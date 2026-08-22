import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';

import { ItemName } from '../../components/ItemName';
import { useTranslation } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { tHealth } from '../../lib/healthLabels';
import { formatPlatinumValue } from '../../lib/trades';
import type { TradeSellOrder } from '../../types';

/**
 * Trades → Health: which of your listings need attention, and the one click that fixes each.
 *
 * **Migration, not redesign** — every behaviour is the shipped one. The single deliberate change is
 * compression: the expanded card was four stacked blocks (a five-cell metric grid, the ETA bars, an
 * action row, a score breakdown), and the grid was most of its height for five short values. Those
 * five are one inline fact row now. The ETA bars and the breakdown stay: they are the reason to
 * open a card at all.
 */

const GAUGE_RADIUS = 19;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

const TONE_TEXT: Record<string, string> = {
  green: 'text-accent-green',
  blue: 'text-accent-blue',
  red: 'text-accent-red',
  amber: 'text-accent-amber',
};

const TONE_CHIP: Record<string, string> = {
  green: 'bg-accent-green/15 text-accent-green',
  blue: 'bg-accent-blue/15 text-accent-blue',
  red: 'bg-accent-red/15 text-accent-red',
  amber: 'bg-accent-amber/15 text-accent-amber',
};

function toneKey(tone: string | undefined): string {
  const normalized = (tone ?? 'amber').trim().toLowerCase();
  return normalized in TONE_TEXT ? normalized : 'amber';
}

/** Gap tone: below market is good, above market is what costs you the sale. */
export function gapToneKey(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'amber';
  if (value <= 0) return 'green';
  return value > 5 ? 'red' : 'amber';
}

