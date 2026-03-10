import { useAppStore } from '../../stores/useAppStore';

function scoreBadge(score: number) {
  if (score >= 75) return 'badge-green';
  if (score >= 50) return 'badge-amber';
  return 'badge-muted';
}

export function WatchlistTab() {
  const watchlist = useAppStore((s) => s.watchlist);
  const removeItem = useAppStore((s) => s.removeWatchlistItem);
  const targetInput = useAppStore((s) => s.watchlistTargetInput);
  const setTargetInput = useAppStore((s) => s.setWatchlistTargetInput);
  const addItem = useAppStore((s) => s.addWatchlistItem);

  const handleAdd = () => {
    const name = prompt('Item name:');
    if (!name) return;
    addItem(name, parseFloat(targetInput) || 0);
    setTargetInput('');
  };

  return (
    <div className="wl-fullscreen">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          Watchlist
        </span>
        <span className="badge badge-blue">{watchlist.length} items</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="input-label">Target pt</span>
          <input
            className="price-input"
            type="number"
            placeholder="0"
            style={{ width: 80 }}
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
          />
          <button className="btn-sm" onClick={handleAdd}>+ Add Item</button>
        </div>
      </div>

      <div className="card">
        <table className="wl-fs-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Target Price</th>
              <th>Current Price</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Volume</th>
              <th>Δ 24h</th>
              <th>Score</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {watchlist.map((item) => (
              <tr key={item.id}>
                <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{item.name}</td>
                <td>{item.targetPrice} pt</td>
                <td style={{ color: item.currentPrice <= item.targetPrice ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                  {item.currentPrice} pt
                </td>
                <td>{item.entryPrice} pt</td>
                <td>{item.exitPrice} pt</td>
                <td className="td-muted">{item.volume.toLocaleString()}</td>
                <td className={item.delta24h >= 0 ? 'td-green' : 'td-red'}>
                  {item.delta24h >= 0 ? '+' : ''}{item.delta24h.toFixed(1)}%
                </td>
                <td>
                  <span className={`badge ${scoreBadge(item.score)}`}>{item.score}</span>
                </td>
                <td>
                  <button className="act-btn" style={{ marginRight: 4 }}>Details</button>
                  <button className="act-btn danger" onClick={() => removeItem(item.id)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="wl-footer">
          <span>10s · burst 1 · queue 0 · 429 0%</span>
        </div>
      </div>
    </div>
  );
}
