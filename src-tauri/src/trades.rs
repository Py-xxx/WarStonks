use crate::error_log::{log_feature_error_best_effort, log_feature_event_best_effort};
use crate::market_observatory::{
    apply_owned_set_component_deltas, load_cached_trade_health_context,
    load_set_completion_screenshot_import_cutoff, replace_owned_set_component_deltas,
    CachedTradeHealthContext, OwnedSetComponentDelta,
};
use crate::settings::{
    load_settings_for_internal_use, send_trade_detected_discord_notification_inner,
    DiscordTradeDetectedNotificationInput, DiscordTradeNotificationItem,
};
use anyhow::{anyhow, Context, Result};
use keyring::Entry as KeychainEntry;
use futures_util::{SinkExt, StreamExt};
use reqwest::blocking::Client;
use reqwest::Method;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::wfm_scheduler::{execute_coalesced_wfm_request, RequestPriority, WfmHttpResponse};

const ITEM_CATALOG_DATABASE_FILE: &str = "item_catalog.sqlite";
const MARKET_OBSERVATORY_DATABASE_FILE: &str = "market_observatory.sqlite";
const TRADES_DIR_NAME: &str = "trades";
const TRADES_SESSION_FILE_NAME: &str = "wfm-session.json";
const TRADES_CREDENTIALS_FILE_NAME: &str = "wfm-credentials.json";
const TRADES_SIGNIN_COOLDOWN_FILE_NAME: &str = "wfm-signin-cooldown.json";
// Hard floor / ceiling for how long we refuse to touch /auth/signin after a rate-limit.
const SIGNIN_COOLDOWN_MIN_SECONDS: u64 = 30;
const SIGNIN_COOLDOWN_MAX_SECONDS: u64 = 600;
const TRADES_AUTO_SIGNIN_STATE_FILE_NAME: &str = "wfm-auto-signin.json";
// Automatic (non-user-initiated) sign-in stops after this many consecutive failures; the
// user must then sign in manually. Keeps a transient problem from becoming an endless loop.
const MAX_AUTO_SIGNIN_ATTEMPTS: u32 = 3;
const KEYCHAIN_SERVICE: &str = "warstonks";
const KEYCHAIN_WFM_SESSION_KEY: &str = "wfm-session";
const KEYCHAIN_WFM_CREDENTIALS_KEY: &str = "wfm-credentials";
const KEYCHAIN_WFM_DEVICE_ID_KEY: &str = "wfm-device-id";
const TRADES_CACHE_DATABASE_FILE: &str = "trades-cache.sqlite";
const TRADE_SET_MAP_FILE_NAME: &str = "wfm-set-map.json";
const TRADE_SET_COMPONENT_CACHE_RETENTION_DAYS: i64 = 30;
const TRADE_LOG_DERIVED_VERSION: i64 = 3;
const PORTFOLIO_PNL_CHART_BUCKET_LIMIT: usize = 90;
const PORTFOLIO_PROFIT_POINT_LIMIT: usize = 12;
const ALECAFRAME_USER_AGENT: &str = concat!("warstonks/", env!("CARGO_PKG_VERSION"));
const TRADE_TIME_DUPLICATE_WINDOW_SECONDS: i64 = 60;
const WFM_TRADE_LOG_LOCK_DAYS: i64 = 80;
const PENDING_NOTIFICATION_WINDOW_MINUTES: i64 = 30;
const WFM_API_BASE_URL_V1: &str = "https://api.warframe.market/v1";
const WFM_API_BASE_URL_V2: &str = "https://api.warframe.market/v2";
const WFM_WS_URL: &str = "wss://ws.warframe.market/socket";
// Descriptive, identifying User-Agent as required by Warframe.Market's API rules: a client
// MUST identify itself (project name, version, website/contact) and MUST NOT disguise itself
// as a browser. Format follows their example: `ProjectName/version (+url)`.
const WFM_USER_AGENT: &str =
    concat!("WarStonks/", env!("CARGO_PKG_VERSION"), " (+https://pyth.co.za)");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeAccountSummary {
    pub user_id: String,
    pub name: String,
    pub status: String,
    pub platform: Option<String>,
    pub reputation: Option<i64>,
    pub avatar_url: Option<String>,
    pub last_updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSessionState {
    pub connected: bool,
    pub account: Option<TradeAccountSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSellOrder {
    pub order_id: String,
    pub order_type: String,
    pub wfm_id: String,
    pub item_id: Option<i64>,
    pub name: String,
    pub slug: String,
    pub image_path: Option<String>,
    pub rank: Option<i64>,
    pub max_rank: Option<i64>,
    pub quantity: i64,
    /// Units exchanged per in-game trade. Only meaningful for bulk-tradable items (e.g.
    /// arcanes); `1` for everything else. WFM requires it on create/update for bulk items.
    pub per_trade: i64,
    pub bulk_tradable: bool,
    pub your_price: i64,
    pub market_low: Option<i64>,
    pub price_gap: Option<i64>,
    pub visible: bool,
    pub updated_at: String,
    pub health_score: Option<i64>,
    pub health_note: Option<String>,
    pub health: Option<TradeListingHealth>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeListingHealth {
    pub refreshed_at: String,
    pub score: i64,
    pub label: String,
    pub tone: String,
    pub action_label: String,
    pub action_tone: String,
    pub outlook_label: String,
    pub posture_label: String,
    pub market_direction: String,
    pub reason: String,
    pub sellers_ahead: i64,
    pub quantity_ahead: i64,
    pub tie_count: i64,
    pub market_low: Option<i64>,
    pub price_gap: Option<i64>,
    pub recommended_price: Option<i64>,
    pub liquidity_score: Option<i64>,
    pub liquidity_label: Option<String>,
    pub pressure_label: Option<String>,
    pub is_degraded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeOverview {
    pub account: TradeAccountSummary,
    pub last_updated_at: String,
    pub active_trade_value: i64,
    pub total_completed_trades: Option<i64>,
    pub open_positions: i64,
    pub sell_orders: Vec<TradeSellOrder>,
    pub buy_orders: Vec<TradeSellOrder>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSignInInput {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub stay_logged_in: bool,
}

// Manual Debug so a stray `{:?}` (e.g. in an error chain that reaches the on-disk log)
// can never leak the password.
impl std::fmt::Debug for TradeSignInInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TradeSignInInput")
            .field("email", &self.email)
            .field("password", &"<redacted>")
            .field("stay_logged_in", &self.stay_logged_in)
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeCreateListingInput {
    pub wfm_id: String,
    pub price: i64,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub visible: bool,
    /// Batch size for bulk-tradable items (arcanes). Ignored for non-bulk items; defaults to
    /// 1 when omitted. Must be 1..=6 and divide `quantity`.
    #[serde(default)]
    pub per_trade: Option<i64>,
    /// WFM subtype for subtyped items (e.g. `regular`/`atragraph` mods, relic refinements).
    /// When omitted, the item's default (first) subtype is used; items without subtypes
    /// ignore this entirely.
    #[serde(default)]
    pub subtype: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeUpdateListingInput {
    pub order_id: String,
    pub price: i64,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub visible: bool,
    /// Item id of the order being edited. Needed to tell whether the item is bulk-tradable
    /// (so `perTrade` is sent only when allowed). Optional for non-bulk callers.
    #[serde(default)]
    pub wfm_id: Option<String>,
    #[serde(default)]
    pub per_trade: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioTradeLogEntry {
    pub id: String,
    pub item_name: String,
    pub slug: String,
    pub image_path: Option<String>,
    pub order_type: String,
    pub source: String,
    pub platinum: i64,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub closed_at: String,
    pub updated_at: String,
    pub profit: Option<i64>,
    pub margin: Option<f64>,
    pub status: Option<String>,
    pub keep_item: bool,
    pub group_id: Option<String>,
    pub group_label: Option<String>,
    pub group_total_platinum: Option<i64>,
    pub group_item_count: Option<i64>,
    pub allocation_total_platinum: Option<i64>,
    pub group_sort_order: Option<i64>,
    pub allocation_mode: Option<String>,
    pub cost_basis_confidence: Option<String>,
    pub cost_basis_label: Option<String>,
    pub matched_cost: Option<i64>,
    pub matched_quantity: Option<i64>,
    pub matched_buy_count: i64,
    pub matched_buy_rows: Vec<PortfolioMatchedBuyRow>,
    pub set_component_rows: Vec<PortfolioSetComponentRow>,
    pub profit_formula: Option<String>,
    pub duplicate_risk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioTradeLogState {
    pub entries: Vec<PortfolioTradeLogEntry>,
    pub last_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioPnlMetricPoint {
    pub bucket_at: String,
    pub label: String,
    pub realized_profit: i64,
    pub cumulative_profit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioTradeProfitPoint {
    pub id: String,
    pub item_name: String,
    pub closed_at: String,
    pub profit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioBreakdownRow {
    pub label: String,
    pub value: i64,
    pub trade_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioMatchedBuyRow {
    pub order_id: String,
    pub item_name: String,
    pub slug: String,
    pub quantity: i64,
    pub consumed_cost: i64,
    pub closed_at: String,
    pub match_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioSetComponentRow {
    pub slug: String,
    pub name: String,
    pub required_quantity: i64,
    pub matched_quantity: i64,
    pub missing_quantity: i64,
    pub matched_cost: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioInventoryRow {
    pub id: String,
    pub item_name: String,
    pub slug: String,
    pub image_path: Option<String>,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub status: String,
    pub cost_basis: i64,
    pub estimated_value: i64,
    pub unrealized_pnl: i64,
    pub last_updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioAuditRow {
    pub id: String,
    pub item_name: String,
    pub slug: String,
    pub order_type: String,
    pub source: String,
    pub closed_at: String,
    pub label: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioPnlSummary {
    pub period: String,
    pub last_updated_at: Option<String>,
    pub realized_profit: i64,
    pub unrealized_value: i64,
    pub unrealized_pnl: i64,
    pub total_pnl: i64,
    pub open_exposure: i64,
    pub turnover_bought: i64,
    pub turnover_sold: i64,
    pub total_trades: i64,
    pub closed_trades: i64,
    pub open_buys: i64,
    pub kept_items: i64,
    pub cost_basis_coverage_pct: f64,
    pub current_value_coverage_pct: f64,
    pub win_rate: f64,
    pub average_margin: Option<f64>,
    pub average_profit_per_trade: f64,
    pub average_hold_hours: Option<f64>,
    pub sold_as_set_profit: i64,
    pub flip_profit: i64,
    pub unmatched_sell_revenue: i64,
    pub partial_cost_basis_revenue: i64,
    pub kept_inventory_value: i64,
    pub partial_set_profit: i64,
    pub best_trade_item: Option<String>,
    pub best_trade_profit: Option<i64>,
    pub worst_trade_item: Option<String>,
    pub worst_trade_profit: Option<i64>,
    pub previous_realized_profit: Option<i64>,
    pub item_breakdown: Vec<PortfolioBreakdownRow>,
    pub inventory_rows: Vec<PortfolioInventoryRow>,
    pub audit_rows: Vec<PortfolioAuditRow>,
    pub category_breakdown: Vec<PortfolioBreakdownRow>,
    pub source_breakdown: Vec<PortfolioBreakdownRow>,
    pub cumulative_profit_points: Vec<PortfolioPnlMetricPoint>,
    pub profit_per_trade_points: Vec<PortfolioTradeProfitPoint>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone)]
struct PortfolioCatalogMeta {
    item_id: Option<i64>,
    item_family: Option<String>,
}

#[derive(Debug, Clone)]
struct ConsumedBuyMatch {
    order_id: String,
    item_name: String,
    slug: String,
    quantity: i64,
    consumed_cost: i64,
    buy_closed_at: String,
    match_kind: String,
}

#[derive(Debug, Clone)]
struct DerivedSetComponentDetail {
    slug: String,
    required_quantity: i64,
    matched_quantity: i64,
    matched_cost: i64,
}

#[derive(Debug, Clone, Default)]
struct DerivedSellDetail {
    revenue: i64,
    matched_quantity: i64,
    matched_cost: i64,
    flip_quantity: i64,
    flip_cost: i64,
    sold_as_set_quantity: i64,
    sold_as_set_cost: i64,
    matches: Vec<ConsumedBuyMatch>,
    set_component_details: Vec<DerivedSetComponentDetail>,
}

#[derive(Debug, Clone)]
struct DerivedTradeLedger {
    entries: Vec<PortfolioTradeLogEntry>,
    sell_details: HashMap<String, DerivedSellDetail>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeTradeMigrationInput {
    pub baseline_date: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeGroupAllocationInput {
    pub order_id: String,
    pub total_platinum: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeDetectionRefreshResult {
    pub source: String,
    pub new_trade_count: i64,
    pub notification_count: i64,
    pub last_updated_at: Option<String>,
    pub skipped: bool,
    pub message: Option<String>,
    pub detected_buys: Vec<DetectedTradeBuy>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeDetectionRefreshInput {
    pub session_started_at: Option<String>,
    pub request_priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTradeBuy {
    pub slug: String,
    pub rank: Option<i64>,
    pub quantity: i64,
    pub platinum: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTradeSession {
    #[serde(default)]
    warstonks_version: Option<String>,
    token: String,
    device_id: String,
    account: TradeAccountSummary,
}

// Manual Debug: never expose the session JWT.
impl std::fmt::Debug for StoredTradeSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredTradeSession")
            .field("warstonks_version", &self.warstonks_version)
            .field("token", &"<redacted>")
            .field("device_id", &self.device_id)
            .field("account", &self.account)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTradeCredentials {
    #[serde(default)]
    warstonks_version: Option<String>,
    email: String,
    password: String,
    saved_at: String,
}

// Manual Debug: never expose the stored password.
impl std::fmt::Debug for StoredTradeCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredTradeCredentials")
            .field("warstonks_version", &self.warstonks_version)
            .field("email", &self.email)
            .field("password", &"<redacted>")
            .field("saved_at", &self.saved_at)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmWsMessage {
    route: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(rename = "refId", skip_serializing_if = "Option::is_none")]
    ref_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmMyOrdersResponse {
    data: Vec<WfmOwnOrder>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOwnOrder {
    id: String,
    #[serde(rename = "type")]
    order_type: String,
    // v2 currently serializes these as integers, but the v1 statistics endpoint
    // silently switched platinum to floats — accept either here to stay robust.
    #[serde(deserialize_with = "deserialize_lenient_i64")]
    platinum: i64,
    #[serde(deserialize_with = "deserialize_lenient_i64")]
    quantity: i64,
    #[serde(default, deserialize_with = "deserialize_lenient_optional_i64")]
    rank: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_lenient_optional_i64")]
    per_trade: Option<i64>,
    #[serde(rename = "itemId")]
    item_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
struct WfmProfileStatisticsResponse {
    payload: WfmProfileStatisticsPayload,
}

#[derive(Debug, Clone, Deserialize)]
struct WfmProfileStatisticsPayload {
    closed_orders: Vec<WfmProfileClosedOrder>,
}

#[derive(Debug, Clone, Deserialize)]
struct WfmProfileClosedOrder {
    id: String,
    item: WfmProfileClosedOrderItem,
    updated_at: String,
    #[serde(deserialize_with = "deserialize_lenient_i64")]
    quantity: i64,
    closed_date: String,
    order_type: String,
    // WFM serializes platinum (and other numeric trade fields) as JSON floats
    // (e.g. `30.0`) as of mid-2026; they were previously integers. Accept either
    // representation so a number-type change in the API doesn't break parsing.
    #[serde(deserialize_with = "deserialize_lenient_i64")]
    platinum: i64,
    #[serde(default, deserialize_with = "deserialize_lenient_optional_i64")]
    mod_rank: Option<i64>,
}

/// Deserialize a JSON number into i64, accepting both integer (`30`) and float
/// (`30.0`) encodings. Warframe trade values are always whole numbers; WFM started
/// serializing them as floats, which a plain `i64` field rejects.
fn deserialize_lenient_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    lenient_f64_to_i64::<D>(value)
}

/// Optional variant of [`deserialize_lenient_i64`] — tolerates absent/null and both
/// integer and float number encodings.
fn deserialize_lenient_optional_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Option::<f64>::deserialize(deserializer)? {
        Some(value) => Ok(Some(lenient_f64_to_i64::<D>(value)?)),
        None => Ok(None),
    }
}

/// Rounds a JSON float to i64, but rejects non-finite (`NaN`/`±inf`) or out-of-range values
/// instead of letting an `as i64` cast silently launder them into garbage (NaN→0,
/// inf→i64::MAX, huge floats→saturated). A malformed WFM number then surfaces as a parse
/// error rather than corrupting a platinum/quantity figure that feeds P&L sums.
fn lenient_f64_to_i64<'de, D>(value: f64) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    if !value.is_finite() {
        return Err(serde::de::Error::custom(
            "expected a finite number, got NaN or infinity",
        ));
    }
    let rounded = value.round();
    if rounded < i64::MIN as f64 || rounded > i64::MAX as f64 {
        return Err(serde::de::Error::custom("number is out of the supported range"));
    }
    Ok(rounded as i64)
}

#[derive(Debug, Clone, Deserialize)]
struct WfmProfileClosedOrderItem {
    #[serde(rename = "url_name")]
    url_name: String,
    #[serde(default)]
    thumb: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    en: WfmProfileClosedOrderItemName,
}

#[derive(Debug, Clone, Deserialize)]
struct WfmProfileClosedOrderItemName {
    #[serde(rename = "item_name")]
    item_name: String,
}

#[derive(Debug, Clone)]
struct StoredTradeLogRecord {
    id: String,
    item_name: String,
    slug: String,
    image_path: Option<String>,
    order_type: String,
    source: String,
    platinum: i64,
    quantity: i64,
    rank: Option<i64>,
    closed_at: String,
    updated_at: String,
    keep_item: bool,
    group_id: Option<String>,
    group_label: Option<String>,
    group_total_platinum: Option<i64>,
    group_item_count: Option<i64>,
    allocation_total_platinum: Option<i64>,
    group_sort_order: Option<i64>,
}

#[derive(Debug, Clone)]
struct TradeSetComponentRecord {
    component_slug: String,
    quantity_in_set: i64,
    fetched_at: String,
}

#[derive(Debug, Clone)]
struct TradeNotificationCandidate {
    fingerprint: String,
    source: String,
    order_type: String,
    total_platinum: i64,
    closed_at: String,
    summary_label: String,
    items: Vec<DiscordTradeNotificationItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradeSetMapFile {
    #[serde(default)]
    warstonks_version: Option<String>,
    api_version: Option<String>,
    generated_at: String,
    sets: Vec<TradeSetMapSetRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradeSetMapSetRecord {
    slug: String,
    name: String,
    image_path: Option<String>,
    components: Vec<TradeSetMapComponentRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradeSetMapComponentRecord {
    slug: String,
    quantity_in_set: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSetMapSummary {
    pub ready: bool,
    pub refreshed: bool,
    pub api_version: Option<String>,
    pub set_count: i64,
    pub file_path: String,
}

#[derive(Debug, Clone)]
struct TradeSetRootRecord {
    slug: String,
    name: String,
    image_path: Option<String>,
}

#[derive(Debug, Clone)]
struct MatchedTradeSet {
    slug: String,
    name: String,
    image_path: Option<String>,
    quantity: i64,
}

#[derive(Debug, Clone, Default)]
struct BuyConsumptionState {
    flipped_quantity: i64,
    sold_as_set_quantity: i64,
}

#[derive(Debug, Clone)]
struct CatalogTradeItemMeta {
    item_id: Option<i64>,
    wfm_id: String,
    slug: String,
    name: String,
    image_path: Option<String>,
    max_rank: Option<i64>,
    bulk_tradable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlecaframeTradeResponse {
    #[serde(default)]
    buy_trades: Vec<AlecaframeTradeRecord>,
    #[serde(default)]
    sell_trades: Vec<AlecaframeTradeRecord>,
    #[serde(default)]
    trades: Vec<AlecaframeRawTradeRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlecaframeTradeRecord {
    timestamp: String,
    direction: String,
    total_plat: Option<i64>,
    #[serde(default)]
    items_sent: Vec<AlecaframeTradeItemRecord>,
    #[serde(default)]
    items_received: Vec<AlecaframeTradeItemRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlecaframeTradeItemRecord {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    cnt: i64,
    rank: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlecaframeRawTradeRecord {
    #[serde(rename = "ts")]
    timestamp: String,
    #[serde(rename = "type")]
    trade_type: i64,
    #[serde(default)]
    total_plat: Option<i64>,
    #[serde(default, rename = "tx")]
    items_sent: Vec<AlecaframeTradeItemRecord>,
    #[serde(default, rename = "rx")]
    items_received: Vec<AlecaframeTradeItemRecord>,
}

fn now_utc() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

fn format_timestamp(value: OffsetDateTime) -> Result<String> {
    value.format(&Rfc3339).context("failed to format timestamp")
}

fn normalize_status_label(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "in_game" | "ingame" => "ingame".to_string(),
        "online" => "online".to_string(),
        "invisible" => "offline".to_string(),
        _ => "offline".to_string(),
    }
}

fn shared_wfm_client() -> Result<Client> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    match CLIENT.get_or_init(|| {
        // Mirror the reference WFM client's defaults: language + platform headers, no
        // browser emulation and no cookie store.
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("language", reqwest::header::HeaderValue::from_static("en"));
        headers.insert("platform", reqwest::header::HeaderValue::from_static("pc"));
        Client::builder()
            .timeout(Duration::from_secs(30))
            .default_headers(headers)
            .build()
            .map_err(|error| format!("failed to build WFM trades client: {error}"))
    }) {
        Ok(client) => Ok(client.clone()),
        Err(error) => Err(anyhow!(error.clone())),
    }
}


fn session_cache() -> &'static Mutex<Option<StoredTradeSession>> {
    static CACHE: OnceLock<Mutex<Option<StoredTradeSession>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn get_session_from_cache() -> Option<StoredTradeSession> {
    session_cache().lock().ok().and_then(|g| g.clone())
}

fn set_session_in_cache(session: &StoredTradeSession) {
    if let Ok(mut guard) = session_cache().lock() {
        *guard = Some(session.clone());
    }
}

fn clear_session_cache() {
    if let Ok(mut guard) = session_cache().lock() {
        *guard = None;
    }
}

// ── Sign-in rate-limit cooldown ────────────────────────────────────────────────
//
// Warframe.Market's login endpoint is Cloudflare rate-limited (HTTP 429 / "error code:
// 1015"). When we get rate-limited we must STOP calling /auth/signin until the cooldown
// lapses — otherwise every retry resets Cloudflare's window and the block becomes
// effectively permanent (the exact failure mode we hit: a background loop re-signing-in
// kept an account throttled for 24h+). The cooldown is held in memory and mirrored to disk
// so it also survives an app restart.

struct SigninCooldown {
    until: OffsetDateTime,
    consecutive: u32,
}

fn signin_cooldown() -> &'static Mutex<Option<SigninCooldown>> {
    static COOLDOWN: OnceLock<Mutex<Option<SigninCooldown>>> = OnceLock::new();
    COOLDOWN.get_or_init(|| Mutex::new(None))
}

fn signin_cooldown_file_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .app_data_dir()
            .ok()?
            .join(TRADES_DIR_NAME)
            .join(TRADES_SIGNIN_COOLDOWN_FILE_NAME),
    )
}

/// Remaining sign-in cooldown, if any. Checks the in-memory value first, then falls back to
/// the persisted file (covers a fresh process that just launched into an active cooldown).
fn signin_cooldown_remaining(app: &tauri::AppHandle) -> Option<Duration> {
    let now = now_utc();

    if let Ok(guard) = signin_cooldown().lock() {
        if let Some(state) = guard.as_ref() {
            if state.until > now {
                return (state.until - now).try_into().ok();
            }
        }
    }

    // Fall back to the persisted cooldown (e.g. right after a restart, before any in-memory
    // state exists).
    let path = signin_cooldown_file_path(app)?;
    let text = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    let until = parse_timestamp(value.get("until")?.as_str()?)?;
    if until > now {
        (until - now).try_into().ok()
    } else {
        None
    }
}

/// Records a sign-in rate-limit. The wait escalates on consecutive hits (the server's
/// `retry_after`, doubled each time) within sane bounds, and is persisted so a restart
/// doesn't immediately re-hit the login endpoint.
fn note_signin_rate_limited(app: &tauri::AppHandle, server_retry_after: Option<Duration>) {
    let base = server_retry_after
        .map(|d| d.as_secs())
        .unwrap_or(SIGNIN_COOLDOWN_MIN_SECONDS)
        .max(SIGNIN_COOLDOWN_MIN_SECONDS);

    // Capture both the cooldown deadline and the consecutive count while holding the lock once,
    // so the values mirrored to disk below are guaranteed to be the pair we just committed —
    // a second lock read could otherwise observe a different writer's state (TOCTOU).
    let (until, consecutive) = {
        let mut guard = match signin_cooldown().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let next = guard.as_ref().map(|s| s.consecutive + 1).unwrap_or(1);
        let wait = base
            .saturating_mul(1u64 << (next - 1).min(5))
            .min(SIGNIN_COOLDOWN_MAX_SECONDS);
        let until = now_utc() + Duration::from_secs(wait);
        *guard = Some(SigninCooldown { until, consecutive: next });
        (until, next)
    };

    // Mirror to disk (best-effort) using the values captured above — no second lock read.
    if let Some(path) = signin_cooldown_file_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(until) = format_timestamp(until) {
            let _ = fs::write(
                &path,
                json!({ "until": until, "consecutive": consecutive }).to_string(),
            );
        }
    }
}

/// Clears the cooldown after a successful sign-in.
fn clear_signin_cooldown(app: &tauri::AppHandle) {
    if let Ok(mut guard) = signin_cooldown().lock() {
        *guard = None;
    }
    if let Some(path) = signin_cooldown_file_path(app) {
        let _ = fs::remove_file(path);
    }
}

// ── Automatic sign-in governor ─────────────────────────────────────────────────
//
// The app keeps a persistent presence connection that holds the session alive, so we no
// longer need an aggressive auto-reauth. Automatic (non-user-initiated) sign-in is now
// fail-stop: after MAX_AUTO_SIGNIN_ATTEMPTS consecutive failures it suspends itself and the
// user must sign in manually. A successful manual sign-in resets it. The state is persisted
// so a restart can't bypass the suspension and resume hammering the login endpoint.

#[derive(Clone, Default)]
struct AutoSigninState {
    failures: u32,
    suspended: bool,
}

fn auto_signin_state() -> &'static Mutex<Option<AutoSigninState>> {
    static STATE: OnceLock<Mutex<Option<AutoSigninState>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn auto_signin_state_file_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .app_data_dir()
            .ok()?
            .join(TRADES_DIR_NAME)
            .join(TRADES_AUTO_SIGNIN_STATE_FILE_NAME),
    )
}

fn load_auto_signin_state_from_file(app: &tauri::AppHandle) -> AutoSigninState {
    let Some(path) = auto_signin_state_file_path(app) else {
        return AutoSigninState::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return AutoSigninState::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return AutoSigninState::default();
    };
    AutoSigninState {
        failures: value.get("failures").and_then(Value::as_u64).unwrap_or(0) as u32,
        suspended: value.get("suspended").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// Reads the current governor state (memory cache, loading from disk on first access).
fn read_auto_signin_state(app: &tauri::AppHandle) -> AutoSigninState {
    let mut guard = match auto_signin_state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.is_none() {
        *guard = Some(load_auto_signin_state_from_file(app));
    }
    guard.clone().unwrap_or_default()
}

fn write_auto_signin_state(app: &tauri::AppHandle, state: AutoSigninState) {
    if let Ok(mut guard) = auto_signin_state().lock() {
        *guard = Some(state.clone());
    }
    if let Some(path) = auto_signin_state_file_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(
            &path,
            json!({ "failures": state.failures, "suspended": state.suspended }).to_string(),
        );
    }
}

fn is_auto_signin_suspended(app: &tauri::AppHandle) -> bool {
    read_auto_signin_state(app).suspended
}

/// Records an automatic sign-in failure. Returns the new consecutive-failure count; sets the
/// suspended flag once it reaches the cap.
fn record_auto_signin_failure(app: &tauri::AppHandle) -> u32 {
    let mut state = read_auto_signin_state(app);
    state.failures = state.failures.saturating_add(1);
    if state.failures >= MAX_AUTO_SIGNIN_ATTEMPTS {
        state.suspended = true;
    }
    let failures = state.failures;
    write_auto_signin_state(app, state);
    failures
}

/// Resets the governor — called after any successful sign-in (manual or automatic).
fn reset_auto_signin_state(app: &tauri::AppHandle) {
    write_auto_signin_state(app, AutoSigninState::default());
}

fn build_item_catalog_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    Ok(app_data_dir.join(ITEM_CATALOG_DATABASE_FILE))
}

fn build_market_observatory_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    Ok(app_data_dir.join(MARKET_OBSERVATORY_DATABASE_FILE))
}

fn build_trades_cache_database_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    Ok(app_data_dir
        .join(TRADES_DIR_NAME)
        .join(TRADES_CACHE_DATABASE_FILE))
}

fn build_trade_set_map_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    Ok(app_data_dir.join("data").join(TRADE_SET_MAP_FILE_NAME))
}

fn load_trade_credentials(app: &tauri::AppHandle) -> Result<Option<StoredTradeCredentials>> {
    let entry = KeychainEntry::new(KEYCHAIN_SERVICE, KEYCHAIN_WFM_CREDENTIALS_KEY)
        .context("failed to open keychain for WFM credentials")?;
    match entry.get_password() {
        Ok(json) => {
            let creds = serde_json::from_str::<StoredTradeCredentials>(&json)
                .context("failed to parse WFM credentials from keychain")?;
            Ok(Some(creds))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => {
            log_feature_error_best_effort(
                app,
                "trades-session",
                "load-credentials-keychain",
                "Failed to read WFM credentials from the OS keychain — user will need to sign in again.",
                &anyhow!("{error}"),
            );
            Ok(None)
        }
    }
}

fn save_trade_credentials(_app: &tauri::AppHandle, creds: &StoredTradeCredentials) -> Result<()> {
    let entry = KeychainEntry::new(KEYCHAIN_SERVICE, KEYCHAIN_WFM_CREDENTIALS_KEY)
        .context("failed to open keychain for WFM credentials")?;
    let mut updated = creds.clone();
    updated.warstonks_version = Some(env!("CARGO_PKG_VERSION").to_string());
    let json =
        serde_json::to_string(&updated).context("failed to serialize WFM credentials")?;
    entry
        .set_password(&json)
        .context("failed to save WFM credentials to the OS keychain")
}

fn clear_trade_credentials(_app: &tauri::AppHandle) -> Result<()> {
    let entry = KeychainEntry::new(KEYCHAIN_SERVICE, KEYCHAIN_WFM_CREDENTIALS_KEY)
        .context("failed to open keychain for WFM credentials")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(anyhow!("failed to clear WFM credentials from keychain: {error}")),
    }
}

fn placeholder_trade_account_summary() -> TradeAccountSummary {
    TradeAccountSummary {
        user_id: String::new(),
        name: String::new(),
        status: "offline".to_string(),
        platform: None,
        reputation: None,
        avatar_url: None,
        last_updated_at: String::new(),
    }
}

fn load_session(app: &tauri::AppHandle) -> Result<Option<StoredTradeSession>> {
    let entry = KeychainEntry::new(KEYCHAIN_SERVICE, KEYCHAIN_WFM_SESSION_KEY)
        .context("failed to open keychain for WFM session")?;
    match entry.get_password() {
        Ok(json) => {
            // Accept both the new minimal payload (token + deviceId) and the legacy full
            // payload (which embedded the whole account). The account is re-fetched via
            // /me on restore, so only the token + device id are persisted now — that keeps
            // the blob small enough for Windows Credential Manager's ~2560-byte limit.
            let value = serde_json::from_str::<serde_json::Value>(&json)
                .context("failed to parse WFM session from keychain")?;
            let token = value
                .get("token")
                .and_then(|entry| entry.as_str())
                .unwrap_or_default()
                .to_string();
            let device_id = value
                .get("deviceId")
                .and_then(|entry| entry.as_str())
                .unwrap_or_default()
                .to_string();
            if token.is_empty() || device_id.is_empty() {
                return Ok(None);
            }
            let account = value
                .get("account")
                .and_then(|account| {
                    serde_json::from_value::<TradeAccountSummary>(account.clone()).ok()
                })
                .unwrap_or_else(placeholder_trade_account_summary);
            Ok(Some(StoredTradeSession {
                warstonks_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                token,
                device_id,
                account,
            }))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => {
            log_feature_error_best_effort(
                app,
                "trades-session",
                "load-session-keychain",
                "Failed to read WFM session from the OS keychain.",
                &anyhow!("{error}"),
            );
            Ok(None)
        }
    }
}

fn save_session(_app: &tauri::AppHandle, session: &StoredTradeSession) -> Result<()> {
    let entry = KeychainEntry::new(KEYCHAIN_SERVICE, KEYCHAIN_WFM_SESSION_KEY)
        .context("failed to open keychain for WFM session")?;
    // Persist only the token + device id. The account summary is re-fetched via /me on
    // restore, and omitting it keeps the blob under Windows Credential Manager's
    // ~2560-byte (UTF-16) limit, which a full JWT + account object would blow past.
    let payload = json!({
        "warstonksVersion": env!("CARGO_PKG_VERSION"),
        "token": session.token,
        "deviceId": session.device_id,
    });
    entry
        .set_password(&payload.to_string())
        .context("failed to save WFM session to the OS keychain")
}

fn clear_session(_app: &tauri::AppHandle) -> Result<()> {
    let entry = KeychainEntry::new(KEYCHAIN_SERVICE, KEYCHAIN_WFM_SESSION_KEY)
        .context("failed to open keychain for WFM session")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(anyhow!("failed to clear WFM session from keychain: {error}")),
    }
}

fn cleanup_legacy_trade_files(app: &tauri::AppHandle) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    for name in [TRADES_SESSION_FILE_NAME, TRADES_CREDENTIALS_FILE_NAME] {
        let path = app_data_dir.join(TRADES_DIR_NAME).join(name);
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
}

fn open_catalog_database(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = build_item_catalog_path(app)?;
    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("failed to open item catalog")
}

fn open_market_observatory_database(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = build_market_observatory_path(app)?;
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("failed to open market observatory")?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("failed to set market observatory busy timeout")?;
    Ok(connection)
}

pub(crate) fn open_trades_cache_database(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = build_trades_cache_database_path(app)?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create trades cache directory {}",
                parent.display()
            )
        })?;
    }

    let connection = Connection::open(db_path).context("failed to open trades cache database")?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("failed to set trades cache busy timeout")?;
    initialize_trades_cache_schema(&connection)?;
    Ok(connection)
}

fn initialize_trades_cache_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS portfolio_trade_log_cache (
              username TEXT NOT NULL,
              order_id TEXT NOT NULL,
              item_name TEXT NOT NULL,
              slug TEXT NOT NULL,
              image_path TEXT,
              order_type TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT 'wfm',
              platinum INTEGER NOT NULL,
              quantity INTEGER NOT NULL,
              rank INTEGER,
              closed_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              group_id TEXT,
              group_label TEXT,
              group_total_platinum INTEGER,
              group_item_count INTEGER,
              allocation_total_platinum INTEGER,
              group_sort_order INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (username, order_id)
            );

            CREATE TABLE IF NOT EXISTS portfolio_trade_log_overrides (
              username TEXT NOT NULL,
              order_id TEXT NOT NULL,
              keep_item INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (username, order_id)
            );

            CREATE TABLE IF NOT EXISTS portfolio_trade_log_cache_meta (
              username TEXT PRIMARY KEY,
              last_updated_at TEXT NOT NULL,
              entry_count INTEGER NOT NULL,
              alecaframe_baseline_date TEXT
            );

            CREATE TABLE IF NOT EXISTS portfolio_trade_log_derived (
              username TEXT NOT NULL,
              order_id TEXT NOT NULL,
              profit INTEGER,
              margin REAL,
              status TEXT,
              derived_version INTEGER NOT NULL DEFAULT 0,
              derived_at TEXT NOT NULL,
              PRIMARY KEY (username, order_id)
            );

            CREATE TABLE IF NOT EXISTS trade_set_component_cache (
              set_slug TEXT NOT NULL,
              component_slug TEXT NOT NULL,
              quantity_in_set INTEGER NOT NULL,
              sort_order INTEGER NOT NULL,
              fetched_at TEXT NOT NULL,
              PRIMARY KEY (set_slug, component_slug)
            );

            CREATE TABLE IF NOT EXISTS portfolio_trade_log_notifications (
              username TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              source TEXT NOT NULL,
              notified_at TEXT NOT NULL,
              closed_at TEXT NOT NULL,
              PRIMARY KEY (username, fingerprint)
            );
            ",
        )
        .context("failed to initialize trades cache schema")?;

    migrate_trades_cache_schema(connection)
}

fn migrate_trades_cache_schema(connection: &Connection) -> Result<()> {
    let mut statement = connection
        .prepare("PRAGMA table_info(portfolio_trade_log_cache)")
        .context("failed to inspect trade log cache schema")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .context("failed to query trade log cache columns")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect trade log cache columns")?;

    if !columns.iter().any(|column| column == "keep_item") {
        connection
            .execute(
                "ALTER TABLE portfolio_trade_log_cache ADD COLUMN keep_item INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .context("failed to add keep_item column to trade log cache")?;
    }

    for (column, sql, error_label) in [
        (
            "source",
            "ALTER TABLE portfolio_trade_log_cache ADD COLUMN source TEXT NOT NULL DEFAULT 'wfm'",
            "failed to add source column to trade log cache",
        ),
        (
            "group_id",
            "ALTER TABLE portfolio_trade_log_cache ADD COLUMN group_id TEXT",
            "failed to add group_id column to trade log cache",
        ),
        (
            "group_label",
            "ALTER TABLE portfolio_trade_log_cache ADD COLUMN group_label TEXT",
            "failed to add group_label column to trade log cache",
        ),
        (
            "group_total_platinum",
            "ALTER TABLE portfolio_trade_log_cache ADD COLUMN group_total_platinum INTEGER",
            "failed to add group_total_platinum column to trade log cache",
        ),
        (
            "group_item_count",
            "ALTER TABLE portfolio_trade_log_cache ADD COLUMN group_item_count INTEGER",
            "failed to add group_item_count column to trade log cache",
        ),
        (
            "allocation_total_platinum",
            "ALTER TABLE portfolio_trade_log_cache ADD COLUMN allocation_total_platinum INTEGER",
            "failed to add allocation_total_platinum column to trade log cache",
        ),
        (
            "group_sort_order",
            "ALTER TABLE portfolio_trade_log_cache ADD COLUMN group_sort_order INTEGER NOT NULL DEFAULT 0",
            "failed to add group_sort_order column to trade log cache",
        ),
    ] {
        if !columns.iter().any(|existing| existing == column) {
            connection
                .execute(sql, [])
                .with_context(|| error_label.to_string())?;
        }
    }

    let mut derived_statement = connection
        .prepare("PRAGMA table_info(portfolio_trade_log_derived)")
        .context("failed to inspect derived trade log schema")?;
    let derived_columns = derived_statement
        .query_map([], |row| row.get::<_, String>(1))
        .context("failed to query derived trade log columns")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect derived trade log columns")?;

    if !derived_columns
        .iter()
        .any(|column| column == "derived_version")
    {
        connection
            .execute(
                "ALTER TABLE portfolio_trade_log_derived ADD COLUMN derived_version INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .context("failed to add derived_version column to derived trade log")?;
    }

    let mut meta_statement = connection
        .prepare("PRAGMA table_info(portfolio_trade_log_cache_meta)")
        .context("failed to inspect trade log cache metadata schema")?;
    let meta_columns = meta_statement
        .query_map([], |row| row.get::<_, String>(1))
        .context("failed to query trade log cache metadata columns")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect trade log cache metadata columns")?;

    if !meta_columns
        .iter()
        .any(|column| column == "alecaframe_baseline_date")
    {
        connection
            .execute(
                "ALTER TABLE portfolio_trade_log_cache_meta ADD COLUMN alecaframe_baseline_date TEXT",
                [],
            )
            .context("failed to add alecaframe_baseline_date column to trade log cache metadata")?;
    }

    Ok(())
}

fn generate_device_id() -> String {
    let seed = format!(
        "{}:{}:{}:{}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::process::id(),
        now_utc().unix_timestamp_nanos()
    );
    let digest = sha2::Sha256::digest(seed.as_bytes());
    hex::encode(&digest[..16])
}

/// Returns a stable per-install device id, persisted in the OS keychain and cached for the
/// process lifetime.
///
/// WFM associates a `device_id` with each login. Previously a fresh id was minted on every
/// sign-in, so each automatic re-auth looked like a brand-new device — which can trip
/// security heuristics and rate limits. We now generate the id once, persist it, and reuse
/// it for all subsequent sign-ins. If the keychain is unavailable we fall back to a
/// process-stable id (still better than regenerating per request).
fn get_or_create_device_id() -> String {
    static DEVICE_ID: OnceLock<String> = OnceLock::new();
    DEVICE_ID
        .get_or_init(|| {
            if let Ok(entry) = KeychainEntry::new(KEYCHAIN_SERVICE, KEYCHAIN_WFM_DEVICE_ID_KEY) {
                if let Ok(existing) = entry.get_password() {
                    let trimmed = existing.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_string();
                    }
                }
                let fresh = generate_device_id();
                // Best-effort persistence: a write failure just means we mint a new id next
                // launch, which is no worse than the old behaviour.
                let _ = entry.set_password(&fresh);
                return fresh;
            }
            generate_device_id()
        })
        .clone()
}

fn parse_timestamp(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

fn trade_record_is_before_cutoff(record: &StoredTradeLogRecord, cutoff: OffsetDateTime) -> bool {
    parse_timestamp(&record.closed_at)
        .map(|closed_at| closed_at < cutoff)
        .unwrap_or(false)
}

fn parse_date_start_utc(value: &str) -> Result<OffsetDateTime> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Select a baseline date for migration."));
    }

    let midnight = format!("{trimmed}T00:00:00Z");
    OffsetDateTime::parse(&midnight, &Rfc3339)
        .with_context(|| format!("failed to parse migration baseline date '{trimmed}'"))
}

fn extract_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(candidate) = value.get(*key).and_then(Value::as_str) {
            let trimmed = candidate.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn extract_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(candidate) = value.get(*key).and_then(Value::as_i64) {
            return Some(candidate);
        }
    }

    None
}

fn normalize_alias_lookup_value(value: &str) -> String {
    value.trim().to_lowercase()
}

fn build_fallback_slug(value: &str) -> String {
    value
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or(value)
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn normalize_avatar_url(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            return None;
        }

        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Some(trimmed.to_string());
        }

        let normalized_path = trimmed.trim_start_matches('/');
        if normalized_path.starts_with("user/avatar/") {
            return Some(format!(
                "https://warframe.market/static/assets/{normalized_path}"
            ));
        }

        Some(format!("https://warframe.market/{normalized_path}"))
    })
}

fn parse_account_summary(data: &Value, fetched_at: &str) -> Result<TradeAccountSummary> {
    let user_id = extract_string(data, &["id"]).ok_or_else(|| anyhow!("missing user id"))?;
    let name = extract_string(data, &["ingame_name", "ingameName", "name"])
        .ok_or_else(|| anyhow!("missing ingame name"))?;
    let status = normalize_status_label(
        &extract_string(data, &["status", "status_type"]).unwrap_or_else(|| "offline".to_string()),
    );

    Ok(TradeAccountSummary {
        user_id,
        name,
        status,
        platform: extract_string(data, &["platform"]),
        reputation: extract_i64(data, &["reputation"]),
        avatar_url: normalize_avatar_url(extract_string(
            data,
            &[
                "avatar",
                "avatar_url",
                "avatarUrl",
                "profile_image",
                "profileImage",
            ],
        )),
        last_updated_at: fetched_at.to_string(),
    })
}

fn auth_header_value(token: &str) -> String {
    format!("Bearer {token}")
}

fn send_wfm_request(
    client: &Client,
    method: Method,
    url: String,
    token: Option<&str>,
) -> reqwest::blocking::RequestBuilder {
    let builder = client
        .request(method, url)
        .header("User-Agent", WFM_USER_AGENT)
        .header("Accept", "application/json");

    if let Some(token) = token {
        builder.header("Authorization", auth_header_value(token))
    } else {
        builder
    }
}

fn parse_retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
}

fn execute_wfm_bytes_request(
    builder: reqwest::blocking::RequestBuilder,
    priority: RequestPriority,
    action_label: &str,
    coalesce_key: Option<String>,
) -> Result<WfmHttpResponse> {
    let action_label_owned = action_label.to_string();
    execute_coalesced_wfm_request(
        priority,
        action_label,
        coalesce_key,
        None,
        || false,
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

fn execute_wfm_request_with_priority(
    builder: reqwest::blocking::RequestBuilder,
    action_label: &str,
    priority: RequestPriority,
) -> Result<WfmHttpResponse> {
    let response = execute_wfm_bytes_request(builder, priority, action_label, None)?;
    if response.status >= 200 && response.status < 300 {
        return Ok(response);
    }
    Err(extract_wfm_bytes_error(action_label, &response))
}

fn extract_wfm_bytes_error(action_label: &str, response: &WfmHttpResponse) -> anyhow::Error {
    let body = String::from_utf8_lossy(&response.body);
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        anyhow!("{action_label} failed with status {}", response.status)
    } else {
        anyhow!(
            "{action_label} failed with status {}: {}",
            response.status,
            trimmed_body
        )
    }
}

/// Pulls the HTTP status code out of an error message produced by [`extract_wfm_bytes_error`]
/// (which always formats "... failed with status {code} ..."). Returns `None` for errors that
/// don't carry an HTTP status (network failures, our own validation messages).
fn extract_wfm_status_code(message: &str) -> Option<u16> {
    const MARKER: &str = "failed with status ";
    let start = message.find(MARKER)? + MARKER.len();
    message[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse::<u16>()
        .ok()
}

/// Maps an order-mutation failure (create / update / close / delete / visibility) to a clear,
/// user-facing message so a raw `"create sell order failed with status 400: {json}"` never
/// reaches the UI. Mirrors [`friendly_sign_in_error`] for the order paths. Session-expiry text
/// keeps the literal "session expired" so the frontend's re-sign-in prompt still triggers.
fn friendly_order_error(error: &anyhow::Error) -> String {
    if should_attempt_trade_session_reauth(error) {
        return "Your Warframe.Market session expired. Please sign in again.".to_string();
    }
    if is_rate_limit_error(error) {
        return "Warframe.Market is rate-limiting requests right now. Wait a moment, then try again."
            .to_string();
    }

    let message = error.to_string();
    match extract_wfm_status_code(&message) {
        Some(400) => "Warframe.Market rejected this order. Double-check the price, quantity, and rank, then try again.".to_string(),
        Some(403) => "Warframe.Market refused this action. Try signing in again, then retry.".to_string(),
        Some(404) => "That order no longer exists on Warframe.Market. Refresh your listings and try again.".to_string(),
        Some(code) if (500..=599).contains(&code) => "Warframe.Market is having trouble right now. Please try again in a moment.".to_string(),
        Some(_) => "Couldn’t complete that order on Warframe.Market. Please try again.".to_string(),
        None => {
            let lower = message.to_ascii_lowercase();
            if lower.contains("error sending request")
                || lower.contains("timed out")
                || lower.contains("timeout")
                || lower.contains("dns")
                || lower.contains("connection")
            {
                "Couldn’t reach Warframe.Market. Check your connection and try again.".to_string()
            } else {
                // No HTTP status and not a network error → an already-friendly validation
                // message from create_order_inner (e.g. the perTrade / price checks). Pass through.
                message
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Trade market low helpers
// ---------------------------------------------------------------------------

/// Minimal response structs for the WFM V2 item orders endpoint.
/// Only the fields needed to derive the lowest sell price are parsed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradeMarketOrderUser {
    #[serde(default)]
    ingame_name: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradeMarketOrder {
    #[serde(rename = "type")]
    order_type: String,
    platinum: f64,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    rank: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
    user: TradeMarketOrderUser,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradeMarketOrdersResponse {
    #[serde(default)]
    data: Vec<TradeMarketOrder>,
}

#[derive(Debug, Clone)]
struct TradeHealthOrder {
    price: f64,
    quantity: i64,
    username: String,
}

#[derive(Debug, Clone)]
struct TradeHealthLiveContext {
    sell_orders: Vec<TradeHealthOrder>,
    market_low: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
struct TradeHealthDecision {
    score: i64,
    label: &'static str,
    tone: &'static str,
    action_label: &'static str,
    action_tone: &'static str,
    outlook_label: &'static str,
    posture_label: &'static str,
    recommended_price: Option<i64>,
}

fn seller_mode_allows_status(status: Option<&str>, seller_mode: &str) -> bool {
    match status {
        Some("ingame") => true,
        Some("online") => seller_mode == "ingame-online",
        _ => false,
    }
}

fn trade_health_variant_matches(rank: Option<i64>, required_rank: Option<i64>) -> bool {
    match required_rank {
        Some(value) => rank == Some(value),
        None => rank.is_none() || rank == Some(0),
    }
}

fn trade_health_variant_key(rank: Option<i64>) -> String {
    match rank {
        Some(value) => format!("rank:{value}"),
        None => "base".to_string(),
    }
}

fn normalize_trade_health_order(order: TradeMarketOrder) -> Option<TradeHealthOrder> {
    Some(TradeHealthOrder {
        price: order.platinum,
        quantity: order.quantity.unwrap_or(1).max(1),
        username: order.user.ingame_name?,
    })
}

fn count_queue_ahead(
    sell_orders: &[TradeHealthOrder],
    your_price: i64,
    account_name: &str,
) -> (i64, i64, i64) {
    let normalized_account_name = account_name.trim().to_ascii_lowercase();
    let target_price = your_price as f64;
    let mut sellers_ahead = 0_i64;
    let mut quantity_ahead = 0_i64;
    let mut tie_count = 0_i64;

    for order in sell_orders {
        if order.username.trim().to_ascii_lowercase() == normalized_account_name {
            continue;
        }
        // Platinum prices are whole numbers; use a 0.5 tolerance so float rounding can't make a
        // genuinely-equal price read as "cheaper". f64::EPSILON (~2.2e-16) was far too tight.
        if order.price < target_price - 0.5 {
            sellers_ahead += 1;
            quantity_ahead += order.quantity;
        } else if (order.price - target_price).abs() < 0.5 {
            tie_count += 1;
        }
    }

    (sellers_ahead, quantity_ahead, tie_count)
}

fn calculate_trade_health_score(
    price_gap: Option<i64>,
    sellers_ahead: i64,
    quantity_ahead: i64,
    tie_count: i64,
    market_direction: &str,
    liquidity_score: Option<i64>,
) -> i64 {
    let mut score = 84.0;
    score -= (sellers_ahead.min(8) as f64) * 5.0;
    score -= (quantity_ahead.min(24) as f64) * 1.4;
    score -= (tie_count.min(5) as f64) * 2.0;
    score -= match price_gap {
        Some(value) if value <= 0 => 0.0,
        Some(value) => (value.min(10) as f64) * 3.0,
        None => 10.0,
    };
    score += match market_direction {
        "Rising" => 10.0,
        "Falling" => -8.0,
        _ => 0.0,
    };
    score += match liquidity_score {
        Some(value) if value >= 75 => 10.0,
        Some(value) if value >= 55 => 4.0,
        Some(value) if value < 35 => -10.0,
        Some(value) if value < 55 => -4.0,
        _ => 0.0,
    };
    score.round().clamp(0.0, 100.0) as i64
}

fn derive_trade_health_reason(
    decision: &TradeHealthDecision,
    sellers_ahead: i64,
    quantity_ahead: i64,
    context: Option<&CachedTradeHealthContext>,
) -> String {
    let queue_summary = if sellers_ahead <= 0 {
        "You are already sitting at the front of the visible sell queue.".to_string()
    } else if quantity_ahead > 0 {
        format!(
            "{sellers_ahead} cheaper seller{} and {quantity_ahead} unit{} are still ahead of your listing.",
            if sellers_ahead == 1 { "" } else { "s" },
            if quantity_ahead == 1 { "" } else { "s" }
        )
    } else {
        format!(
            "{sellers_ahead} cheaper seller{} are still ahead of your listing.",
            if sellers_ahead == 1 { "" } else { "s" }
        )
    };

    let market_summary = context
        .map(|entry| entry.trend_summary.clone())
        .unwrap_or_else(|| "WarStonks is using live orderbook data only for this listing right now.".to_string());

    if decision.action_label == "Wait for normalization" {
        format!("{market_summary} {queue_summary}")
    } else if decision.action_label == "Reprice to market" {
        format!("{queue_summary} {market_summary}")
    } else {
        format!("{queue_summary} {market_summary}")
    }
}

fn decide_trade_health(
    your_price: i64,
    market_low: Option<i64>,
    sellers_ahead: i64,
    quantity_ahead: i64,
    tie_count: i64,
    context: Option<&CachedTradeHealthContext>,
) -> TradeHealthDecision {
    let price_gap = market_low.map(|value| your_price - value);
    let market_direction = context
        .map(|entry| entry.trend_direction.as_str())
        .unwrap_or("Flat");
    let liquidity_score = context.and_then(|entry| entry.liquidity_score.map(|value| value.round() as i64));
    let score = calculate_trade_health_score(
        price_gap,
        sellers_ahead,
        quantity_ahead,
        tie_count,
        market_direction,
        liquidity_score,
    );
    let posture_label = if price_gap.unwrap_or_default() < 0 {
        "Leading"
    } else if price_gap == Some(0) && sellers_ahead == 0 {
        "At market"
    } else if price_gap.unwrap_or(99) <= 2 && sellers_ahead <= 2 {
        "Competitive"
    } else if price_gap.unwrap_or(99) <= 5 && sellers_ahead <= 6 {
        "Slightly above"
    } else {
        "Buried"
    };

    let weak_exit_zone = match (context, market_low) {
        (Some(entry), Some(low))
            if entry.exit_zone_low.is_some() && low + 3 < entry.exit_zone_low.unwrap_or(low as f64).round() as i64 =>
        {
            true
        }
        _ => false,
    };

    let (action_label, action_tone, outlook_label, recommended_price) = if market_low.is_none() {
        ("Reprice to market", "amber", "Needs a refresh", None)
    } else if weak_exit_zone && market_direction != "Rising" {
        ("Wait for normalization", "amber", "Do not chase down", None)
    } else if sellers_ahead == 0 && price_gap.unwrap_or_default() <= 0 {
        ("Hold", "green", "Likely soon", None)
    } else if sellers_ahead <= 2 && price_gap.unwrap_or(99) <= 2 {
        (
            "Trim by 1-2p",
            "blue",
            "Competitive, but may take time",
            Some(your_price.saturating_sub(price_gap.unwrap_or_default().clamp(1, 2))),
        )
    } else if sellers_ahead >= 6 || quantity_ahead >= 10 || price_gap.unwrap_or_default() >= 4 {
        ("Reprice to market", "red", "Unlikely at current price", market_low)
    } else if liquidity_score.unwrap_or(60) < 35 {
        ("Low priority listing", "amber", "Thin market", None)
    } else {
        ("Hold", "blue", "Needs patience", None)
    };

    let (label, tone) = if score >= 78 {
        ("Strong", "green")
    } else if score >= 62 {
        ("Healthy", "blue")
    } else if score >= 42 {
        ("Watch", "amber")
    } else if score >= 22 {
        ("Weak", "red")
    } else {
        ("Action Needed", "red")
    };

    TradeHealthDecision {
        score,
        label,
        tone,
        action_label,
        action_tone,
        outlook_label,
        posture_label,
        recommended_price,
    }
}

/// Fetches the lowest visible sell price for `slug` (optionally filtered by `rank`)
/// from online/ingame sellers, using the given scheduler priority.
fn fetch_trade_health_live_context_inner(
    slug: &str,
    rank: Option<i64>,
    seller_mode: &str,
    priority: RequestPriority,
) -> Result<TradeHealthLiveContext> {
    let client = shared_wfm_client()?;
    let priority_label = match priority {
        RequestPriority::High => "high",
        RequestPriority::Medium => "medium",
        RequestPriority::Low => "low",
        RequestPriority::Instant => "instant",
    };
    let coalesce_key = format!(
        "trade-market-low:{}:{}:{}",
        priority_label,
        slug,
        rank.map_or_else(|| "none".to_string(), |r| r.to_string()),
    );
    let response = execute_wfm_bytes_request(
        client
            .get(format!("{WFM_API_BASE_URL_V2}/orders/item/{slug}"))
            .header("User-Agent", WFM_USER_AGENT)
            .header("Language", "en")
            .header("Platform", "pc")
            .header("Crossplay", "true"),
        priority,
        "request trade market low",
        Some(coalesce_key),
    )?;
    if response.status < 200 || response.status >= 300 {
        return Err(extract_wfm_bytes_error("request trade market low", &response));
    }
    let payload = serde_json::from_slice::<TradeMarketOrdersResponse>(&response.body)
        .context("failed to parse trade market orders response")?;
    let sell_orders = payload
        .data
        .iter()
        .filter(|order| order.order_type == "sell")
        .filter(|order| order.visible.unwrap_or(true))
        .filter(|order| seller_mode_allows_status(order.user.status.as_deref(), seller_mode))
        .filter(|order| trade_health_variant_matches(order.rank, rank))
        .cloned()
        .filter_map(normalize_trade_health_order)
        .collect::<Vec<_>>();

    let market_low = sell_orders
        .iter()
        .map(|order| order.price.round() as i64)
        .min();

    Ok(TradeHealthLiveContext {
        sell_orders,
        market_low,
    })
}

fn fetch_sell_order_market_low_inner(
    slug: &str,
    rank: Option<i64>,
    seller_mode: &str,
    priority: RequestPriority,
) -> Result<Option<i64>> {
    Ok(fetch_trade_health_live_context_inner(slug, rank, seller_mode, priority)?.market_low)
}

#[tauri::command]
pub async fn get_trade_sell_order_market_low(
    slug: String,
    rank: Option<i64>,
    seller_mode: String,
    priority: String,
) -> Result<Option<i64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let priority = RequestPriority::from_wire(Some(priority.trim()), RequestPriority::Low);
        fetch_sell_order_market_low_inner(slug.trim(), rank, seller_mode.trim(), priority)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_trade_sell_order_health(
    app: tauri::AppHandle,
    item_id: Option<i64>,
    slug: String,
    rank: Option<i64>,
    your_price: i64,
    seller_mode: String,
    priority: String,
) -> Result<TradeListingHealth, String> {
    let app_for_work = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let priority = RequestPriority::from_wire(Some(priority.trim()), RequestPriority::Low);
        let seller_mode = seller_mode.trim().to_string();
        let live_context =
            fetch_trade_health_live_context_inner(slug.trim(), rank, &seller_mode, priority)?;
        let session = ensure_authenticated_session(&app_for_work)?;
        let observatory = open_market_observatory_database(&app_for_work)?;
        let variant_key = trade_health_variant_key(rank);
        let cached_context = item_id
            .map(|value| load_cached_trade_health_context(&observatory, value, &variant_key, &seller_mode))
            .transpose()?
            .flatten();
        let (sellers_ahead, quantity_ahead, tie_count) =
            count_queue_ahead(&live_context.sell_orders, your_price, &session.account.name);
        let decision = decide_trade_health(
            your_price,
            live_context.market_low,
            sellers_ahead,
            quantity_ahead,
            tie_count,
            cached_context.as_ref(),
        );
        let market_direction = cached_context
            .as_ref()
            .map(|entry| entry.trend_direction.clone())
            .unwrap_or_else(|| "Flat".to_string());
        let price_gap = live_context.market_low.map(|value| your_price - value);
        let reason =
            derive_trade_health_reason(&decision, sellers_ahead, quantity_ahead, cached_context.as_ref());

        Ok::<_, anyhow::Error>(TradeListingHealth {
            refreshed_at: format_timestamp(now_utc())?,
            score: decision.score,
            label: decision.label.to_string(),
            tone: decision.tone.to_string(),
            action_label: decision.action_label.to_string(),
            action_tone: decision.action_tone.to_string(),
            outlook_label: decision.outlook_label.to_string(),
            posture_label: decision.posture_label.to_string(),
            market_direction,
            reason,
            sellers_ahead,
            quantity_ahead,
            tie_count,
            market_low: live_context.market_low,
            price_gap,
            recommended_price: decision.recommended_price,
            liquidity_score: cached_context
                .as_ref()
                .and_then(|entry| entry.liquidity_score.map(|value| value.round() as i64)),
            liquidity_label: cached_context.as_ref().map(|entry| entry.liquidity_label.clone()),
            pressure_label: cached_context.as_ref().map(|entry| entry.pressure_label.clone()),
            is_degraded: cached_context
                .as_ref()
                .map(|entry| entry.is_degraded)
                .unwrap_or(true),
        })
    })
    .await
    .map_err(|error| {
        let error = anyhow!("failed to join trade listing health worker: {error}");
        log_feature_error_best_effort(
            &app,
            "trades-health",
            "refresh-listing-health-join",
            "Failed to join the trade listing health refresh worker.",
            &error,
        );
        "Couldn’t refresh listing health right now.".to_string()
    })?
    .map_err(|error| {
        log_feature_error_best_effort(
            &app,
            "trades-health",
            "refresh-listing-health",
            "Failed to refresh the live trade listing health context.",
            &error,
        );
        "Couldn’t refresh listing health right now.".to_string()
    })
}

fn fetch_me_with_token(client: &Client, token: &str) -> Result<TradeAccountSummary> {
    let response = execute_wfm_bytes_request(
        send_wfm_request(
            client,
            Method::GET,
            format!("{WFM_API_BASE_URL_V2}/me"),
            Some(token),
        ),
        RequestPriority::Instant,
        "request WFM profile",
        Some("profile:me".to_string()),
    )?;
    if response.status < 200 || response.status >= 300 {
        return Err(extract_wfm_bytes_error("request WFM profile", &response));
    }

    let payload = serde_json::from_slice::<Value>(&response.body)
        .context("failed to parse WFM profile response")?;
    let fetched_at = format_timestamp(now_utc())?;
    parse_account_summary(
        payload
            .get("data")
            .ok_or_else(|| anyhow!("missing WFM profile data"))?,
        &fetched_at,
    )
}

fn resolve_catalog_trade_item_by_alias(
    connection: &Connection,
    alias_value: &str,
) -> Result<Option<CatalogTradeItemMeta>> {
    let normalized = normalize_alias_lookup_value(alias_value);
    let trimmed = alias_value.trim();
    let preferred_name = prettify_alecaframe_name(trimmed);
    let normalized_preferred_name = normalize_alias_lookup_value(&preferred_name);

    let queries = [
        (
            "
            SELECT
              items.item_id,
              COALESCE(items.wfm_id, wfm_items.wfm_id),
              COALESCE(items.wfm_slug, wfm_items.slug, ''),
              COALESCE(items.preferred_name, wfm_items.name_en, items.canonical_name, ?1),
              COALESCE(items.preferred_image, wfm_items.thumb, wfm_items.icon),
              wfm_items.max_rank
            FROM items
            LEFT JOIN wfm_items ON wfm_items.wfm_id = items.wfm_id
            WHERE items.primary_wfstat_unique_name = ?2
            LIMIT 1
            ",
            params![preferred_name.as_str(), trimmed],
        ),
        (
            "
            SELECT
              items.item_id,
              COALESCE(items.wfm_id, wfm_items.wfm_id),
              COALESCE(items.wfm_slug, wfm_items.slug, ''),
              COALESCE(items.preferred_name, wfm_items.name_en, items.canonical_name, ?1),
              COALESCE(items.preferred_image, wfm_items.thumb, wfm_items.icon),
              wfm_items.max_rank
            FROM wfstat_item_components
            JOIN items ON items.item_id = wfstat_item_components.component_item_id
            LEFT JOIN wfm_items ON wfm_items.wfm_id = items.wfm_id
            WHERE wfstat_item_components.component_unique_name = ?2
            LIMIT 1
            ",
            params![preferred_name.as_str(), trimmed],
        ),
        (
            "
            SELECT
              items.item_id,
              COALESCE(items.wfm_id, wfm_items.wfm_id),
              COALESCE(items.wfm_slug, wfm_items.slug, ''),
              COALESCE(items.preferred_name, wfm_items.name_en, items.canonical_name, ?1),
              COALESCE(items.preferred_image, wfm_items.thumb, wfm_items.icon),
              wfm_items.max_rank,
              wfm_items.bulk_tradable
            FROM item_aliases
            JOIN items ON items.item_id = item_aliases.item_id
            LEFT JOIN wfm_items ON wfm_items.wfm_id = items.wfm_id
            WHERE item_aliases.alias_value = ?2
               OR item_aliases.normalized_alias_value = ?3
            ORDER BY CASE
              WHEN item_aliases.alias_value = ?2 THEN 0
              WHEN item_aliases.normalized_alias_value = ?3 THEN 1
              ELSE 2
            END
            LIMIT 1
            ",
            params![preferred_name.as_str(), trimmed, normalized.as_str()],
        ),
        (
            "
            SELECT
              items.item_id,
              COALESCE(items.wfm_id, wfm_items.wfm_id),
              COALESCE(items.wfm_slug, wfm_items.slug, ''),
              COALESCE(items.preferred_name, wfm_items.name_en, items.canonical_name, ?1),
              COALESCE(items.preferred_image, wfm_items.thumb, wfm_items.icon),
              wfm_items.max_rank,
              wfm_items.bulk_tradable
            FROM items
            LEFT JOIN wfm_items ON wfm_items.wfm_id = items.wfm_id
            WHERE LOWER(COALESCE(items.preferred_name, wfm_items.name_en, items.canonical_name, '')) = ?2
            LIMIT 1
            ",
            params![preferred_name.as_str(), normalized_preferred_name.as_str()],
        ),
    ];

    for (sql, params) in queries {
        let resolved = connection
            .query_row(sql, params, |row| {
                Ok(CatalogTradeItemMeta {
                    item_id: row.get(0)?,
                    wfm_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    slug: row.get(2)?,
                    name: row.get(3)?,
                    image_path: row.get(4)?,
                    max_rank: row.get(5)?,
                    bulk_tradable: row.get::<_, Option<i64>>(6)?.unwrap_or(0) == 1,
                })
            })
            .optional()
            .context("failed to resolve catalog item by alias")?;

        if resolved.is_some() {
            return Ok(resolved);
        }
    }

    Ok(None)
}

fn resolve_catalog_trade_item_by_slug(
    connection: &Connection,
    slug: &str,
) -> Result<Option<CatalogTradeItemMeta>> {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    connection
        .query_row(
            "
            SELECT
              items.item_id,
              COALESCE(items.wfm_id, wfm_items.wfm_id, ''),
              COALESCE(items.wfm_slug, wfm_items.slug, ''),
              COALESCE(items.preferred_name, wfm_items.name_en, items.canonical_name, ?1),
              COALESCE(items.preferred_image, wfm_items.thumb, wfm_items.icon),
              wfm_items.max_rank,
              wfm_items.bulk_tradable
            FROM items
            LEFT JOIN wfm_items ON wfm_items.wfm_id = items.wfm_id
            WHERE COALESCE(items.wfm_slug, wfm_items.slug) = ?2
            LIMIT 1
            ",
            params![trimmed, trimmed],
            |row| {
                Ok(CatalogTradeItemMeta {
                    item_id: row.get(0)?,
                    wfm_id: row.get(1)?,
                    slug: row.get(2)?,
                    name: row.get(3)?,
                    image_path: row.get(4)?,
                    max_rank: row.get(5)?,
                    bulk_tradable: row.get::<_, Option<i64>>(6)?.unwrap_or(0) == 1,
                })
            },
        )
        .optional()
        .context("failed to resolve catalog item by slug")
}

fn observatory_contains_set_component_slug(connection: &Connection, slug: &str) -> Result<bool> {
    connection
        .query_row(
            "SELECT 1
             FROM set_component_cache
             WHERE component_slug = ?1
             LIMIT 1",
            params![slug],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|value| value.is_some())
        .context("failed to check observatory set component membership")
}

fn fetch_alecaframe_trade_payload(app: &tauri::AppHandle) -> Result<AlecaframeTradeResponse> {
    let settings = load_settings_for_internal_use(app)?;
    let alecaframe = settings.alecaframe;
    if !alecaframe.enabled {
        return Err(anyhow!("Enable Alecaframe API in Settings first."));
    }

    let Some(public_link) = alecaframe.public_link else {
        return Err(anyhow!("No Alecaframe public link is saved."));
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to construct Alecaframe trade client")?;

    client
        .get(public_link)
        .header("User-Agent", ALECAFRAME_USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .context("failed to request Alecaframe trade history")?
        .error_for_status()
        .context("Alecaframe trade history request failed")?
        .json::<AlecaframeTradeResponse>()
        .context("failed to parse Alecaframe trade history response")
}

fn is_platinum_trade_item(item: &AlecaframeTradeItemRecord) -> bool {
    item.name == "/AF_Special/Platinum"
}

fn normalize_alecaframe_rank(rank: i64) -> Option<i64> {
    (rank >= 0).then_some(rank)
}

fn normalize_alecaframe_trade_payload(
    payload: AlecaframeTradeResponse,
) -> Vec<AlecaframeTradeRecord> {
    let mut trades = payload
        .buy_trades
        .into_iter()
        .chain(payload.sell_trades)
        .collect::<Vec<_>>();

    if trades.is_empty() {
        trades.extend(payload.trades.into_iter().filter_map(|trade| {
            let direction = match trade.trade_type {
                0 => "sell",
                1 => "buy",
                _ => return None,
            };

            Some(AlecaframeTradeRecord {
                timestamp: trade.timestamp,
                direction: direction.to_string(),
                total_plat: trade.total_plat,
                items_sent: trade.items_sent,
                items_received: trade.items_received,
            })
        }));
    }

    trades.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    trades
}

fn allocated_row_totals(total_platinum: i64, unit_counts: &[i64]) -> Vec<i64> {
    let total_units = unit_counts
        .iter()
        .copied()
        .map(|value| value.max(0))
        .sum::<i64>();
    if total_units <= 0 {
        return vec![0; unit_counts.len()];
    }

    let base = total_platinum.div_euclid(total_units);
    let mut remainder = total_platinum.rem_euclid(total_units);
    let mut allocations = Vec::with_capacity(unit_counts.len());

    for units in unit_counts {
        let normalized_units = (*units).max(0);
        let extra = remainder.min(normalized_units);
        allocations.push(base * normalized_units + extra);
        remainder -= extra;
    }

    allocations
}

fn stable_trade_group_id(
    username: &str,
    direction: &str,
    timestamp: &str,
    total_platinum: i64,
    item_keys: &[String],
) -> String {
    let seed = format!(
        "{username}|{direction}|{timestamp}|{total_platinum}|{}",
        item_keys.join("|")
    );
    let digest = sha2::Sha256::digest(seed.as_bytes());
    format!("af-group-{}", hex::encode(&digest[..12]))
}

fn stable_trade_row_id(group_id: &str, sort_order: usize, item_key: &str) -> String {
    let seed = format!("{group_id}|{sort_order}|{item_key}");
    let digest = sha2::Sha256::digest(seed.as_bytes());
    format!("af-trade-{}", hex::encode(&digest[..12]))
}

fn build_trade_log_entries_from_statistics(
    payload: WfmProfileStatisticsPayload,
) -> Vec<PortfolioTradeLogEntry> {
    let mut entries = payload
        .closed_orders
        .into_iter()
        .filter(|order| matches!(order.order_type.as_str(), "buy" | "sell"))
        .map(|order| PortfolioTradeLogEntry {
            id: order.id,
            item_name: order.item.en.item_name,
            slug: order.item.url_name,
            image_path: order.item.thumb.or(order.item.icon),
            order_type: order.order_type.to_lowercase(),
            source: "wfm".to_string(),
            platinum: order.platinum,
            quantity: order.quantity,
            rank: order.mod_rank,
            closed_at: order.closed_date,
            updated_at: order.updated_at,
            profit: None,
            margin: None,
            status: None,
            keep_item: false,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: None,
            group_sort_order: None,
            allocation_mode: None,
            cost_basis_confidence: None,
            cost_basis_label: None,
            matched_cost: None,
            matched_quantity: None,
            matched_buy_count: 0,
            matched_buy_rows: Vec::new(),
            set_component_rows: Vec::new(),
            profit_formula: None,
            duplicate_risk: false,
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| right.closed_at.cmp(&left.closed_at));
    entries
}

fn build_trade_notification_minute_bucket(value: &str) -> String {
    parse_timestamp(value)
        .and_then(|timestamp| {
            timestamp
                .replace_second(0)
                .ok()
                .and_then(|candidate| candidate.replace_nanosecond(0).ok())
        })
        .and_then(|timestamp| format_timestamp(timestamp).ok())
        .unwrap_or_else(|| value.trim().to_string())
}

fn build_trade_notification_fingerprint(
    order_type: &str,
    total_platinum: i64,
    closed_at: &str,
    items: &[DiscordTradeNotificationItem],
) -> String {
    let mut item_parts = items
        .iter()
        .map(|item| {
            format!(
                "{}:{}:{}",
                normalize_alias_lookup_value(&item.item_name),
                item.quantity.max(1),
                item.rank.unwrap_or(-1)
            )
        })
        .collect::<Vec<_>>();
    item_parts.sort();

    format!(
        "{}|{}|{}|{}",
        order_type.trim().to_lowercase(),
        total_platinum,
        build_trade_notification_minute_bucket(closed_at),
        item_parts.join("|")
    )
}

fn build_trade_owned_sync_key(record: &StoredTradeLogRecord) -> String {
    let total_platinum = record
        .allocation_total_platinum
        .unwrap_or(record.platinum.saturating_mul(record.quantity.max(1)));
    let items = [DiscordTradeNotificationItem {
        item_name: record.item_name.clone(),
        quantity: record.quantity.max(1),
        rank: record.rank,
        image_path: record.image_path.clone(),
    }];

    build_trade_notification_fingerprint(
        &record.order_type,
        total_platinum,
        &record.closed_at,
        &items,
    )
}

fn build_trade_notification_items_from_entry(
    entry: &PortfolioTradeLogEntry,
) -> Vec<DiscordTradeNotificationItem> {
    vec![DiscordTradeNotificationItem {
        item_name: entry.item_name.clone(),
        quantity: entry.quantity.max(1),
        rank: entry.rank,
        image_path: entry.image_path.clone(),
    }]
}

fn build_trade_notification_items_for_wfm_entry(
    app: &tauri::AppHandle,
    entry: &PortfolioTradeLogEntry,
) -> Result<Vec<DiscordTradeNotificationItem>> {
    if !entry.slug.ends_with("_set") {
        return Ok(build_trade_notification_items_from_entry(entry));
    }

    let mut components = load_trade_set_components_for_slug(app, &entry.slug)?;
    if components.is_empty() {
        components = load_trade_set_components_from_map(app, &entry.slug)?;
    }
    if components.is_empty() {
        return Ok(build_trade_notification_items_from_entry(entry));
    }

    let catalog = open_catalog_database(app)?;
    let trade_quantity = entry.quantity.max(1);
    let mut items = Vec::new();

    for component in components {
        let meta = resolve_catalog_trade_item_by_slug(&catalog, &component.component_slug)?;
        let name = meta
            .as_ref()
            .map(|entry| entry.name.clone())
            .unwrap_or_else(|| component.component_slug.clone());
        let image_path = meta.and_then(|entry| entry.image_path);
        let quantity = component
            .quantity_in_set
            .max(1)
            .saturating_mul(trade_quantity);

        items.push(DiscordTradeNotificationItem {
            item_name: name,
            quantity,
            rank: None,
            image_path,
        });
    }

    if items.is_empty() {
        return Ok(build_trade_notification_items_from_entry(entry));
    }

    Ok(items)
}

fn build_trade_notification_candidates_for_wfm(
    app: &tauri::AppHandle,
    entries: &[PortfolioTradeLogEntry],
) -> Result<Vec<TradeNotificationCandidate>> {
    let mut candidates = Vec::with_capacity(entries.len());

    for entry in entries {
        let items = build_trade_notification_items_for_wfm_entry(app, entry)?;
        let total_platinum = entry
            .allocation_total_platinum
            .unwrap_or(entry.platinum.saturating_mul(entry.quantity.max(1)));
        let summary_label = format!(
            "{} {} x{} for {}p",
            if entry.order_type == "buy" {
                "Bought"
            } else {
                "Sold"
            },
            entry.item_name,
            entry.quantity.max(1),
            total_platinum
        );

        candidates.push(TradeNotificationCandidate {
            fingerprint: build_trade_notification_fingerprint(
                &entry.order_type,
                total_platinum,
                &entry.closed_at,
                &items,
            ),
            source: "wfm".to_string(),
            order_type: entry.order_type.clone(),
            total_platinum,
            closed_at: entry.closed_at.clone(),
            summary_label,
            items,
        });
    }

    Ok(candidates)
}

fn build_trade_notification_candidates_for_alecaframe(
    entries: &[PortfolioTradeLogEntry],
) -> Vec<TradeNotificationCandidate> {
    let mut grouped = HashMap::<String, Vec<PortfolioTradeLogEntry>>::new();
    let mut singles = Vec::<PortfolioTradeLogEntry>::new();

    for entry in entries {
        if let Some(group_id) = &entry.group_id {
            grouped
                .entry(group_id.clone())
                .or_default()
                .push(entry.clone());
        } else {
            singles.push(entry.clone());
        }
    }

    let mut candidates = Vec::new();

    for entry in singles {
        let items = build_trade_notification_items_from_entry(&entry);
        let total_platinum = entry
            .allocation_total_platinum
            .unwrap_or(entry.platinum.saturating_mul(entry.quantity.max(1)));
        let summary_label = format!(
            "{} {} x{} for {}p",
            if entry.order_type == "buy" {
                "Bought"
            } else {
                "Sold"
            },
            entry.item_name,
            entry.quantity.max(1),
            total_platinum
        );

        candidates.push(TradeNotificationCandidate {
            fingerprint: build_trade_notification_fingerprint(
                &entry.order_type,
                total_platinum,
                &entry.closed_at,
                &items,
            ),
            source: "alecaframe".to_string(),
            order_type: entry.order_type.clone(),
            total_platinum,
            closed_at: entry.closed_at.clone(),
            summary_label,
            items,
        });
    }

    for mut group_entries in grouped.into_values() {
        group_entries.sort_by(|left, right| {
            left.group_sort_order
                .unwrap_or(0)
                .cmp(&right.group_sort_order.unwrap_or(0))
                .then_with(|| left.id.cmp(&right.id))
        });
        let Some(first) = group_entries.first() else {
            continue;
        };

        let total_platinum = first.group_total_platinum.unwrap_or_else(|| {
            group_entries
                .iter()
                .map(|entry| entry.allocation_total_platinum.unwrap_or(entry.platinum))
                .sum::<i64>()
        });
        let items = group_entries
            .iter()
            .map(|entry| DiscordTradeNotificationItem {
                item_name: entry.item_name.clone(),
                quantity: entry.quantity.max(1),
                rank: entry.rank,
                image_path: entry.image_path.clone(),
            })
            .collect::<Vec<_>>();
        let summary_label = format!(
            "{} {} item{} for {}p",
            if first.order_type == "buy" {
                "Bought"
            } else {
                "Sold"
            },
            items.len(),
            if items.len() == 1 { "" } else { "s" },
            total_platinum
        );

        candidates.push(TradeNotificationCandidate {
            fingerprint: build_trade_notification_fingerprint(
                &first.order_type,
                total_platinum,
                &first.closed_at,
                &items,
            ),
            source: "alecaframe".to_string(),
            order_type: first.order_type.clone(),
            total_platinum,
            closed_at: first.closed_at.clone(),
            summary_label,
            items,
        });
    }

    candidates.sort_by(|left, right| left.closed_at.cmp(&right.closed_at));
    candidates
}

fn trade_happened_after_session_start(
    candidate: &TradeNotificationCandidate,
    session_started_at: Option<&OffsetDateTime>,
) -> bool {
    let Some(session_started_at) = session_started_at else {
        return false;
    };

    parse_timestamp(&candidate.closed_at)
        .map(|closed_at| closed_at >= *session_started_at)
        .unwrap_or(false)
}

fn send_trade_notification_candidates_inner(
    app: &tauri::AppHandle,
    connection: &Connection,
    username: &str,
    candidates: &[TradeNotificationCandidate],
    _source: &str,
    session_started_at: Option<&OffsetDateTime>,
) -> Result<i64> {
    let mut sent_count = 0_i64;

    for candidate in candidates {
        if !trade_happened_after_session_start(candidate, session_started_at) {
            continue;
        }

        if trade_notification_fingerprint_exists_inner(
            connection,
            username,
            &candidate.fingerprint,
        )? {
            continue;
        }

        let sent = send_trade_detected_discord_notification_inner(
            app,
            &DiscordTradeDetectedNotificationInput {
                source: candidate.source.clone(),
                order_type: candidate.order_type.clone(),
                total_platinum: candidate.total_platinum,
                closed_at: candidate.closed_at.clone(),
                summary_label: candidate.summary_label.clone(),
                items: candidate.items.clone(),
            },
        )?;

        if sent {
            persist_trade_notification_fingerprint_inner(
                connection,
                username,
                &candidate.fingerprint,
                &candidate.source,
                &candidate.closed_at,
            )?;
            sent_count += 1;
        }
    }

    Ok(sent_count)
}

fn prettify_alecaframe_name(value: &str) -> String {
    value
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or(value)
        .replace('_', " ")
}

fn find_duplicate_trade_record(
    existing: &[StoredTradeLogRecord],
    order_type: &str,
    item_name: &str,
    quantity: i64,
    closed_at: &OffsetDateTime,
) -> bool {
    existing.iter().any(|record| {
        if record.order_type != order_type || record.quantity != quantity {
            return false;
        }

        if normalize_alias_lookup_value(&record.item_name)
            != normalize_alias_lookup_value(item_name)
        {
            return false;
        }

        parse_timestamp(&record.closed_at)
            .map(|existing_time| {
                (existing_time - *closed_at).whole_seconds().abs()
                    <= TRADE_TIME_DUPLICATE_WINDOW_SECONDS
            })
            .unwrap_or(false)
    })
}

fn match_grouped_trade_to_exact_set(
    group: &[StoredTradeLogRecord],
    set_definitions: &[(TradeSetRootRecord, Vec<TradeSetComponentRecord>)],
) -> Option<MatchedTradeSet> {
    if group.len() < 2 {
        return None;
    }

    let mut grouped_quantities = HashMap::<String, i64>::new();
    for record in group {
        if record.slug.trim().is_empty() || record.quantity <= 0 {
            return None;
        }

        *grouped_quantities.entry(record.slug.clone()).or_insert(0) += record.quantity.max(0);
    }

    for (set_root, components) in set_definitions {
        if components.is_empty() || components.len() != grouped_quantities.len() {
            continue;
        }

        let mut matched_set_quantity: Option<i64> = None;
        let mut is_exact_match = true;

        for component in components {
            let Some(actual_quantity) = grouped_quantities.get(&component.component_slug) else {
                is_exact_match = false;
                break;
            };

            if *actual_quantity <= 0 || actual_quantity % component.quantity_in_set != 0 {
                is_exact_match = false;
                break;
            }

            let candidate_set_quantity = actual_quantity / component.quantity_in_set;
            if candidate_set_quantity <= 0 {
                is_exact_match = false;
                break;
            }

            matched_set_quantity = match matched_set_quantity {
                Some(existing) if existing != candidate_set_quantity => {
                    is_exact_match = false;
                    break;
                }
                Some(existing) => Some(existing),
                None => Some(candidate_set_quantity),
            };
        }

        if is_exact_match {
            return matched_set_quantity.map(|quantity| MatchedTradeSet {
                slug: set_root.slug.clone(),
                name: set_root.name.clone(),
                image_path: set_root.image_path.clone(),
                quantity,
            });
        }
    }

    None
}

fn collapse_grouped_trade_sets(
    records: &[StoredTradeLogRecord],
    set_definitions: &[(TradeSetRootRecord, Vec<TradeSetComponentRecord>)],
) -> (Vec<StoredTradeLogRecord>, bool) {
    let mut grouped_records = HashMap::<String, Vec<StoredTradeLogRecord>>::new();
    for record in records {
        if let Some(group_id) = &record.group_id {
            grouped_records
                .entry(group_id.clone())
                .or_default()
                .push(record.clone());
        }
    }

    if grouped_records.is_empty() {
        return (records.to_vec(), false);
    }

    let mut collapsed = Vec::with_capacity(records.len());
    let mut seen_group_ids = HashMap::<String, bool>::new();
    let mut changed = false;

    for record in records {
        let Some(group_id) = &record.group_id else {
            collapsed.push(record.clone());
            continue;
        };

        if seen_group_ids.contains_key(group_id) {
            continue;
        }
        seen_group_ids.insert(group_id.clone(), true);

        let Some(group) = grouped_records.get(group_id) else {
            continue;
        };

        let Some(matched_set) = match_grouped_trade_to_exact_set(group, set_definitions) else {
            collapsed.extend(group.iter().cloned());
            continue;
        };

        let total_platinum = group
            .first()
            .and_then(|entry| entry.group_total_platinum)
            .unwrap_or_else(|| group.iter().map(record_total_platinum).sum::<i64>());
        let average_unit_platinum = if matched_set.quantity > 0 {
            (total_platinum + (matched_set.quantity / 2)) / matched_set.quantity
        } else {
            total_platinum
        };

        let duplicate_exists = records
            .iter()
            .filter(|candidate| candidate.group_id.as_deref() != Some(group_id.as_str()))
            .any(|candidate| {
                candidate.order_type == group[0].order_type
                    && candidate.quantity == matched_set.quantity
                    && candidate.slug == matched_set.slug
                    && parse_timestamp(&candidate.closed_at)
                        .map(|candidate_time| {
                            parse_timestamp(&group[0].closed_at)
                                .map(|group_time| {
                                    (candidate_time - group_time).whole_seconds().abs()
                                        <= TRADE_TIME_DUPLICATE_WINDOW_SECONDS
                                })
                                .unwrap_or(false)
                        })
                        .unwrap_or(false)
            });

        changed = true;
        if duplicate_exists {
            continue;
        }

        let keep_item = group.iter().any(|entry| entry.keep_item);
        collapsed.push(StoredTradeLogRecord {
            id: format!("af-set-{group_id}"),
            item_name: matched_set.name,
            slug: matched_set.slug,
            image_path: matched_set.image_path,
            order_type: group[0].order_type.clone(),
            source: group[0].source.clone(),
            platinum: average_unit_platinum,
            quantity: matched_set.quantity,
            rank: None,
            closed_at: group[0].closed_at.clone(),
            updated_at: group[0].updated_at.clone(),
            keep_item,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: Some(total_platinum),
            group_sort_order: None,
        });
    }

    (collapsed, changed)
}

fn build_alecaframe_trade_entries(
    app: &tauri::AppHandle,
    username: &str,
    baseline_date: &str,
    existing: &[StoredTradeLogRecord],
) -> Result<Vec<PortfolioTradeLogEntry>> {
    let baseline = parse_date_start_utc(baseline_date)?;
    let trades = normalize_alecaframe_trade_payload(fetch_alecaframe_trade_payload(app)?);
    let catalog = open_catalog_database(app)?;
    let mut imported = Vec::new();

    for trade in trades {
        let order_type = match trade.direction.as_str() {
            "buy" => "buy",
            "sell" => "sell",
            _ => continue,
        };

        let Some(closed_at) = parse_timestamp(&trade.timestamp) else {
            continue;
        };
        if closed_at < baseline {
            continue;
        }

        let items_sent = trade.items_sent;
        let items_received = trade.items_received;
        let total_platinum = trade.total_plat.unwrap_or_else(|| {
            let platinum_items = if order_type == "buy" {
                &items_sent
            } else {
                &items_received
            };
            platinum_items
                .iter()
                .filter(|item| is_platinum_trade_item(item))
                .map(|item| item.cnt.max(0))
                .sum::<i64>()
        });

        let trade_items = if order_type == "buy" {
            items_received
        } else {
            items_sent
        }
        .into_iter()
        .filter(|item| !is_platinum_trade_item(item))
        .filter(|item| item.cnt > 0)
        .collect::<Vec<_>>();

        if trade_items.is_empty() {
            continue;
        }

        if total_platinum <= 0 {
            continue;
        }

        let preview_rows = trade_items
            .iter()
            .map(|item| {
                let meta = resolve_catalog_trade_item_by_alias(&catalog, &item.name)
                    .ok()
                    .flatten();
                let item_name = meta
                    .as_ref()
                    .map(|entry| entry.name.clone())
                    .or_else(|| item.display_name.clone())
                    .unwrap_or_else(|| prettify_alecaframe_name(&item.name));
                (item_name, item.cnt.max(1))
            })
            .collect::<Vec<_>>();

        let group_is_duplicate = if preview_rows.len() > 1 {
            preview_rows.iter().all(|(item_name, quantity)| {
                find_duplicate_trade_record(existing, order_type, item_name, *quantity, &closed_at)
            })
        } else {
            preview_rows
                .first()
                .map(|(item_name, quantity)| {
                    find_duplicate_trade_record(
                        existing, order_type, item_name, *quantity, &closed_at,
                    )
                })
                .unwrap_or(false)
        };

        if group_is_duplicate {
            continue;
        }

        let unit_counts = trade_items
            .iter()
            .map(|item| item.cnt.max(1))
            .collect::<Vec<_>>();
        let allocations = allocated_row_totals(total_platinum, &unit_counts);
        let group_id = if trade_items.len() > 1 {
            Some(stable_trade_group_id(
                username,
                order_type,
                &trade.timestamp,
                total_platinum,
                &trade_items
                    .iter()
                    .map(|item| item.name.clone())
                    .collect::<Vec<_>>(),
            ))
        } else {
            None
        };

        for (index, item) in trade_items.into_iter().enumerate() {
            let meta = resolve_catalog_trade_item_by_alias(&catalog, &item.name)?;
            let item_name = meta
                .as_ref()
                .map(|entry| entry.name.clone())
                .or(item.display_name.clone())
                .unwrap_or_else(|| prettify_alecaframe_name(&item.name));
            let quantity = item.cnt.max(1);
            if group_id.is_none()
                && find_duplicate_trade_record(
                    existing, order_type, &item_name, quantity, &closed_at,
                )
            {
                continue;
            }

            let slug = meta
                .as_ref()
                .map(|entry| entry.slug.clone())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| build_fallback_slug(&item_name));
            let sort_order = index as i64;
            let effective_group_id = group_id.clone();
            let row_id = effective_group_id
                .as_ref()
                .map(|value| stable_trade_row_id(value, index, &item.name))
                .unwrap_or_else(|| {
                    stable_trade_row_id(
                        &format!("af-single-{order_type}-{}", trade.timestamp),
                        0,
                        &item.name,
                    )
                });

            imported.push(PortfolioTradeLogEntry {
                id: row_id,
                item_name,
                slug,
                image_path: meta.as_ref().and_then(|entry| entry.image_path.clone()),
                order_type: order_type.to_string(),
                source: "alecaframe".to_string(),
                platinum: allocations[index],
                quantity,
                rank: normalize_alecaframe_rank(item.rank),
                closed_at: trade.timestamp.clone(),
                updated_at: trade.timestamp.clone(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: effective_group_id.clone(),
                group_label: effective_group_id
                    .as_ref()
                    .map(|_| "Multiple Item Trade".to_string()),
                group_total_platinum: effective_group_id.as_ref().map(|_| total_platinum),
                group_item_count: effective_group_id
                    .as_ref()
                    .map(|_| preview_rows.len() as i64),
                allocation_total_platinum: Some(allocations[index]),
                group_sort_order: effective_group_id.as_ref().map(|_| sort_order),
                allocation_mode: effective_group_id.as_ref().map(|_| "auto".to_string()),
                cost_basis_confidence: None,
                cost_basis_label: None,
                matched_cost: None,
                matched_quantity: None,
                matched_buy_count: 0,
                matched_buy_rows: Vec::new(),
                set_component_rows: Vec::new(),
                profit_formula: None,
                duplicate_risk: false,
            });
        }
    }

    Ok(imported)
}

fn fetch_profile_trade_log_inner_with_priority(
    username: &str,
    priority: RequestPriority,
) -> Result<Vec<PortfolioTradeLogEntry>> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!("Username is required to load the trade log."));
    }

    let client = shared_wfm_client()?;
    let mut url = reqwest::Url::parse(&format!("{WFM_API_BASE_URL_V1}/profile/"))
        .context("failed to build WFM trade history url")?;
    url.path_segments_mut()
        .map_err(|_| anyhow!("failed to build WFM trade history path"))?
        .push(trimmed_username)
        .push("statistics");

    let response = execute_wfm_bytes_request(
        client
            .get(url.clone())
            .header("User-Agent", WFM_USER_AGENT)
            .header("Accept", "application/json"),
        priority,
        "request WFM trade history",
        Some(format!("trade-history:{}", url)),
    )?;
    if response.status < 200 || response.status >= 300 {
        let body = String::from_utf8_lossy(&response.body);
        let trimmed = body.trim();
        return Err(if trimmed.is_empty() {
            anyhow!(
                "request WFM trade history failed with status {}",
                response.status
            )
        } else {
            anyhow!(
                "request WFM trade history failed with status {}: {}",
                response.status,
                trimmed
            )
        });
    }
    let payload = serde_json::from_slice::<WfmProfileStatisticsResponse>(&response.body)
        .context("failed to parse WFM trade history response")?;

    Ok(build_trade_log_entries_from_statistics(payload.payload))
}

fn fetch_profile_trade_log_inner(username: &str) -> Result<Vec<PortfolioTradeLogEntry>> {
    fetch_profile_trade_log_inner_with_priority(username, RequestPriority::High)
}

fn load_stored_trade_log_records_inner(
    connection: &Connection,
    username: &str,
) -> Result<Vec<StoredTradeLogRecord>> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!("Username is required to load the trade log."));
    }

    let mut statement = connection
        .prepare(
            "
            SELECT
              cache.order_id,
              cache.item_name,
              cache.slug,
              cache.image_path,
              cache.order_type,
              cache.source,
              cache.platinum,
              cache.quantity,
              cache.rank,
              cache.closed_at,
              cache.updated_at,
              COALESCE(overrides.keep_item, cache.keep_item, 0),
              cache.group_id,
              cache.group_label,
              cache.group_total_platinum,
              cache.group_item_count,
              cache.allocation_total_platinum,
              cache.group_sort_order
            FROM portfolio_trade_log_cache AS cache
            LEFT JOIN portfolio_trade_log_overrides AS overrides
              ON overrides.username = cache.username
             AND overrides.order_id = cache.order_id
            WHERE cache.username = ?1
            ORDER BY cache.closed_at ASC, cache.updated_at ASC, cache.order_id ASC
            ",
        )
        .context("failed to prepare stored trade log query")?;

    let rows = statement
        .query_map(params![trimmed_username], |row| {
            Ok(StoredTradeLogRecord {
                id: row.get(0)?,
                item_name: row.get(1)?,
                slug: row.get(2)?,
                image_path: row.get(3)?,
                order_type: row.get(4)?,
                source: row.get(5)?,
                platinum: row.get(6)?,
                quantity: row.get(7)?,
                rank: row.get(8)?,
                closed_at: row.get(9)?,
                updated_at: row.get(10)?,
                keep_item: row.get::<_, i64>(11)? != 0,
                group_id: row.get(12)?,
                group_label: row.get(13)?,
                group_total_platinum: row.get(14)?,
                group_item_count: row.get(15)?,
                allocation_total_platinum: row.get(16)?,
                group_sort_order: row.get(17)?,
            })
        })
        .context("failed to read stored trade log rows")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect stored trade log rows")?;

    Ok(rows)
}

fn load_trade_log_last_updated_at(
    connection: &Connection,
    username: &str,
) -> Result<Option<String>> {
    connection
        .query_row(
            "
            SELECT last_updated_at
            FROM portfolio_trade_log_cache_meta
            WHERE username = ?1
            ",
            params![username.trim()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("failed to read cached trade log metadata")
}

fn load_alecaframe_trade_baseline_date_inner(
    connection: &Connection,
    username: &str,
) -> Result<Option<String>> {
    connection
        .query_row(
            "
            SELECT alecaframe_baseline_date
            FROM portfolio_trade_log_cache_meta
            WHERE username = ?1
            ",
            params![username.trim()],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .context("failed to read Alecaframe trade baseline date")
        .map(|value| value.flatten())
}

fn save_alecaframe_trade_baseline_date_inner(
    connection: &Connection,
    username: &str,
    baseline_date: &str,
) -> Result<()> {
    let trimmed_username = username.trim();
    let trimmed_baseline = baseline_date.trim();
    if trimmed_username.is_empty() || trimmed_baseline.is_empty() {
        return Ok(());
    }

    let updated_at = format_timestamp(now_utc())?;
    connection
        .execute(
            "
            INSERT INTO portfolio_trade_log_cache_meta (
              username,
              last_updated_at,
              entry_count,
              alecaframe_baseline_date
            ) VALUES (?1, ?2, 0, ?3)
            ON CONFLICT(username) DO UPDATE SET
              alecaframe_baseline_date = excluded.alecaframe_baseline_date
            ",
            params![trimmed_username, updated_at, trimmed_baseline],
        )
        .context("failed to persist Alecaframe trade baseline date")?;
    Ok(())
}

fn trade_notification_fingerprint_exists_inner(
    connection: &Connection,
    username: &str,
    fingerprint: &str,
) -> Result<bool> {
    Ok(connection
        .query_row(
            "
            SELECT 1
            FROM portfolio_trade_log_notifications
            WHERE username = ?1
              AND fingerprint = ?2
            LIMIT 1
            ",
            params![username.trim(), fingerprint.trim()],
            |_row| Ok(()),
        )
        .optional()
        .context("failed to read trade notification fingerprint")?
        .is_some())
}

fn persist_trade_notification_fingerprint_inner(
    connection: &Connection,
    username: &str,
    fingerprint: &str,
    source: &str,
    closed_at: &str,
) -> Result<()> {
    let notified_at = format_timestamp(now_utc())?;
    connection
        .execute(
            "
            INSERT OR IGNORE INTO portfolio_trade_log_notifications (
              username,
              fingerprint,
              source,
              notified_at,
              closed_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)
            ",
            params![
                username.trim(),
                fingerprint.trim(),
                source.trim(),
                notified_at,
                closed_at.trim(),
            ],
        )
        .context("failed to persist trade notification fingerprint")?;
    Ok(())
}

fn trade_record_matches_existing_duplicate(
    existing: &[StoredTradeLogRecord],
    entry: &PortfolioTradeLogEntry,
) -> bool {
    let Some(closed_at) = parse_timestamp(&entry.closed_at) else {
        return false;
    };

    find_duplicate_trade_record(
        existing,
        &entry.order_type,
        &entry.item_name,
        entry.quantity,
        &closed_at,
    )
}

fn append_unique_trade_entries(
    existing: &[PortfolioTradeLogEntry],
    incoming: &[PortfolioTradeLogEntry],
) -> Vec<PortfolioTradeLogEntry> {
    let existing_records = existing
        .iter()
        .map(build_stored_trade_record_from_entry)
        .collect::<Vec<_>>();
    let mut combined = existing.to_vec();

    for entry in incoming {
        if existing_records.iter().any(|record| record.id == entry.id) {
            continue;
        }
        if trade_record_matches_existing_duplicate(&existing_records, entry) {
            continue;
        }
        combined.push(entry.clone());
    }

    combined
}

fn merge_wfm_trade_log_entries(
    existing: &[StoredTradeLogRecord],
    fetched_entries: &[PortfolioTradeLogEntry],
) -> (Vec<PortfolioTradeLogEntry>, Vec<PortfolioTradeLogEntry>) {
    let existing_ids = existing
        .iter()
        .map(|record| record.id.clone())
        .collect::<HashSet<_>>();

    let persisted_entries = fetched_entries
        .iter()
        .filter(|entry| {
            if existing_ids.contains(&entry.id) {
                return true;
            }

            !trade_record_matches_existing_duplicate(existing, entry)
        })
        .cloned()
        .collect::<Vec<_>>();

    let new_entries = persisted_entries
        .iter()
        .filter(|entry| !existing_ids.contains(&entry.id))
        .cloned()
        .collect::<Vec<_>>();

    (persisted_entries, new_entries)
}

fn has_complete_derived_trade_log_state(connection: &Connection, username: &str) -> Result<bool> {
    let trimmed_username = username.trim();
    let cached_count = connection
        .query_row(
            "
            SELECT COUNT(*)
            FROM portfolio_trade_log_cache
            WHERE username = ?1
            ",
            params![trimmed_username],
            |row| row.get::<_, i64>(0),
        )
        .context("failed to count cached trade log rows")?;

    if cached_count == 0 {
        return Ok(true);
    }

    let derived_count = connection
        .query_row(
            "
            SELECT COUNT(*)
            FROM portfolio_trade_log_derived
            WHERE username = ?1
            ",
            params![trimmed_username],
            |row| row.get::<_, i64>(0),
        )
        .context("failed to count derived trade log rows")?;

    if cached_count != derived_count {
        return Ok(false);
    }

    let current_version_count = connection
        .query_row(
            "
            SELECT COUNT(*)
            FROM portfolio_trade_log_derived
            WHERE username = ?1
              AND derived_version = ?2
            ",
            params![trimmed_username, TRADE_LOG_DERIVED_VERSION],
            |row| row.get::<_, i64>(0),
        )
        .context("failed to count current-version derived trade log rows")?;

    Ok(cached_count == current_version_count)
}

fn fetch_cached_trade_set_components(
    connection: &Connection,
    set_slug: &str,
) -> Result<Vec<TradeSetComponentRecord>> {
    let mut statement = connection
        .prepare(
            "
            SELECT component_slug, quantity_in_set, fetched_at
            FROM trade_set_component_cache
            WHERE set_slug = ?1
            ORDER BY sort_order ASC, component_slug ASC
            ",
        )
        .context("failed to prepare trades set component cache query")?;

    let rows = statement
        .query_map(params![set_slug], |row| {
            Ok(TradeSetComponentRecord {
                component_slug: row.get(0)?,
                quantity_in_set: row.get::<_, i64>(1)?.max(1),
                fetched_at: row.get(2)?,
            })
        })
        .context("failed to query trades set component cache")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect trades set component cache rows")?;

    Ok(rows)
}

fn trade_set_component_cache_is_fresh(entries: &[TradeSetComponentRecord]) -> bool {
    let Some(fetched_at) = entries
        .first()
        .and_then(|entry| parse_timestamp(&entry.fetched_at))
    else {
        return false;
    };

    (now_utc() - fetched_at) < time::Duration::days(TRADE_SET_COMPONENT_CACHE_RETENTION_DAYS)
}

fn persist_trade_set_component_cache(
    connection: &Connection,
    set_slug: &str,
    components: &[TradeSetComponentRecord],
) -> Result<()> {
    connection
        .execute(
            "DELETE FROM trade_set_component_cache WHERE set_slug = ?1",
            params![set_slug],
        )
        .context("failed to clear trade set component cache")?;

    let mut statement = connection
        .prepare(
            "
            INSERT INTO trade_set_component_cache (
              set_slug,
              component_slug,
              quantity_in_set,
              sort_order,
              fetched_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)
            ",
        )
        .context("failed to prepare trade set component cache insert")?;

    for (index, component) in components.iter().enumerate() {
        statement
            .execute(params![
                set_slug,
                component.component_slug,
                component.quantity_in_set,
                index as i64,
                component.fetched_at,
            ])
            .context("failed to insert trade set component cache row")?;
    }

    Ok(())
}

fn load_trade_set_components_from_catalog(
    catalog_connection: &Connection,
    set_slug: &str,
) -> Result<Vec<TradeSetComponentRecord>> {
    let set_item_id = catalog_connection
        .query_row(
            "SELECT item_id
             FROM items
             WHERE wfm_slug = ?1 OR preferred_slug = ?1
             LIMIT 1",
            params![set_slug],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .context("failed to resolve set item id for catalog component lookup")?;

    let Some(set_item_id) = set_item_id else {
        return Ok(Vec::new());
    };

    let set_unique_name = catalog_connection
        .query_row(
            "SELECT primary_wfstat_unique_name
             FROM items
             WHERE item_id = ?1
             LIMIT 1",
            params![set_item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .context("failed to resolve set wfstat unique name for catalog component lookup")?
        .flatten();
    let Some(set_unique_name) = set_unique_name else {
        return Ok(Vec::new());
    };

    let fetched_at = format_timestamp(now_utc())?;
    let mut statement = catalog_connection.prepare(
        "
        SELECT
          COALESCE(ci.wfm_slug, ci.preferred_slug) AS component_slug,
          c.item_count,
          c.raw_json,
          c.component_index
        FROM wfstat_item_components c
        JOIN items ci ON ci.item_id = c.component_item_id
        WHERE c.wfstat_unique_name = ?1
          AND (ci.wfm_slug IS NOT NULL OR ci.preferred_slug IS NOT NULL)
        ORDER BY c.component_index ASC, component_slug ASC
        ",
    )?;
    let rows = statement
        .query_map(params![set_unique_name], |row| {
            let raw_json: Option<String> = row.get(2)?;
            let quantity_from_raw = raw_json
                .as_deref()
                .and_then(extract_component_quantity_from_raw);
            let quantity_in_set = row
                .get::<_, Option<i64>>(1)?
                .or(quantity_from_raw)
                .unwrap_or(1)
                .max(1);
            Ok(TradeSetComponentRecord {
                component_slug: row.get(0)?,
                quantity_in_set,
                fetched_at: fetched_at.clone(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect catalog set components")?;

    Ok(rows)
}

fn extract_component_quantity_from_raw(raw_json: &str) -> Option<i64> {
    let payload = serde_json::from_str::<serde_json::Value>(raw_json).ok()?;
    payload
        .get("itemCount")
        .and_then(serde_json::Value::as_i64)
        .or_else(|| payload.get("count").and_then(serde_json::Value::as_i64))
}

fn list_trade_set_roots_from_catalog(connection: &Connection) -> Result<Vec<TradeSetRootRecord>> {
    let mut statement = connection
        .prepare(
            "
            SELECT
              COALESCE(items.wfm_slug, wfm_items.slug) AS slug,
              COALESCE(items.preferred_name, wfm_items.name_en, items.canonical_name) AS name,
              COALESCE(items.preferred_image, wfm_items.thumb, wfm_items.icon) AS image_path
            FROM items
            JOIN wfm_items
              ON wfm_items.wfm_id = items.wfm_id
            WHERE EXISTS (
              SELECT 1
              FROM wfm_item_tags
              WHERE wfm_item_tags.wfm_id = wfm_items.wfm_id
                AND wfm_item_tags.tag = 'set'
            )
            ORDER BY LOWER(COALESCE(items.preferred_name, wfm_items.name_en, items.canonical_name)) ASC
            ",
        )
        .context("failed to prepare trade set root catalog query")?;

    let rows = statement
        .query_map([], |row| {
            Ok(TradeSetRootRecord {
                slug: row.get(0)?,
                name: row.get(1)?,
                image_path: row.get(2)?,
            })
        })
        .context("failed to query trade set roots from catalog")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect trade set roots from catalog")?;

    Ok(rows)
}

fn load_trade_set_map_file(path: &Path) -> Result<Option<TradeSetMapFile>> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read trade set map at {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }

    let file = serde_json::from_str::<TradeSetMapFile>(&raw)
        .with_context(|| format!("failed to parse trade set map at {}", path.display()))?;
    Ok(Some(file))
}

fn map_trade_set_components_from_file(
    set_map: &TradeSetMapFile,
    set_slug: &str,
) -> Vec<TradeSetComponentRecord> {
    let target_slug = set_slug.trim();
    if target_slug.is_empty() {
        return Vec::new();
    }

    let Some(set_record) = set_map
        .sets
        .iter()
        .find(|record| record.slug == target_slug)
    else {
        return Vec::new();
    };

    set_record
        .components
        .iter()
        .map(|component| TradeSetComponentRecord {
            component_slug: component.slug.clone(),
            quantity_in_set: component.quantity_in_set.max(1),
            fetched_at: set_map.generated_at.clone(),
        })
        .collect()
}

fn load_trade_set_components_from_map(
    app: &tauri::AppHandle,
    set_slug: &str,
) -> Result<Vec<TradeSetComponentRecord>> {
    let map_path = build_trade_set_map_path(app)?;
    let Some(file) = load_trade_set_map_file(&map_path)? else {
        return Ok(Vec::new());
    };

    Ok(map_trade_set_components_from_file(&file, set_slug))
}

fn save_trade_set_map_file(path: &Path, file: &TradeSetMapFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create trade set map directory {}",
                parent.display()
            )
        })?;
    }

    let mut updated = file.clone();
    updated.warstonks_version = Some(env!("CARGO_PKG_VERSION").to_string());
    let raw =
        serde_json::to_string_pretty(&updated).context("failed to serialize trade set map")?;
    fs::write(path, raw)
        .with_context(|| format!("failed to write trade set map at {}", path.display()))
}

fn persist_trade_set_map_into_cache(
    connection: &Connection,
    set_map: &TradeSetMapFile,
) -> Result<()> {
    for set_record in &set_map.sets {
        let components = set_record
            .components
            .iter()
            .map(|component| TradeSetComponentRecord {
                component_slug: component.slug.clone(),
                quantity_in_set: component.quantity_in_set.max(1),
                fetched_at: set_map.generated_at.clone(),
            })
            .collect::<Vec<_>>();
        persist_trade_set_component_cache(connection, &set_record.slug, &components)?;
    }

    Ok(())
}

fn build_trade_set_map_inner(
    app: &tauri::AppHandle,
    api_version: Option<&str>,
) -> Result<TradeSetMapSummary> {
    let map_path = build_trade_set_map_path(app)?;
    let app_version = env!("CARGO_PKG_VERSION");
    let version_key = api_version
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    if let Some(existing) = load_trade_set_map_file(&map_path)? {
        let existing_version = existing
            .api_version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let existing_app_version = existing
            .warstonks_version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if existing_version == version_key && existing_app_version == Some(app_version) {
            let cache_connection = open_trades_cache_database(app)?;
            persist_trade_set_map_into_cache(&cache_connection, &existing)?;
            return Ok(TradeSetMapSummary {
                ready: true,
                refreshed: false,
                api_version: existing.api_version,
                set_count: existing.sets.len() as i64,
                file_path: map_path.display().to_string(),
            });
        }
    }

    let catalog_connection = open_catalog_database(app)?;
    let set_roots = list_trade_set_roots_from_catalog(&catalog_connection)?;
    let generated_at = format_timestamp(now_utc())?;
    let mut sets = Vec::with_capacity(set_roots.len());

    for set_root in &set_roots {
        let components =
            load_trade_set_components_from_catalog(&catalog_connection, &set_root.slug)?
                .into_iter()
                .map(|component| TradeSetMapComponentRecord {
                    slug: component.component_slug,
                    quantity_in_set: component.quantity_in_set.max(1),
                })
                .collect::<Vec<_>>();

        sets.push(TradeSetMapSetRecord {
            slug: set_root.slug.clone(),
            name: set_root.name.clone(),
            image_path: set_root.image_path.clone(),
            components,
        });
    }

    let set_map = TradeSetMapFile {
        warstonks_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        api_version: version_key.map(str::to_string),
        generated_at: generated_at.clone(),
        sets,
    };

    save_trade_set_map_file(&map_path, &set_map)?;
    let cache_connection = open_trades_cache_database(app)?;
    persist_trade_set_map_into_cache(&cache_connection, &set_map)?;

    Ok(TradeSetMapSummary {
        ready: true,
        refreshed: true,
        api_version: set_map.api_version,
        set_count: set_map.sets.len() as i64,
        file_path: map_path.display().to_string(),
    })
}

fn load_observatory_trade_set_components(
    app: &tauri::AppHandle,
    set_slug: &str,
) -> Result<Vec<TradeSetComponentRecord>> {
    let observatory_connection = open_market_observatory_database(app)?;
    let mut statement = observatory_connection
        .prepare(
            "
            SELECT component_slug, quantity_in_set, fetched_at
            FROM set_component_cache
            WHERE set_slug = ?1
            ORDER BY sort_order ASC, component_slug ASC
            ",
        )
        .context("failed to prepare observatory set component cache query")?;

    let rows = statement
        .query_map(params![set_slug], |row| {
            Ok(TradeSetComponentRecord {
                component_slug: row.get(0)?,
                quantity_in_set: row.get::<_, i64>(1)?.max(1),
                fetched_at: row.get(2)?,
            })
        })
        .context("failed to query observatory set component cache")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect observatory set component cache rows")?;

    Ok(rows)
}

fn load_trade_set_components_for_slug(
    app: &tauri::AppHandle,
    set_slug: &str,
) -> Result<Vec<TradeSetComponentRecord>> {
    let cache_connection = open_trades_cache_database(app)?;
    let cached = fetch_cached_trade_set_components(&cache_connection, set_slug)?;
    if !cached.is_empty() && trade_set_component_cache_is_fresh(&cached) {
        return Ok(cached);
    }

    if let Ok(observatory_rows) = load_observatory_trade_set_components(app, set_slug) {
        if !observatory_rows.is_empty() {
            persist_trade_set_component_cache(&cache_connection, set_slug, &observatory_rows)?;
            return Ok(observatory_rows);
        }
    }

    Ok(Vec::new())
}

fn write_trade_log_rows_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    username: &str,
    entries: &[PortfolioTradeLogEntry],
    last_updated_at: &str,
) -> Result<()> {
    let mut insert_statement = tx
        .prepare(
            "
            INSERT INTO portfolio_trade_log_cache (
              username,
              order_id,
              item_name,
              slug,
              image_path,
              order_type,
              source,
              platinum,
              quantity,
              rank,
              closed_at,
              updated_at,
              group_id,
              group_label,
              group_total_platinum,
              group_item_count,
              allocation_total_platinum,
              group_sort_order,
              keep_item
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
              COALESCE(
                (SELECT keep_item
                 FROM portfolio_trade_log_overrides
                 WHERE username = ?1 AND order_id = ?2),
                ?19
              )
            )
            ON CONFLICT(username, order_id) DO UPDATE SET
              item_name = excluded.item_name,
              slug = excluded.slug,
              image_path = excluded.image_path,
              order_type = excluded.order_type,
              source = excluded.source,
              platinum = excluded.platinum,
              quantity = excluded.quantity,
              rank = excluded.rank,
              closed_at = excluded.closed_at,
              updated_at = excluded.updated_at,
              group_id = excluded.group_id,
              group_label = excluded.group_label,
              group_total_platinum = excluded.group_total_platinum,
              group_item_count = excluded.group_item_count,
              allocation_total_platinum = excluded.allocation_total_platinum,
              group_sort_order = excluded.group_sort_order
            ",
        )
        .context("failed to prepare trade log cache upsert")?;

    for entry in entries {
        insert_statement
            .execute(params![
                username,
                entry.id,
                entry.item_name,
                entry.slug,
                entry.image_path,
                entry.order_type,
                entry.source,
                entry.platinum,
                entry.quantity,
                entry.rank,
                entry.closed_at,
                entry.updated_at,
                entry.group_id,
                entry.group_label,
                entry.group_total_platinum,
                entry.group_item_count,
                entry.allocation_total_platinum,
                entry.group_sort_order.unwrap_or(0),
                if entry.keep_item { 1 } else { 0 },
            ])
            .context("failed to upsert cached trade log row")?;
    }

    tx.execute(
        "
        INSERT INTO portfolio_trade_log_cache_meta (
          username,
          last_updated_at,
          entry_count
        ) VALUES (?1, ?2, ?3)
        ON CONFLICT(username) DO UPDATE SET
          last_updated_at = excluded.last_updated_at,
          entry_count = excluded.entry_count
        ",
        params![username, last_updated_at, entries.len() as i64],
    )
    .context("failed to upsert cached trade log metadata")?;

    Ok(())
}

fn save_trade_log_rows_inner(
    connection: &mut Connection,
    username: &str,
    entries: &[PortfolioTradeLogEntry],
) -> Result<String> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!("Username is required to cache the trade log."));
    }

    let last_updated_at = format_timestamp(now_utc())?;
    let tx = connection
        .transaction()
        .context("failed to start trade log cache transaction")?;

    write_trade_log_rows_in_transaction(&tx, trimmed_username, entries, &last_updated_at)?;

    tx.commit()
        .context("failed to commit trade log cache transaction")?;

    Ok(last_updated_at)
}

fn replace_trade_log_rows_inner(
    connection: &mut Connection,
    username: &str,
    entries: &[PortfolioTradeLogEntry],
) -> Result<String> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!(
            "Username is required to replace the trade log cache."
        ));
    }

    let last_updated_at = format_timestamp(now_utc())?;
    let tx = connection
        .transaction()
        .context("failed to start trade log replacement transaction")?;

    tx.execute(
        "DELETE FROM portfolio_trade_log_cache WHERE username = ?1",
        params![trimmed_username],
    )
    .context("failed to clear cached trade log rows for replacement")?;

    write_trade_log_rows_in_transaction(&tx, trimmed_username, entries, &last_updated_at)?;

    tx.commit()
        .context("failed to commit trade log replacement transaction")?;

    // NOTE: stale override pruning is intentionally deferred to
    // reconcile_trade_log_state_inner, which runs after
    // normalize_grouped_trade_sets_inner has collapsed Set entries.
    // Pruning here would discard keep-item overrides for Set entries whose
    // collapsed IDs ("af-set-...") don't exist in the cache yet.

    Ok(last_updated_at)
}

fn persist_derived_trade_log_entries_inner(
    connection: &mut Connection,
    username: &str,
    entries: &[PortfolioTradeLogEntry],
) -> Result<()> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!(
            "Username is required to persist the derived trade log."
        ));
    }

    let derived_at = format_timestamp(now_utc())?;
    let transaction = connection
        .transaction()
        .context("failed to start derived trade log transaction")?;

    transaction
        .execute(
            "DELETE FROM portfolio_trade_log_derived WHERE username = ?1",
            params![trimmed_username],
        )
        .context("failed to clear derived trade log rows")?;

    {
        let mut insert_statement = transaction
            .prepare(
                "
                INSERT INTO portfolio_trade_log_derived (
                  username,
                  order_id,
                  profit,
                  margin,
                  status,
                  derived_version,
                  derived_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ",
            )
            .context("failed to prepare derived trade log insert")?;

        for entry in entries {
            insert_statement
                .execute(params![
                    trimmed_username,
                    entry.id,
                    entry.profit,
                    entry.margin,
                    entry.status,
                    TRADE_LOG_DERIVED_VERSION,
                    derived_at,
                ])
                .context("failed to insert derived trade log row")?;
        }
    }

    transaction
        .commit()
        .context("failed to commit derived trade log transaction")?;

    Ok(())
}

fn record_total_platinum(record: &StoredTradeLogRecord) -> i64 {
    record
        .allocation_total_platinum
        .unwrap_or(record.platinum.saturating_mul(record.quantity))
}

fn build_trade_allocation_mode(record: &StoredTradeLogRecord) -> Option<String> {
    record.group_id.as_ref()?;
    Some(if record.allocation_total_platinum.is_some() {
        "manual".to_string()
    } else {
        "auto".to_string()
    })
}

fn portfolio_display_name_from_slug(slug: &str) -> String {
    slug.split('_')
        .filter(|part| !part.trim().is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_cost_basis_confidence(
    order_type: &str,
    quantity: i64,
    matched_quantity: i64,
    matched_cost: i64,
) -> (Option<String>, Option<String>) {
    if order_type != "sell" {
        return (None, None);
    }

    if matched_cost <= 0 || matched_quantity <= 0 {
        return (Some("none".to_string()), Some("No Cost Basis".to_string()));
    }

    if matched_quantity >= quantity.max(1) {
        return (
            Some("full".to_string()),
            Some("Full Cost Basis".to_string()),
        );
    }

    (
        Some("partial".to_string()),
        Some("Partial Cost Basis".to_string()),
    )
}

fn build_profit_formula(revenue: i64, matched_cost: i64, profit: i64) -> String {
    format!(
        "{} sell - {} matched cost = {} profit",
        format_platinum_amount(revenue),
        format_platinum_amount(matched_cost),
        format_platinum_amount(profit)
    )
}

fn format_platinum_amount(value: i64) -> String {
    format!("{value}p")
}

fn build_portfolio_entry_from_stored_record(
    record: &StoredTradeLogRecord,
) -> PortfolioTradeLogEntry {
    PortfolioTradeLogEntry {
        id: record.id.clone(),
        item_name: record.item_name.clone(),
        slug: record.slug.clone(),
        image_path: record.image_path.clone(),
        order_type: record.order_type.clone(),
        source: record.source.clone(),
        platinum: record.platinum,
        quantity: record.quantity,
        rank: record.rank,
        closed_at: record.closed_at.clone(),
        updated_at: record.updated_at.clone(),
        profit: None,
        margin: None,
        status: None,
        keep_item: record.keep_item,
        group_id: record.group_id.clone(),
        group_label: record.group_label.clone(),
        group_total_platinum: record.group_total_platinum,
        group_item_count: record.group_item_count,
        allocation_total_platinum: record.allocation_total_platinum,
        group_sort_order: record.group_sort_order,
        allocation_mode: build_trade_allocation_mode(record),
        cost_basis_confidence: None,
        cost_basis_label: None,
        matched_cost: None,
        matched_quantity: None,
        matched_buy_count: 0,
        matched_buy_rows: Vec::new(),
        set_component_rows: Vec::new(),
        profit_formula: None,
        duplicate_risk: false,
    }
}

fn build_stored_trade_record_from_entry(entry: &PortfolioTradeLogEntry) -> StoredTradeLogRecord {
    StoredTradeLogRecord {
        id: entry.id.clone(),
        item_name: entry.item_name.clone(),
        slug: entry.slug.clone(),
        image_path: entry.image_path.clone(),
        order_type: entry.order_type.clone(),
        source: entry.source.clone(),
        platinum: entry.platinum,
        quantity: entry.quantity,
        rank: entry.rank,
        closed_at: entry.closed_at.clone(),
        updated_at: entry.updated_at.clone(),
        keep_item: entry.keep_item,
        group_id: entry.group_id.clone(),
        group_label: entry.group_label.clone(),
        group_total_platinum: entry.group_total_platinum,
        group_item_count: entry.group_item_count,
        allocation_total_platinum: entry.allocation_total_platinum,
        group_sort_order: entry.group_sort_order,
    }
}

fn load_trade_set_definitions(
    app: &tauri::AppHandle,
) -> Result<Vec<(TradeSetRootRecord, Vec<TradeSetComponentRecord>)>> {
    let catalog = open_catalog_database(app)?;
    let set_roots = list_trade_set_roots_from_catalog(&catalog)?;
    let mut set_definitions = Vec::new();
    for set_root in set_roots {
        let components = load_trade_set_components_for_slug(app, &set_root.slug)?;
        if components.is_empty() {
            continue;
        }

        set_definitions.push((set_root, components));
    }

    Ok(set_definitions)
}

fn normalize_trade_entries_for_owned_component_sync(
    app: &tauri::AppHandle,
    entries: &[PortfolioTradeLogEntry],
) -> Result<Vec<StoredTradeLogRecord>> {
    let records = entries
        .iter()
        .map(build_stored_trade_record_from_entry)
        .collect::<Vec<_>>();
    if records.iter().all(|record| record.group_id.is_none()) {
        return Ok(records);
    }

    let set_definitions = load_trade_set_definitions(app)?;
    Ok(collapse_grouped_trade_sets(&records, &set_definitions).0)
}

fn build_owned_set_component_deltas_for_entries(
    app: &tauri::AppHandle,
    entries: &[PortfolioTradeLogEntry],
) -> Result<Vec<OwnedSetComponentDelta>> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let normalized_records = normalize_trade_entries_for_owned_component_sync(app, entries)?;
    let catalog = open_catalog_database(app)?;
    let observatory = open_market_observatory_database(app)?;

    // Any trade that closed before the screenshot import is irrelevant — its
    // effect is already captured in the protected baseline.
    let import_cutoff = load_set_completion_screenshot_import_cutoff(app)?;
    let import_cutoff_time = import_cutoff
        .as_deref()
        .and_then(parse_timestamp);

    let mut deltas = Vec::new();

    for record in normalized_records {
        let normalized_order_type = record.order_type.trim().to_lowercase();
        if normalized_order_type == "buy" && record.keep_item {
            continue;
        }

        // Skip trades that were closed before the screenshot import — they're
        // already reflected in the screenshot baseline and must not be counted again.
        if let Some(cutoff) = import_cutoff_time {
            if let Some(closed) = parse_timestamp(&record.closed_at) {
                if closed <= cutoff {
                    continue;
                }
            }
        }

        let direction = match normalized_order_type.as_str() {
            "buy" => 1_i64,
            "sell" => -1_i64,
            _ => continue,
        };
        let trade_quantity = record.quantity.max(1);
        let trade_sync_key = build_trade_owned_sync_key(&record);

        if record.slug.ends_with("_set") {
            let mut components = load_trade_set_components_for_slug(app, &record.slug)?;
            if components.is_empty() {
                components = load_trade_set_components_from_map(app, &record.slug)?;
            }
            for component in components {
                let Some(meta) =
                    resolve_catalog_trade_item_by_slug(&catalog, &component.component_slug)?
                else {
                    continue;
                };
                let quantity_delta = direction
                    .saturating_mul(trade_quantity)
                    .saturating_mul(component.quantity_in_set.max(1));
                if quantity_delta == 0 {
                    continue;
                }

                deltas.push(OwnedSetComponentDelta {
                    sync_key: format!("trade-owned:{trade_sync_key}:{}", component.component_slug),
                    item_id: meta.item_id,
                    slug: meta.slug,
                    name: meta.name,
                    image_path: meta.image_path,
                    quantity_delta,
                });
            }
            continue;
        }

        if !observatory_contains_set_component_slug(&observatory, &record.slug)? {
            continue;
        }

        let Some(meta) = resolve_catalog_trade_item_by_slug(&catalog, &record.slug)? else {
            continue;
        };
        let quantity_delta = direction.saturating_mul(trade_quantity);
        if quantity_delta == 0 {
            continue;
        }

        deltas.push(OwnedSetComponentDelta {
            sync_key: format!("trade-owned:{trade_sync_key}:{}", record.slug),
            item_id: meta.item_id,
            slug: meta.slug,
            name: meta.name,
            image_path: meta.image_path,
            quantity_delta,
        });
    }

    Ok(deltas)
}

fn record_consumed_platinum(record: &StoredTradeLogRecord, quantity: i64) -> i64 {
    let normalized_quantity = quantity.max(0);
    if normalized_quantity <= 0 {
        return 0;
    }

    if let Some(total) = record.allocation_total_platinum {
        if record.quantity <= 0 {
            return total;
        }

        // i128 intermediate so the rounding multiply can't overflow i64 before the divide.
        let scaled = ((total as i128 * normalized_quantity as i128) + (record.quantity as i128 / 2))
            / record.quantity as i128;
        return scaled.clamp(i64::MIN as i128, i64::MAX as i128) as i64;
    }

    record.platinum.saturating_mul(normalized_quantity)
}

fn consume_matching_buy_lots(
    records: &[StoredTradeLogRecord],
    consumption: &mut HashMap<String, BuyConsumptionState>,
    slug: &str,
    rank: Option<i64>,
    required_quantity: i64,
    sell_closed_at: &str,
    as_set: bool,
) -> (i64, i64, Vec<ConsumedBuyMatch>) {
    let mut matched_quantity = 0_i64;
    let mut matched_cost = 0_i64;
    let mut matches = Vec::new();
    let normalized_slug = slug.trim();

    for record in records {
        if matched_quantity >= required_quantity {
            break;
        }
        if record.order_type != "buy"
            || record.keep_item
            || record.slug != normalized_slug
            || record.rank != rank
            || record.closed_at.as_str() > sell_closed_at
        {
            continue;
        }

        let entry = consumption.entry(record.id.clone()).or_default();
        let used_quantity = entry.flipped_quantity + entry.sold_as_set_quantity;
        let available_quantity = (record.quantity - used_quantity).max(0);
        if available_quantity <= 0 {
            continue;
        }

        let quantity_to_consume = (required_quantity - matched_quantity).min(available_quantity);
        if quantity_to_consume <= 0 {
            continue;
        }

        matched_quantity += quantity_to_consume;
        let consumed_cost = record_consumed_platinum(record, quantity_to_consume);
        matched_cost += consumed_cost;

        if as_set {
            entry.sold_as_set_quantity += quantity_to_consume;
        } else {
            entry.flipped_quantity += quantity_to_consume;
        }

        matches.push(ConsumedBuyMatch {
            order_id: record.id.clone(),
            item_name: record.item_name.clone(),
            slug: record.slug.clone(),
            quantity: quantity_to_consume,
            consumed_cost,
            buy_closed_at: record.closed_at.clone(),
            match_kind: if as_set {
                "sold_as_set".to_string()
            } else {
                "flip".to_string()
            },
        });
    }

    (matched_quantity, matched_cost, matches)
}

fn consume_set_component_buy_lots(
    records: &[StoredTradeLogRecord],
    consumption: &mut HashMap<String, BuyConsumptionState>,
    components: &[TradeSetComponentRecord],
    sell_quantity: i64,
    sell_closed_at: &str,
) -> (
    i64,
    i64,
    Vec<ConsumedBuyMatch>,
    Vec<DerivedSetComponentDetail>,
) {
    if components.is_empty() || sell_quantity <= 0 {
        return (0, 0, Vec::new(), Vec::new());
    }

    let mut fully_supported_sets = sell_quantity;
    for component in components {
        let available_quantity = records
            .iter()
            .filter(|record| {
                record.order_type == "buy"
                    && !record.keep_item
                    && record.slug == component.component_slug
                    && record.closed_at.as_str() <= sell_closed_at
            })
            .map(|record| {
                let used = consumption
                    .get(&record.id)
                    .map(|entry| entry.flipped_quantity + entry.sold_as_set_quantity)
                    .unwrap_or(0);
                (record.quantity - used).max(0)
            })
            .sum::<i64>();

        fully_supported_sets =
            fully_supported_sets.min(available_quantity / component.quantity_in_set);
    }

    let mut total_cost = 0_i64;
    let mut all_matches = Vec::new();
    let mut component_details = Vec::new();
    for component in components {
        let (component_matched_quantity, component_cost, component_matches) =
            consume_matching_buy_lots(
                records,
                consumption,
                &component.component_slug,
                None,
                component.quantity_in_set * sell_quantity,
                sell_closed_at,
                true,
            );
        total_cost += component_cost;
        all_matches.extend(component_matches);
        component_details.push(DerivedSetComponentDetail {
            slug: component.component_slug.clone(),
            required_quantity: component.quantity_in_set * sell_quantity,
            matched_quantity: component_matched_quantity,
            matched_cost: component_cost,
        });
    }

    (
        fully_supported_sets.max(0),
        total_cost,
        all_matches,
        component_details,
    )
}

fn derive_trade_ledger_with_components<F>(
    records: &[StoredTradeLogRecord],
    mut load_components: F,
) -> DerivedTradeLedger
where
    F: FnMut(&str) -> Vec<TradeSetComponentRecord>,
{
    let mut consumption = HashMap::<String, BuyConsumptionState>::new();
    let mut derived = Vec::with_capacity(records.len());
    let mut sell_details = HashMap::<String, DerivedSellDetail>::new();

    for record in records {
        if record.order_type == "buy" {
            continue;
        }

        let mut remaining_quantity = record.quantity;
        let mut matched_quantity = 0_i64;
        let mut matched_cost = 0_i64;
        let mut detail = DerivedSellDetail::default();

        if record.slug.ends_with("_set") {
            let components = load_components(&record.slug);
            if !components.is_empty() {
                let (set_quantity, set_cost, set_matches, component_details) =
                    consume_set_component_buy_lots(
                        records,
                        &mut consumption,
                        &components,
                        remaining_quantity,
                        &record.closed_at,
                    );
                matched_quantity += set_quantity;
                matched_cost += set_cost;
                remaining_quantity -= set_quantity;
                detail.sold_as_set_quantity = set_quantity;
                detail.sold_as_set_cost = set_cost;
                detail.matches.extend(set_matches);
                detail.set_component_details = component_details;
            }
        }

        if remaining_quantity > 0 {
            let (flip_quantity, flip_cost, flip_matches) = consume_matching_buy_lots(
                records,
                &mut consumption,
                &record.slug,
                record.rank,
                remaining_quantity,
                &record.closed_at,
                false,
            );
            matched_quantity += flip_quantity;
            matched_cost += flip_cost;
            detail.flip_quantity = flip_quantity;
            detail.flip_cost = flip_cost;
            detail.matches.extend(flip_matches);
        }

        let revenue = record_total_platinum(record);
        let profit = revenue - matched_cost;
        let margin = if matched_cost > 0 && revenue > 0 {
            Some((profit as f64 / revenue as f64) * 100.0)
        } else {
            None
        };
        let (cost_basis_confidence, cost_basis_label) =
            build_cost_basis_confidence("sell", record.quantity, matched_quantity, matched_cost);
        let profit_formula = Some(build_profit_formula(revenue, matched_cost, profit));
        let matched_buy_rows = detail
            .matches
            .iter()
            .map(|matched| PortfolioMatchedBuyRow {
                order_id: matched.order_id.clone(),
                item_name: matched.item_name.clone(),
                slug: matched.slug.clone(),
                quantity: matched.quantity,
                consumed_cost: matched.consumed_cost,
                closed_at: matched.buy_closed_at.clone(),
                match_kind: matched.match_kind.clone(),
            })
            .collect::<Vec<_>>();
        let set_component_rows = detail
            .set_component_details
            .iter()
            .map(|component| PortfolioSetComponentRow {
                slug: component.slug.clone(),
                name: portfolio_display_name_from_slug(&component.slug),
                required_quantity: component.required_quantity,
                matched_quantity: component.matched_quantity,
                missing_quantity: (component.required_quantity - component.matched_quantity).max(0),
                matched_cost: component.matched_cost,
            })
            .collect::<Vec<_>>();

        derived.push(PortfolioTradeLogEntry {
            id: record.id.clone(),
            item_name: record.item_name.clone(),
            slug: record.slug.clone(),
            image_path: record.image_path.clone(),
            order_type: "sell".to_string(),
            source: record.source.clone(),
            platinum: record.allocation_total_platinum.unwrap_or(record.platinum),
            quantity: record.quantity,
            rank: record.rank,
            closed_at: record.closed_at.clone(),
            updated_at: record.updated_at.clone(),
            profit: Some(profit),
            margin,
            status: None,
            keep_item: false,
            group_id: record.group_id.clone(),
            group_label: record.group_label.clone(),
            group_total_platinum: record.group_total_platinum,
            group_item_count: record.group_item_count,
            allocation_total_platinum: record.allocation_total_platinum,
            group_sort_order: record.group_sort_order,
            allocation_mode: build_trade_allocation_mode(record),
            cost_basis_confidence,
            cost_basis_label,
            matched_cost: Some(matched_cost),
            matched_quantity: Some(matched_quantity),
            matched_buy_count: matched_buy_rows.len() as i64,
            matched_buy_rows,
            set_component_rows,
            profit_formula,
            duplicate_risk: false,
        });

        detail.revenue = revenue;
        detail.matched_quantity = matched_quantity;
        detail.matched_cost = matched_cost;
        sell_details.insert(record.id.clone(), detail);
    }

    for record in records {
        if record.order_type != "buy" {
            continue;
        }

        let buy_state = consumption.get(&record.id).cloned().unwrap_or_default();
        let status = if record.keep_item {
            Some("Kept".to_string())
        } else if buy_state.sold_as_set_quantity >= record.quantity {
            Some("Sold As Set".to_string())
        } else if buy_state.flipped_quantity >= record.quantity {
            Some("Flip".to_string())
        } else {
            Some("Open".to_string())
        };

        derived.push(PortfolioTradeLogEntry {
            id: record.id.clone(),
            item_name: record.item_name.clone(),
            slug: record.slug.clone(),
            image_path: record.image_path.clone(),
            order_type: "buy".to_string(),
            source: record.source.clone(),
            platinum: record.allocation_total_platinum.unwrap_or(record.platinum),
            quantity: record.quantity,
            rank: record.rank,
            closed_at: record.closed_at.clone(),
            updated_at: record.updated_at.clone(),
            profit: None,
            margin: None,
            status,
            keep_item: record.keep_item,
            group_id: record.group_id.clone(),
            group_label: record.group_label.clone(),
            group_total_platinum: record.group_total_platinum,
            group_item_count: record.group_item_count,
            allocation_total_platinum: record.allocation_total_platinum,
            group_sort_order: record.group_sort_order,
            allocation_mode: build_trade_allocation_mode(record),
            cost_basis_confidence: None,
            cost_basis_label: None,
            matched_cost: None,
            matched_quantity: None,
            matched_buy_count: 0,
            matched_buy_rows: Vec::new(),
            set_component_rows: Vec::new(),
            profit_formula: None,
            duplicate_risk: false,
        });
    }

    derived.sort_by(|left, right| {
        right
            .closed_at
            .cmp(&left.closed_at)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| right.id.cmp(&left.id))
    });

    DerivedTradeLedger {
        entries: derived,
        sell_details,
    }
}

fn derive_trade_log_entries_with_components<F>(
    records: &[StoredTradeLogRecord],
    load_components: F,
) -> Vec<PortfolioTradeLogEntry>
where
    F: FnMut(&str) -> Vec<TradeSetComponentRecord>,
{
    derive_trade_ledger_with_components(records, load_components).entries
}

fn derive_trade_log_entries(
    app: &tauri::AppHandle,
    records: &[StoredTradeLogRecord],
) -> Vec<PortfolioTradeLogEntry> {
    derive_trade_log_entries_with_components(records, |set_slug| {
        load_trade_set_components_for_slug(app, set_slug).unwrap_or_default()
    })
}

fn load_cached_trade_log_state_inner(
    app: &tauri::AppHandle,
    connection: &Connection,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    let last_updated_at = load_trade_log_last_updated_at(connection, username)?;
    let records = load_stored_trade_log_records_inner(connection, username)?;
    let entries = derive_trade_log_entries(app, &records);

    Ok(PortfolioTradeLogState {
        entries,
        last_updated_at,
    })
}

fn normalize_grouped_trade_sets_inner(
    app: &tauri::AppHandle,
    connection: &mut Connection,
    username: &str,
) -> Result<bool> {
    let records = load_stored_trade_log_records_inner(connection, username)?;
    if records.iter().all(|record| record.group_id.is_none()) {
        return Ok(false);
    }

    let catalog = open_catalog_database(app)?;
    let set_roots = list_trade_set_roots_from_catalog(&catalog)?;
    let mut set_definitions = Vec::new();
    for set_root in set_roots {
        let components = load_trade_set_components_for_slug(app, &set_root.slug)?;
        if components.is_empty() {
            continue;
        }

        set_definitions.push((set_root, components));
    }

    let (collapsed_records, changed) = collapse_grouped_trade_sets(&records, &set_definitions);
    if !changed {
        return Ok(false);
    }

    let collapsed_entries = collapsed_records
        .iter()
        .map(build_portfolio_entry_from_stored_record)
        .collect::<Vec<_>>();
    replace_trade_log_rows_inner(connection, username, &collapsed_entries)?;

    Ok(true)
}

fn prune_stale_trade_log_overrides_inner(
    connection: &Connection,
    username: &str,
) -> Result<()> {
    connection
        .execute(
            "
            DELETE FROM portfolio_trade_log_overrides
            WHERE username = ?1
              AND order_id NOT IN (
                SELECT order_id
                FROM portfolio_trade_log_cache
                WHERE username = ?1
              )
            ",
            params![username],
        )
        .context("failed to prune stale trade log overrides")?;
    Ok(())
}

fn reconcile_trade_log_state_inner(
    app: &tauri::AppHandle,
    connection: &mut Connection,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    let _ = normalize_grouped_trade_sets_inner(app, connection, username)?;
    // Prune stale overrides only after normalization so that collapsed Set
    // entries ("af-set-...") are already present in the cache.
    prune_stale_trade_log_overrides_inner(connection, username)?;
    let records = load_stored_trade_log_records_inner(connection, username)?;
    let entries = derive_trade_log_entries(app, &records);
    persist_derived_trade_log_entries_inner(connection, username, &entries)?;
    load_cached_trade_log_state_inner(app, connection, username)
}

fn ensure_trade_log_state_inner(
    app: &tauri::AppHandle,
    connection: &mut Connection,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    if has_complete_derived_trade_log_state(connection, username)? {
        return load_cached_trade_log_state_inner(app, connection, username);
    }

    reconcile_trade_log_state_inner(app, connection, username)
}

fn set_trade_log_keep_item_inner(
    app: &tauri::AppHandle,
    username: &str,
    order_id: &str,
    keep_item: bool,
) -> Result<PortfolioTradeLogState> {
    let trimmed_username = username.trim();
    let trimmed_order_id = order_id.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!("Username is required to update trade log state."));
    }
    if trimmed_order_id.is_empty() {
        return Err(anyhow!("Order id is required to update trade log state."));
    }

    let mut connection = open_trades_cache_database(app)?;
    connection
        .execute(
            "
            INSERT INTO portfolio_trade_log_overrides (username, order_id, keep_item)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(username, order_id) DO UPDATE SET
              keep_item = excluded.keep_item
            ",
            params![
                trimmed_username,
                trimmed_order_id,
                if keep_item { 1 } else { 0 }
            ],
        )
        .context("failed to update trade log keep override")?;

    let next_state = reconcile_trade_log_state_inner(app, &mut connection, trimmed_username)?;
    let owned_part_deltas = build_owned_set_component_deltas_for_entries(app, &next_state.entries)?;
    replace_owned_set_component_deltas(app, &owned_part_deltas)?;
    Ok(next_state)
}

fn migrate_alecaframe_trade_log_inner(
    app: &tauri::AppHandle,
    username: &str,
    input: &AlecaframeTradeMigrationInput,
) -> Result<PortfolioTradeLogState> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!("Username is required to migrate trade history."));
    }

    let mut connection = open_trades_cache_database(app)?;
    save_alecaframe_trade_baseline_date_inner(&connection, trimmed_username, &input.baseline_date)?;
    let existing = load_stored_trade_log_records_inner(&connection, trimmed_username)?;
    let imported =
        build_alecaframe_trade_entries(app, trimmed_username, &input.baseline_date, &existing)?;

    if !imported.is_empty() {
        save_trade_log_rows_inner(&mut connection, trimmed_username, &imported)?;
    }

    reconcile_trade_log_state_inner(app, &mut connection, trimmed_username)
}

