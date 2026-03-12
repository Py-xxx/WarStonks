import { create } from 'zustand';
import {
  ensureMarketTracking,
  getAppSettings,
  getItemAnalytics,
  getItemAnalysis,
  getCurrencyBalances,
  getItemVariantsForMarket,
  getWfmItemOrders,
  getWfmTopSellOrdersForVariant,
  getWfmTopSellOrders,
  saveAlecaframeSettings,
  stopMarketTracking,
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
} from '../lib/worldState';
import {
  persistWorldStateCacheEntry,
  readWorldStateCacheEntry,
} from '../lib/worldStateCache';
import {
  buildWatchlistUserKey,
  getWatchlistPollIntervalMs,
  getWatchlistRetryDelayMs,
  selectPreferredWatchlistOrder,
} from '../lib/watchlist';
import type {
  HomeSubTab,
  PageId,
  QuickViewSelection,
  SellerMode,
  SettingsSection,
  TradeOrder,
  TradePeriod,
  TradesSubTab,
  WatchlistAlert,
  WatchlistItem,
  SystemAlert,
  WorldStateEndpointKey,
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
  ItemAnalysisResponse,
  MarketVariant,
  WalletSnapshot,
  WfmAutocompleteItem,
  WfmTopSellOrder,
} from '../types';
import { mockSellOrders } from '../mocks/trades';

let quickViewRequestSequence = 0;
let marketAnalysisRequestSequence = 0;
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

interface WatchlistRefreshResult {
  alertTriggered: boolean;
}

interface CachedWorldStateSnapshot<T> {
  payload: T;
  fetchedAt: string;
  nextRefreshAt: string | null;
}

function buildMarketAnalysisCacheKey(itemId: number, variantKey: string): string {
  return `${itemId}:${variantKey}`;
}

function extractQuickViewSparklinePoints(chartPoints: Awaited<ReturnType<typeof getItemAnalytics>>['chartPoints']): number[] {
  return chartPoints
    .slice(-24)
    .map((point) => point.lowestSell)
    .filter((value): value is number => value !== null && value !== undefined && !Number.isNaN(value));
}

const WORLDSTATE_SYSTEM_ALERT_ID = 'system:worldstate-offline';

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

function buildWatchlistAlertId(watchlistId: string, orderId: string): string {
  return `${watchlistId}:${orderId}`;
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

function clearWorldStateSystemAlertSource(
  alerts: SystemAlert[],
  sourceKey: WorldStateEndpointKey,
): SystemAlert[] {
  const existingAlert = alerts.find((alert) => alert.id === WORLDSTATE_SYSTEM_ALERT_ID);
  if (!existingAlert) {
    return alerts;
  }

  const remainingSourceKeys = existingAlert.sourceKeys.filter((key) => key !== sourceKey);
  if (remainingSourceKeys.length === 0) {
    return alerts.filter((alert) => alert.id !== WORLDSTATE_SYSTEM_ALERT_ID);
  }

  const nextAlert = buildWorldStateSystemAlert(remainingSourceKeys);
  return [nextAlert, ...alerts.filter((alert) => alert.id !== WORLDSTATE_SYSTEM_ALERT_ID)];
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
  };
}

function buildWatchlistUpdateState(
  currentState: AppStore,
  item: WfmAutocompleteItem,
  variantKey: string,
  variantLabel: string,
  targetPrice: number,
  preferredOrder: WfmTopSellOrder | null,
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
              }
            : entry,
        )
      : [...currentState.watchlist, nextItem],
    alerts: nextAlert
      ? [
          nextAlert,
          ...currentState.alerts.filter((alert) => alert.watchlistId !== nextItem.id),
        ]
      : currentState.alerts,
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
): Promise<{ sellOrders: WfmTopSellOrder[]; apiVersion: string | null }> {
  const response = variantKey
    ? await getWfmTopSellOrdersForVariant(item.slug, variantKey)
    : await getWfmTopSellOrders(item.slug);

  return {
    sellOrders: response.sellOrders,
    apiVersion: response.apiVersion,
  };
}

