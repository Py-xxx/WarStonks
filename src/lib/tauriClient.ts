/**
 * tauriClient.ts — typed wrapper around Tauri commands.
 * All functions are stubs when running in a browser (non-Tauri) context.
 */

import type {
  AlecaframeSettingsInput,
  AlecaframeValidationResult,
  AnalyticsBucketSizeKey,
  AnalyticsDomainKey,
  AppSettings,
  ItemAnalyticsResponse,
  MarketSnapshot,
  MarketTrackingSource,
  MarketVariant,
  PersistedWorldStateCacheEntry,
  WfmDetailedOrder,
  WfstatFlashSale,
  WfstatNewsItem,
  WfstatArchonHunt,
  WfstatArbitration,
  WfstatAlert,
  WfstatInvasion,
  WfstatSortie,
  WfstatSyndicateMission,
  RelicTierIcon,
  WalletSnapshot,
  WfstatVoidTrader,
  WfmAutocompleteItem,
  WfmTopSellOrder,
} from '../types';

// Check if running inside Tauri
export const isTauriRuntime = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke<T>(cmd, args);
  }
  // Browser fallback — return mock shapes
  console.warn(`[tauriClient] Not in Tauri context, stubbing: ${cmd}`, args);
  throw new Error(`Command ${cmd} not available outside Tauri`);
}

// ── Typed command wrappers ─────────────────────────────────────────────────

export interface AppShellInfo {
  version: string;
  name: string;
  platform: string;
}

export interface StartupProgress {
  stageKey: string;
  stageLabel: string;
  statusText: string;
  progressValue: number;
}

export interface ImportStats {
  totalWfmItems: number;
  totalWfstatItems: number;
  matchedByDirectRef: number;
  matchedByComponentRef: number;
  matchedByMarketSlug: number;
  matchedByMarketId: number;
  matchedByNormalizedName: number;
  matchedByBlueprintDecomposition: number;
  matchedByManualAlias: number;
  unmatchedWfmItems: number;
  wfmOnlyCanonicalItems: number;
  wfstatOnlyCanonicalItems: number;
}

export interface StartupSummary {
  ready: boolean;
  refreshed: boolean;
  databasePath: string;
  dataDir: string;
  wfmSourceFile: string;
  wfstatSourceFile: string | null;
  stats: ImportStats;
  currentWfmApiVersion: string | null;
}

export interface WfmTopSellOrdersResponse {
  apiVersion: string | null;
  slug: string;
  sellOrders: WfmTopSellOrder[];
}

export interface WfmItemOrdersResponse {
  apiVersion: string | null;
  slug: string;
  variantKey: string;
  sellOrders: WfmDetailedOrder[];
  buyOrders: WfmDetailedOrder[];
  snapshot: MarketSnapshot;
}

export interface TrackingRefreshSummary {
  refreshedItems: number;
  dueItems: number;
}

export interface WorldStateMarketNewsResponse {
  news: WfstatNewsItem[];
  flashSales: WfstatFlashSale[];
}

let startupInitializationPromise: Promise<StartupSummary> | null = null;

export async function getAppShellInfo(): Promise<AppShellInfo> {
  return invoke<AppShellInfo>('get_app_shell_info');
}

export async function getAppVersion(): Promise<string> {
  return invoke<string>('get_app_version');
}

export async function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('get_app_settings');
}

export async function testAlecaframePublicLink(
  publicLink: string,
): Promise<AlecaframeValidationResult> {
  return invoke<AlecaframeValidationResult>('test_alecaframe_public_link', {
    publicLink,
  });
}

export async function saveAlecaframeSettings(
  input: AlecaframeSettingsInput,
): Promise<AppSettings> {
  return invoke<AppSettings>('save_alecaframe_settings', { input });
}

export async function getCurrencyBalances(): Promise<WalletSnapshot> {
  return invoke<WalletSnapshot>('get_currency_balances');
}

export async function getWorldStateEvents(): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>('get_worldstate_events');
}

export async function getWorldStateAlerts(): Promise<WfstatAlert[]> {
  return invoke<WfstatAlert[]>('get_worldstate_alerts');
}

export async function getWorldStateSortie(): Promise<WfstatSortie> {
  return invoke<WfstatSortie>('get_worldstate_sortie');
}

export async function getWorldStateArbitration(): Promise<WfstatArbitration> {
  return invoke<WfstatArbitration>('get_worldstate_arbitration');
}

export async function getWorldStateArchonHunt(): Promise<WfstatArchonHunt> {
  return invoke<WfstatArchonHunt>('get_worldstate_archon_hunt');
}

