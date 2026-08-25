import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Metric, MetricGrid } from '@/components/ui/metric';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { ItemThumb } from '../../components/ListRow';
import { InfoHint } from '../../components/InfoHint';
import {
  getCachedWfmProfileTradeLog,
  getPortfolioInventoryValue,
  getPortfolioPnlSummary,
  importWfmTradeLog,
  setWfmTradeLogKeepItem,
  updateTradeGroupAllocations,
} from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { formatPlatinumValue } from '../../lib/trades';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { PageHeading } from '../../components/PageHeading';
import { useAppStore } from '../../stores/useAppStore';
import { intlLocaleCode } from '../../lib/language';
import { tActive, useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import type {
  PortfolioPnlSummary,
  PortfolioTradeLogEntry,
  SetCompletionInventoryValue,
} from '../../types';
import { ItemName } from '../../components/ItemName';

// Safe error → message: never surfaces "[object Object]" from a non-Error throw, and falls
// back to friendly copy when there's no usable message.
function formatPortfolioError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return tActive('pf.somethingWentWrong');
}

type TradeSourceFilter = 'all' | 'eelog' | 'wfm' | 'alecaframe';

/**
 * Where a trade-log row came from.
 *
 * `eelog` rows are detected live from the game as the trade completes. Everything else
 * predates the cutover or arrived through the manual Warframe.Market backfill, so it is
 * labelled **Imported** — the origin stays visible rather than being flattened away.
 */
function tradeSourceLabel(source: string, t: (key: TranslationKey) => string): string {
  if (source === 'eelog') {
    return t('pf.sourceInGame');
  }
  if (source === 'alecaframe') {
    return t('pf.alecaframe');
  }
  return t('pf.sourceImported');
}

/**
 * Whether a grouped trade still needs the user to say what each item was worth.
 *
 * EE.log gives a platinum **total per trade and never a per-item price** (plan §4.2), so a
 * multi-item trade lands with a provisional even split. That split is a placeholder, not a
 * measurement: left unmarked it would flow into realized profit and margins looking settled.
 * A group stops needing pricing the moment any child is promoted to a manual allocation.
 *
 * Two exclusions are deliberate:
 * - **Single-item groups** — the total *is* the item's price, so there is nothing to divide.
 * - **Zero-platinum trades** — item-for-item swaps have no cost basis to allocate at all.
 */
function groupNeedsPricing(
  children: PortfolioTradeLogEntry[],
  totalPlatinum: number,
): boolean {
  if (children.length < 2 || totalPlatinum <= 0) {
    return false;
  }
  if (!children.some((child) => child.source === 'eelog')) {
    return false;
  }
  return !children.some((child) => child.allocationMode === 'manual');
}

function formatSignedPlatinumValue(value: number): string {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatPlatinumValue(value)}`;
}

function formatPercentValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }

  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)}%`;
}

function formatHoursValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }

  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)}h`;
}

function portfolioCoverageTone(value: number): 'green' | 'blue' | 'amber' {
  if (value >= 95) {
    return 'green';
  }
  if (value >= 75) {
    return 'blue';
  }
  return 'amber';
}

function formatAxisPlatinumValue(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }

  const absolute = Math.abs(Math.round(value));
  const prefix = value < 0 ? '-' : '';
  if (absolute >= 1_000_000) {
    return `${prefix}${(absolute / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}m`;
  }
  if (absolute >= 1_000) {
    return `${prefix}${(absolute / 1_000).toFixed(absolute >= 10_000 ? 0 : 1)}k`;
  }
  return `${prefix}${absolute}p`;
}

function formatChartDateLabel(value: string): string {
  try {
    return formatShortLocalDateTime(value);
  } catch {
    return value;
  }
}

function buildLinearGuides(min: number, max: number, count: number): number[] {
  if (count <= 1) {
    return [min];
  }

  const range = max - min;
  if (range === 0) {
    return Array.from({ length: count }, () => min);
  }

  return Array.from({ length: count }, (_, index) => min + (range / (count - 1)) * index);
}

function buildLineChartGeometry(
  values: number[],
  width: number,
  height: number,
  padding: { top: number; right: number; bottom: number; left: number },
) {
  if (values.length === 0) {
    return { polyline: '', area: '', guides: [0, 0, 0, 0], points: [] as { x: number; y: number; value: number; index: number }[] };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(Math.abs(max - min), 1);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const points = values.map((value, index) => {
    const x = padding.left + (values.length === 1 ? innerWidth / 2 : (index / (values.length - 1)) * innerWidth);
    const normalized = (value - min) / range;
    const y = padding.top + innerHeight - normalized * innerHeight;
    return { x, y, value, index };
  });

  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
  const firstX = padding.left;
  const lastX = padding.left + innerWidth;
  const area = `${firstX},${height - padding.bottom} ${polyline} ${lastX},${height - padding.bottom}`;
  const guides = buildLinearGuides(min, max, 4);

  return { polyline, area, guides, points };
}

/**
 * The value under the cursor, floated over the plot.
 *
 * It used to be a bordered card sitting permanently above each chart, which meant a box that
 * mostly restated the last point and cost the plot ~70px of height. Now it appears on hover and
 * gets out of the way otherwise — the same crosshair-readout behaviour Market's chart uses.
 */
function ChartReadout({
  value,
  meta,
  tone,
}: {
  value: string;
  meta: string;
  tone?: 'negative';
}) {
  return (
    <div className="pointer-events-none absolute top-2 left-2 z-(--z-raised) rounded-md border border-white/12 bg-bg-overlay px-2 py-1 shadow-float">
      <div
        className={`font-mono text-sm leading-tight font-bold tabular-nums ${
          tone === 'negative' ? 'text-accent-red' : 'text-accent-green'
        }`}
      >
        {value}
      </div>
      <div className="font-mono text-[10px] text-ink-dim tabular-nums">{meta}</div>
    </div>
  );
}

/**
 * One row of a profit breakdown: what it is, how many trades, the signed value, and a bar.
 *
 * The three breakdown panels — by trade source, by category, by item — rendered this markup three
 * times over. The bar plots `|value| / max`, a real proportion, so it is a chart rather than
 * decoration.
 */
function BreakdownList({
  rows,
  max,
  emptyLabel,
}: {
  rows: { label: string; value: number; tradeCount: number }[];
  max: number;
  emptyLabel: string;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <EmptyState icon="ti-chart-bar" title={emptyLabel} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => {
        const positive = row.value >= 0;
        return (
          <div key={row.label} className="flex flex-col gap-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{row.label}</span>
              <span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
                {t('pf.tradesCount', { count: row.tradeCount })}
              </span>
              <span
                className={`shrink-0 font-mono text-[11px] font-bold tabular-nums ${
                  positive ? 'text-accent-green' : 'text-accent-red'
                }`}
              >
                {formatSignedPlatinumValue(row.value)}
              </span>
            </div>
            <span className="h-1 overflow-hidden rounded-full bg-bg-base" aria-hidden="true">
              <span
                className={`block h-full rounded-full ${positive ? 'bg-accent-green' : 'bg-accent-red'}`}
                style={{ width: `${Math.max(4, Math.round((Math.abs(row.value) / max) * 100))}%` }}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CumulativeProfitChart({ summary }: { summary: PortfolioPnlSummary }) {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const width = 520;
  const height = 220;
  const padding = { top: 18, right: 18, bottom: 34, left: 54 };
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const values = summary.cumulativeProfitPoints.map((point) => point.cumulativeProfit);
  const { polyline, area, guides, points } = buildLineChartGeometry(values, width, height, padding);
  const activeIndex = hoverIndex ?? Math.max(summary.cumulativeProfitPoints.length - 1, 0);
  const activePoint = points[activeIndex] ?? null;
  const activeData = summary.cumulativeProfitPoints[activeIndex] ?? null;
  const xLabelIndices = new Set(
    summary.cumulativeProfitPoints.length <= 4
      ? summary.cumulativeProfitPoints.map((_, index) => index)
      : [0, Math.floor(summary.cumulativeProfitPoints.length / 2), summary.cumulativeProfitPoints.length - 1],
  );
  const slotWidth =
    summary.cumulativeProfitPoints.length > 1
      ? (width - padding.left - padding.right) / (summary.cumulativeProfitPoints.length - 1)
      : width - padding.left - padding.right;

  return (
    <Panel className="gap-0">
      <PanelHeader>
        <PanelTitle variant="heading">{t('a11y.cumulativeProfit')}</PanelTitle>
        <InfoHint text={t('pf.cumulativeProfitInfo')} />
      </PanelHeader>
      <div className="block min-h-44 px-3.5 pt-3 pb-2">
        {summary.cumulativeProfitPoints.length === 0 ? (
          <EmptyState className="min-h-[148px] justify-center" icon="ti-chart-line" title={t('pf.noClosedTrades')} />
        ) : (
          <div className="relative grid gap-2.5">
            {hoverIndex !== null && activeData ? (
              <ChartReadout
                value={formatSignedPlatinumValue(activeData.cumulativeProfit)}
                meta={formatChartDateLabel(activeData.bucketAt)}
                tone={activeData.cumulativeProfit < 0 ? 'negative' : undefined}
              />
            ) : null}
            <svg width="100%" height="220" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
              <rect
                x={padding.left}
                y={padding.top}
                width={width - padding.left - padding.right}
                height={height - padding.top - padding.bottom}
                rx="10"
                fill="rgba(255,255,255,0.02)"
                stroke="rgba(255,255,255,0.05)"
              />
              {guides.map((guide, index) => {
                const y =
                  padding.top +
                  ((guides.length - 1 - index) / Math.max(guides.length - 1, 1)) *
                    (height - padding.top - padding.bottom);
                return (
                  <g key={`${guide}-${index}`}>
                    <line
                      x1={padding.left}
                      y1={y}
                      x2={width - padding.right}
                      y2={y}
                      stroke="rgba(255,255,255,0.07)"
                      strokeWidth="1"
                      strokeDasharray="3 5"
                    />
                    <text
                      x={10}
                      y={y + 3}
                      fill="var(--text-muted)"
                      fontSize="9"
                      fontFamily="JetBrains Mono"
                    >
                      {formatAxisPlatinumValue(guide)}
                    </text>
                  </g>
                );
              })}
              {points.map((point, index) => (
                <line
                  key={`guide-${point.index}`}
                  x1={point.x}
                  y1={padding.top}
                  x2={point.x}
                  y2={height - padding.bottom}
                  stroke="rgba(255,255,255,0.045)"
                  strokeWidth="1"
                  opacity={xLabelIndices.has(index) ? 1 : 0.45}
                />
              ))}
              <polygon points={area} fill="rgba(74, 158, 255, 0.13)" />
              <polyline
                points={polyline}
                fill="none"
                stroke="rgba(74, 158, 255, 0.95)"
                strokeWidth="2.6"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {activePoint ? (
                <>
                  <line
                    x1={activePoint.x}
                    y1={padding.top}
                    x2={activePoint.x}
                    y2={height - padding.bottom}
                    stroke="rgba(74,158,255,0.5)"
                    strokeWidth="1.2"
                    strokeDasharray="4 4"
                  />
                  <circle cx={activePoint.x} cy={activePoint.y} r="5" fill="var(--accent-blue)" />
                  <circle cx={activePoint.x} cy={activePoint.y} r="10" fill="rgba(74,158,255,0.14)" />
                </>
              ) : null}
              {points.map((point, index) => {
                const label = summary.cumulativeProfitPoints[index];
                return (
                  <g key={`hover-${point.index}`}>
                    <rect
                      x={point.x - slotWidth / 2}
                      y={padding.top}
                      width={Math.max(slotWidth, 18)}
                      height={height - padding.top - padding.bottom}
                      fill="transparent"
                      onMouseEnter={() => setHoverIndex(index)}
                      onMouseMove={() => setHoverIndex(index)}
                      onMouseLeave={() => setHoverIndex(null)}
                    />
                    {xLabelIndices.has(index) ? (
                      <text
                        x={point.x}
                        y={height - 10}
                        textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
                        fill="var(--text-muted)"
                        fontSize="9"
                        fontFamily="JetBrains Mono"
                      >
                        {new Date(label.bucketAt).toLocaleDateString(intlLocaleCode(language), {
                          day: '2-digit',
                          month: 'short',
                        })}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </Panel>
  );
}

function ProfitPerTradeChart({ summary }: { summary: PortfolioPnlSummary }) {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const width = 420;
  const height = 220;
  const padding = { top: 18, right: 16, bottom: 34, left: 50 };
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const points = summary.profitPerTradePoints;
  const maxAbs = Math.max(...points.map((point) => Math.abs(point.profit)), 1);
  const innerHeight = height - padding.top - padding.bottom;
  const baseline = padding.top + innerHeight / 2;
  const barSlotWidth = points.length > 0 ? (width - padding.left - padding.right) / points.length : 0;
  const barWidth = points.length > 0 ? Math.max(12, barSlotWidth - 8) : 0;
  const guides = buildLinearGuides(maxAbs, -maxAbs, 5);
  // Derived straight from the hover, with no last-point fallback: the old `hoverIndex ?? last`
  // meant a pointer in a dead zone highlighted the final bar as though it were selected.
  const activeTrade = hoverIndex === null ? null : (points[hoverIndex] ?? null);
  const xLabelIndices = new Set(
    points.length <= 4 ? points.map((_, index) => index) : [0, Math.floor(points.length / 2), points.length - 1],
  );

  return (
    <Panel className="gap-0">
      <PanelHeader>
        <PanelTitle variant="heading">{t('a11y.profitPerTrade')}</PanelTitle>
        <InfoHint text={t('pf.profitPerTradeInfo')} />
      </PanelHeader>
      <div className="block min-h-44 px-3.5 pt-3 pb-2">
        {points.length === 0 ? (
          <EmptyState className="min-h-[148px] justify-center" icon="ti-chart-bar" title={t('pf.profitBarsHint')} />
        ) : (
          <div className="relative grid gap-2.5">
            {hoverIndex !== null && activeTrade ? (
              <ChartReadout
                value={formatSignedPlatinumValue(activeTrade.profit)}
                meta={`${activeTrade.itemName} · ${formatChartDateLabel(activeTrade.closedAt)}`}
                tone={activeTrade.profit < 0 ? 'negative' : undefined}
              />
            ) : null}
            <svg width="100%" height="220" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
              <rect
                x={padding.left}
                y={padding.top}
                width={width - padding.left - padding.right}
                height={height - padding.top - padding.bottom}
                rx="10"
                fill="rgba(255,255,255,0.02)"
                stroke="rgba(255,255,255,0.05)"
              />
              {guides.map((guide) => {
                const normalized = (guide + maxAbs) / (2 * maxAbs || 1);
                const y = padding.top + innerHeight - normalized * innerHeight;
                return (
                  <g key={`profit-guide-${guide}`}>
                    <line
                      x1={padding.left}
                      y1={y}
                      x2={width - padding.right}
                      y2={y}
                      stroke={Math.abs(guide) < 0.0001 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)'}
                      strokeWidth={Math.abs(guide) < 0.0001 ? '1.2' : '1'}
                      strokeDasharray={Math.abs(guide) < 0.0001 ? undefined : '3 5'}
                    />
                    <text
                      x={10}
                      y={y + 3}
                      fill="var(--text-muted)"
                      fontSize="9"
                      fontFamily="JetBrains Mono"
                    >
                      {formatAxisPlatinumValue(guide)}
                    </text>
                  </g>
                );
              })}
              <line
                x1={padding.left}
                y1={baseline}
                x2={width - padding.right}
                y2={baseline}
                stroke="rgba(255,255,255,0.14)"
                strokeWidth="1.2"
              />
              {points.map((point, index) => {
                const x = padding.left + index * barSlotWidth + (barSlotWidth - barWidth) / 2;
                const normalizedHeight = (Math.abs(point.profit) / maxAbs) * (innerHeight / 2 - 8);
                const isPositive = point.profit >= 0;
                const y = isPositive ? baseline - normalizedHeight : baseline;
                const isActive = hoverIndex === index;
                return (
                  <g key={point.id}>
                    <rect
                      x={padding.left + index * barSlotWidth}
                      y={padding.top}
                      width={barSlotWidth}
                      height={height - padding.top - padding.bottom}
                      fill="transparent"
                      onMouseEnter={() => setHoverIndex(index)}
                      onMouseMove={() => setHoverIndex(index)}
                      onMouseLeave={() => setHoverIndex(null)}
                    />
                    {/* The bar is painted AFTER its hit zone, so without this it sits on top and
                        swallows the pointer — hovering a bar fired `mouseleave` on the zone
                        underneath and cleared the selection. That was the whole bug: with the old
                        `?? last` fallback it showed the final bar, and without it, nothing. */}
                    <rect
                      x={x}
                      y={y}
                      width={barWidth}
                      height={Math.max(normalizedHeight, 3)}
                      rx="4"
                      pointerEvents="none"
                      fill={isPositive ? 'rgba(61,214,140,0.7)' : 'rgba(240,79,88,0.7)'}
                      stroke={isActive ? (isPositive ? 'rgba(61,214,140,1)' : 'rgba(240,79,88,1)') : 'transparent'}
                      strokeWidth="1.1"
                    />
                    {xLabelIndices.has(index) ? (
                      <text
                        x={x + barWidth / 2}
                        y={height - 10}
                        textAnchor="middle"
                        pointerEvents="none"
                        fill="var(--text-muted)"
                        fontSize="9"
                        fontFamily="JetBrains Mono"
                      >
                        {new Date(point.closedAt).toLocaleDateString(intlLocaleCode(language), {
                          day: '2-digit',
                          month: 'short',
                        })}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </Panel>
  );
}

function renderTradeType(orderType: PortfolioTradeLogEntry['orderType']): string {
  return orderType === 'buy' ? tActive('pf.buy') : tActive('pf.sell');
}

const TRADE_STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  Flip: 'pf.flip',
  'Sold As Set': 'pf.soldAsSet',
  Kept: 'pf.kept',
  Open: 'pf.open',
  Partial: 'pf.partial',
};

function renderTradeStatus(status: string | null): string {
  if (!status) {
    return '';
  }
  const labelKey = TRADE_STATUS_LABEL_KEYS[status];
  return labelKey ? tActive(labelKey) : status;
}

/** On a partly-sold buy the badge alone doesn't say how far along it is, so it carries the
 *  sold-of-total count. `matchedQuantity` is the sold-so-far figure for buy rows. */
function renderTradeStatusDetail(entry: PortfolioTradeLogEntry): string | null {
  if (entry.status !== 'Partial' || entry.matchedQuantity == null) {
    return null;
  }
  return `${entry.matchedQuantity}/${entry.quantity}`;
}

function tradeTypeTone(orderType: PortfolioTradeLogEntry['orderType']): BadgeTone {
  return orderType === 'buy' ? 'blue' : 'green';
}

/** `Partial` was `.badge-partial`, which was `.badge-purple` under a second name. */
function tradeStatusTone(status: string | null): BadgeTone {
  switch (status) {
    case 'Flip':
      return 'green';
    case 'Sold As Set':
      return 'purple';
    case 'Kept':
      return 'amber';
    case 'Open':
      return 'blue';
    case 'Partial':
      return 'purple';
    default:
      return 'neutral';
  }
}

function formatMarginValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }

  const rounded = Math.round(value * 10) / 10;
  const normalized = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(1);
  return `${normalized}%`;
}


function normalizeFilterDate(value: string): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(`${value}T00:00:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildEndFilterDate(value: string): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(`${value}T23:59:59`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

type TradeLogDisplayRow =
  | { kind: 'single'; entry: PortfolioTradeLogEntry }
  | {
      kind: 'group';
      groupId: string;
      label: string;
      totalPlatinum: number;
      itemCount: number;
      orderType: PortfolioTradeLogEntry['orderType'];
      closedAt: string;
      updatedAt: string;
      children: PortfolioTradeLogEntry[];
    };

function buildTradeLogDisplayRows(entries: PortfolioTradeLogEntry[]): TradeLogDisplayRow[] {
  const groupedEntries = new Map<string, PortfolioTradeLogEntry[]>();
  for (const entry of entries) {
    if (!entry.groupId) {
      continue;
    }

    const group = groupedEntries.get(entry.groupId) ?? [];
    group.push(entry);
    groupedEntries.set(entry.groupId, group);
  }

  const rows: TradeLogDisplayRow[] = [];
  const seenGroupIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.groupId) {
      rows.push({ kind: 'single', entry });
      continue;
    }

    if (seenGroupIds.has(entry.groupId)) {
      continue;
    }
    seenGroupIds.add(entry.groupId);

    const children = (groupedEntries.get(entry.groupId) ?? [entry]).slice().sort((left, right) => {
      const leftOrder = left.groupSortOrder ?? 0;
      const rightOrder = right.groupSortOrder ?? 0;
      return leftOrder - rightOrder || left.itemName.localeCompare(right.itemName);
    });

    rows.push({
      kind: 'group',
      groupId: entry.groupId,
      label: entry.groupLabel ?? tActive('pf.multipleItemTrade'),
      totalPlatinum:
        entry.groupTotalPlatinum ??
        children.reduce(
          (sum, child) => sum + (child.allocationTotalPlatinum ?? child.platinum),
          0,
        ),
      itemCount: entry.groupItemCount ?? children.length,
      orderType: entry.orderType,
      closedAt: entry.closedAt,
      updatedAt: entry.updatedAt,
      children,
    });
  }

  return rows;
}

