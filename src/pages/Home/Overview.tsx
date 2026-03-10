import { useEffect, useState } from 'react';
import { WatchlistAddControls } from '../../components/WatchlistAddControls';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { getWatchlistVisualState } from '../../lib/watchlist';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { WfmTopSellOrder } from '../../types';

const COPY_RESET_DELAY_MS = 1800;
const COPY_ERROR_MESSAGE = 'Unable to copy the whisper message.';
const PENDING_METRIC_VALUE = '--';

const colorMap = {
  green: 'var(--accent-green)',
  amber: 'var(--accent-amber)',
  red: 'var(--accent-red)',
};

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

function WatchlistCard() {
  const watchlist = useAppStore((state) => state.watchlist);
  const selectedId = useAppStore((state) => state.selectedWatchlistId);
  const setSelected = useAppStore((state) => state.setSelectedWatchlist);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Watchlist</span>
        <span className="badge badge-blue">{watchlist.length} items</span>
      </div>

      <div className="card-body card-body-compact">
        <WatchlistAddControls compact />
      </div>

      {watchlist.length === 0 ? (
        <div className="empty-state">
          <span className="empty-primary">No watchlist items yet</span>
          <span className="empty-sub">Search for an item, set your desired price, and add it to start monitoring live sell orders.</span>
        </div>
      ) : (
        <>
          <table className="wl-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Target</th>
                <th>Current</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((item) => {
                const visualState = getWatchlistVisualState(item);

                return (
                  <tr
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                    className={`watchlist-row watchlist-row-${visualState.tone}${
                      selectedId === item.id ? ' selected' : ''
                    }`}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{item.name}</td>
                    <td className="td-muted">{item.targetPrice} pt</td>
                    <td>{item.currentPrice !== null ? `${item.currentPrice} pt` : '—'}</td>
                    <td className={`watchlist-status watchlist-status-${visualState.tone}`}>
                      {visualState.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="wl-footer">
            <span>Adaptive scans · min 10s per item</span>
            {selectedId ? (
              <span className="selected">
                Selected:{' '}
                <span style={{ color: 'var(--text-primary)' }}>
                  {watchlist.find((w) => w.id === selectedId)?.name}
                </span>
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function MetricsRow() {
  return (
    <div className="metrics-row">
      <div className="card metric-card">
        <div className="card-label">Best Score</div>
        <div className="metric-value">{PENDING_METRIC_VALUE}</div>
        <div className="metric-sub">Analysis pending</div>
        <div className="metric-bar">
          <div className="metric-bar-fill" style={{ width: '0%', background: colorMap.green }} />
        </div>
      </div>
      <div className="card metric-card">
        <div className="card-label">Avg Efficiency</div>
        <div className="metric-value">{PENDING_METRIC_VALUE}</div>
        <div className="metric-sub">Analysis pending</div>
        <div className="metric-bar">
          <div className="metric-bar-fill" style={{ width: '0%', background: colorMap.amber }} />
        </div>
      </div>
      <div className="card metric-card">
        <div className="card-label">Market Volatility</div>
        <div className="metric-value">{PENDING_METRIC_VALUE}</div>
        <div className="metric-sub">24h abs move</div>
        <div className="metric-bar">
          <div className="metric-bar-fill" style={{ width: '0%', background: colorMap.red, opacity: 0.7 }} />
        </div>
      </div>
    </div>
  );
}

function QuickViewCard() {
  const quickView = useAppStore((s) => s.quickView);
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const selectedItem = quickView.selectedItem;
  const mainOrder = quickView.sellOrders[0] ?? null;
  const compactOrders = quickView.sellOrders.slice(1, 5);
  const selectedItemImageUrl = resolveWfmAssetUrl(selectedItem?.imagePath);
  const sparklinePath = buildSparklinePath(quickView.sellOrders.map((order) => order.platinum));
  const spreadLabel = formatSpreadLabel(quickView.sellOrders);
  const mainStats = [
    {
      label: 'Entry Price',
      value: `${mainOrder?.platinum ?? 0} pt`,
      accent: 'var(--accent-green)',
    },
    {
      label: 'Exit Price',
      value: 'Pending',
      pending: true,
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
  }, [selectedItem?.slug]);

  const handleCopy = async (order: WfmTopSellOrder) => {
    if (!selectedItem) {
      return;
    }

    try {
      await copyWhisperMessage(order, selectedItem.name);
      setCopiedOrderId(order.orderId);
      setCopyFeedback(null);
      window.setTimeout(
        () => setCopiedOrderId((current) => (current === order.orderId ? null : current)),
        COPY_RESET_DELAY_MS,
      );
    } catch {
      setCopiedOrderId(null);
      setCopyFeedback(COPY_ERROR_MESSAGE);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Quick View</span>
        <span className="qv-title">{selectedItem?.itemFamily ?? 'WFM item'}</span>
        <div className="card-actions">
          {quickView.apiVersion ? <span className="badge badge-muted">WFM {quickView.apiVersion}</span> : null}
        </div>
      </div>

      <div className="card-body">
        {!selectedItem ? (
          <div className="empty-state">
            <span className="empty-primary">Search a WFM item to load quick view</span>
            <span className="empty-sub">Autocomplete uses the local SQLite catalog only. Live orders are fetched only after you pick an item.</span>
          </div>
        ) : null}

        {selectedItem && quickView.loading ? (
          <div className="empty-state">
            <span className="empty-primary">Loading top sell orders…</span>
            <span className="empty-sub">Fetching the 5 cheapest online sell orders for {selectedItem.name}.</span>
          </div>
        ) : null}

        {selectedItem && !quickView.loading && quickView.errorMessage ? (
          <div className="empty-state">
            <span className="empty-primary">Quick view failed to load</span>
            <span className="empty-sub">{quickView.errorMessage}</span>
          </div>
        ) : null}

        {selectedItem && !quickView.loading && !quickView.errorMessage && !mainOrder ? (
          <div className="empty-state">
            <span className="empty-primary">No online sell orders found</span>
            <span className="empty-sub">{selectedItem.name} currently has no top sell orders returned by warframe.market.</span>
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
                  <div className="qv-stat-label">Selected Item</div>
                  <div className="qv-focus-item-name">{selectedItem.name}</div>
                </div>
              </div>
              <div>
                <div className="qv-stat-label">Cheapest Seller</div>
                <div className="qv-focus-user">{mainOrder.username}</div>
                <div className="qv-focus-status">{mainOrder.status ?? 'online'}</div>
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
                  <polyline points={sparklinePath} fill="none" stroke="#3DD68C" strokeWidth="1.5" opacity="0.8" />
                  <polyline points={`${sparklinePath} 300,24 0,24`} fill="rgba(61,214,140,0.06)" stroke="none" />
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

            {copyFeedback ? <div className="qv-copy-feedback">{copyFeedback}</div> : null}

            <div className="qv-spread-row">
              <span className="qv-spread-label">Spread</span>
              <span className="qv-spread-value">{spreadLabel}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AnalysisCard() {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Analysis Preview</span>
      </div>
      <div className="card-body">
        <div className="analysis-placeholder">
          <span className="analysis-placeholder-title">Analysis is not live yet</span>
          <span className="analysis-placeholder-body">
            Exit price, score, trend, and derived opportunity metrics will be calculated here once the analysis layer is added.
          </span>
        </div>
      </div>
    </div>
  );
}

export function Overview() {
  return (
    <div className="dashboard">
      <MetricsRow />
      <div className="content-row">
        <QuickViewCard />
        <AnalysisCard />
      </div>
      <div className="watchlist-row-shell">
        <WatchlistCard />
      </div>
    </div>
  );
}
