use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime};

use crate::settings;
use crate::wfm_scheduler::{
    execute_coalesced_wfm_request, RequestPriority, WfmHttpResponse,
};

const ITEM_CATALOG_DATABASE_FILE: &str = "item_catalog.sqlite";
const MARKET_OBSERVATORY_DATABASE_FILE: &str = "market_observatory.sqlite";
const SCANNER_SET_MAP_FILE_NAME: &str = "wfm-set-map.json";
const WFM_API_BASE_URL_V1: &str = "https://api.warframe.market/v1";
const WFM_API_BASE_URL_V2: &str = "https://api.warframe.market/v2";
const WFM_LANGUAGE_HEADER: &str = "en";
const WFM_PLATFORM_HEADER: &str = "pc";
const WFM_CROSSPLAY_HEADER: &str = "true";
const WFM_USER_AGENT: &str = "warstonks/3.0.0";
const TRACKING_SNAPSHOT_INTERVAL_MINUTES: i64 = 4;
const SNAPSHOT_RETENTION_DAYS: i64 = 30;
const SET_COMPOSITION_CACHE_RETENTION_DAYS: i64 = 30;
const SCANNER_STATS_FRESHNESS_HOURS: i64 = 12;
const SCANNER_WFM_STATS_TIMEOUT_SECONDS: u64 = 5;
const SCANNER_ITEM_MAX_ATTEMPTS: usize = 3;
const SCANNER_ITEM_TOTAL_DEADLINE_SECONDS: u64 = 25;
// Number of items to prefetch statistics for ahead of the current scan position.
// Keeps up to SCANNER_PREFETCH_LOOKAHEAD + 1 concurrent HTTP slots occupied at once,
// fully saturating the 3-req/s rate window instead of leaving it half-idle.
const SCANNER_PREFETCH_LOOKAHEAD: usize = 2;
const WFM_DEFAULT_REQUEST_TIMEOUT_SECONDS: u64 = 20;
const ARBITRAGE_SCANNER_STALE_MINUTES: i64 = 2;
const ARBITRAGE_SCANNER_HEARTBEAT_SECONDS: u64 = 3;
const ANALYTICS_CACHE_VERSION: i64 = 5;
const ARBITRAGE_SCANNER_KEY: &str = "arbitrage";
const ARBITRAGE_SCANNER_PROGRESS_EVENT: &str = "arbitrage-scanner-progress";
const RELIC_REFINEMENT_INTACT: &str = "intact";
const RELIC_REFINEMENT_EXCEPTIONAL: &str = "exceptional";
const RELIC_REFINEMENT_FLAWLESS: &str = "flawless";
const RELIC_REFINEMENT_RADIANT: &str = "radiant";

fn scoped_wfm_coalesce_key(prefix: &str, priority: RequestPriority, slug: &str) -> String {
    let priority_scope = match priority {
        RequestPriority::Instant => "instant",
        RequestPriority::High => "high",
        RequestPriority::Medium => "medium",
        RequestPriority::Low => "low",
        RequestPriority::Background => "background",
    };
    format!("{prefix}:{priority_scope}:{slug}")
}

