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
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

use crate::error_log::log_feature_error_best_effort;

const SETTINGS_DIR_NAME: &str = "settings";
const SETTINGS_FILE_NAME: &str = "integrations.json";
const ALECAFRAME_BASE_URL: &str = "https://stats.alecaframe.com";
const ALECAFRAME_PUBLIC_STATS_PATH: &str = "/api/stats/public";
const ALECAFRAME_RELIC_INVENTORY_PATH: &str = "/api/stats/public/getRelicInventory";
const ALECAFRAME_USER_AGENT: &str = concat!("warstonks/", env!("CARGO_PKG_VERSION"));
const HTTP_TIMEOUT_SECONDS: u64 = 30;

fn build_support_error_message(summary: &str) -> String {
    format!("{summary} If it keeps happening, report it in Discord.")
}

fn log_settings_error_and_build_message(
    app: &tauri::AppHandle,
    feature: &str,
    stage: &str,
    detail: &str,
    summary: &str,
    _reference_code: &str,
    error: &anyhow::Error,
) -> String {
    log_feature_error_best_effort(app, feature, stage, detail, error);
    build_support_error_message(summary)
}

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
    pub underpriced_listing: bool,
    /// Smart Manage auto price changes (and preview intents).
    pub price_change: bool,
    /// Proactive "listings need action" alert (reprice / outbid).
    #[serde(default = "default_true")]
    pub listing_health: bool,
    /// Scanner data has gone stale.
    #[serde(default = "default_true")]
    pub scanner_stale: bool,
    /// A new app version is available.
    #[serde(default = "default_true")]
    pub app_update: bool,
}

fn default_true() -> bool {
    true
}

impl Default for DiscordWebhookNotificationSettings {
    fn default() -> Self {
        Self {
            watchlist_found: true,
            trade_detected: true,
            underpriced_listing: true,
            price_change: true,
            listing_health: true,
            scanner_stale: true,
            app_update: true,
        }
    }
}

/// Tunables for the Opportunities engine's Set Decision Engine, edited on the Strategy tab.
/// Global config for Smart Manage — optional auto-repricing of your sell listings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SmartManageSettings {
    /// Master switch. When on, new listings default to auto-managed; when off, auto only runs
    /// for listings you individually opt in.
    pub enabled: bool,
    /// "conservative" | "balanced" | "aggressive" — profit-vs-speed trade-off.
    pub aggressiveness: String,
    /// Percent of margin to keep above cost when the cost floor applies.
    pub min_margin_pct: f64,
    /// Max auto price-changes per listing per day.
    pub max_changes_per_day: i64,
    /// Minimum minutes between auto changes on the same listing.
    pub min_interval_minutes: i64,
}

