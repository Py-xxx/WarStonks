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
  DiscordUnderpricedNotificationInput,
  ArbitrageScannerResponse,
  AnalyticsBucketSizeKey,
  AnalyticsDomainKey,
  AppSettings,
  StrategySettings,
  AlecaframeTradeMigrationInput,
  ItemAnalysisResponse,
  ItemAnalyticsResponse,
  ItemDetailSummary,
  MarketSnapshot,
  MarketTrackingSource,
  MarketVariant,
  TradeCreateListingInput,
  TradeListingHealth,
  PortfolioPnlSummary,
  SetCompletionInventoryValue,
  SetCompletionOwnedItemValue,
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
  OwnedRelicInventoryCache,
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
  BacktestSummary,
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
  /** True when the catalog is serving last-known WFStat data because WFStat could not be
   * refreshed. The app works, but drop/vault enrichment may be out of date until WFStat
   * is reachable again. */
  wfstatStale: boolean;
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

export async function saveStrategySettings(
  input: StrategySettings,
): Promise<AppSettings> {
  return invoke<AppSettings>('save_strategy_settings', { input });
}

export async function sendWatchlistFoundDiscordNotification(
  input: DiscordWatchlistNotificationInput,
): Promise<boolean> {
  return invoke<boolean>('send_watchlist_found_discord_notification', { input });
}

export async function sendUnderpricedListingDiscordNotification(
  input: DiscordUnderpricedNotificationInput,
): Promise<boolean> {
  return invoke<boolean>('send_underpriced_listing_discord_notification', { input });
}

export async function getCurrencyBalances(): Promise<WalletSnapshot> {
  return invoke<WalletSnapshot>('get_currency_balances');
}

export async function refreshAlecaframeWalletSnapshot(): Promise<WalletSnapshot> {
  return invoke<WalletSnapshot>('refresh_alecaframe_wallet_snapshot');
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

export interface VoidTraderItemPrice {
  item: string;
  recommendedExitPrice: number | null;
}

export async function scanVoidTraderPrices(items: string[]): Promise<VoidTraderItemPrice[]> {
  return invoke<VoidTraderItemPrice[]>('scan_void_trader_prices', { items });
}

export async function getWorldStateMarketNews(): Promise<WorldStateMarketNewsResponse> {
  return invoke<WorldStateMarketNewsResponse>('get_worldstate_market_news');
}

// Reference worldstate sources (Events overhaul) — returned as raw JSON; the panels parse them.
export async function getWorldStateCycles(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('get_worldstate_cycles');
}

export async function getWorldStateSteelPath(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('get_worldstate_steel_path');
}

export async function getWorldStateNightwave(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('get_worldstate_nightwave');
}

export async function getWorldStateVaultTrader(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('get_worldstate_vault_trader');
}

export async function getWorldStateCache(): Promise<
  Record<string, PersistedWorldStateCacheEntry>
> {
  return invoke<Record<string, PersistedWorldStateCacheEntry>>('get_worldstate_cache');
}

/** Sets the language warframestat.us worldstate fetches use (wfstat code, e.g. "zh"). */
export async function setWorldstateLanguage(language: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke('set_worldstate_language', { language });
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

export async function getWfmAutocompleteItems(
  language?: string,
): Promise<WfmAutocompleteItem[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  return invoke<WfmAutocompleteItem[]>('get_wfm_autocomplete_items', { language });
}

export interface LanguagePackStatus {
  langCode: string;
  populated: boolean;
  itemCount: number;
  builtVersion: string | null;
  currentVersion: string | null;
  wfstatReachable: boolean;
  upToDate: boolean;
}

export interface LanguagePackImportResult {
  langCode: string;
  itemCount: number;
}

/** Downloads + installs localized item names for a language from WFStat. Throws if WFStat is unreachable. */
export async function populateLanguageItemNames(language: string): Promise<LanguagePackImportResult> {
  if (!isTauriRuntime()) {
    return { langCode: language, itemCount: 0 };
  }
  return invoke<LanguagePackImportResult>('populate_language_item_names', { language });
}

export async function getLanguagePackStatus(language: string): Promise<LanguagePackStatus | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  return invoke<LanguagePackStatus>('get_language_pack_status', { language });
}

/** Returns the pack JSON string (guarded backend-side); throws with a LANGPACK_* code on failure. */
export async function exportLanguagePack(language: string): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error('LANGPACK_OFFLINE');
  }
  return invoke<string>('export_language_pack', { language });
}

