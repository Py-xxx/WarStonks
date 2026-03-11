import { useAppStore } from '../../stores/useAppStore';
import { ActiveEventsPanel } from '../../components/ActiveEventsPanel';
import { ActivitiesPanel } from '../../components/ActivitiesPanel';
import { FissuresPanel } from '../../components/FissuresPanel';
import { MarketNewsPanel } from '../../components/MarketNewsPanel';
import { VoidTraderPanel } from '../../components/VoidTraderPanel';

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

        <div className="page-content events-page-content">
        {eventsSubTab === 'active-events' && <ActiveEventsPanel />}
        {eventsSubTab === 'void-trader' && <VoidTraderPanel />}
        {eventsSubTab === 'fissures' && <FissuresPanel />}
        {eventsSubTab === 'activities' && <ActivitiesPanel />}
        {eventsSubTab === 'market-news' && <MarketNewsPanel />}

      </div>
    </>
  );
}
