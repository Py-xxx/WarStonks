import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAlecaframeProbe } from './hooks/useAlecaframeProbe';
import { useAppStore } from './stores/useAppStore';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { HomePage } from './pages/Home';
import { WatchlistPage } from './pages/Watchlist';
import { MarketPage } from './pages/Market';
import { EventsPage } from './pages/Events';
import { ScannersPage } from './pages/Scanners';
import { OpportunitiesPage } from './pages/Opportunities';
import { TradesPage } from './pages/Trades';
import { PortfolioPage } from './pages/Portfolio';
import { StrategyPage } from './pages/Strategy';
import { GuidePage } from './pages/Guide';
import { StartupScreen } from './components/StartupScreen';
import { SettingsDialog } from './components/Settings';
import { ToastHost } from './components/ToastHost';
import { BackgroundCatalogRefreshIndicator } from './components/BackgroundCatalogRefreshIndicator';
import { FarmingSessionPanel } from './components/FarmingSessionPanel';
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
import { useWorldStateExtras } from './hooks/useWorldStateExtras';
import { useMarketTracking } from './hooks/useMarketTracking';
import { useAutoScanScheduler } from './hooks/useAutoScanScheduler';
import { useTradeHealthBackground } from './hooks/useTradeHealthBackground';
import { useSmartManageAlerts } from './hooks/useSmartManageAlerts';
import { useTradeDetectedAlerts } from './hooks/useTradeDetectedAlerts';
import { usePrivateMessageAlerts } from './hooks/usePrivateMessageAlerts';
import { useTradePresence } from './hooks/useTradePresence';
import { useAppUpdater } from './hooks/useAppUpdater';

function WfstatStaleBanner() {
  const wfstatDataStale = useAppStore((s) => s.wfstatDataStale);
  const setWfstatDataStale = useAppStore((s) => s.setWfstatDataStale);

  if (!wfstatDataStale) {
    return null;
  }

  return (
    /* Body text stays full-contrast ink: the warning meaning is carried by the amber icon and
       ground, never by the text colour alone. */
    <div
      className="flex items-center gap-3 border-b border-accent-amber/45 bg-[color-mix(in_srgb,var(--color-accent-amber)_14%,var(--color-bg-surface))] px-4 py-2 text-xs leading-[1.4] text-ink"
      role="status"
    >
      <i className="ti ti-alert-triangle shrink-0 text-base text-accent-amber" aria-hidden="true" />
      <span className="flex-1">
        Warframestat (WFStat) data may be out of date — warframestat.us was unreachable, so
        WarStonks is showing its last saved data. This refreshes automatically when the service
        is back online.
      </span>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 border-accent-amber/55 font-semibold text-accent-amber hover:bg-accent-amber/[0.18] hover:text-accent-amber"
        onClick={() => setWfstatDataStale(false)}
        aria-label="Dismiss WFStat status notice"
      >
        Dismiss
      </Button>
    </div>
  );
}

function PageRouter() {
  const activePage = useAppStore((s) => s.activePage);

  switch (activePage) {
    case 'home':          return <HomePage />;
    case 'watchlist':     return <WatchlistPage />;
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
  useAutoScanScheduler();
  useTradeHealthBackground();
  useSmartManageAlerts();
  useTradeDetectedAlerts();
  usePrivateMessageAlerts();
  // Build the relic-drop index once so item context menus can offer "View drop details".
  const loadRelicDropIndex = useAppStore((state) => state.loadRelicDropIndex);
  useEffect(() => {
    void loadRelicDropIndex();
  }, [loadRelicDropIndex]);
  useTradePresence();
  useAppUpdater();
  useIntegrationSettings();
  useWorldStateEvents();
  useWorldStateFissures();
  useWorldStateMarketNews();
  useWorldStateVoidTrader();
  useWorldStateActivities();
  useWorldStateExtras();
  useAlecaframeProbe();

  return (
    // One provider for the whole app. Without it, Base UI falls back to its own OPEN_DELAY of
    // 600ms and the primitive's documented 250ms never applies — `Tooltip.Root` takes no `delay`
    // prop in this version, so the provider is the only place that delay can be set.
    <TooltipProvider>
      <TopBar />
      <WfstatStaleBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        {/* Two very low-opacity blooms at the top corners — the only thing separating the content
            ground from flat `bg-base`. Kept on the shell, not on any page, so every page inherits
            the same one. */}
        <main className="flex flex-1 flex-col overflow-hidden bg-bg-base bg-[radial-gradient(900px_320px_at_18%_-8%,color-mix(in_srgb,var(--color-accent-blue)_5%,transparent),transparent_65%),radial-gradient(700px_280px_at_92%_-6%,color-mix(in_srgb,var(--color-accent-purple)_4%,transparent),transparent_60%)]">
          <PageRouter />
        </main>
      </div>
      <SettingsDialog />
      <FarmingSessionPanel />
      <ToastHost />
      <BackgroundCatalogRefreshIndicator />
    </TooltipProvider>
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
