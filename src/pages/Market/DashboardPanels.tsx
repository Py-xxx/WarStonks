/**
 * Quick View and Analysis Preview, moved here from Home's Overview tab.
 *
 * Both panels are driven by a search (`openItemInQuickView`) and both defer to this page's own
 * analysis, so they belong beside it rather than occupying half of a dashboard while empty.
 * Home is now an action board; global search and ⌘K route here.
 *
 * Lifted as-is on purpose — this move is about location, not behaviour. Restyling happens when
 * Market itself is migrated.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Panel, PanelHeader } from '@/components/ui/panel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { resolveLocalizedName } from '../../lib/itemNames';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { tHealth } from '../../lib/healthLabels';
import { useAppStore } from '../../stores/useAppStore';
import { buildAnalysisHeroState, getRiskTone, toUnitInterval } from './posture';
import { MarketStatus, SignalMeter } from './parts';
import type { WfmTopSellOrder } from '../../types';

const COPY_RESET_DELAY_MS = 1800;

/** The posture's tone as a ring on Quick View's own frame. The posture is stated inside this
 *  panel, so the colour belongs to the surface that states it. */
const POSTURE_RING: Record<string, string> = {
  green: 'ring-1 ring-inset ring-accent-green/25',
  amber: 'ring-1 ring-inset ring-accent-amber/25',
  red: 'ring-1 ring-inset ring-accent-red/25',
  blue: 'ring-1 ring-inset ring-accent-blue/25',
  neutral: 'ring-1 ring-inset ring-white/10',
};

const POSTURE_TEXT: Record<string, string> = {
  green: 'text-accent-green',
  amber: 'text-accent-amber',
  red: 'text-accent-red',
  blue: 'text-accent-blue',
  neutral: 'text-ink',
};

const MICRO_LABEL =
  'font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase';

/**
 * Quick View's loading state. It was a **spinner on a scrim over the whole panel** — the exact
 * thing interface-polish rule 5 forbids when the content's shape is known, and it is known here:
 * a trend chart over five seller rows. `AnalyticsPanel` learned this in an earlier pass; this
 * panel kept the spinner because nobody came back to it.
 */
function QuickViewSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton type="image" leafClassName="h-14" />
      <Skeleton type="table-row@5" leafClassName="h-9" />
    </div>
  );
}

const TREND_CHART_WIDTH = 300;
const TREND_CHART_HEIGHT = 56;
/** Vertical inset so the stroke and the end dot aren't clipped at the extremes. */
const TREND_CHART_INSET = 5;

interface TrendChartGeometry {
  line: string;
  area: string;
  min: number;
  max: number;
  first: number;
  last: number;
  lastX: number;
  lastY: number;
}

/**
 * Geometry for the 24h price-trend chart: a line path plus the closed area beneath it, and the
 * end-point coordinates so the caller can mark "where the price is now". Flat series (every
 * bucket identical) fall back to a mid-height line rather than dividing by a zero range.
 */
function buildTrendChartGeometry(points: number[]): TrendChartGeometry | null {
  if (points.length === 0) {
    return null;
  }

  const safePoints = points.length === 1 ? [points[0], points[0]] : points;
  const max = Math.max(...safePoints);
  const min = Math.min(...safePoints);
  const range = max - min;
  const usableHeight = TREND_CHART_HEIGHT - TREND_CHART_INSET * 2;
  const step = TREND_CHART_WIDTH / (safePoints.length - 1);

  const coordinates = safePoints.map((value, index) => ({
    x: index * step,
    y:
      range === 0
        ? TREND_CHART_HEIGHT / 2
        : TREND_CHART_INSET + (1 - (value - min) / range) * usableHeight,
  }));

  const line = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
  const lastPoint = coordinates[coordinates.length - 1];

  return {
    line,
    area: `${line} L${TREND_CHART_WIDTH},${TREND_CHART_HEIGHT} L0,${TREND_CHART_HEIGHT} Z`,
    min,
    max,
    first: safePoints[0],
    last: safePoints[safePoints.length - 1],
    lastX: lastPoint.x,
    lastY: lastPoint.y,
  };
}

