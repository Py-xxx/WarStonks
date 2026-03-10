import { useState } from 'react';

export function ScannersPage() {
  const [activeTab, setActiveTab] = useState<'arbitrage' | 'relic-roi'>('arbitrage');

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Scanners</span>
          <span
            className={`subtab${activeTab === 'arbitrage' ? ' active' : ''}`}
            onClick={() => setActiveTab('arbitrage')}
            role="tab"
            tabIndex={0}
          >
            Arbitrage
          </span>
          <span
            className={`subtab${activeTab === 'relic-roi' ? ' active' : ''}`}
            onClick={() => setActiveTab('relic-roi')}
            role="tab"
            tabIndex={0}
          >
            Relic ROI
          </span>
        </div>
      </div>
      <div className="page-content">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-muted)', fontSize: 13 }}>
          Select a scanner to begin
        </div>
      </div>
    </>
  );
}
