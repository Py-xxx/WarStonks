use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
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
const STATISTICS_STALE_MINUTES: i64 = 45;

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
    OneDay,
    SevenDays,
    ThirtyDays,
    NinetyDays,
}

impl AnalyticsDomainKey {
    fn as_str(self) -> &'static str {
        match self {
            Self::OneDay => "1d",
            Self::SevenDays => "7d",
            Self::ThirtyDays => "30d",
            Self::NinetyDays => "90d",
        }
    }

    fn source_domain(self) -> &'static str {
        match self {
            Self::OneDay => "48hours",
            Self::SevenDays | Self::ThirtyDays | Self::NinetyDays => "90days",
        }
    }

    fn lookback(self) -> TimeDuration {
        match self {
            Self::OneDay => TimeDuration::hours(24),
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
            "1d" => Ok(Self::OneDay),
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
pub struct StatisticsBucketRow {
    pub bucket_at: String,
    pub source_kind: String,
    pub volume: f64,
    pub min_price: Option<f64>,
    pub max_price: Option<f64>,
    pub open_price: Option<f64>,
    pub closed_price: Option<f64>,
    pub avg_price: Option<f64>,
    pub wa_price: Option<f64>,
    pub median: Option<f64>,
    pub moving_avg: Option<f64>,
    pub donch_top: Option<f64>,
    pub donch_bot: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsChartPoint {
    pub bucket_at: String,
    pub lowest_sell: Option<f64>,
    pub median_sell: Option<f64>,
    pub moving_avg: Option<f64>,
    pub weighted_avg: Option<f64>,
    pub average_price: Option<f64>,
    pub highest_buy: Option<f64>,
    pub fair_value_low: Option<f64>,
    pub fair_value_high: Option<f64>,
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
    pub computed_at: String,
    pub source_snapshot_at: Option<String>,
    pub source_stats_fetched_at: Option<String>,
    pub chart_points: Vec<AnalyticsChartPoint>,
    pub statistics_rows: Vec<StatisticsBucketRow>,
    pub current_snapshot: Option<MarketSnapshot>,
    pub entry_exit_zone_overview: EntryExitZoneOverview,
    pub orderbook_pressure: OrderbookPressureSummary,
    pub trend_quality_breakdown: TrendQualityBreakdown,
    pub action_card: AnalyticsActionCard,
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
#[serde(rename_all = "camelCase")]
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
          computed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          source_snapshot_at TEXT,
          source_stats_fetched_at TEXT,
          PRIMARY KEY (item_id, variant_key, domain_key, bucket_size_key)
        );
        ",
    )?;

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

fn supported_bucket_sizes(domain: AnalyticsDomainKey) -> &'static [AnalyticsBucketSizeKey] {
    match domain {
        AnalyticsDomainKey::OneDay => &[
            AnalyticsBucketSizeKey::OneHour,
            AnalyticsBucketSizeKey::ThreeHours,
            AnalyticsBucketSizeKey::TwelveHours,
            AnalyticsBucketSizeKey::EighteenHours,
            AnalyticsBucketSizeKey::TwentyFourHours,
        ],
        AnalyticsDomainKey::SevenDays => &[
            AnalyticsBucketSizeKey::TwentyFourHours,
            AnalyticsBucketSizeKey::SevenDays,
        ],
        AnalyticsDomainKey::ThirtyDays | AnalyticsDomainKey::NinetyDays => &[
            AnalyticsBucketSizeKey::TwentyFourHours,
            AnalyticsBucketSizeKey::SevenDays,
            AnalyticsBucketSizeKey::FourteenDays,
        ],
    }
}

fn validate_domain_and_bucket(
    domain_key: AnalyticsDomainKey,
    bucket_size_key: AnalyticsBucketSizeKey,
) -> Result<()> {
    if supported_bucket_sizes(domain_key).contains(&bucket_size_key) {
        Ok(())
    } else {
        Err(anyhow!(
            "bucket {} is not supported for domain {}",
            bucket_size_key.as_str(),
            domain_key.as_str()
        ))
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

fn statistics_cache_is_stale(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
) -> Result<bool> {
    let cached_fetched_at = connection
        .query_row(
            "SELECT MAX(fetched_at)
             FROM statistics_cache
             WHERE item_id = ?1
               AND variant_key = ?2",
            params![item_id, variant_key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();

    let Some(cached_fetched_at) = cached_fetched_at else {
        return Ok(true);
    };

    let Some(parsed_fetched_at) = parse_timestamp(&cached_fetched_at) else {
        return Ok(true);
    };

    Ok(now_utc() - parsed_fetched_at >= TimeDuration::minutes(STATISTICS_STALE_MINUTES))
}

fn statistics_cache_is_usable(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    domain_key: AnalyticsDomainKey,
) -> Result<bool> {
    let expected_min_rows = match domain_key {
        AnalyticsDomainKey::OneDay => 8_i64,
        AnalyticsDomainKey::SevenDays => 5_i64,
        AnalyticsDomainKey::ThirtyDays | AnalyticsDomainKey::NinetyDays => 10_i64,
    };

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
        params![item_id, variant_key, domain_key.source_domain()],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )?;

    if closed_row_count < expected_min_rows {
        return Ok(false);
    }

    Ok(rich_anchor_count > 0 && rich_anchor_count * 2 >= closed_row_count)
}

fn load_statistics_rows(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    domain_key: AnalyticsDomainKey,
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
    let rows = statement.query_map(params![item_id, variant_key, domain_key.source_domain()], |row| {
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
                    if let Some(value) = row.median {
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
                    if let Some(value) = row.median {
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

            AnalyticsChartPoint {
                bucket_at: format_timestamp(bucket_at).unwrap_or_default(),
                lowest_sell: bucket_rows
                    .iter()
                    .filter_map(|row| row.min_price)
                    .reduce(f64::min),
                median_sell: aggregate_weighted(
                    bucket_rows.iter().map(|row| (row.median, row.volume)),
                ),
                moving_avg: bucket_rows.last().and_then(|row| row.moving_avg),
                weighted_avg: aggregate_weighted(
                    bucket_rows.iter().map(|row| (row.wa_price, row.volume)),
                ),
                average_price: aggregate_weighted(
                    bucket_rows.iter().map(|row| (row.avg_price, row.volume)),
                ),
                highest_buy: live_bucket_rows
                    .iter()
                    .filter_map(|row| row.max_price.or(row.median).or(row.avg_price))
                    .reduce(f64::max),
                fair_value_low: fair_low,
                fair_value_high: fair_high,
                volume,
            }
        })
        .collect()
}

fn statistics_rows_from_points(points: &[AnalyticsChartPoint]) -> Vec<StatisticsBucketRow> {
    points
        .iter()
        .map(|point| StatisticsBucketRow {
            bucket_at: point.bucket_at.clone(),
            source_kind: "closed".to_string(),
            volume: point.volume,
            min_price: point.lowest_sell,
            max_price: point.fair_value_high,
            open_price: None,
            closed_price: None,
            avg_price: point.average_price,
            wa_price: point.weighted_avg,
            median: point.median_sell,
            moving_avg: point.moving_avg,
            donch_top: point.fair_value_high,
            donch_bot: point.fair_value_low,
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
    let entry_zone_low = match (fair_value_low, latest_point.and_then(|point| point.lowest_sell)) {
        (Some(fair_low), Some(lowest)) => Some(fair_low.min(lowest)),
        (Some(fair_low), None) => Some(fair_low),
        _ => None,
    };
    let entry_zone_high = fair_value_low;
    let exit_zone_low = fair_value_high;
    let exit_zone_high = match (
        fair_value_high,
        latest_point.and_then(|point| point.fair_value_high).or(latest_point.and_then(|point| point.average_price)),
    ) {
        (Some(fair_high), Some(ceiling)) => Some(fair_high.max(ceiling)),
        (Some(fair_high), None) => Some(fair_high),
        _ => None,
    };

    let current_lowest_price = snapshot.and_then(|entry| entry.lowest_sell);
    let current_median_lowest_price = snapshot.and_then(|entry| entry.median_sell);
    let zone_quality = match (current_lowest_price, fair_value_low, fair_value_high) {
        (Some(current), Some(low), Some(high)) if current <= low => "Excellent".to_string(),
        (Some(current), Some(low), Some(high)) if current <= (low + high) / 2.0 => {
            "Good".to_string()
        }
        (Some(_), Some(_), Some(_)) => "Watch".to_string(),
        _ => "Thin data".to_string(),
    };
    let entry_rationale = match (current_lowest_price, fair_value_low) {
        (Some(current), Some(low)) if current <= low => {
            "Current floor is trading below the lower fair-value anchor, which improves entry quality.".to_string()
        }
        (Some(current), Some(low)) if current <= low * 1.04 => {
            "Current floor is close to the lower fair-value anchor, so the item is approaching an attractive entry zone.".to_string()
        }
        _ => "Current floor is not yet discounted against the recent fair-value anchors.".to_string(),
    };
    let exit_rationale = match (current_median_lowest_price, fair_value_high) {
        (Some(current), Some(high)) if current >= high => {
            "Recent median market price is already testing the upper fair-value zone, which supports taking profit.".to_string()
        }
        (Some(current), Some(high)) if current >= high * 0.96 => {
            "Recent median market price is approaching the upper fair-value zone, which supports preparing exits.".to_string()
        }
        _ => "Recent median market price is still below the upper fair-value zone, so exits are less favorable than entries.".to_string(),
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
            "SELECT payload_json, source_snapshot_at, source_stats_fetched_at
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
                ))
            },
        )
        .optional()?;

    let Some((payload_json, cached_snapshot_at, cached_stats_at)) = cached_row else {
        return Ok(None);
    };

    if cached_snapshot_at.as_deref() != source_snapshot_at
        || cached_stats_at.as_deref() != source_stats_fetched_at
    {
        return Ok(None);
    }

    Ok(Some(
        serde_json::from_str(&payload_json).context("failed to parse analytics cache payload")?,
    ))
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
           computed_at,
           payload_json,
           source_snapshot_at,
           source_stats_fetched_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(item_id, variant_key, domain_key, bucket_size_key) DO UPDATE SET
           slug = excluded.slug,
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
    domain_key: String,
    bucket_size_key: String,
) -> Result<ItemAnalyticsResponse> {
    let domain_key = AnalyticsDomainKey::try_from(domain_key.as_str())?;
    let bucket_size_key = AnalyticsBucketSizeKey::try_from(bucket_size_key.as_str())?;
    validate_domain_and_bucket(domain_key, bucket_size_key)?;

    let variant_key = normalize_variant_key(variant_key.as_deref());
    let variant_label = derive_variant_label(&variant_key);
    let connection = open_market_observatory_database(&app)?;

    if statistics_cache_is_stale(&connection, item_id, &variant_key)?
        || !statistics_cache_is_usable(&connection, item_id, &variant_key, domain_key)?
    {
        fetch_and_cache_statistics(&connection, item_id, &slug, &variant_key)?;
    }

    let snapshot = maybe_capture_fresh_snapshot(&connection, item_id, &slug, &variant_key)?;
    let (closed_rows, live_buy_rows, latest_stats_fetched_at) =
        load_statistics_rows(&connection, item_id, &variant_key, domain_key)?;

    let chart_points = resample_rows(&closed_rows, &live_buy_rows, domain_key, bucket_size_key);
    let source_snapshot_at = Some(snapshot.captured_at.clone());
    if let Some(cached) = load_cached_analytics(
        &connection,
        item_id,
        &variant_key,
        domain_key,
        bucket_size_key,
        source_snapshot_at.as_deref(),
        latest_stats_fetched_at.as_deref(),
    )? {
        return Ok(cached);
    }

    let latest_point = chart_points.last();
    let zone_overview = build_entry_exit_zone_overview(Some(&snapshot), latest_point);
    let orderbook_pressure = build_orderbook_pressure(Some(&snapshot));
    let trend_quality_breakdown = build_trend_quality_breakdown(&chart_points);
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
        computed_at: format_timestamp(now_utc())?,
        source_snapshot_at,
        source_stats_fetched_at: latest_stats_fetched_at,
        chart_points: chart_points.clone(),
        statistics_rows: statistics_rows_from_points(&chart_points),
        current_snapshot: Some(snapshot),
        entry_exit_zone_overview: zone_overview,
        orderbook_pressure,
        trend_quality_breakdown,
        action_card,
    };

    persist_analytics_cache(&connection, &response, domain_key, bucket_size_key)?;
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
pub async fn get_wfm_item_statistics(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
    variant_key: Option<String>,
    domain_key: String,
    bucket_size_key: String,
) -> Result<Vec<StatisticsBucketRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response = build_item_analytics_inner(app, item_id, slug, variant_key, domain_key, bucket_size_key)?;
        Ok::<_, anyhow::Error>(response.statistics_rows)
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
    domain_key: String,
    bucket_size_key: String,
) -> Result<ItemAnalyticsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_item_analytics_inner(app, item_id, slug, variant_key, domain_key, bucket_size_key)
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
        initialize_market_observatory_schema, insert_statistics_rows_for_domain,
        normalize_variant_key, pressure_label, resample_rows, validate_domain_and_bucket,
        AnalyticsBucketSizeKey, AnalyticsChartPoint, AnalyticsDomainKey, InternalStatsRow,
        MarketSnapshot, WfmDetailedOrder,
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
    fn validates_bucket_support() {
        assert!(validate_domain_and_bucket(
            AnalyticsDomainKey::OneDay,
            AnalyticsBucketSizeKey::OneHour
        )
        .is_ok());
        assert!(validate_domain_and_bucket(
            AnalyticsDomainKey::SevenDays,
            AnalyticsBucketSizeKey::ThreeHours
        )
        .is_err());
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
            AnalyticsDomainKey::OneDay,
            AnalyticsBucketSizeKey::ThreeHours,
        );

        assert_eq!(points.len(), 1);
        assert_eq!(points[0].lowest_sell, Some(10.0));
        assert_eq!(points[0].volume, 12.0);
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
                lowest_sell: Some(11.0),
                median_sell: Some(12.0),
                moving_avg: Some(11.5),
                weighted_avg: Some(11.7),
                average_price: Some(11.6),
                highest_buy: Some(10.0),
                fair_value_low: Some(11.2),
                fair_value_high: Some(12.5),
                volume: 8.0,
            },
            AnalyticsChartPoint {
                bucket_at: "2026-03-11T00:00:00Z".to_string(),
                lowest_sell: Some(10.0),
                median_sell: Some(12.0),
                moving_avg: Some(11.4),
                weighted_avg: Some(11.6),
                average_price: Some(11.5),
                highest_buy: Some(9.0),
                fair_value_low: Some(11.1),
                fair_value_high: Some(12.6),
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
