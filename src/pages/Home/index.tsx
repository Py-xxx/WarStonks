import { useAppStore } from '../../stores/useAppStore';
import type { HomeSubTab } from '../../types';
import { Overview } from './Overview';
import { WatchlistTab } from './WatchlistTab';
import { AlertsTab } from './AlertsTab';

export function HomePage() {
  const homeSubTab = useAppStore((s) => s.homeSubTab);
  const setHomeSubTab = useAppStore((s) => s.setHomeSubTab);
  const autoProfile = useAppStore((s) => s.autoProfile);
  const sellerMode = useAppStore((s) => s.sellerMode);
  const setSellerMode = useAppStore((s) => s.setSellerMode);
  const toggleAutoProfile = useAppStore((s) => s.toggleAutoProfile);

  const tabs: { id: HomeSubTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'alerts', label: 'Alerts' },
  ];

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Dashboard</span>
          {tabs.map((tab) => (
            <span
              key={tab.id}
              className={`subtab${homeSubTab === tab.id ? ' active' : ''}`}
              onClick={() => setHomeSubTab(tab.id)}
              role="tab"
              aria-selected={homeSubTab === tab.id}
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setHomeSubTab(tab.id)}
            >
              {tab.label}
            </span>
          ))}
        </div>
        <div className="subnav-right">
          <div className="seller-group" role="group" aria-label="Seller filter">
            <button
              className={`seller-option${sellerMode === 'ingame' ? ' active' : ''}`}
              type="button"
              onClick={() => setSellerMode('ingame')}
            >
              Ingame
            </button>
            <button
              className={`seller-option${sellerMode === 'ingame-online' ? ' active' : ''}`}
              type="button"
              onClick={() => setSellerMode('ingame-online')}
            >
              Ingame & Online
            </button>
          </div>
          <div className="toggle-wrap">
            <span>Auto Profile</span>
            <div
              className={`toggle${autoProfile ? ' on' : ''}`}
              onClick={toggleAutoProfile}
              role="switch"
              aria-checked={autoProfile}
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && toggleAutoProfile()}
            />
          </div>
        </div>
      </div>

      {homeSubTab === 'overview'    && <Overview />}
      {homeSubTab === 'watchlist'   && <WatchlistTab />}
      {homeSubTab === 'alerts'      && <AlertsTab />}
    </>
  );
}
