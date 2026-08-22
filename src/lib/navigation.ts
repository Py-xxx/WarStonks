import type { TranslationKey } from '../i18n/en';
import type { PageId } from '../types';

/**
 * The app's navigation model — every page and every sub-view, in one place.
 *
 * This exists because sub-tabs moved out of the pages and into the sidebar. Previously each page
 * owned its own tab list, and four of them (Opportunities, Inventory, Scanners, Portfolio) held
 * the selection in component `useState`, which the sidebar cannot read or drive. Rebuilding that
 * list a second time inside the sidebar would guarantee the two drift — the same failure the
 * opportunity tone map had, where Home and the board disagreed about what a colour meant.
 *
 * So the list lives here, the store holds the selection, and both the sidebar and the pages read
 * from these definitions.
 */

/** Sub-view ids, per page. Kept as string unions so the store slices stay exhaustive. */
export type OpportunitiesSubTab = 'opportunities' | 'farm-now';
export type InventorySubTab =
  | 'set-planner'
  | 'prime-parts'
  | 'mods'
  | 'arcanes'
  | 'inventory'
  | 'owned-relics';
export type ScannersSubTab = 'arbitrage' | 'relic-roi';
export type PortfolioSubTab = 'pnl' | 'log';

export interface NavSubItem {
  id: string;
  labelKey: TranslationKey;
  /** Renders the small BETA marker the shipped subnav used. */
  beta?: boolean;
}

/**
 * Sub-items per page.
 *
 * `inventory` is a function rather than a list because its shape genuinely depends on runtime
 * state: Parts / Mods / Arcanes only exist when AlecaFrame is connected, and without it the page
 * offers a single generic Inventory view instead. The sidebar therefore changes shape with the
 * connection — deliberately, not as a glitch.
 */
export const NAV_SUB_ITEMS: Partial<Record<PageId, NavSubItem[]>> = {
  market: [
    { id: 'analysis', labelKey: 'market.tab.analysis' },
    { id: 'analytics', labelKey: 'market.tab.analytics' },
  ],
  events: [
    { id: 'vendors', labelKey: 'events.tab.vendors' },
    { id: 'fissures', labelKey: 'events.tab.fissures' },
    { id: 'activities', labelKey: 'events.tab.activities' },
    { id: 'progression', labelKey: 'events.tab.progression' },
    { id: 'events-news', labelKey: 'events.tab.eventsNews' },
  ],
  scanners: [
    { id: 'arbitrage', labelKey: 'scan.arbitrage' },
    { id: 'relic-roi', labelKey: 'scan.tab.relicRoi' },
  ],
  opportunities: [
    // Renamed from "Opportunities": a sub-item repeating its parent's name reads as a mistake
    // once it is nested directly underneath it in the sidebar.
    { id: 'opportunities', labelKey: 'opp.tabOverview', beta: true },
    { id: 'farm-now', labelKey: 'opp.tabWhatToFarmNow' },
  ],
  trades: [
    { id: 'orders', labelKey: 'trades.tab.orders' },
    { id: 'health', labelKey: 'trades.tab.health' },
    { id: 'detection', labelKey: 'det.tab' },
  ],
  portfolio: [
    { id: 'pnl', labelKey: 'pf.pnlSummary' },
    { id: 'log', labelKey: 'pf.tradeLog' },
  ],
};

/**
 * Inventory's sub-items, which depend on whether AlecaFrame is connected.
 *
 * **Owned Relics is AlecaFrame-only.** Relic counts per refinement exist nowhere else — there is no
 * manual entry for them and no WFM source — so without AlecaFrame the tab had nothing to show. It
 * used to render a legacy view whose own copy told you to check a "public link in Settings", from
 * the retired API era; that view is deleted rather than kept as an empty shell.
 *
 * The AlecaFrame group is therefore the three item tabs **plus relics**, and the manual inventory
 * is the whole of the alternative.
 */
export function inventorySubItems(alecaframeAvailable: boolean): NavSubItem[] {
  return [
    { id: 'set-planner', labelKey: 'opp.tabSetCompletionPlanner' },
    ...(alecaframeAvailable
      ? [
          { id: 'prime-parts', labelKey: 'inv.tabPrimeParts' as TranslationKey },
          { id: 'mods', labelKey: 'inv.tabMods' as TranslationKey },
          { id: 'arcanes', labelKey: 'inv.tabArcanes' as TranslationKey },
          { id: 'owned-relics', labelKey: 'opp.tabOwnedRelics' as TranslationKey },
        ]
      : [{ id: 'inventory', labelKey: 'opp.tabInventory' as TranslationKey }]),
  ];
}

/** All sub-items for a page, resolved against runtime state. Empty when the page has none. */
export function subItemsFor(page: PageId, alecaframeAvailable: boolean): NavSubItem[] {
  if (page === 'inventory') {
    return inventorySubItems(alecaframeAvailable);
  }
  return NAV_SUB_ITEMS[page] ?? [];
}
