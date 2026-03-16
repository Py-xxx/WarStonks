import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceWfmTradeLogResync,
  getCachedWfmProfileTradeLog,
  getPortfolioPnlSummary,
  getWfmProfileTradeLog,
  migrateAlecaframeTradeLog,
  setWfmTradeLogKeepItem,
  updateTradeGroupAllocations,
} from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { formatPlatinumValue } from '../../lib/trades';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { PortfolioPnlSummary, PortfolioTradeLogEntry } from '../../types';

const RefreshIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

const PORTFOLIO_TOOLTIP_TOP_CLEARANCE_PX = 120;

type InfoHintPlacement = 'auto' | 'bottom' | 'left';

function InfoHint({
  text,
  placement = 'auto',
}: {
  text: string;
  placement?: InfoHintPlacement;
}) {
  const hintRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const [expandDownward, setExpandDownward] = useState(false);

  const updatePlacement = () => {
    if (placement !== 'auto') {
      setExpandDownward(placement === 'bottom');
      return;
    }

    const hintRect = hintRef.current?.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    if (!hintRect || !tooltipRect) {
      return;
    }

    const topClearance = hintRect.top;
    const requiredClearance = Math.max(
      tooltipRect.height + 20,
      PORTFOLIO_TOOLTIP_TOP_CLEARANCE_PX,
    );
    setExpandDownward(topClearance < requiredClearance);
  };

  return (
    <span
      ref={hintRef}
      className="info-hint"
      tabIndex={0}
      aria-label={text}
      onMouseEnter={updatePlacement}
      onFocus={updatePlacement}
    >
      <span className="info-hint-glyph" aria-hidden="true">i</span>
      <span
        ref={tooltipRef}
        className={`info-hint-tooltip${placement === 'left' ? ' left' : expandDownward ? ' bottom' : ''}`}
      >
        {text}
      </span>
    </span>
  );
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

function portfolioCoverageLabel(value: number): string {
  if (value >= 95) {
    return 'Strong';
  }
  if (value >= 75) {
    return 'Partial';
  }
  return 'Limited';
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

function CumulativeProfitChart({ summary }: { summary: PortfolioPnlSummary }) {
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
    <div className="chart-card">
      <PortfolioPanelHeader
        title="Cumulative Profit Curve"
        info="Running realized profit over time for the selected period. This only uses closed sell rows."
      />
      <div className="chart-body portfolio-chart-body">
        {summary.cumulativeProfitPoints.length === 0 ? (
          <div className="portfolio-chart-empty">No closed trades in this period yet.</div>
        ) : (
          <div className="portfolio-chart-shell">
            <div className="portfolio-chart-callout">
              <span className="portfolio-chart-callout-label">Active Point</span>
              <div className="portfolio-chart-callout-value">
                {activeData ? formatSignedPlatinumValue(activeData.cumulativeProfit) : '—'}
              </div>
              <span className="portfolio-chart-callout-meta">
                {activeData ? formatChartDateLabel(activeData.bucketAt) : 'Move across the curve'}
              </span>
            </div>
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
                        {label.label}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

function ProfitPerTradeChart({ summary }: { summary: PortfolioPnlSummary }) {
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
  const activeIndex = hoverIndex ?? Math.max(points.length - 1, 0);
  const activeTrade = points[activeIndex] ?? null;
  const xLabelIndices = new Set(
    points.length <= 4 ? points.map((_, index) => index) : [0, Math.floor(points.length / 2), points.length - 1],
  );

  return (
    <div className="chart-card">
      <PortfolioPanelHeader
        title="Profit Per Trade"
        info="Each bar is one closed sell row. Positive values are green, negative values are red."
        infoPlacement="left"
      />
      <div className="chart-body portfolio-chart-body">
        {points.length === 0 ? (
          <div className="portfolio-chart-empty">Profit bars will appear after your first completed sells.</div>
        ) : (
          <div className="portfolio-chart-shell">
            <div className="portfolio-chart-callout">
              <span className="portfolio-chart-callout-label">Active Trade</span>
              <div className={`portfolio-chart-callout-value${activeTrade && activeTrade.profit < 0 ? ' negative' : ''}`}>
                {activeTrade ? formatSignedPlatinumValue(activeTrade.profit) : '—'}
              </div>
              <span className="portfolio-chart-callout-meta">
                {activeTrade ? `${activeTrade.itemName} · ${formatChartDateLabel(activeTrade.closedAt)}` : 'Hover a bar'}
              </span>
            </div>
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
                const isActive = activeIndex === index;
                return (
                  <g key={point.id}>
                    <rect
                      x={x}
                      y={padding.top}
                      width={Math.max(barSlotWidth, 16)}
                      height={height - padding.top - padding.bottom}
                      fill="transparent"
                      onMouseEnter={() => setHoverIndex(index)}
                      onMouseMove={() => setHoverIndex(index)}
                      onMouseLeave={() => setHoverIndex(null)}
                    />
                    <rect
                      x={x}
                      y={y}
                      width={barWidth}
                      height={Math.max(normalizedHeight, 3)}
                      rx="4"
                      fill={isPositive ? 'rgba(61,214,140,0.7)' : 'rgba(240,79,88,0.7)'}
                      stroke={isActive ? (isPositive ? 'rgba(61,214,140,1)' : 'rgba(240,79,88,1)') : 'transparent'}
                      strokeWidth="1.1"
                    />
                    {xLabelIndices.has(index) ? (
                      <text
                        x={x + barWidth / 2}
                        y={height - 10}
                        textAnchor="middle"
                        fill="var(--text-muted)"
                        fontSize="9"
                        fontFamily="JetBrains Mono"
                      >
                        {new Date(point.closedAt).toLocaleDateString('en-GB', {
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
    </div>
  );
}

function renderTradeType(orderType: PortfolioTradeLogEntry['orderType']): string {
  return orderType === 'buy' ? 'Buy' : 'Sell';
}

function buildTradeTypeClassName(orderType: PortfolioTradeLogEntry['orderType']): string {
  return orderType === 'buy' ? 'badge-blue' : 'badge-green';
}

function buildTradeStatusClassName(status: string | null): string {
  switch (status) {
    case 'Flip':
      return 'badge-green';
    case 'Sold As Set':
      return 'badge-purple';
    case 'Kept':
      return 'badge-amber';
    case 'Open':
      return 'badge-blue';
    default:
      return 'badge';
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

function buildDefaultMigrationDate(): string {
  const baseline = new Date();
  baseline.setDate(baseline.getDate() - 90);
  return baseline.toISOString().slice(0, 10);
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

function downloadTradeLogCsv(entries: PortfolioTradeLogEntry[]) {
  const rows = [
    [
      'Item',
      'Slug',
      'Type',
      'Source',
      'Price',
      'Quantity',
      'Rank',
      'Profit',
      'MarginPct',
      'Status',
      'ClosedAt',
      'UpdatedAt',
      'GroupId',
      'AllocationMode',
    ],
    ...entries.map((entry) => [
      entry.itemName,
      entry.slug,
      entry.orderType,
      entry.source,
      String(entry.platinum),
      String(entry.quantity),
      entry.rank == null ? '' : String(entry.rank),
      entry.profit == null ? '' : String(entry.profit),
      entry.margin == null ? '' : entry.margin.toFixed(2),
      entry.status ?? '',
      entry.closedAt,
      entry.updatedAt,
      entry.groupId ?? '',
      entry.allocationMode ?? '',
    ]),
  ];
  const csv = rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(','),
    )
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `warstonks-trade-log-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
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
      label: entry.groupLabel ?? 'Multiple Item Trade',
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
    return 'No items in this trade';
  }

  const names = children.slice(0, 2).map((child) => child.itemName);
  const suffix = children.length > 2 ? ` +${children.length - 2} more` : '';
  return `${names.join(' • ')}${suffix}`;
}

function PortfolioPanelHeader({
  title,
  info,
  infoPlacement = 'auto',
}: {
  title: string;
  info: string;
  infoPlacement?: InfoHintPlacement;
}) {
  return (
    <div className="chart-header portfolio-panel-header">
      <span>{title}</span>
      <InfoHint text={info} placement={infoPlacement} />
    </div>
  );
}

function TradeLogTab({ username }: { username: string | null }) {
  const appSettings = useAppStore((state) => state.appSettings);
  const [entries, setEntries] = useState<PortfolioTradeLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [savingAllocations, setSavingAllocations] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const [migrateModalOpen, setMigrateModalOpen] = useState(false);
  const [migrationBaselineDate, setMigrationBaselineDate] = useState(buildDefaultMigrationDate);
  const [allocationGroupId, setAllocationGroupId] = useState<string | null>(null);
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [orderTypeFilter, setOrderTypeFilter] = useState<'all' | 'buy' | 'sell'>('all');
  const [statusFilter, setStatusFilter] =
    useState<'all' | 'Flip' | 'Sold As Set' | 'Open' | 'Kept' | 'none'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'wfm' | 'alecaframe'>('all');
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

  const displayRows = useMemo(() => buildTradeLogDisplayRows(filteredEntries), [filteredEntries]);
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
      setErrorMessage('Connect your Warframe Market account in Trades first.');
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const nextState = await getWfmProfileTradeLog(username);
      applyTradeLogState(nextState);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const handleToggleKeepItem = async (entry: PortfolioTradeLogEntry) => {
    if (!username || entry.orderType !== 'buy') {
      return;
    }

    setUpdatingOrderId(entry.id);
    setErrorMessage(null);

    try {
      const nextState = await setWfmTradeLogKeepItem(username, entry.id, !entry.keepItem);
      applyTradeLogState(nextState);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingOrderId(null);
    }
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

  const handleMigrate = async () => {
    if (!username) {
      setErrorMessage('Connect your Warframe Market account in Trades first.');
      return;
    }

    setMigrating(true);
    setErrorMessage(null);

    try {
      const nextState = await migrateAlecaframeTradeLog(username, {
        baselineDate: migrationBaselineDate,
      });
      applyTradeLogState(nextState);
      setMigrateModalOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMigrating(false);
    }
  };

  const handleForceResync = async () => {
    if (!username) {
      setErrorMessage('Connect your Warframe Market account in Trades first.');
      return;
    }

    setResyncing(true);
    setErrorMessage(null);

    try {
      const nextState = await forceWfmTradeLogResync(username);
      applyTradeLogState(nextState);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setResyncing(false);
    }
  };

  const handleSaveAllocations = async () => {
    if (!username || !allocationGroup) {
      return;
    }

    if (!allocationMatches) {
      setErrorMessage(`Adjusted totals must add up to ${formatPlatinumValue(allocationExpectedTotal)}.`);
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
      setErrorMessage(error instanceof Error ? error.message : String(error));
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
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }

      try {
        const nextState = await getWfmProfileTradeLog(username);
        if (!cancelled) {
          applyTradeLogState(nextState);
          setErrorMessage(null);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
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
    <>
      <div className="period-bar">
        <label>Trade Log</label>
        <div className="period-right portfolio-log-toolbar">
          {lastUpdatedAt ? (
            <span className="portfolio-log-updated">Last updated {formatShortLocalDateTime(lastUpdatedAt)}</span>
          ) : null}
          {appSettings.alecaframe.enabled && username ? (
            <button
              className="act-btn portfolio-secondary-btn"
              type="button"
              onClick={() => {
                setMigrationBaselineDate(buildDefaultMigrationDate());
                setMigrateModalOpen(true);
              }}
            >
              Migrate
            </button>
          ) : null}
          {username ? (
            <button
              className="act-btn portfolio-secondary-btn"
              type="button"
              onClick={() => void handleForceResync()}
              disabled={resyncing || loading}
            >
              {resyncing ? 'Resyncing…' : 'Force Resync'}
            </button>
          ) : null}
          <button
            className="act-btn portfolio-secondary-btn"
            type="button"
            onClick={() => downloadTradeLogCsv(filteredEntries)}
            disabled={filteredEntries.length === 0}
          >
            Export CSV
          </button>
          <button
            className="act-btn portfolio-refresh-btn"
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || resyncing}
          >
            <RefreshIcon />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {errorMessage ? <div className="scanner-inline-error">{errorMessage}</div> : null}

      {!username ? (
        <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
          <span className="empty-primary">Connect your Warframe Market account first</span>
          <span className="empty-sub">Trade Log uses your public WFM profile statistics.</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
          <span className="empty-primary">{loading ? 'Loading trade history…' : 'No trade history loaded yet'}</span>
          <span className="empty-sub">
            {loading
              ? 'Loading your cached trade log and updating it from Warframe Market.'
              : 'Open the tab or press Refresh to load your last 90 days of buy and sell orders.'}
          </span>
        </div>
      ) : (
        <div className="portfolio-log-stack">
          <div className="portfolio-log-card portfolio-filter-card">
            <PortfolioPanelHeader
              title="Filters"
              info="Filter the permanent local trade ledger by type, status, source, item name, and close date range."
            />
            <div className="portfolio-log-filters">
              <label className="portfolio-filter-field">
                <span>Search</span>
                <input
                  className="settings-text-input"
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Item name or slug"
                />
              </label>
              <label className="portfolio-filter-field">
                <span>Type</span>
                <select
                  className="settings-text-input"
                  value={orderTypeFilter}
                  onChange={(event) => setOrderTypeFilter(event.target.value as 'all' | 'buy' | 'sell')}
                >
                  <option value="all">All</option>
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </label>
              <label className="portfolio-filter-field">
                <span>Status</span>
                <select
                  className="settings-text-input"
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as 'all' | 'Flip' | 'Sold As Set' | 'Open' | 'Kept' | 'none')
                  }
                >
                  <option value="all">All</option>
                  <option value="Flip">Flip</option>
                  <option value="Sold As Set">Sold As Set</option>
                  <option value="Open">Open</option>
                  <option value="Kept">Kept</option>
                  <option value="none">No Status</option>
                </select>
              </label>
              <label className="portfolio-filter-field">
                <span>Source</span>
                <select
                  className="settings-text-input"
                  value={sourceFilter}
                  onChange={(event) => setSourceFilter(event.target.value as 'all' | 'wfm' | 'alecaframe')}
                >
                  <option value="all">All</option>
                  <option value="wfm">warframe.market</option>
                  <option value="alecaframe">Alecaframe</option>
                </select>
              </label>
              <label className="portfolio-filter-field">
                <span>From</span>
                <input className="settings-text-input" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
              </label>
              <label className="portfolio-filter-field">
                <span>To</span>
                <input className="settings-text-input" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
              </label>
            </div>
          </div>

          <div className="portfolio-log-card">
            <PortfolioPanelHeader
              title="Trade Log Ledger"
              info="Permanent local trade ledger built from warframe.market history, Alecaframe imports, and local reconciliation rules."
            />
            <div className="portfolio-log-header">
              <span>Item</span>
              <span>Type</span>
              <span>Price</span>
              <span>Qty</span>
              <span>Rank</span>
              <span>Profit</span>
              <span>Margin</span>
              <span>Status</span>
              <span>Closed</span>
              <span>Action</span>
            </div>

            <div className="portfolio-log-list">
              {displayRows.length === 0 ? (
                <div className="portfolio-breakdown-empty">No trades match the current filters.</div>
              ) : (
                displayRows.map((row) =>
                  row.kind === 'single' ? (
                    <div key={row.entry.id} className="portfolio-log-group">
                      <div className="portfolio-log-row">
                        <div className="portfolio-log-item">
                          <span className="portfolio-log-thumb">
                            {row.entry.imagePath ? (
                              <img src={resolveWfmAssetUrl(row.entry.imagePath) ?? undefined} alt="" />
                            ) : (
                              <span className="portfolio-log-thumb-fallback">{row.entry.itemName.charAt(0)}</span>
                            )}
                          </span>
                          <div className="portfolio-log-item-copy">
                            <span className="portfolio-log-item-name">{row.entry.itemName}</span>
                            <span className="portfolio-log-item-slug">{row.entry.slug}</span>
                            <div className="portfolio-row-badges">
                              <span className="badge">{row.entry.source === 'wfm' ? 'WFM' : 'Alecaframe'}</span>
                            </div>
                          </div>
                        </div>
                        <span className={`badge ${buildTradeTypeClassName(row.entry.orderType)}`}>{renderTradeType(row.entry.orderType)}</span>
                        <span className="portfolio-log-value">{formatPlatinumValue(row.entry.platinum)}</span>
                        <span className="portfolio-log-value">{row.entry.quantity}</span>
                        <span className="portfolio-log-value">{row.entry.rank ?? '—'}</span>
                        <span className="portfolio-log-value">{row.entry.profit == null ? '—' : formatPlatinumValue(row.entry.profit)}</span>
                        <span className="portfolio-log-value">{formatMarginValue(row.entry.margin)}</span>
                        <span>
                          {row.entry.status ? (
                            <span className={`badge ${buildTradeStatusClassName(row.entry.status)}`}>{row.entry.status}</span>
                          ) : (
                            <span className="portfolio-log-value">—</span>
                          )}
                        </span>
                        <span className="portfolio-log-date">{formatShortLocalDateTime(row.entry.closedAt)}</span>
                        <span className="portfolio-log-actions">
                          {row.entry.orderType === 'buy' ? (
                            <label className="portfolio-keep-toggle-wrap">
                              <button
                                className={`toggle portfolio-keep-toggle${row.entry.keepItem ? ' on' : ''}`}
                                type="button"
                                role="switch"
                                aria-checked={row.entry.keepItem}
                                aria-label={`Keep ${row.entry.itemName}`}
                                onClick={() => void handleToggleKeepItem(row.entry)}
                                disabled={updatingOrderId === row.entry.id}
                              />
                              <span>{updatingOrderId === row.entry.id ? 'Saving…' : 'Keep Item'}</span>
                            </label>
                          ) : (
                            <span className="portfolio-log-value">—</span>
                          )}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div key={row.groupId} className="portfolio-log-group">
                      <div className="portfolio-log-row portfolio-log-row-parent">
                        <div className="portfolio-log-item">
                          <button
                            className="portfolio-log-expand-btn"
                            type="button"
                            aria-label={expandedGroupIds.includes(row.groupId) ? `Collapse ${row.label}` : `Expand ${row.label}`}
                            onClick={() => handleToggleGroupExpanded(row.groupId)}
                          >
                            {expandedGroupIds.includes(row.groupId) ? '−' : '+'}
                          </button>
                          <span className="portfolio-log-thumb">
                            {row.children[0]?.imagePath ? (
                              <img src={resolveWfmAssetUrl(row.children[0].imagePath) ?? undefined} alt="" />
                            ) : (
                              <span className="portfolio-log-thumb-fallback">M</span>
                            )}
                          </span>
                          <div className="portfolio-log-item-copy">
                            <span className="portfolio-log-item-name">{row.label}</span>
                            <span className="portfolio-log-item-slug">
                              {buildTradeGroupSummary(row.children)} · {row.itemCount} item{row.itemCount === 1 ? '' : 's'}
                            </span>
                            <div className="portfolio-row-badges">
                              <span className="badge">{row.children[0]?.source === 'wfm' ? 'WFM' : 'Alecaframe'}</span>
                              <span className="badge">
                                {row.children.some((child) => child.allocationMode === 'manual') ? 'Manual Split' : 'Auto Split'}
                              </span>
                            </div>
                          </div>
                        </div>
                        <span className={`badge ${buildTradeTypeClassName(row.orderType)}`}>{renderTradeType(row.orderType)}</span>
                        <span className="portfolio-log-value">{formatPlatinumValue(row.totalPlatinum)}</span>
                        <span className="portfolio-log-value">{row.itemCount}</span>
                        <span className="portfolio-log-value">—</span>
                        <span className="portfolio-log-value">—</span>
                        <span className="portfolio-log-value">—</span>
                        <span className="portfolio-log-value">Grouped</span>
                        <span className="portfolio-log-date">{formatShortLocalDateTime(row.closedAt)}</span>
                        <span className="portfolio-log-actions portfolio-log-actions-parent">
                          <button className="act-btn portfolio-secondary-btn" type="button" onClick={() => handleOpenAllocationModal(row)}>
                            Adjust Amounts
                          </button>
                        </span>
                      </div>
                      {expandedGroupIds.includes(row.groupId)
                        ? row.children.map((child) => (
                            <div key={child.id} className="portfolio-log-child-wrap">
                              <div className="portfolio-log-row portfolio-log-row-child">
                                <div className="portfolio-log-item portfolio-log-item-child">
                                  <span className="portfolio-log-thumb">
                                    {child.imagePath ? (
                                      <img src={resolveWfmAssetUrl(child.imagePath) ?? undefined} alt="" />
                                    ) : (
                                      <span className="portfolio-log-thumb-fallback">{child.itemName.charAt(0)}</span>
                                    )}
                                  </span>
                                  <div className="portfolio-log-item-copy">
                                    <span className="portfolio-log-item-name">{child.itemName}</span>
                                    <span className="portfolio-log-item-slug">{child.slug}</span>
                                    <div className="portfolio-row-badges">
                                      {child.allocationMode ? <span className="badge">{child.allocationMode === 'manual' ? 'Manual' : 'Auto'}</span> : null}
                                    </div>
                                  </div>
                                </div>
                                <span className={`badge ${buildTradeTypeClassName(child.orderType)}`}>{renderTradeType(child.orderType)}</span>
                                <span className="portfolio-log-value">{formatPlatinumValue(child.platinum)}</span>
                                <span className="portfolio-log-value">{child.quantity}</span>
                                <span className="portfolio-log-value">{child.rank ?? '—'}</span>
                                <span className="portfolio-log-value">{child.profit == null ? '—' : formatPlatinumValue(child.profit)}</span>
                                <span className="portfolio-log-value">{formatMarginValue(child.margin)}</span>
                                <span>
                                  {child.status ? (
                                    <span className={`badge ${buildTradeStatusClassName(child.status)}`}>{child.status}</span>
                                  ) : (
                                    <span className="portfolio-log-value">—</span>
                                  )}
                                </span>
                                <span className="portfolio-log-date">{formatShortLocalDateTime(child.closedAt)}</span>
                                <span className="portfolio-log-actions">
                                  {child.orderType === 'buy' ? (
                                    <label className="portfolio-keep-toggle-wrap">
                                      <button
                                        className={`toggle portfolio-keep-toggle${child.keepItem ? ' on' : ''}`}
                                        type="button"
                                        role="switch"
                                        aria-checked={child.keepItem}
                                        aria-label={`Keep ${child.itemName}`}
                                        onClick={() => void handleToggleKeepItem(child)}
                                        disabled={updatingOrderId === child.id}
                                      />
                                      <span>{updatingOrderId === child.id ? 'Saving…' : 'Keep Item'}</span>
                                    </label>
                                  ) : (
                                    <span className="portfolio-log-value">—</span>
                                  )}
                                </span>
                              </div>
                            </div>
                          ))
                        : null}
                    </div>
                  ),
                )
              )}
            </div>
          </div>
        </div>
      )}

      {migrateModalOpen ? (
        <div className="modal-backdrop" onClick={() => setMigrateModalOpen(false)}>
          <div
            className="settings-modal portfolio-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Migrate Alecaframe trades"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <span className="card-label">Trade Log</span>
                <h3>Migrate Alecaframe Trades</h3>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Close migrate trades dialog"
                onClick={() => setMigrateModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <div className="settings-preview-grid">
                <article className="settings-preview-card">
                  <span className="settings-field-label">Purpose</span>
                  <p className="settings-preview-value">
                    Import missing buy and sell trades from Alecaframe without duplicating existing log rows.
                  </p>
                </article>
                <article className="settings-preview-card">
                  <span className="settings-field-label">Baseline Date</span>
                  <input
                    className="settings-text-input"
                    type="date"
                    value={migrationBaselineDate}
                    onChange={(event) => setMigrationBaselineDate(event.target.value)}
                  />
                </article>
              </div>
              <p className="portfolio-modal-note">
                Only trades from this day forward will be migrated. Existing rows with the same item, quantity, and a timestamp within one minute will be skipped.
              </p>
            </div>
            <div className="settings-modal-actions">
              <button className="period-btn" type="button" onClick={() => setMigrateModalOpen(false)}>
                Cancel
              </button>
              <button
                className="act-btn"
                type="button"
                onClick={() => void handleMigrate()}
                disabled={migrating || !migrationBaselineDate}
              >
                {migrating ? 'Migrating…' : 'Migrate'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {allocationGroup ? (
        <div className="modal-backdrop" onClick={() => setAllocationGroupId(null)}>
          <div
            className="settings-modal portfolio-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Adjust grouped trade amounts"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <span className="card-label">Trade Log</span>
                <h3>Adjust Amounts</h3>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Close adjust amounts dialog"
                onClick={() => setAllocationGroupId(null)}
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <div className="portfolio-allocation-summary">
                <span>Total trade value</span>
                <strong>{formatPlatinumValue(allocationExpectedTotal)}</strong>
              </div>
              <div className="portfolio-allocation-list">
                {allocationGroup.children.map((child) => (
                  <div key={child.id} className="portfolio-allocation-row">
                    <div className="portfolio-allocation-copy">
                      <span className="portfolio-allocation-name">{child.itemName}</span>
                      <span className="portfolio-allocation-meta">
                        Qty {child.quantity}{child.rank != null ? ` · Rank ${child.rank}` : ''}
                      </span>
                    </div>
                    <div className="portfolio-allocation-input-wrap">
                      <input
                        className="settings-text-input portfolio-allocation-input"
                        type="number"
                        min="0"
                        step="1"
                        value={allocationDrafts[child.id] ?? ''}
                        onChange={(event) =>
                          setAllocationDrafts((current) => ({
                            ...current,
                            [child.id]: event.target.value,
                          }))
                        }
                      />
                      <span className="portfolio-allocation-unit">pt</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className={`portfolio-allocation-summary${allocationMatches ? '' : ' error'}`}>
                <span>Allocated total</span>
                <strong>
                  {formatPlatinumValue(allocationTotal)} / {formatPlatinumValue(allocationExpectedTotal)}
                </strong>
              </div>
            </div>
            <div className="settings-modal-actions">
              <button className="period-btn" type="button" onClick={() => setAllocationGroupId(null)}>
                Cancel
              </button>
              <button
                className="act-btn"
                type="button"
                onClick={() => void handleSaveAllocations()}
                disabled={savingAllocations || !allocationMatches}
              >
                {savingAllocations ? 'Saving…' : 'Save Amounts'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
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
  const setTradePeriod = useAppStore((state) => state.setTradePeriod);
  const [summary, setSummary] = useState<PortfolioPnlSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingTrades, setRefreshingTrades] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
          setErrorMessage(error instanceof Error ? error.message : String(error));
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshingTrades(false);
    }
  };

  return (
    <>
      <div className="period-bar">
        <label>Period:</label>
        {(['7d', '30d', '90d', 'all'] as const).map((nextPeriod) => (
          <button
            key={nextPeriod}
            className={`period-btn${period === nextPeriod ? ' active' : ''}`}
            onClick={() => setTradePeriod(nextPeriod)}
          >
            {nextPeriod === 'all' ? 'All Time' : nextPeriod}
          </button>
        ))}
        <div className="period-right portfolio-log-toolbar">
          {summary?.lastUpdatedAt ? (
            <span className="portfolio-log-updated">
              Last updated {formatShortLocalDateTime(summary.lastUpdatedAt)}
            </span>
          ) : null}
          <button
            className="act-btn portfolio-refresh-btn"
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || refreshingTrades || !username}
          >
            <RefreshIcon />
            {refreshingTrades ? 'Refreshing…' : 'Refresh Trades'}
          </button>
        </div>
      </div>

      {errorMessage ? <div className="scanner-inline-error">{errorMessage}</div> : null}

      {!username ? (
        <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
          <span className="empty-primary">Connect your Warframe Market account first</span>
          <span className="empty-sub">
            P&amp;L Summary uses your permanent local trade ledger and cached market history.
          </span>
        </div>
      ) : loading && !summary ? (
        <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
          <span className="empty-primary">Loading portfolio summary…</span>
          <span className="empty-sub">
            Calculating realized profit, open exposure, and valuation from your local trade ledger.
          </span>
        </div>
      ) : summary ? (
        <div className="portfolio-summary-body">
          <div className="portfolio-quality-strip">
            <div className="chart-card portfolio-quality-card">
              <div className="portfolio-quality-card-top">
                <span className="info-card-label">
                  Profit Coverage
                  <InfoHint text="How much of sell revenue has a matched local buy cost basis behind it." />
                </span>
                <span className={`market-panel-badge tone-${portfolioCoverageTone(summary.costBasisCoveragePct)}`}>
                  {portfolioCoverageLabel(summary.costBasisCoveragePct)}
                </span>
              </div>
              <strong className="portfolio-quality-card-value">
                {formatPercentValue(summary.costBasisCoveragePct)}
              </strong>
            </div>
            <div className="chart-card portfolio-quality-card">
              <div className="portfolio-quality-card-top">
                <span className="info-card-label">
                  Value Coverage
                  <InfoHint text="How much of open inventory has cached market statistics behind its current valuation." />
                </span>
                <span className={`market-panel-badge tone-${portfolioCoverageTone(summary.currentValueCoveragePct)}`}>
                  {portfolioCoverageLabel(summary.currentValueCoveragePct)}
                </span>
              </div>
              <strong className="portfolio-quality-card-value">
                {formatPercentValue(summary.currentValueCoveragePct)}
              </strong>
            </div>
            <div className="chart-card portfolio-quality-card">
              <div className="portfolio-quality-card-top">
                <span className="info-card-label">
                  Unmatched Sell Revenue
                  <InfoHint text="Sell revenue that still has no matched local buy cost basis. This is the least reliable part of realized profit." />
                </span>
              </div>
              <strong className="portfolio-quality-card-value">
                {formatPlatinumValue(summary.unmatchedSellRevenue)}
              </strong>
            </div>
            <div className="chart-card portfolio-quality-card">
              <div className="portfolio-quality-card-top">
                <span className="info-card-label">
                  Partial Basis Revenue
                  <InfoHint text="Sell revenue where only part of the cost basis could be matched locally." />
                </span>
              </div>
              <strong className="portfolio-quality-card-value">
                {formatPlatinumValue(summary.partialCostBasisRevenue)}
              </strong>
            </div>
          </div>

          <div className="plat-grid portfolio-summary-grid">
            <div className="info-card">
              <div className="info-card-label">
                Realized Profit
                <InfoHint
                  text="Profit from closed sell trades in the selected period, using the local matched cost basis when available."
                  placement="bottom"
                />
              </div>
              <div className={`info-card-val${summary.realizedProfit >= 0 ? '' : ' negative'}`}>
                {formatSignedPlatinumValue(summary.realizedProfit)}
              </div>
            </div>
            <div className="info-card">
              <div className="info-card-label">
                Estimated Inventory Value
                <InfoHint
                  text="Estimated current value of open and kept inventory, using the latest local market estimate when available."
                  placement="bottom"
                />
              </div>
              <div className="info-card-val neutral">{formatPlatinumValue(summary.unrealizedValue)}</div>
            </div>
            <div className="info-card">
              <div className="info-card-label">
                Estimated Total P&amp;L
                <InfoHint
                  text="Realized profit plus unrealized P&L. This is the broadest portfolio view across closed and open positions."
                  placement="bottom"
                />
              </div>
              <div className={`info-card-val${summary.totalPnl >= 0 ? '' : ' negative'}`}>
                {formatSignedPlatinumValue(summary.totalPnl)}
              </div>
            </div>
            <div className="info-card">
              <div className="info-card-label">
                Open Exposure
                <InfoHint text="Total platinum still tied up in open buys and kept inventory." />
              </div>
              <div className="info-card-val neutral">{formatPlatinumValue(summary.openExposure)}</div>
            </div>
          </div>

          <div className="perf-grid portfolio-perf-grid">
            <div className="perf-card">
              <div className="perf-label">Closed Trades <InfoHint text="Completed sell trades inside the selected period." /></div>
              <div className="perf-val">{summary.closedTrades}</div>
            </div>
            <div className="perf-card">
              <div className="perf-label">Win Rate <InfoHint text="Percentage of closed sells with positive realized profit." /></div>
              <div className="perf-val blue">{formatPercentValue(summary.winRate)}</div>
            </div>
            <div className="perf-card">
              <div className="perf-label">Avg Margin <InfoHint text="Average sell-margin percentage across closed sells with local cost basis." /></div>
              <div className="perf-val blue">{formatPercentValue(summary.averageMargin)}</div>
            </div>
            <div className="perf-card">
              <div className="perf-label">Avg Hold <InfoHint text="Average time between matched buy and sell rows." /></div>
              <div className="perf-val">{formatHoursValue(summary.averageHoldHours)}</div>
            </div>
            <div className="perf-card">
              <div className="perf-label">Avg Profit / Trade <InfoHint text="Average realized profit across closed sell rows." /></div>
              <div className="perf-val green">{formatPlatinumValue(Math.round(summary.averageProfitPerTrade))}</div>
            </div>
            <div className="perf-card">
              <div className="perf-label">Flip Profit <InfoHint text="Profit from sells matched directly against prior buys of the same item." /></div>
              <div className="perf-val green">{formatPlatinumValue(summary.flipProfit)}</div>
            </div>
            <div className="perf-card">
              <div className="perf-label">Set Profit <InfoHint text="Profit from set sells using matched component buys as the cost basis." /></div>
              <div className="perf-val green">{formatPlatinumValue(summary.soldAsSetProfit)}</div>
            </div>
          </div>

          <div className="chart-grid portfolio-chart-grid">
            <CumulativeProfitChart summary={summary} />
            <ProfitPerTradeChart summary={summary} />
          </div>

          <div className="portfolio-breakdown-grid">
            <div className="chart-card">
              <PortfolioPanelHeader
                title="Trade Breakdown"
                info="Breakdown of realized profit by trade closure style: direct flip, sold as set, or unmatched sell."
              />
              <div className="portfolio-breakdown-list">
                {summary.sourceBreakdown.length === 0 ? (
                  <div className="portfolio-breakdown-empty">No closed sell trades in this period yet.</div>
                ) : (
                  summary.sourceBreakdown.map((row) => (
                    <div key={row.label} className="portfolio-breakdown-row">
                      <div className="portfolio-breakdown-copy">
                        <span className="portfolio-breakdown-name">{row.label}</span>
                        <span className="portfolio-breakdown-meta">{row.tradeCount} trades</span>
                      </div>
                      <span className="portfolio-breakdown-value">{formatSignedPlatinumValue(row.value)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="chart-card">
              <PortfolioPanelHeader
                title="Category Breakdown"
                info="Realized profit grouped by item family using the local item catalog classification."
                infoPlacement="left"
              />
              <div className="portfolio-breakdown-list">
                {summary.categoryBreakdown.length === 0 ? (
                  <div className="portfolio-breakdown-empty">No category profit data is available yet.</div>
                ) : (
                  summary.categoryBreakdown.map((row) => (
                    <div key={row.label} className="portfolio-breakdown-row">
                      <div className="portfolio-breakdown-copy">
                        <span className="portfolio-breakdown-name">{row.label}</span>
                        <span className="portfolio-breakdown-meta">{row.tradeCount} trades</span>
                      </div>
                      <span className="portfolio-breakdown-value">{formatSignedPlatinumValue(row.value)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="portfolio-insight-grid">
            <div className="info-card">
              <div className="info-card-label">Open Buys <InfoHint text="Current buy rows that are still available to be matched to future sells." /></div>
              <div className="info-card-val neutral">{summary.openBuys}</div>
            </div>
            <div className="info-card">
              <div className="info-card-label">Kept Items <InfoHint text="Buys explicitly marked Keep Item. These are excluded from flip and set matching." /></div>
              <div className="info-card-val neutral">{summary.keptItems}</div>
            </div>
            <div className="info-card">
              <div className="info-card-label">Kept Inventory Value <InfoHint text="Estimated value of inventory marked Keep Item." /></div>
              <div className="info-card-val neutral">{formatPlatinumValue(summary.keptInventoryValue)}</div>
            </div>
            <div className="info-card">
              <div className="info-card-label">Partial Set Profit <InfoHint text="Profit from set sells where only part of the component basket had a matched local cost basis." /></div>
              <div className="info-card-val neutral">{formatPlatinumValue(summary.partialSetProfit)}</div>
            </div>
            <div className="info-card">
              <div className="info-card-label">Best Trade <InfoHint text="Highest-profit closed sell row in the selected period." /></div>
              <div className="info-card-val neutral portfolio-inline-stat">
                {summary.bestTradeItem ? `${summary.bestTradeItem} · ${formatPlatinumValue(summary.bestTradeProfit ?? 0)}` : '—'}
              </div>
            </div>
            <div className="info-card">
              <div className="info-card-label">Worst Trade <InfoHint text="Lowest-profit closed sell row in the selected period." /></div>
              <div className="info-card-val neutral portfolio-inline-stat">
                {summary.worstTradeItem ? `${summary.worstTradeItem} · ${formatPlatinumValue(summary.worstTradeProfit ?? 0)}` : '—'}
              </div>
            </div>
          </div>

          {summary.notes.length > 0 ? (
            <div className="chart-card portfolio-notes-card">
              <PortfolioPanelHeader
                title="Integrity Notes"
                info="Summary notes explaining where the local trade ledger or market valuation still has limited coverage."
                infoPlacement="left"
              />
              <div className="portfolio-notes-list">
                {summary.notes.map((note) => (
                  <span key={note} className="portfolio-note-pill">
                    {note}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function PortfolioPage() {
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const tradePeriod = useAppStore((s) => s.tradePeriod);
  const [portfolioTab, setPortfolioTab] = useState<'pnl' | 'log'>('pnl');

  const handleRefreshTrades = async () => {
    if (!tradeAccount?.name) {
      return;
    }

    await getWfmProfileTradeLog(tradeAccount.name);
  };

  return (
    <>
      <div className="subnav portfolio-page-subnav">
        <div className="subnav-left">
          <span className="page-title">Portfolio</span>
          <span className={`subtab${portfolioTab === 'pnl' ? ' active' : ''}`} onClick={() => setPortfolioTab('pnl')} role="tab" tabIndex={0}>P&amp;L Summary</span>
          <span className={`subtab${portfolioTab === 'log' ? ' active' : ''}`} onClick={() => setPortfolioTab('log')} role="tab" tabIndex={0}>Trade Log</span>
        </div>
      </div>
      <div className="page-content portfolio-page-content">
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
