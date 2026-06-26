import { useAppStore } from './stores/useAppStore';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { HomePage } from './pages/Home';
import { MarketPage } from './pages/Market';
import { EventsPage } from './pages/Events';
import { ScannersPage } from './pages/Scanners';
import { OpportunitiesPage } from './pages/Opportunities';
import { TradesPage } from './pages/Trades';
import { PortfolioPage } from './pages/Portfolio';
import { StrategyPage } from './pages/Strategy';
import { GuidePage } from './pages/Guide';
import { StartupScreen } from './components/StartupScreen';
import { SettingsSidebar } from './components/SettingsSidebar';
import { AlecaframeModal } from './components/AlecaframeModal';
import { DiscordWebhookModal } from './components/DiscordWebhookModal';
import { NotificationsModal } from './components/NotificationsModal';
import { ToastHost } from './components/ToastHost';
import { useStartupInitialization } from './hooks/useStartupInitialization';
import { useIntegrationSettings } from './hooks/useIntegrationSettings';
import { useWatchlistScanner } from './hooks/useWatchlistScanner';
import { useWatchlistSubscription } from './hooks/useWatchlistSubscription';
import { useUnderpricedListings } from './hooks/useUnderpricedListings';
import { useOpportunitiesSync } from './hooks/useOpportunitiesSync';
import { useOwnedRelicsBootstrap } from './hooks/useOwnedRelicsBootstrap';
import { useImageErrorRecovery } from './hooks/useImageErrorRecovery';
import { useWorldStateEvents } from './hooks/useWorldStateEvents';
import { useWorldStateFissures } from './hooks/useWorldStateFissures';
import { useWorldStateMarketNews } from './hooks/useWorldStateMarketNews';
import { useWorldStateVoidTrader } from './hooks/useWorldStateVoidTrader';
import { useWorldStateActivities } from './hooks/useWorldStateActivities';
import { useMarketTracking } from './hooks/useMarketTracking';
import { useTradeDetection } from './hooks/useTradeDetection';
import { useTradePresence } from './hooks/useTradePresence';
import { useAppUpdater } from './hooks/useAppUpdater';

function WfstatStaleBanner() {
  const wfstatDataStale = useAppStore((s) => s.wfstatDataStale);
  const setWfstatDataStale = useAppStore((s) => s.setWfstatDataStale);

  if (!wfstatDataStale) {
    return null;
  }

  return (
    <div className="data-stale-banner" role="status">
      <svg
        className="data-stale-banner-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span className="data-stale-banner-text">
        Warframestat (WFStat) data may be out of date — warframestat.us was unreachable, so
        WarStonks is showing its last saved data. This refreshes automatically when the service
        is back online.
      </span>
      <button
        type="button"
        className="data-stale-banner-dismiss"
        onClick={() => setWfstatDataStale(false)}
        aria-label="Dismiss WFStat status notice"
      >
        Dismiss
      </button>
    </div>
  );
}

function PageRouter() {
  const activePage = useAppStore((s) => s.activePage);

  switch (activePage) {
    case 'home':          return <HomePage />;
    case 'market':        return <MarketPage />;
    case 'events':        return <EventsPage />;
    case 'scanners':      return <ScannersPage />;
    case 'opportunities': return <OpportunitiesPage key="opportunities" />;
    case 'inventory':     return <OpportunitiesPage key="inventory" mode="inventory" />;
    case 'trades':        return <TradesPage />;
    case 'portfolio':     return <PortfolioPage />;
    case 'strategy':      return <StrategyPage />;
    case 'guide':         return <GuidePage />;
    default:              return <HomePage />;
  }
}

function AppShell() {
  useWatchlistScanner();
  useWatchlistSubscription();
  useUnderpricedListings();
  useOpportunitiesSync();
  useOwnedRelicsBootstrap();
  useImageErrorRecovery();
  useMarketTracking();
  useTradeDetection();
  useTradePresence();
  useAppUpdater();
  useIntegrationSettings();
  useWorldStateEvents();
  useWorldStateFissures();
  useWorldStateMarketNews();
  useWorldStateVoidTrader();
  useWorldStateActivities();

  return (
    <>
      <TopBar />
      <WfstatStaleBanner />
      <div className="app-body">
        <Sidebar />
        <main className="content">
          <PageRouter />
        </main>
      </div>
      <SettingsSidebar />
      <AlecaframeModal />
      <DiscordWebhookModal />
      <NotificationsModal />
      <ToastHost />
    </>
  );
}

export function App() {
  const { phase, progress, summary, errorMessage, retry } = useStartupInitialization();

  if (phase !== 'ready') {
    return (
      <StartupScreen
        progress={progress}
        summary={summary}
        errorMessage={errorMessage}
        onRetry={retry}
      />
    );
  }

  return <AppShell />;
}