export async function getWorldStateFissures(): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>('get_worldstate_fissures');
}

export async function getWorldStateInvasions(): Promise<WfstatInvasion[]> {
  return invoke<WfstatInvasion[]>('get_worldstate_invasions');
}

export async function getWorldStateSyndicateMissions(): Promise<WfstatSyndicateMission[]> {
  return invoke<WfstatSyndicateMission[]>('get_worldstate_syndicate_missions');
}

export async function getWorldStateVoidTrader(): Promise<WfstatVoidTrader> {
  return invoke<WfstatVoidTrader>('get_worldstate_void_trader');
}

export async function getWorldStateMarketNews(): Promise<WorldStateMarketNewsResponse> {
  return invoke<WorldStateMarketNewsResponse>('get_worldstate_market_news');
}

export async function getWorldStateCache(): Promise<
  Record<string, PersistedWorldStateCacheEntry>
> {
  return invoke<Record<string, PersistedWorldStateCacheEntry>>('get_worldstate_cache');
}

export async function saveWorldStateCacheEntry(
  endpoint: string,
  entry: PersistedWorldStateCacheEntry,
): Promise<void> {
  return invoke<void>('save_worldstate_cache_entry', { endpoint, entry });
}

export async function getRelicTierIcons(): Promise<RelicTierIcon[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  return invoke<RelicTierIcon[]>('get_relic_tier_icons');
}

export async function getWfmAutocompleteItems(): Promise<WfmAutocompleteItem[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  return invoke<WfmAutocompleteItem[]>('get_wfm_autocomplete_items');
}

export async function getWfmTopSellOrders(slug: string): Promise<WfmTopSellOrdersResponse> {
  return invoke<WfmTopSellOrdersResponse>('get_wfm_top_sell_orders', { slug });
}

export async function getWfmTopSellOrdersForVariant(
  slug: string,
  variantKey: string | null,
): Promise<WfmTopSellOrdersResponse> {
  return invoke<WfmTopSellOrdersResponse>('get_wfm_top_sell_orders', {
    slug,
    variantKey,
  });
}

export async function getWfmItemOrders(
  slug: string,
  variantKey: string | null,
): Promise<WfmItemOrdersResponse> {
  return invoke<WfmItemOrdersResponse>('get_wfm_item_orders', {
    slug,
    variantKey,
  });
}

export async function ensureMarketTracking(
  itemId: number,
  slug: string,
  variantKey: string | null,
  source: MarketTrackingSource,
): Promise<MarketSnapshot> {
  return invoke<MarketSnapshot>('ensure_market_tracking', {
    itemId,
    slug,
    variantKey,
    source,
  });
}

export async function stopMarketTracking(
  itemId: number,
  slug: string,
  variantKey: string | null,
  source: MarketTrackingSource,
): Promise<void> {
  return invoke<void>('stop_market_tracking', {
    itemId,
    slug,
    variantKey,
    source,
  });
}

export async function refreshMarketTracking(): Promise<TrackingRefreshSummary> {
  return invoke<TrackingRefreshSummary>('refresh_market_tracking');
}

export async function getItemVariantsForMarket(
  itemId: number,
  slug: string,
): Promise<MarketVariant[]> {
  return invoke<MarketVariant[]>('get_item_variants_for_market', {
    itemId,
    slug,
  });
}

export async function getItemAnalytics(
  itemId: number,
  slug: string,
  variantKey: string | null,
  domainKey: AnalyticsDomainKey,
  bucketSizeKey: AnalyticsBucketSizeKey,
): Promise<ItemAnalyticsResponse> {
  return invoke<ItemAnalyticsResponse>('get_item_analytics', {
    itemId,
    slug,
    variantKey,
    domainKey,
    bucketSizeKey,
  });
}

export async function initializeAppCatalog(): Promise<StartupSummary> {
  return invoke<StartupSummary>('initialize_app_catalog');
}

export function initializeAppCatalogOnce(): Promise<StartupSummary> {
  if (!startupInitializationPromise) {
    startupInitializationPromise = initializeAppCatalog().catch((error) => {
      startupInitializationPromise = null;
      throw error;
    });
  }

  return startupInitializationPromise;
}

export async function listenToStartupProgress(
  onProgress: (progress: StartupProgress) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  return listen<StartupProgress>('startup-progress', (event) => {
    onProgress(event.payload);
  });
}

// Future commands — add typed stubs here as the backend grows:
// export async function fetchMarketData(itemId: string): Promise<MarketData> { ... }
// export async function syncTradeOrders(): Promise<TradeOrder[]> { ... }
