/**
 * tauriClient.ts — typed wrapper around Tauri commands.
 * All functions are stubs when running in a browser (non-Tauri) context.
 */

import type {
  ArbitrageScannerProgress,
  ArbitrageScannerState,
  AlecaframeSettingsInput,
  AlecaframeValidationResult,
  DiscordWebhookSettingsInput,
  DiscordWatchlistNotificationInput,
  ArbitrageScannerResponse,
  AnalyticsBucketSizeKey,
  AnalyticsDomainKey,
  AppSettings,
  AlecaframeTradeMigrationInput,
  ItemAnalysisResponse,
  ItemAnalyticsResponse,
  ItemDetailSummary,
  MarketSnapshot,
  MarketTrackingSource,
  MarketVariant,
  TradeCreateListingInput,
  PortfolioPnlSummary,
  TradeOverview,
  PortfolioTradeLogState,
  TradeGroupAllocationInput,
  TradeDetectionRefreshResult,
  TradeDetectionRefreshInput,
  TradeSetMapSummary,
  TradeSessionState,
  TradeSignInInput,
  TradeUpdateListingInput,
  SetCompletionOwnedItem,
  PersistedWorldStateCacheEntry,
  SellerMode,
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

export async function openExternalUrl(url: string): Promise<void> {
  return invoke<void>('open_external_url', { url });
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

export async function saveDiscordWebhookSettings(
  input: DiscordWebhookSettingsInput,
): Promise<AppSettings> {
  return invoke<AppSettings>('save_discord_webhook_settings', { input });
}

export async function sendWatchlistFoundDiscordNotification(
  input: DiscordWatchlistNotificationInput,
): Promise<boolean> {
  return invoke<boolean>('send_watchlist_found_discord_notification', { input });
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

export async function getWfmTradeSessionState(): Promise<TradeSessionState> {
  return invoke<TradeSessionState>('get_wfm_trade_session_state');
}

export async function signInWfmTradeAccount(
  input: TradeSignInInput,
): Promise<TradeSessionState> {
  return invoke<TradeSessionState>('sign_in_wfm_trade_account', { input });
}

export async function signOutWfmTradeAccount(): Promise<void> {
  return invoke<void>('sign_out_wfm_trade_account');
}

export async function getWfmTradeOverview(
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('get_wfm_trade_overview', { sellerMode });
}

export async function getWfmProfileTradeLog(
  username: string,
): Promise<PortfolioTradeLogState> {
  return invoke<PortfolioTradeLogState>('get_wfm_profile_trade_log', { username });
}

export async function refreshWfmTradeDetection(
  username: string,
  input: TradeDetectionRefreshInput,
): Promise<TradeDetectionRefreshResult> {
  return invoke<TradeDetectionRefreshResult>('refresh_wfm_trade_detection', { username, input });
}

export async function refreshAlecaframeTradeDetection(
  username: string,
  input: TradeDetectionRefreshInput,
): Promise<TradeDetectionRefreshResult> {
  return invoke<TradeDetectionRefreshResult>('refresh_alecaframe_trade_detection', { username, input });
}

export async function getCachedWfmProfileTradeLog(
  username: string,
): Promise<PortfolioTradeLogState> {
  return invoke<PortfolioTradeLogState>('get_cached_wfm_profile_trade_log', { username });
}

export async function getPortfolioPnlSummary(
  username: string,
  period: '7d' | '30d' | 'all',
): Promise<PortfolioPnlSummary> {
  return invoke<PortfolioPnlSummary>('get_portfolio_pnl_summary', { username, period });
}

export async function setWfmTradeLogKeepItem(
  username: string,
  orderId: string,
  keepItem: boolean,
): Promise<PortfolioTradeLogState> {
  return invoke<PortfolioTradeLogState>('set_wfm_trade_log_keep_item', {
    username,
    orderId,
    keepItem,
  });
}

export async function migrateAlecaframeTradeLog(
  username: string,
  input: AlecaframeTradeMigrationInput,
): Promise<PortfolioTradeLogState> {
  return invoke<PortfolioTradeLogState>('migrate_alecaframe_trade_log', {
    username,
    input,
  });
}

export async function updateTradeGroupAllocations(
  username: string,
  groupId: string,
  allocations: TradeGroupAllocationInput[],
): Promise<PortfolioTradeLogState> {
  return invoke<PortfolioTradeLogState>('update_trade_group_allocations', {
    username,
    groupId,
    allocations,
  });
}

export async function forceWfmTradeLogResync(
  username: string,
): Promise<PortfolioTradeLogState> {
  return invoke<PortfolioTradeLogState>('force_wfm_trade_log_resync', { username });
}

export async function ensureTradeSetMap(
  apiVersion: string | null,
): Promise<TradeSetMapSummary> {
  return invoke<TradeSetMapSummary>('ensure_trade_set_map', {
    apiVersion,
  });
}

export async function createWfmSellOrder(
  input: TradeCreateListingInput,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('create_wfm_sell_order', { input, sellerMode });
}

export async function createWfmBuyOrder(
  input: TradeCreateListingInput,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('create_wfm_buy_order', { input, sellerMode });
}

export async function updateWfmSellOrder(
  input: TradeUpdateListingInput,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('update_wfm_sell_order', { input, sellerMode });
}

export async function closeWfmSellOrder(
  orderId: string,
  quantity: number,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('close_wfm_sell_order', {
    orderId,
    quantity,
    sellerMode,
  });
}

export async function deleteWfmSellOrder(
  orderId: string,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('delete_wfm_sell_order', { orderId, sellerMode });
}

export async function getWfmTopSellOrders(
  slug: string,
  sellerMode: SellerMode,
): Promise<WfmTopSellOrdersResponse> {
  return invoke<WfmTopSellOrdersResponse>('get_wfm_top_sell_orders', { slug, sellerMode });
}

export async function getWfmTopSellOrdersForVariant(
  slug: string,
  variantKey: string | null,
  sellerMode: SellerMode,
): Promise<WfmTopSellOrdersResponse> {
  return invoke<WfmTopSellOrdersResponse>('get_wfm_top_sell_orders', {
    slug,
    variantKey,
    sellerMode,
  });
}

export async function getWfmItemOrders(
  slug: string,
  variantKey: string | null,
  sellerMode: SellerMode,
): Promise<WfmItemOrdersResponse> {
  return invoke<WfmItemOrdersResponse>('get_wfm_item_orders', {
    slug,
    variantKey,
    sellerMode,
  });
}

export async function ensureMarketTracking(
  itemId: number,
  slug: string,
  variantKey: string | null,
  sellerMode: SellerMode,
  source: MarketTrackingSource,
): Promise<MarketSnapshot> {
  return invoke<MarketSnapshot>('ensure_market_tracking', {
    itemId,
    slug,
    variantKey,
    sellerMode,
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

export async function refreshMarketTracking(
  sellerMode: SellerMode,
): Promise<TrackingRefreshSummary> {
  return invoke<TrackingRefreshSummary>('refresh_market_tracking', { sellerMode });
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
  sellerMode: SellerMode,
  domainKey: AnalyticsDomainKey,
  bucketSizeKey: AnalyticsBucketSizeKey,
): Promise<ItemAnalyticsResponse> {
  return invoke<ItemAnalyticsResponse>('get_item_analytics', {
    itemId,
    slug,
    variantKey,
    sellerMode,
    domainKey,
    bucketSizeKey,
  });
}

export async function getItemDetailSummary(
  itemId: number,
  slug: string,
): Promise<ItemDetailSummary> {
  return invoke<ItemDetailSummary>('get_item_detail_summary', {
    itemId,
    slug,
  });
}

export async function getItemAnalysis(
  itemId: number,
  slug: string,
  variantKey: string | null,
  sellerMode: SellerMode,
): Promise<ItemAnalysisResponse> {
  return invoke<ItemAnalysisResponse>('get_item_analysis', {
    itemId,
    slug,
    variantKey,
    sellerMode,
  });
}

export async function getArbitrageScanner(): Promise<ArbitrageScannerResponse> {
  return invoke<ArbitrageScannerResponse>('get_arbitrage_scanner');
}

export async function getArbitrageScannerState(): Promise<ArbitrageScannerState> {
  return invoke<ArbitrageScannerState>('get_arbitrage_scanner_state');
}

export async function getSetCompletionOwnedItems(): Promise<SetCompletionOwnedItem[]> {
  return invoke<SetCompletionOwnedItem[]>('get_set_completion_owned_items');
}

export async function setSetCompletionOwnedItemQuantity(input: {
  itemId: number | null;
  slug: string;
  name: string;
  imagePath: string | null;
  quantity: number;
}): Promise<SetCompletionOwnedItem[]> {
  return invoke<SetCompletionOwnedItem[]>('set_set_completion_owned_item_quantity', {
    itemId: input.itemId,
    slug: input.slug,
    name: input.name,
    imagePath: input.imagePath,
    quantity: input.quantity,
  });
}

export async function startArbitrageScanner(): Promise<boolean> {
  return invoke<boolean>('start_arbitrage_scanner');
}

export async function stopArbitrageScanner(): Promise<boolean> {
  return invoke<boolean>('stop_arbitrage_scanner');
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

export async function listenToArbitrageScannerProgress(
  onProgress: (progress: ArbitrageScannerProgress) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  return listen<ArbitrageScannerProgress>('arbitrage-scanner-progress', (event) => {
    onProgress(event.payload);
  });
}

// Future commands — add typed stubs here as the backend grows:
// export async function fetchMarketData(itemId: string): Promise<MarketData> { ... }
// export async function syncTradeOrders(): Promise<TradeOrder[]> { ... }
