import { useAppStore } from '../../stores/useAppStore';
import { mockFissures } from '../../mocks/events';
import type { GameEvent } from '../../types';

function EventRow({ evt }: { evt: GameEvent }) {
  return (
    <div className="event-row">
      <div>
        <div className="event-name">{evt.name}</div>
        <div className="event-dates">
          {evt.startDate ? `${evt.startDate} → ` : ''}{evt.endDate}
        </div>
      </div>
      <div className="event-badges">
        <span className={`badge badge-${evt.status === 'active' ? 'green' : 'muted'}`}>
          {evt.status === 'active' ? 'Active' : 'Upcoming'}
        </span>
        <span className={`badge badge-${evt.tier === 'high' ? 'red' : evt.tier === 'medium' ? 'amber' : 'muted'}`}>
          {evt.tier.charAt(0).toUpperCase() + evt.tier.slice(1)}
        </span>
      </div>
    </div>
  );
}

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
        {eventsSubTab === 'fissures' && (
          <div className="card">
            <div className="card-header">
              <span className="card-label">Fissures</span>
              <span className="badge badge-purple">{mockFissures.filter(e => e.status === 'active').length} active</span>
              <div className="card-actions"><button className="text-btn">Refresh</button></div>
            </div>
            {mockFissures.map((evt) => <EventRow key={evt.id} evt={evt} />)}
          </div>
        )}
        {eventsSubTab === 'activities' && (
          <div className="card">
            <div className="card-header"><span className="card-label">Activities</span></div>
            <EmptyState message="No activities found" />
          </div>
        )}
        {eventsSubTab === 'market-news' && (
          <div className="card">
            <div className="card-header"><span className="card-label">Market &amp; News</span></div>
            <EmptyState message="No market news available" />
          </div>
        )}
      </div>
    </>
  );
}
