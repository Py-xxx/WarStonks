use anyhow::{Context, Result};
use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use crate::error_log::log_feature_error_best_effort;
use crate::wfm_scheduler::{
    execute_coalesced_wfm_request, wfm_scheduler_snapshot, RequestPriority, WfmHttpResponse,
    WfmSchedulerSnapshot,
};

const WFM_API_BASE_URL: &str = "https://api.warframe.market/v2";
const WFSTAT_API_BASE_URL: &str = "https://api.warframestat.us";
const WFM_LANGUAGE_HEADER: &str = "en";
const WFM_PLATFORM_HEADER: &str = "pc";
const WFM_CROSSPLAY_HEADER: &str = "true";
// Descriptive, identifying User-Agent required by Warframe.Market's API rules (name/version/
// website, never browser-disguised). Format: `ProjectName/version (+url)`.
const WFM_USER_AGENT: &str =
    concat!("WarStonks/", env!("CARGO_PKG_VERSION"), " (+https://pyth.co.za)");
// Worldstate display language for warframestat.us fetches. Set at runtime from the frontend
// (`set_worldstate_language`) so all WFStat fetch helpers localize without per-command threading.
// Empty = default to English. wfstat's code differs from WFM's (e.g. `zh` vs `zh-hans`), so the
// frontend maps before calling.
static WFSTAT_LANGUAGE: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

pub(crate) fn wfstat_language() -> String {
    WFSTAT_LANGUAGE
        .read()
        .ok()
        .map(|value| value.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "en".to_string())
}

#[tauri::command]
pub fn set_worldstate_language(language: String) {
    if let Ok(mut guard) = WFSTAT_LANGUAGE.write() {
        *guard = language.trim().to_string();
    }
}

/// The app's own UI language (the raw `src/i18n/*.ts` file code — `zh-hans`, not WFStat's `zh`),
/// set at runtime from the frontend (`set_app_language`) so Discord notifications fired from a
/// purely backend-triggered flow (trade detection, Smart Manage) can still localize their text —
/// those two have no frontend round-trip to pre-resolve `tActive()` strings through the way every
/// other Discord notification does. Empty = default to English. See `settings::discord_i18n` for
/// the small translation table this feeds.
static APP_LANGUAGE: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

pub(crate) fn app_language() -> String {
    APP_LANGUAGE
        .read()
        .ok()
        .map(|value| value.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "en".to_string())
}

