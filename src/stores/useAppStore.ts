import { create } from 'zustand';
import { type AppUpdateSummary, clearPendingAppUpdate, installPendingAppUpdate } from '../lib/appUpdater';
import {
  closeWfmBuyOrder,
  createWfmBuyOrder,
  deleteWfmBuyOrder,
  ensureMarketTracking,
  getCachedWfmProfileTradeLog,
  getWfmAutocompleteItems,
  getAppSettings,
  getItemAnalytics,
  getItemAnalysis,
  refreshAlecaframeWalletSnapshot,
  getItemVariantsForMarket,
  getWfmTradeOverview,
  getWfmItemOrders,
  setWfmTradeStatus,
  updateWfmBuyOrder,
  getWfmTopSellOrdersForVariant,
  getWfmTopSellOrders,
  saveAlecaframeSettings,
  saveDiscordWebhookSettings,
  sendWatchlistFoundDiscordNotification,
  sendUnderpricedListingDiscordNotification,
  signInWfmTradeAccount,
  signOutWfmTradeAccount,
  stopMarketTracking,
  tryAutoSignInWfmTradeAccount,
  getOpportunities,
  getCachedOpportunities,
  getOwnedRelicInventoryCache,
  refreshOwnedRelicInventory,
  scanVoidTraderPrices,
  getWorldStateCycles,
  getWorldStateSteelPath,
  getWorldStateNightwave,
  getWorldStateVaultTrader,
  setWorldstateLanguage,
  type RealtimeWatchlistOrder,
  type UnderpricedListing,
  type Opportunity,
} from '../lib/tauriClient';
import {
  fetchWorldStateAlertsSnapshot,
  fetchWorldStateArbitrationSnapshot,
  fetchWorldStateArchonHuntSnapshot,
  fetchWorldStateEventsSnapshot,
  fetchWorldStateFissuresSnapshot,
  fetchWorldStateInvasionsSnapshot,
  fetchWorldStateMarketNewsSnapshot,
  fetchWorldStateSortieSnapshot,
  fetchWorldStateSyndicateMissionsSnapshot,
  fetchWorldStateVoidTraderSnapshot,
  restoreCachedWorldStateAlerts,
  restoreCachedWorldStateArbitration,
  restoreCachedWorldStateArchonHunt,
  restoreCachedWorldStateEvents,
  restoreCachedWorldStateFissures,
  restoreCachedWorldStateInvasions,
  restoreCachedWorldStateMarketNews,
  restoreCachedWorldStateSortie,
  restoreCachedWorldStateSyndicateMissions,
  restoreCachedWorldStateVoidTrader,
  WORLDSTATE_ENDPOINT_KEYS,
  WORLDSTATE_ENDPOINT_LABELS,
  WORLDSTATE_RETRY_DELAY_MS,
  worldStateObjectExpiry,
  worldStateCyclesNextRefresh,
} from '../lib/worldState';
import {
  persistWorldStateCacheEntry,
  readWorldStateCacheEntry,
} from '../lib/worldStateCache';
import {
  buildWatchlistUserKey,
  getWatchlistPollIntervalMs,
  getWatchlistRequestPriority,
  getWatchlistRetryDelayMs,
  selectPreferredWatchlistOrder,
} from '../lib/watchlist';
import {
  buildTradeBuyOrderVariantKey,
  indexTradeBuyOrdersByVariant,
} from '../lib/watchlistTradeSync';
import {
  findActiveWatchlistBuyOrder,
  hasRecentClosedBuyTradeAtPrice,
} from '../lib/watchlistPurchase';
import { orderQuickViewVariants } from '../lib/marketVariantFallback';
import { formatEventsErrorMessage } from '../lib/eventsErrorHandling';
import { formatHomeErrorMessage } from '../lib/homeErrorHandling';
import { formatMarketErrorMessage } from '../lib/marketErrorHandling';
import { formatSettingsErrorMessage } from '../lib/settingsErrorHandling';
import type {
  AppToast,
  ItemQuickViewTarget,
  OwnedRelicEntry,
  NavigationSnapshot,
  HomeSubTab,
  PageId,
  QuickViewSelection,
  SellerMode,
  SettingsSection,
  TradeAccountSummary,
  TradeSignInInput,
  TradePeriod,
  TradesSubTab,
  WatchlistAlert,
  WatchlistItem,
  SystemAlert,
  WorldStateEndpointKey,
  WorldStateExtraKey,
  EventsSubTab,
  WfstatAlert,
  WfstatArchonHunt,
  WfstatArbitration,
  WfstatFlashSale,
  WfstatFissure,
  WfstatInvasion,
  WfstatNewsItem,
  WfstatSortie,
  WfstatSyndicateMission,
  WfstatVoidTrader,
  WfstatWorldStateEvent,
  AlecaframeSettingsInput,
  AppSettings,
  AppUpdateInstallState,
  DiscordWebhookSettingsInput,
  ItemAnalysisResponse,
  MarketVariant,
  TradeOverview,
  TradeDetectedBuy,
  WalletSnapshot,
  WfmAutocompleteItem,
  WfmTopSellOrder,
  NotificationSettings,
} from '../types';
import {
  fireAlertNotification,
  loadNotificationSettings,
  saveNotificationSettings,
} from '../lib/notifications';
import { applySetSuffix, type AppLanguage, loadLanguage, saveLanguage, wfmLangCode, wfstatLangCode } from '../lib/language';
import {
  loadPinnedOpportunities,
  savePinnedOpportunities,
  mergePinSnapshots,
  type PinnedOpportunities,
} from '../lib/pinnedOpportunities';

let quickViewRequestSequence = 0;
let marketAnalysisRequestSequence = 0;
const marketAnalysisLoadPromises = new Map<string, Promise<ItemAnalysisResponse | null>>();
let worldStateEventsRefreshPromise: Promise<void> | null = null;
let worldStateAlertsRefreshPromise: Promise<void> | null = null;
let worldStateSortieRefreshPromise: Promise<void> | null = null;
let worldStateArbitrationRefreshPromise: Promise<void> | null = null;
let worldStateArchonHuntRefreshPromise: Promise<void> | null = null;
let worldStateFissuresRefreshPromise: Promise<void> | null = null;
let worldStateMarketNewsRefreshPromise: Promise<void> | null = null;
let worldStateInvasionsRefreshPromise: Promise<void> | null = null;
let worldStateSyndicateMissionsRefreshPromise: Promise<void> | null = null;
let worldStateVoidTraderRefreshPromise: Promise<void> | null = null;
let tradeAccountLoadPromise: Promise<void> | null = null;

/** One reference worldstate source held generically — raw payload + its load/cache state. */
export interface WorldStateExtraEntry {
  payload: unknown;
  loading: boolean;
  error: string | null;
  nextRefreshAt: string | null;
  lastUpdatedAt: string | null;
}

/** Generic plumbing for the four reference worldstate sources (cycles/steel-path/nightwave/vault). */
export const WORLDSTATE_EXTRA_KEYS: WorldStateExtraKey[] = [
  'cycles',
  'steel-path',
  'nightwave',
  'vault-trader',
];
const WORLDSTATE_EXTRA_CONFIG: Record<
  WorldStateExtraKey,
  { fetch: () => Promise<unknown>; nextRefreshAt: (payload: unknown) => string | null }
> = {
  cycles: { fetch: getWorldStateCycles, nextRefreshAt: worldStateCyclesNextRefresh },
  'steel-path': { fetch: getWorldStateSteelPath, nextRefreshAt: worldStateObjectExpiry },
  nightwave: { fetch: getWorldStateNightwave, nextRefreshAt: worldStateObjectExpiry },
  'vault-trader': { fetch: getWorldStateVaultTrader, nextRefreshAt: worldStateObjectExpiry },
};
const worldStateExtraRefreshPromises: Record<WorldStateExtraKey, Promise<void> | null> = {
  cycles: null,
  'steel-path': null,
  nightwave: null,
  'vault-trader': null,
};
const emptyWorldStateExtraEntry = (): WorldStateExtraEntry => ({
  payload: null,
  loading: false,
  error: null,
  nextRefreshAt: null,
  lastUpdatedAt: null,
});
let backgroundWalletRefreshPromise: Promise<void> | null = null;
const watchlistRefreshGenerations = new Map<string, number>();
let autocompleteCatalogPromise: Promise<WfmAutocompleteItem[]> | null = null;
// The catalog is fetched per display language; changing language invalidates it.
let autocompleteCatalogLang: string | null = null;

const defaultAppSettings: AppSettings = {
  alecaframe: {
    enabled: false,
    publicLink: null,
    usernameWhenPublic: null,
    lastValidatedAt: null,
  },
  discordWebhook: {
    enabled: false,
    webhookUrl: null,
    notifications: {
      watchlistFound: true,
      tradeDetected: true,
      underpricedListing: true,
    },
    lastValidatedAt: null,
  },
};

const defaultWalletSnapshot: WalletSnapshot = {
  enabled: false,
  configured: false,
  balances: {
    platinum: null,
    credits: null,
    endo: null,
    ducats: null,
    aya: null,
  },
  usernameWhenPublic: null,
  lastUpdate: null,
  errorMessage: null,
};

const WATCHLIST_STORAGE_KEY = 'warstonks.watchlist.v1';

interface PersistedWatchlistState {
  watchlist: Array<{
    itemId: number;
    name: string;
    displayName: string;
    slug: string;
    variantKey: string;
    variantLabel: string;
    imagePath: string | null;
    itemFamily: string | null;
    targetPrice: number;
    maxRank: number | null;
    ignoredUserKeys: string[];
    linkedBuyOrderId: string | null;
  }>;
  selectedWatchlistId: string | null;
}

interface WatchlistRefreshResult {
  alertTriggered: boolean;
}

interface CachedWorldStateSnapshot<T> {
  payload: T;
  fetchedAt: string;
  nextRefreshAt: string | null;
}

function beginWatchlistRefresh(id: string): number {
  const nextGeneration = (watchlistRefreshGenerations.get(id) ?? 0) + 1;
  watchlistRefreshGenerations.set(id, nextGeneration);
  return nextGeneration;
}

function isLatestWatchlistRefresh(id: string, generation: number): boolean {
  return watchlistRefreshGenerations.get(id) === generation;
}

function buildMarketAnalysisCacheKey(
  itemId: number,
  variantKey: string,
  sellerMode: SellerMode,
): string {
  return `${itemId}:${variantKey}:${sellerMode}`;
}

function readPersistedWatchlistState(): PersistedWatchlistState {
  if (typeof window === 'undefined') {
    return { watchlist: [], selectedWatchlistId: null };
  }

  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) {
      return { watchlist: [], selectedWatchlistId: null };
    }

    const parsed = JSON.parse(raw) as Partial<PersistedWatchlistState>;
    return {
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
      selectedWatchlistId:
        typeof parsed.selectedWatchlistId === 'string' ? parsed.selectedWatchlistId : null,
    };
  } catch (error) {
    console.error('[watchlist] failed to read persisted state', error);
    return { watchlist: [], selectedWatchlistId: null };
  }
}

function writePersistedWatchlistState(
  watchlist: WatchlistItem[],
  selectedWatchlistId: string | null,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  const nextState: PersistedWatchlistState = {
    watchlist: watchlist.map((item) => ({
      itemId: item.itemId,
      name: item.name,
      displayName: item.displayName,
      slug: item.slug,
      variantKey: item.variantKey,
      variantLabel: item.variantLabel,
      imagePath: item.imagePath,
      itemFamily: item.itemFamily,
      targetPrice: item.targetPrice,
      maxRank: item.maxRank,
      ignoredUserKeys: item.ignoredUserKeys,
      linkedBuyOrderId: item.linkedBuyOrderId,
    })),
    selectedWatchlistId,
  };

  try {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(nextState));
  } catch (error) {
    console.error('[watchlist] failed to persist state', error);
  }
}

const RECENT_ITEMS_STORAGE_KEY = 'warstonks.recentItems.v1';
const RECENT_ITEMS_LIMIT = 8;

function readPersistedRecentItems(): WfmAutocompleteItem[] {
  try {
    const raw = window.localStorage.getItem(RECENT_ITEMS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WfmAutocompleteItem[]).slice(0, RECENT_ITEMS_LIMIT) : [];
  } catch {
    return [];
  }
}

function writePersistedRecentItems(items: WfmAutocompleteItem[]): void {
  try {
    window.localStorage.setItem(RECENT_ITEMS_STORAGE_KEY, JSON.stringify(items.slice(0, RECENT_ITEMS_LIMIT)));
  } catch (error) {
    console.error('[recents] failed to persist recent items', error);
  }
}

function extractQuickViewSparklinePoints(chartPoints: Awaited<ReturnType<typeof getItemAnalytics>>['chartPoints']): number[] {
  return chartPoints
    .slice(-24)
    .map((point) => point.lowestSell)
    .filter((value): value is number => value !== null && value !== undefined && !Number.isNaN(value));
}

const WORLDSTATE_SYSTEM_ALERT_ID = 'system:worldstate-offline';
const SCANNER_STALE_SYSTEM_ALERT_ID = 'system:scanner-stale';
const APP_UPDATE_SYSTEM_ALERT_ID = 'system:app-update';
const SCANNER_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildWatchlistId(item: WfmAutocompleteItem): string {
  return item.slug;
}

function buildMarketDisplayName(name: string, variantLabel: string | null | undefined): string {
  if (!variantLabel || variantLabel === 'Base Market') {
    return name;
  }

  return `${name} · ${variantLabel}`;
}

