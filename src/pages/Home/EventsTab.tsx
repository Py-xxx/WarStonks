import { mockFissures } from '../../mocks/events';

export function EventsTab() {
  return (
    <div style={{ padding: '16px 20px', flex: 1 }}>
      <div className="card">
        <div className="card-header">
          <span className="card-label">Active Events</span>
          <span className="badge badge-purple">1 active</span>
          <div className="card-actions">
            <button className="text-btn">Refresh</button>
          </div>
        </div>
        {mockFissures.slice(0, 1).map((evt) => (
          <div key={evt.id} className="event-row">
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
        ))}
      </div>
    </div>
  );
}
