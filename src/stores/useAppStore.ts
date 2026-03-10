import { create } from 'zustand';
import type {
  PageId,
  HomeSubTab,
  SellerMode,
  TradePeriod,
  TradesSubTab,
  WatchlistItem,
  TradeOrder,
} from '../types';
import { mockWatchlist } from '../mocks/watchlist';
import { mockSellOrders } from '../mocks/trades';

interface AppStore {
  // Navigation
  activePage: PageId;
  setActivePage: (page: PageId) => void;

  // Home sub-tabs
  homeSubTab: HomeSubTab;
  setHomeSubTab: (tab: HomeSubTab) => void;

  // Sidebar
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  // Filters
  sellerMode: SellerMode;
  setSellerMode: (mode: SellerMode) => void;
  autoProfile: boolean;
  toggleAutoProfile: () => void;

  // Watchlist
  watchlist: WatchlistItem[];
  selectedWatchlistId: string | null;
  setSelectedWatchlist: (id: string | null) => void;
  addWatchlistItem: (name: string, targetPrice: number) => void;
  removeWatchlistItem: (id: string) => void;
  watchlistTargetInput: string;
  setWatchlistTargetInput: (val: string) => void;

  // Trades
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

  // Portfolio
  tradePeriod: TradePeriod;
  setTradePeriod: (p: TradePeriod) => void;

  // Market
  marketSubTab: 'analysis' | 'analytics';
  setMarketSubTab: (tab: 'analysis' | 'analytics') => void;

  // Events page sub tab
  eventsSubTab: 'fissures' | 'activities' | 'market-news';
  setEventsSubTab: (tab: 'fissures' | 'activities' | 'market-news') => void;
}

export const useAppStore = create<AppStore>((set) => ({
  // Navigation
  activePage: 'home',
  setActivePage: (page) => set({ activePage: page }),

  // Home sub-tabs
  homeSubTab: 'overview',
  setHomeSubTab: (tab) => set({ homeSubTab: tab }),

  // Sidebar
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  // Filters
  sellerMode: 'ingame',
  setSellerMode: (mode) => set({ sellerMode: mode }),
  autoProfile: false,
  toggleAutoProfile: () => set((s) => ({ autoProfile: !s.autoProfile })),

  // Watchlist
  watchlist: mockWatchlist,
  selectedWatchlistId: mockWatchlist[0]?.id ?? null,
  setSelectedWatchlist: (id) => set({ selectedWatchlistId: id }),
  addWatchlistItem: (name, targetPrice) =>
    set((s) => ({
      watchlist: [
        ...s.watchlist,
        {
          id: name.toLowerCase().replace(/\s+/g, '-'),
          name,
          targetPrice,
          currentPrice: targetPrice,
          entryPrice: targetPrice,
          exitPrice: targetPrice,
          volume: 0,
          delta24h: 0,
          score: 0,
        },
      ],
    })),
  removeWatchlistItem: (id) =>
    set((s) => ({
      watchlist: s.watchlist.filter((w) => w.id !== id),
      selectedWatchlistId:
        s.selectedWatchlistId === id
          ? s.watchlist.find((w) => w.id !== id)?.id ?? null
          : s.selectedWatchlistId,
    })),
  watchlistTargetInput: '',
  setWatchlistTargetInput: (val) => set({ watchlistTargetInput: val }),

  // Trades
  tradesSubTab: 'sell-orders',
  setTradesSubTab: (tab) => set({ tradesSubTab: tab }),
  sellOrders: mockSellOrders,
  removeSellOrder: (id) =>
    set((s) => ({ sellOrders: s.sellOrders.filter((o) => o.id !== id) })),
  newOrderName: '',
  setNewOrderName: (val) => set({ newOrderName: val }),
  newOrderPrice: '10',
  setNewOrderPrice: (val) => set({ newOrderPrice: val }),
  newOrderQty: '1',
  setNewOrderQty: (val) => set({ newOrderQty: val }),
  newOrderRank: '0',
  setNewOrderRank: (val) => set({ newOrderRank: val }),

  // Portfolio
  tradePeriod: '30d',
  setTradePeriod: (p) => set({ tradePeriod: p }),

  // Market
  marketSubTab: 'analysis',
  setMarketSubTab: (tab) => set({ marketSubTab: tab }),

  // Events
  eventsSubTab: 'fissures',
  setEventsSubTab: (tab) => set({ eventsSubTab: tab }),
}));