impl Default for SmartManageSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            aggressiveness: "balanced".to_string(),
            min_margin_pct: 0.0,
            max_changes_per_day: 8,
            min_interval_minutes: 10,
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
    #[serde(default)]
    pub smart_manage: SmartManageSettings,
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
pub struct DiscordUnderpricedNotificationInput {
    pub item_name: String,
    pub item_slug: String,
    pub listed_price: i64,
    pub recommended_price: i64,
    pub pct_below: i64,
    pub username: String,
    pub rank: Option<i64>,
    pub order_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordListingHealthNotificationInput {
    /// How many listings currently need action (reprice / outbid).
    pub count: i64,
    /// A few of the worst offenders, worst first, for the embed body.
    pub examples: Vec<DiscordListingHealthItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordListingHealthItem {
    pub item_name: String,
    pub your_price: i64,
    pub market_low: Option<i64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordScannerStaleNotificationInput {
    /// Which scanner went stale (e.g. "Underpriced radar").
    pub scanner_name: String,
    /// Minutes since the last successful scan, if known.
    pub minutes_stale: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordAppUpdateNotificationInput {
    pub version: String,
    pub current_version: Option<String>,
    pub notes: Option<String>,
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

/// Returns the saved settings with secrets stripped, for inclusion in a data export.
/// The Discord webhook URL and Alecaframe link are removed so the export is safe to share.
pub(crate) fn export_settings_stripped(app: &tauri::AppHandle) -> Result<AppSettings> {
    let path = build_settings_path(app)?;
    let mut settings = load_settings_from_path(&path)?;
    settings.discord_webhook.webhook_url = None;
    settings.discord_webhook.last_validated_at = None;
    settings.alecaframe.public_link = None;
    settings.alecaframe.username_when_public = None;
    settings.alecaframe.last_validated_at = None;
    Ok(settings)
}

/// Applies imported settings (enabled flags + Discord notification toggles) while preserving
/// the existing secrets (webhook URL, Alecaframe link), which are never part of an export.
pub(crate) fn import_settings_preserving_secrets(
    app: &tauri::AppHandle,
    imported: &AppSettings,
) -> Result<()> {
    let path = build_settings_path(app)?;
    let mut current = load_settings_from_path(&path)?;
    // Only re-enable an integration if its secret (which is never exported) is present locally,
    // so we never leave an integration "enabled" with no URL/link that would silently do nothing.
    current.alecaframe.enabled = imported.alecaframe.enabled && current.alecaframe.public_link.is_some();
    current.discord_webhook.enabled =
        imported.discord_webhook.enabled && current.discord_webhook.webhook_url.is_some();
    current.discord_webhook.notifications = imported.discord_webhook.notifications.clone();
    save_settings_to_path(&path, &current)
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
    write_string_atomically(path, &serialized)
        .with_context(|| format!("failed to write settings file at {}", path.display()))
}

/// Writes `contents` to `path` atomically: write a sibling temp file, then rename it over the
/// target. A crash mid-write leaves the previous file intact rather than a truncated/empty one.
/// Callers serialize writes via [`lock_settings_file`], so the fixed temp name can't collide.
fn write_string_atomically(path: &Path, contents: &str) -> Result<()> {
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, contents)
        .with_context(|| format!("failed to write temp file {}", tmp_path.display()))?;
    fs::rename(&tmp_path, path)
        .with_context(|| format!("failed to replace {}", path.display()))?;
    Ok(())
}

/// Serializes settings read-modify-write cycles. The two mutating commands
/// (`save_alecaframe_settings` / `save_discord_webhook_settings`) each touch a different
/// section; without this, two concurrent saves can interleave their load→modify→save and one
/// silently drops the other's section.
fn lock_settings_file() -> Result<std::sync::MutexGuard<'static, ()>> {
    static SETTINGS_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    SETTINGS_FILE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| anyhow!("settings file lock was poisoned"))
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

// ---- Shared embed styling ------------------------------------------------------------------
// Every WarStonks embed shares one visual language: a small author line, an accent color keyed
// to the alert category, a divider before the stat fields, and a footer that names the section.
// The builders below assemble that envelope so the alerts read as one coherent product.

/// WarStonks brand icon, hosted on the public marketing site so Discord can fetch it.
const DISCORD_BRAND_ICON: &str = "https://warstonks.app/icon.png";
const WARSTONKS_SITE: &str = "https://warstonks.app";

// Category accent colors, mirroring the in-app palette.
const COLOR_GREEN: u32 = 0x3D_D6_8C;
const COLOR_RED: u32 = 0xF0_4F_58;
const COLOR_AMBER: u32 = 0xF0_A0_30;
const COLOR_BLUE: u32 = 0x4A_9E_FF;
const COLOR_PURPLE: u32 = 0x8B_6F_FF;

/// The author block shown at the top of every embed — a consistent brand signature.
fn brand_author() -> serde_json::Value {
    json!({ "name": "WarStonks", "url": WARSTONKS_SITE, "icon_url": DISCORD_BRAND_ICON })
}

/// A footer naming the alert's section, with the brand mark.
fn brand_footer(section: &str) -> serde_json::Value {
    json!({ "text": format!("WarStonks · {section}"), "icon_url": DISCORD_BRAND_ICON })
}

/// A zero-width divider field, used to separate the description from the stat grid so the numbers
/// sit in their own visual band.
fn divider_field() -> serde_json::Value {
    json!({ "name": "\u{200b}", "value": "\u{200b}", "inline": false })
}

fn build_discord_test_payload() -> serde_json::Value {
    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": "✅ Webhook Connected",
        "description": "Your Discord webhook is live. Market alerts, trade detections, and Smart Manage updates will now arrive right here.",
        "color": COLOR_BLUE,
        "fields": [
          { "name": "Status", "value": "🟢 Active", "inline": true },
          { "name": "Source", "value": "Settings", "inline": true }
        ],
        "footer": brand_footer("Discord integration"),
        "timestamp": now_iso8601()
      }]
    })
}

