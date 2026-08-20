import { subItemsFor, type NavSubItem } from '../lib/navigation';
import { selectAlecaframeInventoryAvailable, useAppStore } from '../stores/useAppStore';
import type { PageId } from '../types';

/**
 * One accessor for "which sub-view is a page showing, and how do I change it".
 *
 * Each page keeps its own store key (`tradesSubTab`, `inventorySubTab`, …) because the ids are
 * different unions and collapsing them into one loose `string` would lose that. This hook is the
 * seam that lets the sidebar treat them uniformly anyway, so adding a page's sub-nav means adding
 * a row here and a row in `lib/navigation.ts` — not touching the sidebar.
 */
export function useSubNav(page: PageId): {
  items: NavSubItem[];
  active: string | null;
  select: (id: string) => void;
} {
  const store = useAppStore();
  const alecaframeAvailable = selectAlecaframeInventoryAvailable(store);

  const items = subItemsFor(page, alecaframeAvailable);

  switch (page) {
    case 'market':
      return {
        items,
        active: store.marketSubTab,
        select: (id) => store.setMarketSubTab(id as 'analysis' | 'analytics'),
      };
    case 'events':
      return { items, active: store.eventsSubTab, select: (id) => store.setEventsSubTab(id as never) };
    case 'scanners':
      return {
        items,
        active: store.scannersSubTab,
        select: (id) => store.setScannersSubTab(id as never),
      };
    case 'opportunities':
      return {
        items,
        active: store.opportunitiesSubTab,
        select: (id) => store.setOpportunitiesSubTab(id as never),
      };
    case 'inventory':
      return {
        items,
        active: store.inventorySubTab,
        select: (id) => store.setInventorySubTab(id as never),
      };
    case 'trades':
      return { items, active: store.tradesSubTab, select: (id) => store.setTradesSubTab(id as never) };
    case 'portfolio':
      return {
        items,
        active: store.portfolioSubTab,
        select: (id) => store.setPortfolioSubTab(id as never),
      };
    default:
      return { items: [], active: null, select: () => {} };
  }
}
