import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { WatchlistAddControls } from '../../components/WatchlistAddControls';
import { WatchlistTable } from '../../components/WatchlistTable';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { formatWorldStateCountdown, formatWorldStateDateTime } from '../../lib/worldState';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { resolveLocalizedName } from '../../lib/itemNames';
import { useTranslation } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { confidenceTone, tConfidence, tHealth, tTrendSummary } from '../../lib/healthLabels';
import { useDocumentVisibility } from '../../hooks/useDocumentVisibility';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAppStore } from '../../stores/useAppStore';
import type { ItemAnalysisResponse, WfmTopSellOrder } from '../../types';

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

function calculateSpreadMetrics(orders: WfmTopSellOrder[]) {
  if (orders.length < 5) {
    return null;
  }

  const cheapestPrice = orders[0].platinum;
  const fifthPrice = orders[4].platinum;
  const spreadPlatinum = fifthPrice - cheapestPrice;
  const spreadPercent = cheapestPrice > 0 ? (spreadPlatinum / cheapestPrice) * 100 : null;

  return {
    spreadPlatinum,
    spreadPercent,
  };
}

function formatSpreadLabel(orders: WfmTopSellOrder[], t: TranslateFn): string {
  const spreadMetrics = calculateSpreadMetrics(orders);
  if (!spreadMetrics) {
    return t('ov.waiting5');
  }

  if (spreadMetrics.spreadPercent === null) {
    return `${spreadMetrics.spreadPlatinum} pt`;
  }

  return `${spreadMetrics.spreadPlatinum} pt (${spreadMetrics.spreadPercent.toFixed(1)}%)`;
}

function buildDashboardEventDetail(node: string | null, expiry: string | null, t: TranslateFn): string {
  const detailParts = [];

  if (node) {
    detailParts.push(node);
  }

  if (expiry) {
    detailParts.push(t('ov.ends', { time: formatWorldStateDateTime(expiry) }));
  }

  return detailParts.join(' • ');
}

function getAnalysisPreviewTone(analysis: ItemAnalysisResponse | null): 'green' | 'amber' | 'red' {
  if (!analysis) {
    return 'amber';
  }
  const level = analysis.headline.confidenceSummary.level;
  const netMargin = analysis.headline.netMargin ?? 0;
  // Red is reserved for genuinely negative signals — manipulation risk or a losing
  // (negative) margin. Low confidence is caution (amber), not danger.
  if (analysis.manipulationRisk.riskLevel.toLowerCase().includes('high')) {
    return 'red';
  }
  if (netMargin < 0) {
    return 'red';
  }
  if (level === 'high' && netMargin > 0) {
    return 'green';
  }
  return 'amber';
}

function buildAnalysisPreviewLabel(analysis: ItemAnalysisResponse | null): TranslationKey {
  if (!analysis) {
    return 'health.building';
  }
  if (analysis.manipulationRisk.riskLevel.toLowerCase().includes('high')) {
    return 'ov.caution';
  }
  if ((analysis.headline.netMargin ?? 0) > 0 && analysis.headline.confidenceSummary.level === 'high') {
    return 'mkt.hero.buyBias';
  }
  if ((analysis.headline.netMargin ?? 0) > 0) {
    return 'mkt.hero.selective';
  }
  return 'mkt.hero.wait';
}

function WatchlistCard() {
  const { t } = useTranslation();
  const watchlistCount = useAppStore((state) => state.watchlist.length);
  const setHomeSubTab = useAppStore((state) => state.setHomeSubTab);

  return (
    <div className="card accent-green">
      <div className="card-header">
        <span className="card-label">{t('ov.watchlist')}</span>
        <span className="badge badge-blue">{t('hm.itemsCount', { count: watchlistCount })}</span>
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={() => setHomeSubTab('watchlist')}>
            {t('wl.manage')} →
          </button>
        </div>
      </div>

      <div className="card-body card-body-compact">
        <WatchlistAddControls mode="selected" />
      </div>

      <WatchlistTable variant="compact" />
    </div>
  );
}

