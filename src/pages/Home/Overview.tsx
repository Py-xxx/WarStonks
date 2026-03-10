import { useEffect, useState } from 'react';
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

const bellSvg = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
);

function formatMessage(order: WfmTopSellOrder, itemName: string): string {
  return `/w ${order.username} Hey there! I would like to buy ${itemName} for ${order.platinum} :platinum: (WarStonks - by py)`;
}

async function copyMessageToClipboard(order: WfmTopSellOrder, itemName: string): Promise<void> {
  const message = formatMessage(order, itemName);

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(message);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = message;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
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

function AlertsCard() {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Alerts</span>
        <span className="badge badge-muted">0</span>
        <div className="card-actions">
          <button className="text-btn">Mark All Read</button>
        </div>
      </div>
      <div className="empty-state">
        <span className="empty-icon">{bellSvg}</span>
        <span className="empty-primary">No active alerts</span>
        <span className="empty-sub">Alerts appear when watchlist items hit target prices</span>
      </div>
    </div>
  );
}

function WatchlistCard() {
  const watchlist = useAppStore((s) => s.watchlist);
  const selectedId = useAppStore((s) => s.selectedWatchlistId);
  const setSelected = useAppStore((s) => s.setSelectedWatchlist);
  const targetInput = useAppStore((s) => s.watchlistTargetInput);
  const setTargetInput = useAppStore((s) => s.setWatchlistTargetInput);
  const addWatchlistItem = useAppStore((s) => s.addWatchlistItem);

  const handleAdd = () => {
    const name = prompt('Item name:');
    if (!name) return;
    const price = parseFloat(targetInput) || 0;
    addWatchlistItem(name, price);
    setTargetInput('');
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Watchlist</span>
        <span className="badge badge-blue">{watchlist.length} items</span>
        <div className="card-actions">
          <span className="input-label">pt</span>
          <input
            className="price-input"
            type="number"
            placeholder="0"
            title="Target price"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
          />
          <button className="btn-sm" onClick={handleAdd}>+ Add</button>
        </div>
      </div>

      {watchlist.length === 0 ? (
        <div className="empty-state">
          <span className="empty-primary">No watchlist items yet</span>
          <span className="empty-sub">Add tracked items here later. Overview no longer ships with seeded mock watchlist data.</span>
        </div>
      ) : (
        <>
          <table className="wl-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Target</th>
                <th>Current</th>
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => setSelected(item.id)}
                  style={{ cursor: 'pointer', background: selectedId === item.id ? 'var(--bg-elevated)' : undefined }}
                >
                  <td>{item.name}</td>
                  <td className="td-muted">{item.targetPrice} pt</td>
                  <td>{item.currentPrice} pt</td>
                  <td className={item.delta24h >= 0 ? 'td-green' : 'td-red'}>
                    {item.delta24h >= 0 ? '+' : ''}{item.delta24h.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="wl-footer">
            <span>10s · burst 1 · queue 0 · 429 0%</span>
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
  const spread =
    quickView.sellOrders.length >= 5
      ? quickView.sellOrders[4].platinum - quickView.sellOrders[0].platinum
      : null;
  const sparklinePath = buildSparklinePath(quickView.sellOrders.map((order) => order.platinum));

  useEffect(() => {
    setCopiedOrderId(null);
    setCopyFeedback(null);
  }, [selectedItem?.slug]);

  const handleCopy = async (order: WfmTopSellOrder) => {
    if (!selectedItem) {
      return;
    }

    try {
      await copyMessageToClipboard(order, selectedItem.name);
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
        <span className="qv-title">{selectedItem?.name ?? 'No item selected'}</span>
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
              <div>
                <div className="qv-stat-label">Orders Loaded</div>
                <div className="qv-stat-value">{quickView.sellOrders.length}</div>
              </div>
              <div>
                <div className="qv-stat-label">Entry Price</div>
                <div className="qv-stat-value" style={{ color: 'var(--accent-green)' }}>{mainOrder.platinum} pt</div>
              </div>
              <div>
                <div className="qv-stat-label">Exit Price</div>
                <div className="qv-stat-value qv-stat-pending">Pending</div>
              </div>
              <div>
                <div className="qv-stat-label">Quantity</div>
                <div className="qv-stat-value">{mainOrder.quantity}</div>
              </div>
              <div>
                <div className="qv-stat-label">Per Trade</div>
                <div className="qv-stat-value">{mainOrder.perTrade}</div>
              </div>
              <div>
                <div className="qv-stat-label">Rank</div>
                <div className="qv-stat-value">{mainOrder.rank ?? '—'}</div>
              </div>
              <div>
                <div className="qv-stat-label">Per Trade</div>
                <div className="qv-stat-value">{mainOrder.perTrade}</div>
              </div>
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
                  <span>{order.username}</span>
                  <span>{order.platinum} pt</span>
                </button>
              ))}
            </div>

            {copyFeedback ? <div className="qv-copy-feedback">{copyFeedback}</div> : null}

            <div className="qv-spread-row">
              <span className="qv-spread-label">Spread</span>
              <span className="qv-spread-value">
                {spread === null ? 'Waiting for 5 sell orders' : `${spread} pt`}
              </span>
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
      <div className="priority-row">
        <AlertsCard />
        <WatchlistCard />
      </div>
      <MetricsRow />
      <div className="content-row">
        <QuickViewCard />
        <AnalysisCard />
      </div>
    </div>
  );
}
