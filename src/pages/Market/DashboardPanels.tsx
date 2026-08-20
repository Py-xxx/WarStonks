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
import { createPortal } from 'react-dom';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { resolveLocalizedName } from '../../lib/itemNames';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { useModalA11y } from '../../hooks/useModalA11y';
import { tHealth } from '../../lib/healthLabels';
import { useAppStore } from '../../stores/useAppStore';
import { buildAnalysisHeroState, getRiskTone, toUnitInterval } from './posture';
import type { WfmTopSellOrder } from '../../types';

const COPY_RESET_DELAY_MS = 1800;

function CardLoadingOverlay({ visible, label }: { visible: boolean; label: string }) {
  if (!visible) {
    return null;
  }

  return (
    <div className="market-panel-overlay">
      <span className="market-panel-spinner" aria-hidden="true" />
      <span className="market-panel-overlay-copy">{label}</span>
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
 * A labelled signal bar. Three of these carry the posture's evidence — liquidity, trend
 * confidence and risk — which previously lived in a separate Trade posture panel that also
 * repeated numbers the panels below already owned.
 *
 * The fill plots a real value. The old risk meter did not: it picked 0.92 / 0.58 / 0.18 from a
 * tone, which is a picture of data rather than data. This one uses the efficiency penalty.
 */
function QvMeter({
  label,
  value,
  fill,
  tone,
}: {
  label: string;
  value: string;
  fill: number;
  tone: 'blue' | 'green' | 'amber' | 'red' | 'neutral';
}) {
  return (
    <div className="qv-meter">
      <div className="qv-meter-head">
        <span className="qv-stat-label">{label}</span>
        <span className={`qv-meter-value tone-${tone}`}>{value}</span>
      </div>
      <div className="qv-meter-track">
        <div
          className={`qv-meter-fill tone-${tone}`}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, fill)) * 100)}%` }}
        />
      </div>
    </div>
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
  const viewAllRef = useModalA11y<HTMLDivElement>({
    onClose: () => setViewAllOpen(false),
    active: viewAllOpen && Boolean(selectedItem),
  });
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
    <div className={`card qv-posture-shell tone-${heroState.tone}`}>
      <div className="card-header">
        {/* Matches the analysis panels' heading treatment (Inter 13/600, full-strength ink)
            rather than the legacy mono micro-label, so the two sit level. */}
        <span className="truncate font-sans text-sm font-semibold tracking-normal text-ink normal-case">
          {t('ov.quickView')}
        </span>
        {marketPosition ? (
          <span className={`market-panel-badge tone-${marketPosition.tone} ml-auto`}>
            {t(marketPosition.labelKey)}
          </span>
        ) : analysisLoading ? (
          <span className="market-panel-badge tone-neutral ml-auto">{t('hm.building')}</span>
        ) : null}
      </div>

      <div className="card-body dashboard-panel-shell">
        {!selectedItem ? (
          <div className="empty-state">
            <span className="empty-primary">{t('ov.searchToLoadQv')}</span>
            <span className="empty-sub">{t('ov.autocompleteHint')}</span>
          </div>
        ) : null}

        {selectedItem && quickView.loading ? (
          <div className="empty-state">
            <span className="empty-primary">{t('hm.loadingTopOrders')}</span>
            <span className="empty-sub">Fetching the live sell orders for {selectedItemName}.</span>
          </div>
        ) : null}

        {selectedItem && !quickView.loading && quickView.errorMessage ? (
          <div className="empty-state">
            <span className="empty-primary">{t('ov.qvFailed')}</span>
            <span className="empty-sub">{quickView.errorMessage}</span>
            <button
              className="text-btn"
              type="button"
              onClick={() => {
                void loadQuickViewItem(selectedItem);
              }}
            >
              {t('ov.retryQuickView')}
            </button>
          </div>
        ) : null}

        {selectedItem && !quickView.loading && !quickView.errorMessage && !mainOrder ? (
          <div className="empty-state">
            <span className="empty-primary">{t('ov.noOnlineOrders')}</span>
            <span className="empty-sub">{selectedItemName} currently has no top sell orders returned by warframe.market.</span>
          </div>
        ) : null}

        {selectedItem && mainOrder && !quickView.loading && !quickView.errorMessage ? (
          <div className="qv-split">
          <div className="qv-stack">
            {/* Name, art and spread all gone: Item details sits directly to the right and
                carries the name and the art, and spread is Orderbook's number. The market
                position moved to the header, where it reads as a status for the whole panel. */}

            {/* The 24h sparkline used to live in Analysis Preview, which has been removed as a
                duplicate of the panels further down this page. The trend is NOT duplicated there
                — the Charts sub-view has the full chart, but Summary would otherwise have no
                price history at all — so it moves here, onto the item header it belongs to. */}
            <PriceTrendChart points={sparklinePoints} loading={sparklineLoading} />

            <div className="qv-seller-list">
              {topSellers.map((order) => {
                const tier = cheapestPrice !== null
                  ? getSellerPriceTier(order.platinum, cheapestPrice)
                  : 'normal';
                return (
                  <button
                    key={order.orderId}
                    className={`qv-seller-row tier-${tier}${copiedOrderId === order.orderId ? ' copied' : ''}`}
                    type="button"
                    onClick={() => void handleCopy(order)}
                    title={t('ov.copyWhisperTitle', { user: order.username })}
                  >
                    <span className="qv-seller-identity">
                      <span className="qv-seller-name">{order.username}</span>
                      <span className="qv-seller-meta">
                        {t('pf.qtyValue', { n: order.quantity })}
                        {order.rank !== null && order.rank !== undefined
                          ? ` • ${t('pf.rank')} ${order.rank}`
                          : ''}
                      </span>
                    </span>
                    <span className="qv-seller-price">{order.platinum} pt</span>
                    <span className="qv-seller-action" aria-hidden="true">
                      {copiedOrderId === order.orderId ? t('common.copied') : t('ov.copyShort')}
                    </span>
                  </button>
                );
              })}
            </div>

            {allOrders.length > topSellers.length ? (
              <button
                type="button"
                className="btn-secondary qv-view-all-btn"
                onClick={() => setViewAllOpen(true)}
              >
                {t('ov.viewAllCount', { n: allOrders.length })}
              </button>
            ) : null}

            {copyFeedback ? <div className="qv-copy-feedback">{copyFeedback}</div> : null}
          </div>

            {/* Trade posture, folded in from its own panel. Quick View wasted most of its
                horizontal space on a dead middle; the posture, its three signals and the
                recommended prices now fill it, and the panel genuinely is the summary. */}
            <div className="qv-posture-rail">
              <div className="flex flex-col gap-1">
                <span className="qv-stat-label">{t('mkt.tradePosture')}</span>
                <span className={`qv-posture-label tone-${heroState.tone}`}>{heroState.label}</span>
              </div>

              <div className="flex flex-col gap-2.5">
                <QvMeter
                  label={t('mkt.liquidity')}
                  tone="blue"
                  fill={toUnitInterval(analysis?.headline.liquidityScore)}
                  value={`${Math.round(analysis?.headline.liquidityScore ?? 0)}%`}
                />
                <QvMeter
                  label={t('mkt.trendConfidence')}
                  tone="green"
                  fill={toUnitInterval(analysis?.trend.confidence)}
                  value={`${Math.round(analysis?.trend.confidence ?? 0)}%`}
                />
                <QvMeter
                  label={t('mkt.riskPosture')}
                  tone={getRiskTone(analysis?.manipulationRisk.riskLevel)}
                  fill={toUnitInterval(analysis?.manipulationRisk.efficiencyPenaltyPct)}
                  value={tHealth(t, analysis?.manipulationRisk.riskLevel) || '—'}
                />
              </div>

              <div className="qv-posture-prices">
                <div className="flex flex-col gap-1">
                  <span className="qv-stat-label">{t('mkt.entryPrice')}</span>
                  <span className="qv-posture-price">
                    {analysis?.headline.entryPrice != null ? `${Math.round(analysis.headline.entryPrice)} pt` : '—'}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="qv-stat-label">{t('mkt.exitPrice')}</span>
                  <span className="qv-posture-price">
                    {analysis?.headline.exitPrice != null ? `${Math.round(analysis.headline.exitPrice)} pt` : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        <CardLoadingOverlay
          visible={Boolean(selectedItem && quickView.loading)}
          label={t('hm.loadingQv', { item: selectedItemName || '…' })}
        />
      </div>

      {viewAllOpen && selectedItem ? createPortal(
        <div className="qv-viewall-root" role="dialog" aria-modal="true" aria-label={t('a11y.allSellOrders')}>
          <button
            type="button"
            className="modal-backdrop"
            aria-label={t('a11y.closeAllSellOrders')}
            onClick={() => setViewAllOpen(false)}
          />
          <div ref={viewAllRef} className="qv-viewall-modal">
            <div className="qv-viewall-header">
              <div>
                <span className="card-label">{t('ov.allSellOrders')}</span>
                <h3>{selectedItemName}</h3>
                <span className="qv-viewall-count">
                  {allOrders.length} {allOrders.length === 1 ? 'listing' : 'listings'} · cheapest first
                </span>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label={t('a11y.close')}
                onClick={() => setViewAllOpen(false)}
              >
                ✕
              </button>
            </div>

            {/* Same row treatment as the Quick View's top-5 list — including the cheapest/near
                price tiers — so the popup reads as "more of the same list", not a second design. */}
            <div className="qv-viewall-list qv-seller-list">
              {allOrders.map((order) => {
                const tier = cheapestPrice !== null
                  ? getSellerPriceTier(order.platinum, cheapestPrice)
                  : 'normal';
                return (
                  <button
                    key={order.orderId}
                    className={`qv-seller-row tier-${tier}${copiedOrderId === order.orderId ? ' copied' : ''}`}
                    type="button"
                    onClick={() => void handleCopy(order)}
                    title={t('ov.copyWhisperTitle', { user: order.username })}
                  >
                    <span className="qv-seller-identity">
                      <span className="qv-seller-name">{order.username}</span>
                      <span className="qv-seller-meta">
                        {t('pf.qtyValue', { n: order.quantity })}
                        {order.rank !== null && order.rank !== undefined
                          ? ` • ${t('pf.rank')} ${order.rank}`
                          : ''}
                        {order.status ? ` • ${order.status}` : ''}
                      </span>
                    </span>
                    <span className="qv-seller-price">{order.platinum} pt</span>
                    <span className="qv-seller-action" aria-hidden="true">
                      {copiedOrderId === order.orderId ? t('common.copied') : t('ov.copyShort')}
                    </span>
                  </button>
                );
              })}
            </div>

            {copyFeedback ? <div className="qv-copy-feedback">{copyFeedback}</div> : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
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
      <div className="trend-chart-shell">
        <div className="trend-chart-head">
          <span className="qv-stat-label">{t('ov.trend24h')}</span>
          <span className="trend-chart-pending">{t('hm.building')}</span>
        </div>
      </div>
    ) : null;
  }

  const change = geometry.last - geometry.first;
  const changePercent = geometry.first > 0 ? (change / geometry.first) * 100 : null;
  const tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';

  return (
    <div className="trend-chart-shell">
      <div className="trend-chart-head">
        <span className="qv-stat-label">{t('ov.trend24h')}</span>
        <span className={`trend-chart-change tone-${tone}`}>
          {change > 0 ? '+' : ''}
          {Math.round(change)} pt
          {changePercent !== null ? ` (${change > 0 ? '+' : ''}${changePercent.toFixed(1)}%)` : ''}
        </span>
      </div>
      <div className={`trend-chart-body tone-${tone}`}>
        <svg
          width="100%"
          height={TREND_CHART_HEIGHT}
          viewBox={`0 0 ${TREND_CHART_WIDTH} ${TREND_CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('ov.trend24hAria', {
            min: String(Math.round(geometry.min)),
            max: String(Math.round(geometry.max)),
          })}
        >
          <path className="trend-chart-area" d={geometry.area} />
          <path className="trend-chart-line" d={geometry.line} fill="none" />
          {/* Marks where the price sits now, so the eye lands on the current value first. */}
          <circle className="trend-chart-dot" cx={geometry.lastX} cy={geometry.lastY} r="3" />
        </svg>
        <span className="trend-chart-bound trend-chart-bound-max">{Math.round(geometry.max)}</span>
        <span className="trend-chart-bound trend-chart-bound-min">{Math.round(geometry.min)}</span>
      </div>
    </div>
  );
}