function buildTradeGroupSummary(children: PortfolioTradeLogEntry[]): string {
  if (children.length === 0) {
    return tActive('pf.noItemsInTrade');
  }

  const names = children.slice(0, 2).map((child) => child.itemName);
  const suffix = children.length > 2 ? ` +${children.length - 2} more` : '';
  return `${names.join(' • ')}${suffix}`;
}

/** Trade Log's panel header. The P&L tab used to share this; it is the last caller, so it is a
 *  thin wrapper over the primitives rather than a second header implementation. */
function PortfolioPanelHeader({ title, info }: { title: string; info: string }) {
  return (
    <PanelHeader>
      <PanelTitle variant="heading">{title}</PanelTitle>
      <InfoHint text={info} />
    </PanelHeader>
  );
}

/** The ledger's column geometry, in one place because the header and every row have to agree —
 *  it was a single `grid-template-columns` shared across two selectors in `legacy.css`, and two
 *  copies of a seven-column track list would drift the first time one changed.
 *
 *  The two legacy breakpoints, inverted into Tailwind's min-width form: under 920px the row is a
 *  single stacked column (and the header hides), 920–1024 tightens the tracks, 1024 up is the full
 *  layout. `min-w-[780px]` applies at every width, as it did before — it is what makes the scroll
 *  container scroll rather than crush the columns. */
const LEDGER_GRID =
  'grid min-w-[780px] grid-cols-1 items-center gap-2.5 ' +
  'min-[920px]:grid-cols-[minmax(180px,1.5fr)_58px_92px_100px_108px_120px_104px] ' +
  'min-[1024px]:grid-cols-[minmax(200px,1.6fr)_64px_100px_110px_118px_132px_118px] min-[1024px]:gap-3';

/** A ledger row. The hover tint is purple on every row — a later `legacy.css` rule overrode the
 *  blue one and this ports the value that was actually on screen. */
const LEDGER_ROW =
  `${LEDGER_GRID} border-b border-white/4 px-4 py-[9px] transition-[background-color,border-color] ` +
  'duration-[140ms] last:border-b-0 hover:bg-accent-purple/[0.045]';

/** Right-aligned once the columns exist; left-aligned while the row is stacked. */
const LEDGER_DATE =
  'text-left font-mono text-[10.5px] leading-[1.45] text-ink-dim tabular-nums min-[920px]:text-right';

const LEDGER_ACTIONS = 'flex items-center justify-start min-[920px]:justify-end';

/** Right-aligned numeric column: the main figure with its secondary metric stacked underneath
 *  (qty under price, margin under profit), which is what halves the column count. */
function LedgerCell({ main, sub, tone }: { main: string; sub?: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="grid min-w-0 justify-items-end gap-px text-right">
      <span
        className={`font-mono text-[12.5px] tabular-nums ${
          tone === 'pos' ? 'text-accent-green' : tone === 'neg' ? 'text-accent-red' : 'text-ink'
        }`}
      >
        {main}
      </span>
      {sub ? <span className="font-mono text-[10px] text-ink-dim tabular-nums">{sub}</span> : null}
    </div>
  );
}

/** The em-dash a cell shows when it has no value. */
function LedgerBlank() {
  return <span className="text-[13px] text-ink-soft tabular-nums">—</span>;
}

/** One ledger entry line — shared by standalone trades and expanded group children, which render
 *  identically except for the child indent. Numeric columns carry their secondary metric as a
 *  sub-line (qty under price, margin under profit) so the table fits without horizontal scroll. */
