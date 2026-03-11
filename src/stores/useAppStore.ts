import { create } from 'zustand';
import {
  getAppSettings,
  getCurrencyBalances,
  getWfmTopSellOrders,
  saveAlecaframeSettings,
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
  WalletSnapshot,
  WfmAutocompleteItem,
  WfmTopSellOrder,
} from '../types';
import { mockSellOrders } from '../mocks/trades';

let quickViewRequestSequence = 0;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildWatchlistId(item: WfmAutocompleteItem): string {
  return item.slug;
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
    itemName: item.name,
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

function buildSystemAlert(sourceKey: WorldStateEndpointKey, message: string): SystemAlert {
  return {
    id: `system:${sourceKey}`,
    sourceKey,
    title: `${WORLDSTATE_ENDPOINT_LABELS[sourceKey]} refresh failed`,
    message,
    createdAt: new Date().toISOString(),
  };
}

function upsertSystemAlert(alerts: SystemAlert[], nextAlert: SystemAlert): SystemAlert[] {
  return [nextAlert, ...alerts.filter((alert) => alert.sourceKey !== nextAlert.sourceKey)];
}

function clearSystemAlert(alerts: SystemAlert[], sourceKey: WorldStateEndpointKey): SystemAlert[] {
  return alerts.filter((alert) => alert.sourceKey !== sourceKey);
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
  targetPrice: number,
  currentOrder: WfmTopSellOrder | null,
  currentCount: number,
  ignoredUserKeys: string[] = [],
): WatchlistItem {
  const nextScanAt = currentOrder
    ? Date.now() + getWatchlistPollIntervalMs(currentCount)
    : Date.now();

  return {
    id: buildWatchlistId(item),
    itemId: item.itemId,
    name: item.name,
    slug: item.slug,
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
  selectedWatchlistId: string | null;
  watchlistTargetInput: string;
  watchlistFormError: string | null;
  setSelectedWatchlist: (id: string | null) => void;
  setWatchlistTargetInput: (val: string) => void;
  addSelectedQuickViewToWatchlist: () => void;
  removeWatchlistItem: (id: string) => void;
  dismissAlert: (id: string) => void;
  clearAllAlerts: () => void;
  markAlertBought: (id: string) => void;
  markAlertNoResponse: (id: string) => void;
  dismissSystemAlert: (id: string) => void;
  clearAllSystemAlerts: () => void;
  refreshWatchlistItem: (id: string) => Promise<WatchlistRefreshResult>;

  quickView: QuickViewSelection;
  loadQuickViewItem: (item: WfmAutocompleteItem) => Promise<void>;

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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.events),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.events,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Active Events from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Active Events are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.alerts),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.alerts,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Alerts from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Alerts are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.sortie),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.sortie,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Sorties from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Sorties are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.arbitration),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.arbitration,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Arbitrations from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Arbitrations are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.archonHunt),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.archonHunt,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Archon Hunts from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Archon Hunts are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.fissures),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.fissures,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Fissures from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Fissures are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.marketNews),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.marketNews,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Market & News from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Market & News are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.invasions),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.invasions,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Invasions from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Invasions are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.syndicateMissions,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Syndicate Missions from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Syndicate Missions are available yet.',
            ),
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
        });
        set((state) => ({
          systemAlerts: clearSystemAlert(state.systemAlerts, WORLDSTATE_ENDPOINT_KEYS.voidTrader),
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
          systemAlerts: upsertSystemAlert(
            state.systemAlerts,
            buildSystemAlert(
              WORLDSTATE_ENDPOINT_KEYS.voidTrader,
              cachedSnapshot
                ? `WFStat is offline. Showing cached Void Trader data from ${cachedSnapshot.fetchedAt}.`
                : 'WFStat is offline and no cached Void Trader data is available yet.',
            ),
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
  selectedWatchlistId: null,
  watchlistTargetInput: '',
  watchlistFormError: null,
  setSelectedWatchlist: (id) => set({ selectedWatchlistId: id }),
  setWatchlistTargetInput: (val) =>
    set({ watchlistTargetInput: val, watchlistFormError: null }),
  addSelectedQuickViewToWatchlist: () => {
    const state = get();
    const selectedItem = state.quickView.selectedItem;

    if (!selectedItem) {
      set({
        watchlistFormError: 'Search and load a WFM item before adding it to the watchlist.',
      });
      return;
    }

    const targetPrice = Number.parseFloat(state.watchlistTargetInput);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      set({ watchlistFormError: 'Enter a desired price greater than 0.' });
      return;
    }

    const existingItem = state.watchlist.find((item) => item.slug === selectedItem.slug);
    const preferredOrder = selectPreferredWatchlistOrder(
      state.quickView.sellOrders,
      existingItem?.ignoredUserKeys ?? [],
    );
    const watchlistCount = existingItem
      ? state.watchlist.length
      : state.watchlist.length + 1;
    const nextItem = createWatchlistItem(
      selectedItem,
      targetPrice,
      preferredOrder,
      watchlistCount,
      existingItem?.ignoredUserKeys ?? [],
    );
    const nextAlert =
      preferredOrder && targetPrice >= preferredOrder.platinum
        ? buildWatchlistAlert(nextItem, preferredOrder)
        : null;

    set((currentState) => ({
      watchlist: existingItem
        ? currentState.watchlist.map((item) =>
            item.id === existingItem.id
              ? {
                  ...nextItem,
                  retryCount: existingItem.retryCount,
                  ignoredUserKeys: existingItem.ignoredUserKeys,
                }
              : item,
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
    }));
  },
  removeWatchlistItem: (id) =>
    set((state) => ({
      watchlist: state.watchlist.filter((item) => item.id !== id),
      alerts: state.alerts.filter((alert) => alert.watchlistId !== id),
      selectedWatchlistId:
        state.selectedWatchlistId === id
          ? state.watchlist.find((item) => item.id !== id)?.id ?? null
          : state.selectedWatchlistId,
      watchlistFormError: null,
    })),
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
    })),
  clearAllSystemAlerts: () => set({ systemAlerts: [] }),
  refreshWatchlistItem: async (id) => {
    const currentState = get();
    const item = currentState.watchlist.find((entry) => entry.id === id);
    if (!item) {
      return { alertTriggered: false };
    }

    try {
      const response = await getWfmTopSellOrders(item.slug);
      const latestState = get();
      const latestItem = latestState.watchlist.find((entry) => entry.id === id);
      if (!latestItem) {
        return { alertTriggered: false };
      }

      const nextScanAt =
        Date.now() + getWatchlistPollIntervalMs(Math.max(latestState.watchlist.length, 1));
      const preferredOrder = selectPreferredWatchlistOrder(
        response.sellOrders,
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
    apiVersion: null,
    loading: false,
    errorMessage: null,
  },
  loadQuickViewItem: async (item) => {
    const requestId = ++quickViewRequestSequence;

    set({
      activePage: 'home',
      homeSubTab: 'overview',
      quickView: {
        selectedItem: item,
        sellOrders: [],
        apiVersion: null,
        loading: true,
        errorMessage: null,
      },
    });

    try {
      const response = await getWfmTopSellOrders(item.slug);
      if (requestId !== quickViewRequestSequence) {
        return;
      }

      set({
        quickView: {
          selectedItem: item,
          sellOrders: response.sellOrders,
          apiVersion: response.apiVersion,
          loading: false,
          errorMessage: null,
        },
      });
    } catch (error) {
      if (requestId !== quickViewRequestSequence) {
        return;
      }

      set({
        quickView: {
          selectedItem: item,
          sellOrders: [],
          apiVersion: null,
          loading: false,
          errorMessage: toErrorMessage(error),
        },
      });
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
