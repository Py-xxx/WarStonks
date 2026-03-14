use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::blocking::Client;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

const SETTINGS_DIR_NAME: &str = "settings";
const SETTINGS_FILE_NAME: &str = "integrations.json";
const ALECAFRAME_BASE_URL: &str = "https://stats.alecaframe.com";
const ALECAFRAME_PUBLIC_STATS_PATH: &str = "/api/stats/public";
const ALECAFRAME_RELIC_INVENTORY_PATH: &str = "/api/stats/public/getRelicInventory";
const ALECAFRAME_USER_AGENT: &str = "warstonks/3.0.0";
const HTTP_TIMEOUT_SECONDS: u64 = 30;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyBalance {
    pub platinum: Option<i64>,
    pub credits: Option<i64>,
    pub endo: Option<i64>,
    pub ducats: Option<i64>,
    pub aya: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeSettings {
    pub enabled: bool,
    pub public_link: Option<String>,
    pub username_when_public: Option<String>,
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordWebhookSettings {
    pub enabled: bool,
    pub webhook_url: Option<String>,
    #[serde(default)]
    pub notifications: DiscordWebhookNotificationSettings,
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DiscordWebhookNotificationSettings {
    pub watchlist_found: bool,
    pub trade_detected: bool,
    pub worldstate_offline: bool,
}

impl Default for DiscordWebhookNotificationSettings {
    fn default() -> Self {
        Self {
            watchlist_found: true,
            trade_detected: true,
            worldstate_offline: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub warstonks_version: Option<String>,
    pub alecaframe: AlecaframeSettings,
    pub discord_webhook: DiscordWebhookSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeSettingsInput {
    pub enabled: bool,
    pub public_link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordWebhookSettingsInput {
    pub enabled: bool,
    pub webhook_url: Option<String>,
    #[serde(default)]
    pub notifications: DiscordWebhookNotificationSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeValidationResult {
    pub valid: bool,
    pub normalized_public_link: String,
    pub public_token: String,
    pub username_when_public: Option<String>,
    pub last_update: Option<String>,
    pub balances: CurrencyBalance,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletSnapshot {
    pub enabled: bool,
    pub configured: bool,
    pub balances: CurrencyBalance,
    pub username_when_public: Option<String>,
    pub last_update: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordWatchlistNotificationInput {
    pub item_name: String,
    pub item_slug: String,
    pub item_image_path: Option<String>,
    pub target_price: i64,
    pub current_price: i64,
    pub username: String,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub order_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordTradeNotificationItem {
    pub item_name: String,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub image_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordTradeDetectedNotificationInput {
    pub source: String,
    pub order_type: String,
    pub total_platinum: i64,
    pub closed_at: String,
    pub summary_label: String,
    pub items: Vec<DiscordTradeNotificationItem>,
}

#[derive(Debug, Clone)]
pub(crate) struct AlecaframeRelicInventoryEntry {
    pub tier: String,
    pub code: String,
    pub refinement: String,
    pub count: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlecaframePublicStatsResponse {
    #[serde(default)]
    general_data_points: Vec<AlecaframeDataPoint>,
    last_update: Option<String>,
    username_when_public: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlecaframeDataPoint {
    ts: Option<String>,
    plat: Option<i64>,
    credits: Option<i64>,
    endo: Option<i64>,
    ducats: Option<i64>,
    aya: Option<i64>,
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn compare_optional_timestamps(left: Option<&str>, right: Option<&str>) -> Ordering {
    left.cmp(&right)
}

fn select_latest_data_point(data_points: &[AlecaframeDataPoint]) -> Option<&AlecaframeDataPoint> {
    data_points
        .iter()
        .max_by(|left, right| compare_optional_timestamps(left.ts.as_deref(), right.ts.as_deref()))
}

fn map_currency_balance(data_point: &AlecaframeDataPoint) -> CurrencyBalance {
    CurrencyBalance {
        platinum: data_point.plat,
        credits: data_point.credits,
        endo: data_point.endo,
        ducats: data_point.ducats,
        aya: data_point.aya,
    }
}

fn build_settings_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve the app data directory")?;
    Ok(app_data_dir
        .join(SETTINGS_DIR_NAME)
        .join(SETTINGS_FILE_NAME))
}

fn load_settings_from_path(path: &Path) -> Result<AppSettings> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read settings file at {}", path.display()))?;

    if raw.trim().is_empty() {
        return Ok(AppSettings::default());
    }

    serde_json::from_str::<AppSettings>(&raw)
        .with_context(|| format!("failed to parse settings file at {}", path.display()))
}

fn save_settings_to_path(path: &Path, settings: &AppSettings) -> Result<()> {
    if let Some(parent_dir) = path.parent() {
        fs::create_dir_all(parent_dir).with_context(|| {
            format!(
                "failed to create settings directory {}",
                parent_dir.display()
            )
        })?;
    }

    let mut updated = settings.clone();
    updated.warstonks_version = Some(env!("CARGO_PKG_VERSION").to_string());
    let serialized =
        serde_json::to_string_pretty(&updated).context("failed to serialize app settings")?;
    fs::write(path, serialized)
        .with_context(|| format!("failed to write settings file at {}", path.display()))
}

pub(crate) fn load_settings_inner(app: &tauri::AppHandle) -> Result<AppSettings> {
    let path = build_settings_path(app)?;
    load_settings_from_path(&path)
}

pub(crate) fn load_settings_for_internal_use(app: &tauri::AppHandle) -> Result<AppSettings> {
    load_settings_inner(app)
}

fn save_settings_inner(app: &tauri::AppHandle, settings: &AppSettings) -> Result<()> {
    let path = build_settings_path(app)?;
    save_settings_to_path(&path, settings)
}

fn normalize_optional_webhook_url(value: Option<String>) -> Option<String> {
    normalize_optional(value)
}

fn validate_discord_webhook_url(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Enter a Discord webhook URL."));
    }

    let parsed = Url::parse(trimmed).context("Enter a valid Discord webhook URL.")?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("Enter a valid Discord webhook URL."))?;
    let normalized_host = host.to_ascii_lowercase();
    if normalized_host != "discord.com" && normalized_host != "discordapp.com" {
        return Err(anyhow!("Webhook URL must point to Discord."));
    }

    if !parsed.path().contains("/api/webhooks/") {
        return Err(anyhow!("Webhook URL must be a Discord webhook endpoint."));
    }

    Ok(parsed.to_string())
}

fn post_discord_webhook_payload(webhook_url: &str, payload: serde_json::Value) -> Result<()> {
    let client = Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .build()
        .context("failed to construct Discord webhook client")?;

    client
        .post(webhook_url)
        .header("User-Agent", ALECAFRAME_USER_AGENT)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .context("failed to send Discord webhook request")?
        .error_for_status()
        .context("Discord webhook request failed")?;

    Ok(())
}

fn build_wfm_asset_url(asset_path: Option<&str>) -> Option<String> {
    let trimmed = asset_path?.trim();
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
}

fn build_discord_test_payload() -> serde_json::Value {
    json!({
      "username": "WarStonks",
      "embeds": [{
        "title": "🧪 WarStonks Discord Webhook Connected",
        "description": "Your Discord webhook is active and ready to receive WarStonks alerts.",
        "color": 0x3D7BFF,
        "fields": [
          { "name": "Notification Type", "value": "Test Notification", "inline": true },
          { "name": "Source", "value": "Settings Save", "inline": true }
        ],
        "footer": { "text": "WarStonks • Discord integration" }
      }]
    })
}

fn build_watchlist_found_payload(input: &DiscordWatchlistNotificationInput) -> serde_json::Value {
    let rank_value = input
        .rank
        .map(|value| value.to_string())
        .unwrap_or_else(|| "—".to_string());
    let image_url = build_wfm_asset_url(input.item_image_path.as_deref());

    json!({
      "username": "WarStonks",
      "embeds": [{
        "title": "🔔 Watchlist Hit",
        "description": format!("{} is now at or below your target price.", input.item_name),
        "color": 0x3DD68C,
        "thumbnail": image_url.as_ref().map(|url| json!({ "url": url })),
        "fields": [
          { "name": "Item", "value": input.item_name, "inline": true },
          { "name": "Seller", "value": input.username, "inline": true },
          { "name": "Current Price", "value": format!("{}p", input.current_price), "inline": true },
          { "name": "Desired Price", "value": format!("{}p", input.target_price), "inline": true },
          { "name": "Gap", "value": format!("{}p", input.target_price - input.current_price), "inline": true },
          { "name": "Quantity", "value": input.quantity.to_string(), "inline": true },
          { "name": "Rank", "value": rank_value, "inline": true },
          { "name": "Order", "value": input.order_id, "inline": false }
        ],
        "footer": { "text": "WarStonks • Watchlist alert" },
        "timestamp": input.created_at
      }]
    })
}

fn build_trade_detected_payload(
    input: &DiscordTradeDetectedNotificationInput,
) -> serde_json::Value {
    let order_type_label = if input.order_type.eq_ignore_ascii_case("buy") {
        "Buy"
    } else {
        "Sell"
    };
    let title_icon = if input.order_type.eq_ignore_ascii_case("buy") {
        "🛒"
    } else {
        "💸"
    };
    let source_label = if input.source.eq_ignore_ascii_case("wfm") {
        "Warframe Market"
    } else {
        "Alecaframe"
    };
    let image_url = input
        .items
        .iter()
        .find_map(|item| build_wfm_asset_url(item.image_path.as_deref()));
    let item_lines = input
        .items
        .iter()
        .map(|item| {
            let rank_suffix = item
                .rank
                .map(|rank| format!(" · Rank {rank}"))
                .unwrap_or_default();
            format!(
                "• {} x{}{}",
                item.item_name,
                item.quantity.max(1),
                rank_suffix
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    json!({
      "username": "WarStonks",
      "embeds": [{
        "title": format!("{title_icon} New {order_type_label} Trade Detected"),
        "description": input.summary_label,
        "color": if input.order_type.eq_ignore_ascii_case("buy") { 0x3D7BFF } else { 0x3DD68C },
        "thumbnail": image_url.as_ref().map(|url| json!({ "url": url })),
        "fields": [
          { "name": "Trade Type", "value": order_type_label, "inline": true },
          { "name": "Source", "value": source_label, "inline": true },
          { "name": "Price", "value": format!("{}p", input.total_platinum), "inline": true },
          { "name": if input.order_type.eq_ignore_ascii_case("buy") { "Items Received" } else { "Items Given" }, "value": item_lines, "inline": false }
        ],
        "footer": { "text": "WarStonks • Trade detection" },
        "timestamp": input.closed_at
      }]
    })
}

pub(crate) fn extract_public_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if !trimmed.contains("://") {
        return Some(trimmed.to_string());
    }

    let parsed = Url::parse(trimmed).ok()?;

    for (key, candidate) in parsed.query_pairs() {
        if key == "token" || key == "publicToken" {
            let token = candidate.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }

    parsed
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .map(|segment| segment.trim().to_string())
        .filter(|segment| !segment.is_empty())
}

fn build_public_link(public_token: &str) -> String {
    let mut url = Url::parse(&format!(
        "{ALECAFRAME_BASE_URL}{ALECAFRAME_PUBLIC_STATS_PATH}"
    ))
    .expect("Alecaframe base URL should be valid");
    url.query_pairs_mut().append_pair("token", public_token);
    url.to_string()
}

fn build_alecaframe_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .build()
        .context("failed to construct Alecaframe client")
}

fn fetch_public_stats(public_token: &str) -> Result<AlecaframePublicStatsResponse> {
    let client = build_alecaframe_client()?;

    client
        .get(format!(
            "{ALECAFRAME_BASE_URL}{ALECAFRAME_PUBLIC_STATS_PATH}"
        ))
        .query(&[("token", public_token)])
        .header("User-Agent", ALECAFRAME_USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .context("failed to request Alecaframe public stats")?
        .error_for_status()
        .context("Alecaframe public stats request failed")?
        .json::<AlecaframePublicStatsResponse>()
        .context("failed to parse Alecaframe public stats response")
}

fn relic_tier_label(value: u8) -> Result<&'static str> {
    match value {
        0 => Ok("Lith"),
        1 => Ok("Meso"),
        2 => Ok("Neo"),
        3 => Ok("Axi"),
        4 => Ok("Requiem"),
        _ => Err(anyhow!("Unknown relic tier value: {value}")),
    }
}

fn relic_refinement_key(value: u8) -> Result<&'static str> {
    match value {
        0 => Ok("intact"),
        1 | 4 => Ok("exceptional"),
        2 | 5 => Ok("flawless"),
        3 | 6 => Ok("radiant"),
        _ => Err(anyhow!("Unknown relic refinement value: {value}")),
    }
}

fn parse_alecaframe_relic_inventory(payload: &[u8]) -> Result<Vec<AlecaframeRelicInventoryEntry>> {
    if payload.len() < 4 {
        return Err(anyhow!(
            "Alecaframe relic inventory payload is too short to read the entry count."
        ));
    }

    let entry_count = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    let expected_len = 4usize.saturating_add(entry_count.saturating_mul(9));
    if payload.len() < expected_len {
        return Err(anyhow!(
            "Alecaframe relic inventory payload is incomplete (expected at least {expected_len} bytes)."
        ));
    }

    let mut entries = Vec::with_capacity(entry_count);
    let mut offset = 4;
    for _ in 0..entry_count {
        let relic_type = payload[offset];
        let refinement = payload[offset + 1];
        let code_slice = &payload[offset + 2..offset + 5];
        let count = u32::from_le_bytes([
            payload[offset + 5],
            payload[offset + 6],
            payload[offset + 7],
            payload[offset + 8],
        ]);
        offset += 9;

        let code = String::from_utf8_lossy(code_slice)
            .trim_matches('\u{0}')
            .trim()
            .to_string();
        if code.is_empty() {
            return Err(anyhow!("Alecaframe relic inventory entry has an empty relic code."));
        }

        entries.push(AlecaframeRelicInventoryEntry {
            tier: relic_tier_label(relic_type)?.to_string(),
            code,
            refinement: relic_refinement_key(refinement)?.to_string(),
            count,
        });
    }

    Ok(entries)
}

fn decode_alecaframe_relic_inventory_payload(payload: &[u8]) -> Result<Vec<u8>> {
    let trimmed = payload
        .iter()
        .skip_while(|byte| byte.is_ascii_whitespace())
        .copied()
        .collect::<Vec<u8>>();

    if trimmed.is_empty() {
        return Err(anyhow!(
            "Alecaframe relic inventory payload was empty."
        ));
    }

    if trimmed[0] == b'{' || trimmed[0] == b'[' || trimmed[0] == b'"' {
        let parsed = serde_json::from_slice::<serde_json::Value>(&trimmed)
            .context("failed to parse Alecaframe relic inventory JSON payload")?;
        if let Some(raw_string) = parsed.as_str() {
            let decoded = BASE64_STANDARD
                .decode(raw_string.trim())
                .context("failed to decode Alecaframe relic inventory base64 payload")?;
            return Ok(decoded);
        }
        if let Some(raw_string) = parsed.get("rawBase64").and_then(|value| value.as_str()) {
            let decoded = BASE64_STANDARD
                .decode(raw_string.trim())
                .context("failed to decode Alecaframe relic inventory base64 payload")?;
            return Ok(decoded);
        }
        return Err(anyhow!(
            "Alecaframe relic inventory JSON payload did not contain a base64 inventory string."
        ));
    }

    Ok(payload.to_vec())
}

pub(crate) fn fetch_alecaframe_relic_inventory(
    public_token: &str,
) -> Result<Vec<AlecaframeRelicInventoryEntry>> {
    let client = build_alecaframe_client()?;
    let response = client
        .get(format!(
            "{ALECAFRAME_BASE_URL}{ALECAFRAME_RELIC_INVENTORY_PATH}"
        ))
        .query(&[("publicToken", public_token)])
        .header("User-Agent", ALECAFRAME_USER_AGENT)
        .header("Accept", "application/octet-stream")
        .send()
        .context("failed to request Alecaframe relic inventory")?
        .error_for_status()
        .context("Alecaframe relic inventory request failed")?;
    let payload = response
        .bytes()
        .context("failed to read Alecaframe relic inventory payload")?;
    let decoded = decode_alecaframe_relic_inventory_payload(payload.as_ref())?;
    parse_alecaframe_relic_inventory(&decoded)
}

fn validate_public_link_inner(public_link: String) -> Result<AlecaframeValidationResult> {
    let normalized_public_link_input = normalize_optional(Some(public_link))
        .ok_or_else(|| anyhow!("Enter an Alecaframe public link or public token."))?;
    let public_token = extract_public_token(&normalized_public_link_input)
        .ok_or_else(|| anyhow!("Could not extract a public token from the Alecaframe value."))?;
    let payload = fetch_public_stats(&public_token)?;
    let latest_data_point = select_latest_data_point(&payload.general_data_points)
        .ok_or_else(|| anyhow!("Alecaframe did not return any wallet data points."))?;

    Ok(AlecaframeValidationResult {
        valid: true,
        normalized_public_link: build_public_link(&public_token),
        public_token,
        username_when_public: payload.username_when_public,
        last_update: payload.last_update,
        balances: map_currency_balance(latest_data_point),
    })
}

#[tauri::command]
pub fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    load_settings_inner(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn test_alecaframe_public_link(
    public_link: String,
) -> Result<AlecaframeValidationResult, String> {
    validate_public_link_inner(public_link).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_alecaframe_settings(
    app: tauri::AppHandle,
    input: AlecaframeSettingsInput,
) -> Result<AppSettings, String> {
    let mut settings = load_settings_inner(&app).map_err(|error| error.to_string())?;
    let trimmed_public_link = normalize_optional(input.public_link);

    let validation_result = match trimmed_public_link.clone() {
        Some(public_link) => Some(
            validate_public_link_inner(public_link)
                .map_err(|error| format!("Could not save Alecaframe settings: {error}"))?,
        ),
        None => None,
    };

    if input.enabled && validation_result.is_none() {
        return Err("Enter a valid Alecaframe public link before enabling the API.".to_string());
    }

    settings.alecaframe = AlecaframeSettings {
        enabled: input.enabled,
        public_link: validation_result
            .as_ref()
            .map(|result| result.normalized_public_link.clone()),
        username_when_public: validation_result
            .as_ref()
            .and_then(|result| result.username_when_public.clone()),
        last_validated_at: validation_result
            .as_ref()
            .and_then(|result| result.last_update.clone()),
    };

    save_settings_inner(&app, &settings).map_err(|error| error.to_string())?;

    Ok(settings)
}

#[tauri::command]
pub fn save_discord_webhook_settings(
    app: tauri::AppHandle,
    input: DiscordWebhookSettingsInput,
) -> Result<AppSettings, String> {
    let mut settings = load_settings_inner(&app).map_err(|error| error.to_string())?;
    let normalized_webhook_url = normalize_optional_webhook_url(input.webhook_url);

    let validated_webhook_url = match normalized_webhook_url {
        Some(url) => Some(
            validate_discord_webhook_url(&url)
                .map_err(|error| format!("Could not save Discord webhook settings: {error}"))?,
        ),
        None => None,
    };

    if input.enabled && validated_webhook_url.is_none() {
        return Err(
            "Enter a valid Discord webhook URL before enabling Discord notifications.".to_string(),
        );
    }

    if let Some(webhook_url) = validated_webhook_url.as_deref() {
        post_discord_webhook_payload(webhook_url, build_discord_test_payload())
            .map_err(|error| format!("Discord webhook test failed: {error}"))?;
    }

    settings.discord_webhook = DiscordWebhookSettings {
        enabled: input.enabled,
        webhook_url: validated_webhook_url,
        notifications: input.notifications,
        last_validated_at: Some(
            time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        ),
    };

    save_settings_inner(&app, &settings).map_err(|error| error.to_string())?;

    Ok(settings)
}

pub(crate) fn send_watchlist_found_discord_notification_inner(
    app: &tauri::AppHandle,
    input: &DiscordWatchlistNotificationInput,
) -> Result<bool> {
    let settings = load_settings_inner(app)?;
    let discord = settings.discord_webhook;
    if !discord.enabled || !discord.notifications.watchlist_found {
        return Ok(false);
    }
    let Some(webhook_url) = discord.webhook_url else {
        return Ok(false);
    };

    post_discord_webhook_payload(&webhook_url, build_watchlist_found_payload(input))?;
    Ok(true)
}

pub(crate) fn send_trade_detected_discord_notification_inner(
    app: &tauri::AppHandle,
    input: &DiscordTradeDetectedNotificationInput,
) -> Result<bool> {
    let settings = load_settings_inner(app)?;
    let discord = settings.discord_webhook;
    if !discord.enabled || !discord.notifications.trade_detected {
        return Ok(false);
    }
    let Some(webhook_url) = discord.webhook_url else {
        return Ok(false);
    };

    post_discord_webhook_payload(&webhook_url, build_trade_detected_payload(input))?;
    Ok(true)
}

#[tauri::command]
pub fn send_watchlist_found_discord_notification(
    app: tauri::AppHandle,
    input: DiscordWatchlistNotificationInput,
) -> Result<bool, String> {
    send_watchlist_found_discord_notification_inner(&app, &input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_currency_balances(app: tauri::AppHandle) -> Result<WalletSnapshot, String> {
    let settings = load_settings_inner(&app).map_err(|error| error.to_string())?;
    let alecaframe_settings = settings.alecaframe;

    if !alecaframe_settings.enabled {
        return Ok(WalletSnapshot::default());
    }

    let Some(public_link) = alecaframe_settings.public_link else {
        return Ok(WalletSnapshot {
            enabled: true,
            configured: false,
            error_message: Some(
                "Alecaframe is enabled but no public link is configured.".to_string(),
            ),
            ..WalletSnapshot::default()
        });
    };

    match validate_public_link_inner(public_link) {
        Ok(result) => Ok(WalletSnapshot {
            enabled: true,
            configured: true,
            balances: result.balances,
            username_when_public: result.username_when_public,
            last_update: result.last_update,
            error_message: None,
        }),
        Err(error) => Ok(WalletSnapshot {
            enabled: true,
            configured: true,
            error_message: Some(error.to_string()),
            ..WalletSnapshot::default()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        extract_public_token, load_settings_from_path, map_currency_balance,
        decode_alecaframe_relic_inventory_payload, parse_alecaframe_relic_inventory,
        save_settings_to_path, select_latest_data_point, AlecaframeDataPoint, AlecaframeSettings,
        AppSettings, DiscordWebhookNotificationSettings, DiscordWebhookSettings,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_settings_path() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("warstonks-settings-{suffix}.json"))
    }

    #[test]
    fn extracts_token_from_raw_value() {
        assert_eq!(extract_public_token("abc123"), Some("abc123".to_string()));
    }

    #[test]
    fn extracts_token_from_public_url_query() {
        let input = "https://stats.alecaframe.com/api/stats/public?token=query-token";
        assert_eq!(extract_public_token(input), Some("query-token".to_string()));
    }

    #[test]
    fn extracts_token_from_public_url_path() {
        let input = "https://example.com/public-links/path-token";
        assert_eq!(extract_public_token(input), Some("path-token".to_string()));
    }

    #[test]
    fn latest_data_point_prefers_newest_timestamp() {
        let points = vec![
            AlecaframeDataPoint {
                ts: Some("2026-03-10T13:14:57.761Z".to_string()),
                plat: Some(100),
                credits: Some(200),
                endo: Some(300),
                ducats: Some(400),
                aya: Some(500),
            },
            AlecaframeDataPoint {
                ts: Some("2026-03-11T13:14:57.761Z".to_string()),
                plat: Some(999),
                credits: Some(888),
                endo: Some(777),
                ducats: Some(666),
                aya: Some(555),
            },
        ];

        let latest = select_latest_data_point(&points).expect("latest point should exist");
        let balance = map_currency_balance(latest);

        assert_eq!(balance.platinum, Some(999));
        assert_eq!(balance.credits, Some(888));
        assert_eq!(balance.endo, Some(777));
        assert_eq!(balance.ducats, Some(666));
        assert_eq!(balance.aya, Some(555));
    }

    #[test]
    fn settings_round_trip_uses_json_file() {
        let path = temp_settings_path();
        let settings = AppSettings {
            warstonks_version: None,
            alecaframe: AlecaframeSettings {
                enabled: true,
                public_link: Some(
                    "https://stats.alecaframe.com/api/stats/public?token=abc123".to_string(),
                ),
                username_when_public: Some("py".to_string()),
                last_validated_at: Some("2026-03-10T13:14:57.761Z".to_string()),
            },
            discord_webhook: DiscordWebhookSettings {
                enabled: false,
                webhook_url: None,
                notifications: DiscordWebhookNotificationSettings::default(),
                last_validated_at: None,
            },
        };

        save_settings_to_path(&path, &settings).expect("settings should save");
        let loaded = load_settings_from_path(&path).expect("settings should load");
        fs::remove_file(&path).ok();

        assert!(loaded.alecaframe.enabled);
        assert_eq!(
            loaded.alecaframe.public_link,
            settings.alecaframe.public_link
        );
        assert_eq!(
            loaded.alecaframe.username_when_public,
            settings.alecaframe.username_when_public
        );
    }

    #[test]
    fn parses_alecaframe_relic_inventory_payload() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&2u32.to_le_bytes());
        payload.push(0);
        payload.push(0);
        payload.extend_from_slice(b"D7 ");
        payload.extend_from_slice(&3u32.to_le_bytes());
        payload.push(2);
        payload.push(4);
        payload.extend_from_slice(b"G1\0");
        payload.extend_from_slice(&12u32.to_le_bytes());

        let entries = parse_alecaframe_relic_inventory(&payload).expect("parse relic inventory");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].tier, "Lith");
        assert_eq!(entries[0].code, "D7");
        assert_eq!(entries[0].refinement, "intact");
        assert_eq!(entries[0].count, 3);
        assert_eq!(entries[1].tier, "Neo");
        assert_eq!(entries[1].code, "G1");
        assert_eq!(entries[1].refinement, "exceptional");
        assert_eq!(entries[1].count, 12);
    }

    #[test]
    fn decodes_base64_wrapped_relic_payloads() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1u32.to_le_bytes());
        payload.push(1);
        payload.push(3);
        payload.extend_from_slice(b"A1 ");
        payload.extend_from_slice(&7u32.to_le_bytes());
        let encoded = BASE64_STANDARD.encode(&payload);
        let wrapped = format!("\"{}\"", encoded);

        let decoded =
            decode_alecaframe_relic_inventory_payload(wrapped.as_bytes()).expect("decode payload");
        let entries = parse_alecaframe_relic_inventory(&decoded).expect("parse inventory");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].tier, "Meso");
        assert_eq!(entries[0].code, "A1");
        assert_eq!(entries[0].refinement, "radiant");
        assert_eq!(entries[0].count, 7);
    }
}
