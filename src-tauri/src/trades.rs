use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::blocking::Client;
use reqwest::Method;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::HashMap;
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
const TRADES_CACHE_DATABASE_FILE: &str = "trades-cache.sqlite";
const TRADE_SET_MAP_FILE_NAME: &str = "wfm-set-map.json";
const TRADE_SET_COMPONENT_CACHE_RETENTION_DAYS: i64 = 30;
const WFM_API_BASE_URL_V1: &str = "https://api.warframe.market/v1";
const WFM_API_BASE_URL_V2: &str = "https://api.warframe.market/v2";
const WFM_WS_URL: &str = "wss://warframe.market/socket-v2";
const WFM_LANGUAGE_HEADER: &str = "en";
const WFM_PLATFORM_HEADER: &str = "pc";
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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSignInInput {
    pub email: String,
    pub password: String,
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
    pub platinum: i64,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub closed_at: String,
    pub updated_at: String,
    pub profit: Option<i64>,
    pub margin: Option<f64>,
    pub status: Option<String>,
    pub keep_item: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioTradeLogState {
    pub entries: Vec<PortfolioTradeLogEntry>,
    pub last_updated_at: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmTradeSetApiResponse {
    data: WfmTradeSetData,
}

#[derive(Debug, Clone, Deserialize)]
struct WfmTradeSetData {
    items: Vec<WfmTradeSetItemRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmTradeSetItemRecord {
    slug: String,
    #[serde(default)]
    set_root: Option<bool>,
    #[serde(default)]
    quantity_in_set: Option<i64>,
}

#[derive(Debug, Clone)]
struct StoredTradeLogRecord {
    id: String,
    item_name: String,
    slug: String,
    image_path: Option<String>,
    order_type: String,
    platinum: i64,
    quantity: i64,
    rank: Option<i64>,
    closed_at: String,
    updated_at: String,
    keep_item: bool,
}

#[derive(Debug, Clone)]
struct TradeSetComponentRecord {
    component_slug: String,
    quantity_in_set: i64,
    fetched_at: String,
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
              platinum INTEGER NOT NULL,
              quantity INTEGER NOT NULL,
              rank INTEGER,
              closed_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
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
              entry_count INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trade_set_component_cache (
              set_slug TEXT NOT NULL,
              component_slug TEXT NOT NULL,
              quantity_in_set INTEGER NOT NULL,
              sort_order INTEGER NOT NULL,
              fetched_at TEXT NOT NULL,
              PRIMARY KEY (set_slug, component_slug)
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
        .header("Language", WFM_LANGUAGE_HEADER)
        .header("Platform", WFM_PLATFORM_HEADER)
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
            order_type: order.order_type,
            platinum: order.platinum,
            quantity: order.quantity,
            rank: order.mod_rank,
            closed_at: order.closed_date,
            updated_at: order.updated_at,
            profit: None,
            margin: None,
            status: None,
            keep_item: false,
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| right.closed_at.cmp(&left.closed_at));
    entries
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
              cache.platinum,
              cache.quantity,
              cache.rank,
              cache.closed_at,
              cache.updated_at,
              COALESCE(overrides.keep_item, cache.keep_item, 0)
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
                platinum: row.get(5)?,
                quantity: row.get(6)?,
                rank: row.get(7)?,
                closed_at: row.get(8)?,
                updated_at: row.get(9)?,
                keep_item: row.get::<_, i64>(10)? != 0,
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

fn fetch_wfm_trade_set_components(set_slug: &str) -> Result<Vec<TradeSetComponentRecord>> {
    let client = shared_wfm_client()?;
    let response = execute_wfm_request(
        client
            .get(format!("{WFM_API_BASE_URL_V2}/item/{set_slug}/set"))
            .header("User-Agent", WFM_USER_AGENT)
            .header("Language", WFM_LANGUAGE_HEADER)
            .header("Platform", WFM_PLATFORM_HEADER)
            .header("Accept", "application/json"),
        "request WFM set components",
    )?;
    let fetched_at = format_timestamp(now_utc())?;

    Ok(response
        .json::<WfmTradeSetApiResponse>()
        .context("failed to parse WFM trade set response")?
        .data
        .items
        .into_iter()
        .filter(|item| item.set_root != Some(true) && item.slug != set_slug)
        .map(|item| TradeSetComponentRecord {
            component_slug: item.slug,
            quantity_in_set: item.quantity_in_set.unwrap_or(1).max(1),
            fetched_at: fetched_at.clone(),
        })
        .collect())
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

fn save_trade_set_map_file(path: &Path, file: &TradeSetMapFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create trade set map directory {}", parent.display()))?;
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
    let version_key = api_version.map(|value| value.trim()).filter(|value| !value.is_empty());

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
        let components = fetch_wfm_trade_set_components(&set_root.slug)?
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

    let fetched = fetch_wfm_trade_set_components(set_slug)?;
    if !fetched.is_empty() {
        persist_trade_set_component_cache(&cache_connection, set_slug, &fetched)?;
    }

    Ok(fetched)
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
                  platinum,
                  quantity,
                  rank,
                  closed_at,
                  updated_at,
                  keep_item
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, COALESCE(
                  (SELECT keep_item
                   FROM portfolio_trade_log_overrides
                   WHERE username = ?1 AND order_id = ?2),
                  0
                ))
                ON CONFLICT(username, order_id) DO UPDATE SET
                  item_name = excluded.item_name,
                  slug = excluded.slug,
                  image_path = excluded.image_path,
                  order_type = excluded.order_type,
                  platinum = excluded.platinum,
                  quantity = excluded.quantity,
                  rank = excluded.rank,
                  closed_at = excluded.closed_at,
                  updated_at = excluded.updated_at
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
                    entry.platinum,
                    entry.quantity,
                    entry.rank,
                    entry.closed_at,
                    entry.updated_at,
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

fn consume_matching_buy_lots(
    records: &[StoredTradeLogRecord],
    consumption: &mut HashMap<String, BuyConsumptionState>,
    slug: &str,
    rank: Option<i64>,
    required_quantity: i64,
    sell_closed_at: &str,
    as_set: bool,
) -> (i64, i64) {
    let mut matched_quantity = 0_i64;
    let mut matched_cost = 0_i64;
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
        matched_cost += quantity_to_consume * record.platinum;

        if as_set {
            entry.sold_as_set_quantity += quantity_to_consume;
        } else {
            entry.flipped_quantity += quantity_to_consume;
        }
    }

    (matched_quantity, matched_cost)
}

fn consume_set_component_buy_lots(
    records: &[StoredTradeLogRecord],
    consumption: &mut HashMap<String, BuyConsumptionState>,
    components: &[TradeSetComponentRecord],
    sell_quantity: i64,
    sell_closed_at: &str,
) -> (i64, i64) {
    if components.is_empty() || sell_quantity <= 0 {
        return (0, 0);
    }

    let mut max_sets_supported = sell_quantity;
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

        max_sets_supported = max_sets_supported.min(available_quantity / component.quantity_in_set);
    }

    if max_sets_supported <= 0 {
        return (0, 0);
    }

    let mut total_cost = 0_i64;
    for component in components {
        let (_, component_cost) = consume_matching_buy_lots(
            records,
            consumption,
            &component.component_slug,
            None,
            component.quantity_in_set * max_sets_supported,
            sell_closed_at,
            true,
        );
        total_cost += component_cost;
    }

    (max_sets_supported, total_cost)
}

fn derive_trade_log_entries_with_components<F>(
    records: &[StoredTradeLogRecord],
    mut load_components: F,
) -> Vec<PortfolioTradeLogEntry>
where
    F: FnMut(&str) -> Vec<TradeSetComponentRecord>,
{
    let mut consumption = HashMap::<String, BuyConsumptionState>::new();
    let mut derived = Vec::with_capacity(records.len());

    for record in records {
        if record.order_type == "buy" {
            continue;
        }

        let mut remaining_quantity = record.quantity;
        let mut matched_quantity = 0_i64;
        let mut matched_cost = 0_i64;

        if record.slug.ends_with("_set") {
            let components = load_components(&record.slug);
            if !components.is_empty() {
                let (set_quantity, set_cost) = consume_set_component_buy_lots(
                    records,
                    &mut consumption,
                    &components,
                    remaining_quantity,
                    &record.closed_at,
                );
                matched_quantity += set_quantity;
                matched_cost += set_cost;
                remaining_quantity -= set_quantity;
            }
        }

        if remaining_quantity > 0 {
            let (flip_quantity, flip_cost) = consume_matching_buy_lots(
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
        }

        let revenue = record.platinum * record.quantity;
        let profit = revenue - matched_cost;
        let margin = if matched_cost > 0 && matched_quantity == record.quantity {
            Some(((profit as f64) / (matched_cost as f64)) * 100.0)
        } else {
            None
        };

        derived.push(PortfolioTradeLogEntry {
            id: record.id.clone(),
            item_name: record.item_name.clone(),
            slug: record.slug.clone(),
            image_path: record.image_path.clone(),
            order_type: "sell".to_string(),
            platinum: record.platinum,
            quantity: record.quantity,
            rank: record.rank,
            closed_at: record.closed_at.clone(),
            updated_at: record.updated_at.clone(),
            profit: Some(profit),
            margin,
            status: None,
            keep_item: false,
        });
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
            platinum: record.platinum,
            quantity: record.quantity,
            rank: record.rank,
            closed_at: record.closed_at.clone(),
            updated_at: record.updated_at.clone(),
            profit: None,
            margin: None,
            status,
            keep_item: record.keep_item,
        });
    }

    derived.sort_by(|left, right| {
        right
            .closed_at
            .cmp(&left.closed_at)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| right.id.cmp(&left.id))
    });

    derived
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
    let records = load_stored_trade_log_records_inner(connection, username)?;
    let last_updated_at = load_trade_log_last_updated_at(connection, username)?;

    Ok(PortfolioTradeLogState {
        entries: derive_trade_log_entries(app, &records),
        last_updated_at,
    })
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

    let connection = open_trades_cache_database(app)?;
    connection
        .execute(
            "
            INSERT INTO portfolio_trade_log_overrides (username, order_id, keep_item)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(username, order_id) DO UPDATE SET
              keep_item = excluded.keep_item
            ",
            params![trimmed_username, trimmed_order_id, if keep_item { 1 } else { 0 }],
        )
        .context("failed to update trade log keep override")?;

    load_cached_trade_log_state_inner(app, &connection, trimmed_username)
}

fn load_cached_trade_log_state_for_app(
    app: &tauri::AppHandle,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    let connection = open_trades_cache_database(app)?;
    load_cached_trade_log_state_inner(app, &connection, username)
}

fn refresh_trade_log_state_for_app(
    app: &tauri::AppHandle,
    username: &str,
) -> Result<PortfolioTradeLogState> {
    let entries = fetch_profile_trade_log_inner(username)?;
    let mut connection = open_trades_cache_database(app)?;
    save_trade_log_rows_inner(&mut connection, username, &entries)?;
    load_cached_trade_log_state_inner(app, &connection, username)
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

    for order in orders
        .into_iter()
        .filter(|entry| entry.order_type == "sell")
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

        sell_orders.push(TradeSellOrder {
            order_id: order.id,
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
        });
    }

    sell_orders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    let active_trade_value = sell_orders
        .iter()
        .filter(|order| order.visible)
        .map(|order| order.your_price * order.quantity)
        .sum::<i64>();

    Ok(TradeOverview {
        account: session.account.clone(),
        last_updated_at: format_timestamp(now_utc())?,
        active_trade_value,
        total_completed_trades: None,
        open_positions: sell_orders.len() as i64,
        sell_orders,
    })
}