function TradeLogEntryRow({
  entry,
  isChild = false,
  provisionalPrice = false,
  keepOn,
  onToggleKeep,
}: {
  entry: PortfolioTradeLogEntry;
  isChild?: boolean;
  /** Row belongs to a group whose platinum total has only been split provisionally. */
  provisionalPrice?: boolean;
  keepOn: boolean;
  onToggleKeep: (entry: PortfolioTradeLogEntry) => void;
}) {
  const { t } = useTranslation();
  const profitTone = entry.profit == null ? undefined : entry.profit < 0 ? ('neg' as const) : ('pos' as const);
  const statusDetail = renderTradeStatusDetail(entry);
  const metaParts = [
    tradeSourceLabel(entry.source, t),
    entry.rank !== null && entry.rank !== undefined ? `${t('pf.rank')} ${entry.rank}` : null,
    isChild && entry.allocationMode
      ? entry.allocationMode === 'manual' ? t('pf.manual') : t('pf.auto')
      : null,
    provisionalPrice ? t('pf.estimatedPrice') : null,
  ].filter(Boolean);

  return (
    <div
      className={`${LEDGER_ROW} ${
        isChild
          ? 'bg-white/[0.015] shadow-[inset_2px_0_0_color-mix(in_oklab,var(--color-accent-purple)_35%,transparent)]'
          : ''
      }`}
    >
      <div className={`flex min-w-0 items-center gap-[11px] ${isChild ? 'pl-8' : ''}`}>
        <ItemThumb
          size="size-8"
          src={entry.imagePath ? (resolveWfmAssetUrl(entry.imagePath, entry.slug) ?? null) : null}
          fallback={entry.itemName.charAt(0)}
        />
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate text-[13px] font-semibold text-ink">{entry.itemName}</span>
          <span className="truncate font-mono text-[10.5px] text-ink-soft">{metaParts.join(' · ')}</span>
        </div>
      </div>
      <Badge tone={tradeTypeTone(entry.orderType)}>{renderTradeType(entry.orderType)}</Badge>
      <LedgerCell main={formatPlatinumValue(entry.platinum)} sub={`×${entry.quantity}`} />
      <LedgerCell
        main={entry.profit == null ? '—' : formatPlatinumValue(entry.profit)}
        sub={formatMarginValue(entry.margin)}
        tone={profitTone}
      />
      <span className="flex min-w-0 justify-start">
        {entry.status ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Badge tone={tradeStatusTone(entry.status)}>{renderTradeStatus(entry.status)}</Badge>
            {statusDetail ? (
              <span className="font-mono text-[10px] whitespace-nowrap text-ink-dim tabular-nums">
                {statusDetail}
              </span>
            ) : null}
          </span>
        ) : (
          <LedgerBlank />
        )}
      </span>
      <span className={LEDGER_DATE}>{formatShortLocalDateTime(entry.closedAt)}</span>
      <span className={LEDGER_ACTIONS}>
        {entry.orderType === 'buy' ? (
          /* The last hand-rolled switch in the app. `Switch` has existed since the Trades pass;
             this one kept its `.toggle` CSS only because nothing had come back to it. */
          <label className="flex cursor-pointer items-center gap-2">
            <Switch
              tone="positive"
              checked={keepOn}
              aria-label={t('pf.keepAriaLabel', { name: entry.itemName })}
              onCheckedChange={() => onToggleKeep(entry)}
            />
            <span className="text-[11px] text-ink-soft">{t('pf.keepItem')}</span>
          </label>
        ) : (
          <LedgerBlank />
        )}
      </span>
    </div>
  );
}