/// Current time as an ISO-8601 string for embed timestamps.
fn now_iso8601() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn build_watchlist_found_payload(input: &DiscordWatchlistNotificationInput) -> serde_json::Value {
    let rank_value = input
        .rank
        .map(|value| value.to_string())
        .unwrap_or_else(|| "—".to_string());
    let image_url = build_wfm_asset_url(input.item_image_path.as_deref());

    let market_url = format!("https://warframe.market/items/{}", input.item_slug);
    let savings = (input.target_price - input.current_price).max(0);

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("🎯 {} hit your target", input.item_name),
        "url": market_url,
        "description": format!(
            "Now listed at **{}p** — that's **{}p** under your **{}p** target.",
            input.current_price, savings, input.target_price
        ),
        "color": COLOR_GREEN,
        "thumbnail": image_url.as_ref().map(|url| json!({ "url": url })),
        "fields": [
          { "name": "💰 Listed", "value": format!("**{}p**", input.current_price), "inline": true },
          { "name": "🎯 Target", "value": format!("{}p", input.target_price), "inline": true },
          { "name": "📉 You save", "value": format!("{}p", savings), "inline": true },
          { "name": "👤 Seller", "value": input.username, "inline": true },
          { "name": "📦 Qty", "value": input.quantity.to_string(), "inline": true },
          { "name": "🏅 Rank", "value": rank_value, "inline": true }
        ],
        "footer": brand_footer("Watchlist alert"),
        "timestamp": input.created_at
      }]
    })
}

fn build_underpriced_listing_payload(
    input: &DiscordUnderpricedNotificationInput,
) -> serde_json::Value {
    let rank_value = input
        .rank
        .map(|value| value.to_string())
        .unwrap_or_else(|| "—".to_string());
    let market_url = format!("https://warframe.market/items/{}", input.item_slug);

    let profit = (input.recommended_price - input.listed_price).max(0);

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("💸 {} is underpriced", input.item_name),
        "description": format!(
            "Listed at **{}p**, **{}%** below the **{}p** recommended price. Flip potential: **~{}p**.",
            input.listed_price, input.pct_below, input.recommended_price, profit
        ),
        "url": market_url,
        "color": COLOR_AMBER,
        "fields": [
          { "name": "🏷️ Listed", "value": format!("**{}p**", input.listed_price), "inline": true },
          { "name": "📊 Recommended", "value": format!("{}p", input.recommended_price), "inline": true },
          { "name": "📈 Upside", "value": format!("~{}p ({}%)", profit, input.pct_below), "inline": true },
          { "name": "👤 Seller", "value": input.username, "inline": true },
          { "name": "🏅 Rank", "value": rank_value, "inline": true }
        ],
        "footer": brand_footer("Underpriced radar"),
        "timestamp": now_iso8601()
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

    let is_buy = input.order_type.eq_ignore_ascii_case("buy");
    let items_label = if is_buy { "📥 Received" } else { "📤 Given" };
    let item_count: i64 = input.items.iter().map(|item| item.quantity.max(1)).sum();

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("{title_icon} {order_type_label} trade — {}p", input.total_platinum),
        "description": input.summary_label,
        "color": if is_buy { COLOR_BLUE } else { COLOR_GREEN },
        "thumbnail": image_url.as_ref().map(|url| json!({ "url": url })),
        "fields": [
          { "name": "💠 Platinum", "value": format!("**{}p**", input.total_platinum), "inline": true },
          { "name": "📦 Items", "value": item_count.to_string(), "inline": true },
          { "name": "🔗 Source", "value": source_label, "inline": true },
          divider_field(),
          { "name": items_label, "value": item_lines, "inline": false }
        ],
        "footer": brand_footer("Trade detection"),
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

/// Shared cache + failure backoff for the `/api/stats/public` endpoint. Both the wallet
/// snapshot and trade detection read this endpoint; without sharing, they each ran their own
/// polling stream and AlecaFrame started shedding us with 503s. The cache also enforces a
/// cooldown after failures (honoring Retry-After, exponential otherwise) so an unhealthy or
/// rate-limiting server is left alone instead of hammered on the next poll tick.
struct AlecaframeStatsState {
    token: String,
    body: std::sync::Arc<String>,
    fetched_at: std::time::Instant,
}

#[derive(Default)]
struct AlecaframeStatsGuard {
    cache: Option<AlecaframeStatsState>,
    consecutive_failures: u32,
    cooldown_until: Option<std::time::Instant>,
}

fn alecaframe_stats_guard() -> &'static Mutex<AlecaframeStatsGuard> {
    static GUARD: OnceLock<Mutex<AlecaframeStatsGuard>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(AlecaframeStatsGuard::default()))
}

const ALECAFRAME_BACKOFF_BASE_SECONDS: u64 = 30;
const ALECAFRAME_BACKOFF_CAP_SECONDS: u64 = 600;