fn update_trade_group_allocations_inner(
    app: &tauri::AppHandle,
    username: &str,
    group_id: &str,
    allocations: &[TradeGroupAllocationInput],
) -> Result<PortfolioTradeLogState> {
    let trimmed_username = username.trim();
    let trimmed_group_id = group_id.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!(
            "Username is required to update grouped trade allocations."
        ));
    }
    if trimmed_group_id.is_empty() {
        return Err(anyhow!("Trade group id is required to update allocations."));
    }
    if allocations.is_empty() {
        return Err(anyhow!("Provide at least one child trade allocation."));
    }

    let mut connection = open_trades_cache_database(app)?;
    let existing_rows = {
        let mut statement = connection
            .prepare(
                "
                SELECT order_id, group_total_platinum
                FROM portfolio_trade_log_cache
                WHERE username = ?1
                  AND group_id = ?2
                ORDER BY group_sort_order ASC, order_id ASC
                ",
            )
            .context("failed to prepare grouped trade allocation query")?;

        let rows = statement
            .query_map(params![trimmed_username, trimmed_group_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .context("failed to query grouped trade allocation rows")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to collect grouped trade allocation rows")?;

        rows
    };

    if existing_rows.is_empty() {
        return Err(anyhow!("The selected grouped trade could not be found."));
    }

    let expected_total = existing_rows
        .first()
        .and_then(|row| row.1)
        .ok_or_else(|| anyhow!("The grouped trade is missing its total platinum value."))?;
    let expected_ids = existing_rows
        .iter()
        .map(|row| row.0.as_str())
        .collect::<Vec<_>>();

    if expected_ids.len() != allocations.len()
        || allocations
            .iter()
            .any(|allocation| !expected_ids.contains(&allocation.order_id.as_str()))
    {
        return Err(anyhow!(
            "Allocation rows do not match the stored grouped trade items."
        ));
    }

    let supplied_total = allocations
        .iter()
        .map(|allocation| allocation.total_platinum)
        .sum::<i64>();
    if supplied_total != expected_total {
        return Err(anyhow!(
            "Adjusted totals must add up to {expected_total} platinum."
        ));
    }
    if allocations
        .iter()
        .any(|allocation| allocation.total_platinum < 0)
    {
        return Err(anyhow!("Adjusted trade totals cannot be negative."));
    }

    let transaction = connection
        .transaction()
        .context("failed to start grouped trade allocation transaction")?;
    {
        let mut update_statement = transaction
            .prepare(
                "
                UPDATE portfolio_trade_log_cache
                SET allocation_total_platinum = ?3,
                    platinum = ?3
                WHERE username = ?1
                  AND order_id = ?2
                ",
            )
            .context("failed to prepare grouped trade allocation update")?;

        for allocation in allocations {
            update_statement
                .execute(params![
                    trimmed_username,
                    allocation.order_id,
                    allocation.total_platinum,
                ])
                .context("failed to update grouped trade allocation")?;
        }
    }
    transaction
        .commit()
        .context("failed to commit grouped trade allocation transaction")?;

    reconcile_trade_log_state_inner(app, &mut connection, trimmed_username)
}

fn force_trade_log_resync_inner(
    app: &tauri::AppHandle,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!("Username is required to resync the trade log."));
    }

    let mut connection = open_trades_cache_database(app)?;
    let existing_records = load_stored_trade_log_records_inner(&connection, trimmed_username)?;
    let mut fetched_entries = fetch_profile_trade_log_inner(trimmed_username)?;

    let settings = load_settings_for_internal_use(app)?;
    if settings.alecaframe.enabled && settings.alecaframe.public_link.is_some() {
        if let Some(baseline_date) =
            load_alecaframe_trade_baseline_date_inner(&connection, trimmed_username)?
        {
            let existing_records = fetched_entries
                .iter()
                .map(build_stored_trade_record_from_entry)
                .collect::<Vec<_>>();
            let imported = build_alecaframe_trade_entries(
                app,
                trimmed_username,
                &baseline_date,
                &existing_records,
            )?;
            if !imported.is_empty() {
                fetched_entries = append_unique_trade_entries(&fetched_entries, &imported);
            }
        }
    }

    let cutoff = now_utc() - time::Duration::days(WFM_TRADE_LOG_LOCK_DAYS);
    let locked_entries = existing_records
        .iter()
        .filter(|record| trade_record_is_before_cutoff(record, cutoff))
        .map(build_portfolio_entry_from_stored_record)
        .collect::<Vec<_>>();
    if !locked_entries.is_empty() {
        fetched_entries = append_unique_trade_entries(&fetched_entries, &locked_entries);
    }

    replace_trade_log_rows_inner(&mut connection, trimmed_username, &fetched_entries)?;
    reconcile_trade_log_state_inner(app, &mut connection, trimmed_username)
}

