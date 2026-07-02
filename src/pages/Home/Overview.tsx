import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { WatchlistAddControls } from '../../components/WatchlistAddControls';
import { WatchlistTable } from '../../components/WatchlistTable';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { buildWatchlistMarketSignals } from '../../lib/watchlistMarketSignals';
import { formatWorldStateCountdown, formatWorldStateDateTime } from '../../lib/worldState';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { resolveLocalizedName } from '../../lib/itemNames';
import { useTranslation } from '../../i18n';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useDocumentVisibility } from '../../hooks/useDocumentVisibility';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAppStore } from '../../stores/useAppStore';
import type { ItemAnalysisResponse, WfmTopSellOrder } from '../../types';

const COPY_RESET_DELAY_MS = 1800;
const colorMap = {
  green: 'var(--accent-green)',
  amber: 'var(--accent-amber)',
  red: 'var(--accent-red)',
};

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

function buildSparklinePath(points: number[]): string {
  if (points.length === 0) {
    return '';
  }

  const safePoints = points.length === 1 ? [points[0], points[0]] : points;
  const max = Math.max(...safePoints);
  const min = Math.min(...safePoints);
  const range = max - min || 1;
  const width = 300;
  const height = 24;
  const step = width / (safePoints.length - 1);

  return safePoints
    .map((value, index) => {
      const x = Math.round(index * step);
      const y = Math.round(height - ((value - min) / range) * (height - 2) - 1);
      return `${x},${y}`;
    })
    .join(' ');
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

function formatSpreadLabel(orders: WfmTopSellOrder[]): string {
  const spreadMetrics = calculateSpreadMetrics(orders);
  if (!spreadMetrics) {
    return 'Waiting for 5 sell orders';
  }

  if (spreadMetrics.spreadPercent === null) {
    return `${spreadMetrics.spreadPlatinum} pt`;
  }

  return `${spreadMetrics.spreadPlatinum} pt (${spreadMetrics.spreadPercent.toFixed(1)}%)`;
}

function buildDashboardEventDetail(node: string | null, expiry: string | null): string {
  const detailParts = [];

  if (node) {
    detailParts.push(node);
  }

  if (expiry) {
    detailParts.push(`Ends ${formatWorldStateDateTime(expiry)}`);
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

function buildAnalysisPreviewLabel(analysis: ItemAnalysisResponse | null): string {
  if (!analysis) {
    return 'Building';
  }
  if (analysis.manipulationRisk.riskLevel.toLowerCase().includes('high')) {
    return 'Caution';
  }
  if ((analysis.headline.netMargin ?? 0) > 0 && analysis.headline.confidenceSummary.level === 'high') {
    return 'Buy Bias';
  }
  if ((analysis.headline.netMargin ?? 0) > 0) {
    return 'Selective';
  }
  return 'Wait';
}

function WatchlistCard() {
  const { t } = useTranslation();
  const watchlistCount = useAppStore((state) => state.watchlist.length);

  return (
    <div className="card accent-green">
      <div className="card-header">
        <span className="card-label">{t('ov.watchlist')}</span>
        <span className="badge badge-blue">{watchlistCount} items</span>
      </div>

      <div className="card-body card-body-compact">
        <WatchlistAddControls compact />
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
          {worldStateEvents.length} active
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
                      <span>{buildDashboardEventDetail(event.node, event.expiry) || 'No node data'}</span>
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
              Loading active worldstate events for the dashboard.
            </button>
          ) : null}

          {!worldStateEventsError && !worldStateEventsLoading && worldStateEvents.length === 0 ? (
            <button
              className="watchlist-alert-summary-empty"
              type="button"
              onClick={openActiveEventsPage}
            >
              No active worldstate events right now. Click here to open the Events page.
            </button>
          ) : null}
        </div>
        <CardLoadingOverlay
          visible={worldStateEventsLoading}
          label="Refreshing active dashboard events"
        />
      </div>
    </div>
  );
}

function MetricsRow() {
  const watchlist = useAppStore((state) => state.watchlist);
  const signals = useMemo(() => buildWatchlistMarketSignals(watchlist), [watchlist]);

  return (
    <div className="metrics-row">
      {signals.map((signal) => (
        <div key={signal.key} className="card metric-card" title={signal.tooltip}>
          <div className="card-label">{signal.label}</div>
          <div className="metric-value">{signal.valueText}</div>
          <div className="metric-sub">{signal.subtitle}</div>
          <div className="metric-bar">
            <div
              className="metric-bar-fill"
              style={{
                width: `${signal.fillPct}%`,
                background:
                  signal.tone === 'green'
                    ? colorMap.green
                    : signal.tone === 'red'
                      ? colorMap.red
                      : colorMap.amber,
                opacity: signal.key === 'volatility' ? 0.8 : 1,
              }}
            />
          </div>
        </div>
      ))}
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
  const mainOrder = quickView.sellOrders[0] ?? null;
  const compactOrders = quickView.sellOrders.slice(1, 5);
  // Full snapshot, cheapest first, for the "View All" popup.
  const allOrders = useMemo(
    () => [...quickView.sellOrders].sort((a, b) => a.platinum - b.platinum),
    [quickView.sellOrders],
  );
  const selectedItemImageUrl = resolveWfmAssetUrl(selectedItem?.imagePath);
  const sparklinePath = buildSparklinePath(quickView.sparklinePoints);
  const spreadLabel = formatSpreadLabel(quickView.sellOrders);
  // Use the same recommended exit the Market analysis computes for this item; it's the
  // adaptive exit price from the shared analysis pipeline, not a placeholder.
  const exitPrice = analysis?.headline.exitPrice ?? null;
  const mainStats = [
    {
      label: 'Entry Price',
      value: `${mainOrder?.platinum ?? 0} pt`,
      accent: 'var(--accent-green)',
    },
    {
      label: 'Exit Price',
      value: exitPrice !== null ? `${Math.round(exitPrice)} pt` : analysisLoading ? 'Building…' : '—',
      pending: exitPrice === null,
      accent: exitPrice !== null ? 'var(--accent-blue)' : undefined,
    },
    {
      label: 'Quantity',
      value: `${mainOrder?.quantity ?? 0}`,
    },
    ...(mainOrder?.rank !== null && mainOrder?.rank !== undefined
      ? [
          {
            label: 'Rank',
            value: `${mainOrder.rank}`,
          },
        ]
      : []),
  ];

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
        <span className="qv-title">{selectedItem?.itemFamily ?? 'WFM item'}</span>
        <div className="card-actions">
          {quickView.apiVersion ? <span className="badge badge-muted">WFM {quickView.apiVersion}</span> : null}
        </div>
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
            <span className="empty-primary">Loading top sell orders…</span>
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
                <div>
                  <div className="qv-stat-label">{t('ov.selectedItem')}</div>
                  <div className="qv-focus-item-name">{selectedItemName}</div>
                </div>
              </div>
              <div>
                <div className="qv-stat-label">{t('ov.cheapestSeller')}</div>
                <div className="qv-focus-user">{mainOrder.username}</div>
                <div className="qv-focus-status">{mainOrder.status ?? 'Unknown'}</div>
              </div>
              <button className="btn-sm" onClick={() => void handleCopy(mainOrder)}>
                {copiedOrderId === mainOrder.orderId ? 'Copied' : 'Copy Message'}
              </button>
            </div>

            <div className="qv-grid">
              {mainStats.map((stat) => (
                <div key={stat.label}>
                  <div className="qv-stat-label">{stat.label}</div>
                  <div
                    className={`qv-stat-value${stat.pending ? ' qv-stat-pending' : ''}`}
                    style={stat.accent ? { color: stat.accent } : undefined}
                  >
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>

            {sparklinePath ? (
              <div className="sparkline-wrap">
                <svg width="100%" height="24" viewBox="0 0 300 24" preserveAspectRatio="none">
                  <polyline className="qv-sparkline-line" points={sparklinePath} fill="none" strokeWidth="1.5" opacity="0.8" />
                  <polyline className="qv-sparkline-fill" points={`${sparklinePath} 300,24 0,24`} stroke="none" />
                </svg>
              </div>
            ) : quickView.sparklineLoading ? (
              <div className="sparkline-wrap">
                <svg width="100%" height="24" viewBox="0 0 300 24" preserveAspectRatio="none">
                  <line className="qv-sparkline-mid" x1="0" y1="12" x2="300" y2="12" strokeDasharray="4 4" />
                </svg>
              </div>
            ) : null}

            <div className="qv-order-list">
              {compactOrders.map((order) => (
                <button
                  key={order.orderId}
                  className={`qv-order-button${copiedOrderId === order.orderId ? ' copied' : ''}`}
                  type="button"
                  onClick={() => void handleCopy(order)}
                >
                  <span className="qv-order-copy">
                    <span className="qv-order-primary">{order.username}</span>
                    <span className="qv-order-secondary">
                      Qty {order.quantity}
                      {order.rank !== null && order.rank !== undefined ? ` • Rank ${order.rank}` : ''}
                    </span>
                  </span>
                  <span className="qv-order-price">{order.platinum} pt</span>
                </button>
              ))}
            </div>
            {compactOrders.length > 0 ? (
              <div className="qv-order-hint">{t('ov.orderHint')}</div>
            ) : null}

            {allOrders.length > 1 ? (
              <button
                type="button"
                className="btn-secondary qv-view-all-btn"
                onClick={() => setViewAllOpen(true)}
              >
                View All ({allOrders.length})
              </button>
            ) : null}

            {copyFeedback ? <div className="qv-copy-feedback">{copyFeedback}</div> : null}

            <div className="qv-spread-row">
              <span className="qv-spread-label">{t('ov.spread')}</span>
              <span className="qv-spread-value">{spreadLabel}</span>
            </div>
          </div>
        ) : null}
        <CardLoadingOverlay
          visible={Boolean(selectedItem && quickView.loading)}
          label={`Loading quick view for ${selectedItem?.name ?? 'item'}`}
        />
      </div>

      {viewAllOpen && selectedItem ? createPortal(
        <div className="qv-viewall-root" role="dialog" aria-modal="true" aria-label="All sell orders">
          <button
            type="button"
            className="modal-backdrop"
            aria-label="Close all sell orders"
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
                aria-label="Close"
                onClick={() => setViewAllOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="qv-viewall-list">
              <div className="qv-viewall-row qv-viewall-row-head">
                <span>{t('ov.price')}</span>
                <span>Qty</span>
                <span>{t('ov.seller')}</span>
                <span />
              </div>
              {allOrders.map((order) => (
                <div key={order.orderId} className="qv-viewall-row">
                  <span className="qv-viewall-price">{order.platinum} pt</span>
                  <span className="qv-viewall-qty">{order.quantity}</span>
                  <span className="qv-viewall-user" title={order.username}>
                    {order.username}
                    {order.status ? <span className="qv-viewall-status">{order.status}</span> : null}
                  </span>
                  <button
                    type="button"
                    className={`btn-sm qv-viewall-copy${copiedOrderId === order.orderId ? ' copied' : ''}`}
                    onClick={() => void handleCopy(order)}
                  >
                    {copiedOrderId === order.orderId ? 'Copied' : 'Copy Message'}
                  </button>
                </div>
              ))}
            </div>

            {copyFeedback ? <div className="qv-copy-feedback">{copyFeedback}</div> : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function AnalysisCard() {
  const { t } = useTranslation();
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const quickViewLoading = useAppStore((state) => state.quickView.loading);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const selectedMarketVariantLabel = useAppStore((state) => state.selectedMarketVariantLabel);
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
  const previewLabel = buildAnalysisPreviewLabel(analysis);

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
                  {analysis.trend.summary}
                </div>
              </div>
              <div className="analysis-preview-meta">
                <span>{selectedMarketVariantLabel ?? 'Base Market'}</span>
                <span>{analysis.headline.confidenceSummary.label}</span>
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
                <span className="analysis-preview-stat-value">{analysis.trend.direction}</span>
              </div>
              <div className="analysis-preview-stat">
                <span className="analysis-preview-stat-label">{t('ov.risk')}</span>
                <span className="analysis-preview-stat-value">{analysis.manipulationRisk.riskLevel}</span>
              </div>
            </div>

            <div className="analysis-preview-foot">
              <span>{analysis.supplyContext.mode === 'set-components' ? 'Set breakdown ready' : analysis.supplyContext.mode === 'drop-sources' ? 'Drop sources ready' : 'No source context'}</span>
              <span>{analysis.computedAt ? `Computed ${formatShortLocalDateTime(analysis.computedAt)}` : ''}</span>
            </div>
          </div>
        ) : null}

        <CardLoadingOverlay
          visible={Boolean(selectedItem && selectedMarketVariantKey && analysisLoading)}
          label={`Building analysis for ${selectedItem?.name ?? 'item'}`}
        />
      </div>
    </div>
  );
}

export function Overview() {
  return (
    <div className="dashboard">
      <ErrorBoundary label="Market signals">
        <MetricsRow />
      </ErrorBoundary>
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
