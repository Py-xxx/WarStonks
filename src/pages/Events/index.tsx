import { useAppStore } from '../../stores/useAppStore';
import type { EventsSubTab } from '../../types';
import { ActiveEventsPanel } from '../../components/ActiveEventsPanel';
import { ActivitiesPanel } from '../../components/ActivitiesPanel';
import { FissuresPanel } from '../../components/FissuresPanel';
import { MarketNewsPanel } from '../../components/MarketNewsPanel';
import { VoidTraderPanel } from '../../components/VoidTraderPanel';
import { VaultTraderPanel } from '../../components/VaultTraderPanel';
import { NightwavePanel } from '../../components/NightwavePanel';
import { SteelPathPanel } from '../../components/SteelPathPanel';
import { WorldClockPanel } from '../../components/WorldClockPanel';

const TABS: { id: EventsSubTab; label: string }[] = [
  { id: 'vendors', label: 'Vendors' },
  { id: 'fissures', label: 'Fissures' },
  { id: 'activities', label: 'Activities' },
  { id: 'progression', label: 'Nightwave & Steel Path' },
  { id: 'events-news', label: 'Events & News' },
];

export function EventsPage() {
  const eventsSubTab = useAppStore((s) => s.eventsSubTab);
  const setEventsSubTab = useAppStore((s) => s.setEventsSubTab);

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Events</span>
          {TABS.map((tab) => (
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
        {/* Always-visible world clock — the open-world cycles people check constantly. */}
        <WorldClockPanel />

        {eventsSubTab === 'vendors' && (
          <div className="events-stack">
            <VoidTraderPanel />
            <VaultTraderPanel />
          </div>
        )}
        {eventsSubTab === 'fissures' && <FissuresPanel />}
        {eventsSubTab === 'activities' && <ActivitiesPanel />}
        {eventsSubTab === 'progression' && (
          <div className="events-stack">
            <NightwavePanel />
            <SteelPathPanel />
          </div>
        )}
        {eventsSubTab === 'events-news' && (
          <div className="events-stack">
            <ActiveEventsPanel />
            <MarketNewsPanel />
          </div>
        )}
      </div>
    </>
  );
}
