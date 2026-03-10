import { useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { mockPortfolioStats } from '../../mocks/portfolio';

function CumulativeProfitChart() {
  return (
    <div className="chart-card">
      <div className="chart-header">Cumulative Profit Curve</div>
      <div className="chart-body" style={{ padding: 16, display: 'block', position: 'relative' }}>
        <svg width="100%" height="130" viewBox="0 0 400 130" preserveAspectRatio="none">
          <line x1="0" y1="0" x2="0" y2="110" stroke="var(--border)" strokeWidth="1"/>
          <line x1="0" y1="110" x2="400" y2="110" stroke="var(--border)" strokeWidth="1"/>
          <text x="5" y="15" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">60</text>
          <text x="5" y="42" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">45</text>
          <text x="5" y="69" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">30</text>
          <text x="5" y="96" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">15</text>
          <polyline points="20,75 120,55 200,50 280,30 380,12" fill="none" stroke="var(--accent-blue)" strokeWidth="2"/>
          <polyline points="20,75 120,55 200,50 280,30 380,12 380,110 20,110" fill="rgba(74,158,255,0.06)" stroke="none"/>
          <text x="20"  y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">2026-03-09</text>
          <text x="320" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">2026-03-10</text>
        </svg>
      </div>
    </div>
  );
}

function ProfitPerTradeChart() {
  return (
    <div className="chart-card">
      <div className="chart-header">Profit Per Trade</div>
      <div className="chart-body" style={{ padding: 16, display: 'block' }}>
        <svg width="100%" height="130" viewBox="0 0 300 130" preserveAspectRatio="none">
          <line x1="0" y1="110" x2="300" y2="110" stroke="var(--border)" strokeWidth="1"/>
          <text x="2" y="15" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">36</text>
          <text x="2" y="42" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">27</text>
          <text x="2" y="69" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">18</text>
          <text x="2" y="96" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">9</text>
          <rect x="30"  y="10" width="80" height="100" fill="rgba(61,214,140,0.5)" rx="2"/>
          <rect x="160" y="40" width="80" height="70"  fill="rgba(61,214,140,0.5)" rx="2"/>
          <text x="50"  y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">Wisp Prime Set</text>
          <text x="165" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">Wisp Prime Set</text>
        </svg>
      </div>
    </div>
  );
}

function TradeLogTab() {
  return (
    <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
      <span className="empty-primary">No trade history yet</span>
      <span className="empty-sub">Completed trades will appear here</span>
    </div>
  );
}

export function PortfolioPage() {
  const tradePeriod = useAppStore((s) => s.tradePeriod);
  const setTradePeriod = useAppStore((s) => s.setTradePeriod);
  const [portfolioTab, setPortfolioTab] = useState<'pnl' | 'log'>('pnl');

  const s = mockPortfolioStats;

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Portfolio</span>
          <span className={`subtab${portfolioTab === 'pnl' ? ' active' : ''}`} onClick={() => setPortfolioTab('pnl')} role="tab" tabIndex={0}>P&amp;L Summary</span>
          <span className={`subtab${portfolioTab === 'log' ? ' active' : ''}`} onClick={() => setPortfolioTab('log')} role="tab" tabIndex={0}>Trade Log</span>
        </div>
      </div>
      <div className="page-content">
        {portfolioTab === 'log' ? <TradeLogTab /> : (
          <>
            {/* Period selector */}
            <div className="period-bar">
              <label>Period:</label>
              {(['7d', '30d', 'all'] as const).map((p) => (
                <button
                  key={p}
                  className={`period-btn${tradePeriod === p ? ' active' : ''}`}
                  onClick={() => setTradePeriod(p)}
                >
                  {p === 'all' ? 'All Time' : p}
                </button>
              ))}
              <div className="period-right">
                <button className="act-btn">Refresh Trades</button>
              </div>
            </div>

            {/* Plat grid */}
            <div className="plat-grid">
              <div className="info-card">
                <div className="info-card-label">Total Plat (All Time)</div>
                <div className="info-card-val">{s.totalPlatAllTime.toFixed(2)} pt</div>
              </div>
              <div className="info-card">
                <div className="info-card-label">Total Plat (7d)</div>
                <div className="info-card-val">{s.totalPlat7d.toFixed(2)} pt</div>
              </div>
              <div className="info-card">
                <div className="info-card-label">Total Plat (30d)</div>
                <div className="info-card-val">{s.totalPlat30d.toFixed(2)} pt</div>
              </div>
            </div>

            {/* Alloc grid */}
            <div className="alloc-grid">
              <div className="info-card">
                <div className="info-card-label">Allocator Status</div>
                <div className="info-card-val off" style={{ fontSize: 16 }}>Off</div>
              </div>
              <div className="info-card">
                <div className="info-card-label">Allocator Allocated</div>
                <div className="info-card-val neutral" style={{ fontSize: 16 }}>--</div>
              </div>
              <div className="info-card">
                <div className="info-card-label">Allocator Expected Net</div>
                <div className="info-card-val neutral" style={{ fontSize: 16 }}>--</div>
              </div>
            </div>

            {/* Perf grid */}
            <div className="perf-grid">
              <div className="perf-card">
                <div className="perf-label">Profit</div>
                <div className="perf-val green">{s.profit.toFixed(2)}<br/><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>pt</span></div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Trades</div>
                <div className="perf-val">{s.trades}</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Win Rate</div>
                <div className="perf-val blue">{s.winRate.toFixed(2)}%</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Avg Margin</div>
                <div className="perf-val blue">{s.avgMargin.toFixed(2)}%</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Avg Hold</div>
                <div className="perf-val">{s.avgHold.toFixed(2)}h</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Plat/hr</div>
                <div className="perf-val">{s.platPerHour.toFixed(2)}</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Best Trade</div>
                <div className="perf-val green" style={{ fontSize: 11, lineHeight: 1.3 }}>
                  {s.bestTrade.item.slice(0, 10)}…<br/>{s.bestTrade.profit.toFixed(2)}pt
                </div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Top Category</div>
                <div className="perf-val" style={{ fontSize: 12, lineHeight: 1.3 }}>
                  {s.topCategory.name}<br/><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.topCategory.profit.toFixed(2)}pt</span>
                </div>
              </div>
            </div>

            {/* Charts */}
            <div className="chart-grid">
              <CumulativeProfitChart />
              <ProfitPerTradeChart />
            </div>
          </>
        )}
      </div>
    </>
  );
}

