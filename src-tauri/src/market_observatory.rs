use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime};

const ITEM_CATALOG_DATABASE_FILE: &str = "item_catalog.sqlite";
const MARKET_OBSERVATORY_DATABASE_FILE: &str = "market_observatory.sqlite";
const WFM_API_BASE_URL_V1: &str = "https://api.warframe.market/v1";
const WFM_API_BASE_URL_V2: &str = "https://api.warframe.market/v2";
const WFM_LANGUAGE_HEADER: &str = "en";
const WFM_PLATFORM_HEADER: &str = "pc";
const WFM_CROSSPLAY_HEADER: &str = "true";
const WFM_USER_AGENT: &str = "warstonks/3.0.0";
const TRACKING_SNAPSHOT_INTERVAL_MINUTES: i64 = 4;
const SNAPSHOT_RETENTION_DAYS: i64 = 30;
const ANALYTICS_CACHE_VERSION: i64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarketTrackingSource {
    Search,
    Watchlist,
    Analytics,
    TradeHealth,
}

impl MarketTrackingSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::Watchlist => "watchlist",
            Self::Analytics => "analytics",
            Self::TradeHealth => "trade-health",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "search" => Some(Self::Search),
            "watchlist" => Some(Self::Watchlist),
            "analytics" => Some(Self::Analytics),
            "trade-health" => Some(Self::TradeHealth),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnalyticsDomainKey {
    FortyEightHours,
    SevenDays,
    ThirtyDays,
    NinetyDays,
}

impl AnalyticsDomainKey {
    fn as_str(self) -> &'static str {
        match self {
            Self::FortyEightHours => "48h",
            Self::SevenDays => "7d",
            Self::ThirtyDays => "30d",
            Self::NinetyDays => "90d",
        }
    }

    fn lookback(self) -> TimeDuration {
        match self {
            Self::FortyEightHours => TimeDuration::hours(48),
            Self::SevenDays => TimeDuration::days(7),
            Self::ThirtyDays => TimeDuration::days(30),
            Self::NinetyDays => TimeDuration::days(90),
        }
    }
}

