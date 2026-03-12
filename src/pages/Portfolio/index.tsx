import { useState } from 'react';
import { getWfmProfileTradeLog } from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { formatPlatinumValue } from '../../lib/trades';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { PortfolioTradeLogEntry } from '../../types';
import { mockPortfolioStats } from '../../mocks/portfolio';

const RefreshIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

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
          <text x="20" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">2026-03-09</text>
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
          <rect x="30" y="10" width="80" height="100" fill="rgba(61,214,140,0.5)" rx="2"/>
          <rect x="160" y="40" width="80" height="70" fill="rgba(61,214,140,0.5)" rx="2"/>
          <text x="50" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">Wisp Prime Set</text>
          <text x="165" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">Wisp Prime Set</text>
        </svg>
      </div>
    </div>
  );
}

function renderTradeType(orderType: PortfolioTradeLogEntry['orderType']): string {
  return orderType === 'buy' ? 'Buy' : 'Sell';
}

function buildTradeTypeClassName(orderType: PortfolioTradeLogEntry['orderType']): string {
  return orderType === 'buy' ? 'badge-blue' : 'badge-green';
}

function TradeLogTab({ username }: { username: string | null }) {
  const [entries, setEntries] = useState<PortfolioTradeLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const handleRefresh = async () => {
    if (!username) {
      setErrorMessage('Connect your Warframe Market account in Trades first.');
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const nextEntries = await getWfmProfileTradeLog(username);
      setEntries(nextEntries);
      setLastUpdatedAt(new Date().toISOString());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="period-bar">
        <label>Trade Log</label>
        <div className="period-right portfolio-log-toolbar">
          {lastUpdatedAt ? (
            <span className="portfolio-log-updated">
              Last updated {formatShortLocalDateTime(lastUpdatedAt)}
            </span>
          ) : null}
          <button
            className="act-btn portfolio-refresh-btn"
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading}
          >
            <RefreshIcon />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {errorMessage ? (
        <div className="scanner-inline-error">{errorMessage}</div>
      ) : null}

      {!username ? (
        <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
          <span className="empty-primary">Connect your Warframe Market account first</span>
          <span className="empty-sub">Trade Log uses your public WFM profile statistics.</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
          <span className="empty-primary">No trade history loaded yet</span>
          <span className="empty-sub">Press Refresh to load your last 90 days of buy and sell orders.</span>
        </div>
      ) : (
        <div className="portfolio-log-card">
          <div className="portfolio-log-header">
            <span>Item</span>
            <span>Type</span>
            <span>Price</span>
            <span>Qty</span>
            <span>Rank</span>
            <span>Closed</span>
          </div>

          <div className="portfolio-log-list">
            {entries.map((entry) => (
              <div key={entry.id} className="portfolio-log-row">
                <div className="portfolio-log-item">
                  <span className="portfolio-log-thumb">
                    {entry.imagePath ? (
                      <img src={resolveWfmAssetUrl(entry.imagePath)} alt="" />
                    ) : (
                      <span className="portfolio-log-thumb-fallback">{entry.itemName.charAt(0)}</span>
                    )}
                  </span>
                  <div className="portfolio-log-item-copy">
                    <span className="portfolio-log-item-name">{entry.itemName}</span>
                    <span className="portfolio-log-item-slug">{entry.slug}</span>
                  </div>
                </div>

                <span className={`badge ${buildTradeTypeClassName(entry.orderType)}`}>
                  {renderTradeType(entry.orderType)}
                </span>
                <span className="portfolio-log-value">{formatPlatinumValue(entry.platinum)}</span>
                <span className="portfolio-log-value">{entry.quantity}</span>
                <span className="portfolio-log-value">{entry.rank ?? '—'}</span>
                <span className="portfolio-log-date">{formatShortLocalDateTime(entry.closedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function PortfolioPage() {
  const tradeAccount = useAppStore((s) => s.tradeAccount);
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
        {portfolioTab === 'log' ? <TradeLogTab username={tradeAccount?.name ?? null} /> : (
          <>
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
                <button className="act-btn" type="button">Refresh Trades</button>
              </div>
            </div>

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
