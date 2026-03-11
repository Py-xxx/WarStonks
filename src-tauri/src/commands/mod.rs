use anyhow::{Context, Result};
use reqwest::blocking::Client;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

use crate::item_catalog;

const ITEM_CATALOG_DATABASE_FILE: &str = "item_catalog.sqlite";
const WFM_API_BASE_URL: &str = "https://api.warframe.market/v2";
const WFSTAT_API_BASE_URL: &str = "https://api.warframestat.us";
const WFM_LANGUAGE_HEADER: &str = "en";
const WFM_PLATFORM_HEADER: &str = "pc";
const WFM_CROSSPLAY_HEADER: &str = "true";
const WFM_USER_AGENT: &str = "warstonks/3.0.0";
const WFSTAT_LANGUAGE_QUERY: &str = "en";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmAutocompleteItem {
    pub item_id: i64,
    pub name: String,
    pub slug: String,
    pub max_rank: Option<i64>,
    pub item_family: Option<String>,
    pub image_path: Option<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmTopOrdersApiResponse {
    api_version: Option<String>,
    data: WfmTopOrdersData,
}

#[derive(Debug, Deserialize)]
struct WfmTopOrdersData {
    #[serde(default)]
    sell: Vec<WfmOrderWithUser>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WfmOrderWithUser {
    id: String,
    platinum: i64,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    per_trade: Option<i64>,
    #[serde(default)]
    rank: Option<i64>,
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

fn build_wfstat_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

fn fetch_wfstat_array(endpoint: &str, label: &str) -> Result<Vec<serde_json::Value>, String> {
    let client = build_wfstat_client()?;
    let response = client
        .get(format!("{WFSTAT_API_BASE_URL}{endpoint}"))
        .query(&[("language", WFSTAT_LANGUAGE_QUERY)])
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
    let client = build_wfstat_client()?;
    let response = client
        .get(format!("{WFSTAT_API_BASE_URL}{endpoint}"))
        .query(&[("language", WFSTAT_LANGUAGE_QUERY)])
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

fn resolve_catalog_item_id_by_name(
    connection: &Connection,
    item_name: &str,
) -> Result<Option<i64>> {
    let Some(normalized_name) = normalize_catalog_lookup_value(item_name) else {
        return Ok(None);
    };

    let alias_item_id = connection
        .query_row(
            "SELECT item_id
             FROM item_aliases
             WHERE normalized_alias_value = ?1
             ORDER BY
               CASE alias_scope
                 WHEN 'wfm_name_en' THEN 0
                 WHEN 'wfstat_name' THEN 1
                 WHEN 'wfstat_component_name' THEN 2
                 WHEN 'normalized_name' THEN 3
                 ELSE 4
               END,
               is_primary DESC,
               alias_id ASC
             LIMIT 1",
            [normalized_name.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;

    if alias_item_id.is_some() {
        return Ok(alias_item_id);
    }

    let indexed_item_id = connection
        .query_row(
            "SELECT item_id
             FROM items
             WHERE canonical_name_normalized = ?1
             UNION
             SELECT item_id
             FROM wfm_items
             WHERE normalized_name_en = ?1
             UNION
             SELECT item_id
             FROM wfstat_items
             WHERE normalized_name = ?1
             LIMIT 1",
            [normalized_name.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;

    Ok(indexed_item_id)
}

fn load_catalog_item_metadata(
    connection: &Connection,
    item_id: i64,
) -> Result<Option<CatalogItemMetadata>> {
    connection
        .query_row(
            "SELECT
               COALESCE(
                 NULLIF(wfstat_items.category, ''),
                 NULLIF(wfstat_items.type, ''),
                 NULLIF(wfm_items.item_family, ''),
                 NULLIF(items.item_family, ''),
                 'Other'
               ) AS category,
               COALESCE(
                 NULLIF(items.preferred_image, ''),
                 NULLIF(wfm_items.thumb, ''),
                 NULLIF(wfm_items.icon, ''),
                 NULLIF(wfstat_items.wikia_thumbnail, '')
               ) AS image_path
             FROM items
             LEFT JOIN wfm_items
               ON wfm_items.item_id = items.item_id
             LEFT JOIN wfstat_items
               ON wfstat_items.item_id = items.item_id
             WHERE items.item_id = ?1
             LIMIT 1",
            [item_id],
            |row| {
                Ok(CatalogItemMetadata {
                    category: row.get::<_, String>(0)?,
                    image_path: row.get::<_, Option<String>>(1)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn enrich_void_trader_inventory_item(
    connection: Option<&Connection>,
    item: VoidTraderInventoryApiItem,
) -> Result<VoidTraderInventoryItem> {
    let metadata = match connection {
        Some(catalog) => resolve_catalog_item_id_by_name(catalog, &item.item)?
            .map(|item_id| load_catalog_item_metadata(catalog, item_id))
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
    let client = Client::builder().timeout(Duration::from_secs(30)).build()?;
    let response = client
        .get(format!("{WFSTAT_API_BASE_URL}/pc/voidTrader"))
        .query(&[("language", WFSTAT_LANGUAGE_QUERY)])
        .header("User-Agent", WFM_USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .context("failed to request WFStat void trader")?
        .error_for_status()
        .context("WFStat void trader request failed")?;
    let payload = response
        .json::<VoidTraderApiResponse>()
        .context("failed to parse WFStat void trader response JSON")?;

    let catalog_connection = open_catalog_database(&app).ok();
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

fn load_wfm_autocomplete_items_inner(app: tauri::AppHandle) -> Result<Vec<WfmAutocompleteItem>> {
    let connection = open_catalog_database(&app)?;
    let mut statement = connection.prepare(
        "SELECT
            item_id,
            name_en,
            slug,
            max_rank,
            item_family,
            COALESCE(NULLIF(thumb, ''), NULLIF(icon, ''))
         FROM wfm_items
         WHERE name_en IS NOT NULL
         ORDER BY name_en COLLATE NOCASE, slug COLLATE NOCASE",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(WfmAutocompleteItem {
            item_id: row.get(0)?,
            name: row.get(1)?,
            slug: row.get(2)?,
            max_rank: row.get(3)?,
            item_family: row.get(4)?,
            image_path: row.get(5)?,
        })
    })?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }

    Ok(items)
}

fn load_relic_tier_icons_inner(app: tauri::AppHandle) -> Result<Vec<RelicTierIcon>> {
    let connection = open_catalog_database(&app)?;
    let mut statement = connection.prepare(
        "WITH ranked AS (
            SELECT
              relic_tier,
              preferred_image,
              ROW_NUMBER() OVER (
                PARTITION BY relic_tier
                ORDER BY
                  CASE WHEN preferred_image = 'items/unknown.thumb.png' THEN 1 ELSE 0 END,
                  preferred_name ASC
              ) AS row_rank
            FROM items
            WHERE item_family = 'relics'
              AND relic_tier IS NOT NULL
              AND preferred_image IS NOT NULL
          )
          SELECT relic_tier, preferred_image
          FROM ranked
          WHERE row_rank = 1
          ORDER BY relic_tier COLLATE NOCASE",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(RelicTierIcon {
            tier: row.get(0)?,
            image_path: row.get(1)?,
        })
    })?;

    let mut icons = Vec::new();
    for row in rows {
        icons.push(row?);
    }

    Ok(icons)
}

fn compare_sell_orders(left: &WfmTopSellOrder, right: &WfmTopSellOrder) -> Ordering {
    left.platinum.cmp(&right.platinum).then_with(|| {
        left.username
            .to_lowercase()
            .cmp(&right.username.to_lowercase())
    })
}

fn normalize_top_sell_orders(
    slug: &str,
    api_version: Option<String>,
    sell_orders: Vec<WfmOrderWithUser>,
) -> WfmTopSellOrdersResponse {
    let mut normalized = sell_orders
        .into_iter()
        .filter_map(|order| {
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
    normalized.truncate(5);

    WfmTopSellOrdersResponse {
        api_version,
        slug: slug.to_string(),
        sell_orders: normalized,
    }
}

fn fetch_wfm_top_sell_orders_inner(slug: String) -> Result<WfmTopSellOrdersResponse> {
    let trimmed_slug = slug.trim();
    if trimmed_slug.is_empty() {
        return Err(anyhow::anyhow!("item slug cannot be empty"));
    }

    let client = Client::builder().timeout(Duration::from_secs(30)).build()?;
    let response = client
        .get(format!("{WFM_API_BASE_URL}/orders/item/{trimmed_slug}/top"))
        .header("User-Agent", WFM_USER_AGENT)
        .header("Language", WFM_LANGUAGE_HEADER)
        .header("Platform", WFM_PLATFORM_HEADER)
        .header("Crossplay", WFM_CROSSPLAY_HEADER)
        .send()
        .context("failed to request top WFM orders")?
        .error_for_status()
        .context("WFM top orders request failed")?;
    let payload = response
        .json::<WfmTopOrdersApiResponse>()
        .context("failed to parse WFM top orders response JSON")?;

    Ok(normalize_top_sell_orders(
        trimmed_slug,
        payload.api_version,
        payload.data.sell,
    ))
}

#[derive(Debug, Default)]
struct StartupCommandState {
    in_progress: bool,
    last_result: Option<Result<item_catalog::StartupSummary, String>>,
}

fn startup_command_state() -> &'static (Mutex<StartupCommandState>, Condvar) {
    static STATE: OnceLock<(Mutex<StartupCommandState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(StartupCommandState::default()), Condvar::new()))
}

fn cached_startup_summary(
    state: &StartupCommandState,
) -> Option<Result<item_catalog::StartupSummary, String>> {
    match &state.last_result {
        Some(Ok(summary)) => Some(Ok(summary.clone())),
        Some(Err(_)) | None => None,
    }
}

fn run_initialize_app_catalog(
    app: tauri::AppHandle,
) -> Result<item_catalog::StartupSummary, String> {
    let (state_lock, state_signal) = startup_command_state();
    let mut state = state_lock
        .lock()
        .map_err(|_| "startup command state lock poisoned".to_string())?;

    if let Some(result) = cached_startup_summary(&state) {
        return result;
    }

    while state.in_progress {
        state = state_signal
            .wait(state)
            .map_err(|_| "startup command state lock poisoned".to_string())?;

        if let Some(result) = &state.last_result {
            return result.clone();
        }
    }

    state.in_progress = true;
    state.last_result = None;
    drop(state);

    let result = item_catalog::initialize_app_catalog(app);

    let mut state = state_lock
        .lock()
        .map_err(|_| "startup command state lock poisoned".to_string())?;
    state.in_progress = false;
    state.last_result = Some(result.clone());
    state_signal.notify_all();

    result
}

#[tauri::command]
pub async fn initialize_app_catalog(
    app: tauri::AppHandle,
) -> Result<item_catalog::StartupSummary, String> {
    tauri::async_runtime::spawn_blocking(move || run_initialize_app_catalog(app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_wfm_autocomplete_items(
    app: tauri::AppHandle,
) -> Result<Vec<WfmAutocompleteItem>, String> {
    tauri::async_runtime::spawn_blocking(move || load_wfm_autocomplete_items_inner(app))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_relic_tier_icons(app: tauri::AppHandle) -> Result<Vec<RelicTierIcon>, String> {
    tauri::async_runtime::spawn_blocking(move || load_relic_tier_icons_inner(app))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_wfm_top_sell_orders(slug: String) -> Result<WfmTopSellOrdersResponse, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_wfm_top_sell_orders_inner(slug))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        cached_startup_summary, normalize_catalog_lookup_value, normalize_top_sell_orders,
        StartupCommandState, WfmOrderUser, WfmOrderWithUser,
    };
    use crate::item_catalog::{ImportStats, StartupSummary};

    fn sample_summary() -> StartupSummary {
        StartupSummary {
            ready: true,
            refreshed: false,
            database_path: "/tmp/item_catalog.sqlite".to_string(),
            data_dir: "/tmp".to_string(),
            wfm_source_file: "/tmp/WFM-items.json".to_string(),
            wfstat_source_file: Some("/tmp/WFStat-items.json".to_string()),
            stats: ImportStats::default(),
            current_wfm_api_version: Some("v2".to_string()),
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
    fn normalizes_and_truncates_top_sell_orders() {
        let response = normalize_top_sell_orders(
            "arcane_energize",
            Some("0.22.7".to_string()),
            vec![
                WfmOrderWithUser {
                    id: "3".to_string(),
                    platinum: 9,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    user: WfmOrderUser {
                        ingame_name: Some("charlie".to_string()),
                        slug: Some("charlie".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "1".to_string(),
                    platinum: 5,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    user: WfmOrderUser {
                        ingame_name: Some("alpha".to_string()),
                        slug: Some("alpha".to_string()),
                        status: Some("ingame".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "skip".to_string(),
                    platinum: 4,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    user: WfmOrderUser {
                        ingame_name: None,
                        slug: Some("missing".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "2".to_string(),
                    platinum: 7,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    user: WfmOrderUser {
                        ingame_name: Some("bravo".to_string()),
                        slug: Some("bravo".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "4".to_string(),
                    platinum: 10,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    user: WfmOrderUser {
                        ingame_name: Some("delta".to_string()),
                        slug: Some("delta".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "5".to_string(),
                    platinum: 11,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    user: WfmOrderUser {
                        ingame_name: Some("echo".to_string()),
                        slug: Some("echo".to_string()),
                        status: Some("online".to_string()),
                    },
                },
                WfmOrderWithUser {
                    id: "6".to_string(),
                    platinum: 12,
                    quantity: Some(1),
                    per_trade: Some(1),
                    rank: Some(0),
                    user: WfmOrderUser {
                        ingame_name: Some("foxtrot".to_string()),
                        slug: Some("foxtrot".to_string()),
                        status: Some("online".to_string()),
                    },
                },
            ],
        );

        assert_eq!(response.slug, "arcane_energize");
        assert_eq!(response.sell_orders.len(), 5);
        assert_eq!(response.sell_orders[0].username, "alpha");
        assert_eq!(response.sell_orders[4].username, "echo");
    }

    #[test]
    fn normalizes_catalog_lookup_values() {
        assert_eq!(
            normalize_catalog_lookup_value("  Primed   Continuity  "),
            Some("primed continuity".to_string())
        );
        assert_eq!(normalize_catalog_lookup_value("   "), None);
    }
}
