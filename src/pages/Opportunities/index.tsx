import { useState } from 'react';

type OppTab = 'opportunities' | 'farm-now' | 'set-planner' | 'owned-relics';

export function OpportunitiesPage() {
  const [activeTab, setActiveTab] = useState<OppTab>('opportunities');

  const tabs: { id: OppTab; label: string }[] = [
    { id: 'opportunities', label: 'Opportunities' },
    { id: 'farm-now',      label: 'What To Farm Now' },
    { id: 'set-planner',   label: 'Set Completion Planner' },
    { id: 'owned-relics',  label: 'Owned Relics' },
  ];

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Opportunities</span>
          {tabs.map((tab) => (
            <span
              key={tab.id}
              className={`subtab${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              tabIndex={0}
            >
              {tab.label}
            </span>
          ))}
        </div>
      </div>
      <div className="page-content">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-muted)', fontSize: 13 }}>
          No opportunities found — try adjusting strategy filters
        </div>
      </div>
    </>
  );
}