function TradeLogTab({ username }: { username: string | null }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<PortfolioTradeLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Optimistic "Keep item" toggle state. `keepOverrides` is what the UI shows
  // immediately; `keepDesiredRef` holds the value we still need to persist and
  // `keepInFlightRef` serialises writes per order so rapid spam-clicking collapses
  // into the latest value without races or data loss.
  const [keepOverrides, setKeepOverrides] = useState<Record<string, boolean>>({});
  const keepDesiredRef = useRef<Map<string, boolean>>(new Map());
  const keepInFlightRef = useRef<Set<string>>(new Set());
  const [savingAllocations, setSavingAllocations] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const [allocationGroupId, setAllocationGroupId] = useState<string | null>(null);
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [orderTypeFilter, setOrderTypeFilter] = useState<'all' | 'buy' | 'sell'>('all');
  const [statusFilter, setStatusFilter] =
    useState<'all' | 'Flip' | 'Sold As Set' | 'Partial' | 'Open' | 'Kept' | 'none'>('all');
  const [sourceFilter, setSourceFilter] = useState<TradeSourceFilter>('all');
  const [onlyNeedsPricing, setOnlyNeedsPricing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const filteredEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const fromTimestamp = normalizeFilterDate(fromDate);
    const toTimestamp = buildEndFilterDate(toDate);

    return entries.filter((entry) => {
      if (orderTypeFilter !== 'all' && entry.orderType !== orderTypeFilter) {
        return false;
      }
      if (statusFilter !== 'all') {
        if (statusFilter === 'none') {
          if (entry.status != null) {
            return false;
          }
        } else if (entry.status !== statusFilter) {
          return false;
        }
      }
      if (sourceFilter !== 'all' && entry.source !== sourceFilter) {
        return false;
      }
      if (normalizedQuery) {
        const haystack = `${entry.itemName} ${entry.slug}`.toLowerCase();
        if (!haystack.includes(normalizedQuery)) {
          return false;
        }
      }

      const closedTimestamp = Date.parse(entry.closedAt);
      if (fromTimestamp != null && Number.isFinite(closedTimestamp) && closedTimestamp < fromTimestamp) {
        return false;
      }
      if (toTimestamp != null && Number.isFinite(closedTimestamp) && closedTimestamp > toTimestamp) {
        return false;
      }
      return true;
    });
  }, [entries, fromDate, orderTypeFilter, searchQuery, sourceFilter, statusFilter, toDate]);

  const allDisplayRows = useMemo(() => buildTradeLogDisplayRows(filteredEntries), [filteredEntries]);
  const needsPricingCount = useMemo(
    () =>
      allDisplayRows.filter(
        (row) => row.kind === 'group' && groupNeedsPricing(row.children, row.totalPlatinum),
      ).length,
    [allDisplayRows],
  );
  const displayRows = useMemo(
    () =>
      onlyNeedsPricing
        ? allDisplayRows.filter(
            (row) => row.kind === 'group' && groupNeedsPricing(row.children, row.totalPlatinum),
          )
        : allDisplayRows,
    [allDisplayRows, onlyNeedsPricing],
  );
  const allocationGroup = useMemo(
    () =>
      displayRows.find(
        (row): row is Extract<TradeLogDisplayRow, { kind: 'group' }> =>
          row.kind === 'group' && row.groupId === allocationGroupId,
      ) ?? null,
    [allocationGroupId, displayRows],
  );
  const allocationTotal = allocationGroup
    ? allocationGroup.children.reduce((sum, child) => {
        const nextValue = Number.parseInt(allocationDrafts[child.id] ?? '', 10);
        return sum + (Number.isFinite(nextValue) ? nextValue : 0);
      }, 0)
    : 0;
  const allocationExpectedTotal = allocationGroup?.totalPlatinum ?? 0;
  const allocationMatches = allocationGroup ? allocationTotal === allocationExpectedTotal : true;

  const applyTradeLogState = (nextState: { entries: PortfolioTradeLogEntry[]; lastUpdatedAt: string | null }) => {
    setEntries(nextState.entries);
    setLastUpdatedAt(nextState.lastUpdatedAt);
  };

  const handleRefresh = async () => {
    if (!username) {
      setErrorMessage(t('pf.connectFirst2'));
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      // Reloads what is already stored. EE.log is the trade-log source, so there is
      // nothing to fetch here — a WFM backfill is the separate Import button.
      const nextState = await getCachedWfmProfileTradeLog(username);
      applyTradeLogState(nextState);
    } catch (error) {
      setErrorMessage(formatPortfolioError(error));
    } finally {
      setLoading(false);
    }
  };

  // Manual backfill for trades made while WarStonks was closed — the one gap EE.log
  // cannot cover, because the game truncates its log on every launch.
  const handleImportFromWfm = async () => {
    if (!username) {
      setErrorMessage(t('pf.connectFirst2'));
      return;
    }

    setImporting(true);
    setErrorMessage(null);
    setImportMessage(null);

    try {
      const outcome = await importWfmTradeLog(username);
      applyTradeLogState(await getCachedWfmProfileTradeLog(username));
      setImportMessage(t('pf.importedCount', { count: String(outcome.added) }));
    } catch (error) {
      setErrorMessage(formatPortfolioError(error));
    } finally {
      setImporting(false);
    }
  };

  // Persists the latest desired keep value for an order, serialised so concurrent
  // spam-clicks on the same order never race. Each write returns the fully reconciled
  // trade-log state; we apply it but keep any still-pending optimistic overrides.
  const flushKeepWrites = async (orderId: string) => {
    if (!username || keepInFlightRef.current.has(orderId)) {
      return;
    }
    keepInFlightRef.current.add(orderId);
    try {
      while (keepDesiredRef.current.has(orderId)) {
        const desired = keepDesiredRef.current.get(orderId) as boolean;
        let nextState: { entries: PortfolioTradeLogEntry[]; lastUpdatedAt: string | null };
        try {
          nextState = await setWfmTradeLogKeepItem(username, orderId, desired);
        } catch (error) {
          // Roll back this order's optimistic state and surface the error.
          keepDesiredRef.current.delete(orderId);
          setKeepOverrides((prev) => {
            const next = { ...prev };
            delete next[orderId];
            return next;
          });
          setErrorMessage(formatPortfolioError(error));
          break;
        }
        // Only accept the server state if the user hasn't clicked again mid-flight.
        if (keepDesiredRef.current.get(orderId) === desired) {
          keepDesiredRef.current.delete(orderId);
          setEntries(nextState.entries);
          setLastUpdatedAt(nextState.lastUpdatedAt);
          setKeepOverrides((prev) => {
            const next = { ...prev };
            delete next[orderId];
            return next;
          });
        }
        // Otherwise loop and re-send the newest desired value.
      }
    } finally {
      keepInFlightRef.current.delete(orderId);
    }
  };

  const handleToggleKeepItem = (entry: PortfolioTradeLogEntry) => {
    if (!username || entry.orderType !== 'buy') {
      return;
    }
    const orderId = entry.id;
    const current = keepOverrides[orderId] ?? entry.keepItem;
    const next = !current;
    // Instant optimistic flip; the backend write happens in the background.
    setKeepOverrides((prev) => ({ ...prev, [orderId]: next }));
    keepDesiredRef.current.set(orderId, next);
    setErrorMessage(null);
    void flushKeepWrites(orderId);
  };

  const handleToggleGroupExpanded = (groupId: string) => {
    setExpandedGroupIds((current) =>
      current.includes(groupId)
        ? current.filter((value) => value !== groupId)
        : [...current, groupId],
    );
  };

  const handleOpenAllocationModal = (
    row: Extract<TradeLogDisplayRow, { kind: 'group' }>,
  ) => {
    setAllocationGroupId(row.groupId);
    setAllocationDrafts(
      Object.fromEntries(
        row.children.map((child) => [child.id, String(child.allocationTotalPlatinum ?? child.platinum)]),
      ),
    );
  };


  const handleSaveAllocations = async () => {
    if (!username || !allocationGroup) {
      return;
    }

    if (!allocationMatches) {
      setErrorMessage(t('pf.adjustedTotalsMustMatch', { total: formatPlatinumValue(allocationExpectedTotal) }));
      return;
    }

    setSavingAllocations(true);
    setErrorMessage(null);

    try {
      const nextState = await updateTradeGroupAllocations(
        username,
        allocationGroup.groupId,
        allocationGroup.children.map((child) => ({
          orderId: child.id,
          totalPlatinum: Number.parseInt(allocationDrafts[child.id] ?? '0', 10) || 0,
        })),
      );
      applyTradeLogState(nextState);
      setAllocationGroupId(null);
      setAllocationDrafts({});
    } catch (error) {
      setErrorMessage(formatPortfolioError(error));
    } finally {
      setSavingAllocations(false);
    }
  };

  useEffect(() => {
    if (!username) {
      setEntries([]);
      setLastUpdatedAt(null);
      setErrorMessage(null);
      return;
    }

    let cancelled = false;
    const loadOnOpen = async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const cachedState = await getCachedWfmProfileTradeLog(username);
        if (!cancelled) {
          applyTradeLogState(cachedState);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(formatPortfolioError(error));
        }
      }

      if (!cancelled) {
        setLoading(false);
      }
    };

    void loadOnOpen();
    return () => {
      cancelled = true;
    };
  }, [username]);

  useEffect(() => {
    if (!username) {
      return;
    }

    let cancelled = false;
    const intervalId = setInterval(() => {
      void getCachedWfmProfileTradeLog(username)
        .then((nextState) => {
          if (!cancelled) {
            applyTradeLogState(nextState);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            console.error('[portfolio] failed to refresh cached trade log', error);
          }
        });
    }, 4_000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [username]);

  return (
    /* The container owns the vertical rhythm. This page's spacing used to live on
       `margin-bottom` declarations inside the row and bar rules — migrate one of those away and
       the gaps go with it, which is exactly what happened to the P&L tab (see §4 of the
       inventory). */
    <div className="flex flex-col gap-4 p-4">
      {/* No heading here — the sub-tab the user just clicked already says "Trade Log", and
          repeating it directly underneath spends a row saying nothing. */}
      <div className="flex flex-wrap items-center justify-end gap-2.5">
          {lastUpdatedAt ? (
            <span className="mr-0.5 inline-flex items-baseline gap-1.5">
              <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
                {t('pf.updated')}
              </span>
              <time className="font-mono text-[11px] text-ink-soft tabular-nums">
                {formatShortLocalDateTime(lastUpdatedAt)}
              </time>
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleImportFromWfm()}
            disabled={loading || importing || !username}
            title={t('pf.importFromWfmHint')}
          >
            {importing ? t('pf.importing') : t('pf.importFromWfm')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={loading}>
            <i className="ti ti-refresh" aria-hidden="true" />
            {loading ? t('common.refreshing') : t('common.refresh')}
          </Button>
      </div>

      {needsPricingCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-amber/25 bg-accent-amber/[0.07] px-3 py-2 text-[11px] text-accent-amber">
          <span>{t('pf.needsPricingBanner', { count: String(needsPricingCount) })}</span>
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={onlyNeedsPricing}
            onClick={() => setOnlyNeedsPricing((current) => !current)}
            className="ml-auto h-6 border-line text-[11px]"
          >
            {onlyNeedsPricing ? t('pf.showAllTrades') : t('pf.showOnlyNeedsPricing')}
          </Button>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11px] text-accent-red">
          {errorMessage}
        </div>
      ) : null}
      {importMessage ? (
        <div className="rounded-md border border-accent-green/25 bg-accent-green/[0.07] px-3 py-2 text-[11px] text-accent-green">
          {importMessage}
        </div>
      ) : null}

      {!username ? (
        <EmptyState
          className="mt-10 min-h-40 justify-center"
          icon="ti-plug-connected-x"
          title={t('pf.connectFirst')}
          detail={t('pf.tradeLogHint')}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          className="mt-10 min-h-40 justify-center"
          icon={loading ? 'ti-history' : 'ti-history-off'}
          title={loading ? t('pf.loadingTradeHistory') : t('pf.noTradeHistoryYet')}
          detail={loading ? t('pf.loadingCachedTradeLog') : t('pf.openTabOrRefresh')}
        />
      ) : (
        <div className="grid gap-3">
          <Panel className="gap-0">
            <PortfolioPanelHeader
              title={t('a11y.filters')}
              info={t('pf.filterLedgerInfo')}
            />
            <div className="grid grid-cols-2 gap-2.5 p-3.5 md:grid-cols-3 lg:grid-cols-6">
              <label className="grid min-w-0 gap-1.5 font-mono text-[11px] tracking-[0.08em] text-ink-dim uppercase">
                <span>{t('pf.search')}</span>
                <Input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t('pf.searchPlaceholder')}
                />
              </label>
              <label className="grid min-w-0 gap-1.5 font-mono text-[11px] tracking-[0.08em] text-ink-dim uppercase">
                <span>{t('pf.type')}</span>
                <Select
                  value={orderTypeFilter}
                  onChange={(event) => setOrderTypeFilter(event.target.value as 'all' | 'buy' | 'sell')}
                >
                  <option value="all">{t('oppf.all')}</option>
                  <option value="buy">{t('pf.buy')}</option>
                  <option value="sell">{t('pf.sell')}</option>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1.5 font-mono text-[11px] tracking-[0.08em] text-ink-dim uppercase">
                <span>{t('pf.status')}</span>
                <Select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as 'all' | 'Flip' | 'Sold As Set' | 'Partial' | 'Open' | 'Kept' | 'none')
                  }
                >
                  <option value="all">{t('oppf.all')}</option>
                  <option value="Flip">{t('pf.flip')}</option>
                  <option value="Sold As Set">{t('pf.soldAsSet')}</option>
                  <option value="Partial">{t('pf.partial')}</option>
                  <option value="Open">{t('pf.open')}</option>
                  <option value="Kept">{t('pf.kept')}</option>
                  <option value="none">{t('pf.noStatus')}</option>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1.5 font-mono text-[11px] tracking-[0.08em] text-ink-dim uppercase">
                <span>{t('pf.source')}</span>
                <Select
                  value={sourceFilter}
                  onChange={(event) => setSourceFilter(event.target.value as TradeSourceFilter)}
                >
                  <option value="all">{t('oppf.all')}</option>
                  <option value="eelog">{t('pf.sourceInGame')}</option>
                  <option value="wfm">{t('pf.sourceImported')}</option>
                  <option value="alecaframe">{t('pf.alecaframe')}</option>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1.5 font-mono text-[11px] tracking-[0.08em] text-ink-dim uppercase">
                <span>{t('pf.from')}</span>
                <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
              </label>
              <label className="grid min-w-0 gap-1.5 font-mono text-[11px] tracking-[0.08em] text-ink-dim uppercase">
                <span>{t('pf.to')}</span>
                <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
              </label>
            </div>
          </Panel>

          <Panel className="gap-0">
            <PortfolioPanelHeader
              title={t('a11y.tradeLogLedger')}
              info={t('pf.tradeLedgerInfo')}
            />
            <div className="max-h-[min(64vh,680px)] overflow-auto rounded-lg border border-line bg-bg-surface">
            {/* Hidden while the rows are stacked — a seven-column header over a one-column row
                labels nothing. */}
            <div
              className={`${LEDGER_GRID} sticky top-0 z-(--z-raised) hidden border-b border-line bg-bg-elevated px-4 py-[11px] font-mono text-xs tracking-[0.14em] text-ink-soft uppercase min-[920px]:grid`}
            >
              <span>{t('pf.item')}</span>
              <span>{t('pf.type')}</span>
              <span className="text-right">{t('pf.price')}</span>
              <span className="text-right">{t('pf.profit')}</span>
              <span>{t('pf.status')}</span>
              <span className="text-right">{t('pf.closed')}</span>
              <span className="text-right">{t('pf.action')}</span>
            </div>

            <div className="grid">
              {displayRows.length === 0 ? (
                <EmptyState icon="ti-filter-off" title={t('pf.noTradesFilter')} />
              ) : (
                displayRows.map((row) =>
                  row.kind === 'single' ? (
                    <TradeLogEntryRow
                      key={row.entry.id}
                      entry={row.entry}
                      keepOn={keepOverrides[row.entry.id] ?? row.entry.keepItem}
                      onToggleKeep={handleToggleKeepItem}
                    />
                  ) : (
                    <div key={row.groupId} className="grid">
                      <div className={`${LEDGER_ROW} bg-accent-purple/[0.04] hover:bg-accent-purple/[0.07]`}>
                        <div className="flex min-w-0 items-center gap-[11px]">
                          <Button
                            variant="outline"
                            size="icon-sm"
                            aria-label={expandedGroupIds.includes(row.groupId) ? t('pf.collapseAriaLabel', { label: row.label }) : t('pf.expandAriaLabel', { label: row.label })}
                            onClick={() => handleToggleGroupExpanded(row.groupId)}
                            className="size-7 shrink-0 rounded-lg border-line text-ink-soft"
                          >
                            <i
                              className={`ti ${expandedGroupIds.includes(row.groupId) ? 'ti-minus' : 'ti-plus'}`}
                              aria-hidden="true"
                            />
                          </Button>
                          <ItemThumb
                            size="size-8"
                            src={
                              row.children[0]?.imagePath
                                ? (resolveWfmAssetUrl(row.children[0].imagePath, row.children[0].slug) ?? null)
                                : null
                            }
                            fallback="M"
                          />
                          <div className="grid min-w-0 gap-0.5">
                            <span className="truncate text-[13px] font-semibold text-ink">{row.label}</span>
                            <span className="truncate font-mono text-[10.5px] text-ink-soft">
                              {buildTradeGroupSummary(row.children)}
                              {' · '}
                              {row.children.some((child) => child.allocationMode === 'manual') ? t('pf.manualSplit') : t('pf.autoSplit')}
                            </span>
                          </div>
                        </div>
                        <Badge tone={tradeTypeTone(row.orderType)}>{renderTradeType(row.orderType)}</Badge>
                        <LedgerCell
                          main={formatPlatinumValue(row.totalPlatinum)}
                          sub={t('pf.itemsCount', { n: row.itemCount })}
                        />
                        <LedgerCell main="—" />
                        <span className="flex min-w-0 justify-start">
                          {groupNeedsPricing(row.children, row.totalPlatinum) ? (
                            <Badge tone="amber" title={t('pf.needsPricingHint')}>
                              {t('pf.needsPricing')}
                            </Badge>
                          ) : (
                            <Badge>{t('pf.grouped')}</Badge>
                          )}
                        </span>
                        <span className={LEDGER_DATE}>{formatShortLocalDateTime(row.closedAt)}</span>
                        <span className={LEDGER_ACTIONS}>
                          {/* An unpriced group is incomplete data, not a settled row, so it reads
                              amber until it is filled in. `min-w-23` keeps the column steady as
                              the label swaps between the two states. */}
                          <Button
                            variant={groupNeedsPricing(row.children, row.totalPlatinum) ? 'secondary' : 'outline'}
                            size="sm"
                            onClick={() => handleOpenAllocationModal(row)}
                            className={`h-7 min-w-23 text-[11px] ${
                              groupNeedsPricing(row.children, row.totalPlatinum)
                                ? 'border-accent-amber/40 bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25'
                                : 'border-line'
                            }`}
                          >
                            {groupNeedsPricing(row.children, row.totalPlatinum) ? t('pf.setPrices') : t('pf.adjustAmounts')}
                          </Button>
                        </span>
                      </div>
                      {expandedGroupIds.includes(row.groupId)
                        ? row.children.map((child) => (
                            <TradeLogEntryRow
                              key={child.id}
                              entry={child}
                              isChild
                              provisionalPrice={groupNeedsPricing(row.children, row.totalPlatinum)}
                              keepOn={keepOverrides[child.id] ?? child.keepItem}
                              onToggleKeep={handleToggleKeepItem}
                            />
                          ))
                        : null}
                    </div>
                  ),
                )
              )}
            </div>
            </div>
          </Panel>
        </div>
      )}


      <Dialog
        open={allocationGroup !== null}
        onOpenChange={(open) => !open && setAllocationGroupId(null)}
      >
        <DialogContent className="max-w-md">
          {allocationGroup ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('pf.adjustAmounts')}</DialogTitle>
                <DialogDescription>
                  {t('pf.totalTradeValue')} {formatPlatinumValue(allocationExpectedTotal)}
                </DialogDescription>
              </DialogHeader>

              <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
                {allocationGroup.children.map((child) => (
                  <div
                    key={child.id}
                    className="flex items-center gap-2.5 rounded-sm border border-line-subtle bg-bg-panel px-2 py-1.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[11px] font-medium text-ink">
                        {child.itemName}
                      </span>
                      <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                        {t('pf.qtyValue', { n: child.quantity })}
                        {child.rank != null ? t('pf.rankValue', { n: child.rank }) : ''}
                      </span>
                    </div>
                    <span className="relative shrink-0">
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        className="h-7 w-24 pr-6 text-right tabular-nums"
                        value={allocationDrafts[child.id] ?? ''}
                        onChange={(event) =>
                          setAllocationDrafts((current) => ({
                            ...current,
                            [child.id]: event.target.value,
                          }))
                        }
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center font-mono text-[10px] text-ink-faint">
                        p
                      </span>
                    </span>
                  </div>
                ))}
              </div>

              {/* Red when the split does not add up — saving is blocked on the same condition,
                  so the reason the button is disabled is visible rather than implied. */}
              <div
                className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 font-mono text-[11px] tabular-nums ${
                  allocationMatches
                    ? 'border-line bg-bg-base text-ink-soft'
                    : 'border-accent-red/30 bg-accent-red/[0.06] text-accent-red'
                }`}
              >
                <span>{t('pf.allocatedTotal')}</span>
                <strong>
                  {formatPlatinumValue(allocationTotal)} /{' '}
                  {formatPlatinumValue(allocationExpectedTotal)}
                </strong>
              </div>

              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setAllocationGroupId(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleSaveAllocations()}
                  disabled={savingAllocations || !allocationMatches}
                >
                  {savingAllocations ? t('pf.saving') : t('pf.saveAmounts')}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// A zeroed summary so the full page layout can render immediately (under a loading overlay)
// before the real summary arrives — the structure shows, then populates.
const PLACEHOLDER_PNL_SUMMARY: PortfolioPnlSummary = {
  period: '7d',
  lastUpdatedAt: null,
  realizedProfit: 0,
  unrealizedValue: 0,
  unrealizedPnl: 0,
  totalPnl: 0,
  openExposure: 0,
  turnoverBought: 0,
  turnoverSold: 0,
  totalTrades: 0,
  closedTrades: 0,
  openBuys: 0,
  keptItems: 0,
  costBasisCoveragePct: 0,
  currentValueCoveragePct: 0,
  winRate: 0,
  averageMargin: null,
  averageProfitPerTrade: 0,
  averageHoldHours: null,
  soldAsSetProfit: 0,
  flipProfit: 0,
  unmatchedSellRevenue: 0,
  partialCostBasisRevenue: 0,
  keptInventoryValue: 0,
  partialSetProfit: 0,
  bestTradeItem: null,
  bestTradeProfit: null,
  worstTradeItem: null,
  worstTradeProfit: null,
  previousRealizedProfit: null,
  itemBreakdown: [],
  inventoryRows: [],
  auditRows: [],
  categoryBreakdown: [],
  sourceBreakdown: [],
  cumulativeProfitPoints: [],
  profitPerTradePoints: [],
  notes: [],
};

/** Absolute-fill loading overlay placed over a panel/section that's still loading. */
function PortfolioLoadingOverlay({ label }: { label?: string }) {
  return (
    <div className="absolute inset-0 z-(--z-raised) flex items-center justify-center gap-2.5 rounded-lg bg-bg-base/55 backdrop-blur-[2px]">
      <span
        className="size-[22px] animate-spin rounded-full border-[3px] border-accent-blue/20 border-t-accent-blue"
        aria-hidden="true"
      />
      {label ? <span className="font-mono text-xs text-ink-soft">{label}</span> : null}
    </div>
  );
}

function PnlSummaryTab({
  username,
  period,
  onRefreshTrades,
}: {
  username: string | null;
  period: '7d' | '30d' | '90d' | 'all';
  onRefreshTrades: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const setTradePeriod = useAppStore((state) => state.setTradePeriod);
  const [summary, setSummary] = useState<PortfolioPnlSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingTrades, setRefreshingTrades] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Inventory value is computed separately because per-part valuation is slower — it loads
  // independently so it never blocks the rest of the page.
  const [inventory, setInventory] = useState<SetCompletionInventoryValue | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!username) {
      setSummary(null);
      setErrorMessage(null);
      return;
    }

    let cancelled = false;

    const loadSummary = async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const nextSummary = await getPortfolioPnlSummary(username, period);
        if (!cancelled) {
          setSummary(nextSummary);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(formatPortfolioError(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSummary();

    return () => {
      cancelled = true;
    };
  }, [period, username]);

  // Owned-inventory value: period-independent, loaded in parallel with (and after) the
  // summary so the page populates progressively.
  // Friendly, non-technical message for an inventory-value load failure.
  const formatInventoryError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    if (/session expired|sign in/i.test(message)) {
      return t('pf.sessionExpiredInventory');
    }
    if (/network|timed out|timeout|reach|connection|fetch/i.test(message)) {
      return t('pf.couldNotReachInventory');
    }
    return t('pf.couldNotLoadInventory');
  };

  // Retry-able inventory value load, shared by the manual refresh and the retry button so a
  // failure surfaces a clear message instead of leaving the card spinning forever.
  const reloadInventory = async () => {
    setInventoryLoading(true);
    setInventoryError(null);
    try {
      setInventory(await getPortfolioInventoryValue());
    } catch (error) {
      setInventoryError(formatInventoryError(error));
    } finally {
      setInventoryLoading(false);
    }
  };

  useEffect(() => {
    if (!username) {
      setInventory(null);
      setInventoryError(null);
      return;
    }

    let cancelled = false;
    setInventoryLoading(true);
    setInventoryError(null);
    void getPortfolioInventoryValue()
      .then((value) => {
        if (!cancelled) {
          setInventory(value);
          setInventoryError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setInventoryError(formatInventoryError(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setInventoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [username]);

  const handleRefresh = async () => {
    if (!username) {
      return;
    }

    setRefreshingTrades(true);
    setErrorMessage(null);

    try {
      await onRefreshTrades();
      const nextSummary = await getPortfolioPnlSummary(username, period);
      setSummary(nextSummary);
      // Re-value inventory too (separate, slower) without blocking the summary refresh.
      void reloadInventory();
    } catch (error) {
      setErrorMessage(formatPortfolioError(error));
    } finally {
      setRefreshingTrades(false);
    }
  };

  // The full layout renders immediately using a zeroed placeholder while the real summary
  // loads (under an overlay), then populates in place.
  const bodySummary = summary ?? PLACEHOLDER_PNL_SUMMARY;
  const sourceBarMax = Math.max(1, ...bodySummary.sourceBreakdown.map((row) => Math.abs(row.value)));
  const categoryBarMax = Math.max(1, ...bodySummary.categoryBreakdown.map((row) => Math.abs(row.value)));
  const itemBarMax = Math.max(1, ...bodySummary.itemBreakdown.map((row) => Math.abs(row.value)));
  // "Kept" means you decided to hold it, so it is inventory rather than an open position.
  // The backend excludes kept rows from `unrealizedPnl` too (`trades.rs`, same rule as
  // `open_exposure`), so the hero figure and these rows describe the same set.
  const openPositions = bodySummary.inventoryRows
    .filter((row) => row.status !== 'kept')
    .sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);
  const keptCount = bodySummary.inventoryRows.length - openPositions.length;
  const previousDelta =
    bodySummary.previousRealizedProfit === null || bodySummary.previousRealizedProfit === undefined
      ? null
      : bodySummary.realizedProfit - bodySummary.previousRealizedProfit;

  return (
    <>
      {errorMessage ? (
        <div className="mx-4 mt-4 rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11px] text-accent-red">
          {errorMessage}
        </div>
      ) : null}

      {!username ? (
        <div className="p-4">
          <EmptyState
            icon="ti-plug-connected-x"
            title={t('pf.connectFirst')}
            detail={t('pf.connectFirstDetail')}
          />
        </div>
      ) : (
        <div className="relative flex flex-col gap-4 p-4">
          {!summary ? <PortfolioLoadingOverlay label={t('pf.loadingPortfolioSummary')} /> : null}

          {/* One frame, not four. The hero was a bordered card containing three more bordered
              cards; the three secondary figures are `Metric`s now, separated by space. */}
          <Panel className="gap-0">
            <PanelHeader className="flex-wrap gap-3">
              <PanelTitle>{t('pf.netPosition')}</PanelTitle>

              <div className="flex items-center gap-0.5 rounded-md bg-bg-base p-0.5" role="group" aria-label={t('pf.period')}>
                {(['7d', '30d', '90d', 'all'] as const).map((nextPeriod) => {
                  const active = period === nextPeriod;
                  return (
                    <Button
                      key={nextPeriod}
                      variant="ghost"
                      size="sm"
                      static
                      aria-pressed={active}
                      onClick={() => {
                        // Clear any stale error from the previous period before switching.
                        setErrorMessage(null);
                        setTradePeriod(nextPeriod);
                      }}
                      className={`h-6 rounded-sm px-2 text-[11px] font-medium tabular-nums ${
                        active ? 'bg-bg-elevated text-ink' : 'text-ink-dim hover:text-ink'
                      }`}
                    >
                      {nextPeriod === 'all' ? t('pf.allTime') : nextPeriod}
                    </Button>
                  );
                })}
              </div>

              <span className="ml-auto flex items-center gap-3">
                {summary?.lastUpdatedAt ? (
                  <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                    {t('pf.lastUpdated')} {formatShortLocalDateTime(summary.lastUpdatedAt)}
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRefresh()}
                  disabled={loading || refreshingTrades || !username}
                >
                  <i className="ti ti-refresh" aria-hidden="true" />
                  {refreshingTrades ? t('pf.refreshing') : t('pf.refreshTrades')}
                </Button>
              </span>
            </PanelHeader>

            <div className="flex flex-wrap items-end gap-x-10 gap-y-4 p-4">
              <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1 font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
                  {t('pf.realizedProfit')}
                  <InfoHint text={t('pf.realizedProfitInfo')} placement="bottom" />
                </span>
                {/* The page's one focal point: platinum actually banked. */}
                <span
                  className={`font-mono text-[42px] leading-none font-bold tracking-tight tabular-nums ${
                    bodySummary.realizedProfit >= 0 ? 'text-accent-green' : 'text-accent-red'
                  }`}
                >
                  {formatSignedPlatinumValue(bodySummary.realizedProfit)}
                </span>
                {previousDelta !== null ? (
                  <span
                    className={`w-fit rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                      previousDelta > 0
                        ? 'bg-accent-green/15 text-accent-green'
                        : previousDelta < 0
                          ? 'bg-accent-red/15 text-accent-red'
                          : 'bg-bg-elevated text-ink-dim'
                    }`}
                  >
                    <i
                      className={`ti ${previousDelta > 0 ? 'ti-trending-up' : previousDelta < 0 ? 'ti-trending-down' : 'ti-minus'}`}
                      aria-hidden="true"
                    />{' '}
                    {formatSignedPlatinumValue(previousDelta)} {t('pf.vsPrior', { period })}
                  </span>
                ) : null}
              </div>

              <MetricGrid columns={3} className="flex-1">
                <Metric
                  label={t('pf.totalPnl')}
                  value={formatSignedPlatinumValue(bodySummary.totalPnl)}
                  tone={bodySummary.totalPnl >= 0 ? 'green' : 'red'}
                  hint={<InfoHint text={t('pf.totalPnlInfo')} />}
                />
                <Metric
                  label={t('pf.unrealizedPnl')}
                  value={formatSignedPlatinumValue(bodySummary.unrealizedPnl)}
                  tone={bodySummary.unrealizedPnl >= 0 ? 'green' : 'red'}
                  hint={<InfoHint text={t('pf.unrealizedPnlInfo')} />}
                />
                <Metric
                  label={t('pf.openBuys')}
                  value={formatPlatinumValue(bodySummary.openExposure)}
                  hint={<InfoHint text={t('pf.openBuysInfo')} />}
                />
              </MetricGrid>
            </div>
          </Panel>

          {/* Five bordered cells became a borderless `MetricGrid` — this is what that primitive
              was extracted for. Space separates them; the numbers keep their tone. */}
          <MetricGrid columns={5} className="px-1">
            <Metric
              label={t('pf.closedTrades')}
              value={String(bodySummary.closedTrades)}
              hint={<InfoHint text={t('pf.closedTradesInfo')} />}
            />
            <Metric
              label={t('pf.winRate')}
              value={formatPercentValue(bodySummary.winRate)}
              tone={bodySummary.winRate >= 50 ? 'green' : bodySummary.winRate >= 35 ? 'blue' : 'red'}
              hint={<InfoHint text={t('pf.winRateInfo')} />}
            />
            <Metric
              label={t('pf.avgMargin')}
              value={formatPercentValue(bodySummary.averageMargin)}
              tone="blue"
              hint={<InfoHint text={t('pf.avgMarginInfo')} />}
            />
            <Metric
              label={t('pf.avgHold')}
              value={formatHoursValue(bodySummary.averageHoldHours)}
              hint={<InfoHint text={t('pf.avgHoldInfo')} />}
            />
            <Metric
              label={t('pf.avgProfitTrade')}
              value={formatPlatinumValue(Math.round(bodySummary.averageProfitPerTrade))}
              tone="green"
              hint={<InfoHint text={t('pf.avgProfitTradeInfo')} />}
            />
          </MetricGrid>

          <div className="grid gap-4 lg:grid-cols-2">
            <CumulativeProfitChart summary={bodySummary} />
            <ProfitPerTradeChart summary={bodySummary} />
          </div>

          <Panel className="gap-0">
            <PanelHeader>
              <PanelTitle variant="heading">{t('pf.positionsTitle')}</PanelTitle>
              <InfoHint text={t('pf.positionsInfo')} />
              {keptCount > 0 ? (
                <span className="ml-auto font-mono text-[10px] text-ink-faint tabular-nums">
                  {t('pf.keptExcluded', { n: keptCount })}
                </span>
              ) : null}
            </PanelHeader>
            <div className="p-3">
              {openPositions.length === 0 ? (
                <EmptyState icon="ti-package" title={t('pf.noPositions')} />
              ) : (
                // Capped and scrolled: the list grows with every kept item, and an unbounded
                // table pushed the breakdown panels off the page. `max-h` rather than a fixed
                // height so a two-position list doesn't sit in a pane of dead space.
                <div className="max-h-80 overflow-auto overscroll-contain">
                  <table className="w-full border-collapse">
                    {/* Sticky header — a scrolling table whose column labels scroll away is
                        worse than one that doesn't scroll at all. `bg-bg-panel` is opaque so
                        rows don't show through it. */}
                    <thead className="sticky top-0 z-(--z-raised) bg-bg-panel">
                      <tr className="border-b border-line">
                        {[t('wl.item'), t('wl.qty'), t('pf.cost'), t('pf.currentValue'), t('pf.unrealizedPnl')].map(
                          (heading, index) => (
                            <th
                              key={heading}
                              className={`py-1.5 font-mono text-[9px] font-bold tracking-[0.07em] text-ink-faint uppercase ${
                                index === 0 ? 'text-left' : 'text-right'
                              }`}
                            >
                              {heading}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {openPositions.map((row) => (
                        <tr key={row.id} className="border-b border-line-subtle last:border-b-0">
                          <td className="py-1.5">
                            <div className="flex items-center gap-2.5">
                              <ItemThumb
                                src={resolveWfmAssetUrl(row.imagePath, row.slug)}
                                fallback={row.itemName.charAt(0)}
                                size="size-7"
                              />
                              <div className="flex min-w-0 flex-col">
                                <ItemName
                                  name={row.itemName}
                                  slug={row.slug}
                                  imagePath={row.imagePath}
                                  className="truncate text-[11px] font-medium text-ink"
                                />
                                {row.rank !== null ? (
                                  <span className="font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
                                    R{row.rank}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </td>
                          <td className="py-1.5 text-right font-mono text-[11px] text-ink-soft tabular-nums">
                            {row.quantity}
                          </td>
                          <td className="py-1.5 text-right font-mono text-[11px] text-ink-soft tabular-nums">
                            {formatPlatinumValue(row.costBasis)}
                          </td>
                          <td className="py-1.5 text-right font-mono text-[11px] text-ink tabular-nums">
                            {formatPlatinumValue(row.estimatedValue)}
                          </td>
                          <td
                            className={`py-1.5 text-right font-mono text-[11px] font-bold tabular-nums ${
                              row.unrealizedPnl >= 0 ? 'text-accent-green' : 'text-accent-red'
                            }`}
                          >
                            {formatSignedPlatinumValue(row.unrealizedPnl)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Panel>

          {/* Three breakdowns of the same shape — where the profit came from, by three cuts. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel className="gap-0">
              <PanelHeader>
                <PanelTitle variant="heading">{t('a11y.tradeBreakdown')}</PanelTitle>
                <InfoHint text={t('pf.tradeBreakdownInfo')} />
              </PanelHeader>
              <div className="p-3">
                <BreakdownList
                  rows={bodySummary.sourceBreakdown}
                  max={sourceBarMax}
                  emptyLabel={t('pf.noClosedSell')}
                />
              </div>
            </Panel>

            <Panel className="gap-0">
              <PanelHeader>
                <PanelTitle variant="heading">{t('a11y.categoryBreakdown')}</PanelTitle>
                <InfoHint text={t('pf.categoryBreakdownInfo')} />
              </PanelHeader>
              <div className="p-3">
                <BreakdownList
                  rows={bodySummary.categoryBreakdown}
                  max={categoryBarMax}
                  emptyLabel={t('pf.noCategoryProfit')}
                />
              </div>
            </Panel>
          </div>

          <Panel className="gap-0">
            <PanelHeader>
              <PanelTitle variant="heading">{t('pf.topItems')}</PanelTitle>
              <InfoHint text={t('pf.topItemsInfo')} />
            </PanelHeader>
            <div className="p-3">
              <BreakdownList
                rows={bodySummary.itemBreakdown}
                max={itemBarMax}
                emptyLabel={t('pf.noItemProfit')}
              />
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel className="gap-0">
              <PanelHeader>
                <PanelTitle variant="heading">{t('a11y.dataConfidence')}</PanelTitle>
                <InfoHint text={t('pf.dataConfidenceInfo')} />
              </PanelHeader>
              <div className="flex flex-col gap-2 p-3">
                <MetricGrid>
                  <Metric
                    label={t('pf.profitBasis')}
                    value={formatPercentValue(bodySummary.costBasisCoveragePct)}
                    tone={portfolioCoverageTone(bodySummary.costBasisCoveragePct)}
                  />
                  <Metric
                    label={t('pf.inventoryValue')}
                    value={formatPercentValue(bodySummary.currentValueCoveragePct)}
                    tone={portfolioCoverageTone(bodySummary.currentValueCoveragePct)}
                  />
                </MetricGrid>
                {bodySummary.notes.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {bodySummary.notes.map((note) => (
                      <span
                        key={note}
                        className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] text-ink-dim"
                      >
                        {note}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </Panel>

            <Panel className="relative gap-0">
              {(inventoryLoading || !inventory) && !inventoryError ? <PortfolioLoadingOverlay /> : null}
              <PanelHeader>
                <PanelTitle variant="heading">{t('pf.plannerInventory')}</PanelTitle>
                <InfoHint text={t('pf.plannerInventoryInfo')} />
              </PanelHeader>
              <div className="flex flex-col gap-2 p-3">
                <span className="font-mono text-2xl leading-none font-bold text-ink tabular-nums">
                  {formatPlatinumValue(inventory?.totalValue ?? 0)}
                </span>
                {inventoryError ? (
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-accent-red">
                    <span>{inventoryError}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void reloadInventory()}
                      disabled={inventoryLoading}
                      className="h-6 text-[11px]"
                    >
                      {inventoryLoading ? t('pf.retrying') : t('common.retry')}
                    </Button>
                  </div>
                ) : inventory && inventory.unpricedCount > 0 ? (
                  <span className="text-[11px] text-ink-dim">
                    {t('pf.partsNotYetPriced', { n: inventory.unpricedCount })}
                  </span>
                ) : null}
              </div>
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

export function PortfolioPage() {
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const tradePeriod = useAppStore((s) => s.tradePeriod);
  // Sub-view selection lives in the store: the sidebar renders this page's sub-navigation.
  const portfolioTab = useAppStore((s) => s.portfolioSubTab);

  const handleRefreshTrades = async () => {
    if (!tradeAccount?.name) {
      return;
    }

    // Recomputes from the stored log; trades arrive from EE.log, not a WFM pull.
    await getCachedWfmProfileTradeLog(tradeAccount.name);
  };

  return (
    <>
      <PageHeading page="portfolio" />
      <div className="page-content">
        {portfolioTab === 'log' ? (
          <TradeLogTab username={tradeAccount?.name ?? null} />
        ) : (
          <PnlSummaryTab
            username={tradeAccount?.name ?? null}
            period={tradePeriod}
            onRefreshTrades={handleRefreshTrades}
          />
        )}
      </div>
    </>
  );
}
