/**
 * tauriClient.ts — typed wrapper around Tauri commands.
 * All functions are stubs when running in a browser (non-Tauri) context.
 */

import { wfmLangCode, type AppLanguage } from './language';
import type {
  ArbitrageScannerProgress,
  ArbitrageScannerState,
  DiscordWebhookSettingsInput,
  DiscordWatchlistNotificationInput,
  DiscordUnderpricedNotificationInput,
  DiscordListingHealthNotificationInput,
  DiscordScannerStaleNotificationInput,
  DiscordAppUpdateNotificationInput,
  AnalyticsBucketSizeKey,
  AnalyticsDomainKey,
  AppSettings,
  SmartManageSettings,
  SmartManageStateEntry,
  SmartManageLogEntry,
  SmartListingOverrides,
  SmartManageImpact,
  ItemAnalysisResponse,
  ItemAnalyticsResponse,
  ItemDetailSummary,
  MarketSnapshot,
  MarketTrackingSource,
  MarketVariant,
  TradeCreateListingInput,
  TradeListingHealth,
  HealthPredictionAccuracy,
  PortfolioPnlSummary,
  SetCompletionInventoryValue,
  SetCompletionOwnedItemValue,
  TradeOverview,
  PortfolioTradeLogState,
  TradeGroupAllocationInput,
  DetectedTradeOutcome,
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
  AlecaframeSettingsInput,
  WalletSnapshot,
  WfstatVoidTrader,
  AlecaframeInventory,
  DiscordPrivateMessageNotificationInput,
  EeLogEvent,
  EeLogTradeEvent,
  ShadowTradeRow,
  TradeComparison,
  LocalSourceAvailability,
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

export async function getAppVersion(): Promise<string> {
  return invoke<string>('get_app_version');
}

export async function openExternalUrl(url: string): Promise<void> {
  return invoke<void>('open_external_url', { url });
}

export async function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('get_app_settings');
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

/**
 * Grants (or revokes) trade detection's permission to close listings on Warframe.Market.
 * Default off — this is the only path where detection writes to WFM.
 */
export async function setAutoCloseListings(enabled: boolean): Promise<AppSettings> {
  return invoke<AppSettings>('set_auto_close_listings', { enabled });
}

export async function saveSmartManageSettings(
  input: SmartManageSettings,
): Promise<AppSettings> {
  return invoke<AppSettings>('save_smart_manage_settings', { input });
}

/** Set/clear a listing's auto-manage opt-in. `enabled = null` clears the override (use default). */
export async function setSmartManageForListing(
  wfmId: string,
  rank: number | null,
  enabled: boolean | null,
): Promise<void> {
  return invoke<void>('set_smart_manage_for_listing', { wfmId, rank, enabled });
}

export async function getSmartManageStates(): Promise<SmartManageStateEntry[]> {
  return invoke<SmartManageStateEntry[]>('get_smart_manage_states');
}

export async function getSmartManageImpact(): Promise<SmartManageImpact> {
  return invoke<SmartManageImpact>('get_smart_manage_impact');
}

export async function setSmartManageOverrides(
  wfmId: string,
  rank: number | null,
  overrides: SmartListingOverrides,
): Promise<void> {
  return invoke<void>('set_smart_manage_overrides', {
    wfmId,
    variantKey: rank === null || rank === undefined ? 'base' : `rank:${rank}`,
    aggressiveness: overrides.aggressiveness,
    minPrice: overrides.minPrice,
    maxPrice: overrides.maxPrice,
  });
}

export async function clearSmartManageFailures(
  wfmId: string,
  variantKey: string,
): Promise<void> {
  return invoke<void>('clear_smart_manage_failures', { wfmId, variantKey });
}

export async function getSmartManageLog(limit?: number): Promise<SmartManageLogEntry[]> {
  return invoke<SmartManageLogEntry[]>('get_smart_manage_log', { limit: limit ?? 50 });
}

/** Subscribe to Smart Manage price changes (and preview intents) for the activity feed + alerts. */
export interface SmartManageChange {
  wfmId: string;
  slug: string;
  oldPrice: number;
  newPrice: number;
  action: string;
  reasonCode: string;
  applied: boolean;
  preview: boolean;
}

export interface TradeDetectedEvent {
  orderType: string;
  totalPlatinum: number;
  summary: string;
  itemName: string | null;
  itemCount: number;
  source: string;
}

export async function subscribeToTradeDetected(
  onDetected: (event: TradeDetectedEvent) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen<TradeDetectedEvent>('wfm-trade-detected', (event) => {
    if (event.payload) {
      onDetected(event.payload);
    }
  });
}

export async function subscribeToSmartManageChanges(
  onChange: (change: SmartManageChange) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen<SmartManageChange>('wfm-smart-manage-change', (event) => {
    if (event.payload) {
      onChange(event.payload);
    }
  });
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

export async function sendListingHealthDiscordNotification(
  input: DiscordListingHealthNotificationInput,
): Promise<boolean> {
  return invoke<boolean>('send_listing_health_discord_notification', { input });
}

export async function sendScannerStaleDiscordNotification(
  input: DiscordScannerStaleNotificationInput,
): Promise<boolean> {
  return invoke<boolean>('send_scanner_stale_discord_notification', { input });
}

export async function sendPrivateMessageDiscordNotification(
  input: DiscordPrivateMessageNotificationInput,
): Promise<boolean> {
  return invoke<boolean>('send_private_message_discord_notification', { input });
}

export async function sendAppUpdateDiscordNotification(
  input: DiscordAppUpdateNotificationInput,
): Promise<boolean> {
  return invoke<boolean>('send_app_update_discord_notification', { input });
}

export async function refreshWalletFromAppdata(): Promise<WalletSnapshot> {
  return invoke<WalletSnapshot>('refresh_wallet_from_appdata');
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

export interface VaultTraderTradeableItem {
  name: string;
  /** "warframe" or "weapon" — which kind of item this is, for grouping the panel by family. */
  family: string;
  /** `null` when the catalog lookup failed (e.g. offline first run) — the item still displays,
   * there's just nothing to link/group/pull an icon from. */
  slug: string | null;
  imagePath: string | null;
  regalAyaCost: number | null;
  /** This item's own slug plus every one of its set components' slugs — every slug whose price
   * is affected by Varzia currently selling this item's relics. */
  affectedSlugs: string[];
}

export interface VaultTraderInfo {
  active: boolean;
  location: string | null;
  activation: string | null;
  expiry: string | null;
  tradeableItems: VaultTraderTradeableItem[];
}

export async function getWorldStateVaultTrader(): Promise<VaultTraderInfo> {
  return invoke<VaultTraderInfo>('get_worldstate_vault_trader');
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

/**
 * Sets the app's own UI language on the Rust side (the raw `src/i18n/*.ts` code, e.g.
 * "zh-hans" — NOT wfstat's own code). Lets Discord notifications fired from a purely
 * backend-triggered flow (trade detection, Smart Manage) localize their text even though there's
 * no frontend round-trip to pre-resolve `tActive()` strings through for those two.
 */
export async function setAppLanguage(language: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke('set_app_language', { language });
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

/**
 * The localized item catalog that powers every search box.
 *
 * Takes the app language, NOT a raw code string, and converts it here. Item names live in
 * `wfm_item_i18n` keyed by Warframe.Market's codes, but the app also has warframestat.us codes
 * for worldstate — and those disagree for Chinese (`zh-hans` vs `zh`). Five call sites passed
 * the warframestat code, the SQL join silently matched nothing, and every Chinese user got an
 * English-only catalog. Accepting `AppLanguage` makes that mistake a compile error instead of
 * a silent fallback.
 */
/**
 * Probes for Warframe's `EE.log` and AlecaFrame's inventory snapshot. Cheap enough to call on
 * every settings render — a user can launch the game or install AlecaFrame while we're open, and
 * a cached answer would go stale silently. Outside Tauri there is no filesystem to probe, so it
 * reports the same shape rather than throwing.
 */
/**
 * Drains events appended to Warframe's `EE.log` since the last call. Returns an empty
 * array when the game isn't running or the log is absent — both ordinary states, not
 * errors. The first call attaches at the end of the file so starting the app mid-session
 * doesn't replay messages the user already read.
 */
export async function pollEeLogEvents(): Promise<EeLogEvent[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  return invoke<EeLogEvent[]>('poll_ee_log_events');
}

/**
 * Decrypts and parses AlecaFrame's cached inventory snapshot.
 *
 * Returns `null` when AlecaFrame isn't installed — an ordinary state, not an error. A
 * thrown error means decryption itself failed, which most likely means AlecaFrame changed
 * its static key; the message says so.
 *
 * This is a snapshot taken at the last session boundary, not a live feed. Always show
 * `lastInventorySync` alongside it.
 */
export async function readAlecaframeInventory(): Promise<AlecaframeInventory | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  return invoke<AlecaframeInventory | null>('read_alecaframe_inventory');
}

/**
 * Records trades parsed from `EE.log` into the shadow store.
 *
 * Shadow mode: these are kept **separate from the real trade log** so the new parser can be
 * compared against WFM detection over real trading before the cutover. Nothing here affects
 * the ledger, P&L, or listings.
 */
export async function recordEeLogTrades(trades: EeLogTradeEvent[]): Promise<number> {
  if (!isTauriRuntime() || trades.length === 0) {
    return 0;
  }

  return invoke<number>('record_ee_log_trades', { trades });
}

/**
 * Writes detected trades into the real trade log. EE.log is the trade-log source — WFM is
 * never polled for trades, only imported from on request.
 */
export async function recordEeLogTradesToLog(
  username: string,
  trades: EeLogTradeEvent[],
  sessionStartedAt: string | null,
): Promise<DetectedTradeOutcome> {
  if (!isTauriRuntime() || trades.length === 0 || !username) {
    return { added: 0, notificationCount: 0, lastUpdatedAt: null };
  }

  return invoke<DetectedTradeOutcome>('record_ee_log_trades_to_log', {
    username,
    trades,
    sessionStartedAt,
  });
}

export async function getEeLogShadowTrades(): Promise<ShadowTradeRow[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  return invoke<ShadowTradeRow[]>('get_ee_log_shadow_trades');
}

/**
 * Compares EE.log trade detection against WFM's, for shadow mode. Read-only diagnostic —
 * it reads both stores and pairs them, changing nothing.
 */
export async function getTradeDetectionComparison(username: string): Promise<TradeComparison> {
  if (!isTauriRuntime()) {
    return {
      rows: [],
      matchedCount: 0,
      shadowOnlyCount: 0,
      wfmOnlyCount: 0,
      unresolvedItemCount: 0,
    };
  }

  return invoke<TradeComparison>('get_trade_detection_comparison', { username });
}

/**
 * Rebuilds owned set components from AlecaFrame's inventory, so the set-completion planner
 * and Opportunities reflect what the player actually owns.
 *
 * Returns `null` when AlecaFrame is off or unavailable — in that case the manually imported
 * baseline is deliberately left untouched rather than wiped.
 */
export async function syncOwnedItemsFromAlecaframe(): Promise<SetCompletionOwnedItem[] | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  return invoke<SetCompletionOwnedItem[] | null>('sync_owned_items_from_alecaframe');
}

export async function probeLocalSources(): Promise<LocalSourceAvailability> {
  if (!isTauriRuntime()) {
    return {
      warframeLog: { status: 'unavailable', reason: 'unsupportedPlatform' },
      alecaframeInventory: { status: 'unavailable', reason: 'unsupportedPlatform' },
      usingOverride: false,
    };
  }

  return invoke<LocalSourceAvailability>('probe_local_sources');
}

export async function getWfmAutocompleteItems(
  language?: AppLanguage,
): Promise<WfmAutocompleteItem[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  return invoke<WfmAutocompleteItem[]>('get_wfm_autocomplete_items', {
    language: language ? wfmLangCode(language) : undefined,
  });
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
// Export/import both go straight to/from a file path the user picks via a native dialog (see
// dataTransfer.ts) — never through a giant string return value. `statistics_cache` alone can
// exceed 300k rows; round-tripping that as an `invoke()` string meant the Rust side building a
// 100+MB string, Tauri's IPC layer serializing it again, and the webview `JSON.parse`-ing it, all
// on one command call — which is what made large exports appear to hang or silently fail.

export interface TransferTableCount {
  table: string;
  rowCount: number;
}

export interface TransferSummary {
  tables: TransferTableCount[];
  totalRows: number;
  fileSizeBytes: number;
}

export interface UserDataImportResult {
  summary: TransferSummary;
  localStorage: Record<string, string>;
}

export interface BaddieHeader {
  format: string;
  kind: string;
  schemaVersion: number | null;
  appVersion: string | null;
  exportedAt: string | null;
}

/** Reads just the envelope header (kind/version/exported-at) without touching the payload, so
 * the UI can confirm "this will replace your [user/market] data" before running the real
 * (destructive) import. */
export async function peekBaddieFile(path: string): Promise<BaddieHeader> {
  return invoke<BaddieHeader>('peek_baddie_file', { path });
}

export async function exportUserData(
  path: string,
  localStorage: Record<string, string>,
): Promise<TransferSummary> {
  return invoke<TransferSummary>('export_user_data', { path, localStorage });
}
export async function exportMarketData(path: string): Promise<TransferSummary> {
  return invoke<TransferSummary>('export_market_data', { path });
}
export async function importUserData(path: string): Promise<UserDataImportResult> {
  return invoke<UserDataImportResult>('import_user_data', { path });
}
export async function importMarketData(path: string): Promise<TransferSummary> {
  return invoke<TransferSummary>('import_market_data', { path });
}

/**
 * Manual backfill of trades from Warframe.Market. WFM is never polled for trades — this is
 * only for the gap case, trades made while WarStonks was closed.
 */
export async function importWfmTradeLog(username: string): Promise<DetectedTradeOutcome> {
  return invoke<DetectedTradeOutcome>('import_wfm_trade_log', { username });
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

/** Subtypes for an item in catalog order (index 0 = WFM default); empty = no subtypes. */
export async function getWfmItemSubtypes(wfmId: string): Promise<string[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invoke<string[]>('get_wfm_item_subtypes', { wfmId });
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

export async function getTradeSellOrderHealth(
  itemKey: string | null,
  slug: string,
  rank: number | null,
  yourPrice: number,
  sellerMode: SellerMode,
  priority: 'high' | 'medium' | 'low',
  createdAt: string | null,
  perTrade: number | null,
  orderId: string | null,
  wfmId: string | null,
  quantity: number | null,
  visible: boolean | null,
  bulkTradable: boolean | null,
): Promise<TradeListingHealth> {
  return invoke<TradeListingHealth>('get_trade_sell_order_health', {
    itemKey,
    slug,
    rank,
    yourPrice,
    sellerMode,
    priority,
    createdAt,
    perTrade,
    orderId,
    wfmId,
    quantity,
    visible,
    bulkTradable,
  });
}

export async function getHealthPredictionAccuracy(): Promise<HealthPredictionAccuracy> {
  return invoke<HealthPredictionAccuracy>('get_health_prediction_accuracy');
}

export async function getTradeBuyOrderHealth(
  itemKey: string | null,
  slug: string,
  rank: number | null,
  yourPrice: number,
  sellerMode: SellerMode,
  priority: 'high' | 'medium' | 'low',
): Promise<TradeListingHealth> {
  return invoke<TradeListingHealth>('get_trade_buy_order_health', {
    itemKey,
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
  itemKey: string,
  slug: string,
  variantKey: string | null,
  sellerMode: SellerMode,
  source: MarketTrackingSource,
): Promise<MarketSnapshot> {
  return invoke<MarketSnapshot>('ensure_market_tracking', {
    itemKey,
    slug,
    variantKey,
    sellerMode,
    source,
  });
}

export async function stopMarketTracking(
  itemKey: string,
  slug: string,
  variantKey: string | null,
  source: MarketTrackingSource,
): Promise<void> {
  return invoke<void>('stop_market_tracking', {
    itemKey,
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
  itemKey: string,
  slug: string,
): Promise<MarketVariant[]> {
  return invoke<MarketVariant[]>('get_item_variants_for_market', {
    itemKey,
    slug,
  });
}

export async function getItemAnalytics(
  itemKey: string,
  slug: string,
  variantKey: string | null,
  sellerMode: SellerMode,
  domainKey: AnalyticsDomainKey,
  bucketSizeKey: AnalyticsBucketSizeKey,
): Promise<ItemAnalyticsResponse> {
  return invoke<ItemAnalyticsResponse>('get_item_analytics', {
    itemKey,
    slug,
    variantKey,
    sellerMode,
    domainKey,
    bucketSizeKey,
  });
}

export async function getItemDetailSummary(
  itemKey: string,
  slug: string,
): Promise<ItemDetailSummary> {
  return invoke<ItemDetailSummary>('get_item_detail_summary', {
    itemKey,
    slug,
  });
}

export async function getItemAnalysis(
  itemKey: string,
  slug: string,
  variantKey: string | null,
  sellerMode: SellerMode,
): Promise<ItemAnalysisResponse> {
  return invoke<ItemAnalysisResponse>('get_item_analysis', {
    itemKey,
    slug,
    variantKey,
    sellerMode,
  });
}

export async function getBacktestSummary(): Promise<BacktestSummary> {
  return invoke<BacktestSummary>('get_backtest_summary');
}

export async function getArbitrageScannerState(): Promise<ArbitrageScannerState> {
  return invoke<ArbitrageScannerState>('get_arbitrage_scanner_state');
}

export async function getSetCompletionOwnedItems(): Promise<SetCompletionOwnedItem[]> {
  return invoke<SetCompletionOwnedItem[]>('get_set_completion_owned_items');
}

export async function setSetCompletionOwnedItemQuantity(input: {
  itemKey: string | null;
  slug: string;
  name: string;
  imagePath: string | null;
  quantity: number;
}): Promise<SetCompletionOwnedItem[]> {
  return invoke<SetCompletionOwnedItem[]>('set_set_completion_owned_item_quantity', {
    itemKey: input.itemKey,
    slug: input.slug,
    name: input.name,
    imagePath: input.imagePath,
    quantity: input.quantity,
  });
}

export async function applySetCompletionScreenshotImportRows(rows: Array<{
  itemKey: string | null;
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

export interface BackgroundCatalogProgress {
  statusText: string;
  progressValue: number;
}

export interface BackgroundCatalogFailed {
  message: string;
}

/**
 * A stale-but-usable item catalog refreshing off the boot path (see
 * `item_catalog_v2::spawn_background_catalog_v2_refresh` on the Rust side) — distinct from
 * `startup-progress`, which only ever fires before the app is usable.
 */
export async function listenToBackgroundCatalogRefresh(handlers: {
  onProgress: (progress: BackgroundCatalogProgress) => void;
  onComplete: () => void;
  onFailed: (failure: BackgroundCatalogFailed) => void;
}): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  const unlistenProgress = await listen<BackgroundCatalogProgress>(
    'catalog-v2-background-progress',
    (event) => handlers.onProgress(event.payload),
  );
  const unlistenComplete = await listen('catalog-v2-background-complete', () => {
    handlers.onComplete();
  });
  const unlistenFailed = await listen<BackgroundCatalogFailed>(
    'catalog-v2-background-failed',
    (event) => handlers.onFailed(event.payload),
  );

  return () => {
    unlistenProgress();
    unlistenComplete();
    unlistenFailed();
  };
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

/**
 * Live state of the persistent WFM websocket. Presence only exists while this connection
 * does, so a dropped socket and a rejected sign-in are the two ways the user silently goes
 * offline — this distinguishes them instead of both surfacing as a bare "offline".
 */
export interface WfmPresenceConnection {
  connected: boolean;
  authenticated: boolean;
  /** Seconds since the last inbound frame. Only present while connected. */
  lastInboundSecondsAgo?: number;
  /** Unanswered keepalive pings. Only present while connected. */
  pendingPings?: number;
  /** Consecutive failed reconnects. Only present while disconnected. */
  reconnectAttempts?: number;
  /** Seconds until the next reconnect attempt. Only present while disconnected. */
  retryInSeconds?: number;
}

export async function listenToWfmPresenceConnection(
  onConnection: (state: WfmPresenceConnection) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  return listen<WfmPresenceConnection>('wfm-presence-connection', (event) => {
    onConnection(event.payload);
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

/**
 * Subscribes to the firehose "your listing was just undercut" signal so health can refresh that
 * item immediately instead of waiting for the poll. Payload carries the WFM hex item id.
 */
export async function subscribeToTradeHealthStale(
  onStale: (wfmItemId: string) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ itemId: string }>('wfm-trade-health-stale', (event) => {
    if (event.payload?.itemId) {
      onStale(event.payload.itemId);
    }
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
  /**
   * Whether the listing is still a genuine deal at its *current* price — the seller may have
   * edited it since we surfaced it. `null` when there's no recommended price to judge against.
   * Decided in Rust so it uses the same threshold that surfaced the listing.
   */
  stillUnderpriced: boolean | null;
}

/** Re-checks (instant priority) whether an underpriced listing is still live on Warframe.Market. */
export async function verifyMarketListing(input: {
  orderId: string;
  userSlug: string;
  itemId: string;
  rank: number | null;
  expectedPrice: number;
  recommendedPrice?: number | null;
}): Promise<VerifyMarketListingResult> {
  return invoke<VerifyMarketListingResult>('verify_market_listing', {
    orderId: input.orderId,
    userSlug: input.userSlug,
    itemId: input.itemId,
    rank: input.rank,
    expectedPrice: input.expectedPrice,
    recommendedPrice: input.recommendedPrice ?? null,
  });
}

// Future commands — add typed stubs here as the backend grows:
// export async function fetchMarketData(itemId: string): Promise<MarketData> { ... }
// export async function syncTradeOrders(): Promise<TradeOrder[]> { ... }