async function syncSearchTrackingSelection(
  previousSelection: { itemId: number; slug: string; variantKey: string } | null,
  item: WfmAutocompleteItem,
  variantKey: string | null,
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
  await ensureMarketTracking(item.itemId, item.slug, variantKey, 'search');
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
): Promise<{ itemId: number; slug: string; variantKey: string } | null> {
  const syncedSelection = await syncSearchTrackingSelection(
    previousSelection,
    item,
    'base',
  );

  return syncedSelection.nextTrackedSelection;
}

interface AppStore {
  activePage: PageId;
  setActivePage: (page: PageId) => void;

  homeSubTab: HomeSubTab;
  setHomeSubTab: (tab: HomeSubTab) => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  settingsSidebarOpen: boolean;
  settingsSection: SettingsSection;
  alecaframeModalOpen: boolean;
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
  openSettingsSidebar: (section?: SettingsSection) => void;
  closeSettingsSidebar: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  openAlecaframeModal: () => void;
  closeAlecaframeModal: () => void;
  loadAppSettings: () => Promise<void>;
  refreshWalletSnapshot: () => Promise<void>;
  saveAlecaframeConfiguration: (input: AlecaframeSettingsInput) => Promise<void>;
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
  systemAlerts: SystemAlert[];
  worldStateSystemAlertDismissed: boolean;
  selectedWatchlistId: string | null;
  watchlistTargetInput: string;
  watchlistFormError: string | null;
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
  dismissAlert: (id: string) => void;
  clearAllAlerts: () => void;
  markAlertBought: (id: string) => void;
  markAlertNoResponse: (id: string) => void;
  dismissSystemAlert: (id: string) => void;
  clearAllSystemAlerts: () => void;
  retryWorldStateSystemAlert: (sourceKeys: WorldStateEndpointKey[]) => Promise<void>;
  refreshWatchlistItem: (id: string) => Promise<WatchlistRefreshResult>;

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
  loadSelectedMarketAnalysis: (options?: { force?: boolean }) => Promise<void>;

  tradesSubTab: TradesSubTab;
  setTradesSubTab: (tab: TradesSubTab) => void;
  sellOrders: TradeOrder[];
  removeSellOrder: (id: string) => void;
  newOrderName: string;
  setNewOrderName: (val: string) => void;
  newOrderPrice: string;
  setNewOrderPrice: (val: string) => void;
  newOrderQty: string;
  setNewOrderQty: (val: string) => void;
  newOrderRank: string;
  setNewOrderRank: (val: string) => void;

  tradePeriod: TradePeriod;
  setTradePeriod: (p: TradePeriod) => void;

  marketSubTab: 'analysis' | 'analytics';
  setMarketSubTab: (tab: 'analysis' | 'analytics') => void;

  eventsSubTab: 'active-events' | 'void-trader' | 'fissures' | 'activities' | 'market-news';
  setEventsSubTab: (tab: 'active-events' | 'void-trader' | 'fissures' | 'activities' | 'market-news') => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  activePage: 'home',
  setActivePage: (page) => set({ activePage: page }),

