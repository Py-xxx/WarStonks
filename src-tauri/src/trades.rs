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
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const ITEM_CATALOG_DATABASE_FILE: &str = "item_catalog.sqlite";
const TRADES_DIR_NAME: &str = "trades";
const TRADES_SESSION_FILE_NAME: &str = "wfm-session.json";
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeStatusInput {
    pub status: String,
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
    value
        .format(&Rfc3339)
        .context("failed to format timestamp")
}

fn normalize_status_label(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "in_game" | "ingame" => "ingame".to_string(),
        "online" => "online".to_string(),
        "invisible" => "offline".to_string(),
        _ => "offline".to_string(),
    }
}

fn normalize_status_command(value: &str) -> Result<&'static str> {
    match value.trim().to_lowercase().as_str() {
        "invisible" | "offline" => Ok("invisible"),
        "online" => Ok("online"),
        "in game" | "in_game" | "ingame" => Ok("in_game"),
        _ => Err(anyhow!("Unsupported status. Use Invisible, Online, or In game.")),
    }
}

fn normalize_server_status(value: &str) -> &'static str {
    match value.trim().to_lowercase().as_str() {
        "in_game" | "ingame" => "ingame",
        "online" => "online",
        "invisible" | "offline" => "offline",
        _ => "offline",
    }
}

fn desired_status_matches_account(desired_status: &str, account_status: &str) -> bool {
    match desired_status {
        "invisible" => normalize_server_status(account_status) == "offline",
        "online" => normalize_server_status(account_status) == "online",
        "in_game" => normalize_server_status(account_status) == "ingame",
        _ => false,
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
    Ok(app_data_dir.join(TRADES_DIR_NAME).join(TRADES_SESSION_FILE_NAME))
}

fn build_item_catalog_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    Ok(app_data_dir.join(ITEM_CATALOG_DATABASE_FILE))
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
            &["avatar", "avatar_url", "avatarUrl", "profile_image", "profileImage"],
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

    Err(anyhow!("{action_label} failed with status {status}: {trimmed_body}"))
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

async fn fetch_me_with_token_async(token: String) -> Result<TradeAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = shared_wfm_client()?;
        fetch_me_with_token(&client, &token)
    })
    .await
    .map_err(|error| anyhow!("failed to join WFM profile refresh task: {error}"))?
}

fn sign_in_inner(input: &TradeSignInInput) -> Result<StoredTradeSession> {
    let client = shared_wfm_client()?;
    let trimmed_email = input.email.trim();
    let trimmed_password = input.password.trim();
    if trimmed_email.is_empty() || trimmed_password.is_empty() {
        return Err(anyhow!("Enter both your Warframe Market email and password."));
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

    for order in orders.into_iter().filter(|entry| entry.order_type == "sell") {
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
        return Err(anyhow!("Price and quantity must both be greater than zero."));
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
        return Err(anyhow!("Price and quantity must both be greater than zero."));
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

async fn update_trade_status_inner(
    app: tauri::AppHandle,
    input: TradeStatusInput,
) -> Result<TradeSessionState> {
    let session = ensure_authenticated_session(&app)?;
    let desired_status = normalize_status_command(&input.status)?;

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
            "token": session.token,
            "deviceId": session.device_id,
        })),
        id: Some(auth_request_id.clone()),
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

    let mut authenticated = false;
    let mut status_updated = false;
    let status_request_id = uuid::Uuid::new_v4().to_string();

    let websocket_result: Result<()> = timeout(Duration::from_secs(10), async {
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
                if route == "cmd/auth/signIn:ok"
                    || payload.ref_id.as_deref() == Some(auth_request_id.as_str())
                {
                    authenticated = true;
                    let status_message = WfmWsMessage {
                        route: "@wfm|cmd/status/set".to_string(),
                        payload: Some(json!({ "status": desired_status })),
                        id: Some(status_request_id.clone()),
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

            if route == "cmd/status/set:error" {
                let reason = payload
                    .payload
                    .as_ref()
                    .and_then(|value| value.get("reason"))
                    .and_then(Value::as_str)
                    .unwrap_or("status update failed");
                return Err(anyhow!(reason.to_string()));
            }

            if route == "cmd/status/set:ok" || payload.ref_id.as_deref() == Some(status_request_id.as_str()) {
                status_updated = true;
                break;
            }

            // WFM also emits the current presence as an event. Accept that as success
            // when it confirms the requested state, instead of waiting indefinitely.
            if route == "event/status/set"
                && payload
                    .payload
                    .as_ref()
                    .and_then(|value| value.get("status"))
                    .and_then(Value::as_str)
                    == Some(desired_status)
            {
                status_updated = true;
                break;
            }
        }

        Ok(())
    })
    .await
    .context("timed out while waiting for WFM status update")?;

    websocket_result?;

    if !status_updated {
        return Err(anyhow!("status update did not complete"));
    }

    // Refresh until the server reports the status we just requested, but fall back
    // to the server's current view instead of inventing a local optimistic state.
    let mut latest_account = fetch_me_with_token_async(session.token.clone()).await?;
    for _attempt in 0..5 {
        if desired_status_matches_account(desired_status, &latest_account.status) {
            break;
        }
        sleep(Duration::from_millis(350)).await;
        latest_account = fetch_me_with_token_async(session.token.clone()).await?;
    }

    let updated_session = StoredTradeSession {
        account: latest_account.clone(),
        ..session
    };
    save_session(&app, &updated_session)?;

    Ok(TradeSessionState {
        connected: true,
        account: Some(latest_account),
    })
}

#[tauri::command]
pub async fn get_wfm_trade_session_state(app: tauri::AppHandle) -> Result<TradeSessionState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match ensure_authenticated_session(&app) {
            Ok(session) => Ok(TradeSessionState {
                connected: true,
                account: Some(session.account),
            }),
            Err(_) => Ok(TradeSessionState {
                connected: false,
                account: None,
            }),
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())
}

#[tauri::command]
pub async fn sign_in_wfm_trade_account(
    app: tauri::AppHandle,
    input: TradeSignInInput,
) -> Result<TradeSessionState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = sign_in_inner(&input)?;
        save_session(&app, &session)?;
        Ok(TradeSessionState {
            connected: true,
            account: Some(session.account),
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())
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
    tauri::async_runtime::spawn_blocking(move || build_trade_overview_inner(&app, seller_mode.trim()))
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

#[tauri::command]
pub async fn update_wfm_trade_status(
    app: tauri::AppHandle,
    input: TradeStatusInput,
) -> Result<TradeSessionState, String> {
    update_trade_status_inner(app, input)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_avatar_url;

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
}
