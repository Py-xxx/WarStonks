/**
 * Events — worldstate, in six views.
 *
 * **One refresh, not eleven.** Every panel used to carry its own Refresh link and its own "last
 * synced" line: two rows of chrome per panel, on a page that is eleven panels deep. They all hit
 * warframestat.us and they are all stale at the same moment, so refreshing them individually was
 * never the useful control. It lives here now, and a panel only surfaces its own retry when it has
 * an error — the one case where the per-panel control was right.
 *
 * See `.claude/design/events-inventory.md` for the functional inventory this preserves.
 */
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ActivitiesPanel } from '../../components/ActivitiesPanel';
import { EventsOverview } from '../../components/EventsOverview';
import { FissuresPanel } from '../../components/FissuresPanel';
import { FlashSalesPanel } from '../../components/FlashSalesPanel';
import { MarketNewsPanel } from '../../components/MarketNewsPanel';
import { NightwavePanel } from '../../components/NightwavePanel';
import { PageHeading } from '../../components/PageHeading';
import { SteelPathPanel } from '../../components/SteelPathPanel';
import { VaultTraderPanel } from '../../components/VaultTraderPanel';
import { VoidTraderPanel } from '../../components/VoidTraderPanel';
import { WorldClockPanel } from '../../components/WorldClockPanel';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';

export function EventsPage() {
  const eventsSubTab = useAppStore((s) => s.eventsSubTab);
  const setEventsSubTab = useAppStore((s) => s.setEventsSubTab);
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);

  const store = useAppStore;

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const state = store.getState();
      // Settled, not `all`: one dead endpoint must not stop the other ten from updating, and each
      // panel already renders its own error from the store.
      await Promise.allSettled([
        state.refreshWorldStateEvents(),
        state.refreshWorldStateAlerts(),
        state.refreshWorldStateSortie(),
        state.refreshWorldStateArchonHunt(),
        state.refreshWorldStateFissures(),
        state.refreshWorldStateInvasions(),
        state.refreshWorldStateVoidTrader(),
        state.refreshWorldStateMarketNews(),
        state.refreshWorldStateExtra('cycles'),
        state.refreshWorldStateExtra('nightwave'),
        state.refreshWorldStateExtra('steel-path'),
        state.refreshWorldStateExtra('vault-trader'),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <PageHeading
        page="events"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => void refreshAll()}
          >
            <i className="ti ti-refresh" aria-hidden="true" />
            {refreshing ? t('common.refreshing') : t('common.refresh')}
          </Button>
        }
      />

      {/* `[&>*]:shrink-0` is load-bearing, not tidiness. `.page-content` is `flex: 1` with
          `overflow-y: auto`, and adding `flex flex-col` makes every child a flex item with the
          default `flex-shrink: 1` — so when the content is taller than the viewport, the browser
          SQUASHES the short children instead of scrolling. That is what made the world clock
          vanish in Normal fissures (14 of them, page overflows) and come back on Steel Path
          (fewer, page fits). Overflow only becomes real once the children refuse to shrink. */}
      <div className="page-content flex flex-col gap-3 [&>*]:shrink-0">
        {/* The open-world cycles, above every view — they are checked constantly and belong to no
            single tab. */}
        <WorldClockPanel />

        {eventsSubTab === 'overview' && <EventsOverview onNavigate={setEventsSubTab} />}

        {/* The Fissures tab renders the same component the overview does. One panel, two entry
            points — never two implementations. */}
        {eventsSubTab === 'fissures' && <FissuresPanel />}

        {eventsSubTab === 'vendors' && (
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
            <VoidTraderPanel />
            <VaultTraderPanel />
          </div>
        )}

        {eventsSubTab === 'activities' && <ActivitiesPanel />}

        {eventsSubTab === 'progression' && (
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
            <NightwavePanel />
            <SteelPathPanel />
          </div>
        )}

        {/* News and flash sales, side by side and nothing else.
            Active events used to be duplicated here from the overview, and flash sales rendered
            TWICE — once inside the legacy `MarketNewsPanel` and again in the panel beside it.
            `MarketNewsPanel` is news only now; `FlashSalesPanel` is the single renderer. */}
        {eventsSubTab === 'events-news' && (
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <MarketNewsPanel />
            <FlashSalesPanel />
          </div>
        )}
      </div>
    </>
  );
}