function deriveVariantRankFromKey(variantKey: string): number | null {
  if (!variantKey.startsWith('rank:')) {
    return null;
  }

  const parsed = Number.parseInt(variantKey.slice(5), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function restoreSelectedWatchlistId(
  watchlist: WatchlistItem[],
  selectedWatchlistId: string | null,
): string | null {
  return selectedWatchlistId && watchlist.some((item) => item.id === selectedWatchlistId)
    ? selectedWatchlistId
    : watchlist[0]?.id ?? null;
}

function isSameWatchlistSequence(left: WatchlistItem[], right: WatchlistItem[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function findMatchingBuyOrderId(
  item: WfmAutocompleteItem,
  variantKey: string,
  targetPrice: number,
  overview: Awaited<ReturnType<typeof createWfmBuyOrder>>,
): string | null {
  const expectedRank = deriveVariantRankFromKey(variantKey);
  const matchingOrders = overview.buyOrders.filter(
    (order) =>
      order.wfmId === item.wfmId &&
      order.yourPrice === Math.round(targetPrice) &&
      order.quantity === 1 &&
      order.rank === expectedRank,
  );

  if (matchingOrders.length === 0) {
    return null;
  }

  matchingOrders.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return matchingOrders[0]?.orderId ?? null;
}

function findBuyOrderById(
  buyOrders: TradeOverview['buyOrders'],
  orderId: string,
): TradeOverview['buyOrders'][number] | null {
  return buyOrders.find((order) => order.orderId === orderId) ?? null;
}

function isBuyOrderConfirmedForPurchase(input: {
  order: TradeOverview['buyOrders'][number] | null;
  expectedPrice: number;
  expectedRank: number | null;
}): boolean {
  const { order, expectedPrice, expectedRank } = input;
  return Boolean(
    order
    && order.yourPrice === expectedPrice
    && order.quantity === 1
    && order.visible
    && order.rank === expectedRank,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function confirmWatchlistBuyOrderReadyForClose(input: {
  overview: TradeOverview;
  orderId: string;
  expectedPrice: number;
  expectedRank: number | null;
  sellerMode: SellerMode;
}): Promise<TradeOverview> {
  const { orderId, expectedPrice, expectedRank, sellerMode } = input;
  let latestOverview = input.overview;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const matchingOrder = findBuyOrderById(latestOverview.buyOrders, orderId);
    if (
      isBuyOrderConfirmedForPurchase({
        order: matchingOrder,
        expectedPrice,
        expectedRank,
      })
    ) {
      return latestOverview;
    }

    await delay(175);
    latestOverview = await getWfmTradeOverview(sellerMode);
  }

  throw new Error('Failed to confirm the updated buy order price before closing the order.');
}

function clearLinkedBuyOrderFromWatchlistState(
  watchlist: WatchlistItem[],
  id: string,
): WatchlistItem[] {
  return watchlist.map((entry) =>
    entry.id === id && entry.linkedBuyOrderId !== null
      ? { ...entry, linkedBuyOrderId: null }
      : entry,
  );
}

async function getAutocompleteCatalog(): Promise<WfmAutocompleteItem[]> {
  const lang = wfmLangCode(useAppStore.getState().language);
  if (!autocompleteCatalogPromise || autocompleteCatalogLang !== lang) {
    autocompleteCatalogLang = lang;
    autocompleteCatalogPromise = getWfmAutocompleteItems(lang).catch((error) => {
      autocompleteCatalogPromise = null;
      autocompleteCatalogLang = null;
      throw error;
    });
  }

  return autocompleteCatalogPromise;
}

async function resolveWatchlistWfmIdentity(item: WfmAutocompleteItem): Promise<WfmAutocompleteItem> {
  if (item.wfmId) {
    return item;
  }

  const catalog = await getAutocompleteCatalog();
  const matched =
    catalog.find((entry) => entry.itemId === item.itemId) ??
    catalog.find((entry) => entry.slug === item.slug);

  return matched
    ? {
        ...item,
        wfmId: matched.wfmId,
        maxRank: item.maxRank ?? matched.maxRank,
        itemFamily: item.itemFamily ?? matched.itemFamily,
        imagePath: item.imagePath ?? matched.imagePath,
      }
    : item;
}

async function syncWatchlistBuyOrder(
  item: WfmAutocompleteItem,
  variantKey: string,
  targetPrice: number,
  sellerMode: SellerMode,
  linkedBuyOrderId: string | null,
): Promise<string | null> {
  const resolvedItem = await resolveWatchlistWfmIdentity(item);
  if (!resolvedItem.wfmId) {
    return linkedBuyOrderId;
  }

  const rank = deriveVariantRankFromKey(variantKey);
  const normalizedPrice = Math.max(1, Math.round(targetPrice));

  if (linkedBuyOrderId) {
    const overview = await updateWfmBuyOrder(
      {
        orderId: linkedBuyOrderId,
        price: normalizedPrice,
        quantity: 1,
        rank,
        visible: true,
      },
      sellerMode,
    );
    return findMatchingBuyOrderId(resolvedItem, variantKey, normalizedPrice, overview) ?? linkedBuyOrderId;
  }

  const overview = await createWfmBuyOrder(
    {
      wfmId: resolvedItem.wfmId,
      price: normalizedPrice,
      quantity: 1,
      rank,
      visible: true,
    },
    sellerMode,
  );

  return findMatchingBuyOrderId(resolvedItem, variantKey, normalizedPrice, overview);
}

async function removeWatchlistBuyOrder(
  orderId: string | null,
  sellerMode: SellerMode,
): Promise<void> {
  if (!orderId) {
    return;
  }

  await deleteWfmBuyOrder(orderId, sellerMode);
}

function buildWatchlistAlertId(watchlistId: string, orderId: string): string {
  return `${watchlistId}:${orderId}`;
}

/**
 * Identity of an alert by what it MEANS, not which order id triggered it: the same item, from the
 * same seller, at the same price. Dismissing records this so the exact same alert can't reappear
 * when the trigger refreshes — while a cheaper price or a different seller (a new signature) still
 * alerts as it should.
 */
function watchlistAlertSignature(alert: {
  watchlistId: string;
  rank: number | null;
  price: number;
  username: string;
}): string {
  return `${alert.watchlistId}:${alert.rank ?? 'base'}:${alert.price}:${alert.username.trim().toLowerCase()}`;
}

function sanitizePositiveIntegerInput(value: string): string {
  const digitsOnly = value.replace(/\D+/g, '');
  const trimmedLeadingZeroes = digitsOnly.replace(/^0+/, '');
  return trimmedLeadingZeroes;
}

function parsePositiveWholeNumber(value: string): number | null {
  const normalized = sanitizePositiveIntegerInput(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function buildWatchlistAlert(
  item: WatchlistItem,
  order: WfmTopSellOrder,
): WatchlistAlert {
  return {
    id: buildWatchlistAlertId(item.id, order.orderId),
    watchlistId: item.id,
    itemName: item.displayName,
    itemSlug: item.slug,
    itemImagePath: item.imagePath,
    username: order.username,
    userSlug: order.userSlug,
    price: order.platinum,
    quantity: order.quantity,
    rank: order.rank,
    orderId: order.orderId,
    createdAt: new Date().toISOString(),
  };
}

function buildWorldStateSystemAlert(sourceKeys: WorldStateEndpointKey[]): SystemAlert {
  const uniqueSourceKeys = [...new Set(sourceKeys)];
  const affectedLabels = uniqueSourceKeys
    .map((sourceKey) => WORLDSTATE_ENDPOINT_LABELS[sourceKey])
    .sort((left, right) => left.localeCompare(right));
  const affectedSummary =
    affectedLabels.length > 3
      ? `${affectedLabels.slice(0, 3).join(', ')}, +${affectedLabels.length - 3} more`
      : affectedLabels.join(', ');

  return {
    id: WORLDSTATE_SYSTEM_ALERT_ID,
    kind: 'worldstate-offline',
    sourceKeys: uniqueSourceKeys,
    title: 'WFStat API unavailable',
    message:
      uniqueSourceKeys.length === 1
        ? `${affectedSummary} could not be refreshed. Cached data will stay visible until the API recovers.`
        : `${affectedSummary} could not be refreshed. Cached data will stay visible until the API recovers.`,
    createdAt: new Date().toISOString(),
  };
}

function buildScannerStaleSystemAlert(scanFinishedAt: string): SystemAlert {
  return {
    id: SCANNER_STALE_SYSTEM_ALERT_ID,
    kind: 'scanner-stale',
    title: 'Scanner data is stale',
    message: 'The latest scanner run is over 48 hours old. A rescan is highly recommended.',
    createdAt: scanFinishedAt,
  };
}

function buildAppUpdateSystemAlert(input: {
  version: string;
  currentVersion: string;
  notes: string | null;
  installState: AppUpdateInstallState;
  progressPercent?: number | null;
  errorMessage?: string | null;
}): SystemAlert {
  let message = `WarStonks ${input.version} is available. You are currently on ${input.currentVersion}.`;
  if (input.installState === 'downloading') {
    message = input.progressPercent !== null && input.progressPercent !== undefined
      ? `Downloading WarStonks ${input.version}… ${input.progressPercent}%`
      : `Downloading WarStonks ${input.version}…`;
  } else if (input.installState === 'installing') {
    message = `Installing WarStonks ${input.version}. The app will relaunch automatically when the installer finishes.`;
  } else if (input.installState === 'error') {
    message = input.errorMessage ?? `WarStonks ${input.version} could not be installed automatically.`;
  }

  return {
    id: APP_UPDATE_SYSTEM_ALERT_ID,
    kind: 'app-update',
    title: input.installState === 'error' ? 'Update failed' : 'Update available',
    message,
    createdAt: new Date().toISOString(),
    updateVersion: input.version,
    currentVersion: input.currentVersion,
    releaseNotes: input.notes,
    installState: input.installState,
    progressPercent: input.progressPercent ?? null,
  };
}

function upsertWorldStateSystemAlert(
  alerts: SystemAlert[],
  sourceKey: WorldStateEndpointKey,
  allowCreate: boolean,
): SystemAlert[] {
  const existingAlert = alerts.find((alert) => alert.id === WORLDSTATE_SYSTEM_ALERT_ID);
  if (!existingAlert && !allowCreate) {
    return alerts;
  }

  const nextAlert = buildWorldStateSystemAlert([
    ...(existingAlert?.sourceKeys ?? []),
    sourceKey,
  ]);

  return [nextAlert, ...alerts.filter((alert) => alert.id !== WORLDSTATE_SYSTEM_ALERT_ID)];
}

function shouldCreateWorldStateOfflineAlert(input: {
  dismissed: boolean;
  hasUsableData: boolean;
}): boolean {
  return !input.dismissed && !input.hasUsableData;
}

function clearWorldStateSystemAlertSource(
  alerts: SystemAlert[],
  sourceKey: WorldStateEndpointKey,
): SystemAlert[] {
  const existingAlert = alerts.find((alert) => alert.id === WORLDSTATE_SYSTEM_ALERT_ID);
  if (!existingAlert) {
    return alerts;
  }

  const remainingSourceKeys = (existingAlert.sourceKeys ?? []).filter((key) => key !== sourceKey);
  if (remainingSourceKeys.length === 0) {
    return alerts.filter((alert) => alert.id !== WORLDSTATE_SYSTEM_ALERT_ID);
  }

  const nextAlert = buildWorldStateSystemAlert(remainingSourceKeys);
  return [nextAlert, ...alerts.filter((alert) => alert.id !== WORLDSTATE_SYSTEM_ALERT_ID)];
}

function upsertScannerStaleSystemAlert(
  alerts: SystemAlert[],
  scanFinishedAt: string | null,
): SystemAlert[] {
  const filteredAlerts = alerts.filter((alert) => alert.id !== SCANNER_STALE_SYSTEM_ALERT_ID);
  if (!scanFinishedAt) {
    return filteredAlerts;
  }

  const finishedAtMs = Date.parse(scanFinishedAt);
  if (!Number.isFinite(finishedAtMs)) {
    return filteredAlerts;
  }

  if (Date.now() - finishedAtMs < SCANNER_STALE_THRESHOLD_MS) {
    return filteredAlerts;
  }

  // Once the user dismisses the stale-scanner alert, stop re-adding it and stop
  // re-notifying for that scan for the rest of the session (until a fresh scan runs).
  if (dismissedScannerStaleScans.has(scanFinishedAt)) {
    return filteredAlerts;
  }

  // Fire a desktop/sound notification once per distinct stale scan (not on every
  // reconciliation tick).
  if (lastScannerStaleNotifiedAt !== scanFinishedAt) {
    lastScannerStaleNotifiedAt = scanFinishedAt;
    fireAlertNotification(
      useAppStore.getState().notificationSettings,
      'scannerStale',
      'Scanner data is stale',
      'The latest scanner run is over 48 hours old. A rescan is recommended.',
    );
  }

  return [buildScannerStaleSystemAlert(scanFinishedAt), ...filteredAlerts];
}

let lastScannerStaleNotifiedAt: string | null = null;
// Scan timestamps the user has dismissed this session; not re-added or re-notified.
const dismissedScannerStaleScans = new Set<string>();

function upsertAppUpdateSystemAlert(
  alerts: SystemAlert[],
  input: {
    version: string;
    currentVersion: string;
    notes: string | null;
    installState: AppUpdateInstallState;
    progressPercent?: number | null;
    errorMessage?: string | null;
  },
): SystemAlert[] {
  const nextAlert = buildAppUpdateSystemAlert(input);
  return [nextAlert, ...alerts.filter((alert) => alert.id !== APP_UPDATE_SYSTEM_ALERT_ID)];
}

async function persistWorldStateSnapshot<T>(
  sourceKey: WorldStateEndpointKey,
  snapshot: CachedWorldStateSnapshot<T>,
) {
  try {
    await persistWorldStateCacheEntry(sourceKey, {
      payload: snapshot.payload,
      fetchedAt: snapshot.fetchedAt,
      nextRefreshAt: snapshot.nextRefreshAt,
    });
  } catch (error) {
    console.error(`[worldstate-cache] failed to persist ${sourceKey}`, error);
  }
}

async function loadCachedWorldStateSnapshot<T>(
  sourceKey: WorldStateEndpointKey,
  restore: (payload: unknown) => T,
): Promise<CachedWorldStateSnapshot<T> | null> {
  try {
    const cachedEntry = await readWorldStateCacheEntry(sourceKey);
    if (!cachedEntry) {
      return null;
    }

    return {
      payload: restore(cachedEntry.payload),
      fetchedAt: cachedEntry.fetchedAt,
      nextRefreshAt: cachedEntry.nextRefreshAt,
    };
  } catch (error) {
    console.error(`[worldstate-cache] failed to load ${sourceKey}`, error);
    return null;
  }
}

function applyWatchlistOrder(
  item: WatchlistItem,
  order: WfmTopSellOrder | null,
  nextScanAt: number,
): WatchlistItem {
  return {
    ...item,
    currentPrice: order?.platinum ?? null,
    currentSeller: order?.username ?? null,
    currentUserSlug: order?.userSlug ?? null,
    currentOrderId: order?.orderId ?? null,
    currentQuantity: order?.quantity ?? null,
    currentRank: order?.rank ?? null,
    entryPrice: order?.platinum ?? null,
    lastUpdatedAt: new Date().toISOString(),
    nextScanAt,
    retryCount: 0,
    lastError: order ? null : 'No eligible sell orders are available right now.',
  };
}

function createWatchlistItem(
  item: WfmAutocompleteItem,
  variantKey: string,
  variantLabel: string,
  targetPrice: number,
  currentOrder: WfmTopSellOrder | null,
  currentCount: number,
  ignoredUserKeys: string[] = [],
  linkedBuyOrderId: string | null = null,
): WatchlistItem {
  const nextScanAt = currentOrder
    ? Date.now() + getWatchlistPollIntervalMs(currentCount)
    : Date.now();

  return {
    id: `${buildWatchlistId(item)}:${variantKey}`,
    itemId: item.itemId,
    name: item.name,
    displayName: buildMarketDisplayName(item.name, variantLabel),
    slug: item.slug,
    variantKey,
    variantLabel,
    imagePath: item.imagePath,
    itemFamily: item.itemFamily,
    targetPrice,
    currentPrice: currentOrder?.platinum ?? null,
    currentSeller: currentOrder?.username ?? null,
    currentUserSlug: currentOrder?.userSlug ?? null,
    currentOrderId: currentOrder?.orderId ?? null,
    currentQuantity: currentOrder?.quantity ?? null,
    currentRank: currentOrder?.rank ?? null,
    maxRank: item.maxRank ?? null,
    entryPrice: currentOrder?.platinum ?? null,
    exitPrice: null,
    volume: 0,
    delta24h: 0,
    score: 0,
    lastUpdatedAt: currentOrder ? new Date().toISOString() : null,
    nextScanAt,
    retryCount: 0,
    lastError: currentOrder ? null : 'Waiting for the first market refresh.',
    ignoredUserKeys,
    linkedBuyOrderId,
  };
}

function restorePersistedWatchlistItems(entries: PersistedWatchlistState['watchlist']): WatchlistItem[] {
  const currentCount = Math.max(entries.length, 1);
  return entries.map((entry) =>
    createWatchlistItem(
      {
        itemId: entry.itemId,
        wfmId: null,
        name: entry.name,
        slug: entry.slug,
        maxRank: entry.maxRank ?? deriveVariantRankFromKey(entry.variantKey),
        itemFamily: entry.itemFamily,
        imagePath: entry.imagePath,
        bulkTradable: false,
      },
      entry.variantKey,
      entry.variantLabel,
      entry.targetPrice,
      null,
      currentCount,
      entry.ignoredUserKeys,
      entry.linkedBuyOrderId,
    ),
  );
}

function createWatchlistItemFromTradeBuyOrder(
  order: Awaited<ReturnType<typeof getWfmTradeOverview>>['buyOrders'][number],
  currentCount: number,
): WatchlistItem | null {
  if (order.itemId === null) {
    return null;
  }

  const variantKey = buildTradeBuyOrderVariantKey(order.rank);
  const variantLabel = order.rank === null ? 'Base Market' : `Rank ${order.rank}`;
  return createWatchlistItem(
    {
      itemId: order.itemId,
      wfmId: order.wfmId,
      name: order.name,
      slug: order.slug,
      maxRank: order.maxRank,
      itemFamily: null,
      imagePath: order.imagePath,
      bulkTradable: false,
    },
    variantKey,
    variantLabel,
    order.yourPrice,
    null,
    currentCount,
    [],
    order.orderId,
  );
}

function mergeWatchlistWithTradeBuyOrders(
  existingWatchlist: WatchlistItem[],
  buyOrders: Awaited<ReturnType<typeof getWfmTradeOverview>>['buyOrders'],
): WatchlistItem[] {
  const orderMap = indexTradeBuyOrdersByVariant(buyOrders);
  let nextWatchlist = existingWatchlist.map((item) => {
    const matchingOrder = orderMap.get(`${item.slug}:${item.variantKey}`);
    if (!matchingOrder) {
      return item.linkedBuyOrderId ? { ...item, linkedBuyOrderId: null } : item;
    }

    if (
      item.targetPrice === matchingOrder.yourPrice
      && item.linkedBuyOrderId === matchingOrder.orderId
      && item.imagePath === (matchingOrder.imagePath ?? item.imagePath)
    ) {
      return item;
    }

    return {
      ...item,
      targetPrice: matchingOrder.yourPrice,
      linkedBuyOrderId: matchingOrder.orderId,
      imagePath: matchingOrder.imagePath ?? item.imagePath,
    };
  });

  for (const order of buyOrders) {
    const variantKey = buildTradeBuyOrderVariantKey(order.rank);
    const existingIndex = nextWatchlist.findIndex(
      (item) => item.slug === order.slug && item.variantKey === variantKey,
    );

    if (existingIndex >= 0) {
      nextWatchlist[existingIndex] = {
        ...nextWatchlist[existingIndex],
        targetPrice: order.yourPrice,
        linkedBuyOrderId: order.orderId,
        imagePath: order.imagePath ?? nextWatchlist[existingIndex].imagePath,
      };
      continue;
    }

    const nextItem = createWatchlistItemFromTradeBuyOrder(order, nextWatchlist.length + 1);
    if (nextItem) {
      nextWatchlist = [...nextWatchlist, nextItem];
    }
  }

  return nextWatchlist;
}

function buildAutocompleteItemFromWatchlistEntry(item: WatchlistItem): WfmAutocompleteItem {
  return {
    itemId: item.itemId,
    wfmId: null,
    name: item.name,
    slug: item.slug,
    maxRank: deriveVariantRankFromKey(item.variantKey),
    itemFamily: item.itemFamily,
    imagePath: item.imagePath,
    bulkTradable: false,
  };
}

/**
 * Reconciles the watchlist against the user's live buy orders. This ONLY links/unlinks
 * existing orders — it never creates them. Auto buy orders are created exclusively when an
 * item is first added to the watchlist (in `addWatchlistItem`, when "Auto Buy Order" is on),
 * so manually deleting/hiding a linked buy order has zero effect and is never re-created.
 */
function reconcileWatchlistWithTradeBuyOrders(input: {
  watchlist: WatchlistItem[];
  selectedWatchlistId: string | null;
  buyOrders: TradeOverview['buyOrders'];
}): {
  watchlist: WatchlistItem[];
  selectedWatchlistId: string | null;
} {
  const nextWatchlist = mergeWatchlistWithTradeBuyOrders(input.watchlist, input.buyOrders);
  return {
    watchlist: nextWatchlist,
    selectedWatchlistId: restoreSelectedWatchlistId(nextWatchlist, input.selectedWatchlistId),
  };
}

const persistedWatchlistState = readPersistedWatchlistState();
const restoredWatchlist = restorePersistedWatchlistItems(persistedWatchlistState.watchlist);
const restoredSelectedWatchlistId =
  persistedWatchlistState.selectedWatchlistId
  && restoredWatchlist.some((item) => item.id === persistedWatchlistState.selectedWatchlistId)
    ? persistedWatchlistState.selectedWatchlistId
    : restoredWatchlist[0]?.id ?? null;

function buildWatchlistUpdateState(
  currentState: AppStore,
  item: WfmAutocompleteItem,
  variantKey: string,
  variantLabel: string,
  targetPrice: number,
  preferredOrder: WfmTopSellOrder | null,
  linkedBuyOrderId: string | null,
) {
  const existingItem = currentState.watchlist.find(
    (entry) => entry.slug === item.slug && entry.variantKey === variantKey,
  );
  const watchlistCount = existingItem
    ? currentState.watchlist.length
    : currentState.watchlist.length + 1;
  const nextItem = createWatchlistItem(
    item,
    variantKey,
    variantLabel,
    targetPrice,
    preferredOrder,
    watchlistCount,
    existingItem?.ignoredUserKeys ?? [],
    linkedBuyOrderId ?? existingItem?.linkedBuyOrderId ?? null,
  );
  const nextAlert =
    preferredOrder && targetPrice >= preferredOrder.platinum
      ? buildWatchlistAlert(nextItem, preferredOrder)
      : null;

  return {
    watchlist: existingItem
      ? currentState.watchlist.map((entry) =>
          entry.id === existingItem.id
            ? {
                ...nextItem,
                retryCount: existingItem.retryCount,
                ignoredUserKeys: existingItem.ignoredUserKeys,
                linkedBuyOrderId: linkedBuyOrderId ?? existingItem.linkedBuyOrderId,
              }
            : entry,
        )
      : [...currentState.watchlist, nextItem],
    alerts: nextAlert
      ? [
          nextAlert,
          ...currentState.alerts.filter((alert) => alert.watchlistId !== nextItem.id),
        ]
      : currentState.alerts.filter((alert) => alert.watchlistId !== nextItem.id),
    selectedWatchlistId: existingItem?.id ?? nextItem.id,
    watchlistTargetInput: '',
    watchlistFormError: null,
  };
}

async function stopTrackedSelection(
  trackedSelection: { itemId: number; slug: string; variantKey: string } | null,
) {
  if (!trackedSelection) {
    return;
  }

  try {
    await stopMarketTracking(
      trackedSelection.itemId,
      trackedSelection.slug,
      trackedSelection.variantKey,
      'search',
    );
  } catch (error) {
    console.error('[market] failed to stop tracked search selection', error);
  }
}

async function loadQuickViewOrdersForSelection(
  item: WfmAutocompleteItem,
  variantKey: string | null,
  sellerMode: SellerMode,
): Promise<{ sellOrders: WfmTopSellOrder[]; apiVersion: string | null }> {
  const response = variantKey
    ? await getWfmTopSellOrdersForVariant(item.slug, variantKey, sellerMode)
    : await getWfmTopSellOrders(item.slug, sellerMode);

  return {
    sellOrders: response.sellOrders,
    apiVersion: response.apiVersion,
  };
}

async function loadQuickViewOrdersForBestVariant(
  item: WfmAutocompleteItem,
  variants: MarketVariant[],
  sellerMode: SellerMode,
): Promise<{
  variantKey: string | null;
  variantLabel: string | null;
  sellOrders: WfmTopSellOrder[];
  apiVersion: string | null;
}> {
  const orderedVariants = orderQuickViewVariants(variants);
  let fallbackVariant = orderedVariants[0] ?? null;
  let fallbackResponse: { sellOrders: WfmTopSellOrder[]; apiVersion: string | null } | null = null;

  for (const variant of orderedVariants) {
    const response = await loadQuickViewOrdersForSelection(item, variant.key, sellerMode);
    if (!fallbackResponse) {
      fallbackResponse = response;
      fallbackVariant = variant;
    }

    if (response.sellOrders.length > 0) {
      return {
        variantKey: variant.key,
        variantLabel: variant.label,
        sellOrders: response.sellOrders,
        apiVersion: response.apiVersion,
      };
    }
  }

  return {
    variantKey: fallbackVariant?.key ?? null,
    variantLabel: fallbackVariant?.label ?? null,
    sellOrders: fallbackResponse?.sellOrders ?? [],
    apiVersion: fallbackResponse?.apiVersion ?? null,
  };
}

async function syncSearchTrackingSelection(
  previousSelection: { itemId: number; slug: string; variantKey: string } | null,
  item: WfmAutocompleteItem,
  variantKey: string | null,
  sellerMode: SellerMode,
): Promise<{
  nextTrackedSelection: { itemId: number; slug: string; variantKey: string } | null;
  selectedVariantLabel: string | null;
}> {
  if (!variantKey) {
    await stopTrackedSelection(previousSelection);
    return {
      nextTrackedSelection: null,
      selectedVariantLabel: null,
    };
  }

  if (
    previousSelection &&
    previousSelection.itemId === item.itemId &&
    previousSelection.slug === item.slug &&
    previousSelection.variantKey === variantKey
  ) {
    return {
      nextTrackedSelection: previousSelection,
      selectedVariantLabel: variantKey.startsWith('rank:')
        ? `Rank ${variantKey.slice(5)}`
        : 'Base Market',
    };
  }

  await stopTrackedSelection(previousSelection);
  await ensureMarketTracking(item.itemId, item.slug, variantKey, sellerMode, 'search');
  const nextTrackedSelection = {
    itemId: item.itemId,
    slug: item.slug,
    variantKey,
  };

  return {
    nextTrackedSelection,
    selectedVariantLabel: variantKey.startsWith('rank:')
      ? `Rank ${variantKey.slice(5)}`
      : 'Base Market',
  };
}

async function persistSearchedItemSelection(
  previousSelection: { itemId: number; slug: string; variantKey: string } | null,
  item: WfmAutocompleteItem,
  sellerMode: SellerMode,
): Promise<{ itemId: number; slug: string; variantKey: string } | null> {
  const syncedSelection = await syncSearchTrackingSelection(
    previousSelection,
    item,
    'base',
    sellerMode,
  );

  return syncedSelection.nextTrackedSelection;
}

/** How long an underpriced-listing card lives before it's auto-removed (we can't see removals). */
export const UNDERPRICED_LISTING_TTL_MS = 5 * 60 * 1000;
const UNDERPRICED_LISTING_CAP = 60;

/** Hard cooldown between AlecaFrame relic refreshes (manual refresh bypasses it). */
const OWNED_RELICS_REFRESH_COOLDOWN_MS = 3 * 60 * 1000;

/** A request to open the Trades listing modal pre-filled (from an opportunity action button). */
export interface PendingTradeListing {
  orderType: 'sell' | 'buy';
  name: string;
  slug: string | null;
  rank: number | null;
  price: number | null;
}

/** A request to switch the Opportunities page's subtab from elsewhere (e.g. a "Farm" action). */
export type RequestedOpportunitiesTab =
  | 'opportunities'
  | 'farm-now'
  | 'owned-relics'
  | 'set-planner'
  | 'inventory';

/** A live underpriced listing as held in the store: the backend event plus UI/verify state. */
export interface UnderpricedListingCard extends UnderpricedListing {
  receivedAt: number;
  status: 'new' | 'verifying' | 'verified' | 'gone';
  verifiedPrice: number | null;
}

/** The single underpriced alert card shown in the notification bar. */
export interface UnderpricedAlertState {
  listing: UnderpricedListingCard;
  /** How many other notified underpriced listings arrived since this card was last cleared. */
  otherCount: number;
}

interface AppStore {
  activePage: PageId;
  setActivePage: (page: PageId) => void;

  homeSubTab: HomeSubTab;
  setHomeSubTab: (tab: HomeSubTab) => void;

  // Quality-of-life: clickable item names, back navigation, toasts, recents, ⌘K.
  openItemInQuickView: (item: ItemQuickViewTarget) => Promise<void>;
  navigationBack: NavigationSnapshot | null;
  goBack: () => void;
  recentItems: WfmAutocompleteItem[];
  toasts: AppToast[];
  pushToast: (message: string, tone?: AppToast['tone']) => void;
  dismissToast: (id: string) => void;
  searchFocusNonce: number;
  requestSearchFocus: () => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  settingsSidebarOpen: boolean;
  settingsSection: SettingsSection;
  alecaframeModalOpen: boolean;
  discordWebhookModalOpen: boolean;
  notificationsModalOpen: boolean;
  importExportModalOpen: boolean;
  languageModalOpen: boolean;
  // While true (during an import/export), background scans/polls pause so nothing writes
  // to the databases mid-operation.
  dataMaintenanceActive: boolean;
  setDataMaintenanceActive: (active: boolean) => void;
  // Display language (Phase 1: localizes item names via the catalog's per-language data).
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  /** Bumped when the language changes so worldstate hooks refetch localized data immediately. */
  worldstateEpoch: number;
  /** Localized item names keyed by wfmId and slug, for display across the UI. */
  itemNameMap: Record<string, string>;
  loadLocalizedNames: () => Promise<void>;
  /** True when WFStat data (item catalog enrichment and/or live worldstate) is being served
   * from cache because warframestat.us was unreachable at startup. Drives a dismissible banner;
   * resolves itself once WFStat is back online. */
  wfstatDataStale: boolean;
  notificationSettings: NotificationSettings;
  appSettings: AppSettings;
  walletSnapshot: WalletSnapshot;
  settingsLoading: boolean;
  walletLoading: boolean;
  settingsError: string | null;
  worldStateEvents: WfstatWorldStateEvent[];
  worldStateEventsLoading: boolean;
  worldStateEventsError: string | null;
  worldStateEventsNextRefreshAt: string | null;
  worldStateEventsLastUpdatedAt: string | null;
  worldStateAlerts: WfstatAlert[];
  worldStateAlertsLoading: boolean;
  worldStateAlertsError: string | null;
  worldStateAlertsNextRefreshAt: string | null;
  worldStateAlertsLastUpdatedAt: string | null;
  worldStateSortie: WfstatSortie | null;
  worldStateSortieLoading: boolean;
  worldStateSortieError: string | null;
  worldStateSortieNextRefreshAt: string | null;
  worldStateSortieLastUpdatedAt: string | null;
  worldStateArbitration: WfstatArbitration | null;
  worldStateArbitrationLoading: boolean;
  worldStateArbitrationError: string | null;
  worldStateArbitrationNextRefreshAt: string | null;
  worldStateArbitrationLastUpdatedAt: string | null;
  worldStateArchonHunt: WfstatArchonHunt | null;
  worldStateArchonHuntLoading: boolean;
  worldStateArchonHuntError: string | null;
  worldStateArchonHuntNextRefreshAt: string | null;
  worldStateArchonHuntLastUpdatedAt: string | null;
  worldStateFissures: WfstatFissure[];
  worldStateFissuresLoading: boolean;
  worldStateFissuresError: string | null;
  worldStateFissuresNextRefreshAt: string | null;
  worldStateFissuresLastUpdatedAt: string | null;
  worldStateNews: WfstatNewsItem[];
  worldStateFlashSales: WfstatFlashSale[];
  worldStateMarketNewsLoading: boolean;
  worldStateMarketNewsError: string | null;
  worldStateMarketNewsNextRefreshAt: string | null;
  worldStateMarketNewsLastUpdatedAt: string | null;
  worldStateInvasions: WfstatInvasion[];
  worldStateInvasionsLoading: boolean;
  worldStateInvasionsError: string | null;
  worldStateInvasionsNextRefreshAt: string | null;
  worldStateInvasionsLastUpdatedAt: string | null;
  worldStateSyndicateMissions: WfstatSyndicateMission[];
  worldStateSyndicateMissionsLoading: boolean;
  worldStateSyndicateMissionsError: string | null;
  worldStateSyndicateMissionsNextRefreshAt: string | null;
  worldStateSyndicateMissionsLastUpdatedAt: string | null;
  worldStateVoidTrader: WfstatVoidTrader | null;
  worldStateVoidTraderLoading: boolean;
  worldStateVoidTraderError: string | null;
  worldStateVoidTraderNextRefreshAt: string | null;
  worldStateVoidTraderLastUpdatedAt: string | null;
  // Recommended exit prices for Baro's inventory (item name → platinum). Scanned once per visit.
  voidTraderPrices: Record<string, number | null>;
  voidTraderPricesScannedFor: string | null;
  voidTraderPricesLoading: boolean;
  scanVoidTraderPricesIfNeeded: () => Promise<void>;
  // Reference worldstate sources (cycles / steel-path / nightwave / vault-trader), held generically.
  worldStateExtra: Record<WorldStateExtraKey, WorldStateExtraEntry>;
  refreshWorldStateExtra: (key: WorldStateExtraKey) => Promise<void>;
  openSettingsSidebar: (section?: SettingsSection) => void;
  closeSettingsSidebar: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  openAlecaframeModal: () => void;
  closeAlecaframeModal: () => void;
  openDiscordWebhookModal: () => void;
  closeDiscordWebhookModal: () => void;
  openNotificationsModal: () => void;
  closeNotificationsModal: () => void;
  openImportExportModal: () => void;
  closeImportExportModal: () => void;
  openLanguageModal: () => void;
  closeLanguageModal: () => void;
  setWfstatDataStale: (stale: boolean) => void;
  setNotificationSettings: (settings: NotificationSettings) => void;
  clearSettingsError: () => void;
  loadAppSettings: () => Promise<void>;
  refreshWalletSnapshot: () => Promise<void>;
  refreshWalletSnapshotSilently: () => Promise<void>;
  saveAlecaframeConfiguration: (input: AlecaframeSettingsInput) => Promise<void>;
  saveDiscordWebhookConfiguration: (input: DiscordWebhookSettingsInput) => Promise<void>;
  refreshWorldStateEvents: () => Promise<void>;
  refreshWorldStateAlerts: () => Promise<void>;
  refreshWorldStateSortie: () => Promise<void>;
  refreshWorldStateArbitration: () => Promise<void>;
  refreshWorldStateArchonHunt: () => Promise<void>;
  refreshWorldStateFissures: () => Promise<void>;
  refreshWorldStateMarketNews: () => Promise<void>;
  refreshWorldStateInvasions: () => Promise<void>;
  refreshWorldStateSyndicateMissions: () => Promise<void>;
  refreshWorldStateVoidTrader: () => Promise<void>;

  sellerMode: SellerMode;
  setSellerMode: (mode: SellerMode) => void;
  autoProfile: boolean;
  toggleAutoProfile: () => void;

  watchlist: WatchlistItem[];
  alerts: WatchlistAlert[];
  /** Signatures of alerts the user dismissed this session — suppresses the exact same alert from
   *  reappearing on refresh. Cleared on app restart (a fresh session re-alerts). */
  dismissedAlertKeys: Set<string>;
  systemAlerts: SystemAlert[];
  worldStateSystemAlertDismissed: boolean;
  selectedWatchlistId: string | null;
  watchlistTargetInput: string;
  watchlistFormError: string | null;
  watchlistActionError: string | null;
  setWatchlistActionError: (message: string | null) => void;
  setSelectedWatchlist: (id: string | null) => void;
  setWatchlistTargetInput: (val: string) => void;
  addSelectedQuickViewToWatchlist: () => void;
  addExplicitItemToWatchlist: (
    item: WfmAutocompleteItem,
    variantKey: string,
    variantLabel: string,
    targetPrice: number,
  ) => void;
  removeWatchlistItem: (id: string) => void;
  markWatchlistItemBought: (
    id: string,
    price: number,
  ) => Promise<{ confirmationMessage: string }>;
  handleDetectedTradeBuys: (buys: TradeDetectedBuy[]) => Promise<void>;
  dismissAlert: (id: string) => void;
  clearAllAlerts: () => void;
  markAlertNoResponse: (id: string) => void;
  dismissSystemAlert: (id: string) => void;
  clearAllSystemAlerts: () => void;
  showAppUpdateAvailable: (update: AppUpdateSummary) => void;
  installAppUpdate: () => Promise<void>;
  retryWorldStateSystemAlert: (sourceKeys: WorldStateEndpointKey[]) => Promise<void>;
  syncScannerStaleAlert: (scanFinishedAt: string | null) => void;
  refreshWatchlistItem: (id: string) => Promise<WatchlistRefreshResult>;
  /**
   * Ingests a realtime newOrder match pushed from the backend subscription. Raises/updates
   * the per-item alert (deduped) and reflects the live cheapest price. Returns true when a
   * new alert was triggered (so the caller can play the sound).
   */
  ingestRealtimeWatchlistOrder: (order: RealtimeWatchlistOrder) => boolean;

  // Underpriced-listings radar (Opportunities tab). Collected from the always-on firehose.
  underpricedListings: UnderpricedListingCard[];
  ingestUnderpricedListing: (listing: UnderpricedListing) => void;
  updateUnderpricedListing: (orderId: string, patch: Partial<UnderpricedListingCard>) => void;
  removeUnderpricedListing: (orderId: string) => void;
  pruneExpiredUnderpricedListings: () => void;
  // Single replaceable alert card shown in the notification bar for the latest notified
  // underpriced listing (so a ping always has a visible counterpart).
  underpricedAlert: UnderpricedAlertState | null;
  dismissUnderpricedAlert: () => void;

  // Opportunities board (the Set Decision Engine + future detectors). Computed cache-side.
  opportunities: Opportunity[];
  opportunitiesLoading: boolean;
  opportunitiesError: string | null;
  opportunitiesLoadedAt: number | null;
  loadCachedOpportunities: () => Promise<void>;
  refreshOpportunities: () => Promise<void>;
  // Pinned ("accepted") opportunities — kept on top, survive recomputes + app restarts, and update
  // in place when the recompute produces a newer card for the same subject.
  pinnedOpportunities: PinnedOpportunities;
  pinOpportunity: (opportunity: Opportunity) => void;
  unpinOpportunity: (subjectKey: string) => void;
  // Dismissed ("not interested") subjects — hidden for this session only (cleared on restart).
  dismissedOpportunityKeys: Set<string>;
  dismissOpportunity: (subjectKey: string) => void;
  restoreDismissedOpportunities: () => void;
  // In-app routing for opportunity action buttons.
  pendingTradeListing: PendingTradeListing | null;
  requestTradeListing: (req: PendingTradeListing) => void;
  clearPendingTradeListing: () => void;
  requestedOpportunitiesTab: RequestedOpportunitiesTab | null;
  requestedFarmNowSearch: string | null;
  requestOpportunitiesTab: (tab: RequestedOpportunitiesTab, search?: string) => void;
  clearRequestedOpportunitiesTab: () => void;
  openItemAnalysis: (target: ItemQuickViewTarget) => Promise<void>;

  // Owned relics — single source of truth in the store (persists across navigation). Display reads
  // the local SQLite cache; AlecaFrame refresh is cooldown-gated so we don't hammer/timeout it.
  ownedRelics: OwnedRelicEntry[];
  ownedRelicsUpdatedAt: string | null;
  ownedRelicsCacheLoaded: boolean;
  ownedRelicsLoading: boolean;
  ownedRelicsRefreshing: boolean;
  ownedRelicsError: string | null;
  ownedRelicsLastRefreshAt: number | null;
  loadOwnedRelicsCache: () => Promise<void>;
  refreshOwnedRelics: (force?: boolean) => Promise<void>;

  quickView: QuickViewSelection;
  marketVariants: MarketVariant[];
  marketVariantsLoading: boolean;
  marketVariantsError: string | null;
  selectedMarketVariantKey: string | null;
  selectedMarketVariantLabel: string | null;
  searchTrackingSource: {
    itemId: number;
    slug: string;
    variantKey: string;
  } | null;
  selectedMarketAnalysis: ItemAnalysisResponse | null;
  selectedMarketAnalysisLoading: boolean;
  selectedMarketAnalysisError: string | null;
  marketAnalysisCache: Record<string, ItemAnalysisResponse>;
  loadQuickViewItem: (item: WfmAutocompleteItem) => Promise<void>;
  setSelectedMarketVariantKey: (variantKey: string | null) => Promise<void>;
  loadSelectedMarketAnalysis: (options?: { force?: boolean }) => Promise<ItemAnalysisResponse | null>;

  tradeAccount: TradeAccountSummary | null;
  tradeAccountLoading: boolean;
  tradeAccountError: string | null;
  loadTradeAccount: () => Promise<void>;
  syncWatchlistTradeOverview: (overview: TradeOverview) => Promise<TradeOverview>;
  signInTradeAccount: (input: TradeSignInInput) => Promise<void>;
  signOutTradeAccount: () => Promise<void>;
  setTradeAccountStatus: (status: 'ingame' | 'online' | 'invisible') => Promise<void>;
  autoWatchlistBuyOrdersEnabled: boolean;
  setAutoWatchlistBuyOrdersEnabled: (enabled: boolean) => void;
  tradesSubTab: TradesSubTab;
  setTradesSubTab: (tab: TradesSubTab) => void;

  tradePeriod: TradePeriod;
  setTradePeriod: (p: TradePeriod) => void;

  marketSubTab: 'analysis' | 'analytics' | 'calibration';
  setMarketSubTab: (tab: 'analysis' | 'analytics' | 'calibration') => void;

  eventsSubTab: EventsSubTab;
  setEventsSubTab: (tab: EventsSubTab) => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  activePage: 'home',
  // Manual navigation clears the "back" target (openItemInQuickView sets activePage
  // directly, bypassing this, so its back target survives the redirect).
  setActivePage: (page) => set({ activePage: page, navigationBack: null }),

  homeSubTab: 'overview',
  setHomeSubTab: (tab) => set({ homeSubTab: tab }),

  navigationBack: null,
  recentItems: readPersistedRecentItems(),
  toasts: [],
  underpricedListings: [],
  underpricedAlert: null,
  opportunities: [],
  opportunitiesLoading: false,
  opportunitiesError: null,
  opportunitiesLoadedAt: null,
  pinnedOpportunities: loadPinnedOpportunities(),
  dismissedOpportunityKeys: new Set<string>(),
  pendingTradeListing: null,
  requestedOpportunitiesTab: null,
  requestedFarmNowSearch: null,
  ownedRelics: [],
  ownedRelicsUpdatedAt: null,
  ownedRelicsCacheLoaded: false,
  ownedRelicsLoading: false,
  ownedRelicsRefreshing: false,
  ownedRelicsError: null,
  ownedRelicsLastRefreshAt: null,
  searchFocusNonce: 0,
  requestSearchFocus: () => set((state) => ({ searchFocusNonce: state.searchFocusNonce + 1 })),
  pushToast: (message, tone = 'info') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({ toasts: [...state.toasts, { id, tone, message }] }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, 3600);
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  goBack: () => {
    const target = get().navigationBack;
    if (!target) {
      return;
    }
    set({
      activePage: target.activePage,
      homeSubTab: target.homeSubTab,
      marketSubTab: target.marketSubTab,
      navigationBack: null,
    });
  },
  openItemInQuickView: async (target) => {
    const state = get();

    // Resolve to a full autocomplete item. Most call sites already carry the itemId +
    // slug; if only a name/slug is available we look it up in the local catalog.
    let resolved: WfmAutocompleteItem | null = null;
    if (target.itemId != null && target.slug) {
      resolved = {
        itemId: target.itemId,
        wfmId: target.wfmId ?? null,
        name: target.name,
        slug: target.slug,
        maxRank: target.maxRank ?? null,
        itemFamily: target.itemFamily ?? null,
        imagePath: target.imagePath ?? null,
        bulkTradable: false,
      };
    } else {
      try {
        const catalog = await getAutocompleteCatalog();
        const needleSlug = target.slug?.trim().toLowerCase();
        const needleName = target.name.trim().toLowerCase();
        resolved =
          (needleSlug ? catalog.find((entry) => entry.slug.toLowerCase() === needleSlug) : undefined) ??
          catalog.find((entry) => entry.name.toLowerCase() === needleName) ??
          null;
      } catch (error) {
        console.error('[quick-view] failed to resolve item from catalog', error);
      }
    }

    if (!resolved) {
      get().pushToast(`Couldn't open "${target.name}".`, 'error');
      return;
    }

    // Capture where we came from so the user can go back (don't stack onto an existing
    // back target while already viewing items).
    set({
      navigationBack: {
        activePage: state.activePage,
        homeSubTab: state.homeSubTab,
        marketSubTab: state.marketSubTab,
      } satisfies NavigationSnapshot,
      activePage: 'home',
      homeSubTab: 'overview',
    });

    // Record in recents (most-recent first, deduped by slug).
    set((current) => {
      const withoutDuplicate = current.recentItems.filter((entry) => entry.slug !== resolved!.slug);
      const nextRecents = [resolved!, ...withoutDuplicate].slice(0, RECENT_ITEMS_LIMIT);
      writePersistedRecentItems(nextRecents);
      return { recentItems: nextRecents };
    });

    await get().loadQuickViewItem(resolved);
  },

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  settingsSidebarOpen: false,
  settingsSection: 'alecaframe',
  alecaframeModalOpen: false,
  discordWebhookModalOpen: false,
  notificationsModalOpen: false,
  importExportModalOpen: false,
  languageModalOpen: false,
  dataMaintenanceActive: false,
  setDataMaintenanceActive: (active) => set({ dataMaintenanceActive: active }),
  language: loadLanguage(),
  setLanguage: (language) => {
    saveLanguage(language);
    // Invalidate the cached item catalog so search/quick-view re-fetch localized names.
    autocompleteCatalogPromise = null;
    autocompleteCatalogLang = null;
    // Point warframestat.us worldstate fetches at the new language, then bump the epoch so the
    // worldstate hooks refetch immediately (rather than waiting for their next poll).
    void setWorldstateLanguage(wfstatLangCode(language)).catch(() => undefined);
    set((state) => ({ language, worldstateEpoch: state.worldstateEpoch + 1 }));
    void useAppStore.getState().loadLocalizedNames();
  },
  worldstateEpoch: 0,
  itemNameMap: {},
  loadLocalizedNames: async () => {
    try {
      const language = useAppStore.getState().language;
      const items = await getWfmAutocompleteItems(wfstatLangCode(language));
      const map: Record<string, string> = {};
      for (const item of items) {
        if (!item.name) {
          continue;
        }
        // Re-append the localized "Set" suffix for set items whose localized name dropped it.
        const name = applySetSuffix(language, item.slug, item.name);
        if (item.wfmId) {
          map[item.wfmId] = name;
        }
        if (item.slug) {
          map[item.slug] = name;
        }
      }
      set({ itemNameMap: map });
    } catch {
      // Keep the previous map on failure; names fall back to English per-row.
    }
  },
  wfstatDataStale: false,
  notificationSettings: loadNotificationSettings(),
  appSettings: defaultAppSettings,
  walletSnapshot: defaultWalletSnapshot,
  settingsLoading: false,
  walletLoading: false,
  settingsError: null,
  worldStateEvents: [],
  worldStateEventsLoading: false,
  worldStateEventsError: null,
  worldStateEventsNextRefreshAt: null,
  worldStateEventsLastUpdatedAt: null,
  worldStateAlerts: [],
  worldStateAlertsLoading: false,
  worldStateAlertsError: null,
  worldStateAlertsNextRefreshAt: null,
  worldStateAlertsLastUpdatedAt: null,
  worldStateSortie: null,
  worldStateSortieLoading: false,
  worldStateSortieError: null,
  worldStateSortieNextRefreshAt: null,
  worldStateSortieLastUpdatedAt: null,
  worldStateArbitration: null,
  worldStateArbitrationLoading: false,
  worldStateArbitrationError: null,
  worldStateArbitrationNextRefreshAt: null,
  worldStateArbitrationLastUpdatedAt: null,
  worldStateArchonHunt: null,
  worldStateArchonHuntLoading: false,
  worldStateArchonHuntError: null,
  worldStateArchonHuntNextRefreshAt: null,
  worldStateArchonHuntLastUpdatedAt: null,
  worldStateFissures: [],
  worldStateFissuresLoading: false,
  worldStateFissuresError: null,
  worldStateFissuresNextRefreshAt: null,
  worldStateFissuresLastUpdatedAt: null,
  worldStateNews: [],
  worldStateFlashSales: [],
  worldStateMarketNewsLoading: false,
  worldStateMarketNewsError: null,
  worldStateMarketNewsNextRefreshAt: null,
  worldStateMarketNewsLastUpdatedAt: null,
  worldStateInvasions: [],
  worldStateInvasionsLoading: false,
  worldStateInvasionsError: null,
  worldStateInvasionsNextRefreshAt: null,
  worldStateInvasionsLastUpdatedAt: null,
  worldStateSyndicateMissions: [],
  worldStateSyndicateMissionsLoading: false,
  worldStateSyndicateMissionsError: null,
  worldStateSyndicateMissionsNextRefreshAt: null,
  worldStateSyndicateMissionsLastUpdatedAt: null,
  worldStateVoidTrader: null,
  worldStateVoidTraderLoading: false,
  voidTraderPrices: {},
  voidTraderPricesScannedFor: null,
  voidTraderPricesLoading: false,
  worldStateVoidTraderError: null,
  worldStateVoidTraderNextRefreshAt: null,
  worldStateVoidTraderLastUpdatedAt: null,
  worldStateExtra: {
    cycles: emptyWorldStateExtraEntry(),
    'steel-path': emptyWorldStateExtraEntry(),
    nightwave: emptyWorldStateExtraEntry(),
    'vault-trader': emptyWorldStateExtraEntry(),
  },
  refreshWorldStateExtra: async (key) => {
    if (worldStateExtraRefreshPromises[key]) {
      return worldStateExtraRefreshPromises[key]!;
    }
    set((state) => ({
      worldStateExtra: {
        ...state.worldStateExtra,
        [key]: { ...state.worldStateExtra[key], loading: true },
      },
    }));

    const config = WORLDSTATE_EXTRA_CONFIG[key];
    worldStateExtraRefreshPromises[key] = (async () => {
      try {
        const payload = await config.fetch();
        const fetchedAt = new Date().toISOString();
        const nextRefreshAt = config.nextRefreshAt(payload);
        await persistWorldStateSnapshot(key, { payload, fetchedAt, nextRefreshAt });
        set((state) => ({
          worldStateExtra: {
            ...state.worldStateExtra,
            [key]: { payload, loading: false, error: null, nextRefreshAt, lastUpdatedAt: fetchedAt },
          },
        }));
      } catch (error) {
        // Keep the last-good payload on screen; retry on the standard backoff.
        const cached = await loadCachedWorldStateSnapshot(key, (value) => value);
        set((state) => {
          const existing = state.worldStateExtra[key];
          return {
            worldStateExtra: {
              ...state.worldStateExtra,
              [key]: {
                payload: existing.payload ?? cached?.payload ?? null,
                loading: false,
                error:
                  error instanceof Error ? error.message : 'Could not load worldstate data.',
                nextRefreshAt: new Date(Date.now() + WORLDSTATE_RETRY_DELAY_MS).toISOString(),
                lastUpdatedAt: existing.lastUpdatedAt ?? cached?.fetchedAt ?? null,
              },
            },
          };
        });
      } finally {
        worldStateExtraRefreshPromises[key] = null;
      }
    })();

    return worldStateExtraRefreshPromises[key]!;
  },
  openSettingsSidebar: (section = 'alecaframe') =>
    set({
      settingsSidebarOpen: true,
      settingsSection: section,
      alecaframeModalOpen: false,
      discordWebhookModalOpen: false,
      settingsError: null,
    }),
  closeSettingsSidebar: () =>
    set({
      settingsSidebarOpen: false,
      alecaframeModalOpen: false,
      discordWebhookModalOpen: false,
      settingsError: null,
    }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  openAlecaframeModal: () =>
    set({
      settingsSidebarOpen: true,
      settingsSection: 'alecaframe',
      alecaframeModalOpen: true,
      discordWebhookModalOpen: false,
      settingsError: null,
    }),
  closeAlecaframeModal: () => set({ alecaframeModalOpen: false, settingsError: null }),
  openDiscordWebhookModal: () =>
    set({
      settingsSidebarOpen: true,
      settingsSection: 'discord-webhook',
      alecaframeModalOpen: false,
      discordWebhookModalOpen: true,
      settingsError: null,
    }),
  closeDiscordWebhookModal: () =>
    set({ discordWebhookModalOpen: false, settingsError: null }),
  openNotificationsModal: () =>
    set({
      settingsSidebarOpen: true,
      alecaframeModalOpen: false,
      discordWebhookModalOpen: false,
      notificationsModalOpen: true,
      settingsError: null,
    }),
  closeNotificationsModal: () => set({ notificationsModalOpen: false }),
  openImportExportModal: () =>
    set({
      settingsSidebarOpen: true,
      settingsSection: 'import-export',
      alecaframeModalOpen: false,
      discordWebhookModalOpen: false,
      notificationsModalOpen: false,
      importExportModalOpen: true,
      settingsError: null,
    }),
  closeImportExportModal: () => set({ importExportModalOpen: false }),
  openLanguageModal: () =>
    set({
      settingsSidebarOpen: true,
      alecaframeModalOpen: false,
      discordWebhookModalOpen: false,
      notificationsModalOpen: false,
      importExportModalOpen: false,
      languageModalOpen: true,
      settingsError: null,
    }),
  closeLanguageModal: () => set({ languageModalOpen: false }),
  setWfstatDataStale: (stale) => set({ wfstatDataStale: stale }),
  setNotificationSettings: (settings) => {
    saveNotificationSettings(settings);
    set({ notificationSettings: settings });
  },
  clearSettingsError: () => set({ settingsError: null }),
  loadAppSettings: async () => {
    set({ settingsLoading: true, settingsError: null });

    try {
      const settings = await getAppSettings();
      set({
        appSettings: settings,
        settingsLoading: false,
        settingsError: null,
      });
    } catch (error) {
      set({
        settingsLoading: false,
        settingsError: formatSettingsErrorMessage('settings-load', error),
      });
    }
  },
  refreshWalletSnapshot: async () => {
    const previousSnapshot = get().walletSnapshot;
    set({ walletLoading: true });

    try {
      const snapshot = await refreshAlecaframeWalletSnapshot();
      set({
        walletSnapshot: snapshot,
        walletLoading: false,
      });
    } catch (error) {
      set({
        walletSnapshot: {
          ...previousSnapshot,
          enabled: previousSnapshot.enabled || get().appSettings.alecaframe.enabled,
          configured:
            previousSnapshot.configured || Boolean(get().appSettings.alecaframe.publicLink),
          errorMessage: formatSettingsErrorMessage('alecaframe-refresh', error),
        },
        walletLoading: false,
      });
    }
  },
  refreshWalletSnapshotSilently: async () => {
    if (backgroundWalletRefreshPromise) {
      return backgroundWalletRefreshPromise;
    }

    backgroundWalletRefreshPromise = (async () => {
      try {
        const snapshot = await refreshAlecaframeWalletSnapshot();
        set({ walletSnapshot: snapshot });
      } catch (error) {
        console.warn('[alecaframe] background wallet refresh failed', error);
        const previousSnapshot = get().walletSnapshot;
        set({
          walletSnapshot: {
            ...previousSnapshot,
            enabled: previousSnapshot.enabled || get().appSettings.alecaframe.enabled,
            configured:
              previousSnapshot.configured || Boolean(get().appSettings.alecaframe.publicLink),
            errorMessage: formatSettingsErrorMessage('alecaframe-refresh', error),
          },
        });
      } finally {
        backgroundWalletRefreshPromise = null;
      }
    })();

    return backgroundWalletRefreshPromise;
  },
  saveAlecaframeConfiguration: async (input) => {
    set({ settingsLoading: true, settingsError: null });

    try {
      const previousSnapshot = get().walletSnapshot;
      const settings = await saveAlecaframeSettings(input);
      set({
        appSettings: settings,
        settingsLoading: false,
        settingsError: null,
        alecaframeModalOpen: false,
        walletLoading: true,
      });

      try {
        const snapshot = await refreshAlecaframeWalletSnapshot();
        set({
          walletSnapshot: snapshot,
          walletLoading: false,
        });
      } catch (error) {
        set({
          walletSnapshot: {
            ...previousSnapshot,
            enabled: settings.alecaframe.enabled,
            configured: Boolean(settings.alecaframe.publicLink),
            usernameWhenPublic:
              settings.alecaframe.usernameWhenPublic ?? previousSnapshot.usernameWhenPublic,
            lastUpdate: settings.alecaframe.lastValidatedAt ?? previousSnapshot.lastUpdate,
            errorMessage: formatSettingsErrorMessage('alecaframe-refresh', error),
          },
          walletLoading: false,
        });
      }
    } catch (error) {
      set({
        settingsLoading: false,
        settingsError: formatSettingsErrorMessage('alecaframe-save', error),
      });
      throw error;
    }
  },
  saveDiscordWebhookConfiguration: async (input) => {
    set({ settingsLoading: true, settingsError: null });

    try {
      const settings = await saveDiscordWebhookSettings(input);
      set({
        appSettings: settings,
        settingsLoading: false,
        settingsError: null,
        discordWebhookModalOpen: false,
      });
    } catch (error) {
      set({
        settingsLoading: false,
        settingsError: formatSettingsErrorMessage('discord-webhook-save', error),
      });
      throw error;
    }
  },
  refreshWorldStateEvents: async () => {
    if (worldStateEventsRefreshPromise) {
      return worldStateEventsRefreshPromise;
    }

    set({ worldStateEventsLoading: true });

    worldStateEventsRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateEventsSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.events, {
          payload: snapshot.events,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateEvents: snapshot.events,
          worldStateEventsLoading: false,
          worldStateEventsError: null,
          worldStateEventsNextRefreshAt: snapshot.nextRefreshAt,
          worldStateEventsLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.events,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.events,
          restoreCachedWorldStateEvents,
        );

        set((state) => ({
          worldStateEvents: state.worldStateEvents.length > 0
            ? state.worldStateEvents
            : (cachedSnapshot?.payload ?? []),
          worldStateEventsLoading: false,
          worldStateEventsError: formatEventsErrorMessage('events-active-events', error, {
            lastAvailableAt: state.worldStateEventsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateEventsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateEventsLastUpdatedAt:
            state.worldStateEventsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.events,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData:
                state.worldStateEvents.length > 0 || (cachedSnapshot?.payload.length ?? 0) > 0,
            }),
          ),
        }));
      } finally {
        worldStateEventsRefreshPromise = null;
      }
    })();

    return worldStateEventsRefreshPromise;
  },
  refreshWorldStateAlerts: async () => {
    if (worldStateAlertsRefreshPromise) {
      return worldStateAlertsRefreshPromise;
    }

    set({ worldStateAlertsLoading: true });

    worldStateAlertsRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateAlertsSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.alerts, {
          payload: snapshot.alerts,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateAlerts: snapshot.alerts,
          worldStateAlertsLoading: false,
          worldStateAlertsError: null,
          worldStateAlertsNextRefreshAt: snapshot.nextRefreshAt,
          worldStateAlertsLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.alerts,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.alerts,
          restoreCachedWorldStateAlerts,
        );

        set((state) => ({
          worldStateAlerts: state.worldStateAlerts.length > 0
            ? state.worldStateAlerts
            : (cachedSnapshot?.payload ?? []),
          worldStateAlertsLoading: false,
          worldStateAlertsError: formatEventsErrorMessage('events-alerts', error, {
            lastAvailableAt: state.worldStateAlertsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateAlertsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateAlertsLastUpdatedAt:
            state.worldStateAlertsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.alerts,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData:
                state.worldStateAlerts.length > 0 || (cachedSnapshot?.payload.length ?? 0) > 0,
            }),
          ),
        }));
      } finally {
        worldStateAlertsRefreshPromise = null;
      }
    })();

    return worldStateAlertsRefreshPromise;
  },
  refreshWorldStateSortie: async () => {
    if (worldStateSortieRefreshPromise) {
      return worldStateSortieRefreshPromise;
    }

    set({ worldStateSortieLoading: true });

    worldStateSortieRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateSortieSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.sortie, {
          payload: snapshot.sortie,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateSortie: snapshot.sortie,
          worldStateSortieLoading: false,
          worldStateSortieError: null,
          worldStateSortieNextRefreshAt: snapshot.nextRefreshAt,
          worldStateSortieLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.sortie,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.sortie,
          restoreCachedWorldStateSortie,
        );

        set((state) => ({
          worldStateSortie: state.worldStateSortie ?? cachedSnapshot?.payload ?? null,
          worldStateSortieLoading: false,
          worldStateSortieError: formatEventsErrorMessage('events-sortie', error, {
            lastAvailableAt: state.worldStateSortieLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateSortieNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateSortieLastUpdatedAt:
            state.worldStateSortieLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.sortie,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData: state.worldStateSortie !== null || cachedSnapshot?.payload !== null,
            }),
          ),
        }));
      } finally {
        worldStateSortieRefreshPromise = null;
      }
    })();

    return worldStateSortieRefreshPromise;
  },
  refreshWorldStateArbitration: async () => {
    if (worldStateArbitrationRefreshPromise) {
      return worldStateArbitrationRefreshPromise;
    }

    set({ worldStateArbitrationLoading: true });

    worldStateArbitrationRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateArbitrationSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.arbitration, {
          payload: snapshot.arbitration,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateArbitration: snapshot.arbitration,
          worldStateArbitrationLoading: false,
          worldStateArbitrationError: null,
          worldStateArbitrationNextRefreshAt: snapshot.nextRefreshAt,
          worldStateArbitrationLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.arbitration,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.arbitration,
          restoreCachedWorldStateArbitration,
        );

        set((state) => ({
          worldStateArbitration: state.worldStateArbitration ?? cachedSnapshot?.payload ?? null,
          worldStateArbitrationLoading: false,
          worldStateArbitrationError: formatEventsErrorMessage('events-arbitration', error, {
            lastAvailableAt: state.worldStateArbitrationLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateArbitrationNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateArbitrationLastUpdatedAt:
            state.worldStateArbitrationLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.arbitration,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData:
                state.worldStateArbitration !== null || cachedSnapshot?.payload !== null,
            }),
          ),
        }));
      } finally {
        worldStateArbitrationRefreshPromise = null;
      }
    })();

    return worldStateArbitrationRefreshPromise;
  },
  refreshWorldStateArchonHunt: async () => {
    if (worldStateArchonHuntRefreshPromise) {
      return worldStateArchonHuntRefreshPromise;
    }

    set({ worldStateArchonHuntLoading: true });

    worldStateArchonHuntRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateArchonHuntSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.archonHunt, {
          payload: snapshot.archonHunt,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateArchonHunt: snapshot.archonHunt,
          worldStateArchonHuntLoading: false,
          worldStateArchonHuntError: null,
          worldStateArchonHuntNextRefreshAt: snapshot.nextRefreshAt,
          worldStateArchonHuntLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.archonHunt,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.archonHunt,
          restoreCachedWorldStateArchonHunt,
        );

        set((state) => ({
          worldStateArchonHunt: state.worldStateArchonHunt ?? cachedSnapshot?.payload ?? null,
          worldStateArchonHuntLoading: false,
          worldStateArchonHuntError: formatEventsErrorMessage('events-archon-hunt', error, {
            lastAvailableAt: state.worldStateArchonHuntLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateArchonHuntNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateArchonHuntLastUpdatedAt:
            state.worldStateArchonHuntLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.archonHunt,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData:
                state.worldStateArchonHunt !== null || cachedSnapshot?.payload !== null,
            }),
          ),
        }));
      } finally {
        worldStateArchonHuntRefreshPromise = null;
      }
    })();

    return worldStateArchonHuntRefreshPromise;
  },
  refreshWorldStateFissures: async () => {
    if (worldStateFissuresRefreshPromise) {
      return worldStateFissuresRefreshPromise;
    }

    set({ worldStateFissuresLoading: true });

    worldStateFissuresRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateFissuresSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.fissures, {
          payload: snapshot.fissures,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateFissures: snapshot.fissures,
          worldStateFissuresLoading: false,
          worldStateFissuresError: null,
          worldStateFissuresNextRefreshAt: snapshot.nextRefreshAt,
          worldStateFissuresLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.fissures,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.fissures,
          restoreCachedWorldStateFissures,
        );

        set((state) => ({
          worldStateFissures: state.worldStateFissures.length > 0
            ? state.worldStateFissures
            : (cachedSnapshot?.payload ?? []),
          worldStateFissuresLoading: false,
          worldStateFissuresError: formatEventsErrorMessage('events-fissures', error, {
            lastAvailableAt: state.worldStateFissuresLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateFissuresNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateFissuresLastUpdatedAt:
            state.worldStateFissuresLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.fissures,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData:
                state.worldStateFissures.length > 0 || (cachedSnapshot?.payload.length ?? 0) > 0,
            }),
          ),
        }));
      } finally {
        worldStateFissuresRefreshPromise = null;
      }
    })();

    return worldStateFissuresRefreshPromise;
  },
  refreshWorldStateMarketNews: async () => {
    if (worldStateMarketNewsRefreshPromise) {
      return worldStateMarketNewsRefreshPromise;
    }

    set({ worldStateMarketNewsLoading: true });

    worldStateMarketNewsRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateMarketNewsSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.marketNews, {
          payload: {
            news: snapshot.news,
            flashSales: snapshot.flashSales,
          },
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateNews: snapshot.news,
          worldStateFlashSales: snapshot.flashSales,
          worldStateMarketNewsLoading: false,
          worldStateMarketNewsError: null,
          worldStateMarketNewsNextRefreshAt: snapshot.nextRefreshAt,
          worldStateMarketNewsLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.marketNews,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.marketNews,
          restoreCachedWorldStateMarketNews,
        );

        set((state) => ({
          worldStateNews:
            state.worldStateNews.length > 0 ? state.worldStateNews : (cachedSnapshot?.payload.news ?? []),
          worldStateFlashSales:
            state.worldStateFlashSales.length > 0
              ? state.worldStateFlashSales
              : (cachedSnapshot?.payload.flashSales ?? []),
          worldStateMarketNewsLoading: false,
          worldStateMarketNewsError: formatEventsErrorMessage('events-market-news', error, {
            lastAvailableAt: state.worldStateMarketNewsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateMarketNewsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateMarketNewsLastUpdatedAt:
            state.worldStateMarketNewsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.marketNews,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData:
                state.worldStateNews.length > 0 ||
                state.worldStateFlashSales.length > 0 ||
                (cachedSnapshot?.payload.news.length ?? 0) > 0 ||
                (cachedSnapshot?.payload.flashSales.length ?? 0) > 0,
            }),
          ),
        }));
      } finally {
        worldStateMarketNewsRefreshPromise = null;
      }
    })();

    return worldStateMarketNewsRefreshPromise;
  },
  refreshWorldStateInvasions: async () => {
    if (worldStateInvasionsRefreshPromise) {
      return worldStateInvasionsRefreshPromise;
    }

    set({ worldStateInvasionsLoading: true });

    worldStateInvasionsRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateInvasionsSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.invasions, {
          payload: snapshot.invasions,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateInvasions: snapshot.invasions,
          worldStateInvasionsLoading: false,
          worldStateInvasionsError: null,
          worldStateInvasionsNextRefreshAt: snapshot.nextRefreshAt,
          worldStateInvasionsLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.invasions,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.invasions,
          restoreCachedWorldStateInvasions,
        );

        set((state) => ({
          worldStateInvasions: state.worldStateInvasions.length > 0
            ? state.worldStateInvasions
            : (cachedSnapshot?.payload ?? []),
          worldStateInvasionsLoading: false,
          worldStateInvasionsError: formatEventsErrorMessage('events-invasions', error, {
            lastAvailableAt: state.worldStateInvasionsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateInvasionsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateInvasionsLastUpdatedAt:
            state.worldStateInvasionsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.invasions,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData:
                state.worldStateInvasions.length > 0 || (cachedSnapshot?.payload.length ?? 0) > 0,
            }),
          ),
        }));
      } finally {
        worldStateInvasionsRefreshPromise = null;
      }
    })();

    return worldStateInvasionsRefreshPromise;
  },
  refreshWorldStateSyndicateMissions: async () => {
    if (worldStateSyndicateMissionsRefreshPromise) {
      return worldStateSyndicateMissionsRefreshPromise;
    }

    set({ worldStateSyndicateMissionsLoading: true });

    worldStateSyndicateMissionsRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateSyndicateMissionsSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.syndicateMissions, {
          payload: snapshot.syndicateMissions,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateSyndicateMissions: snapshot.syndicateMissions,
          worldStateSyndicateMissionsLoading: false,
          worldStateSyndicateMissionsError: null,
          worldStateSyndicateMissionsNextRefreshAt: snapshot.nextRefreshAt,
          worldStateSyndicateMissionsLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.syndicateMissions,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.syndicateMissions,
          restoreCachedWorldStateSyndicateMissions,
        );

        set((state) => ({
          worldStateSyndicateMissions: state.worldStateSyndicateMissions.length > 0
            ? state.worldStateSyndicateMissions
            : (cachedSnapshot?.payload ?? []),
          worldStateSyndicateMissionsLoading: false,
          worldStateSyndicateMissionsError: formatEventsErrorMessage('events-syndicate-missions', error, {
            lastAvailableAt: state.worldStateSyndicateMissionsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateSyndicateMissionsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateSyndicateMissionsLastUpdatedAt:
            state.worldStateSyndicateMissionsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.syndicateMissions,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData:
                state.worldStateSyndicateMissions.length > 0 ||
                (cachedSnapshot?.payload.length ?? 0) > 0,
            }),
          ),
        }));
      } finally {
        worldStateSyndicateMissionsRefreshPromise = null;
      }
    })();

    return worldStateSyndicateMissionsRefreshPromise;
  },
  refreshWorldStateVoidTrader: async () => {
    if (worldStateVoidTraderRefreshPromise) {
      return worldStateVoidTraderRefreshPromise;
    }

    set({ worldStateVoidTraderLoading: true });

    worldStateVoidTraderRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateVoidTraderSnapshot();
        await persistWorldStateSnapshot(WORLDSTATE_ENDPOINT_KEYS.voidTrader, {
          payload: snapshot.voidTrader,
          fetchedAt: snapshot.fetchedAt,
          nextRefreshAt: snapshot.nextRefreshAt,
        });
        set({
          worldStateVoidTrader: snapshot.voidTrader,
          worldStateVoidTraderLoading: false,
          worldStateVoidTraderError: null,
          worldStateVoidTraderNextRefreshAt: snapshot.nextRefreshAt,
          worldStateVoidTraderLastUpdatedAt: snapshot.fetchedAt,
          worldStateSystemAlertDismissed: false,
        });
        set((state) => ({
          systemAlerts: clearWorldStateSystemAlertSource(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.voidTrader,
          ),
        }));
      } catch (error) {
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.voidTrader,
          restoreCachedWorldStateVoidTrader,
        );

        set((state) => ({
          worldStateVoidTrader: state.worldStateVoidTrader ?? cachedSnapshot?.payload ?? null,
          worldStateVoidTraderLoading: false,
          worldStateVoidTraderError: formatEventsErrorMessage('events-void-trader', error, {
            lastAvailableAt: state.worldStateVoidTraderLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          }),
          worldStateVoidTraderNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateVoidTraderLastUpdatedAt:
            state.worldStateVoidTraderLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.voidTrader,
            shouldCreateWorldStateOfflineAlert({
              dismissed: state.worldStateSystemAlertDismissed,
              hasUsableData: state.worldStateVoidTrader !== null || cachedSnapshot?.payload !== null,
            }),
          ),
        }));
      } finally {
        worldStateVoidTraderRefreshPromise = null;
      }
    })();

    return worldStateVoidTraderRefreshPromise;
  },
  scanVoidTraderPricesIfNeeded: async () => {
    const state = get();
    const voidTrader = state.worldStateVoidTrader;
    // Only scan while Baro is actually present (he has inventory) and not yet scanned this visit.
    if (
      !voidTrader ||
      voidTrader.inventory.length === 0 ||
      state.voidTraderPricesLoading ||
      state.voidTraderPricesScannedFor === voidTrader.id
    ) {
      return;
    }

    set({ voidTraderPricesLoading: true });
    try {
      const names = voidTrader.inventory.map((entry) => entry.item);
      const results = await scanVoidTraderPrices(names);
      const prices: Record<string, number | null> = {};
      for (const result of results) {
        prices[result.item] = result.recommendedExitPrice;
      }
      set({
        voidTraderPrices: prices,
        voidTraderPricesScannedFor: voidTrader.id,
        voidTraderPricesLoading: false,
      });
    } catch (error) {
      console.error('[void-trader] failed to scan inventory prices', error);
      set({ voidTraderPricesLoading: false });
    }
  },

  sellerMode: 'ingame',
  setSellerMode: (mode) => {
    const state = get();
    if (state.sellerMode === mode) {
      return;
    }

    const selectedItem = state.quickView.selectedItem;
    const selectedVariantKey = state.selectedMarketVariantKey;
    set({
      sellerMode: mode,
      selectedMarketAnalysis:
        selectedItem && selectedVariantKey
          ? state.marketAnalysisCache[
              buildMarketAnalysisCacheKey(selectedItem.itemId, selectedVariantKey, mode)
            ] ?? null
          : null,
      selectedMarketAnalysisLoading: false,
      selectedMarketAnalysisError: null,
    });

    if (selectedItem && selectedVariantKey) {
      void get().setSelectedMarketVariantKey(selectedVariantKey);
      void get().loadSelectedMarketAnalysis({ force: true });
    }
  },
  autoProfile: false,
  toggleAutoProfile: () => set((s) => ({ autoProfile: !s.autoProfile })),

  watchlist: restoredWatchlist,
  alerts: [],
  dismissedAlertKeys: new Set<string>(),
  systemAlerts: [],
  worldStateSystemAlertDismissed: false,
  selectedWatchlistId: restoredSelectedWatchlistId,
  watchlistTargetInput: '',
  watchlistFormError: null,
  watchlistActionError: null,
  setWatchlistActionError: (message) => set({ watchlistActionError: message }),
  setSelectedWatchlist: (id) => {
    set({ selectedWatchlistId: id });
    writePersistedWatchlistState(get().watchlist, id);
  },
  setWatchlistTargetInput: (val) =>
    set({
      watchlistTargetInput: sanitizePositiveIntegerInput(val),
      watchlistFormError: null,
    }),
  addSelectedQuickViewToWatchlist: () => {
    const state = get();
    const selectedItem = state.quickView.selectedItem;
    const selectedVariantKey = state.selectedMarketVariantKey;
    const selectedVariantLabel = state.selectedMarketVariantLabel;

    if (!selectedItem) {
      set({
        watchlistFormError: 'Search and load a WFM item before adding it to the watchlist.',
      });
      return;
    }

    if (state.marketVariants.length > 1 && !selectedVariantKey) {
      set({
        watchlistFormError: 'Select a rank variant before adding this item to the watchlist.',
      });
      return;
    }

    const targetPrice = parsePositiveWholeNumber(state.watchlistTargetInput);
    if (targetPrice === null) {
      set({ watchlistFormError: 'Enter a positive whole-number desired price.' });
      return;
    }

    const variantKey = selectedVariantKey ?? 'base';
    const variantLabel = selectedVariantLabel ?? 'Base Market';
    const existingItem = state.watchlist.find(
      (item) => item.slug === selectedItem.slug && item.variantKey === variantKey,
    );
    const preferredOrder = selectPreferredWatchlistOrder(
      state.quickView.sellOrders,
      existingItem?.ignoredUserKeys ?? [],
    );
    set((currentState) => {
      const nextState = buildWatchlistUpdateState(
        currentState,
        selectedItem,
        variantKey,
        variantLabel,
        targetPrice,
        preferredOrder,
        existingItem?.linkedBuyOrderId ?? null,
      );
      writePersistedWatchlistState(nextState.watchlist, nextState.selectedWatchlistId);
      return nextState;
    });

    void ensureMarketTracking(
      selectedItem.itemId,
      selectedItem.slug,
      variantKey,
      state.sellerMode,
      'watchlist',
    ).catch(
      (error) => {
        console.error('[watchlist] failed to start tracking item', error);
      },
    );

    if (state.tradeAccount && state.autoWatchlistBuyOrdersEnabled) {
      void syncWatchlistBuyOrder(
        selectedItem,
        variantKey,
        targetPrice,
        state.sellerMode,
        existingItem?.linkedBuyOrderId ?? null,
      )
        .then((linkedBuyOrderId) => {
          set((currentState) => {
            const nextWatchlist = currentState.watchlist.map((entry) =>
              entry.id === `${buildWatchlistId(selectedItem)}:${variantKey}`
                ? { ...entry, linkedBuyOrderId }
                : entry,
            );
            writePersistedWatchlistState(nextWatchlist, currentState.selectedWatchlistId);
            return { watchlist: nextWatchlist };
          });
        })
        .catch((error) => {
          console.error('[watchlist] failed to sync buy order', error);
          set({
            watchlistFormError: formatHomeErrorMessage('watchlist-buy-sync', error),
          });
        });
    }
  },
  addExplicitItemToWatchlist: (item, variantKey, variantLabel, targetPrice) => {
    if (!Number.isInteger(targetPrice) || targetPrice <= 0) {
      set({ watchlistFormError: 'Enter a positive whole-number desired price.' });
      return;
    }

    void getWfmTopSellOrdersForVariant(item.slug, variantKey, get().sellerMode)
      .then((response) => {
        const preferredOrder = selectPreferredWatchlistOrder(response.sellOrders, []);
        set((currentState) => {
          const nextState = buildWatchlistUpdateState(
            currentState,
            item,
            variantKey,
            variantLabel,
            targetPrice,
            preferredOrder,
            currentState.watchlist.find(
              (entry) => entry.slug === item.slug && entry.variantKey === variantKey,
            )?.linkedBuyOrderId ?? null,
          );
          writePersistedWatchlistState(nextState.watchlist, nextState.selectedWatchlistId);
          return nextState;
        });
        const latestState = get();
        const existingItem = latestState.watchlist.find(
          (entry) => entry.slug === item.slug && entry.variantKey === variantKey,
        );

        const trackingPromise = ensureMarketTracking(
          item.itemId,
          item.slug,
          variantKey,
          latestState.sellerMode,
          'watchlist',
        );
        const orderPromise =
          latestState.tradeAccount && latestState.autoWatchlistBuyOrdersEnabled
            ? syncWatchlistBuyOrder(
                item,
                variantKey,
                targetPrice,
                latestState.sellerMode,
                existingItem?.linkedBuyOrderId ?? null,
              ).then((linkedBuyOrderId) => {
                set((currentState) => {
                  const nextWatchlist = currentState.watchlist.map((entry) =>
                    entry.id === `${buildWatchlistId(item)}:${variantKey}`
                      ? { ...entry, linkedBuyOrderId }
                      : entry,
                  );
                  writePersistedWatchlistState(nextWatchlist, currentState.selectedWatchlistId);
                  return { watchlist: nextWatchlist };
                });
              })
            : Promise.resolve();

        return Promise.all([trackingPromise, orderPromise]);
      })
      .catch((error) => {
        console.error('[watchlist] failed to add explicit item', error);
        const message = formatHomeErrorMessage('watchlist-add', error);
        set({ watchlistFormError: message });
        // Surface the failure everywhere (Opportunities/Scanners don't render
        // watchlistFormError), so an add that silently failed isn't mistaken for success.
        get().pushToast(message, 'error');
      });
  },
  removeWatchlistItem: (id) => {
    const state = get();
    watchlistRefreshGenerations.delete(id);
    const itemToRemove = state.watchlist.find((item) => item.id === id);
    if (itemToRemove) {
      void stopMarketTracking(
        itemToRemove.itemId,
        itemToRemove.slug,
        itemToRemove.variantKey,
        'watchlist',
      ).catch((error) => {
        console.error('[watchlist] failed to stop tracking item', error);
      });
      if (itemToRemove.linkedBuyOrderId) {
        void removeWatchlistBuyOrder(itemToRemove.linkedBuyOrderId, state.sellerMode).catch(
          (error) => {
            console.error('[watchlist] failed to remove linked buy order', error);
            // Surface it: the item is gone from the watchlist, but its WFM buy order may
            // still be live, so the user can clean it up manually.
            set({
              watchlistActionError: `Removed ${itemToRemove.displayName} from the watchlist, but its linked Warframe.Market buy order may still be live — check your buy orders in the Trades tab.`,
            });
          },
        );
      }
    }

    set((currentState) => {
      const nextWatchlist = currentState.watchlist.filter((item) => item.id !== id);
      const nextSelectedWatchlistId =
        currentState.selectedWatchlistId === id
          ? nextWatchlist[0]?.id ?? null
          : currentState.selectedWatchlistId;
      writePersistedWatchlistState(nextWatchlist, nextSelectedWatchlistId);
      return {
        watchlist: nextWatchlist,
        alerts: currentState.alerts.filter((alert) => alert.watchlistId !== id),
        selectedWatchlistId: nextSelectedWatchlistId,
        watchlistFormError: null,
        // Clear any stale orphaned-order notice; the async buy-order removal above will
        // re-set it only if this removal's cleanup actually fails.
        watchlistActionError: null,
      };
    });
  },
  markWatchlistItemBought: async (id, price) => {
    try {
      const state = get();
      const item = state.watchlist.find((entry) => entry.id === id);
      if (!item) {
        throw new Error('That watchlist item could not be found.');
      }

      const normalizedPrice = Math.max(1, Math.round(price));
      if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
        throw new Error('Bought price must be greater than zero.');
      }

      const expectedRank = deriveVariantRankFromKey(item.variantKey);
      const clearLinkedBuyOrder = () => {
        set((currentState) => {
          const nextWatchlist = clearLinkedBuyOrderFromWatchlistState(currentState.watchlist, id);
          if (isSameWatchlistSequence(nextWatchlist, currentState.watchlist)) {
            return currentState;
          }

          writePersistedWatchlistState(nextWatchlist, currentState.selectedWatchlistId);
          return { watchlist: nextWatchlist };
        });
      };

      if (state.tradeAccount) {
        const activeOverview = await getWfmTradeOverview(state.sellerMode);
        const activeBuyOrder = findActiveWatchlistBuyOrder(item, activeOverview.buyOrders);

        if (activeBuyOrder) {
          let latestOverview = activeOverview;
          if (
            !isBuyOrderConfirmedForPurchase({
              order: activeBuyOrder,
              expectedPrice: normalizedPrice,
              expectedRank,
            })
          ) {
            latestOverview = await updateWfmBuyOrder(
              {
                orderId: activeBuyOrder.orderId,
                price: normalizedPrice,
                quantity: 1,
                rank: expectedRank,
                visible: true,
              },
              state.sellerMode,
            );
            latestOverview = await confirmWatchlistBuyOrderReadyForClose({
              overview: latestOverview,
              orderId: activeBuyOrder.orderId,
              expectedPrice: normalizedPrice,
              expectedRank,
              sellerMode: state.sellerMode,
            });
          }

          await closeWfmBuyOrder(activeBuyOrder.orderId, 1, state.sellerMode);
          clearLinkedBuyOrder();
          get().removeWatchlistItem(id);
          return { confirmationMessage: 'Item has been marked as bought.' };
        }

        const cachedTradeLog = await getCachedWfmProfileTradeLog(state.tradeAccount.name).catch(
          () => null,
        );
        if (
          cachedTradeLog
          && hasRecentClosedBuyTradeAtPrice(
            item,
            normalizedPrice,
            cachedTradeLog.entries,
            Date.now(),
          )
        ) {
          clearLinkedBuyOrder();
          get().removeWatchlistItem(id);
          return { confirmationMessage: 'Item has been marked as bought.' };
        }

        const resolvedItem = await resolveWatchlistWfmIdentity(
          buildAutocompleteItemFromWatchlistEntry(item),
        );
        if (resolvedItem.wfmId) {
          const createdOverview = await createWfmBuyOrder(
            {
              wfmId: resolvedItem.wfmId,
              price: normalizedPrice,
              quantity: 1,
              rank: expectedRank,
              visible: true,
            },
            state.sellerMode,
          );
          const createdOrderId =
            findMatchingBuyOrderId(resolvedItem, item.variantKey, normalizedPrice, createdOverview);
          if (!createdOrderId) {
            throw new Error('Created the buy order but could not confirm it before closing.');
          }
          await confirmWatchlistBuyOrderReadyForClose({
            overview: createdOverview,
            orderId: createdOrderId,
            expectedPrice: normalizedPrice,
            expectedRank,
            sellerMode: state.sellerMode,
          });

          await closeWfmBuyOrder(createdOrderId, 1, state.sellerMode);
        }
      }

      clearLinkedBuyOrder();
      get().removeWatchlistItem(id);
      return { confirmationMessage: 'Item has been marked as bought.' };
    } catch (error) {
      throw new Error(formatHomeErrorMessage('watchlist-mark-bought', error));
    }
  },
  handleDetectedTradeBuys: async (buys) => {
    if (!buys.length) {
      return;
    }

    const processed = new Set<string>();
    for (const buy of buys) {
      const latestState = get();
      const pricePerUnit = Math.max(1, Math.round(buy.platinum / Math.max(1, buy.quantity)));
      const matches = latestState.watchlist.filter((entry) => {
        if (entry.slug !== buy.slug) {
          return false;
        }
        return deriveVariantRankFromKey(entry.variantKey) === buy.rank;
      });

      for (const match of matches) {
        if (processed.has(match.id)) {
          continue;
        }
        try {
          await get().markWatchlistItemBought(match.id, pricePerUnit);
          processed.add(match.id);
        } catch (error) {
          console.error('[watchlist] failed to auto-handle detected buy', error);
        }
      }
    }
  },
  dismissAlert: (id) =>
    set((state) => {
      const alert = state.alerts.find((entry) => entry.id === id);
      if (!alert) {
        return state;
      }
      // Remember the dismissal so this exact item/seller/price can't re-trigger on refresh.
      const dismissedAlertKeys = new Set(state.dismissedAlertKeys);
      dismissedAlertKeys.add(watchlistAlertSignature(alert));
      return {
        alerts: state.alerts.filter((entry) => entry.id !== id),
        dismissedAlertKeys,
      };
    }),
  clearAllAlerts: () =>
    set((state) => {
      // Treat "clear all" as dismissing each — none of them should pop straight back.
      const dismissedAlertKeys = new Set(state.dismissedAlertKeys);
      for (const alert of state.alerts) {
        dismissedAlertKeys.add(watchlistAlertSignature(alert));
      }
      return { alerts: [], dismissedAlertKeys };
    }),
  markAlertNoResponse: (id) =>
    set((state) => {
      const alert = state.alerts.find((entry) => entry.id === id);
      if (!alert) {
        return state;
      }

      const ignoredUserKey = buildWatchlistUserKey(alert.username, alert.userSlug);

      return {
        alerts: state.alerts.filter((entry) => entry.id !== id),
        watchlist: (() => {
          const nextWatchlist = state.watchlist.map((item) =>
          item.id === alert.watchlistId
            ? {
                ...item,
                ignoredUserKeys: item.ignoredUserKeys.includes(ignoredUserKey)
                  ? item.ignoredUserKeys
                  : [...item.ignoredUserKeys, ignoredUserKey],
                nextScanAt: Date.now(),
                lastError: null,
              }
            : item,
          );
          writePersistedWatchlistState(nextWatchlist, state.selectedWatchlistId);
          return nextWatchlist;
        })(),
      };
    }),
  dismissSystemAlert: (id) =>
    set((state) => {
      if (id === APP_UPDATE_SYSTEM_ALERT_ID) {
        void clearPendingAppUpdate();
      }

      // Remember the dismissed stale scan so it isn't re-added/re-notified this session.
      if (id === SCANNER_STALE_SYSTEM_ALERT_ID) {
        const staleAlert = state.systemAlerts.find(
          (alert) => alert.id === SCANNER_STALE_SYSTEM_ALERT_ID,
        );
        if (staleAlert) {
          dismissedScannerStaleScans.add(staleAlert.createdAt);
        }
      }

      return {
        systemAlerts: state.systemAlerts.filter((alert) => alert.id !== id),
        worldStateSystemAlertDismissed:
          id === WORLDSTATE_SYSTEM_ALERT_ID ? true : state.worldStateSystemAlertDismissed,
      };
    }),
  clearAllSystemAlerts: () =>
    set((state) => {
      if (state.systemAlerts.some((alert) => alert.id === APP_UPDATE_SYSTEM_ALERT_ID)) {
        void clearPendingAppUpdate();
      }

      const staleAlert = state.systemAlerts.find(
        (alert) => alert.id === SCANNER_STALE_SYSTEM_ALERT_ID,
      );
      if (staleAlert) {
        dismissedScannerStaleScans.add(staleAlert.createdAt);
      }

      return {
        systemAlerts: [],
        worldStateSystemAlertDismissed:
          state.systemAlerts.some((alert) => alert.id === WORLDSTATE_SYSTEM_ALERT_ID)
            ? true
            : state.worldStateSystemAlertDismissed,
      };
    }),
  showAppUpdateAvailable: (update) =>
    set((state) => ({
      systemAlerts: upsertAppUpdateSystemAlert(state.systemAlerts, {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.notes,
        installState: 'available',
      }),
    })),
  installAppUpdate: async () => {
    const existingAlert = get().systemAlerts.find((alert) => alert.id === APP_UPDATE_SYSTEM_ALERT_ID);
    if (!existingAlert?.updateVersion || !existingAlert.currentVersion) {
      throw new Error('No pending app update was found.');
    }

    let totalBytes: number | null = null;
    let downloadedBytes = 0;

    set((state) => ({
      systemAlerts: upsertAppUpdateSystemAlert(state.systemAlerts, {
        version: existingAlert.updateVersion ?? 'Unknown',
        currentVersion: existingAlert.currentVersion ?? 'Unknown',
        notes: existingAlert.releaseNotes ?? null,
        installState: 'downloading',
        progressPercent: 0,
      }),
    }));

    try {
      await installPendingAppUpdate((event) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength ?? null;
          downloadedBytes = 0;
          set((state) => ({
            systemAlerts: upsertAppUpdateSystemAlert(state.systemAlerts, {
              version: existingAlert.updateVersion ?? 'Unknown',
              currentVersion: existingAlert.currentVersion ?? 'Unknown',
              notes: existingAlert.releaseNotes ?? null,
              installState: 'downloading',
              progressPercent: 0,
            }),
          }));
          return;
        }

        if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength;
          const progressPercent = totalBytes && totalBytes > 0
            ? Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)))
            : null;
          set((state) => ({
            systemAlerts: upsertAppUpdateSystemAlert(state.systemAlerts, {
              version: existingAlert.updateVersion ?? 'Unknown',
              currentVersion: existingAlert.currentVersion ?? 'Unknown',
              notes: existingAlert.releaseNotes ?? null,
              installState: 'downloading',
              progressPercent,
            }),
          }));
          return;
        }

        set((state) => ({
          systemAlerts: upsertAppUpdateSystemAlert(state.systemAlerts, {
            version: existingAlert.updateVersion ?? 'Unknown',
            currentVersion: existingAlert.currentVersion ?? 'Unknown',
            notes: existingAlert.releaseNotes ?? null,
            installState: 'installing',
            progressPercent: 100,
          }),
        }));
      });

      void clearPendingAppUpdate();
      set((state) => ({
        systemAlerts: state.systemAlerts.filter((alert) => alert.id !== APP_UPDATE_SYSTEM_ALERT_ID),
      }));
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      set((state) => ({
        systemAlerts: upsertAppUpdateSystemAlert(state.systemAlerts, {
          version: existingAlert.updateVersion ?? 'Unknown',
          currentVersion: existingAlert.currentVersion ?? 'Unknown',
          notes: existingAlert.releaseNotes ?? null,
          installState: 'error',
          errorMessage,
        }),
      }));
      throw error;
    }
  },
  retryWorldStateSystemAlert: async (sourceKeys) => {
    const uniqueSourceKeys = [...new Set(sourceKeys)];

    set({ worldStateSystemAlertDismissed: false });

    await Promise.allSettled(
      uniqueSourceKeys.map(async (sourceKey) => {
        const latestState = get();

        switch (sourceKey) {
          case 'events':
            await latestState.refreshWorldStateEvents();
            break;
          case 'alerts':
            await latestState.refreshWorldStateAlerts();
            break;
          case 'sortie':
            await latestState.refreshWorldStateSortie();
            break;
          case 'arbitration':
            await latestState.refreshWorldStateArbitration();
            break;
          case 'archon-hunt':
            await latestState.refreshWorldStateArchonHunt();
            break;
          case 'fissures':
            await latestState.refreshWorldStateFissures();
            break;
          case 'market-news':
            await latestState.refreshWorldStateMarketNews();
            break;
          case 'invasions':
            await latestState.refreshWorldStateInvasions();
            break;
          case 'syndicate-missions':
            await latestState.refreshWorldStateSyndicateMissions();
            break;
          case 'void-trader':
            await latestState.refreshWorldStateVoidTrader();
            break;
        }
      }),
    );
  },
  syncScannerStaleAlert: (scanFinishedAt) =>
    set((state) => ({
      systemAlerts: upsertScannerStaleSystemAlert(state.systemAlerts, scanFinishedAt),
    })),
  refreshWatchlistItem: async (id) => {
    const currentState = get();
    const item = currentState.watchlist.find((entry) => entry.id === id);
    if (!item) {
      return { alertTriggered: false };
    }
    const refreshGeneration = beginWatchlistRefresh(id);

    try {
      const latestState = get();
      const response = await getWfmItemOrders(
        item.slug,
        item.variantKey,
        latestState.sellerMode,
        getWatchlistRequestPriority(item),
        'watchlist',
      );
      if (!isLatestWatchlistRefresh(id, refreshGeneration)) {
        return { alertTriggered: false };
      }

      const resolvedState = get();
      const latestItem = resolvedState.watchlist.find((entry) => entry.id === id);
      if (!latestItem) {
        return { alertTriggered: false };
      }

      const nextScanAt =
        Date.now() + getWatchlistPollIntervalMs(Math.max(resolvedState.watchlist.length, 1));
      const candidateOrders = response.sellOrders.map((order) => ({
        orderId: order.orderId,
        platinum: order.platinum,
        quantity: order.quantity,
        perTrade: order.perTrade,
        rank: order.rank,
        username: order.username,
        userSlug: order.userSlug,
        status: order.status,
      }));
      const preferredOrder = selectPreferredWatchlistOrder(
        candidateOrders,
        latestItem.ignoredUserKeys,
      );
      const updatedItem = applyWatchlistOrder(latestItem, preferredOrder, nextScanAt);
      const existingAlert = resolvedState.alerts.find(
        (alert) => alert.watchlistId === latestItem.id,
      );
      const builtAlert =
        preferredOrder && latestItem.targetPrice >= preferredOrder.platinum
          ? buildWatchlistAlert(latestItem, preferredOrder)
          : null;
      // Suppress an alert the user already dismissed (same item/seller/price); the watchlist item
      // itself still updates below.
      const nextAlert =
        builtAlert && get().dismissedAlertKeys.has(watchlistAlertSignature(builtAlert))
          ? null
          : builtAlert;
      const alertTriggered =
        nextAlert !== null &&
        (!existingAlert || existingAlert.orderId !== nextAlert.orderId);

      if (!isLatestWatchlistRefresh(id, refreshGeneration)) {
        return { alertTriggered: false };
      }

      set((state) => {
        if (!isLatestWatchlistRefresh(id, refreshGeneration)) {
          return state;
        }

        return {
          watchlist: state.watchlist.map((entry) =>
            entry.id === latestItem.id ? updatedItem : entry,
          ),
          alerts: nextAlert
            ? [
                nextAlert,
                ...state.alerts.filter((alert) => alert.watchlistId !== latestItem.id),
              ]
            : state.alerts.filter((alert) => alert.watchlistId !== latestItem.id),
        };
      });

      if (nextAlert && alertTriggered && isLatestWatchlistRefresh(id, refreshGeneration)) {
        void sendWatchlistFoundDiscordNotification({
          itemName: nextAlert.itemName,
          itemSlug: nextAlert.itemSlug,
          itemImagePath: nextAlert.itemImagePath,
          targetPrice: latestItem.targetPrice,
          currentPrice: nextAlert.price,
          username: nextAlert.username,
          quantity: nextAlert.quantity,
          rank: nextAlert.rank,
          orderId: nextAlert.orderId,
          createdAt: nextAlert.createdAt,
        }).catch((error) => {
          console.error('[discord] failed to send watchlist notification', error);
        });
      }

      return { alertTriggered };
    } catch (error) {
      if (!isLatestWatchlistRefresh(id, refreshGeneration)) {
        return { alertTriggered: false };
      }

      const latestState = get();
      const latestItem = latestState.watchlist.find((entry) => entry.id === id);
      if (!latestItem) {
        return { alertTriggered: false };
      }

      const nextRetryCount = latestItem.retryCount + 1;
      const retryDelayMs = getWatchlistRetryDelayMs(
        nextRetryCount,
        Math.max(latestState.watchlist.length, 1),
      );

      set((state) => {
        if (!isLatestWatchlistRefresh(id, refreshGeneration)) {
          return state;
        }

        return {
          watchlist: state.watchlist.map((entry) =>
            entry.id === latestItem.id
              ? {
                  ...entry,
                  retryCount: nextRetryCount,
                  nextScanAt: Date.now() + retryDelayMs,
                  lastError: formatHomeErrorMessage('watchlist-refresh', error),
                }
              : entry,
          ),
        };
      });

      return { alertTriggered: false };
    }
  },

  ingestUnderpricedListing: (listing) => {
    const isNew = !get().underpricedListings.some((entry) => entry.orderId === listing.orderId);

    set((state) => {
      const card: UnderpricedListingCard = {
        ...listing,
        receivedAt: Date.now(),
        status: 'new',
        verifiedPrice: null,
      };
      // Dedupe by order id (refresh it if the same listing re-arrives), newest first, capped.
      const without = state.underpricedListings.filter((entry) => entry.orderId !== card.orderId);
      return { underpricedListings: [card, ...without].slice(0, UNDERPRICED_LISTING_CAP) };
    });

    // Only alert the first time a given listing appears, so a re-arriving order doesn't re-notify.
    if (!isNew) {
      return;
    }

    // Respect the user's minimum-discount threshold for underpriced alerts (applies to the
    // in-app tone, desktop notification, Discord webhook, and the alert card alike).
    const notificationSettings = get().notificationSettings;
    if (listing.pctBelow < notificationSettings.underpricedMinPctBelow) {
      return;
    }

    // Surface a single, replaceable alert card in the notification bar so a ping is never
    // silent — newest listing shown, earlier ones rolled into the "N others" count.
    set((state) => ({
      underpricedAlert: {
        listing: { ...listing, receivedAt: Date.now(), status: 'new', verifiedPrice: null },
        otherCount: state.underpricedAlert ? state.underpricedAlert.otherCount + 1 : 0,
      },
    }));

    const title = 'Underpriced listing found';
    const body = `${listing.itemName} — ${listing.listedPrice}p (${Math.round(listing.pctBelow)}% below ${listing.recommendedPrice}p) from ${listing.username}`;
    fireAlertNotification(notificationSettings, 'underpricedListing', title, body);
    void sendUnderpricedListingDiscordNotification({
      itemName: listing.itemName,
      itemSlug: listing.slug,
      listedPrice: listing.listedPrice,
      recommendedPrice: listing.recommendedPrice,
      pctBelow: listing.pctBelow,
      username: listing.username,
      rank: listing.rank,
      orderId: listing.orderId,
    }).catch((error) => {
      console.error('[discord] failed to send underpriced listing notification', error);
    });
  },
  updateUnderpricedListing: (orderId, patch) =>
    set((state) => ({
      underpricedListings: state.underpricedListings.map((entry) =>
        entry.orderId === orderId ? { ...entry, ...patch } : entry,
      ),
    })),
  removeUnderpricedListing: (orderId) =>
    set((state) => ({
      underpricedListings: state.underpricedListings.filter((entry) => entry.orderId !== orderId),
    })),
  dismissUnderpricedAlert: () => set({ underpricedAlert: null }),
  pruneExpiredUnderpricedListings: () =>
    set((state) => {
      const cutoff = Date.now() - UNDERPRICED_LISTING_TTL_MS;
      const next = state.underpricedListings.filter((entry) => entry.receivedAt > cutoff);
      return next.length === state.underpricedListings.length
        ? state
        : { underpricedListings: next };
    }),

  loadCachedOpportunities: async () => {
    // Instant paint from the persisted board; only fills in if we don't already have fresher data.
    try {
      const cached = await getCachedOpportunities();
      set((state) => {
        if (state.opportunitiesLoadedAt !== null || cached.length === 0) {
          return state;
        }
        const pinnedOpportunities = mergePinSnapshots(state.pinnedOpportunities, cached);
        if (pinnedOpportunities !== state.pinnedOpportunities) {
          savePinnedOpportunities(pinnedOpportunities);
        }
        return { opportunities: cached, pinnedOpportunities };
      });
    } catch {
      // Best-effort; the live refresh is the source of truth.
    }
  },

  requestTradeListing: (req) => {
    get().setTradesSubTab(req.orderType === 'sell' ? 'sell-orders' : 'buy-orders');
    set({ pendingTradeListing: req, activePage: 'trades', navigationBack: null });
  },
  clearPendingTradeListing: () => set({ pendingTradeListing: null }),
  requestOpportunitiesTab: (tab, search) =>
    set({
      requestedOpportunitiesTab: tab,
      requestedFarmNowSearch: search ?? null,
      activePage: 'opportunities',
      navigationBack: null,
    }),
  clearRequestedOpportunitiesTab: () =>
    set({ requestedOpportunitiesTab: null, requestedFarmNowSearch: null }),
  openItemAnalysis: async (target) => {
    await get().openItemInQuickView(target);
    set({ activePage: 'market', navigationBack: null });
    void get().loadSelectedMarketAnalysis({ force: false });
  },

  // Reads the local SQLite relic cache once per session (cheap, no network). Subsequent navigation
  // reuses the in-memory store, so switching tabs never wipes the relics or refetches.
  loadOwnedRelicsCache: async () => {
    if (get().ownedRelicsCacheLoaded || get().ownedRelicsLoading) {
      return;
    }
    set({ ownedRelicsLoading: true });
    try {
      const cache = await getOwnedRelicInventoryCache();
      set({
        ownedRelics: cache.entries,
        ownedRelicsUpdatedAt: cache.updatedAt,
        ownedRelicsCacheLoaded: true,
        ownedRelicsLoading: false,
      });
    } catch (error) {
      set({
        ownedRelicsLoading: false,
        ownedRelicsError: error instanceof Error ? error.message : 'Could not load relics.',
      });
    }
  },

  // Refreshes from AlecaFrame and re-caches. Cooldown-gated (3 min) unless forced, so reopening the
  // Opportunities tab can't hammer AlecaFrame. On failure the cached relics stay on screen.
  refreshOwnedRelics: async (force = false) => {
    const state = get();
    if (state.ownedRelicsRefreshing) {
      return;
    }
    if (
      !force &&
      state.ownedRelicsLastRefreshAt !== null &&
      Date.now() - state.ownedRelicsLastRefreshAt < OWNED_RELICS_REFRESH_COOLDOWN_MS
    ) {
      return;
    }
    // Stamp the attempt up front so a hang/timeout still counts toward the cooldown.
    set({ ownedRelicsRefreshing: true, ownedRelicsLastRefreshAt: Date.now() });
    try {
      const cache = await refreshOwnedRelicInventory();
      set({
        ownedRelics: cache.entries,
        ownedRelicsUpdatedAt: cache.updatedAt,
        ownedRelicsCacheLoaded: true,
        ownedRelicsRefreshing: false,
        ownedRelicsError: null,
      });
    } catch (error) {
      set({
        ownedRelicsRefreshing: false,
        ownedRelicsError: error instanceof Error ? error.message : 'Could not refresh relics.',
      });
    }
  },

  refreshOpportunities: async () => {
    set({ opportunitiesLoading: true, opportunitiesError: null });
    try {
      const opportunities = await getOpportunities();
      set((state) => {
        const pinnedOpportunities = mergePinSnapshots(state.pinnedOpportunities, opportunities);
        if (pinnedOpportunities !== state.pinnedOpportunities) {
          savePinnedOpportunities(pinnedOpportunities);
        }
        return {
          opportunities,
          opportunitiesLoading: false,
          opportunitiesLoadedAt: Date.now(),
          pinnedOpportunities,
        };
      });
    } catch (error) {
      set({
        opportunitiesLoading: false,
        opportunitiesError:
          error instanceof Error ? error.message : 'Could not load opportunities.',
      });
    }
  },

  pinOpportunity: (opportunity) =>
    set((state) => {
      const pinnedOpportunities = {
        ...state.pinnedOpportunities,
        [opportunity.subjectKey]: opportunity,
      };
      savePinnedOpportunities(pinnedOpportunities);
      return { pinnedOpportunities };
    }),
  unpinOpportunity: (subjectKey) =>
    set((state) => {
      if (!(subjectKey in state.pinnedOpportunities)) {
        return state;
      }
      const pinnedOpportunities = { ...state.pinnedOpportunities };
      delete pinnedOpportunities[subjectKey];
      savePinnedOpportunities(pinnedOpportunities);
      return { pinnedOpportunities };
    }),
  dismissOpportunity: (subjectKey) =>
    set((state) => {
      const dismissedOpportunityKeys = new Set(state.dismissedOpportunityKeys);
      dismissedOpportunityKeys.add(subjectKey);
      // Dismissing also drops it from "accepted" if it was pinned.
      if (subjectKey in state.pinnedOpportunities) {
        const pinnedOpportunities = { ...state.pinnedOpportunities };
        delete pinnedOpportunities[subjectKey];
        savePinnedOpportunities(pinnedOpportunities);
        return { dismissedOpportunityKeys, pinnedOpportunities };
      }
      return { dismissedOpportunityKeys };
    }),
  restoreDismissedOpportunities: () => set({ dismissedOpportunityKeys: new Set<string>() }),

  ingestRealtimeWatchlistOrder: (order) => {
    const item = get().watchlist.find((entry) => entry.id === order.watchlistId);
    if (!item) {
      return false;
    }

    const realtimeOrder: WfmTopSellOrder = {
      orderId: order.orderId,
      platinum: order.platinum,
      quantity: order.quantity,
      perTrade: 1,
      rank: order.rank,
      username: order.username,
      userSlug: order.userSlug,
      status: null,
    };

    // The backend already filtered to a visible sell ≤ target from an acceptable seller.
    // Dedupe against the per-item alert: only raise/replace when there's no current alert
    // or this order is genuinely cheaper, so a flurry of pricier posts can't spam alerts.
    const existingAlert = get().alerts.find((alert) => alert.watchlistId === item.id);
    if (existingAlert && existingAlert.price <= order.platinum) {
      return false;
    }

    const nextAlert = buildWatchlistAlert(item, realtimeOrder);
    // The user already dismissed this exact item/seller/price — don't pop it back up.
    if (get().dismissedAlertKeys.has(watchlistAlertSignature(nextAlert))) {
      return false;
    }
    const isNewAlert = !existingAlert || existingAlert.orderId !== nextAlert.orderId;

    set((state) => {
      const target = state.watchlist.find((entry) => entry.id === item.id);
      if (!target) {
        return state;
      }
      // Reflect the live cheapest on the item only when it actually beats what we show.
      const shouldUpdateItem =
        target.currentPrice === null || order.platinum < target.currentPrice;
      const updatedItem = shouldUpdateItem
        ? applyWatchlistOrder(target, realtimeOrder, target.nextScanAt)
        : target;

      return {
        watchlist: state.watchlist.map((entry) =>
          entry.id === item.id ? updatedItem : entry,
        ),
        alerts: [
          nextAlert,
          ...state.alerts.filter((alert) => alert.watchlistId !== item.id),
        ],
      };
    });

    if (isNewAlert) {
      void sendWatchlistFoundDiscordNotification({
        itemName: nextAlert.itemName,
        itemSlug: nextAlert.itemSlug,
        itemImagePath: nextAlert.itemImagePath,
        targetPrice: item.targetPrice,
        currentPrice: nextAlert.price,
        username: nextAlert.username,
        quantity: nextAlert.quantity,
        rank: nextAlert.rank,
        orderId: nextAlert.orderId,
        createdAt: nextAlert.createdAt,
      }).catch((error) => {
        console.error('[discord] failed to send realtime watchlist notification', error);
      });
    }

    return isNewAlert;
  },

  quickView: {
    selectedItem: null,
    sellOrders: [],
    sparklinePoints: [],
    sparklineLoading: false,
    apiVersion: null,
    loading: false,
    errorMessage: null,
  },
  marketVariants: [],
  marketVariantsLoading: false,
  marketVariantsError: null,
  selectedMarketVariantKey: null,
  selectedMarketVariantLabel: null,
  searchTrackingSource: null,
  selectedMarketAnalysis: null,
  selectedMarketAnalysisLoading: false,
  selectedMarketAnalysisError: null,
  marketAnalysisCache: {},
  loadQuickViewItem: async (item) => {
    const requestId = ++quickViewRequestSequence;
    const state = get();
    const previousTrackedSelection = state.searchTrackingSource;
    const sellerMode = state.sellerMode;

    set({
      quickView: {
        selectedItem: item,
        sellOrders: [],
        sparklinePoints: [],
        sparklineLoading: false,
        apiVersion: null,
        loading: true,
        errorMessage: null,
      },
      marketVariants: [],
      marketVariantsLoading: true,
      marketVariantsError: null,
      selectedMarketVariantKey: null,
      selectedMarketVariantLabel: null,
      selectedMarketAnalysis: null,
      selectedMarketAnalysisLoading: false,
      selectedMarketAnalysisError: null,
    });

    try {
      const variants = await getItemVariantsForMarket(item.itemId, item.slug);
      const defaultVariantKey =
        variants.find((variant) => variant.isDefault)?.key
        ?? variants[0]?.key
        ?? 'base';
      const resolvedQuickView = await loadQuickViewOrdersForBestVariant(item, variants, sellerMode);
      if (requestId !== quickViewRequestSequence) {
        return;
      }

      let nextTrackedSelection = await persistSearchedItemSelection(
        previousTrackedSelection,
        item,
        sellerMode,
      );
      let nextSelectedVariantKey: string | null = resolvedQuickView.variantKey ?? defaultVariantKey;
      let nextSelectedVariantLabel: string | null =
        resolvedQuickView.variantLabel
        ?? variants.find((variant) => variant.key === nextSelectedVariantKey)?.label
        ?? (nextSelectedVariantKey?.startsWith('rank:')
          ? `Rank ${nextSelectedVariantKey.slice(5)}`
          : 'Base Market');

      if (nextTrackedSelection?.variantKey !== nextSelectedVariantKey) {
        const syncedSelection = await syncSearchTrackingSelection(
          nextTrackedSelection,
          item,
          nextSelectedVariantKey,
          sellerMode,
        );
        nextTrackedSelection = syncedSelection.nextTrackedSelection;
        nextSelectedVariantLabel = syncedSelection.selectedVariantLabel;
      }

      if (requestId !== quickViewRequestSequence) {
        return;
      }

      set({
        quickView: {
          selectedItem: item,
          sellOrders: resolvedQuickView.sellOrders,
          sparklinePoints: [],
          sparklineLoading: true,
          apiVersion: resolvedQuickView.apiVersion,
          loading: false,
          errorMessage: null,
        },
        marketVariants: variants,
        marketVariantsLoading: false,
        marketVariantsError: null,
        selectedMarketVariantKey: nextSelectedVariantKey,
        selectedMarketVariantLabel: nextSelectedVariantLabel,
        searchTrackingSource: nextTrackedSelection,
        selectedMarketAnalysis:
          nextSelectedVariantKey
            ? state.marketAnalysisCache[
                buildMarketAnalysisCacheKey(item.itemId, nextSelectedVariantKey, sellerMode)
              ] ?? null
            : null,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
      });

      void getItemAnalytics(
        item.itemId,
        item.slug,
        nextSelectedVariantKey,
        sellerMode,
        '48h',
        '1h',
      )
        .then((analytics) => {
          if (requestId !== quickViewRequestSequence) {
            return;
          }
          set((currentState) => ({
            quickView: {
              ...currentState.quickView,
              sparklinePoints: extractQuickViewSparklinePoints(analytics.chartPoints),
              sparklineLoading: false,
            },
          }));
        })
        .catch(() => {
          if (requestId !== quickViewRequestSequence) {
            return;
          }
          set((currentState) => ({
            quickView: {
              ...currentState.quickView,
              sparklinePoints: [],
              sparklineLoading: false,
            },
          }));
        });
    } catch (error) {
      if (requestId !== quickViewRequestSequence) {
        return;
      }

      const friendlyMessage = formatHomeErrorMessage('dashboard-quick-view-load', error);
      const marketFriendlyMessage = formatMarketErrorMessage('market-variant-load', error);
      set({
        quickView: {
          selectedItem: item,
          sellOrders: [],
          sparklinePoints: [],
          sparklineLoading: false,
          apiVersion: null,
          loading: false,
          errorMessage: friendlyMessage,
        },
        marketVariants: [],
        marketVariantsLoading: false,
        marketVariantsError: marketFriendlyMessage,
        selectedMarketVariantKey: null,
        selectedMarketVariantLabel: null,
        selectedMarketAnalysis: null,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
      });
    }
  },
  setSelectedMarketVariantKey: async (variantKey) => {
    const requestId = ++quickViewRequestSequence;
    const state = get();
    const selectedItem = state.quickView.selectedItem;
    const previousTrackedSelection = state.searchTrackingSource;
    const sellerMode = state.sellerMode;

    if (!selectedItem) {
      set({
        selectedMarketVariantKey: null,
        selectedMarketVariantLabel: null,
        searchTrackingSource: null,
        selectedMarketAnalysis: null,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
      });
      return;
    }

    set({
      selectedMarketVariantKey: variantKey,
      selectedMarketVariantLabel:
        state.marketVariants.find((entry) => entry.key === variantKey)?.label ?? null,
      selectedMarketAnalysis:
        variantKey
          ? state.marketAnalysisCache[
              buildMarketAnalysisCacheKey(selectedItem.itemId, variantKey, sellerMode)
            ] ?? null
          : null,
      selectedMarketAnalysisLoading: false,
      selectedMarketAnalysisError: null,
      quickView: {
        ...state.quickView,
        sparklinePoints: [],
        sparklineLoading: false,
        loading: true,
        errorMessage: null,
      },
    });

    try {
      const syncedSelection = await syncSearchTrackingSelection(
        previousTrackedSelection,
        selectedItem,
        variantKey,
        sellerMode,
      );
      const response = await loadQuickViewOrdersForSelection(selectedItem, variantKey, sellerMode);
      if (requestId !== quickViewRequestSequence) {
        return;
      }
      set((currentState) => ({
        selectedMarketVariantKey: variantKey,
        selectedMarketVariantLabel:
          currentState.marketVariants.find((entry) => entry.key === variantKey)?.label ?? null,
        searchTrackingSource: syncedSelection.nextTrackedSelection,
        selectedMarketAnalysis:
          variantKey
            ? currentState.marketAnalysisCache[
                buildMarketAnalysisCacheKey(selectedItem.itemId, variantKey, sellerMode)
              ] ?? null
            : null,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
        quickView: {
          ...currentState.quickView,
          selectedItem,
          sellOrders: response.sellOrders,
          sparklinePoints: [],
          sparklineLoading: true,
          apiVersion: response.apiVersion,
          loading: false,
          errorMessage: null,
        },
      }));

      void getItemAnalytics(
        selectedItem.itemId,
        selectedItem.slug,
        variantKey,
        sellerMode,
        '48h',
        '1h',
      )
        .then((analytics) => {
          if (requestId !== quickViewRequestSequence) {
            return;
          }
          set((currentState) => ({
            quickView: {
              ...currentState.quickView,
              sparklinePoints: extractQuickViewSparklinePoints(analytics.chartPoints),
              sparklineLoading: false,
            },
          }));
        })
        .catch(() => {
          if (requestId !== quickViewRequestSequence) {
            return;
          }
          set((currentState) => ({
            quickView: {
              ...currentState.quickView,
              sparklinePoints: [],
              sparklineLoading: false,
            },
          }));
        });
    } catch (error) {
      const friendlyMessage = formatHomeErrorMessage('dashboard-quick-view-load', error);
      const marketFriendlyMessage = formatMarketErrorMessage('market-variant-load', error);
      set((currentState) => ({
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: marketFriendlyMessage,
        quickView: {
          ...currentState.quickView,
          sparklinePoints: [],
          sparklineLoading: false,
          loading: false,
          errorMessage: friendlyMessage,
        },
      }));
    }
  },
  loadSelectedMarketAnalysis: async (options) => {
    const state = get();
    const selectedItem = state.quickView.selectedItem;
    const selectedVariantKey = state.selectedMarketVariantKey;
    const sellerMode = state.sellerMode;
    const force = options?.force ?? false;

    if (!selectedItem || !selectedVariantKey) {
      set({
        selectedMarketAnalysis: null,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
      });
      return null;
    }

    const cacheKey = buildMarketAnalysisCacheKey(selectedItem.itemId, selectedVariantKey, sellerMode);
    const cached = state.marketAnalysisCache[cacheKey] ?? null;

    if (cached && !force) {
      set({
        selectedMarketAnalysis: cached,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
      });
      return cached;
    }

    if (!force) {
      const existingPromise = marketAnalysisLoadPromises.get(cacheKey);
      if (existingPromise) {
        set({
          selectedMarketAnalysis: cached,
          selectedMarketAnalysisLoading: true,
          selectedMarketAnalysisError: null,
        });
        return existingPromise;
      }
    }

    const requestId = ++marketAnalysisRequestSequence;
    set({
      selectedMarketAnalysis: cached,
      selectedMarketAnalysisLoading: true,
      selectedMarketAnalysisError: null,
    });

    let loadPromise: Promise<ItemAnalysisResponse | null> | null = null;
    loadPromise = (async () => {
      try {
        const analysis = await getItemAnalysis(
          selectedItem.itemId,
          selectedItem.slug,
          selectedVariantKey,
          sellerMode,
        );
        if (requestId === marketAnalysisRequestSequence) {
          set((currentState) => {
            const nextCache = {
              ...currentState.marketAnalysisCache,
              [cacheKey]: analysis,
            };
            return {
              marketAnalysisCache: nextCache,
              selectedMarketAnalysis:
                currentState.quickView.selectedItem?.itemId === selectedItem.itemId
                && currentState.selectedMarketVariantKey === selectedVariantKey
                  ? analysis
                  : currentState.selectedMarketAnalysis,
              selectedMarketAnalysisLoading: false,
              selectedMarketAnalysisError: null,
            };
          });
        }
        return analysis;
      } catch (error) {
        if (requestId === marketAnalysisRequestSequence) {
          const friendlyMessage = formatMarketErrorMessage(
            force ? 'market-analysis-refresh' : 'market-analysis-load',
            error,
          );
          set((currentState) => ({
            selectedMarketAnalysis: currentState.marketAnalysisCache[cacheKey] ?? currentState.selectedMarketAnalysis,
            selectedMarketAnalysisLoading: false,
            selectedMarketAnalysisError: friendlyMessage,
          }));
        }
        throw error;
      } finally {
        if (loadPromise && marketAnalysisLoadPromises.get(cacheKey) === loadPromise) {
          marketAnalysisLoadPromises.delete(cacheKey);
        }
      }
    })();

    marketAnalysisLoadPromises.set(cacheKey, loadPromise);
    return loadPromise;
  },

  tradeAccount: null,
  tradeAccountLoading: false,
  tradeAccountError: null,
  syncWatchlistTradeOverview: async (overview) => {
    const currentState = get();
    const reconciled = reconcileWatchlistWithTradeBuyOrders({
      watchlist: currentState.watchlist,
      selectedWatchlistId: currentState.selectedWatchlistId,
      buyOrders: overview.buyOrders,
    });

    const finalWatchlist = reconciled.watchlist;
    const finalSelectedWatchlistId = reconciled.selectedWatchlistId;
    const finalOverview = overview;

    const watchlistChanged =
      !isSameWatchlistSequence(finalWatchlist, currentState.watchlist)
      || finalSelectedWatchlistId !== currentState.selectedWatchlistId;

    if (watchlistChanged) {
      writePersistedWatchlistState(finalWatchlist, finalSelectedWatchlistId);
      set({
        watchlist: finalWatchlist,
        selectedWatchlistId: finalSelectedWatchlistId,
      });
    }

    return finalOverview;
  },
  loadTradeAccount: async () => {
    if (tradeAccountLoadPromise) {
      return tradeAccountLoadPromise;
    }

    const loadPromise = (async () => {
      set({ tradeAccountLoading: true, tradeAccountError: null });

      try {
        const sessionState = await tryAutoSignInWfmTradeAccount();
        let nextWatchlist = get().watchlist;
        let nextSelectedWatchlistId = get().selectedWatchlistId;

        if (sessionState.account) {
          try {
            const overview = await getWfmTradeOverview(get().sellerMode);
            const reconciled = reconcileWatchlistWithTradeBuyOrders({
              watchlist: nextWatchlist,
              selectedWatchlistId: nextSelectedWatchlistId,
              buyOrders: overview.buyOrders,
            });
            nextWatchlist = reconciled.watchlist;
            nextSelectedWatchlistId = reconciled.selectedWatchlistId;
            writePersistedWatchlistState(nextWatchlist, nextSelectedWatchlistId);
          } catch (error) {
            console.error('[watchlist] failed to hydrate from active buy orders', error);
          }
        }

        set({
          tradeAccount: sessionState.account,
          watchlist: nextWatchlist,
          selectedWatchlistId: nextSelectedWatchlistId,
          tradeAccountLoading: false,
          tradeAccountError: null,
        });
      } catch (error) {
        set({
          tradeAccount: null,
          tradeAccountLoading: false,
          tradeAccountError: toErrorMessage(error),
        });
      } finally {
        tradeAccountLoadPromise = null;
      }
    })();

    tradeAccountLoadPromise = loadPromise;
    return loadPromise;
  },
  signInTradeAccount: async (input) => {
    set({ tradeAccountLoading: true, tradeAccountError: null });

    try {
      const sessionState = await signInWfmTradeAccount(input);
      let nextWatchlist = get().watchlist;
      let nextSelectedWatchlistId = get().selectedWatchlistId;

      if (sessionState.account) {
        try {
          const overview = await getWfmTradeOverview(get().sellerMode);
          const reconciled = reconcileWatchlistWithTradeBuyOrders({
            watchlist: nextWatchlist,
            selectedWatchlistId: nextSelectedWatchlistId,
            buyOrders: overview.buyOrders,
          });
          nextWatchlist = reconciled.watchlist;
          nextSelectedWatchlistId = reconciled.selectedWatchlistId;
          writePersistedWatchlistState(nextWatchlist, nextSelectedWatchlistId);
        } catch (error) {
          console.error('[watchlist] failed to hydrate from active buy orders', error);
        }
      }

      set({
        tradeAccount: sessionState.account,
        watchlist: nextWatchlist,
        selectedWatchlistId: nextSelectedWatchlistId,
        tradeAccountLoading: false,
        tradeAccountError: null,
        activePage: 'trades',
        tradesSubTab: 'sell-orders',
      });
    } catch (error) {
      set({
        tradeAccountLoading: false,
        tradeAccountError: toErrorMessage(error),
      });
      throw error;
    }
  },
  signOutTradeAccount: async () => {
    set({ tradeAccountLoading: true, tradeAccountError: null });

    try {
      await signOutWfmTradeAccount();
      set({
        tradeAccount: null,
        tradeAccountLoading: false,
        tradeAccountError: null,
      });
    } catch (error) {
      set({
        tradeAccountLoading: false,
        tradeAccountError: toErrorMessage(error),
      });
      throw error;
    }
  },
  setTradeAccountStatus: async (status) => {
    set({ tradeAccountLoading: true, tradeAccountError: null });

    try {
      const sessionState = await setWfmTradeStatus(status);
      set({
        tradeAccount: sessionState.account,
        tradeAccountLoading: false,
        tradeAccountError: null,
      });
    } catch (error) {
      set({
        tradeAccountLoading: false,
        tradeAccountError: toErrorMessage(error),
      });
      throw error;
    }
  },
  autoWatchlistBuyOrdersEnabled: true,
  setAutoWatchlistBuyOrdersEnabled: (enabled) => {
    set({ autoWatchlistBuyOrdersEnabled: enabled });
    if (!enabled) {
      return;
    }

    const state = get();
    if (!state.tradeAccount) {
      return;
    }

    void getWfmTradeOverview(state.sellerMode)
      .then((overview) => get().syncWatchlistTradeOverview(overview))
      .catch((error) => {
        console.error('[watchlist] failed to reconcile after enabling auto buy order', error);
        set({ tradeAccountError: toErrorMessage(error) });
      });
  },
  tradesSubTab: 'sell-orders',
  setTradesSubTab: (tab) => set({ tradesSubTab: tab }),

  tradePeriod: '30d',
  setTradePeriod: (period) => set({ tradePeriod: period }),

  marketSubTab: 'analysis',
  setMarketSubTab: (tab) => set({ marketSubTab: tab }),

  eventsSubTab: 'vendors',
  setEventsSubTab: (tab) => set({ eventsSubTab: tab }),
}));