/// Fetch the raw public-stats body, serving a cached copy when it is younger than `max_age`.
/// Holding the guard lock across the HTTP call is deliberate: concurrent callers (wallet poll
/// + trade detection) coalesce onto one request instead of racing.
pub(crate) fn fetch_public_stats_body_cached(
    public_token: &str,
    max_age: Duration,
) -> Result<std::sync::Arc<String>> {
    let mut guard = alecaframe_stats_guard()
        .lock()
        .map_err(|_| anyhow!("Alecaframe stats cache lock poisoned"))?;
    let now = std::time::Instant::now();

    if let Some(cache) = &guard.cache {
        if cache.token == public_token && now.duration_since(cache.fetched_at) <= max_age {
            return Ok(cache.body.clone());
        }
    }

    if let Some(until) = guard.cooldown_until {
        if until > now {
            let remaining = until.duration_since(now).as_secs().max(1);
            return Err(anyhow!(
                "Alecaframe requests are paused for {remaining}s after repeated errors."
            ));
        }
    }

    // (error, server-provided Retry-After seconds when present)
    let result: std::result::Result<String, (anyhow::Error, Option<u64>)> = (|| {
        let client = build_alecaframe_client().map_err(|error| (error, None))?;
        let response = client
            .get(format!(
                "{ALECAFRAME_BASE_URL}{ALECAFRAME_PUBLIC_STATS_PATH}"
            ))
            .query(&[("token", public_token)])
            .header("User-Agent", ALECAFRAME_USER_AGENT)
            .header("Accept", "application/json")
            .send()
            .map_err(|error| {
                (
                    anyhow!(error).context("failed to request Alecaframe public stats"),
                    None,
                )
            })?;

        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        if let Err(error) = response.error_for_status_ref() {
            return Err((
                anyhow!(error).context("Alecaframe public stats request failed"),
                retry_after,
            ));
        }
        response.text().map_err(|error| {
            (
                anyhow!(error).context("failed to read Alecaframe public stats response"),
                None,
            )
        })
    })();

    match result {
        Ok(body) => {
            guard.consecutive_failures = 0;
            guard.cooldown_until = None;
            let body = std::sync::Arc::new(body);
            guard.cache = Some(AlecaframeStatsState {
                token: public_token.to_string(),
                body: body.clone(),
                fetched_at: now,
            });
            Ok(body)
        }
        Err((error, server_delay)) => {
            guard.consecutive_failures = guard.consecutive_failures.saturating_add(1);
            let exponential = ALECAFRAME_BACKOFF_BASE_SECONDS
                .saturating_mul(1_u64 << (guard.consecutive_failures - 1).min(5));
            // The server's own Retry-After wins over our exponential schedule.
            let delay = server_delay
                .unwrap_or(exponential)
                .clamp(ALECAFRAME_BACKOFF_BASE_SECONDS, ALECAFRAME_BACKOFF_CAP_SECONDS);
            guard.cooldown_until = Some(now + Duration::from_secs(delay));
            Err(error)
        }
    }
}

/// Wallet callers tolerate slightly stale data (balances change on the cadence of AlecaFrame's
/// own uploads, i.e. minutes) — a 90s window lets the wallet poll ride on trade detection's
/// fetches instead of issuing its own.
const WALLET_STATS_MAX_AGE: Duration = Duration::from_secs(90);

