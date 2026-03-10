import { useAppStore } from '../../stores/useAppStore';
import { mockTradeStats } from '../../mocks/trades';

function healthColor(score: number) {
  if (score >= 75) return 'var(--accent-green)';
  if (score >= 50) return 'var(--accent-amber)';
  return 'var(--accent-red)';
}

function SellOrdersTab() {
  const sellOrders = useAppStore((s) => s.sellOrders);
  const removeSellOrder = useAppStore((s) => s.removeSellOrder);
  const newOrderName = useAppStore((s) => s.newOrderName);
  const setNewOrderName = useAppStore((s) => s.setNewOrderName);
  const newOrderPrice = useAppStore((s) => s.newOrderPrice);
  const setNewOrderPrice = useAppStore((s) => s.setNewOrderPrice);
  const newOrderQty = useAppStore((s) => s.newOrderQty);
  const setNewOrderQty = useAppStore((s) => s.setNewOrderQty);
  const newOrderRank = useAppStore((s) => s.newOrderRank);
  const setNewOrderRank = useAppStore((s) => s.setNewOrderRank);

  return (
    <>
      {/* Connection bar */}
      <div className="connection-bar">
        <span className="conn-badge">Connected</span>
        <span className="conn-meta">Account: <strong>qtPyth</strong></span>
        <span className="conn-meta" style={{ color: 'var(--text-muted)' }}>Updated 2s ago</span>
        <span className="conn-meta">Seller filter: <strong>In-Game</strong></span>
        <div className="conn-actions">
          <button className="act-btn">Refresh</button>
          <button className="act-btn danger">Disconnect</button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="stats-strip">
        <div className="stat-mini">
          <div className="stat-mini-label">Portfolio Profit (All Time)</div>
          <div className="stat-mini-val">{mockTradeStats.profitAllTime} pt</div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">Portfolio Profit (30d)</div>
          <div className="stat-mini-val">{mockTradeStats.profit30d} pt</div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">Completed Trades</div>
          <div className="stat-mini-val neutral">{mockTradeStats.completedTrades}</div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">Open Positions</div>
          <div className="stat-mini-val neutral">{mockTradeStats.openPositions}</div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">Win Rate</div>
          <div className="stat-mini-val rate">{mockTradeStats.winRate.toFixed(1)}%</div>
        </div>
      </div>

      {/* Create order */}
      <div className="create-order-card">
        <div className="create-order-label">Create Sell Order</div>
        <div className="create-order-fields">
          <input
            className="field-input"
            placeholder="Type exact item name"
            value={newOrderName}
            onChange={(e) => setNewOrderName(e.target.value)}
          />
          <input
            className="field-input"
            type="number"
            value={newOrderPrice}
            onChange={(e) => setNewOrderPrice(e.target.value)}
            placeholder="Price"
          />
          <input
            className="field-input"
            type="number"
            value={newOrderQty}
            onChange={(e) => setNewOrderQty(e.target.value)}
            placeholder="Qty"
          />
          <input
            className="field-input"
            type="number"
            value={newOrderRank}
            onChange={(e) => setNewOrderRank(e.target.value)}
            placeholder="Rank"
          />
          <button className="btn-primary">+ Create Listing</button>
        </div>
      </div>

      {/* Listings table */}
      <div className="card">
        <table className="listing-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Your Price</th>
              <th>Market Low</th>
              <th>Price Gap</th>
              <th>Listing Health</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sellOrders.map((order) => {
              const gap = order.yourPrice - order.marketLow;
              return (
                <tr key={order.id}>
                  <td>
                    <div className="item-cell">
                      <div className="item-thumb">{order.emoji}</div>
                      <div>
                        <div className="item-name">{order.name}</div>
                        <div className="item-id">{order.slug} · Qty: {order.qty}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>CURRENT LISTING</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{order.yourPrice}pt</div>
                  </td>
                  <td>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>CHEAPEST IN-GAME</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{order.marketLow}pt</div>
                  </td>
                  <td>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>YOU VS LOW</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: gap > 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                      {gap > 0 ? '+' : ''}{gap}pt
                    </div>
                  </td>
                  <td>
                    <div className="health-score" style={{ color: healthColor(order.healthScore) }}>
                      {order.healthScore}/100
                    </div>
                    <div className="health-note">{order.healthNote}</div>
                    <div className="health-checked">Checked {order.checkedAgo}</div>
                  </td>
                  <td>
                    <div className="actions-cell">
                      <input className="qty-input" type="number" defaultValue={1} />
                      <button className="act-btn">Mark Sold</button>
                      <button className="act-btn">Details</button>
                      <button className="act-btn">Edit</button>
                      <button className="act-btn danger" onClick={() => removeSellOrder(order.id)}>Remove</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {sellOrders.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    <span className="empty-primary">No sell orders</span>
                    <span className="empty-sub">Create a listing above to get started</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BuyOrdersTab() {
  return (
    <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
      <span className="empty-primary">No buy orders</span>
      <span className="empty-sub">Buy orders will appear here when created</span>
    </div>
  );
}

function HealthTab() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-muted)', fontSize: 13 }}>
      Health report not available — connect to Warframe Market first
    </div>
  );
}

export function TradesPage() {
  const tradesSubTab = useAppStore((s) => s.tradesSubTab);
  const setTradesSubTab = useAppStore((s) => s.setTradesSubTab);

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Trades</span>
          <span className={`subtab${tradesSubTab === 'sell-orders' ? ' active' : ''}`} onClick={() => setTradesSubTab('sell-orders')} role="tab" tabIndex={0}>Sell Orders</span>
          <span className={`subtab${tradesSubTab === 'buy-orders'  ? ' active' : ''}`} onClick={() => setTradesSubTab('buy-orders')}  role="tab" tabIndex={0}>Buy Orders</span>
          <span className={`subtab${tradesSubTab === 'health'      ? ' active' : ''}`} onClick={() => setTradesSubTab('health')}      role="tab" tabIndex={0}>Health</span>
        </div>
      </div>
      <div className="page-content">
        {tradesSubTab === 'sell-orders' && <SellOrdersTab />}
        {tradesSubTab === 'buy-orders'  && <BuyOrdersTab />}
        {tradesSubTab === 'health'      && <HealthTab />}
      </div>
    </>
  );
}