fn load_cached_trade_log_state_for_app(
    app: &tauri::AppHandle,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    let mut connection = open_trades_cache_database(app)?;
    ensure_trade_log_state_inner(app, &mut connection, username)
}

fn refresh_trade_log_state_for_app(
    app: &tauri::AppHandle,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    let mut connection = open_trades_cache_database(app)?;
    let existing = load_stored_trade_log_records_inner(&connection, username)?;
    let fetched_entries =
        fetch_profile_trade_log_inner_with_priority(username, RequestPriority::Instant)?;
    let (persisted_entries, _) = merge_wfm_trade_log_entries(&existing, &fetched_entries);
    save_trade_log_rows_inner(&mut connection, username, &persisted_entries)?;
    reconcile_trade_log_state_inner(app, &mut connection, username)
}

fn load_recent_trade_records_by_source(
    connection: &Connection,
    username: &str,
    source: &str,
    closed_at_cutoff: &str,
) -> Result<Vec<StoredTradeLogRecord>> {
    let mut statement = connection
        .prepare(
            "
            SELECT
              cache.order_id,
              cache.item_name,
              cache.slug,
              cache.image_path,
              cache.order_type,
              cache.source,
              cache.platinum,
              cache.quantity,
              cache.rank,
              cache.closed_at,
              cache.updated_at,
              COALESCE(overrides.keep_item, cache.keep_item, 0),
              cache.group_id,
              cache.group_label,
              cache.group_total_platinum,
              cache.group_item_count,
              cache.allocation_total_platinum,
              cache.group_sort_order
            FROM portfolio_trade_log_cache AS cache
            LEFT JOIN portfolio_trade_log_overrides AS overrides
              ON overrides.username = cache.username
             AND overrides.order_id = cache.order_id
            WHERE cache.username = ?1
              AND cache.source = ?2
              AND cache.closed_at >= ?3
            ORDER BY cache.closed_at DESC
            ",
        )
        .context("failed to prepare recent trade records query")?;

    let rows = statement
        .query_map(params![username, source, closed_at_cutoff], |row| {
            Ok(StoredTradeLogRecord {
                id: row.get(0)?,
                item_name: row.get(1)?,
                slug: row.get(2)?,
                image_path: row.get(3)?,
                order_type: row.get(4)?,
                source: row.get(5)?,
                platinum: row.get(6)?,
                quantity: row.get(7)?,
                rank: row.get(8)?,
                closed_at: row.get(9)?,
                updated_at: row.get(10)?,
                keep_item: row.get::<_, i64>(11)? != 0,
                group_id: row.get(12)?,
                group_label: row.get(13)?,
                group_total_platinum: row.get(14)?,
                group_item_count: row.get(15)?,
                allocation_total_platinum: row.get(16)?,
                group_sort_order: row.get(17)?,
            })
        })
        .context("failed to query recent trade records")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect recent trade records")?;
    Ok(rows)
}