type MarketPositionTone = 'green' | 'blue' | 'muted';

/**
 * Where the live cheapest listing sits relative to the analysis pipeline's recommended entry and
 * exit prices — the "should I be buying or selling right now?" read that the raw numbers alone
 * don't make obvious. Returns `null` when the analysis hasn't produced both bounds yet, so the
 * badge is simply absent rather than showing a guess.
 */
function buildMarketPosition(
  cheapestPrice: number | null,
  entryPrice: number | null,
  exitPrice: number | null,
): { labelKey: TranslationKey; tone: MarketPositionTone } | null {
  if (cheapestPrice === null || entryPrice === null || exitPrice === null) {
    return null;
  }
  if (cheapestPrice <= entryPrice) {
    return { labelKey: 'ov.pos.nearEntry', tone: 'green' };
  }
  if (cheapestPrice >= exitPrice) {
    return { labelKey: 'ov.pos.nearExit', tone: 'blue' };
  }
  return { labelKey: 'ov.pos.fairValue', tone: 'muted' };
}

/** How close a listing is to the cheapest one — drives the green/amber row highlighting. */
type SellerPriceTier = 'cheapest' | 'near' | 'normal';

/** Listings within this many platinum of the cheapest are worth flagging as still competitive. */
const NEAR_CHEAPEST_PLATINUM = 2;

function getSellerPriceTier(platinum: number, cheapestPrice: number): SellerPriceTier {
  if (platinum === cheapestPrice) {
    return 'cheapest';
  }
  if (platinum - cheapestPrice <= NEAR_CHEAPEST_PLATINUM) {
    return 'near';
  }
  return 'normal';
}




/**
 * A seller listing you can click to copy the whisper. **The shipped app's "seller card"** — name,
 * quantity, price — registered in `ELEMENTS.md` §4.
 *
 * It existed twice in this file, once in the top-5 list and once in the View-all dialog, differing
 * only in whether the meta line included the seller's status. Now one component with a `showStatus`
 * flag, so the dialog can never drift from the list it is "more of".
 *
 * The copy affordance sits on every row rather than on hover: at a glance it has to be obvious the
 * row does something, and a hover-only hint is invisible until you have already guessed.
 */
