export type PageId =
  | 'home'
  | 'market'
  | 'events'
  | 'scanners'
  | 'opportunities'
  | 'trades'
  | 'portfolio'
  | 'strategy';

export type HomeSubTab = 'overview' | 'watchlist' | 'events-tab';
export type SellerMode = 'ingame' | 'ingame-online';
export type TradePeriod = '7d' | '30d' | 'all';
export type TradesSubTab = 'sell-orders' | 'buy-orders' | 'health';

export interface WatchlistItem {
  id: string;
  name: string;
  targetPrice: number;
  currentPrice: number;
  entryPrice: number;
  exitPrice: number;
  volume: number;
  delta24h: number; // percent
  score: number;
}

export interface TradeOrder {
  id: string;
  name: string;
  slug: string;
  emoji: string;
  qty: number;
  yourPrice: number;
  marketLow: number;
  healthScore: number;
  healthNote: string;
  checkedAgo: string;
}

export interface PortfolioTrade {
  id: string;
  item: string;
  buyPrice: number;
  sellPrice: number;
  profit: number;
  date: string;
  category: string;
  holdHours: number;
}

export interface GameEvent {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'upcoming' | 'ended';
  tier: 'low' | 'medium' | 'high';
}

export interface CurrencyBalance {
  platinum: number | null;
  credits: number | null;
  endo: number | null;
  ducats: number | null;
  aya: number | null;
}

export interface QuickViewData {
  item: string;
  entry: number;
  exit: number;
  volume: number;
  spread: number;
  trend: number;
  efficiency: number;
  score: number;
  sparkline: number[];
}

export interface AnalysisBar {
  label: string;
  value: number;
  color: 'green' | 'amber' | 'red';
}