fn fetch_public_stats(public_token: &str) -> Result<AlecaframePublicStatsResponse> {
    let body = fetch_public_stats_body_cached(public_token, WALLET_STATS_MAX_AGE)?;
    serde_json::from_str::<AlecaframePublicStatsResponse>(&body)
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

    const RELIC_ENTRY_SIZE: usize = 9;
    let entry_count = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    // AlecaFrame's header count can exceed the number of fixed-size entries actually
    // present (observed: header says 91 but the payload holds exactly 90 complete
    // 9-byte entries). Parse the entries the buffer truly contains instead of rejecting
    // the whole payload on a strict length check; each entry is still validated below, so
    // a genuinely misaligned/garbage payload will surface as an unknown tier/refinement.
    let available_entries = payload.len().saturating_sub(4) / RELIC_ENTRY_SIZE;
    let parse_count = entry_count.min(available_entries);

    let mut entries = Vec::with_capacity(parse_count);
    let mut offset = 4;
    for _ in 0..parse_count {
        let relic_type = payload[offset];
        let refinement = payload[offset + 1];
        let code_slice = &payload[offset + 2..offset + 5];
        let count = u32::from_le_bytes([
            payload[offset + 5],
            payload[offset + 6],
            payload[offset + 7],
            payload[offset + 8],
        ]);
        offset += RELIC_ENTRY_SIZE;

        let code = String::from_utf8_lossy(code_slice)
            .trim_matches('\u{0}')
            .trim()
            .to_string();
        if code.is_empty() {
            return Err(anyhow!(
                "Alecaframe relic inventory entry has an empty relic code."
            ));
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
        return Err(anyhow!("Alecaframe relic inventory payload was empty."));
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

fn get_currency_balances_inner(app: &tauri::AppHandle) -> Result<WalletSnapshot> {
    let settings = load_settings_inner(app)?;
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
        Err(error) => {
            log_feature_error_best_effort(
                app,
                "alecaframe",
                "wallet-refresh",
                "Failed to refresh the Alecaframe wallet snapshot.",
                &error,
            );
            Ok(WalletSnapshot {
                enabled: true,
                configured: true,
                error_message: Some(build_support_error_message(
                    "Couldn’t refresh Alecaframe balances right now.",
                )),
                ..WalletSnapshot::default()
            })
        }
    }
}

#[tauri::command]
pub fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    load_settings_inner(&app).map_err(|error| {
        log_settings_error_and_build_message(
            &app,
            "settings",
            "load",
            "Failed to load the saved integration settings.",
            "Couldn’t load app settings right now. Please try again.",
            "SETTINGS-LOAD-01",
            &error,
        )
    })
}

#[tauri::command]
pub fn test_alecaframe_public_link(
    app: tauri::AppHandle,
    public_link: String,
) -> Result<AlecaframeValidationResult, String> {
    validate_public_link_inner(public_link).map_err(|error| {
        log_settings_error_and_build_message(
            &app,
            "alecaframe",
            "validate-link",
            "Failed to validate the Alecaframe public link or token.",
            "Couldn’t validate that Alecaframe link right now. Check the link or token and try again.",
            "ALECAFRAME-VALIDATE-01",
            &error,
        )
    })
}

#[tauri::command]
pub fn save_alecaframe_settings(
    app: tauri::AppHandle,
    input: AlecaframeSettingsInput,
) -> Result<AppSettings, String> {
    // Serialize the whole load→modify→save against the other settings-mutating command so a
    // concurrent save can't clobber the section this one isn't touching.
    let _settings_guard = lock_settings_file().map_err(|error| error.to_string())?;
    let mut settings = load_settings_inner(&app).map_err(|error| {
        log_settings_error_and_build_message(
            &app,
            "settings",
            "load-for-alecaframe-save",
            "Failed to load settings before saving Alecaframe configuration.",
            "Couldn’t save Alecaframe settings right now. Please try again.",
            "ALECAFRAME-SAVE-LOAD-01",
            &error,
        )
    })?;
    let trimmed_public_link = normalize_optional(input.public_link);

    let validation_result = match trimmed_public_link.clone() {
        Some(public_link) => Some(validate_public_link_inner(public_link).map_err(|error| {
            log_settings_error_and_build_message(
                &app,
                "alecaframe",
                "save-validate-link",
                "Failed to validate the Alecaframe link while saving settings.",
                "Couldn’t save Alecaframe settings. Check the link or token and try again.",
                "ALECAFRAME-SAVE-01",
                &error,
            )
        })?),
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

    save_settings_inner(&app, &settings).map_err(|error| {
        log_settings_error_and_build_message(
            &app,
            "settings",
            "save-alecaframe-settings",
            "Failed to persist Alecaframe settings to app storage.",
            "Couldn’t save Alecaframe settings right now. Please try again.",
            "ALECAFRAME-SAVE-STORE-01",
            &error,
        )
    })?;

    Ok(settings)
}

#[tauri::command]
pub fn save_discord_webhook_settings(
    app: tauri::AppHandle,
    input: DiscordWebhookSettingsInput,
) -> Result<AppSettings, String> {
    // Serialize the whole load→modify→save against the other settings-mutating command so a
    // concurrent save can't clobber the section this one isn't touching.
    let _settings_guard = lock_settings_file().map_err(|error| error.to_string())?;
    let mut settings = load_settings_inner(&app).map_err(|error| {
        log_settings_error_and_build_message(
            &app,
            "settings",
            "load-for-discord-save",
            "Failed to load settings before saving Discord webhook configuration.",
            "Couldn’t save Discord webhook settings right now. Please try again.",
            "DISCORD-WEBHOOK-LOAD-01",
            &error,
        )
    })?;
    let normalized_webhook_url = normalize_optional_webhook_url(input.webhook_url);

    let validated_webhook_url = match normalized_webhook_url {
        Some(url) => Some(validate_discord_webhook_url(&url).map_err(|error| {
            log_settings_error_and_build_message(
                &app,
                "discord-webhook",
                "validate-url",
                "Failed to validate the Discord webhook URL while saving settings.",
                "Couldn’t save Discord webhook settings. Check the webhook URL and try again.",
                "DISCORD-WEBHOOK-VALIDATE-01",
                &error,
            )
        })?),
        None => None,
    };

    if input.enabled && validated_webhook_url.is_none() {
        return Err(
            "Enter a valid Discord webhook URL before enabling Discord notifications.".to_string(),
        );
    }

    if let Some(webhook_url) = validated_webhook_url.as_deref() {
        post_discord_webhook_payload(webhook_url, build_discord_test_payload())
            .map_err(|error| {
                log_settings_error_and_build_message(
                    &app,
                    "discord-webhook",
                    "test-notification",
                    "Failed to deliver the Discord webhook test notification while saving settings.",
                    "Couldn’t send the Discord test notification. Check the webhook and try again.",
                    "DISCORD-WEBHOOK-TEST-01",
                    &error,
                )
            })?;
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

    save_settings_inner(&app, &settings).map_err(|error| {
        log_settings_error_and_build_message(
            &app,
            "settings",
            "save-discord-webhook-settings",
            "Failed to persist Discord webhook settings to app storage.",
            "Couldn’t save Discord webhook settings right now. Please try again.",
            "DISCORD-WEBHOOK-SAVE-STORE-01",
            &error,
        )
    })?;

    Ok(settings)
}

#[tauri::command]
pub fn save_smart_manage_settings(
    app: tauri::AppHandle,
    input: SmartManageSettings,
) -> Result<AppSettings, String> {
    let _settings_guard = lock_settings_file().map_err(|error| error.to_string())?;
    let mut settings = load_settings_inner(&app).map_err(|error| {
        log_settings_error_and_build_message(
            &app,
            "settings",
            "load-for-smart-manage-save",
            "Failed to load settings before saving Smart Manage configuration.",
            "Couldn’t save Smart Manage settings right now. Please try again.",
            "SMART-SAVE-LOAD-01",
            &error,
        )
    })?;

    let aggressiveness = match input.aggressiveness.trim().to_ascii_lowercase().as_str() {
        "conservative" => "conservative",
        "aggressive" => "aggressive",
        _ => "balanced",
    };
    settings.smart_manage = SmartManageSettings {
        enabled: input.enabled,
        aggressiveness: aggressiveness.to_string(),
        min_margin_pct: input.min_margin_pct.clamp(0.0, 100.0),
        max_changes_per_day: input.max_changes_per_day.clamp(1, 100),
        min_interval_minutes: input.min_interval_minutes.clamp(1, 720),
    };

    save_settings_inner(&app, &settings).map_err(|error| {
        log_settings_error_and_build_message(
            &app,
            "settings",
            "save-smart-manage-settings",
            "Failed to persist Smart Manage settings to app storage.",
            "Couldn’t save Smart Manage settings right now. Please try again.",
            "SMART-SAVE-STORE-01",
            &error,
        )
    })?;

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

pub(crate) fn send_underpriced_listing_discord_notification_inner(
    app: &tauri::AppHandle,
    input: &DiscordUnderpricedNotificationInput,
) -> Result<bool> {
    let settings = load_settings_inner(app)?;
    let discord = settings.discord_webhook;
    if !discord.enabled || !discord.notifications.underpriced_listing {
        return Ok(false);
    }
    let Some(webhook_url) = discord.webhook_url else {
        return Ok(false);
    };

    post_discord_webhook_payload(&webhook_url, build_underpriced_listing_payload(input))?;
    Ok(true)
}

/// Fire a Discord webhook for a Smart Manage price change (or preview intent).
pub(crate) fn send_smart_manage_discord_notification_inner(
    app: &tauri::AppHandle,
    item_slug: &str,
    old_price: i64,
    new_price: i64,
    action: &str,
    applied: bool,
    preview: bool,
) -> Result<bool> {
    let settings = load_settings_inner(app)?;
    let discord = settings.discord_webhook;
    if !discord.enabled || !discord.notifications.price_change {
        return Ok(false);
    }
    let Some(webhook_url) = discord.webhook_url else {
        return Ok(false);
    };
    post_discord_webhook_payload(
        &webhook_url,
        build_smart_manage_payload(item_slug, old_price, new_price, action, applied, preview),
    )?;
    Ok(true)
}

fn build_smart_manage_payload(
    item_slug: &str,
    old_price: i64,
    new_price: i64,
    action: &str,
    applied: bool,
    preview: bool,
) -> serde_json::Value {
    let market_url = format!("https://warframe.market/items/{item_slug}");
    let raised = new_price > old_price;
    let arrow = if raised { "📈" } else { "📉" };
    let direction = if raised { "Raised" } else { "Trimmed" };
    let pretty_name = prettify_slug(item_slug);
    let delta = (new_price - old_price).abs();
    let verb = if preview {
        "would be"
    } else if applied {
        "was"
    } else {
        "couldn't be"
    };
    let color = if !applied && !preview {
        COLOR_RED
    } else if raised {
        COLOR_GREEN
    } else {
        COLOR_BLUE
    };
    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("🤖 {arrow} {direction} {pretty_name}"),
        "description": format!(
            "Price {verb} moved **{old_price}p → {new_price}p** ({}{delta}p).{}",
            if raised { "+" } else { "−" },
            if preview { "\n> _Preview only — no change applied._" } else { "" }
        ),
        "url": market_url,
        "color": color,
        "fields": [
          { "name": "Was", "value": format!("{old_price}p"), "inline": true },
          { "name": "Now", "value": format!("**{new_price}p**"), "inline": true },
          { "name": "Reason", "value": action, "inline": true }
        ],
        "footer": brand_footer("Smart Manage"),
        "timestamp": now_iso8601()
      }]
    })
}