export function formatGapValue(value: number | null): string {
  if (value === null || value === undefined) return '—';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}p`;
}

export function formatEtaHours(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return null;
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Score ring — `stroke-dasharray` driven by the real score, the shipped pattern (ELEMENTS §4). */
function ScoreGauge({ score, tone }: { score: number | null; tone: string }) {
  const clamped = score === null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <span className={`relative grid size-11 shrink-0 place-items-center ${TONE_TEXT[tone]}`}>
      <svg viewBox="0 0 44 44" className="size-11" aria-hidden="true">
        <circle cx="22" cy="22" r={GAUGE_RADIUS} fill="none" stroke="var(--color-line-strong)" strokeWidth="4" />
        {score !== null ? (
          <circle
            cx="22"
            cy="22"
            r={GAUGE_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={GAUGE_CIRCUMFERENCE}
            strokeDashoffset={GAUGE_CIRCUMFERENCE * (1 - clamped / 100)}
            transform="rotate(-90 22 22)"
          />
        ) : null}
      </svg>
      <span className="absolute font-mono text-[11px] font-bold tabular-nums">
        {score === null ? '—' : score}
      </span>
    </span>
  );
}

/**
 * Two bars comparing time-to-sell at your price against at market — the slower wait renders as the
 * longer bar, so the speed/price trade-off is visual rather than arithmetic.
 */
function HealthEtaBars({
  atPriceHours,
  atMarketHours,
  yourPrice,
  marketPrice,
  gapTone,
  t,
}: {
  atPriceHours: number;
  atMarketHours: number | null;
  yourPrice: number;
  marketPrice: number | null;
  gapTone: string;
  t: TranslateFn;
}) {
  const maxHours = Math.max(atPriceHours, atMarketHours ?? 0, 1);
  const widthPct = (hours: number) => Math.max(6, Math.min(100, (hours / maxHours) * 100));
  const showMarket = atMarketHours !== null && marketPrice !== null && atMarketHours < atPriceHours;

  const row = (label: string, hours: number, tone: string) => (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 font-mono text-[10px] text-ink-dim tabular-nums">{label}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-base">
        <span
          className={`block h-full rounded-full ${tone === 'green' ? 'bg-accent-green' : tone === 'red' ? 'bg-accent-red' : 'bg-accent-amber'}`}
          style={{ width: `${widthPct(hours)}%` }}
        />
      </span>
      <span
        className={`w-10 shrink-0 text-right font-mono text-[10px] font-semibold tabular-nums ${TONE_TEXT[tone]}`}
      >
        {formatEtaHours(hours)}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-bg-base p-2">
      <div className="flex items-center justify-between font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
        <span>{t('trades.health.timeToSell')}</span>
        <span>{t('trades.health.faster')}</span>
      </div>
      {row(t('trades.health.atPrice', { price: formatPlatinumValue(yourPrice) }), atPriceHours, gapTone)}
      {showMarket
        ? row(
            t('trades.health.atPrice', { price: formatPlatinumValue(marketPrice as number) }),
            atMarketHours as number,
            'green',
          )
        : null}
    </div>
  );
}

/** One fact in the compressed metric row. */
function Fact({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <span className="flex items-baseline gap-1" title={title}>
      <span className="font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
        {label}
      </span>
      <span
        className={`font-mono text-[11px] font-semibold tabular-nums ${tone ? TONE_TEXT[tone] : 'text-ink'}`}
      >
        {value}
      </span>
    </span>
  );
}

function HealthCard({
  order,
  applyPending,
  onApply,
  onEdit,
}: {
  order: TradeSellOrder;
  applyPending: boolean;
  onApply: (order: TradeSellOrder) => void;
  onEdit: (order: TradeSellOrder) => void;
}) {
  const { t } = useTranslation();
  const health = order.health;
  const tone = toneKey(health?.tone);
  const gapTone = gapToneKey(order.priceGap);
  const marketPrice = health?.marketLow ?? order.marketLow ?? null;
  const canApply =
    health?.recommendedPrice != null &&
    health.recommendedPrice > 0 &&
    health.recommendedPrice !== order.yourPrice;

  const label = health?.label ?? '';
  // Urgent listings open themselves — the whole point of the tab is that you act on these.
  const expanded = label === 'Action Needed' || label === 'Weak' || Boolean(health?.isPriceWar);

  const rankBit = order.maxRank != null && order.maxRank > 0 ? `${order.rank ?? 0}/${order.maxRank} · ` : '';

  const action = canApply ? (
    <Button
      size="sm"
      disabled={applyPending}
      onClick={() => onApply(order)}
      className={`h-7 border text-[11px] font-semibold ${TONE_CHIP[tone]} border-current/30 hover:opacity-85`}
    >
      <i className="ti ti-bolt" aria-hidden="true" />
      {applyPending
        ? t('trades.row.working')
        : `${tHealth(t, health?.actionLabel) || t('trades.health.apply')} ${formatPlatinumValue(health?.recommendedPrice ?? 0)}`}
    </Button>
  ) : health ? (
    // A hold recommendation is still a recommendation — never let a listing look unadvised.
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold ${TONE_CHIP[toneKey(health.actionTone)]}`}
    >
      <i className="ti ti-player-pause" aria-hidden="true" />
      {tHealth(t, health.actionLabel) || t('trades.health.noAction')}
    </span>
  ) : null;

  return (
    <article
      className={`flex gap-3 rounded-lg border border-l-[3px] bg-bg-elevated p-3 ${
        tone === 'green'
          ? 'border-line border-l-accent-green'
          : tone === 'red'
            ? 'border-accent-red/30 border-l-accent-red'
            : tone === 'blue'
              ? 'border-line border-l-accent-blue'
              : 'border-accent-amber/25 border-l-accent-amber'
      }`}
    >
      <ScoreGauge score={health?.score ?? null} tone={tone} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ItemName
            className="truncate text-xs font-semibold text-ink"
            name={order.name}
            slug={order.slug}
            itemId={order.itemId}
            imagePath={order.imagePath}
          />
          <span className={`shrink-0 font-mono text-[9px] font-bold tracking-[0.06em] uppercase ${TONE_TEXT[tone]}`}>
            {tHealth(t, health?.label) || t('trades.row.building')}
          </span>
          {health?.isPriceWar ? (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ${TONE_CHIP.red}`}
              title={t('trades.health.priceWarHint')}
            >
              <i className="ti ti-flame" aria-hidden="true" /> {t('trades.health.priceWar')}
            </span>
          ) : null}
          {health?.isOnlyVariantSeller ? (
            <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ${TONE_CHIP.blue}`}>
              {t('trades.health.onlySeller')}
            </span>
          ) : null}
          {health && health.confidenceLevel !== 'high' ? (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                health.confidenceLevel === 'low' ? TONE_CHIP.amber : TONE_CHIP.blue
              }`}
              title={t('trades.health.confidenceHint')}
            >
              {health.confidenceLabel}
            </span>
          ) : null}
        </div>

        <p className="text-[11px] text-ink-dim">
          <span className="font-mono tabular-nums">
            {rankBit}×{order.quantity}
          </span>
          {health?.reason ? ` · ${health.reason}` : ` · ${t('trades.refreshingLiveHealth')}`}
        </p>

        {expanded && health ? (
          <>
            {/* Five short values. They were a five-cell grid, which was most of the card's
                height for facts that fit on one line. */}
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <Fact label={t('trades.health.yourPrice')} value={formatPlatinumValue(order.yourPrice)} />
              <Fact
                label={t('trades.health.marketLow')}
                value={formatPlatinumValue(marketPrice)}
                tone="blue"
              />
              <Fact
                label={t('trades.col.priceGap')}
                value={marketPrice != null ? formatGapValue(order.priceGap) : '—'}
                tone={gapTone}
              />
              <Fact
                label={t('trades.health.demand')}
                value={t('trades.health.buyersCount', { count: String(health.buyDemand) })}
              />
              <Fact
                label={t('trades.health.costBasis')}
                value={health.costBasis != null ? formatPlatinumValue(health.costBasis) : '—'}
                tone={health.wouldRealizeLoss ? 'red' : undefined}
                title={health.wouldRealizeLoss ? t('trades.health.wouldLose') : undefined}
              />
            </div>

            {health.estSellHoursAtPrice != null ? (
              <HealthEtaBars
                atPriceHours={health.estSellHoursAtPrice}
                atMarketHours={health.estSellHoursAtMarket}
                yourPrice={order.yourPrice}
                marketPrice={health.recommendedPrice ?? marketPrice}
                gapTone={gapTone}
                t={t}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {action}
              <Button variant="outline" size="sm" onClick={() => onEdit(order)} className="h-7 text-[11px]">
                {t('trades.row.edit')}
              </Button>
              {health.wouldRealizeLoss && health.costBasis != null ? (
                <span className="flex items-center gap-1 text-[10px] text-accent-red">
                  <i className="ti ti-alert-triangle" aria-hidden="true" />
                  {t('trades.health.lossVsCost', {
                    plat: formatPlatinumValue(
                      Math.abs((health.recommendedPrice ?? marketPrice ?? 0) - health.costBasis),
                    ),
                  })}
                </span>
              ) : null}
            </div>

            {health.scoreFactors.length > 0 ? (
              <details className="group">
                <summary className="cursor-pointer list-none font-mono text-[10px] text-ink-dim tabular-nums hover:text-ink">
                  <i className="ti ti-chevron-right inline-block transition-transform duration-150 group-open:rotate-90" aria-hidden="true" />{' '}
                  {t('trades.health.scoreBreakdown')} — {health.score}/100 ·{' '}
                  {health.confidenceLabel.toLowerCase()}
                </summary>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {health.scoreFactors.map((factor, index) => (
                    <span
                      key={`${factor.label}-${index}`}
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                        factor.delta >= 0 ? TONE_CHIP.green : TONE_CHIP.red
                      }`}
                    >
                      {factor.label} {factor.delta >= 0 ? '+' : ''}
                      {factor.delta}
                    </span>
                  ))}
                </div>
              </details>
            ) : null}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {action}
            {!canApply ? (
              <Button variant="outline" size="sm" onClick={() => onEdit(order)} className="h-7 text-[11px]">
                {t('trades.row.edit')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}

function CardsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex gap-3 rounded-lg border border-line bg-bg-elevated p-3">
          <Skeleton type="avatar" className="w-auto shrink-0" leafClassName="size-11 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton type="text" className="w-52" />
            <Skeleton type="text" className="w-72" />
          </div>
        </div>
      ))}
    </div>
  );
}

