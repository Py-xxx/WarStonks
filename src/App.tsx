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

export function App() {
  return (
    <>
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <main className="content">
          <PageRouter />
        </main>
      </div>
    </>
  );
}