/// Turns a WFM slug ("mirage_prime_set") into a readable name ("Mirage Prime Set").
fn prettify_slug(slug: &str) -> String {
    slug.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_listing_health_payload(
    input: &DiscordListingHealthNotificationInput,
) -> serde_json::Value {
    let lines = if input.examples.is_empty() {
        "_Open the Trades tab to review._".to_string()
    } else {
        input
            .examples
            .iter()
            .map(|item| {
                let market = item
                    .market_low
                    .map(|low| format!(" · market **{low}p**"))
                    .unwrap_or_default();
                format!("• **{}** — yours {}p{}", item.item_name, item.your_price, market)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("🩺 {} listing{} need attention", input.count, if input.count == 1 { "" } else { "s" }),
        "description": format!(
            "Some of your sell orders have slipped out of a competitive spot.\n\n{lines}"
        ),
        "color": COLOR_AMBER,
        "footer": brand_footer("Listing health"),
        "timestamp": now_iso8601()
      }]
    })
}

fn build_scanner_stale_payload(
    input: &DiscordScannerStaleNotificationInput,
) -> serde_json::Value {
    let age = input
        .minutes_stale
        .map(|mins| format!("Last successful scan was **{mins} min** ago."))
        .unwrap_or_else(|| "It hasn't refreshed in a while.".to_string());

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("⚠️ {} has gone stale", input.scanner_name),
        "description": format!("{age}\nOpportunities may be out of date until it refreshes."),
        "color": COLOR_RED,
        "footer": brand_footer("Scanner status"),
        "timestamp": now_iso8601()
      }]
    })
}