/// Scans the last `PENDING_NOTIFICATION_WINDOW_MINUTES` of trade history and
/// sends Discord notifications for any trades that don't yet have a fingerprint.
/// This acts as a retry mechanism: if a webhook call failed (or was blocked by a
/// filter) during an earlier poll, the notification is re-attempted here.
fn check_pending_trade_notifications_inner(
    app: &tauri::AppHandle,
    connection: &Connection,
    username: &str,
    source: &str,
    session_started_at: Option<&OffsetDateTime>,
) -> Result<i64> {
    let cutoff =
        format_timestamp(now_utc() - time::Duration::minutes(PENDING_NOTIFICATION_WINDOW_MINUTES))
            .context("failed to compute pending notification cutoff")?;

    let records = load_recent_trade_records_by_source(connection, username, source, &cutoff)?;
    if records.is_empty() {
        return Ok(0);
    }

    let entries: Vec<PortfolioTradeLogEntry> = records
        .iter()
        .map(build_portfolio_entry_from_stored_record)
        .collect();

    let candidates = match source {
        "wfm" => build_trade_notification_candidates_for_wfm(app, &entries)?,
        _ => build_trade_notification_candidates_for_alecaframe(&entries),
    };

    send_trade_notification_candidates_inner(
        app,
        connection,
        username,
        &candidates,
        source,
        session_started_at,
    )
}

