import { useAppStore } from '../../stores/useAppStore';
import { PageHeading } from '../../components/PageHeading';
import { ActiveEventsPanel } from '../../components/ActiveEventsPanel';
import { ActivitiesPanel } from '../../components/ActivitiesPanel';
import { FissuresPanel } from '../../components/FissuresPanel';
import { MarketNewsPanel } from '../../components/MarketNewsPanel';
import { VoidTraderPanel } from '../../components/VoidTraderPanel';
import { VaultTraderPanel } from '../../components/VaultTraderPanel';
import { NightwavePanel } from '../../components/NightwavePanel';
import { SteelPathPanel } from '../../components/SteelPathPanel';
import { WorldClockPanel } from '../../components/WorldClockPanel';

export function EventsPage() {
  const eventsSubTab = useAppStore((s) => s.eventsSubTab);
  return (
    <>
      <PageHeading page="events" />

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
