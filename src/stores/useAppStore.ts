import { create } from 'zustand';
import {
  getAppSettings,
  getCurrencyBalances,
  getWfmTopSellOrders,
  saveAlecaframeSettings,
} from '../lib/tauriClient';
import {
  fetchWorldStateEventsSnapshot,
  fetchWorldStateFissuresSnapshot,
  fetchWorldStateVoidTraderSnapshot,
  WORLDSTATE_RETRY_DELAY_MS,
} from '../lib/worldState';
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
  WfstatFissure,
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
let worldStateFissuresRefreshPromise: Promise<void> | null = null;
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
  worldStateFissures: WfstatFissure[];
  worldStateFissuresLoading: boolean;
  worldStateFissuresError: string | null;
  worldStateFissuresNextRefreshAt: string | null;
  worldStateFissuresLastUpdatedAt: string | null;
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
  refreshWorldStateFissures: () => Promise<void>;
  refreshWorldStateVoidTrader: () => Promise<void>;

  sellerMode: SellerMode;
  setSellerMode: (mode: SellerMode) => void;
  autoProfile: boolean;
  toggleAutoProfile: () => void;

  watchlist: WatchlistItem[];
  alerts: WatchlistAlert[];
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
  worldStateFissures: [],
  worldStateFissuresLoading: false,
  worldStateFissuresError: null,
  worldStateFissuresNextRefreshAt: null,
  worldStateFissuresLastUpdatedAt: null,
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
        set({
          worldStateEvents: snapshot.events,
          worldStateEventsLoading: false,
          worldStateEventsError: null,
          worldStateEventsNextRefreshAt: snapshot.nextRefreshAt,
          worldStateEventsLastUpdatedAt: snapshot.fetchedAt,
        });
      } catch (error) {
        set((state) => ({
          worldStateEventsLoading: false,
          worldStateEventsError: toErrorMessage(error),
          worldStateEventsNextRefreshAt:
            state.worldStateEventsNextRefreshAt ??
            new Date(Date.now() + WORLDSTATE_RETRY_DELAY_MS).toISOString(),
        }));
      } finally {
        worldStateEventsRefreshPromise = null;
      }
    })();

    return worldStateEventsRefreshPromise;
  },
  refreshWorldStateFissures: async () => {
    if (worldStateFissuresRefreshPromise) {
      return worldStateFissuresRefreshPromise;
    }

    set({ worldStateFissuresLoading: true });

    worldStateFissuresRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateFissuresSnapshot();
        set({
          worldStateFissures: snapshot.fissures,
          worldStateFissuresLoading: false,
          worldStateFissuresError: null,
          worldStateFissuresNextRefreshAt: snapshot.nextRefreshAt,
          worldStateFissuresLastUpdatedAt: snapshot.fetchedAt,
        });
      } catch (error) {
        set((state) => ({
          worldStateFissuresLoading: false,
          worldStateFissuresError: toErrorMessage(error),
          worldStateFissuresNextRefreshAt:
            state.worldStateFissuresNextRefreshAt ??
            new Date(Date.now() + WORLDSTATE_RETRY_DELAY_MS).toISOString(),
        }));
      } finally {
        worldStateFissuresRefreshPromise = null;
      }
    })();

    return worldStateFissuresRefreshPromise;
  },
  refreshWorldStateVoidTrader: async () => {
    if (worldStateVoidTraderRefreshPromise) {
      return worldStateVoidTraderRefreshPromise;
    }

    set({ worldStateVoidTraderLoading: true });

    worldStateVoidTraderRefreshPromise = (async () => {
      try {
        const snapshot = await fetchWorldStateVoidTraderSnapshot();
        set({
          worldStateVoidTrader: snapshot.voidTrader,
          worldStateVoidTraderLoading: false,
          worldStateVoidTraderError: null,
          worldStateVoidTraderNextRefreshAt: snapshot.nextRefreshAt,
          worldStateVoidTraderLastUpdatedAt: snapshot.fetchedAt,
        });
      } catch (error) {
        set((state) => ({
          worldStateVoidTraderLoading: false,
          worldStateVoidTraderError: toErrorMessage(error),
          worldStateVoidTraderNextRefreshAt:
            state.worldStateVoidTraderNextRefreshAt ??
            new Date(Date.now() + WORLDSTATE_RETRY_DELAY_MS).toISOString(),
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
