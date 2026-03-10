import { useAppStore } from '../../stores/useAppStore';
import { ActiveEventsPanel } from '../../components/ActiveEventsPanel';
import { FissuresPanel } from '../../components/FissuresPanel';
import { VoidTraderPanel } from '../../components/VoidTraderPanel';

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
  const worldStateEventsError = useAppStore((s) => s.worldStateEventsError);
  const worldStateFissuresError = useAppStore((s) => s.worldStateFissuresError);
  const worldStateVoidTraderError = useAppStore((s) => s.worldStateVoidTraderError);
  const refreshWorldStateEvents = useAppStore((s) => s.refreshWorldStateEvents);
  const refreshWorldStateFissures = useAppStore((s) => s.refreshWorldStateFissures);
  const refreshWorldStateVoidTrader = useAppStore((s) => s.refreshWorldStateVoidTrader);

  const tabs = [
    { id: 'active-events' as const, label: 'Active Events' },
    { id: 'void-trader'  as const, label: 'Void Trader' },
    { id: 'fissures'     as const, label: 'Fissures' },
    { id: 'activities'   as const, label: 'Activities' },
    { id: 'market-news'  as const, label: 'Market & News' },
  ];

  const currentFeedError =
    eventsSubTab === 'active-events'
      ? worldStateEventsError
      : eventsSubTab === 'fissures'
        ? worldStateFissuresError
      : eventsSubTab === 'void-trader'
        ? worldStateVoidTraderError
        : null;
  const retryCurrentFeed =
    eventsSubTab === 'active-events'
      ? () => {
          void refreshWorldStateEvents();
        }
      : eventsSubTab === 'fissures'
        ? () => {
            void refreshWorldStateFissures();
          }
      : eventsSubTab === 'void-trader'
        ? () => {
            void refreshWorldStateVoidTrader();
          }
        : null;
  const currentFeedLabel =
    eventsSubTab === 'active-events'
      ? 'Active Events'
      : eventsSubTab === 'fissures'
        ? 'Fissures'
      : eventsSubTab === 'void-trader'
        ? 'Void Trader'
        : 'Events';

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

        <div className="page-content events-page-content">
        {eventsSubTab === 'active-events' && <ActiveEventsPanel />}
        {eventsSubTab === 'void-trader' && <VoidTraderPanel />}
        {eventsSubTab === 'fissures' && <FissuresPanel />}
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

        {currentFeedError ? (
          <div className="events-offline-overlay" role="status" aria-live="polite">
            <div className="events-offline-panel">
              <span className="card-label">Events Offline</span>
              <div className="events-offline-title">
                {currentFeedLabel} is unable to be updated because the API is offline.
              </div>
              <div className="events-offline-body">
                Last request failed. The page will retry automatically when the worldstate refresh
                timer runs again.
              </div>
              {retryCurrentFeed ? (
                <button
                  className="settings-secondary-btn events-offline-btn"
                  type="button"
                  onClick={retryCurrentFeed}
                >
                  Retry now
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
