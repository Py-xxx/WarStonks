export type PageId =
  | 'home'
  | 'market'
  | 'events'
  | 'scanners'
  | 'opportunities'
  | 'trades'
  | 'portfolio'
  | 'strategy';

export type HomeSubTab = 'overview' | 'watchlist' | 'alerts';
export type SellerMode = 'ingame' | 'ingame-online';
export type TradePeriod = '7d' | '30d' | 'all';
export type TradesSubTab = 'sell-orders' | 'buy-orders' | 'health';
export type SettingsSection = 'alecaframe' | 'discord-webhook' | 'import-export';

export interface WatchlistItem {
  id: string;
  itemId: number;
  name: string;
  slug: string;
  imagePath: string | null;
  itemFamily: string | null;
  targetPrice: number;
  currentPrice: number | null;
  currentSeller: string | null;
  currentUserSlug: string | null;
  currentOrderId: string | null;
  currentQuantity: number | null;
  currentRank: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  volume: number;
  delta24h: number; // percent
  score: number;
  lastUpdatedAt: string | null;
  nextScanAt: number;
  retryCount: number;
  lastError: string | null;
  ignoredUserKeys: string[];
}

export interface WatchlistAlert {
  id: string;
  watchlistId: string;
  itemName: string;
  itemSlug: string;
  itemImagePath: string | null;
  username: string;
  userSlug: string | null;
  price: number;
  quantity: number;
  rank: number | null;
  orderId: string;
  createdAt: string;
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

export interface WfstatEventRewardCountedItem {
  count: number;
  type: string;
  key: string | null;
}

export interface WfstatEventReward {
  items: string[];
  countedItems: WfstatEventRewardCountedItem[];
  credits: number | null;
  thumbnail: string | null;
  color: number | null;
}

export interface WfstatEventInterimStep {
  goal: number | null;
  reward: WfstatEventReward | null;
  message: Record<string, unknown>;
}

export interface WfstatWorldStateEvent {
  id: string;
  activation: string | null;
  expiry: string | null;
  description: string;
  tooltip: string | null;
  node: string | null;
  rewards: WfstatEventReward[];
  interimSteps: WfstatEventInterimStep[];
  jobs: Record<string, unknown>[];
  previousJobs: Record<string, unknown>[];
  concurrentNodes: string[];
  progressSteps: number[];
  regionDrops: string[];
  archwingDrops: string[];
  maximumScore: number | null;
  currentScore: number | null;
  health: number | null;
  scoreLocTag: string | null;
  scoreVar: string | null;
  tag: string | null;
  altExpiry: string | null;
  altActivation: string | null;
  isPersonal: boolean;
  isCommunity: boolean;
  showTotalAtEndOfMission: boolean;
  expired?: boolean;
}

export interface CurrencyBalance {
  platinum: number | null;
  credits: number | null;
  endo: number | null;
  ducats: number | null;
  aya: number | null;
}

export interface AlecaframeSettings {
  enabled: boolean;
  publicLink: string | null;
  usernameWhenPublic: string | null;
  lastValidatedAt: string | null;
}

export interface DiscordWebhookSettings {
  enabled: boolean;
  webhookUrl: string | null;
}

export interface AppSettings {
  alecaframe: AlecaframeSettings;
  discordWebhook: DiscordWebhookSettings;
}

export interface AlecaframeSettingsInput {
  enabled: boolean;
  publicLink: string | null;
}

export interface AlecaframeValidationResult {
  valid: boolean;
  normalizedPublicLink: string;
  publicToken: string;
  usernameWhenPublic: string | null;
  lastUpdate: string | null;
  balances: CurrencyBalance;
}

export interface WalletSnapshot {
  enabled: boolean;
  configured: boolean;
  balances: CurrencyBalance;
  usernameWhenPublic: string | null;
  lastUpdate: string | null;
  errorMessage: string | null;
}

export interface WfmAutocompleteItem {
  itemId: number;
  name: string;
  slug: string;
  maxRank: number | null;
  itemFamily: string | null;
  imagePath: string | null;
}

export interface WfmTopSellOrder {
  orderId: string;
  platinum: number;
  quantity: number;
  perTrade: number;
  rank: number | null;
  username: string;
  userSlug: string | null;
  status: string | null;
}

export interface QuickViewSelection {
  selectedItem: WfmAutocompleteItem | null;
  sellOrders: WfmTopSellOrder[];
  apiVersion: string | null;
  loading: boolean;
  errorMessage: string | null;
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
