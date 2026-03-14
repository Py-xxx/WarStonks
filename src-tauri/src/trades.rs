use crate::market_observatory::{
    apply_owned_set_component_deltas, replace_owned_set_component_deltas, OwnedSetComponentDelta,
};
use crate::settings::{
    load_settings_for_internal_use, send_trade_detected_discord_notification_inner,
    DiscordTradeDetectedNotificationInput, DiscordTradeNotificationItem,
};
use anyhow::{anyhow, Context, Result};
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
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const ITEM_CATALOG_DATABASE_FILE: &str = "item_catalog.sqlite";
const MARKET_OBSERVATORY_DATABASE_FILE: &str = "market_observatory.sqlite";
const TRADES_DIR_NAME: &str = "trades";
const TRADES_SESSION_FILE_NAME: &str = "wfm-session.json";
const TRADES_CREDENTIALS_FILE_NAME: &str = "wfm-credentials.json";
const TRADES_CACHE_DATABASE_FILE: &str = "trades-cache.sqlite";
const TRADE_SET_MAP_FILE_NAME: &str = "wfm-set-map.json";
const TRADE_SET_COMPONENT_CACHE_RETENTION_DAYS: i64 = 30;
const TRADE_LOG_DERIVED_VERSION: i64 = 3;
const PORTFOLIO_PNL_CHART_BUCKET_LIMIT: usize = 90;
const PORTFOLIO_PROFIT_POINT_LIMIT: usize = 12;
const ALECAFRAME_USER_AGENT: &str = "warstonks/3.0.0";
const TRADE_TIME_DUPLICATE_WINDOW_SECONDS: i64 = 60;
const WFM_TRADE_LOG_LOCK_DAYS: i64 = 80;
const ALECAFRAME_NOTIFICATION_DELAY_SECONDS: i64 = 90;
const WFM_API_BASE_URL_V1: &str = "https://api.warframe.market/v1";
const WFM_API_BASE_URL_V2: &str = "https://api.warframe.market/v2";
const WFM_WS_URL: &str = "wss://ws.warframe.market/socket";
const WFM_USER_AGENT: &str = "warstonks/3.0.0";

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
    pub your_price: i64,
    pub market_low: Option<i64>,
    pub price_gap: Option<i64>,
    pub visible: bool,
    pub updated_at: String,
    pub health_score: Option<i64>,
    pub health_note: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSignInInput {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub stay_logged_in: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeCreateListingInput {
    pub wfm_id: String,
    pub price: i64,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub visible: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeUpdateListingInput {
    pub order_id: String,
    pub price: i64,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub visible: bool,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTradeBuy {
    pub slug: String,
    pub rank: Option<i64>,
    pub quantity: i64,
    pub platinum: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTradeSession {
    token: String,
    device_id: String,
    account: TradeAccountSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTradeCredentials {
    email: String,
    password: String,
    saved_at: String,
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
    platinum: i64,
    quantity: i64,
    #[serde(default)]
    rank: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(rename = "itemId")]
    item_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrdersItemResponse {
    data: Vec<WfmOrderWithUser>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrderWithUser {
    #[serde(rename = "type")]
    order_type: String,
    platinum: i64,
    #[serde(default)]
    rank: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
    user: WfmOrderUser,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrderUser {
    #[serde(default)]
    ingame_name: Option<String>,
    #[serde(default)]
    status: Option<String>,
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
    quantity: i64,
    closed_date: String,
    order_type: String,
    platinum: i64,
    #[serde(default)]
    mod_rank: Option<i64>,
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

fn seller_mode_allows_status(status: Option<&str>, seller_mode: &str) -> bool {
    match seller_mode {
        "ingame-online" => matches!(status, Some("ingame" | "in_game" | "online")),
        _ => matches!(status, Some("ingame" | "in_game")),
    }
}

fn shared_wfm_client() -> Result<Client> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    match CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("failed to build WFM trades client: {error}"))
    }) {
        Ok(client) => Ok(client.clone()),
        Err(error) => Err(anyhow!(error.clone())),
    }
}

fn build_trades_session_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    Ok(app_data_dir
        .join(TRADES_DIR_NAME)
        .join(TRADES_SESSION_FILE_NAME))
}

fn build_trades_credentials_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    Ok(app_data_dir
        .join(TRADES_DIR_NAME)
        .join(TRADES_CREDENTIALS_FILE_NAME))
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

fn load_session_from_path(path: &Path) -> Result<Option<StoredTradeSession>> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read trade session at {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }

    let session = serde_json::from_str::<StoredTradeSession>(&raw)
        .with_context(|| format!("failed to parse trade session at {}", path.display()))?;
    Ok(Some(session))
}

fn save_session_to_path(path: &Path, session: &StoredTradeSession) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create trades directory {}", parent.display()))?;
    }

    let serialized =
        serde_json::to_string_pretty(session).context("failed to serialize trade session")?;
    fs::write(path, serialized)
        .with_context(|| format!("failed to write trade session at {}", path.display()))
}

