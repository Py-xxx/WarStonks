import { useAppStore } from '../../stores/useAppStore';
import { ActiveEventsPanel } from '../../components/ActiveEventsPanel';

function EmptyState({ message }: { message: string }) {
  return (
    <div className="empty-state" style={{ minHeight: 120 }}>
      <span className="empty-primary">{message}</span>
    </div>
  );
}

export function EventsPage() {
  const eventsSubTab = useAppStore((s) => s.eventsSubTab);
  const setEventsSubTab = useAppStore((s) => s.setEventsSubTab);

  const tabs = [
    { id: 'active-events' as const, label: 'Active Events' },
    { id: 'void-trader'  as const, label: 'Void Trader' },
    { id: 'fissures'     as const, label: 'Fissures' },
    { id: 'activities'   as const, label: 'Activities' },
    { id: 'market-news'  as const, label: 'Market & News' },
  ];

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Events</span>
          {tabs.map((tab) => (
            <span
              key={tab.id}
              className={`subtab${eventsSubTab === tab.id ? ' active' : ''}`}
              onClick={() => setEventsSubTab(tab.id)}
              role="tab"
              tabIndex={0}
            >
              {tab.label}
            </span>
          ))}
        </div>
      </div>

      <div className="page-content">
        {eventsSubTab === 'active-events' && <ActiveEventsPanel />}
        {eventsSubTab === 'void-trader' && (
          <div className="card">
            <div className="card-header"><span className="card-label">Void Trader</span></div>
            <EmptyState message="Void Trader is not wired to a live worldstate feed yet." />
          </div>
        )}
        {eventsSubTab === 'fissures' && (
          <div className="card">
            <div className="card-header">
              <span className="card-label">Fissures</span>
            </div>
            <EmptyState message="Fissures are not wired to a live worldstate feed yet." />
          </div>
        )}
        {eventsSubTab === 'activities' && (
          <div className="card">
            <div className="card-header"><span className="card-label">Activities</span></div>
            <EmptyState message="Activities are not wired to a live worldstate feed yet." />
          </div>
        )}
        {eventsSubTab === 'market-news' && (
          <div className="card">
            <div className="card-header"><span className="card-label">Market &amp; News</span></div>
            <EmptyState message="Market and news feeds are not wired to live data yet." />
          </div>
        )}
      </div>
    </>
  );
}