impl TryFrom<&str> for AnalyticsDomainKey {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self> {
        match value {
            "48h" | "1d" => Ok(Self::FortyEightHours),
            "7d" => Ok(Self::SevenDays),
            "30d" => Ok(Self::ThirtyDays),
            "90d" => Ok(Self::NinetyDays),
            _ => Err(anyhow!("unsupported analytics domain: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnalyticsBucketSizeKey {
    OneHour,
    ThreeHours,
    SixHours,
    TwelveHours,
    EighteenHours,
    TwentyFourHours,
    SevenDays,
    FourteenDays,
}

impl AnalyticsBucketSizeKey {
    fn as_str(self) -> &'static str {
        match self {
            Self::OneHour => "1h",
            Self::ThreeHours => "3h",
            Self::SixHours => "6h",
            Self::TwelveHours => "12h",
            Self::EighteenHours => "18h",
            Self::TwentyFourHours => "24h",
            Self::SevenDays => "7d",
            Self::FourteenDays => "14d",
        }
    }

    fn duration(self) -> TimeDuration {
        match self {
            Self::OneHour => TimeDuration::hours(1),
            Self::ThreeHours => TimeDuration::hours(3),
            Self::SixHours => TimeDuration::hours(6),
            Self::TwelveHours => TimeDuration::hours(12),
            Self::EighteenHours => TimeDuration::hours(18),
            Self::TwentyFourHours => TimeDuration::hours(24),
            Self::SevenDays => TimeDuration::days(7),
            Self::FourteenDays => TimeDuration::days(14),
        }
    }
}

impl TryFrom<&str> for AnalyticsBucketSizeKey {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self> {
        match value {
            "1h" => Ok(Self::OneHour),
            "3h" => Ok(Self::ThreeHours),
            "6h" => Ok(Self::SixHours),
            "12h" => Ok(Self::TwelveHours),
            "18h" => Ok(Self::EighteenHours),
            "24h" => Ok(Self::TwentyFourHours),
            "7d" => Ok(Self::SevenDays),
            "14d" => Ok(Self::FourteenDays),
            _ => Err(anyhow!("unsupported analytics bucket size: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketVariant {
    pub key: String,
    pub label: String,
    pub rank: Option<i64>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDepthLevel {
    pub side: String,
    pub price: f64,
    pub quantity: i64,
    pub order_count: i64,
    pub band_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSnapshot {
    pub captured_at: String,
    pub lowest_sell: Option<f64>,
    pub median_sell: Option<f64>,
    pub highest_buy: Option<f64>,
    pub spread: Option<f64>,
    pub spread_pct: Option<f64>,
    pub sell_order_count: i64,
    pub sell_quantity: i64,
    pub buy_order_count: i64,
    pub buy_quantity: i64,
    pub near_floor_seller_count: i64,
    pub near_floor_quantity: i64,
    pub unique_sell_users: i64,
    pub unique_buy_users: i64,
    pub pressure_ratio: Option<f64>,
    pub entry_depth: f64,
    pub exit_depth: f64,
    pub depth_levels: Vec<MarketDepthLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsChartPoint {
    pub bucket_at: String,
    pub open_price: Option<f64>,
    pub closed_price: Option<f64>,
    pub low_price: Option<f64>,
    pub high_price: Option<f64>,
    pub lowest_sell: Option<f64>,
    pub median_sell: Option<f64>,
    pub moving_avg: Option<f64>,
    pub weighted_avg: Option<f64>,
    pub average_price: Option<f64>,
    pub highest_buy: Option<f64>,
    pub fair_value_low: Option<f64>,
    pub fair_value_high: Option<f64>,
    pub entry_zone: Option<f64>,
    pub exit_zone: Option<f64>,
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryExitZoneOverview {
    pub current_lowest_price: Option<f64>,
    pub current_median_lowest_price: Option<f64>,
    pub fair_value_low: Option<f64>,
    pub fair_value_high: Option<f64>,
    pub entry_zone_low: Option<f64>,
    pub entry_zone_high: Option<f64>,
    pub exit_zone_low: Option<f64>,
    pub exit_zone_high: Option<f64>,
    pub zone_quality: String,
    pub entry_rationale: String,
    pub exit_rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderbookPressureSummary {
    pub cheapest_sell: Option<f64>,
    pub highest_buy: Option<f64>,
    pub spread: Option<f64>,
    pub spread_pct: Option<f64>,
    pub entry_depth: f64,
    pub exit_depth: f64,
    pub pressure_ratio: Option<f64>,
    pub pressure_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendMetricSet {
    pub slope_1h: Option<f64>,
    pub slope_3h: Option<f64>,
    pub slope_6h: Option<f64>,
    pub cross_signal: String,
    pub reversal: String,
    pub confidence: f64,
    pub confirming_signals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendQualityBreakdown {
    pub selected_tab: String,
    pub tabs: HashMap<String, TrendMetricSet>,
    pub stability: f64,
    pub volatility: f64,
    pub noise: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsActionCard {
    pub suggested_action: String,
    pub tone: String,
    pub zone_quality: String,
    pub zone_adjusted_edge: Option<f64>,
    pub spread: Option<f64>,
    pub spread_pct: Option<f64>,
    pub pressure_label: String,
    pub aligned_signals: Vec<String>,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemAnalyticsResponse {
    pub item_id: i64,
    pub slug: String,
    pub variant_key: String,
    pub variant_label: String,
    pub chart_domain_key: String,
    pub chart_bucket_size_key: String,
    pub computed_at: String,
    pub source_snapshot_at: Option<String>,
    pub source_stats_fetched_at: Option<String>,
    pub current_snapshot: Option<MarketSnapshot>,
    pub chart_points: Vec<AnalyticsChartPoint>,
    pub entry_exit_zone_overview: EntryExitZoneOverview,
    pub orderbook_pressure: OrderbookPressureSummary,
    pub trend_quality_breakdown: TrendQualityBreakdown,
    pub action_card: AnalyticsActionCard,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisHeadline {
    pub entry_price: Option<f64>,
    pub exit_price: Option<f64>,
    pub exit_percentile_label: String,
    pub net_margin: Option<f64>,
    pub liquidity_score: Option<f64>,
    pub liquidity_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlipAnalysisSummary {
    pub entry_price: Option<f64>,
    pub exit_price: Option<f64>,
    pub gross_margin: Option<f64>,
    pub net_margin: Option<f64>,
    pub efficiency_score: Option<f64>,
    pub efficiency_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiquidityDetailSummary {
    pub demand_ratio: Option<f64>,
    pub state: String,
    pub sellers_within_two_pt: i64,
    pub undercut_velocity: Option<f64>,
    pub quantity_weighted_demand: Option<f64>,
    pub liquidity_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendSummary {
    pub direction: String,
    pub confidence: Option<f64>,
    pub summary: String,
    pub slope_1h: Option<f64>,
    pub slope_3h: Option<f64>,
    pub slope_6h: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManipulationSignalState {
    pub key: String,
    pub label: String,
    pub active: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManipulationRiskSummary {
    pub risk_level: String,
    pub active_signals: usize,
    pub efficiency_penalty_pct: i64,
    pub signals: Vec<ManipulationSignalState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeOfDayLiquidityBucket {
    pub hour: i64,
    pub label: String,
    pub avg_visible_quantity: f64,
    pub avg_sell_orders: f64,
    pub avg_spread_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeOfDayLiquiditySummary {
    pub current_hour_label: String,
    pub strongest_window_label: Option<String>,
    pub weakest_window_label: Option<String>,
    pub buckets: Vec<TimeOfDayLiquidityBucket>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetailSummary {
    pub item_id: i64,
    pub name: String,
    pub slug: String,
    pub image_path: Option<String>,
    pub wiki_link: Option<String>,
    pub description: Option<String>,
    pub item_family: Option<String>,
    pub category: Option<String>,
    pub item_type: Option<String>,
    pub rarity: Option<String>,
    pub mastery_req: Option<i64>,
    pub max_rank: Option<i64>,
    pub ducats: Option<i64>,
    pub tradable: Option<bool>,
    pub prime: Option<bool>,
    pub vaulted: Option<bool>,
    pub release_date: Option<String>,
    pub estimated_vault_date: Option<String>,
    pub vault_date: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetComponentAnalysisEntry {
    pub item_id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub current_lowest_price: Option<f64>,
    pub recommended_entry_price: Option<f64>,
    pub variant_key: String,
    pub variant_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropSourceEntry {
    pub location: String,
    pub chance: Option<f64>,
    pub rarity: Option<String>,
    pub source_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSupplyContext {
    pub mode: String,
    pub components: Vec<SetComponentAnalysisEntry>,
    pub drop_sources: Vec<DropSourceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemAnalysisResponse {
    pub item_id: i64,
    pub slug: String,
    pub variant_key: String,
    pub variant_label: String,
    pub computed_at: String,
    pub source_snapshot_at: Option<String>,
    pub source_stats_fetched_at: Option<String>,
    pub headline: AnalysisHeadline,
    pub flip_analysis: FlipAnalysisSummary,
    pub liquidity_detail: LiquidityDetailSummary,
    pub trend: TrendSummary,
    pub manipulation_risk: ManipulationRiskSummary,
    pub time_of_day_liquidity: TimeOfDayLiquiditySummary,
    pub item_details: ItemDetailSummary,
    pub supply_context: ItemSupplyContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmDetailedOrder {
    pub order_id: String,
    pub order_type: String,
    pub platinum: f64,
    pub quantity: i64,
    pub per_trade: i64,
    pub rank: Option<i64>,
    pub username: String,
    pub user_slug: Option<String>,
    pub status: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmItemOrdersResponse {
    pub api_version: Option<String>,
    pub slug: String,
    pub variant_key: String,
    pub sell_orders: Vec<WfmDetailedOrder>,
    pub buy_orders: Vec<WfmDetailedOrder>,
    pub snapshot: MarketSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingRefreshSummary {
    pub refreshed_items: usize,
    pub due_items: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrdersApiResponse {
    api_version: Option<String>,
    data: Vec<WfmOrderRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmSetApiResponse {
    data: WfmSetData,
}

#[derive(Debug, Deserialize)]
struct WfmSetData {
    items: Vec<WfmSetItemRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmSetItemRecord {
    slug: String,
    #[serde(default)]
    set_root: Option<bool>,
    #[serde(default)]
    i18n: HashMap<String, WfmSetI18nRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmSetI18nRecord {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    thumb: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrderRecord {
    id: String,
    #[serde(rename = "type")]
    order_type: String,
    platinum: f64,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    per_trade: Option<i64>,
    #[serde(default)]
    rank: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    updated_at: Option<String>,
    user: WfmOrderUser,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrderUser {
    #[serde(default)]
    ingame_name: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WfmStatisticsApiResponse {
    payload: WfmStatisticsPayload,
}

#[derive(Debug, Deserialize)]
struct WfmStatisticsPayload {
    #[serde(default)]
    statistics_closed: HashMap<String, Vec<WfmStatisticsRowApi>>,
    #[serde(default)]
    statistics_live: HashMap<String, Vec<WfmStatisticsRowApi>>,
}

#[derive(Debug, Clone, Deserialize)]
struct WfmStatisticsRowApi {
    datetime: String,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    min_price: Option<f64>,
    #[serde(default)]
    max_price: Option<f64>,
    #[serde(default)]
    open_price: Option<f64>,
    #[serde(default)]
    closed_price: Option<f64>,
    #[serde(default)]
    avg_price: Option<f64>,
    #[serde(default)]
    wa_price: Option<f64>,
    #[serde(default)]
    median: Option<f64>,
    #[serde(default)]
    moving_avg: Option<f64>,
    #[serde(default)]
    donch_top: Option<f64>,
    #[serde(default)]
    donch_bot: Option<f64>,
    #[serde(default)]
    order_type: Option<String>,
    #[serde(default)]
    mod_rank: Option<i64>,
}

#[derive(Debug, Clone)]
struct InternalStatsRow {
    bucket_at: OffsetDateTime,
    source_kind: String,
    volume: f64,
    min_price: Option<f64>,
    max_price: Option<f64>,
    open_price: Option<f64>,
    closed_price: Option<f64>,
    avg_price: Option<f64>,
    wa_price: Option<f64>,
    median: Option<f64>,
    moving_avg: Option<f64>,
    donch_top: Option<f64>,
    donch_bot: Option<f64>,
}

#[derive(Debug)]
struct TrackingTarget {
    item_id: i64,
    slug: String,
    variant_key: String,
}

fn now_utc() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

fn format_timestamp(value: OffsetDateTime) -> Result<String> {
    value
        .format(&Rfc3339)
        .context("failed to format RFC3339 timestamp")
}

fn parse_timestamp(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

fn resolve_market_observatory_db_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve the app data directory")?;
    Ok(app_data_dir.join(MARKET_OBSERVATORY_DATABASE_FILE))
}

fn resolve_catalog_db_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve the app data directory")?;
    Ok(app_data_dir.join(ITEM_CATALOG_DATABASE_FILE))
}

fn open_catalog_database(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = resolve_catalog_db_path(app)?;
    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("failed to open the local item catalog")
}

fn open_market_observatory_database(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = resolve_market_observatory_db_path(app)?;
    if let Some(parent_dir) = db_path.parent() {
        std::fs::create_dir_all(parent_dir).context("failed to create app data directory")?;
    }

    let connection = Connection::open(db_path).context("failed to open market observatory db")?;
    initialize_market_observatory_schema(&connection)?;
    Ok(connection)
}

fn initialize_market_observatory_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS tracked_items (
          item_id INTEGER NOT NULL,
          slug TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          variant_label TEXT NOT NULL,
          tracking_sources TEXT NOT NULL,
          first_tracked_at TEXT NOT NULL,
          last_tracked_at TEXT NOT NULL,
          last_snapshot_at TEXT,
          next_snapshot_at TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (item_id, slug, variant_key)
        );

        CREATE TABLE IF NOT EXISTS orderbook_snapshots (
          snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER NOT NULL,
          slug TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          lowest_sell REAL,
          median_sell REAL,
          highest_buy REAL,
          spread REAL,
          spread_pct REAL,
          sell_order_count INTEGER NOT NULL,
          sell_quantity INTEGER NOT NULL,
          buy_order_count INTEGER NOT NULL,
          buy_quantity INTEGER NOT NULL,
          near_floor_seller_count INTEGER NOT NULL,
          near_floor_quantity INTEGER NOT NULL,
          unique_sell_users INTEGER NOT NULL,
          unique_buy_users INTEGER NOT NULL,
          pressure_ratio REAL,
          entry_depth REAL NOT NULL,
          exit_depth REAL NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_orderbook_snapshots_lookup
          ON orderbook_snapshots (item_id, variant_key, captured_at DESC);

        CREATE TABLE IF NOT EXISTS orderbook_snapshot_levels (
          snapshot_id INTEGER NOT NULL,
          side TEXT NOT NULL,
          price REAL NOT NULL,
          quantity INTEGER NOT NULL,
          order_count INTEGER NOT NULL,
          band_kind TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, side, price, band_kind),
          FOREIGN KEY (snapshot_id) REFERENCES orderbook_snapshots(snapshot_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS statistics_cache (
          item_id INTEGER NOT NULL,
          slug TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          domain_key TEXT NOT NULL,
          bucket_origin TEXT NOT NULL,
          bucket_at TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          volume REAL NOT NULL,
          min_price REAL,
          max_price REAL,
          open_price REAL,
          closed_price REAL,
          avg_price REAL,
          wa_price REAL,
          median REAL,
          moving_avg REAL,
          donch_top REAL,
          donch_bot REAL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (item_id, variant_key, domain_key, bucket_origin, bucket_at, source_kind)
        );

        CREATE INDEX IF NOT EXISTS idx_statistics_cache_lookup
          ON statistics_cache (item_id, variant_key, domain_key, source_kind, bucket_at DESC);

        CREATE TABLE IF NOT EXISTS analytics_cache (
          item_id INTEGER NOT NULL,
          slug TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          domain_key TEXT NOT NULL,
          bucket_size_key TEXT NOT NULL,
          cache_version INTEGER NOT NULL DEFAULT 1,
          computed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          source_snapshot_at TEXT,
          source_stats_fetched_at TEXT,
          PRIMARY KEY (item_id, variant_key, domain_key, bucket_size_key)
        );
        ",
    )?;

    let has_cache_version = connection
        .query_row(
            "SELECT 1
             FROM pragma_table_info('analytics_cache')
             WHERE name = 'cache_version'
             LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if !has_cache_version {
        connection.execute(
            "ALTER TABLE analytics_cache
             ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }

    Ok(())
}

fn build_wfm_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to build WFM client")
}

fn normalize_variant_key(value: Option<&str>) -> String {
    let trimmed = value.unwrap_or("base").trim();
    if trimmed.is_empty() {
        "base".to_string()
    } else {
        trimmed.to_string()
    }
}

fn derive_variant_rank(variant_key: &str) -> Option<i64> {
    variant_key
        .strip_prefix("rank:")
        .and_then(|value| value.parse::<i64>().ok())
}

fn derive_variant_label(variant_key: &str) -> String {
    if let Some(rank) = derive_variant_rank(variant_key) {
        format!("Rank {rank}")
    } else {
        "Base Market".to_string()
    }
}

fn read_tracking_sources(raw_json: &str) -> BTreeSet<MarketTrackingSource> {
    serde_json::from_str::<Vec<String>>(raw_json)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| MarketTrackingSource::from_str(&value))
        .collect()
}

fn write_tracking_sources(sources: &BTreeSet<MarketTrackingSource>) -> Result<String> {
    let values = sources
        .iter()
        .map(|source| source.as_str().to_string())
        .collect::<Vec<_>>();
    serde_json::to_string(&values).context("failed to serialize tracking sources")
}

fn filter_variant_statistics_rows(
    rows: Vec<WfmStatisticsRowApi>,
    variant_key: &str,
) -> Vec<WfmStatisticsRowApi> {
    match derive_variant_rank(variant_key) {
        Some(rank) => rows
            .into_iter()
            .filter(|row| row.mod_rank == Some(rank))
            .collect(),
        None => rows
            .into_iter()
            .filter(|row| row.mod_rank.is_none())
            .collect(),
    }
}

fn normalize_statistics_rows(
    rows: Vec<WfmStatisticsRowApi>,
    source_kind: &str,
) -> Vec<InternalStatsRow> {
    rows.into_iter()
        .filter_map(|row| {
            let bucket_at = parse_timestamp(&row.datetime)?;
            Some(InternalStatsRow {
                bucket_at,
                source_kind: source_kind.to_string(),
                volume: row.volume.unwrap_or(0.0),
                min_price: row.min_price,
                max_price: row.max_price,
                open_price: row.open_price,
                closed_price: row.closed_price,
                avg_price: row.avg_price,
                wa_price: row.wa_price,
                median: row.median,
                moving_avg: row.moving_avg,
                donch_top: row.donch_top,
                donch_bot: row.donch_bot,
            })
        })
        .collect()
}

fn insert_statistics_rows_for_domain(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    domain_key: &str,
    rows: &[InternalStatsRow],
    fetched_at: &str,
) -> Result<()> {
    connection.execute(
        "DELETE FROM statistics_cache
         WHERE item_id = ?1
           AND variant_key = ?2
           AND domain_key = ?3",
        params![item_id, variant_key, domain_key],
    )?;

    let mut deduped_rows = BTreeMap::<(String, String), InternalStatsRow>::new();
    for row in rows {
        let bucket_at = format_timestamp(row.bucket_at)?;
        deduped_rows.insert((bucket_at, row.source_kind.clone()), row.clone());
    }

    let mut statement = connection.prepare(
        "INSERT INTO statistics_cache (
           item_id,
           slug,
           variant_key,
           domain_key,
           bucket_origin,
           bucket_at,
           source_kind,
           volume,
           min_price,
           max_price,
           open_price,
           closed_price,
           avg_price,
           wa_price,
           median,
           moving_avg,
           donch_top,
           donch_bot,
           fetched_at
         ) VALUES (?1, ?2, ?3, ?4, 'native', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(item_id, variant_key, domain_key, bucket_origin, bucket_at, source_kind)
         DO UPDATE SET
           slug = excluded.slug,
           volume = excluded.volume,
           min_price = excluded.min_price,
           max_price = excluded.max_price,
           open_price = excluded.open_price,
           closed_price = excluded.closed_price,
           avg_price = excluded.avg_price,
           wa_price = excluded.wa_price,
           median = excluded.median,
           moving_avg = excluded.moving_avg,
           donch_top = excluded.donch_top,
           donch_bot = excluded.donch_bot,
           fetched_at = excluded.fetched_at",
    )?;

    for ((bucket_at, _), row) in deduped_rows {
        statement.execute(params![
            item_id,
            slug,
            variant_key,
            domain_key,
            bucket_at,
            row.source_kind,
            row.volume,
            row.min_price,
            row.max_price,
            row.open_price,
            row.closed_price,
            row.avg_price,
            row.wa_price,
            row.median,
            row.moving_avg,
            row.donch_top,
            row.donch_bot,
            fetched_at
        ])?;
    }

    Ok(())
}

fn fetch_and_cache_statistics(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
) -> Result<()> {
    let client = build_wfm_client()?;
    let response = client
        .get(format!("{WFM_API_BASE_URL_V1}/items/{slug}/statistics"))
        .header("User-Agent", WFM_USER_AGENT)
        .header("Language", WFM_LANGUAGE_HEADER)
        .header("Platform", WFM_PLATFORM_HEADER)
        .header("Crossplay", WFM_CROSSPLAY_HEADER)
        .send()
        .context("failed to request WFM statistics")?
        .error_for_status()
        .context("WFM statistics request failed")?;
    let payload = response
        .json::<WfmStatisticsApiResponse>()
        .context("failed to parse WFM statistics response")?;

    let fetched_at = format_timestamp(now_utc())?;

    let mut rows_by_domain = HashMap::<String, Vec<InternalStatsRow>>::new();

    for (domain_key, rows) in payload.payload.statistics_closed {
        let filtered_rows = filter_variant_statistics_rows(rows, variant_key);
        let normalized_rows = normalize_statistics_rows(filtered_rows, "closed");
        rows_by_domain
            .entry(domain_key)
            .or_default()
            .extend(normalized_rows);
    }

    for (domain_key, rows) in payload.payload.statistics_live {
        let filtered_rows = filter_variant_statistics_rows(rows, variant_key);
        let grouped_rows = filtered_rows.into_iter().fold(
            HashMap::<String, Vec<WfmStatisticsRowApi>>::new(),
            |mut acc, row| {
                let source_kind = match row.order_type.as_deref() {
                    Some("buy") => "live_buy",
                    _ => "live_sell",
                };
                acc.entry(source_kind.to_string()).or_default().push(row);
                acc
            },
        );

        for (source_kind, source_rows) in grouped_rows {
            let normalized_rows = normalize_statistics_rows(source_rows, &source_kind);
            rows_by_domain
                .entry(domain_key.clone())
                .or_default()
                .extend(normalized_rows);
        }
    }

    for (domain_key, rows) in rows_by_domain {
        insert_statistics_rows_for_domain(
            connection,
            item_id,
            slug,
            variant_key,
            &domain_key,
            &rows,
            &fetched_at,
        )?;
    }

    Ok(())
}

fn statistics_cache_is_usable(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    domain_key: AnalyticsDomainKey,
) -> Result<bool> {
    let required_domains = match domain_key {
        AnalyticsDomainKey::FortyEightHours => vec![("48hours", 12_i64)],
        AnalyticsDomainKey::SevenDays => vec![("48hours", 12_i64), ("90days", 5_i64)],
        AnalyticsDomainKey::ThirtyDays | AnalyticsDomainKey::NinetyDays => {
            vec![("48hours", 12_i64), ("90days", 10_i64)]
        }
    };

    for (source_domain, expected_min_rows) in required_domains {
        let (closed_row_count, rich_anchor_count): (i64, i64) = connection.query_row(
            "SELECT
               COUNT(*),
               SUM(
                 CASE
                   WHEN min_price IS NOT NULL
                     OR max_price IS NOT NULL
                     OR open_price IS NOT NULL
                     OR closed_price IS NOT NULL
                     OR avg_price IS NOT NULL
                     OR wa_price IS NOT NULL
                     OR moving_avg IS NOT NULL
                     OR donch_top IS NOT NULL
                     OR donch_bot IS NOT NULL
                   THEN 1
                   ELSE 0
                 END
               )
             FROM statistics_cache
             WHERE item_id = ?1
               AND variant_key = ?2
               AND domain_key = ?3
               AND source_kind = 'closed'",
            params![item_id, variant_key, source_domain],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        )?;

        if closed_row_count < expected_min_rows {
            return Ok(false);
        }

        if !(rich_anchor_count > 0 && rich_anchor_count * 2 >= closed_row_count) {
            return Ok(false);
        }
    }

    Ok(true)
}

fn load_statistics_rows_for_domain(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    source_domain: &str,
) -> Result<(Vec<InternalStatsRow>, Vec<InternalStatsRow>, Option<String>)> {
    let mut statement = connection.prepare(
        "SELECT
           bucket_at,
           source_kind,
           volume,
           min_price,
           max_price,
           open_price,
           closed_price,
           avg_price,
           wa_price,
           median,
           moving_avg,
           donch_top,
           donch_bot,
           fetched_at
         FROM statistics_cache
         WHERE item_id = ?1
           AND variant_key = ?2
           AND domain_key = ?3
         ORDER BY bucket_at ASC",
    )?;
    let rows = statement.query_map(params![item_id, variant_key, source_domain], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, f64>(2)?,
            row.get::<_, Option<f64>>(3)?,
            row.get::<_, Option<f64>>(4)?,
            row.get::<_, Option<f64>>(5)?,
            row.get::<_, Option<f64>>(6)?,
            row.get::<_, Option<f64>>(7)?,
            row.get::<_, Option<f64>>(8)?,
            row.get::<_, Option<f64>>(9)?,
            row.get::<_, Option<f64>>(10)?,
            row.get::<_, Option<f64>>(11)?,
            row.get::<_, Option<f64>>(12)?,
            row.get::<_, String>(13)?,
        ))
    })?;

    let mut closed_rows = Vec::new();
    let mut live_buy_rows = Vec::new();
    let mut latest_fetched_at: Option<String> = None;

    for row in rows {
        let (
            bucket_at_raw,
            source_kind,
            volume,
            min_price,
            max_price,
            open_price,
            closed_price,
            avg_price,
            wa_price,
            median,
            moving_avg,
            donch_top,
            donch_bot,
            fetched_at,
        ) = row?;
        latest_fetched_at = Some(fetched_at);
        let Some(bucket_at) = parse_timestamp(&bucket_at_raw) else {
            continue;
        };

        let normalized = InternalStatsRow {
            bucket_at,
            source_kind: source_kind.clone(),
            volume,
            min_price,
            max_price,
            open_price,
            closed_price,
            avg_price,
            wa_price,
            median,
            moving_avg,
            donch_top,
            donch_bot,
        };

        match source_kind.as_str() {
            "closed" => closed_rows.push(normalized),
            "live_buy" => live_buy_rows.push(normalized),
            _ => {}
        }
    }

    Ok((closed_rows, live_buy_rows, latest_fetched_at))
}

fn merge_latest_fetched_at(current: Option<String>, candidate: Option<String>) -> Option<String> {
    match (current, candidate) {
        (None, value) => value,
        (value, None) => value,
        (Some(current), Some(candidate)) => {
            if candidate > current {
                Some(candidate)
            } else {
                Some(current)
            }
        }
    }
}

fn load_chart_statistics_rows(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    domain_key: AnalyticsDomainKey,
) -> Result<(Vec<InternalStatsRow>, Vec<InternalStatsRow>, Option<String>)> {
    let domain_cutoff = now_utc() - domain_key.lookback();
    let recent_cutoff = now_utc() - TimeDuration::hours(48);
    let source_domains = match domain_key {
        AnalyticsDomainKey::FortyEightHours => vec!["48hours"],
        AnalyticsDomainKey::SevenDays | AnalyticsDomainKey::ThirtyDays | AnalyticsDomainKey::NinetyDays => {
            vec!["90days", "48hours"]
        }
    };

    let mut closed_rows = Vec::new();
    let mut live_buy_rows = Vec::new();
    let mut latest_fetched_at = None;

    for source_domain in source_domains {
        let (domain_closed_rows, domain_live_buy_rows, fetched_at) =
            load_statistics_rows_for_domain(connection, item_id, variant_key, source_domain)?;
        latest_fetched_at = merge_latest_fetched_at(latest_fetched_at, fetched_at);

        let include_row = |row: &InternalStatsRow| -> bool {
            if row.bucket_at < domain_cutoff {
                return false;
            }

            if source_domain == "90days" {
                return row.bucket_at < recent_cutoff;
            }

            true
        };

        closed_rows.extend(domain_closed_rows.into_iter().filter(include_row));
        live_buy_rows.extend(domain_live_buy_rows.into_iter().filter(include_row));
    }

    closed_rows.sort_by_key(|row| row.bucket_at);
    live_buy_rows.sort_by_key(|row| row.bucket_at);

    Ok((closed_rows, live_buy_rows, latest_fetched_at))
}

fn load_snapshot_chart_points(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    domain_key: AnalyticsDomainKey,
    bucket_size_key: AnalyticsBucketSizeKey,
) -> Result<Vec<AnalyticsChartPoint>> {
    let cutoff = format_timestamp(now_utc() - domain_key.lookback())?;
    let mut statement = connection.prepare(
        "SELECT captured_at, lowest_sell, median_sell, highest_buy
         FROM orderbook_snapshots
         WHERE item_id = ?1
           AND variant_key = ?2
           AND captured_at >= ?3
         ORDER BY captured_at ASC",
    )?;

    let rows = statement.query_map(params![item_id, variant_key, cutoff], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<f64>>(1)?,
            row.get::<_, Option<f64>>(2)?,
            row.get::<_, Option<f64>>(3)?,
        ))
    })?;

    let mut buckets = BTreeMap::<i64, Vec<(Option<f64>, Option<f64>, Option<f64>)>>::new();

    for row in rows {
        let (captured_at_raw, lowest_sell, median_sell, highest_buy) = row?;
        let Some(captured_at) = parse_timestamp(&captured_at_raw) else {
            continue;
        };
        let bucket_start = floor_timestamp(captured_at, bucket_size_key).unix_timestamp();
        buckets
            .entry(bucket_start)
            .or_default()
            .push((lowest_sell, median_sell, highest_buy));
    }

    Ok(buckets
        .into_iter()
        .map(|(bucket_start, bucket_rows)| {
            let lowest_values = bucket_rows
                .iter()
                .filter_map(|(lowest_sell, _, _)| *lowest_sell)
                .collect::<Vec<_>>();
            let median_values = bucket_rows
                .iter()
                .filter_map(|(_, median_sell, _)| *median_sell)
                .collect::<Vec<_>>();
            let highest_buy = bucket_rows
                .iter()
                .filter_map(|(_, _, highest_buy)| *highest_buy)
                .reduce(f64::max);
            let low_price = lowest_values.iter().copied().reduce(f64::min);
            let high_price = median_values
                .iter()
                .copied()
                .chain(lowest_values.iter().copied())
                .reduce(f64::max);
            let open_price = lowest_values.first().copied();
            let closed_price = lowest_values.last().copied();

            AnalyticsChartPoint {
                bucket_at: format_timestamp(
                    OffsetDateTime::from_unix_timestamp(bucket_start).unwrap_or_else(|_| now_utc()),
                )
                .unwrap_or_default(),
                open_price,
                closed_price,
                low_price,
                high_price,
                lowest_sell: low_price,
                median_sell: if median_values.is_empty() {
                    None
                } else {
                    Some(median_values.iter().sum::<f64>() / median_values.len() as f64)
                },
                moving_avg: None,
                weighted_avg: None,
                average_price: if median_values.is_empty() {
                    None
                } else {
                    Some(median_values.iter().sum::<f64>() / median_values.len() as f64)
                },
                highest_buy,
                fair_value_low: None,
                fair_value_high: None,
                entry_zone: None,
                exit_zone: None,
                volume: 0.0,
            }
        })
        .collect())
}

fn merge_snapshot_chart_points(
    mut chart_points: Vec<AnalyticsChartPoint>,
    snapshot_points: Vec<AnalyticsChartPoint>,
) -> Vec<AnalyticsChartPoint> {
    let mut point_by_bucket = chart_points
        .drain(..)
        .map(|point| (point.bucket_at.clone(), point))
        .collect::<BTreeMap<_, _>>();

    for snapshot_point in snapshot_points {
        let entry = point_by_bucket
            .entry(snapshot_point.bucket_at.clone())
            .or_insert_with(|| snapshot_point.clone());

        if entry.open_price.is_none() {
            entry.open_price = snapshot_point.open_price;
        }
        if entry.closed_price.is_none() {
            entry.closed_price = snapshot_point.closed_price;
        }
        if entry.low_price.is_none() {
            entry.low_price = snapshot_point.low_price;
        }
        if entry.high_price.is_none() {
            entry.high_price = snapshot_point.high_price;
        }
        if entry.lowest_sell.is_none() {
            entry.lowest_sell = snapshot_point.lowest_sell;
        }
        if entry.median_sell.is_none() {
            entry.median_sell = snapshot_point.median_sell;
        }
        if entry.average_price.is_none() {
            entry.average_price = snapshot_point.average_price;
        }
        if entry.highest_buy.is_none() {
            entry.highest_buy = snapshot_point.highest_buy;
        }
        if entry.entry_zone.is_none() {
            entry.entry_zone = snapshot_point.entry_zone;
        }
        if entry.exit_zone.is_none() {
            entry.exit_zone = snapshot_point.exit_zone;
        }
    }

    point_by_bucket.into_values().collect()
}

fn filter_supported_order(order: &WfmOrderRecord, variant_key: &str) -> bool {
    if order.visible != Some(true) {
        return false;
    }

    let Some(status) = order.user.status.as_deref() else {
        return false;
    };
    if status != "online" && status != "ingame" {
        return false;
    }

    match derive_variant_rank(variant_key) {
        Some(rank) => order.rank == Some(rank),
        None => order.rank.is_none(),
    }
}

fn normalize_order(order: WfmOrderRecord) -> Option<WfmDetailedOrder> {
    let username = order.user.ingame_name?;
    Some(WfmDetailedOrder {
        order_id: order.id,
        order_type: order.order_type,
        platinum: order.platinum,
        quantity: order.quantity.unwrap_or(1),
        per_trade: order.per_trade.unwrap_or(1),
        rank: order.rank,
        username,
        user_slug: order.user.slug,
        status: order.user.status,
        updated_at: order.updated_at,
    })
}

fn median_price(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }

    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        Some((values[middle - 1] + values[middle]) / 2.0)
    } else {
        Some(values[middle])
    }
}

fn build_depth_levels(orders: &[WfmDetailedOrder], side: &str) -> Vec<MarketDepthLevel> {
    let mut aggregated: BTreeMap<i64, (i64, i64)> = BTreeMap::new();
    for order in orders {
        let price_key = order.platinum.round() as i64;
        let entry = aggregated.entry(price_key).or_insert((0, 0));
        entry.0 += order.quantity;
        entry.1 += 1;
    }

    let mut levels = aggregated
        .into_iter()
        .map(|(price_key, (quantity, order_count))| MarketDepthLevel {
            side: side.to_string(),
            price: price_key as f64,
            quantity,
            order_count,
            band_kind: "top".to_string(),
        })
        .collect::<Vec<_>>();

    if side == "sell" {
        levels.sort_by(|left, right| left.price.total_cmp(&right.price));
    } else {
        levels.sort_by(|left, right| right.price.total_cmp(&left.price));
    }
    levels.truncate(6);
    levels
}

fn compute_pressure_ratio(
    buy_quantity: i64,
    sell_quantity: i64,
    buy_count: i64,
    sell_count: i64,
) -> Option<f64> {
    if sell_quantity <= 0 || sell_count <= 0 {
        return None;
    }

    let quantity_ratio = buy_quantity as f64 / sell_quantity as f64;
    let count_ratio = if sell_count <= 0 {
        0.0
    } else {
        buy_count as f64 / sell_count as f64
    };

    Some((quantity_ratio * 0.65) + (count_ratio * 0.35))
}

fn pressure_label(pressure_ratio: Option<f64>) -> String {
    match pressure_ratio {
        Some(value) if value >= 1.1 => "Entry Pressure".to_string(),
        Some(value) if value <= 0.9 => "Exit Pressure".to_string(),
        Some(_) => "Balanced".to_string(),
        None => "Balanced".to_string(),
    }
}

fn build_market_snapshot(captured_at: &str, sell_orders: &[WfmDetailedOrder], buy_orders: &[WfmDetailedOrder]) -> MarketSnapshot {
    let mut sorted_sell_prices = sell_orders.iter().map(|entry| entry.platinum).collect::<Vec<_>>();
    sorted_sell_prices.sort_by(|left, right| left.total_cmp(right));
    let mut sorted_buy_prices = buy_orders.iter().map(|entry| entry.platinum).collect::<Vec<_>>();
    sorted_buy_prices.sort_by(|left, right| right.total_cmp(left));

    let lowest_sell = sorted_sell_prices.first().copied();
    let median_sell = median_price(&sorted_sell_prices);
    let highest_buy = sorted_buy_prices.first().copied();
    let spread = match (lowest_sell, highest_buy) {
        (Some(sell), Some(buy)) => Some(sell - buy),
        _ => None,
    };
    let spread_pct = match (spread, lowest_sell) {
        (Some(value), Some(lowest)) if lowest > 0.0 => Some((value / lowest) * 100.0),
        _ => None,
    };

    let near_floor_seller_count = lowest_sell
        .map(|floor| {
            sell_orders
                .iter()
                .filter(|order| order.platinum <= floor + 2.0)
                .count() as i64
        })
        .unwrap_or(0);
    let near_floor_quantity = lowest_sell
        .map(|floor| {
            sell_orders
                .iter()
                .filter(|order| order.platinum <= floor + 2.0)
                .map(|order| order.quantity)
                .sum()
        })
        .unwrap_or(0);
    let sell_quantity = sell_orders.iter().map(|order| order.quantity).sum();
    let buy_quantity = buy_orders.iter().map(|order| order.quantity).sum();
    let sell_order_count = sell_orders.len() as i64;
    let buy_order_count = buy_orders.len() as i64;

    let unique_sell_users = sell_orders
        .iter()
        .map(|order| order.user_slug.clone().unwrap_or_else(|| order.username.to_lowercase()))
        .collect::<HashSet<_>>()
        .len() as i64;
    let unique_buy_users = buy_orders
        .iter()
        .map(|order| order.user_slug.clone().unwrap_or_else(|| order.username.to_lowercase()))
        .collect::<HashSet<_>>()
        .len() as i64;
    let pressure_ratio = compute_pressure_ratio(
        buy_quantity,
        sell_quantity,
        buy_order_count,
        sell_order_count,
    );

    let sell_levels = build_depth_levels(sell_orders, "sell");
    let buy_levels = build_depth_levels(buy_orders, "buy");
    let depth_levels = sell_levels
        .iter()
        .cloned()
        .chain(buy_levels.iter().cloned())
        .collect::<Vec<_>>();
    let entry_depth = buy_levels
        .iter()
        .take(3)
        .map(|level| level.quantity as f64)
        .sum::<f64>();
    let exit_depth = sell_levels
        .iter()
        .take(3)
        .map(|level| level.quantity as f64)
        .sum::<f64>();

    MarketSnapshot {
        captured_at: captured_at.to_string(),
        lowest_sell,
        median_sell,
        highest_buy,
        spread,
        spread_pct,
        sell_order_count,
        sell_quantity,
        buy_order_count,
        buy_quantity,
        near_floor_seller_count,
        near_floor_quantity,
        unique_sell_users,
        unique_buy_users,
        pressure_ratio,
        entry_depth,
        exit_depth,
        depth_levels,
    }
}

fn fetch_filtered_orders(slug: &str, variant_key: &str) -> Result<(Option<String>, Vec<WfmDetailedOrder>, Vec<WfmDetailedOrder>, MarketSnapshot)> {
    let client = build_wfm_client()?;
    let response = client
        .get(format!("{WFM_API_BASE_URL_V2}/orders/item/{slug}"))
        .header("User-Agent", WFM_USER_AGENT)
        .header("Language", WFM_LANGUAGE_HEADER)
        .header("Platform", WFM_PLATFORM_HEADER)
        .header("Crossplay", WFM_CROSSPLAY_HEADER)
        .send()
        .context("failed to request WFM orders")?
        .error_for_status()
        .context("WFM orders request failed")?;
    let payload = response
        .json::<WfmOrdersApiResponse>()
        .context("failed to parse WFM orders response")?;

    let mut sell_orders = Vec::new();
    let mut buy_orders = Vec::new();

    for order in payload.data {
        if !filter_supported_order(&order, variant_key) {
            continue;
        }
        let Some(normalized) = normalize_order(order) else {
            continue;
        };

        if normalized.order_type == "sell" {
            sell_orders.push(normalized);
        } else if normalized.order_type == "buy" {
            buy_orders.push(normalized);
        }
    }

    sell_orders.sort_by(|left, right| {
        left.platinum
            .total_cmp(&right.platinum)
            .then_with(|| left.username.to_lowercase().cmp(&right.username.to_lowercase()))
    });
    buy_orders.sort_by(|left, right| {
        right
            .platinum
            .total_cmp(&left.platinum)
            .then_with(|| left.username.to_lowercase().cmp(&right.username.to_lowercase()))
    });

    let captured_at = format_timestamp(now_utc())?;
    let snapshot = build_market_snapshot(&captured_at, &sell_orders, &buy_orders);
    Ok((payload.api_version, sell_orders, buy_orders, snapshot))
}

fn persist_snapshot(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    snapshot: &MarketSnapshot,
) -> Result<()> {
    connection.execute(
        "INSERT INTO orderbook_snapshots (
           item_id,
           slug,
           variant_key,
           captured_at,
           lowest_sell,
           median_sell,
           highest_buy,
           spread,
           spread_pct,
           sell_order_count,
           sell_quantity,
           buy_order_count,
           buy_quantity,
           near_floor_seller_count,
           near_floor_quantity,
           unique_sell_users,
           unique_buy_users,
           pressure_ratio,
           entry_depth,
           exit_depth
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            item_id,
            slug,
            variant_key,
            snapshot.captured_at,
            snapshot.lowest_sell,
            snapshot.median_sell,
            snapshot.highest_buy,
            snapshot.spread,
            snapshot.spread_pct,
            snapshot.sell_order_count,
            snapshot.sell_quantity,
            snapshot.buy_order_count,
            snapshot.buy_quantity,
            snapshot.near_floor_seller_count,
            snapshot.near_floor_quantity,
            snapshot.unique_sell_users,
            snapshot.unique_buy_users,
            snapshot.pressure_ratio,
            snapshot.entry_depth,
            snapshot.exit_depth,
        ],
    )?;

    let snapshot_id = connection.last_insert_rowid();
    connection.execute(
        "DELETE FROM orderbook_snapshot_levels WHERE snapshot_id = ?1",
        params![snapshot_id],
    )?;

    let mut level_statement = connection.prepare(
        "INSERT INTO orderbook_snapshot_levels (
           snapshot_id,
           side,
           price,
           quantity,
           order_count,
           band_kind
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for level in &snapshot.depth_levels {
        level_statement.execute(params![
            snapshot_id,
            level.side,
            level.price,
            level.quantity,
            level.order_count,
            level.band_kind
        ])?;
    }

    Ok(())
}

fn prune_old_rows(connection: &Connection) -> Result<()> {
    let cutoff = format_timestamp(now_utc() - TimeDuration::days(SNAPSHOT_RETENTION_DAYS))?;
    connection.execute(
        "DELETE FROM orderbook_snapshot_levels
         WHERE snapshot_id IN (
           SELECT snapshot_id
           FROM orderbook_snapshots
           WHERE captured_at < ?1
         )",
        params![cutoff],
    )?;
    connection.execute(
        "DELETE FROM orderbook_snapshots
         WHERE captured_at < ?1",
        params![cutoff],
    )?;
    Ok(())
}

fn update_tracking_row(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    variant_label: &str,
    sources: &BTreeSet<MarketTrackingSource>,
    force_due_now: bool,
    last_snapshot_at: Option<&str>,
) -> Result<()> {
    let now = format_timestamp(now_utc())?;
    let next_snapshot_at = if sources.is_empty() {
        None
    } else if force_due_now {
        Some(now.clone())
    } else {
        Some(format_timestamp(
            now_utc() + TimeDuration::minutes(TRACKING_SNAPSHOT_INTERVAL_MINUTES),
        )?)
    };

    connection.execute(
        "INSERT INTO tracked_items (
           item_id,
           slug,
           variant_key,
           variant_label,
           tracking_sources,
           first_tracked_at,
           last_tracked_at,
           last_snapshot_at,
           next_snapshot_at,
           is_active
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9)
         ON CONFLICT(item_id, slug, variant_key) DO UPDATE SET
           variant_label = excluded.variant_label,
           tracking_sources = excluded.tracking_sources,
           last_tracked_at = excluded.last_tracked_at,
           last_snapshot_at = COALESCE(excluded.last_snapshot_at, tracked_items.last_snapshot_at),
           next_snapshot_at = excluded.next_snapshot_at,
           is_active = excluded.is_active",
        params![
            item_id,
            slug,
            variant_key,
            variant_label,
            write_tracking_sources(sources)?,
            now,
            last_snapshot_at,
            next_snapshot_at,
            if sources.is_empty() { 0 } else { 1 }
        ],
    )?;

    Ok(())
}

fn get_existing_sources(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
) -> Result<BTreeSet<MarketTrackingSource>> {
    let raw_sources = connection
        .query_row(
            "SELECT tracking_sources
             FROM tracked_items
             WHERE item_id = ?1
               AND slug = ?2
               AND variant_key = ?3",
            params![item_id, slug, variant_key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(raw_sources
        .as_deref()
        .map(read_tracking_sources)
        .unwrap_or_default())
}

fn capture_tracking_snapshot(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
) -> Result<MarketSnapshot> {
    let (_, sell_orders, buy_orders, snapshot) = fetch_filtered_orders(slug, variant_key)?;
    persist_snapshot(connection, item_id, slug, variant_key, &snapshot)?;
    prune_old_rows(connection)?;
    update_tracking_row(
        connection,
        item_id,
        slug,
        variant_key,
        &derive_variant_label(variant_key),
        &get_existing_sources(connection, item_id, slug, variant_key)?,
        false,
        Some(snapshot.captured_at.as_str()),
    )?;
    let _ = (sell_orders, buy_orders);
    Ok(snapshot)
}

fn resolve_variants_from_catalog(app: &tauri::AppHandle, item_id: i64, slug: &str) -> Result<Vec<MarketVariant>> {
    let connection = open_catalog_database(app)?;
    let max_rank = connection
        .query_row(
            "SELECT max_rank
             FROM wfm_items
             WHERE item_id = ?1 OR slug = ?2
             LIMIT 1",
            params![item_id, slug],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten();

    if let Some(max_rank) = max_rank.filter(|value| *value > 0) {
        let mut variants = Vec::new();
        for rank in 0..=max_rank {
            variants.push(MarketVariant {
                key: format!("rank:{rank}"),
                label: format!("Rank {rank}"),
                rank: Some(rank),
                is_default: rank == 0,
            });
        }
        return Ok(variants);
    }

    Ok(vec![MarketVariant {
        key: "base".to_string(),
        label: "Base Market".to_string(),
        rank: None,
        is_default: true,
    }])
}

fn latest_snapshot_for_item(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
) -> Result<Option<MarketSnapshot>> {
    let snapshot_row = connection
        .query_row(
            "SELECT
               snapshot_id,
               captured_at,
               lowest_sell,
               median_sell,
               highest_buy,
               spread,
               spread_pct,
               sell_order_count,
               sell_quantity,
               buy_order_count,
               buy_quantity,
               near_floor_seller_count,
               near_floor_quantity,
               unique_sell_users,
               unique_buy_users,
               pressure_ratio,
               entry_depth,
               exit_depth
             FROM orderbook_snapshots
             WHERE item_id = ?1
               AND variant_key = ?2
             ORDER BY captured_at DESC
             LIMIT 1",
            params![item_id, variant_key],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    MarketSnapshot {
                        captured_at: row.get(1)?,
                        lowest_sell: row.get(2)?,
                        median_sell: row.get(3)?,
                        highest_buy: row.get(4)?,
                        spread: row.get(5)?,
                        spread_pct: row.get(6)?,
                        sell_order_count: row.get(7)?,
                        sell_quantity: row.get(8)?,
                        buy_order_count: row.get(9)?,
                        buy_quantity: row.get(10)?,
                        near_floor_seller_count: row.get(11)?,
                        near_floor_quantity: row.get(12)?,
                        unique_sell_users: row.get(13)?,
                        unique_buy_users: row.get(14)?,
                        pressure_ratio: row.get(15)?,
                        entry_depth: row.get(16)?,
                        exit_depth: row.get(17)?,
                        depth_levels: Vec::new(),
                    },
                ))
            },
        )
        .optional()?;

    let Some((snapshot_id, mut snapshot)) = snapshot_row else {
        return Ok(None);
    };

    let mut statement = connection.prepare(
        "SELECT side, price, quantity, order_count, band_kind
         FROM orderbook_snapshot_levels
         WHERE snapshot_id = ?1
         ORDER BY
           CASE side WHEN 'sell' THEN 0 ELSE 1 END,
           CASE side WHEN 'sell' THEN price END ASC,
           CASE side WHEN 'buy' THEN price END DESC",
    )?;
    let rows = statement.query_map(params![snapshot_id], |row| {
        Ok(MarketDepthLevel {
            side: row.get(0)?,
            price: row.get(1)?,
            quantity: row.get(2)?,
            order_count: row.get(3)?,
            band_kind: row.get(4)?,
        })
    })?;
    snapshot.depth_levels = rows.collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(Some(snapshot))
}

fn maybe_capture_fresh_snapshot(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
) -> Result<MarketSnapshot> {
    if let Some(snapshot) = latest_snapshot_for_item(connection, item_id, variant_key)? {
        if let Some(captured_at) = parse_timestamp(&snapshot.captured_at) {
            if now_utc() - captured_at < TimeDuration::minutes(TRACKING_SNAPSHOT_INTERVAL_MINUTES) {
                return Ok(snapshot);
            }
        }
    }

    capture_tracking_snapshot(connection, item_id, slug, variant_key)
}

fn aggregate_weighted(values: impl Iterator<Item = (Option<f64>, f64)>) -> Option<f64> {
    let mut total_weight = 0.0;
    let mut total_value = 0.0;

    for (value, weight) in values {
        if let Some(value) = value {
            total_value += value * weight.max(1.0);
            total_weight += weight.max(1.0);
        }
    }

    if total_weight > 0.0 {
        Some(total_value / total_weight)
    } else {
        None
    }
}

fn row_low_anchor(row: &InternalStatsRow) -> Option<f64> {
    [
        row.min_price,
        row.open_price,
        row.closed_price,
        row.avg_price,
        row.wa_price,
        row.median,
        row.moving_avg,
    ]
    .into_iter()
    .flatten()
    .reduce(f64::min)
}

fn row_high_anchor(row: &InternalStatsRow) -> Option<f64> {
    [
        row.max_price,
        row.open_price,
        row.closed_price,
        row.avg_price,
        row.wa_price,
        row.median,
        row.moving_avg,
        row.donch_top,
    ]
    .into_iter()
    .flatten()
    .reduce(f64::max)
}

fn row_median_anchor(row: &InternalStatsRow) -> Option<f64> {
    row.median
        .or(row.wa_price)
        .or(row.avg_price)
        .or(row.closed_price)
        .or(row.open_price)
        .or(row.moving_avg)
        .or(row.min_price)
        .or(row.max_price)
}

fn row_open_anchor(row: &InternalStatsRow) -> Option<f64> {
    row.open_price
        .or(row.closed_price)
        .or(row.min_price)
        .or(row.max_price)
        .or(row.avg_price)
        .or(row.wa_price)
        .or(row.median)
        .or(row.moving_avg)
}

fn row_close_anchor(row: &InternalStatsRow) -> Option<f64> {
    row.closed_price
        .or(row.open_price)
        .or(row.max_price)
        .or(row.min_price)
        .or(row.avg_price)
        .or(row.wa_price)
        .or(row.median)
        .or(row.moving_avg)
}

fn fair_center_anchor(row: &InternalStatsRow) -> Option<f64> {
    let mut weighted_sum = 0.0;
    let mut total_weight = 0.0;

    for (value, weight) in [
        (row.median, 0.45),
        (row.wa_price, 0.3),
        (row.moving_avg, 0.15),
        (row.avg_price, 0.1),
    ] {
        if let Some(value) = value {
            weighted_sum += value * weight;
            total_weight += weight;
        }
    }

    if total_weight > 0.0 {
        Some(weighted_sum / total_weight)
    } else {
        row_median_anchor(row)
    }
}

struct ZoneBands {
    entry_low: f64,
    entry_high: f64,
    exit_low: f64,
    exit_high: f64,
    entry_target: f64,
    exit_target: f64,
}

fn round_platinum(value: f64) -> f64 {
    value.round()
}

fn compute_zone_bands(
    lower_anchor: Option<f64>,
    upper_anchor: Option<f64>,
    fair_center: Option<f64>,
) -> Option<ZoneBands> {
    let fair_center = fair_center.or_else(|| match (lower_anchor, upper_anchor) {
        (Some(lower), Some(upper)) => Some((lower + upper) * 0.5),
        (Some(value), None) | (None, Some(value)) => Some(value),
        _ => None,
    })?;

    let mut lower_bound = lower_anchor.unwrap_or(fair_center).min(fair_center).floor();
    let mut upper_bound = upper_anchor.unwrap_or(fair_center).max(fair_center).ceil();
    if upper_bound <= lower_bound {
        upper_bound = lower_bound + 4.0;
    }

    let range = (upper_bound - lower_bound).max(4.0);
    let zone_width = (range * 0.2).round().clamp(3.0, 6.0);
    let midpoint = (lower_bound + upper_bound) * 0.5;
    let upward_shift = if fair_center > midpoint + 0.75 {
        ((fair_center - midpoint) * 0.6)
            .round()
            .clamp(0.0, (zone_width - 1.0).max(0.0))
    } else {
        0.0
    };
    let max_entry_low = (upper_bound - zone_width - 2.0).max(lower_bound);
    let mut entry_low = (lower_bound + upward_shift).clamp(lower_bound, max_entry_low);
    let mut entry_high = (entry_low + zone_width).min(upper_bound - 2.0);
    if entry_high <= entry_low {
        entry_high = entry_low + 1.0;
    }

    let mut exit_high = upper_bound;
    let mut exit_low = (upper_bound - zone_width).max(entry_high + 2.0);
    if exit_low >= exit_high {
        exit_low = (exit_high - 1.0).max(entry_high + 1.0);
    }
    if exit_low >= exit_high {
        exit_high = exit_low + 1.0;
    }

    lower_bound = round_platinum(lower_bound);
    upper_bound = round_platinum(upper_bound);
    entry_low = round_platinum(entry_low.clamp(lower_bound, upper_bound));
    entry_high = round_platinum(entry_high.clamp(entry_low + 1.0, upper_bound));
    exit_low = round_platinum(exit_low.max(entry_high + 1.0).clamp(lower_bound, upper_bound));
    exit_high = round_platinum(exit_high.max(exit_low + 1.0).max(upper_bound));

    Some(ZoneBands {
        entry_low,
        entry_high,
        exit_low,
        exit_high,
        entry_target: round_platinum((entry_low + entry_high) * 0.5),
        exit_target: round_platinum((exit_low + exit_high) * 0.5),
    })
}

fn last_defined_value(
    rows: &[InternalStatsRow],
    selector: impl Fn(&InternalStatsRow) -> Option<f64>,
) -> Option<f64> {
    rows.iter().rev().find_map(selector)
}

fn floor_timestamp(timestamp: OffsetDateTime, bucket_size_key: AnalyticsBucketSizeKey) -> OffsetDateTime {
    let unix = timestamp.unix_timestamp();
    let bucket_seconds = bucket_size_key.duration().whole_seconds();
    let floored = unix - (unix.rem_euclid(bucket_seconds));
    OffsetDateTime::from_unix_timestamp(floored).unwrap_or(timestamp)
}

fn resample_rows(
    rows: &[InternalStatsRow],
    live_buy_rows: &[InternalStatsRow],
    domain_key: AnalyticsDomainKey,
    bucket_size_key: AnalyticsBucketSizeKey,
) -> Vec<AnalyticsChartPoint> {
    let cutoff = now_utc() - domain_key.lookback();
    let filtered_rows = rows
        .iter()
        .filter(|row| row.bucket_at >= cutoff)
        .cloned()
        .collect::<Vec<_>>();
    let filtered_live_buy = live_buy_rows
        .iter()
        .filter(|row| row.bucket_at >= cutoff)
        .cloned()
        .collect::<Vec<_>>();

    let mut bucket_map: BTreeMap<i64, Vec<InternalStatsRow>> = BTreeMap::new();
    for row in filtered_rows {
        let bucket_start = floor_timestamp(row.bucket_at, bucket_size_key).unix_timestamp();
        bucket_map.entry(bucket_start).or_default().push(row);
    }

    let mut live_buy_map: BTreeMap<i64, Vec<InternalStatsRow>> = BTreeMap::new();
    for row in filtered_live_buy {
        let bucket_start = floor_timestamp(row.bucket_at, bucket_size_key).unix_timestamp();
        live_buy_map.entry(bucket_start).or_default().push(row);
    }

    bucket_map
        .into_iter()
        .map(|(bucket_start, bucket_rows)| {
            let live_bucket_rows = live_buy_map.get(&bucket_start).cloned().unwrap_or_default();
            let bucket_at = OffsetDateTime::from_unix_timestamp(bucket_start)
                .unwrap_or_else(|_| now_utc());
            let volume = bucket_rows.iter().map(|row| row.volume).sum::<f64>();

            let fair_inputs = bucket_rows.last().cloned();
            let fair_low = fair_inputs
                .as_ref()
                .and_then(|row| {
                    let mut values = vec![];
                    if let Some(value) = row_median_anchor(row) {
                        values.push(value);
                    }
                    if let Some(value) = row.wa_price {
                        values.push(value);
                    }
                    if let Some(value) = row.moving_avg {
                        values.push(value);
                    }
                    if let Some(value) = row.donch_bot {
                        values.push(value);
                    }
                    values.into_iter().reduce(f64::min)
                });
            let fair_high = fair_inputs
                .as_ref()
                .and_then(|row| {
                    let mut values = vec![];
                    if let Some(value) = row_median_anchor(row) {
                        values.push(value);
                    }
                    if let Some(value) = row.wa_price {
                        values.push(value);
                    }
                    if let Some(value) = row.moving_avg {
                        values.push(value);
                    }
                    if let Some(value) = row.donch_top {
                        values.push(value);
                    }
                    values.into_iter().reduce(f64::max)
                });
            let fair_center = fair_inputs.as_ref().and_then(fair_center_anchor);
            let zone_bands = compute_zone_bands(fair_low, fair_high, fair_center);

            AnalyticsChartPoint {
                bucket_at: format_timestamp(bucket_at).unwrap_or_default(),
                open_price: bucket_rows.first().and_then(row_open_anchor),
                closed_price: bucket_rows.last().and_then(row_close_anchor),
                low_price: bucket_rows.iter().filter_map(row_low_anchor).reduce(f64::min),
                high_price: bucket_rows.iter().filter_map(row_high_anchor).reduce(f64::max),
                lowest_sell: bucket_rows
                    .iter()
                    .filter_map(row_low_anchor)
                    .reduce(f64::min),
                median_sell: aggregate_weighted(
                    bucket_rows.iter().map(|row| (row_median_anchor(row), row.volume)),
                ),
                moving_avg: last_defined_value(&bucket_rows, |row| {
                    row.moving_avg
                        .or(row.wa_price)
                        .or(row.avg_price)
                        .or(row.median)
                        .or(row.closed_price)
                }),
                weighted_avg: aggregate_weighted(
                    bucket_rows
                        .iter()
                        .map(|row| (row.wa_price.or(row.avg_price).or(row.median), row.volume)),
                ),
                average_price: aggregate_weighted(
                    bucket_rows
                        .iter()
                        .map(|row| (row.avg_price.or(row.wa_price).or(row.median), row.volume)),
                ),
                highest_buy: live_bucket_rows
                    .iter()
                    .filter_map(|row| {
                        row.max_price
                            .or(row.median)
                            .or(row.avg_price)
                            .or(row.wa_price)
                            .or(row.closed_price)
                            .or(row.open_price)
                    })
                    .reduce(f64::max),
                fair_value_low: fair_low,
                fair_value_high: fair_high.or_else(|| {
                    bucket_rows
                        .iter()
                        .filter_map(row_high_anchor)
                        .reduce(f64::max)
                }),
                entry_zone: zone_bands.as_ref().map(|zone| zone.entry_target),
                exit_zone: zone_bands.as_ref().map(|zone| zone.exit_target),
                volume,
            }
        })
        .collect()
}

fn slope_over_hours(points: &[AnalyticsChartPoint], series_key: &str, hours: i64) -> Option<f64> {
    let latest = points.last()?;
    let latest_time = parse_timestamp(&latest.bucket_at)?;
    let cutoff = latest_time - TimeDuration::hours(hours);
    let start = points
        .iter()
        .rev()
        .find(|point| parse_timestamp(&point.bucket_at).map(|value| value <= cutoff).unwrap_or(false))
        .or_else(|| points.first())?;

    let end_value = value_from_series(latest, series_key)?;
    let start_value = value_from_series(start, series_key)?;
    if start_value <= 0.0 {
        return None;
    }

    Some(((end_value - start_value) / start_value) * 100.0)
}

fn value_from_series(point: &AnalyticsChartPoint, series_key: &str) -> Option<f64> {
    match series_key {
        "lowestSell" => point.lowest_sell,
        "medianSell" => point.median_sell,
        "weightedAvg" => point.weighted_avg,
        _ => None,
    }
}

fn build_trend_metric_set(points: &[AnalyticsChartPoint], series_key: &str) -> TrendMetricSet {
    let slope_1h = slope_over_hours(points, series_key, 1);
    let slope_3h = slope_over_hours(points, series_key, 3);
    let slope_6h = slope_over_hours(points, series_key, 6);
    let latest = points.last();
    let current_value = latest.and_then(|point| value_from_series(point, series_key));
    let fair_midpoint = latest.and_then(|point| match (point.fair_value_low, point.fair_value_high) {
        (Some(low), Some(high)) => Some((low + high) / 2.0),
        _ => None,
    });

    let cross_signal = match (current_value, fair_midpoint) {
        (Some(current), Some(fair)) if current < fair => "Below fair value".to_string(),
        (Some(current), Some(fair)) if current > fair => "Above fair value".to_string(),
        _ => "Near fair value".to_string(),
    };

    let reversal = match (slope_1h, slope_3h) {
        (Some(short), Some(medium)) if short > 0.0 && medium < 0.0 => "Bullish reversal".to_string(),
        (Some(short), Some(medium)) if short < 0.0 && medium > 0.0 => "Bearish reversal".to_string(),
        _ => "No active reversal".to_string(),
    };

    let mut confirming_signals = Vec::new();
    if slope_1h.unwrap_or(0.0) > 0.0 {
        confirming_signals.push("1h slope positive".to_string());
    }
    if slope_3h.unwrap_or(0.0) > 0.0 {
        confirming_signals.push("3h slope positive".to_string());
    }
    if slope_6h.unwrap_or(0.0) > 0.0 {
        confirming_signals.push("6h slope positive".to_string());
    }
    if cross_signal == "Below fair value" {
        confirming_signals.push("Trading below fair midpoint".to_string());
    }

    let confidence = (confirming_signals.len() as f64 / 4.0).clamp(0.25, 1.0) * 100.0;

    TrendMetricSet {
        slope_1h,
        slope_3h,
        slope_6h,
        cross_signal,
        reversal,
        confidence,
        confirming_signals,
    }
}

fn compute_stability(points: &[AnalyticsChartPoint]) -> (f64, f64, f64) {
    let values = points
        .iter()
        .filter_map(|point| point.median_sell)
        .collect::<Vec<_>>();
    if values.len() < 2 {
        return (50.0, 0.0, 50.0);
    }

    let mut returns = Vec::new();
    for window in values.windows(2) {
        if let [previous, current] = window {
            if *previous > 0.0 {
                returns.push((current - previous) / previous);
            }
        }
    }

    if returns.is_empty() {
        return (50.0, 0.0, 50.0);
    }

    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let variance = returns
        .iter()
        .map(|entry| (entry - mean).powi(2))
        .sum::<f64>()
        / returns.len() as f64;
    let volatility = variance.sqrt() * 100.0;
    let stability = (100.0 - (volatility * 8.0)).clamp(10.0, 100.0);
    let noise = (100.0 - (volatility * 10.0)).clamp(5.0, 100.0);
    (stability, volatility, noise)
}

fn build_entry_exit_zone_overview(
    snapshot: Option<&MarketSnapshot>,
    latest_point: Option<&AnalyticsChartPoint>,
) -> EntryExitZoneOverview {
    let fair_value_low = latest_point.and_then(|point| point.fair_value_low);
    let fair_value_high = latest_point.and_then(|point| point.fair_value_high);
    let fair_center = latest_point.and_then(|point| {
        point
            .weighted_avg
            .or(point.median_sell)
            .or(point.average_price)
            .or(match (point.fair_value_low, point.fair_value_high) {
                (Some(low), Some(high)) => Some((low + high) * 0.5),
                _ => None,
            })
    });
    let zone_bands = compute_zone_bands(fair_value_low, fair_value_high, fair_center);
    let entry_zone_low = zone_bands.as_ref().map(|zone| zone.entry_low);
    let entry_zone_high = zone_bands.as_ref().map(|zone| zone.entry_high);
    let exit_zone_low = zone_bands.as_ref().map(|zone| zone.exit_low);
    let exit_zone_high = zone_bands.as_ref().map(|zone| zone.exit_high);

    let current_lowest_price = snapshot.and_then(|entry| entry.lowest_sell);
    let current_median_lowest_price = snapshot.and_then(|entry| entry.median_sell);
    let zone_quality = match (current_lowest_price, entry_zone_low, entry_zone_high, exit_zone_low) {
        (Some(current), Some(low), Some(high), _) if current >= low && current <= high => {
            "Excellent".to_string()
        }
        (Some(current), Some(_low), Some(high), _) if current <= high + 2.0 => {
            "Good".to_string()
        }
        (Some(current), _, _, Some(exit_low)) if current >= exit_low => "Extended".to_string(),
        (Some(_), Some(_), Some(_), _) => "Watch".to_string(),
        _ => "Thin data".to_string(),
    };
    let entry_rationale = match (current_lowest_price, entry_zone_low, entry_zone_high) {
        (Some(current), Some(low), Some(high)) if current >= low && current <= high => {
            "Current floor is inside the calculated entry band, which supports buying into the market without chasing extremes.".to_string()
        }
        (Some(current), Some(_low), Some(high)) if current < high => {
            "Current floor is approaching the calculated entry band and is close to a favorable reversion level.".to_string()
        }
        _ => "Current floor is still above the calculated entry band, so patience is likely better than forcing an entry.".to_string(),
    };
    let exit_rationale = match (current_median_lowest_price, exit_zone_low, exit_zone_high) {
        (Some(current), Some(low), Some(high)) if current >= low && current <= high => {
            "Recent median market price is inside the calculated exit band, which supports taking profit into strength.".to_string()
        }
        (Some(current), Some(low), Some(_high)) if current >= low - 2.0 => {
            "Recent median market price is approaching the calculated exit band, which supports preparing exits rather than chasing more upside.".to_string()
        }
        _ => "Recent median market price is still below the calculated exit band, so there is more room before a preferred take-profit area.".to_string(),
    };

    EntryExitZoneOverview {
        current_lowest_price,
        current_median_lowest_price,
        fair_value_low,
        fair_value_high,
        entry_zone_low,
        entry_zone_high,
        exit_zone_low,
        exit_zone_high,
        zone_quality,
        entry_rationale,
        exit_rationale,
    }
}

fn build_orderbook_pressure(snapshot: Option<&MarketSnapshot>) -> OrderbookPressureSummary {
    match snapshot {
        Some(snapshot) => OrderbookPressureSummary {
            cheapest_sell: snapshot.lowest_sell,
            highest_buy: snapshot.highest_buy,
            spread: snapshot.spread,
            spread_pct: snapshot.spread_pct,
            entry_depth: snapshot.entry_depth,
            exit_depth: snapshot.exit_depth,
            pressure_ratio: snapshot.pressure_ratio,
            pressure_label: pressure_label(snapshot.pressure_ratio),
        },
        None => OrderbookPressureSummary {
            cheapest_sell: None,
            highest_buy: None,
            spread: None,
            spread_pct: None,
            entry_depth: 0.0,
            exit_depth: 0.0,
            pressure_ratio: None,
            pressure_label: "Balanced".to_string(),
        },
    }
}

fn build_action_card(
    zone_overview: &EntryExitZoneOverview,
    orderbook_pressure: &OrderbookPressureSummary,
    trend_breakdown: &TrendQualityBreakdown,
    snapshot: Option<&MarketSnapshot>,
) -> AnalyticsActionCard {
    let mut aligned_signals = Vec::new();
    if zone_overview.zone_quality == "Excellent" || zone_overview.zone_quality == "Good" {
        aligned_signals.push("Entry zone is favorable".to_string());
    }
    if orderbook_pressure.pressure_label == "Entry Pressure" {
        aligned_signals.push("Buy-side depth is stronger than sell-side depth".to_string());
    }
    if trend_breakdown
        .tabs
        .get("lowestSell")
        .and_then(|entry| entry.slope_3h)
        .unwrap_or_default()
        > 0.0
    {
        aligned_signals.push("3h price slope is positive".to_string());
    }
    if snapshot.and_then(|entry| entry.spread_pct).unwrap_or(100.0) <= 12.0 {
        aligned_signals.push("Spread is still tradable".to_string());
    }

    let action = if zone_overview.zone_quality == "Excellent"
        && orderbook_pressure.pressure_label != "Exit Pressure"
    {
        "Buy"
    } else if zone_overview.zone_quality == "Good" && orderbook_pressure.spread_pct.unwrap_or(100.0) <= 15.0 {
        "Hold"
    } else if orderbook_pressure.pressure_label == "Exit Pressure" {
        "Caution"
    } else {
        "Wait"
    };

    let tone = match action {
        "Buy" => "green",
        "Hold" => "blue",
        "Caution" => "red",
        _ => "amber",
    }
    .to_string();
    let zone_adjusted_edge = match (zone_overview.exit_zone_low, snapshot.and_then(|entry| entry.lowest_sell)) {
        (Some(exit), Some(entry)) => Some(exit - entry),
        _ => None,
    };
    let rationale = match action {
        "Buy" => "Current floor is inside a favorable entry zone and the live book is not leaning against the trade.".to_string(),
        "Hold" => "History and live depth are broadly supportive, but the edge is narrower than a clean entry setup.".to_string(),
        "Caution" => "Live book pressure is leaning toward exits or the spread is too hostile for a clean entry.".to_string(),
        _ => "The item needs either a deeper discount, stronger buy support, or a cleaner spread before acting.".to_string(),
    };

    AnalyticsActionCard {
        suggested_action: action.to_string(),
        tone,
        zone_quality: zone_overview.zone_quality.clone(),
        zone_adjusted_edge,
        spread: orderbook_pressure.spread,
        spread_pct: orderbook_pressure.spread_pct,
        pressure_label: orderbook_pressure.pressure_label.clone(),
        aligned_signals,
        rationale,
    }
}

fn bool_from_i64(value: Option<i64>) -> Option<bool> {
    value.map(|entry| entry != 0)
}

fn round_price_option(value: Option<f64>) -> Option<f64> {
    value.map(round_platinum)
}

fn liquidity_score_percent(snapshot: &MarketSnapshot) -> f64 {
    let demand_ratio = compute_pressure_ratio(
        snapshot.buy_quantity,
        snapshot.sell_quantity,
        snapshot.buy_order_count,
        snapshot.sell_order_count,
    )
    .unwrap_or(0.0);
    let demand_balance = if demand_ratio >= 1.35 {
        100.0
    } else if demand_ratio >= 1.10 {
        80.0
    } else if demand_ratio >= 0.85 {
        60.0
    } else if demand_ratio >= 0.60 {
        40.0
    } else {
        20.0
    };

    let low_price_competition = if snapshot.near_floor_seller_count <= 2
        && snapshot.near_floor_quantity <= 5
        && snapshot.unique_sell_users <= 2
    {
        100.0
    } else if snapshot.near_floor_seller_count <= 4
        && snapshot.near_floor_quantity <= 10
        && snapshot.unique_sell_users <= 4
    {
        80.0
    } else if snapshot.near_floor_seller_count <= 7 && snapshot.near_floor_quantity <= 20 {
        60.0
    } else if snapshot.near_floor_seller_count <= 12 && snapshot.near_floor_quantity <= 40 {
        40.0
    } else {
        20.0
    };

    let activity_index = (snapshot.sell_order_count + snapshot.buy_order_count) as f64 * 0.3
        + (snapshot.sell_quantity + snapshot.buy_quantity) as f64 * 0.5
        + (snapshot.unique_sell_users + snapshot.unique_buy_users) as f64 * 0.2;
    let market_depth = if activity_index >= 120.0 {
        100.0
    } else if activity_index >= 80.0 {
        80.0
    } else if activity_index >= 45.0 {
        60.0
    } else if activity_index >= 20.0 {
        40.0
    } else {
        20.0
    };

    let spread_tightness = match snapshot.spread_pct {
        Some(value) if value <= 2.0 => 100.0,
        Some(value) if value <= 5.0 => 80.0,
        Some(value) if value <= 10.0 => 60.0,
        Some(value) if value <= 20.0 => 40.0,
        Some(_) => 20.0,
        None => 20.0,
    };

    let score: f64 = demand_balance * 0.40
        + low_price_competition * 0.25
        + market_depth * 0.20
        + spread_tightness * 0.15;

    score.clamp(0.0, 100.0)
}

fn liquidity_label(score: f64) -> String {
    if score >= 75.0 {
        "Deep".to_string()
    } else if score >= 55.0 {
        "Tradable".to_string()
    } else if score >= 35.0 {
        "Thin".to_string()
    } else {
        "Fragile".to_string()
    }
}

fn weighted_sell_percentile_price(sell_orders: &[WfmDetailedOrder], percentile: f64) -> Option<f64> {
    if sell_orders.is_empty() {
        return None;
    }

    let mut ladder = sell_orders
        .iter()
        .map(|order| {
            (
                order.platinum,
                (order.quantity.max(1) as f64).sqrt(),
            )
        })
        .collect::<Vec<_>>();
    ladder.sort_by(|left, right| left.0.total_cmp(&right.0));

    let prices = ladder.iter().map(|entry| entry.0).collect::<Vec<_>>();
    let median = median_price(&prices)?;
    let max_allowed = median + median.max(10.0) * 0.35;
    ladder.retain(|entry| entry.0 <= max_allowed);
    if ladder.is_empty() {
        return Some(median);
    }

    let total_weight = ladder.iter().map(|entry| entry.1).sum::<f64>();
    let target_weight = total_weight * (percentile / 100.0);
    let mut running_weight = 0.0;
    for (price, weight) in ladder {
        running_weight += weight;
        if running_weight >= target_weight {
            return Some(price);
        }
    }

    prices.last().copied()
}

fn historical_exit_ceiling(rows: &[InternalStatsRow]) -> Option<f64> {
    let cutoff = now_utc() - TimeDuration::days(14);
    rows.iter()
        .filter(|row| row.bucket_at >= cutoff)
        .filter_map(|row| row.max_price.or(row.donch_top).or(row.median))
        .reduce(f64::max)
}

fn recommended_exit_price(
    entry_price: Option<f64>,
    sell_orders: &[WfmDetailedOrder],
    snapshot: &MarketSnapshot,
    stats_rows: &[InternalStatsRow],
    zone_overview: &EntryExitZoneOverview,
) -> Option<f64> {
    let p60 = weighted_sell_percentile_price(sell_orders, 60.0);
    let historical_ceiling = historical_exit_ceiling(stats_rows)
        .or(zone_overview.exit_zone_high)
        .or(zone_overview.fair_value_high);
    let depth_based_cushion = if snapshot.sell_order_count < 12 { 2.0 } else { 1.0 };

    let candidate = match (p60, historical_ceiling) {
        (Some(percentile), Some(ceiling)) => percentile.max(ceiling - depth_based_cushion).min(ceiling),
        (Some(percentile), None) => percentile,
        (None, Some(ceiling)) => ceiling - depth_based_cushion,
        (None, None) => return entry_price,
    };

    let candidate = round_platinum(candidate);
    Some(candidate.max(round_platinum(entry_price.unwrap_or(candidate))))
}

fn efficiency_score_percent(
    entry_price: Option<f64>,
    exit_price: Option<f64>,
    liquidity_score: f64,
    efficiency_penalty_pct: i64,
) -> Option<f64> {
    let entry = entry_price?;
    let exit = exit_price?;
    if entry <= 0.0 {
        return None;
    }

    let profit_percent = ((exit - entry) / entry).max(0.0);
    let profit_normalization = (profit_percent / 0.25).clamp(0.0, 1.0);
    let market_quality = (liquidity_score / 100.0).clamp(0.0, 1.0);
    let base_score = (0.65 * profit_normalization) + (0.35 * market_quality);
    let liquidity_multiplier = 0.70 + (0.60 * market_quality);
    let risk_penalty = (100 - efficiency_penalty_pct).max(0) as f64 / 100.0;

    Some((100.0 * base_score * liquidity_multiplier * risk_penalty).clamp(0.0, 100.0))
}

fn efficiency_label(score: Option<f64>) -> String {
    match score {
        Some(value) if value >= 75.0 => "Plat Machine".to_string(),
        Some(value) if value >= 50.0 => "Balanced".to_string(),
        Some(value) if value >= 25.0 => "Slow Burn".to_string(),
        Some(_) => "Capital Trap".to_string(),
        None => "Pending".to_string(),
    }
}

fn recent_snapshots(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    limit: i64,
) -> Result<Vec<MarketSnapshot>> {
    let mut statement = connection.prepare(
        "SELECT
           captured_at,
           lowest_sell,
           median_sell,
           highest_buy,
           spread,
           spread_pct,
           sell_order_count,
           sell_quantity,
           buy_order_count,
           buy_quantity,
           near_floor_seller_count,
           near_floor_quantity,
           unique_sell_users,
           unique_buy_users,
           pressure_ratio,
           entry_depth,
           exit_depth
         FROM orderbook_snapshots
         WHERE item_id = ?1
           AND variant_key = ?2
         ORDER BY captured_at DESC
         LIMIT ?3",
    )?;

    let rows = statement.query_map(params![item_id, variant_key, limit], |row| {
        Ok(MarketSnapshot {
            captured_at: row.get(0)?,
            lowest_sell: row.get(1)?,
            median_sell: row.get(2)?,
            highest_buy: row.get(3)?,
            spread: row.get(4)?,
            spread_pct: row.get(5)?,
            sell_order_count: row.get(6)?,
            sell_quantity: row.get(7)?,
            buy_order_count: row.get(8)?,
            buy_quantity: row.get(9)?,
            near_floor_seller_count: row.get(10)?,
            near_floor_quantity: row.get(11)?,
            unique_sell_users: row.get(12)?,
            unique_buy_users: row.get(13)?,
            pressure_ratio: row.get(14)?,
            entry_depth: row.get(15)?,
            exit_depth: row.get(16)?,
            depth_levels: Vec::new(),
        })
    })?;

    let mut snapshots = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    snapshots.reverse();
    Ok(snapshots)
}

fn undercut_velocity_per_hour(snapshots: &[MarketSnapshot]) -> Option<f64> {
    if snapshots.len() < 2 {
        return None;
    }

    let mut undercut_steps = 0.0;
    let first_time = parse_timestamp(&snapshots.first()?.captured_at)?;
    let last_time = parse_timestamp(&snapshots.last()?.captured_at)?;
    let hours = ((last_time - first_time).whole_minutes().max(1) as f64) / 60.0;

    for window in snapshots.windows(2) {
        if let [previous, current] = window {
            if let (Some(previous_floor), Some(current_floor)) = (previous.lowest_sell, current.lowest_sell) {
                if current_floor < previous_floor {
                    undercut_steps += 1.0;
                }
            }
        }
    }

    Some(undercut_steps / hours.max(1.0))
}

fn snapshot_std_dev(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values
        .iter()
        .map(|entry| (entry - mean).powi(2))
        .sum::<f64>()
        / values.len() as f64;
    Some(variance.sqrt())
}

fn build_manipulation_risk(
    snapshot: &MarketSnapshot,
    recent_snapshots: &[MarketSnapshot],
) -> ManipulationRiskSummary {
    let price_wall_active = snapshot
        .depth_levels
        .iter()
        .filter(|level| level.side == "sell")
        .map(|level| level.quantity as f64 / snapshot.sell_quantity.max(1) as f64)
        .reduce(f64::max)
        .unwrap_or(0.0)
        >= 0.40;

    let liquidity_withdrawal_active = if recent_snapshots.len() >= 6 {
        let split_index = recent_snapshots.len() / 2;
        let previous_avg = recent_snapshots[..split_index]
            .iter()
            .map(|entry| entry.buy_quantity as f64)
            .sum::<f64>()
            / split_index as f64;
        let recent_avg = recent_snapshots[split_index..]
            .iter()
            .map(|entry| entry.buy_quantity as f64)
            .sum::<f64>()
            / (recent_snapshots.len() - split_index) as f64;
        let floor_start = recent_snapshots[split_index - 1].lowest_sell.unwrap_or(0.0);
        let floor_end = recent_snapshots.last().and_then(|entry| entry.lowest_sell).unwrap_or(0.0);
        previous_avg > 0.0 && recent_avg <= previous_avg * 0.65 && (floor_end - floor_start).abs() <= 2.0
    } else {
        false
    };

    let volatile_undercut_active = if recent_snapshots.len() >= 4 {
        let mut direction_changes = 0;
        let mut previous_direction = 0_i8;
        for window in recent_snapshots.windows(2) {
            if let [previous, current] = window {
                if let (Some(previous_floor), Some(current_floor)) = (previous.lowest_sell, current.lowest_sell) {
                    let direction = match current_floor.partial_cmp(&previous_floor) {
                        Some(Ordering::Less) => -1,
                        Some(Ordering::Greater) => 1,
                        _ => 0,
                    };
                    if direction != 0 && previous_direction != 0 && direction != previous_direction {
                        direction_changes += 1;
                    }
                    if direction != 0 {
                        previous_direction = direction;
                    }
                }
            }
        }
        direction_changes >= 3 || undercut_velocity_per_hour(recent_snapshots).unwrap_or(0.0) >= 0.45
    } else {
        false
    };

    let unstable_buy_pressure_active = snapshot_std_dev(
        &recent_snapshots
            .iter()
            .filter_map(|entry| entry.pressure_ratio)
            .collect::<Vec<_>>(),
    )
    .unwrap_or(0.0)
        >= 0.35;

    let thin_market_active =
        snapshot.sell_order_count < 6 || snapshot.unique_sell_users < 4 || snapshot.buy_order_count < 3;

    let signals = vec![
        ManipulationSignalState {
            key: "price_wall".to_string(),
            label: "Price Wall".to_string(),
            active: price_wall_active,
            detail: if price_wall_active {
                "A single sell level is carrying an outsized share of visible supply.".to_string()
            } else {
                "Visible sell supply is not concentrated at one price wall.".to_string()
            },
        },
        ManipulationSignalState {
            key: "liquidity_withdrawal".to_string(),
            label: "Liquidity Withdrawal".to_string(),
            active: liquidity_withdrawal_active,
            detail: if liquidity_withdrawal_active {
                "Buy-side quantity has fallen materially without the floor repricing down.".to_string()
            } else {
                "Buy-side liquidity is not showing a sharp withdrawal pattern.".to_string()
            },
        },
        ManipulationSignalState {
            key: "volatile_undercut_cycling".to_string(),
            label: "Volatile Undercut Cycling".to_string(),
            active: volatile_undercut_active,
            detail: if volatile_undercut_active {
                "Recent floor changes are cycling fast enough to suggest unstable queue behavior.".to_string()
            } else {
                "Recent floor changes are not cycling aggressively.".to_string()
            },
        },
        ManipulationSignalState {
            key: "unstable_buy_pressure".to_string(),
            label: "Unstable Buy Pressure".to_string(),
            active: unstable_buy_pressure_active,
            detail: if unstable_buy_pressure_active {
                "Pressure ratio is moving around too aggressively across recent snapshots.".to_string()
            } else {
                "Buy pressure has been comparatively stable across recent snapshots.".to_string()
            },
        },
        ManipulationSignalState {
            key: "thin_market".to_string(),
            label: "Thin Market".to_string(),
            active: thin_market_active,
            detail: if thin_market_active {
                "Visible supply and demand are both too light for stable execution.".to_string()
            } else {
                "The live book is deep enough to avoid the thinnest-market warning.".to_string()
            },
        },
    ];

    let active_signals = signals.iter().filter(|signal| signal.active).count();
    let risk_level = if active_signals >= 3 {
        "High"
    } else if active_signals >= 2 {
        "Moderate"
    } else {
        "Low"
    };
    let efficiency_penalty_pct = match risk_level {
        "High" => 45,
        "Moderate" => 20,
        _ => 0,
    };

    ManipulationRiskSummary {
        risk_level: risk_level.to_string(),
        active_signals,
        efficiency_penalty_pct,
        signals,
    }
}

fn build_time_of_day_liquidity(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
) -> Result<TimeOfDayLiquiditySummary> {
    let cutoff = format_timestamp(now_utc() - TimeDuration::days(30))?;
    let mut statement = connection.prepare(
        "SELECT captured_at, sell_quantity + buy_quantity AS visible_quantity, sell_order_count, spread_pct
         FROM orderbook_snapshots
         WHERE item_id = ?1
           AND variant_key = ?2
           AND captured_at >= ?3
         ORDER BY captured_at ASC",
    )?;
    let rows = statement.query_map(params![item_id, variant_key, cutoff], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<f64>>(3)?,
        ))
    })?;

    let mut per_hour = BTreeMap::<i64, Vec<(f64, f64, Option<f64>)>>::new();
    for row in rows {
        let (captured_at, visible_quantity, sell_orders, spread_pct) = row?;
        let Some(timestamp) = parse_timestamp(&captured_at) else {
            continue;
        };
        per_hour
            .entry(timestamp.hour() as i64)
            .or_default()
            .push((visible_quantity as f64, sell_orders as f64, spread_pct));
    }

    let buckets = per_hour
        .into_iter()
        .map(|(hour, entries)| {
            let avg_visible_quantity =
                entries.iter().map(|entry| entry.0).sum::<f64>() / entries.len() as f64;
            let avg_sell_orders =
                entries.iter().map(|entry| entry.1).sum::<f64>() / entries.len() as f64;
            let spread_values = entries
                .iter()
                .filter_map(|entry| entry.2)
                .collect::<Vec<_>>();

            TimeOfDayLiquidityBucket {
                hour,
                label: format!("{hour:02}:00"),
                avg_visible_quantity,
                avg_sell_orders,
                avg_spread_pct: if spread_values.is_empty() {
                    None
                } else {
                    Some(spread_values.iter().sum::<f64>() / spread_values.len() as f64)
                },
            }
        })
        .collect::<Vec<_>>();

    let strongest_window_label = buckets
        .iter()
        .max_by(|left, right| left.avg_visible_quantity.total_cmp(&right.avg_visible_quantity))
        .map(|bucket| bucket.label.clone());
    let weakest_window_label = buckets
        .iter()
        .min_by(|left, right| left.avg_visible_quantity.total_cmp(&right.avg_visible_quantity))
        .map(|bucket| bucket.label.clone());
    let current_hour_label = format!("{:02}:00", now_utc().hour());

    Ok(TimeOfDayLiquiditySummary {
        current_hour_label,
        strongest_window_label,
        weakest_window_label,
        buckets,
    })
}

fn load_item_detail_summary(
    app: &tauri::AppHandle,
    item_id: i64,
    slug: &str,
) -> Result<ItemDetailSummary> {
    let connection = open_catalog_database(app)?;
    let detail_row = connection.query_row(
        "SELECT
           COALESCE(i.preferred_name, w.name_en, ws.name, i.canonical_name, ?2),
           COALESCE(i.wfm_slug, w.slug, ?2),
           COALESCE(i.preferred_image, w.thumb, w.icon, ws.wikia_thumbnail),
           COALESCE(ws.wikia_url, json_extract(w.raw_json, '$.i18n.en.wikiLink')),
           ws.description,
           i.item_family,
           ws.category,
           ws.type,
           ws.rarity,
           ws.mastery_req,
           w.max_rank,
           w.ducats,
           ws.tradable,
           ws.is_prime,
           COALESCE(ws.vaulted, w.vaulted),
           ws.release_date,
           ws.estimated_vault_date,
           ws.vault_date
         FROM items i
         LEFT JOIN wfm_items w ON w.item_id = i.item_id
         LEFT JOIN wfstat_items ws ON ws.item_id = i.item_id
         WHERE i.item_id = ?1
         LIMIT 1",
        params![item_id, slug],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, Option<i64>>(12)?,
                row.get::<_, Option<i64>>(13)?,
                row.get::<_, Option<i64>>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
                row.get::<_, Option<String>>(17)?,
            ))
        },
    )?;

    let tags = {
        let mut statement = connection.prepare(
            "SELECT DISTINCT tag
             FROM wfm_item_tags
             JOIN wfm_items ON wfm_items.wfm_id = wfm_item_tags.wfm_id
             WHERE wfm_items.item_id = ?1
             ORDER BY tag ASC",
        )?;
        let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    Ok(ItemDetailSummary {
        item_id,
        name: detail_row.0,
        slug: detail_row.1,
        image_path: detail_row.2,
        wiki_link: detail_row.3,
        description: detail_row.4,
        item_family: detail_row.5,
        category: detail_row.6,
        item_type: detail_row.7,
        rarity: detail_row.8,
        mastery_req: detail_row.9,
        max_rank: detail_row.10,
        ducats: detail_row.11,
        tradable: bool_from_i64(detail_row.12),
        prime: bool_from_i64(detail_row.13),
        vaulted: bool_from_i64(detail_row.14),
        release_date: detail_row.15,
        estimated_vault_date: detail_row.16,
        vault_date: detail_row.17,
        tags,
    })
}

fn resolve_item_id_by_slug(connection: &Connection, slug: &str) -> Result<Option<i64>> {
    connection
        .query_row(
            "SELECT item_id
             FROM items
             WHERE wfm_slug = ?1 OR preferred_slug = ?1
             LIMIT 1",
            params![slug],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(Into::into)
}

fn fetch_wfm_set_items(slug: &str) -> Result<Vec<WfmSetItemRecord>> {
    let client = build_wfm_client()?;
    let response = client
        .get(format!("{WFM_API_BASE_URL_V2}/item/{slug}/set"))
        .header("User-Agent", WFM_USER_AGENT)
        .header("Language", WFM_LANGUAGE_HEADER)
        .header("Platform", WFM_PLATFORM_HEADER)
        .header("Crossplay", WFM_CROSSPLAY_HEADER)
        .send()
        .context("failed to request WFM set payload")?
        .error_for_status()
        .context("WFM set request failed")?;

    Ok(response
        .json::<WfmSetApiResponse>()
        .context("failed to parse WFM set response")?
        .data
        .items)
}

fn load_drop_sources(
    app: &tauri::AppHandle,
    item_id: i64,
) -> Result<Vec<DropSourceEntry>> {
    let connection = open_catalog_database(app)?;
    let primary_unique_name = connection
        .query_row(
            "SELECT primary_wfstat_unique_name
             FROM items
             WHERE item_id = ?1",
            params![item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();

    let mut sources = Vec::new();
    if let Some(unique_name) = primary_unique_name {
        let mut statement = connection.prepare(
            "SELECT location, chance, rarity, type
             FROM wfstat_item_drops
             WHERE wfstat_unique_name = ?1",
        )?;
        let rows = statement.query_map(params![unique_name], |row| {
            Ok(DropSourceEntry {
                location: row.get(0)?,
                chance: row.get(1)?,
                rarity: row.get(2)?,
                source_type: row.get(3)?,
            })
        })?;
        sources.extend(rows.collect::<std::result::Result<Vec<_>, _>>()?);
    }

    let mut component_statement = connection.prepare(
        "SELECT cd.location, cd.chance, cd.rarity, cd.type
         FROM wfstat_component_drops cd
         JOIN wfstat_item_components c ON c.component_id = cd.component_id
         WHERE c.component_item_id = ?1",
    )?;
    let component_rows = component_statement.query_map(params![item_id], |row| {
        Ok(DropSourceEntry {
            location: row.get(0)?,
            chance: row.get(1)?,
            rarity: row.get(2)?,
            source_type: row.get(3)?,
        })
    })?;
    sources.extend(component_rows.collect::<std::result::Result<Vec<_>, _>>()?);

    let mut deduped = BTreeMap::<(String, Option<String>, Option<String>), DropSourceEntry>::new();
    for source in sources {
        let key = (
            source.location.clone(),
            source.rarity.clone(),
            source.source_type.clone(),
        );
        deduped
            .entry(key)
            .and_modify(|entry| {
                if entry.chance.unwrap_or(0.0) < source.chance.unwrap_or(0.0) {
                    entry.chance = source.chance;
                }
            })
            .or_insert(source);
    }

    Ok(deduped.into_values().take(10).collect())
}

fn build_trend_quality_breakdown(points: &[AnalyticsChartPoint]) -> TrendQualityBreakdown {
    let mut tabs = HashMap::new();
    tabs.insert(
        "lowestSell".to_string(),
        build_trend_metric_set(points, "lowestSell"),
    );
    tabs.insert(
        "medianSell".to_string(),
        build_trend_metric_set(points, "medianSell"),
    );
    tabs.insert(
        "weightedAvg".to_string(),
        build_trend_metric_set(points, "weightedAvg"),
    );
    let (stability, volatility, noise) = compute_stability(points);

    TrendQualityBreakdown {
        selected_tab: "lowestSell".to_string(),
        tabs,
        stability,
        volatility,
        noise,
    }
}

fn build_trend_summary(breakdown: &TrendQualityBreakdown) -> TrendSummary {
    let lowest_sell = breakdown.tabs.get("lowestSell");
    let slope_1h = lowest_sell.and_then(|entry| entry.slope_1h);
    let slope_3h = lowest_sell.and_then(|entry| entry.slope_3h);
    let slope_6h = lowest_sell.and_then(|entry| entry.slope_6h);

    let direction = match (slope_3h.unwrap_or(0.0), slope_6h.unwrap_or(0.0)) {
        (short, medium) if short > 0.4 && medium >= 0.0 => "Rising",
        (short, medium) if short < -0.4 && medium <= 0.0 => "Falling",
        _ => "Flat",
    };

    let summary = match direction {
        "Rising" => "Short-term momentum is positive and the live structure is leaning upward.".to_string(),
        "Falling" => "Recent slope structure is still pointing down, so patience matters more than chase entries.".to_string(),
        _ => "Recent price structure is mixed, with neither buyers nor sellers holding a clean short-term trend.".to_string(),
    };

    TrendSummary {
        direction: direction.to_string(),
        confidence: lowest_sell.map(|entry| entry.confidence),
        summary,
        slope_1h,
        slope_3h,
        slope_6h,
    }
}

fn build_supply_context(
    app: &tauri::AppHandle,
    item_id: i64,
    slug: &str,
    item_details: &ItemDetailSummary,
) -> Result<ItemSupplyContext> {
    let looks_like_set = item_details.tags.iter().any(|tag| tag == "set")
        || item_details.name.ends_with(" Set");

    if looks_like_set {
        let connection = open_catalog_database(app)?;
        let mut components = Vec::new();
        for component in fetch_wfm_set_items(slug)? {
            if component.set_root == Some(true) || component.slug == slug {
                continue;
            }

            let item_id = resolve_item_id_by_slug(&connection, &component.slug)?;
            let name = component
                .i18n
                .get("en")
                .and_then(|entry| entry.name.clone())
                .unwrap_or_else(|| component.slug.replace('_', " "));
            let image_path = component
                .i18n
                .get("en")
                .and_then(|entry| entry.thumb.clone().or(entry.icon.clone()));

            let (current_lowest_price, recommended_entry_price) = match item_id {
                Some(component_item_id) => match build_item_analytics_inner(
                    app.clone(),
                    component_item_id,
                    component.slug.clone(),
                    Some("base".to_string()),
                    Some("48h".to_string()),
                    Some("1h".to_string()),
                ) {
                    Ok(component_analytics) => (
                        component_analytics
                            .current_snapshot
                            .as_ref()
                            .and_then(|entry| entry.lowest_sell)
                            .map(round_platinum),
                        component_analytics
                            .entry_exit_zone_overview
                            .entry_zone_low
                            .map(round_platinum)
                            .or_else(|| {
                                component_analytics
                                    .current_snapshot
                                    .as_ref()
                                    .and_then(|entry| entry.lowest_sell)
                                    .map(round_platinum)
                            }),
                    ),
                    Err(_) => {
                        let (_, _, _, snapshot) = fetch_filtered_orders(&component.slug, "base")?;
                        (
                            snapshot.lowest_sell.map(round_platinum),
                            snapshot.lowest_sell.map(round_platinum),
                        )
                    }
                },
                None => {
                    let (_, _, _, snapshot) = fetch_filtered_orders(&component.slug, "base")?;
                    (
                        snapshot.lowest_sell.map(round_platinum),
                        snapshot.lowest_sell.map(round_platinum),
                    )
                }
            };

            components.push(SetComponentAnalysisEntry {
                item_id,
                slug: component.slug,
                name,
                image_path,
                current_lowest_price,
                recommended_entry_price,
                variant_key: "base".to_string(),
                variant_label: "Base Market".to_string(),
            });
        }

        return Ok(ItemSupplyContext {
            mode: "set-components".to_string(),
            components,
            drop_sources: Vec::new(),
        });
    }

    let drop_sources = load_drop_sources(app, item_id)?;
    Ok(ItemSupplyContext {
        mode: if drop_sources.is_empty() {
            "none".to_string()
        } else {
            "drop-sources".to_string()
        },
        components: Vec::new(),
        drop_sources,
    })
}

fn build_item_analysis_inner(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
    variant_key: Option<String>,
) -> Result<ItemAnalysisResponse> {
    let variant_key = normalize_variant_key(variant_key.as_deref());
    let analytics = build_item_analytics_inner(
        app.clone(),
        item_id,
        slug.clone(),
        Some(variant_key.clone()),
        Some("48h".to_string()),
        Some("1h".to_string()),
    )?;

    let live_orders = fetch_filtered_orders(&slug, &variant_key).ok();
    let current_snapshot = live_orders
        .as_ref()
        .map(|entry| entry.3.clone())
        .or_else(|| analytics.current_snapshot.clone())
        .ok_or_else(|| anyhow!("market snapshot unavailable for analysis"))?;
    let sell_orders = live_orders
        .as_ref()
        .map(|entry| entry.1.clone())
        .unwrap_or_default();

    let connection = open_market_observatory_database(&app)?;
    let recent_snapshots = recent_snapshots(&connection, item_id, &variant_key, 12)?;
    let (stats_rows, _, _) = load_chart_statistics_rows(
        &connection,
        item_id,
        &variant_key,
        AnalyticsDomainKey::ThirtyDays,
    )?;

    let manipulation_risk = build_manipulation_risk(&current_snapshot, &recent_snapshots);
    let liquidity_score = liquidity_score_percent(&current_snapshot);
    let entry_price = round_price_option(current_snapshot.lowest_sell);
    let exit_price = round_price_option(recommended_exit_price(
        entry_price,
        &sell_orders,
        &current_snapshot,
        &stats_rows,
        &analytics.entry_exit_zone_overview,
    ));
    let gross_margin = match (
        historical_exit_ceiling(&stats_rows).map(round_platinum),
        entry_price,
    ) {
        (Some(exit_ceiling), Some(entry)) => Some(exit_ceiling - entry),
        _ => None,
    };
    let net_margin = match (exit_price, entry_price) {
        (Some(exit), Some(entry)) => Some(exit - entry),
        _ => None,
    };
    let efficiency_score = efficiency_score_percent(
        entry_price,
        exit_price,
        liquidity_score,
        manipulation_risk.efficiency_penalty_pct,
    );
    let demand_ratio = compute_pressure_ratio(
        current_snapshot.buy_quantity,
        current_snapshot.sell_quantity,
        current_snapshot.buy_order_count,
        current_snapshot.sell_order_count,
    );
    let quantity_weighted_demand = if current_snapshot.sell_quantity > 0 {
        Some(
            (current_snapshot.buy_quantity as f64
                / (current_snapshot.buy_quantity + current_snapshot.sell_quantity) as f64)
                * 100.0,
        )
    } else {
        None
    };
    let liquidity_state = match demand_ratio {
        Some(value) if value >= 1.1 => "Demand Heavy",
        Some(value) if value <= 0.9 => "Supply Heavy",
        Some(_) => "Balanced",
        None => "Balanced",
    };
    let trend = build_trend_summary(&analytics.trend_quality_breakdown);
    let item_details = load_item_detail_summary(&app, item_id, &slug)?;
    let supply_context = build_supply_context(&app, item_id, &slug, &item_details)?;

    Ok(ItemAnalysisResponse {
        item_id,
        slug,
        variant_key: analytics.variant_key.clone(),
        variant_label: analytics.variant_label.clone(),
        computed_at: format_timestamp(now_utc())?,
        source_snapshot_at: Some(current_snapshot.captured_at.clone()),
        source_stats_fetched_at: analytics.source_stats_fetched_at.clone(),
        headline: AnalysisHeadline {
            entry_price,
            exit_price,
            exit_percentile_label: "P60".to_string(),
            net_margin,
            liquidity_score: Some(liquidity_score),
            liquidity_label: liquidity_label(liquidity_score),
        },
        flip_analysis: FlipAnalysisSummary {
            entry_price,
            exit_price,
            gross_margin,
            net_margin,
            efficiency_score,
            efficiency_label: efficiency_label(efficiency_score),
        },
        liquidity_detail: LiquidityDetailSummary {
            demand_ratio,
            state: liquidity_state.to_string(),
            sellers_within_two_pt: current_snapshot.near_floor_seller_count,
            undercut_velocity: undercut_velocity_per_hour(&recent_snapshots),
            quantity_weighted_demand,
            liquidity_score: Some(liquidity_score),
        },
        trend,
        manipulation_risk,
        time_of_day_liquidity: build_time_of_day_liquidity(&connection, item_id, &variant_key)?,
        item_details,
        supply_context,
    })
}

fn load_cached_analytics(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    domain_key: AnalyticsDomainKey,
    bucket_size_key: AnalyticsBucketSizeKey,
    source_snapshot_at: Option<&str>,
    source_stats_fetched_at: Option<&str>,
) -> Result<Option<ItemAnalyticsResponse>> {
    let cached_row = connection
        .query_row(
            "SELECT payload_json, source_snapshot_at, source_stats_fetched_at, cache_version
             FROM analytics_cache
             WHERE item_id = ?1
               AND variant_key = ?2
               AND domain_key = ?3
               AND bucket_size_key = ?4",
            params![
                item_id,
                variant_key,
                domain_key.as_str(),
                bucket_size_key.as_str()
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;

    let Some((payload_json, cached_snapshot_at, cached_stats_at, cache_version)) = cached_row else {
        return Ok(None);
    };

    if cached_snapshot_at.as_deref() != source_snapshot_at
        || cached_stats_at.as_deref() != source_stats_fetched_at
        || cache_version != ANALYTICS_CACHE_VERSION
    {
        return Ok(None);
    }

    let parsed =
        serde_json::from_str::<ItemAnalyticsResponse>(&payload_json).context("failed to parse analytics cache payload")?;

    Ok(Some(parsed))
}

fn persist_analytics_cache(
    connection: &Connection,
    response: &ItemAnalyticsResponse,
    domain_key: AnalyticsDomainKey,
    bucket_size_key: AnalyticsBucketSizeKey,
) -> Result<()> {
    connection.execute(
        "INSERT INTO analytics_cache (
           item_id,
           slug,
           variant_key,
           domain_key,
           bucket_size_key,
           cache_version,
           computed_at,
           payload_json,
           source_snapshot_at,
           source_stats_fetched_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(item_id, variant_key, domain_key, bucket_size_key) DO UPDATE SET
           slug = excluded.slug,
           cache_version = excluded.cache_version,
           computed_at = excluded.computed_at,
           payload_json = excluded.payload_json,
           source_snapshot_at = excluded.source_snapshot_at,
           source_stats_fetched_at = excluded.source_stats_fetched_at",
        params![
            response.item_id,
            response.slug,
            response.variant_key,
            domain_key.as_str(),
            bucket_size_key.as_str(),
            ANALYTICS_CACHE_VERSION,
            response.computed_at,
            serde_json::to_string(response).context("failed to serialize analytics payload")?,
            response.source_snapshot_at,
            response.source_stats_fetched_at
        ],
    )?;

    Ok(())
}

fn build_item_analytics_inner(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
    variant_key: Option<String>,
    domain_key: Option<String>,
    bucket_size_key: Option<String>,
) -> Result<ItemAnalyticsResponse> {
    let analytics_domain_key = domain_key
        .as_deref()
        .map(AnalyticsDomainKey::try_from)
        .transpose()?
        .unwrap_or(AnalyticsDomainKey::FortyEightHours);
    let analytics_bucket_size_key = bucket_size_key
        .as_deref()
        .map(AnalyticsBucketSizeKey::try_from)
        .transpose()?
        .unwrap_or(AnalyticsBucketSizeKey::OneHour);
    let variant_key = normalize_variant_key(variant_key.as_deref());
    let variant_label = derive_variant_label(&variant_key);
    let connection = open_market_observatory_database(&app)?;

    if let Err(error) = fetch_and_cache_statistics(&connection, item_id, &slug, &variant_key) {
        if !statistics_cache_is_usable(
            &connection,
            item_id,
            &variant_key,
            AnalyticsDomainKey::FortyEightHours,
        )? {
            return Err(error);
        }
    }

    let snapshot = maybe_capture_fresh_snapshot(&connection, item_id, &slug, &variant_key)?;
    let (hourly_closed_rows, hourly_live_buy_rows, hourly_stats_fetched_at) =
        load_statistics_rows_for_domain(&connection, item_id, &variant_key, "48hours")?;
    let trend_points = resample_rows(
        &hourly_closed_rows,
        &hourly_live_buy_rows,
        AnalyticsDomainKey::FortyEightHours,
        AnalyticsBucketSizeKey::OneHour,
    );
    let (chart_closed_rows, chart_live_buy_rows, chart_stats_fetched_at) =
        load_chart_statistics_rows(&connection, item_id, &variant_key, analytics_domain_key)?;
    let chart_points = merge_snapshot_chart_points(
        resample_rows(
            &chart_closed_rows,
            &chart_live_buy_rows,
            analytics_domain_key,
            analytics_bucket_size_key,
        ),
        load_snapshot_chart_points(
            &connection,
            item_id,
            &variant_key,
            analytics_domain_key,
            analytics_bucket_size_key,
        )?,
    );
    let latest_stats_fetched_at = merge_latest_fetched_at(hourly_stats_fetched_at, chart_stats_fetched_at);
    let source_snapshot_at = Some(snapshot.captured_at.clone());
    if let Some(cached) = load_cached_analytics(
        &connection,
        item_id,
        &variant_key,
        analytics_domain_key,
        analytics_bucket_size_key,
        source_snapshot_at.as_deref(),
        latest_stats_fetched_at.as_deref(),
    )? {
        return Ok(cached);
    }

    let latest_point = trend_points.last();
    let zone_overview = build_entry_exit_zone_overview(Some(&snapshot), latest_point);
    let orderbook_pressure = build_orderbook_pressure(Some(&snapshot));
    let trend_quality_breakdown = build_trend_quality_breakdown(&trend_points);
    let action_card = build_action_card(
        &zone_overview,
        &orderbook_pressure,
        &trend_quality_breakdown,
        Some(&snapshot),
    );
    let response = ItemAnalyticsResponse {
        item_id,
        slug,
        variant_key: variant_key.clone(),
        variant_label,
        chart_domain_key: analytics_domain_key.as_str().to_string(),
        chart_bucket_size_key: analytics_bucket_size_key.as_str().to_string(),
        computed_at: format_timestamp(now_utc())?,
        source_snapshot_at,
        source_stats_fetched_at: latest_stats_fetched_at,
        current_snapshot: Some(snapshot),
        chart_points,
        entry_exit_zone_overview: zone_overview,
        orderbook_pressure,
        trend_quality_breakdown,
        action_card,
    };

    persist_analytics_cache(
        &connection,
        &response,
        analytics_domain_key,
        analytics_bucket_size_key,
    )?;
    Ok(response)
}

#[tauri::command]
pub async fn get_item_variants_for_market(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
) -> Result<Vec<MarketVariant>, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_variants_from_catalog(&app, item_id, &slug))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_wfm_item_orders(
    slug: String,
    variant_key: Option<String>,
) -> Result<WfmItemOrdersResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let variant_key = normalize_variant_key(variant_key.as_deref());
        let (api_version, sell_orders, buy_orders, snapshot) =
            fetch_filtered_orders(&slug, &variant_key)?;
        Ok::<_, anyhow::Error>(WfmItemOrdersResponse {
            api_version,
            slug,
            variant_key,
            sell_orders: sell_orders.into_iter().take(50).collect(),
            buy_orders: buy_orders.into_iter().take(50).collect(),
            snapshot,
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ensure_market_tracking(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
    variant_key: Option<String>,
    source: MarketTrackingSource,
) -> Result<MarketSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let variant_key = normalize_variant_key(variant_key.as_deref());
        let variant_label = derive_variant_label(&variant_key);
        let connection = open_market_observatory_database(&app)?;
        let mut sources = get_existing_sources(&connection, item_id, &slug, &variant_key)?;
        sources.insert(source);
        update_tracking_row(
            &connection,
            item_id,
            &slug,
            &variant_key,
            &variant_label,
            &sources,
            true,
            None,
        )?;
        let snapshot = capture_tracking_snapshot(&connection, item_id, &slug, &variant_key)?;
        Ok::<_, anyhow::Error>(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stop_market_tracking(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
    variant_key: Option<String>,
    source: MarketTrackingSource,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let variant_key = normalize_variant_key(variant_key.as_deref());
        let variant_label = derive_variant_label(&variant_key);
        let connection = open_market_observatory_database(&app)?;
        let mut sources = get_existing_sources(&connection, item_id, &slug, &variant_key)?;
        if sources.is_empty() {
            return Ok::<_, anyhow::Error>(());
        }
        sources.remove(&source);
        if !sources.is_empty() || latest_snapshot_for_item(&connection, item_id, &variant_key)?.is_some() {
            let _ = capture_tracking_snapshot(&connection, item_id, &slug, &variant_key);
        }
        update_tracking_row(
            &connection,
            item_id,
            &slug,
            &variant_key,
            &variant_label,
            &sources,
            false,
            latest_snapshot_for_item(&connection, item_id, &variant_key)?
                .as_ref()
                .map(|entry| entry.captured_at.as_str()),
        )?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn refresh_market_tracking(app: tauri::AppHandle) -> Result<TrackingRefreshSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_market_observatory_database(&app)?;
        let mut statement = connection.prepare(
            "SELECT item_id, slug, variant_key
             FROM tracked_items
             WHERE is_active = 1
               AND next_snapshot_at IS NOT NULL
               AND next_snapshot_at <= ?1
             ORDER BY next_snapshot_at ASC
             LIMIT 8",
        )?;
        let now = format_timestamp(now_utc())?;
        let rows = statement.query_map(params![now], |row| {
            Ok(TrackingTarget {
                item_id: row.get(0)?,
                slug: row.get(1)?,
                variant_key: row.get(2)?,
            })
        })?;
        let targets = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        let due_items = targets.len();
        let mut refreshed_items = 0;

        for target in targets {
            if capture_tracking_snapshot(&connection, target.item_id, &target.slug, &target.variant_key).is_ok() {
                refreshed_items += 1;
            }
        }

        Ok::<_, anyhow::Error>(TrackingRefreshSummary {
            refreshed_items,
            due_items,
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_item_analytics(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
    variant_key: Option<String>,
    domain_key: Option<String>,
    bucket_size_key: Option<String>,
) -> Result<ItemAnalyticsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_item_analytics_inner(app, item_id, slug, variant_key, domain_key, bucket_size_key)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_item_analysis(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
    variant_key: Option<String>,
) -> Result<ItemAnalysisResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_item_analysis_inner(app, item_id, slug, variant_key)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        build_action_card, build_entry_exit_zone_overview, build_market_snapshot,
        build_orderbook_pressure, build_trend_quality_breakdown, compute_pressure_ratio,
        compute_zone_bands,
        initialize_market_observatory_schema, insert_statistics_rows_for_domain,
        normalize_variant_key, pressure_label, resample_rows, AnalyticsBucketSizeKey,
        AnalyticsChartPoint, AnalyticsDomainKey, InternalStatsRow, MarketSnapshot,
        WfmDetailedOrder,
    };
    use rusqlite::Connection;
    fn sample_order(
        order_type: &str,
        platinum: f64,
        quantity: i64,
        username: &str,
    ) -> WfmDetailedOrder {
        WfmDetailedOrder {
            order_id: format!("{order_type}-{platinum}-{username}"),
            order_type: order_type.to_string(),
            platinum,
            quantity,
            per_trade: 1,
            rank: None,
            username: username.to_string(),
            user_slug: Some(username.to_string()),
            status: Some("online".to_string()),
            updated_at: None,
        }
    }

    #[test]
    fn normalizes_variant_key_defaults_to_base() {
        assert_eq!(normalize_variant_key(None), "base");
        assert_eq!(normalize_variant_key(Some("  ")), "base");
        assert_eq!(normalize_variant_key(Some("rank:5")), "rank:5");
    }

    #[test]
    fn computes_pressure_ratio_and_labels() {
        let strong_entry = compute_pressure_ratio(100, 40, 20, 10).expect("ratio");
        assert!(strong_entry > 1.1);
        assert_eq!(pressure_label(Some(strong_entry)), "Entry Pressure");
        assert_eq!(pressure_label(Some(0.5)), "Exit Pressure");
    }

    #[test]
    fn builds_snapshot_metrics_from_filtered_orders() {
        let snapshot = build_market_snapshot(
            "2026-03-11T00:00:00Z",
            &[
                sample_order("sell", 10.0, 2, "alpha"),
                sample_order("sell", 12.0, 1, "bravo"),
                sample_order("sell", 11.0, 3, "charlie"),
            ],
            &[
                sample_order("buy", 8.0, 2, "delta"),
                sample_order("buy", 9.0, 1, "echo"),
            ],
        );

        assert_eq!(snapshot.lowest_sell, Some(10.0));
        assert_eq!(snapshot.highest_buy, Some(9.0));
        assert_eq!(snapshot.spread, Some(1.0));
        assert_eq!(snapshot.sell_order_count, 3);
        assert_eq!(snapshot.buy_order_count, 2);
    }

    #[test]
    fn resamples_native_rows_into_chart_points() {
        let base_time = super::floor_timestamp(
            super::now_utc() - time::Duration::hours(2),
            AnalyticsBucketSizeKey::ThreeHours,
        );
        let rows = vec![
            InternalStatsRow {
                bucket_at: base_time,
                source_kind: "closed".to_string(),
                volume: 5.0,
                min_price: Some(10.0),
                max_price: Some(14.0),
                open_price: Some(10.0),
                closed_price: Some(12.0),
                avg_price: Some(11.5),
                wa_price: Some(11.8),
                median: Some(12.0),
                moving_avg: Some(11.0),
                donch_top: Some(14.0),
                donch_bot: Some(9.0),
            },
            InternalStatsRow {
                bucket_at: base_time + time::Duration::hours(1),
                source_kind: "closed".to_string(),
                volume: 7.0,
                min_price: Some(11.0),
                max_price: Some(15.0),
                open_price: Some(12.0),
                closed_price: Some(13.0),
                avg_price: Some(12.5),
                wa_price: Some(12.8),
                median: Some(12.0),
                moving_avg: Some(11.5),
                donch_top: Some(15.0),
                donch_bot: Some(9.0),
            },
        ];

        let points = resample_rows(
            &rows,
            &[],
            AnalyticsDomainKey::FortyEightHours,
            AnalyticsBucketSizeKey::ThreeHours,
        );

        assert_eq!(points.len(), 1);
        assert_eq!(points[0].lowest_sell, Some(10.0));
        assert_eq!(points[0].volume, 12.0);
    }

    #[test]
    fn resamples_sparse_rows_into_visible_chart_points() {
        let base_time = super::floor_timestamp(
            super::now_utc() - time::Duration::days(2),
            AnalyticsBucketSizeKey::TwentyFourHours,
        );
        let rows = vec![
            InternalStatsRow {
                bucket_at: base_time,
                source_kind: "closed".to_string(),
                volume: 12.0,
                min_price: None,
                max_price: None,
                open_price: None,
                closed_price: None,
                avg_price: None,
                wa_price: None,
                median: Some(67.0),
                moving_avg: None,
                donch_top: None,
                donch_bot: None,
            },
            InternalStatsRow {
                bucket_at: base_time + time::Duration::hours(6),
                source_kind: "closed".to_string(),
                volume: 18.0,
                min_price: None,
                max_price: None,
                open_price: None,
                closed_price: None,
                avg_price: None,
                wa_price: Some(69.0),
                median: Some(68.0),
                moving_avg: None,
                donch_top: None,
                donch_bot: None,
            },
        ];

        let points = resample_rows(
            &rows,
            &[],
            AnalyticsDomainKey::SevenDays,
            AnalyticsBucketSizeKey::TwentyFourHours,
        );

        assert_eq!(points.len(), 1);
        assert_eq!(points[0].lowest_sell, Some(67.0));
        assert_eq!(points[0].median_sell, Some(67.6));
        assert_eq!(points[0].weighted_avg, Some(68.2));
        assert_eq!(points[0].fair_value_high, Some(69.0));
    }

    #[test]
    fn computes_short_term_slopes_from_hourly_points() {
        let base_time = super::now_utc() - time::Duration::hours(6);
        let points = (0..7)
            .map(|index| AnalyticsChartPoint {
                bucket_at: super::format_timestamp(base_time + time::Duration::hours(index as i64))
                    .expect("timestamp"),
                open_price: Some(60.0 + index as f64),
                closed_price: Some(60.5 + index as f64),
                low_price: Some(60.0 + index as f64),
                high_price: Some(61.8 + index as f64),
                lowest_sell: Some(60.0 + index as f64),
                median_sell: Some(61.0 + index as f64),
                moving_avg: Some(60.5 + index as f64),
                weighted_avg: Some(60.8 + index as f64),
                average_price: Some(60.6 + index as f64),
                highest_buy: Some(58.0 + index as f64),
                fair_value_low: Some(59.0),
                fair_value_high: Some(66.0),
                entry_zone: Some(61.0),
                exit_zone: Some(65.0),
                volume: 10.0,
            })
            .collect::<Vec<_>>();

        let breakdown = build_trend_quality_breakdown(&points);
        let lowest_sell = breakdown.tabs.get("lowestSell").expect("lowest sell tab");

        assert!(lowest_sell.slope_1h.unwrap_or_default() > 0.0);
        assert!(lowest_sell.slope_3h.unwrap_or_default() > 0.0);
        assert!(lowest_sell.slope_6h.unwrap_or_default() > 0.0);
    }

    #[test]
    fn builds_analytics_panels_without_panicking() {
        let snapshot = MarketSnapshot {
            captured_at: "2026-03-11T00:00:00Z".to_string(),
            lowest_sell: Some(10.0),
            median_sell: Some(12.0),
            highest_buy: Some(9.0),
            spread: Some(1.0),
            spread_pct: Some(10.0),
            sell_order_count: 3,
            sell_quantity: 6,
            buy_order_count: 2,
            buy_quantity: 4,
            near_floor_seller_count: 2,
            near_floor_quantity: 3,
            unique_sell_users: 3,
            unique_buy_users: 2,
            pressure_ratio: Some(1.2),
            entry_depth: 9.0,
            exit_depth: 5.0,
            depth_levels: vec![],
        };
        let points = vec![
            AnalyticsChartPoint {
                bucket_at: "2026-03-10T21:00:00Z".to_string(),
                open_price: Some(11.2),
                closed_price: Some(11.0),
                low_price: Some(11.0),
                high_price: Some(12.1),
                lowest_sell: Some(11.0),
                median_sell: Some(12.0),
                moving_avg: Some(11.5),
                weighted_avg: Some(11.7),
                average_price: Some(11.6),
                highest_buy: Some(10.0),
                fair_value_low: Some(11.2),
                fair_value_high: Some(12.5),
                entry_zone: Some(11.0),
                exit_zone: Some(12.0),
                volume: 8.0,
            },
            AnalyticsChartPoint {
                bucket_at: "2026-03-11T00:00:00Z".to_string(),
                open_price: Some(10.8),
                closed_price: Some(10.0),
                low_price: Some(10.0),
                high_price: Some(12.0),
                lowest_sell: Some(10.0),
                median_sell: Some(12.0),
                moving_avg: Some(11.4),
                weighted_avg: Some(11.6),
                average_price: Some(11.5),
                highest_buy: Some(9.0),
                fair_value_low: Some(11.1),
                fair_value_high: Some(12.6),
                entry_zone: Some(11.0),
                exit_zone: Some(12.0),
                volume: 10.0,
            },
        ];

        let zone = build_entry_exit_zone_overview(Some(&snapshot), points.last());
        let pressure = build_orderbook_pressure(Some(&snapshot));
        let trend = build_trend_quality_breakdown(&points);
        let action = build_action_card(&zone, &pressure, &trend, Some(&snapshot));

        assert_eq!(pressure.pressure_label, "Entry Pressure");
        assert!(!action.suggested_action.is_empty());
        assert!(!zone.zone_quality.is_empty());
    }

    #[test]
    fn computes_integer_zone_bands_inside_the_historical_range() {
        let zone = compute_zone_bands(Some(55.0), Some(70.0), Some(63.0)).expect("zone bands");

        assert_eq!(zone.entry_low, 55.0);
        assert_eq!(zone.entry_high, 58.0);
        assert_eq!(zone.exit_low, 67.0);
        assert_eq!(zone.exit_high, 70.0);
        assert_eq!(zone.entry_target, 57.0);
        assert_eq!(zone.exit_target, 69.0);
    }

    #[test]
    fn keeps_entry_zone_from_climbing_too_high_when_market_bias_rises() {
        let zone = compute_zone_bands(Some(55.0), Some(70.0), Some(66.0)).expect("zone bands");

        assert_eq!(zone.entry_low, 57.0);
        assert_eq!(zone.entry_high, 60.0);
        assert_eq!(zone.exit_low, 67.0);
        assert_eq!(zone.exit_high, 70.0);
    }

    #[test]
    fn dedupes_duplicate_statistics_rows_within_domain_insert() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite");
        initialize_market_observatory_schema(&connection).expect("schema");
        let bucket_at = super::floor_timestamp(
            super::now_utc() - time::Duration::hours(1),
            AnalyticsBucketSizeKey::OneHour,
        );
        let duplicate_rows = vec![
            InternalStatsRow {
                bucket_at,
                source_kind: "closed".to_string(),
                volume: 5.0,
                min_price: Some(10.0),
                max_price: Some(14.0),
                open_price: Some(10.0),
                closed_price: Some(12.0),
                avg_price: Some(11.0),
                wa_price: Some(11.1),
                median: Some(11.5),
                moving_avg: Some(11.2),
                donch_top: Some(14.0),
                donch_bot: Some(9.0),
            },
            InternalStatsRow {
                bucket_at,
                source_kind: "closed".to_string(),
                volume: 7.0,
                min_price: Some(11.0),
                max_price: Some(15.0),
                open_price: Some(11.0),
                closed_price: Some(13.0),
                avg_price: Some(12.0),
                wa_price: Some(12.1),
                median: Some(12.5),
                moving_avg: Some(12.2),
                donch_top: Some(15.0),
                donch_bot: Some(9.0),
            },
        ];

        insert_statistics_rows_for_domain(
            &connection,
            1,
            "test_item",
            "base",
            "48hours",
            &duplicate_rows,
            "2026-03-11T00:00:00Z",
        )
        .expect("insert deduped rows");

        let row_count: i64 = connection
            .query_row(
                "SELECT COUNT(*)
                 FROM statistics_cache
                 WHERE item_id = 1
                   AND variant_key = 'base'
                   AND domain_key = '48hours'",
                [],
                |row| row.get(0),
            )
            .expect("count row");

        assert_eq!(row_count, 1);
    }

    #[test]
    fn flags_sparse_closed_cache_as_unusable() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite");
        initialize_market_observatory_schema(&connection).expect("schema");
        let base_time = super::floor_timestamp(
            super::now_utc() - time::Duration::days(20),
            AnalyticsBucketSizeKey::TwentyFourHours,
        );

        let sparse_rows = (0..12)
            .map(|index| InternalStatsRow {
                bucket_at: base_time + time::Duration::days(index),
                source_kind: "closed".to_string(),
                volume: 10.0,
                min_price: None,
                max_price: None,
                open_price: None,
                closed_price: None,
                avg_price: None,
                wa_price: None,
                median: Some(69.0),
                moving_avg: None,
                donch_top: None,
                donch_bot: None,
            })
            .collect::<Vec<_>>();

        insert_statistics_rows_for_domain(
            &connection,
            5,
            "wisp_prime_set",
            "base",
            "90days",
            &sparse_rows,
            "2026-03-11T00:00:00Z",
        )
        .expect("insert sparse rows");

        assert!(
            !super::statistics_cache_is_usable(
                &connection,
                5,
                "base",
                AnalyticsDomainKey::ThirtyDays
            )
            .expect("cache usability"),
        );
    }
}