fn build_app_update_payload(input: &DiscordAppUpdateNotificationInput) -> serde_json::Value {
    let from = input
        .current_version
        .as_ref()
        .map(|current| format!("{current} → "))
        .unwrap_or_default();
    let notes = input
        .notes
        .as_ref()
        .filter(|notes| !notes.trim().is_empty())
        .map(|notes| format!("\n\n{notes}"))
        .unwrap_or_default();

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("🚀 WarStonks {} is available", input.version),
        "description": format!("A new version is ready to install: **{from}{}**.{notes}", input.version),
        "url": WARSTONKS_SITE,
        "color": COLOR_PURPLE,
        "footer": brand_footer("App update"),
        "timestamp": now_iso8601()
      }]
    })
}

#[tauri::command]
pub fn send_underpriced_listing_discord_notification(
    app: tauri::AppHandle,
    input: DiscordUnderpricedNotificationInput,
) -> Result<bool, String> {
    send_underpriced_listing_discord_notification_inner(&app, &input)
        .map_err(|error| error.to_string())
}

pub(crate) fn send_listing_health_discord_notification_inner(
    app: &tauri::AppHandle,
    input: &DiscordListingHealthNotificationInput,
) -> Result<bool> {
    let discord = load_settings_inner(app)?.discord_webhook;
    if !discord.enabled || !discord.notifications.listing_health {
        return Ok(false);
    }
    let Some(webhook_url) = discord.webhook_url else {
        return Ok(false);
    };
    post_discord_webhook_payload(&webhook_url, build_listing_health_payload(input))?;
    Ok(true)
}