  homeSubTab: 'overview',
  setHomeSubTab: (tab) => set({ homeSubTab: tab }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  settingsSidebarOpen: false,
  settingsSection: 'alecaframe',
  alecaframeModalOpen: false,
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
  worldStateVoidTraderError: null,
  worldStateVoidTraderNextRefreshAt: null,
  worldStateVoidTraderLastUpdatedAt: null,
  openSettingsSidebar: (section = 'alecaframe') =>
    set({ settingsSidebarOpen: true, settingsSection: section, alecaframeModalOpen: false }),
  closeSettingsSidebar: () => set({ settingsSidebarOpen: false, alecaframeModalOpen: false }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  openAlecaframeModal: () =>
    set({
      settingsSidebarOpen: true,
      settingsSection: 'alecaframe',
      alecaframeModalOpen: true,
    }),
  closeAlecaframeModal: () => set({ alecaframeModalOpen: false }),
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
        settingsError: toErrorMessage(error),
      });
    }
  },
  refreshWalletSnapshot: async () => {
    set({ walletLoading: true });

    try {
      const snapshot = await getCurrencyBalances();
      set({
        walletSnapshot: snapshot,
        walletLoading: false,
      });
    } catch (error) {
      set({
        walletSnapshot: {
          ...defaultWalletSnapshot,
          errorMessage: toErrorMessage(error),
        },
        walletLoading: false,
      });
    }
  },
  saveAlecaframeConfiguration: async (input) => {
    set({ settingsLoading: true, settingsError: null });

    try {
      const settings = await saveAlecaframeSettings(input);
      set({
        appSettings: settings,
        settingsLoading: false,
        settingsError: null,
        alecaframeModalOpen: false,
        walletLoading: true,
      });

      const snapshot = await getCurrencyBalances();
      set({
        walletSnapshot: snapshot,
        walletLoading: false,
      });
    } catch (error) {
      set({
        settingsLoading: false,
        settingsError: toErrorMessage(error),
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.events,
          restoreCachedWorldStateEvents,
        );

        set((state) => ({
          worldStateEvents: state.worldStateEvents.length > 0
            ? state.worldStateEvents
            : (cachedSnapshot?.payload ?? []),
          worldStateEventsLoading: false,
          worldStateEventsError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateEventsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateEventsLastUpdatedAt:
            state.worldStateEventsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.events,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.alerts,
          restoreCachedWorldStateAlerts,
        );

        set((state) => ({
          worldStateAlerts: state.worldStateAlerts.length > 0
            ? state.worldStateAlerts
            : (cachedSnapshot?.payload ?? []),
          worldStateAlertsLoading: false,
          worldStateAlertsError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateAlertsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateAlertsLastUpdatedAt:
            state.worldStateAlertsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.alerts,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.sortie,
          restoreCachedWorldStateSortie,
        );

        set((state) => ({
          worldStateSortie: state.worldStateSortie ?? cachedSnapshot?.payload ?? null,
          worldStateSortieLoading: false,
          worldStateSortieError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateSortieNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateSortieLastUpdatedAt:
            state.worldStateSortieLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.sortie,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.arbitration,
          restoreCachedWorldStateArbitration,
        );

        set((state) => ({
          worldStateArbitration: state.worldStateArbitration ?? cachedSnapshot?.payload ?? null,
          worldStateArbitrationLoading: false,
          worldStateArbitrationError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateArbitrationNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateArbitrationLastUpdatedAt:
            state.worldStateArbitrationLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.arbitration,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.archonHunt,
          restoreCachedWorldStateArchonHunt,
        );

        set((state) => ({
          worldStateArchonHunt: state.worldStateArchonHunt ?? cachedSnapshot?.payload ?? null,
          worldStateArchonHuntLoading: false,
          worldStateArchonHuntError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateArchonHuntNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateArchonHuntLastUpdatedAt:
            state.worldStateArchonHuntLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.archonHunt,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.fissures,
          restoreCachedWorldStateFissures,
        );

        set((state) => ({
          worldStateFissures: state.worldStateFissures.length > 0
            ? state.worldStateFissures
            : (cachedSnapshot?.payload ?? []),
          worldStateFissuresLoading: false,
          worldStateFissuresError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateFissuresNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateFissuresLastUpdatedAt:
            state.worldStateFissuresLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.fissures,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
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
          worldStateMarketNewsError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateMarketNewsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateMarketNewsLastUpdatedAt:
            state.worldStateMarketNewsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.marketNews,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.invasions,
          restoreCachedWorldStateInvasions,
        );

        set((state) => ({
          worldStateInvasions: state.worldStateInvasions.length > 0
            ? state.worldStateInvasions
            : (cachedSnapshot?.payload ?? []),
          worldStateInvasionsLoading: false,
          worldStateInvasionsError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateInvasionsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateInvasionsLastUpdatedAt:
            state.worldStateInvasionsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.invasions,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.syndicateMissions,
          restoreCachedWorldStateSyndicateMissions,
        );

        set((state) => ({
          worldStateSyndicateMissions: state.worldStateSyndicateMissions.length > 0
            ? state.worldStateSyndicateMissions
            : (cachedSnapshot?.payload ?? []),
          worldStateSyndicateMissionsLoading: false,
          worldStateSyndicateMissionsError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateSyndicateMissionsNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateSyndicateMissionsLastUpdatedAt:
            state.worldStateSyndicateMissionsLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.syndicateMissions,
            !state.worldStateSystemAlertDismissed,
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
        const errorMessage = toErrorMessage(error);
        const cachedSnapshot = await loadCachedWorldStateSnapshot(
          WORLDSTATE_ENDPOINT_KEYS.voidTrader,
          restoreCachedWorldStateVoidTrader,
        );

        set((state) => ({
          worldStateVoidTrader: state.worldStateVoidTrader ?? cachedSnapshot?.payload ?? null,
          worldStateVoidTraderLoading: false,
          worldStateVoidTraderError: cachedSnapshot
            ? `${errorMessage} Using cached data from ${cachedSnapshot.fetchedAt}.`
            : errorMessage,
          worldStateVoidTraderNextRefreshAt: new Date(
            Date.now() + WORLDSTATE_RETRY_DELAY_MS,
          ).toISOString(),
          worldStateVoidTraderLastUpdatedAt:
            state.worldStateVoidTraderLastUpdatedAt ?? cachedSnapshot?.fetchedAt ?? null,
          systemAlerts: upsertWorldStateSystemAlert(
            state.systemAlerts,
            WORLDSTATE_ENDPOINT_KEYS.voidTrader,
            !state.worldStateSystemAlertDismissed,
          ),
        }));
      } finally {
        worldStateVoidTraderRefreshPromise = null;
      }
    })();

    return worldStateVoidTraderRefreshPromise;
  },

  sellerMode: 'ingame',
  setSellerMode: (mode) => set({ sellerMode: mode }),
  autoProfile: false,
  toggleAutoProfile: () => set((s) => ({ autoProfile: !s.autoProfile })),

  watchlist: [],
  alerts: [],
  systemAlerts: [],
  worldStateSystemAlertDismissed: false,
  selectedWatchlistId: null,
  watchlistTargetInput: '',
  watchlistFormError: null,
  setSelectedWatchlist: (id) => set({ selectedWatchlistId: id }),
  setWatchlistTargetInput: (val) =>
    set({ watchlistTargetInput: val, watchlistFormError: null }),
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

    const targetPrice = Number.parseFloat(state.watchlistTargetInput);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      set({ watchlistFormError: 'Enter a desired price greater than 0.' });
      return;
    }

    const variantKey = selectedVariantKey ?? 'base';
    const variantLabel = selectedVariantLabel ?? 'Base Market';
    const preferredOrder = selectPreferredWatchlistOrder(
      state.quickView.sellOrders,
      state.watchlist.find(
        (item) => item.slug === selectedItem.slug && item.variantKey === variantKey,
      )?.ignoredUserKeys ?? [],
    );
    set((currentState) =>
      buildWatchlistUpdateState(
        currentState,
        selectedItem,
        variantKey,
        variantLabel,
        targetPrice,
        preferredOrder,
      ),
    );

    void ensureMarketTracking(selectedItem.itemId, selectedItem.slug, variantKey, 'watchlist').catch(
      (error) => {
        console.error('[watchlist] failed to start tracking item', error);
      },
    );
  },
  addExplicitItemToWatchlist: (item, variantKey, variantLabel, targetPrice) => {
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      set({ watchlistFormError: 'Enter a desired price greater than 0.' });
      return;
    }

    void getWfmTopSellOrdersForVariant(item.slug, variantKey)
      .then((response) => {
        const preferredOrder = selectPreferredWatchlistOrder(response.sellOrders, []);
        set((currentState) =>
          buildWatchlistUpdateState(
            currentState,
            item,
            variantKey,
            variantLabel,
            targetPrice,
            preferredOrder,
          ),
        );
        return ensureMarketTracking(item.itemId, item.slug, variantKey, 'watchlist');
      })
      .catch((error) => {
        console.error('[watchlist] failed to add explicit item', error);
        set({
          watchlistFormError: toErrorMessage(error),
        });
      });
  },
  removeWatchlistItem: (id) =>
    set((state) => {
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
      }

      return {
        watchlist: state.watchlist.filter((item) => item.id !== id),
        alerts: state.alerts.filter((alert) => alert.watchlistId !== id),
        selectedWatchlistId:
          state.selectedWatchlistId === id
            ? state.watchlist.find((item) => item.id !== id)?.id ?? null
            : state.selectedWatchlistId,
        watchlistFormError: null,
      };
    }),
  dismissAlert: (id) =>
    set((state) => ({
      alerts: state.alerts.filter((alert) => alert.id !== id),
    })),
  clearAllAlerts: () => set({ alerts: [] }),
  markAlertBought: (_id) => undefined,
  markAlertNoResponse: (id) =>
    set((state) => {
      const alert = state.alerts.find((entry) => entry.id === id);
      if (!alert) {
        return state;
      }

      const ignoredUserKey = buildWatchlistUserKey(alert.username, alert.userSlug);

      return {
        alerts: state.alerts.filter((entry) => entry.id !== id),
        watchlist: state.watchlist.map((item) =>
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
        ),
      };
    }),
  dismissSystemAlert: (id) =>
    set((state) => ({
      systemAlerts: state.systemAlerts.filter((alert) => alert.id !== id),
      worldStateSystemAlertDismissed:
        id === WORLDSTATE_SYSTEM_ALERT_ID ? true : state.worldStateSystemAlertDismissed,
    })),
  clearAllSystemAlerts: () =>
    set((state) => ({
      systemAlerts: [],
      worldStateSystemAlertDismissed:
        state.systemAlerts.some((alert) => alert.id === WORLDSTATE_SYSTEM_ALERT_ID)
          ? true
          : state.worldStateSystemAlertDismissed,
    })),
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
  refreshWatchlistItem: async (id) => {
    const currentState = get();
    const item = currentState.watchlist.find((entry) => entry.id === id);
    if (!item) {
      return { alertTriggered: false };
    }

    try {
      const response = await getWfmItemOrders(item.slug, item.variantKey);
      const latestState = get();
      const latestItem = latestState.watchlist.find((entry) => entry.id === id);
      if (!latestItem) {
        return { alertTriggered: false };
      }

      const nextScanAt =
        Date.now() + getWatchlistPollIntervalMs(Math.max(latestState.watchlist.length, 1));
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
      const existingAlert = latestState.alerts.find(
        (alert) => alert.watchlistId === latestItem.id,
      );
      const nextAlert =
        preferredOrder && latestItem.targetPrice >= preferredOrder.platinum
          ? buildWatchlistAlert(latestItem, preferredOrder)
          : null;
      const alertTriggered =
        nextAlert !== null &&
        (!existingAlert || existingAlert.orderId !== nextAlert.orderId);

      set((state) => ({
        watchlist: state.watchlist.map((entry) =>
          entry.id === latestItem.id ? updatedItem : entry,
        ),
        alerts: nextAlert
          ? [
              nextAlert,
              ...state.alerts.filter((alert) => alert.watchlistId !== latestItem.id),
            ]
          : state.alerts,
      }));

      return { alertTriggered };
    } catch (error) {
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

      set((state) => ({
        watchlist: state.watchlist.map((entry) =>
          entry.id === latestItem.id
            ? {
                ...entry,
                retryCount: nextRetryCount,
                nextScanAt: Date.now() + retryDelayMs,
                lastError: toErrorMessage(error),
              }
            : entry,
        ),
      }));

      return { alertTriggered: false };
    }
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
    const previousTrackedSelection = get().searchTrackingSource;

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
      const response = await loadQuickViewOrdersForSelection(item, defaultVariantKey);
      if (requestId !== quickViewRequestSequence) {
        return;
      }

      let nextTrackedSelection = await persistSearchedItemSelection(previousTrackedSelection, item);
      let nextSelectedVariantKey: string | null = defaultVariantKey;
      let nextSelectedVariantLabel: string | null =
        variants.find((variant) => variant.key === defaultVariantKey)?.label
        ?? (defaultVariantKey.startsWith('rank:')
          ? `Rank ${defaultVariantKey.slice(5)}`
          : 'Base Market');

      if (nextTrackedSelection?.variantKey !== nextSelectedVariantKey) {
        const syncedSelection = await syncSearchTrackingSelection(
          nextTrackedSelection,
          item,
          nextSelectedVariantKey,
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
          sellOrders: response.sellOrders,
          sparklinePoints: [],
          sparklineLoading: true,
          apiVersion: response.apiVersion,
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
            ? get().marketAnalysisCache[buildMarketAnalysisCacheKey(item.itemId, nextSelectedVariantKey)] ?? null
            : null,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
      });

      void getItemAnalytics(
        item.itemId,
        item.slug,
        nextSelectedVariantKey,
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

      set({
        quickView: {
          selectedItem: item,
          sellOrders: [],
          sparklinePoints: [],
          sparklineLoading: false,
          apiVersion: null,
          loading: false,
          errorMessage: toErrorMessage(error),
        },
        marketVariants: [],
        marketVariantsLoading: false,
        marketVariantsError: toErrorMessage(error),
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
          ? state.marketAnalysisCache[buildMarketAnalysisCacheKey(selectedItem.itemId, variantKey)] ?? null
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
      );
      const response = await loadQuickViewOrdersForSelection(selectedItem, variantKey);
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
            ? currentState.marketAnalysisCache[buildMarketAnalysisCacheKey(selectedItem.itemId, variantKey)] ?? null
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
      set((currentState) => ({
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: toErrorMessage(error),
        quickView: {
          ...currentState.quickView,
          sparklinePoints: [],
          sparklineLoading: false,
          loading: false,
          errorMessage: toErrorMessage(error),
        },
      }));
    }
  },
  loadSelectedMarketAnalysis: async (options) => {
    const state = get();
    const selectedItem = state.quickView.selectedItem;
    const selectedVariantKey = state.selectedMarketVariantKey;
    const force = options?.force ?? false;

    if (!selectedItem || !selectedVariantKey) {
      set({
        selectedMarketAnalysis: null,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
      });
      return;
    }

    const cacheKey = buildMarketAnalysisCacheKey(selectedItem.itemId, selectedVariantKey);
    const cached = state.marketAnalysisCache[cacheKey] ?? null;

    if (cached && !force) {
      set({
        selectedMarketAnalysis: cached,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: null,
      });
      return;
    }

    const requestId = ++marketAnalysisRequestSequence;
    set({
      selectedMarketAnalysis: cached,
      selectedMarketAnalysisLoading: true,
      selectedMarketAnalysisError: null,
    });

    try {
      await ensureMarketTracking(
        selectedItem.itemId,
        selectedItem.slug,
        selectedVariantKey,
        'analytics',
      );
      const analysis = await getItemAnalysis(
        selectedItem.itemId,
        selectedItem.slug,
        selectedVariantKey,
      );
      if (requestId !== marketAnalysisRequestSequence) {
        return;
      }
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
    } catch (error) {
      if (requestId !== marketAnalysisRequestSequence) {
        return;
      }
      set((currentState) => ({
        selectedMarketAnalysis: currentState.marketAnalysisCache[cacheKey] ?? currentState.selectedMarketAnalysis,
        selectedMarketAnalysisLoading: false,
        selectedMarketAnalysisError: toErrorMessage(error),
      }));
    }
  },

  tradesSubTab: 'sell-orders',
  setTradesSubTab: (tab) => set({ tradesSubTab: tab }),
  sellOrders: mockSellOrders,
  removeSellOrder: (id) =>
    set((state) => ({ sellOrders: state.sellOrders.filter((order) => order.id !== id) })),
  newOrderName: '',
  setNewOrderName: (val) => set({ newOrderName: val }),
  newOrderPrice: '10',
  setNewOrderPrice: (val) => set({ newOrderPrice: val }),
  newOrderQty: '1',
  setNewOrderQty: (val) => set({ newOrderQty: val }),
  newOrderRank: '0',
  setNewOrderRank: (val) => set({ newOrderRank: val }),

  tradePeriod: '30d',
  setTradePeriod: (period) => set({ tradePeriod: period }),

  marketSubTab: 'analysis',
  setMarketSubTab: (tab) => set({ marketSubTab: tab }),

  eventsSubTab: 'active-events',
  setEventsSubTab: (tab) => set({ eventsSubTab: tab }),
}));
