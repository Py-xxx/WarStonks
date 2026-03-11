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
import { StartupScreen } from './components/StartupScreen';
import { SettingsSidebar } from './components/SettingsSidebar';
import { AlecaframeModal } from './components/AlecaframeModal';
import { useStartupInitialization } from './hooks/useStartupInitialization';
import { useIntegrationSettings } from './hooks/useIntegrationSettings';
import { useWatchlistScanner } from './hooks/useWatchlistScanner';
import { useWorldStateEvents } from './hooks/useWorldStateEvents';
import { useWorldStateFissures } from './hooks/useWorldStateFissures';
import { useWorldStateMarketNews } from './hooks/useWorldStateMarketNews';
import { useWorldStateVoidTrader } from './hooks/useWorldStateVoidTrader';
import { useWorldStateActivities } from './hooks/useWorldStateActivities';
import { useMarketTracking } from './hooks/useMarketTracking';

function PageRouter() {
  const activePage = useAppStore((s) => s.activePage);

  switch (activePage) {
    case 'home':          return <HomePage />;
    case 'market':        return <MarketPage />;
    case 'events':        return <EventsPage />;
    case 'scanners':      return <ScannersPage />;
    case 'opportunities': return <OpportunitiesPage />;
    case 'trades':        return <TradesPage />;
    case 'portfolio':     return <PortfolioPage />;
    case 'strategy':      return <StrategyPage />;
    default:              return <HomePage />;
  }
}

function AppShell() {
  useWatchlistScanner();
  useMarketTracking();
  useIntegrationSettings();
  useWorldStateEvents();
  useWorldStateFissures();
  useWorldStateMarketNews();
  useWorldStateVoidTrader();
  useWorldStateActivities();

  return (
    <>
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <main className="content">
          <PageRouter />
        </main>
      </div>
      <SettingsSidebar />
      <AlecaframeModal />
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