export async function importLanguagePack(pack: string): Promise<LanguagePackImportResult> {
  if (!isTauriRuntime()) {
    throw new Error('LANGPACK_BADFORMAT');
  }
  return invoke<LanguagePackImportResult>('import_language_pack', { pack });
}

export async function getWfmTradeSessionState(): Promise<TradeSessionState> {
  return invoke<TradeSessionState>('get_wfm_trade_session_state');
}

export async function signInWfmTradeAccount(
  input: TradeSignInInput,
): Promise<TradeSessionState> {
  return invoke<TradeSessionState>('sign_in_wfm_trade_account', { input });
}

export async function tryAutoSignInWfmTradeAccount(): Promise<TradeSessionState> {
  return invoke<TradeSessionState>('try_auto_sign_in_wfm_trade_account');
}

export async function signOutWfmTradeAccount(): Promise<void> {
  return invoke<void>('sign_out_wfm_trade_account');
}

export async function setWfmTradeStatus(
  status: 'ingame' | 'online' | 'invisible',
): Promise<TradeSessionState> {
  return invoke<TradeSessionState>('set_wfm_trade_status', { status });
}

export async function getWfmTradeOverview(
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('get_wfm_trade_overview', { sellerMode });
}

// ---- Import / Export (.baddie) ----
export async function exportUserDataPayload(): Promise<string> {
  return invoke<string>('export_user_data');
}
export async function exportMarketDataPayload(): Promise<string> {
  return invoke<string>('export_market_data');
}
export async function importUserDataPayload(payload: string): Promise<void> {
  return invoke<void>('import_user_data', { payload });
}
export async function importMarketDataPayload(payload: string): Promise<void> {
  return invoke<void>('import_market_data', { payload });
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
  period: '7d' | '30d' | '90d' | 'all',
): Promise<PortfolioPnlSummary> {
  return invoke<PortfolioPnlSummary>('get_portfolio_pnl_summary', { username, period });
}

export async function getPortfolioInventoryValue(): Promise<SetCompletionInventoryValue> {
  return invoke<SetCompletionInventoryValue>('get_portfolio_inventory_value');
}