#[tauri::command]
pub fn set_app_language(language: String) {
    if let Ok(mut guard) = APP_LANGUAGE.write() {
        *guard = language.trim().to_string();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmAutocompleteItem {
    pub item_id: i64,
    pub wfm_id: String,
    /// Localized display name (falls back to English when the language pack has no entry).
    pub name: String,
    /// The English name, always. Kept alongside `name` so search can match what the user sees
    /// *and* what they might know the item as — a Chinese player who knows "Mesa Prime" should
    /// not lose the ability to type it just because the UI is localized.
    pub name_en: String,
    pub slug: String,
    pub max_rank: Option<i64>,
    pub item_family: Option<String>,
    pub image_path: Option<String>,
    /// Whether the item trades in batches (e.g. arcanes). When true, listing it requires a
    /// `perTrade` batch size on the WFM order API.
    pub bulk_tradable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmTopSellOrder {
    pub order_id: String,
    pub platinum: i64,
    pub quantity: i64,
    pub per_trade: i64,
    pub rank: Option<i64>,
    pub username: String,
    pub user_slug: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmTopSellOrdersResponse {
    pub api_version: Option<String>,
    pub slug: String,
    pub sell_orders: Vec<WfmTopSellOrder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelicTierIcon {
    pub tier: String,
    pub image_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidTraderInventoryItem {
    pub item: String,
    pub ducats: Option<i64>,
    pub credits: Option<i64>,
    pub category: String,
    pub image_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidTraderResponse {
    pub id: String,
    pub activation: Option<String>,
    pub expiry: Option<String>,
    pub character: String,
    pub location: Option<String>,
    pub inventory: Vec<VoidTraderInventoryItem>,
    pub ps_id: Option<String>,
    pub initial_start: Option<String>,
    pub schedule: Vec<serde_json::Value>,
    pub expired: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketNewsResponse {
    pub news: Vec<serde_json::Value>,
    pub flash_sales: Vec<serde_json::Value>,
}

/// Response shape for `/v2/orders/item/{slug}` — the full order book snapshot (every
/// buy + sell listing). We filter to the sell side ourselves so the quick view can show
/// the cheapest few and the "View All" popup can list every online/in-game seller.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrdersApiResponse {
    api_version: Option<String>,
    #[serde(default)]
    data: Vec<WfmOrderWithUser>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrderWithUser {
    id: String,
    #[serde(rename = "type")]
    order_type: String,
    platinum: i64,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    per_trade: Option<i64>,
    #[serde(default)]
    rank: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
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
#[serde(rename_all = "camelCase")]
struct VoidTraderApiResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    activation: Option<String>,
    #[serde(default)]
    expiry: Option<String>,
    #[serde(default)]
    character: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    inventory: Vec<VoidTraderInventoryApiItem>,
    #[serde(default)]
    ps_id: Option<String>,
    #[serde(default)]
    initial_start: Option<String>,
    #[serde(default)]
    schedule: Vec<serde_json::Value>,
    #[serde(default)]
    expired: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoidTraderInventoryApiItem {
    item: String,
    #[serde(default)]
    ducats: Option<i64>,
    #[serde(default)]
    credits: Option<i64>,
}

#[derive(Debug, Clone)]
struct CatalogItemMetadata {
    category: String,
    image_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppShellInfo {
    pub version: String,
    pub name: String,
    pub platform: String,
}

/// Returns static metadata about the app shell.
/// Used by the frontend tauriClient to verify connectivity.
#[tauri::command]
pub fn get_app_shell_info() -> AppShellInfo {
    AppShellInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        name: "WarStonks".to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

/// Placeholder — returns the current app version string.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Lightweight stats for the underpriced-listings radar so the UI can confirm the firehose is
/// flowing: how many live orders we've examined and how many priced items we're watching.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarStats {
    pub scanned_count: u64,
    pub tracked_items: u64,
}

#[tauri::command]
pub fn get_radar_stats() -> RadarStats {
    RadarStats {
        scanned_count: crate::recommended_prices::scanned_count(),
        tracked_items: crate::recommended_prices::tracked_count() as u64,
    }
}

#[tauri::command]
pub fn get_wfm_scheduler_snapshot() -> WfmSchedulerSnapshot {
    wfm_scheduler_snapshot()
}

fn validate_external_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }

    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http and https URLs are supported".to_string());
    }

    Ok(trimmed)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let validated_url = validate_external_url(&url)?;
    webbrowser::open(validated_url)
        .map(|_| ())
        .map_err(|error| format!("Failed to open external URL: {error}"))
}

fn build_wfstat_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

fn shared_wfstat_client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    match CLIENT.get_or_init(build_wfstat_client) {
        Ok(client) => Ok(client.clone()),
        Err(error) => Err(error.clone()),
    }
}

fn shared_wfm_client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    match CLIENT.get_or_init(|| {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("language", reqwest::header::HeaderValue::from_static("en"));
        headers.insert("platform", reqwest::header::HeaderValue::from_static("pc"));
        Client::builder()
            .timeout(Duration::from_secs(30))
            .default_headers(headers)
            .build()
            .map_err(|error| error.to_string())
    }) {
        Ok(client) => Ok(client.clone()),
        Err(error) => Err(error.clone()),
    }
}

fn parse_retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let raw = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())?
        .trim();
    // delta-seconds form (the common case for WFM).
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    // HTTP-date form (IMF-fixdate), e.g. "Wed, 21 Oct 2025 07:28:00 GMT" — best-effort: compute
    // the delta from now, clamped at 0. Falls back to None if the date can't be parsed.
    let format = time::format_description::parse(
        "[weekday repr:short], [day] [month repr:short] [year] [hour]:[minute]:[second] GMT",
    )
    .ok()?;
    let parsed = time::PrimitiveDateTime::parse(raw, &format)
        .ok()?
        .assume_utc();
    let seconds = (parsed - time::OffsetDateTime::now_utc())
        .whole_seconds()
        .max(0);
    Some(Duration::from_secs(seconds as u64))
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

fn fetch_wfstat_array(endpoint: &str, label: &str) -> Result<Vec<serde_json::Value>, String> {
    let client = shared_wfstat_client()?;
    let response = client
        .get(format!("{WFSTAT_API_BASE_URL}{endpoint}"))
        .query(&[("language", wfstat_language().as_str())])
        .header("User-Agent", WFM_USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .with_context(|| format!("failed to request WFStat {label}"))
        .map_err(|error| error.to_string())?
        .error_for_status()
        .with_context(|| format!("WFStat {label} request failed"))
        .map_err(|error| error.to_string())?;

    response
        .json::<Vec<serde_json::Value>>()
        .with_context(|| format!("failed to parse WFStat {label} response JSON"))
        .map_err(|error| error.to_string())
}

fn fetch_wfstat_object(endpoint: &str, label: &str) -> Result<serde_json::Value, String> {
    let client = shared_wfstat_client()?;
    let response = client
        .get(format!("{WFSTAT_API_BASE_URL}{endpoint}"))
        .query(&[("language", wfstat_language().as_str())])
        .header("User-Agent", WFM_USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .with_context(|| format!("failed to request WFStat {label}"))
        .map_err(|error| error.to_string())?
        .error_for_status()
        .with_context(|| format!("WFStat {label} request failed"))
        .map_err(|error| error.to_string())?;

    response
        .json::<serde_json::Value>()
        .with_context(|| format!("failed to parse WFStat {label} response JSON"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_worldstate_events() -> Result<Vec<serde_json::Value>, String> {
    fetch_wfstat_array("/pc/events", "events")
}

#[tauri::command]
pub fn get_worldstate_alerts() -> Result<Vec<serde_json::Value>, String> {
    fetch_wfstat_array("/pc/alerts", "alerts")
}

#[tauri::command]
pub fn get_worldstate_invasions() -> Result<Vec<serde_json::Value>, String> {
    fetch_wfstat_array("/pc/invasions", "invasions")
}

#[tauri::command]
pub fn get_worldstate_syndicate_missions() -> Result<Vec<serde_json::Value>, String> {
    fetch_wfstat_array("/pc/syndicateMissions", "syndicate missions")
}

#[tauri::command]
pub fn get_worldstate_sortie() -> Result<serde_json::Value, String> {
    fetch_wfstat_object("/pc/sortie", "sortie")
}

#[tauri::command]
pub fn get_worldstate_arbitration() -> Result<serde_json::Value, String> {
    fetch_wfstat_object("/pc/arbitration", "arbitration")
}

#[tauri::command]
pub fn get_worldstate_archon_hunt() -> Result<serde_json::Value, String> {
    fetch_wfstat_object("/pc/archonHunt", "archon hunt")
}

#[tauri::command]
pub fn get_worldstate_fissures() -> Result<Vec<serde_json::Value>, String> {
    fetch_wfstat_array("/pc/fissures", "fissures")
}

#[tauri::command]
pub fn get_worldstate_market_news() -> Result<MarketNewsResponse, String> {
    let payload = fetch_wfstat_object("/pc", "market & news")?;
    let record = payload
        .as_object()
        .ok_or_else(|| "WFStat market & news response was not an object.".to_string())?;

    let news = record
        .get("news")
        .and_then(|value| value.as_array())
        .cloned()
        .ok_or_else(|| "WFStat market & news payload did not include a news array.".to_string())?;
    let flash_sales = record
        .get("flashSales")
        .and_then(|value| value.as_array())
        .cloned()
        .ok_or_else(|| {
            "WFStat market & news payload did not include a flashSales array.".to_string()
        })?;

    Ok(MarketNewsResponse { news, flash_sales })
}

/// Open-world day/night & temperature cycles (Cetus, Orb Vallis, Cambion Drift, Earth). Pulled
/// from the `/pc` master payload in one request so all cycles stay consistent.
#[tauri::command]
pub fn get_worldstate_cycles() -> Result<serde_json::Value, String> {
    let payload = fetch_wfstat_object("/pc", "cycles")?;
    let record = payload
        .as_object()
        .ok_or_else(|| "WFStat cycles response was not an object.".to_string())?;
    let pick = |key: &str| record.get(key).cloned().unwrap_or(serde_json::Value::Null);
    Ok(serde_json::json!({
        "cetusCycle": pick("cetusCycle"),
        "vallisCycle": pick("vallisCycle"),
        "cambionCycle": pick("cambionCycle"),
        "earthCycle": pick("earthCycle"),
    }))
}

/// Teshin's weekly Steel Path offering (current reward + rotation).
#[tauri::command]
pub fn get_worldstate_steel_path() -> Result<serde_json::Value, String> {
    fetch_wfstat_object("/pc/steelPath", "steel path")
}

/// Current Nightwave season (active challenges + rewards).
#[tauri::command]
pub fn get_worldstate_nightwave() -> Result<serde_json::Value, String> {
    fetch_wfstat_object("/pc/nightwave", "nightwave")
}

/// Strips WFM's set-root naming convention down to how players actually refer to the item — WFM
/// names every set root "X Prime Set" even for a single warframe or weapon (confirmed live:
/// `titania_prime_set`'s own display name is "Titania Prime Set", not "Titania Prime"), but the
/// common name everyone actually uses drops that suffix.
fn strip_trailing_set_suffix(name: &str) -> String {
    name.strip_suffix(" Set").unwrap_or(name).trim().to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTraderTradeableItem {
    pub name: String,
    /// "warframe" or "weapon" — derived from which uniqueName path she carries the item under,
    /// not the catalog's own `item_family` (which classifies every set root as `"set"` for both,
    /// not useful for grouping the panel by kind).
    pub family: String,
    /// `None` when the catalog lookup failed (e.g. offline first run) — the raw WFStat name is
    /// still shown, there's just nothing to link/group/pull an icon from.
    pub slug: Option<String>,
    pub image_path: Option<String>,
    pub regal_aya_cost: Option<i64>,
    /// This item's own slug plus every one of its set components' slugs — every slug whose price
    /// is affected by Varzia currently selling this item's relics (she sells relics that drop
    /// the warframe/weapon in question, which puts every one of its components in extra supply,
    /// not just the set-bundle listing itself).
    pub affected_slugs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTraderInfo {
    pub active: bool,
    pub location: Option<String>,
    pub activation: Option<String>,
    pub expiry: Option<String>,
    /// Warframes + weapons only, resolved and grouped — see `VaultTraderTradeableItem`. Relics,
    /// cosmetics, and bundle packages in her real inventory are excluded entirely: the point of
    /// showing her warframes/weapons at all is that they indicate which relics she's carrying.
    pub tradeable_items: Vec<VaultTraderTradeableItem>,
}

/// Mirrors the frontend's `isWorldStateWindowActive` (see `src/lib/worldState.ts`) — WFStat's
/// `/pc/vaultTrader` payload has no `active` field at all (confirmed live), so this has to be
/// derived from the activation/expiry window instead, same as Void Trader.
fn worldstate_window_active(activation: Option<&str>, expiry: Option<&str>) -> bool {
    let now = time::OffsetDateTime::now_utc();
    let Some(expiry_time) = expiry.and_then(|value| {
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
    }) else {
        return false;
    };
    if expiry_time <= now {
        return false;
    }
    match activation.and_then(|value| {
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
    }) {
        Some(activation_time) => activation_time <= now,
        None => true,
    }
}

/// Varzia / Prime Resurgence — the vaulted-relic vendor in Maroo's Bazaar.
///
/// WFStat's own `item` field for her inventory is inconsistent junk copied from internal naming
/// (`"Astilla Prime Weapon"`, `"Prime Pangolin Sword"` instead of the real `"Astilla Prime"` /
/// `"Pangolin Prime"`). Each entry's `uniqueName` is resolved against the same item catalog
/// everything else in this app uses: her uniqueNames carry an extra `/StoreItems` path segment
/// WFM's own `gameRef` doesn't (confirmed live — `/Lotus/StoreItems/Weapons/.../PrimePangolinSword`
/// vs. WFM's own `/Lotus/Weapons/.../PrimePangolinSword`), but the leaf segment past the last `/`
/// still matches exactly via the catalog's `GameRefLeaf` lookup tier — which only matches when
/// the query is already a bare leaf, so the leaf has to be extracted here before querying, not
/// passed through as the full path. Only entries whose uniqueName is under a warframe or weapon
/// path are kept — she also sells cosmetics, bundles, and the relics themselves, none of which
/// the UI needs.
#[tauri::command]
pub fn get_worldstate_vault_trader(app: tauri::AppHandle) -> Result<VaultTraderInfo, String> {
    let payload = fetch_wfstat_object("/pc/vaultTrader", "vault trader")?;
    let catalog = crate::item_catalog_v2::open_catalog_v2_readonly(&app).ok();

    let location = payload.get("location").and_then(|value| value.as_str()).map(str::to_string);
    let activation = payload.get("activation").and_then(|value| value.as_str()).map(str::to_string);
    let expiry = payload.get("expiry").and_then(|value| value.as_str()).map(str::to_string);
    let active = worldstate_window_active(activation.as_deref(), expiry.as_deref());

    let mut tradeable_items = Vec::new();
    if let Some(inventory) = payload.get("inventory").and_then(|value| value.as_array()) {
        for entry in inventory {
            let Some(unique_name) = entry.get("uniqueName").and_then(|value| value.as_str()) else {
                continue;
            };
            let family = if unique_name.starts_with("/Lotus/StoreItems/Powersuits/") {
                "warframe"
            } else if unique_name.starts_with("/Lotus/StoreItems/Weapons/") {
                "weapon"
            } else {
                continue;
            };

            let leaf = unique_name.rsplit_once('/').map(|(_, leaf)| leaf).unwrap_or(unique_name);
            let resolved = catalog.as_ref().and_then(|connection| {
                crate::item_catalog_v2::lookup_item_v2_inner(connection, leaf)
                    .ok()
                    .flatten()
            });

            let (name, slug, image_path, affected_slugs) = match &resolved {
                Some(item) => {
                    let mut affected = vec![item.slug.clone()];
                    affected.extend(item.set_parts.iter().map(|part| part.slug.clone()));
                    (
                        strip_trailing_set_suffix(&item.name_en),
                        Some(item.slug.clone()),
                        item.preferred_image.clone(),
                        affected,
                    )
                }
                // Catalog lookup failed (e.g. offline first run) — fall back to WFStat's own
                // name rather than silently dropping the entry; nothing to link/group by though.
                None => (
                    entry
                        .get("item")
                        .and_then(|value| value.as_str())
                        .unwrap_or("Unknown Item")
                        .to_string(),
                    None,
                    None,
                    Vec::new(),
                ),
            };
            let regal_aya_cost = entry.get("ducats").and_then(|value| value.as_i64());

            tradeable_items.push(VaultTraderTradeableItem {
                name,
                family: family.to_string(),
                slug,
                image_path,
                regal_aya_cost,
                affected_slugs,
            });
        }
    }

    Ok(VaultTraderInfo { active, location, activation, expiry, tradeable_items })
}

fn normalize_catalog_lookup_value(value: &str) -> Option<String> {
    let normalized = value
        .split_whitespace()
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_lowercase();

    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// Resolves an item name to its v2 item_key + slug via the catalog's deterministic Name-kind
/// lookup — the same resolution `lookup_item_v2_inner` uses for any other query, never a
/// `LIMIT 1` pick among ambiguous candidates.
fn resolve_catalog_item_key_and_slug_by_name(
    connection: &Connection,
    item_name: &str,
) -> Result<Option<(String, String)>> {
    if normalize_catalog_lookup_value(item_name).is_none() {
        return Ok(None);
    }
    let item = crate::item_catalog_v2::lookup_item_v2_inner(connection, item_name)?;
    Ok(item.map(|item| (item.item_key, item.slug)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidTraderItemPrice {
    pub item: String,
    pub recommended_exit_price: Option<i64>,
}

fn scan_void_trader_prices_inner(
    app: &tauri::AppHandle,
    items: Vec<String>,
) -> Result<Vec<VoidTraderItemPrice>> {
    let mut result: Vec<VoidTraderItemPrice> = items
        .iter()
        .map(|item| VoidTraderItemPrice {
            item: item.clone(),
            recommended_exit_price: None,
        })
        .collect();

    let Some(catalog) = crate::item_catalog_v2::open_catalog_v2_readonly(app).ok() else {
        return Ok(result);
    };

    // Resolve names → (index, item_key, slug), dropping any item the v2 catalog can't resolve.
    let mut resolved: Vec<(usize, String, String)> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if let Some((item_key, slug)) = resolve_catalog_item_key_and_slug_by_name(&catalog, item)? {
            resolved.push((index, item_key, slug));
        }
    }

    let pairs: Vec<(String, String)> = resolved
        .iter()
        .map(|(_, item_key, slug)| (item_key.clone(), slug.clone()))
        .collect();
    let prices = crate::market_observatory::scan_recommended_exit_prices(app, &pairs)?;

    for ((index, _, _), price) in resolved.iter().zip(prices.iter()) {
        result[*index].recommended_exit_price = *price;
    }
    Ok(result)
}

/// Scans the Void Trader (Baro) inventory once and returns the recommended exit price for each
/// resolvable, tradeable item. Rate-limited via the WFM scheduler; the frontend runs it a single
/// time per Baro visit.
#[tauri::command]
pub async fn scan_void_trader_prices(
    app: tauri::AppHandle,
    items: Vec<String>,
) -> Result<Vec<VoidTraderItemPrice>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_void_trader_prices_inner(&app, items))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn load_catalog_item_metadata(
    connection: &Connection,
    item_key: &str,
) -> Result<Option<CatalogItemMetadata>> {
    Ok(crate::item_catalog_v2::load_item_metadata_v2(connection, item_key)?.map(|row| {
        CatalogItemMetadata {
            category: row.category,
            image_path: row.image_path,
        }
    }))
}

fn enrich_void_trader_inventory_item(
    connection: Option<&Connection>,
    item: VoidTraderInventoryApiItem,
) -> Result<VoidTraderInventoryItem> {
    let metadata = match connection {
        Some(catalog) => resolve_catalog_item_key_and_slug_by_name(catalog, &item.item)?
            .map(|(item_key, _slug)| load_catalog_item_metadata(catalog, &item_key))
            .transpose()?
            .flatten(),
        None => None,
    };

    Ok(VoidTraderInventoryItem {
        item: item.item,
        ducats: item.ducats,
        credits: item.credits,
        category: metadata
            .as_ref()
            .map(|entry| entry.category.clone())
            .unwrap_or_else(|| "Other".to_string()),
        image_path: metadata.and_then(|entry| entry.image_path),
    })
}

fn fetch_worldstate_void_trader_inner(app: tauri::AppHandle) -> Result<VoidTraderResponse> {
    let client = shared_wfm_client().map_err(anyhow::Error::msg)?;
    let response = client
        .get(format!("{WFSTAT_API_BASE_URL}/pc/voidTrader"))
        .query(&[("language", wfstat_language().as_str())])
        .header("User-Agent", WFM_USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .context("failed to request WFStat void trader")?
        .error_for_status()
        .context("WFStat void trader request failed")?;
    let payload = response
        .json::<VoidTraderApiResponse>()
        .context("failed to parse WFStat void trader response JSON")?;

    let catalog_connection = crate::item_catalog_v2::open_catalog_v2_readonly(&app).ok();
    let mut inventory = payload
        .inventory
        .into_iter()
        .map(|entry| enrich_void_trader_inventory_item(catalog_connection.as_ref(), entry))
        .collect::<Result<Vec<_>>>()?;
    inventory.sort_by(|left, right| {
        left.category
            .to_lowercase()
            .cmp(&right.category.to_lowercase())
            .then_with(|| left.item.to_lowercase().cmp(&right.item.to_lowercase()))
    });

    Ok(VoidTraderResponse {
        id: payload.id.unwrap_or_else(|| "void-trader".to_string()),
        activation: payload.activation,
        expiry: payload.expiry,
        character: payload
            .character
            .unwrap_or_else(|| "Baro Ki'Teer".to_string()),
        location: payload.location,
        inventory,
        ps_id: payload.ps_id,
        initial_start: payload.initial_start,
        schedule: payload.schedule,
        expired: payload.expired,
    })
}

#[tauri::command]
pub async fn get_worldstate_void_trader(
    app: tauri::AppHandle,
) -> Result<VoidTraderResponse, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_worldstate_void_trader_inner(app))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// `WfmAutocompleteItem.item_id` is a legacy numeric field the frontend still keys watchlist/
/// cache entries by (see `useAppStore.ts`). The old catalog's own rowid was itself unstable
/// across rebuilds (see `item_id` comment history) — this hash is deterministic given the same
/// `item_key` (std's `DefaultHasher` uses fixed keys, not per-process randomized ones), so it is
/// at least as stable as what it replaces, without requiring the wider frontend numeric-id ->
/// string-id migration that is out of scope here. `wfm_id` carries the real, fully-stable v2
/// `item_key` for any caller that already resolves identity from it instead.
fn stable_numeric_item_id(item_key: &str) -> i64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    item_key.hash(&mut hasher);
    hasher.finish() as i64
}

/// Removes the `Name: Part` / `Name - Part` separators Warframe.Market puts in some localized
/// item names ("Perigale Prime: Cano", "Trumna Prime - Culasse").
///
/// These come from WFM's own data, not from us — verified against the raw API response, where
/// the English name is "Perigale Prime Barrel" and the Portuguese is "Perigale Prime: Cano".
/// They carry no meaning and only make the item harder to search for, since the user has to
/// reproduce punctuation they can't see the need for. English has zero of them across all
/// 3,837 items, so removing them costs nothing and makes every language read like English.
///
/// Only *spaced* separators are removed. A hyphen inside a word is part of the name — "目—目"
/// (Eye-Eye) and "Photora-Szene" must survive intact.
fn strip_name_separators(name: &str) -> String {
    let cleaned = name.replace(": ", " ").replace(" - ", " ");
    // Collapse any double spacing the removal leaves behind.
    let mut out = String::with_capacity(cleaned.len());
    let mut previous_was_space = false;
    for character in cleaned.chars() {
        let is_space = character == ' ';
        if is_space && previous_was_space {
            continue;
        }
        previous_was_space = is_space;
        out.push(character);
    }
    out.trim().to_string()
}

fn load_wfm_autocomplete_items_inner(
    app: tauri::AppHandle,
    language: Option<String>,
) -> Result<Vec<WfmAutocompleteItem>> {
    let connection = crate::item_catalog_v2::open_catalog_v2_readonly(&app)?;
    // Localize the display name from the catalog's per-language table (item_i18n), falling back
    // to English when no translation exists. Passing "en" is a harmless no-op.
    let lang_code = language.unwrap_or_else(|| "en".to_string());
    let rows = crate::item_catalog_v2::load_autocomplete_items_v2(&connection, &lang_code)?;

    Ok(rows
        .into_iter()
        .map(|row| WfmAutocompleteItem {
            item_id: stable_numeric_item_id(&row.item_key),
            wfm_id: row.item_key,
            // Cleaned on read, not on import, so installs that already downloaded a language
            // pack are fixed on next launch with no re-download.
            name: strip_name_separators(&row.name),
            name_en: row.name_en,
            slug: row.slug,
            max_rank: row.max_rank,
            item_family: Some(row.item_family),
            image_path: row.image_path,
            bulk_tradable: row.bulk_tradable,
        })
        .collect())
}

fn load_relic_tier_icons_inner(app: tauri::AppHandle) -> Result<Vec<RelicTierIcon>> {
    let connection = crate::item_catalog_v2::open_catalog_v2_readonly(&app)?;
    let rows = crate::item_catalog_v2::load_relic_tier_icons_v2(&connection)?;
    Ok(rows
        .into_iter()
        .map(|row| RelicTierIcon {
            tier: row.tier,
            image_path: row.image_path,
        })
        .collect())
}

fn compare_sell_orders(left: &WfmTopSellOrder, right: &WfmTopSellOrder) -> Ordering {
    left.platinum.cmp(&right.platinum).then_with(|| {
        left.username
            .to_lowercase()
            .cmp(&right.username.to_lowercase())
    })
}

fn normalize_seller_mode(value: Option<&str>) -> &'static str {
    match value.unwrap_or("ingame").trim() {
        "ingame-online" => "ingame-online",
        _ => "ingame",
    }
}

fn seller_mode_allows_status(status: Option<&str>, seller_mode: &str) -> bool {
    match normalize_seller_mode(Some(seller_mode)) {
        "ingame-online" => matches!(status, Some("ingame" | "online")),
        _ => matches!(status, Some("ingame")),
    }
}

fn order_matches_variant(rank: Option<i64>, variant_key: Option<&str>) -> bool {
    let normalized_variant = variant_key.unwrap_or("base").trim();
    if normalized_variant.is_empty() || normalized_variant == "base" {
        return rank.is_none();
    }

    normalized_variant
        .strip_prefix("rank:")
        .and_then(|value| value.parse::<i64>().ok())
        .map(|expected_rank| rank == Some(expected_rank))
        .unwrap_or(true)
}

fn normalize_top_sell_orders(
    slug: &str,
    api_version: Option<String>,
    orders: Vec<WfmOrderWithUser>,
    variant_key: Option<&str>,
    seller_mode: &str,
) -> WfmTopSellOrdersResponse {
    let mut normalized = orders
        .into_iter()
        .filter_map(|order| {
            if order.order_type != "sell" || order.visible == Some(false) {
                return None;
            }
            if !seller_mode_allows_status(order.user.status.as_deref(), seller_mode) {
                return None;
            }
            if !order_matches_variant(order.rank, variant_key) {
                return None;
            }
            let username = order.user.ingame_name?;
            Some(WfmTopSellOrder {
                order_id: order.id,
                platinum: order.platinum,
                quantity: order.quantity.unwrap_or(1),
                per_trade: order.per_trade.unwrap_or(1),
                rank: order.rank,
                username,
                user_slug: order.user.slug,
                status: order.user.status,
            })
        })
        .collect::<Vec<_>>();

    normalized.sort_by(compare_sell_orders);

    WfmTopSellOrdersResponse {
        api_version,
        slug: slug.to_string(),
        sell_orders: normalized,
    }
}

fn fetch_wfm_top_sell_orders_inner(
    slug: String,
    variant_key: Option<String>,
    seller_mode: Option<String>,
) -> Result<WfmTopSellOrdersResponse> {
    let trimmed_slug = slug.trim();
    if trimmed_slug.is_empty() {
        return Err(anyhow::anyhow!("item slug cannot be empty"));
    }

    // Fetch the full order book snapshot for the item and filter it locally. This returns
    // every sell listing (not just the top 5) so the quick view can show the cheapest few
    // and the "View All" popup can list every online/in-game seller, sorted by price.
    let client = shared_wfm_client().map_err(anyhow::Error::msg)?;
    let response = execute_wfm_bytes_request(
        client
            .get(format!("{WFM_API_BASE_URL}/orders/item/{trimmed_slug}"))
            .header("User-Agent", WFM_USER_AGENT)
            .header("Language", WFM_LANGUAGE_HEADER)
            .header("Platform", WFM_PLATFORM_HEADER)
            .header("Crossplay", WFM_CROSSPLAY_HEADER),
        RequestPriority::Instant,
        "request WFM item orders",
        Some(format!("orders:item:{trimmed_slug}")),
    )?;
    if response.status < 200 || response.status >= 300 {
        let body = String::from_utf8_lossy(&response.body);
        let trimmed = body.trim();
        return Err(anyhow::anyhow!(if trimmed.is_empty() {
            format!(
                "WFM item orders request failed with status {}",
                response.status
            )
        } else {
            format!(
                "WFM item orders request failed with status {}: {}",
                response.status, trimmed
            )
        }));
    }
    let payload = serde_json::from_slice::<WfmOrdersApiResponse>(&response.body)
        .context("failed to parse WFM item orders response JSON")?;

    Ok(normalize_top_sell_orders(
        trimmed_slug,
        payload.api_version,
        payload.data,
        variant_key.as_deref(),
        normalize_seller_mode(seller_mode.as_deref()),
    ))
}

#[derive(Debug, Default)]
struct StartupCommandState {
    in_progress: bool,
    last_result: Option<Result<crate::item_catalog_v2::StartupSummary, String>>,
}

fn startup_command_state() -> &'static (Mutex<StartupCommandState>, Condvar) {
    static STATE: OnceLock<(Mutex<StartupCommandState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(StartupCommandState::default()), Condvar::new()))
}

fn cached_startup_summary(
    state: &StartupCommandState,
) -> Option<Result<crate::item_catalog_v2::StartupSummary, String>> {
    match &state.last_result {
        Some(Ok(summary)) => Some(Ok(summary.clone())),
        Some(Err(_)) | None => None,
    }
}

fn run_initialize_app_catalog(
    app: tauri::AppHandle,
) -> Result<crate::item_catalog_v2::StartupSummary, String> {
    let (state_lock, state_signal) = startup_command_state();
    let mut state = state_lock.lock().map_err(|_| {
        let error = anyhow::anyhow!("startup command state lock poisoned");
        log_feature_error_best_effort(
            &app,
            "bootstrap",
            "startup-command-lock",
            "Failed to acquire the startup command state lock.",
            &error,
        );
        error.to_string()
    })?;

    if let Some(result) = cached_startup_summary(&state) {
        return result;
    }

    while state.in_progress {
        state = state_signal.wait(state).map_err(|_| {
            let error = anyhow::anyhow!("startup command state lock poisoned");
            log_feature_error_best_effort(
                &app,
                "bootstrap",
                "startup-command-wait",
                "Failed while waiting for another startup initialization to finish.",
                &error,
            );
            error.to_string()
        })?;

        if let Some(result) = &state.last_result {
            return result.clone();
        }
    }

    state.in_progress = true;
    state.last_result = None;
    drop(state);

    // The sole boot-time catalog build step. Deliberately blocking, not a background thread:
    // the app is allowed to stay on the loading screen until this lands, since nothing downstream
    // (order creation, trade log import, portfolio valuation, set-completion scanning) can
    // resolve an item's identity without it.
    let result = crate::item_catalog_v2::initialize_catalog_v2_on_startup(&app);

    let mut state = state_lock.lock().map_err(|_| {
        let error = anyhow::anyhow!("startup command state lock poisoned");
        log_feature_error_best_effort(
            &app,
            "bootstrap",
            "startup-command-finalize",
            "Failed to reacquire the startup command state lock after initialization.",
            &error,
        );
        error.to_string()
    })?;
    state.in_progress = false;
    state.last_result = Some(result.clone());
    state_signal.notify_all();

    result
}

#[tauri::command]
pub async fn initialize_app_catalog(
    app: tauri::AppHandle,
) -> Result<crate::item_catalog_v2::StartupSummary, String> {
    let app_for_worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_initialize_app_catalog(app_for_worker))
        .await
        .map_err(|error| {
            let wrapped = anyhow::anyhow!(error.to_string());
            log_feature_error_best_effort(
                &app,
                "bootstrap",
                "startup-command-spawn",
                "The startup worker thread failed before initialization could finish.",
                &wrapped,
            );
            wrapped.to_string()
        })?
}

#[tauri::command]
pub async fn get_wfm_autocomplete_items(
    app: tauri::AppHandle,
    language: Option<String>,
) -> Result<Vec<WfmAutocompleteItem>, String> {
    tauri::async_runtime::spawn_blocking(move || load_wfm_autocomplete_items_inner(app, language))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_language_pack_status(
    app: tauri::AppHandle,
    language: String,
) -> Result<crate::item_catalog_v2::LanguagePackStatusV2, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::item_catalog_v2::get_language_pack_status_v2(app, language)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn populate_language_item_names(
    app: tauri::AppHandle,
    language: String,
) -> Result<crate::item_catalog_v2::LanguagePackImportResultV2, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::item_catalog_v2::populate_language_item_names_v2(app, language)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn export_language_pack(
    app: tauri::AppHandle,
    language: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::item_catalog_v2::export_language_pack_v2(app, language)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn import_language_pack(
    app: tauri::AppHandle,
    pack: String,
) -> Result<crate::item_catalog_v2::LanguagePackImportResultV2, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::item_catalog_v2::import_language_pack_v2(app, pack)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_relic_tier_icons(app: tauri::AppHandle) -> Result<Vec<RelicTierIcon>, String> {
    tauri::async_runtime::spawn_blocking(move || load_relic_tier_icons_inner(app))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_wfm_top_sell_orders(
    slug: String,
    variant_key: Option<String>,
    seller_mode: Option<String>,
) -> Result<WfmTopSellOrdersResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_wfm_top_sell_orders_inner(slug, variant_key, seller_mode)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{strip_trailing_set_suffix, worldstate_window_active};

    #[test]
    fn strips_trailing_set_suffix() {
        // Real WFM display names — confirmed live that every set root, warframe or weapon
        // alike, is named "X Prime Set" even when the set contains one item.
        assert_eq!(strip_trailing_set_suffix("Titania Prime Set"), "Titania Prime");
        assert_eq!(strip_trailing_set_suffix("Pangolin Prime Set"), "Pangolin Prime");
        assert_eq!(strip_trailing_set_suffix("Astilla Prime Set"), "Astilla Prime");
        // No suffix to strip — left untouched, not mangled.
        assert_eq!(strip_trailing_set_suffix("Gara Prime"), "Gara Prime");
    }

    /// Reproduces the real Varzia-panel bug end to end: her `uniqueName` carries an extra
    /// `/StoreItems` path segment WFM's own `gameRef` doesn't, so `lookup_item_v2_inner` (which
    /// only matches `GameRefLeaf` when the query is ALREADY a bare leaf, not a full path) needs
    /// the leaf extracted from her uniqueName before it's queried — passing the full path
    /// through, as an earlier version of this code did, silently never resolves.
    #[test]
    fn resolves_a_varzia_style_unique_name_via_its_extracted_leaf() {
        use crate::item_catalog_v2::{build_item_lookup, initialize_schema, lookup_item_v2_inner, write_items, write_lookup, ItemRow};
        use std::collections::HashMap;

        let items = vec![ItemRow {
            item_key: "titania".into(),
            slug: "titania_prime_set".into(),
            game_ref: Some("/Lotus/Powersuits/Fairy/TitaniaPrime".into()),
            name_en: "Titania Prime Set".into(),
            item_family: "set".into(),
            max_rank: None,
            ducats: None,
            bulk_tradable: false,
            set_root: true,
            icon: None,
            thumb: None,
            subtypes: Vec::new(),
            relic_tier: None,
            preferred_image: None,
        }];
        let (lookup, rejected) = build_item_lookup(&items, &HashMap::new());
        assert!(rejected.is_empty());

        let connection = rusqlite::Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        write_items(&connection, &items).unwrap();
        write_lookup(&connection, &lookup, &rejected).unwrap();

        // The full path (as Varzia's API sends it) must NOT resolve directly — this is the
        // exact shape of the original bug, kept as a guard against regressing back to it.
        let full_path_query = "/Lotus/StoreItems/Powersuits/Fairy/TitaniaPrime";
        assert!(lookup_item_v2_inner(&connection, full_path_query).unwrap().is_none());

        // The extracted leaf resolves correctly, matching what `get_worldstate_vault_trader`
        // now does before calling this function.
        let leaf = full_path_query.rsplit_once('/').map(|(_, leaf)| leaf).unwrap();
        let resolved = lookup_item_v2_inner(&connection, leaf).unwrap().expect("leaf resolves");
        assert_eq!(strip_trailing_set_suffix(&resolved.name_en), "Titania Prime");
    }

    #[test]
    fn worldstate_window_active_matches_activation_expiry_bounds() {
        // No `active` field exists on WFStat's real payload — this is the sole source of truth
        // for whether Varzia is currently in the bazaar.
        assert!(!worldstate_window_active(
            Some("2026-07-09T18:00:00.000Z"),
            None,
        ));
        assert!(!worldstate_window_active(None, None));
        // Expired window: not active even with a real activation time.
        assert!(!worldstate_window_active(
            Some("2020-01-01T00:00:00.000Z"),
            Some("2020-01-02T00:00:00.000Z"),
        ));
        // Far-future window: not active yet.
        assert!(!worldstate_window_active(
            Some("2999-01-01T00:00:00.000Z"),
            Some("2999-02-01T00:00:00.000Z"),
        ));
        // Currently within a wide-open window: active.
        assert!(worldstate_window_active(
            Some("2020-01-01T00:00:00.000Z"),
            Some("2999-01-01T00:00:00.000Z"),
        ));
    }

    /// Real strings from Warframe.Market's API. WFM ships these separators in its own localized
    /// names — English has zero across all 3,837 items — so stripping them is data cleanup, not
    /// a change to what an item is called.
    #[test]
    fn strips_wfm_localized_name_separators() {
        assert_eq!(strip_name_separators("Perigale Prime: Cano"), "Perigale Prime Cano");
        assert_eq!(strip_name_separators("Quassus Prime: Klinge"), "Quassus Prime Klinge");
        assert_eq!(strip_name_separators("Trumna Prime - Culasse"), "Trumna Prime Culasse");
        assert_eq!(strip_name_separators("Frost Prime: Conjunto"), "Frost Prime Conjunto");
    }

    #[test]
    fn leaves_english_names_untouched() {
        for name in [
            "Mesa Prime Set",
            "Perigale Prime Barrel",
            "Titania Prime Neuroptics Blueprint",
        ] {
            assert_eq!(strip_name_separators(name), name);
        }
    }

    #[test]
    fn preserves_hyphens_that_are_part_of_the_name() {
        // Only *spaced* separators are structural. These are real names and must survive:
        // "Eye-Eye" in Chinese, and a compound German word.
        assert_eq!(strip_name_separators("\u{76ee}\u{2014}\u{76ee}"), "\u{76ee}\u{2014}\u{76ee}");
        assert_eq!(strip_name_separators("Photora-Szene"), "Photora-Szene");
        // Both kinds in one real name: the spaced dash goes, the in-word hyphen stays.
        assert_eq!(
            strip_name_separators("Photora-Szene: Citrines Letzter Wunsch - Fabrik"),
            "Photora-Szene Citrines Letzter Wunsch Fabrik"
        );
    }

    #[test]
    fn collapses_whitespace_left_behind() {
        assert_eq!(strip_name_separators("Fluctus:  Cano"), "Fluctus Cano");
        assert_eq!(strip_name_separators("  Vasto Prime: Conjunto  "), "Vasto Prime Conjunto");
    }

    #[test]
    fn keeps_parenthetical_qualifiers_wfm_uses() {
        // WFM marks blueprints/arcanes with a trailing parenthetical; that is meaningful.
        assert_eq!(
            strip_name_separators("Zephyr Prime: Chassi (Diagrama)"),
            "Zephyr Prime Chassi (Diagrama)"
        );
    }
    use super::{
        cached_startup_summary, normalize_catalog_lookup_value, normalize_top_sell_orders,
        seller_mode_allows_status, strip_name_separators, validate_external_url,
        StartupCommandState, WfmOrderUser,
        WfmOrderWithUser,
    };
    use crate::item_catalog_v2::{ImportStats, StartupSummary};

    fn sample_summary() -> StartupSummary {
        StartupSummary {
            ready: true,
            refreshed: false,
            database_path: "/tmp/item_catalog_v2.sqlite".to_string(),
            data_dir: "/tmp".to_string(),
            wfm_source_file: String::new(),
            wfstat_source_file: None,
            stats: ImportStats::default(),
            current_wfm_api_version: Some("v2".to_string()),
            wfstat_stale: false,
        }
    }

    #[test]
    fn caches_successful_startup_result() {
        let state = StartupCommandState {
            in_progress: false,
            last_result: Some(Ok(sample_summary())),
        };

        let cached = cached_startup_summary(&state).expect("cached success");
        assert!(cached.is_ok());
    }

    #[test]
    fn does_not_cache_failed_startup_result() {
        let state = StartupCommandState {
            in_progress: false,
            last_result: Some(Err("startup failed".to_string())),
        };

        assert!(cached_startup_summary(&state).is_none());
    }

    #[test]
    fn normalizes_and_sorts_all_sell_orders() {
        let response = normalize_top_sell_orders(
            "arcane_energize",
            Some("0.22.7".to_string()),
            vec![
                WfmOrderWithUser {
                    id: "3".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 9,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("charlie".to_string()),
                        slug: Some("charlie".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "1".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 5,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("alpha".to_string()),
                        slug: Some("alpha".to_string()),
                        status: Some("ingame".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "skip".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 4,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: None,
                        slug: Some("missing".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "2".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 7,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("bravo".to_string()),
                        slug: Some("bravo".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "4".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 10,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("delta".to_string()),
                        slug: Some("delta".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "5".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 11,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("echo".to_string()),
                        slug: Some("echo".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "6".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 12,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("foxtrot".to_string()),
                        slug: Some("foxtrot".to_string()),
                        status: Some("online".to_string()),
                    },
                },
            ],
            Some("rank:0"),
            "ingame-online",
        );

        assert_eq!(response.slug, "arcane_energize");
        // All valid sell orders are returned (the one with a missing ingame name is
        // dropped), sorted by price — no truncation, so "View All" can show every seller.
        assert_eq!(response.sell_orders.len(), 6);
        assert_eq!(response.sell_orders[0].username, "alpha");
        assert_eq!(response.sell_orders[5].username, "foxtrot");
    }

    #[test]
    fn ignores_non_sell_hidden_and_wrong_rank_orders() {
        let response = normalize_top_sell_orders(
            "primary_merciless",
            Some("0.22.7".to_string()),
            vec![
                WfmOrderWithUser {
                    id: "buy".to_string(),
                    order_type: "buy".to_string(),
                    platinum: 300,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(5),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("buyer".to_string()),
                        slug: Some("buyer".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "hidden".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 20,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(5),
                    visible: Some(false),
                    user: WfmOrderUser {
                        ingame_name: Some("hidden".to_string()),
                        slug: Some("hidden".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "wrong-rank".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 30,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(4),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("wrong".to_string()),
                        slug: Some("wrong".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "match".to_string(),
                    order_type: "sell".to_string(),
                    platinum: 40,
                    quantity: Some(2),
                    per_trade: Some(1),
                    rank: Some(5),
                    visible: Some(true),
                    user: WfmOrderUser {
                        ingame_name: Some("seller".to_string()),
                        slug: Some("seller".to_string()),
                        status: Some("online".to_string()),
                    },
                },
            ],
            Some("rank:5"),
            "ingame-online",
        );

        assert_eq!(response.sell_orders.len(), 1);
        assert_eq!(response.sell_orders[0].order_id, "match");
    }

    #[test]
    fn seller_mode_filters_statuses() {
        assert!(seller_mode_allows_status(Some("ingame"), "ingame"));
        assert!(!seller_mode_allows_status(Some("online"), "ingame"));
        assert!(!seller_mode_allows_status(Some("offline"), "ingame"));
        assert!(seller_mode_allows_status(Some("ingame"), "ingame-online"));
        assert!(seller_mode_allows_status(Some("online"), "ingame-online"));
        assert!(!seller_mode_allows_status(Some("offline"), "ingame-online"));
    }

    #[test]
    fn normalizes_catalog_lookup_values() {
        assert_eq!(
            normalize_catalog_lookup_value("  Primed   Continuity  "),
            Some("primed continuity".to_string())
        );
        assert_eq!(normalize_catalog_lookup_value("   "), None);
    }

    #[test]
    fn validates_http_and_https_urls() {
        assert_eq!(
            validate_external_url("https://warframe.fandom.com/wiki/Wisp_Prime_Set").unwrap(),
            "https://warframe.fandom.com/wiki/Wisp_Prime_Set"
        );
        assert_eq!(
            validate_external_url(" http://example.com ").unwrap(),
            "http://example.com"
        );
    }

    #[test]
    fn rejects_empty_or_unsupported_urls() {
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("   ").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("file:///tmp/test").is_err());
    }
}