fn refresh_wfm_trade_detection_inner(
    app: &tauri::AppHandle,
    username: &str,
    input: &TradeDetectionRefreshInput,
) -> Result<TradeDetectionRefreshResult> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!(
            "Username is required to detect new Warframe Market trades."
        ));
    }

    let mut connection = open_trades_cache_database(app)?;
    let session_started_at = input
        .session_started_at
        .as_deref()
        .and_then(parse_timestamp);
    let request_priority = RequestPriority::from_wire(
        input.request_priority.as_deref(),
        RequestPriority::Low,
    );
    let existing = load_stored_trade_log_records_inner(&connection, trimmed_username)?;
    let fetched_entries = fetch_profile_trade_log_inner_with_priority(trimmed_username, request_priority)?;
    let (persisted_entries, new_entries) = merge_wfm_trade_log_entries(&existing, &fetched_entries);

    if persisted_entries.is_empty() {
        return Ok(TradeDetectionRefreshResult {
            source: "wfm".to_string(),
            new_trade_count: 0,
            notification_count: 0,
            last_updated_at: load_trade_log_last_updated_at(&connection, trimmed_username)?,
            skipped: false,
            message: Some("No trade history rows were returned.".to_string()),
            detected_buys: Vec::new(),
        });
    }

    let mut notification_count = 0_i64;
    let mut last_updated_at = None;

    if !new_entries.is_empty() {
        let updated_at =
            save_trade_log_rows_inner(&mut connection, trimmed_username, &persisted_entries)?;
        let _ = reconcile_trade_log_state_inner(app, &mut connection, trimmed_username)?;
        let owned_part_deltas =
            build_owned_set_component_deltas_for_entries(app, &new_entries)?;
        apply_owned_set_component_deltas(app, &owned_part_deltas)?;
        let wfm_candidates =
            build_trade_notification_candidates_for_wfm(app, &new_entries)?;
        notification_count += send_trade_notification_candidates_inner(
            app,
            &connection,
            trimmed_username,
            &wfm_candidates,
            "wfm",
            session_started_at.as_ref(),
        )?;
        last_updated_at = Some(updated_at);
    }

    // Retry notifications for any recent trades whose webhook call previously
    // failed or was otherwise missed (webhook down, transient error, etc.).
    notification_count += check_pending_trade_notifications_inner(
        app,
        &connection,
        trimmed_username,
        "wfm",
        session_started_at.as_ref(),
    )?;

    Ok(TradeDetectionRefreshResult {
        source: "wfm".to_string(),
        new_trade_count: new_entries.len() as i64,
        notification_count,
        last_updated_at: last_updated_at
            .or_else(|| load_trade_log_last_updated_at(&connection, trimmed_username).ok().flatten()),
        skipped: false,
        message: None,
        detected_buys: Vec::new(),
    })
}

fn refresh_alecaframe_trade_detection_inner(
    app: &tauri::AppHandle,
    username: &str,
    input: &TradeDetectionRefreshInput,
) -> Result<TradeDetectionRefreshResult> {
    let trimmed_username = username.trim();
    if trimmed_username.is_empty() {
        return Err(anyhow!("Username is required to detect Alecaframe trades."));
    }

    let settings = load_settings_for_internal_use(app)?;
    if !settings.alecaframe.enabled || settings.alecaframe.public_link.is_none() {
        return Ok(TradeDetectionRefreshResult {
            source: "alecaframe".to_string(),
            new_trade_count: 0,
            notification_count: 0,
            last_updated_at: None,
            skipped: true,
            message: Some("Alecaframe is not enabled.".to_string()),
            detected_buys: Vec::new(),
        });
    }

    let mut connection = open_trades_cache_database(app)?;
    let session_started_at = input
        .session_started_at
        .as_deref()
        .and_then(parse_timestamp);
    let Some(baseline_date) =
        load_alecaframe_trade_baseline_date_inner(&connection, trimmed_username)?
    else {
        return Ok(TradeDetectionRefreshResult {
            source: "alecaframe".to_string(),
            new_trade_count: 0,
            notification_count: 0,
            last_updated_at: load_trade_log_last_updated_at(&connection, trimmed_username)?,
            skipped: true,
            message: Some("No Alecaframe migration baseline has been saved yet.".to_string()),
            detected_buys: Vec::new(),
        });
    };

    let existing = load_stored_trade_log_records_inner(&connection, trimmed_username)?;
    let imported =
        build_alecaframe_trade_entries(app, trimmed_username, &baseline_date, &existing)?;

    let mut notification_count = 0_i64;
    let mut last_updated_at = None;
    let mut detected_buys = Vec::new();

    if !imported.is_empty() {
        let updated_at =
            save_trade_log_rows_inner(&mut connection, trimmed_username, &imported)?;
        let _ = reconcile_trade_log_state_inner(app, &mut connection, trimmed_username)?;
        let owned_part_deltas = build_owned_set_component_deltas_for_entries(app, &imported)?;
        apply_owned_set_component_deltas(app, &owned_part_deltas)?;
        notification_count += send_trade_notification_candidates_inner(
            app,
            &connection,
            trimmed_username,
            &build_trade_notification_candidates_for_alecaframe(&imported),
            "alecaframe",
            session_started_at.as_ref(),
        )?;
        last_updated_at = Some(updated_at);
        detected_buys = imported
            .iter()
            .filter(|entry| entry.order_type == "buy")
            .map(|entry| DetectedTradeBuy {
                slug: entry.slug.clone(),
                rank: entry.rank,
                quantity: entry.quantity.max(1),
                platinum: entry.platinum,
            })
            .collect();
    }

    notification_count += check_pending_trade_notifications_inner(
        app,
        &connection,
        trimmed_username,
        "alecaframe",
        session_started_at.as_ref(),
    )?;

    Ok(TradeDetectionRefreshResult {
        source: "alecaframe".to_string(),
        new_trade_count: imported.len() as i64,
        notification_count,
        last_updated_at: last_updated_at
            .or_else(|| load_trade_log_last_updated_at(&connection, trimmed_username).ok().flatten()),
        skipped: false,
        message: None,
        detected_buys,
    })
}

fn normalize_portfolio_pnl_period(value: &str) -> String {
    match value.trim() {
        "7d" => "7d".to_string(),
        "30d" => "30d".to_string(),
        "90d" => "90d".to_string(),
        _ => "all".to_string(),
    }
}

fn portfolio_pnl_cutoff(period: &str) -> Option<OffsetDateTime> {
    match period {
        "7d" => Some(now_utc() - time::Duration::days(7)),
        "30d" => Some(now_utc() - time::Duration::days(30)),
        "90d" => Some(now_utc() - time::Duration::days(90)),
        _ => None,
    }
}

fn month_short_label(month: time::Month) -> &'static str {
    match month {
        time::Month::January => "Jan",
        time::Month::February => "Feb",
        time::Month::March => "Mar",
        time::Month::April => "Apr",
        time::Month::May => "May",
        time::Month::June => "Jun",
        time::Month::July => "Jul",
        time::Month::August => "Aug",
        time::Month::September => "Sep",
        time::Month::October => "Oct",
        time::Month::November => "Nov",
        time::Month::December => "Dec",
    }
}

fn build_portfolio_bucket_label(bucket_at: &str) -> String {
    parse_timestamp(bucket_at)
        .map(|timestamp| {
            format!(
                "{} {}",
                timestamp.day(),
                month_short_label(timestamp.month())
            )
        })
        .unwrap_or_else(|| bucket_at.to_string())
}

fn average(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn compute_cost_basis_coverage(
    total_sell_revenue: i64,
    full_cost_basis_revenue: i64,
    partial_cost_basis_revenue: i64,
) -> f64 {
    if total_sell_revenue <= 0 {
        return 100.0;
    }

    (((full_cost_basis_revenue as f64) + ((partial_cost_basis_revenue as f64) * 0.5))
        / total_sell_revenue as f64)
        * 100.0
}

fn compute_current_value_coverage(open_exposure: i64, current_value_covered_cost: i64) -> f64 {
    if open_exposure <= 0 {
        return 100.0;
    }

    (current_value_covered_cost as f64 / open_exposure as f64) * 100.0
}

fn round_money(value: f64) -> i64 {
    value.round() as i64
}

fn build_trade_variant_key(rank: Option<i64>) -> String {
    rank.map(|value| format!("rank:{value}"))
        .unwrap_or_else(|| "base".to_string())
}

fn query_latest_statistics_reference_price(
    connection: &Connection,
    item_id: i64,
    variant_key: &str,
    domain_key: &str,
    source_kind: &str,
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
               AND domain_key = ?3
               AND source_kind = ?4
             ORDER BY bucket_at DESC
             LIMIT 1",
            params![item_id, variant_key, domain_key, source_kind],
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

fn load_portfolio_catalog_meta_map(
    app: &tauri::AppHandle,
    records: &[StoredTradeLogRecord],
) -> Result<HashMap<String, PortfolioCatalogMeta>> {
    let connection = open_catalog_database(app)?;
    let unique_slugs = records
        .iter()
        .map(|record| record.slug.trim().to_string())
        .filter(|slug| !slug.is_empty())
        .collect::<std::collections::BTreeSet<_>>();

    let mut statement = connection
        .prepare(
            "
            SELECT
              items.item_id,
              items.item_family
            FROM items
            LEFT JOIN wfm_items ON wfm_items.wfm_id = items.wfm_id
            WHERE COALESCE(items.wfm_slug, wfm_items.slug) = ?1
            LIMIT 1
            ",
        )
        .context("failed to prepare portfolio catalog metadata query")?;

    let mut metadata = HashMap::new();
    for slug in unique_slugs {
        let maybe_meta = statement
            .query_row(params![slug.as_str()], |row| {
                Ok(PortfolioCatalogMeta {
                    item_id: row.get(0)?,
                    item_family: row.get(1)?,
                })
            })
            .optional()
            .context("failed to resolve portfolio catalog metadata")?;

        if let Some(meta) = maybe_meta {
            metadata.insert(slug, meta);
        }
    }

    Ok(metadata)
}

fn classify_portfolio_category(
    metadata: Option<&PortfolioCatalogMeta>,
    slug: &str,
    item_name: &str,
) -> String {
    let normalized_slug = slug.trim().to_lowercase();
    let normalized_name = item_name.trim().to_lowercase();
    let family = metadata
        .and_then(|entry| entry.item_family.as_deref())
        .unwrap_or_default()
        .trim()
        .to_lowercase();

    if normalized_slug.ends_with("_set")
        || family.contains("set")
        || normalized_name.ends_with(" set")
    {
        "Sets".to_string()
    } else if normalized_name.contains("arcane") || family.contains("arcane") {
        "Arcanes".to_string()
    } else if normalized_name.contains("relic") || family.contains("relic") {
        "Relics".to_string()
    } else if family.contains("mod") {
        "Mods".to_string()
    } else if family.contains("weapon") {
        "Weapons".to_string()
    } else if family.contains("warframe") || family.contains("frame") {
        "Warframes".to_string()
    } else {
        "Components".to_string()
    }
}

fn latest_local_market_estimate(
    connection: &Connection,
    item_id: i64,
    rank: Option<i64>,
) -> Result<Option<i64>> {
    let variant_key = build_trade_variant_key(rank);

    // Prefer the 30-day zone model's recommended exit — anchored on weighted history, so one
    // spiky latest bucket can't swing every holding's valuation. The single-bucket reference
    // chain below stays as the fallback for items with too little history for a zone model.
    if let Some(value) =
        crate::market_observatory::zone_recommended_exit_price(connection, item_id, &variant_key)
    {
        return Ok(Some(round_money(value)));
    }

    for (domain_key, source_kind) in [
        ("48hours", "live_sell"),
        ("48hours", "closed"),
        ("90days", "closed"),
    ] {
        if let Some(value) = query_latest_statistics_reference_price(
            connection,
            item_id,
            &variant_key,
            domain_key,
            source_kind,
        )? {
            return Ok(Some(round_money(value)));
        }
    }

    Ok(None)
}

fn record_matches_cutoff(record: &StoredTradeLogRecord, cutoff: Option<OffsetDateTime>) -> bool {
    let Some(cutoff) = cutoff else {
        return true;
    };

    parse_timestamp(&record.closed_at)
        .map(|timestamp| timestamp >= cutoff)
        .unwrap_or(false)
}

fn breakdown_rows_from_map(
    mut values: HashMap<String, (i64, i64)>,
    limit: usize,
) -> Vec<PortfolioBreakdownRow> {
    let mut rows = values
        .drain()
        .map(|(label, (value, trade_count))| PortfolioBreakdownRow {
            label,
            value,
            trade_count,
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .value
            .cmp(&left.value)
            .then_with(|| right.trade_count.cmp(&left.trade_count))
            .then_with(|| left.label.cmp(&right.label))
    });
    rows.truncate(limit);
    rows
}

fn build_portfolio_pnl_summary_inner(
    app: &tauri::AppHandle,
    username: &str,
    period: &str,
) -> Result<PortfolioPnlSummary> {
    let normalized_period = normalize_portfolio_pnl_period(period);
    let cutoff = portfolio_pnl_cutoff(&normalized_period);
    let mut trades_connection = open_trades_cache_database(app)?;
    let trade_log_state = ensure_trade_log_state_inner(app, &mut trades_connection, username)?;
    let records = load_stored_trade_log_records_inner(&trades_connection, username)?;
    let derived_ledger = derive_trade_ledger_with_components(&records, |set_slug| {
        load_trade_set_components_for_slug(app, set_slug).unwrap_or_default()
    });
    let last_updated_at = trade_log_state.last_updated_at.clone();

    let mut derived_by_id = HashMap::<String, PortfolioTradeLogEntry>::new();
    for entry in derived_ledger.entries.iter().cloned() {
        derived_by_id.insert(entry.id.clone(), entry);
    }

    let metadata_by_slug = load_portfolio_catalog_meta_map(app, &records)?;
    let market_connection = open_market_observatory_database(app).ok();

    let mut realized_profit = 0_i64;
    let mut turnover_bought = 0_i64;
    let mut turnover_sold = 0_i64;
    let mut closed_trades = 0_i64;
    let mut total_trades = 0_i64;
    let mut win_count = 0_i64;
    let mut positive_margin_values = Vec::<f64>::new();
    let mut average_hold_values = Vec::<f64>::new();
    let mut sold_as_set_profit = 0_i64;
    let mut flip_profit = 0_i64;
    let mut unmatched_sell_revenue = 0_i64;
    let mut partial_cost_basis_revenue = 0_i64;
    let mut total_sell_revenue = 0_i64;
    let mut full_cost_basis_revenue = 0_i64;
    let mut best_trade: Option<(String, i64)> = None;
    let mut worst_trade: Option<(String, i64)> = None;
    let mut category_breakdown_map = HashMap::<String, (i64, i64)>::new();
    let mut item_breakdown_map = HashMap::<String, (i64, i64)>::new();
    let mut previous_realized_profit = 0_i64;
    // Previous window of the same length as the selected period, for the hero delta.
    let previous_window = cutoff.map(|cut| (cut - (now_utc() - cut), cut));
    let mut source_breakdown_map = HashMap::<String, (i64, i64)>::new();
    let mut cumulative_bucket_map = std::collections::BTreeMap::<String, i64>::new();
    let mut profit_points = Vec::<PortfolioTradeProfitPoint>::new();
    let mut unrealized_value = 0_i64;
    let mut unrealized_pnl = 0_i64;
    let mut open_exposure = 0_i64;
    let mut open_buys = 0_i64;
    let mut kept_items = 0_i64;
    let mut current_value_covered_cost = 0_i64;
    let mut kept_inventory_value = 0_i64;
    let mut partial_set_profit = 0_i64;
    let mut inventory_rows = Vec::<PortfolioInventoryRow>::new();
    // Market estimates now come from the 30-day zone model, which is far heavier than the old
    // single-row lookup — memoize per (item, rank) since holdings repeat items constantly.
    let mut market_estimate_cache = HashMap::<(i64, Option<i64>), Option<i64>>::new();
    let mut audit_rows = Vec::<PortfolioAuditRow>::new();
    let mut ambiguous_group_ids = HashSet::<String>::new();
    let mut alecaframe_audit_ids = HashSet::<String>::new();
    let mut unmatched_sell_audit_ids = HashSet::<String>::new();

    for record in &records {
        let Some(derived_entry) = derived_by_id.get(&record.id) else {
            continue;
        };
        let total_platinum = record_total_platinum(record);

        if record.order_type == "buy" {
            if matches!(derived_entry.status.as_deref(), Some("Open" | "Kept")) {
                let is_open = derived_entry.status.as_deref() == Some("Open");
                // "Open Buys" is capital tied up in buys still awaiting sale. Items the
                // user has marked "Kept" are deliberately pulled out of trading, so they
                // must NOT count toward open exposure (or its coverage ratio).
                if is_open {
                    open_exposure += total_platinum;
                    open_buys += 1;
                }
                if derived_entry.status.as_deref() == Some("Kept") {
                    kept_items += 1;
                }

                let maybe_estimate = metadata_by_slug
                    .get(record.slug.as_str())
                    .and_then(|meta| meta.item_id)
                    .and_then(|item_id| {
                        *market_estimate_cache
                            .entry((item_id, record.rank))
                            .or_insert_with(|| {
                                market_connection
                                    .as_ref()
                                    .and_then(|connection| {
                                        latest_local_market_estimate(connection, item_id, record.rank)
                                            .ok()
                                    })
                                    .flatten()
                            })
                    });

                let estimated_total = maybe_estimate
                    .map(|unit_price| unit_price.saturating_mul(record.quantity))
                    .unwrap_or(total_platinum);
                unrealized_value += estimated_total;
                unrealized_pnl += estimated_total - total_platinum;
                if derived_entry.status.as_deref() == Some("Kept") {
                    kept_inventory_value += estimated_total;
                }

                if maybe_estimate.is_some() && is_open {
                    current_value_covered_cost += total_platinum;
                }

                inventory_rows.push(PortfolioInventoryRow {
                    id: record.id.clone(),
                    item_name: record.item_name.clone(),
                    slug: record.slug.clone(),
                    image_path: record.image_path.clone(),
                    quantity: record.quantity,
                    rank: record.rank,
                    status: if derived_entry.status.as_deref() == Some("Kept") {
                        "kept".to_string()
                    } else {
                        "open".to_string()
                    },
                    cost_basis: total_platinum,
                    estimated_value: estimated_total,
                    unrealized_pnl: estimated_total - total_platinum,
                    last_updated_at: record.updated_at.clone(),
                });
            }

            if !record_matches_cutoff(record, cutoff) {
                continue;
            }

            total_trades += 1;
            turnover_bought += total_platinum;

            continue;
        }

        if let Some((previous_start, previous_end)) = previous_window {
            if let Some(closed_ts) = parse_timestamp(&record.closed_at) {
                if closed_ts >= previous_start && closed_ts < previous_end {
                    previous_realized_profit += derived_entry.profit.unwrap_or(0);
                }
            }
        }

        if !record_matches_cutoff(record, cutoff) {
            continue;
        }

        total_trades += 1;
        turnover_sold += total_platinum;
        total_sell_revenue += total_platinum;
        closed_trades += 1;

        let profit = derived_entry.profit.unwrap_or(0);
        realized_profit += profit;
        {
            let entry = item_breakdown_map
                .entry(record.item_name.clone())
                .or_insert((0, 0));
            entry.0 += profit;
            entry.1 += 1;
        }
        if profit > 0 {
            win_count += 1;
        }
        if let Some(margin) = derived_entry.margin {
            positive_margin_values.push(margin);
        }

        let detail = derived_ledger.sell_details.get(&record.id);
        let matched_cost = detail.map(|value| value.matched_cost).unwrap_or(0);
        match derived_entry.cost_basis_confidence.as_deref() {
            Some("full") => {
                full_cost_basis_revenue += total_platinum;
            }
            Some("partial") => {
                partial_cost_basis_revenue += total_platinum;
            }
            _ => {}
        }
        if matched_cost <= 0 {
            unmatched_sell_revenue += total_platinum;
            if unmatched_sell_audit_ids.insert(record.id.clone()) {
                audit_rows.push(PortfolioAuditRow {
                    id: record.id.clone(),
                    item_name: record.item_name.clone(),
                    slug: record.slug.clone(),
                    order_type: record.order_type.clone(),
                    source: record.source.clone(),
                    closed_at: record.closed_at.clone(),
                    label: "Unmatched Sell".to_string(),
                    detail: "No local buy cost basis was matched for this sell yet.".to_string(),
                });
            }
        }

        let source_label = if detail.map(|value| value.sold_as_set_cost).unwrap_or(0) > 0 {
            sold_as_set_profit += profit;
            if derived_entry.cost_basis_confidence.as_deref() == Some("partial") {
                partial_set_profit += profit;
            }
            "Sold As Set"
        } else if matched_cost > 0 {
            flip_profit += profit;
            "Flip"
        } else {
            "Direct Sell"
        };
        {
            let entry = source_breakdown_map
                .entry(source_label.to_string())
                .or_insert((0, 0));
            entry.0 += profit;
            entry.1 += 1;
        }

        let category_label = classify_portfolio_category(
            metadata_by_slug.get(record.slug.as_str()),
            &record.slug,
            &record.item_name,
        );
        {
            let entry = category_breakdown_map
                .entry(category_label)
                .or_insert((0, 0));
            entry.0 += profit;
            entry.1 += 1;
        }

        if let Some(detail) = detail {
            let mut weighted_hold_hours = 0_f64;
            let mut weighted_units = 0_f64;
            for matched_buy in &detail.matches {
                if let (Some(sell_at), Some(buy_at)) = (
                    parse_timestamp(&record.closed_at),
                    parse_timestamp(&matched_buy.buy_closed_at),
                ) {
                    let hold_hours = (sell_at - buy_at).whole_minutes().max(0) as f64 / 60.0;
                    weighted_hold_hours += hold_hours * matched_buy.quantity as f64;
                    weighted_units += matched_buy.quantity as f64;
                }
            }
            if weighted_units > 0.0 {
                average_hold_values.push(weighted_hold_hours / weighted_units);
            }
        }

        match best_trade {
            Some((_, value)) if value >= profit => {}
            _ => best_trade = Some((record.item_name.clone(), profit)),
        }
        match worst_trade {
            Some((_, value)) if value <= profit => {}
            _ => worst_trade = Some((record.item_name.clone(), profit)),
        }

        let bucket_key = parse_timestamp(&record.closed_at)
            .and_then(|timestamp| {
                let date = timestamp.date();
                let midnight = date.with_hms(0, 0, 0).ok()?;
                format_timestamp(midnight.assume_utc()).ok()
            })
            .unwrap_or_else(|| record.closed_at.clone());
        *cumulative_bucket_map.entry(bucket_key).or_insert(0) += profit;

        profit_points.push(PortfolioTradeProfitPoint {
            id: record.id.clone(),
            item_name: record.item_name.clone(),
            closed_at: record.closed_at.clone(),
            profit,
        });

        if record.source == "alecaframe" && alecaframe_audit_ids.insert(record.id.clone()) {
            audit_rows.push(PortfolioAuditRow {
                id: record.id.clone(),
                item_name: record.item_name.clone(),
                slug: record.slug.clone(),
                order_type: record.order_type.clone(),
                source: record.source.clone(),
                closed_at: record.closed_at.clone(),
                label: "Alecaframe Import".to_string(),
                detail:
                    "This row was imported from Alecaframe and merged into the permanent trade ledger."
                        .to_string(),
            });
        }

        if let Some(group_id) = record.group_id.as_ref() {
            if ambiguous_group_ids.insert(group_id.clone()) {
                audit_rows.push(PortfolioAuditRow {
                    id: group_id.clone(),
                    item_name: record
                        .group_label
                        .clone()
                        .unwrap_or_else(|| "Grouped Trade".to_string()),
                    slug: record.slug.clone(),
                    order_type: record.order_type.clone(),
                    source: record.source.clone(),
                    closed_at: record.closed_at.clone(),
                    label: "Ambiguous Group".to_string(),
                    detail:
                        "Grouped trade still contains multiple child items and may need allocation review."
                            .to_string(),
                });
            }
        }
    }

    let average_margin = average(&positive_margin_values);
    let average_hold_hours = average(&average_hold_values);
    let average_profit_per_trade = if closed_trades > 0 {
        realized_profit as f64 / closed_trades as f64
    } else {
        0.0
    };
    let win_rate = if closed_trades > 0 {
        (win_count as f64 / closed_trades as f64) * 100.0
    } else {
        0.0
    };
    let cost_basis_coverage_pct = compute_cost_basis_coverage(
        total_sell_revenue,
        full_cost_basis_revenue,
        partial_cost_basis_revenue,
    );
    let current_value_coverage_pct =
        compute_current_value_coverage(open_exposure, current_value_covered_cost);

    let mut cumulative_profit = 0_i64;
    let mut cumulative_profit_points = cumulative_bucket_map
        .into_iter()
        .map(|(bucket_at, realized_profit_bucket)| {
            cumulative_profit += realized_profit_bucket;
            PortfolioPnlMetricPoint {
                label: build_portfolio_bucket_label(&bucket_at),
                bucket_at,
                realized_profit: realized_profit_bucket,
                cumulative_profit,
            }
        })
        .collect::<Vec<_>>();
    if cumulative_profit_points.len() > PORTFOLIO_PNL_CHART_BUCKET_LIMIT {
        let start = cumulative_profit_points.len() - PORTFOLIO_PNL_CHART_BUCKET_LIMIT;
        cumulative_profit_points = cumulative_profit_points.split_off(start);
    }

    profit_points.sort_by(|left, right| right.closed_at.cmp(&left.closed_at));
    profit_points.truncate(PORTFOLIO_PROFIT_POINT_LIMIT);
    profit_points.reverse();

    let mut notes = Vec::new();
    if closed_trades == 0 {
        notes.push("No closed sell trades were found for the selected period.".to_string());
    }
    if cost_basis_coverage_pct < 99.9 {
        notes.push(format!(
            "Profit coverage is {:.0}% because some sells do not have a full local cost basis yet.",
            cost_basis_coverage_pct
        ));
    }
    if current_value_coverage_pct < 99.9 {
        notes.push(format!(
            "Unrealized value coverage is {:.0}% because some held items do not have cached market statistics yet.",
            current_value_coverage_pct
        ));
    }
    if kept_items > 0 {
        notes.push(format!(
            "{kept_items} kept buy {} excluded from set/flip matching.",
            if kept_items == 1 {
                "entry is"
            } else {
                "entries are"
            }
        ));
    }

    inventory_rows.sort_by(|left, right| {
        right
            .unrealized_pnl
            .cmp(&left.unrealized_pnl)
            .then_with(|| right.estimated_value.cmp(&left.estimated_value))
            .then_with(|| left.item_name.cmp(&right.item_name))
    });
    audit_rows.sort_by(|left, right| {
        right
            .closed_at
            .cmp(&left.closed_at)
            .then_with(|| left.label.cmp(&right.label))
            .then_with(|| left.item_name.cmp(&right.item_name))
    });
    audit_rows.truncate(40);

    Ok(PortfolioPnlSummary {
        period: normalized_period,
        last_updated_at,
        realized_profit,
        unrealized_value,
        unrealized_pnl,
        total_pnl: realized_profit + unrealized_pnl,
        open_exposure,
        turnover_bought,
        turnover_sold,
        total_trades,
        closed_trades,
        open_buys,
        kept_items,
        cost_basis_coverage_pct,
        current_value_coverage_pct,
        win_rate,
        average_margin,
        average_profit_per_trade,
        average_hold_hours,
        sold_as_set_profit,
        flip_profit,
        unmatched_sell_revenue,
        partial_cost_basis_revenue,
        kept_inventory_value,
        partial_set_profit,
        best_trade_item: best_trade.as_ref().map(|value| value.0.clone()),
        best_trade_profit: best_trade.as_ref().map(|value| value.1),
        worst_trade_item: worst_trade.as_ref().map(|value| value.0.clone()),
        worst_trade_profit: worst_trade.as_ref().map(|value| value.1),
        inventory_rows,
        audit_rows,
        previous_realized_profit: cutoff.map(|_| previous_realized_profit),
        item_breakdown: breakdown_rows_from_map(item_breakdown_map, 8),
        category_breakdown: breakdown_rows_from_map(category_breakdown_map, 6),
        source_breakdown: breakdown_rows_from_map(source_breakdown_map, 6),
        cumulative_profit_points,
        profit_per_trade_points: profit_points,
        notes,
    })
}

fn parse_status_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("status")
        .and_then(Value::as_str)
        .map(normalize_status_label)
}

type WfmWsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Opens the single WFM websocket connection. Connecting requires no authentication — auth
/// (and the newOrders subscription) are applied as separate messages by the connection
/// manager, so the subscription can run logged-out and auth piggybacks when signed in.
async fn connect_wfm_websocket() -> Result<WfmWsStream> {
    let mut request = WFM_WS_URL
        .into_client_request()
        .context("failed to build WFM websocket request")?;
    let headers = request.headers_mut();
    // Static, known-valid header values; expect (not a bare unwrap) documents that the only way
    // these fail is an invalid edit to the constants themselves.
    headers.append(
        "Sec-WebSocket-Protocol",
        "wfm".parse().expect("static WS subprotocol header is valid"),
    );
    headers.append(
        "User-Agent",
        WFM_USER_AGENT
            .parse()
            .expect("static WFM user-agent header is valid"),
    );

    let (ws_stream, _) = timeout(Duration::from_secs(10), connect_async(request))
        .await
        .context("timed out while connecting to WFM websocket")?
        .context("failed to connect to WFM websocket")?;

    Ok(ws_stream)
}

/// Serializes and sends one envelope on the websocket.
async fn ws_send_message(ws: &mut WfmWsStream, route: &str, payload: Value) -> Result<()> {
    let message = WfmWsMessage {
        route: route.to_string(),
        payload: Some(payload),
        id: Some(uuid::Uuid::new_v4().to_string()),
        ref_id: None,
    };
    ws.send(Message::Text(
        serde_json::to_string(&message)
            .with_context(|| format!("failed to serialize websocket message {route}"))?
            .into(),
    ))
    .await
    .with_context(|| format!("failed to send websocket message {route}"))
}

async fn ws_send_auth(ws: &mut WfmWsStream, token: &str, device_id: &str) -> Result<()> {
    ws_send_message(
        ws,
        "@wfm|cmd/auth/signIn",
        json!({ "token": token, "deviceId": device_id }),
    )
    .await
}

async fn ws_send_status_set(ws: &mut WfmWsStream, status: &str) -> Result<()> {
    let normalized = normalize_status_set_request(status).unwrap_or("invisible");
    ws_send_message(ws, "@wfm|cmd/status/set", json!({ "status": normalized })).await
}

async fn ws_send_subscribe_new_orders(ws: &mut WfmWsStream) -> Result<()> {
    ws_send_message(ws, "@wfm|cmd/subscribe/newOrders", json!({ "platform": "pc" })).await
}

async fn ws_send_unsubscribe_new_orders(ws: &mut WfmWsStream) -> Result<()> {
    ws_send_message(ws, "@wfm|cmd/unsubscribe/newOrders", json!({ "platform": "pc" })).await
}

fn normalize_status_set_request(status: &str) -> Result<&'static str> {
    match status.trim().to_lowercase().as_str() {
        "ingame" | "in_game" => Ok("ingame"),
        "online" => Ok("online"),
        "invisible" | "offline" => Ok("invisible"),
        _ => Err(anyhow!("Unsupported presence state.")),
    }
}