function EventsCard() {
  const { t } = useTranslation();
  const worldStateEvents = useAppStore((state) => state.worldStateEvents);
  const worldStateEventsLoading = useAppStore((state) => state.worldStateEventsLoading);
  const worldStateEventsError = useAppStore((state) => state.worldStateEventsError);
  const refreshWorldStateEvents = useAppStore((state) => state.refreshWorldStateEvents);
  const setActivePage = useAppStore((state) => state.setActivePage);
  const setEventsSubTab = useAppStore((state) => state.setEventsSubTab);
  const isVisible = useDocumentVisibility();
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    // Don't tick the countdown while the window is hidden (WebView2 throttles it anyway).
    if (!isVisible) {
      return undefined;
    }
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isVisible]);

  const openActiveEventsPage = () => {
    setActivePage('events');
    setEventsSubTab('events-news');
  };

  return (
    <div className="card accent-amber">
      <div className="card-header">
        <span className="card-label">{t('ov.events')}</span>
        <span
          className={`badge ${worldStateEvents.length > 0 ? 'badge-blue' : 'badge-muted'}`}
        >
          {t('hm.activeCount', { count: worldStateEvents.length })}
        </span>
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={openActiveEventsPage}>
            {t('ov.open')}
          </button>
        </div>
      </div>

      <div className="card-body dashboard-panel-shell">
        <div className="watchlist-alert-summary">
          {worldStateEventsError && worldStateEvents.length === 0 ? (
            <button
              className="watchlist-alert-summary-empty"
              type="button"
              onClick={() => {
                void refreshWorldStateEvents();
              }}
            >
              {t('ov.eventsOffline')}
            </button>
          ) : null}

          {worldStateEvents.length > 0 ? (
            <div className="watchlist-alert-summary-list">
              {worldStateEvents.map((event) => (
                <button
                  key={event.id}
                  className="watchlist-alert-summary-item"
                  type="button"
                  onClick={openActiveEventsPage}
                >
                  <span className="watchlist-alert-summary-item-copy">
                    <span className="watchlist-alert-summary-item-name">{event.description}</span>
                    <span className="watchlist-alert-summary-item-meta">
                      {event.isCommunity ? (
                        <span className="badge badge-blue">{t('ov.community')}</span>
                      ) : null}
                      {event.isPersonal ? (
                        <span className="badge badge-purple">{t('ov.personal')}</span>
                      ) : null}
                      <span>{buildDashboardEventDetail(event.node, event.expiry, t) || t('ov.noNodeData')}</span>
                    </span>
                  </span>
                  <span className="watchlist-alert-summary-item-price">
                    {formatWorldStateCountdown(event.expiry, nowMs)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {!worldStateEventsError && worldStateEventsLoading && worldStateEvents.length === 0 ? (
            <button className="watchlist-alert-summary-empty" type="button" onClick={openActiveEventsPage}>
              {t('hm.loadingEvents')}
            </button>
          ) : null}

          {!worldStateEventsError && !worldStateEventsLoading && worldStateEvents.length === 0 ? (
            <button
              className="watchlist-alert-summary-empty"
              type="button"
              onClick={openActiveEventsPage}
            >
              {t('hm.noEvents')}
            </button>
          ) : null}
        </div>
        <CardLoadingOverlay
          visible={worldStateEventsLoading}
          label={t('hm.refreshingEvents')}
        />
      </div>
    </div>
  );
}

function QuickViewCard() {
  const { t } = useTranslation();
  const quickView = useAppStore((s) => s.quickView);
  const loadQuickViewItem = useAppStore((state) => state.loadQuickViewItem);
  const analysis = useAppStore((state) => state.selectedMarketAnalysis);
  const analysisLoading = useAppStore((state) => state.selectedMarketAnalysisLoading);
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
  const selectedItemImageUrl = resolveWfmAssetUrl(selectedItem?.imagePath);
  const spreadLabel = formatSpreadLabel(quickView.sellOrders, t);
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
    <div className="card accent-blue">
      <div className="card-header">
        <span className="card-label">{t('ov.quickView')}</span>
        <span className="qv-title">{selectedItem?.itemFamily ?? t('ov.wfmItem')}</span>
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
          <div className="qv-stack">
            <div className="qv-focus-row">
              <div className="qv-focus-main">
                <span className="qv-item-thumb">
                  {selectedItemImageUrl ? (
                    <img src={selectedItemImageUrl} alt="" loading="lazy" />
                  ) : (
                    <span>{selectedItem.name.slice(0, 1)}</span>
                  )}
                </span>
                <div className="qv-focus-identity">
                  <div className="qv-stat-label">{t('ov.selectedItem')}</div>
                  <div className="qv-focus-item-name">{selectedItemName}</div>
                </div>
              </div>
              <div className="qv-focus-metrics">
                {marketPosition ? (
                  <span className={`qv-position-badge tone-${marketPosition.tone}`}>
                    {t(marketPosition.labelKey)}
                  </span>
                ) : analysisLoading ? (
                  <span className="qv-position-badge tone-muted">{t('hm.building')}</span>
                ) : null}
                <div className="qv-focus-spread">
                  <span className="qv-spread-label">{t('ov.spread')}</span>
                  <span className="qv-spread-value">{spreadLabel}</span>
                </div>
              </div>
            </div>

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

function AnalysisCard() {
  const { t } = useTranslation();
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const quickViewLoading = useAppStore((state) => state.quickView.loading);
  const sparklinePoints = useAppStore((state) => state.quickView.sparklinePoints);
  const sparklineLoading = useAppStore((state) => state.quickView.sparklineLoading);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const analysis = useAppStore((state) => state.selectedMarketAnalysis);
  const analysisLoading = useAppStore((state) => state.selectedMarketAnalysisLoading);
  const analysisError = useAppStore((state) => state.selectedMarketAnalysisError);
  const loadSelectedMarketAnalysis = useAppStore((state) => state.loadSelectedMarketAnalysis);
  const setActivePage = useAppStore((state) => state.setActivePage);
  const setMarketSubTab = useAppStore((state) => state.setMarketSubTab);

  useEffect(() => {
    if (!selectedItem || !selectedMarketVariantKey || quickViewLoading) {
      return;
    }
    void loadSelectedMarketAnalysis();
  }, [selectedItem?.itemId, selectedMarketVariantKey, quickViewLoading, loadSelectedMarketAnalysis]);

  const openMarketAnalysis = () => {
    setActivePage('market');
    setMarketSubTab('analysis');
  };

  const previewTone = getAnalysisPreviewTone(analysis);
  const previewLabel = t(buildAnalysisPreviewLabel(analysis));

  return (
    <div className="card accent-blue">
      <div className="card-header">
        <span className="card-label">{t('ov.analysisPreview')}</span>
        {analysis ? <span className={`badge badge-${previewTone}`}>{previewLabel}</span> : null}
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={openMarketAnalysis}>
            {t('ov.open')}
          </button>
        </div>
      </div>
      <div className="card-body dashboard-panel-shell">
        {!selectedItem ? (
          <div className="empty-state">
            <span className="empty-primary">{t('ov.searchToBuild')}</span>
            <span className="empty-sub">{t('ov.dashboardPreviewHint')}</span>
          </div>
        ) : null}

        {selectedItem && !selectedMarketVariantKey && !quickViewLoading ? (
          <div className="empty-state">
            <span className="empty-primary">{t('ov.selectVariantFirst')}</span>
            <span className="empty-sub">{t('ov.analysisStartsHint')}</span>
          </div>
        ) : null}

        {selectedItem && selectedMarketVariantKey && !analysis && analysisError ? (
          <div className="empty-state">
            <span className="empty-primary">{t('ov.analysisFailed')}</span>
            <span className="empty-sub">{analysisError}</span>
            <button
              className="text-btn"
              type="button"
              onClick={() => {
                void loadSelectedMarketAnalysis({ force: true });
              }}
            >
              {t('ov.retryAnalysis')}
            </button>
          </div>
        ) : null}

        {selectedItem && analysis ? (
          <div className="analysis-preview-shell">
            <div className={`analysis-preview-hero tone-${previewTone}`}>
              <div>
                <div className="analysis-preview-kicker">{t('ov.tradePosture')}</div>
                <div className="analysis-preview-title">{previewLabel}</div>
                <div className="analysis-preview-copy">
                  {tTrendSummary(t, analysis.trend)}
                </div>
              </div>
              <div className="analysis-preview-meta">
                <span className={`analysis-preview-confidence tone-${confidenceTone(analysis.headline.confidenceSummary)}`}>
                  {tConfidence(t, analysis.headline.confidenceSummary)}
                </span>
              </div>
            </div>

            <div className="analysis-preview-grid">
              <div className="analysis-preview-stat">
                <span className="analysis-preview-stat-label">{t('ov.entry')}</span>
                <span className="analysis-preview-stat-value">
                  {analysis.headline.entryPrice !== null ? `${Math.round(analysis.headline.entryPrice)} pt` : '—'}
                </span>
              </div>
              <div className="analysis-preview-stat">
                <span className="analysis-preview-stat-label">{t('ov.exit')}</span>
                <span className="analysis-preview-stat-value">
                  {analysis.headline.exitPrice !== null ? `${Math.round(analysis.headline.exitPrice)} pt` : '—'}
                </span>
              </div>
              <div className="analysis-preview-stat">
                <span className="analysis-preview-stat-label">{t('ov.netMargin')}</span>
                <span className="analysis-preview-stat-value">
                  {analysis.headline.netMargin !== null ? `${Math.round(analysis.headline.netMargin)} pt` : '—'}
                </span>
              </div>
              <div className="analysis-preview-stat">
                <span className="analysis-preview-stat-label">{t('ov.liquidity')}</span>
                <span className="analysis-preview-stat-value">
                  {analysis.headline.liquidityScore !== null ? `${Math.round(analysis.headline.liquidityScore)}%` : '—'}
                </span>
              </div>
              <div className="analysis-preview-stat">
                <span className="analysis-preview-stat-label">{t('ov.trend')}</span>
                <span className="analysis-preview-stat-value">{tHealth(t, analysis.trend.direction)}</span>
              </div>
              <div className="analysis-preview-stat">
                <span className="analysis-preview-stat-label">{t('ov.risk')}</span>
                <span className="analysis-preview-stat-value">{tHealth(t, analysis.manipulationRisk.riskLevel)}</span>
              </div>
            </div>

            <PriceTrendChart points={sparklinePoints} loading={sparklineLoading} />
          </div>
        ) : null}

        <CardLoadingOverlay
          visible={Boolean(selectedItem && selectedMarketVariantKey && analysisLoading)}
          label={t('hm.buildingAnalysis', { item: selectedItem?.name ?? '…' })}
        />
      </div>
    </div>
  );
}

export function Overview() {
  return (
    <div className="dashboard">
      <div className="content-row">
        <ErrorBoundary label="Quick View">
          <QuickViewCard />
        </ErrorBoundary>
        <ErrorBoundary label="Analysis Preview">
          <AnalysisCard />
        </ErrorBoundary>
      </div>
      <div className="watchlist-row-shell">
        <ErrorBoundary label="Watchlist">
          <WatchlistCard />
        </ErrorBoundary>
        <ErrorBoundary label="Events">
          <EventsCard />
        </ErrorBoundary>
      </div>
    </div>
  );
}
