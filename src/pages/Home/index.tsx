import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import type { HomeSubTab } from '../../types';
import { ErrorBoundary } from '../../components/ErrorBoundary';
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
  const { t } = useTranslation();

  const tabs: { id: HomeSubTab; labelKey: TranslationKey }[] = [
    { id: 'overview', labelKey: 'home.tab.overview' },
    { id: 'watchlist', labelKey: 'home.tab.watchlist' },
    { id: 'alerts', labelKey: 'home.tab.alerts' },
  ];

  return (
    <div className="home-page-shell">
      <div className="subnav home-page-subnav">
        <div className="subnav-left">
          <span className="page-title">{t('home.title')}</span>
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
              {t(tab.labelKey)}
            </span>
          ))}
        </div>
        <div className="subnav-right">
          <div className="seller-group" role="group" aria-label={t('home.seller.filter')}>
            <button
              className={`seller-option${sellerMode === 'ingame' ? ' active' : ''}`}
              type="button"
              onClick={() => setSellerMode('ingame')}
            >
              {t('home.seller.ingame')}
            </button>
            <button
              className={`seller-option${sellerMode === 'ingame-online' ? ' active' : ''}`}
              type="button"
              onClick={() => setSellerMode('ingame-online')}
            >
              {t('home.seller.ingameOnline')}
            </button>
          </div>
          <div className="toggle-wrap">
            <span>{t('home.autoProfile')}</span>
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

      <ErrorBoundary label="Dashboard">
        {homeSubTab === 'overview'    && <Overview />}
        {homeSubTab === 'watchlist'   && <WatchlistTab />}
        {homeSubTab === 'alerts'      && <AlertsTab />}
      </ErrorBoundary>
    </div>
  );
}