// ─── Persistent presence keeper ───────────────────────────────────────────────
//
// On Warframe.Market your online/ingame presence only lasts while a WebSocket stays
// connected — the moment it drops, WFM marks you offline after its heartbeat grace
// window. The transient connect→set→disconnect calls used elsewhere therefore can't
// hold presence (which is why a browser tab was needed). This keeper holds a single
// long-lived connection that re-applies the desired status, answers pings, and
// reconnects automatically — including after a session re-auth, picking up the fresh
// token each time.

const TRADES_PRESENCE_FILE_NAME: &str = "wfm-presence.json";
const PRESENCE_CHANGED_EVENT: &str = "wfm-presence-changed";
/// Emitted to the frontend when a tracked watchlist item gets a matching sell ≤ target via
/// the realtime newOrders feed.
const WATCHLIST_ORDER_EVENT: &str = "wfm-watchlist-order";
/// Emitted when a live `newOrders` sell listing is priced well below its recommended entry
/// price (the "underpriced listings" radar on the Opportunities tab).
const UNDERPRICED_LISTING_EVENT: &str = "wfm-underpriced-listing";

/// The discount needed to flag a listing scales with the item's value: cheap items must be
/// discounted hard before they're worth a ping, while expensive items fire on a shallower
/// discount because the absolute plat saved is large. Returns the maximum `listed / recommended`
/// ratio that still triggers an alert for a given recommended price.
///
/// `0.88 - 2.5/rec` (clamped to `[0, 0.88]`) yields, by recommended price:
/// 5p → fire ≤ ~1.9p · 10p → ≤ ~6p · 20p → ≤ ~15p · 30p → ≤ ~24p · 50p → ≤ ~41p · 100p → ≤ ~85p.
const UNDERPRICED_TRIGGER_BASE_RATIO: f64 = 0.88;
const UNDERPRICED_TRIGGER_PRICE_OFFSET: f64 = 2.5;
/// Listings priced below this are ignored — almost always accidental/typo prices (e.g. 1p),
/// not real opportunities.
const UNDERPRICED_MIN_LISTED_PLAT: f64 = 3.0;

fn underpriced_trigger_ratio(recommended_price: f64) -> f64 {
    if !recommended_price.is_finite() || recommended_price <= 0.0 {
        return 0.0;
    }
    (UNDERPRICED_TRIGGER_BASE_RATIO - UNDERPRICED_TRIGGER_PRICE_OFFSET / recommended_price)
        .clamp(0.0, UNDERPRICED_TRIGGER_BASE_RATIO)
}
const PRESENCE_KEEPALIVE_SECONDS: u64 = 20;
const PRESENCE_STARTUP_DELAY_SECONDS: u64 = 8;

// ─── Single persistent websocket: commands + tracked-item registry ─────────────
//
// One long-lived connection serves both purposes: the `newOrders` subscription (which
// works logged-out and only runs when we have items to match) and, when signed in,
// presence/status. Other parts of the app talk to that connection through this command
// channel instead of opening their own sockets.

/// Commands sent to the persistent websocket task.
#[derive(Debug, Clone)]
pub(crate) enum WsCommand {
    /// Desired presence changed — apply it on the live connection.
    SetStatus,
    /// A session token became available (sign-in) — reconnect to authenticate.
    SignedIn,
    /// User signed out — drop presence/auth.
    SignedOut,
    /// Tracked-item set changed — (un)subscribe to newOrders as needed.
    RefreshSubscription,
}

fn ws_command_sender() -> &'static Mutex<Option<tokio::sync::mpsc::UnboundedSender<WsCommand>>> {
    static TX: OnceLock<Mutex<Option<tokio::sync::mpsc::UnboundedSender<WsCommand>>>> =
        OnceLock::new();
    TX.get_or_init(|| Mutex::new(None))
}

/// Sends a command to the persistent websocket task, if it is running. Best-effort: if the
/// task isn't up yet, the command is dropped (the task reconciles from shared state on its
/// next loop anyway).
pub(crate) fn send_ws_command(command: WsCommand) {
    if let Ok(guard) = ws_command_sender().lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(command);
        }
    }
}

/// A watchlist target the realtime feed matches incoming orders against.
#[derive(Debug, Clone)]
struct WatchlistTarget {
    watchlist_id: String,
    slug: String,
    target_price: f64,
    rank: Option<i64>,
}

/// Items the user is actively tracking, keyed by their Warframe.Market item id (the `itemId`
/// carried on each newOrder event). The newOrders subscription only runs while this is
/// non-empty, so we never pull the global firehose with nothing to match against. Synced
/// from the frontend watchlist via `set_watchlist_targets`.
fn watchlist_targets() -> &'static Mutex<std::collections::HashMap<String, WatchlistTarget>> {
    static TARGETS: OnceLock<Mutex<std::collections::HashMap<String, WatchlistTarget>>> =
        OnceLock::new();
    TARGETS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Seller-mode filter applied to realtime matches (`ingame` or `ingame-online`).
fn watchlist_seller_mode() -> &'static Mutex<String> {
    static MODE: OnceLock<Mutex<String>> = OnceLock::new();
    MODE.get_or_init(|| Mutex::new("ingame".to_string()))
}

fn has_tracked_items() -> bool {
    watchlist_targets()
        .lock()
        .map(|guard| !guard.is_empty())
        .unwrap_or(false)
}

/// True when the underpriced-listings radar has recommended prices to match against — in which
/// case the WS connection + `newOrders` subscription should stay up even with no watchlist
/// items, so the radar keeps running in the background.
fn radar_active() -> bool {
    crate::recommended_prices::tracked_count() > 0
}

/// Whether the `newOrders` subscription should be active: needed for watchlist alerts and/or the
/// underpriced-listings radar.
fn wants_new_orders_subscription() -> bool {
    has_tracked_items() || radar_active()
}

/// Whether an order from a user with `status` is acceptable under the current seller mode.
/// The newOrders feed already excludes offline users; `ingame` mode further restricts to
/// players actually in-game.
fn seller_status_allowed(status: Option<&str>, seller_mode: &str) -> bool {
    match seller_mode {
        "ingame" => matches!(status, Some("ingame")),
        // "ingame-online" / anything else: any non-offline status the feed delivers.
        _ => matches!(status, Some("ingame") | Some("online")),
    }
}

fn presence_desired_status() -> &'static Mutex<Option<String>> {
    static DESIRED: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    DESIRED.get_or_init(|| Mutex::new(None))
}

fn get_desired_presence() -> Option<String> {
    presence_desired_status().lock().ok().and_then(|guard| guard.clone())
}

fn set_desired_presence(status: Option<String>) {
    if let Ok(mut guard) = presence_desired_status().lock() {
        *guard = status;
    }
}

/// The presence status the keeper should currently be holding. We hold a connection
/// whenever the user is signed in (keeping the WFM session alive the way a browser tab
/// does); the chosen presence only decides what status to set. An unset/invisible choice
/// is held as `invisible` — connected and logged in, but appearing offline to others.
fn effective_presence_status() -> &'static str {
    match get_desired_presence().as_deref() {
        Some("ingame") => "ingame",
        Some("online") => "online",
        _ => "invisible",
    }
}

fn presence_file_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?
        .join(TRADES_DIR_NAME)
        .join(TRADES_PRESENCE_FILE_NAME))
}

fn load_persisted_desired_presence(app: &tauri::AppHandle) -> Option<String> {
    let path = presence_file_path(app).ok()?;
    let text = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    value
        .get("desiredStatus")
        .and_then(Value::as_str)
        .map(|status| status.to_string())
}