export async function getSetCompletionOwnedItemPrices(): Promise<SetCompletionOwnedItemValue[]> {
  return invoke<SetCompletionOwnedItemValue[]>('get_set_completion_owned_item_prices');
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

export async function updateWfmBuyOrder(
  input: TradeUpdateListingInput,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('update_wfm_buy_order', { input, sellerMode });
}

/**
 * Bulk-toggles visibility of all the user's orders (optionally a single type).
 * Backs the "hide/show all my listings" control. Returns the refreshed overview.
 */
export async function setWfmOrdersVisibility(
  visible: boolean,
  orderType: 'sell' | 'buy' | null,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('set_wfm_orders_visibility', {
    visible,
    orderType,
    sellerMode,
  });
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

export async function closeWfmBuyOrder(
  orderId: string,
  quantity: number,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('close_wfm_buy_order', {
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

export async function deleteWfmBuyOrder(
  orderId: string,
  sellerMode: SellerMode,
): Promise<TradeOverview> {
  return invoke<TradeOverview>('delete_wfm_buy_order', { orderId, sellerMode });
}

export async function getTradeMarketLow(
  slug: string,
  rank: number | null,
  sellerMode: SellerMode,
  priority: 'high' | 'medium' | 'low',
): Promise<number | null> {
  return invoke<number | null>('get_trade_sell_order_market_low', { slug, rank, sellerMode, priority });
}

export async function getTradeSellOrderHealth(
  itemId: number | null,
  slug: string,
  rank: number | null,
  yourPrice: number,
  sellerMode: SellerMode,
  priority: 'high' | 'medium' | 'low',
): Promise<TradeListingHealth> {
  return invoke<TradeListingHealth>('get_trade_sell_order_health', {
    itemId,
    slug,
    rank,
    yourPrice,
    sellerMode,
    priority,
  });
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
  requestPriority?: 'instant' | 'high' | 'medium' | 'low',
  requestSource?: 'watchlist' | 'quick-view' | 'trades' | 'generic',
): Promise<WfmItemOrdersResponse> {
  return invoke<WfmItemOrdersResponse>('get_wfm_item_orders', {
    slug,
    variantKey,
    sellerMode,
    requestPriority,
    requestSource,
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

export async function gradeRecommendationOutcomes(): Promise<number> {
  return invoke<number>('grade_recommendation_outcomes');
}

export async function getBacktestSummary(): Promise<BacktestSummary> {
  return invoke<BacktestSummary>('get_backtest_summary');
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

export async function applySetCompletionScreenshotImportRows(rows: Array<{
  itemId: number | null;
  slug: string;
  name: string;
  imagePath: string | null;
  quantity: number;
}>): Promise<SetCompletionOwnedItem[]> {
  return invoke<SetCompletionOwnedItem[]>('apply_set_completion_screenshot_import_rows', {
    rows,
  });
}

export async function getOwnedRelicInventoryCache(): Promise<OwnedRelicInventoryCache> {
  return invoke<OwnedRelicInventoryCache>('get_owned_relic_inventory_cache');
}

export async function refreshOwnedRelicInventory(): Promise<OwnedRelicInventoryCache> {
  return invoke<OwnedRelicInventoryCache>('refresh_owned_relic_inventory');
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

export async function listenToWfmPresenceChange(
  onPresence: (status: string) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('wfm-presence-changed', (event) => {
    onPresence(event.payload);
  });
}

export interface WatchlistTargetSync {
  watchlistId: string;
  slug: string;
  targetPrice: number;
  rank: number | null;
}

/**
 * Syncs the current watchlist to the backend so the realtime newOrders subscription can
 * match against it. The backend resolves each slug to its WFM item id and (un)subscribes.
 */
export async function setWatchlistTargets(
  targets: WatchlistTargetSync[],
  sellerMode: string,
): Promise<void> {
  return invoke<void>('set_watchlist_targets', { targets, sellerMode });
}

/** Payload pushed by the backend when a tracked item gets a matching sell ≤ target. */
export interface RealtimeWatchlistOrder {
  watchlistId: string;
  itemId: string;
  slug: string;
  orderId: string;
  username: string;
  userSlug: string | null;
  platinum: number;
  quantity: number;
  rank: number | null;
  createdAt: string | null;
}

export async function listenToWatchlistOrders(
  onOrder: (order: RealtimeWatchlistOrder) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  return listen<RealtimeWatchlistOrder>('wfm-watchlist-order', (event) => {
    onOrder(event.payload);
  });
}

/** A live sell listing flagged as underpriced vs its recommended entry price (Opportunities radar). */
export interface UnderpricedListing {
  itemId: string;
  slug: string;
  itemName: string;
  orderId: string;
  username: string;
  userSlug: string | null;
  rank: number | null;
  quantity: number;
  listedPrice: number;
  recommendedPrice: number;
  pctBelow: number;
  tier: 'red' | 'yellow' | 'normal';
  /** Present when this underpriced part finishes a set the user is close to completing. */
  completesSet: {
    setSlug: string;
    setName: string;
    ownedDistinct: number;
    neededDistinct: number;
  } | null;
}

/** A structured reason chip explaining WHY an opportunity is worth acting on. `textKey` is an
 *  i18n key interpolated with `textParams` at render time, so the board renders in any app
 *  language instead of the backend's raw English. */
export interface OpportunityReason {
  icon: 'inventory' | 'market' | 'relics' | 'math' | string;
  textKey: string;
  textParams: Record<string, string>;
  source: string;
}

/** A suggested action on an opportunity card. */
export interface OpportunityAction {
  kind: 'buyPart' | 'sellPart' | 'sellSet' | 'farmRelic' | 'openWfm' | 'copyWhisper' | string;
  labelKey: string;
  labelParams: Record<string, string>;
  itemSlug: string | null;
  itemName: string | null;
  price: number | null;
  /** Seller in-game name, only set for `copyWhisper` (live snipe) actions. */
  username?: string | null;
}

/** A single ranked, explained "what to do now" play on the Opportunities board. */
export interface Opportunity {
  id: string;
  /** Stable key for the underlying subject (a set/holding) — survives the recommendation changing.
   *  Pins track this so a pinned "complete set" auto-becomes "sell set" once you own the parts. */
  subjectKey: string;
  category: 'setCompletion' | 'sellInventory' | string;
  titleKey: string;
  titleParams: Record<string, string>;
  subtitleKey: string | null;
  subtitleParams: Record<string, string>;
  setSlug: string | null;
  imagePath: string | null;
  estValue: number;
  /** Upfront plat needed to act (0 for sell/reprice/farm). Drives the budget filter. */
  cost: number;
  valueBasis: 'profit' | 'liquidation' | 'savings' | 'unlock' | string;
  /** When the prices were last computed (scan time) — for the freshness indicator. */
  pricedAt: string | null;
  confidence: number;
  confidenceLabel: string;
  urgency: 'persistent' | 'expiring' | 'timed' | string;
  reasons: OpportunityReason[];
  actions: OpportunityAction[];
  score: number;
}

/** Computes the current opportunity board (cache-only on the backend; safe to poll). */
export async function getOpportunities(): Promise<Opportunity[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invoke<Opportunity[]>('get_opportunities');
}

/** Returns the last persisted board instantly (no recompute) for stale-while-revalidate paint. */
export async function getCachedOpportunities(): Promise<Opportunity[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invoke<Opportunity[]>('get_cached_opportunities');
}

/** Fires when a board input changes (owned parts, relics, a fresh scan) → time to recompute. */
export async function listenToOpportunitiesStale(onStale: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen('opportunities-stale', () => onStale());
}

export async function listenToUnderpricedListings(
  onListing: (listing: UnderpricedListing) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  return listen<UnderpricedListing>('wfm-underpriced-listing', (event) => {
    onListing(event.payload);
  });
}

export interface RadarStats {
  scannedCount: number;
  trackedItems: number;
}

/** Throughput stats for the underpriced-listings radar — confirms the firehose is flowing. */
export async function getRadarStats(): Promise<RadarStats> {
  if (!isTauriRuntime()) {
    return { scannedCount: 0, trackedItems: 0 };
  }
  return invoke<RadarStats>('get_radar_stats');
}

export interface VerifyMarketListingResult {
  stillListed: boolean;
  currentPrice: number | null;
}

/** Re-checks (instant priority) whether an underpriced listing is still live on Warframe.Market. */
export async function verifyMarketListing(input: {
  orderId: string;
  userSlug: string;
  itemId: string;
  rank: number | null;
  expectedPrice: number;
}): Promise<VerifyMarketListingResult> {
  return invoke<VerifyMarketListingResult>('verify_market_listing', {
    orderId: input.orderId,
    userSlug: input.userSlug,
    itemId: input.itemId,
    rank: input.rank,
    expectedPrice: input.expectedPrice,
  });
}

// Future commands — add typed stubs here as the backend grows:
// export async function fetchMarketData(itemId: string): Promise<MarketData> { ... }
// export async function syncTradeOrders(): Promise<TradeOrder[]> { ... }