function SellerRow({
  order,
  tier,
  copied,
  showStatus = false,
  onCopy,
}: {
  order: WfmTopSellOrder;
  tier: SellerPriceTier;
  copied: boolean;
  showStatus?: boolean;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  // Cheapest (and anything tied with it) reads green; within a couple of platinum is still
  // competitive, so it reads amber. Everything else is neutral.
  const edge =
    tier === 'cheapest'
      ? 'border-l-accent-green'
      : tier === 'near'
        ? 'border-l-accent-amber'
        : 'border-l-line-strong';
  const price =
    tier === 'cheapest' ? 'text-accent-green' : tier === 'near' ? 'text-accent-amber' : 'text-ink';

  return (
    <Button
      variant="ghost"
      static
      onClick={onCopy}
      title={t('ov.copyWhisperTitle', { user: order.username })}
      className={`h-auto w-full justify-start gap-3 rounded-md border border-line border-l-[3px] bg-bg-base px-3 py-2 text-left hover:border-accent-blue/35 hover:bg-bg-elevated ${edge}`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-xs font-bold text-ink">{order.username}</span>
        <span className="truncate font-mono text-[10px] font-normal text-ink-dim">
          {t('pf.qtyValue', { n: order.quantity })}
          {order.rank !== null && order.rank !== undefined
            ? ` · ${t('pf.rank')} ${order.rank}`
            : ''}
          {showStatus && order.status ? ` · ${order.status}` : ''}
        </span>
      </span>
      <span className={`shrink-0 font-mono text-[13px] font-bold tabular-nums ${price}`}>
        {order.platinum} pt
      </span>
      <span
        className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] tracking-[0.08em] uppercase ${
          copied
            ? 'border-accent-green/45 bg-accent-green/10 text-accent-green'
            : 'border-line text-ink-dim'
        }`}
        aria-hidden="true"
      >
        {copied ? t('common.copied') : t('ov.copyShort')}
      </span>
    </Button>
  );
}

export function QuickViewCard() {
  const { t } = useTranslation();
  const quickView = useAppStore((s) => s.quickView);
  const loadQuickViewItem = useAppStore((state) => state.loadQuickViewItem);
  const sparklinePoints = useAppStore((state) => state.quickView.sparklinePoints);
  const sparklineLoading = useAppStore((state) => state.quickView.sparklineLoading);
  const analysis = useAppStore((state) => state.selectedMarketAnalysis);
  const analysisLoading = useAppStore((state) => state.selectedMarketAnalysisLoading);
  const heroState = buildAnalysisHeroState(analysis, t);
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [viewAllOpen, setViewAllOpen] = useState(false);

  const selectedItem = quickView.selectedItem;
  const itemNameMap = useAppStore((s) => s.itemNameMap);
  const selectedItemName = selectedItem ? resolveLocalizedName(itemNameMap, selectedItem) : '';
  // Full snapshot, cheapest first — drives both the top-5 list and the "View All" popup.
  const allOrders = useMemo(
    () => [...quickView.sellOrders].sort((a, b) => a.platinum - b.platinum),
    [quickView.sellOrders],
  );
  const mainOrder = allOrders[0] ?? null;
  const topSellers = allOrders.slice(0, 5);
  const cheapestPrice = mainOrder?.platinum ?? null;
  // Both bounds come from the shared analysis pipeline (the same numbers the Market analysis
  // shows), so the position badge agrees with the full analysis rather than re-deriving its own.
  const marketPosition = buildMarketPosition(
    cheapestPrice,
    analysis?.headline.entryPrice ?? null,
    analysis?.headline.exitPrice ?? null,
  );

  useEffect(() => {
    setCopiedOrderId(null);
    setCopyFeedback(null);
    setViewAllOpen(false);
  }, [selectedItem?.slug]);

  const handleCopy = async (order: WfmTopSellOrder) => {
    if (!selectedItem) {
      return;
    }

    try {
      await copyWhisperMessage(
        { username: order.username, platinum: order.platinum, rank: order.rank, maxRank: selectedItem.maxRank },
        selectedItem.name,
      );
      setCopiedOrderId(order.orderId);
      setCopyFeedback(null);
      window.setTimeout(
        () => setCopiedOrderId((current) => (current === order.orderId ? null : current)),
        COPY_RESET_DELAY_MS,
      );
    } catch {
      setCopiedOrderId(null);
      setCopyFeedback(
        formatHomeErrorMessage('dashboard-quick-view-copy', new Error('copy failed')),
      );
    }
  };

  return (
    // The posture-toned outline is back, and now it wraps Quick View: the posture lives in here
    // rather than in its own panel, so the colour belongs to the surface that states it.
    <Panel className={`gap-0 ${POSTURE_RING[heroState.tone] ?? POSTURE_RING.neutral}`}>
      <PanelHeader className="px-4">
        {/* Matches the analysis panels' heading treatment (Inter 13/600, full-strength ink)
            rather than the legacy mono micro-label, so the two sit level. */}
        <span className="truncate font-sans text-sm font-semibold tracking-normal text-ink normal-case">
          {t('ov.quickView')}
        </span>
        {marketPosition ? (
          <MarketStatus tone={marketPosition.tone === 'muted' ? 'neutral' : marketPosition.tone}>
            {t(marketPosition.labelKey)}
          </MarketStatus>
        ) : analysisLoading ? (
          <MarketStatus>{t('hm.building')}</MarketStatus>
        ) : null}
      </PanelHeader>

      <div className="relative flex min-h-20 flex-col gap-3 p-4">
        {!selectedItem ? (
          <EmptyState
            icon="ti-search"
            title={t('ov.searchToLoadQv')}
            detail={t('ov.autocompleteHint')}
          />
        ) : null}

        {/* One loading state, and it is the panel's own shape. There used to be TWO at once: a
            centred "Loading top orders" empty state AND a spinner on a scrim over the whole
            panel, both visible for the same `quickView.loading`. */}
        {selectedItem && quickView.loading ? <QuickViewSkeleton /> : null}

        {selectedItem && !quickView.loading && quickView.errorMessage ? (
          <EmptyState
            icon="ti-alert-triangle"
            title={t('ov.qvFailed')}
            detail={quickView.errorMessage}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void loadQuickViewItem(selectedItem);
                }}
              >
                {t('ov.retryQuickView')}
              </Button>
            }
          />
        ) : null}

        {selectedItem && !quickView.loading && !quickView.errorMessage && !mainOrder ? (
          <EmptyState
            icon="ti-search-off"
            title={t('ov.noOnlineOrders')}
            detail={t('ov.noOnlineOrdersDetail', { item: selectedItemName })}
          />
        ) : null}

        {selectedItem && mainOrder && !quickView.loading && !quickView.errorMessage ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
          <div className="flex min-w-0 flex-col gap-3">
            {/* Name, art and spread all gone: Item details sits directly to the right and
                carries the name and the art, and spread is Orderbook's number. The market
                position moved to the header, where it reads as a status for the whole panel. */}

            {/* The 24h sparkline used to live in Analysis Preview, which has been removed as a
                duplicate of the panels further down this page. The trend is NOT duplicated there
                — the Charts sub-view has the full chart, but Summary would otherwise have no
                price history at all — so it moves here, onto the item header it belongs to. */}
            <PriceTrendChart points={sparklinePoints} loading={sparklineLoading} />

            <div className="flex flex-col gap-1.5">
              {topSellers.map((order) => (
                <SellerRow
                  key={order.orderId}
                  order={order}
                  tier={cheapestPrice !== null ? getSellerPriceTier(order.platinum, cheapestPrice) : 'normal'}
                  copied={copiedOrderId === order.orderId}
                  onCopy={() => void handleCopy(order)}
                />
              ))}
            </div>

            {allOrders.length > topSellers.length ? (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 self-start border-line px-2.5 text-[11px]"
                onClick={() => setViewAllOpen(true)}
              >
                {t('ov.viewAllCount', { n: allOrders.length })}
              </Button>
            ) : null}

            {copyFeedback ? (
              <p className="text-[11px] text-accent-green">{copyFeedback}</p>
            ) : null}
          </div>

            {/* Trade posture, folded in from its own panel. Quick View wasted most of its
                horizontal space on a dead middle; the posture, its three signals and the
                recommended prices now fill it, and the panel genuinely is the summary. */}
            <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-bg-base p-3">
              <div className="flex flex-col gap-1">
                <span className={MICRO_LABEL}>{t('mkt.tradePosture')}</span>
                <span
                  className={`text-[15px] font-bold ${POSTURE_TEXT[heroState.tone] ?? POSTURE_TEXT.neutral}`}
                >
                  {heroState.label}
                </span>
              </div>

              <div className="flex flex-col gap-2.5">
                <SignalMeter
                  label={t('mkt.liquidity')}
                  tone="blue"
                  fill={toUnitInterval(analysis?.headline.liquidityScore)}
                  value={`${Math.round(analysis?.headline.liquidityScore ?? 0)}%`}
                />
                <SignalMeter
                  label={t('mkt.trendConfidence')}
                  tone="green"
                  fill={toUnitInterval(analysis?.trend.confidence)}
                  value={`${Math.round(analysis?.trend.confidence ?? 0)}%`}
                />
                <SignalMeter
                  label={t('mkt.riskPosture')}
                  tone={getRiskTone(analysis?.manipulationRisk.riskLevel)}
                  fill={toUnitInterval(analysis?.manipulationRisk.efficiencyPenaltyPct)}
                  value={tHealth(t, analysis?.manipulationRisk.riskLevel) || '—'}
                />
              </div>

              <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
                <div className="flex flex-col gap-1">
                  <span className={MICRO_LABEL}>{t('mkt.entryPrice')}</span>
                  <span className="font-mono text-sm font-bold tabular-nums text-ink">
                    {analysis?.headline.entryPrice != null ? `${Math.round(analysis.headline.entryPrice)} pt` : '—'}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className={MICRO_LABEL}>{t('mkt.exitPrice')}</span>
                  <span className="font-mono text-sm font-bold tabular-nums text-ink">
                    {analysis?.headline.exitPrice != null ? `${Math.round(analysis.headline.exitPrice)} pt` : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* The hand-rolled portal + `modal-backdrop` + `useModalA11y` is gone: `Dialog` owns the
          backdrop, the focus trap, Escape and focus restore, and it is the app's only modal. */}
      <Dialog open={viewAllOpen && Boolean(selectedItem)} onOpenChange={setViewAllOpen}>
        <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-line px-4 py-3">
            <DialogTitle>{selectedItemName}</DialogTitle>
            <DialogDescription>
              {t('ov.listingsCheapestFirst', { n: allOrders.length })}
            </DialogDescription>
          </DialogHeader>

          {/* Same row as the top-5 list — literally the same component — so the dialog reads as
              "more of that list" rather than a second design. */}
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-3">
            {allOrders.map((order) => (
              <SellerRow
                key={order.orderId}
                order={order}
                tier={cheapestPrice !== null ? getSellerPriceTier(order.platinum, cheapestPrice) : 'normal'}
                copied={copiedOrderId === order.orderId}
                showStatus
                onCopy={() => void handleCopy(order)}
              />
            ))}
          </div>

          {copyFeedback ? (
            <p className="border-t border-line px-4 py-2 text-[11px] text-accent-green">
              {copyFeedback}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

/**
 * The 24h low-price move, in more detail than a bare sparkline: the range it travelled between
 * (min/max), where it ended up, and the net change over the window. Points are the last 24
 * analytics buckets' lowest-sell values (see `extractQuickViewSparklinePoints`).
 */
function PriceTrendChart({ points, loading }: { points: number[]; loading: boolean }) {
  const { t } = useTranslation();
  const geometry = buildTrendChartGeometry(points);

  if (!geometry) {
    return loading ? (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className={MICRO_LABEL}>{t('ov.trend24h')}</span>
          <span className="font-mono text-[10px] text-ink-dim">{t('hm.building')}</span>
        </div>
        <Skeleton type="image" leafClassName="h-14" />
      </div>
    ) : null;
  }

  const change = geometry.last - geometry.first;
  const changePercent = geometry.first > 0 ? (change / geometry.first) * 100 : null;
  // Green up, red down, muted flat — profit and loss, the meanings the accents already carry.
  const stroke =
    change > 0 ? 'text-accent-green' : change < 0 ? 'text-accent-red' : 'text-ink-dim';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className={MICRO_LABEL}>{t('ov.trend24h')}</span>
        <span className={`font-mono text-[11px] font-semibold tabular-nums ${stroke}`}>
          {change > 0 ? '+' : ''}
          {Math.round(change)} pt
          {changePercent !== null ? ` (${change > 0 ? '+' : ''}${changePercent.toFixed(1)}%)` : ''}
        </span>
      </div>
      <div className={`relative rounded-md bg-bg-base p-1 ${stroke}`}>
        <svg
          width="100%"
          height={TREND_CHART_HEIGHT}
          viewBox={`0 0 ${TREND_CHART_WIDTH} ${TREND_CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          className="block"
          aria-label={t('ov.trend24hAria', {
            min: String(Math.round(geometry.min)),
            max: String(Math.round(geometry.max)),
          })}
        >
          {/* `currentColor` on both, so the tone is set once on the wrapper and the fill is the
              same hue at 12% rather than a second colour to keep in sync. */}
          <path d={geometry.area} fill="currentColor" opacity={0.12} stroke="none" />
          <path
            d={geometry.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
          {/* Marks where the price sits now, so the eye lands on the current value first. */}
          <circle cx={geometry.lastX} cy={geometry.lastY} r="3" fill="currentColor" />
        </svg>
        <span className="pointer-events-none absolute top-1 right-1.5 font-mono text-[9px] tabular-nums text-ink-faint">
          {Math.round(geometry.max)}
        </span>
        <span className="pointer-events-none absolute right-1.5 bottom-1 font-mono text-[9px] tabular-nums text-ink-faint">
          {Math.round(geometry.min)}
        </span>
      </div>
    </div>
  );
}