fn create_sell_order_inner(
    app: &tauri::AppHandle,
    input: &TradeCreateListingInput,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
    if input.price <= 0 || input.quantity <= 0 {
        return Err(anyhow!(
            "Price and quantity must both be greater than zero."
        ));
    }

    let mut payload = json!({
        "itemId": input.wfm_id,
        "type": "sell",
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
        "create sell order",
    )?;

    build_trade_overview_inner(app, seller_mode)
}

fn update_sell_order_inner(
    app: &tauri::AppHandle,
    input: &TradeUpdateListingInput,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
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
        "update sell order",
    )?;

    build_trade_overview_inner(app, seller_mode)
}

fn close_sell_order_inner(
    app: &tauri::AppHandle,
    order_id: &str,
    quantity: i64,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;
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
        "close sell order",
    )?;

    build_trade_overview_inner(app, seller_mode)
}

fn delete_sell_order_inner(
    app: &tauri::AppHandle,
    order_id: &str,
    seller_mode: &str,
) -> Result<TradeOverview> {
    let session = ensure_authenticated_session(app)?;
    let client = shared_wfm_client()?;

    execute_wfm_request(
        send_wfm_request(
            &client,
            Method::DELETE,
            format!("{WFM_API_BASE_URL_V2}/order/{order_id}"),
            Some(&session.token),
        ),
        "delete sell order",
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
    let mut session = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
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

    Ok(TradeSessionState {
        connected: true,
        account: Some(session.account),
    })
}

#[tauri::command]
pub async fn sign_out_wfm_trade_account(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clear_session(&app))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
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
        create_sell_order_inner(&app, &input, seller_mode.trim())
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
        update_sell_order_inner(&app, &input, seller_mode.trim())
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
        close_sell_order_inner(&app, order_id.trim(), quantity, seller_mode.trim())
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
        delete_sell_order_inner(&app, order_id.trim(), seller_mode.trim())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        build_trade_log_entries_from_statistics, derive_trade_log_entries_with_components,
        initialize_trades_cache_schema, load_stored_trade_log_records_inner,
        load_trade_log_last_updated_at, normalize_avatar_url, parse_status_from_payload,
        save_trade_log_rows_inner, PortfolioTradeLogEntry, StoredTradeLogRecord,
        TradeSetComponentRecord, WfmProfileClosedOrder,
        WfmProfileClosedOrderItem, WfmProfileClosedOrderItemName, WfmProfileStatisticsPayload,
    };
    use rusqlite::Connection;
    use serde_json::json;

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
                platinum: 25,
                quantity: 2,
                rank: None,
                closed_at: "2026-03-09T10:00:00.000+00:00".to_string(),
                updated_at: "2026-03-09T10:00:00.000+00:00".to_string(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
            },
            PortfolioTradeLogEntry {
                id: "buy-1".to_string(),
                item_name: "Test Item".to_string(),
                slug: "test_item".to_string(),
                image_path: Some("items/images/en/test.png".to_string()),
                order_type: "buy".to_string(),
                platinum: 15,
                quantity: 1,
                rank: Some(2),
                closed_at: "2026-03-10T10:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T10:00:00.000+00:00".to_string(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
            },
        ];

        let saved_updated_at =
            save_trade_log_rows_inner(&mut connection, "qtpyth", &entries).expect("save cached trade log");
        let loaded_records =
            load_stored_trade_log_records_inner(&connection, "qtpyth").expect("load cached trade log");
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
                platinum: 20,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T08:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T08:00:00.000+00:00".to_string(),
                keep_item: false,
            },
            StoredTradeLogRecord {
                id: "buy-neuro".to_string(),
                item_name: "Wisp Prime Neuroptics".to_string(),
                slug: "wisp_prime_neuroptics".to_string(),
                image_path: None,
                order_type: "buy".to_string(),
                platinum: 18,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T08:05:00.000+00:00".to_string(),
                updated_at: "2026-03-10T08:05:00.000+00:00".to_string(),
                keep_item: false,
            },
            StoredTradeLogRecord {
                id: "buy-systems".to_string(),
                item_name: "Wisp Prime Systems".to_string(),
                slug: "wisp_prime_systems".to_string(),
                image_path: None,
                order_type: "buy".to_string(),
                platinum: 22,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T08:10:00.000+00:00".to_string(),
                updated_at: "2026-03-10T08:10:00.000+00:00".to_string(),
                keep_item: false,
            },
            StoredTradeLogRecord {
                id: "sell-set".to_string(),
                item_name: "Wisp Prime Set".to_string(),
                slug: "wisp_prime_set".to_string(),
                image_path: None,
                order_type: "sell".to_string(),
                platinum: 95,
                quantity: 1,
                rank: None,
                closed_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                updated_at: "2026-03-10T09:00:00.000+00:00".to_string(),
                keep_item: false,
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

        let sell_entry = derived.iter().find(|entry| entry.id == "sell-set").expect("sell entry");
        assert_eq!(sell_entry.profit, Some(35));
        assert_eq!(sell_entry.margin, Some(58.333333333333336));

        for buy_id in ["buy-chassis", "buy-neuro", "buy-systems"] {
            let buy_entry = derived.iter().find(|entry| entry.id == buy_id).expect("buy entry");
            assert_eq!(buy_entry.status.as_deref(), Some("Sold As Set"));
        }
    }
}
