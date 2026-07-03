import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
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

const TABS: { id: EventsSubTab; labelKey: TranslationKey }[] = [
  { id: 'vendors', labelKey: 'events.tab.vendors' },
  { id: 'fissures', labelKey: 'events.tab.fissures' },
  { id: 'activities', labelKey: 'events.tab.activities' },
  { id: 'progression', labelKey: 'events.tab.progression' },
  { id: 'events-news', labelKey: 'events.tab.eventsNews' },
];

export function EventsPage() {
  const eventsSubTab = useAppStore((s) => s.eventsSubTab);
  const setEventsSubTab = useAppStore((s) => s.setEventsSubTab);
  const { t } = useTranslation();

  return (
    <>
      <div className="subnav events-page-subnav">
        <div className="subnav-left">
          <span className="page-title">{t('events.title')}</span>
          {TABS.map((tab) => (
            <span
              key={tab.id}
              className={`subtab${eventsSubTab === tab.id ? ' active' : ''}`}
              onClick={() => setEventsSubTab(tab.id)}
              role="tab"
              tabIndex={0}
            >
              {t(tab.labelKey)}
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