fn clear_session_path(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_file(path)
            .with_context(|| format!("failed to remove trade session at {}", path.display()))?;
    }
    Ok(())
}

fn load_trade_credentials(app: &tauri::AppHandle) -> Result<Option<StoredTradeCredentials>> {
    let path = build_trades_credentials_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path)
        .with_context(|| format!("failed to read trade credentials at {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }

    let creds = serde_json::from_str::<StoredTradeCredentials>(&raw)
        .with_context(|| format!("failed to parse trade credentials at {}", path.display()))?;
    Ok(Some(creds))
}

fn save_trade_credentials(app: &tauri::AppHandle, creds: &StoredTradeCredentials) -> Result<()> {
    let path = build_trades_credentials_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create trades directory {}", parent.display()))?;
    }

    let serialized =
        serde_json::to_string_pretty(creds).context("failed to serialize trade credentials")?;
    fs::write(&path, serialized)
        .with_context(|| format!("failed to write trade credentials at {}", path.display()))
}

fn clear_trade_credentials(app: &tauri::AppHandle) -> Result<()> {
    let path = build_trades_credentials_path(app)?;
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("failed to remove trade credentials at {}", path.display()))?;
    }
    Ok(())
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

fn open_trades_cache_database(app: &tauri::AppHandle) -> Result<Connection> {
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

fn parse_timestamp(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

fn trade_record_is_before_cutoff(
    record: &StoredTradeLogRecord,
    cutoff: OffsetDateTime,
) -> bool {
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

fn execute_wfm_request(
    builder: reqwest::blocking::RequestBuilder,
    action_label: &str,
) -> Result<reqwest::blocking::Response> {
    let response = builder
        .send()
        .with_context(|| format!("failed to {action_label}"))?;

    if response.status().is_success() {
        return Ok(response);
    }

    let status = response.status();
    let body = response.text().unwrap_or_default();
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        return Err(anyhow!("{action_label} failed with status {status}"));
    }

    Err(anyhow!(
        "{action_label} failed with status {status}: {trimmed_body}"
    ))
}

fn fetch_me_with_token(client: &Client, token: &str) -> Result<TradeAccountSummary> {
    let response = execute_wfm_request(
        send_wfm_request(
            client,
            Method::GET,
            format!("{WFM_API_BASE_URL_V2}/me"),
            Some(token),
        ),
        "request WFM profile",
    )?;

    let payload = response
        .json::<Value>()
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
              wfm_items.max_rank
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
              wfm_items.max_rank
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
              wfm_items.max_rank
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
        let quantity = component.quantity_in_set.max(1).saturating_mul(trade_quantity);

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

fn should_send_alecaframe_trade_notification(candidate: &TradeNotificationCandidate) -> bool {
    parse_timestamp(&candidate.closed_at)
        .map(|closed_at| {
            (now_utc() - closed_at).whole_seconds() >= ALECAFRAME_NOTIFICATION_DELAY_SECONDS
        })
        .unwrap_or(true)
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
    source: &str,
    session_started_at: Option<&OffsetDateTime>,
) -> Result<i64> {
    let mut sent_count = 0_i64;

    for candidate in candidates {
        if !trade_happened_after_session_start(candidate, session_started_at) {
            continue;
        }

        if source == "alecaframe" && !should_send_alecaframe_trade_notification(candidate) {
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

fn fetch_profile_trade_log_inner(username: &str) -> Result<Vec<PortfolioTradeLogEntry>> {
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

    let payload = execute_wfm_request(
        client
            .get(url)
            .header("User-Agent", WFM_USER_AGENT)
            .header("Accept", "application/json"),
        "request WFM trade history",
    )?
    .json::<WfmProfileStatisticsResponse>()
    .context("failed to parse WFM trade history response")?;

    Ok(build_trade_log_entries_from_statistics(payload.payload))
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
            Ok(TradeSetComponentRecord {
                component_slug: row.get(0)?,
                quantity_in_set: 1,
                fetched_at: fetched_at.clone(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect catalog set components")?;

    Ok(rows)
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

    let raw = serde_json::to_string_pretty(file).context("failed to serialize trade set map")?;
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
    let version_key = api_version
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    if let Some(existing) = load_trade_set_map_file(&map_path)? {
        let existing_version = existing
            .api_version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if existing_version == version_key {
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
        let components = load_trade_set_components_from_catalog(&catalog_connection, &set_root.slug)?
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
    let transaction = connection
        .transaction()
        .context("failed to start trade log cache transaction")?;

    {
        let mut insert_statement = transaction
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
                    trimmed_username,
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
    }

    transaction
        .execute(
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
            params![trimmed_username, last_updated_at, entries.len() as i64],
        )
        .context("failed to upsert cached trade log metadata")?;

    transaction
        .commit()
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

    connection
        .execute(
            "DELETE FROM portfolio_trade_log_cache WHERE username = ?1",
            params![trimmed_username],
        )
        .context("failed to clear cached trade log rows for replacement")?;

    let last_updated_at = save_trade_log_rows_inner(connection, trimmed_username, entries)?;

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
            params![trimmed_username],
        )
        .context("failed to prune stale trade log overrides")?;

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
        return (Some("full".to_string()), Some("Full Cost Basis".to_string()));
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
    let mut deltas = Vec::new();

    for record in normalized_records {
        let normalized_order_type = record.order_type.trim().to_lowercase();
        if normalized_order_type == "buy" && record.keep_item {
            continue;
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

        return ((total * normalized_quantity) + (record.quantity / 2)) / record.quantity;
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
) -> (i64, i64, Vec<ConsumedBuyMatch>, Vec<DerivedSetComponentDetail>) {
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
        let (component_matched_quantity, component_cost, component_matches) = consume_matching_buy_lots(
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

    (fully_supported_sets.max(0), total_cost, all_matches, component_details)
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
                let (set_quantity, set_cost, set_matches, component_details) = consume_set_component_buy_lots(
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

fn reconcile_trade_log_state_inner(
    app: &tauri::AppHandle,
    connection: &mut Connection,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    let _ = normalize_grouped_trade_sets_inner(app, connection, username)?;
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
            let imported =
                build_alecaframe_trade_entries(app, trimmed_username, &baseline_date, &existing_records)?;
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
    let fetched_entries = fetch_profile_trade_log_inner(username)?;
    let (persisted_entries, _) = merge_wfm_trade_log_entries(&existing, &fetched_entries);
    save_trade_log_rows_inner(&mut connection, username, &persisted_entries)?;
    reconcile_trade_log_state_inner(app, &mut connection, username)
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
    let existing = load_stored_trade_log_records_inner(&connection, trimmed_username)?;
    let fetched_entries = fetch_profile_trade_log_inner(trimmed_username)?;
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

    if new_entries.is_empty() {
        return Ok(TradeDetectionRefreshResult {
            source: "wfm".to_string(),
            new_trade_count: 0,
            notification_count: 0,
            last_updated_at: load_trade_log_last_updated_at(&connection, trimmed_username)?,
            skipped: false,
            message: None,
            detected_buys: Vec::new(),
        });
    }

    let last_updated_at =
        save_trade_log_rows_inner(&mut connection, trimmed_username, &persisted_entries)?;
    let _ = reconcile_trade_log_state_inner(app, &mut connection, trimmed_username)?;
    let owned_part_deltas = build_owned_set_component_deltas_for_entries(app, &new_entries)?;
    apply_owned_set_component_deltas(app, &owned_part_deltas)?;
    let wfm_candidates = build_trade_notification_candidates_for_wfm(app, &new_entries)?;
    let notification_count = send_trade_notification_candidates_inner(
        app,
        &connection,
        trimmed_username,
        &wfm_candidates,
        "wfm",
        session_started_at.as_ref(),
    )?;

    Ok(TradeDetectionRefreshResult {
        source: "wfm".to_string(),
        new_trade_count: new_entries.len() as i64,
        notification_count,
        last_updated_at: Some(last_updated_at),
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
    if imported.is_empty() {
        return Ok(TradeDetectionRefreshResult {
            source: "alecaframe".to_string(),
            new_trade_count: 0,
            notification_count: 0,
            last_updated_at: load_trade_log_last_updated_at(&connection, trimmed_username)?,
            skipped: false,
            message: None,
            detected_buys: Vec::new(),
        });
    }

    let last_updated_at = save_trade_log_rows_inner(&mut connection, trimmed_username, &imported)?;
    let _ = reconcile_trade_log_state_inner(app, &mut connection, trimmed_username)?;
    let owned_part_deltas = build_owned_set_component_deltas_for_entries(app, &imported)?;
    apply_owned_set_component_deltas(app, &owned_part_deltas)?;
    let notification_count = send_trade_notification_candidates_inner(
        app,
        &connection,
        trimmed_username,
        &build_trade_notification_candidates_for_alecaframe(&imported),
        "alecaframe",
        session_started_at.as_ref(),
    )?;

    Ok(TradeDetectionRefreshResult {
        source: "alecaframe".to_string(),
        new_trade_count: imported.len() as i64,
        notification_count,
        last_updated_at: Some(last_updated_at),
        skipped: false,
        message: None,
        detected_buys: imported
            .iter()
            .filter(|entry| entry.order_type == "buy")
            .map(|entry| DetectedTradeBuy {
                slug: entry.slug.clone(),
                rank: entry.rank,
                quantity: entry.quantity.max(1),
                platinum: entry.platinum,
            })
            .collect(),
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
                open_exposure += total_platinum;
                if derived_entry.status.as_deref() == Some("Open") {
                    open_buys += 1;
                }
                if derived_entry.status.as_deref() == Some("Kept") {
                    kept_items += 1;
                }

                let maybe_estimate = metadata_by_slug
                    .get(record.slug.as_str())
                    .and_then(|meta| meta.item_id)
                    .and_then(|item_id| {
                        market_connection
                            .as_ref()
                            .and_then(|connection| {
                                latest_local_market_estimate(connection, item_id, record.rank).ok()
                            })
                            .flatten()
                    });

                let estimated_total = maybe_estimate
                    .map(|unit_price| unit_price.saturating_mul(record.quantity))
                    .unwrap_or(total_platinum);
                unrealized_value += estimated_total;
                unrealized_pnl += estimated_total - total_platinum;
                if derived_entry.status.as_deref() == Some("Kept") {
                    kept_inventory_value += estimated_total;
                }

                if maybe_estimate.is_some() {
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

        if !record_matches_cutoff(record, cutoff) {
            continue;
        }

        total_trades += 1;
        turnover_sold += total_platinum;
        total_sell_revenue += total_platinum;
        closed_trades += 1;

        let profit = derived_entry.profit.unwrap_or(0);
        realized_profit += profit;
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

async fn connect_wfm_websocket(
    token: &str,
    device_id: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let mut request = WFM_WS_URL
        .into_client_request()
        .context("failed to build WFM websocket request")?;
    let headers = request.headers_mut();
    headers.append("Sec-WebSocket-Protocol", "wfm".parse().unwrap());
    headers.append("User-Agent", WFM_USER_AGENT.parse().unwrap());

    let (mut ws_stream, _) = timeout(Duration::from_secs(10), connect_async(request))
        .await
        .context("timed out while connecting to WFM websocket")?
        .context("failed to connect to WFM websocket")?;

    let auth_request_id = uuid::Uuid::new_v4().to_string();
    let auth_message = WfmWsMessage {
        route: "@wfm|cmd/auth/signIn".to_string(),
        payload: Some(json!({
            "token": token,
            "deviceId": device_id,
        })),
        id: Some(auth_request_id),
        ref_id: None,
    };

    ws_stream
        .send(Message::Text(
            serde_json::to_string(&auth_message)
                .context("failed to serialize websocket auth message")?
                .into(),
        ))
        .await
        .context("failed to send websocket auth message")?;

    Ok(ws_stream)
}

async fn fetch_current_trade_status_ws(token: &str, device_id: &str) -> Result<String> {
    let mut ws_stream = connect_wfm_websocket(token, device_id).await?;
    let mut authenticated = false;

    timeout(Duration::from_secs(10), async {
        while let Some(message) = ws_stream.next().await {
            let message = message.context("failed to read WFM websocket message")?;
            let Message::Text(text) = message else {
                continue;
            };

            let payload = serde_json::from_str::<WfmWsMessage>(&text)
                .context("failed to parse WFM websocket payload")?;
            let route = payload
                .route
                .split('|')
                .nth(1)
                .unwrap_or(payload.route.as_str())
                .to_string();

            if !authenticated {
                if route == "cmd/auth/signIn:ok" {
                    authenticated = true;
                    continue;
                }

                if route == "cmd/auth/signIn:error" {
                    let reason = payload
                        .payload
                        .as_ref()
                        .and_then(|value| value.get("reason"))
                        .and_then(Value::as_str)
                        .unwrap_or("websocket authentication failed");
                    return Err(anyhow!(reason.to_string()));
                }

                continue;
            }

            if route == "event/status/set" {
                if let Some(status) = payload.payload.as_ref().and_then(parse_status_from_payload) {
                    return Ok(status);
                }
            }
        }

        Err(anyhow!("presence status was not emitted by WFM"))
    })
    .await
    .context("timed out while waiting for WFM presence state")?
}

fn normalize_status_set_request(status: &str) -> Result<&'static str> {
    match status.trim().to_lowercase().as_str() {
        "ingame" | "in_game" => Ok("ingame"),
        "online" => Ok("online"),
        "invisible" | "offline" => Ok("invisible"),
        _ => Err(anyhow!("Unsupported presence state.")),
    }
}

async fn set_current_trade_status_ws(token: &str, device_id: &str, status: &str) -> Result<String> {
    let requested_status = normalize_status_set_request(status)?;
    let mut ws_stream = connect_wfm_websocket(token, device_id).await?;
    let mut authenticated = false;
    let mut status_sent = false;
    let mut latest_emitted_status: Option<String> = None;

    timeout(Duration::from_secs(10), async {
        while let Some(message) = ws_stream.next().await {
            let message = message.context("failed to read WFM websocket message")?;
            let Message::Text(text) = message else {
                continue;
            };

            let payload = serde_json::from_str::<WfmWsMessage>(&text)
                .context("failed to parse WFM websocket payload")?;
            let route = payload
                .route
                .split('|')
                .nth(1)
                .unwrap_or(payload.route.as_str())
                .to_string();

            if !authenticated {
                if route == "cmd/auth/signIn:ok" {
                    authenticated = true;
                } else if route == "cmd/auth/signIn:error" {
                    let reason = payload
                        .payload
                        .as_ref()
                        .and_then(|value| value.get("reason"))
                        .and_then(Value::as_str)
                        .unwrap_or("websocket authentication failed");
                    return Err(anyhow!(reason.to_string()));
                } else {
                    continue;
                }
            }

            if authenticated && !status_sent {
                status_sent = true;
                let status_message = WfmWsMessage {
                    route: "@wfm|cmd/status/set".to_string(),
                    payload: Some(json!({
                        "status": requested_status,
                    })),
                    id: Some(uuid::Uuid::new_v4().to_string()),
                    ref_id: None,
                };

                ws_stream
                    .send(Message::Text(
                        serde_json::to_string(&status_message)
                            .context("failed to serialize websocket status message")?
                            .into(),
                    ))
                    .await
                    .context("failed to send websocket status message")?;
                continue;
            }

            if route == "cmd/status/set:error" {
                let reason = payload
                    .payload
                    .as_ref()
                    .and_then(|value| value.get("reason"))
                    .and_then(Value::as_str)
                    .unwrap_or("failed to update presence");
                return Err(anyhow!(reason.to_string()));
            }

            if route == "event/status/set" {
                latest_emitted_status = payload.payload.as_ref().and_then(parse_status_from_payload);
                continue;
            }

            if route == "cmd/status/set:ok" {
                if let Some(status) = payload.payload.as_ref().and_then(parse_status_from_payload) {
                    return Ok(status);
                }

                if let Some(status) = latest_emitted_status.clone() {
                    return Ok(status);
                }

                return Ok(normalize_status_label(requested_status));
            }
        }

        Err(anyhow!("presence update confirmation was not emitted by WFM"))
    })
    .await
    .context("timed out while waiting for WFM presence update")?
}

fn sign_in_inner(input: &TradeSignInInput) -> Result<StoredTradeSession> {
    let client = shared_wfm_client()?;
    let trimmed_email = input.email.trim();
    let trimmed_password = input.password.trim();
    if trimmed_email.is_empty() || trimmed_password.is_empty() {
        return Err(anyhow!(
            "Enter both your Warframe Market email and password."
        ));
    }

    let device_id = generate_device_id();
    let response = client
        .post(format!("{WFM_API_BASE_URL_V1}/auth/signin"))
        .header("User-Agent", WFM_USER_AGENT)
        .header("Authorization", "JWT")
        .header("Accept", "application/json")
        .json(&json!({
            "auth_type": "header",
            "email": trimmed_email,
            "password": trimmed_password,
            "device_id": device_id,
        }))
        .send()
        .context("failed to request WFM sign-in")?
        .error_for_status()
        .context("WFM sign-in request failed")?;

    let auth_header = response
        .headers()
        .get("Authorization")
        .and_then(|value| value.to_str().ok())
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

    Ok(StoredTradeSession {
        token: jwt,
        device_id,
        account,
    })
}

fn load_session(app: &tauri::AppHandle) -> Result<Option<StoredTradeSession>> {
    let path = build_trades_session_path(app)?;
    load_session_from_path(&path)
}

fn save_session(app: &tauri::AppHandle, session: &StoredTradeSession) -> Result<()> {
    let path = build_trades_session_path(app)?;
    save_session_to_path(&path, session)
}

fn clear_session(app: &tauri::AppHandle) -> Result<()> {
    let path = build_trades_session_path(app)?;
    clear_session_path(&path)
}

fn ensure_authenticated_session(app: &tauri::AppHandle) -> Result<StoredTradeSession> {
    let client = shared_wfm_client()?;
    let Some(mut session) = load_session(app)? else {
        return Err(anyhow!("Sign in to Warframe Market first."));
    };

    match fetch_me_with_token(&client, &session.token) {
        Ok(account) => {
            session.account = account;
            save_session(app, &session)?;
            Ok(session)
        }
        Err(error) => {
            clear_session(app)?;
            Err(anyhow!("Warframe Market session expired: {error}"))
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
                max_rank
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
                })
            },
        )
        .optional()
        .context("failed to resolve catalog item")
}

fn fetch_market_low_for_listing(
    client: &Client,
    slug: &str,
    rank: Option<i64>,
    seller_mode: &str,
    own_username: &str,
) -> Result<Option<i64>> {
    let payload = execute_wfm_request(
        send_wfm_request(
            client,
            Method::GET,
            format!("{WFM_API_BASE_URL_V2}/orders/item/{slug}"),
            None,
        ),
        "request market low",
    )?
    .json::<WfmOrdersItemResponse>()
    .context("failed to parse market low response")?;

    let own_name = own_username.trim().to_lowercase();

    Ok(payload
        .data
        .into_iter()
        .filter(|order| order.order_type == "sell")
        .filter(|order| order.visible.unwrap_or(true))
        .filter(|order| seller_mode_allows_status(order.user.status.as_deref(), seller_mode))
        .filter(|order| order.rank == rank)
        .filter_map(|order| {
            let username = order.user.ingame_name?;
            (username.trim().to_lowercase() != own_name).then_some(order.platinum)
        })
        .min())
}

fn fetch_my_orders(client: &Client, token: &str) -> Result<Vec<WfmOwnOrder>> {
    let response = execute_wfm_request(
        send_wfm_request(
            client,
            Method::GET,
            format!("{WFM_API_BASE_URL_V2}/orders/my"),
            Some(token),
        ),
        "load own orders",
    )?;

    let payload = response
        .json::<WfmMyOrdersResponse>()
        .context("failed to parse own orders response")?;

    Ok(payload.data)
}

fn build_trade_overview_inner(app: &tauri::AppHandle, seller_mode: &str) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
    let connection = open_catalog_database(app)?;
    let orders = fetch_my_orders(&client, &session.token)?;

    let mut market_low_cache = HashMap::<(String, Option<i64>), Option<i64>>::new();
    let mut sell_orders = Vec::new();
    let mut buy_orders = Vec::new();

    for order in orders
        .into_iter()
        .filter(|entry| matches!(entry.order_type.as_str(), "sell" | "buy"))
    {
        let Some(meta) = resolve_catalog_trade_item_meta(&connection, &order.item_id)? else {
            continue;
        };

        let cache_key = (meta.slug.clone(), order.rank);
        let market_low = if let Some(cached) = market_low_cache.get(&cache_key) {
            *cached
        } else {
            let fetched = fetch_market_low_for_listing(
                &client,
                &meta.slug,
                order.rank,
                seller_mode,
                &session.account.name,
            )
            .unwrap_or(None);
            market_low_cache.insert(cache_key, fetched);
            fetched
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
            your_price: order.platinum,
            market_low,
            price_gap: market_low.map(|value| order.platinum - value),
            visible: order.visible.unwrap_or(true),
            updated_at: order.updated_at,
            health_score: None,
            health_note: None,
        };

        if order.order_type == "sell" {
            sell_orders.push(trade_order);
        } else {
            buy_orders.push(trade_order);
        }
    }

    sell_orders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    buy_orders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    let active_trade_value = sell_orders
        .iter()
        .chain(buy_orders.iter())
        .filter(|order| order.visible)
        .map(|order| order.your_price * order.quantity)
        .sum::<i64>();

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

    execute_wfm_request(
        send_wfm_request(
            &client,
            Method::POST,
            format!("{WFM_API_BASE_URL_V2}/order"),
            Some(&session.token),
        )
        .json(&payload),
        &format!("create {order_type} order"),
    )?;

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

    execute_wfm_request(
        send_wfm_request(
            &client,
            Method::PATCH,
            format!("{WFM_API_BASE_URL_V2}/order/{}", input.order_id),
            Some(&session.token),
        )
        .json(&payload),
        &format!("update {order_type} order"),
    )?;

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

    execute_wfm_request(
        send_wfm_request(
            &client,
            Method::POST,
            format!("{WFM_API_BASE_URL_V2}/order/{order_id}/close"),
            Some(&session.token),
        )
        .json(&json!({ "quantity": quantity })),
        &format!("close {order_type} order"),
    )?;

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

    execute_wfm_request(
        send_wfm_request(
            &client,
            Method::DELETE,
            format!("{WFM_API_BASE_URL_V2}/order/{order_id}"),
            Some(&session.token),
        ),
        &format!("delete {order_type} order"),
    )?;

    build_trade_overview_inner(app, seller_mode)
}

#[tauri::command]
pub async fn get_wfm_trade_session_state(
    app: tauri::AppHandle,
) -> Result<TradeSessionState, String> {
    let maybe_session = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || ensure_authenticated_session(&app)
    })
    .await
    .map_err(|error| error.to_string())?;

    match maybe_session {
        Ok(mut session) => {
            if let Ok(status) =
                fetch_current_trade_status_ws(&session.token, &session.device_id).await
            {
                session.account.status = status;
                let _ = tauri::async_runtime::spawn_blocking({
                    let app = app.clone();
                    let session = session.clone();
                    move || save_session(&app, &session)
                })
                .await;
            }

            Ok(TradeSessionState {
                connected: true,
                account: Some(session.account),
            })
        }
        Err(_) => Ok(TradeSessionState {
            connected: false,
            account: None,
        }),
    }
}

#[tauri::command]
pub async fn sign_in_wfm_trade_account(
    app: tauri::AppHandle,
    input: TradeSignInInput,
) -> Result<TradeSessionState, String> {
    let should_persist_credentials = input.stay_logged_in;
    let credentials = StoredTradeCredentials {
        email: input.email.trim().to_string(),
        password: input.password.trim().to_string(),
        saved_at: format_timestamp(now_utc()).map_err(|error| error.to_string())?,
    };
    let mut session = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let input = input.clone();
        move || {
            let session = sign_in_inner(&input)?;
            save_session(&app, &session)?;
            Ok::<StoredTradeSession, anyhow::Error>(session)
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())?;

    if let Ok(status) = fetch_current_trade_status_ws(&session.token, &session.device_id).await {
        session.account.status = status;
        tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            let session = session.clone();
            move || save_session(&app, &session)
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error: anyhow::Error| error.to_string())?;
    }

    if should_persist_credentials {
        tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            let credentials = credentials.clone();
            move || save_trade_credentials(&app, &credentials)
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error: anyhow::Error| error.to_string())?;
    }

    Ok(TradeSessionState {
        connected: true,
        account: Some(session.account),
    })
}

#[tauri::command]
pub async fn sign_out_wfm_trade_account(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    let maybe_session = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || ensure_authenticated_session(&app)
    })
    .await
    .map_err(|error| error.to_string());

    if let Ok(Ok(mut session)) = maybe_session {
        if let Ok(status) =
            fetch_current_trade_status_ws(&session.token, &session.device_id).await
        {
            session.account.status = status;
            let _ = tauri::async_runtime::spawn_blocking({
                let app = app.clone();
                let session = session.clone();
                move || save_session(&app, &session)
            })
            .await;
        }

        return Ok(TradeSessionState {
            connected: true,
            account: Some(session.account),
        });
    }

    let maybe_creds = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || load_trade_credentials(&app)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())?;

    let Some(creds) = maybe_creds else {
        return Ok(TradeSessionState {
            connected: false,
            account: None,
        });
    };

    let input = TradeSignInInput {
        email: creds.email.clone(),
        password: creds.password.clone(),
        stay_logged_in: true,
    };

    let mut session = match tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let input = input.clone();
        move || {
            let session = sign_in_inner(&input)?;
            save_session(&app, &session)?;
            Ok::<StoredTradeSession, anyhow::Error>(session)
        }
    })
    .await
    .map_err(|error| error.to_string())
    {
        Ok(Ok(session)) => session,
        _ => {
            return Ok(TradeSessionState {
                connected: false,
                account: None,
            });
        }
    };

    if let Ok(status) = fetch_current_trade_status_ws(&session.token, &session.device_id).await {
        session.account.status = status;
        let _ = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            let session = session.clone();
            move || save_session(&app, &session)
        })
        .await;
    }

    Ok(TradeSessionState {
        connected: true,
        account: Some(session.account),
    })
}

#[tauri::command]
pub async fn set_wfm_trade_status(
    app: tauri::AppHandle,
    status: String,
) -> Result<TradeSessionState, String> {
    let mut session = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || ensure_authenticated_session(&app)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())?;

    let next_status = set_current_trade_status_ws(&session.token, &session.device_id, &status)
        .await
        .map_err(|error| error.to_string())?;
    session.account.status = next_status;

    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let session = session.clone();
        move || save_session(&app, &session)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())?;

    Ok(TradeSessionState {
        connected: true,
        account: Some(session.account),
    })
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
    .map_err(|error| error.to_string())
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
    .map_err(|error| error.to_string())
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
    .map_err(|error| error.to_string())
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
    .map_err(|error| error.to_string())
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
    .map_err(|error| error.to_string())
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
    .map_err(|error| error.to_string())
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
    .map_err(|error| error.to_string())
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
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        build_trade_log_entries_from_statistics, build_trade_notification_fingerprint,
        collapse_grouped_trade_sets, compute_cost_basis_coverage, compute_current_value_coverage,
        derive_trade_log_entries_with_components, initialize_trades_cache_schema,
        load_stored_trade_log_records_inner, load_trade_log_last_updated_at,
        merge_wfm_trade_log_entries, normalize_alecaframe_trade_payload, normalize_avatar_url,
        normalize_status_set_request, parse_status_from_payload, save_trade_log_rows_inner,
        trade_record_is_before_cutoff, AlecaframeRawTradeRecord,
        AlecaframeTradeItemRecord, AlecaframeTradeResponse, PortfolioTradeLogEntry,
        StoredTradeLogRecord, TradeSetComponentRecord, TradeSetRootRecord, WfmProfileClosedOrder,
        WfmProfileClosedOrderItem, WfmProfileClosedOrderItemName, WfmProfileStatisticsPayload,
    };
    use crate::settings::DiscordTradeNotificationItem;
    use rusqlite::Connection;
    use serde_json::json;
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;

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
}
