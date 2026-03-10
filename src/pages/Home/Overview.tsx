import { useAppStore } from '../../stores/useAppStore';
import { mockQuickView, mockAnalysisBars } from '../../mocks/watchlist';

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
        {selectedId && (
          <span className="selected">
            Selected:{' '}
            <span style={{ color: 'var(--text-primary)' }}>
              {watchlist.find((w) => w.id === selectedId)?.name}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function MetricsRow() {
  return (
    <div className="metrics-row">
      <div className="card metric-card">
        <div className="card-label">Best Score</div>
        <div className="metric-value">100</div>
        <div className="metric-sub">/ 100</div>
        <div className="metric-bar">
          <div className="metric-bar-fill" style={{ width: '100%', background: 'var(--accent-green)' }} />
        </div>
      </div>
      <div className="card metric-card">
        <div className="card-label">Avg Efficiency</div>
        <div className="metric-value">49.1</div>
        <div className="metric-sub">/ 100</div>
        <div className="metric-bar">
          <div className="metric-bar-fill" style={{ width: '49.1%', background: 'var(--accent-amber)' }} />
        </div>
      </div>
      <div className="card metric-card">
        <div className="card-label">Market Volatility</div>
        <div className="metric-value">100%</div>
        <div className="metric-sub">24h abs move</div>
        <div className="metric-bar">
          <div className="metric-bar-fill" style={{ width: '100%', background: 'var(--accent-red)', opacity: 0.7 }} />
        </div>
      </div>
    </div>
  );
}

// Normalise sparkline points to SVG coords
function buildSparklinePath(points: number[]): string {
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const w = 300;
  const h = 24;
  const step = w / (points.length - 1);
  return points
    .map((v, i) => {
      const x = Math.round(i * step);
      const y = Math.round(h - ((v - min) / range) * (h - 2) - 1);
      return `${x},${y}`;
    })
    .join(' ');
}

function QuickViewCard() {
  const selectedId = useAppStore((s) => s.selectedWatchlistId);
  const watchlist = useAppStore((s) => s.watchlist);
  const item = watchlist.find((w) => w.id === selectedId);
  const qv = mockQuickView;
  const spPath = buildSparklinePath(qv.sparkline);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Quick View</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--accent-green)', marginLeft: 2 }}>
          {item?.name ?? qv.item}
        </span>
        <div className="card-actions">
          <span className="badge badge-green">Score {item?.score ?? qv.score}</span>
        </div>
      </div>
      <div className="card-body">
        <div className="qv-grid">
          <div>
            <div className="qv-stat-label">Entry</div>
            <div className="qv-stat-value" style={{ color: 'var(--accent-green)' }}>{item?.entryPrice ?? qv.entry} pt</div>
          </div>
          <div>
            <div className="qv-stat-label">Exit</div>
            <div className="qv-stat-value" style={{ color: 'var(--accent-red)' }}>{item?.exitPrice ?? qv.exit} pt</div>
          </div>
          <div>
            <div className="qv-stat-label">Volume</div>
            <div className="qv-stat-value">{(item?.volume ?? qv.volume).toLocaleString()}</div>
          </div>
          <div>
            <div className="qv-stat-label">Spread</div>
            <div className="qv-stat-value" style={{ color: 'var(--accent-amber)' }}>
              {item ? item.exitPrice - item.entryPrice : qv.spread} pt
            </div>
          </div>
          <div>
            <div className="qv-stat-label">Trend</div>
            <div className="qv-stat-value" style={{ color: item && item.delta24h < 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>
              {(item?.delta24h ?? qv.trend) >= 0 ? '↑' : '↓'} {Math.abs(item?.delta24h ?? qv.trend).toFixed(1)}%
            </div>
          </div>
          <div>
            <div className="qv-stat-label">Efficiency</div>
            <div className="qv-stat-value">{qv.efficiency}</div>
          </div>
        </div>
        <div className="sparkline-wrap">
          <svg width="100%" height="24" viewBox="0 0 300 24" preserveAspectRatio="none">
            <polyline points={spPath} fill="none" stroke="#3DD68C" strokeWidth="1.5" opacity="0.8"/>
            <polyline points={`${spPath} 300,24 0,24`} fill="rgba(61,214,140,0.06)" stroke="none"/>
          </svg>
        </div>
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
        <div className="analysis-bars">
          {mockAnalysisBars.map((bar) => (
            <div key={bar.label} className="abar-row">
              <span className="abar-label">{bar.label}</span>
              <div className="abar-track">
                <div
                  className="abar-fill"
                  style={{ width: `${bar.value}%`, background: colorMap[bar.color], opacity: bar.color === 'red' ? 0.8 : 1 }}
                />
              </div>
              <span className="abar-val">{bar.value}</span>
            </div>
          ))}
        </div>
        <div className="analysis-note">
          Good liquidity and tight spread. Moderate velocity — suitable for short-hold strategy.
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
