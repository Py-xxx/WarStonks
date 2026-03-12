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
export type WorldStateEndpointKey =
  | 'events'
  | 'alerts'
  | 'sortie'
  | 'arbitration'
  | 'archon-hunt'
  | 'fissures'
  | 'invasions'
  | 'syndicate-missions'
  | 'void-trader'
  | 'market-news';

export type SystemAlertKind = 'worldstate-offline';

export interface WatchlistItem {
  id: string;
  itemId: number;
  name: string;
  displayName: string;
  slug: string;
  variantKey: string;
  variantLabel: string;
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

export interface SystemAlert {
  id: string;
  kind: SystemAlertKind;
  sourceKeys: WorldStateEndpointKey[];
  title: string;
  message: string;
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

export interface WfstatAlertMission {
  description: string | null;
  node: string | null;
  nodeKey: string | null;
  type: string | null;
  typeKey: string | null;
  faction: string | null;
  factionKey: string | null;
  reward: WfstatEventReward | null;
  minEnemyLevel: number | null;
  maxEnemyLevel: number | null;
  maxWaveNum: number | null;
  nightmare: boolean;
  archwingRequired: boolean;
  isSharkwing: boolean;
}

export interface WfstatAlert {
  id: string;
  activation: string | null;
  expiry: string | null;
  mission: WfstatAlertMission | null;
  rewardTypes: string[];
  tag: string | null;
  expired?: boolean;
}

export interface WfstatSortieVariant {
  missionType: string | null;
  missionTypeKey: string | null;
  modifier: string | null;
  modifierDescription: string | null;
  node: string | null;
  nodeKey: string | null;
}

export interface WfstatSortie {
  id: string;
  activation: string | null;
  expiry: string | null;
  rewardPool: string | null;
  variants: WfstatSortieVariant[];
  boss: string | null;
  faction: string | null;
  factionKey: string | null;
  expired?: boolean;
}

export interface WfstatArbitration {
  id: string;
  node: string | null;
  nodeKey: string | null;
  activation: string | null;
  expiry: string | null;
  enemy: string | null;
  type: string | null;
  typeKey: string | null;
  archwing: boolean;
  sharkwing: boolean;
  expired?: boolean;
}

export interface WfstatArchonMission {
  node: string | null;
  nodeKey: string | null;
  type: string | null;
  typeKey: string | null;
  nightmare: boolean;
  archwingRequired: boolean;
  isSharkwing: boolean;
}

export interface WfstatArchonHunt {
  id: string;
  activation: string | null;
  expiry: string | null;
  rewardPool: string | null;
  missions: WfstatArchonMission[];
  boss: string | null;
  faction: string | null;
  factionKey: string | null;
  expired?: boolean;
}

export interface WfstatInvasionSide {
  reward: WfstatEventReward | null;
  faction: string | null;
  factionKey: string | null;
}

export interface WfstatInvasion {
  id: string;
  activation: string | null;
  node: string | null;
  nodeKey: string | null;
  desc: string | null;
  attacker: WfstatInvasionSide;
  defender: WfstatInvasionSide;
  vsInfestation: boolean;
  count: number | null;
  requiredRuns: number | null;
  completion: number | null;
  completed: boolean;
  rewardTypes: string[];
}

export interface WfstatSyndicateJobDrop {
  item: string;
  rarity: string | null;
  chance: number | null;
  count: number | null;
}

export interface WfstatSyndicateJob {
  id: string;
  expiry: string | null;
  uniqueName: string | null;
  rewardPool: string[];
  rewardPoolDrops: WfstatSyndicateJobDrop[];
  type: string | null;
  enemyLevels: number[];
  standingStages: number[];
  minMR: number | null;
}

export interface WfstatSyndicateMission {
  id: string;
  activation: string | null;
  expiry: string | null;
  syndicate: string | null;
  syndicateKey: string | null;
  nodes: string[];
  jobs: WfstatSyndicateJob[];
  expired?: boolean;
}

export interface VoidTraderInventoryItem {
  item: string;
  ducats: number | null;
  credits: number | null;
  category: string;
  imagePath: string | null;
}

export interface WfstatVoidTrader {
  id: string;
  activation: string | null;
  expiry: string | null;
  character: string;
  location: string | null;
  inventory: VoidTraderInventoryItem[];
  psId: string | null;
  initialStart: string | null;
  schedule: Record<string, unknown>[];
  expired?: boolean;
}

export interface WfstatFissure {
  id: string;
  activation: string | null;
  expiry: string | null;
  node: string | null;
  missionType: string | null;
  missionTypeKey: string | null;
  enemy: string | null;
  enemyKey: string | null;
  nodeKey: string | null;
  tier: string | null;
  tierNum: number | null;
  isStorm: boolean;
  isHard: boolean;
  expired?: boolean;
}

export interface WfstatNewsItem {
  id: string;
  message: string;
  link: string | null;
  imageLink: string | null;
  priority: boolean;
  date: string | null;
  activation: string | null;
  expiry: string | null;
  update: boolean;
  primeAccess: boolean;
  stream: boolean;
  mobileOnly: boolean;
  expired?: boolean;
}

export interface WfstatFlashSale {
  id: string;
  item: string;
  activation: string | null;
  expiry: string | null;
  discount: number | null;
  premiumOverride: number | null;
  regularOverride: number | null;
  isShownInMarket: boolean;
  expired?: boolean;
}

export interface RelicTierIcon {
  tier: string;
  imagePath: string;
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

export type MarketTrackingSource =
  | 'search'
  | 'watchlist'
  | 'analytics'
  | 'trade-health';

export interface MarketVariant {
  key: string;
  label: string;
  rank: number | null;
  isDefault: boolean;
}

export interface MarketDepthLevel {
  side: string;
  price: number;
  quantity: number;
  orderCount: number;
  bandKind: string;
}

export interface MarketSnapshot {
  capturedAt: string;
  lowestSell: number | null;
  medianSell: number | null;
  highestBuy: number | null;
  spread: number | null;
  spreadPct: number | null;
  sellOrderCount: number;
  sellQuantity: number;
  buyOrderCount: number;
  buyQuantity: number;
  nearFloorSellerCount: number;
  nearFloorQuantity: number;
  uniqueSellUsers: number;
  uniqueBuyUsers: number;
  pressureRatio: number | null;
  entryDepth: number;
  exitDepth: number;
  depthLevels: MarketDepthLevel[];
}

export interface WfmDetailedOrder {
  orderId: string;
  orderType: string;
  platinum: number;
  quantity: number;
  perTrade: number;
  rank: number | null;
  username: string;
  userSlug: string | null;
  status: string | null;
  updatedAt: string | null;
}

export interface MarketConfidenceSummary {
  level: 'high' | 'medium' | 'low';
  label: string;
  reasons: string[];
  isDegraded: boolean;
}

export interface EntryExitZoneOverview {
  currentLowestPrice: number | null;
  currentMedianLowestPrice: number | null;
  fairValueLow: number | null;
  fairValueHigh: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  exitZoneLow: number | null;
  exitZoneHigh: number | null;
  zoneQuality: string;
  entryRationale: string;
  exitRationale: string;
  confidenceSummary: MarketConfidenceSummary;
}

export interface OrderbookPressureSummary {
  cheapestSell: number | null;
  highestBuy: number | null;
  spread: number | null;
  spreadPct: number | null;
  entryDepth: number;
  exitDepth: number;
  pressureRatio: number | null;
  pressureLabel: string;
  confidenceSummary: MarketConfidenceSummary;
}

export interface TrendMetricSet {
  slope1h: number | null;
  slope3h: number | null;
  slope6h: number | null;
  crossSignal: string;
  reversal: string;
  confidence: number;
  confirmingSignals: string[];
}

export interface TrendQualityBreakdown {
  selectedTab: string;
  tabs: Record<string, TrendMetricSet>;
  stability: number;
  volatility: number;
  noise: number;
  confidenceSummary: MarketConfidenceSummary;
}

export interface AnalyticsActionCard {
  suggestedAction: string;
  tone: string;
  zoneQuality: string;
  zoneAdjustedEdge: number | null;
  spread: number | null;
  spreadPct: number | null;
  pressureLabel: string;
  alignedSignals: string[];
  rationale: string;
  confidenceSummary: MarketConfidenceSummary;
}

export type AnalyticsDomainKey = '48h' | '7d' | '30d' | '90d';
export type AnalyticsBucketSizeKey = '1h' | '3h' | '6h' | '12h' | '18h' | '24h' | '7d' | '14d';

export interface AnalyticsChartPoint {
  bucketAt: string;
  openPrice: number | null;
  closedPrice: number | null;
  lowPrice: number | null;
  highPrice: number | null;
  lowestSell: number | null;
  medianSell: number | null;
  movingAvg: number | null;
  weightedAvg: number | null;
  averagePrice: number | null;
  highestBuy: number | null;
  fairValueLow: number | null;
  fairValueHigh: number | null;
  entryZone: number | null;
  exitZone: number | null;
  volume: number;
}

export interface ItemAnalyticsResponse {
  itemId: number;
  slug: string;
  variantKey: string;
  variantLabel: string;
  chartDomainKey: AnalyticsDomainKey;
  chartBucketSizeKey: AnalyticsBucketSizeKey;
  computedAt: string;
  sourceSnapshotAt: string | null;
  sourceStatsFetchedAt: string | null;
  currentSnapshot: MarketSnapshot | null;
  chartPoints: AnalyticsChartPoint[];
  entryExitZoneOverview: EntryExitZoneOverview;
  orderbookPressure: OrderbookPressureSummary;
  trendQualityBreakdown: TrendQualityBreakdown;
  actionCard: AnalyticsActionCard;
}

export interface AnalysisHeadline {
  entryPrice: number | null;
  exitPrice: number | null;
  exitPercentileLabel: string;
  netMargin: number | null;
  liquidityScore: number | null;
  liquidityLabel: string;
  confidenceSummary: MarketConfidenceSummary;
}

export interface FlipAnalysisSummary {
  entryPrice: number | null;
  exitPrice: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  efficiencyScore: number | null;
  efficiencyLabel: string;
  confidenceSummary: MarketConfidenceSummary;
}

export interface LiquidityDetailSummary {
  demandRatio: number | null;
  state: string;
  sellersWithinTwoPt: number;
  undercutVelocity: number | null;
  quantityWeightedDemand: number | null;
  liquidityScore: number | null;
  confidenceSummary: MarketConfidenceSummary;
}

export interface TrendSummary {
  direction: string;
  confidence: number | null;
  summary: string;
  slope1h: number | null;
  slope3h: number | null;
  slope6h: number | null;
  confidenceSummary: MarketConfidenceSummary;
}

export interface ManipulationSignalState {
  key: string;
  label: string;
  active: boolean;
  detail: string;
}

export interface ManipulationRiskSummary {
  riskLevel: string;
  activeSignals: number;
  efficiencyPenaltyPct: number;
  signals: ManipulationSignalState[];
  confidenceSummary: MarketConfidenceSummary;
}

export interface TimeOfDayLiquidityBucket {
  hour: number;
  label: string;
  avgVisibleQuantity: number;
  avgSellOrders: number;
  avgSpreadPct: number | null;
}

export interface TimeOfDayLiquiditySummary {
  currentHourLabel: string;
  strongestWindowLabel: string | null;
  weakestWindowLabel: string | null;
  buckets: TimeOfDayLiquidityBucket[];
  confidenceSummary: MarketConfidenceSummary;
}

export interface ItemDetailSummary {
  itemId: number;
  name: string;
  slug: string;
  imagePath: string | null;
  wikiLink: string | null;
  description: string | null;
  itemFamily: string | null;
  category: string | null;
  itemType: string | null;
  rarity: string | null;
  compatName: string | null;
  productCategory: string | null;
  polarity: string | null;
  stancePolarity: string | null;
  modSet: string | null;
  masteryReq: number | null;
  maxRank: number | null;
  baseDrain: number | null;
  fusionLimit: number | null;
  ducats: number | null;
  marketCost: number | null;
  buildPrice: number | null;
  buildQuantity: number | null;
  buildTime: number | null;
  skipBuildTimePrice: number | null;
  itemCount: number | null;
  tradable: boolean | null;
  prime: boolean | null;
  vaulted: boolean | null;
  relicTier: string | null;
  relicCode: string | null;
  criticalChance: number | null;
  criticalMultiplier: number | null;
  statusChance: number | null;
  fireRate: number | null;
  reloadTime: number | null;
  magazineSize: number | null;
  multishot: number | null;
  totalDamage: number | null;
  disposition: number | null;
  range: number | null;
  followThrough: number | null;
  blockingAngle: number | null;
  comboDuration: number | null;
  heavyAttackDamage: number | null;
  slamAttack: number | null;
  heavySlamAttack: number | null;
  windUp: number | null;
  health: number | null;
  shield: number | null;
  armor: number | null;
  sprintSpeed: number | null;
  power: number | null;
  stamina: number | null;
  noise: string | null;
  trigger: string | null;
  releaseDate: string | null;
  estimatedVaultDate: string | null;
  vaultDate: string | null;
  tags: string[];
  polarities: string[];
  parentNames: string[];
  abilityNames: string[];
  attackNames: string[];
  rankScaleLabel: string | null;
  statHighlights: string[];
}

export interface SetComponentAnalysisEntry {
  itemId: number | null;
  slug: string;
  name: string;
  imagePath: string | null;
  currentLowestPrice: number | null;
  recommendedEntryPrice: number | null;
  variantKey: string;
  variantLabel: string;
}

export interface DropSourceEntry {
  location: string;
  chance: number | null;
  rarity: string | null;
  sourceType: string | null;
}

export interface ItemSupplyContext {
  mode: 'set-components' | 'drop-sources' | 'none';
  components: SetComponentAnalysisEntry[];
  dropSources: DropSourceEntry[];
  confidenceSummary: MarketConfidenceSummary;
}

export interface ItemAnalysisResponse {
  itemId: number;
  slug: string;
  variantKey: string;
  variantLabel: string;
  computedAt: string;
  sourceSnapshotAt: string | null;
  sourceStatsFetchedAt: string | null;
  headline: AnalysisHeadline;
  flipAnalysis: FlipAnalysisSummary;
  liquidityDetail: LiquidityDetailSummary;
  trend: TrendSummary;
  manipulationRisk: ManipulationRiskSummary;
  timeOfDayLiquidity: TimeOfDayLiquiditySummary;
  itemDetails: ItemDetailSummary;
  supplyContext: ItemSupplyContext;
}

export interface ArbitrageScannerComponentEntry {
  itemId: number | null;
  slug: string;
  name: string;
  imagePath: string | null;
  quantityInSet: number;
  recommendedEntryLow: number | null;
  recommendedEntryHigh: number | null;
  recommendedEntryPrice: number | null;
  currentStatsPrice: number | null;
  entryAtOrBelowPrice: boolean;
  liquidityScore: number;
  confidenceSummary: MarketConfidenceSummary;
}

export interface ArbitrageScannerSetEntry {
  setItemId: number;
  slug: string;
  name: string;
  imagePath: string | null;
  componentCount: number;
  basketEntryCost: number | null;
  setExitLow: number | null;
  setExitHigh: number | null;
  recommendedSetExitPrice: number | null;
  grossMargin: number | null;
  roiPct: number | null;
  liquidityScore: number;
  arbitrageScore: number;
  saleState: string;
  confidenceSummary: MarketConfidenceSummary;
  note: string;
  components: ArbitrageScannerComponentEntry[];
}

export interface ArbitrageScannerResponse {
  computedAt: string;
  scannedSetCount: number;
  opportunityCount: number;
  refreshedSetCount: number;
  refreshedStatisticsCount: number;
  results: ArbitrageScannerSetEntry[];
}

export interface QuickViewSelection {
  selectedItem: WfmAutocompleteItem | null;
  sellOrders: WfmTopSellOrder[];
  sparklinePoints: number[];
  sparklineLoading: boolean;
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

export interface PersistedWorldStateCacheEntry {
  payload: unknown;
  fetchedAt: string;
  nextRefreshAt: string | null;
}
