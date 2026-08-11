use anyhow::{anyhow, Context, Result};
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
    /// Someone opened a DM with the user in-game (read from Warframe's EE.log).
    #[serde(default = "default_true")]
    pub private_message: bool,
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
            private_message: true,
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
    pub labels: DiscordWatchlistNotificationLabels,
}

/// Pre-localized UI text for [`DiscordWatchlistNotificationInput`], resolved on the frontend
/// via `tActive()` so the Rust builder never bakes in hardcoded English.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordWatchlistNotificationLabels {
    /// e.g. "hit your target" — appended after the item name in the title.
    pub title_suffix: String,
    /// Fully resolved description sentence (item price / savings / target already interpolated).
    pub description: String,
    pub listed_label: String,
    pub target_label: String,
    pub savings_label: String,
    pub seller_label: String,
    pub qty_label: String,
    pub rank_label: String,
    pub footer: String,
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
    pub labels: DiscordUnderpricedNotificationLabels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordUnderpricedNotificationLabels {
    /// e.g. "is underpriced" — appended after the item name in the title.
    pub title_suffix: String,
    /// Fully resolved description sentence.
    pub description: String,
    pub listed_label: String,
    pub recommended_label: String,
    pub upside_label: String,
    pub seller_label: String,
    pub rank_label: String,
    pub footer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordTradeNotificationItem {
    pub item_name: String,
    pub quantity: i64,
    pub rank: Option<i64>,
    pub image_path: Option<String>,
    /// Only needed to recover Warframe.Market art when `image_path` is one of our own
    /// component overrides, which Discord cannot fetch.
    #[serde(default)]
    pub slug: Option<String>,
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
    pub labels: DiscordListingHealthLabels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordListingHealthLabels {
    /// e.g. "listing needs attention" / "listings need attention" (already pluralized by the FE).
    pub title: String,
    pub intro: String,
    /// Shown when there are no example listings.
    pub empty: String,
    pub footer: String,
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
    pub labels: DiscordScannerStaleLabels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPrivateMessageNotificationInput {
    /// Sender, already stripped of the game's private-use glyph by the log parser.
    pub user: String,
    /// Localized on the frontend, like every other Discord payload here.
    pub labels: DiscordPrivateMessageLabels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPrivateMessageLabels {
    pub title: String,
    /// e.g. "New private message from {user}" — `{user}` already interpolated.
    pub body: String,
    /// States that the game never logs message text, so the embed can't be mistaken
    /// for showing the message itself.
    pub note: String,
    pub footer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordScannerStaleLabels {
    /// e.g. "has gone stale" — appended after the scanner name in the title.
    pub title_suffix: String,
    /// e.g. "Last successful scan was **{mins} min** ago." (mins already interpolated).
    pub age_known: String,
    /// Shown when the last-scan time isn't known.
    pub age_unknown: String,
    pub outro: String,
    pub footer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordAppUpdateNotificationInput {
    pub version: String,
    pub current_version: Option<String>,
    pub notes: Option<String>,
    pub labels: DiscordAppUpdateLabels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordAppUpdateLabels {
    /// e.g. "is available" — appended after the version in the title.
    pub title_suffix: String,
    /// e.g. "A new version is ready to install: **{fromTo}**." (fromTo already interpolated).
    pub description: String,
    pub footer: String,
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

/// Prefix the catalog stamps onto a component's image. See `part_images.rs`.
const PART_IMAGE_SENTINEL: &str = "warstonks:part/";

/// Discord fetches thumbnails over the network, so it can only be given a public URL. A
/// component's `preferred_image` is our own bundled asset, which Discord cannot reach — fall
/// back to the item's Warframe.Market art, which is exactly what these embeds showed before
/// the override existed.
fn build_wfm_asset_url_with_fallback(
    app: &tauri::AppHandle,
    asset_path: Option<&str>,
    key_or_slug: Option<&str>,
) -> Option<String> {
    let is_part_override = asset_path
        .map(|path| path.trim().starts_with(PART_IMAGE_SENTINEL))
        .unwrap_or(false);

    if is_part_override {
        return key_or_slug
            .and_then(|value| crate::item_catalog_v2::wfm_art_for_key_or_slug(app, value))
            .and_then(|path| build_wfm_asset_url(Some(&path)));
    }

    build_wfm_asset_url(asset_path)
}

fn build_wfm_asset_url(asset_path: Option<&str>) -> Option<String> {
    let trimmed = asset_path?.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Never emit a sentinel as a URL: only the frontend can resolve it, and Discord would
    // render a broken image. Callers with an item key should use the fallback variant.
    if trimmed.starts_with(PART_IMAGE_SENTINEL) {
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

/// WarStonks brand icon. `warstonks.app` (the previous host) does not resolve at all — confirmed
/// live (`curl`: "Could not resolve host") — which is why every embed's author/footer icon showed
/// Discord's broken-image placeholder. Points at the app's own icon file in the GitHub repo via
/// `raw.githubusercontent.com`, which actually serves it (confirmed live, `content-type:
/// image/png`) and tracks whatever's committed at `src-tauri/icons/icon.png` on `main`.
const DISCORD_BRAND_ICON: &str =
    "https://raw.githubusercontent.com/Py-xxx/WarStonks/main/src-tauri/icons/icon.png";
/// Same dead-domain problem as `DISCORD_BRAND_ICON` — this is the clickable link on the embed's
/// author line and the app-update notification's title link, so it silently 404'd too. Points at
/// the repo itself, the only confirmed-live web presence for the project.
const WARSTONKS_SITE: &str = "https://github.com/Py-xxx/WarStonks";

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

/// Label text for the two Discord notifications that fire from a purely backend-triggered flow
/// (trade detection off the WS listener, Smart Manage's auto-pricing loop) with no frontend round
/// trip to pre-resolve `tActive()` strings the way every other Discord notification does — see
/// `crate::commands::app_language`, set once at boot (and on language change) from the frontend's
/// own `src/i18n/*.ts` language code. Every other string in this file's builders is genuine DATA
/// (an item name, a price) or a brand/product name deliberately left untranslated (`Warframe
/// Market`, `Alecaframe`, `Smart Manage` — matches the existing convention already used
/// throughout `src/i18n/*.ts`, where feature/product names stay in English in every locale).
mod discord_i18n {
    pub(super) struct Labels {
        pub buy: &'static str,
        pub sell: &'static str,
        pub received_label: &'static str,
        pub given_label: &'static str,
        pub platinum_label: &'static str,
        pub items_label: &'static str,
        pub source_label: &'static str,
        pub trade_detection_footer: &'static str,
        pub raised: &'static str,
        pub trimmed: &'static str,
        pub verb_would_be: &'static str,
        pub verb_was: &'static str,
        pub verb_couldnt_be: &'static str,
        pub preview_only_note: &'static str,
        pub was_label: &'static str,
        pub now_label: &'static str,
        pub reason_label: &'static str,
        pub smart_manage_footer: &'static str,
    }

    const EN: Labels = Labels {
        buy: "Buy",
        sell: "Sell",
        received_label: "📥 Received",
        given_label: "📤 Given",
        platinum_label: "💠 Platinum",
        items_label: "📦 Items",
        source_label: "🔗 Source",
        trade_detection_footer: "Trade detection",
        raised: "Raised",
        trimmed: "Trimmed",
        verb_would_be: "would be",
        verb_was: "was",
        verb_couldnt_be: "couldn't be",
        preview_only_note: "\n> _Preview only — no change applied._",
        was_label: "Was",
        now_label: "Now",
        reason_label: "Reason",
        smart_manage_footer: "Smart Manage",
    };

    const DE: Labels = Labels {
        buy: "Kauf",
        sell: "Verkauf",
        received_label: "📥 Erhalten",
        given_label: "📤 Gegeben",
        platinum_label: "💠 Platin",
        items_label: "📦 Artikel",
        source_label: "🔗 Quelle",
        trade_detection_footer: "Handelserkennung",
        raised: "Erhöht",
        trimmed: "Gesenkt",
        verb_would_be: "würde",
        verb_was: "wurde",
        verb_couldnt_be: "konnte nicht",
        preview_only_note: "\n> _Nur Vorschau — keine Änderung angewendet._",
        was_label: "Vorher",
        now_label: "Jetzt",
        reason_label: "Grund",
        smart_manage_footer: "Smart Manage",
    };

    const ES: Labels = Labels {
        buy: "Compra",
        sell: "Venta",
        received_label: "📥 Recibido",
        given_label: "📤 Entregado",
        platinum_label: "💠 Platino",
        items_label: "📦 Artículos",
        source_label: "🔗 Origen",
        trade_detection_footer: "Detección de intercambios",
        raised: "Subido",
        trimmed: "Recortado",
        verb_would_be: "se moveria",
        verb_was: "se movió",
        verb_couldnt_be: "no se pudo mover",
        preview_only_note: "\n> _Solo vista previa — no se aplicó ningún cambio._",
        was_label: "Antes",
        now_label: "Ahora",
        reason_label: "Motivo",
        smart_manage_footer: "Smart Manage",
    };

    const FR: Labels = Labels {
        buy: "Achat",
        sell: "Vente",
        received_label: "📥 Reçu",
        given_label: "📤 Donné",
        platinum_label: "💠 Platine",
        items_label: "📦 Objets",
        source_label: "🔗 Source",
        trade_detection_footer: "Détection d'échanges",
        raised: "Augmenté",
        trimmed: "Réduit",
        verb_would_be: "serait",
        verb_was: "a été",
        verb_couldnt_be: "n'a pas pu être",
        preview_only_note: "\n> _Aperçu uniquement — aucun changement appliqué._",
        was_label: "Avant",
        now_label: "Maintenant",
        reason_label: "Raison",
        smart_manage_footer: "Smart Manage",
    };

    const PT: Labels = Labels {
        buy: "Compra",
        sell: "Venda",
        received_label: "📥 Recebido",
        given_label: "📤 Enviado",
        platinum_label: "💠 Platina",
        items_label: "📦 Itens",
        source_label: "🔗 Origem",
        trade_detection_footer: "Detecção de negociações",
        raised: "Aumentado",
        trimmed: "Reduzido",
        verb_would_be: "seria",
        verb_was: "foi",
        verb_couldnt_be: "não pôde ser",
        preview_only_note: "\n> _Apenas pré-visualização — nenhuma alteração aplicada._",
        was_label: "Antes",
        now_label: "Agora",
        reason_label: "Motivo",
        smart_manage_footer: "Smart Manage",
    };

    const ZH_HANS: Labels = Labels {
        buy: "购买",
        sell: "出售",
        received_label: "📥 已收到",
        given_label: "📤 已给出",
        platinum_label: "💠 白金",
        items_label: "📦 物品",
        source_label: "🔗 来源",
        trade_detection_footer: "交易检测",
        raised: "已上调",
        trimmed: "已下调",
        verb_would_be: "将会",
        verb_was: "已",
        verb_couldnt_be: "未能",
        preview_only_note: "\n> _仅预览 — 未应用任何更改。_",
        was_label: "原价",
        now_label: "现价",
        reason_label: "原因",
        smart_manage_footer: "Smart Manage",
    };

    /// `language` is the raw `src/i18n/*.ts` file code (`zh-hans`, `en`, ...) — falls back to
    /// English for anything unrecognized, same tolerance `translate.ts`'s locale chain gives an
    /// unsupported language on the frontend.
    pub(super) fn resolve(language: &str) -> &'static Labels {
        match language.trim().to_ascii_lowercase().as_str() {
            "de" => &DE,
            "es" => &ES,
            "fr" => &FR,
            "pt" => &PT,
            "zh-hans" | "zh" => &ZH_HANS,
            _ => &EN,
        }
    }
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

fn build_watchlist_found_payload(
    app: &tauri::AppHandle,
    input: &DiscordWatchlistNotificationInput,
) -> serde_json::Value {
    let rank_value = input
        .rank
        .map(|value| value.to_string())
        .unwrap_or_else(|| "—".to_string());
    let image_url = build_wfm_asset_url_with_fallback(
        app,
        input.item_image_path.as_deref(),
        Some(input.item_slug.as_str()),
    );

    let market_url = format!("https://warframe.market/items/{}", input.item_slug);
    let savings = (input.target_price - input.current_price).max(0);

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("🎯 {} {}", input.item_name, input.labels.title_suffix),
        "url": market_url,
        "description": input.labels.description,
        "color": COLOR_GREEN,
        "thumbnail": image_url.as_ref().map(|url| json!({ "url": url })),
        "fields": [
          { "name": format!("💰 {}", input.labels.listed_label), "value": format!("**{}p**", input.current_price), "inline": true },
          { "name": format!("🎯 {}", input.labels.target_label), "value": format!("{}p", input.target_price), "inline": true },
          { "name": format!("📉 {}", input.labels.savings_label), "value": format!("{}p", savings), "inline": true },
          { "name": format!("👤 {}", input.labels.seller_label), "value": input.username, "inline": true },
          { "name": format!("📦 {}", input.labels.qty_label), "value": input.quantity.to_string(), "inline": true },
          { "name": format!("🏅 {}", input.labels.rank_label), "value": rank_value, "inline": true }
        ],
        "footer": brand_footer(&input.labels.footer),
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
        "title": format!("💸 {} {}", input.item_name, input.labels.title_suffix),
        "description": input.labels.description,
        "url": market_url,
        "color": COLOR_AMBER,
        "fields": [
          { "name": format!("🏷️ {}", input.labels.listed_label), "value": format!("**{}p**", input.listed_price), "inline": true },
          { "name": format!("📊 {}", input.labels.recommended_label), "value": format!("{}p", input.recommended_price), "inline": true },
          { "name": format!("📈 {}", input.labels.upside_label), "value": format!("~{}p ({}%)", profit, input.pct_below), "inline": true },
          { "name": format!("👤 {}", input.labels.seller_label), "value": input.username, "inline": true },
          { "name": format!("🏅 {}", input.labels.rank_label), "value": rank_value, "inline": true }
        ],
        "footer": brand_footer(&input.labels.footer),
        "timestamp": now_iso8601()
      }]
    })
}

fn build_trade_detected_payload(
    app: &tauri::AppHandle,
    input: &DiscordTradeDetectedNotificationInput,
) -> serde_json::Value {
    let labels = discord_i18n::resolve(&crate::commands::app_language());
    let order_type_label = if input.order_type.eq_ignore_ascii_case("buy") {
        labels.buy
    } else {
        labels.sell
    };
    let title_icon = if input.order_type.eq_ignore_ascii_case("buy") {
        "🛒"
    } else {
        "💸"
    };
    // "Warframe Market"/"Alecaframe" are product/brand names — deliberately left untranslated,
    // matching the existing convention in `src/i18n/*.ts` (see `discord_i18n`'s doc comment).
    let source_label = if input.source.eq_ignore_ascii_case("wfm") {
        "Warframe Market"
    } else {
        "Alecaframe"
    };
    let image_url = input.items.iter().find_map(|item| {
        build_wfm_asset_url_with_fallback(app, item.image_path.as_deref(), item.slug.as_deref())
    });
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
    let items_label = if is_buy { labels.received_label } else { labels.given_label };
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
          { "name": labels.platinum_label, "value": format!("**{}p**", input.total_platinum), "inline": true },
          { "name": labels.items_label, "value": item_count.to_string(), "inline": true },
          { "name": labels.source_label, "value": source_label, "inline": true },
          divider_field(),
          { "name": items_label, "value": item_lines, "inline": false }
        ],
        "footer": brand_footer(labels.trade_detection_footer),
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

/// `/api/stats/public` returns the whole payload — trades AND wallet — in one response, so every
/// caller shares a single freshness window rather than each keeping its own. At 10s this is ~0.1
/// requests/sec against AlecaFrame's 1 rps per-IP limit, leaving ample headroom for the relic
/// endpoint and any retry burst.
pub(crate) const PUBLIC_STATS_MAX_AGE: Duration = Duration::from_secs(10);

fn fetch_public_stats(public_token: &str) -> Result<AlecaframePublicStatsResponse> {
    let body = fetch_public_stats_body_cached(public_token, PUBLIC_STATS_MAX_AGE)?;
    serde_json::from_str::<AlecaframePublicStatsResponse>(&body)
        .context("failed to parse Alecaframe public stats response")
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
    // There is nothing left to validate: the integration reads AlecaFrame's local app data,
    // so enabling it is just a switch. `public_link` survives on the struct only so existing
    // saved configs keep deserializing, and is always cleared.
    settings.alecaframe = AlecaframeSettings {
        enabled: input.enabled,
        public_link: None,
        username_when_public: None,
        last_validated_at: None,
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

    post_discord_webhook_payload(&webhook_url, build_watchlist_found_payload(app, input))?;
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

    post_discord_webhook_payload(&webhook_url, build_trade_detected_payload(app, input))?;
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
    let labels = discord_i18n::resolve(&crate::commands::app_language());
    let market_url = format!("https://warframe.market/items/{item_slug}");
    let raised = new_price > old_price;
    let arrow = if raised { "📈" } else { "📉" };
    let direction = if raised { labels.raised } else { labels.trimmed };
    let pretty_name = prettify_slug(item_slug);
    let delta = (new_price - old_price).abs();
    let verb = if preview {
        labels.verb_would_be
    } else if applied {
        labels.verb_was
    } else {
        labels.verb_couldnt_be
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
            if preview { labels.preview_only_note } else { "" }
        ),
        "url": market_url,
        "color": color,
        "fields": [
          { "name": labels.was_label, "value": format!("{old_price}p"), "inline": true },
          { "name": labels.now_label, "value": format!("**{new_price}p**"), "inline": true },
          { "name": labels.reason_label, "value": action, "inline": true }
        ],
        "footer": brand_footer(labels.smart_manage_footer),
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
        input.labels.empty.clone()
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
        "title": format!("🩺 {} {}", input.count, input.labels.title),
        "description": format!("{}\n\n{lines}", input.labels.intro),
        "color": COLOR_AMBER,
        "footer": brand_footer(&input.labels.footer),
        "timestamp": now_iso8601()
      }]
    })
}

fn build_scanner_stale_payload(
    input: &DiscordScannerStaleNotificationInput,
) -> serde_json::Value {
    let age = input
        .minutes_stale
        .map(|mins| input.labels.age_known.replace("{mins}", &mins.to_string()))
        .unwrap_or_else(|| input.labels.age_unknown.clone());

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("⚠️ {} {}", input.scanner_name, input.labels.title_suffix),
        "description": format!("{age}\n{}", input.labels.outro),
        "color": COLOR_RED,
        "footer": brand_footer(&input.labels.footer),
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
    let description = input
        .labels
        .description
        .replace("{fromTo}", &format!("{from}{}", input.version));

    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": format!("🚀 WarStonks {} {}", input.version, input.labels.title_suffix),
        "description": format!("{description}{notes}"),
        "url": WARSTONKS_SITE,
        "color": COLOR_PURPLE,
        "footer": brand_footer(&input.labels.footer),
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

fn build_private_message_payload(
    input: &DiscordPrivateMessageNotificationInput,
) -> serde_json::Value {
    json!({
      "username": "WarStonks",
      "embeds": [{
        "author": brand_author(),
        "title": input.labels.title.clone(),
        "description": format!("{}\n\n_{}_", input.labels.body, input.labels.note),
        "color": COLOR_BLUE,
        "footer": brand_footer(&input.labels.footer),
        "timestamp": now_iso8601()
      }]
    })
}

pub(crate) fn send_private_message_discord_notification_inner(
    app: &tauri::AppHandle,
    input: &DiscordPrivateMessageNotificationInput,
) -> Result<bool> {
    let discord = load_settings_inner(app)?.discord_webhook;
    if !discord.enabled || !discord.notifications.private_message {
        return Ok(false);
    }
    let Some(webhook_url) = discord.webhook_url else {
        return Ok(false);
    };
    post_discord_webhook_payload(&webhook_url, build_private_message_payload(input))?;
    Ok(true)
}

#[tauri::command]
pub fn send_private_message_discord_notification(
    app: tauri::AppHandle,
    input: DiscordPrivateMessageNotificationInput,
) -> Result<bool, String> {
    send_private_message_discord_notification_inner(&app, &input)
        .map_err(|error| error.to_string())
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


#[cfg(test)]
mod tests {
    use super::{
        extract_public_token, load_settings_from_path, map_currency_balance,
        save_settings_to_path, select_latest_data_point, AlecaframeDataPoint,
        AlecaframeSettings, AppSettings, DiscordWebhookNotificationSettings,
        DiscordWebhookSettings,
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


}