export type HealthTabProps = {
  orders: TradeSellOrder[];
  fixableOrders: TradeSellOrder[];
  loading: boolean;
  hasOverview: boolean;
  errorMessage: string | null;
  counts: { actionNeeded: number; competitive: number; likelySoon: number };
  isApplyPending: (orderId: string) => boolean;
  fixAllRunning: boolean;
  onApply: (order: TradeSellOrder) => void;
  onFixAll: () => void;
  onEdit: (order: TradeSellOrder) => void;
};

export function HealthTab(props: HealthTabProps) {
  const { t } = useTranslation();
  const [confirmFixAll, setConfirmFixAll] = useState(false);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat
          label={t('trades.health.needsAction')}
          value={String(props.counts.actionNeeded)}
          icon="ti-alert-triangle"
          tone={props.counts.actionNeeded > 0 ? 'negative' : 'muted'}
        />
        <Stat
          label={t('trades.health.competitive')}
          value={String(props.counts.competitive)}
          icon="ti-check"
          tone={props.counts.competitive > 0 ? 'positive' : 'muted'}
        />
        <Stat
          label={t('trades.health.likelySoon')}
          value={String(props.counts.likelySoon)}
          icon="ti-clock"
          tone={props.counts.likelySoon > 0 ? 'neutral' : 'muted'}
        />
      </div>

      <Panel className="gap-0">
        <PanelHeader className="flex-wrap gap-2">
          <PanelTitle variant="heading">{t('trades.col.listingHealth')}</PanelTitle>
          {props.fixableOrders.length > 0 ? (
            <Button
              size="sm"
              disabled={props.fixAllRunning}
              onClick={() => setConfirmFixAll(true)}
              className="ml-auto"
            >
              <i className="ti ti-bolt" aria-hidden="true" />
              {props.fixAllRunning
                ? t('trades.row.working')
                : t('trades.health.fixAll', { count: String(props.fixableOrders.length) })}
            </Button>
          ) : null}
        </PanelHeader>

        {props.errorMessage ? (
          <div className="border-b border-line bg-accent-red/[0.06] px-3 py-2 text-[11px] text-accent-red">
            {props.errorMessage}
          </div>
        ) : null}

        <div className="p-3">
          {props.loading && !props.hasOverview ? (
            <CardsSkeleton />
          ) : props.orders.length === 0 ? (
            <EmptyState
              icon="ti-tag"
              title={t('trades.health.noListings')}
              detail={t('trades.health.noListingsHint')}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {props.orders.map((order) => (
                <HealthCard
                  key={order.orderId}
                  order={order}
                  applyPending={props.isApplyPending(order.orderId)}
                  onApply={props.onApply}
                  onEdit={props.onEdit}
                />
              ))}
            </div>
          )}
        </div>
      </Panel>

      {/* Was `window.confirm` — a native browser dialog in a desktop app, unstyled and out of
          place next to everything around it. */}
      <Dialog open={confirmFixAll} onOpenChange={setConfirmFixAll}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t('trades.health.fixAll', { count: String(props.fixableOrders.length) })}
            </DialogTitle>
            <DialogDescription>
              {t('trades.health.fixAllConfirm', { count: String(props.fixableOrders.length) })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmFixAll(false)}>
              {t('opp.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmFixAll(false);
                props.onFixAll();
              }}
            >
              <i className="ti ti-bolt" aria-hidden="true" />
              {t('trades.health.fixAll', { count: String(props.fixableOrders.length) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