fn save_persisted_desired_presence(app: &tauri::AppHandle, status: Option<&str>) {
    let Ok(path) = presence_file_path(app) else {
        return;
    };
    match status {
        Some(status) => {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(serialized) = serde_json::to_string(&json!({ "desiredStatus": status })) {
                let _ = fs::write(path, serialized);
            }
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

/// Records the desired presence in memory, persists it across restarts, and makes sure
/// the keeper task is running so it gets applied and held.
fn apply_desired_presence(app: &tauri::AppHandle, status: Option<&str>) {
    set_desired_presence(status.map(|value| value.to_string()));
    save_persisted_desired_presence(app, status);
    start_ws_manager(app.clone());
}

fn ws_manager_started() -> &'static AtomicBool {
    static STARTED: AtomicBool = AtomicBool::new(false);
    &STARTED
}

/// Spawns the single persistent websocket manager exactly once, wiring up its command
/// channel. Loads any persisted desired presence so it is restored after a restart.
pub fn start_ws_manager(app: tauri::AppHandle) {
    if ws_manager_started().swap(true, Ordering::SeqCst) {
        return;
    }
    if get_desired_presence().is_none() {
        if let Some(persisted) = load_persisted_desired_presence(&app) {
            set_desired_presence(Some(persisted));
        }
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<WsCommand>();
    if let Ok(mut guard) = ws_command_sender().lock() {
        *guard = Some(tx);
    }
    tauri::async_runtime::spawn(run_ws_manager(app, rx));
}

/// The persistent websocket manager. Holds at most one connection, opened whenever we are
/// signed in (for presence) or have tracked items (for the newOrders subscription), and
/// reconnects with capped backoff. It never performs an HTTP credential sign-in — WS auth
/// uses the cached JWT — so it can never hammer the login endpoint.
async fn run_ws_manager(
    app: tauri::AppHandle,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<WsCommand>,
) {
    tokio::time::sleep(Duration::from_secs(PRESENCE_STARTUP_DELAY_SECONDS)).await;

    let reset_backoff = Duration::from_secs(2);
    let max_backoff = Duration::from_secs(60);
    let mut backoff = reset_backoff;

    loop {
        let session = get_session_from_cache();
        let want_connection = session.is_some() || wants_new_orders_subscription();

        if !want_connection {
            // Nothing to hold open. Wait for a command (sign-in / new tracked item) or
            // re-check periodically. No network, no login — purely idle.
            tokio::select! {
                _ = rx.recv() => {}
                _ = tokio::time::sleep(Duration::from_secs(30)) => {}
            }
            backoff = reset_backoff;
            continue;
        }

        // A connection that ends almost immediately is "flapping" — apply backoff even on a
        // clean close so a socket WFM keeps closing can never become a tight reconnect loop
        // (the WS handshake bypasses the HTTP rate limiter, so this guard is essential).
        const MIN_HEALTHY_CONNECTION: Duration = Duration::from_secs(10);
        let connected_at = std::time::Instant::now();

        match run_ws_connection(&app, &mut rx, session).await {
            // A deliberate command (status change / sign-in / sign-out) — reconnect promptly.
            Ok(WsOutcome::CommandReconnect) => {
                backoff = reset_backoff;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            // Socket closed: reset only if it held for a while; otherwise treat as flapping.
            Ok(WsOutcome::Closed) => {
                if connected_at.elapsed() >= MIN_HEALTHY_CONNECTION {
                    backoff = reset_backoff;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                } else {
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(max_backoff);
                }
            }
            Err(error) => {
                log_feature_error_best_effort(
                    &app,
                    "trades-ws",
                    "connection",
                    "WFM websocket dropped; backing off and reconnecting (auth session left intact).",
                    &error,
                );
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(max_backoff);
            }
        }
    }
}

/// Opens and services one websocket connection until it should be torn down (so the
/// manager can reconnect). Subscribes first (works logged-out), then authenticates if a
/// session token is available, then multiplexes inbound events and outbound commands.
/// Why a websocket connection ended — lets the manager reconnect promptly on a deliberate
/// command but back off on a socket close, so it can never tight-loop reconnects.
enum WsOutcome {
    /// A SetStatus/SignedIn/SignedOut/subscription command asked us to reconnect.
    CommandReconnect,
    /// The socket closed (clean close, EOF, or channel gone).
    Closed,
}

async fn run_ws_connection(
    app: &tauri::AppHandle,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<WsCommand>,
    session: Option<StoredTradeSession>,
) -> Result<WsOutcome> {
    let mut ws = connect_wfm_websocket().await?;
    let mut authenticated = false;
    let mut subscribed = false;

    if wants_new_orders_subscription() {
        ws_send_subscribe_new_orders(&mut ws).await?;
        subscribed = true;
        log_feature_event_best_effort(
            app,
            "trades-ws",
            "subscribe",
            "Subscribed to newOrders feed (watchlist and/or underpriced-listings radar).",
        );
    }

    if let Some(session) = session.as_ref() {
        ws_send_auth(&mut ws, &session.token, &session.device_id).await?;
    }

    loop {
        // Tear down when there's nothing left to hold the connection for.
        if get_session_from_cache().is_none() && !wants_new_orders_subscription() {
            return Ok(WsOutcome::CommandReconnect);
        }

        tokio::select! {
            command = rx.recv() => {
                match command {
                    None => return Ok(WsOutcome::Closed),
                    Some(WsCommand::SetStatus) => {
                        if authenticated {
                            ws_send_status_set(&mut ws, effective_presence_status()).await?;
                        }
                    }
                    // Reconnect to (re)authenticate or drop auth cleanly.
                    Some(WsCommand::SignedIn) | Some(WsCommand::SignedOut) => {
                        return Ok(WsOutcome::CommandReconnect)
                    }
                    Some(WsCommand::RefreshSubscription) => {
                        let want = wants_new_orders_subscription();
                        if want && !subscribed {
                            ws_send_subscribe_new_orders(&mut ws).await?;
                            subscribed = true;
                        } else if !want && subscribed {
                            ws_send_unsubscribe_new_orders(&mut ws).await?;
                            subscribed = false;
                        }
                    }
                }
            }
            next = timeout(Duration::from_secs(PRESENCE_KEEPALIVE_SECONDS), ws.next()) => {
                match next {
                    // Idle window elapsed: keepalive ping (also detects a dead socket).
                    Err(_) => {
                        ws.send(Message::Ping(Vec::new().into()))
                            .await
                            .context("failed to send websocket keepalive ping")?;
                    }
                    Ok(None) => return Ok(WsOutcome::Closed),
                    Ok(Some(message)) => {
                        match message.context("failed to read websocket message")? {
                            Message::Ping(payload) => {
                                ws.send(Message::Pong(payload))
                                    .await
                                    .context("failed to answer websocket ping")?;
                            }
                            Message::Close(_) => return Ok(WsOutcome::Closed),
                            Message::Text(text) => {
                                handle_ws_text(app, &mut ws, &text, &mut authenticated).await?;
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

/// Routes one inbound text frame. Unexpected/error paths are logged so the connection never
/// fails silently.
async fn handle_ws_text(
    app: &tauri::AppHandle,
    ws: &mut WfmWsStream,
    text: &str,
    authenticated: &mut bool,
) -> Result<()> {
    let Ok(message) = serde_json::from_str::<WfmWsMessage>(text) else {
        return Ok(());
    };
    let route = message
        .route
        .split('|')
        .nth(1)
        .unwrap_or(message.route.as_str());

    match route {
        "cmd/auth/signIn:ok" => {
            *authenticated = true;
            log_feature_event_best_effort(
                app,
                "trades-ws",
                "auth",
                "Websocket authenticated; applying presence.",
            );
            ws_send_status_set(ws, effective_presence_status()).await?;
        }
        "cmd/auth/signIn:error" => {
            log_feature_error_best_effort(
                app,
                "trades-ws",
                "auth",
                "Websocket authentication failed (presence unavailable; subscription continues).",
                &anyhow!("{}", message.payload.clone().unwrap_or(Value::Null)),
            );
        }
        "cmd/subscribe/newOrders:error" => {
            log_feature_error_best_effort(
                app,
                "trades-ws",
                "subscribe",
                "newOrders subscription was rejected by the server.",
                &anyhow!("{}", message.payload.clone().unwrap_or(Value::Null)),
            );
        }
        "event/subscriptions/newOrder" => {
            if let Some(order) = message.payload.as_ref() {
                handle_new_order_event(app, order);
            }
        }
        "event/status/set" | "cmd/status/set:ok" => {
            if let Some(status) = message.payload.as_ref().and_then(parse_status_from_payload) {
                record_observed_presence(app, &status);
            }
        }
        "cmd/status/set:error" => {
            log_feature_error_best_effort(
                app,
                "trades-ws",
                "status",
                "Failed to set presence status over the websocket.",
                &anyhow!("{}", message.payload.clone().unwrap_or(Value::Null)),
            );
        }
        _ => {}
    }
    Ok(())
}

/// Minimal newOrder event payload (an `Order` shape) — only the fields we match on.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewOrderEventUser {
    #[serde(default)]
    ingame_name: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewOrderEvent {
    id: String,
    #[serde(rename = "type")]
    order_type: String,
    platinum: f64,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    rank: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    item_id: Option<String>,
    #[serde(default)]
    user: Option<NewOrderEventUser>,
}

/// Handles a pushed newOrder event. Only acts on items the user tracks (the global firehose
/// is otherwise discarded). For a tracked item, a matching **sell ≤ target** from an
/// acceptable seller emits a realtime watchlist alert to the frontend. (Order-flow activity
/// recording is added in the next step.)
fn handle_new_order_event(app: &tauri::AppHandle, payload: &Value) {
    let Ok(order) = serde_json::from_value::<NewOrderEvent>(payload.clone()) else {
        return;
    };
    let Some(item_id) = order.item_id.as_deref() else {
        return;
    };

    // Count every firehose order we examine — a simple "the subscription is flowing" signal.
    crate::recommended_prices::increment_scanned();

    // Underpriced-listings radar — runs for the WHOLE firehose (any item with a recommended
    // price), independent of the watchlist branch below.
    check_underpriced_listing(app, &order, item_id);

    // Look up the tracked target; discard untracked items immediately.
    let Some(target) = watchlist_targets()
        .lock()
        .ok()
        .and_then(|guard| guard.get(item_id).cloned())
    else {
        return;
    };

    // Watchlist alerts are buying opportunities: a new visible SELL at or below target.
    if order.order_type != "sell" || order.visible == Some(false) {
        return;
    }
    if order.rank != target.rank {
        return;
    }
    if order.platinum > target.target_price {
        return;
    }

    let seller_mode = watchlist_seller_mode()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| "ingame".to_string());
    let status = order.user.as_ref().and_then(|user| user.status.as_deref());
    if !seller_status_allowed(status, &seller_mode) {
        return;
    }

    let Some(username) = order
        .user
        .as_ref()
        .and_then(|user| user.ingame_name.clone())
    else {
        // Can't whisper a seller we can't name.
        return;
    };

    let _ = app.emit(
        WATCHLIST_ORDER_EVENT,
        json!({
            "watchlistId": target.watchlist_id,
            "itemId": item_id,
            "slug": target.slug,
            "orderId": order.id,
            "username": username,
            "userSlug": order.user.as_ref().and_then(|user| user.slug.clone()),
            "platinum": order.platinum,
            "quantity": order.quantity.unwrap_or(1),
            "rank": order.rank,
            "createdAt": order.created_at,
        }),
    );
}

/// Flags a live sell listing that is priced well below its recommended entry price. Looks up the
/// item's recommended price (populated by the scanner / analysis), and on a strong-enough
/// discount from an acceptable seller emits an `UNDERPRICED_LISTING_EVENT` for the Opportunities
/// radar. Respects the user's seller mode, same as watchlist alerts.
fn check_underpriced_listing(app: &tauri::AppHandle, order: &NewOrderEvent, item_id: &str) {
    // Buying opportunities only: a new, visible SELL listing with a sane price.
    if order.order_type != "sell" || order.visible == Some(false) {
        return;
    }
    if !order.platinum.is_finite() || order.platinum <= 0.0 {
        return;
    }
    // Ignore very cheap listings — these are almost always accidental/typo prices
    // (e.g. someone listing for 1p) rather than a real underpriced opportunity.
    if order.platinum < UNDERPRICED_MIN_LISTED_PLAT {
        return;
    }

    let variant_key = crate::recommended_prices::variant_key_for_rank(order.rank);
    let Some(recommended) = crate::recommended_prices::recommended_price(item_id, &variant_key)
    else {
        return;
    };
    if recommended.price <= 0.0 {
        return;
    }

    let ratio = order.platinum / recommended.price;
    let trigger_ratio = underpriced_trigger_ratio(recommended.price);
    if !ratio.is_finite() || trigger_ratio <= 0.0 || ratio >= trigger_ratio {
        return;
    }

    // Same seller-mode gate as watchlist alerts — only surface sellers you can trade with now.
    let seller_mode = watchlist_seller_mode()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| "ingame".to_string());
    let status = order.user.as_ref().and_then(|user| user.status.as_deref());
    if !seller_status_allowed(status, &seller_mode) {
        return;
    }

    let Some(username) = order.user.as_ref().and_then(|user| user.ingame_name.clone()) else {
        // Can't whisper a seller we can't name.
        return;
    };

    // Colour by how deep into the trigger zone the listing sits, not by an absolute discount —
    // since the trigger ratio now scales with price, a fixed band would peg high-value items to
    // "normal" forever. depth 0 = just qualified, 1 = nearly free.
    let depth = ((trigger_ratio - ratio) / trigger_ratio).clamp(0.0, 1.0);
    let tier = if depth >= 0.6 {
        "red"
    } else if depth >= 0.3 {
        "yellow"
    } else {
        "normal"
    };

    // Snipe-completes-set: if this underpriced part finishes a set the user is close to, attach the
    // context so the radar card can flag it as a buy-to-complete play.
    let completes_set = crate::opportunities::owned_set_part_hint(&recommended.slug).map(|hint| {
        json!({
            "setSlug": hint.set_slug,
            "setName": hint.set_name,
            "ownedDistinct": hint.owned_distinct,
            "neededDistinct": hint.needed_distinct,
        })
    });

    let _ = app.emit(
        UNDERPRICED_LISTING_EVENT,
        json!({
            "itemId": item_id,
            "slug": recommended.slug,
            "itemName": recommended.name,
            "orderId": order.id,
            "username": username,
            "userSlug": order.user.as_ref().and_then(|user| user.slug.clone()),
            "rank": order.rank,
            "quantity": order.quantity.unwrap_or(1),
            "listedPrice": order.platinum,
            "recommendedPrice": recommended.price,
            "pctBelow": (1.0 - ratio) * 100.0,
            "tier": tier,
            "completesSet": completes_set,
        }),
    );
}

/// Updates the cached session's status and notifies the frontend so the UI reflects the
/// presence WFM is actually reporting.
fn record_observed_presence(app: &tauri::AppHandle, status: &str) {
    // Update the cache and, only when the status actually changed, persist it so the on-disk
    // session converges to the server-confirmed value — the optimistic write in
    // set_wfm_trade_status may have stored an unconfirmed/normalized-away status. Guarding on a
    // real change avoids a keychain write on every (often unchanged) presence event.
    let updated_session = match session_cache().lock() {
        Ok(mut guard) => guard.as_mut().and_then(|session| {
            if session.account.status == status {
                None
            } else {
                session.account.status = status.to_string();
                Some(session.clone())
            }
        }),
        Err(_) => None,
    };
    if let Some(session) = updated_session {
        let _ = save_session(app, &session);
    }
    let _ = app.emit(PRESENCE_CHANGED_EVENT, status.to_string());
}

fn sign_in_inner(app: &tauri::AppHandle, input: &TradeSignInInput) -> Result<StoredTradeSession> {
    let client = shared_wfm_client()?;
    let trimmed_email = input.email.trim();
    let trimmed_password = input.password.trim();
    if trimmed_email.is_empty() || trimmed_password.is_empty() {
        return Err(anyhow!(
            "Enter both your Warframe Market email and password."
        ));
    }

    // Honour an active rate-limit cooldown WITHOUT touching the network. Re-hitting
    // /auth/signin while Cloudflare is rate-limiting us just resets its window and keeps the
    // account blocked, so we refuse locally until the cooldown lapses.
    if let Some(remaining) = signin_cooldown_remaining(app) {
        return Err(anyhow!(
            "Warframe.Market is rate-limiting sign-in (Cloudflare 1015). Wait about {}s before trying again.",
            remaining.as_secs().max(1)
        ));
    }

    let device_id = get_or_create_device_id();
    let response = execute_wfm_bytes_request(
        client
            .post(format!("{WFM_API_BASE_URL_V1}/auth/signin"))
            .header("User-Agent", WFM_USER_AGENT)
            .header("Authorization", "JWT")
            .header("Accept", "application/json")
            .json(&json!({
                "auth_type": "header",
                "email": trimmed_email,
                "password": trimmed_password,
                "device_id": device_id,
            })),
        RequestPriority::Instant,
        "request WFM sign-in",
        None,
    )?;

    // Rate-limited: record a cooldown (using the server's retry_after when present) so no
    // path re-attempts sign-in until it lapses, then surface the error.
    if response.status == 429 || response_body_is_rate_limited(&response.body) {
        note_signin_rate_limited(app, response.retry_after);
        return Err(extract_wfm_bytes_error("request WFM sign-in", &response));
    }

    if response.status < 200 || response.status >= 300 {
        return Err(extract_wfm_bytes_error("request WFM sign-in", &response));
    }

    let auth_header = response
        .headers
        .get("authorization")
        .map(String::as_str)
        .ok_or_else(|| anyhow!("WFM sign-in succeeded but did not return an auth token"))?
        .to_string();

    let jwt = auth_header
        .strip_prefix("JWT ")
        .or_else(|| auth_header.strip_prefix("Bearer "))
        .unwrap_or(&auth_header)
        .trim()
        .to_string();
    if jwt.is_empty() {
        return Err(anyhow!("WFM sign-in returned an empty auth token"));
    }

    let account = fetch_me_with_token(&client, &jwt)?;

    // A clean sign-in clears any prior rate-limit cooldown.
    clear_signin_cooldown(app);

    Ok(StoredTradeSession {
        warstonks_version: None,
        token: jwt,
        device_id,
        account,
    })
}

/// True when a response body is a Cloudflare 1015 rate-limit payload (defensive: some edge
/// responses arrive with a non-429 status but the 1015 body).
fn response_body_is_rate_limited(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body);
    text.contains("1015") || text.to_ascii_lowercase().contains("rate limited")
}

/// Decides whether an error means the WFM session has genuinely expired and we should
/// re-authenticate.
///
/// Scoped deliberately tight. A real JWT expiry is an HTTP **401**. We do NOT treat the
/// following as expiry, because doing so destroys a still-valid session and can trigger a
/// re-login storm (which is exactly how the sign-in endpoint gets Cloudflare-rate-limited):
/// - **403 Forbidden** — typically a Cloudflare block / "error code: 1015" / permission
///   issue, not an expired token. Clearing the session won't help and re-login makes it
///   worse.
/// - Bare substrings like "auth" or "token" — far too broad (they match unrelated error
///   text and request labels), causing spurious re-auths.
fn should_attempt_trade_session_reauth(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();

    // A rate-limit / Cloudflare block is never an expiry — never re-auth on it.
    if is_rate_limit_error(error) {
        return false;
    }

    message.contains("failed with status 401")
        || message.contains("session expired")
        || message.contains("token expired")
        || message.contains("invalid token")
        || message.contains("unauthorized")
}

/// True when an error is a Warframe.Market / Cloudflare rate-limit response — HTTP 429,
/// commonly surfaced by Cloudflare as "error code: 1015" on the sign-in endpoint.
fn is_rate_limit_error(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("failed with status 429") || message.contains("1015")
}

/// Maps a sign-in failure to a user-facing message. Rate limits get a clear, actionable
/// explanation instead of the raw Cloudflare status code, which is otherwise opaque.
fn friendly_sign_in_error(error: &anyhow::Error) -> String {
    let message = error.to_string();

    // Our own cooldown/suspension messages are already user-friendly (and carry a precise
    // wait time) — pass them through unchanged rather than flattening to the generic text.
    if message.contains("Wait about")
        || message.contains("automatic retry is paused")
        || message.contains("Automatic sign-in is paused")
    {
        return message;
    }

    if is_rate_limit_error(error) {
        return "Warframe.Market is temporarily rate-limiting sign-in requests \
(Cloudflare \"error code: 1015\"). This is a limit on their end, not a problem with your \
credentials. Please wait a minute or two before trying again, and avoid repeated sign-in \
attempts until then."
            .to_string();
    }
    message
}

/// Automatic (non-user-initiated) credential sign-in, governed and fully logged.
///
/// Fail-stop policy: each call makes at most ONE sign-in attempt. After
/// [`MAX_AUTO_SIGNIN_ATTEMPTS`] consecutive failures the governor suspends automatic
/// sign-in entirely — the user must then sign in manually (which resets the governor). This
/// replaces the old exponential-backoff retry that, combined with background callers, could
/// hammer WFM's login endpoint indefinitely. Rate-limit cooldowns are honoured WITHOUT
/// consuming an attempt. Every branch leaves a log breadcrumb so the flow is never silent.
fn restore_saved_trade_session(app: &tauri::AppHandle) -> Result<Option<StoredTradeSession>> {
    let Some(creds) = load_trade_credentials(app)? else {
        log_feature_event_best_effort(
            app,
            "trades-session",
            "auto-signin",
            "No saved credentials; automatic sign-in skipped (user must sign in).",
        );
        return Ok(None);
    };

    // Suspended after repeated failures — never auto-attempt again until a manual sign-in.
    if is_auto_signin_suspended(app) {
        log_feature_event_best_effort(
            app,
            "trades-session",
            "auto-signin",
            "Automatic sign-in is suspended after repeated failures; manual sign-in required.",
        );
        return Err(anyhow!(
            "Automatic sign-in is paused after repeated failures. Please sign in to Warframe Market again."
        ));
    }

    // Respect an active rate-limit cooldown without consuming an attempt.
    if let Some(remaining) = signin_cooldown_remaining(app) {
        log_feature_event_best_effort(
            app,
            "trades-session",
            "auto-signin",
            &format!(
                "Automatic sign-in skipped; rate-limit cooldown active ({}s remaining).",
                remaining.as_secs()
            ),
        );
        return Err(anyhow!(
            "Warframe.Market sign-in is rate-limited; automatic retry is paused for {}s.",
            remaining.as_secs()
        ));
    }

    let input = TradeSignInInput {
        email: creds.email.trim().to_string(),
        password: creds.password.trim().to_string(),
        stay_logged_in: true,
    };

    let attempt_so_far = read_auto_signin_state(app).failures + 1;
    log_feature_event_best_effort(
        app,
        "trades-session",
        "auto-signin",
        &format!(
            "Attempting automatic sign-in from saved credentials (attempt {attempt_so_far}/{MAX_AUTO_SIGNIN_ATTEMPTS})."
        ),
    );

    match sign_in_inner(app, &input) {
        Ok(session) => {
            reset_auto_signin_state(app);
            // Persistence is best-effort: a keychain write failure must not break the live
            // session, but we log it loudly because it forces a re-auth next launch.
            if let Err(error) = save_session(app, &session) {
                log_feature_error_best_effort(
                    app,
                    "trades-session",
                    "auto-signin-save",
                    "Automatic sign-in succeeded but persisting the session token failed — a re-auth will be needed next launch.",
                    &error,
                );
            }
            set_session_in_cache(&session);
            log_feature_event_best_effort(
                app,
                "trades-session",
                "auto-signin",
                "Automatic sign-in succeeded.",
            );
            Ok(Some(session))
        }
        Err(error) => {
            // A rate-limit isn't a credential failure — don't burn an attempt on it.
            if is_rate_limit_error(&error) {
                log_feature_error_best_effort(
                    app,
                    "trades-session",
                    "auto-signin",
                    "Automatic sign-in was rate-limited (no attempt consumed; cooldown applied).",
                    &error,
                );
                return Err(error);
            }

            let failures = record_auto_signin_failure(app);
            if failures >= MAX_AUTO_SIGNIN_ATTEMPTS {
                log_feature_error_best_effort(
                    app,
                    "trades-session",
                    "auto-signin",
                    &format!(
                        "Automatic sign-in failed ({failures}/{MAX_AUTO_SIGNIN_ATTEMPTS}) — suspending automatic sign-in; manual sign-in now required."
                    ),
                    &error,
                );
            } else {
                log_feature_error_best_effort(
                    app,
                    "trades-session",
                    "auto-signin",
                    &format!(
                        "Automatic sign-in failed (attempt {failures}/{MAX_AUTO_SIGNIN_ATTEMPTS})."
                    ),
                    &error,
                );
            }
            Err(error)
        }
    }
}

fn ensure_authenticated_session(app: &tauri::AppHandle) -> Result<StoredTradeSession> {
    // Return the in-memory cached session without any network call. The token is
    // trusted until an actual WFM API call returns 401, at which point the caller
    // clears the cache and this function re-auths from credentials.
    if let Some(session) = get_session_from_cache() {
        return Ok(session);
    }

    // Cache miss: try the keychain-persisted session token first to avoid a full
    // credential re-auth (which counts against WFM login rate limits).
    if let Some(session) = load_session(app)? {
        set_session_in_cache(&session);
        return Ok(session);
    }

    // No persisted token: sign in with saved credentials.
    if let Some(session) = restore_saved_trade_session(app)? {
        return Ok(session); // restore_saved_trade_session populates the cache
    }

    Err(anyhow!("Sign in to Warframe Market first."))
}

fn reauth_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Clears the in-memory and persisted session, then re-authenticates from saved
/// credentials. Called when a real WFM API call returns a 401.
///
/// Single-flighted: when several in-flight requests get a 401 at once, only the first
/// actually signs in; the others wait on the lock and then reuse the freshly cached
/// session (detected by the token differing from the `stale_token` they failed with).
/// This prevents a burst of concurrent sign-ins from tripping WFM's login rate limit.
fn reauth_session(app: &tauri::AppHandle, stale_token: &str) -> Result<StoredTradeSession> {
    let _guard = reauth_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    // Another thread may have already re-authenticated while we waited for the lock.
    if let Some(session) = get_session_from_cache() {
        if session.token != stale_token {
            return Ok(session);
        }
    }

    clear_session_cache();
    let _ = clear_session(app);
    if let Some(session) = restore_saved_trade_session(app)? {
        return Ok(session);
    }
    Err(anyhow!("Warframe Market session expired. Please sign in again."))
}

fn ensure_presence_connection(app: &tauri::AppHandle) {
    // Make sure the persistent websocket is running and authenticated. The live status is
    // delivered asynchronously via PRESENCE_CHANGED_EVENT — we no longer open a transient
    // socket here just to read it (that was wasteful and is what the manager exists for).
    start_ws_manager(app.clone());
    send_ws_command(WsCommand::SignedIn);
}

fn build_connected_trade_session_state(
    app: &tauri::AppHandle,
    session: StoredTradeSession,
) -> Result<TradeSessionState> {
    ensure_presence_connection(app);
    Ok(TradeSessionState {
        connected: true,
        account: Some(session.account),
    })
}

/// Validate the current session (in-memory cache, then keychain) with a live `/me`
/// call and, if it has expired, transparently re-authenticate from saved credentials.
///
/// This is the user-facing restore path (Trades tab open, startup auto-sign-in). Unlike
/// [`ensure_authenticated_session`] — which trusts the cached token for high-frequency
/// internal calls and relies on a later 401 to trigger re-auth — this path proactively
/// confirms the session is live so the UI never shows a stale "logged out" state while a
/// valid set of saved credentials could log the user straight back in.
///
/// Returns `Ok(None)` only when there is no usable session and no saved credentials.
fn restore_or_reauth_validated_session(
    app: &tauri::AppHandle,
) -> Result<Option<StoredTradeSession>> {
    let client = shared_wfm_client()?;

    // Trust the in-memory cached session as-is: it was established/refreshed during this
    // run, so validating it with another /me call only risks a false logout if that call
    // hits a transient 401/403/rate-limit. If the cached token has actually expired, the
    // real order/overview API calls return 401 and trigger re-auth on their own.
    if let Some(session) = get_session_from_cache() {
        return Ok(Some(session));
    }

    // Cold start: only a keychain-loaded session (which may have expired since last run)
    // gets a live /me validation before we trust it.
    let candidate = load_session(app)?;

    if let Some(mut session) = candidate {
        match fetch_me_with_token(&client, &session.token) {
            Ok(account) => {
                session.account = account;
                set_session_in_cache(&session);
                let _ = save_session(app, &session);
                return Ok(Some(session));
            }
            Err(error) if should_attempt_trade_session_reauth(&error) => {
                // Genuine expiry/auth failure — drop the dead session and fall through
                // to a credential re-auth below.
                log_feature_error_best_effort(
                    app,
                    "trades-session",
                    "validate-session",
                    "Saved Warframe Market session is no longer valid; re-authenticating from saved credentials.",
                    &error,
                );
                clear_session_cache();
                let _ = clear_session(app);
            }
            Err(error) => {
                // Transient/network error (not an auth failure): keep trusting the
                // cached session rather than flipping the user to a logged-out state
                // on a connectivity blip.
                log_feature_error_best_effort(
                    app,
                    "trades-session",
                    "validate-session",
                    "Couldn't reach Warframe Market to validate the session; keeping the current session.",
                    &error,
                );
                return Ok(Some(session));
            }
        }
    }

    // No usable session (or it just expired): re-auth from saved credentials.
    // Returns Ok(None) when no credentials are stored.
    restore_saved_trade_session(app)
}

fn load_or_restore_trade_session_state(app: &tauri::AppHandle) -> Result<TradeSessionState> {
    match restore_or_reauth_validated_session(app)? {
        Some(session) => build_connected_trade_session_state(app, session),
        None => Ok(TradeSessionState {
            connected: false,
            account: None,
        }),
    }
}

fn try_restore_trade_session_state(app: &tauri::AppHandle) -> Result<TradeSessionState> {
    match load_or_restore_trade_session_state(app) {
        Ok(state) => Ok(state),
        Err(error) => {
            if load_trade_credentials(app)?.is_none() {
                return Ok(TradeSessionState {
                    connected: false,
                    account: None,
                });
            }

            log_feature_error_best_effort(
                app,
                "trades-session",
                "restore-session",
                "Failed to restore the remembered Warframe Market session automatically.",
                &error,
            );
            Ok(TradeSessionState {
                connected: false,
                account: None,
            })
        }
    }
}

fn resolve_catalog_trade_item_meta(
    connection: &Connection,
    wfm_id: &str,
) -> Result<Option<CatalogTradeItemMeta>> {
    connection
        .query_row(
            "SELECT
                item_id,
                wfm_id,
                slug,
                COALESCE(NULLIF(name_en, ''), slug),
                COALESCE(NULLIF(thumb, ''), NULLIF(icon, '')),
                max_rank,
                bulk_tradable
             FROM wfm_items
             WHERE wfm_id = ?1
             LIMIT 1",
            params![wfm_id],
            |row| {
                Ok(CatalogTradeItemMeta {
                    item_id: row.get(0)?,
                    wfm_id: row.get(1)?,
                    slug: row.get(2)?,
                    name: row.get(3)?,
                    image_path: row.get(4)?,
                    max_rank: row.get(5)?,
                    bulk_tradable: row.get::<_, Option<i64>>(6)?.unwrap_or(0) == 1,
                })
            },
        )
        .optional()
        .context("failed to resolve catalog item")
}

fn fetch_my_orders(client: &Client, token: &str) -> Result<Vec<WfmOwnOrder>> {
    let response = execute_wfm_bytes_request(
        send_wfm_request(
            client,
            Method::GET,
            format!("{WFM_API_BASE_URL_V2}/orders/my"),
            Some(token),
        ),
        RequestPriority::Instant,
        "load own orders",
        Some("orders:my".to_string()),
    )?;
    if response.status < 200 || response.status >= 300 {
        return Err(extract_wfm_bytes_error("load own orders", &response));
    }

    let payload = serde_json::from_slice::<WfmMyOrdersResponse>(&response.body)
        .context("failed to parse own orders response")?;

    Ok(payload.data)
}

#[derive(Debug, Deserialize)]
struct WfmUserOrdersResponse {
    #[serde(default)]
    data: Vec<WfmUserOrder>,
}

/// A compact order from `GET /v2/orders/user/{slug}`. All fields optional/lenient so a shape
/// change can't break the verify call.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmUserOrder {
    #[serde(default)]
    id: Option<String>,
    #[serde(rename = "type", default)]
    order_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_lenient_optional_i64")]
    platinum: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_lenient_optional_i64")]
    rank: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    item_id: Option<String>,
}

/// Result of re-checking whether an underpriced listing is still live on Warframe.Market.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyMarketListingResult {
    pub still_listed: bool,
    pub current_price: Option<i64>,
}

fn verify_market_listing_inner(
    user_slug: &str,
    order_id: &str,
    item_id: &str,
    rank: Option<i64>,
    expected_price: i64,
    token: Option<&str>,
) -> Result<VerifyMarketListingResult> {
    if user_slug.is_empty() {
        return Err(anyhow!("That listing has no seller to re-check."));
    }

    let client = shared_wfm_client()?;
    // The v2 user-orders endpoint rejects anonymous callers, so send the cached session JWT when
    // we have one (the radar only runs while signed in, so we normally do).
    let response = execute_wfm_bytes_request(
        send_wfm_request(
            &client,
            Method::GET,
            format!("{WFM_API_BASE_URL_V2}/orders/user/{user_slug}"),
            token,
        ),
        RequestPriority::Instant,
        "verify market listing",
        Some(format!("orders:user:{user_slug}")),
    )?;
    if response.status < 200 || response.status >= 300 {
        return Err(extract_wfm_bytes_error("verify market listing", &response));
    }

    let payload = serde_json::from_slice::<WfmUserOrdersResponse>(&response.body)
        .context("failed to parse user orders response")?;

    let is_buyable_sell = |order: &WfmUserOrder| {
        order.order_type.as_deref() == Some("sell") && order.visible != Some(false)
    };

    // Primary: the exact listing by order id (a price edit keeps the same id).
    if let Some(order) = payload
        .data
        .iter()
        .find(|order| order.id.as_deref() == Some(order_id))
    {
        if is_buyable_sell(order) {
            return Ok(VerifyMarketListingResult {
                still_listed: true,
                current_price: order.platinum,
            });
        }
        return Ok(VerifyMarketListingResult {
            still_listed: false,
            current_price: None,
        });
    }

    // Fallback: any visible sell for the same item + rank still at or below the price we saw.
    let fallback = payload.data.iter().find(|order| {
        is_buyable_sell(order)
            && order.item_id.as_deref() == Some(item_id)
            && order.rank == rank
            && order.platinum.map(|price| price <= expected_price).unwrap_or(false)
    });
    Ok(match fallback {
        Some(order) => VerifyMarketListingResult {
            still_listed: true,
            current_price: order.platinum,
        },
        None => VerifyMarketListingResult {
            still_listed: false,
            current_price: None,
        },
    })
}

#[tauri::command]
pub async fn verify_market_listing(
    order_id: String,
    user_slug: String,
    item_id: String,
    rank: Option<i64>,
    expected_price: i64,
) -> Result<VerifyMarketListingResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = get_session_from_cache().map(|session| session.token);
        verify_market_listing_inner(
            user_slug.trim(),
            order_id.trim(),
            item_id.trim(),
            rank,
            expected_price,
            token.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

fn build_trade_overview_inner(app: &tauri::AppHandle, _seller_mode: &str) -> Result<TradeOverview> {
    let mut session = ensure_authenticated_session(app)?;
    let connection = open_catalog_database(app)?;
    let client = shared_wfm_client()?;
    let orders = match fetch_my_orders(&client, &session.token) {
        Ok(orders) => orders,
        Err(ref error) if should_attempt_trade_session_reauth(error) => {
            log_feature_error_best_effort(
                app,
                "trades-session",
                "reauth-on-401",
                "WFM orders fetch returned an auth error — re-authenticating automatically.",
                error,
            );
            session = reauth_session(app, &session.token)?;
            fetch_my_orders(&client, &session.token)?
        }
        Err(error) => return Err(error),
    };
    let mut sell_orders = Vec::new();
    let mut buy_orders = Vec::new();

    for order in orders
        .into_iter()
        .filter(|entry| matches!(entry.order_type.as_str(), "sell" | "buy"))
    {
        let Some(meta) = resolve_catalog_trade_item_meta(&connection, &order.item_id)? else {
            continue;
        };

        let trade_order = TradeSellOrder {
            order_id: order.id,
            order_type: order.order_type.clone(),
            wfm_id: meta.wfm_id,
            item_id: meta.item_id,
            name: meta.name,
            slug: meta.slug,
            image_path: meta.image_path,
            rank: order.rank,
            max_rank: meta.max_rank,
            quantity: order.quantity,
            per_trade: order.per_trade.unwrap_or(1).max(1),
            bulk_tradable: meta.bulk_tradable,
            your_price: order.platinum,
            market_low: None,
            price_gap: None,
            visible: order.visible.unwrap_or(true),
            updated_at: order.updated_at,
            health_score: None,
            health_note: None,
            health: None,
        };

        if order.order_type == "sell" {
            sell_orders.push(trade_order);
        } else {
            buy_orders.push(trade_order);
        }
    }

    sell_orders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    buy_orders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    // Active trade value reflects only visible SELL orders — it's the plat you have
    // listed for sale, not what you're bidding to buy.
    let active_trade_value = sell_orders
        .iter()
        .filter(|order| order.visible)
        .map(|order| order.your_price.saturating_mul(order.quantity))
        .sum::<i64>();

    // Cache a slim snapshot of the active sell orders so the opportunities engine can flag
    // overpriced listings without a live WFM fetch (best-effort; never fails the overview).
    let cached_orders: Vec<crate::opportunities::CachedSellOrder> = sell_orders
        .iter()
        .map(|order| crate::opportunities::CachedSellOrder {
            order_id: order.order_id.clone(),
            slug: order.slug.clone(),
            name: order.name.clone(),
            image_path: order.image_path.clone(),
            item_id: order.item_id,
            rank: order.rank,
            your_price: order.your_price,
            visible: order.visible,
        })
        .collect();
    if let Ok(json) = serde_json::to_string(&cached_orders) {
        if crate::market_observatory::persist_trade_sell_orders(app, &json).is_ok() {
            crate::opportunities::signal_stale(app); // Active listings changed → board is stale.
        }
    }

    Ok(TradeOverview {
        account: session.account.clone(),
        last_updated_at: format_timestamp(now_utc())?,
        active_trade_value,
        total_completed_trades: None,
        open_positions: (sell_orders.len() + buy_orders.len()) as i64,
        sell_orders,
        buy_orders,
    })
}

/// Looks up whether an item is bulk-tradable (e.g. arcanes) from the local catalog.
fn catalog_item_is_bulk_tradable(connection: &Connection, wfm_id: &str) -> Result<bool> {
    let value = connection
        .query_row(
            "SELECT bulk_tradable FROM wfm_items WHERE wfm_id = ?1 LIMIT 1",
            params![wfm_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .context("failed to look up the item's bulk-tradable flag")?
        .flatten();
    Ok(value.unwrap_or(0) == 1)
}

/// The item's WFM subtypes in catalog order (index 0 is WFM's default — "regular" for
/// Atragraph-variant mods, "intact" for relics). WFM rejects order creation for subtyped items
/// when the payload omits `subtype`; items without subtypes return an empty list and the field
/// must be omitted (sending it for those is equally rejected).
pub(crate) fn catalog_item_subtypes(connection: &Connection, wfm_id: &str) -> Result<Vec<String>> {
    let mut statement = connection
        .prepare(
            "SELECT subtype FROM wfm_item_subtypes WHERE wfm_id = ?1 ORDER BY subtype_index ASC",
        )
        .context("failed to prepare the item subtype lookup")?;
    let subtypes = statement
        .query_map(params![wfm_id], |row| row.get::<_, String>(0))
        .context("failed to look up the item's subtypes")?
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("failed to read the item's subtypes")?;
    Ok(subtypes)
}

/// Resolves the `perTrade` value to send with an order. WFM requires `perTrade` for
/// bulk-tradable items and forbids it otherwise, so this returns `None` for non-bulk items
/// (omit the field) and a validated batch size for bulk items (1..=6 that divides quantity,
/// defaulting to 1 when the caller doesn't specify one).
fn resolve_per_trade(
    bulk_tradable: bool,
    per_trade: Option<i64>,
    quantity: i64,
) -> Result<Option<i64>> {
    if !bulk_tradable {
        return Ok(None);
    }
    let value = per_trade.unwrap_or(1);
    if !(1..=6).contains(&value) {
        return Err(anyhow!(
            "Per-trade quantity must be between 1 and 6 for bulk-tradable items."
        ));
    }
    if quantity % value != 0 {
        return Err(anyhow!(
            "Per-trade quantity ({value}) must divide the listing quantity ({quantity}) evenly."
        ));
    }
    Ok(Some(value))
}

fn create_order_inner(
    app: &tauri::AppHandle,
    input: &TradeCreateListingInput,
    order_type: &str,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
    if !matches!(order_type, "sell" | "buy") {
        return Err(anyhow!("Unsupported order type."));
    }
    if input.price <= 0 || input.quantity <= 0 {
        return Err(anyhow!(
            "Price and quantity must both be greater than zero."
        ));
    }

    let mut payload = json!({
        "itemId": input.wfm_id,
        "type": order_type,
        "platinum": input.price,
        "quantity": input.quantity,
        "visible": input.visible,
    });
    if let Some(rank) = input.rank {
        payload["rank"] = json!(rank);
    }
    // Bulk-tradable items (e.g. arcanes) require `perTrade`; non-bulk items forbid it.
    let catalog = open_catalog_database(app)?;
    let bulk_tradable = catalog_item_is_bulk_tradable(&catalog, &input.wfm_id)?;
    if let Some(per_trade) = resolve_per_trade(bulk_tradable, input.per_trade, input.quantity)? {
        payload["perTrade"] = json!(per_trade);
    }
    // Subtyped items (relics, Atragraph-variant mods like Archon Vitality) are rejected by WFM
    // unless the order carries a `subtype`. Honour an explicit caller choice (validated against
    // the catalog so a stale UI value can't produce an opaque WFM 400), else the item default.
    let subtypes = catalog_item_subtypes(&catalog, &input.wfm_id)?;
    if let Some(first_subtype) = subtypes.first() {
        let requested = input
            .subtype
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let subtype = match requested {
            Some(value) => {
                if !subtypes.iter().any(|entry| entry == value) {
                    return Err(anyhow!("“{value}” isn't a valid variant for this item."));
                }
                value.to_string()
            }
            None => first_subtype.clone(),
        };
        payload["subtype"] = json!(subtype);
    }

    let result = execute_wfm_request_with_priority(
        send_wfm_request(
            &client,
            Method::POST,
            format!("{WFM_API_BASE_URL_V2}/order"),
            Some(&session.token),
        )
        .json(&payload),
        &format!("create {order_type} order"),
        RequestPriority::Instant,
    );
    if let Err(ref error) = result {
        if should_attempt_trade_session_reauth(error) {
            // Clear the stale cached token so the next call re-authenticates automatically.
            // Don't silently retry mutations — let the caller surface the error.
            log_feature_error_best_effort(
                app,
                "trades-session",
                "order-auth-error",
                "An order request hit an auth error (401) — clearing the cached session so the next call re-authenticates.",
                error,
            );
            clear_session_cache();
            if let Err(clear_error) = clear_session(app) {
                log_feature_error_best_effort(
                    app,
                    "trades-session",
                    "order-auth-error",
                    "Failed to clear the persisted session after an order auth error.",
                    &clear_error,
                );
            }
        } else {
            // The UI only ever shows the friendly summary, so persist the raw WFM response
            // (status + body, e.g. which payload field it objected to) for diagnosis.
            log_feature_error_best_effort(
                app,
                "trades-order",
                "create-order-failed",
                &format!(
                    "Warframe.Market refused a create-{order_type} order (item {}, payload {}).",
                    input.wfm_id, payload
                ),
                error,
            );
        }
    }
    result?;

    build_trade_overview_inner(app, seller_mode)
}

fn update_order_inner(
    app: &tauri::AppHandle,
    input: &TradeUpdateListingInput,
    order_type: &str,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
    if !matches!(order_type, "sell" | "buy") {
        return Err(anyhow!("Unsupported order type."));
    }
    if input.price <= 0 || input.quantity <= 0 {
        return Err(anyhow!(
            "Price and quantity must both be greater than zero."
        ));
    }

    let mut payload = json!({
        "platinum": input.price,
        "quantity": input.quantity,
        "visible": input.visible,
    });
    if let Some(rank) = input.rank {
        payload["rank"] = json!(rank);
    }
    // `perTrade` is allowed only for bulk-tradable items. We can only tell when the caller
    // passes the item id, so non-bulk / id-less updates simply omit it.
    let bulk_tradable = match input.wfm_id.as_deref() {
        Some(wfm_id) if !wfm_id.is_empty() => {
            catalog_item_is_bulk_tradable(&open_catalog_database(app)?, wfm_id)?
        }
        _ => false,
    };
    if let Some(per_trade) = resolve_per_trade(bulk_tradable, input.per_trade, input.quantity)? {
        payload["perTrade"] = json!(per_trade);
    }

    let result = execute_wfm_request_with_priority(
        send_wfm_request(
            &client,
            Method::PATCH,
            format!("{WFM_API_BASE_URL_V2}/order/{}", input.order_id),
            Some(&session.token),
        )
        .json(&payload),
        &format!("update {order_type} order"),
        RequestPriority::Instant,
    );
    if let Err(ref error) = result {
        if should_attempt_trade_session_reauth(error) {
            clear_session_cache();
            let _ = clear_session(app);
        } else {
            // Mirror create: keep the raw WFM response in the error log for diagnosis.
            log_feature_error_best_effort(
                app,
                "trades-order",
                "update-order-failed",
                &format!(
                    "Warframe.Market refused an update-{order_type} order (order {}, payload {}).",
                    input.order_id, payload
                ),
                error,
            );
        }
    }
    result?;

    build_trade_overview_inner(app, seller_mode)
}

/// Bulk-toggles the visibility of all the user's orders (the `all` virtual group), optionally
/// restricted to one order type. Backs the "hide/show all my listings" control.
fn set_orders_group_visibility_inner(
    app: &tauri::AppHandle,
    visible: bool,
    order_type: Option<&str>,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
    if let Some(order_type) = order_type {
        if !matches!(order_type, "sell" | "buy") {
            return Err(anyhow!("Unsupported order type."));
        }
    }

    let mut payload = json!({ "visible": visible });
    if let Some(order_type) = order_type {
        payload["type"] = json!(order_type);
    }

    let result = execute_wfm_request_with_priority(
        send_wfm_request(
            &client,
            Method::PATCH,
            format!("{WFM_API_BASE_URL_V2}/orders/group/all"),
            Some(&session.token),
        )
        .json(&payload),
        "update orders group visibility",
        RequestPriority::Instant,
    );
    if let Err(ref error) = result {
        if should_attempt_trade_session_reauth(error) {
            clear_session_cache();
            let _ = clear_session(app);
        }
    }
    result?;

    build_trade_overview_inner(app, seller_mode)
}

fn close_order_inner(
    app: &tauri::AppHandle,
    order_id: &str,
    quantity: i64,
    order_type: &str,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
    if !matches!(order_type, "sell" | "buy") {
        return Err(anyhow!("Unsupported order type."));
    }
    if quantity <= 0 {
        return Err(anyhow!("Quantity to close must be greater than zero."));
    }

    let result = execute_wfm_request_with_priority(
        send_wfm_request(
            &client,
            Method::POST,
            format!("{WFM_API_BASE_URL_V2}/order/{order_id}/close"),
            Some(&session.token),
        )
        .json(&json!({ "quantity": quantity })),
        &format!("close {order_type} order"),
        RequestPriority::Instant,
    );
    if let Err(ref error) = result {
        if should_attempt_trade_session_reauth(error) {
            clear_session_cache();
            let _ = clear_session(app);
        }
    }
    result?;

    build_trade_overview_inner(app, seller_mode)
}

fn delete_order_inner(
    app: &tauri::AppHandle,
    order_id: &str,
    order_type: &str,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
    if !matches!(order_type, "sell" | "buy") {
        return Err(anyhow!("Unsupported order type."));
    }

    let result = execute_wfm_request_with_priority(
        send_wfm_request(
            &client,
            Method::DELETE,
            format!("{WFM_API_BASE_URL_V2}/order/{order_id}"),
            Some(&session.token),
        ),
        &format!("delete {order_type} order"),
        RequestPriority::Instant,
    );
    if let Err(ref error) = result {
        if should_attempt_trade_session_reauth(error) {
            clear_session_cache();
            let _ = clear_session(app);
        }
    }
    result?;

    build_trade_overview_inner(app, seller_mode)
}

#[tauri::command]
pub async fn get_wfm_trade_session_state(
    app: tauri::AppHandle,
) -> Result<TradeSessionState, String> {
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || try_restore_trade_session_state(&app)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sign_in_wfm_trade_account(
    app: tauri::AppHandle,
    input: TradeSignInInput,
) -> Result<TradeSessionState, String> {
    let should_persist_credentials = input.stay_logged_in;
    let credentials = StoredTradeCredentials {
        warstonks_version: None,
        email: input.email.trim().to_string(),
        password: input.password.trim().to_string(),
        saved_at: format_timestamp(now_utc()).map_err(|error| error.to_string())?,
    };
    let session = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let input = input.clone();
        move || {
            let session = sign_in_inner(&app, &input)?;
            // Populate the in-memory cache FIRST so the session is usable this run even if
            // the keychain write fails (e.g. Windows Credential Manager rejecting a blob).
            set_session_in_cache(&session);
            // Keychain persistence is best-effort — a write failure must never abort a
            // successful sign-in. Persistence then falls back to credential re-auth.
            if let Err(error) = save_session(&app, &session) {
                log_feature_error_best_effort(
                    &app,
                    "trades-session",
                    "save-session-keychain",
                    "Signed in, but couldn't persist the session token to the OS keychain (it still works this run).",
                    &error,
                );
            }
            Ok::<StoredTradeSession, anyhow::Error>(session)
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| friendly_sign_in_error(&error))?;

    // A successful manual sign-in is the escape hatch: re-enable automatic sign-in and clear
    // any rate-limit cooldown so the app resumes normal session keeping.
    reset_auto_signin_state(&app);
    clear_signin_cooldown(&app);
    log_feature_event_best_effort(
        &app,
        "trades-session",
        "manual-signin",
        "Manual sign-in succeeded; automatic sign-in re-enabled and cooldown cleared.",
    );

    // Make sure the persistent websocket is running and signal that a session is now
    // available so it (re)connects and authenticates. The server-confirmed presence then
    // arrives via the manager's PRESENCE_CHANGED_EVENT — no transient status socket.
    start_ws_manager(app.clone());
    send_ws_command(WsCommand::SignedIn);

    if should_persist_credentials {
        let app_for_creds = app.clone();
        let credentials_to_save = credentials.clone();
        let creds_result = tauri::async_runtime::spawn_blocking(move || {
            save_trade_credentials(&app_for_creds, &credentials_to_save)
        })
        .await;
        if let Ok(Err(error)) = creds_result {
            // Best-effort: don't fail sign-in if credential persistence fails, but log it
            // since it means auto re-auth across restarts won't work.
            log_feature_error_best_effort(
                &app,
                "trades-session",
                "save-credentials-keychain",
                "Signed in, but couldn't persist credentials to the OS keychain — auto sign-in across restarts may not work.",
                &anyhow!("{error}"),
            );
        }
    }

    Ok(TradeSessionState {
        connected: true,
        account: Some(session.account),
    })
}

#[tauri::command]
pub async fn sign_out_wfm_trade_account(app: tauri::AppHandle) -> Result<(), String> {
    // Stop maintaining presence and clear the cached session synchronously so the keeper
    // releases its held connection promptly (the user goes offline on sign-out).
    set_desired_presence(None);
    save_persisted_desired_presence(&app, None);
    clear_session_cache();
    // Tell the persistent websocket to drop presence/auth promptly.
    send_ws_command(WsCommand::SignedOut);
    tauri::async_runtime::spawn_blocking(move || {
        clear_session_cache();
        clear_session(&app)?;
        clear_trade_credentials(&app)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn try_auto_sign_in_wfm_trade_account(
    app: tauri::AppHandle,
) -> Result<TradeSessionState, String> {
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            cleanup_legacy_trade_files(&app);
            try_restore_trade_session_state(&app)
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_wfm_trade_status(
    app: tauri::AppHandle,
    status: String,
) -> Result<TradeSessionState, String> {
    let desired = normalize_status_set_request(&status).map_err(|error| error.to_string())?;

    let mut session = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || ensure_authenticated_session(&app)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())?;

    // Record the desired presence (persisted, restored across restarts) and signal the
    // persistent websocket to apply it on the live connection — no transient socket.
    apply_desired_presence(&app, Some(desired));
    send_ws_command(WsCommand::SetStatus);

    // Optimistically reflect the requested status; the server-confirmed value arrives
    // shortly via the PRESENCE_CHANGED_EVENT the manager emits on `event/status/set`.
    session.account.status = desired.to_string();
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let session = session.clone();
        move || {
            set_session_in_cache(&session);
            save_session(&app, &session)
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())?;

    Ok(TradeSessionState {
        connected: true,
        account: Some(session.account),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistTargetInput {
    pub watchlist_id: String,
    pub slug: String,
    pub target_price: f64,
    #[serde(default)]
    pub rank: Option<i64>,
}

/// Syncs the frontend watchlist to the backend so the realtime newOrders feed can match
/// against it. Resolves each slug to its Warframe.Market item id (the key carried on order
/// events), replaces the tracked set, and signals the websocket to (un)subscribe as needed.
#[tauri::command]
pub async fn set_watchlist_targets(
    app: tauri::AppHandle,
    targets: Vec<WatchlistTargetInput>,
    seller_mode: String,
) -> Result<(), String> {
    let resolved = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || -> Result<std::collections::HashMap<String, WatchlistTarget>> {
            let connection = open_catalog_database(&app)?;
            let mut map = std::collections::HashMap::new();
            for target in targets {
                // Resolve slug -> WFM item id; skip items the catalog doesn't know.
                let wfm_id: Option<String> = connection
                    .query_row(
                        "SELECT wfm_id FROM wfm_items WHERE slug = ?1 LIMIT 1",
                        params![target.slug],
                        |row| row.get(0),
                    )
                    .optional()
                    .context("failed to resolve watchlist slug")?;
                if let Some(wfm_id) = wfm_id {
                    map.insert(
                        wfm_id,
                        WatchlistTarget {
                            watchlist_id: target.watchlist_id,
                            slug: target.slug,
                            target_price: target.target_price,
                            rank: target.rank,
                        },
                    );
                }
            }
            Ok(map)
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())?;

    if let Ok(mut guard) = watchlist_targets().lock() {
        *guard = resolved;
    }
    if let Ok(mut guard) = watchlist_seller_mode().lock() {
        *guard = seller_mode;
    }

    // Make sure the websocket is running, then have it (un)subscribe to match the new set.
    start_ws_manager(app.clone());
    send_ws_command(WsCommand::RefreshSubscription);
    Ok(())
}

#[tauri::command]
pub async fn get_wfm_trade_overview(
    app: tauri::AppHandle,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_trade_overview_inner(&app, seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_cached_wfm_profile_trade_log(
    app: tauri::AppHandle,
    username: String,
) -> Result<PortfolioTradeLogState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_cached_trade_log_state_for_app(&app, username.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_wfm_profile_trade_log(
    app: tauri::AppHandle,
    username: String,
) -> Result<PortfolioTradeLogState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_trade_log_state_for_app(&app, username.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn refresh_wfm_trade_detection(
    app: tauri::AppHandle,
    username: String,
    input: TradeDetectionRefreshInput,
) -> Result<TradeDetectionRefreshResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_wfm_trade_detection_inner(&app, username.trim(), &input)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn refresh_alecaframe_trade_detection(
    app: tauri::AppHandle,
    username: String,
    input: TradeDetectionRefreshInput,
) -> Result<TradeDetectionRefreshResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_alecaframe_trade_detection_inner(&app, username.trim(), &input)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_portfolio_pnl_summary(
    app: tauri::AppHandle,
    username: String,
    period: String,
) -> Result<PortfolioPnlSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_portfolio_pnl_summary_inner(&app, username.trim(), period.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

/// Values the owned Set Completion inventory. Separate from the P&L summary because the
/// per-part valuation is slower — the UI loads it independently so the rest of the page
/// isn't blocked.
#[tauri::command]
pub async fn get_portfolio_inventory_value(
    app: tauri::AppHandle,
) -> Result<crate::market_observatory::SetCompletionInventoryValue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::market_observatory::compute_set_completion_inventory_value(&app)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

/// The signed-in user's currently-held positions (open + kept buys) with cost basis and current
/// estimated value. Cache/DB-only (no WFM calls); empty when not signed in. Used by the
/// opportunities engine's sell-inventory detector.
pub(crate) fn load_portfolio_holdings(
    app: &tauri::AppHandle,
) -> Result<Vec<PortfolioInventoryRow>> {
    let Some(session) = get_session_from_cache() else {
        return Ok(Vec::new());
    };
    let summary = build_portfolio_pnl_summary_inner(app, &session.account.name, "all")?;
    Ok(summary.inventory_rows)
}

/// Per-owned-item recommended exit prices (cache-only) for the Inventory panel.
#[tauri::command]
pub async fn get_set_completion_owned_item_prices(
    app: tauri::AppHandle,
) -> Result<Vec<crate::market_observatory::SetCompletionOwnedItemValue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::market_observatory::compute_set_completion_owned_item_prices(&app)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_wfm_trade_log_keep_item(
    app: tauri::AppHandle,
    username: String,
    order_id: String,
    keep_item: bool,
) -> Result<PortfolioTradeLogState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_trade_log_keep_item_inner(&app, username.trim(), order_id.trim(), keep_item)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn migrate_alecaframe_trade_log(
    app: tauri::AppHandle,
    username: String,
    input: AlecaframeTradeMigrationInput,
) -> Result<PortfolioTradeLogState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        migrate_alecaframe_trade_log_inner(&app, username.trim(), &input)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn update_trade_group_allocations(
    app: tauri::AppHandle,
    username: String,
    group_id: String,
    allocations: Vec<TradeGroupAllocationInput>,
) -> Result<PortfolioTradeLogState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_trade_group_allocations_inner(&app, username.trim(), group_id.trim(), &allocations)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn force_wfm_trade_log_resync(
    app: tauri::AppHandle,
    username: String,
) -> Result<PortfolioTradeLogState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        force_trade_log_resync_inner(&app, username.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ensure_trade_set_map(
    app: tauri::AppHandle,
    api_version: Option<String>,
) -> Result<TradeSetMapSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_trade_set_map_inner(&app, api_version.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

/// Subtypes for an item (catalog order, index 0 = WFM default), so the listing modal can offer
/// a variant picker for subtyped items (Atragraph mods, relics, fish…). Empty = no subtypes.
#[tauri::command]
pub async fn get_wfm_item_subtypes(
    app: tauri::AppHandle,
    wfm_id: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let catalog = open_catalog_database(&app)?;
        catalog_item_subtypes(&catalog, &wfm_id)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_wfm_sell_order(
    app: tauri::AppHandle,
    input: TradeCreateListingInput,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_order_inner(&app, &input, "sell", seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[tauri::command]
pub async fn create_wfm_buy_order(
    app: tauri::AppHandle,
    input: TradeCreateListingInput,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_order_inner(&app, &input, "buy", seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[tauri::command]
pub async fn set_wfm_orders_visibility(
    app: tauri::AppHandle,
    visible: bool,
    order_type: Option<String>,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_orders_group_visibility_inner(&app, visible, order_type.as_deref(), seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[tauri::command]
pub async fn update_wfm_sell_order(
    app: tauri::AppHandle,
    input: TradeUpdateListingInput,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_order_inner(&app, &input, "sell", seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[tauri::command]
pub async fn update_wfm_buy_order(
    app: tauri::AppHandle,
    input: TradeUpdateListingInput,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_order_inner(&app, &input, "buy", seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[tauri::command]
pub async fn close_wfm_sell_order(
    app: tauri::AppHandle,
    order_id: String,
    quantity: i64,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        close_order_inner(&app, order_id.trim(), quantity, "sell", seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[tauri::command]
pub async fn close_wfm_buy_order(
    app: tauri::AppHandle,
    order_id: String,
    quantity: i64,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        close_order_inner(&app, order_id.trim(), quantity, "buy", seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[tauri::command]
pub async fn delete_wfm_sell_order(
    app: tauri::AppHandle,
    order_id: String,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        delete_order_inner(&app, order_id.trim(), "sell", seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[tauri::command]
pub async fn delete_wfm_buy_order(
    app: tauri::AppHandle,
    order_id: String,
    seller_mode: String,
) -> Result<TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        delete_order_inner(&app, order_id.trim(), "buy", seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| friendly_order_error(&error))
}

#[cfg(test)]
mod tests {
    use super::{
        append_unique_trade_entries, build_cost_basis_confidence,
        build_trade_log_entries_from_statistics, build_trade_notification_fingerprint,
        build_trade_owned_sync_key, collapse_grouped_trade_sets, compute_cost_basis_coverage,
        compute_current_value_coverage, decide_trade_health,
        derive_trade_log_entries_with_components, initialize_trades_cache_schema,
        load_stored_trade_log_records_inner, load_trade_log_last_updated_at,
        map_trade_set_components_from_file, merge_wfm_trade_log_entries,
        normalize_alecaframe_trade_payload, normalize_avatar_url, normalize_status_set_request,
        parse_status_from_payload, prune_stale_trade_log_overrides_inner, resolve_per_trade,
        replace_trade_log_rows_inner, save_trade_log_rows_inner,
        should_attempt_trade_session_reauth, trade_record_is_before_cutoff,
        underpriced_trigger_ratio, UNDERPRICED_TRIGGER_BASE_RATIO,
        AlecaframeRawTradeRecord, AlecaframeTradeItemRecord, AlecaframeTradeResponse,
        PortfolioTradeLogEntry, StoredTradeLogRecord, TradeSetComponentRecord,
        TradeSetMapComponentRecord, TradeSetMapFile, TradeSetMapSetRecord, TradeSetRootRecord,
        WfmProfileClosedOrder, WfmProfileClosedOrderItem, WfmProfileClosedOrderItemName,
        WfmProfileStatisticsPayload,
    };
    use crate::market_observatory::CachedTradeHealthContext;
    use crate::settings::DiscordTradeNotificationItem;
    use anyhow::anyhow;
    use rusqlite::params;
    use rusqlite::Connection;
    use serde_json::json;
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;

    #[test]
    fn underpriced_trigger_scales_discount_with_price() {
        // The trigger price (rec * ratio) should match the price-weighted curve: cheap items need
        // a deep discount, expensive items fire on a shallow one.
        let trigger_price = |rec: f64| rec * underpriced_trigger_ratio(rec);

        // Cheap items: only a steep discount qualifies.
        assert!(trigger_price(5.0) < 2.5, "5p should fire only near 1-2p");
        assert!(trigger_price(10.0) < 7.0, "10p should fire only near 5-6p");

        // A 20p item listed at 15p must qualify (user's explicit floor).
        assert!(15.0 < trigger_price(20.0), "20p item at 15p should trigger");
        // A 50p item listed at 40p must qualify.
        assert!(40.0 < trigger_price(50.0), "50p item at 40p should trigger");

        // The required discount eases as price rises (ratio is monotonic increasing).
        assert!(underpriced_trigger_ratio(10.0) < underpriced_trigger_ratio(50.0));
        // Even very expensive items keep a floor discount (never fire just below rec).
        assert!(underpriced_trigger_ratio(1000.0) <= UNDERPRICED_TRIGGER_BASE_RATIO);

        // Non-positive / non-finite recommended prices never trigger.
        assert_eq!(underpriced_trigger_ratio(0.0), 0.0);
        assert_eq!(underpriced_trigger_ratio(-5.0), 0.0);
        assert_eq!(underpriced_trigger_ratio(f64::NAN), 0.0);
    }

    #[test]
    fn normalizes_relative_avatar_path_to_static_assets_host() {
        let normalized = normalize_avatar_url(Some(
            "user/avatar/663d477c0f86de000ab5026a.png?abc123".to_string(),
        ));

        assert_eq!(
            normalized.as_deref(),
            Some(
                "https://warframe.market/static/assets/user/avatar/663d477c0f86de000ab5026a.png?abc123"
            )
        );
    }

    #[test]
    fn parses_presence_status_from_websocket_payload() {
        assert_eq!(
            parse_status_from_payload(&json!({ "status": "in_game" })).as_deref(),
            Some("ingame")
        );
        assert_eq!(
            parse_status_from_payload(&json!({ "status": "online" })).as_deref(),
            Some("online")
        );
        assert_eq!(
            parse_status_from_payload(&json!({ "status": "invisible" })).as_deref(),
            Some("offline")
        );
    }

    #[test]
    fn normalizes_presence_write_request_values() {
        assert_eq!(normalize_status_set_request("ingame").ok(), Some("ingame"));
        assert_eq!(normalize_status_set_request("in_game").ok(), Some("ingame"));
        assert_eq!(normalize_status_set_request("online").ok(), Some("online"));
        assert_eq!(
            normalize_status_set_request("invisible").ok(),
            Some("invisible")
        );
    }

    #[test]
    fn locks_trade_records_older_than_cutoff() {
        let cutoff = OffsetDateTime::parse("2026-03-01T00:00:00Z", &Rfc3339).expect("cutoff");
        let old_record = StoredTradeLogRecord {
            id: "old-1".to_string(),
            item_name: "Old Item".to_string(),
            slug: "old_item".to_string(),
            image_path: None,
            order_type: "sell".to_string(),
            source: "wfm".to_string(),
            platinum: 50,
            quantity: 1,
            rank: None,
            closed_at: "2026-02-01T00:00:00Z".to_string(),
            updated_at: "2026-02-01T00:00:00Z".to_string(),
            keep_item: false,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: None,
            group_sort_order: None,
        };
        let recent_record = StoredTradeLogRecord {
            closed_at: "2026-03-05T00:00:00Z".to_string(),
            updated_at: "2026-03-05T00:00:00Z".to_string(),
            ..old_record.clone()
        };

        assert!(trade_record_is_before_cutoff(&old_record, cutoff));
        assert!(!trade_record_is_before_cutoff(&recent_record, cutoff));
    }

    #[test]
    fn normalizes_and_sorts_trade_log_entries() {
        let entries = build_trade_log_entries_from_statistics(WfmProfileStatisticsPayload {
            closed_orders: vec![
                WfmProfileClosedOrder {
                    id: "ignore".to_string(),
                    item: WfmProfileClosedOrderItem {
                        url_name: "ignored_item".to_string(),
                        thumb: None,
                        icon: None,
                        en: WfmProfileClosedOrderItemName {
                            item_name: "Ignored Item".to_string(),
                        },
                    },
                    updated_at: "2026-03-10T10:00:00.000+00:00".to_string(),
                    quantity: 1,
                    closed_date: "2026-03-10T10:00:00.000+00:00".to_string(),
                    order_type: "other".to_string(),
                    platinum: 5,
                    mod_rank: None,
                },
                WfmProfileClosedOrder {
                    id: "buy-1".to_string(),
                    item: WfmProfileClosedOrderItem {
                        url_name: "test_item".to_string(),
                        thumb: Some("items/images/en/thumbs/test.png".to_string()),
                        icon: None,
                        en: WfmProfileClosedOrderItemName {
                            item_name: "Test Item".to_string(),
                        },
                    },
                    updated_at: "2026-03-10T10:00:00.000+00:00".to_string(),
                    quantity: 1,
                    closed_date: "2026-03-10T10:00:00.000+00:00".to_string(),
                    order_type: "buy".to_string(),
                    platinum: 15,
                    mod_rank: Some(2),
                },
                WfmProfileClosedOrder {
                    id: "sell-1".to_string(),
                    item: WfmProfileClosedOrderItem {
                        url_name: "test_item".to_string(),
                        thumb: None,
                        icon: Some("items/images/en/test.png".to_string()),
                        en: WfmProfileClosedOrderItemName {
                            item_name: "Test Item".to_string(),
                        },
                    },
                    updated_at: "2026-03-09T10:00:00.000+00:00".to_string(),
                    quantity: 2,
                    closed_date: "2026-03-09T10:00:00.000+00:00".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 25,
                    mod_rank: None,
                },
            ],
        });

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "buy-1");
        assert_eq!(entries[0].order_type, "buy");
        assert_eq!(entries[0].rank, Some(2));
        assert_eq!(entries[1].id, "sell-1");
        assert_eq!(
            entries[1].image_path.as_deref(),
            Some("items/images/en/test.png")
        );
    }

    #[test]
    fn normalizes_raw_alecaframe_trade_payload() {
        let trades = normalize_alecaframe_trade_payload(AlecaframeTradeResponse {
            buy_trades: Vec::new(),
            sell_trades: Vec::new(),
            trades: vec![
                AlecaframeRawTradeRecord {
                    timestamp: "2026-03-07T12:12:25.5764897Z".to_string(),
                    trade_type: 0,
                    total_plat: Some(69),
                    items_sent: vec![AlecaframeTradeItemRecord {
                        name: "/Lotus/Types/Recipes/WarframeRecipes/WispPrimeBlueprint".to_string(),
                        display_name: None,
                        cnt: 1,
                        rank: -1,
                    }],
                    items_received: vec![AlecaframeTradeItemRecord {
                        name: "/AF_Special/Platinum".to_string(),
                        display_name: None,
                        cnt: 69,
                        rank: -1,
                    }],
                },
                AlecaframeRawTradeRecord {
                    timestamp: "2026-03-06T03:54:00.8900411Z".to_string(),
                    trade_type: 1,
                    total_plat: None,
                    items_sent: vec![AlecaframeTradeItemRecord {
                        name: "/AF_Special/Platinum".to_string(),
                        display_name: None,
                        cnt: 34,
                        rank: -1,
                    }],
                    items_received: vec![AlecaframeTradeItemRecord {
                        name: "/Lotus/Types/Recipes/WarframeRecipes/NovaPrimeChassisComponent"
                            .to_string(),
                        display_name: None,
                        cnt: 1,
                        rank: -1,
                    }],
                },
            ],
        });

        assert_eq!(trades.len(), 2);
        assert_eq!(trades[0].direction, "buy");
        assert_eq!(trades[1].direction, "sell");
        assert_eq!(trades[1].total_plat, Some(69));
    }

    #[test]
    fn resolve_per_trade_omits_field_for_non_bulk_items() {
        // Non-bulk items must never send perTrade (WFM forbids it), even if a value sneaks in.
        assert_eq!(resolve_per_trade(false, None, 10).unwrap(), None);
        assert_eq!(resolve_per_trade(false, Some(3), 9).unwrap(), None);
    }

    #[test]
    fn resolve_per_trade_defaults_bulk_items_to_one() {
        // Bulk items with no explicit batch size default to 1, which always divides quantity.
        assert_eq!(resolve_per_trade(true, None, 7).unwrap(), Some(1));
    }

    #[test]
    fn resolve_per_trade_accepts_valid_divisor_in_range() {
        assert_eq!(resolve_per_trade(true, Some(3), 12).unwrap(), Some(3));
        assert_eq!(resolve_per_trade(true, Some(6), 6).unwrap(), Some(6));
    }

    #[test]
    fn resolve_per_trade_rejects_out_of_range_or_non_divisor() {
        assert!(resolve_per_trade(true, Some(0), 10).is_err());
        assert!(resolve_per_trade(true, Some(7), 14).is_err());
        assert!(resolve_per_trade(true, Some(3), 10).is_err());
    }

    #[test]
    fn extract_wfm_status_code_reads_the_status() {
        assert_eq!(
            super::extract_wfm_status_code("create sell order failed with status 400: {\"x\":1}"),
            Some(400)
        );
        assert_eq!(
            super::extract_wfm_status_code("load own orders failed with status 503"),
            Some(503)
        );
        assert_eq!(super::extract_wfm_status_code("error sending request"), None);
    }

    #[test]
    fn friendly_order_error_hides_raw_wfm_status_bodies() {
        let raw = anyhow!("create sell order failed with status 400: {{\"error\":{{\"perTrade\":\"required\"}}}}");
        let friendly = super::friendly_order_error(&raw);
        assert!(!friendly.contains("status 400"));
        assert!(!friendly.contains("perTrade"));
        assert!(friendly.to_lowercase().contains("rejected"));

        // 401 maps to a session-expiry message that keeps the phrase the UI matches on.
        let unauthorized = anyhow!("create sell order failed with status 401");
        assert!(super::friendly_order_error(&unauthorized)
            .to_lowercase()
            .contains("session expired"));

        // Our own validation messages (no HTTP status) pass through unchanged.
        let validation = anyhow!("Per-trade quantity must be between 1 and 6 for bulk-tradable items.");
        assert_eq!(
            super::friendly_order_error(&validation),
            "Per-trade quantity must be between 1 and 6 for bulk-tradable items."
        );
    }

    #[test]
    fn lenient_i64_rejects_non_finite_and_out_of_range() {
        #[derive(serde::Deserialize)]
        struct Probe {
            #[serde(deserialize_with = "super::deserialize_lenient_i64")]
            value: i64,
        }
        assert_eq!(
            serde_json::from_str::<Probe>("{\"value\": 30.0}").unwrap().value,
            30
        );
        // A huge float (valid JSON) would saturate to garbage under `as i64`; reject instead.
        assert!(serde_json::from_str::<Probe>("{\"value\": 1e30}").is_err());
    }

    #[test]
    fn persists_trade_log_cache_state() {
        let mut connection = Connection::open_in_memory().expect("in-memory trades cache");
        initialize_trades_cache_schema(&connection).expect("schema");

        let entries = vec![
            PortfolioTradeLogEntry {
                id: "sell-1".to_string(),
                item_name: "Test Item".to_string(),
                slug: "test_item".to_string(),
                image_path: Some("items/images/en/test.png".to_string()),
                order_type: "sell".to_string(),
                source: "wfm".to_string(),
                platinum: 25,
                quantity: 2,
                rank: None,
                closed_at: "2026-03-09T10:00:00.000+00:00".to_string(),
                updated_at: "2026-03-09T10:00:00.000+00:00".to_string(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
                allocation_mode: None,
                cost_basis_confidence: None,
                cost_basis_label: None,
                matched_cost: None,
                matched_quantity: None,
                matched_buy_count: 0,
                matched_buy_rows: Vec::new(),
                set_component_rows: Vec::new(),
                profit_formula: None,
                duplicate_risk: false,
            },
            PortfolioTradeLogEntry {
                id: "buy-1".to_string(),
                item_name: "Test Item".to_string(),
                slug: "test_item".to_string(),
                image_path: Some("items/images/en/test.png".to_string()),
                order_type: "buy".to_string(),
                source: "wfm".to_string(),
                platinum: 15,
                quantity: 1,
                rank: Some(2),
                closed_at: "2026-03-10T10:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T10:00:00.000+00:00".to_string(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
                allocation_mode: None,
                cost_basis_confidence: None,
                cost_basis_label: None,
                matched_cost: None,
                matched_quantity: None,
                matched_buy_count: 0,
                matched_buy_rows: Vec::new(),
                set_component_rows: Vec::new(),
                profit_formula: None,
                duplicate_risk: false,
            },
        ];

        let saved_updated_at = save_trade_log_rows_inner(&mut connection, "qtpyth", &entries)
            .expect("save cached trade log");
        let loaded_records = load_stored_trade_log_records_inner(&connection, "qtpyth")
            .expect("load cached trade log");
        let loaded_updated_at =
            load_trade_log_last_updated_at(&connection, "qtpyth").expect("load cached metadata");

        assert_eq!(loaded_records.len(), 2);
        assert_eq!(loaded_records[0].id, "sell-1");
        assert_eq!(loaded_records[1].id, "buy-1");
        assert_eq!(loaded_updated_at, Some(saved_updated_at));
    }

    #[test]
    fn marks_component_buys_as_sold_as_set_when_set_sells_later() {
        let records = vec![
            StoredTradeLogRecord {
                id: "buy-chassis".to_string(),
                item_name: "Wisp Prime Chassis".to_string(),
                slug: "wisp_prime_chassis".to_string(),
                image_path: None,
                order_type: "buy".to_string(),
                source: "wfm".to_string(),
                platinum: 20,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T08:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T08:00:00.000+00:00".to_string(),
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
            },
            StoredTradeLogRecord {
                id: "buy-neuro".to_string(),
                item_name: "Wisp Prime Neuroptics".to_string(),
                slug: "wisp_prime_neuroptics".to_string(),
                image_path: None,
                order_type: "buy".to_string(),
                source: "wfm".to_string(),
                platinum: 18,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T08:05:00.000+00:00".to_string(),
                updated_at: "2026-03-10T08:05:00.000+00:00".to_string(),
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
            },
            StoredTradeLogRecord {
                id: "buy-systems".to_string(),
                item_name: "Wisp Prime Systems".to_string(),
                slug: "wisp_prime_systems".to_string(),
                image_path: None,
                order_type: "buy".to_string(),
                source: "wfm".to_string(),
                platinum: 22,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T08:10:00.000+00:00".to_string(),
                updated_at: "2026-03-10T08:10:00.000+00:00".to_string(),
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
            },
            StoredTradeLogRecord {
                id: "sell-set".to_string(),
                item_name: "Wisp Prime Set".to_string(),
                slug: "wisp_prime_set".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                source: "wfm".to_string(),
                platinum: 95,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
            },
        ];

        let derived = derive_trade_log_entries_with_components(&records, |slug| {
            if slug == "wisp_prime_set" {
                vec![
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_chassis".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_neuroptics".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_systems".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                ]
            } else {
                Vec::new()
            }
        });

        let sell_entry = derived
            .iter()
            .find(|entry| entry.id == "sell-set")
            .expect("sell entry");
        assert_eq!(sell_entry.profit, Some(35));
        assert!((sell_entry.margin.unwrap_or_default() - 36.8421052631579).abs() < 1e-9);

        for buy_id in ["buy-chassis", "buy-neuro", "buy-systems"] {
            let buy_entry = derived
                .iter()
                .find(|entry| entry.id == buy_id)
                .expect("buy entry");
            assert_eq!(buy_entry.status.as_deref(), Some("Sold As Set"));
        }
    }

    #[test]
    fn collapses_grouped_component_rows_into_exact_set_row() {
        let records = vec![
            StoredTradeLogRecord {
                id: "child-1".to_string(),
                item_name: "Wisp Prime Chassis Blueprint".to_string(),
                slug: "wisp_prime_chassis_blueprint".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                source: "alecaframe".to_string(),
                platinum: 23,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                keep_item: false,
                group_id: Some("group-1".to_string()),
                group_label: Some("Multiple Item Trade".to_string()),
                group_total_platinum: Some(68),
                group_item_count: Some(4),
                allocation_total_platinum: Some(23),
                group_sort_order: Some(0),
            },
            StoredTradeLogRecord {
                id: "child-2".to_string(),
                item_name: "Wisp Prime Neuroptics Blueprint".to_string(),
                slug: "wisp_prime_neuroptics_blueprint".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                source: "alecaframe".to_string(),
                platinum: 15,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                keep_item: false,
                group_id: Some("group-1".to_string()),
                group_label: Some("Multiple Item Trade".to_string()),
                group_total_platinum: Some(68),
                group_item_count: Some(4),
                allocation_total_platinum: Some(15),
                group_sort_order: Some(1),
            },
            StoredTradeLogRecord {
                id: "child-3".to_string(),
                item_name: "Wisp Prime Systems Blueprint".to_string(),
                slug: "wisp_prime_systems_blueprint".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                source: "alecaframe".to_string(),
                platinum: 15,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                keep_item: false,
                group_id: Some("group-1".to_string()),
                group_label: Some("Multiple Item Trade".to_string()),
                group_total_platinum: Some(68),
                group_item_count: Some(4),
                allocation_total_platinum: Some(15),
                group_sort_order: Some(2),
            },
            StoredTradeLogRecord {
                id: "child-4".to_string(),
                item_name: "Wisp Prime Blueprint".to_string(),
                slug: "wisp_prime_blueprint".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                source: "alecaframe".to_string(),
                platinum: 15,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                keep_item: true,
                group_id: Some("group-1".to_string()),
                group_label: Some("Multiple Item Trade".to_string()),
                group_total_platinum: Some(68),
                group_item_count: Some(4),
                allocation_total_platinum: Some(15),
                group_sort_order: Some(3),
            },
        ];

        let (collapsed, changed) = collapse_grouped_trade_sets(
            &records,
            &[(
                TradeSetRootRecord {
                    slug: "wisp_prime_set".to_string(),
                    name: "Wisp Prime Set".to_string(),
                    image_path: None,
                },
                vec![
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_blueprint".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_chassis_blueprint".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_neuroptics_blueprint".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_systems_blueprint".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                ],
            )],
        );

        assert!(changed);
        assert_eq!(collapsed.len(), 1);
        assert_eq!(collapsed[0].slug, "wisp_prime_set");
        assert_eq!(collapsed[0].item_name, "Wisp Prime Set");
        assert_eq!(collapsed[0].quantity, 1);
        assert_eq!(collapsed[0].allocation_total_platinum, Some(68));
        assert!(collapsed[0].group_id.is_none());
        assert!(collapsed[0].keep_item);
    }

    #[test]
    fn computes_margin_for_partial_sold_as_set_cost_basis() {
        let records = vec![
            StoredTradeLogRecord {
                id: "buy-chassis".to_string(),
                item_name: "Wisp Prime Chassis".to_string(),
                slug: "wisp_prime_chassis".to_string(),
                image_path: None,
                order_type: "buy".to_string(),
                source: "wfm".to_string(),
                platinum: 25,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T08:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T08:00:00.000+00:00".to_string(),
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
            },
            StoredTradeLogRecord {
                id: "sell-set".to_string(),
                item_name: "Wisp Prime Set".to_string(),
                slug: "wisp_prime_set".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                source: "wfm".to_string(),
                platinum: 100,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
            },
        ];

        let derived = derive_trade_log_entries_with_components(&records, |slug| {
            if slug == "wisp_prime_set" {
                vec![
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_chassis".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                    TradeSetComponentRecord {
                        component_slug: "wisp_prime_systems".to_string(),
                        quantity_in_set: 1,
                        fetched_at: "2026-03-10T07:00:00.000+00:00".to_string(),
                    },
                ]
            } else {
                Vec::new()
            }
        });

        let sell_entry = derived
            .iter()
            .find(|entry| entry.id == "sell-set")
            .expect("sell entry");
        assert_eq!(sell_entry.profit, Some(75));
        assert_eq!(sell_entry.margin, Some(75.0));

        let buy_entry = derived
            .iter()
            .find(|entry| entry.id == "buy-chassis")
            .expect("buy entry");
        assert_eq!(buy_entry.status.as_deref(), Some("Sold As Set"));
    }

    #[test]
    fn computes_portfolio_coverage_with_partial_credit() {
        let cost_basis_coverage = compute_cost_basis_coverage(100, 40, 20);
        let current_value_coverage = compute_current_value_coverage(80, 20);

        assert!((cost_basis_coverage - 50.0).abs() < f64::EPSILON);
        assert!((current_value_coverage - 25.0).abs() < f64::EPSILON);
        assert_eq!(compute_cost_basis_coverage(0, 0, 0), 100.0);
        assert_eq!(compute_current_value_coverage(0, 0), 100.0);
    }

    #[test]
    fn classifies_sell_cost_basis_confidence_correctly() {
        assert_eq!(
            build_cost_basis_confidence("sell", 1, 0, 0),
            (Some("none".to_string()), Some("No Cost Basis".to_string()))
        );
        assert_eq!(
            build_cost_basis_confidence("sell", 2, 1, 25),
            (
                Some("partial".to_string()),
                Some("Partial Cost Basis".to_string())
            )
        );
        assert_eq!(
            build_cost_basis_confidence("sell", 2, 2, 50),
            (
                Some("full".to_string()),
                Some("Full Cost Basis".to_string())
            )
        );
        assert_eq!(build_cost_basis_confidence("buy", 1, 1, 10), (None, None));
    }

    #[test]
    fn trade_notification_fingerprint_is_source_agnostic() {
        let fingerprint = build_trade_notification_fingerprint(
            "sell",
            68,
            "2026-03-10T09:00:45Z",
            &[DiscordTradeNotificationItem {
                item_name: "Wisp Prime Set".to_string(),
                quantity: 1,
                rank: None,
                image_path: None,
            }],
        );
        let same_trade_fingerprint = build_trade_notification_fingerprint(
            "sell",
            68,
            "2026-03-10T09:00:10Z",
            &[DiscordTradeNotificationItem {
                item_name: "wisp prime set".to_string(),
                quantity: 1,
                rank: None,
                image_path: None,
            }],
        );

        assert_eq!(fingerprint, same_trade_fingerprint);
    }

    #[test]
    fn map_trade_set_components_from_file_returns_components() {
        let set_map = TradeSetMapFile {
            warstonks_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            api_version: Some("0.0.0".to_string()),
            generated_at: "2026-03-10T09:00:00Z".to_string(),
            sets: vec![TradeSetMapSetRecord {
                slug: "wisp_prime_set".to_string(),
                name: "Wisp Prime Set".to_string(),
                image_path: None,
                components: vec![
                    TradeSetMapComponentRecord {
                        slug: "wisp_prime_blueprint".to_string(),
                        quantity_in_set: 1,
                    },
                    TradeSetMapComponentRecord {
                        slug: "wisp_prime_chassis".to_string(),
                        quantity_in_set: 2,
                    },
                ],
            }],
        };

        let components = map_trade_set_components_from_file(&set_map, "wisp_prime_set");
        assert_eq!(components.len(), 2);
        assert_eq!(components[0].component_slug, "wisp_prime_blueprint");
        assert_eq!(components[0].quantity_in_set, 1);
        assert_eq!(components[1].component_slug, "wisp_prime_chassis");
        assert_eq!(components[1].quantity_in_set, 2);
        assert_eq!(components[0].fetched_at, "2026-03-10T09:00:00Z");
    }

    #[test]
    fn owned_component_sync_key_is_source_agnostic() {
        let base_record = StoredTradeLogRecord {
            id: "wfm-trade-1".to_string(),
            item_name: "Wisp Prime Set".to_string(),
            slug: "wisp_prime_set".to_string(),
            image_path: None,
            order_type: "sell".to_string(),
            source: "wfm".to_string(),
            platinum: 68,
            quantity: 1,
            rank: None,
            closed_at: "2026-03-10T09:00:10Z".to_string(),
            updated_at: "2026-03-10T09:00:10Z".to_string(),
            keep_item: false,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: None,
            group_sort_order: None,
        };

        let mut other_record = base_record.clone();
        other_record.id = "af-trade-1".to_string();
        other_record.source = "alecaframe".to_string();
        other_record.closed_at = "2026-03-10T09:00:40Z".to_string();
        other_record.updated_at = "2026-03-10T09:00:40Z".to_string();

        let left = build_trade_owned_sync_key(&base_record);
        let right = build_trade_owned_sync_key(&other_record);

        assert_eq!(left, right);
    }

    #[test]
    fn force_resync_retains_keep_overrides() {
        let mut connection = Connection::open_in_memory().expect("in-memory trades cache");
        initialize_trades_cache_schema(&connection).expect("schema");

        let username = "qtpyth";
        let initial_entries = vec![PortfolioTradeLogEntry {
            id: "trade-1".to_string(),
            item_name: "Wisp Prime Chassis Blueprint".to_string(),
            slug: "wisp_prime_chassis_blueprint".to_string(),
            image_path: None,
            order_type: "buy".to_string(),
            source: "wfm".to_string(),
            platinum: 20,
            quantity: 1,
            rank: None,
            closed_at: "2026-03-10T09:00:00Z".to_string(),
            updated_at: "2026-03-10T09:00:00Z".to_string(),
            profit: None,
            margin: None,
            status: None,
            keep_item: false,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: None,
            group_sort_order: None,
            allocation_mode: None,
            cost_basis_confidence: None,
            cost_basis_label: None,
            matched_cost: None,
            matched_quantity: None,
            matched_buy_count: 0,
            matched_buy_rows: Vec::new(),
            set_component_rows: Vec::new(),
            profit_formula: None,
            duplicate_risk: false,
        }];

        save_trade_log_rows_inner(&mut connection, username, &initial_entries)
            .expect("save initial trade log");
        connection
            .execute(
                "
                INSERT INTO portfolio_trade_log_overrides (username, order_id, keep_item)
                VALUES (?1, ?2, ?3)
                ",
                params![username, "trade-1", 1],
            )
            .expect("seed keep override");
        connection
            .execute(
                "
                INSERT INTO portfolio_trade_log_overrides (username, order_id, keep_item)
                VALUES (?1, ?2, ?3)
                ",
                params![username, "trade-2", 1],
            )
            .expect("seed stale override");

        let refreshed_entries = vec![
            PortfolioTradeLogEntry {
                id: "trade-1".to_string(),
                item_name: "Wisp Prime Chassis Blueprint".to_string(),
                slug: "wisp_prime_chassis_blueprint".to_string(),
                image_path: None,
                order_type: "buy".to_string(),
                source: "wfm".to_string(),
                platinum: 20,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:00Z".to_string(),
                updated_at: "2026-03-10T09:00:00Z".to_string(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
                allocation_mode: None,
                cost_basis_confidence: None,
                cost_basis_label: None,
                matched_cost: None,
                matched_quantity: None,
                matched_buy_count: 0,
                matched_buy_rows: Vec::new(),
                set_component_rows: Vec::new(),
                profit_formula: None,
                duplicate_risk: false,
            },
            PortfolioTradeLogEntry {
                id: "trade-3".to_string(),
                item_name: "Wisp Prime Neuroptics Blueprint".to_string(),
                slug: "wisp_prime_neuroptics_blueprint".to_string(),
                image_path: None,
                order_type: "buy".to_string(),
                source: "wfm".to_string(),
                platinum: 25,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T10:00:00Z".to_string(),
                updated_at: "2026-03-10T10:00:00Z".to_string(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
                allocation_mode: None,
                cost_basis_confidence: None,
                cost_basis_label: None,
                matched_cost: None,
                matched_quantity: None,
                matched_buy_count: 0,
                matched_buy_rows: Vec::new(),
                set_component_rows: Vec::new(),
                profit_formula: None,
                duplicate_risk: false,
            },
        ];

        replace_trade_log_rows_inner(&mut connection, username, &refreshed_entries)
            .expect("replace trade log rows");
        // The real force-resync path runs reconcile after replace, which prunes overrides
        // for orders no longer in the cache. `replace_trade_log_rows_inner` intentionally
        // defers that pruning (so collapsed Set-entry overrides aren't dropped), so mirror
        // the reconcile step here.
        prune_stale_trade_log_overrides_inner(&connection, username)
            .expect("prune stale overrides");

        let records = load_stored_trade_log_records_inner(&connection, username)
            .expect("load refreshed trade log");
        let trade_1 = records
            .iter()
            .find(|record| record.id == "trade-1")
            .expect("trade-1");
        assert!(trade_1.keep_item);
        assert!(records.iter().any(|record| record.id == "trade-3"));

        let override_count: i64 = connection
            .query_row(
                "
                SELECT COUNT(*)
                FROM portfolio_trade_log_overrides
                WHERE username = ?1 AND order_id = ?2
                ",
                params![username, "trade-2"],
                |row| row.get(0),
            )
            .expect("override lookup");
        assert_eq!(override_count, 0);
    }

    #[test]
    fn append_unique_trade_entries_skips_duplicates() {
        let existing = vec![PortfolioTradeLogEntry {
            id: "trade-1".to_string(),
            item_name: "Wisp Prime Set".to_string(),
            slug: "wisp_prime_set".to_string(),
            image_path: None,
            order_type: "sell".to_string(),
            source: "wfm".to_string(),
            platinum: 68,
            quantity: 1,
            rank: None,
            closed_at: "2026-03-10T09:00:20Z".to_string(),
            updated_at: "2026-03-10T09:00:20Z".to_string(),
            profit: None,
            margin: None,
            status: None,
            keep_item: false,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: None,
            group_sort_order: None,
            allocation_mode: None,
            cost_basis_confidence: None,
            cost_basis_label: None,
            matched_cost: None,
            matched_quantity: None,
            matched_buy_count: 0,
            matched_buy_rows: Vec::new(),
            set_component_rows: Vec::new(),
            profit_formula: None,
            duplicate_risk: false,
        }];

        let incoming = vec![
            PortfolioTradeLogEntry {
                id: "trade-2".to_string(),
                item_name: "Wisp Prime Set".to_string(),
                slug: "wisp_prime_set".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                source: "alecaframe".to_string(),
                platinum: 68,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:45Z".to_string(),
                updated_at: "2026-03-10T09:00:45Z".to_string(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
                allocation_mode: None,
                cost_basis_confidence: None,
                cost_basis_label: None,
                matched_cost: None,
                matched_quantity: None,
                matched_buy_count: 0,
                matched_buy_rows: Vec::new(),
                set_component_rows: Vec::new(),
                profit_formula: None,
                duplicate_risk: false,
            },
            PortfolioTradeLogEntry {
                id: "trade-3".to_string(),
                item_name: "Wisp Prime Chassis Blueprint".to_string(),
                slug: "wisp_prime_chassis_blueprint".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                source: "alecaframe".to_string(),
                platinum: 34,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:02:00Z".to_string(),
                updated_at: "2026-03-10T09:02:00Z".to_string(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: None,
                group_label: None,
                group_total_platinum: None,
                group_item_count: None,
                allocation_total_platinum: None,
                group_sort_order: None,
                allocation_mode: None,
                cost_basis_confidence: None,
                cost_basis_label: None,
                matched_cost: None,
                matched_quantity: None,
                matched_buy_count: 0,
                matched_buy_rows: Vec::new(),
                set_component_rows: Vec::new(),
                profit_formula: None,
                duplicate_risk: false,
            },
        ];

        let combined = append_unique_trade_entries(&existing, &incoming);
        assert_eq!(combined.len(), 2);
        assert!(combined.iter().any(|entry| entry.id == "trade-1"));
        assert!(combined.iter().any(|entry| entry.id == "trade-3"));
    }

    #[test]
    fn merge_wfm_trade_log_entries_skips_cross_source_duplicates() {
        let existing = vec![StoredTradeLogRecord {
            id: "af-trade-1".to_string(),
            item_name: "Wisp Prime Chassis Blueprint".to_string(),
            slug: "wisp_prime_chassis_blueprint".to_string(),
            image_path: None,
            order_type: "sell".to_string(),
            source: "alecaframe".to_string(),
            platinum: 34,
            quantity: 1,
            rank: None,
            closed_at: "2026-03-10T09:00:00Z".to_string(),
            updated_at: "2026-03-10T09:00:00Z".to_string(),
            keep_item: false,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: None,
            group_sort_order: None,
        }];

        let fetched_entries = vec![PortfolioTradeLogEntry {
            id: "wfm-trade-1".to_string(),
            item_name: "Wisp Prime Chassis Blueprint".to_string(),
            slug: "wisp_prime_chassis_blueprint".to_string(),
            image_path: None,
            order_type: "sell".to_string(),
            source: "wfm".to_string(),
            platinum: 34,
            quantity: 1,
            rank: None,
            closed_at: "2026-03-10T09:00:30Z".to_string(),
            updated_at: "2026-03-10T09:00:30Z".to_string(),
            profit: None,
            margin: None,
            status: None,
            keep_item: false,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: None,
            group_sort_order: None,
            allocation_mode: None,
            cost_basis_confidence: None,
            cost_basis_label: None,
            matched_cost: None,
            matched_quantity: None,
            matched_buy_count: 0,
            matched_buy_rows: Vec::new(),
            set_component_rows: Vec::new(),
            profit_formula: None,
            duplicate_risk: false,
        }];

        let (persisted_entries, new_entries) =
            merge_wfm_trade_log_entries(&existing, &fetched_entries);

        assert!(persisted_entries.is_empty());
        assert!(new_entries.is_empty());
    }

    #[test]
    fn decide_trade_health_prefers_hold_when_listing_is_already_at_market() {
        let context = CachedTradeHealthContext {
            trend_direction: "Flat".to_string(),
            trend_summary: "Recent tracked floors are broadly stable.".to_string(),
            liquidity_score: Some(68.0),
            liquidity_label: "Tradable".to_string(),
            pressure_label: "Balanced".to_string(),
            exit_zone_low: Some(118.0),
            is_degraded: false,
        };

        let decision = decide_trade_health(120, Some(120), 0, 0, 0, Some(&context));
        assert_eq!(decision.action_label, "Hold");
        assert_eq!(decision.outlook_label, "Likely soon");
        assert!(decision.score >= 70);
    }

    #[test]
    fn decide_trade_health_waits_when_live_floor_is_below_exit_zone() {
        let context = CachedTradeHealthContext {
            trend_direction: "Falling".to_string(),
            trend_summary: "Recent tracked floors are still slipping.".to_string(),
            liquidity_score: Some(60.0),
            liquidity_label: "Tradable".to_string(),
            pressure_label: "Exit Pressure".to_string(),
            exit_zone_low: Some(90.0),
            is_degraded: false,
        };

        let decision = decide_trade_health(88, Some(82), 3, 5, 1, Some(&context));
        assert_eq!(decision.action_label, "Wait for normalization");
        assert_eq!(decision.action_tone, "amber");
    }

    #[test]
    fn trade_session_reauth_detection_matches_expiry_signals() {
        assert!(should_attempt_trade_session_reauth(&anyhow!("request failed with status 401")));
        assert!(should_attempt_trade_session_reauth(&anyhow!("session expired")));
        assert!(!should_attempt_trade_session_reauth(&anyhow!(
            "failed to reach warframe market"
        )));
    }
}