#[tauri::command]
pub fn send_listing_health_discord_notification(
    app: tauri::AppHandle,
    input: DiscordListingHealthNotificationInput,
) -> Result<bool, String> {
    send_listing_health_discord_notification_inner(&app, &input).map_err(|error| error.to_string())
}

pub(crate) fn send_scanner_stale_discord_notification_inner(
    app: &tauri::AppHandle,
    input: &DiscordScannerStaleNotificationInput,
) -> Result<bool> {
    let discord = load_settings_inner(app)?.discord_webhook;
    if !discord.enabled || !discord.notifications.scanner_stale {
        return Ok(false);
    }
    let Some(webhook_url) = discord.webhook_url else {
        return Ok(false);
    };
    post_discord_webhook_payload(&webhook_url, build_scanner_stale_payload(input))?;
    Ok(true)
}

#[tauri::command]
pub fn send_scanner_stale_discord_notification(
    app: tauri::AppHandle,
    input: DiscordScannerStaleNotificationInput,
) -> Result<bool, String> {
    send_scanner_stale_discord_notification_inner(&app, &input).map_err(|error| error.to_string())
}

pub(crate) fn send_app_update_discord_notification_inner(
    app: &tauri::AppHandle,
    input: &DiscordAppUpdateNotificationInput,
) -> Result<bool> {
    let discord = load_settings_inner(app)?.discord_webhook;
    if !discord.enabled || !discord.notifications.app_update {
        return Ok(false);
    }
    let Some(webhook_url) = discord.webhook_url else {
        return Ok(false);
    };
    post_discord_webhook_payload(&webhook_url, build_app_update_payload(input))?;
    Ok(true)
}

#[tauri::command]
pub fn send_app_update_discord_notification(
    app: tauri::AppHandle,
    input: DiscordAppUpdateNotificationInput,
) -> Result<bool, String> {
    send_app_update_discord_notification_inner(&app, &input).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_currency_balances(app: tauri::AppHandle) -> Result<WalletSnapshot, String> {
    let app_for_worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_currency_balances_inner(&app_for_worker).map_err(|error| {
            log_settings_error_and_build_message(
                &app_for_worker,
                "alecaframe",
                "wallet-load",
                "Failed to load the Alecaframe wallet snapshot.",
                "Couldn’t load Alecaframe balances right now.",
                "ALECAFRAME-WALLET-LOAD-01",
                &error,
            )
        })
    })
    .await
    .map_err(|error| {
        let wrapped = anyhow!(error.to_string());
        log_settings_error_and_build_message(
            &app,
            "alecaframe",
            "wallet-load-worker",
            "The Alecaframe wallet worker thread failed before completing.",
            "Couldn’t load Alecaframe balances right now.",
            "ALECAFRAME-WALLET-LOAD-02",
            &wrapped,
        )
    })?
}

#[tauri::command]
pub async fn refresh_alecaframe_wallet_snapshot(
    app: tauri::AppHandle,
) -> Result<WalletSnapshot, String> {
    let app_for_worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = get_currency_balances_inner(&app_for_worker).map_err(|error| {
            log_settings_error_and_build_message(
                &app_for_worker,
                "alecaframe",
                "wallet-refresh",
                "Failed to refresh the Alecaframe wallet snapshot.",
                "Couldn’t refresh Alecaframe balances right now.",
                "ALECAFRAME-WALLET-REFRESH-02",
                &error,
            )
        })?;
        // NOTE: do NOT refresh the owned-relic cache here. The wallet snapshot polls every 60s, and
        // bundling relics in would fetch /api/stats/relics every 60s too — bypassing the relic
        // refresh's 3-minute cooldown and doubling AlecaFrame load. Relics refresh only via the
        // dedicated, cooldown-gated `refresh_owned_relic_inventory` command.
        Ok(snapshot)
    })
    .await
    .map_err(|error| {
        let wrapped = anyhow!(error.to_string());
        log_settings_error_and_build_message(
            &app,
            "alecaframe",
            "wallet-refresh-worker",
            "The Alecaframe wallet refresh worker thread failed before completing.",
            "Couldn’t refresh Alecaframe balances right now.",
            "ALECAFRAME-WALLET-REFRESH-03",
            &wrapped,
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::{
        decode_alecaframe_relic_inventory_payload, extract_public_token, load_settings_from_path,
        map_currency_balance, parse_alecaframe_relic_inventory, save_settings_to_path,
        select_latest_data_point, AlecaframeDataPoint, AlecaframeSettings, AppSettings,
        DiscordWebhookNotificationSettings, DiscordWebhookSettings,
        BASE64_STANDARD,
    };
    use base64::Engine;
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
            smart_manage: super::SmartManageSettings::default(),
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