#[derive(Debug, Clone)]
struct RelicCatalogEntry {
    item_id: i64,
    slug: String,
    name: String,
    image_path: Option<String>,
}

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
pub struct MarketConfidenceSummary {
    pub level: String,
    pub label: String,
    pub reasons: Vec<String>,
    pub is_degraded: bool,
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
    pub confidence_summary: MarketConfidenceSummary,
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
    pub confidence_summary: MarketConfidenceSummary,
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
    pub confidence_summary: MarketConfidenceSummary,
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
    pub confidence_summary: MarketConfidenceSummary,
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
    pub confidence_summary: MarketConfidenceSummary,
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
    pub confidence_summary: MarketConfidenceSummary,
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
    pub confidence_summary: MarketConfidenceSummary,
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
    pub confidence_summary: MarketConfidenceSummary,
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
    pub confidence_summary: MarketConfidenceSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeOfDayLiquidityBucket {
    pub hour: i64,
    pub label: String,
    pub avg_visible_quantity: f64,
    pub avg_sell_orders: f64,
    pub avg_spread_pct: Option<f64>,
    pub avg_liquidity_score: f64,
    pub avg_hourly_volume: f64,
    pub sample_count: usize,
    pub normalized_liquidity: f64,
    pub normalized_volume: f64,
    pub heat_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeOfDayLiquiditySummary {
    pub current_hour_label: String,
    pub strongest_window_label: Option<String>,
    pub weakest_window_label: Option<String>,
    pub buckets: Vec<TimeOfDayLiquidityBucket>,
    pub confidence_summary: MarketConfidenceSummary,
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
    pub compat_name: Option<String>,
    pub product_category: Option<String>,
    pub polarity: Option<String>,
    pub stance_polarity: Option<String>,
    pub mod_set: Option<String>,
    pub mastery_req: Option<i64>,
    pub max_rank: Option<i64>,
    pub base_drain: Option<i64>,
    pub fusion_limit: Option<i64>,
    pub ducats: Option<i64>,
    pub market_cost: Option<i64>,
    pub build_price: Option<i64>,
    pub build_quantity: Option<i64>,
    pub build_time: Option<i64>,
    pub skip_build_time_price: Option<i64>,
    pub item_count: Option<i64>,
    pub tradable: Option<bool>,
    pub prime: Option<bool>,
    pub vaulted: Option<bool>,
    pub relic_tier: Option<String>,
    pub relic_code: Option<String>,
    pub critical_chance: Option<f64>,
    pub critical_multiplier: Option<f64>,
    pub status_chance: Option<f64>,
    pub fire_rate: Option<f64>,
    pub reload_time: Option<f64>,
    pub magazine_size: Option<i64>,
    pub multishot: Option<i64>,
    pub total_damage: Option<f64>,
    pub disposition: Option<i64>,
    pub range: Option<f64>,
    pub follow_through: Option<f64>,
    pub blocking_angle: Option<i64>,
    pub combo_duration: Option<f64>,
    pub heavy_attack_damage: Option<i64>,
    pub slam_attack: Option<i64>,
    pub heavy_slam_attack: Option<i64>,
    pub wind_up: Option<f64>,
    pub health: Option<i64>,
    pub shield: Option<i64>,
    pub armor: Option<i64>,
    pub sprint_speed: Option<f64>,
    pub power: Option<i64>,
    pub stamina: Option<i64>,
    pub noise: Option<String>,
    pub trigger: Option<String>,
    pub release_date: Option<String>,
    pub estimated_vault_date: Option<String>,
    pub vault_date: Option<String>,
    pub tags: Vec<String>,
    pub polarities: Vec<String>,
    pub parent_names: Vec<String>,
    pub ability_names: Vec<String>,
    pub attack_names: Vec<String>,
    pub rank_scale_label: Option<String>,
    pub stat_highlights: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetComponentAnalysisEntry {
    pub item_id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub quantity_in_set: i64,
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
    pub confidence_summary: MarketConfidenceSummary,
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
pub struct ArbitrageScannerComponentEntry {
    pub item_id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub quantity_in_set: i64,
    pub recommended_entry_low: Option<f64>,
    pub recommended_entry_high: Option<f64>,
    pub recommended_entry_price: Option<f64>,
    pub current_stats_price: Option<f64>,
    pub entry_at_or_below_price: bool,
    pub liquidity_score: f64,
    pub confidence_summary: MarketConfidenceSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArbitrageScannerSetEntry {
    pub set_item_id: i64,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub component_count: usize,
    pub basket_entry_cost: Option<f64>,
    pub set_exit_low: Option<f64>,
    pub set_exit_high: Option<f64>,
    pub recommended_set_exit_price: Option<f64>,
    pub gross_margin: Option<f64>,
    pub roi_pct: Option<f64>,
    pub liquidity_score: f64,
    pub arbitrage_score: f64,
    pub sale_state: String,
    pub confidence_summary: MarketConfidenceSummary,
    pub note: String,
    pub components: Vec<ArbitrageScannerComponentEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelicRefinementChanceProfile {
    pub intact: Option<f64>,
    pub exceptional: Option<f64>,
    pub flawless: Option<f64>,
    pub radiant: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelicRoiDropEntry {
    pub item_id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub rarity: Option<String>,
    pub chance_profile: RelicRefinementChanceProfile,
    pub recommended_exit_low: Option<f64>,
    pub recommended_exit_high: Option<f64>,
    pub recommended_exit_price: Option<f64>,
    pub current_stats_price: Option<f64>,
    pub liquidity_score: f64,
    pub confidence_summary: MarketConfidenceSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelicRoiRefinementSummary {
    pub refinement_key: String,
    pub refinement_label: String,
    pub run_value: Option<f64>,
    pub liquidity_score: f64,
    pub relic_roi_score: f64,
    pub confidence_summary: MarketConfidenceSummary,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelicRoiEntry {
    pub relic_item_id: i64,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub is_unvaulted: bool,
    pub drop_count: usize,
    pub confidence_summary: MarketConfidenceSummary,
    pub note: String,
    pub refinements: Vec<RelicRoiRefinementSummary>,
    pub drops: Vec<RelicRoiDropEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedRelicRefinementCounts {
    pub intact: u32,
    pub exceptional: u32,
    pub flawless: u32,
    pub radiant: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedRelicDropEntry {
    pub item_id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub rarity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedRelicEntry {
    pub relic_item_id: Option<i64>,
    pub slug: Option<String>,
    pub name: String,
    pub tier: String,
    pub code: String,
    pub image_path: Option<String>,
    pub counts: OwnedRelicRefinementCounts,
    pub drops: Vec<OwnedRelicDropEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedRelicInventoryCache {
    pub entries: Vec<OwnedRelicEntry>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArbitrageScannerResponse {
    pub computed_at: String,
    pub scan_started_at: String,
    pub scan_finished_at: String,
    pub scanned_set_count: usize,
    pub scanned_component_count: usize,
    pub opportunity_count: usize,
    pub refreshed_set_count: usize,
    pub refreshed_statistics_count: usize,
    pub skipped_entry_count: usize,
    #[serde(default)]
    pub skipped_entries: Vec<ScannerSkippedEntry>,
    #[serde(default)]
    pub skipped_summary_text: Option<String>,
    #[serde(default)]
    pub scanned_relic_count: usize,
    #[serde(default)]
    pub relic_opportunity_count: usize,
    pub results: Vec<ArbitrageScannerSetEntry>,
    #[serde(default)]
    pub relic_roi_results: Vec<RelicRoiEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArbitrageScannerProgress {
    pub scanner_key: String,
    pub status: String,
    pub progress_value: f64,
    pub stage_label: String,
    pub status_text: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub last_completed_at: Option<String>,
    pub last_error: Option<String>,
    #[serde(default)]
    pub current_set_name: Option<String>,
    #[serde(default)]
    pub current_component_name: Option<String>,
    #[serde(default)]
    pub completed_set_count: usize,
    #[serde(default)]
    pub total_set_count: usize,
    #[serde(default)]
    pub completed_component_count: usize,
    #[serde(default)]
    pub total_component_count: usize,
    #[serde(default)]
    pub skipped_entry_count: usize,
    #[serde(default)]
    pub retrying_item_name: Option<String>,
    #[serde(default)]
    pub retry_attempt: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArbitrageScannerState {
    pub latest_scan: Option<ArbitrageScannerResponse>,
    pub progress: ArbitrageScannerProgress,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCompletionOwnedItem {
    pub item_id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub quantity: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct OwnedSetComponentDelta {
    pub sync_key: String,
    pub item_id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub quantity_delta: i64,
}

#[derive(Debug, Clone, Default)]
struct ScannerRuntimeProgress {
    current_set_name: Option<String>,
    current_component_name: Option<String>,
    completed_set_count: usize,
    total_set_count: usize,
    completed_component_count: usize,
    total_component_count: usize,
    skipped_entry_count: usize,
    retrying_item_name: Option<String>,
    retry_attempt: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerSkippedEntry {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy)]
enum ScannerWorkKind {
    Set,
    Component,
}

#[derive(Debug, Clone)]
struct ScannerWorkUnit {
    item_id: Option<i64>,
    slug: String,
    display_name: String,
    stage_label: &'static str,
    current_set_name: Option<String>,
    current_component_name: Option<String>,
    completion_text: String,
    kind: ScannerWorkKind,
    attempt: usize,
}

struct ArbitrageScannerRunOutcome {
    response: ArbitrageScannerResponse,
    was_stopped: bool,
    skipped_entry_count: usize,
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

#[derive(Debug, Clone)]
struct SetRootCatalogRecord {
    item_id: i64,
    slug: String,
    name: String,
    image_path: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedSetComponentRecord {
    set_item_id: i64,
    set_slug: String,
    set_name: String,
    set_image_path: Option<String>,
    component_item_id: Option<i64>,
    component_slug: String,
    component_name: String,
    component_image_path: Option<String>,
    quantity_in_set: i64,
    sort_order: i64,
    fetched_at: String,
}

#[derive(Debug, Clone)]
struct RelicRootCatalogRecord {
    item_id: i64,
    slug: String,
    name: String,
    image_path: Option<String>,
    vaulted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScannerSetMapFile {
    #[serde(default)]
    warstonks_version: Option<String>,
    api_version: Option<String>,
    generated_at: String,
    sets: Vec<ScannerSetMapSetRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScannerSetMapSetRecord {
    slug: String,
    name: String,
    image_path: Option<String>,
    components: Vec<ScannerSetMapComponentRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScannerSetMapComponentRecord {
    slug: String,
    quantity_in_set: i64,
}

#[derive(Debug, Clone)]
struct ScannerPriceModel {
    entry_low: Option<f64>,
    entry_high: Option<f64>,
    recommended_entry_price: Option<f64>,
    exit_low: Option<f64>,
    exit_high: Option<f64>,
    recommended_exit_price: Option<f64>,
    current_stats_price: Option<f64>,
    liquidity_score: f64,
    sale_state: String,
    confidence_summary: MarketConfidenceSummary,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfstatRelicRewardApi {
    #[serde(default)]
    chance: Option<f64>,
    #[serde(default)]
    rarity: Option<String>,
    #[serde(default)]
    item: Option<WfstatRelicRewardItemApi>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfstatRelicRewardItemApi {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    warframe_market: Option<WfstatRelicRewardMarketApi>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfstatRelicRewardMarketApi {
    #[serde(default)]
    url_name: Option<String>,
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
    seller_mode: String,
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

fn resolve_scanner_set_map_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve the app data directory")?;
    Ok(app_data_dir.join("data").join(SCANNER_SET_MAP_FILE_NAME))
}

fn open_catalog_database(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = resolve_catalog_db_path(app)?;
    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("failed to open the local item catalog")
}

pub(crate) fn open_market_observatory_database(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = resolve_market_observatory_db_path(app)?;
    if let Some(parent_dir) = db_path.parent() {
        std::fs::create_dir_all(parent_dir).context("failed to create app data directory")?;
    }

    let connection = Connection::open(db_path).context("failed to open market observatory db")?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .context("failed to configure market observatory busy timeout")?;
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
          seller_mode TEXT NOT NULL DEFAULT 'ingame',
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
          seller_mode TEXT NOT NULL DEFAULT 'ingame',
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
          ON orderbook_snapshots (item_id, variant_key, seller_mode, captured_at DESC);

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

        CREATE TABLE IF NOT EXISTS set_component_cache (
          set_item_id INTEGER NOT NULL,
          set_slug TEXT NOT NULL,
          set_name TEXT NOT NULL,
          set_image_path TEXT,
          component_item_id INTEGER,
          component_slug TEXT NOT NULL,
          component_name TEXT NOT NULL,
          component_image_path TEXT,
          quantity_in_set INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (set_slug, component_slug)
        );

        CREATE TABLE IF NOT EXISTS owned_relic_inventory_cache (
          relic_tier TEXT NOT NULL,
          relic_code TEXT NOT NULL,
          intact_count INTEGER NOT NULL DEFAULT 0,
          exceptional_count INTEGER NOT NULL DEFAULT 0,
          flawless_count INTEGER NOT NULL DEFAULT 0,
          radiant_count INTEGER NOT NULL DEFAULT 0,
          total_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (relic_tier, relic_code)
        );

        CREATE TABLE IF NOT EXISTS owned_relic_inventory_meta (
          cache_key TEXT PRIMARY KEY,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_set_component_cache_set_slug
          ON set_component_cache (set_slug, sort_order ASC);

        CREATE TABLE IF NOT EXISTS owned_set_components (
          component_slug TEXT PRIMARY KEY,
          component_item_id INTEGER,
          component_name TEXT NOT NULL,
          component_image_path TEXT,
          quantity INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_owned_set_components_name
          ON owned_set_components (component_name COLLATE NOCASE ASC);

        CREATE TABLE IF NOT EXISTS owned_set_component_trade_sync (
          sync_key TEXT PRIMARY KEY,
          component_slug TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scanner_cache (
          scanner_key TEXT PRIMARY KEY,
          computed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scanner_progress (
          scanner_key TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          progress_value REAL NOT NULL,
          stage_label TEXT NOT NULL,
          status_text TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          last_completed_at TEXT,
          last_error TEXT,
          current_set_name TEXT,
          current_component_name TEXT,
          completed_set_count INTEGER NOT NULL DEFAULT 0,
          total_set_count INTEGER NOT NULL DEFAULT 0,
          completed_component_count INTEGER NOT NULL DEFAULT 0,
          total_component_count INTEGER NOT NULL DEFAULT 0,
          skipped_entry_count INTEGER NOT NULL DEFAULT 0,
          retrying_item_name TEXT,
          retry_attempt INTEGER,
          stop_requested INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS analytics_cache (
          item_id INTEGER NOT NULL,
          slug TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          seller_mode TEXT NOT NULL DEFAULT 'ingame',
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

    for (table_name, column_name, column_sql) in [
        (
            "tracked_items",
            "seller_mode",
            "ALTER TABLE tracked_items ADD COLUMN seller_mode TEXT NOT NULL DEFAULT 'ingame'",
        ),
        (
            "orderbook_snapshots",
            "seller_mode",
            "ALTER TABLE orderbook_snapshots ADD COLUMN seller_mode TEXT NOT NULL DEFAULT 'ingame'",
        ),
        (
            "analytics_cache",
            "seller_mode",
            "ALTER TABLE analytics_cache ADD COLUMN seller_mode TEXT NOT NULL DEFAULT 'ingame'",
        ),
        (
            "scanner_progress",
            "stop_requested",
            "ALTER TABLE scanner_progress ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "scanner_progress",
            "current_set_name",
            "ALTER TABLE scanner_progress ADD COLUMN current_set_name TEXT",
        ),
        (
            "scanner_progress",
            "current_component_name",
            "ALTER TABLE scanner_progress ADD COLUMN current_component_name TEXT",
        ),
        (
            "scanner_progress",
            "completed_set_count",
            "ALTER TABLE scanner_progress ADD COLUMN completed_set_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "scanner_progress",
            "total_set_count",
            "ALTER TABLE scanner_progress ADD COLUMN total_set_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "scanner_progress",
            "completed_component_count",
            "ALTER TABLE scanner_progress ADD COLUMN completed_component_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "scanner_progress",
            "total_component_count",
            "ALTER TABLE scanner_progress ADD COLUMN total_component_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "scanner_progress",
            "skipped_entry_count",
            "ALTER TABLE scanner_progress ADD COLUMN skipped_entry_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "scanner_progress",
            "retrying_item_name",
            "ALTER TABLE scanner_progress ADD COLUMN retrying_item_name TEXT",
        ),
        (
            "scanner_progress",
            "retry_attempt",
            "ALTER TABLE scanner_progress ADD COLUMN retry_attempt INTEGER",
        ),
    ] {
        let has_column = connection
            .query_row(
                &format!(
                    "SELECT 1 FROM pragma_table_info('{table_name}') WHERE name = '{column_name}' LIMIT 1"
                ),
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if !has_column {
            connection.execute(column_sql, [])?;
        }
    }

    Ok(())
}

fn shared_wfm_client() -> Result<Client> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    match CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("failed to build WFM client: {error}"))
    }) {
        Ok(client) => Ok(client.clone()),
        Err(error) => Err(anyhow!(error.clone())),
    }
}

fn parse_retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
}

fn execute_wfm_bytes_request<C>(
    builder: reqwest::blocking::RequestBuilder,
    priority: RequestPriority,
    action_label: &str,
    coalesce_key: Option<String>,
    request_timeout: Option<Duration>,
    mut is_cancelled: C,
) -> Result<WfmHttpResponse>
where
    C: FnMut() -> bool,
{
    let action_label_owned = action_label.to_string();
    execute_coalesced_wfm_request(
        priority,
        action_label,
        coalesce_key,
        request_timeout,
        || is_cancelled(),
        move || {
            let response = builder
                .send()
                .with_context(|| format!("failed to {}", action_label_owned))?;
            let status = response.status();
            let retry_after = parse_retry_after_seconds(response.headers());
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
                })
                .collect();
            let body = response
                .bytes()
                .with_context(|| format!("failed to read {} response body", action_label_owned))?
                .to_vec();
            Ok(WfmHttpResponse {
                status: status.as_u16(),
                body,
                retry_after,
                headers,
            })
        },
    )
}

fn extract_wfm_error_body(action_label: &str, response: &WfmHttpResponse) -> anyhow::Error {
    let body = String::from_utf8_lossy(&response.body);
    let trimmed = body.trim();
    anyhow!(if trimmed.is_empty() {
        format!("{action_label} failed with status {}", response.status)
    } else {
        format!(
            "{action_label} failed with status {}: {}",
            response.status, trimmed
        )
    })
}

fn normalize_variant_key(value: Option<&str>) -> String {
    let trimmed = value.unwrap_or("base").trim();
    if trimmed.is_empty() {
        "base".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_seller_mode(value: Option<&str>) -> String {
    match value.unwrap_or("ingame").trim() {
        "ingame-online" => "ingame-online".to_string(),
        _ => "ingame".to_string(),
    }
}

fn seller_mode_allows_status(status: Option<&str>, seller_mode: &str) -> bool {
    match seller_mode {
        "ingame-online" => matches!(status, Some("ingame" | "online")),
        _ => matches!(status, Some("ingame")),
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
            .filter(|row| row.mod_rank.unwrap_or(0) == rank)
            .collect(),
        None => rows
            .into_iter()
            .filter(|row| row.mod_rank.unwrap_or(0) == 0)
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

fn fetch_and_cache_statistics_impl<C>(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    priority: RequestPriority,
    request_timeout: Option<Duration>,
    mut is_cancelled: C,
) -> Result<()>
where
    C: FnMut() -> bool,
{
    let client = shared_wfm_client()?;
    let mut builder = client
        .get(format!("{WFM_API_BASE_URL_V1}/items/{slug}/statistics"))
        .header("User-Agent", WFM_USER_AGENT)
        .header("Language", WFM_LANGUAGE_HEADER)
        .header("Platform", WFM_PLATFORM_HEADER)
        .header("Crossplay", WFM_CROSSPLAY_HEADER);
    if let Some(timeout) = request_timeout {
        builder = builder.timeout(timeout);
    }
    let response = execute_wfm_bytes_request(
        builder,
        priority,
        "request WFM statistics",
        Some(scoped_wfm_coalesce_key("statistics", priority, slug)),
        request_timeout,
        || is_cancelled(),
    )?;
    if response.status < 200 || response.status >= 300 {
        return Err(extract_wfm_error_body(
            "WFM statistics request",
            &response,
        ));
    }
    let payload = serde_json::from_slice::<WfmStatisticsApiResponse>(&response.body)
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

fn fetch_and_cache_statistics(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    priority: RequestPriority,
) -> Result<()> {
    fetch_and_cache_statistics_impl(
        connection,
        item_id,
        slug,
        variant_key,
        priority,
        Some(Duration::from_secs(WFM_DEFAULT_REQUEST_TIMEOUT_SECONDS)),
        || false,
    )
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
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                ))
            },
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
        AnalyticsDomainKey::SevenDays
        | AnalyticsDomainKey::ThirtyDays
        | AnalyticsDomainKey::NinetyDays => {
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

fn latest_statistics_fetch_timestamp(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
) -> Result<Option<OffsetDateTime>> {
    let fetched_at = connection
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

    Ok(fetched_at.and_then(|value| parse_timestamp(&value)))
}

fn ensure_statistics_cached_for_scan<C>(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    mut is_cancelled: C,
) -> Result<bool>
where
    C: FnMut() -> bool,
{
    let needs_refresh = !statistics_cache_is_usable(
        connection,
        item_id,
        variant_key,
        AnalyticsDomainKey::ThirtyDays,
    )? || latest_statistics_fetch_timestamp(connection, item_id, variant_key)?
        .map(|value| (now_utc() - value) >= TimeDuration::hours(SCANNER_STATS_FRESHNESS_HOURS))
        .unwrap_or(true);

    if !needs_refresh {
        return Ok(false);
    }

    if let Err(error) = fetch_and_cache_statistics_impl(
        connection,
        item_id,
        slug,
        variant_key,
        RequestPriority::Low,
        Some(Duration::from_secs(SCANNER_WFM_STATS_TIMEOUT_SECONDS)),
        || is_cancelled(),
    ) {
        if statistics_cache_is_usable(
            connection,
            item_id,
            variant_key,
            AnalyticsDomainKey::ThirtyDays,
        )? {
            return Ok(false);
        }

        return Err(error);
    }
    Ok(true)
}

fn latest_live_sell_reference_price(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
) -> Result<Option<f64>> {
    connection
        .query_row(
            "SELECT
               min_price,
               median,
               avg_price,
               wa_price,
               closed_price,
               open_price
             FROM statistics_cache
             WHERE item_id = ?1
               AND variant_key = ?2
               AND domain_key = '48hours'
               AND source_kind = 'live_sell'
             ORDER BY bucket_at DESC
             LIMIT 1",
            params![item_id, variant_key],
            |row| {
                let min_price = row.get::<_, Option<f64>>(0)?;
                let median = row.get::<_, Option<f64>>(1)?;
                let avg_price = row.get::<_, Option<f64>>(2)?;
                let wa_price = row.get::<_, Option<f64>>(3)?;
                let closed_price = row.get::<_, Option<f64>>(4)?;
                let open_price = row.get::<_, Option<f64>>(5)?;
                Ok(min_price
                    .or(median)
                    .or(avg_price)
                    .or(wa_price)
                    .or(closed_price)
                    .or(open_price))
            },
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(Into::into)
}

fn score_stats_liquidity(rows: &[InternalStatsRow]) -> (f64, String) {
    if rows.is_empty() {
        return (20.0, "Thin".to_string());
    }

    let cutoff_48h = now_utc() - TimeDuration::hours(48);
    let cutoff_30d = now_utc() - TimeDuration::days(30);
    let recent_48h_volume = rows
        .iter()
        .filter(|row| row.bucket_at >= cutoff_48h)
        .map(|row| row.volume)
        .sum::<f64>();
    let active_rows_30d = rows
        .iter()
        .filter(|row| row.bucket_at >= cutoff_30d && row.volume > 0.0)
        .count();
    let point_rows = resample_rows(
        rows,
        &[],
        AnalyticsDomainKey::ThirtyDays,
        AnalyticsBucketSizeKey::TwentyFourHours,
    );
    let (stability_score, _, _) = compute_stability(&point_rows);

    let activity_score = if recent_48h_volume >= 120.0 {
        100.0
    } else if recent_48h_volume >= 60.0 {
        80.0
    } else if recent_48h_volume >= 24.0 {
        60.0
    } else if recent_48h_volume >= 10.0 {
        40.0
    } else {
        20.0
    };

    let cadence_score = if active_rows_30d >= 20 {
        100.0
    } else if active_rows_30d >= 12 {
        80.0
    } else if active_rows_30d >= 6 {
        60.0
    } else if active_rows_30d >= 3 {
        40.0
    } else {
        20.0
    };

    let liquidity_score =
        ((activity_score * 0.5) + (cadence_score * 0.3) + (stability_score * 0.2))
            .clamp(20.0, 100.0);
    let sale_state = if liquidity_score >= 80.0 {
        "Fast mover"
    } else if liquidity_score >= 60.0 {
        "Healthy"
    } else if liquidity_score >= 40.0 {
        "Moderate"
    } else {
        "Thin"
    }
    .to_string();

    (liquidity_score, sale_state)
}

fn build_statistics_price_model(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
) -> Result<Option<ScannerPriceModel>> {
    let (closed_rows, _, _) = load_chart_statistics_rows(
        connection,
        item_id,
        variant_key,
        AnalyticsDomainKey::ThirtyDays,
    )?;
    if closed_rows.is_empty() {
        return Ok(None);
    }

    let anchors = build_historical_zone_anchors(&closed_rows);
    let zone_bands = anchors.as_ref().and_then(|entry| {
        compute_zone_bands(
            entry.support_floor.or(entry.fair_low),
            entry.fair_high,
            entry.support_recurrence,
            entry.fair_center,
        )
    });
    let chart_points = resample_rows(
        &closed_rows,
        &[],
        AnalyticsDomainKey::ThirtyDays,
        AnalyticsBucketSizeKey::TwentyFourHours,
    );
    let confidence_summary = if let Some(anchor_values) = anchors.as_ref() {
        build_zone_confidence(
            &chart_points,
            anchor_values.fair_low,
            anchor_values.fair_high,
        )
    } else {
        build_confidence_summary("low", vec!["Thin history".to_string()])
    };
    let current_stats_price =
        latest_live_sell_reference_price(connection, item_id, variant_key)?.map(round_platinum);
    let (liquidity_score, sale_state) = score_stats_liquidity(&closed_rows);

    Ok(Some(ScannerPriceModel {
        entry_low: zone_bands
            .as_ref()
            .map(|entry| round_platinum(entry.entry_low)),
        entry_high: zone_bands
            .as_ref()
            .map(|entry| round_platinum(entry.entry_high)),
        recommended_entry_price: recommended_entry_price_from_zone(zone_bands.as_ref()),
        exit_low: zone_bands
            .as_ref()
            .map(|entry| round_platinum(entry.exit_low)),
        exit_high: zone_bands
            .as_ref()
            .map(|entry| round_platinum(entry.exit_high)),
        recommended_exit_price: historical_recommended_exit_price(
            recommended_entry_price_from_zone(zone_bands.as_ref()),
            &closed_rows,
            zone_bands.as_ref(),
            None,
        ),
        current_stats_price,
        liquidity_score,
        sale_state,
        confidence_summary,
    }))
}

fn load_snapshot_chart_points(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    seller_mode: &str,
    domain_key: AnalyticsDomainKey,
    bucket_size_key: AnalyticsBucketSizeKey,
) -> Result<Vec<AnalyticsChartPoint>> {
    let cutoff = format_timestamp(now_utc() - domain_key.lookback())?;
    let mut statement = connection.prepare(
        "SELECT captured_at, lowest_sell, median_sell, highest_buy
         FROM orderbook_snapshots
         WHERE item_id = ?1
           AND variant_key = ?2
           AND seller_mode = ?3
           AND captured_at >= ?4
         ORDER BY captured_at ASC",
    )?;

    let rows = statement.query_map(params![item_id, variant_key, seller_mode, cutoff], |row| {
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
    let latest_snapshot_point = snapshot_points.last().cloned();
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

    if let Some(latest_snapshot_point) = latest_snapshot_point {
        if let Some(entry) = point_by_bucket.get_mut(&latest_snapshot_point.bucket_at) {
            entry.lowest_sell = latest_snapshot_point.lowest_sell.or(entry.lowest_sell);
            entry.highest_buy = latest_snapshot_point.highest_buy.or(entry.highest_buy);
        }
    }

    point_by_bucket.into_values().collect()
}

fn filter_supported_order(order: &WfmOrderRecord, variant_key: &str, seller_mode: &str) -> bool {
    if order.visible != Some(true) {
        return false;
    }

    if !seller_mode_allows_status(order.user.status.as_deref(), seller_mode) {
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

fn build_market_snapshot(
    captured_at: &str,
    sell_orders: &[WfmDetailedOrder],
    buy_orders: &[WfmDetailedOrder],
) -> MarketSnapshot {
    let mut sorted_sell_prices = sell_orders
        .iter()
        .map(|entry| entry.platinum)
        .collect::<Vec<_>>();
    sorted_sell_prices.sort_by(|left, right| left.total_cmp(right));
    let mut sorted_buy_prices = buy_orders
        .iter()
        .map(|entry| entry.platinum)
        .collect::<Vec<_>>();
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
        .map(|order| {
            order
                .user_slug
                .clone()
                .unwrap_or_else(|| order.username.to_lowercase())
        })
        .collect::<HashSet<_>>()
        .len() as i64;
    let unique_buy_users = buy_orders
        .iter()
        .map(|order| {
            order
                .user_slug
                .clone()
                .unwrap_or_else(|| order.username.to_lowercase())
        })
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

fn fetch_filtered_orders_with_cancel<C>(
    slug: &str,
    variant_key: &str,
    seller_mode: &str,
    priority: RequestPriority,
    request_label: &str,
    mut is_cancelled: C,
) -> Result<(
    Option<String>,
    Vec<WfmDetailedOrder>,
    Vec<WfmDetailedOrder>,
    MarketSnapshot,
)>
where
    C: FnMut() -> bool,
{
    let client = shared_wfm_client()?;
    let response = execute_wfm_bytes_request(
        client
            .get(format!("{WFM_API_BASE_URL_V2}/orders/item/{slug}"))
            .header("User-Agent", WFM_USER_AGENT)
            .header("Language", WFM_LANGUAGE_HEADER)
            .header("Platform", WFM_PLATFORM_HEADER)
            .header("Crossplay", WFM_CROSSPLAY_HEADER),
        priority,
        request_label,
        Some(scoped_wfm_coalesce_key("orders", priority, slug)),
        None,
        || is_cancelled(),
    )?;
    if response.status < 200 || response.status >= 300 {
        return Err(extract_wfm_error_body("WFM orders request", &response));
    }
    let payload = serde_json::from_slice::<WfmOrdersApiResponse>(&response.body)
        .context("failed to parse WFM orders response")?;

    let mut sell_orders = Vec::new();
    let mut buy_orders = Vec::new();

    for order in payload.data {
        if !filter_supported_order(&order, variant_key, seller_mode) {
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
        left.platinum.total_cmp(&right.platinum).then_with(|| {
            left.username
                .to_lowercase()
                .cmp(&right.username.to_lowercase())
        })
    });
    buy_orders.sort_by(|left, right| {
        right.platinum.total_cmp(&left.platinum).then_with(|| {
            left.username
                .to_lowercase()
                .cmp(&right.username.to_lowercase())
        })
    });

    let captured_at = format_timestamp(now_utc())?;
    let snapshot = build_market_snapshot(&captured_at, &sell_orders, &buy_orders);
    Ok((payload.api_version, sell_orders, buy_orders, snapshot))
}

fn fetch_filtered_orders(
    slug: &str,
    variant_key: &str,
    seller_mode: &str,
    priority: RequestPriority,
) -> Result<(
    Option<String>,
    Vec<WfmDetailedOrder>,
    Vec<WfmDetailedOrder>,
    MarketSnapshot,
)> {
    fetch_filtered_orders_with_cancel(
        slug,
        variant_key,
        seller_mode,
        priority,
        "request WFM orders",
        || false,
    )
}

fn fetch_filtered_orders_labeled(
    slug: &str,
    variant_key: &str,
    seller_mode: &str,
    priority: RequestPriority,
    request_label: &str,
) -> Result<(
    Option<String>,
    Vec<WfmDetailedOrder>,
    Vec<WfmDetailedOrder>,
    MarketSnapshot,
)> {
    fetch_filtered_orders_with_cancel(
        slug,
        variant_key,
        seller_mode,
        priority,
        request_label,
        || false,
    )
}

fn persist_snapshot(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    seller_mode: &str,
    snapshot: &MarketSnapshot,
) -> Result<()> {
    connection.execute(
        "INSERT INTO orderbook_snapshots (
           item_id,
           slug,
           variant_key,
           seller_mode,
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
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            item_id,
            slug,
            variant_key,
            seller_mode,
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
    seller_mode: &str,
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
           seller_mode,
           variant_label,
           tracking_sources,
           first_tracked_at,
           last_tracked_at,
           last_snapshot_at,
           next_snapshot_at,
           is_active
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10)
         ON CONFLICT(item_id, slug, variant_key) DO UPDATE SET
           seller_mode = excluded.seller_mode,
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
            seller_mode,
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

fn get_tracking_seller_mode(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
) -> Result<String> {
    Ok(connection
        .query_row(
            "SELECT seller_mode
             FROM tracked_items
             WHERE item_id = ?1
               AND slug = ?2
               AND variant_key = ?3",
            params![item_id, slug, variant_key],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| "ingame".to_string()))
}

fn capture_tracking_snapshot_with_priority(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    seller_mode: &str,
    priority: RequestPriority,
) -> Result<MarketSnapshot> {
    let (_, sell_orders, buy_orders, snapshot) = fetch_filtered_orders(
        slug,
        variant_key,
        seller_mode,
        priority,
    )?;
    persist_snapshot(
        connection,
        item_id,
        slug,
        variant_key,
        seller_mode,
        &snapshot,
    )?;
    prune_old_rows(connection)?;
    update_tracking_row(
        connection,
        item_id,
        slug,
        variant_key,
        seller_mode,
        &derive_variant_label(variant_key),
        &get_existing_sources(connection, item_id, slug, variant_key)?,
        false,
        Some(snapshot.captured_at.as_str()),
    )?;
    let _ = (sell_orders, buy_orders);
    Ok(snapshot)
}

fn capture_tracking_snapshot(
    connection: &Connection,
    item_id: i64,
    slug: &str,
    variant_key: &str,
    seller_mode: &str,
) -> Result<MarketSnapshot> {
    capture_tracking_snapshot_with_priority(
        connection,
        item_id,
        slug,
        variant_key,
        seller_mode,
        RequestPriority::Medium,
    )
}

fn resolve_variants_from_catalog(
    app: &tauri::AppHandle,
    item_id: i64,
    slug: &str,
) -> Result<Vec<MarketVariant>> {
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
    seller_mode: &str,
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
               AND seller_mode = ?3
             ORDER BY captured_at DESC
             LIMIT 1",
            params![item_id, variant_key, seller_mode],
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
    seller_mode: &str,
) -> Result<MarketSnapshot> {
    if let Some(snapshot) = latest_snapshot_for_item(connection, item_id, variant_key, seller_mode)?
    {
        if let Some(captured_at) = parse_timestamp(&snapshot.captured_at) {
            if now_utc() - captured_at < TimeDuration::minutes(TRACKING_SNAPSHOT_INTERVAL_MINUTES) {
                return Ok(snapshot);
            }
        }
    }

    capture_tracking_snapshot_with_priority(
        connection,
        item_id,
        slug,
        variant_key,
        seller_mode,
        RequestPriority::Instant,
    )
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

#[derive(Debug, Clone)]
struct ZoneBands {
    entry_low: f64,
    entry_high: f64,
    exit_low: f64,
    exit_high: f64,
    entry_target: f64,
    exit_target: f64,
}

struct HistoricalZoneAnchors {
    support_floor: Option<f64>,
    support_recurrence: Option<f64>,
    fair_low: Option<f64>,
    fair_high: Option<f64>,
    fair_center: Option<f64>,
}

struct HistoricalExitProfile {
    fair_high_anchor: Option<f64>,
    recent_fair_anchor: Option<f64>,
    recent_mid_anchor: Option<f64>,
    drift_pct: Option<f64>,
    relative_volume: Option<f64>,
}

fn round_platinum(value: f64) -> f64 {
    value.round()
}

fn percentile_price(sorted_values: &[f64], percentile: f64) -> Option<f64> {
    if sorted_values.is_empty() {
        return None;
    }

    let clamped = percentile.clamp(0.0, 1.0);
    let max_index = sorted_values.len().saturating_sub(1) as f64;
    let index = max_index * clamped;
    let lower_index = index.floor() as usize;
    let upper_index = index.ceil() as usize;
    if lower_index == upper_index {
        return sorted_values.get(lower_index).copied();
    }

    let lower_value = *sorted_values.get(lower_index)?;
    let upper_value = *sorted_values.get(upper_index)?;
    let weight = index - lower_index as f64;
    Some(lower_value + ((upper_value - lower_value) * weight))
}

fn build_historical_zone_anchors(rows: &[InternalStatsRow]) -> Option<HistoricalZoneAnchors> {
    if rows.is_empty() {
        return None;
    }

    let cutoff = now_utc() - TimeDuration::days(30);
    let recent_rows = rows
        .iter()
        .filter(|row| row.bucket_at >= cutoff)
        .collect::<Vec<_>>();
    let source_rows = if recent_rows.is_empty() {
        rows.iter().collect::<Vec<_>>()
    } else {
        recent_rows
    };

    let mut dip_prices = Vec::new();
    let mut fair_values = Vec::new();
    let mut ceiling_values = Vec::new();

    for row in source_rows {
        if let Some(value) = row.min_price.or(row.donch_bot) {
            dip_prices.push(value);
        }
        if let Some(value) = row
            .median
            .or(row.wa_price)
            .or(row.avg_price)
            .or(row.moving_avg)
        {
            fair_values.push(value);
        }
        if let Some(value) = row
            .max_price
            .or(row.donch_top)
            .or(row.median)
            .or(row.wa_price)
        {
            ceiling_values.push(value);
        }
    }

    dip_prices.sort_by(|left, right| left.total_cmp(right));
    fair_values.sort_by(|left, right| left.total_cmp(right));
    ceiling_values.sort_by(|left, right| left.total_cmp(right));

    Some(HistoricalZoneAnchors {
        support_floor: percentile_price(&dip_prices, 0.18).or_else(|| dip_prices.first().copied()),
        support_recurrence: percentile_price(&dip_prices, 0.38)
            .or_else(|| percentile_price(&dip_prices, 0.5))
            .or_else(|| dip_prices.first().copied()),
        fair_low: percentile_price(&fair_values, 0.35).or_else(|| fair_values.first().copied()),
        fair_high: percentile_price(&ceiling_values, 0.82)
            .or_else(|| ceiling_values.last().copied()),
        fair_center: percentile_price(&fair_values, 0.55)
            .or_else(|| percentile_price(&fair_values, 0.5))
            .or_else(|| fair_values.first().copied()),
    })
}

fn compute_zone_bands(
    lower_anchor: Option<f64>,
    upper_anchor: Option<f64>,
    support_recurrence: Option<f64>,
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
    let max_entry_high = (upper_bound - 3.0).max(lower_bound + 2.0);
    let support_high = support_recurrence
        .map(round_platinum)
        .unwrap_or_else(|| round_platinum(lower_bound + zone_width));
    let mut entry_high = support_high.clamp(lower_bound + 2.0, max_entry_high);
    let mut entry_low = (entry_high - zone_width).max(lower_bound);
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
    exit_low = round_platinum(
        exit_low
            .max(entry_high + 1.0)
            .clamp(lower_bound, upper_bound),
    );
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

fn recommended_entry_price_from_zone(zone_bands: Option<&ZoneBands>) -> Option<f64> {
    zone_bands.map(|entry| round_platinum(entry.entry_target))
}

fn resolved_recommended_entry_price(
    recommended_entry_price: Option<f64>,
    current_floor_price: Option<f64>,
) -> Option<f64> {
    match (recommended_entry_price, current_floor_price) {
        (Some(recommended), Some(current)) if current <= recommended => Some(current),
        (Some(recommended), _) => Some(recommended),
        (None, current) => current,
    }
}

fn average_recent_prices(values: &[f64], take: usize) -> Option<f64> {
    if values.is_empty() {
        return None;
    }

    let slice_len = values.len().min(take);
    let slice = &values[values.len() - slice_len..];
    Some(slice.iter().sum::<f64>() / slice.len() as f64)
}

fn interquartile_bounds(sorted_values: &[f64]) -> Option<(f64, f64)> {
    if sorted_values.len() < 4 {
        return None;
    }

    let q1 = percentile_price(sorted_values, 0.25)?;
    let q3 = percentile_price(sorted_values, 0.75)?;
    let iqr = q3 - q1;
    Some((q1 - (iqr * 1.5), q3 + (iqr * 1.5)))
}

fn filtered_price_series(values: &[f64]) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }

    let mut sorted_values = values.to_vec();
    sorted_values.sort_by(|left, right| left.total_cmp(right));
    let Some((lower_bound, upper_bound)) = interquartile_bounds(&sorted_values) else {
        return sorted_values;
    };

    let filtered = sorted_values
        .into_iter()
        .filter(|value| *value >= lower_bound && *value <= upper_bound)
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        values.to_vec()
    } else {
        filtered
    }
}

fn weighted_average_pairs(pairs: &[(Option<f64>, f64)]) -> Option<f64> {
    let mut weighted_sum = 0.0;
    let mut total_weight = 0.0;
    for (value, weight) in pairs {
        if let Some(price) = value {
            weighted_sum += price * *weight;
            total_weight += *weight;
        }
    }

    if total_weight > 0.0 {
        Some(weighted_sum / total_weight)
    } else {
        None
    }
}

fn build_historical_exit_profile(rows: &[InternalStatsRow]) -> HistoricalExitProfile {
    let cutoff = now_utc() - TimeDuration::days(14);
    let recent_rows = rows
        .iter()
        .filter(|row| row.bucket_at >= cutoff)
        .collect::<Vec<_>>();
    let source_rows = if recent_rows.is_empty() {
        rows.iter().collect::<Vec<_>>()
    } else {
        recent_rows
    };

    let fair_series = source_rows
        .iter()
        .filter_map(|row| row.median.or(row.wa_price).or(row.avg_price).or(row.moving_avg))
        .collect::<Vec<_>>();
    let filtered_fair_series = filtered_price_series(&fair_series);
    let recent_fair_series = source_rows
        .iter()
        .filter_map(|row| row.median.or(row.wa_price).or(row.avg_price).or(row.moving_avg))
        .collect::<Vec<_>>();

    let fair_high_anchor = percentile_price(&filtered_fair_series, 0.68)
        .or_else(|| percentile_price(&filtered_fair_series, 0.62))
        .or_else(|| filtered_fair_series.last().copied());
    let recent_fair_anchor =
        average_recent_prices(&recent_fair_series, 3).or_else(|| average_recent_prices(&filtered_fair_series, 3));
    let recent_mid_anchor =
        average_recent_prices(&recent_fair_series, 7).or_else(|| average_recent_prices(&filtered_fair_series, 6));

    let drift_pct = if recent_fair_series.len() >= 6 {
        let midpoint = recent_fair_series.len() / 2;
        let previous_avg = recent_fair_series[..midpoint].iter().sum::<f64>() / midpoint as f64;
        let recent_avg =
            recent_fair_series[midpoint..].iter().sum::<f64>() / (recent_fair_series.len() - midpoint) as f64;
        if previous_avg > 0.0 {
            Some(((recent_avg - previous_avg) / previous_avg) * 100.0)
        } else {
            None
        }
    } else {
        let previous_avg = average_recent_prices(&recent_fair_series[..recent_fair_series.len().saturating_sub(3)], 3);
        let recent_avg = average_recent_prices(&recent_fair_series, 3);
        match (previous_avg, recent_avg) {
            (Some(previous), Some(recent)) if previous > 0.0 => {
                Some(((recent - previous) / previous) * 100.0)
            }
            _ => None,
        }
    };

    let recent_volume_cutoff = now_utc() - TimeDuration::days(7);
    let recent_volume = rows
        .iter()
        .filter(|row| row.bucket_at >= recent_volume_cutoff)
        .map(|row| row.volume)
        .sum::<f64>();
    let baseline_volume = rows.iter().map(|row| row.volume).sum::<f64>() / rows.len().max(1) as f64;
    let relative_volume = if baseline_volume > 0.0 {
        Some((recent_volume / 7.0) / baseline_volume)
    } else {
        None
    };

    HistoricalExitProfile {
        fair_high_anchor,
        recent_fair_anchor,
        recent_mid_anchor,
        drift_pct,
        relative_volume,
    }
}

fn historical_recommended_exit_price(
    entry_price: Option<f64>,
    rows: &[InternalStatsRow],
    zone_bands: Option<&ZoneBands>,
    zone_overview: Option<&EntryExitZoneOverview>,
) -> Option<f64> {
    if rows.is_empty() {
        return zone_bands
            .map(|entry| round_platinum(entry.exit_target))
            .or_else(|| zone_overview.and_then(|entry| entry.exit_zone_low));
    }

    let profile = build_historical_exit_profile(rows);
    let zone_low = zone_bands
        .map(|entry| entry.exit_low)
        .or_else(|| zone_overview.and_then(|entry| entry.exit_zone_low));
    let zone_high = zone_bands
        .map(|entry| entry.exit_high)
        .or_else(|| zone_overview.and_then(|entry| entry.exit_zone_high));
    let zone_target = zone_bands
        .map(|entry| entry.exit_target)
        .or_else(|| {
            zone_overview.and_then(|entry| {
                entry.exit_zone_low.zip(entry.exit_zone_high).map(|(low, high)| (low + high) * 0.5)
            })
        });

    let mut target = weighted_average_pairs(&[
        (profile.recent_fair_anchor, 0.38),
        (profile.recent_mid_anchor, 0.27),
        (profile.fair_high_anchor, 0.20),
        (zone_target, 0.15),
    ])
    .or(profile.recent_fair_anchor)
    .or(profile.recent_mid_anchor)
    .or(profile.fair_high_anchor)
    .or(zone_target)
    .or(entry_price)?;

    if let Some(relative_volume) = profile.relative_volume {
        if relative_volume < 0.65 {
            target -= 3.0;
        } else if relative_volume < 0.9 {
            target -= 1.5;
        }
    }

    if let Some(drift_pct) = profile.drift_pct {
        if drift_pct <= -8.0 {
            target -= 3.0;
        } else if drift_pct <= -4.0 {
            target -= 1.5;
        }
    }

    if let Some(fair_high_anchor) = profile.fair_high_anchor {
        target = target.min(fair_high_anchor + 2.0);
    }

    if let Some(zone_high) = zone_high {
        target = target.min(zone_high);
    }
    if let Some(zone_low) = zone_low {
        target = target.max(zone_low);
    }

    let target = round_platinum(target);
    match entry_price {
        Some(entry) => Some(target.max(round_platinum(entry + 1.0))),
        None => Some(target),
    }
}

fn choose_live_exit_percentile(snapshot: &MarketSnapshot, liquidity_score: f64) -> f64 {
    let mut percentile: f64 = if snapshot.sell_order_count < 12 {
        38.0
    } else if snapshot.sell_order_count < 25 {
        44.0
    } else {
        49.0
    };

    match pressure_label(snapshot.pressure_ratio) {
        label if label == "Exit Pressure" => percentile -= 11.0,
        label if label == "Balanced" => percentile -= 6.0,
        _ => {}
    }

    if liquidity_score >= 78.0 && snapshot.near_floor_seller_count <= 3 && snapshot.sell_order_count >= 18 {
        percentile += 4.0;
    } else if liquidity_score < 45.0 {
        percentile -= 3.0;
    }

    if snapshot.buy_quantity >= snapshot.sell_quantity && snapshot.buy_order_count >= snapshot.sell_order_count {
        percentile += 3.0;
    } else if snapshot.buy_quantity * 2 < snapshot.sell_quantity {
        percentile -= 4.0;
    }

    percentile.clamp(25.0, 58.0)
}

fn last_defined_value(
    rows: &[InternalStatsRow],
    selector: impl Fn(&InternalStatsRow) -> Option<f64>,
) -> Option<f64> {
    rows.iter().rev().find_map(selector)
}

fn floor_timestamp(
    timestamp: OffsetDateTime,
    bucket_size_key: AnalyticsBucketSizeKey,
) -> OffsetDateTime {
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
            let bucket_at =
                OffsetDateTime::from_unix_timestamp(bucket_start).unwrap_or_else(|_| now_utc());
            let volume = bucket_rows.iter().map(|row| row.volume).sum::<f64>();

            let fair_inputs = bucket_rows.last().cloned();
            let fair_low = fair_inputs.as_ref().and_then(|row| {
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
            let fair_high = fair_inputs.as_ref().and_then(|row| {
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
            let historical_anchors = build_historical_zone_anchors(&bucket_rows);
            let zone_bands = historical_anchors
                .as_ref()
                .and_then(|anchors| {
                    compute_zone_bands(
                        anchors.support_floor.or(fair_low),
                        anchors.fair_high.or(fair_high),
                        anchors.support_recurrence,
                        anchors.fair_center.or(fair_center),
                    )
                })
                .or_else(|| compute_zone_bands(fair_low, fair_high, fair_low, fair_center));

            AnalyticsChartPoint {
                bucket_at: format_timestamp(bucket_at).unwrap_or_default(),
                open_price: bucket_rows.first().and_then(row_open_anchor),
                closed_price: bucket_rows.last().and_then(row_close_anchor),
                low_price: bucket_rows
                    .iter()
                    .filter_map(row_low_anchor)
                    .reduce(f64::min),
                high_price: bucket_rows
                    .iter()
                    .filter_map(row_high_anchor)
                    .reduce(f64::max),
                lowest_sell: bucket_rows
                    .iter()
                    .filter_map(row_low_anchor)
                    .reduce(f64::min),
                median_sell: aggregate_weighted(
                    bucket_rows
                        .iter()
                        .map(|row| (row_median_anchor(row), row.volume)),
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
        .find(|point| {
            parse_timestamp(&point.bucket_at)
                .map(|value| value <= cutoff)
                .unwrap_or(false)
        })
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
    let fair_midpoint =
        latest.and_then(
            |point| match (point.fair_value_low, point.fair_value_high) {
                (Some(low), Some(high)) => Some((low + high) / 2.0),
                _ => None,
            },
        );

    let cross_signal = match (current_value, fair_midpoint) {
        (Some(current), Some(fair)) if current < fair => "Below fair value".to_string(),
        (Some(current), Some(fair)) if current > fair => "Above fair value".to_string(),
        _ => "Near fair value".to_string(),
    };

    let reversal = match (slope_1h, slope_3h) {
        (Some(short), Some(medium)) if short > 0.0 && medium < 0.0 => {
            "Bullish reversal".to_string()
        }
        (Some(short), Some(medium)) if short < 0.0 && medium > 0.0 => {
            "Bearish reversal".to_string()
        }
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
    points: &[AnalyticsChartPoint],
    zone_bands: Option<&ZoneBands>,
) -> EntryExitZoneOverview {
    let latest_point = points.last();
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
    let computed_zone_bands = zone_bands.cloned().or_else(|| {
        compute_zone_bands(fair_value_low, fair_value_high, fair_value_low, fair_center)
    });
    let entry_zone_low = computed_zone_bands.as_ref().map(|zone| zone.entry_low);
    let entry_zone_high = computed_zone_bands.as_ref().map(|zone| zone.entry_high);
    let exit_zone_low = computed_zone_bands.as_ref().map(|zone| zone.exit_low);
    let exit_zone_high = computed_zone_bands.as_ref().map(|zone| zone.exit_high);

    let current_lowest_price = snapshot.and_then(|entry| entry.lowest_sell);
    let current_median_lowest_price = latest_point
        .and_then(|point| point.median_sell)
        .or_else(|| snapshot.and_then(|entry| entry.median_sell));
    let base_zone_quality = match (
        current_lowest_price,
        entry_zone_low,
        entry_zone_high,
        exit_zone_low,
    ) {
        (Some(current), Some(low), Some(high), _) if current >= low && current <= high => {
            "Excellent".to_string()
        }
        (Some(current), Some(_low), Some(high), _) if current <= high + 2.0 => "Good".to_string(),
        (Some(current), _, _, Some(exit_low)) if current >= exit_low => "Extended".to_string(),
        (Some(_), Some(_), Some(_), _) => "Watch".to_string(),
        _ => "Thin data".to_string(),
    };
    let confidence_summary = build_zone_confidence(points, fair_value_low, fair_value_high);
    let zone_quality = clamp_zone_quality(&base_zone_quality, &confidence_summary);
    let mut entry_rationale = match (current_lowest_price, entry_zone_low, entry_zone_high) {
        (Some(current), Some(low), Some(high)) if current >= low && current <= high => {
            "Current floor is inside the calculated entry band, which supports buying into the market without chasing extremes.".to_string()
        }
        (Some(current), Some(_low), Some(high)) if current < high => {
            "Current floor is approaching the calculated entry band and is close to a favorable reversion level.".to_string()
        }
        _ => "Current floor is still above the calculated entry band, so patience is likely better than forcing an entry.".to_string(),
    };
    let mut exit_rationale = match (current_median_lowest_price, exit_zone_low, exit_zone_high) {
        (Some(current), Some(low), Some(high)) if current >= low && current <= high => {
            "Recent median market price is inside the calculated exit band, which supports taking profit into strength.".to_string()
        }
        (Some(current), Some(low), Some(_high)) if current >= low - 2.0 => {
            "Recent median market price is approaching the calculated exit band, which supports preparing exits rather than chasing more upside.".to_string()
        }
        _ => "Recent median market price is still below the calculated exit band, so there is more room before a preferred take-profit area.".to_string(),
    };
    if confidence_summary.level != "high" {
        entry_rationale.push_str(&confidence_suffix(&confidence_summary));
        exit_rationale.push_str(&confidence_suffix(&confidence_summary));
    }

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
        confidence_summary,
    }
}

fn build_orderbook_pressure(snapshot: Option<&MarketSnapshot>) -> OrderbookPressureSummary {
    let confidence_summary = build_pressure_confidence(snapshot);
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
            confidence_summary,
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
            confidence_summary,
        },
    }
}

fn build_action_card(
    zone_overview: &EntryExitZoneOverview,
    orderbook_pressure: &OrderbookPressureSummary,
    trend_breakdown: &TrendQualityBreakdown,
    liquidity_confidence: &MarketConfidenceSummary,
    manipulation_confidence: &MarketConfidenceSummary,
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

    let base_action = if zone_overview.zone_quality == "Excellent"
        && orderbook_pressure.pressure_label != "Exit Pressure"
    {
        "Buy"
    } else if zone_overview.zone_quality == "Good"
        && orderbook_pressure.spread_pct.unwrap_or(100.0) <= 15.0
    {
        "Hold"
    } else if orderbook_pressure.pressure_label == "Exit Pressure" {
        "Caution"
    } else {
        "Wait"
    };
    let confidence_summary = combined_confidence(
        &[
            &zone_overview.confidence_summary,
            &orderbook_pressure.confidence_summary,
            &trend_breakdown.confidence_summary,
            liquidity_confidence,
            manipulation_confidence,
        ],
        &[],
    );
    let action = match (base_action, confidence_summary.level.as_str()) {
        ("Buy", "low") => "Wait",
        ("Buy", "medium") => "Hold",
        ("Hold", "low") => "Wait",
        (value, _) => value,
    };

    let tone = match action {
        "Buy" => "green",
        "Hold" => "blue",
        "Caution" => "red",
        _ => "amber",
    }
    .to_string();
    let zone_adjusted_edge = match (
        zone_overview.exit_zone_low,
        snapshot.and_then(|entry| entry.lowest_sell),
    ) {
        (Some(exit), Some(entry)) => Some(exit - entry),
        _ => None,
    };
    let mut rationale = match action {
        "Buy" => "Current floor is inside a favorable entry zone and the live book is not leaning against the trade.".to_string(),
        "Hold" => "History and live depth are broadly supportive, but the edge is narrower than a clean entry setup.".to_string(),
        "Caution" => "Live book pressure is leaning toward exits or the spread is too hostile for a clean entry.".to_string(),
        _ => "The item needs either a deeper discount, stronger buy support, or a cleaner spread before acting.".to_string(),
    };
    if confidence_summary.level != "high" {
        rationale.push_str(&confidence_suffix(&confidence_summary));
    }

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
        confidence_summary,
    }
}

fn bool_from_i64(value: Option<i64>) -> Option<bool> {
    value.map(|entry| entry != 0)
}

fn round_price_option(value: Option<f64>) -> Option<f64> {
    value.map(round_platinum)
}

fn build_confidence_summary(level: &str, mut reasons: Vec<String>) -> MarketConfidenceSummary {
    let normalized_level = match level {
        "high" | "medium" | "low" => level,
        _ => "medium",
    };
    reasons.retain(|reason| !reason.trim().is_empty());
    reasons.truncate(3);

    MarketConfidenceSummary {
        level: normalized_level.to_string(),
        label: match normalized_level {
            "high" => "High confidence".to_string(),
            "medium" => "Medium confidence".to_string(),
            _ => "Low confidence".to_string(),
        },
        is_degraded: normalized_level != "high" || !reasons.is_empty(),
        reasons,
    }
}

fn confidence_rank(confidence: &MarketConfidenceSummary) -> i32 {
    match confidence.level.as_str() {
        "high" => 2,
        "medium" => 1,
        _ => 0,
    }
}

fn combined_confidence(
    confidences: &[&MarketConfidenceSummary],
    extra_reasons: &[&str],
) -> MarketConfidenceSummary {
    let lowest_rank = confidences
        .iter()
        .map(|confidence| confidence_rank(confidence))
        .min()
        .unwrap_or(1);
    let level = match lowest_rank {
        2 => "high",
        1 => "medium",
        _ => "low",
    };

    let mut seen = HashSet::new();
    let mut reasons = Vec::new();
    for confidence in confidences {
        for reason in &confidence.reasons {
            if seen.insert(reason.clone()) {
                reasons.push(reason.clone());
            }
        }
    }
    for reason in extra_reasons {
        if seen.insert((*reason).to_string()) {
            reasons.push((*reason).to_string());
        }
    }

    build_confidence_summary(level, reasons)
}

fn confidence_suffix(confidence: &MarketConfidenceSummary) -> String {
    if confidence.reasons.is_empty() {
        String::new()
    } else {
        format!(
            " Confidence is reduced because {}.",
            confidence.reasons.join(", ").to_lowercase()
        )
    }
}

fn latest_point_age_hours(points: &[AnalyticsChartPoint]) -> Option<i64> {
    let latest_bucket = points.last()?;
    let timestamp = parse_timestamp(&latest_bucket.bucket_at)?;
    Some((now_utc() - timestamp).whole_hours())
}

fn build_zone_confidence(
    points: &[AnalyticsChartPoint],
    fair_value_low: Option<f64>,
    fair_value_high: Option<f64>,
) -> MarketConfidenceSummary {
    let usable_anchor_points = points
        .iter()
        .filter(|point| {
            point.lowest_sell.is_some()
                || point.median_sell.is_some()
                || point.weighted_avg.is_some()
                || (point.fair_value_low.is_some() && point.fair_value_high.is_some())
        })
        .count();
    let age_hours = latest_point_age_hours(points);
    let band_width = match (fair_value_low, fair_value_high) {
        (Some(low), Some(high)) => Some((high - low).abs()),
        _ => None,
    };

    let mut reasons = Vec::new();
    let mut level = "high";

    if usable_anchor_points < 6 {
        reasons.push("Thin history".to_string());
        level = "low";
    } else if usable_anchor_points < 12 {
        reasons.push("Sparse anchors".to_string());
        level = "medium";
    }

    if age_hours.unwrap_or(999) > 72 {
        reasons.push("Stale stats".to_string());
        level = "low";
    } else if age_hours.unwrap_or(999) > 24 && level == "high" {
        reasons.push("Aging stats".to_string());
        level = "medium";
    }

    if band_width.unwrap_or_default() < 4.0 && level == "high" {
        reasons.push("Compressed range".to_string());
        level = "medium";
    }

    build_confidence_summary(level, reasons)
}

fn clamp_zone_quality(base_quality: &str, confidence: &MarketConfidenceSummary) -> String {
    match (base_quality, confidence.level.as_str()) {
        ("Excellent", "high") => "Excellent".to_string(),
        ("Excellent", "medium") => "Good".to_string(),
        ("Excellent", _) => "Watch".to_string(),
        ("Good", "low") => "Watch".to_string(),
        (quality, _) => quality.to_string(),
    }
}

fn build_pressure_confidence(snapshot: Option<&MarketSnapshot>) -> MarketConfidenceSummary {
    match snapshot {
        Some(snapshot) => {
            let mut reasons = Vec::new();
            let mut level = "high";
            if snapshot.sell_order_count < 6 || snapshot.buy_order_count < 3 {
                reasons.push("Thin live book".to_string());
                level = "medium";
            }
            if snapshot.highest_buy.is_none() || snapshot.lowest_sell.is_none() {
                reasons.push("Missing side depth".to_string());
                level = "low";
            }
            build_confidence_summary(level, reasons)
        }
        None => build_confidence_summary("low", vec!["No live orderbook".to_string()]),
    }
}

fn build_liquidity_confidence(
    snapshot: &MarketSnapshot,
    recent_snapshots: &[MarketSnapshot],
) -> MarketConfidenceSummary {
    let mut reasons = Vec::new();
    let mut level = "high";

    if recent_snapshots.len() < 4 {
        reasons.push("Sparse tape".to_string());
        level = "low";
    } else if recent_snapshots.len() < 8 {
        reasons.push("Shallow tape".to_string());
        level = "medium";
    }

    let latest_snapshot_age = recent_snapshots
        .last()
        .and_then(|entry| parse_timestamp(&entry.captured_at))
        .map(|timestamp| (now_utc() - timestamp).whole_hours())
        .unwrap_or(999);
    if latest_snapshot_age > 24 {
        reasons.push("Stale tape".to_string());
        level = "low";
    } else if latest_snapshot_age > 6 && level == "high" {
        reasons.push("Aging tape".to_string());
        level = "medium";
    }

    if snapshot.sell_order_count < 6 || snapshot.buy_order_count < 3 {
        reasons.push("Thin live depth".to_string());
        if level == "high" {
            level = "medium";
        }
    }

    build_confidence_summary(level, reasons)
}

fn build_trend_confidence(
    points: &[AnalyticsChartPoint],
    selected_metric: Option<&TrendMetricSet>,
) -> MarketConfidenceSummary {
    let usable_points = points
        .iter()
        .filter(|point| {
            point.lowest_sell.is_some()
                || point.median_sell.is_some()
                || point.weighted_avg.is_some()
        })
        .count();
    let latest_age = latest_point_age_hours(points).unwrap_or(999);
    let confidence_pct = selected_metric.map(|entry| entry.confidence).unwrap_or(0.0);
    let flat_signal = selected_metric
        .map(|entry| {
            entry.slope_1h.unwrap_or_default().abs() < 0.05
                && entry.slope_3h.unwrap_or_default().abs() < 0.08
                && entry.slope_6h.unwrap_or_default().abs() < 0.10
        })
        .unwrap_or(true);

    let mut reasons = Vec::new();
    let mut level = "high";
    if usable_points < 8 {
        reasons.push("Thin history".to_string());
        level = "low";
    } else if usable_points < 16 {
        reasons.push("Sparse hourly points".to_string());
        level = "medium";
    }

    if latest_age > 12 {
        reasons.push("Stale hourly data".to_string());
        level = "low";
    }

    if flat_signal && confidence_pct < 60.0 && level == "high" {
        reasons.push("Flat tape".to_string());
        level = "medium";
    }

    build_confidence_summary(level, reasons)
}

fn build_manipulation_confidence(recent_snapshots: &[MarketSnapshot]) -> MarketConfidenceSummary {
    let mut reasons = Vec::new();
    let mut level = "high";

    if recent_snapshots.len() < 4 {
        reasons.push("Sparse tape".to_string());
        level = "low";
    } else if recent_snapshots.len() < 8 {
        reasons.push("Limited tape".to_string());
        level = "medium";
    }

    let latest_snapshot_age = recent_snapshots
        .last()
        .and_then(|entry| parse_timestamp(&entry.captured_at))
        .map(|timestamp| (now_utc() - timestamp).whole_hours())
        .unwrap_or(999);
    if latest_snapshot_age > 24 {
        reasons.push("Stale tape".to_string());
        level = "low";
    }

    build_confidence_summary(level, reasons)
}

fn build_time_of_day_confidence(
    bucket_count: usize,
    sample_count: usize,
) -> MarketConfidenceSummary {
    let mut reasons = Vec::new();
    let mut level = "high";
    if sample_count < 8 || bucket_count < 4 {
        reasons.push("Sparse tape".to_string());
        level = "low";
    } else if sample_count < 16 || bucket_count < 8 {
        reasons.push("Partial tape".to_string());
        level = "medium";
    }

    build_confidence_summary(level, reasons)
}

fn build_supply_confidence(
    mode: &str,
    components: &[SetComponentAnalysisEntry],
    drop_sources: &[DropSourceEntry],
) -> MarketConfidenceSummary {
    match mode {
        "set-components" => {
            let mut reasons = Vec::new();
            let level = if components.len() >= 2 {
                "high"
            } else {
                reasons.push("Partial set data".to_string());
                "medium"
            };
            build_confidence_summary(level, reasons)
        }
        "drop-sources" => {
            if drop_sources.is_empty() {
                return build_confidence_summary("low", vec!["No drop data".to_string()]);
            }
            let has_exact_chance = drop_sources
                .iter()
                .any(|entry| entry.chance.unwrap_or(0.0) > 0.0);
            build_confidence_summary(
                if has_exact_chance { "high" } else { "medium" },
                if has_exact_chance {
                    Vec::new()
                } else {
                    vec!["Weak drop data".to_string()]
                },
            )
        }
        _ => build_confidence_summary("low", vec!["No source data".to_string()]),
    }
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

fn weighted_sell_percentile_price(
    sell_orders: &[WfmDetailedOrder],
    percentile: f64,
) -> Option<f64> {
    if sell_orders.is_empty() {
        return None;
    }

    let mut ladder = sell_orders
        .iter()
        .map(|order| (order.platinum, (order.quantity.max(1) as f64).sqrt()))
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

fn recommended_exit_price(
    entry_price: Option<f64>,
    sell_orders: &[WfmDetailedOrder],
    snapshot: &MarketSnapshot,
    stats_rows: &[InternalStatsRow],
    zone_overview: &EntryExitZoneOverview,
) -> Option<f64> {
    let liquidity_score = liquidity_score_percent(snapshot);
    let live_percentile = choose_live_exit_percentile(snapshot, liquidity_score);
    let live_target = weighted_sell_percentile_price(sell_orders, live_percentile);
    let historical_target =
        historical_recommended_exit_price(entry_price, stats_rows, None, Some(zone_overview));
    let execution_cushion = if snapshot.sell_order_count < 10 {
        1.0
    } else if snapshot.sell_order_count < 24 {
        2.0
    } else {
        3.0
    };

    let candidate = match (historical_target, live_target) {
        (Some(history), Some(live)) => history.min(live + execution_cushion),
        (Some(history), None) => history,
        (None, Some(live)) => live,
        (None, None) => return entry_price,
    };

    let candidate = round_platinum(candidate);
    Some(candidate.max(round_platinum(entry_price.unwrap_or(candidate) + 1.0)))
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
    seller_mode: &str,
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
           AND seller_mode = ?3
         ORDER BY captured_at DESC
         LIMIT ?4",
    )?;

    let rows = statement.query_map(params![item_id, variant_key, seller_mode, limit], |row| {
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
            if let (Some(previous_floor), Some(current_floor)) =
                (previous.lowest_sell, current.lowest_sell)
            {
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
    let confidence_summary = build_manipulation_confidence(recent_snapshots);
    let allow_pattern_signals = confidence_summary.level != "low" && recent_snapshots.len() >= 6;
    let price_wall_active = snapshot
        .depth_levels
        .iter()
        .filter(|level| level.side == "sell")
        .map(|level| level.quantity as f64 / snapshot.sell_quantity.max(1) as f64)
        .reduce(f64::max)
        .unwrap_or(0.0)
        >= 0.40;

    let liquidity_withdrawal_active = if allow_pattern_signals {
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
        let floor_end = recent_snapshots
            .last()
            .and_then(|entry| entry.lowest_sell)
            .unwrap_or(0.0);
        previous_avg > 0.0
            && recent_avg <= previous_avg * 0.65
            && (floor_end - floor_start).abs() <= 2.0
    } else {
        false
    };

    let volatile_undercut_active = if allow_pattern_signals {
        let mut direction_changes = 0;
        let mut previous_direction = 0_i8;
        for window in recent_snapshots.windows(2) {
            if let [previous, current] = window {
                if let (Some(previous_floor), Some(current_floor)) =
                    (previous.lowest_sell, current.lowest_sell)
                {
                    let direction = match current_floor.partial_cmp(&previous_floor) {
                        Some(Ordering::Less) => -1,
                        Some(Ordering::Greater) => 1,
                        _ => 0,
                    };
                    if direction != 0 && previous_direction != 0 && direction != previous_direction
                    {
                        direction_changes += 1;
                    }
                    if direction != 0 {
                        previous_direction = direction;
                    }
                }
            }
        }
        direction_changes >= 3
            || undercut_velocity_per_hour(recent_snapshots).unwrap_or(0.0) >= 0.45
    } else {
        false
    };

    let unstable_buy_pressure_active = if allow_pattern_signals {
        snapshot_std_dev(
            &recent_snapshots
                .iter()
                .filter_map(|entry| entry.pressure_ratio)
                .collect::<Vec<_>>(),
        )
        .unwrap_or(0.0)
            >= 0.35
    } else {
        false
    };

    let thin_market_active = snapshot.sell_order_count < 6
        || snapshot.unique_sell_users < 4
        || snapshot.buy_order_count < 3;

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
                "Buy-side quantity has fallen materially without the floor repricing down."
                    .to_string()
            } else {
                "Buy-side liquidity is not showing a sharp withdrawal pattern.".to_string()
            },
        },
        ManipulationSignalState {
            key: "volatile_undercut_cycling".to_string(),
            label: "Volatile Undercut Cycling".to_string(),
            active: volatile_undercut_active,
            detail: if volatile_undercut_active {
                "Recent floor changes are cycling fast enough to suggest unstable queue behavior."
                    .to_string()
            } else {
                "Recent floor changes are not cycling aggressively.".to_string()
            },
        },
        ManipulationSignalState {
            key: "unstable_buy_pressure".to_string(),
            label: "Unstable Buy Pressure".to_string(),
            active: unstable_buy_pressure_active,
            detail: if unstable_buy_pressure_active {
                "Pressure ratio is moving around too aggressively across recent snapshots."
                    .to_string()
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
        confidence_summary,
    }
}

fn build_time_of_day_liquidity(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    seller_mode: &str,
) -> Result<TimeOfDayLiquiditySummary> {
    let cutoff = format_timestamp(now_utc() - TimeDuration::days(30))?;
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
           AND seller_mode = ?3
         AND captured_at >= ?4
         ORDER BY captured_at ASC",
    )?;
    let rows = statement.query_map(params![item_id, variant_key, seller_mode, cutoff], |row| {
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

    #[derive(Default)]
    struct TimeOfDayAccumulator {
        liquidity_sum: f64,
        visible_quantity_sum: f64,
        sell_order_sum: f64,
        spread_sum: f64,
        spread_count: usize,
        volume_sum: f64,
        volume_sample_count: usize,
        sample_count: usize,
    }

    let mut per_hour = BTreeMap::<i64, TimeOfDayAccumulator>::new();
    for row in rows {
        let snapshot = row?;
        let Some(timestamp) = parse_timestamp(&snapshot.captured_at) else {
            continue;
        };
        let entry = per_hour.entry(timestamp.hour() as i64).or_default();
        entry.sample_count += 1;
        entry.liquidity_sum += liquidity_score_percent(&snapshot);
        entry.visible_quantity_sum += (snapshot.sell_quantity + snapshot.buy_quantity) as f64;
        entry.sell_order_sum += snapshot.sell_order_count as f64;
        if let Some(spread_pct) = snapshot.spread_pct {
            entry.spread_sum += spread_pct;
            entry.spread_count += 1;
        }
    }

    let (closed_rows, _, _) =
        load_statistics_rows_for_domain(connection, item_id, variant_key, "48hours")?;
    for row in closed_rows {
        let hour = row.bucket_at.hour() as i64;
        let entry = per_hour.entry(hour).or_default();
        entry.volume_sum += row.volume.max(0.0);
        entry.volume_sample_count += 1;
    }

    let total_sample_count = per_hour
        .values()
        .map(|entry| entry.sample_count)
        .sum::<usize>();
    let populated_bucket_count = per_hour
        .values()
        .filter(|entry| entry.sample_count > 0 || entry.volume_sample_count > 0)
        .count();

    let mut raw_buckets = (0_i64..24_i64)
        .map(|hour| {
            let entry = per_hour.remove(&hour).unwrap_or_default();
            let avg_liquidity_score = if entry.sample_count > 0 {
                entry.liquidity_sum / entry.sample_count as f64
            } else {
                0.0
            };
            let avg_visible_quantity = if entry.sample_count > 0 {
                entry.visible_quantity_sum / entry.sample_count as f64
            } else {
                0.0
            };
            let avg_sell_orders = if entry.sample_count > 0 {
                entry.sell_order_sum / entry.sample_count as f64
            } else {
                0.0
            };
            let avg_hourly_volume = if entry.volume_sample_count > 0 {
                entry.volume_sum / entry.volume_sample_count as f64
            } else {
                0.0
            };

            TimeOfDayLiquidityBucket {
                hour,
                label: format!("{hour:02}:00"),
                avg_visible_quantity,
                avg_sell_orders,
                avg_spread_pct: if entry.spread_count > 0 {
                    Some(entry.spread_sum / entry.spread_count as f64)
                } else {
                    None
                },
                avg_liquidity_score,
                avg_hourly_volume,
                sample_count: entry.sample_count.max(entry.volume_sample_count),
                normalized_liquidity: 0.0,
                normalized_volume: 0.0,
                heat_score: 0.0,
            }
        })
        .collect::<Vec<_>>();

    let max_liquidity = raw_buckets
        .iter()
        .map(|bucket| bucket.avg_liquidity_score)
        .reduce(f64::max)
        .unwrap_or(0.0)
        .max(0.0);
    let max_volume = raw_buckets
        .iter()
        .map(|bucket| bucket.avg_hourly_volume)
        .reduce(f64::max)
        .unwrap_or(0.0)
        .max(0.0);

    let mut strongest_raw_score = 0.0_f64;
    for bucket in &mut raw_buckets {
        bucket.normalized_liquidity = if max_liquidity > 0.0 {
            (bucket.avg_liquidity_score / max_liquidity).clamp(0.0, 1.0)
        } else {
            0.0
        };
        bucket.normalized_volume = if max_volume > 0.0 {
            (bucket.avg_hourly_volume / max_volume).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let raw_score = (bucket.normalized_liquidity * 0.65) + (bucket.normalized_volume * 0.35);
        strongest_raw_score = strongest_raw_score.max(raw_score);
        bucket.heat_score = raw_score;
    }

    for bucket in &mut raw_buckets {
        bucket.heat_score = if strongest_raw_score > 0.0 {
            (bucket.heat_score / strongest_raw_score).clamp(0.0, 1.0)
        } else {
            0.0
        };
    }

    let strongest_window_label = raw_buckets
        .iter()
        .max_by(|left, right| left.heat_score.total_cmp(&right.heat_score))
        .map(|bucket| bucket.label.clone());
    let weakest_window_label = raw_buckets
        .iter()
        .min_by(|left, right| left.heat_score.total_cmp(&right.heat_score))
        .map(|bucket| bucket.label.clone());
    let current_hour_label = format!("{:02}:00", now_utc().hour());
    let confidence_summary = build_time_of_day_confidence(populated_bucket_count, total_sample_count);

    Ok(TimeOfDayLiquiditySummary {
        current_hour_label,
        strongest_window_label,
        weakest_window_label,
        buckets: raw_buckets,
        confidence_summary,
    })
}

fn compress_rank_stat_line(start: &str, end: &str) -> String {
    let start_chars = start.chars().collect::<Vec<_>>();
    let end_chars = end.chars().collect::<Vec<_>>();

    let mut prefix_len = 0usize;
    while prefix_len < start_chars.len()
        && prefix_len < end_chars.len()
        && start_chars[prefix_len] == end_chars[prefix_len]
    {
        prefix_len += 1;
    }

    let mut suffix_len = 0usize;
    while suffix_len < start_chars.len().saturating_sub(prefix_len)
        && suffix_len < end_chars.len().saturating_sub(prefix_len)
        && start_chars[start_chars.len() - 1 - suffix_len]
            == end_chars[end_chars.len() - 1 - suffix_len]
    {
        suffix_len += 1;
    }

    while suffix_len > 0
        && (prefix_len + suffix_len >= start_chars.len()
            || prefix_len + suffix_len >= end_chars.len())
    {
        suffix_len -= 1;
    }

    let prefix = start_chars[..prefix_len].iter().collect::<String>();
    let suffix = if suffix_len == 0 {
        String::new()
    } else {
        start_chars[start_chars.len() - suffix_len..]
            .iter()
            .collect::<String>()
    };
    let start_middle = start_chars[prefix_len..start_chars.len() - suffix_len]
        .iter()
        .collect::<String>()
        .trim()
        .to_string();
    let end_middle = end_chars[prefix_len..end_chars.len() - suffix_len]
        .iter()
        .collect::<String>()
        .trim()
        .to_string();

    if prefix.trim().is_empty() && suffix.trim().is_empty() {
        return format!("{} -> {}", start.trim(), end.trim());
    }

    format!("{prefix}{start_middle} -> {end_middle}{suffix}")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" %", "%")
}

fn extract_rank_stat_highlights(raw_json: &str) -> Result<(Option<String>, Vec<String>)> {
    let payload = serde_json::from_str::<serde_json::Value>(raw_json)
        .context("failed to parse wfstat raw json for item details")?;
    let Some(level_stats) = payload.get("levelStats").and_then(|value| value.as_array()) else {
        return Ok((None, Vec::new()));
    };
    if level_stats.is_empty() {
        return Ok((None, Vec::new()));
    }

    let extract_lines = |value: &serde_json::Value| {
        value
            .get("stats")
            .and_then(|stats| stats.as_array())
            .map(|stats| {
                stats
                    .iter()
                    .filter_map(|entry| entry.as_str())
                    .map(|entry| entry.trim().to_string())
                    .filter(|entry| !entry.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };

    let first_lines = extract_lines(&level_stats[0]);
    let last_lines = extract_lines(level_stats.last().unwrap_or(&level_stats[0]));
    let max_line_count = first_lines.len().max(last_lines.len());
    let mut highlights = Vec::new();

    for index in 0..max_line_count {
        match (first_lines.get(index), last_lines.get(index)) {
            (Some(first), Some(last)) if first == last => highlights.push(first.clone()),
            (Some(first), Some(last)) => highlights.push(compress_rank_stat_line(first, last)),
            (Some(first), None) => highlights.push(first.clone()),
            (None, Some(last)) => highlights.push(last.clone()),
            (None, None) => {}
        }
    }

    highlights.dedup();

    Ok((
        Some(format!(
            "Rank 0 -> Rank {}",
            level_stats.len().saturating_sub(1)
        )),
        highlights,
    ))
}

struct ItemDetailRow {
    name: String,
    slug: String,
    image_path: Option<String>,
    wiki_link: Option<String>,
    description: Option<String>,
    item_family: Option<String>,
    category: Option<String>,
    item_type: Option<String>,
    rarity: Option<String>,
    compat_name: Option<String>,
    product_category: Option<String>,
    polarity: Option<String>,
    stance_polarity: Option<String>,
    mod_set: Option<String>,
    mastery_req: Option<i64>,
    max_rank: Option<i64>,
    base_drain: Option<i64>,
    fusion_limit: Option<i64>,
    ducats: Option<i64>,
    market_cost: Option<i64>,
    build_price: Option<i64>,
    build_quantity: Option<i64>,
    build_time: Option<i64>,
    skip_build_time_price: Option<i64>,
    item_count: Option<i64>,
    tradable: Option<i64>,
    prime: Option<i64>,
    vaulted: Option<i64>,
    relic_tier: Option<String>,
    relic_code: Option<String>,
    critical_chance: Option<f64>,
    critical_multiplier: Option<f64>,
    status_chance: Option<f64>,
    fire_rate: Option<f64>,
    reload_time: Option<f64>,
    magazine_size: Option<i64>,
    multishot: Option<i64>,
    total_damage: Option<f64>,
    disposition: Option<i64>,
    range: Option<f64>,
    follow_through: Option<f64>,
    blocking_angle: Option<i64>,
    combo_duration: Option<f64>,
    heavy_attack_damage: Option<i64>,
    slam_attack: Option<i64>,
    heavy_slam_attack: Option<i64>,
    wind_up: Option<f64>,
    health: Option<i64>,
    shield: Option<i64>,
    armor: Option<i64>,
    sprint_speed: Option<f64>,
    power: Option<i64>,
    stamina: Option<i64>,
    noise: Option<String>,
    trigger: Option<String>,
    release_date: Option<String>,
    estimated_vault_date: Option<String>,
    vault_date: Option<String>,
    raw_json: Option<String>,
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
           ws.compat_name,
           ws.product_category,
           ws.polarity,
           ws.stance_polarity,
           ws.mod_set,
           ws.mastery_req,
           w.max_rank,
           ws.base_drain,
           ws.fusion_limit,
           w.ducats,
           ws.market_cost,
           ws.build_price,
           ws.build_quantity,
           ws.build_time,
           ws.skip_build_time_price,
           ws.item_count,
           ws.tradable,
           ws.is_prime,
           COALESCE(ws.vaulted, w.vaulted),
           i.relic_tier,
           i.relic_code,
           ws.critical_chance,
           ws.critical_multiplier,
           ws.proc_chance,
           ws.fire_rate,
           ws.reload_time,
           ws.magazine_size,
           ws.multishot,
           ws.total_damage,
           ws.disposition,
           ws.range,
           ws.follow_through,
           ws.blocking_angle,
           ws.combo_duration,
           ws.heavy_attack_damage,
           ws.slam_attack,
           ws.heavy_slam_attack,
           ws.wind_up,
           ws.health,
           ws.shield,
           ws.armor,
           ws.sprint_speed,
           ws.power,
           ws.stamina,
           ws.noise,
           ws.trigger,
           ws.release_date,
           ws.estimated_vault_date,
           ws.vault_date,
           ws.raw_json
         FROM items i
         LEFT JOIN wfm_items w ON w.item_id = i.item_id
         LEFT JOIN wfstat_items ws ON ws.item_id = i.item_id
         WHERE i.item_id = ?1
         LIMIT 1",
        params![item_id, slug],
        |row| {
            Ok(ItemDetailRow {
                name: row.get(0)?,
                slug: row.get(1)?,
                image_path: row.get(2)?,
                wiki_link: row.get(3)?,
                description: row.get(4)?,
                item_family: row.get(5)?,
                category: row.get(6)?,
                item_type: row.get(7)?,
                rarity: row.get(8)?,
                compat_name: row.get(9)?,
                product_category: row.get(10)?,
                polarity: row.get(11)?,
                stance_polarity: row.get(12)?,
                mod_set: row.get(13)?,
                mastery_req: row.get(14)?,
                max_rank: row.get(15)?,
                base_drain: row.get(16)?,
                fusion_limit: row.get(17)?,
                ducats: row.get(18)?,
                market_cost: row.get(19)?,
                build_price: row.get(20)?,
                build_quantity: row.get(21)?,
                build_time: row.get(22)?,
                skip_build_time_price: row.get(23)?,
                item_count: row.get(24)?,
                tradable: row.get(25)?,
                prime: row.get(26)?,
                vaulted: row.get(27)?,
                relic_tier: row.get(28)?,
                relic_code: row.get(29)?,
                critical_chance: row.get(30)?,
                critical_multiplier: row.get(31)?,
                status_chance: row.get(32)?,
                fire_rate: row.get(33)?,
                reload_time: row.get(34)?,
                magazine_size: row.get(35)?,
                multishot: row.get(36)?,
                total_damage: row.get(37)?,
                disposition: row.get(38)?,
                range: row.get(39)?,
                follow_through: row.get(40)?,
                blocking_angle: row.get(41)?,
                combo_duration: row.get(42)?,
                heavy_attack_damage: row.get(43)?,
                slam_attack: row.get(44)?,
                heavy_slam_attack: row.get(45)?,
                wind_up: row.get(46)?,
                health: row.get(47)?,
                shield: row.get(48)?,
                armor: row.get(49)?,
                sprint_speed: row.get(50)?,
                power: row.get(51)?,
                stamina: row.get(52)?,
                noise: row.get(53)?,
                trigger: row.get(54)?,
                release_date: row.get(55)?,
                estimated_vault_date: row.get(56)?,
                vault_date: row.get(57)?,
                raw_json: row.get(58)?,
            })
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
    let polarities = {
        let mut statement = connection.prepare(
            "SELECT wfstat_item_polarities.polarity
             FROM wfstat_item_polarities
             JOIN wfstat_items ON wfstat_items.wfstat_unique_name = wfstat_item_polarities.wfstat_unique_name
             WHERE wfstat_items.item_id = ?1
             ORDER BY wfstat_item_polarities.polarity_index ASC",
        )?;
        let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let parent_names = {
        let mut statement = connection.prepare(
            "SELECT wfstat_item_parents.parent_value
             FROM wfstat_item_parents
             JOIN wfstat_items ON wfstat_items.wfstat_unique_name = wfstat_item_parents.wfstat_unique_name
             WHERE wfstat_items.item_id = ?1
             ORDER BY wfstat_item_parents.parent_index ASC",
        )?;
        let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let ability_names = {
        let mut statement = connection.prepare(
            "SELECT wfstat_item_abilities.ability_name
             FROM wfstat_item_abilities
             JOIN wfstat_items ON wfstat_items.wfstat_unique_name = wfstat_item_abilities.wfstat_unique_name
             WHERE wfstat_items.item_id = ?1
               AND wfstat_item_abilities.ability_name IS NOT NULL
             ORDER BY wfstat_item_abilities.ability_index ASC",
        )?;
        let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let attack_names = {
        let mut statement = connection.prepare(
            "SELECT wfstat_item_attacks.attack_name
             FROM wfstat_item_attacks
             JOIN wfstat_items ON wfstat_items.wfstat_unique_name = wfstat_item_attacks.wfstat_unique_name
             WHERE wfstat_items.item_id = ?1
               AND wfstat_item_attacks.attack_name IS NOT NULL
             ORDER BY wfstat_item_attacks.attack_index ASC",
        )?;
        let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let (rank_scale_label, stat_highlights) = detail_row
        .raw_json
        .as_deref()
        .map(extract_rank_stat_highlights)
        .transpose()?
        .unwrap_or((None, Vec::new()));

    Ok(ItemDetailSummary {
        item_id,
        name: detail_row.name,
        slug: detail_row.slug,
        image_path: detail_row.image_path,
        wiki_link: detail_row.wiki_link,
        description: detail_row.description,
        item_family: detail_row.item_family,
        category: detail_row.category,
        item_type: detail_row.item_type,
        rarity: detail_row.rarity,
        compat_name: detail_row.compat_name,
        product_category: detail_row.product_category,
        polarity: detail_row.polarity,
        stance_polarity: detail_row.stance_polarity,
        mod_set: detail_row.mod_set,
        mastery_req: detail_row.mastery_req,
        max_rank: detail_row.max_rank,
        base_drain: detail_row.base_drain,
        fusion_limit: detail_row.fusion_limit,
        ducats: detail_row.ducats,
        market_cost: detail_row.market_cost,
        build_price: detail_row.build_price,
        build_quantity: detail_row.build_quantity,
        build_time: detail_row.build_time,
        skip_build_time_price: detail_row.skip_build_time_price,
        item_count: detail_row.item_count,
        tradable: bool_from_i64(detail_row.tradable),
        prime: bool_from_i64(detail_row.prime),
        vaulted: bool_from_i64(detail_row.vaulted),
        relic_tier: detail_row.relic_tier,
        relic_code: detail_row.relic_code,
        critical_chance: detail_row.critical_chance,
        critical_multiplier: detail_row.critical_multiplier,
        status_chance: detail_row.status_chance,
        fire_rate: detail_row.fire_rate,
        reload_time: detail_row.reload_time,
        magazine_size: detail_row.magazine_size,
        multishot: detail_row.multishot,
        total_damage: detail_row.total_damage,
        disposition: detail_row.disposition,
        range: detail_row.range,
        follow_through: detail_row.follow_through,
        blocking_angle: detail_row.blocking_angle,
        combo_duration: detail_row.combo_duration,
        heavy_attack_damage: detail_row.heavy_attack_damage,
        slam_attack: detail_row.slam_attack,
        heavy_slam_attack: detail_row.heavy_slam_attack,
        wind_up: detail_row.wind_up,
        health: detail_row.health,
        shield: detail_row.shield,
        armor: detail_row.armor,
        sprint_speed: detail_row.sprint_speed,
        power: detail_row.power,
        stamina: detail_row.stamina,
        noise: detail_row.noise,
        trigger: detail_row.trigger,
        release_date: detail_row.release_date,
        estimated_vault_date: detail_row.estimated_vault_date,
        vault_date: detail_row.vault_date,
        tags,
        polarities,
        parent_names,
        ability_names,
        attack_names,
        rank_scale_label,
        stat_highlights,
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

fn load_scanner_set_map_file(path: &Path) -> Result<Option<ScannerSetMapFile>> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read scanner set map at {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }

    let file = serde_json::from_str::<ScannerSetMapFile>(&raw)
        .with_context(|| format!("failed to parse scanner set map at {}", path.display()))?;
    Ok(Some(file))
}

fn load_catalog_item_brief_by_slug(
    connection: &Connection,
    slug: &str,
) -> Result<Option<(i64, String, Option<String>)>> {
    connection
        .query_row(
            "SELECT
               i.item_id,
               COALESCE(i.preferred_name, i.canonical_name, i.wfstat_name, i.wfm_slug, ?1) AS item_name,
               COALESCE(i.preferred_image, w.thumb, w.icon) AS image_path
             FROM items i
             LEFT JOIN wfm_items w ON w.item_id = i.item_id
             WHERE i.wfm_slug = ?1
                OR i.preferred_slug = ?1
             LIMIT 1",
            params![slug],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(Into::into)
}

fn load_scanner_sets_from_map(
    app: &tauri::AppHandle,
    catalog_connection: &Connection,
) -> Result<Vec<(SetRootCatalogRecord, Vec<CachedSetComponentRecord>)>> {
    let map_path = resolve_scanner_set_map_path(app)?;
    let set_map = load_scanner_set_map_file(&map_path)?
        .ok_or_else(|| anyhow!("scanner set map is unavailable at {}", map_path.display()))?;
    let generated_at = set_map.generated_at.clone();

    let mut sets = Vec::with_capacity(set_map.sets.len());
    for set_record in set_map.sets {
        let Some((set_item_id, resolved_name, resolved_image)) =
            load_catalog_item_brief_by_slug(catalog_connection, &set_record.slug)?
        else {
            continue;
        };

        let set_root = SetRootCatalogRecord {
            item_id: set_item_id,
            slug: set_record.slug.clone(),
            name: if set_record.name.trim().is_empty() {
                resolved_name
            } else {
                set_record.name.clone()
            },
            image_path: set_record.image_path.or(resolved_image),
        };

        let mut components = Vec::with_capacity(set_record.components.len());
        for (index, component) in set_record.components.iter().enumerate() {
            let Some((component_item_id, component_name, component_image_path)) =
                load_catalog_item_brief_by_slug(catalog_connection, &component.slug)?
            else {
                continue;
            };

            components.push(CachedSetComponentRecord {
                set_item_id: set_root.item_id,
                set_slug: set_root.slug.clone(),
                set_name: set_root.name.clone(),
                set_image_path: set_root.image_path.clone(),
                component_item_id: Some(component_item_id),
                component_slug: component.slug.clone(),
                component_name,
                component_image_path,
                quantity_in_set: component.quantity_in_set.max(1),
                sort_order: index as i64,
                fetched_at: generated_at.clone(),
            });
        }

        if !components.is_empty() {
            sets.push((set_root, components));
        }
    }

    Ok(sets)
}

fn list_relic_roots_from_catalog(connection: &Connection) -> Result<Vec<RelicRootCatalogRecord>> {
    let mut statement = connection.prepare(
        "SELECT
           i.item_id,
           i.wfm_slug,
           i.preferred_name,
           COALESCE(i.preferred_image, w.thumb, w.icon) AS image_path,
           COALESCE(MAX(wi.vaulted), 0) AS vaulted
         FROM items i
         LEFT JOIN wfm_items w ON w.item_id = i.item_id
         LEFT JOIN wfstat_items wi ON wi.item_id = i.item_id
         WHERE i.relic_tier IS NOT NULL
           AND i.relic_code IS NOT NULL
           AND i.wfm_slug IS NOT NULL
           AND LOWER(i.relic_tier) <> 'requiem'
         GROUP BY i.item_id, i.wfm_slug, i.preferred_name, image_path
         ORDER BY i.preferred_name ASC",
    )?;

    let rows = statement.query_map([], |row| {
        Ok(RelicRootCatalogRecord {
            item_id: row.get(0)?,
            slug: row.get(1)?,
            name: row.get(2)?,
            image_path: row.get(3)?,
            vaulted: row.get::<_, i64>(4)? != 0,
        })
    })?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn relic_refinement_label(refinement_key: &str) -> &'static str {
    match refinement_key {
        RELIC_REFINEMENT_EXCEPTIONAL => "Exceptional",
        RELIC_REFINEMENT_FLAWLESS => "Flawless",
        RELIC_REFINEMENT_RADIANT => "Radiant",
        _ => "Intact",
    }
}

fn all_relic_refinement_keys() -> [&'static str; 4] {
    [
        RELIC_REFINEMENT_INTACT,
        RELIC_REFINEMENT_EXCEPTIONAL,
        RELIC_REFINEMENT_FLAWLESS,
        RELIC_REFINEMENT_RADIANT,
    ]
}

fn load_cached_set_components(
    connection: &Connection,
    set_slug: &str,
) -> Result<Vec<CachedSetComponentRecord>> {
    let mut statement = connection.prepare(
        "SELECT
           set_item_id,
           set_slug,
           set_name,
           set_image_path,
           component_item_id,
           component_slug,
           component_name,
           component_image_path,
           quantity_in_set,
           sort_order,
           fetched_at
         FROM set_component_cache
         WHERE set_slug = ?1
         ORDER BY sort_order ASC, component_name ASC",
    )?;

    let rows = statement.query_map(params![set_slug], |row| {
        Ok(CachedSetComponentRecord {
            set_item_id: row.get(0)?,
            set_slug: row.get(1)?,
            set_name: row.get(2)?,
            set_image_path: row.get(3)?,
            component_item_id: row.get(4)?,
            component_slug: row.get(5)?,
            component_name: row.get(6)?,
            component_image_path: row.get(7)?,
            quantity_in_set: row.get(8)?,
            sort_order: row.get(9)?,
            fetched_at: row.get(10)?,
        })
    })?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn set_component_cache_is_fresh(entries: &[CachedSetComponentRecord]) -> bool {
    let Some(fetched_at) = entries
        .first()
        .and_then(|entry| parse_timestamp(&entry.fetched_at))
    else {
        return false;
    };

    (now_utc() - fetched_at) < TimeDuration::days(SET_COMPOSITION_CACHE_RETENTION_DAYS)
}

fn load_catalog_set_components(
    catalog_connection: &Connection,
    set_root: &SetRootCatalogRecord,
    fetched_at: &str,
) -> Result<Vec<CachedSetComponentRecord>> {
    let set_unique_name = catalog_connection
        .query_row(
            "SELECT primary_wfstat_unique_name
             FROM items
             WHERE item_id = ?1
             LIMIT 1",
            params![set_root.item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();

    let Some(set_unique_name) = set_unique_name else {
        return Ok(Vec::new());
    };

    let mut statement = catalog_connection.prepare(
        "
        SELECT
          ci.item_id,
          COALESCE(ci.wfm_slug, ci.preferred_slug) AS component_slug,
          COALESCE(
            ci.preferred_name,
            ci.canonical_name,
            ci.wfstat_name,
            ci.wfm_slug
          ) AS component_name,
          COALESCE(ci.preferred_image, w.thumb, w.icon) AS component_image_path,
          c.item_count,
          c.raw_json,
          c.component_index
        FROM wfstat_item_components c
        JOIN items ci ON ci.item_id = c.component_item_id
        LEFT JOIN wfm_items w ON w.item_id = ci.item_id
        WHERE c.wfstat_unique_name = ?1
          AND (ci.wfm_slug IS NOT NULL OR ci.preferred_slug IS NOT NULL)
        ORDER BY c.component_index ASC, component_slug ASC
        ",
    )?;

    let rows = statement.query_map(params![set_unique_name], |row| {
        let raw_json: Option<String> = row.get(5)?;
        let quantity_from_raw = raw_json
            .as_deref()
            .and_then(extract_component_quantity_from_raw);
        let quantity_in_set = row
            .get::<_, Option<i64>>(4)?
            .or(quantity_from_raw)
            .unwrap_or(1)
            .max(1);
        Ok(CachedSetComponentRecord {
            set_item_id: set_root.item_id,
            set_slug: set_root.slug.clone(),
            set_name: set_root.name.clone(),
            set_image_path: set_root.image_path.clone(),
            component_item_id: row.get::<_, i64>(0).ok(),
            component_slug: row.get(1)?,
            component_name: row.get(2)?,
            component_image_path: row.get(3)?,
            quantity_in_set,
            sort_order: row.get(6)?,
            fetched_at: fetched_at.to_string(),
        })
    })?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn extract_component_quantity_from_raw(raw_json: &str) -> Option<i64> {
    let payload = serde_json::from_str::<serde_json::Value>(raw_json).ok()?;
    payload
        .get("itemCount")
        .and_then(serde_json::Value::as_i64)
        .or_else(|| payload.get("count").and_then(serde_json::Value::as_i64))
}

fn persist_set_component_cache(
    observatory_connection: &Connection,
    set_root: &SetRootCatalogRecord,
    components: &[CachedSetComponentRecord],
) -> Result<()> {
    observatory_connection.execute(
        "DELETE FROM set_component_cache
         WHERE set_slug = ?1",
        params![set_root.slug],
    )?;

    let mut statement = observatory_connection.prepare(
        "INSERT INTO set_component_cache (
           set_item_id,
           set_slug,
           set_name,
           set_image_path,
           component_item_id,
           component_slug,
           component_name,
           component_image_path,
           quantity_in_set,
           sort_order,
           fetched_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?;

    for component in components {
        statement.execute(params![
            component.set_item_id,
            component.set_slug,
            component.set_name,
            component.set_image_path,
            component.component_item_id,
            component.component_slug,
            component.component_name,
            component.component_image_path,
            component.quantity_in_set,
            component.sort_order,
            component.fetched_at
        ])?;
    }

    Ok(())
}

fn ensure_set_components_cached(
    catalog_connection: &Connection,
    observatory_connection: &Connection,
    set_root: &SetRootCatalogRecord,
) -> Result<(Vec<CachedSetComponentRecord>, bool)> {
    let cached = load_cached_set_components(observatory_connection, &set_root.slug)?;
    if !cached.is_empty() && set_component_cache_is_fresh(&cached) {
        return Ok((cached, false));
    }

    let fetched_at = format_timestamp(now_utc())?;
    let components = load_catalog_set_components(catalog_connection, set_root, &fetched_at)?;

    persist_set_component_cache(observatory_connection, set_root, &components)?;
    Ok((components, true))
}

fn default_arbitrage_scanner_progress() -> Result<ArbitrageScannerProgress> {
    Ok(ArbitrageScannerProgress {
        scanner_key: ARBITRAGE_SCANNER_KEY.to_string(),
        status: "idle".to_string(),
        progress_value: 0.0,
        stage_label: "Ready".to_string(),
        status_text: "No saved arbitrage scan yet.".to_string(),
        updated_at: format_timestamp(now_utc())?,
        started_at: None,
        last_completed_at: None,
        last_error: None,
        current_set_name: None,
        current_component_name: None,
        completed_set_count: 0,
        total_set_count: 0,
        completed_component_count: 0,
        total_component_count: 0,
        skipped_entry_count: 0,
        retrying_item_name: None,
        retry_attempt: None,
    })
}

fn scanner_progress_with_runtime(
    base: &ArbitrageScannerProgress,
    runtime: &ScannerRuntimeProgress,
) -> ArbitrageScannerProgress {
    ArbitrageScannerProgress {
        scanner_key: base.scanner_key.clone(),
        status: base.status.clone(),
        progress_value: base.progress_value,
        stage_label: base.stage_label.clone(),
        status_text: base.status_text.clone(),
        updated_at: base.updated_at.clone(),
        started_at: base.started_at.clone(),
        last_completed_at: base.last_completed_at.clone(),
        last_error: base.last_error.clone(),
        current_set_name: runtime.current_set_name.clone(),
        current_component_name: runtime.current_component_name.clone(),
        completed_set_count: runtime.completed_set_count,
        total_set_count: runtime.total_set_count,
        completed_component_count: runtime.completed_component_count,
        total_component_count: runtime.total_component_count,
        skipped_entry_count: runtime.skipped_entry_count,
        retrying_item_name: runtime.retrying_item_name.clone(),
        retry_attempt: runtime.retry_attempt,
    }
}

fn total_component_count_from_response(response: &ArbitrageScannerResponse) -> usize {
    response
        .results
        .iter()
        .map(|entry| entry.components.len())
        .sum()
}

fn emit_running_scanner_progress(
    on_progress: &mut impl FnMut(ArbitrageScannerProgress),
    started_at: &str,
    completed_task_count: usize,
    total_task_count: usize,
    runtime: &ScannerRuntimeProgress,
    stage_label: &str,
    status_text: String,
) -> Result<()> {
    let progress_value = if total_task_count == 0 {
        100.0
    } else {
        ((completed_task_count as f64 / total_task_count as f64) * 100.0).clamp(0.0, 99.0)
    };
    let base = ArbitrageScannerProgress {
        scanner_key: ARBITRAGE_SCANNER_KEY.to_string(),
        status: "running".to_string(),
        progress_value,
        stage_label: stage_label.to_string(),
        status_text,
        updated_at: format_timestamp(now_utc())?,
        started_at: Some(started_at.to_string()),
        last_completed_at: None,
        last_error: None,
        current_set_name: None,
        current_component_name: None,
        completed_set_count: 0,
        total_set_count: 0,
        completed_component_count: 0,
        total_component_count: 0,
        skipped_entry_count: 0,
        retrying_item_name: None,
        retry_attempt: None,
    };
    on_progress(scanner_progress_with_runtime(&base, runtime));
    Ok(())
}

fn stale_arbitrage_scanner_progress(
    progress: &ArbitrageScannerProgress,
) -> Result<Option<ArbitrageScannerProgress>> {
    if progress.status != "running" {
        return Ok(None);
    }

    let Some(updated_at) = parse_timestamp(&progress.updated_at) else {
        return Ok(None);
    };

    if (now_utc() - updated_at) < TimeDuration::minutes(ARBITRAGE_SCANNER_STALE_MINUTES) {
        return Ok(None);
    }

    Ok(Some(ArbitrageScannerProgress {
        scanner_key: progress.scanner_key.clone(),
        status: "error".to_string(),
        progress_value: progress.progress_value,
        stage_label: "Interrupted".to_string(),
        status_text: "The previous arbitrage scan stopped updating and was reset.".to_string(),
        updated_at: format_timestamp(now_utc())?,
        started_at: progress.started_at.clone(),
        last_completed_at: progress.last_completed_at.clone(),
        last_error: Some("Previous background scan became stale.".to_string()),
        current_set_name: progress.current_set_name.clone(),
        current_component_name: progress.current_component_name.clone(),
        completed_set_count: progress.completed_set_count,
        total_set_count: progress.total_set_count,
        completed_component_count: progress.completed_component_count,
        total_component_count: progress.total_component_count,
        skipped_entry_count: progress.skipped_entry_count,
        retrying_item_name: None,
        retry_attempt: None,
    }))
}

fn persist_arbitrage_scanner_progress_with_stop_reset(
    connection: &Connection,
    progress: &ArbitrageScannerProgress,
    clear_stop_requested: bool,
) -> Result<()> {
    connection.execute(
        "INSERT INTO scanner_progress (
           scanner_key,
           status,
           progress_value,
           stage_label,
           status_text,
           updated_at,
           started_at,
           last_completed_at,
           last_error,
           current_set_name,
           current_component_name,
           completed_set_count,
           total_set_count,
           completed_component_count,
           total_component_count,
           skipped_entry_count,
           retrying_item_name,
           retry_attempt
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(scanner_key) DO UPDATE SET
           status = excluded.status,
           progress_value = excluded.progress_value,
           stage_label = excluded.stage_label,
           status_text = excluded.status_text,
           updated_at = excluded.updated_at,
           started_at = excluded.started_at,
           last_completed_at = excluded.last_completed_at,
           last_error = excluded.last_error,
           current_set_name = excluded.current_set_name,
           current_component_name = excluded.current_component_name,
           completed_set_count = excluded.completed_set_count,
           total_set_count = excluded.total_set_count,
           completed_component_count = excluded.completed_component_count,
           total_component_count = excluded.total_component_count,
           skipped_entry_count = excluded.skipped_entry_count,
           retrying_item_name = excluded.retrying_item_name,
           retry_attempt = excluded.retry_attempt,
           stop_requested = CASE
             WHEN ?19 = 1 THEN 0
             ELSE scanner_progress.stop_requested
           END",
        params![
            progress.scanner_key,
            progress.status,
            progress.progress_value,
            progress.stage_label,
            progress.status_text,
            progress.updated_at,
            progress.started_at,
            progress.last_completed_at,
            progress.last_error,
            progress.current_set_name,
            progress.current_component_name,
            progress.completed_set_count,
            progress.total_set_count,
            progress.completed_component_count,
            progress.total_component_count,
            progress.skipped_entry_count,
            progress.retrying_item_name,
            progress.retry_attempt,
            if clear_stop_requested { 1 } else { 0 },
        ],
    )?;

    Ok(())
}

fn persist_arbitrage_scanner_progress(
    connection: &Connection,
    progress: &ArbitrageScannerProgress,
) -> Result<()> {
    persist_arbitrage_scanner_progress_with_stop_reset(connection, progress, false)
}

fn arbitrage_scanner_stop_requested(connection: &Connection) -> Result<bool> {
    Ok(connection
        .query_row(
            "SELECT stop_requested
             FROM scanner_progress
             WHERE scanner_key = ?1
             LIMIT 1",
            params![ARBITRAGE_SCANNER_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0)
        != 0)
}

fn request_arbitrage_scanner_stop(connection: &Connection) -> Result<bool> {
    let updated_at = format_timestamp(now_utc())?;
    let changed = connection.execute(
        "UPDATE scanner_progress
         SET stop_requested = 1,
             status = CASE WHEN status = 'running' THEN 'running' ELSE status END,
             stage_label = CASE WHEN status = 'running' THEN 'Stopping' ELSE stage_label END,
             status_text = CASE WHEN status = 'running' THEN 'Stopping arbitrage scan…' ELSE status_text END,
             updated_at = ?2
         WHERE scanner_key = ?1
           AND status = 'running'",
        params![ARBITRAGE_SCANNER_KEY, updated_at],
    )?;

    Ok(changed > 0)
}

fn load_arbitrage_scanner_progress(connection: &Connection) -> Result<ArbitrageScannerProgress> {
    let progress = connection
        .query_row(
            "SELECT
               scanner_key,
               status,
               progress_value,
               stage_label,
               status_text,
               updated_at,
               started_at,
               last_completed_at,
               last_error,
               current_set_name,
               current_component_name,
               completed_set_count,
               total_set_count,
               completed_component_count,
               total_component_count,
               skipped_entry_count,
               retrying_item_name,
               retry_attempt
             FROM scanner_progress
             WHERE scanner_key = ?1
             LIMIT 1",
            params![ARBITRAGE_SCANNER_KEY],
            |row| {
                Ok(ArbitrageScannerProgress {
                    scanner_key: row.get(0)?,
                    status: row.get(1)?,
                    progress_value: row.get(2)?,
                    stage_label: row.get(3)?,
                    status_text: row.get(4)?,
                    updated_at: row.get(5)?,
                    started_at: row.get(6)?,
                    last_completed_at: row.get(7)?,
                    last_error: row.get(8)?,
                    current_set_name: row.get(9)?,
                    current_component_name: row.get(10)?,
                    completed_set_count: row.get::<_, i64>(11)?.max(0) as usize,
                    total_set_count: row.get::<_, i64>(12)?.max(0) as usize,
                    completed_component_count: row.get::<_, i64>(13)?.max(0) as usize,
                    total_component_count: row.get::<_, i64>(14)?.max(0) as usize,
                    skipped_entry_count: row.get::<_, i64>(15)?.max(0) as usize,
                    retrying_item_name: row.get(16)?,
                    retry_attempt: row
                        .get::<_, Option<i64>>(17)?
                        .map(|value| value.max(0) as usize),
                })
            },
        )
        .optional()?;

    match progress {
        Some(progress) => {
            if let Some(stale_progress) = stale_arbitrage_scanner_progress(&progress)? {
                persist_arbitrage_scanner_progress_with_stop_reset(
                    connection,
                    &stale_progress,
                    true,
                )?;
                Ok(stale_progress)
            } else {
                Ok(progress)
            }
        }
        None => {
            let progress = default_arbitrage_scanner_progress()?;
            persist_arbitrage_scanner_progress_with_stop_reset(connection, &progress, true)?;
            Ok(progress)
        }
    }
}

fn persist_arbitrage_scanner_cache(
    connection: &Connection,
    response: &ArbitrageScannerResponse,
) -> Result<()> {
    connection.execute(
        "INSERT INTO scanner_cache (
           scanner_key,
           computed_at,
           payload_json
         ) VALUES (?1, ?2, ?3)
         ON CONFLICT(scanner_key) DO UPDATE SET
           computed_at = excluded.computed_at,
           payload_json = excluded.payload_json",
        params![
            ARBITRAGE_SCANNER_KEY,
            response.computed_at,
            serde_json::to_string(response)?,
        ],
    )?;

    Ok(())
}

fn load_set_completion_owned_items(connection: &Connection) -> Result<Vec<SetCompletionOwnedItem>> {
    let mut statement = connection.prepare(
        "SELECT component_item_id,
                component_slug,
                component_name,
                component_image_path,
                quantity,
                updated_at
         FROM owned_set_components
         WHERE quantity > 0
         ORDER BY component_name COLLATE NOCASE ASC, component_slug ASC",
    )?;

    let rows = statement.query_map([], |row| {
        Ok(SetCompletionOwnedItem {
            item_id: row.get(0)?,
            slug: row.get(1)?,
            name: row.get(2)?,
            image_path: row.get(3)?,
            quantity: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to load owned set components")
}

fn upsert_set_completion_owned_item(
    connection: &Connection,
    item_id: Option<i64>,
    slug: &str,
    name: &str,
    image_path: Option<&str>,
    quantity: i64,
) -> Result<Vec<SetCompletionOwnedItem>> {
    if slug.trim().is_empty() {
        return Err(anyhow!("component slug is required"));
    }
    if name.trim().is_empty() {
        return Err(anyhow!("component name is required"));
    }
    if quantity < 0 {
        return Err(anyhow!("owned quantity cannot be negative"));
    }

    if quantity == 0 {
        connection.execute(
            "DELETE FROM owned_set_components
             WHERE component_slug = ?1",
            params![slug],
        )?;
        return load_set_completion_owned_items(connection);
    }

    let updated_at = format_timestamp(now_utc())?;
    connection.execute(
        "INSERT INTO owned_set_components (
           component_slug,
           component_item_id,
           component_name,
           component_image_path,
           quantity,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(component_slug) DO UPDATE SET
           component_item_id = excluded.component_item_id,
           component_name = excluded.component_name,
           component_image_path = excluded.component_image_path,
           quantity = excluded.quantity,
           updated_at = excluded.updated_at",
        params![slug, item_id, name, image_path, quantity, updated_at],
    )?;

    load_set_completion_owned_items(connection)
}

fn apply_owned_set_component_deltas_inner(
    connection: &mut Connection,
    deltas: &[OwnedSetComponentDelta],
) -> Result<()> {
    if deltas.is_empty() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .context("failed to start owned set component sync transaction")?;
    let applied_at = format_timestamp(now_utc())?;

    for delta in deltas {
        if delta.sync_key.trim().is_empty()
            || delta.slug.trim().is_empty()
            || delta.name.trim().is_empty()
            || delta.quantity_delta == 0
        {
            continue;
        }

        let already_applied = transaction
            .query_row(
                "SELECT 1
                 FROM owned_set_component_trade_sync
                 WHERE sync_key = ?1
                 LIMIT 1",
                params![delta.sync_key.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if already_applied {
            continue;
        }

        let current_quantity = transaction
            .query_row(
                "SELECT quantity
                 FROM owned_set_components
                 WHERE component_slug = ?1
                 LIMIT 1",
                params![delta.slug.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        let next_quantity = (current_quantity + delta.quantity_delta).max(0);

        if next_quantity == 0 {
            transaction.execute(
                "DELETE FROM owned_set_components
                 WHERE component_slug = ?1",
                params![delta.slug.as_str()],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO owned_set_components (
                   component_slug,
                   component_item_id,
                   component_name,
                   component_image_path,
                   quantity,
                   updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(component_slug) DO UPDATE SET
                   component_item_id = excluded.component_item_id,
                   component_name = excluded.component_name,
                   component_image_path = excluded.component_image_path,
                   quantity = excluded.quantity,
                   updated_at = excluded.updated_at",
                params![
                    delta.slug.as_str(),
                    delta.item_id,
                    delta.name.as_str(),
                    delta.image_path.as_deref(),
                    next_quantity,
                    applied_at.as_str(),
                ],
            )?;
        }

        transaction.execute(
            "INSERT INTO owned_set_component_trade_sync (
               sync_key,
               component_slug,
               applied_at
             ) VALUES (?1, ?2, ?3)",
            params![
                delta.sync_key.as_str(),
                delta.slug.as_str(),
                applied_at.as_str()
            ],
        )?;
    }

    transaction
        .commit()
        .context("failed to commit owned set component sync transaction")
}

fn replace_owned_set_component_deltas_inner(
    connection: &mut Connection,
    deltas: &[OwnedSetComponentDelta],
) -> Result<()> {
    let transaction = connection
        .transaction()
        .context("failed to start owned set component rebuild transaction")?;
    let rebuilt_at = format_timestamp(now_utc())?;

    transaction.execute("DELETE FROM owned_set_component_trade_sync", [])?;
    transaction.execute("DELETE FROM owned_set_components", [])?;

    let mut aggregated = BTreeMap::<String, OwnedSetComponentDelta>::new();
    for delta in deltas {
        if delta.sync_key.trim().is_empty()
            || delta.slug.trim().is_empty()
            || delta.name.trim().is_empty()
            || delta.quantity_delta == 0
        {
            continue;
        }

        let entry = aggregated.entry(delta.slug.clone()).or_insert_with(|| OwnedSetComponentDelta {
            sync_key: String::new(),
            item_id: delta.item_id,
            slug: delta.slug.clone(),
            name: delta.name.clone(),
            image_path: delta.image_path.clone(),
            quantity_delta: 0,
        });

        entry.quantity_delta += delta.quantity_delta;
        if entry.item_id.is_none() {
            entry.item_id = delta.item_id;
        }
        if entry.name.trim().is_empty() {
            entry.name = delta.name.clone();
        }
        if entry.image_path.is_none() {
            entry.image_path = delta.image_path.clone();
        }
    }

    for delta in aggregated.values() {
        let next_quantity = delta.quantity_delta.max(0);
        if next_quantity <= 0 {
            continue;
        }

        transaction.execute(
            "INSERT INTO owned_set_components (
               component_slug,
               component_item_id,
               component_name,
               component_image_path,
               quantity,
               updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                delta.slug.as_str(),
                delta.item_id,
                delta.name.as_str(),
                delta.image_path.as_deref(),
                next_quantity,
                rebuilt_at.as_str(),
            ],
        )?;
    }

    for delta in deltas {
        if delta.sync_key.trim().is_empty() || delta.slug.trim().is_empty() {
            continue;
        }

        transaction.execute(
            "INSERT INTO owned_set_component_trade_sync (
               sync_key,
               component_slug,
               applied_at
             ) VALUES (?1, ?2, ?3)
             ON CONFLICT(sync_key) DO UPDATE SET
               component_slug = excluded.component_slug,
               applied_at = excluded.applied_at",
            params![delta.sync_key.as_str(), delta.slug.as_str(), rebuilt_at.as_str()],
        )?;
    }

    transaction
        .commit()
        .context("failed to commit owned set component rebuild transaction")
}

pub(crate) fn apply_owned_set_component_deltas(
    app: &tauri::AppHandle,
    deltas: &[OwnedSetComponentDelta],
) -> Result<()> {
    if deltas.is_empty() {
        return Ok(());
    }

    let mut connection = open_market_observatory_database(app)?;
    apply_owned_set_component_deltas_inner(&mut connection, deltas)
}

pub(crate) fn replace_owned_set_component_deltas(
    app: &tauri::AppHandle,
    deltas: &[OwnedSetComponentDelta],
) -> Result<()> {
    let mut connection = open_market_observatory_database(app)?;
    replace_owned_set_component_deltas_inner(&mut connection, deltas)
}

fn load_arbitrage_scanner_cache(
    connection: &Connection,
) -> Result<Option<ArbitrageScannerResponse>> {
    let payload = connection
        .query_row(
            "SELECT payload_json
             FROM scanner_cache
             WHERE scanner_key = ?1
             LIMIT 1",
            params![ARBITRAGE_SCANNER_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    payload
        .map(|json| {
            serde_json::from_str::<ArbitrageScannerResponse>(&json)
                .context("failed to parse arbitrage cache")
        })
        .transpose()
}

fn load_arbitrage_scanner_state(connection: &Connection) -> Result<ArbitrageScannerState> {
    Ok(ArbitrageScannerState {
        latest_scan: load_arbitrage_scanner_cache(connection)?,
        progress: load_arbitrage_scanner_progress(connection)?,
    })
}

fn emit_arbitrage_scanner_progress(app: &tauri::AppHandle, progress: &ArbitrageScannerProgress) {
    let _ = app.emit(ARBITRAGE_SCANNER_PROGRESS_EVENT, progress.clone());
}

fn load_drop_sources(app: &tauri::AppHandle, item_id: i64) -> Result<Vec<DropSourceEntry>> {
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

    let mut deduped_sources = deduped.into_values().collect::<Vec<_>>();
    deduped_sources.sort_by(|left, right| {
        let left_chance = left.chance.unwrap_or(-1.0);
        let right_chance = right.chance.unwrap_or(-1.0);

        right_chance
            .partial_cmp(&left_chance)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.location.cmp(&right.location))
            .then_with(|| left.rarity.cmp(&right.rarity))
            .then_with(|| left.source_type.cmp(&right.source_type))
    });

    Ok(deduped_sources.into_iter().take(12).collect())
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
    let confidence_summary = build_trend_confidence(points, tabs.get("lowestSell"));

    TrendQualityBreakdown {
        selected_tab: "lowestSell".to_string(),
        tabs,
        stability,
        volatility,
        noise,
        confidence_summary,
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

    let mut summary = match direction {
        "Rising" => "Short-term momentum is positive and the live structure is leaning upward.".to_string(),
        "Falling" => "Recent slope structure is still pointing down, so patience matters more than chase entries.".to_string(),
        _ => "Recent price structure is mixed, with neither buyers nor sellers holding a clean short-term trend.".to_string(),
    };
    if breakdown.confidence_summary.level != "high" {
        summary.push_str(&confidence_suffix(&breakdown.confidence_summary));
    }

    TrendSummary {
        direction: direction.to_string(),
        confidence: lowest_sell.map(|entry| entry.confidence),
        summary,
        slope_1h,
        slope_3h,
        slope_6h,
        confidence_summary: breakdown.confidence_summary.clone(),
    }
}

fn build_supply_context(
    app: &tauri::AppHandle,
    item_id: i64,
    slug: &str,
    item_details: &ItemDetailSummary,
    _seller_mode: &str,
) -> Result<ItemSupplyContext> {
    let looks_like_set =
        item_details.tags.iter().any(|tag| tag == "set") || item_details.name.ends_with(" Set");

    if looks_like_set {
        let catalog_connection = open_catalog_database(app)?;
        let observatory_connection = open_market_observatory_database(app)?;
        let set_root = SetRootCatalogRecord {
            item_id,
            slug: slug.to_string(),
            name: item_details.name.clone(),
            image_path: item_details.image_path.clone(),
        };
        let (cached_components, _) = ensure_set_components_cached(
            &catalog_connection,
            &observatory_connection,
            &set_root,
        )?;
        let mut components = Vec::new();
        for component in cached_components {
            let model = component
                .component_item_id
                .map(|component_item_id| {
                    build_statistics_price_model(
                        &observatory_connection,
                        component_item_id,
                        "base",
                    )
                })
                .transpose()?
                .flatten();
            let current_lowest_price = model
                .as_ref()
                .and_then(|entry| entry.current_stats_price);
            let recommended_entry_price = model
                .as_ref()
                .and_then(|entry| entry.recommended_entry_price.or(entry.current_stats_price));

            components.push(SetComponentAnalysisEntry {
                item_id: component.component_item_id,
                slug: component.component_slug,
                name: component.component_name,
                image_path: component.component_image_path,
                quantity_in_set: component.quantity_in_set.max(1),
                current_lowest_price,
                recommended_entry_price,
                variant_key: "base".to_string(),
                variant_label: "Base Market".to_string(),
            });
        }

        if components.is_empty() {
            return Ok(ItemSupplyContext {
                mode: "none".to_string(),
                components: Vec::new(),
                drop_sources: Vec::new(),
                confidence_summary: build_confidence_summary(
                    "low",
                    vec!["No cached set components".to_string()],
                ),
            });
        }
        let confidence_summary = build_supply_confidence("set-components", &components, &[]);

        return Ok(ItemSupplyContext {
            mode: "set-components".to_string(),
            components,
            drop_sources: Vec::new(),
            confidence_summary,
        });
    }

    let drop_sources = load_drop_sources(app, item_id)?;
    let mode = if drop_sources.is_empty() {
        "none".to_string()
    } else {
        "drop-sources".to_string()
    };
    let confidence_summary = build_supply_confidence(&mode, &[], &drop_sources);
    Ok(ItemSupplyContext {
        mode: mode.clone(),
        components: Vec::new(),
        drop_sources,
        confidence_summary,
    })
}

fn confidence_percent(confidence: &MarketConfidenceSummary) -> f64 {
    match confidence.level.as_str() {
        "high" => 100.0,
        "medium" => 72.0,
        _ => 44.0,
    }
}

fn build_arbitrage_score(
    gross_margin: Option<f64>,
    roi_pct: Option<f64>,
    liquidity_score: f64,
    component_entries: &[ArbitrageScannerComponentEntry],
    confidence_summary: &MarketConfidenceSummary,
) -> f64 {
    let margin_score = match (
        gross_margin.unwrap_or_default(),
        roi_pct.unwrap_or_default(),
    ) {
        (gross, roi) if gross >= 40.0 || roi >= 35.0 => 100.0,
        (gross, roi) if gross >= 25.0 || roi >= 22.0 => 82.0,
        (gross, roi) if gross >= 15.0 || roi >= 14.0 => 64.0,
        (gross, roi) if gross >= 8.0 || roi >= 8.0 => 46.0,
        (gross, _) if gross > 0.0 => 28.0,
        _ => 0.0,
    };

    let acquisition_score = if component_entries.is_empty() {
        20.0
    } else {
        let total = component_entries
            .iter()
            .map(|entry| {
                let mut score = (confidence_percent(&entry.confidence_summary) * 0.65)
                    + (entry.liquidity_score * 0.25);
                if entry.entry_at_or_below_price {
                    score += 10.0;
                }
                score.clamp(20.0, 100.0)
            })
            .sum::<f64>();
        total / component_entries.len() as f64
    };

    ((margin_score * 0.45)
        + (liquidity_score * 0.3)
        + (acquisition_score * 0.15)
        + (confidence_percent(confidence_summary) * 0.1))
        .clamp(0.0, 100.0)
}

fn build_arbitrage_note(
    priced_component_count: usize,
    total_component_count: usize,
    entry_ready_count: usize,
    sale_state: &str,
    confidence_summary: &MarketConfidenceSummary,
) -> String {
    let mut parts = Vec::new();
    if priced_component_count < total_component_count {
        parts.push(format!(
            "Incomplete component stats ({priced_component_count}/{total_component_count})"
        ));
    }
    if entry_ready_count > 0 {
        parts.push(format!("Entry <= Price on {entry_ready_count} part(s)"));
    }
    parts.push(format!("Set sale state: {sale_state}"));
    if confidence_summary.level != "high" && !confidence_summary.reasons.is_empty() {
        parts.push(confidence_summary.reasons.join(", "));
    }
    parts.join(" · ")
}

fn build_arbitrage_set_entry(
    set_root: &SetRootCatalogRecord,
    set_model: Option<&ScannerPriceModel>,
    component_records: &[CachedSetComponentRecord],
    component_models: &[Option<ScannerPriceModel>],
) -> ArbitrageScannerSetEntry {
    let mut basket_entry_cost = 0.0;
    let mut priced_component_count = 0;
    let mut entry_ready_count = 0;
    let mut components = Vec::new();
    let mut confidence_refs = Vec::new();
    let mut extra_reasons = Vec::new();

    for (component_record, model) in component_records.iter().zip(component_models.iter()) {
        let confidence_summary = model
            .as_ref()
            .map(|entry| entry.confidence_summary.clone())
            .unwrap_or_else(|| build_confidence_summary("low", vec!["Missing stats".to_string()]));
        if let Some(model) = model {
            confidence_refs.push(&model.confidence_summary);
            if let Some(entry_price) = model.recommended_entry_price {
                basket_entry_cost += entry_price * component_record.quantity_in_set as f64;
                priced_component_count += 1;
            }
            if model
                .current_stats_price
                .zip(model.recommended_entry_price)
                .map(|(current, entry)| current <= entry)
                .unwrap_or(false)
            {
                entry_ready_count += 1;
            }
        } else {
            extra_reasons.push("Missing component stats");
        }

        components.push(ArbitrageScannerComponentEntry {
            item_id: component_record.component_item_id,
            slug: component_record.component_slug.clone(),
            name: component_record.component_name.clone(),
            image_path: component_record.component_image_path.clone(),
            quantity_in_set: component_record.quantity_in_set,
            recommended_entry_low: model.as_ref().and_then(|entry| entry.entry_low),
            recommended_entry_high: model.as_ref().and_then(|entry| entry.entry_high),
            recommended_entry_price: model
                .as_ref()
                .and_then(|entry| entry.recommended_entry_price),
            current_stats_price: model.as_ref().and_then(|entry| entry.current_stats_price),
            entry_at_or_below_price: model
                .as_ref()
                .and_then(|entry| {
                    entry
                        .current_stats_price
                        .zip(entry.recommended_entry_price)
                        .map(|(current, recommended)| current <= recommended)
                })
                .unwrap_or(false),
            liquidity_score: model
                .as_ref()
                .map(|entry| entry.liquidity_score)
                .unwrap_or(20.0),
            confidence_summary,
        });
    }

    let fallback_set_confidence =
        build_confidence_summary("low", vec!["Missing set stats".to_string()]);
    let set_confidence = set_model
        .map(|entry| &entry.confidence_summary)
        .unwrap_or(&fallback_set_confidence);
    confidence_refs.push(set_confidence);

    if priced_component_count < component_records.len() {
        extra_reasons.push("Partial set basket");
    }
    let confidence_summary = combined_confidence(&confidence_refs, &extra_reasons);

    let basket_entry_cost =
        if priced_component_count == component_records.len() && !component_records.is_empty() {
            Some(round_platinum(basket_entry_cost))
        } else {
            None
        };
    let recommended_set_exit_price = set_model.and_then(|entry| entry.recommended_exit_price);
    let gross_margin = match (recommended_set_exit_price, basket_entry_cost) {
        (Some(exit), Some(entry)) => Some(round_platinum(exit - entry)),
        _ => None,
    };
    let roi_pct = match (gross_margin, basket_entry_cost) {
        (Some(margin), Some(entry)) if entry > 0.0 => Some(((margin / entry) * 100.0).round()),
        _ => None,
    };
    let liquidity_score = set_model.map(|entry| entry.liquidity_score).unwrap_or(20.0);
    let sale_state = set_model
        .map(|entry| entry.sale_state.clone())
        .unwrap_or_else(|| "Thin".to_string());
    let arbitrage_score = build_arbitrage_score(
        gross_margin,
        roi_pct,
        liquidity_score,
        &components,
        &confidence_summary,
    );
    let note = build_arbitrage_note(
        priced_component_count,
        component_records.len(),
        entry_ready_count,
        &sale_state,
        &confidence_summary,
    );

    ArbitrageScannerSetEntry {
        set_item_id: set_root.item_id,
        slug: set_root.slug.clone(),
        name: set_root.name.clone(),
        image_path: set_root.image_path.clone(),
        component_count: component_records.len(),
        basket_entry_cost,
        set_exit_low: set_model.and_then(|entry| entry.exit_low),
        set_exit_high: set_model.and_then(|entry| entry.exit_high),
        recommended_set_exit_price,
        gross_margin,
        roi_pct,
        liquidity_score,
        arbitrage_score,
        sale_state,
        confidence_summary,
        note,
        components,
    }
}

fn get_or_build_scanner_price_model<C>(
    observatory_connection: &Connection,
    price_model_cache: &mut HashMap<i64, Option<ScannerPriceModel>>,
    item_id: i64,
    slug: &str,
    refreshed_statistics_count: &mut usize,
    mut is_cancelled: C,
) -> Result<Option<ScannerPriceModel>>
where
    C: FnMut() -> bool,
{
    if let Some(existing) = price_model_cache.get(&item_id) {
        return Ok(existing.clone());
    }

    let model = (|| -> Result<Option<ScannerPriceModel>> {
        if ensure_statistics_cached_for_scan(
            observatory_connection,
            item_id,
            slug,
            "base",
            || is_cancelled(),
        )? {
            *refreshed_statistics_count += 1;
        }
        build_statistics_price_model(observatory_connection, item_id, "base")
    })()?;
    price_model_cache.insert(item_id, model.clone());
    Ok(model)
}

fn confidence_score(level: &str) -> f64 {
    match level {
        "high" => 100.0,
        "medium" => 72.0,
        _ => 42.0,
    }
}

fn chance_for_refinement(
    chance_profile: &RelicRefinementChanceProfile,
    refinement_key: &str,
) -> Option<f64> {
    match refinement_key {
        RELIC_REFINEMENT_EXCEPTIONAL => chance_profile.exceptional,
        RELIC_REFINEMENT_FLAWLESS => chance_profile.flawless,
        RELIC_REFINEMENT_RADIANT => chance_profile.radiant,
        _ => chance_profile.intact,
    }
}

fn normalized_relic_chance(chance_percent: f64) -> f64 {
    (chance_percent / 100.0).clamp(0.0, 1.0)
}

fn load_relic_reward_profiles(
    catalog_connection: &Connection,
    relic_item_id: i64,
) -> Result<Vec<RelicRoiDropEntry>> {
    let mut statement = catalog_connection.prepare(
        "SELECT variant_value, raw_json
         FROM wfstat_items
         WHERE item_id = ?1
           AND variant_kind = 'relic_refinement'
         ORDER BY variant_rank ASC, variant_value ASC",
    )?;

    let rows = statement.query_map(params![relic_item_id], |row| {
        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut reward_map = BTreeMap::<String, RelicRoiDropEntry>::new();
    for row in rows {
        let (variant_value, raw_json) = row?;
        let refinement_key = match variant_value
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("exceptional") => RELIC_REFINEMENT_EXCEPTIONAL,
            Some("flawless") => RELIC_REFINEMENT_FLAWLESS,
            Some("radiant") => RELIC_REFINEMENT_RADIANT,
            _ => RELIC_REFINEMENT_INTACT,
        };

        let payload = serde_json::from_str::<serde_json::Value>(&raw_json)
            .context("failed to parse wfstat relic raw json")?;
        let rewards = payload
            .get("rewards")
            .and_then(|value| {
                serde_json::from_value::<Vec<WfstatRelicRewardApi>>(value.clone()).ok()
            })
            .unwrap_or_default();

        for reward in rewards {
            let Some(item) = reward.item else {
                continue;
            };
            let reward_name = item.name.unwrap_or_default();
            let reward_slug = item
                .warframe_market
                .as_ref()
                .and_then(|entry| entry.url_name.clone());
            let Some(reward_slug) = reward_slug else {
                continue;
            };

            let item_id = resolve_item_id_by_slug(catalog_connection, &reward_slug)?;
            let image_path = item_id.and_then(|resolved_item_id| {
                catalog_connection
                    .query_row(
                        "SELECT preferred_image
                             FROM items
                             WHERE item_id = ?1",
                        params![resolved_item_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .flatten()
            });

            let entry =
                reward_map
                    .entry(reward_slug.clone())
                    .or_insert_with(|| RelicRoiDropEntry {
                        item_id,
                        slug: reward_slug.clone(),
                        name: reward_name.clone(),
                        image_path,
                        rarity: reward.rarity.clone(),
                        chance_profile: RelicRefinementChanceProfile::default(),
                        recommended_exit_low: None,
                        recommended_exit_high: None,
                        recommended_exit_price: None,
                        current_stats_price: None,
                        liquidity_score: 20.0,
                        confidence_summary: build_confidence_summary(
                            "low",
                            vec!["Missing stats".to_string()],
                        ),
                    });

            match refinement_key {
                RELIC_REFINEMENT_EXCEPTIONAL => entry.chance_profile.exceptional = reward.chance,
                RELIC_REFINEMENT_FLAWLESS => entry.chance_profile.flawless = reward.chance,
                RELIC_REFINEMENT_RADIANT => entry.chance_profile.radiant = reward.chance,
                _ => entry.chance_profile.intact = reward.chance,
            }
            if entry.rarity.is_none() {
                entry.rarity = reward.rarity.clone();
            }
        }
    }

    Ok(reward_map.into_values().collect())
}

fn resolve_relic_catalog_entry(
    catalog_connection: &Connection,
    relic_tier: &str,
    relic_code: &str,
) -> Result<Option<RelicCatalogEntry>> {
    let tier = relic_tier.trim();
    let code = relic_code.trim();

    let has_relic_columns = catalog_connection
        .prepare("PRAGMA table_info(items)")
        .and_then(|mut statement| {
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.iter().any(|column| column == "relic_tier")
                && rows.iter().any(|column| column == "relic_code"))
        })
        .unwrap_or(false);

    if has_relic_columns {
        let lookup = catalog_connection
            .query_row(
                "SELECT
                   i.item_id,
                   i.wfm_slug,
                   COALESCE(i.preferred_name, i.canonical_name, i.wfm_slug),
                   COALESCE(i.preferred_image, w.thumb, w.icon) AS image_path
                 FROM items i
                 LEFT JOIN wfm_items w ON w.item_id = i.item_id
                 WHERE i.relic_tier = ?1 COLLATE NOCASE
                   AND i.relic_code = ?2 COLLATE NOCASE
                 LIMIT 1",
                params![tier, code],
                |row| {
                    Ok(RelicCatalogEntry {
                        item_id: row.get(0)?,
                        slug: row.get(1)?,
                        name: row.get(2)?,
                        image_path: row.get::<_, Option<String>>(3)?,
                    })
                },
            )
            .optional();

        return match lookup {
            Ok(entry) => Ok(entry),
            Err(error) => {
                eprintln!(
                    "Relic catalog lookup failed for {} {}: {}",
                    tier, code, error
                );
                Ok(None)
            }
        };
    } else {
        let fallback_name = format!("{tier} {code} Relic");
        let lookup = catalog_connection
            .query_row(
                "SELECT
                   i.item_id,
                   i.wfm_slug,
                   COALESCE(i.preferred_name, i.canonical_name, i.wfm_slug),
                   COALESCE(i.preferred_image, w.thumb, w.icon) AS image_path
                 FROM items i
                 LEFT JOIN wfm_items w ON w.item_id = i.item_id
                 WHERE i.preferred_name = ?1 COLLATE NOCASE
                    OR i.canonical_name = ?1 COLLATE NOCASE
                 LIMIT 1",
                params![fallback_name],
                |row| {
                    Ok(RelicCatalogEntry {
                        item_id: row.get(0)?,
                        slug: row.get(1)?,
                        name: row.get(2)?,
                        image_path: row.get::<_, Option<String>>(3)?,
                    })
                },
            )
            .optional();

        match lookup {
            Ok(entry) => Ok(entry),
            Err(error) => {
                eprintln!(
                    "Relic catalog lookup failed for {} {}: {}",
                    tier, code, error
                );
                Ok(None)
            }
        }
    }
}

fn relic_tier_sort_order(value: &str) -> i64 {
    match value.trim().to_ascii_lowercase().as_str() {
        "lith" => 0,
        "meso" => 1,
        "neo" => 2,
        "axi" => 3,
        "requiem" => 4,
        _ => 9,
    }
}

fn build_relic_roi_score(
    run_value: Option<f64>,
    weighted_liquidity: f64,
    confidence_summary: &MarketConfidenceSummary,
) -> f64 {
    let run_value_component = run_value.unwrap_or_default().max(0.0).min(50.0) * 1.5;
    let liquidity_component = weighted_liquidity.clamp(0.0, 100.0) * 0.28;
    let confidence_component = confidence_score(&confidence_summary.level) * 0.18;
    (run_value_component + liquidity_component + confidence_component).clamp(0.0, 100.0)
}

fn build_relic_roi_note(
    drop_count: usize,
    priced_drop_count: usize,
    refinement_label: &str,
    confidence_summary: &MarketConfidenceSummary,
) -> String {
    let mut parts = vec![format!(
        "{priced_drop_count}/{drop_count} priced prime drops at {refinement_label}"
    )];
    if confidence_summary.level != "high" && !confidence_summary.reasons.is_empty() {
        parts.push(confidence_summary.reasons.join(", "));
    }
    parts.join(" · ")
}

fn build_relic_roi_entry<F>(
    catalog_connection: &Connection,
    relic_root: &RelicRootCatalogRecord,
    mut fetch_price_model: F,
) -> Result<Option<RelicRoiEntry>>
where
    F: FnMut(i64, &str, &str) -> Result<Option<ScannerPriceModel>>,
{
    let mut drops = load_relic_reward_profiles(catalog_connection, relic_root.item_id)?;
    if drops.is_empty() {
        return Ok(None);
    }

    let mut entry_confidence_refs = Vec::new();
    for drop in &mut drops {
        let reward_model = match drop.item_id {
            Some(reward_item_id) => fetch_price_model(reward_item_id, &drop.slug, &drop.name)?,
            None => None,
        };
        drop.recommended_exit_low = reward_model.as_ref().and_then(|entry| entry.exit_low);
        drop.recommended_exit_high = reward_model.as_ref().and_then(|entry| entry.exit_high);
        drop.recommended_exit_price = reward_model
            .as_ref()
            .and_then(|entry| entry.recommended_exit_price);
        drop.current_stats_price = reward_model
            .as_ref()
            .and_then(|entry| entry.current_stats_price);
        drop.liquidity_score = reward_model
            .as_ref()
            .map(|entry| entry.liquidity_score)
            .unwrap_or(20.0);
        drop.confidence_summary = reward_model
            .as_ref()
            .map(|entry| entry.confidence_summary.clone())
            .unwrap_or_else(|| build_confidence_summary("low", vec!["Missing stats".to_string()]));
        entry_confidence_refs.push(drop.confidence_summary.clone());
    }

    let confidence_refs = entry_confidence_refs.iter().collect::<Vec<_>>();
    let mut refinement_summaries = Vec::new();

    for refinement_key in all_relic_refinement_keys() {
        let mut run_value = 0.0;
        let mut priced_drop_count = 0usize;
        let mut weighted_liquidity_numerator = 0.0;
        let mut weighted_liquidity_denominator = 0.0;
        let mut extra_reasons = Vec::new();

        for drop in &drops {
            let Some(chance) = chance_for_refinement(&drop.chance_profile, refinement_key) else {
                continue;
            };
            let Some(exit_price) = drop.recommended_exit_price else {
                extra_reasons.push(format!("Missing exit for {}", drop.name));
                continue;
            };

            let expected_contribution = normalized_relic_chance(chance) * exit_price;
            run_value += expected_contribution;
            priced_drop_count += 1;
            weighted_liquidity_numerator += expected_contribution * drop.liquidity_score;
            weighted_liquidity_denominator += expected_contribution;
        }

        let run_value = if priced_drop_count > 0 {
            Some(round_platinum(run_value))
        } else {
            None
        };
        let weighted_liquidity = if weighted_liquidity_denominator > 0.0 {
            (weighted_liquidity_numerator / weighted_liquidity_denominator).clamp(20.0, 100.0)
        } else {
            20.0
        };

        if priced_drop_count < drops.len() {
            extra_reasons.push(format!(
                "Incomplete priced drops ({priced_drop_count}/{})",
                drops.len()
            ));
        }

        let extra_reason_refs = extra_reasons.iter().map(String::as_str).collect::<Vec<_>>();
        let confidence_summary = combined_confidence(&confidence_refs, &extra_reason_refs);
        let note = build_relic_roi_note(
            drops.len(),
            priced_drop_count,
            relic_refinement_label(refinement_key),
            &confidence_summary,
        );
        refinement_summaries.push(RelicRoiRefinementSummary {
            refinement_key: refinement_key.to_string(),
            refinement_label: relic_refinement_label(refinement_key).to_string(),
            run_value,
            liquidity_score: round_platinum(weighted_liquidity),
            relic_roi_score: build_relic_roi_score(run_value, weighted_liquidity, &confidence_summary),
            confidence_summary,
            note,
        });
    }

    let default_confidence = refinement_summaries
        .iter()
        .find(|entry| entry.refinement_key == RELIC_REFINEMENT_INTACT)
        .map(|entry| entry.confidence_summary.clone())
        .unwrap_or_else(|| {
            build_confidence_summary("low", vec!["Missing ROI summary".to_string()])
        });
    let default_note = refinement_summaries
        .iter()
        .find(|entry| entry.refinement_key == RELIC_REFINEMENT_INTACT)
        .map(|entry| entry.note.clone())
        .unwrap_or_else(|| "No intact ROI summary available.".to_string());

    Ok(Some(RelicRoiEntry {
        relic_item_id: relic_root.item_id,
        slug: relic_root.slug.clone(),
        name: relic_root.name.clone(),
        image_path: relic_root.image_path.clone(),
        is_unvaulted: !relic_root.vaulted,
        drop_count: drops.len(),
        confidence_summary: default_confidence,
        note: default_note,
        refinements: refinement_summaries,
        drops,
    }))
}

fn build_arbitrage_scanner_inner(
    app: tauri::AppHandle,
    mut on_progress: impl FnMut(ArbitrageScannerProgress),
) -> Result<ArbitrageScannerRunOutcome> {
    let catalog_connection = open_catalog_database(&app)?;
    let observatory_connection = open_market_observatory_database(&app)?;

    // Resolve the DB path once so prefetch threads can open their own connections
    // without needing the AppHandle (avoids cloning a non-trivial handle per thread).
    let observatory_db_path = resolve_market_observatory_db_path(&app)?;

    // AtomicBool shared with prefetch threads so we can cancel them when the scanner stops.
    let prefetch_stop = Arc::new(AtomicBool::new(false));

    // Tracks which item_ids currently have an in-flight prefetch thread so we never
    // spin up duplicate fetches for the same item.
    let prefetch_in_flight: Arc<Mutex<HashSet<i64>>> = Arc::new(Mutex::new(HashSet::new()));

    // Spawn a one-shot background thread that prefetches statistics for `item_id` into the
    // SQLite cache at Background priority.  When the main loop later reaches that item it
    // finds the cache warm and skips the network call entirely.
    let kick_prefetch = |item_id: i64, slug: String| {
        {
            let mut in_flight = prefetch_in_flight.lock().expect("prefetch_in_flight lock poisoned");
            if in_flight.contains(&item_id) {
                return;
            }
            in_flight.insert(item_id);
        }
        let db_path = observatory_db_path.clone();
        let in_flight_arc = Arc::clone(&prefetch_in_flight);
        let stopped = Arc::clone(&prefetch_stop);
        std::thread::spawn(move || {
            if let Ok(conn) = Connection::open(&db_path) {
                let _ = conn.busy_timeout(Duration::from_secs(30));
                let _ = ensure_statistics_cached_for_scan(
                    &conn,
                    item_id,
                    &slug,
                    "base",
                    || stopped.load(AtomicOrdering::Relaxed),
                );
            }
            in_flight_arc.lock().expect("prefetch_in_flight lock poisoned").remove(&item_id);
        });
    };

    let scanned_sets = load_scanner_sets_from_map(&app, &catalog_connection)?;
    let relic_roots = list_relic_roots_from_catalog(&catalog_connection)?;
    let started_at = format_timestamp(now_utc())?;
    let total_set_count = scanned_sets.len();
    let total_component_count = scanned_sets
        .iter()
        .map(|(_, components)| components.len())
        .sum::<usize>();
    let scanned_component_count = scanned_sets
        .iter()
        .map(|(_, components)| {
            components
                .iter()
                .map(|entry| entry.quantity_in_set.max(1) as usize)
                .sum::<usize>()
        })
        .sum::<usize>();
    let total_task_count = total_set_count + total_component_count + relic_roots.len();

    let mut refreshed_set_count = 0;
    let mut refreshed_statistics_count = 0;
    // Shared across Arbitrage and Relic ROI so each prime item price model is derived once per scan run.
    let mut shared_price_model_cache = HashMap::<i64, Option<ScannerPriceModel>>::new();
    let mut was_stopped = false;
    let mut skipped_entry_count = 0usize;
    let mut skipped_entries = Vec::<ScannerSkippedEntry>::new();
    let mut runtime = ScannerRuntimeProgress {
        total_set_count,
        total_component_count,
        ..Default::default()
    };
    let mut completed_task_count = 0usize;

    emit_running_scanner_progress(
        &mut on_progress,
        &started_at,
        completed_task_count,
        total_task_count,
        &runtime,
        "Preparing",
        format!(
            "Loaded {} sets, {} components, and {} relics for scanner analysis.",
            total_set_count,
            total_component_count,
            relic_roots.len()
        ),
    )?;

    let mut work_queue = VecDeque::<ScannerWorkUnit>::new();
    for (set_root, components) in &scanned_sets {
        work_queue.push_back(ScannerWorkUnit {
            item_id: Some(set_root.item_id),
            slug: set_root.slug.clone(),
            display_name: set_root.name.clone(),
            stage_label: "Scanning Sets",
            current_set_name: Some(set_root.name.clone()),
            current_component_name: None,
            completion_text: format!("Completed set {}", set_root.name),
            kind: ScannerWorkKind::Set,
            attempt: 0,
        });
        for component in components {
            work_queue.push_back(ScannerWorkUnit {
                item_id: component.component_item_id,
                slug: component.component_slug.clone(),
                display_name: component.component_name.clone(),
                stage_label: "Scanning Sets",
                current_set_name: Some(set_root.name.clone()),
                current_component_name: Some(component.component_name.clone()),
                completion_text: format!("Completed component {} for {}", component.component_name, set_root.name),
                kind: ScannerWorkKind::Component,
                attempt: 0,
            });
        }
    }

    while let Some(mut work_unit) = work_queue.pop_front() {
        // Kick background prefetch threads for upcoming items before blocking on the
        // current one.  Each thread fetches statistics into the SQLite cache so the
        // main loop's ensure_statistics_cached_for_scan call returns immediately
        // (cache hit) instead of waiting on the network.  This keeps up to
        // SCANNER_PREFETCH_LOOKAHEAD + 1 concurrent HTTP requests in flight, which
        // saturates the full 3-req/s rate window rather than using only 1 slot at a time.
        for ahead in work_queue.iter().take(SCANNER_PREFETCH_LOOKAHEAD) {
            if let Some(ahead_item_id) = ahead.item_id {
                kick_prefetch(ahead_item_id, ahead.slug.clone());
            }
        }

        if arbitrage_scanner_stop_requested(&observatory_connection)? {
            prefetch_stop.store(true, AtomicOrdering::Relaxed);
            was_stopped = true;
            break;
        }

        runtime.current_set_name = work_unit.current_set_name.clone();
        runtime.current_component_name = work_unit.current_component_name.clone();
        runtime.retrying_item_name = if work_unit.attempt > 0 {
            Some(work_unit.display_name.clone())
        } else {
            None
        };
        runtime.retry_attempt = if work_unit.attempt > 0 {
            Some(work_unit.attempt)
        } else {
            None
        };
        emit_running_scanner_progress(
            &mut on_progress,
            &started_at,
            completed_task_count,
            total_task_count,
            &runtime,
            work_unit.stage_label,
            if let Some(component_name) = &work_unit.current_component_name {
                format!(
                    "Scanning set {} · Component {}",
                    work_unit
                        .current_set_name
                        .as_deref()
                        .unwrap_or("Unknown Set"),
                    component_name
                )
            } else {
                format!(
                    "Scanning set {} ({}/{})",
                    work_unit
                        .current_set_name
                        .as_deref()
                        .unwrap_or(work_unit.display_name.as_str()),
                    runtime.completed_set_count + 1,
                    total_set_count
                )
            },
        )?;

        let item_started = Instant::now();
        let resolution = match work_unit.item_id {
            Some(item_id) => get_or_build_scanner_price_model(
                &observatory_connection,
                &mut shared_price_model_cache,
                item_id,
                &work_unit.slug,
                &mut refreshed_statistics_count,
                || {
                    item_started.elapsed().as_secs() >= SCANNER_ITEM_TOTAL_DEADLINE_SECONDS
                        || arbitrage_scanner_stop_requested(&observatory_connection)
                            .unwrap_or(false)
                },
            ),
            None => Ok(None),
        };

        match resolution {
            Ok(_) => {
                if matches!(work_unit.kind, ScannerWorkKind::Set) {
                    refreshed_set_count += 1;
                    runtime.completed_set_count += 1;
                    runtime.current_component_name = None;
                } else {
                    runtime.completed_component_count += 1;
                }
                completed_task_count += 1;
                runtime.retrying_item_name = None;
                runtime.retry_attempt = None;
                emit_running_scanner_progress(
                    &mut on_progress,
                    &started_at,
                    completed_task_count,
                    total_task_count,
                    &runtime,
                    work_unit.stage_label,
                    format!(
                        "{}. {} item(s) skipped so far.",
                        work_unit.completion_text, runtime.skipped_entry_count
                    ),
                )?;
            }
            Err(error) => {
                let next_attempt = work_unit.attempt + 1;
                if next_attempt < SCANNER_ITEM_MAX_ATTEMPTS {
                    eprintln!(
                        "[scanner] deferring '{}' (item_id={:?}) attempt {}/{} after error: {}",
                        work_unit.slug,
                        work_unit.item_id,
                        next_attempt,
                        SCANNER_ITEM_MAX_ATTEMPTS,
                        error
                    );
                    runtime.retrying_item_name = Some(work_unit.display_name.clone());
                    runtime.retry_attempt = Some(next_attempt);
                    emit_running_scanner_progress(
                        &mut on_progress,
                        &started_at,
                        completed_task_count,
                        total_task_count,
                        &runtime,
                        work_unit.stage_label,
                        format!(
                            "Deferred {} after a temporary failure. It will be retried later ({}/{}).",
                            work_unit.display_name, next_attempt, SCANNER_ITEM_MAX_ATTEMPTS,
                        ),
                    )?;
                    work_unit.attempt = next_attempt;
                    work_queue.push_back(work_unit);
                    continue;
                }

                skipped_entry_count += 1;
                runtime.skipped_entry_count = skipped_entry_count;
                skipped_entries.push(ScannerSkippedEntry {
                    name: work_unit.display_name.clone(),
                    reason: error.to_string(),
                });
                if matches!(work_unit.kind, ScannerWorkKind::Set) {
                    runtime.completed_set_count += 1;
                    runtime.current_component_name = None;
                } else {
                    runtime.completed_component_count += 1;
                }
                completed_task_count += 1;
                runtime.retrying_item_name = None;
                runtime.retry_attempt = None;
                eprintln!(
                    "[scanner] skipped '{}' (item_id={:?}) after {} attempts: {}",
                    work_unit.slug, work_unit.item_id, SCANNER_ITEM_MAX_ATTEMPTS, error
                );
                emit_running_scanner_progress(
                    &mut on_progress,
                    &started_at,
                    completed_task_count,
                    total_task_count,
                    &runtime,
                    work_unit.stage_label,
                    format!(
                        "Skipped {} after {} attempts. {} item(s) skipped so far.",
                        work_unit.display_name, SCANNER_ITEM_MAX_ATTEMPTS, runtime.skipped_entry_count
                    ),
                )?;
            }
        }
    }

    // Prefetch threads are only useful during the sets/components phase.
    // Signal them to exit before the pure-computation relic ROI phase begins.
    prefetch_stop.store(true, AtomicOrdering::Relaxed);

    let mut results = Vec::new();
    for (set_root, components) in &scanned_sets {
        let set_model = shared_price_model_cache
            .get(&set_root.item_id)
            .cloned()
            .flatten();
        let component_models = components
            .iter()
            .map(|component| {
                component
                    .component_item_id
                    .and_then(|item_id| shared_price_model_cache.get(&item_id).cloned().flatten())
            })
            .collect::<Vec<_>>();
        results.push(build_arbitrage_set_entry(
            set_root,
            set_model.as_ref(),
            components,
            &component_models,
        ));
    }

    let relic_roi_results = if was_stopped {
        Vec::new()
    } else {
        let mut relic_entries = Vec::new();
        for (index, relic_root) in relic_roots.iter().enumerate() {
            if arbitrage_scanner_stop_requested(&observatory_connection)? {
                was_stopped = true;
                break;
            }

            runtime.current_set_name = Some(relic_root.name.clone());
            runtime.current_component_name = None;
            runtime.retrying_item_name = None;
            runtime.retry_attempt = None;
            emit_running_scanner_progress(
                &mut on_progress,
                &started_at,
                completed_task_count,
                total_task_count,
                &runtime,
                "Scanning Relics",
                format!(
                    "Scanning relic {} ({}/{})",
                    relic_root.name,
                    index + 1,
                    relic_roots.len()
                ),
            )?;
            match build_relic_roi_entry(&catalog_connection, relic_root, |item_id, slug, name| {
                let _ = slug;
                let _ = name;
                Ok(shared_price_model_cache.get(&item_id).cloned().flatten())
            }) {
                Ok(Some(entry)) => relic_entries.push(entry),
                Ok(None) => {}
                Err(error) => {
                    skipped_entry_count += 1;
                    runtime.skipped_entry_count = skipped_entry_count;
                    skipped_entries.push(ScannerSkippedEntry {
                        name: relic_root.name.clone(),
                        reason: error.to_string(),
                    });
                    eprintln!(
                        "[scanner] failed to process relic '{}' (item_id={}): {}",
                        relic_root.slug, relic_root.item_id, error
                    );
                }
            }
            completed_task_count += 1;
            emit_running_scanner_progress(
                &mut on_progress,
                &started_at,
                completed_task_count,
                total_task_count,
                &runtime,
                "Scanning Relics",
                format!(
                    "Completed relic {} ({}/{}). {} item(s) skipped so far.",
                    relic_root.name,
                    index + 1,
                    relic_roots.len(),
                    runtime.skipped_entry_count
                ),
            )?;
        }

        if was_stopped {
            Vec::new()
        } else {
            relic_entries.sort_by(|left, right| {
                let right_score = right
                    .refinements
                    .iter()
                    .find(|entry| entry.refinement_key == RELIC_REFINEMENT_INTACT)
                    .map(|entry| entry.relic_roi_score)
                    .unwrap_or_default();
                let left_score = left
                    .refinements
                    .iter()
                    .find(|entry| entry.refinement_key == RELIC_REFINEMENT_INTACT)
                    .map(|entry| entry.relic_roi_score)
                    .unwrap_or_default();
                right_score
                    .total_cmp(&left_score)
                    .then_with(|| left.name.cmp(&right.name))
            });
            relic_entries
        }
    };

    results.sort_by(|left, right| {
        right
            .arbitrage_score
            .total_cmp(&left.arbitrage_score)
            .then_with(|| {
                right
                    .gross_margin
                    .unwrap_or_default()
                    .total_cmp(&left.gross_margin.unwrap_or_default())
            })
            .then_with(|| left.name.cmp(&right.name))
    });

    let opportunity_count = results
        .iter()
        .filter(|entry| entry.gross_margin.unwrap_or_default() > 0.0)
        .count();
    let relic_opportunity_count = relic_roi_results
        .iter()
        .filter(|entry| {
            entry
                .refinements
                .iter()
                .find(|summary| summary.refinement_key == RELIC_REFINEMENT_INTACT)
                .and_then(|summary| summary.run_value)
                .unwrap_or_default()
                > 0.0
        })
        .count();

    let computed_at = format_timestamp(now_utc())?;
    let skipped_summary_text = if skipped_entries.is_empty() {
        None
    } else {
        Some(format!(
            "{} scanner entr{} skipped.",
            skipped_entries.len(),
            if skipped_entries.len() == 1 { "y was" } else { "ies were" }
        ))
    };

    Ok(ArbitrageScannerRunOutcome {
        response: ArbitrageScannerResponse {
            computed_at: computed_at.clone(),
            scan_started_at: started_at.clone(),
            scan_finished_at: computed_at.clone(),
            scanned_set_count: scanned_sets.len(),
            scanned_component_count,
            opportunity_count,
            refreshed_set_count,
            refreshed_statistics_count,
            skipped_entry_count,
            skipped_entries,
            skipped_summary_text,
            scanned_relic_count: relic_roi_results.len(),
            relic_opportunity_count,
            results,
            relic_roi_results,
        },
        was_stopped,
        skipped_entry_count,
    })
}

fn build_item_analysis_inner(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
    variant_key: Option<String>,
    seller_mode: Option<String>,
) -> Result<ItemAnalysisResponse> {
    let variant_key = normalize_variant_key(variant_key.as_deref());
    let seller_mode = normalize_seller_mode(seller_mode.as_deref());
    let analytics = build_item_analytics_inner(
        app.clone(),
        item_id,
        slug.clone(),
        Some(variant_key.clone()),
        Some(seller_mode.clone()),
        Some("48h".to_string()),
        Some("1h".to_string()),
    )?;

    let live_orders =
        fetch_filtered_orders(&slug, &variant_key, &seller_mode, RequestPriority::Instant).ok();
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
    let recent_snapshots = recent_snapshots(&connection, item_id, &variant_key, &seller_mode, 12)?;
    let (stats_rows, _, _) = load_chart_statistics_rows(
        &connection,
        item_id,
        &variant_key,
        AnalyticsDomainKey::ThirtyDays,
    )?;

    let manipulation_risk = build_manipulation_risk(&current_snapshot, &recent_snapshots);
    let liquidity_score = liquidity_score_percent(&current_snapshot);
    let liquidity_confidence = build_liquidity_confidence(&current_snapshot, &recent_snapshots);
    let shared_price_model = build_statistics_price_model(&connection, item_id, &variant_key)?;
    let current_floor_price = round_price_option(current_snapshot.lowest_sell);
    let entry_price = resolved_recommended_entry_price(
        shared_price_model
            .as_ref()
            .and_then(|entry| entry.recommended_entry_price),
        current_floor_price,
    );
    let exit_price = round_price_option(recommended_exit_price(
        entry_price,
        &sell_orders,
        &current_snapshot,
        &stats_rows,
        &analytics.entry_exit_zone_overview,
    ));
    let gross_margin = match (
        shared_price_model
            .as_ref()
            .and_then(|entry| entry.recommended_exit_price),
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
    let supply_context = build_supply_context(&app, item_id, &slug, &item_details, &seller_mode)?;
    let headline_confidence = combined_confidence(
        &[
            &analytics.entry_exit_zone_overview.confidence_summary,
            &liquidity_confidence,
            &trend.confidence_summary,
            &manipulation_risk.confidence_summary,
            &supply_context.confidence_summary,
        ],
        &[],
    );
    let flip_confidence = combined_confidence(
        &[
            &analytics.action_card.confidence_summary,
            &liquidity_confidence,
            &manipulation_risk.confidence_summary,
        ],
        &[],
    );

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
            confidence_summary: headline_confidence,
        },
        flip_analysis: FlipAnalysisSummary {
            entry_price,
            exit_price,
            gross_margin,
            net_margin,
            efficiency_score,
            efficiency_label: efficiency_label(efficiency_score),
            confidence_summary: flip_confidence,
        },
        liquidity_detail: LiquidityDetailSummary {
            demand_ratio,
            state: liquidity_state.to_string(),
            sellers_within_two_pt: current_snapshot.near_floor_seller_count,
            undercut_velocity: undercut_velocity_per_hour(&recent_snapshots),
            quantity_weighted_demand,
            liquidity_score: Some(liquidity_score),
            confidence_summary: liquidity_confidence,
        },
        trend,
        manipulation_risk,
        time_of_day_liquidity: build_time_of_day_liquidity(
            &connection,
            item_id,
            &variant_key,
            &seller_mode,
        )?,
        item_details,
        supply_context,
    })
}

fn load_cached_analytics(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    seller_mode: &str,
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
               AND seller_mode = ?3
               AND domain_key = ?4
               AND bucket_size_key = ?5",
            params![
                item_id,
                variant_key,
                seller_mode,
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

    let Some((payload_json, cached_snapshot_at, cached_stats_at, cache_version)) = cached_row
    else {
        return Ok(None);
    };

    if cached_snapshot_at.as_deref() != source_snapshot_at
        || cached_stats_at.as_deref() != source_stats_fetched_at
        || cache_version != ANALYTICS_CACHE_VERSION
    {
        return Ok(None);
    }

    let parsed = serde_json::from_str::<ItemAnalyticsResponse>(&payload_json)
        .context("failed to parse analytics cache payload")?;

    Ok(Some(parsed))
}

fn persist_analytics_cache(
    connection: &Connection,
    response: &ItemAnalyticsResponse,
    seller_mode: &str,
    domain_key: AnalyticsDomainKey,
    bucket_size_key: AnalyticsBucketSizeKey,
) -> Result<()> {
    connection.execute(
        "INSERT INTO analytics_cache (
           item_id,
           slug,
           variant_key,
           seller_mode,
           domain_key,
           bucket_size_key,
           cache_version,
           computed_at,
           payload_json,
           source_snapshot_at,
           source_stats_fetched_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(item_id, variant_key, domain_key, bucket_size_key) DO UPDATE SET
           slug = excluded.slug,
           seller_mode = excluded.seller_mode,
           cache_version = excluded.cache_version,
           computed_at = excluded.computed_at,
           payload_json = excluded.payload_json,
           source_snapshot_at = excluded.source_snapshot_at,
           source_stats_fetched_at = excluded.source_stats_fetched_at",
        params![
            response.item_id,
            response.slug,
            response.variant_key,
            seller_mode,
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
    seller_mode: Option<String>,
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
    let seller_mode = normalize_seller_mode(seller_mode.as_deref());
    let variant_label = derive_variant_label(&variant_key);
    let connection = open_market_observatory_database(&app)?;

    if let Err(error) = fetch_and_cache_statistics(
        &connection,
        item_id,
        &slug,
        &variant_key,
        RequestPriority::Instant,
    ) {
        if !statistics_cache_is_usable(
            &connection,
            item_id,
            &variant_key,
            AnalyticsDomainKey::FortyEightHours,
        )? {
            return Err(error);
        }
    }

    let snapshot =
        maybe_capture_fresh_snapshot(&connection, item_id, &slug, &variant_key, &seller_mode)?;
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
    let (support_closed_rows, _, _) = load_chart_statistics_rows(
        &connection,
        item_id,
        &variant_key,
        AnalyticsDomainKey::ThirtyDays,
    )?;
    let historical_zone_anchors = build_historical_zone_anchors(&support_closed_rows);
    let historical_zone_bands = historical_zone_anchors.as_ref().and_then(|anchors| {
        compute_zone_bands(
            anchors.support_floor.or(anchors.fair_low),
            anchors.fair_high,
            anchors.support_recurrence,
            anchors.fair_center,
        )
    });
    let mut chart_points = merge_snapshot_chart_points(
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
            &seller_mode,
            analytics_domain_key,
            analytics_bucket_size_key,
        )?,
    );
    if let Some(zone_bands) = historical_zone_bands.as_ref() {
        for point in &mut chart_points {
            point.entry_zone = Some(zone_bands.entry_target);
            point.exit_zone = Some(zone_bands.exit_target);
        }
    }
    let latest_stats_fetched_at =
        merge_latest_fetched_at(hourly_stats_fetched_at, chart_stats_fetched_at);
    let source_snapshot_at = Some(snapshot.captured_at.clone());
    if let Some(cached) = load_cached_analytics(
        &connection,
        item_id,
        &variant_key,
        &seller_mode,
        analytics_domain_key,
        analytics_bucket_size_key,
        source_snapshot_at.as_deref(),
        latest_stats_fetched_at.as_deref(),
    )? {
        return Ok(cached);
    }

    let recent_snapshots = recent_snapshots(&connection, item_id, &variant_key, &seller_mode, 12)?;
    let liquidity_confidence = build_liquidity_confidence(&snapshot, &recent_snapshots);
    let manipulation_confidence = build_manipulation_confidence(&recent_snapshots);
    let zone_overview = build_entry_exit_zone_overview(
        Some(&snapshot),
        &trend_points,
        historical_zone_bands.as_ref(),
    );
    let orderbook_pressure = build_orderbook_pressure(Some(&snapshot));
    let trend_quality_breakdown = build_trend_quality_breakdown(&trend_points);
    let action_card = build_action_card(
        &zone_overview,
        &orderbook_pressure,
        &trend_quality_breakdown,
        &liquidity_confidence,
        &manipulation_confidence,
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
        &seller_mode,
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
    tauri::async_runtime::spawn_blocking(move || {
        resolve_variants_from_catalog(&app, item_id, &slug)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_wfm_item_orders(
    slug: String,
    variant_key: Option<String>,
    seller_mode: Option<String>,
    request_priority: Option<String>,
    request_source: Option<String>,
) -> Result<WfmItemOrdersResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let variant_key = normalize_variant_key(variant_key.as_deref());
        let seller_mode = normalize_seller_mode(seller_mode.as_deref());
        let request_priority =
            RequestPriority::from_wire(request_priority.as_deref(), RequestPriority::Instant);
        let request_label = match request_source
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("watchlist") => "request WFM watchlist orders",
            Some("quick-view") => "request WFM quick view orders",
            Some("trades") => "request WFM trade orders",
            _ => "request WFM orders",
        };
        let (api_version, sell_orders, buy_orders, snapshot) =
            fetch_filtered_orders_labeled(
                &slug,
                &variant_key,
                &seller_mode,
                request_priority,
                request_label,
            )?;
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
    seller_mode: Option<String>,
    source: MarketTrackingSource,
) -> Result<MarketSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let variant_key = normalize_variant_key(variant_key.as_deref());
        let seller_mode = normalize_seller_mode(seller_mode.as_deref());
        let variant_label = derive_variant_label(&variant_key);
        let connection = open_market_observatory_database(&app)?;
        let mut sources = get_existing_sources(&connection, item_id, &slug, &variant_key)?;
        sources.insert(source);
        update_tracking_row(
            &connection,
            item_id,
            &slug,
            &variant_key,
            &seller_mode,
            &variant_label,
            &sources,
            true,
            None,
        )?;
        let snapshot =
            capture_tracking_snapshot_with_priority(
                &connection,
                item_id,
                &slug,
                &variant_key,
                &seller_mode,
                RequestPriority::Instant,
            )?;
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
        let seller_mode = get_tracking_seller_mode(&connection, item_id, &slug, &variant_key)?;
        let mut sources = get_existing_sources(&connection, item_id, &slug, &variant_key)?;
        if sources.is_empty() {
            return Ok::<_, anyhow::Error>(());
        }
        sources.remove(&source);
        if !sources.is_empty()
            || latest_snapshot_for_item(&connection, item_id, &variant_key, &seller_mode)?.is_some()
        {
            let _ =
                capture_tracking_snapshot(&connection, item_id, &slug, &variant_key, &seller_mode);
        }
        update_tracking_row(
            &connection,
            item_id,
            &slug,
            &variant_key,
            &seller_mode,
            &variant_label,
            &sources,
            false,
            latest_snapshot_for_item(&connection, item_id, &variant_key, &seller_mode)?
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
pub async fn refresh_market_tracking(
    app: tauri::AppHandle,
    seller_mode: Option<String>,
) -> Result<TrackingRefreshSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_market_observatory_database(&app)?;
        let seller_mode = normalize_seller_mode(seller_mode.as_deref());
        connection.execute(
            "UPDATE tracked_items
             SET seller_mode = ?1
             WHERE is_active = 1
               AND seller_mode <> ?1",
            params![seller_mode],
        )?;
        let mut statement = connection.prepare(
            "SELECT item_id, slug, variant_key, seller_mode
             FROM tracked_items
             WHERE is_active = 1
               AND next_snapshot_at IS NOT NULL
               AND next_snapshot_at <= ?1
             ORDER BY next_snapshot_at ASC
             LIMIT 8",
        )?;
        let now = format_timestamp(now_utc())?;
        let rows = statement.query_map(params![now], |row| {
            let stored_seller_mode = row.get::<_, String>(3)?;
            Ok(TrackingTarget {
                item_id: row.get(0)?,
                slug: row.get(1)?,
                variant_key: row.get(2)?,
                seller_mode: normalize_seller_mode(Some(stored_seller_mode.as_str())),
            })
        })?;
        let targets = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        let due_items = targets.len();
        let mut refreshed_items = 0;

        for target in targets {
            if capture_tracking_snapshot(
                &connection,
                target.item_id,
                &target.slug,
                &target.variant_key,
                &target.seller_mode,
            )
            .is_ok()
            {
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
    seller_mode: Option<String>,
    domain_key: Option<String>,
    bucket_size_key: Option<String>,
) -> Result<ItemAnalyticsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_item_analytics_inner(
            app,
            item_id,
            slug,
            variant_key,
            seller_mode,
            domain_key,
            bucket_size_key,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_item_detail_summary(
    app: tauri::AppHandle,
    item_id: i64,
    slug: String,
) -> Result<ItemDetailSummary, String> {
    tauri::async_runtime::spawn_blocking(move || load_item_detail_summary(&app, item_id, &slug))
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
    seller_mode: Option<String>,
) -> Result<ItemAnalysisResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_item_analysis_inner(app, item_id, slug, variant_key, seller_mode)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_arbitrage_scanner(
    app: tauri::AppHandle,
) -> Result<ArbitrageScannerResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_arbitrage_scanner_inner(app, |_| {}).map(|outcome| outcome.response)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_arbitrage_scanner_state(
    app: tauri::AppHandle,
) -> Result<ArbitrageScannerState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_market_observatory_database(&app)?;
        load_arbitrage_scanner_state(&connection)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_set_completion_owned_items(
    app: tauri::AppHandle,
) -> Result<Vec<SetCompletionOwnedItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_market_observatory_database(&app)?;
        load_set_completion_owned_items(&connection)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_set_completion_owned_item_quantity(
    app: tauri::AppHandle,
    item_id: Option<i64>,
    slug: String,
    name: String,
    image_path: Option<String>,
    quantity: i64,
) -> Result<Vec<SetCompletionOwnedItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_market_observatory_database(&app)?;
        upsert_set_completion_owned_item(
            &connection,
            item_id,
            &slug,
            &name,
            image_path.as_deref(),
            quantity,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[derive(Debug, Clone)]
struct OwnedRelicCacheRow {
    tier: String,
    code: String,
    counts: OwnedRelicRefinementCounts,
}

fn fetch_owned_relic_inventory_rows(
    app: &tauri::AppHandle,
) -> Result<Vec<OwnedRelicCacheRow>> {
    let settings = settings::load_settings_inner(app)?;
    if !settings.alecaframe.enabled {
        return Err(anyhow!("Enable Alecaframe API in Settings first."));
    }

    let public_link = settings
        .alecaframe
        .public_link
        .ok_or_else(|| anyhow!("No Alecaframe public link is saved."))?;
    let public_token = settings::extract_public_token(&public_link)
        .ok_or_else(|| anyhow!("Could not extract a public token from the Alecaframe link."))?;
    let inventory = settings::fetch_alecaframe_relic_inventory(&public_token)?;

    let mut aggregates = BTreeMap::<(String, String), OwnedRelicRefinementCounts>::new();
    for entry in inventory {
        let key = (entry.tier.clone(), entry.code.clone());
        let counts = aggregates.entry(key).or_insert_with(|| OwnedRelicRefinementCounts {
            intact: 0,
            exceptional: 0,
            flawless: 0,
            radiant: 0,
            total: 0,
        });

        match entry.refinement.as_str() {
            RELIC_REFINEMENT_INTACT => counts.intact += entry.count,
            RELIC_REFINEMENT_EXCEPTIONAL => counts.exceptional += entry.count,
            RELIC_REFINEMENT_FLAWLESS => counts.flawless += entry.count,
            RELIC_REFINEMENT_RADIANT => counts.radiant += entry.count,
            _ => {
                return Err(anyhow!(
                    "Unsupported relic refinement value: {}",
                    entry.refinement
                ));
            }
        }
    }

    let mut rows = Vec::new();
    for ((tier, code), mut counts) in aggregates {
        counts.total = counts
            .intact
            .saturating_add(counts.exceptional)
            .saturating_add(counts.flawless)
            .saturating_add(counts.radiant);
        rows.push(OwnedRelicCacheRow { tier, code, counts });
    }

    rows.sort_by(|left, right| {
        let tier_cmp =
            relic_tier_sort_order(&left.tier).cmp(&relic_tier_sort_order(&right.tier));
        if tier_cmp != Ordering::Equal {
            return tier_cmp;
        }
        left.code.cmp(&right.code)
    });

    Ok(rows)
}

fn load_owned_relic_inventory_cache(
    app: &tauri::AppHandle,
    connection: &Connection,
) -> Result<OwnedRelicInventoryCache> {
    let updated_at = connection
        .query_row(
            "SELECT updated_at
             FROM owned_relic_inventory_meta
             WHERE cache_key = 'owned_relic_inventory'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("failed to load owned relic inventory cache timestamp")?;

    let mut statement = connection.prepare(
        "SELECT relic_tier,
                relic_code,
                intact_count,
                exceptional_count,
                flawless_count,
                radiant_count,
                total_count
         FROM owned_relic_inventory_cache
         ORDER BY relic_tier ASC, relic_code ASC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(OwnedRelicCacheRow {
                tier: row.get(0)?,
                code: row.get(1)?,
                counts: OwnedRelicRefinementCounts {
                    intact: row.get::<_, i64>(2)?.max(0) as u32,
                    exceptional: row.get::<_, i64>(3)?.max(0) as u32,
                    flawless: row.get::<_, i64>(4)?.max(0) as u32,
                    radiant: row.get::<_, i64>(5)?.max(0) as u32,
                    total: row.get::<_, i64>(6)?.max(0) as u32,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to read owned relic inventory cache")?;

    let catalog_connection = open_catalog_database(app)?;
    let mut entries = Vec::new();
    for row in rows {
        let catalog_entry = resolve_relic_catalog_entry(&catalog_connection, &row.tier, &row.code)?;
        let (relic_item_id, slug, name, image_path) = match catalog_entry {
            Some(entry) => (
                Some(entry.item_id),
                Some(entry.slug),
                entry.name,
                entry.image_path,
            ),
            None => (None, None, format!("{} {} Relic", row.tier, row.code), None),
        };

        let drops = if let Some(item_id) = relic_item_id {
            load_relic_reward_profiles(&catalog_connection, item_id)?
                .into_iter()
                .map(|drop| OwnedRelicDropEntry {
                    item_id: drop.item_id,
                    slug: drop.slug,
                    name: drop.name,
                    image_path: drop.image_path,
                    rarity: drop.rarity,
                })
                .collect()
        } else {
            Vec::new()
        };

        entries.push(OwnedRelicEntry {
            relic_item_id,
            slug,
            name,
            tier: row.tier,
            code: row.code,
            image_path,
            counts: row.counts,
            drops,
        });
    }

    Ok(OwnedRelicInventoryCache { entries, updated_at })
}

fn save_owned_relic_inventory_cache(
    connection: &mut Connection,
    rows: &[OwnedRelicCacheRow],
    updated_at: &str,
) -> Result<()> {
    let transaction = connection
        .transaction()
        .context("failed to start owned relic cache transaction")?;
    transaction
        .execute("DELETE FROM owned_relic_inventory_cache", [])
        .context("failed to clear owned relic cache")?;
    {
        let mut insert = transaction.prepare(
            "INSERT INTO owned_relic_inventory_cache (
              relic_tier,
              relic_code,
              intact_count,
              exceptional_count,
              flawless_count,
              radiant_count,
              total_count,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for row in rows {
            insert.execute(params![
                row.tier,
                row.code,
                row.counts.intact as i64,
                row.counts.exceptional as i64,
                row.counts.flawless as i64,
                row.counts.radiant as i64,
                row.counts.total as i64,
                updated_at,
            ])?;
        }
    }
    transaction.execute(
        "INSERT INTO owned_relic_inventory_meta (cache_key, updated_at)
         VALUES ('owned_relic_inventory', ?1)
         ON CONFLICT(cache_key) DO UPDATE SET updated_at = excluded.updated_at",
        params![updated_at],
    )?;
    transaction.commit().context("failed to save owned relic cache")?;
    Ok(())
}

#[tauri::command]
pub async fn get_owned_relic_inventory_cache(
    app: tauri::AppHandle,
) -> Result<OwnedRelicInventoryCache, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_market_observatory_database(&app)?;
        load_owned_relic_inventory_cache(&app, &connection)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn refresh_owned_relic_inventory(
    app: tauri::AppHandle,
) -> Result<OwnedRelicInventoryCache, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = open_market_observatory_database(&app)?;
        let rows = fetch_owned_relic_inventory_rows(&app)?;
        let updated_at = format_timestamp(now_utc())?;
        save_owned_relic_inventory_cache(&mut connection, &rows, &updated_at)?;
        load_owned_relic_inventory_cache(&app, &connection)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn start_arbitrage_scanner(app: tauri::AppHandle) -> Result<bool, String> {
    let state_connection =
        open_market_observatory_database(&app).map_err(|error| error.to_string())?;
    let current_state =
        load_arbitrage_scanner_state(&state_connection).map_err(|error| error.to_string())?;
    if current_state.progress.status == "running" {
        return Ok(false);
    }

    let started_at = format_timestamp(now_utc()).map_err(|error| error.to_string())?;
    let initial_progress = ArbitrageScannerProgress {
        scanner_key: ARBITRAGE_SCANNER_KEY.to_string(),
        status: "running".to_string(),
        progress_value: 0.0,
        stage_label: "Queued".to_string(),
        status_text: "Arbitrage scan queued.".to_string(),
        updated_at: started_at.clone(),
        started_at: Some(started_at.clone()),
        last_completed_at: current_state.progress.last_completed_at.clone(),
        last_error: None,
        current_set_name: None,
        current_component_name: None,
        completed_set_count: 0,
        total_set_count: 0,
        completed_component_count: 0,
        total_component_count: 0,
        skipped_entry_count: 0,
        retrying_item_name: None,
        retry_attempt: None,
    };
    persist_arbitrage_scanner_progress_with_stop_reset(&state_connection, &initial_progress, true)
        .map_err(|error| error.to_string())?;
    emit_arbitrage_scanner_progress(&app, &initial_progress);

    let worker_app = app.clone();
    let _ = std::thread::Builder::new()
        .name("warstonks-arbitrage-scanner".to_string())
        .spawn(move || {
        let progress_connection = match open_market_observatory_database(&worker_app) {
            Ok(connection) => connection,
            Err(_) => return,
        };
        let live_progress = Arc::new(Mutex::new(initial_progress.clone()));
        let heartbeat_stop = Arc::new(AtomicBool::new(false));
        let heartbeat_progress = Arc::clone(&live_progress);
        let heartbeat_stop_flag = Arc::clone(&heartbeat_stop);
        let heartbeat_app = worker_app.clone();
        let heartbeat_handle = std::thread::Builder::new()
            .name("warstonks-arbitrage-scanner-heartbeat".to_string())
            .spawn(move || {
                let heartbeat_connection = match open_market_observatory_database(&heartbeat_app) {
                    Ok(connection) => connection,
                    Err(_) => return,
                };
                while !heartbeat_stop_flag.load(AtomicOrdering::Relaxed) {
                    std::thread::sleep(Duration::from_secs(ARBITRAGE_SCANNER_HEARTBEAT_SECONDS));
                    if heartbeat_stop_flag.load(AtomicOrdering::Relaxed) {
                        break;
                    }

                    let mut progress = match heartbeat_progress.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => break,
                    };
                    if progress.status != "running" {
                        continue;
                    }
                    progress.updated_at = format_timestamp(now_utc())
                        .unwrap_or_else(|_| progress.updated_at.clone());
                    let _ = persist_arbitrage_scanner_progress(&heartbeat_connection, &progress);
                    emit_arbitrage_scanner_progress(&heartbeat_app, &progress);
                    if let Ok(mut guard) = heartbeat_progress.lock() {
                        *guard = progress;
                    }
                }
            })
            .ok();
        let emit_progress = |progress: ArbitrageScannerProgress,
                             connection: &Connection,
                             app: &tauri::AppHandle| {
            if let Ok(mut guard) = live_progress.lock() {
                *guard = progress.clone();
            }
            let _ = persist_arbitrage_scanner_progress(connection, &progress);
            emit_arbitrage_scanner_progress(app, &progress);
        };

        let run_result = build_arbitrage_scanner_inner(worker_app.clone(), |progress| {
            emit_progress(progress, &progress_connection, &worker_app);
        });

        match run_result {
            Ok(outcome) => {
                if outcome.was_stopped {
                    let progress = ArbitrageScannerProgress {
                        scanner_key: ARBITRAGE_SCANNER_KEY.to_string(),
                        status: "idle".to_string(),
                        progress_value: 0.0,
                        stage_label: "Stopped".to_string(),
                        status_text: "Arbitrage scan stopped.".to_string(),
                        updated_at: outcome.response.computed_at.clone(),
                        started_at: Some(started_at.clone()),
                        last_completed_at: current_state.progress.last_completed_at.clone(),
                        last_error: None,
                        current_set_name: None,
                        current_component_name: None,
                        completed_set_count: outcome.response.scanned_set_count.min(
                            outcome.response.results.len(),
                        ),
                        total_set_count: outcome.response.scanned_set_count,
                        completed_component_count: 0,
                        total_component_count: outcome.response.scanned_component_count,
                        skipped_entry_count: outcome.skipped_entry_count,
                        retrying_item_name: None,
                        retry_attempt: None,
                    };
                    if let Ok(mut guard) = live_progress.lock() {
                        *guard = progress.clone();
                    }
                    let _ = persist_arbitrage_scanner_progress_with_stop_reset(
                        &progress_connection,
                        &progress,
                        true,
                    );
                    emit_arbitrage_scanner_progress(&worker_app, &progress);
                    heartbeat_stop.store(true, AtomicOrdering::Relaxed);
                    if let Some(handle) = heartbeat_handle {
                        let _ = handle.join();
                    }
                    return;
                }

                let response = outcome.response;
                let skipped_entry_count = outcome.skipped_entry_count;
                let _ = persist_arbitrage_scanner_cache(&progress_connection, &response);
                let progress = ArbitrageScannerProgress {
                    scanner_key: ARBITRAGE_SCANNER_KEY.to_string(),
                    status: "success".to_string(),
                    progress_value: 100.0,
                    stage_label: "Complete".to_string(),
                    status_text: format!(
                        "Scanned {} sets and {} relics. {} set opportunities and {} positive relic ROI entries{}.",
                        response.scanned_set_count,
                        response.scanned_relic_count,
                        response.opportunity_count,
                        response.relic_opportunity_count,
                        if skipped_entry_count > 0 {
                            format!(" ({skipped_entry_count} entries skipped)")
                        } else {
                            String::new()
                        }
                    ),
                    updated_at: response.computed_at.clone(),
                    started_at: Some(started_at.clone()),
                    last_completed_at: Some(response.computed_at.clone()),
                    last_error: None,
                    current_set_name: None,
                    current_component_name: None,
                    completed_set_count: response.scanned_set_count,
                    total_set_count: response.scanned_set_count,
                    completed_component_count: total_component_count_from_response(&response),
                    total_component_count: total_component_count_from_response(&response),
                    skipped_entry_count,
                    retrying_item_name: None,
                    retry_attempt: None,
                };
                if let Ok(mut guard) = live_progress.lock() {
                    *guard = progress.clone();
                }
                let _ = persist_arbitrage_scanner_progress_with_stop_reset(
                    &progress_connection,
                    &progress,
                    true,
                );
                emit_arbitrage_scanner_progress(&worker_app, &progress);
            }
            Err(error) => {
                let updated_at = format_timestamp(now_utc()).unwrap_or_else(|_| started_at.clone());
                let progress = ArbitrageScannerProgress {
                    scanner_key: ARBITRAGE_SCANNER_KEY.to_string(),
                    status: "error".to_string(),
                    progress_value: current_state.progress.progress_value,
                    stage_label: "Failed".to_string(),
                    status_text: "Arbitrage scan failed.".to_string(),
                    updated_at,
                    started_at: Some(started_at.clone()),
                    last_completed_at: current_state.progress.last_completed_at.clone(),
                    last_error: Some(error.to_string()),
                    current_set_name: None,
                    current_component_name: None,
                    completed_set_count: current_state.progress.completed_set_count,
                    total_set_count: current_state.progress.total_set_count,
                    completed_component_count: current_state.progress.completed_component_count,
                    total_component_count: current_state.progress.total_component_count,
                    skipped_entry_count: current_state.progress.skipped_entry_count,
                    retrying_item_name: None,
                    retry_attempt: None,
                };
                if let Ok(mut guard) = live_progress.lock() {
                    *guard = progress.clone();
                }
                let _ = persist_arbitrage_scanner_progress_with_stop_reset(
                    &progress_connection,
                    &progress,
                    true,
                );
                emit_arbitrage_scanner_progress(&worker_app, &progress);
            }
        }
        heartbeat_stop.store(true, AtomicOrdering::Relaxed);
        if let Some(handle) = heartbeat_handle {
            let _ = handle.join();
        }
    });

    Ok(true)
}

#[tauri::command]
pub async fn stop_arbitrage_scanner(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_market_observatory_database(&app)?;
        let stopped = request_arbitrage_scanner_stop(&connection)?;
        if stopped {
            let progress = load_arbitrage_scanner_progress(&connection)?;
            emit_arbitrage_scanner_progress(&app, &progress);
        }
        Ok::<_, anyhow::Error>(stopped)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        build_action_card, build_confidence_summary, build_entry_exit_zone_overview,
        build_liquidity_confidence, build_manipulation_risk, build_market_snapshot,
        build_orderbook_pressure, build_relic_roi_score, build_supply_confidence,
        build_time_of_day_liquidity, build_trend_quality_breakdown, chance_for_refinement,
        compute_pressure_ratio,
        compute_zone_bands, extract_rank_stat_highlights, initialize_market_observatory_schema,
        insert_statistics_rows_for_domain, normalize_variant_key, persist_snapshot,
        pressure_label, resample_rows, scoped_wfm_coalesce_key,
        stale_arbitrage_scanner_progress, AnalyticsBucketSizeKey, AnalyticsChartPoint,
        AnalyticsDomainKey, ArbitrageScannerProgress, InternalStatsRow, MarketConfidenceSummary,
        MarketSnapshot, RelicRefinementChanceProfile, WfmDetailedOrder, WfmStatisticsRowApi,
    };
    use crate::wfm_scheduler::RequestPriority;
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
    fn marks_stale_arbitrage_scan_as_error() {
        let stale_progress = ArbitrageScannerProgress {
            scanner_key: "arbitrage".to_string(),
            status: "running".to_string(),
            progress_value: 42.0,
            stage_label: "Scanning".to_string(),
            status_text: "Scanning stalled".to_string(),
            updated_at: super::format_timestamp(super::now_utc() - super::TimeDuration::minutes(3))
                .unwrap(),
            started_at: None,
            last_completed_at: None,
            last_error: None,
            current_set_name: Some("Example Set".to_string()),
            current_component_name: Some("Example Component".to_string()),
            completed_set_count: 1,
            total_set_count: 10,
            completed_component_count: 2,
            total_component_count: 40,
            skipped_entry_count: 0,
            retrying_item_name: Some("Example Component".to_string()),
            retry_attempt: Some(1),
        };

        let normalized = stale_arbitrage_scanner_progress(&stale_progress)
            .expect("stale progress check should succeed")
            .expect("stale running scan should be reset");

        assert_eq!(normalized.status, "error");
        assert_eq!(normalized.stage_label, "Interrupted");
        assert_eq!(
            normalized.last_error.as_deref(),
            Some("Previous background scan became stale.")
        );
        assert_eq!(normalized.current_set_name.as_deref(), Some("Example Set"));
        assert_eq!(
            normalized.current_component_name.as_deref(),
            Some("Example Component")
        );
        assert_eq!(normalized.retrying_item_name, None);
        assert_eq!(normalized.retry_attempt, None);
    }

    #[test]
    fn preserves_scanner_stop_request_during_running_progress_updates() {
        let connection = Connection::open_in_memory().expect("in-memory connection");
        initialize_market_observatory_schema(&connection).expect("schema");

        let running_progress = ArbitrageScannerProgress {
            scanner_key: "arbitrage".to_string(),
            status: "running".to_string(),
            progress_value: 12.0,
            stage_label: "Scanning".to_string(),
            status_text: "Scanning components".to_string(),
            updated_at: super::format_timestamp(super::now_utc()).unwrap(),
            started_at: None,
            last_completed_at: None,
            last_error: None,
            current_set_name: Some("Akgmagnus Prime Set".to_string()),
            current_component_name: Some("Akmagnus Prime Barrel".to_string()),
            completed_set_count: 0,
            total_set_count: 10,
            completed_component_count: 1,
            total_component_count: 40,
            skipped_entry_count: 0,
            retrying_item_name: None,
            retry_attempt: None,
        };

        super::persist_arbitrage_scanner_progress_with_stop_reset(&connection, &running_progress, true)
            .expect("initial progress");
        super::request_arbitrage_scanner_stop(&connection).expect("request stop");

        let updated_progress = ArbitrageScannerProgress {
            progress_value: 18.0,
            status_text: "Scanning next component".to_string(),
            updated_at: super::format_timestamp(super::now_utc()).unwrap(),
            completed_component_count: 2,
            ..running_progress
        };
        super::persist_arbitrage_scanner_progress(&connection, &updated_progress)
            .expect("heartbeat progress");

        assert!(super::arbitrage_scanner_stop_requested(&connection).expect("stop requested"));
    }

    fn sample_snapshot(captured_at: &str) -> MarketSnapshot {
        MarketSnapshot {
            captured_at: captured_at.to_string(),
            lowest_sell: Some(58.0),
            median_sell: Some(63.0),
            highest_buy: Some(56.0),
            spread: Some(2.0),
            spread_pct: Some(3.4),
            sell_order_count: 8,
            sell_quantity: 24,
            buy_order_count: 5,
            buy_quantity: 18,
            near_floor_seller_count: 3,
            near_floor_quantity: 8,
            unique_sell_users: 6,
            unique_buy_users: 4,
            pressure_ratio: Some(1.08),
            entry_depth: 18.0,
            exit_depth: 12.0,
            depth_levels: vec![],
        }
    }

    #[test]
    fn normalizes_variant_key_defaults_to_base() {
        assert_eq!(normalize_variant_key(None), "base");
        assert_eq!(normalize_variant_key(Some("  ")), "base");
        assert_eq!(normalize_variant_key(Some("rank:5")), "rank:5");
    }

    #[test]
    fn scopes_coalesce_keys_by_priority() {
        assert_eq!(
            scoped_wfm_coalesce_key("orders", RequestPriority::Instant, "wisp_prime_set"),
            "orders:instant:wisp_prime_set"
        );
        assert_eq!(
            scoped_wfm_coalesce_key("statistics", RequestPriority::Low, "wisp_prime_set"),
            "statistics:low:wisp_prime_set"
        );
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
    fn merge_snapshot_chart_points_overwrites_latest_bucket_with_live_snapshot_values() {
        let stats_points = vec![
            AnalyticsChartPoint {
                bucket_at: "2026-03-11T00:00:00Z".to_string(),
                open_price: Some(20.0),
                closed_price: Some(21.0),
                low_price: Some(20.0),
                high_price: Some(28.0),
                lowest_sell: Some(20.0),
                median_sell: Some(28.0),
                moving_avg: Some(22.0),
                weighted_avg: Some(23.0),
                average_price: Some(24.0),
                highest_buy: Some(18.0),
                fair_value_low: Some(19.0),
                fair_value_high: Some(25.0),
                entry_zone: Some(20.0),
                exit_zone: Some(24.0),
                volume: 10.0,
            },
        ];
        let snapshot_points = vec![AnalyticsChartPoint {
            bucket_at: "2026-03-11T00:00:00Z".to_string(),
            open_price: Some(20.0),
            closed_price: Some(20.0),
            low_price: Some(20.0),
            high_price: Some(22.0),
            lowest_sell: Some(20.0),
            median_sell: Some(21.0),
            moving_avg: None,
            weighted_avg: None,
            average_price: Some(21.0),
            highest_buy: Some(19.0),
            fair_value_low: None,
            fair_value_high: None,
            entry_zone: None,
            exit_zone: None,
            volume: 0.0,
        }];

        let merged = super::merge_snapshot_chart_points(stats_points, snapshot_points);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].median_sell, Some(28.0));
        assert_eq!(merged[0].lowest_sell, Some(20.0));
        assert_eq!(merged[0].highest_buy, Some(19.0));
        assert_eq!(merged[0].fair_value_high, Some(25.0));
    }

    #[test]
    fn filter_variant_statistics_rows_treats_rank_zero_as_base_market() {
        let rows = vec![
            WfmStatisticsRowApi {
                datetime: "2026-03-11T00:00:00Z".to_string(),
                volume: Some(1.0),
                min_price: Some(10.0),
                max_price: Some(12.0),
                open_price: Some(10.0),
                closed_price: Some(11.0),
                avg_price: Some(11.0),
                wa_price: Some(11.0),
                median: Some(11.0),
                moving_avg: Some(11.0),
                donch_top: None,
                donch_bot: None,
                order_type: Some("sell".to_string()),
                mod_rank: Some(0),
            },
            WfmStatisticsRowApi {
                datetime: "2026-03-11T01:00:00Z".to_string(),
                volume: Some(1.0),
                min_price: Some(20.0),
                max_price: Some(22.0),
                open_price: Some(20.0),
                closed_price: Some(21.0),
                avg_price: Some(21.0),
                wa_price: Some(21.0),
                median: Some(21.0),
                moving_avg: Some(21.0),
                donch_top: None,
                donch_bot: None,
                order_type: Some("sell".to_string()),
                mod_rank: Some(2),
            },
        ];

        let filtered_base = super::filter_variant_statistics_rows(rows.clone(), "base");
        let filtered_rank_two = super::filter_variant_statistics_rows(rows, "rank:2");

        assert_eq!(filtered_base.len(), 1);
        assert_eq!(filtered_base[0].mod_rank, Some(0));
        assert_eq!(filtered_rank_two.len(), 1);
        assert_eq!(filtered_rank_two[0].mod_rank, Some(2));
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

        let zone = build_entry_exit_zone_overview(Some(&snapshot), &points, None);
        let pressure = build_orderbook_pressure(Some(&snapshot));
        let trend = build_trend_quality_breakdown(&points);
        let action = build_action_card(
            &zone,
            &pressure,
            &trend,
            &build_confidence_summary("high", Vec::new()),
            &build_confidence_summary("high", Vec::new()),
            Some(&snapshot),
        );

        assert_eq!(pressure.pressure_label, "Entry Pressure");
        assert!(!action.suggested_action.is_empty());
        assert!(!zone.zone_quality.is_empty());
    }

    #[test]
    fn computes_integer_zone_bands_inside_the_historical_range() {
        let zone =
            compute_zone_bands(Some(55.0), Some(70.0), Some(58.0), Some(63.0)).expect("zone bands");

        assert_eq!(zone.entry_low, 55.0);
        assert_eq!(zone.entry_high, 58.0);
        assert_eq!(zone.exit_low, 67.0);
        assert_eq!(zone.exit_high, 70.0);
        assert_eq!(zone.entry_target, 57.0);
        assert_eq!(zone.exit_target, 69.0);
    }

    #[test]
    fn keeps_entry_zone_from_climbing_too_high_when_market_bias_rises() {
        let zone =
            compute_zone_bands(Some(55.0), Some(70.0), Some(60.0), Some(66.0)).expect("zone bands");

        assert_eq!(zone.entry_low, 57.0);
        assert_eq!(zone.entry_high, 60.0);
        assert_eq!(zone.exit_low, 67.0);
        assert_eq!(zone.exit_high, 70.0);
    }

    #[test]
    fn downgrades_zone_quality_when_history_is_sparse() {
        let snapshot = sample_snapshot("2026-03-11T00:00:00Z");
        let points = vec![AnalyticsChartPoint {
            bucket_at: "2026-03-11T00:00:00Z".to_string(),
            open_price: Some(58.0),
            closed_price: Some(59.0),
            low_price: Some(58.0),
            high_price: Some(63.0),
            lowest_sell: Some(58.0),
            median_sell: Some(60.0),
            moving_avg: Some(59.0),
            weighted_avg: Some(60.0),
            average_price: Some(59.5),
            highest_buy: Some(56.0),
            fair_value_low: Some(57.0),
            fair_value_high: Some(61.0),
            entry_zone: Some(58.0),
            exit_zone: Some(60.0),
            volume: 6.0,
        }];

        let zone = build_entry_exit_zone_overview(Some(&snapshot), &points, None);

        assert_eq!(zone.zone_quality, "Watch");
        assert_eq!(zone.confidence_summary.level, "low");
    }

    #[test]
    fn downgrades_trend_confidence_when_hourly_history_is_sparse() {
        let points = vec![
            AnalyticsChartPoint {
                bucket_at: "2026-03-11T00:00:00Z".to_string(),
                open_price: Some(60.0),
                closed_price: Some(60.0),
                low_price: Some(60.0),
                high_price: Some(61.0),
                lowest_sell: Some(60.0),
                median_sell: Some(61.0),
                moving_avg: Some(60.5),
                weighted_avg: Some(60.7),
                average_price: Some(60.6),
                highest_buy: Some(58.0),
                fair_value_low: Some(59.0),
                fair_value_high: Some(62.0),
                entry_zone: Some(59.0),
                exit_zone: Some(61.0),
                volume: 4.0,
            },
            AnalyticsChartPoint {
                bucket_at: "2026-03-11T01:00:00Z".to_string(),
                open_price: Some(60.0),
                closed_price: Some(60.1),
                low_price: Some(60.0),
                high_price: Some(61.1),
                lowest_sell: Some(60.0),
                median_sell: Some(61.0),
                moving_avg: Some(60.5),
                weighted_avg: Some(60.7),
                average_price: Some(60.6),
                highest_buy: Some(58.0),
                fair_value_low: Some(59.0),
                fair_value_high: Some(62.0),
                entry_zone: Some(59.0),
                exit_zone: Some(61.0),
                volume: 4.0,
            },
        ];

        let breakdown = build_trend_quality_breakdown(&points);

        assert_eq!(breakdown.confidence_summary.level, "low");
    }

    #[test]
    fn liquidity_confidence_respects_tape_depth() {
        let base_time = super::now_utc() - time::Duration::hours(7);
        let snapshot = sample_snapshot(
            &super::format_timestamp(base_time + time::Duration::hours(7)).expect("timestamp"),
        );
        let sparse_confidence = build_liquidity_confidence(&snapshot, &[snapshot.clone()]);
        let dense_history = vec![
            sample_snapshot(&super::format_timestamp(base_time).expect("timestamp")),
            sample_snapshot(
                &super::format_timestamp(base_time + time::Duration::hours(1)).expect("timestamp"),
            ),
            sample_snapshot(
                &super::format_timestamp(base_time + time::Duration::hours(2)).expect("timestamp"),
            ),
            sample_snapshot(
                &super::format_timestamp(base_time + time::Duration::hours(3)).expect("timestamp"),
            ),
            sample_snapshot(
                &super::format_timestamp(base_time + time::Duration::hours(4)).expect("timestamp"),
            ),
            sample_snapshot(
                &super::format_timestamp(base_time + time::Duration::hours(5)).expect("timestamp"),
            ),
            sample_snapshot(
                &super::format_timestamp(base_time + time::Duration::hours(6)).expect("timestamp"),
            ),
            sample_snapshot(
                &super::format_timestamp(base_time + time::Duration::hours(7)).expect("timestamp"),
            ),
        ];
        let dense_confidence = build_liquidity_confidence(&snapshot, &dense_history);

        assert_eq!(sparse_confidence.level, "low");
        assert_eq!(dense_confidence.level, "high");
    }

    #[test]
    fn time_of_day_liquidity_builds_all_24_hours_with_normalized_heat_scores() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite");
        initialize_market_observatory_schema(&connection).expect("schema");

        let item_id = 42_i64;
        let variant_key = "base";
        let seller_mode = "ingame";
        let slug = "test_item";
        let first_snapshot = sample_snapshot("2026-03-10T00:15:00Z");
        let second_snapshot = sample_snapshot("2026-03-10T12:30:00Z");

        persist_snapshot(&connection, item_id, slug, variant_key, seller_mode, &first_snapshot)
            .expect("persist first snapshot");
        persist_snapshot(&connection, item_id, slug, variant_key, seller_mode, &second_snapshot)
            .expect("persist second snapshot");

        let stat_rows = vec![
            InternalStatsRow {
                bucket_at: super::parse_timestamp("2026-03-10T00:00:00Z").expect("timestamp"),
                source_kind: "closed".to_string(),
                volume: 18.0,
                min_price: Some(10.0),
                max_price: Some(12.0),
                open_price: Some(10.0),
                closed_price: Some(11.0),
                avg_price: Some(11.0),
                wa_price: Some(11.0),
                median: Some(11.0),
                moving_avg: Some(11.0),
                donch_top: Some(12.0),
                donch_bot: Some(10.0),
            },
            InternalStatsRow {
                bucket_at: super::parse_timestamp("2026-03-10T12:00:00Z").expect("timestamp"),
                source_kind: "closed".to_string(),
                volume: 36.0,
                min_price: Some(10.0),
                max_price: Some(12.0),
                open_price: Some(10.0),
                closed_price: Some(11.0),
                avg_price: Some(11.0),
                wa_price: Some(11.0),
                median: Some(11.0),
                moving_avg: Some(11.0),
                donch_top: Some(12.0),
                donch_bot: Some(10.0),
            },
        ];

        insert_statistics_rows_for_domain(
            &connection,
            item_id,
            slug,
            variant_key,
            "48hours",
            &stat_rows,
            "2026-03-10T13:00:00Z",
        )
        .expect("insert 48h stats");

        let summary = build_time_of_day_liquidity(&connection, item_id, variant_key, seller_mode)
            .expect("time of day summary");

        assert_eq!(summary.buckets.len(), 24);
        assert!(summary.buckets.iter().all(|bucket| (0.0..=1.0).contains(&bucket.heat_score)));
        assert_eq!(summary.buckets[0].sample_count, 1);
        assert_eq!(summary.buckets[12].sample_count, 1);
        assert!(summary.buckets[12].avg_hourly_volume > summary.buckets[0].avg_hourly_volume);
        assert!(summary.buckets[12].heat_score >= summary.buckets[0].heat_score);
    }

    #[test]
    fn manipulation_risk_degrades_when_tape_is_sparse() {
        let snapshot = sample_snapshot("2026-03-11T00:00:00Z");
        let sparse_recent = vec![
            sample_snapshot("2026-03-10T23:00:00Z"),
            sample_snapshot("2026-03-11T00:00:00Z"),
        ];

        let risk = build_manipulation_risk(&snapshot, &sparse_recent);

        assert_eq!(risk.confidence_summary.level, "low");
        assert!(
            risk.signals
                .iter()
                .find(|signal| signal.key == "liquidity_withdrawal")
                .map(|signal| signal.active)
                .unwrap_or(false)
                == false
        );
    }

    #[test]
    fn supply_confidence_stays_variant_agnostic_for_drop_sources() {
        let low_confidence = build_supply_confidence("drop-sources", &[], &[]);
        let high_confidence = build_supply_confidence(
            "drop-sources",
            &[],
            &[super::DropSourceEntry {
                location: "Void Capture".to_string(),
                chance: Some(0.02),
                rarity: Some("Rare".to_string()),
                source_type: Some("Mission Reward".to_string()),
            }],
        );

        assert_eq!(low_confidence.level, "low");
        assert_eq!(high_confidence.level, "high");
    }

    #[test]
    fn extracts_rank_stat_highlights_from_raw_json() {
        let raw_json = r#"{
          "levelStats": [
            { "stats": ["Increase Critical Chance by 5%."] },
            { "stats": ["Increase Critical Chance by 75%."] }
          ]
        }"#;

        let (label, highlights) = extract_rank_stat_highlights(raw_json).expect("highlights");

        assert_eq!(label.as_deref(), Some("Rank 0 -> Rank 1"));
        assert_eq!(highlights, vec!["Increase Critical Chance by 5 -> 75%."]);
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
    fn owned_set_components_upsert_and_remove_cleanly() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite");
        initialize_market_observatory_schema(&connection).expect("schema");

        let items = super::upsert_set_completion_owned_item(
            &connection,
            Some(42),
            "wisp_prime_chassis",
            "Wisp Prime Chassis",
            Some("items/images/en/thumbs/wisp_prime_chassis.png"),
            2,
        )
        .expect("upsert owned item");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].slug, "wisp_prime_chassis");
        assert_eq!(items[0].quantity, 2);

        let items = super::upsert_set_completion_owned_item(
            &connection,
            Some(42),
            "wisp_prime_chassis",
            "Wisp Prime Chassis",
            Some("items/images/en/thumbs/wisp_prime_chassis.png"),
            0,
        )
        .expect("remove owned item");

        assert!(items.is_empty());
    }

    #[test]
    fn owned_set_component_trade_sync_applies_once() {
        let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
        initialize_market_observatory_schema(&connection).expect("schema");

        let delta = super::OwnedSetComponentDelta {
            sync_key: "trade-owned:wfm:abc:wisp_prime_chassis".to_string(),
            item_id: Some(42),
            slug: "wisp_prime_chassis".to_string(),
            name: "Wisp Prime Chassis".to_string(),
            image_path: Some("items/images/en/thumbs/wisp_prime_chassis.png".to_string()),
            quantity_delta: 2,
        };

        super::apply_owned_set_component_deltas_inner(&mut connection, &[delta.clone()])
            .expect("apply initial delta");
        super::apply_owned_set_component_deltas_inner(&mut connection, &[delta])
            .expect("ignore duplicate sync delta");

        let items = super::load_set_completion_owned_items(&connection).expect("load items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].quantity, 2);

        let sync_count: i64 = connection
            .query_row(
                "SELECT COUNT(*)
                 FROM owned_set_component_trade_sync
                 WHERE component_slug = 'wisp_prime_chassis'",
                [],
                |row| row.get(0),
            )
            .expect("count sync rows");
        assert_eq!(sync_count, 1);
    }

    #[test]
    fn replacing_owned_set_component_deltas_rebuilds_inventory() {
        let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
        initialize_market_observatory_schema(&connection).expect("schema");

        super::apply_owned_set_component_deltas_inner(
            &mut connection,
            &[super::OwnedSetComponentDelta {
                sync_key: "trade-owned:wfm:old:wisp_prime_chassis".to_string(),
                item_id: Some(42),
                slug: "wisp_prime_chassis".to_string(),
                name: "Wisp Prime Chassis".to_string(),
                image_path: None,
                quantity_delta: 2,
            }],
        )
        .expect("apply initial delta");

        super::replace_owned_set_component_deltas_inner(
            &mut connection,
            &[super::OwnedSetComponentDelta {
                sync_key: "trade-owned:wfm:new:wisp_prime_systems".to_string(),
                item_id: Some(84),
                slug: "wisp_prime_systems".to_string(),
                name: "Wisp Prime Systems".to_string(),
                image_path: None,
                quantity_delta: 1,
            }],
        )
        .expect("replace inventory");

        let items = super::load_set_completion_owned_items(&connection).expect("load items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].slug, "wisp_prime_systems");
        assert_eq!(items[0].quantity, 1);
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

        assert!(!super::statistics_cache_is_usable(
            &connection,
            5,
            "base",
            AnalyticsDomainKey::ThirtyDays
        )
        .expect("cache usability"),);
    }

    #[test]
    fn arbitrage_basket_cost_respects_component_quantities() {
        let set_root = super::SetRootCatalogRecord {
            item_id: 1,
            slug: "example_set".to_string(),
            name: "Example Set".to_string(),
            image_path: None,
        };
        let component_records = vec![
            super::CachedSetComponentRecord {
                set_item_id: 1,
                set_slug: "example_set".to_string(),
                set_name: "Example Set".to_string(),
                set_image_path: None,
                component_item_id: Some(2),
                component_slug: "first_part".to_string(),
                component_name: "First Part".to_string(),
                component_image_path: None,
                quantity_in_set: 2,
                sort_order: 0,
                fetched_at: "2026-03-12T00:00:00Z".to_string(),
            },
            super::CachedSetComponentRecord {
                set_item_id: 1,
                set_slug: "example_set".to_string(),
                set_name: "Example Set".to_string(),
                set_image_path: None,
                component_item_id: Some(3),
                component_slug: "second_part".to_string(),
                component_name: "Second Part".to_string(),
                component_image_path: None,
                quantity_in_set: 1,
                sort_order: 1,
                fetched_at: "2026-03-12T00:00:00Z".to_string(),
            },
        ];
        let component_models = vec![
            Some(super::ScannerPriceModel {
                entry_low: Some(10.0),
                entry_high: Some(12.0),
                recommended_entry_price: Some(12.0),
                exit_low: Some(18.0),
                exit_high: Some(20.0),
                recommended_exit_price: Some(18.0),
                current_stats_price: Some(11.0),
                liquidity_score: 70.0,
                sale_state: "Healthy".to_string(),
                confidence_summary: super::build_confidence_summary("high", Vec::new()),
            }),
            Some(super::ScannerPriceModel {
                entry_low: Some(5.0),
                entry_high: Some(6.0),
                recommended_entry_price: Some(6.0),
                exit_low: Some(9.0),
                exit_high: Some(10.0),
                recommended_exit_price: Some(9.0),
                current_stats_price: Some(5.0),
                liquidity_score: 64.0,
                sale_state: "Healthy".to_string(),
                confidence_summary: super::build_confidence_summary("high", Vec::new()),
            }),
        ];
        let set_model = super::ScannerPriceModel {
            entry_low: Some(28.0),
            entry_high: Some(30.0),
            recommended_entry_price: Some(30.0),
            exit_low: Some(42.0),
            exit_high: Some(46.0),
            recommended_exit_price: Some(42.0),
            current_stats_price: Some(41.0),
            liquidity_score: 82.0,
            sale_state: "Fast mover".to_string(),
            confidence_summary: super::build_confidence_summary("high", Vec::new()),
        };

        let entry = super::build_arbitrage_set_entry(
            &set_root,
            Some(&set_model),
            &component_records,
            &component_models,
        );

        assert_eq!(entry.basket_entry_cost, Some(30.0));
        assert_eq!(entry.gross_margin, Some(12.0));
        assert_eq!(entry.components[0].quantity_in_set, 2);
        assert!(entry.note.contains("Entry <= Price"));
    }

    #[test]
    fn relic_refinement_chance_lookup_and_score_behave() {
        let profile = RelicRefinementChanceProfile {
            intact: Some(25.33),
            exceptional: Some(23.33),
            flawless: Some(20.0),
            radiant: Some(16.67),
        };
        assert_eq!(chance_for_refinement(&profile, "intact"), Some(25.33));
        assert_eq!(chance_for_refinement(&profile, "radiant"), Some(16.67));
        assert_eq!(super::normalized_relic_chance(20.0), 0.2);
        assert_eq!(super::normalized_relic_chance(2.5), 0.025);

        let high_confidence = MarketConfidenceSummary {
            level: "high".to_string(),
            label: "High confidence".to_string(),
            reasons: Vec::new(),
            is_degraded: false,
        };
        let low_confidence = MarketConfidenceSummary {
            level: "low".to_string(),
            label: "Low confidence".to_string(),
            reasons: vec!["Thin history".to_string()],
            is_degraded: true,
        };

        let strong_score = build_relic_roi_score(Some(22.0), 78.0, &high_confidence);
        let weak_score = build_relic_roi_score(Some(3.0), 28.0, &low_confidence);

        assert!(strong_score > weak_score);
        assert!(strong_score > 50.0);
    }

    #[test]
    fn relic_roi_expected_value_uses_percent_chance() {
        let expected_contribution = super::normalized_relic_chance(20.0) * 50.0;
        assert!((expected_contribution - 10.0).abs() < f64::EPSILON);
    }

    #[test]
    fn relic_roi_opportunity_uses_run_value() {
        let summary = super::RelicRoiRefinementSummary {
            refinement_key: super::RELIC_REFINEMENT_INTACT.to_string(),
            refinement_label: "Intact".to_string(),
            run_value: Some(14.0),
            liquidity_score: 72.0,
            relic_roi_score: 80.0,
            confidence_summary: super::build_confidence_summary("high", Vec::new()),
            note: "example".to_string(),
        };

        assert_eq!(summary.run_value, Some(14.0));
        assert!(summary.relic_roi_score > 0.0);
    }

    #[test]
    fn scanner_price_model_cache_reuses_existing_prime_item_model() {
        let connection = Connection::open_in_memory().expect("in-memory connection");
        let cached_model = Some(super::ScannerPriceModel {
            entry_low: Some(12.0),
            entry_high: Some(14.0),
            recommended_entry_price: Some(13.0),
            exit_low: Some(18.0),
            exit_high: Some(20.0),
            recommended_exit_price: Some(19.0),
            current_stats_price: Some(12.0),
            liquidity_score: 61.0,
            sale_state: "Healthy".to_string(),
            confidence_summary: super::build_confidence_summary("high", Vec::new()),
        });
        let mut shared_price_model_cache = std::collections::HashMap::new();
        shared_price_model_cache.insert(42_i64, cached_model.clone());
        let mut refreshed_statistics_count = 0usize;

        let reused = super::get_or_build_scanner_price_model(
            &connection,
            &mut shared_price_model_cache,
            42,
            "example_prime_part",
            &mut refreshed_statistics_count,
            || false,
        )
        .expect("cached model should resolve");

        assert_eq!(
            reused
                .as_ref()
                .and_then(|entry| entry.recommended_exit_price),
            cached_model
                .as_ref()
                .and_then(|entry| entry.recommended_exit_price)
        );
        assert_eq!(refreshed_statistics_count, 0);
    }

    #[test]
    fn resolved_recommended_entry_price_prefers_better_live_floor() {
        assert_eq!(
            super::resolved_recommended_entry_price(Some(58.0), Some(55.0)),
            Some(55.0)
        );
        assert_eq!(
            super::resolved_recommended_entry_price(Some(58.0), Some(61.0)),
            Some(58.0)
        );
    }

    #[test]
    fn historical_recommended_exit_price_ignores_single_spiky_bucket() {
        let base_time = super::now_utc() - time::Duration::days(10);
        let rows = vec![
            InternalStatsRow {
                bucket_at: base_time,
                source_kind: "closed".to_string(),
                volume: 12.0,
                min_price: Some(61.0),
                max_price: Some(67.0),
                open_price: Some(62.0),
                closed_price: Some(63.0),
                avg_price: Some(63.0),
                wa_price: Some(63.0),
                median: Some(63.0),
                moving_avg: Some(63.0),
                donch_top: Some(67.0),
                donch_bot: Some(61.0),
            },
            InternalStatsRow {
                bucket_at: base_time + time::Duration::days(2),
                source_kind: "closed".to_string(),
                volume: 10.0,
                min_price: Some(62.0),
                max_price: Some(68.0),
                open_price: Some(63.0),
                closed_price: Some(64.0),
                avg_price: Some(64.0),
                wa_price: Some(64.0),
                median: Some(64.0),
                moving_avg: Some(64.0),
                donch_top: Some(68.0),
                donch_bot: Some(62.0),
            },
            InternalStatsRow {
                bucket_at: base_time + time::Duration::days(4),
                source_kind: "closed".to_string(),
                volume: 9.0,
                min_price: Some(63.0),
                max_price: Some(69.0),
                open_price: Some(64.0),
                closed_price: Some(65.0),
                avg_price: Some(65.0),
                wa_price: Some(65.0),
                median: Some(65.0),
                moving_avg: Some(65.0),
                donch_top: Some(69.0),
                donch_bot: Some(63.0),
            },
            InternalStatsRow {
                bucket_at: base_time + time::Duration::days(6),
                source_kind: "closed".to_string(),
                volume: 11.0,
                min_price: Some(64.0),
                max_price: Some(70.0),
                open_price: Some(65.0),
                closed_price: Some(66.0),
                avg_price: Some(66.0),
                wa_price: Some(66.0),
                median: Some(66.0),
                moving_avg: Some(66.0),
                donch_top: Some(70.0),
                donch_bot: Some(64.0),
            },
            InternalStatsRow {
                bucket_at: base_time + time::Duration::days(8),
                source_kind: "closed".to_string(),
                volume: 1.0,
                min_price: Some(80.0),
                max_price: Some(95.0),
                open_price: Some(86.0),
                closed_price: Some(90.0),
                avg_price: Some(90.0),
                wa_price: Some(90.0),
                median: Some(90.0),
                moving_avg: Some(90.0),
                donch_top: Some(95.0),
                donch_bot: Some(80.0),
            },
        ];

        let zone = super::ZoneBands {
            entry_low: 57.0,
            entry_high: 60.0,
            exit_low: 67.0,
            exit_high: 71.0,
            entry_target: 59.0,
            exit_target: 69.0,
        };

        let recommended =
            super::historical_recommended_exit_price(Some(59.0), &rows, Some(&zone), None)
                .expect("recommended exit");

        assert_eq!(recommended, 68.0);
    }
}
