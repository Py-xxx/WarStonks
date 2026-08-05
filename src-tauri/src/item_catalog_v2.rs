//! The v2 item catalog (see the planning discussion for the full design rationale).
//!
//! Design, in one sentence: **Warframe.Market is the spine; warframestat.us is optional
//! decoration that can be entirely absent without breaking anything.**
//!
//! Identity is the WFM item id (`item_key`), never a positional rowid — that one change is the
//! direct fix for the item-id-drift bug that cost a week of chasing "the price is right, for
//! the wrong item." Every WFStat cross-reference is either exact (WFM's own `gameRef`/
//! `setParts`/`marketInfo.id`) or explicitly bounded/uniqueness-checked — nothing falls back to
//! a global fuzzy name search, because that mechanism is what produced 2,753 ambiguous aliases
//! in the old catalog.
//!
//! Cutover status: this is the FIRST module of the rebuild wired into the running app.
//! `initialize_catalog_v2_on_startup` runs as a BLOCKING step of the existing boot sequence (see
//! `commands::run_initialize_app_catalog`), on the same loading screen as the current catalog —
//! not a background thread underneath a usable app. It's freshness-gated like the current
//! catalog (a cheap WFM version probe decides whether a full rebuild is even needed), so normal
//! launches after the first one are fast. `lookup_item_v2` is the one Tauri command reading from
//! the result so far, not yet consumed by any frontend page. The old `item_catalog.rs` catalog
//! is completely untouched and still what the rest of the app runs on — this file writes to its
//! own separate `item_catalog_v2.sqlite`, nothing shared, nothing at risk in the existing paths.
//!
//! `tests::build_real_catalog_v2_live` (`#[ignore]`d, so it never runs in a normal `cargo test`)
//! calls the exact same production `build_catalog_v2` function against live WFM + WFStat data —
//! see the module's test section for how to run it and inspect the result with the `sqlite3` CLI.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::error_log::{log_feature_error_best_effort, log_feature_event_best_effort};
use crate::wfm_scheduler::{execute_coalesced_wfm_request, RequestPriority, WfmHttpResponse};

/// Same wire shape and event name `item_catalog.rs`'s boot progress bar used — moved here
/// verbatim (not renamed) so the frontend's existing `startup-progress` listener needs no
/// changes now that this module owns the whole boot-time catalog build step.
const STARTUP_PROGRESS_EVENT: &str = "startup-progress";
/// Emitted instead of `startup-progress` when a refresh runs after boot has already handed
/// control to the user (an existing, still-usable catalog file was found stale rather than
/// missing) — a separate event so the frontend can drive a small persistent indicator instead of
/// the full-screen loading bar, which must not reappear once the user is in the app.
const CATALOG_V2_BACKGROUND_PROGRESS_EVENT: &str = "catalog-v2-background-progress";
const CATALOG_V2_BACKGROUND_COMPLETE_EVENT: &str = "catalog-v2-background-complete";
const CATALOG_V2_BACKGROUND_FAILED_EVENT: &str = "catalog-v2-background-failed";
const WFM_VERSIONS_URL: &str = "https://api.warframe.market/v2/versions";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupProgress {
    pub stage_key: String,
    pub stage_label: String,
    pub status_text: String,
    pub progress_value: f64,
}

/// Same shape as `StartupProgress`, emitted on a different event for a background refresh — kept
/// as a distinct type (rather than reusing `StartupProgress`) so the two progress streams can
/// never be cross-wired on the frontend by accident.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCatalogProgress {
    pub status_text: String,
    /// 0.0-1.0, relative to the background refresh only — unrelated to the boot progress bar's
    /// 0.6-0.8 sub-range for the same phases.
    pub progress_value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCatalogFailed {
    pub message: String,
}

/// Moved from `item_catalog.rs` verbatim (field-for-field) — the frontend's `StartupSummary` TS
/// type and `StartupScreen` component read this shape unchanged; only the module that produces
/// it moved. `wfmSourceFile`/`wfstatSourceFile` are genuinely inapplicable now (v2 streams WFM's
/// bulk response straight into SQLite, there is no intermediate downloaded-JSON file to
/// report the path of) and are left empty/`None` rather than
/// removed, since removing them would also require a frontend type change outside this pass's
/// scope.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub total_wfm_items: usize,
    pub total_wfstat_items: usize,
    pub matched_by_direct_ref: usize,
    pub matched_by_component_ref: usize,
    pub matched_by_market_slug: usize,
    pub matched_by_market_id: usize,
    pub matched_by_normalized_name: usize,
    pub matched_by_blueprint_decomposition: usize,
    pub matched_by_manual_alias: usize,
    pub unmatched_wfm_items: usize,
    pub wfm_only_canonical_items: usize,
    pub wfstat_only_canonical_items: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSummary {
    pub ready: bool,
    pub refreshed: bool,
    pub database_path: String,
    pub data_dir: String,
    pub wfm_source_file: String,
    pub wfstat_source_file: Option<String>,
    pub stats: ImportStats,
    pub current_wfm_api_version: Option<String>,
    /// True when the catalog is serving last-known WFStat data because the live WFStat
    /// catalog could not be refreshed (offline / fetch failure). The app still works, but
    /// drop/vault enrichment may be out of date until WFStat is reachable again.
    pub wfstat_stale: bool,
}

pub(crate) fn emit_progress(
    app: &AppHandle,
    stage_key: &str,
    stage_label: &str,
    status_text: &str,
    progress_value: f64,
) {
    let _ = app.emit(
        STARTUP_PROGRESS_EVENT,
        StartupProgress {
            stage_key: stage_key.to_string(),
            stage_label: stage_label.to_string(),
            status_text: status_text.to_string(),
            progress_value,
        },
    );
}

/// Fetches the `collections.items` hash from `/v2/versions` — tells us whether the item catalog
/// changed, so a launch can skip the multi-MB `/v2/items` download when the cached catalog is
/// already current. Moved from `item_catalog.rs` verbatim (that module's own copy is retired).
pub(crate) fn fetch_items_collection_version() -> Result<String> {
    let response = execute_coalesced_wfm_request(
        RequestPriority::High,
        "request WFM versions",
        Some("catalog:wfm-versions".to_string()),
        None,
        || false,
        || {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?;
            let response = client
                .get(WFM_VERSIONS_URL)
                .header("User-Agent", WFM_USER_AGENT)
                .header("Language", "en")
                .send()
                .context("failed to send WFM versions request")?;
            Ok(WfmHttpResponse {
                status: response.status().as_u16(),
                headers: HashMap::new(),
                retry_after: None,
                body: response
                    .bytes()
                    .context("failed to read WFM versions response body")?
                    .to_vec(),
            })
        },
    )?;
    let body = wfm_response_text(response, "request WFM versions")?;
    let json: serde_json::Value =
        serde_json::from_str(&body).context("failed to parse WFM versions response")?;
    json.get("data")
        .and_then(|data| data.get("collections"))
        .and_then(|collections| collections.get("items"))
        .and_then(serde_json::Value::as_str)
        .map(|value| value.to_string())
        .ok_or_else(|| anyhow!("WFM versions response is missing collections.items"))
}

/// Same identifying header every other module sends — WFM requires it, and warframestat.us
/// answers UA-less requests with 403 for some callers (see the presence/catalog UA fix earlier
/// this project). Each module keeps its own copy rather than sharing one; this one is no
/// exception, consistent with the existing convention.
const WFM_USER_AGENT: &str =
    concat!("WarStonks/", env!("CARGO_PKG_VERSION"), " (+https://pyth.co.za)");

// ─── WFM wire shapes ────────────────────────────────────────────────────────────────────────

/// One row of WFM's bulk `/v2/items` response. Confirmed live: 3,837 items, 99.1% carry
/// `gameRef`, ducats included, `setParts` NOT included (that needs the per-item endpoint).
#[derive(Debug, Clone, Deserialize)]
struct WfmBulkItem {
    id: String,
    slug: String,
    #[serde(rename = "gameRef")]
    game_ref: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    ducats: Option<i64>,
    #[serde(rename = "maxRank")]
    max_rank: Option<i64>,
    #[serde(rename = "bulkTradable")]
    bulk_tradable: Option<bool>,
    #[serde(default)]
    i18n: HashMap<String, WfmI18nEntry>,
    #[serde(default)]
    subtypes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WfmI18nEntry {
    name: Option<String>,
    icon: Option<String>,
    thumb: Option<String>,
}

/// WFM's per-item `/v2/item/{slug}` response. Only fetched for `setRoot` items — confirmed live
/// at 230 of 3,837, ~1.3 minutes through the existing 3 req/s scheduler, not the 21-minute
/// full-catalog sweep the original plan worried about.
#[derive(Debug, Clone, Deserialize)]
struct WfmItemDetail {
    // `id` is intentionally not read: the caller already knows which item this response
    // belongs to (it's the HashMap key it was fetched under), so re-deriving it here would just
    // be a second, redundant source of truth to keep in sync.
    #[serde(rename = "setRoot", default)]
    set_root: bool,
    #[serde(rename = "setParts", default)]
    set_parts: Vec<String>,
    // Only present on a COMPONENT's own detail response, not on the set root's — confirmed live
    // against `/v2/item/{slug}`. Absent (e.g. root items, or components fetched before this field
    // existed) defaults to 1 at the point of use, never left as a hard error.
    #[serde(rename = "quantityInSet")]
    quantity_in_set: Option<i64>,
    // tradingTax / reqMasteryRank: present on the wire, not yet promoted to ItemRow — Phase 1
    // proves identity and set wiring; add these columns when a real consumer needs them rather
    // than carrying unused fields now.
}

#[derive(Deserialize)]
struct WfmItemDetailResponse {
    data: WfmItemDetail,
}

fn parse_item_detail(json: &str) -> serde_json::Result<WfmItemDetail> {
    let parsed: WfmItemDetailResponse = serde_json::from_str(json)?;
    Ok(parsed.data)
}

// ─── WFStat wire shapes (enrichment only — matching failure here is never fatal) ───────────────

#[derive(Debug, Clone, Deserialize)]
struct WfstatItem {
    #[serde(rename = "uniqueName")]
    unique_name: String,
    // `name` is on the wire but unused by matching (which keys everything off `uniqueName` and
    // `marketInfo.id`) — add it back once the details layer wants a human-readable label.
    #[serde(rename = "marketInfo")]
    market_info: Option<WfstatMarketInfo>,
    #[serde(default)]
    components: Vec<WfstatComponent>,
    category: Option<String>,
    #[serde(rename = "type")]
    item_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WfstatMarketInfo {
    id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WfstatComponent {
    name: Option<String>,
    #[serde(rename = "uniqueName")]
    unique_name: Option<String>,
}

// ─── The new catalog's own shapes ───────────────────────────────────────────────────────────

/// One row of the spine table. `item_key` is the WFM item id — stable across every rebuild,
/// because it is WFM's own identifier, never something we assign by position.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ItemRow {
    pub item_key: String,
    pub slug: String,
    pub game_ref: Option<String>,
    pub name_en: String,
    pub item_family: String,
    pub max_rank: Option<i64>,
    pub ducats: Option<i64>,
    pub bulk_tradable: bool,
    pub set_root: bool,
    pub icon: Option<String>,
    pub thumb: Option<String>,
    /// Ordered, as WFM returns them (order not itself meaningful, but preserved so a rebuild is
    /// deterministic rather than shuffled by a HashSet somewhere downstream).
    pub subtypes: Vec<String>,
    /// Set only for `item_family == "relic"`. Derived the same way the old catalog derived it —
    /// the first word of the relic's own name ("Lith K1 Relic" -> "Lith") — since WFM's English
    /// name for a relic always leads with its tier.
    pub relic_tier: Option<String>,
    /// Best single image to show for this item: thumb first (larger), falling back to icon.
    /// Mirrors the old catalog's `preferred_image` semantics without a separate WFStat imageName
    /// input — WFM's own i18n thumb/icon is what the old catalog fell back to as well.
    pub preferred_image: Option<String>,
}

/// One row of the i18n side table: one item's name/icon/thumb in one WFM-supplied locale.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ItemI18nRow {
    pub item_key: String,
    pub lang_code: String,
    pub name: Option<String>,
    pub icon: Option<String>,
    pub thumb: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SetPartRow {
    pub set_key: String,
    pub part_key: String,
    /// How many of this component one full set needs. Defaults to 1 when the component's own
    /// detail fetch didn't return `quantityInSet` (fetch failure, or field absent on the wire).
    pub quantity_in_set: i64,
}

/// A resolvable key -> the one item it means. Construction guarantees this is never ambiguous:
/// see `build_item_lookup`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LookupRow {
    pub lookup_key: String,
    pub item_key: String,
    pub kind: LookupKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum LookupKind {
    Slug,
    GameRef,
    GameRefLeaf,
    Name,
}

/// A key that would have resolved to more than one item. Reported, never silently guessed at —
/// this is the direct fix for `blueprint` having matched 1,334 items in the old alias table.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RejectedLookupKey {
    pub lookup_key: String,
    pub candidates: Vec<String>,
}

/// How a WFStat record was attached to a WFM item — kept so the report can show which tier is
/// carrying the catalog, not just a final pass/fail count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WfstatMatchTier {
    /// WFStat's own `marketInfo.id` names the WFM item directly. Authoritative.
    MarketInfoId,
    /// WFM's `gameRef` equals WFStat's `uniqueName` exactly.
    GameRefExact,
    /// Bounded, exact: WFM's `gameRef` equals the `uniqueName` of one of the specific parent
    /// set's OWN components. Confirmed live: WFStat sometimes names a component differently
    /// from the identifier it stores for it — WFStat calls a part "Limbs" while its own
    /// `uniqueName` for that part is `ArchRocketCrossbowStock` — so matching on the identifier
    /// finds it even when the two sides would never agree on the word. Still bounded to the
    /// correct parent, never a search over the full WFStat catalog.
    BoundedComponentExact,
    /// Bounded, by name: only reached when no component in the parent's list shares an exact
    /// identifier — the genuine case is WFM's gameRef ending `...ChassisBlueprint` where
    /// WFStat's own identifier for the same part is `...ChassisComponent`. No shared identifier
    /// exists at all here, so this is the fallback of last resort, still scoped to one parent's
    /// handful of components — never a global name search.
    BoundedComponentByName,
    /// Global, exact: WFM's `gameRef` equals the `uniqueName` of a component listed under
    /// exactly one WFStat parent — used only when no known WFM set links this item to a parent
    /// at all (confirmed live: single-piece weapons like Quellor have a "Blueprint" but no WFM
    /// `setParts` group, since there's nothing else to bundle it with).
    ///
    /// This is NOT the old alias table's mistake: that matched on a generic WORD ("blueprint")
    /// shared by 1,334 unrelated items. This matches on a full internal path — an identifier,
    /// not a word — and only succeeds when it is claimed by exactly one parent globally. When a
    /// component identifier IS claimed by more than one distinct parent (common resources like
    /// Orokin Cell genuinely are), this tier refuses rather than guessing which one.
    GlobalComponentExact,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct WfstatMatchReport {
    pub matches: HashMap<String, (String, WfstatMatchTier)>,
    pub unmatched: Vec<String>,
}

impl WfstatMatchReport {
    pub(crate) fn tier_counts(&self) -> (usize, usize, usize, usize, usize) {
        let mut counts = (0, 0, 0, 0, 0);
        for (_, tier) in self.matches.values() {
            match tier {
                WfstatMatchTier::MarketInfoId => counts.0 += 1,
                WfstatMatchTier::GameRefExact => counts.1 += 1,
                WfstatMatchTier::BoundedComponentExact => counts.2 += 1,
                WfstatMatchTier::BoundedComponentByName => counts.3 += 1,
                WfstatMatchTier::GlobalComponentExact => counts.4 += 1,
            }
        }
        counts
    }
}

// ─── Item family classification ────────────────────────────────────────────────────────────

/// WFM tags are unordered and not designed as a taxonomy, so this picks the single label the
/// rest of the app actually branches on (set completion, relic odds, arcane handling), by
/// priority — most specific tag wins.
pub(crate) fn classify_item_family(tags: &[String]) -> String {
    // "component"/"blueprint" must outrank "warframe"/"weapon"/"sentinel"/"archwing": WFM tags a
    // part with BOTH its own kind and its parent's kind (Mesa Prime Blueprint carries
    // ["blueprint", "prime", "warframe"]) — a part must classify as a part regardless of what
    // it belongs to, or set-completion logic can't tell parts from wholes.
    const PRIORITY: &[(&str, &str)] = &[
        ("relic", "relic"),
        ("arcane_enhancement", "arcane"),
        ("mod", "mod"),
        ("component", "component"),
        ("blueprint", "blueprint"),
        ("set", "set"),
        ("warframe", "warframe"),
        ("weapon", "weapon"),
        ("sentinel", "sentinel"),
        ("archwing", "archwing"),
    ];
    for (tag, family) in PRIORITY {
        if tags.iter().any(|value| value == tag) {
            return (*family).to_string();
        }
    }
    "misc".to_string()
}

// ─── Building the spine from WFM alone ─────────────────────────────────────────────────────

/// Builds every `items` row from WFM's bulk response — no WFStat involvement at all. This is
/// what makes the catalog's core identity independent of WFStat being reachable.
pub(crate) fn build_item_rows(bulk_json: &str) -> serde_json::Result<Vec<ItemRow>> {
    #[derive(Deserialize)]
    struct BulkResponse {
        data: Vec<WfmBulkItem>,
    }
    let parsed: BulkResponse = serde_json::from_str(bulk_json)?;
    Ok(parsed
        .data
        .into_iter()
        .map(|item| {
            let en = item.i18n.get("en");
            // 35 of 3,837 real WFM items (fusion cores, augment mods, void keys) carry
            // `"gameRef": ""` rather than omitting the field or sending null — an empty string
            // is not an identity and must not become one, or every such item collides on the
            // single lookup key "". Confirmed live: without this, the probe against the real
            // catalog reported exactly this key rejected as ambiguous across ~36 items.
            let game_ref = item
                .game_ref
                .filter(|value| !value.trim().is_empty());
            let item_family = classify_item_family(&item.tags);
            let name_en = en.and_then(|entry| entry.name.clone()).unwrap_or_default();
            let icon = en.and_then(|entry| entry.icon.clone());
            let thumb = en.and_then(|entry| entry.thumb.clone());
            let relic_tier = if item_family == "relic" {
                name_en.split_whitespace().next().map(str::to_string)
            } else {
                None
            };
            let preferred_image = thumb.clone().or_else(|| icon.clone());
            ItemRow {
                item_key: item.id,
                slug: item.slug,
                game_ref,
                name_en,
                item_family,
                max_rank: item.max_rank,
                ducats: item.ducats,
                bulk_tradable: item.bulk_tradable.unwrap_or(false),
                // Filled in once per-item detail is fetched for set-tagged items; the bulk
                // response alone can't tell us this, so it starts false.
                set_root: false,
                icon,
                thumb,
                subtypes: item.subtypes,
                relic_tier,
                preferred_image,
            }
        })
        .collect())
}

/// Re-parses the same bulk JSON `build_item_rows` consumes to capture every locale WFM sent, not
/// just "en" — a second pass over already-fetched data, not a second network call. Kept separate
/// from `build_item_rows` rather than folding into `ItemRow` so existing callers/tests of that
/// function are untouched.
pub(crate) fn build_item_i18n_rows(bulk_json: &str) -> serde_json::Result<Vec<ItemI18nRow>> {
    #[derive(Deserialize)]
    struct BulkResponse {
        data: Vec<WfmBulkItem>,
    }
    let parsed: BulkResponse = serde_json::from_str(bulk_json)?;
    let mut rows = Vec::new();
    for item in &parsed.data {
        for (lang_code, entry) in &item.i18n {
            rows.push(ItemI18nRow {
                item_key: item.id.clone(),
                lang_code: lang_code.clone(),
                name: entry.name.clone(),
                icon: entry.icon.clone(),
                thumb: entry.thumb.clone(),
            });
        }
    }
    Ok(rows)
}

/// Applies `setRoot`/`setParts` from the per-item detail fetch — the ONLY per-item network cost
/// this design pays, and only for the ~230 items tagged "set" in bulk.
pub(crate) fn apply_set_details(
    items: &mut [ItemRow],
    details_json_by_item_key: &HashMap<String, String>,
) -> serde_json::Result<Vec<SetPartRow>> {
    // A &str key borrowing `item_key` and a `&mut ItemRow` value borrowing the whole row can't
    // coexist for the same element, so the lookup goes by index instead of by mutable reference.
    // Owned keys, not borrowed: a `&str` index would keep `items` borrowed for the map's whole
    // lifetime, conflicting with the mutation below.
    let index_by_key: HashMap<String, usize> = items
        .iter()
        .enumerate()
        .map(|(index, item)| (item.item_key.clone(), index))
        .collect();

    // Parsed once up front so a component's own `quantityInSet` can be read regardless of
    // whether it was fetched as a "set" root or purely as a component detail fetch.
    let mut details_by_key: HashMap<&str, WfmItemDetail> = HashMap::new();
    for (item_key, json) in details_json_by_item_key {
        details_by_key.insert(item_key.as_str(), parse_item_detail(json)?);
    }

    let mut set_parts = Vec::new();
    for (item_key, detail) in &details_by_key {
        if let Some(&index) = index_by_key.get(*item_key) {
            items[index].set_root = detail.set_root;
        }
        if detail.set_root {
            for part_key in &detail.set_parts {
                // A set's own root id is listed among its parts by WFM; that isn't a
                // "component" relationship and would make the set falsely include itself.
                if part_key != item_key {
                    let quantity_in_set = details_by_key
                        .get(part_key.as_str())
                        .and_then(|part_detail| part_detail.quantity_in_set)
                        .unwrap_or(1);
                    set_parts.push(SetPartRow {
                        set_key: item_key.to_string(),
                        part_key: part_key.clone(),
                        quantity_in_set,
                    });
                }
            }
        }
    }
    set_parts.sort_by(|a, b| (&a.set_key, &a.part_key).cmp(&(&b.set_key, &b.part_key)));
    Ok(set_parts)
}

// ─── Deterministic lookup: an ambiguous key is dropped, never guessed ──────────────────────

/// Folds a name for lookup: lowercase, trimmed. Deliberately minimal here — the full
/// diacritic/CJK-safe folding used by the live search box (`itemSearch.ts`) is a frontend
/// concern; this just needs to be consistent within the catalog.
fn fold(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Builds the resolver table from slugs, game refs (full and leaf), and English names.
///
/// Any key that would point at more than one item is EXCLUDED and reported instead — this is
/// the direct fix for the old `item_aliases` table, where 2,753 values (`blueprint` alone
/// matching 1,334 items) resolved via an undefined `LIMIT 1`, so the same input could resolve
/// to a different item between runs.
pub(crate) fn build_item_lookup(
    items: &[ItemRow],
    wfstat_matches: &HashMap<String, (String, WfstatMatchTier)>,
) -> (Vec<LookupRow>, Vec<RejectedLookupKey>) {
    let mut candidates: HashMap<(String, LookupKind), HashSet<String>> = HashMap::new();
    let mut add = |key: String, kind: LookupKind, item_key: &str| {
        candidates
            .entry((key, kind))
            .or_default()
            .insert(item_key.to_string());
    };

    for item in items {
        add(fold(&item.slug), LookupKind::Slug, &item.item_key);
        if let Some(game_ref) = &item.game_ref {
            add(fold(game_ref), LookupKind::GameRef, &item.item_key);
            if let Some((_, leaf)) = game_ref.rsplit_once('/') {
                if !leaf.trim().is_empty() {
                    add(fold(leaf), LookupKind::GameRefLeaf, &item.item_key);
                }
            }
        }
        if !item.name_en.trim().is_empty() {
            add(fold(&item.name_en), LookupKind::Name, &item.item_key);
        }
        // WFStat's `uniqueName` is the game's own true internal identifier, and diverges from
        // WFM's own `gameRef` for some items — e.g. WFM calls a Warframe part's recipe
        // `.../YareliPrimeSystemsBlueprint` while the game (and AlecaFrame, which reports raw
        // in-game class names) calls it `.../YareliPrimeSystemsComponent`. Folded into the SAME
        // GameRef/GameRefLeaf buckets as WFM's gameRef (not a separate kind) since both
        // represent the identical concept — "the engine's own path for this item" — so the two
        // sources naturally de-duplicate when they agree and correctly collide-and-reject
        // (never guess) if they ever disagree.
        if let Some((unique_name, _tier)) = wfstat_matches.get(&item.item_key) {
            add(fold(unique_name), LookupKind::GameRef, &item.item_key);
            if let Some((_, leaf)) = unique_name.rsplit_once('/') {
                if !leaf.trim().is_empty() {
                    add(fold(leaf), LookupKind::GameRefLeaf, &item.item_key);
                }
            }
        }
    }

    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for ((key, kind), owners) in candidates {
        if owners.len() == 1 {
            accepted.push(LookupRow {
                lookup_key: key,
                item_key: owners.into_iter().next().expect("len checked"),
                kind,
            });
        } else {
            let mut candidates = owners.into_iter().collect::<Vec<_>>();
            candidates.sort();
            rejected.push(RejectedLookupKey {
                lookup_key: key,
                candidates,
            });
        }
    }
    accepted.sort_by(|a, b| (&a.lookup_key, a.kind as u8).cmp(&(&b.lookup_key, b.kind as u8)));
    rejected.sort_by(|a, b| a.lookup_key.cmp(&b.lookup_key));
    (accepted, rejected)
}

// ─── WFStat matching: exact tiers first, bounded fallback last, never global fuzzy ─────────

/// Tier 1 + 2: exact matches only. Confirmed live against the real catalogs: `marketInfo.id`
/// covers 20.1% authoritatively (mostly relic refinement families), `gameRef == uniqueName`
/// covers a further 57.6%. Combined, 77.7% of the catalog is matched with zero ambiguity before
/// tier 3 is even attempted.
fn match_exact_tiers(items: &[ItemRow], wfstat_items: &[WfstatItem]) -> WfstatMatchReport {
    let mut by_market_info: HashMap<&str, Vec<&WfstatItem>> = HashMap::new();
    let mut by_unique_name: HashMap<&str, &WfstatItem> = HashMap::new();
    for record in wfstat_items {
        if let Some(id) = record.market_info.as_ref().and_then(|info| info.id.as_deref()) {
            by_market_info.entry(id).or_default().push(record);
        }
        by_unique_name.insert(record.unique_name.as_str(), record);
    }

    let mut report = WfstatMatchReport::default();
    for item in items {
        if let Some(records) = by_market_info.get(item.item_key.as_str()) {
            // A WFM id claimed by several WFStat entries is a documented one-to-many (a relic's
            // four refinement tiers share one tradeable market listing) — not the accidental
            // ambiguity `item_lookup` guards against, so the lowest unique name is picked
            // deterministically rather than left unmatched.
            let mut sorted = records.clone();
            sorted.sort_by(|a, b| a.unique_name.cmp(&b.unique_name));
            let chosen = sorted[0];
            report.matches.insert(
                item.item_key.clone(),
                (chosen.unique_name.clone(), WfstatMatchTier::MarketInfoId),
            );
            continue;
        }
        if let Some(game_ref) = &item.game_ref {
            if let Some(record) = by_unique_name.get(game_ref.as_str()) {
                report.matches.insert(
                    item.item_key.clone(),
                    (record.unique_name.clone(), WfstatMatchTier::GameRefExact),
                );
                continue;
            }
        }
        report.unmatched.push(item.item_key.clone());
    }
    report
}

/// Words WFM and WFStat both use for the same components under different internal suffixes —
/// confirmed live: WFM names Zephyr Prime's chassis component `...ChassisBlueprint`, WFStat's
/// component list under "Zephyr Prime" calls it `...ChassisComponent`. Stripping both down to
/// the shared word ("chassis") is what lets the two sides agree without a global name search.
/// Structural part words — checked BEFORE the generic suffix below. This ordering matters: a
/// warframe component's slug is `{frame}_{part}_blueprint` for chassis/systems/neuroptics alike,
/// so all three contain the substring "blueprint" — without checking the structural word first,
/// every one of them would collapse onto the generic "Blueprint" component instead of its own.
const STRUCTURAL_PART_WORDS: &[&[&str]] = &[
    &["chassis"],
    &["systems", "system"],
    &["neuroptics", "helmet"],
    &["barrel"],
    &["receiver"],
    &["stock", "grip"],
    &["blade"],
    &["link"],
    &["gauntlet"],
    &["lower_limb", "lowerlimb"],
    &["upper_limb", "upperlimb"],
    &["carapace"],
];

/// Only reached when no structural word matched — this is the item that IS the blueprint
/// itself (e.g. "Zephyr Prime Blueprint"), which WFStat lists as a component named "Blueprint".
const GENERIC_PART_WORDS: &[&[&str]] = &[&["blueprint", "component"]];

/// Reduces a slug or name fragment to a comparable "part word" — e.g. both
/// `zephyr_prime_chassis_blueprint` and a WFStat component named "Chassis" fold to `chassis`.
fn part_word(value: &str) -> Option<&'static str> {
    let folded = fold(value).replace(' ', "_");
    for group in STRUCTURAL_PART_WORDS.iter().chain(GENERIC_PART_WORDS) {
        if group.iter().any(|word| folded.contains(word)) {
            // Canonical word for the group is always its first entry.
            return Some(group[0]);
        }
    }
    None
}

/// Tier 3: for a component still unmatched after the exact tiers, and belonging to a set whose
/// ROOT already matched WFStat, search only that root's own `components[]` list — never the
/// full WFStat catalog. A handful of candidates, not seventeen thousand, so an unresolved case
/// is reported rather than guessed.
fn match_bounded_component_tier(
    items: &[ItemRow],
    wfstat_items: &[WfstatItem],
    set_parts: &[SetPartRow],
    report: &mut WfstatMatchReport,
) {
    let by_unique_name: HashMap<&str, &WfstatItem> = wfstat_items
        .iter()
        .map(|record| (record.unique_name.as_str(), record))
        .collect();
    let items_by_key: HashMap<&str, &ItemRow> =
        items.iter().map(|item| (item.item_key.as_str(), item)).collect();

    // Which set each still-unmatched component belongs to.
    let mut set_of_part: HashMap<&str, &str> = HashMap::new();
    for row in set_parts {
        set_of_part.insert(row.part_key.as_str(), row.set_key.as_str());
    }

    let still_unmatched = std::mem::take(&mut report.unmatched);
    for item_key in still_unmatched {
        let resolved = (|| -> Option<(String, WfstatMatchTier)> {
            let set_key = set_of_part.get(item_key.as_str())?;
            let (root_unique_name, _root_tier) = report.matches.get(*set_key)?;
            let root_record = by_unique_name.get(root_unique_name.as_str())?;
            let component_item = items_by_key.get(item_key.as_str())?;

            // Exact identifier first: confirmed live that WFStat sometimes NAMES a component
            // one word ("Limbs") while its own stored identifier for that same component is a
            // different word (`ArchRocketCrossbowStock`, which is what WFM's gameRef equals) —
            // so identifier equality finds real matches that no word list ever could, with zero
            // guessing. Still bounded to this exact parent's own component list.
            if let Some(game_ref) = &component_item.game_ref {
                let mut exact_candidates = root_record
                    .components
                    .iter()
                    .filter(|component| component.unique_name.as_deref() == Some(game_ref.as_str()))
                    .filter_map(|component| component.unique_name.clone());
                if let Some(first) = exact_candidates.next() {
                    // Component identifiers are supposed to be unique per parent; if that ever
                    // isn't true, treat it exactly like any other ambiguity — report, don't guess.
                    if exact_candidates.next().is_none() {
                        return Some((first, WfstatMatchTier::BoundedComponentExact));
                    }
                    return None;
                }
            }

            // Fallback: only reached when no component shares an identifier with this item at
            // all — the genuine case is a WFM gameRef ending "...ChassisBlueprint" against
            // WFStat's own "...ChassisComponent" for the very same physical part.
            let target_word = part_word(&component_item.name_en)
                .or_else(|| part_word(&component_item.slug))?;
            let mut candidates = root_record
                .components
                .iter()
                .filter(|component| {
                    component
                        .name
                        .as_deref()
                        .and_then(part_word)
                        .is_some_and(|word| word == target_word)
                })
                .filter_map(|component| component.unique_name.clone());
            let first = candidates.next()?;
            // More than one candidate in this tiny, bounded set means the component word is
            // genuinely ambiguous for this parent — report it rather than pick arbitrarily.
            if candidates.next().is_some() {
                return None;
            }
            Some((first, WfstatMatchTier::BoundedComponentByName))
        })();

        match resolved {
            Some(value) => {
                report.matches.insert(item_key, value);
            }
            None => report.unmatched.push(item_key),
        }
    }
}

/// Every WFStat component identifier, mapped to the distinct parent(s) that list it. Common raw
/// resources (Orokin Cell, Circuits, …) are legitimately claimed by hundreds of parents — that's
/// fine, because those resources have their own top-level identity and are already resolved by
/// `match_exact_tiers` long before reaching this index. This index only ever gets consulted for
/// items that failed every earlier tier.
fn build_component_identifier_index(wfstat_items: &[WfstatItem]) -> HashMap<&str, HashSet<&str>> {
    let mut index: HashMap<&str, HashSet<&str>> = HashMap::new();
    for item in wfstat_items {
        for component in &item.components {
            if let Some(unique_name) = component.unique_name.as_deref() {
                index.entry(unique_name).or_default().insert(item.unique_name.as_str());
            }
        }
    }
    index
}

/// Global, last-resort tier: for items with no WFM-known parent to bound a search against at
/// all (confirmed live: single-piece weapon blueprints like Quellor, which have a "Blueprint"
/// but no WFM `setParts` group linking it to anything). Safe specifically because it matches on
/// a full internal path identifier, not a word — and a component identifier claimed by more
/// than one distinct WFStat parent is refused, never guessed at.
fn match_global_component_identifier_tier(
    items: &[ItemRow],
    wfstat_items: &[WfstatItem],
    report: &mut WfstatMatchReport,
) {
    let index = build_component_identifier_index(wfstat_items);
    let items_by_key: HashMap<&str, &ItemRow> =
        items.iter().map(|item| (item.item_key.as_str(), item)).collect();

    let still_unmatched = std::mem::take(&mut report.unmatched);
    for item_key in still_unmatched {
        let resolved = (|| -> Option<(String, WfstatMatchTier)> {
            let item = items_by_key.get(item_key.as_str())?;
            let game_ref = item.game_ref.as_deref()?;
            let parents = index.get(game_ref)?;
            if parents.len() != 1 {
                return None;
            }
            Some((game_ref.to_string(), WfstatMatchTier::GlobalComponentExact))
        })();

        match resolved {
            Some(value) => {
                report.matches.insert(item_key, value);
            }
            None => report.unmatched.push(item_key),
        }
    }
}

/// Runs every tier in order, most authoritative first. This is the only function the rest of
/// the app would ever call — the tiers themselves are private because their order is not a
/// caller's decision.
pub(crate) fn build_wfstat_matches(
    items: &[ItemRow],
    wfstat_json: &str,
    set_parts: &[SetPartRow],
) -> serde_json::Result<WfstatMatchReport> {
    let wfstat_items: Vec<WfstatItem> = serde_json::from_str(wfstat_json)?;
    let mut report = match_exact_tiers(items, &wfstat_items);
    match_bounded_component_tier(items, &wfstat_items, set_parts, &mut report);
    match_global_component_identifier_tier(items, &wfstat_items, &mut report);
    Ok(report)
}

/// WFStat's own `category`/`type` fields, keyed by `uniqueName` — the same identity
/// `wfstat_matches.wfstat_unique_name` already carries, so this is a plain lookup at write time
/// rather than a new matching pass. Mirrors the old catalog's `wfstat_items.category`/`.type`
/// columns, which is what `category` derivation (mod.rs `load_catalog_item_metadata`) reads.
pub(crate) fn build_wfstat_category_map(
    wfstat_json: &str,
) -> serde_json::Result<HashMap<String, (Option<String>, Option<String>)>> {
    let wfstat_items: Vec<WfstatItem> = serde_json::from_str(wfstat_json)?;
    Ok(wfstat_items
        .into_iter()
        .map(|item| (item.unique_name, (item.category, item.item_type)))
        .collect())
}

/// The complete, verbatim WFStat item object for each `uniqueName`, kept alongside the matched
/// summary fields so item-detail enrichment (stats, polarities, abilities, level-scaling — see
/// `market_observatory::load_item_detail_summary`) has the full record to read from without a
/// second WFStat fetch. Parsed generically (`serde_json::Value`, not `WfstatItem`) because that
/// struct only carries the handful of fields matching cares about.
pub(crate) fn build_wfstat_raw_json_map(
    wfstat_json: &str,
) -> serde_json::Result<HashMap<String, String>> {
    let wfstat_items: Vec<serde_json::Value> = serde_json::from_str(wfstat_json)?;
    Ok(wfstat_items
        .into_iter()
        .filter_map(|value| {
            let unique_name = value.get("uniqueName")?.as_str()?.to_string();
            Some((unique_name, value.to_string()))
        })
        .collect())
}

/// The four refinement labels WFStat's own relic `uniqueName`s end in — WFM models one relic as
/// a single item (refinement is a `subtype` on it), but WFStat carries a fully separate record
/// per refinement, each with its own `rewards` table (drop odds genuinely differ by refinement).
/// One relic's four records are siblings only by naming convention: same identifier with one of
/// these words swapped on the end (e.g. `...LithA1RelicIntact` / `...LithA1RelicExceptional`).
const RELIC_REFINEMENT_SUFFIXES: &[&str] = &["Intact", "Exceptional", "Flawless", "Radiant"];

/// Every WFStat relic record, grouped by its identifier with the refinement suffix stripped off
/// — e.g. `.../LithA1RelicIntact` and `.../LithA1RelicExceptional` both key under
/// `.../LithA1Relic`. Used to find a matched relic's three sibling refinements, none of which
/// `build_wfstat_matches` itself ever sees (WFM's single relic item only carries ONE `gameRef`,
/// so at most one refinement is ever the exact-tier match).
pub(crate) fn build_wfstat_relic_variant_map(
    wfstat_json: &str,
) -> serde_json::Result<HashMap<String, HashMap<String, String>>> {
    let wfstat_items: Vec<serde_json::Value> = serde_json::from_str(wfstat_json)?;
    let mut grouped: HashMap<String, HashMap<String, String>> = HashMap::new();
    for value in wfstat_items {
        let Some(unique_name) = value.get("uniqueName").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(suffix) = RELIC_REFINEMENT_SUFFIXES
            .iter()
            .find(|suffix| unique_name.ends_with(**suffix))
        else {
            continue;
        };
        let prefix = &unique_name[..unique_name.len() - suffix.len()];
        grouped
            .entry(prefix.to_string())
            .or_default()
            .insert(suffix.to_string(), value.to_string());
    }
    Ok(grouped)
}

// ─── Persistence ────────────────────────────────────────────────────────────────────────────
//
// Deliberately NOT the old catalog's 41 tables. Nine here, and `item_details` (WFStat's damage/
// magazine/range/etc. enrichment) is out of scope until the phase that adds it — this layer
// proves identity, the set graph, deterministic lookup, and the match report are all correctly
// persisted and queryable, which is the part that has to be right before anything else is built
// on top of it.

/// Creates every table fresh. Called against a brand-new file each build — there is no
/// migration path here because there is no data in this schema yet to migrate.
pub(crate) fn initialize_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "
            CREATE TABLE items (
                item_key        TEXT PRIMARY KEY,
                slug            TEXT NOT NULL UNIQUE,
                game_ref        TEXT,
                name_en         TEXT NOT NULL,
                item_family     TEXT NOT NULL,
                max_rank        INTEGER,
                ducats          INTEGER,
                bulk_tradable   INTEGER NOT NULL,
                set_root        INTEGER NOT NULL,
                icon            TEXT,
                thumb           TEXT,
                relic_tier      TEXT,
                preferred_image TEXT
            );
            CREATE INDEX idx_items_family ON items (item_family);

            -- All locales WFM's bulk response carries per item (not just English), mirroring the
            -- old catalog's wfm_item_i18n shape closely enough that autocomplete localization
            -- reads the same way. Populated from the SAME bulk fetch as items -- no extra
            -- network call.
            CREATE TABLE item_i18n (
                item_key  TEXT NOT NULL REFERENCES items (item_key),
                lang_code TEXT NOT NULL,
                name      TEXT,
                icon      TEXT,
                thumb     TEXT,
                sub_icon  TEXT,
                PRIMARY KEY (item_key, lang_code)
            );

            -- Side table, not a column: WFM's `subtypes` is a variable-length ordered list
            -- (blueprint/rank names, relic refinement tiers, etc.), matching how the rest of this
            -- schema handles one-to-many item facts (see `set_parts`, `item_lookup`).
            CREATE TABLE item_subtypes (
                item_key TEXT NOT NULL REFERENCES items (item_key),
                ord      INTEGER NOT NULL,
                subtype  TEXT NOT NULL,
                PRIMARY KEY (item_key, ord)
            );

            CREATE TABLE set_parts (
                set_key         TEXT NOT NULL REFERENCES items (item_key),
                part_key        TEXT NOT NULL REFERENCES items (item_key),
                quantity_in_set INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (set_key, part_key)
            );

            -- The ONLY resolution path. A `(lookup_key, kind)` pair maps to exactly one item —
            -- enforced by construction in `build_item_lookup`, not by a runtime check here.
            CREATE TABLE item_lookup (
                lookup_key TEXT NOT NULL,
                kind       TEXT NOT NULL,
                item_key   TEXT NOT NULL REFERENCES items (item_key),
                PRIMARY KEY (lookup_key, kind)
            );
            CREATE INDEX idx_item_lookup_key ON item_lookup (lookup_key);

            -- Keys that would have resolved to more than one item, kept so a rebuild's ambiguity
            -- count is visible and comparable, not silently dropped.
            CREATE TABLE rejected_lookup_keys (
                lookup_key      TEXT PRIMARY KEY,
                candidates_json TEXT NOT NULL
            );

            CREATE TABLE wfstat_matches (
                item_key           TEXT PRIMARY KEY REFERENCES items (item_key),
                wfstat_unique_name TEXT NOT NULL,
                match_tier         TEXT NOT NULL,
                category           TEXT,
                type               TEXT,
                raw_json           TEXT
            );
            CREATE TABLE wfstat_unmatched (
                item_key TEXT PRIMARY KEY REFERENCES items (item_key)
            );

            -- One row per relic refinement (Intact/Exceptional/Flawless/Radiant), each carrying
            -- its own WFStat reward table -- see `build_wfstat_relic_variant_map`. Only relics
            -- populate this; every other item's enrichment lives entirely in `wfstat_matches`.
            CREATE TABLE wfstat_relic_variants (
                item_key   TEXT NOT NULL REFERENCES items (item_key),
                refinement TEXT NOT NULL,
                raw_json   TEXT NOT NULL,
                PRIMARY KEY (item_key, refinement)
            );

            CREATE TABLE catalog_meta (
                meta_key   TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL
            );

            -- Per-language build bookkeeping for the language-pack subsystem (see
            -- `populate_language_item_names_v2` and friends, below). `wfm_version` is the WFM
            -- items-collection version string a language's `item_i18n` rows were built from —
            -- used to judge whether the local pack is current, and stamped into exported packs
            -- so an import can carry the same currency check.
            CREATE TABLE language_pack_meta (
                lang_code  TEXT PRIMARY KEY,
                wfm_version TEXT,
                item_count INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            ",
        )
        .context("failed to initialize the v2 catalog schema")
}

pub(crate) fn write_items(connection: &Connection, items: &[ItemRow]) -> Result<()> {
    let mut statement = connection.prepare(
        "INSERT INTO items (
            item_key, slug, game_ref, name_en, item_family,
            max_rank, ducats, bulk_tradable, set_root, icon, thumb,
            relic_tier, preferred_image
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )?;
    for item in items {
        statement.execute(params![
            item.item_key,
            item.slug,
            item.game_ref,
            item.name_en,
            item.item_family,
            item.max_rank,
            item.ducats,
            item.bulk_tradable as i64,
            item.set_root as i64,
            item.icon,
            item.thumb,
            item.relic_tier,
            item.preferred_image,
        ])?;
    }
    Ok(())
}

pub(crate) fn write_item_i18n(connection: &Connection, rows: &[ItemI18nRow]) -> Result<()> {
    let mut statement = connection.prepare(
        "INSERT INTO item_i18n (item_key, lang_code, name, icon, thumb) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for row in rows {
        statement.execute(params![
            row.item_key,
            row.lang_code,
            row.name,
            row.icon,
            row.thumb,
        ])?;
    }
    Ok(())
}

// ─── Language packs ─────────────────────────────────────────────────────────────────────────
//
// V2 port of the old catalog's language-pack subsystem (see `item_catalog.rs`'s equivalent
// block, kept for reference until it's deleted). Same behavior, same WFM-is-canonical source,
// re-homed onto `items`/`item_i18n` (keyed directly by `item_key`, which IS the WFM item id —
// no join needed, same identity as before) and the new `language_pack_meta` table above instead
// of the old catalog's `wfstat_version`-misnamed column.

const LANGUAGE_PACK_FORMAT_V2: &str = "warstonks-language-pack";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePackStatusV2 {
    pub lang_code: String,
    pub populated: bool,
    pub item_count: i64,
    pub built_version: Option<String>,
    pub current_version: Option<String>,
    pub wfstat_reachable: bool,
    pub up_to_date: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanguagePackRowV2 {
    item_key: String,
    name: Option<String>,
    icon: Option<String>,
    thumb: Option<String>,
    sub_icon: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePackV2 {
    pub format: String,
    pub lang_code: String,
    pub wfm_version: Option<String>,
    pub item_count: i64,
    pub exported_at: String,
    rows: Vec<LanguagePackRowV2>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePackImportResultV2 {
    pub lang_code: String,
    pub item_count: i64,
}

/// Brings an already-built v2 catalog file up to date with schema additions made after it was
/// written. `initialize_schema` only ever runs once per file (a fresh build), so a catalog built
/// before `language_pack_meta`/`item_i18n.sub_icon` existed needs this before either is touched.
/// Both statements are individually best-effort-idempotent (`CREATE TABLE IF NOT EXISTS`, and an
/// `ALTER TABLE ADD COLUMN` whose only failure mode is "already there").
fn ensure_language_pack_schema(connection: &Connection) -> Result<()> {
    connection.execute(
        "CREATE TABLE IF NOT EXISTS language_pack_meta (
            lang_code   TEXT PRIMARY KEY,
            wfm_version TEXT,
            item_count  INTEGER NOT NULL DEFAULT 0,
            updated_at  TEXT NOT NULL
        )",
        [],
    )?;
    let _ = connection.execute("ALTER TABLE item_i18n ADD COLUMN sub_icon TEXT", []);
    Ok(())
}

fn i18n_row_count_v2(connection: &Connection, lang_code: &str) -> Result<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM item_i18n
         WHERE lang_code = ?1 AND name IS NOT NULL AND name <> ''",
        [lang_code],
        |row| row.get(0),
    )?)
}

/// Falls back to the catalog's own stored WFM collection hash (`catalog_meta.collection_hash`,
/// written at build time — see `read_stored_collection_hash`) when a language has never recorded
/// its own build version, mirroring the old catalog's fallback to `stored_items_collection_version`.
fn language_built_version_v2(connection: &Connection, lang_code: &str) -> Result<Option<String>> {
    ensure_language_pack_schema(connection)?;
    let imported: Option<String> = connection
        .query_row(
            "SELECT wfm_version FROM language_pack_meta WHERE lang_code = ?1",
            [lang_code],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if imported.is_some() {
        return Ok(imported);
    }
    Ok(connection
        .query_row(
            "SELECT meta_value FROM catalog_meta WHERE meta_key = 'collection_hash'",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

/// Opens the v2 catalog read-write. Distinct from `open_catalog_v2_readonly` because the
/// language-pack commands (and only those, outside the build path) need to write into an
/// already-built catalog file. The file must already exist — these commands only ever run after
/// startup's catalog build has completed.
fn open_catalog_v2_writable(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = catalog_v2_database_path(app)?;
    Connection::open(&db_path).with_context(|| format!("failed to open {}", db_path.display()))
}

/// Fetches localized item names from Warframe.Market for one language, keyed by `item_key`
/// (WFM's own item id, so names attach directly — no join). Same WFM `/v2/items` + `Language`
/// header contract as the bulk build fetch, at Low priority through the shared scheduler so a
/// background language-pack pull never competes with live order/watchlist traffic.
fn fetch_wfm_item_names_v2(lang_code: &str) -> Result<HashMap<String, String>> {
    let action_label = format!("fetch WFM localized item names ({lang_code})");
    let lang_owned = lang_code.to_string();
    let response = execute_coalesced_wfm_request(
        RequestPriority::Low,
        &action_label,
        Some(format!("catalog-v2:wfm-item-names:{lang_code}")),
        Some(Duration::from_secs(60)),
        || false,
        move || {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()?;
            let response = client
                .get("https://api.warframe.market/v2/items")
                .header("User-Agent", WFM_USER_AGENT)
                .header("Language", lang_owned.as_str())
                .send()
                .context("failed to send WFM localized item names request")?;
            Ok(WfmHttpResponse {
                status: response.status().as_u16(),
                headers: HashMap::new(),
                retry_after: None,
                body: response
                    .bytes()
                    .context("failed to read WFM localized item names response body")?
                    .to_vec(),
            })
        },
    )?;
    let body = wfm_response_text(response, &action_label)?;
    let json: serde_json::Value =
        serde_json::from_str(&body).context("failed to parse WFM items response")?;
    let items = json
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow!("WFM items response is missing the data array"))?;
    let mut map = HashMap::with_capacity(items.len());
    for item in items {
        let Some(id) = item.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let name = item
            .get("i18n")
            .and_then(|i18n| i18n.get(lang_code))
            .and_then(|entry| entry.get("name"))
            .and_then(serde_json::Value::as_str);
        if let Some(name) = name {
            if !id.is_empty() && !name.is_empty() {
                map.insert(id.to_string(), name.to_string());
            }
        }
    }
    Ok(map)
}

/// Downloads and installs localized item names for one language from Warframe.Market, keyed
/// directly by `item_key`. WFStat is not involved — WFM is the marketplace's own canonical
/// localization and the only source covering every tradeable item in every supported language.
pub fn populate_language_item_names_v2(
    app: tauri::AppHandle,
    lang_code: String,
) -> std::result::Result<LanguagePackImportResultV2, String> {
    (|| -> Result<LanguagePackImportResultV2> {
        // English is the catalog's native `name_en`; nothing to localize.
        if lang_code.is_empty() || lang_code == "en" {
            return Ok(LanguagePackImportResultV2 {
                lang_code,
                item_count: 0,
            });
        }
        let names = fetch_wfm_item_names_v2(&lang_code)?;
        let mut connection = open_catalog_v2_writable(&app)?;
        ensure_language_pack_schema(&connection)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM item_i18n WHERE lang_code = ?1", [&lang_code])?;
        let mut inserted: i64 = 0;
        {
            // FK-safe: only writes rows for items present in this catalog.
            let mut insert = tx.prepare(
                "INSERT OR REPLACE INTO item_i18n (item_key, lang_code, name)
                 SELECT ?1, ?2, ?3
                 WHERE EXISTS (SELECT 1 FROM items WHERE item_key = ?1)",
            )?;
            for (item_key, name) in &names {
                inserted += insert.execute(params![item_key, lang_code, name])? as i64;
            }
        }
        let version = fetch_items_collection_version().ok();
        tx.execute(
            "INSERT INTO language_pack_meta (lang_code, wfm_version, item_count, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(lang_code) DO UPDATE SET
                wfm_version = excluded.wfm_version,
                item_count = excluded.item_count,
                updated_at = excluded.updated_at",
            params![lang_code, version, inserted, now_iso8601()],
        )?;
        tx.commit()?;
        Ok(LanguagePackImportResultV2 {
            lang_code,
            item_count: inserted,
        })
    })()
    .map_err(|error| error.to_string())
}

pub fn get_language_pack_status_v2(
    app: tauri::AppHandle,
    lang_code: String,
) -> std::result::Result<LanguagePackStatusV2, String> {
    (|| -> Result<LanguagePackStatusV2> {
        let connection = open_catalog_v2_readonly(&app)?;
        ensure_language_pack_schema(&connection)?;
        let item_count = i18n_row_count_v2(&connection, &lang_code)?;
        let built_version = language_built_version_v2(&connection, &lang_code)?;
        let (wfstat_reachable, current_version) =
            match fetch_items_collection_version() {
                Ok(version) => (true, Some(version)),
                Err(_) => (false, None),
            };
        let up_to_date = match (&built_version, &current_version) {
            (Some(b), Some(c)) => b == c,
            (None, Some(_)) => true,
            _ => false,
        };
        Ok(LanguagePackStatusV2 {
            lang_code,
            populated: item_count > 0,
            item_count,
            built_version,
            current_version,
            wfstat_reachable,
            up_to_date,
        })
    })()
    .map_err(|error| error.to_string())
}

/// Serializes a language's translations into a pack (as JSON). Guarded: the language must be
/// populated AND current with WFM (which requires WFM to be reachable to confirm). Returns
/// machine-readable error codes the UI maps to localized messages.
pub fn export_language_pack_v2(
    app: tauri::AppHandle,
    lang_code: String,
) -> std::result::Result<String, String> {
    (|| -> Result<String> {
        let connection = open_catalog_v2_readonly(&app)?;
        ensure_language_pack_schema(&connection)?;
        if i18n_row_count_v2(&connection, &lang_code)? == 0 {
            anyhow::bail!("LANGPACK_EMPTY");
        }
        let current_version = Some(
            fetch_items_collection_version()
                .map_err(|_| anyhow!("LANGPACK_OFFLINE"))?,
        );
        let built_version = language_built_version_v2(&connection, &lang_code)?;
        match (&built_version, &current_version) {
            (_, None) => anyhow::bail!("LANGPACK_OFFLINE"),
            (Some(built), Some(current)) if built != current => anyhow::bail!("LANGPACK_STALE"),
            _ => {}
        }
        let mut statement = connection.prepare(
            "SELECT item_key, name, icon, thumb, sub_icon FROM item_i18n
             WHERE lang_code = ?1 AND name IS NOT NULL AND name <> ''
             ORDER BY item_key",
        )?;
        let rows: Vec<LanguagePackRowV2> = statement
            .query_map([&lang_code], |row| {
                Ok(LanguagePackRowV2 {
                    item_key: row.get(0)?,
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    thumb: row.get(3)?,
                    sub_icon: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let pack = LanguagePackV2 {
            format: LANGUAGE_PACK_FORMAT_V2.to_string(),
            lang_code: lang_code.clone(),
            wfm_version: current_version,
            item_count: rows.len() as i64,
            exported_at: now_iso8601(),
            rows,
        };
        Ok(serde_json::to_string(&pack)?)
    })()
    .map_err(|error| error.to_string())
}

/// Applies a parsed language pack (REPLACE semantics for that language). Rows referencing items
/// not present in this catalog are skipped (FK-safe). Records the pack version so the language's
/// currency can be judged later.
pub fn import_language_pack_v2(
    app: tauri::AppHandle,
    pack_json: String,
) -> std::result::Result<LanguagePackImportResultV2, String> {
    (|| -> Result<LanguagePackImportResultV2> {
        let pack: LanguagePackV2 =
            serde_json::from_str(&pack_json).context("invalid language pack file")?;
        if pack.format != LANGUAGE_PACK_FORMAT_V2 {
            anyhow::bail!("LANGPACK_BADFORMAT");
        }
        if pack.lang_code.trim().is_empty() {
            anyhow::bail!("LANGPACK_BADFORMAT");
        }
        let mut connection = open_catalog_v2_writable(&app)?;
        ensure_language_pack_schema(&connection)?;
        let tx = connection.transaction()?;
        tx.execute(
            "DELETE FROM item_i18n WHERE lang_code = ?1",
            [&pack.lang_code],
        )?;
        let mut inserted: i64 = 0;
        {
            let mut insert = tx.prepare(
                "INSERT INTO item_i18n (item_key, lang_code, name, icon, thumb, sub_icon)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6
                 WHERE EXISTS (SELECT 1 FROM items WHERE item_key = ?1)",
            )?;
            for row in &pack.rows {
                inserted += insert.execute(params![
                    row.item_key,
                    pack.lang_code,
                    row.name,
                    row.icon,
                    row.thumb,
                    row.sub_icon,
                ])? as i64;
            }
        }
        tx.execute(
            "INSERT INTO language_pack_meta (lang_code, wfm_version, item_count, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(lang_code) DO UPDATE SET
                wfm_version = excluded.wfm_version,
                item_count = excluded.item_count,
                updated_at = excluded.updated_at",
            params![
                pack.lang_code,
                pack.wfm_version,
                inserted,
                now_iso8601()
            ],
        )?;
        tx.commit()?;
        Ok(LanguagePackImportResultV2 {
            lang_code: pack.lang_code,
            item_count: inserted,
        })
    })()
    .map_err(|error| error.to_string())
}

pub(crate) fn write_item_subtypes(connection: &Connection, items: &[ItemRow]) -> Result<()> {
    let mut statement = connection
        .prepare("INSERT INTO item_subtypes (item_key, ord, subtype) VALUES (?1, ?2, ?3)")?;
    for item in items {
        for (ord, subtype) in item.subtypes.iter().enumerate() {
            statement.execute(params![item.item_key, ord as i64, subtype])?;
        }
    }
    Ok(())
}

pub(crate) fn write_set_parts(connection: &Connection, set_parts: &[SetPartRow]) -> Result<()> {
    let mut statement = connection.prepare(
        "INSERT INTO set_parts (set_key, part_key, quantity_in_set) VALUES (?1, ?2, ?3)",
    )?;
    for row in set_parts {
        statement.execute(params![row.set_key, row.part_key, row.quantity_in_set])?;
    }
    Ok(())
}

fn lookup_kind_label(kind: LookupKind) -> &'static str {
    match kind {
        LookupKind::Slug => "slug",
        LookupKind::GameRef => "game_ref",
        LookupKind::GameRefLeaf => "game_ref_leaf",
        LookupKind::Name => "name",
    }
}

pub(crate) fn write_lookup(
    connection: &Connection,
    accepted: &[LookupRow],
    rejected: &[RejectedLookupKey],
) -> Result<()> {
    {
        let mut statement = connection.prepare(
            "INSERT INTO item_lookup (lookup_key, kind, item_key) VALUES (?1, ?2, ?3)",
        )?;
        for row in accepted {
            statement.execute(params![
                row.lookup_key,
                lookup_kind_label(row.kind),
                row.item_key,
            ])?;
        }
    }
    {
        let mut statement = connection.prepare(
            "INSERT INTO rejected_lookup_keys (lookup_key, candidates_json) VALUES (?1, ?2)",
        )?;
        for row in rejected {
            let candidates_json = serde_json::to_string(&row.candidates)
                .context("failed to serialize rejected lookup candidates")?;
            statement.execute(params![row.lookup_key, candidates_json])?;
        }
    }
    Ok(())
}

fn wfstat_tier_label(tier: WfstatMatchTier) -> &'static str {
    match tier {
        WfstatMatchTier::MarketInfoId => "market_info_id",
        WfstatMatchTier::GameRefExact => "game_ref_exact",
        WfstatMatchTier::BoundedComponentExact => "bounded_component_exact",
        WfstatMatchTier::BoundedComponentByName => "bounded_component_by_name",
        WfstatMatchTier::GlobalComponentExact => "global_component_exact",
    }
}

pub(crate) fn write_wfstat_report_with_raw_json(
    connection: &Connection,
    report: &WfstatMatchReport,
    category_by_unique_name: &HashMap<String, (Option<String>, Option<String>)>,
    raw_json_by_unique_name: &HashMap<String, String>,
) -> Result<()> {
    {
        let mut statement = connection.prepare(
            "INSERT INTO wfstat_matches (item_key, wfstat_unique_name, match_tier, category, type, raw_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (item_key, (unique_name, tier)) in &report.matches {
            let (category, item_type) = category_by_unique_name
                .get(unique_name)
                .cloned()
                .unwrap_or((None, None));
            let raw_json = raw_json_by_unique_name.get(unique_name).cloned();
            statement.execute(params![
                item_key,
                unique_name,
                wfstat_tier_label(*tier),
                category,
                item_type,
                raw_json
            ])?;
        }
    }
    {
        let mut statement =
            connection.prepare("INSERT INTO wfstat_unmatched (item_key) VALUES (?1)")?;
        for item_key in &report.unmatched {
            statement.execute(params![item_key])?;
        }
    }
    Ok(())
}

/// Writes every matched relic's sibling refinements, found by stripping the matched WFStat
/// record's own refinement suffix and looking up the rest of its group in `variant_map` (see
/// `build_wfstat_relic_variant_map`). Non-relics never appear here.
pub(crate) fn write_wfstat_relic_variants(
    connection: &Connection,
    report: &WfstatMatchReport,
    items_by_key: &HashMap<String, &ItemRow>,
    variant_map: &HashMap<String, HashMap<String, String>>,
) -> Result<()> {
    let mut statement = connection.prepare(
        "INSERT INTO wfstat_relic_variants (item_key, refinement, raw_json) VALUES (?1, ?2, ?3)",
    )?;
    for (item_key, (unique_name, _tier)) in &report.matches {
        let Some(item) = items_by_key.get(item_key) else {
            continue;
        };
        if item.item_family != "relic" {
            continue;
        }
        let Some(suffix) = RELIC_REFINEMENT_SUFFIXES
            .iter()
            .find(|suffix| unique_name.ends_with(**suffix))
        else {
            continue;
        };
        let prefix = &unique_name[..unique_name.len() - suffix.len()];
        let Some(siblings) = variant_map.get(prefix) else {
            continue;
        };
        for (refinement, raw_json) in siblings {
            statement.execute(params![item_key, refinement, raw_json])?;
        }
    }
    Ok(())
}

pub(crate) fn write_catalog_meta(connection: &Connection, key: &str, value: &str) -> Result<()> {
    connection.execute(
        "INSERT INTO catalog_meta (meta_key, meta_value) VALUES (?1, ?2)
         ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value",
        params![key, value],
    )?;
    Ok(())
}

/// Summary handed back from a full build — the numbers worth looking at before trusting the
/// file, without having to query it first.
#[derive(Debug, Clone)]
pub(crate) struct CatalogBuildSummary {
    pub item_count: usize,
    pub set_root_count: usize,
    pub set_part_count: usize,
    pub lookup_key_count: usize,
    pub rejected_key_count: usize,
    pub wfstat_tier_counts: (usize, usize, usize, usize, usize),
    pub wfstat_unmatched_count: usize,
}

/// Runs the whole pipeline against already-fetched JSON and writes every table. Fetching (live
/// network) is kept OUT of this function on purpose, so it stays testable with fixtures — the
/// live harness in `tests::build_real_catalog_v2_live` is a thin wrapper that fetches, then
/// calls this.
pub(crate) fn build_and_write_catalog(
    connection: &Connection,
    wfm_bulk_json: &str,
    wfm_item_details_json_by_key: &HashMap<String, String>,
    wfstat_json: &str,
) -> Result<CatalogBuildSummary> {
    initialize_schema(connection)?;

    let mut items =
        build_item_rows(wfm_bulk_json).context("failed to parse WFM bulk item response")?;
    let set_parts = apply_set_details(&mut items, wfm_item_details_json_by_key)
        .context("failed to apply WFM per-item set details")?;
    let wfstat_report = build_wfstat_matches(&items, wfstat_json, &set_parts)
        .context("failed to parse WFStat item response")?;
    let (lookup, rejected) = build_item_lookup(&items, &wfstat_report.matches);
    let wfstat_category_map = build_wfstat_category_map(wfstat_json)
        .context("failed to parse WFStat category/type data")?;
    let wfstat_raw_json_map = build_wfstat_raw_json_map(wfstat_json)
        .context("failed to parse WFStat raw item data")?;
    let wfstat_relic_variant_map = build_wfstat_relic_variant_map(wfstat_json)
        .context("failed to parse WFStat relic refinement data")?;
    let i18n_rows =
        build_item_i18n_rows(wfm_bulk_json).context("failed to parse WFM bulk i18n data")?;

    let summary = CatalogBuildSummary {
        item_count: items.len(),
        set_root_count: items.iter().filter(|item| item.set_root).count(),
        set_part_count: set_parts.len(),
        lookup_key_count: lookup.len(),
        rejected_key_count: rejected.len(),
        wfstat_tier_counts: wfstat_report.tier_counts(),
        wfstat_unmatched_count: wfstat_report.unmatched.len(),
    };

    write_items(connection, &items)?;
    write_item_subtypes(connection, &items)?;
    write_item_i18n(connection, &i18n_rows)?;
    write_set_parts(connection, &set_parts)?;
    write_lookup(connection, &lookup, &rejected)?;
    write_wfstat_report_with_raw_json(
        connection,
        &wfstat_report,
        &wfstat_category_map,
        &wfstat_raw_json_map,
    )?;
    {
        let items_by_key: HashMap<String, &ItemRow> =
            items.iter().map(|item| (item.item_key.clone(), item)).collect();
        write_wfstat_relic_variants(
            connection,
            &wfstat_report,
            &items_by_key,
            &wfstat_relic_variant_map,
        )?;
    }
    write_catalog_meta(connection, "built_at", &now_iso8601())?;
    write_catalog_meta(connection, "item_count", &summary.item_count.to_string())?;

    Ok(summary)
}

fn now_iso8601() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

// ─── Live fetch (network) ───────────────────────────────────────────────────────────────────
//
// WFM requests go through the app's shared rate-limited scheduler (`wfm_scheduler`) at Low
// priority — the same pool every other WFM call in the app uses, so this can never independently
// hammer WFM regardless of what else is happening. WFStat is not part of that pool (it has no
// shared rate limit with WFM) and is fetched directly, best-effort: its failure must never fail
// the catalog build, only leave items unmatched to enrichment data.

fn wfm_response_text(response: WfmHttpResponse, action_label: &str) -> Result<String> {
    if response.status < 200 || response.status >= 300 {
        let body = String::from_utf8_lossy(&response.body);
        let trimmed = body.trim();
        return Err(anyhow!(if trimmed.is_empty() {
            format!("{action_label} failed with status {}", response.status)
        } else {
            format!("{action_label} failed with status {}: {trimmed}", response.status)
        }));
    }
    String::from_utf8(response.body).with_context(|| format!("{action_label} returned non-UTF8 body"))
}

fn fetch_wfm_bulk_items() -> Result<String> {
    let action_label = "fetch WFM bulk items";
    let response = execute_coalesced_wfm_request(
        RequestPriority::Low,
        action_label,
        Some("catalog-v2:bulk-items".to_string()),
        Some(Duration::from_secs(60)),
        || false,
        || {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()?;
            let response = client
                .get("https://api.warframe.market/v2/items")
                .header("User-Agent", WFM_USER_AGENT)
                .header("Language", "en")
                .send()
                .context("failed to send WFM bulk items request")?;
            Ok(WfmHttpResponse {
                status: response.status().as_u16(),
                headers: HashMap::new(),
                retry_after: None,
                body: response
                    .bytes()
                    .context("failed to read WFM bulk items response body")?
                    .to_vec(),
            })
        },
    )?;
    wfm_response_text(response, action_label)
}

fn fetch_wfm_item_detail(slug: &str) -> Result<String> {
    let action_label = format!("fetch WFM item detail for {slug}");
    let slug_owned = slug.to_string();
    let response = execute_coalesced_wfm_request(
        RequestPriority::Low,
        &action_label,
        Some(format!("catalog-v2:item-detail:{slug}")),
        Some(Duration::from_secs(30)),
        || false,
        move || {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?;
            let response = client
                .get(format!("https://api.warframe.market/v2/item/{slug_owned}"))
                .header("User-Agent", WFM_USER_AGENT)
                .header("Language", "en")
                .send()
                .with_context(|| format!("failed to send WFM item detail request for {slug_owned}"))?;
            Ok(WfmHttpResponse {
                status: response.status().as_u16(),
                headers: HashMap::new(),
                retry_after: None,
                body: response
                    .bytes()
                    .with_context(|| format!("failed to read WFM item detail body for {slug_owned}"))?
                    .to_vec(),
            })
        },
    )?;
    wfm_response_text(response, &action_label)
}

fn fetch_wfstat_items() -> Result<String> {
    // 180s, not 60s — matches `item_catalog.rs`'s own timeout for the same ~40MB WFStat
    // response. This build's per-item WFM loop (230 sequential fetches through the shared
    // scheduler) runs immediately before this call, competing with the rest of the app's
    // startup network activity (websocket, presence, market observatory priming, the OLD
    // catalog's own startup fetch) — 60s was tight enough to fail under that real contention
    // even though it fetched instantly in isolation, which is exactly what happened on first
    // real run: silently degraded to zero WFStat matches instead of surfacing a timeout.
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()?;
    let response = client
        .get("https://api.warframestat.us/items/")
        .header("User-Agent", WFM_USER_AGENT)
        .send()
        .context("failed to send WFStat items request")?
        .error_for_status()
        .context("WFStat items request returned an error status")?;
    response.text().context("failed to read WFStat items body")
}

/// Extracts the slug from a bulk item JSON string without a full parse — used to decide which
/// items need the per-item detail fetch (anything WFM tagged "set") before the real parse runs.
fn slugs_needing_set_detail(wfm_bulk_json: &str) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct Row {
        slug: String,
        #[serde(default)]
        tags: Vec<String>,
    }
    #[derive(Deserialize)]
    struct Response {
        data: Vec<Row>,
    }
    let parsed: Response =
        serde_json::from_str(wfm_bulk_json).context("failed to parse WFM bulk items for slugs")?;
    Ok(parsed
        .data
        .into_iter()
        .filter(|row| row.tags.iter().any(|tag| tag == "set"))
        .map(|row| row.slug)
        .collect())
}

/// Maps a bulk item's slug to its `item_key`, needed because the per-item detail response
/// carries no id of its own (see the `id` field comment on `WfmItemDetail`) — the caller must
/// know which item a detail body belongs to before this function can file it correctly.
fn item_keys_by_slug(wfm_bulk_json: &str) -> Result<HashMap<String, String>> {
    #[derive(Deserialize)]
    struct Row {
        id: String,
        slug: String,
    }
    #[derive(Deserialize)]
    struct Response {
        data: Vec<Row>,
    }
    let parsed: Response = serde_json::from_str(wfm_bulk_json)
        .context("failed to parse WFM bulk items for id/slug pairs")?;
    Ok(parsed.data.into_iter().map(|row| (row.slug, row.id)).collect())
}

// ─── Production build ───────────────────────────────────────────────────────────────────────

const CATALOG_V2_DATABASE_FILE: &str = "item_catalog_v2.sqlite";
const CATALOG_V2_DATABASE_TMP_FILE: &str = "item_catalog_v2.sqlite.building";

/// Bumped whenever `initialize_schema`'s table shape changes (a column or table added/removed).
/// The freshness check below compares this against what an on-disk file was built with,
/// independently of the WFM collection hash — WFM's own data can be byte-identical between two
/// launches while this crate's schema has still grown (exactly what happened when `item_i18n`,
/// `set_parts.quantity_in_set`, `wfstat_relic_variants`, `language_pack_meta`, etc. were added).
/// Without this, a launch would silently keep reusing an older file missing those columns/tables
/// forever, since nothing about WFM's data changed to trigger a rebuild.
const CATALOG_V2_SCHEMA_VERSION: &str = "3";

/// One point in the build the caller might want to report progress at. Internal plumbing only —
/// no `Serialize`, nothing crosses the IPC boundary here; the startup caller translates each
/// variant into the app's existing `startup-progress` event.
enum BuildPhase {
    FetchingBulkItems,
    /// Emitted periodically (not every item — 230 events in under two minutes would flood the
    /// progress UI for no benefit), so `completed`/`total` let the caller show real numbers
    /// without needing to count itself.
    FetchingSetDetails { completed: usize, total: usize },
    FetchingWfstat,
    Writing,
}

/// Builds the v2 catalog from live data and writes it to `output_path`, which must not already
/// exist as a valid SQLite file the caller cares about — this always starts from an empty file
/// (see `initialize_schema`, which does `CREATE TABLE`, not `CREATE TABLE IF NOT EXISTS`).
///
/// WFM is required: if the bulk fetch or any part of parsing/writing it fails, the whole build
/// fails, because there is no v2 catalog without it. WFStat is optional: if it's unreachable,
/// the build still succeeds — every item, its slug, its set membership — using an empty WFStat
/// response, and every item simply carries no enrichment match. This is the one behavior this
/// whole rebuild exists to guarantee (see the module doc comment); it is exercised directly by
/// `wfstat_being_unreachable_does_not_prevent_a_full_working_catalog` above.
///
/// The second return value is the WFStat fetch failure reason, when there was one — degrading
/// to zero enrichment matches must never also mean the reason gets thrown away. A previous
/// version of this function did exactly that (`unwrap_or_else(|_| "[]".to_string())`), and the
/// real first production run silently built a catalog with 3,837/3,837 items unmatched with no
/// trace of why in the log.
/// Test-only convenience wrapper — production code calls `build_catalog_v2_with_progress`
/// directly so it can report progress to the boot loading screen (see
/// `initialize_catalog_v2_on_startup`); tests don't care about progress reporting.
#[cfg(test)]
pub(crate) fn build_catalog_v2(
    output_path: &Path,
) -> Result<(CatalogBuildSummary, Option<String>)> {
    build_catalog_v2_with_progress(output_path, |_| {})
}

const SET_DETAIL_PROGRESS_REPORT_INTERVAL: usize = 15;

fn build_catalog_v2_with_progress(
    output_path: &Path,
    mut on_phase: impl FnMut(BuildPhase),
) -> Result<(CatalogBuildSummary, Option<String>)> {
    on_phase(BuildPhase::FetchingBulkItems);
    let wfm_bulk_json = fetch_wfm_bulk_items().context("WFM bulk item fetch failed")?;

    let set_slugs = slugs_needing_set_detail(&wfm_bulk_json)?;
    let item_keys = item_keys_by_slug(&wfm_bulk_json)?;
    let slug_by_item_key: HashMap<String, String> =
        item_keys.iter().map(|(slug, key)| (key.clone(), slug.clone())).collect();

    let mut details_by_key: HashMap<String, String> = HashMap::with_capacity(set_slugs.len());

    // Pass 1: every set ROOT (WFM-tagged "set" in bulk). This is what tells us setParts at all.
    // Pass 2 (below) then broadens to every distinct COMPONENT referenced by those setParts,
    // because `quantityInSet` only appears on a component's own detail response, never on the
    // root's — confirmed live against `/v2/item/{slug}`.
    // Pass 1's true combined total (pass 1 + pass 2) isn't known until pass 1's responses are
    // parsed below, so pass 1 reports progress against an estimate — every set root has at least
    // one component in practice, so `total_pass1 * 2` undercounts more often than it overcounts,
    // keeping the bar from visibly overshooting 100% once the real combined total is known.
    let total_pass1 = set_slugs.len();
    let estimated_combined_total = total_pass1 * 2;
    for (index, slug) in set_slugs.iter().enumerate() {
        // One item's detail failing must not abort the whole build — it just means that one
        // set's parts stay unknown, same tolerance the rest of the app gives a single bad fetch.
        if let Ok(body) = fetch_wfm_item_detail(slug) {
            if let Some(item_key) = item_keys.get(slug) {
                details_by_key.insert(item_key.clone(), body);
            }
        }
        let completed = index + 1;
        if completed % SET_DETAIL_PROGRESS_REPORT_INTERVAL == 0 || completed == total_pass1 {
            on_phase(BuildPhase::FetchingSetDetails {
                completed,
                total: estimated_combined_total,
            });
        }
    }

    let mut component_keys: HashSet<String> = HashSet::new();
    for (item_key, json) in &details_by_key {
        if let Ok(detail) = parse_item_detail(json) {
            if detail.set_root {
                for part_key in &detail.set_parts {
                    if part_key != item_key {
                        component_keys.insert(part_key.clone());
                    }
                }
            }
        }
    }
    let component_slugs: Vec<String> = component_keys
        .into_iter()
        .filter(|key| !details_by_key.contains_key(key))
        .filter_map(|key| slug_by_item_key.get(&key).cloned())
        .collect();

    // Pass 2 continues the SAME `completed`/`total` counter pass 1 was using, rather than
    // restarting from zero — a reset back to "0 of N" reads as the whole step having restarted
    // even though it's real, new, bounded work (fetching each set's own COMPONENTS, since
    // `quantityInSet` only appears on a component's own detail response — see above).
    let total_combined = total_pass1 + component_slugs.len();
    for (index, slug) in component_slugs.iter().enumerate() {
        // Same tolerance as pass 1 — a failed component fetch just leaves its quantity at the
        // default of 1 rather than aborting the build.
        if let Ok(body) = fetch_wfm_item_detail(slug) {
            if let Some(item_key) = item_keys.get(slug) {
                details_by_key.insert(item_key.clone(), body);
            }
        }
        let completed = total_pass1 + index + 1;
        if completed % SET_DETAIL_PROGRESS_REPORT_INTERVAL == 0 || completed == total_combined {
            on_phase(BuildPhase::FetchingSetDetails { completed, total: total_combined });
        }
    }

    // WFStat is optional decoration — "[]" parses as zero items, which the matching pipeline
    // already treats as "everything unmatched", the exact same outcome as WFStat being offline.
    // The failure reason is preserved (not discarded) so the caller can log it.
    on_phase(BuildPhase::FetchingWfstat);
    let (wfstat_json, wfstat_fetch_error) = match fetch_wfstat_items() {
        Ok(json) => (json, None),
        Err(error) => ("[]".to_string(), Some(format!("{error:#}"))),
    };

    on_phase(BuildPhase::Writing);
    let connection = Connection::open(output_path)
        .with_context(|| format!("failed to open {}", output_path.display()))?;
    let summary = build_and_write_catalog(&connection, &wfm_bulk_json, &details_by_key, &wfstat_json)?;
    Ok((summary, wfstat_fetch_error))
}

/// Reads back the WFM collection hash a catalog file was built against, so a launch can tell
/// whether anything changed without redoing the full build. Tolerant of every way this can be
/// legitimately absent (no file yet, file exists but predates this check, corrupt file) — all of
/// those mean "can't confirm freshness", handled by the caller, not an error here.
/// Whether the v2 catalog needs a full rebuild. Pure and standalone specifically so every case
/// is directly testable without a network or an `AppHandle` — getting this wrong in either
/// direction is a real regression (rebuild every launch forever, or never update at all), and
/// that risk is exactly why it isn't left inline where only an integration test could reach it.
///
/// `Ok(None)` from the version probe (WFM unreachable) deliberately reads as "can't confirm
/// freshness" rather than "definitely stale" — forcing a rebuild we can't complete anyway, on
/// top of whatever already has the network struggling, would only make a bad moment worse.
///
/// A schema-version mismatch always forces a rebuild regardless of the collection hash or
/// network reachability — it's a purely local fact (no fetch required to know the on-disk file
/// predates the current `initialize_schema`), so there's no case where it's safe to defer.
fn catalog_v2_needs_rebuild(
    file_exists: bool,
    latest_collection_hash: Option<&str>,
    stored_collection_hash: Option<&str>,
    stored_schema_version: Option<&str>,
) -> bool {
    if !file_exists {
        return true;
    }
    if stored_schema_version != Some(CATALOG_V2_SCHEMA_VERSION) {
        return true;
    }
    match (latest_collection_hash, stored_collection_hash) {
        (Some(latest), Some(stored)) => latest != stored,
        (None, _) => false,
        (Some(_), None) => true,
    }
}

fn read_stored_collection_hash(path: &Path) -> Option<String> {
    read_stored_meta(path, "collection_hash")
}

fn read_stored_schema_version(path: &Path) -> Option<String> {
    read_stored_meta(path, "schema_version")
}

fn read_stored_meta(path: &Path, meta_key: &str) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let connection = Connection::open(path).ok()?;
    connection
        .query_row(
            "SELECT meta_value FROM catalog_meta WHERE meta_key = ?1",
            params![meta_key],
            |row| row.get(0),
        )
        .ok()
}

/// Fetches, cross-references, and atomically installs a fresh catalog at `final_path`: builds to
/// `tmp_path` first, then renames it into place, so a reader querying at any point during the
/// build only ever sees the complete old file or the complete new one — never a half-written one.
/// `on_phase` is the caller's progress sink; this function has no opinion on which UI event that
/// feeds (the foreground boot bar and the background refresh indicator both call through here).
fn perform_catalog_v2_rebuild(
    tmp_path: &Path,
    final_path: &Path,
    latest_collection_hash: Option<&str>,
    on_phase: impl FnMut(BuildPhase),
) -> Result<(CatalogBuildSummary, Option<String>)> {
    // A previous run that crashed mid-build could leave this behind; starting from nothing is
    // correct since `initialize_schema` cannot run twice against the same tables anyway.
    let _ = std::fs::remove_file(tmp_path);

    let (summary, wfstat_fetch_error) = build_catalog_v2_with_progress(tmp_path, on_phase)?;

    // Record what we built against BEFORE the rename, so the file that lands at `final_path`
    // already carries the hash a future launch needs — there is no window where the live file
    // exists but is missing this.
    {
        let connection = Connection::open(tmp_path)
            .with_context(|| format!("failed to reopen {}", tmp_path.display()))?;
        if let Some(hash) = latest_collection_hash {
            write_catalog_meta(&connection, "collection_hash", hash)?;
        }
        write_catalog_meta(&connection, "schema_version", CATALOG_V2_SCHEMA_VERSION)?;
    }

    std::fs::rename(tmp_path, final_path)
        .with_context(|| format!("failed to finalize {}", final_path.display()))?;

    Ok((summary, wfstat_fetch_error))
}

/// Maps a `BuildPhase` to the boot progress bar's 0.66-0.8 sub-range and emits it on
/// `startup-progress` — the foreground (blocking) path's progress sink.
fn emit_foreground_build_phase(app: &AppHandle, phase: BuildPhase) {
    match phase {
        BuildPhase::FetchingBulkItems => {}
        BuildPhase::FetchingSetDetails { completed, total } => {
            let fraction = if total == 0 {
                0.74
            } else {
                0.66 + (completed as f64 / total as f64) * 0.08
            };
            emit_progress(
                app,
                "catalog-v2-sets",
                "Mapping item sets",
                &format!("Resolving set contents ({completed}/{total})."),
                fraction,
            );
        }
        BuildPhase::FetchingWfstat => {
            emit_progress(
                app,
                "catalog-v2-wfstat",
                "Cross-referencing item details",
                "Matching items against warframestat.us for extra detail.",
                0.76,
            );
        }
        BuildPhase::Writing => {
            emit_progress(
                app,
                "catalog-v2-writing",
                "Finalizing item catalog",
                "Saving the refreshed item catalog.",
                0.79,
            );
        }
    }
}

/// Same phase mapping as the foreground bar, but as an independent 0.0-1.0 fraction on the
/// background-refresh event instead of the boot bar's sub-range.
fn emit_background_build_phase(app: &AppHandle, phase: BuildPhase) {
    let (status_text, fraction) = match phase {
        BuildPhase::FetchingBulkItems => (
            "Fetching the latest item list from Warframe Market.".to_string(),
            0.05,
        ),
        BuildPhase::FetchingSetDetails { completed, total } => {
            let fraction = if total == 0 { 0.8 } else { (completed as f64 / total as f64) * 0.8 };
            (format!("Resolving set contents ({completed}/{total})."), fraction)
        }
        BuildPhase::FetchingWfstat => (
            "Matching items against warframestat.us for extra detail.".to_string(),
            0.85,
        ),
        BuildPhase::Writing => ("Saving the refreshed item catalog.".to_string(), 0.95),
    };
    let _ = app.emit(
        CATALOG_V2_BACKGROUND_PROGRESS_EVENT,
        BackgroundCatalogProgress { status_text, progress_value: fraction },
    );
}

fn log_catalog_v2_build_result(
    app: &AppHandle,
    summary: &CatalogBuildSummary,
    wfstat_fetch_error: &Option<String>,
) -> bool {
    let (t1, t2, t3, t4, t5) = summary.wfstat_tier_counts;
    let matched = t1 + t2 + t3 + t4 + t5;
    log_feature_event_best_effort(
        app,
        "catalog-v2",
        "build",
        &format!(
            "Built item catalog v2: {} items, {} set roots ({} set-part links), {} \
             lookup keys ({} rejected as ambiguous), WFStat matched {}/{} ({} unmatched, \
             {t1}/{t2}/{t3}/{t4}/{t5} by tier).",
            summary.item_count,
            summary.set_root_count,
            summary.set_part_count,
            summary.lookup_key_count,
            summary.rejected_key_count,
            matched,
            summary.item_count,
            summary.wfstat_unmatched_count,
        ),
    );
    // Logged as a distinct ERROR entry, not folded into the info line above — the first real run
    // of this build silently produced 0/3837 WFStat matches with no trace of why, because the
    // failure reason was discarded instead of surfaced. It must never be quiet again: a catalog
    // with zero enrichment matches is a symptom, not a successful outcome, even though the build
    // itself did not fail.
    let wfstat_stale = wfstat_fetch_error.is_some();
    if let Some(reason) = wfstat_fetch_error {
        log_feature_error_best_effort(
            app,
            "catalog-v2",
            "wfstat-fetch",
            "Catalog v2 built successfully but WFStat was unreachable, so every item is missing \
             enrichment data (damage/magazine/range/etc. once that layer exists). This is not \
             fatal — the catalog is otherwise fully correct — but it should not happen every \
             run. If it keeps happening, the fetch timeout or network conditions need attention.",
            &anyhow!(reason.clone()),
        );
    }
    wfstat_stale
}

/// True while a background refresh is in flight — guards against spawning a second one (e.g. a
/// dev-mode double-invoked startup call, or the app being relaunched while one is still running)
/// racing the same `tmp_path`/`final_path`.
fn background_refresh_in_flight() -> &'static std::sync::atomic::AtomicBool {
    static FLAG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &FLAG
}

/// Refreshes an already-usable (but stale) catalog off the main boot path. The app has already
/// handed control to the user by the time this runs — see `initialize_catalog_v2_on_startup` —
/// so failures here are logged and otherwise silent: the existing file just keeps serving until
/// the next launch's freshness check tries again, exactly like any other reuse-last-good case.
fn spawn_background_catalog_v2_refresh(
    app: tauri::AppHandle,
    final_path: std::path::PathBuf,
    tmp_path: std::path::PathBuf,
    latest_collection_hash: Option<String>,
) {
    use std::sync::atomic::Ordering;
    if background_refresh_in_flight()
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    std::thread::spawn(move || {
        let result = perform_catalog_v2_rebuild(
            &tmp_path,
            &final_path,
            latest_collection_hash.as_deref(),
            |phase| emit_background_build_phase(&app, phase),
        );
        match result {
            Ok((summary, wfstat_fetch_error)) => {
                log_catalog_v2_build_result(&app, &summary, &wfstat_fetch_error);
                let _ = app.emit(CATALOG_V2_BACKGROUND_COMPLETE_EVENT, ());
            }
            Err(error) => {
                log_feature_error_best_effort(
                    &app,
                    "catalog-v2",
                    "background-build",
                    "Background item catalog refresh failed — the previous catalog file is \
                     untouched and keeps serving; this will be retried on the next launch.",
                    &error,
                );
                let _ = app.emit(
                    CATALOG_V2_BACKGROUND_FAILED_EVENT,
                    BackgroundCatalogFailed { message: format!("{error:#}") },
                );
            }
        }
        background_refresh_in_flight().store(false, Ordering::SeqCst);
    });
}

/// Runs the v2 catalog freshness check as a blocking step in the app's existing startup sequence
/// (see `commands::run_initialize_app_catalog`, which calls this right after the current catalog
/// settles), and — depending on what it finds — either performs the rebuild inline or hands it
/// off to a background thread:
///
/// - **No catalog file exists at all** (first install): nothing else in the app can resolve an
///   item's identity without one, so this blocks exactly as before — the loading screen stays up
///   until the build lands, using the existing `startup-progress` event.
/// - **A catalog file exists but is stale**: it's a complete, internally-consistent snapshot,
///   just not the newest one. Boot proceeds immediately serving it, and the refresh runs in the
///   background (see `spawn_background_catalog_v2_refresh`), reported on a separate event so a
///   small persistent indicator can track it without resurrecting the full-screen loading bar.
///
/// Freshness-gated like the existing catalog: a cheap WFM version probe decides whether anything
/// actually changed before paying for the full rebuild (bulk fetch + several hundred rate-limited
/// per-item fetches + WFStat fetch, a few minutes total) — without this, EVERY launch would pay
/// that cost, not just the first one or ones where the catalog actually changed.
pub fn initialize_catalog_v2_on_startup(app: &tauri::AppHandle) -> Result<StartupSummary, String> {
    enum Decision {
        UpToDate,
        RebuiltForeground(CatalogBuildSummary, Option<String>),
        DeferredToBackground,
    }

    let outcome = (|| -> Result<Decision> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .context("failed to resolve the app data directory")?;
        std::fs::create_dir_all(&app_data_dir)
            .with_context(|| format!("failed to create {}", app_data_dir.display()))?;
        let final_path = app_data_dir.join(CATALOG_V2_DATABASE_FILE);
        let tmp_path = app_data_dir.join(CATALOG_V2_DATABASE_TMP_FILE);

        emit_progress(
            app,
            "catalog-v2-check",
            "Checking item catalog",
            "Checking whether the item catalog needs refreshing.",
            0.62,
        );
        let latest_collection_hash = fetch_items_collection_version().ok();
        let stored_collection_hash = read_stored_collection_hash(&final_path);
        let stored_schema_version = read_stored_schema_version(&final_path);
        let file_exists = final_path.exists();
        let need_rebuild = catalog_v2_needs_rebuild(
            file_exists,
            latest_collection_hash.as_deref(),
            stored_collection_hash.as_deref(),
            stored_schema_version.as_deref(),
        );

        if !need_rebuild {
            emit_progress(
                app,
                "catalog-v2-cached",
                "Item catalog ready",
                "Using the cached item catalog — no changes detected.",
                0.8,
            );
            return Ok(Decision::UpToDate);
        }

        if !file_exists {
            emit_progress(
                app,
                "catalog-v2-fetch",
                "Downloading market items",
                "Fetching the latest item list from Warframe Market.",
                0.64,
            );
            let (summary, wfstat_fetch_error) = perform_catalog_v2_rebuild(
                &tmp_path,
                &final_path,
                latest_collection_hash.as_deref(),
                |phase| emit_foreground_build_phase(app, phase),
            )?;
            emit_progress(
                app,
                "catalog-v2-ready",
                "Item catalog ready",
                "Item catalog refreshed.",
                0.8,
            );
            return Ok(Decision::RebuiltForeground(summary, wfstat_fetch_error));
        }

        // A usable (if stale) catalog already exists — don't block boot on the refresh.
        emit_progress(
            app,
            "catalog-v2-cached",
            "Item catalog ready",
            "Using the cached item catalog while a refresh runs in the background.",
            0.8,
        );
        spawn_background_catalog_v2_refresh(
            app.clone(),
            final_path,
            tmp_path,
            latest_collection_hash,
        );
        Ok(Decision::DeferredToBackground)
    })();

    match outcome {
        Ok(Decision::UpToDate) => {
            log_feature_event_best_effort(
                app,
                "catalog-v2",
                "build",
                "Item catalog v2 unchanged since last launch — reused the existing file.",
            );
            summary_from_existing_file(app, false)
        }
        Ok(Decision::DeferredToBackground) => {
            log_feature_event_best_effort(
                app,
                "catalog-v2",
                "build",
                "Item catalog v2 is stale — serving the existing file while a refresh runs in \
                 the background.",
            );
            summary_from_existing_file(app, false)
        }
        Ok(Decision::RebuiltForeground(summary, wfstat_fetch_error)) => {
            let wfstat_stale = log_catalog_v2_build_result(app, &summary, &wfstat_fetch_error);
            Ok(StartupSummary {
                ready: true,
                refreshed: true,
                database_path: catalog_v2_database_path(app)
                    .map(|path| path.display().to_string())
                    .unwrap_or_default(),
                data_dir: app
                    .path()
                    .app_data_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default(),
                wfm_source_file: String::new(),
                wfstat_source_file: None,
                stats: import_stats_from_build_summary(&summary),
                current_wfm_api_version: None,
                wfstat_stale,
            })
        }
        Err(error) => {
            let error_text = format!("{error:#}");
            log_feature_error_best_effort(
                app,
                "catalog-v2",
                "build",
                "Failed to build item catalog v2.",
                &error,
            );
            // A build failure with an already-usable catalog on disk is a soft failure — reuse
            // what's there (same "reuse-last-good" contract the old catalog gave WFM/WFStat
            // outages) rather than blocking the app. Only a FRESH install with no catalog at all
            // and no way to build one is fatal: the app genuinely cannot function without item
            // identity data, so this is the one case that must surface as a hard, actionable
            // startup error (matches the old catalog's `WFM_OFFLINE` contract the frontend's
            // `StartupScreen` already matches on).
            match catalog_v2_database_path(app).ok().filter(|path| path.exists()) {
                Some(_) => {
                    log_feature_event_best_effort(
                        app,
                        "catalog-v2",
                        "build",
                        "Reusing the existing item catalog v2 after a failed refresh.",
                    );
                    summary_from_existing_file(app, true)
                }
                None => Err(format!(
                    "WFM_OFFLINE: Warframe.Market is unreachable and WarStonks has no saved item \
                     catalog yet. WarStonks cannot function without Warframe.Market — please try \
                     again once it is back online. ({error_text})"
                )),
            }
        }
    }
}

fn import_stats_from_build_summary(summary: &CatalogBuildSummary) -> ImportStats {
    let (t1, t2, t3, t4, t5) = summary.wfstat_tier_counts;
    ImportStats {
        total_wfm_items: summary.item_count,
        // v2 doesn't track the raw size of the WFStat catalog separately — only how many WFM
        // items it successfully matched against. Not the same number the old catalog reported,
        // but the only honest one available here; only ever shown as `totalWfmItems +
        // totalWfstatItems` on the startup screen, so this stays a display-only approximation.
        total_wfstat_items: t1 + t2 + t3 + t4 + t5,
        // v2's match tiers (`MarketInfoId`/`GameRefExact`/`BoundedComponentExact`/
        // `BoundedComponentByName`/`GlobalComponentExact`) don't line up one-to-one with the old
        // catalog's alias-resolution stages — approximated by directness, not a literal mapping.
        // None of these individual fields are rendered anywhere in the frontend today.
        matched_by_direct_ref: t1 + t2,
        matched_by_component_ref: t3 + t5,
        matched_by_market_slug: 0,
        matched_by_market_id: 0,
        matched_by_normalized_name: t4,
        matched_by_blueprint_decomposition: 0,
        matched_by_manual_alias: 0,
        unmatched_wfm_items: summary.wfstat_unmatched_count,
        wfm_only_canonical_items: summary.wfstat_unmatched_count,
        wfstat_only_canonical_items: 0,
    }
}

/// Builds a `StartupSummary` by reading counts back off the catalog file already on disk —
/// used both when today's launch found nothing to rebuild and when a rebuild failed but a
/// previous good file still exists.
fn summary_from_existing_file(app: &tauri::AppHandle, refreshed: bool) -> Result<StartupSummary, String> {
    let db_path = catalog_v2_database_path(app).map_err(|error| error.to_string())?;
    let connection = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let item_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
        .unwrap_or(0);
    let matched_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM wfstat_matches", [], |row| row.get(0))
        .unwrap_or(0);
    let unmatched_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM wfstat_unmatched", [], |row| row.get(0))
        .unwrap_or(0);

    Ok(StartupSummary {
        ready: true,
        refreshed,
        database_path: db_path.display().to_string(),
        data_dir: app
            .path()
            .app_data_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        wfm_source_file: String::new(),
        wfstat_source_file: None,
        stats: ImportStats {
            total_wfm_items: item_count as usize,
            total_wfstat_items: matched_count as usize,
            matched_by_direct_ref: matched_count as usize,
            matched_by_component_ref: 0,
            matched_by_market_slug: 0,
            matched_by_market_id: 0,
            matched_by_normalized_name: 0,
            matched_by_blueprint_decomposition: 0,
            matched_by_manual_alias: 0,
            unmatched_wfm_items: unmatched_count as usize,
            wfm_only_canonical_items: unmatched_count as usize,
            wfstat_only_canonical_items: 0,
        },
        current_wfm_api_version: None,
        wfstat_stale: false,
    })
}

// ─── Read path ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemV2SetPart {
    pub item_key: String,
    pub slug: String,
    pub name_en: String,
    pub quantity_in_set: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemV2Lookup {
    pub item_key: String,
    pub slug: String,
    pub name_en: String,
    pub item_family: String,
    pub max_rank: Option<i64>,
    pub ducats: Option<i64>,
    pub bulk_tradable: bool,
    pub set_root: bool,
    pub icon: Option<String>,
    pub thumb: Option<String>,
    /// Which key resolved the query — surfaced so the caller (or a developer testing this) can
    /// tell a slug hit from a name hit apart, rather than treating "found" as one undifferentiated
    /// outcome.
    pub matched_kind: String,
    /// Populated only when `set_root` is true.
    pub set_parts: Vec<ItemV2SetPart>,
    pub wfstat_matched: bool,
    /// Ordered as WFM returns them; empty when the item carries none.
    pub subtypes: Vec<String>,
}

fn read_item_subtypes(connection: &Connection, item_key: &str) -> Result<Vec<String>> {
    let mut statement = connection
        .prepare("SELECT subtype FROM item_subtypes WHERE item_key = ?1 ORDER BY ord")?;
    let rows = statement
        .query_map(params![item_key], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Resolves one query string against the lookup table, trying kinds most-specific first.
///
/// Each `(lookup_key, kind)` pair is guaranteed unique by construction (see `build_item_lookup`
/// — an ambiguous key is never inserted at all), so every step here either returns exactly one
/// row or none; there is no `LIMIT 1` making an arbitrary choice anywhere in this path. Trying
/// slug before name (rather than searching all kinds at once and picking one) is what makes the
/// overall result deterministic when a query string happens to be valid under more than one kind.
pub(crate) fn lookup_item_v2_inner(
    connection: &Connection,
    query: &str,
) -> Result<Option<ItemV2Lookup>> {
    let folded = fold(query);
    if folded.is_empty() {
        return Ok(None);
    }

    const KIND_PRIORITY: &[LookupKind] = &[
        LookupKind::Slug,
        LookupKind::GameRef,
        LookupKind::GameRefLeaf,
        LookupKind::Name,
    ];

    let mut resolved: Option<(String, LookupKind)> = None;
    for kind in KIND_PRIORITY {
        let item_key: Option<String> = connection
            .query_row(
                "SELECT item_key FROM item_lookup WHERE lookup_key = ?1 AND kind = ?2",
                params![folded, lookup_kind_label(*kind)],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(item_key) = item_key {
            resolved = Some((item_key, *kind));
            break;
        }
    }
    let Some((item_key, matched_kind)) = resolved else {
        return Ok(None);
    };

    let (slug, name_en, item_family, max_rank, ducats, bulk_tradable, set_root, icon, thumb): (
        String,
        String,
        String,
        Option<i64>,
        Option<i64>,
        i64,
        i64,
        Option<String>,
        Option<String>,
    ) = connection.query_row(
        "SELECT slug, name_en, item_family, max_rank, ducats, bulk_tradable, set_root, icon, thumb
         FROM items WHERE item_key = ?1",
        params![item_key],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        },
    )?;

    let set_parts = if set_root != 0 {
        let mut statement = connection.prepare(
            "SELECT p.item_key, p.slug, p.name_en, sp.quantity_in_set
             FROM set_parts sp JOIN items p ON p.item_key = sp.part_key
             WHERE sp.set_key = ?1
             ORDER BY p.name_en",
        )?;
        let rows = statement
            .query_map(params![item_key], |row| {
                Ok(ItemV2SetPart {
                    item_key: row.get(0)?,
                    slug: row.get(1)?,
                    name_en: row.get(2)?,
                    quantity_in_set: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    } else {
        Vec::new()
    };

    let wfstat_matched: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM wfstat_matches WHERE item_key = ?1)",
        params![item_key],
        |row| row.get(0),
    )?;

    let subtypes = read_item_subtypes(connection, &item_key)?;

    Ok(Some(ItemV2Lookup {
        item_key,
        slug,
        name_en,
        item_family,
        max_rank,
        ducats,
        bulk_tradable: bulk_tradable != 0,
        set_root: set_root != 0,
        icon,
        thumb,
        matched_kind: lookup_kind_label(matched_kind).to_string(),
        set_parts,
        wfstat_matched: wfstat_matched != 0,
        subtypes,
    }))
}

/// `Ok(None)` distinguishes two states the frontend must not conflate: the catalog isn't built
/// yet (so absence proves nothing), versus a real lookup that found no match. This makes that
/// state explicit rather than making the caller guess from an empty result which one occurred.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ItemV2LookupResult {
    NotReady,
    NotFound,
    Found { item: ItemV2Lookup },
}

#[tauri::command]
pub fn lookup_item_v2(app: tauri::AppHandle, query: String) -> Result<ItemV2LookupResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let db_path = app_data_dir.join(CATALOG_V2_DATABASE_FILE);
    if !db_path.exists() {
        return Ok(ItemV2LookupResult::NotReady);
    }
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    match lookup_item_v2_inner(&connection, &query).map_err(|error| error.to_string())? {
        Some(item) => Ok(ItemV2LookupResult::Found { item }),
        None => Ok(ItemV2LookupResult::NotFound),
    }
}

/// The v2 catalog's file path — used by other modules (Market Observatory's migration) that
/// need to read it directly rather than through a command. `None` isn't possible here (path
/// resolution failure is the same class of error as every other app-data-dir lookup), so this
/// returns the same `Result` shape the rest of the app uses for that.
pub(crate) fn catalog_v2_database_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve the app data directory")?;
    Ok(app_data_dir.join(CATALOG_V2_DATABASE_FILE))
}

/// Opens the v2 catalog read-only. Shared by every read-side caller outside this module
/// (`commands/mod.rs`, `market_observatory.rs`, `trades.rs`) instead of each hand-rolling the
/// same `OpenFlags` — mirrors the old catalog's single `open_catalog_database` helper.
pub(crate) fn open_catalog_v2_readonly(app: &tauri::AppHandle) -> Result<Connection> {
    let db_path = catalog_v2_database_path(app)?;
    Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("failed to open {}", db_path.display()))
}

/// One item's localized name/icon/thumb plus the fields autocomplete needs — the v2 replacement
/// for the old catalog's `wfm_items` + `wfm_item_i18n` join. `lang_code` "en" is a harmless
/// no-op (falls back to `items.name_en`), same contract as the old query.
#[derive(Debug, Clone)]
pub(crate) struct AutocompleteItemRow {
    pub item_key: String,
    pub name: String,
    pub name_en: String,
    pub slug: String,
    pub max_rank: Option<i64>,
    pub item_family: String,
    pub image_path: Option<String>,
    pub bulk_tradable: bool,
}

pub(crate) fn load_autocomplete_items_v2(
    connection: &Connection,
    lang_code: &str,
) -> Result<Vec<AutocompleteItemRow>> {
    let mut statement = connection.prepare(
        "SELECT
            items.item_key,
            COALESCE(NULLIF(i18n.name, ''), items.name_en) AS name,
            items.name_en,
            items.slug,
            items.max_rank,
            items.item_family,
            COALESCE(NULLIF(items.thumb, ''), NULLIF(items.icon, '')),
            items.bulk_tradable
         FROM items
         LEFT JOIN item_i18n i18n
           ON i18n.item_key = items.item_key AND i18n.lang_code = ?1
         ORDER BY name COLLATE NOCASE, items.slug COLLATE NOCASE",
    )?;
    let rows = statement.query_map(params![lang_code], |row| {
        Ok(AutocompleteItemRow {
            item_key: row.get(0)?,
            name: row.get(1)?,
            name_en: row.get(2)?,
            slug: row.get(3)?,
            max_rank: row.get(4)?,
            item_family: row.get(5)?,
            image_path: row.get(6)?,
            bulk_tradable: row.get::<_, i64>(7)? != 0,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to read v2 autocomplete items")
}

/// One relic tier's representative icon — the v2 replacement for the old catalog's
/// `item_family = 'relics'` window-function query. `item_family` is `"relic"` (singular) in v2's
/// classification, not `"relics"`.
#[derive(Debug, Clone)]
pub(crate) struct RelicTierIconRow {
    pub tier: String,
    pub image_path: String,
}

pub(crate) fn load_relic_tier_icons_v2(connection: &Connection) -> Result<Vec<RelicTierIconRow>> {
    let mut statement = connection.prepare(
        "WITH ranked AS (
            SELECT
              relic_tier,
              preferred_image,
              ROW_NUMBER() OVER (
                PARTITION BY relic_tier
                ORDER BY
                  CASE WHEN preferred_image = 'items/unknown.thumb.png' THEN 1 ELSE 0 END,
                  name_en ASC
              ) AS row_rank
            FROM items
            WHERE item_family = 'relic'
              AND relic_tier IS NOT NULL
              AND preferred_image IS NOT NULL
          )
          SELECT relic_tier, preferred_image
          FROM ranked
          WHERE row_rank = 1
          ORDER BY relic_tier COLLATE NOCASE",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(RelicTierIconRow {
            tier: row.get(0)?,
            image_path: row.get(1)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to read v2 relic tier icons")
}

/// Category + display image for one item — the v2 replacement for the old catalog's
/// `load_catalog_item_metadata` (`items` + `wfm_items` + `wfstat_items` join). Coalesces the
/// same way: WFStat's own category, then WFStat's type, then our tag-derived `item_family`.
#[derive(Debug, Clone)]
pub(crate) struct ItemMetadataRow {
    pub category: String,
    pub image_path: Option<String>,
}

pub(crate) fn load_item_metadata_v2(
    connection: &Connection,
    item_key: &str,
) -> Result<Option<ItemMetadataRow>> {
    connection
        .query_row(
            "SELECT
               COALESCE(
                 NULLIF(wfstat_matches.category, ''),
                 NULLIF(wfstat_matches.type, ''),
                 NULLIF(items.item_family, ''),
                 'Other'
               ) AS category,
               items.preferred_image
             FROM items
             LEFT JOIN wfstat_matches ON wfstat_matches.item_key = items.item_key
             WHERE items.item_key = ?1",
            params![item_key],
            |row| {
                Ok(ItemMetadataRow {
                    category: row.get(0)?,
                    image_path: row.get(1)?,
                })
            },
        )
        .optional()
        .context("failed to read v2 item metadata")
}

/// Every `slug -> item_key` pair in the v2 catalog. Used by the Market Observatory migration to
/// resolve preserved rows' identity — a plain map, not a live query per row, because the
/// migration runs once and the whole catalog easily fits in memory (a few thousand items).
///
/// Returns an empty map (not an error) when the v2 catalog doesn't exist yet — the caller
/// decides what that means for whatever it's doing; this function's job is only to read what's
/// there, honestly, including "nothing is there yet".
pub(crate) fn load_slug_to_item_key_map(
    app: &tauri::AppHandle,
) -> Result<HashMap<String, String>> {
    let db_path = catalog_v2_database_path(app)?;
    if !db_path.exists() {
        return Ok(HashMap::new());
    }
    let connection = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("failed to open {}", db_path.display()))?;
    let mut statement = connection
        .prepare("SELECT slug, item_key FROM items")
        .context("failed to prepare slug -> item_key read")?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .context("failed to read items for the slug -> item_key map")?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .context("failed to collect the slug -> item_key map")
}

/// Resolves many query strings against the v2 catalog in one connection, keyed by the exact
/// query string handed in (not by the resolved `item_key`) — this matches how callers like
/// `trades::load_portfolio_catalog_meta_map` already loop over a set of distinct slugs/aliases
/// and need to look each one back up by that same string. A query that doesn't resolve is simply
/// absent from the result map rather than erroring the whole batch, the same "not found is not a
/// failure" contract `lookup_item_v2_inner` already has for a single query.
/// A relic's refinement -> raw WFStat JSON pairs, read back for `market_observatory`'s relic ROI
/// scanner (`load_relic_reward_profiles`) — see `write_wfstat_relic_variants` for how this table
/// is populated. Empty for a non-relic or an unmatched relic, never an error.
pub(crate) fn load_relic_variant_raw_json(
    connection: &Connection,
    item_key: &str,
) -> Result<Vec<(String, String)>> {
    let mut statement = connection
        .prepare("SELECT refinement, raw_json FROM wfstat_relic_variants WHERE item_key = ?1")?;
    let rows = statement
        .query_map(params![item_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn lookup_items_v2_batch(
    connection: &Connection,
    queries: &[String],
) -> Result<HashMap<String, ItemV2Lookup>> {
    let mut results = HashMap::with_capacity(queries.len());
    for query in queries {
        if let Some(item) = lookup_item_v2_inner(connection, query)? {
            results.insert(query.clone(), item);
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Persistence tests ──────────────────────────────────────────────────────────────────

    fn open_test_db() -> Connection {
        Connection::open_in_memory().expect("in-memory sqlite opens")
    }

    // ─── Freshness-check tests ──────────────────────────────────────────────────────────────
    //
    // These matter more than usual: get the freshness check wrong in one direction and every
    // launch pays the full multi-minute rebuild cost forever; get it wrong in the other and the
    // catalog silently never updates. Both are real regressions the boot sequence would hide.

    #[test]
    fn rebuild_decision_covers_every_case() {
        const V: Option<&str> = Some(CATALOG_V2_SCHEMA_VERSION);

        // No file at all: nothing to reuse, must build regardless of hash state.
        assert!(catalog_v2_needs_rebuild(false, Some("a"), None, V));
        assert!(catalog_v2_needs_rebuild(false, None, None, V));

        // File exists, WFM reachable, hash changed: WFM's own item collection actually moved.
        assert!(catalog_v2_needs_rebuild(true, Some("new"), Some("old"), V));
        // File exists, WFM reachable, hash unchanged: nothing to do.
        assert!(!catalog_v2_needs_rebuild(true, Some("same"), Some("same"), V));
        // File exists, WFM unreachable: can't confirm either way — keep what we have rather than
        // force a rebuild we can't complete.
        assert!(!catalog_v2_needs_rebuild(true, None, Some("old"), V));
        assert!(!catalog_v2_needs_rebuild(true, None, None, V));
        // File exists but predates this check (no recorded hash) even though WFM IS reachable:
        // rebuild once to backfill it, so every launch after this one can fast-skip correctly.
        assert!(catalog_v2_needs_rebuild(true, Some("new"), None, V));

        // Schema version mismatch always forces a rebuild, even when the hash matches and even
        // when WFM is unreachable — this is exactly the bug this check exists to catch (an
        // on-disk file from before a schema change gets reused forever otherwise).
        assert!(catalog_v2_needs_rebuild(
            true,
            Some("same"),
            Some("same"),
            Some("0")
        ));
        assert!(catalog_v2_needs_rebuild(true, None, Some("old"), Some("0")));
        assert!(catalog_v2_needs_rebuild(true, None, Some("old"), None));
    }

    #[test]
    fn missing_file_has_no_stored_hash() {
        let path = std::env::temp_dir().join("warstonks_test_missing_catalog_v2.sqlite");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_stored_collection_hash(&path), None);
    }

    #[test]
    fn a_built_catalog_stores_and_returns_its_collection_hash() {
        let path = std::env::temp_dir().join(format!(
            "warstonks_test_catalog_v2_hash_{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let connection = Connection::open(&path).unwrap();
            let wfm = bulk_json(&[("a", "s", None, &["misc"], "n")]);
            build_and_write_catalog(&connection, &wfm, &HashMap::new(), "[]").unwrap();
            write_catalog_meta(&connection, "collection_hash", "abc123").unwrap();
        }
        assert_eq!(
            read_stored_collection_hash(&path),
            Some("abc123".to_string())
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_catalog_built_before_this_check_existed_has_no_stored_hash() {
        // Simulates an on-disk file from before `collection_hash` was ever written — must
        // report "unknown", not panic and not crash the freshness decision.
        let path = std::env::temp_dir().join(format!(
            "warstonks_test_catalog_v2_no_hash_{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let connection = Connection::open(&path).unwrap();
            let wfm = bulk_json(&[("a", "s", None, &["misc"], "n")]);
            build_and_write_catalog(&connection, &wfm, &HashMap::new(), "[]").unwrap();
            // Deliberately no write_catalog_meta call.
        }
        assert_eq!(read_stored_collection_hash(&path), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn wfstat_being_unreachable_does_not_prevent_a_full_working_catalog() {
        // The central resilience guarantee: an empty WFStat response (what a real failure
        // degrades to — see `build_catalog_v2`) must still leave every item, its identity, and
        // its set structure fully intact and queryable. Only enrichment matching is absent.
        let wfm = bulk_json(&[
            ("root", "mesa_prime_set", Some("/Lotus/Powersuits/Cowgirl/MesaPrime"), &["set", "warframe"], "Mesa Prime Set"),
            ("bp", "mesa_prime_blueprint", Some("/Lotus/Types/Recipes/WarframeRecipes/MesaPrimeBlueprint"), &["blueprint", "warframe"], "Mesa Prime Blueprint"),
        ]);
        let mut details = HashMap::new();
        details.insert(
            "root".to_string(),
            serde_json::json!({"data": {"setRoot": true, "setParts": ["root", "bp"]}}).to_string(),
        );

        let connection = open_test_db();
        let summary = build_and_write_catalog(&connection, &wfm, &details, "[]").unwrap();
        assert_eq!(summary.item_count, 2);
        assert_eq!(summary.set_part_count, 1);
        assert_eq!(summary.wfstat_tier_counts, (0, 0, 0, 0, 0));
        assert_eq!(summary.wfstat_unmatched_count, 2);

        // The lookup path — what a real command call does — must still fully resolve the item.
        let found = lookup_item_v2_inner(&connection, "mesa prime set").unwrap().unwrap();
        assert!(found.set_root);
        assert!(!found.wfstat_matched);
        assert_eq!(found.set_parts.len(), 1);
    }

    #[test]
    fn lookup_resolves_by_every_kind_deterministically() {
        let wfm = bulk_json(&[(
            "a",
            "mesa_prime_set",
            Some("/Lotus/Powersuits/Cowgirl/MesaPrime"),
            &["set"],
            "Mesa Prime Set",
        )]);
        let connection = open_test_db();
        build_and_write_catalog(&connection, &wfm, &HashMap::new(), "[]").unwrap();

        for query in [
            "mesa_prime_set",                                  // slug
            "/Lotus/Powersuits/Cowgirl/MesaPrime",             // game_ref
            "MesaPrime",                                       // game_ref leaf
            "Mesa Prime Set",                                  // name
            "  MESA prime SET  ",                              // case/whitespace tolerant
        ] {
            let found = lookup_item_v2_inner(&connection, query)
                .unwrap()
                .unwrap_or_else(|| panic!("query {query:?} should resolve"));
            assert_eq!(found.item_key, "a");
        }
    }

    #[test]
    fn lookup_returns_none_for_an_empty_or_unknown_query() {
        let connection = open_test_db();
        initialize_schema(&connection).unwrap();
        assert!(lookup_item_v2_inner(&connection, "").unwrap().is_none());
        assert!(lookup_item_v2_inner(&connection, "   ").unwrap().is_none());
        assert!(lookup_item_v2_inner(&connection, "nothing_like_this_exists").unwrap().is_none());
    }

    #[test]
    fn lookup_never_returns_an_item_whose_key_was_rejected_as_ambiguous() {
        let wfm = bulk_json(&[
            ("a", "item_a", None, &["misc"], "Same Name"),
            ("b", "item_b", None, &["misc"], "Same Name"),
        ]);
        let connection = open_test_db();
        build_and_write_catalog(&connection, &wfm, &HashMap::new(), "[]").unwrap();

        // The ambiguous name must resolve to nothing — not "a", not "b", not a guess.
        assert!(lookup_item_v2_inner(&connection, "Same Name").unwrap().is_none());
        // Each item's own unambiguous slug still works.
        assert_eq!(
            lookup_item_v2_inner(&connection, "item_a").unwrap().unwrap().item_key,
            "a"
        );
    }

    #[test]
    fn a_full_build_persists_and_is_queryable_exactly_like_the_app_would_read_it() {
        let wfm = bulk_json(&[
            ("root", "mesa_prime_set", Some("/Lotus/Powersuits/Cowgirl/MesaPrime"), &["set", "warframe"], "Mesa Prime Set"),
            ("bp", "mesa_prime_blueprint", Some("/Lotus/Types/Recipes/WarframeRecipes/MesaPrimeBlueprint"), &["blueprint", "warframe"], "Mesa Prime Blueprint"),
        ]);
        let mut details = HashMap::new();
        details.insert(
            "root".to_string(),
            serde_json::json!({"data": {"setRoot": true, "setParts": ["root", "bp"]}}).to_string(),
        );
        let wfstat = wfstat_json(&[serde_json::json!({
            "uniqueName": "/Lotus/Powersuits/Cowgirl/MesaPrime",
            "name": "Mesa Prime",
            "components": [{"name": "Blueprint", "uniqueName": "/Lotus/.../MesaPrimeBpComponent"}],
        })]);

        let connection = open_test_db();
        let summary = build_and_write_catalog(&connection, &wfm, &details, &wfstat).unwrap();
        assert_eq!(summary.item_count, 2);
        assert_eq!(summary.set_root_count, 1);
        assert_eq!(summary.set_part_count, 1);
        assert_eq!(summary.rejected_key_count, 0);

        // Read it back with plain SQL, the way any real caller (or the developer testing this
        // by hand with the sqlite3 CLI) would.
        let resolved_item_key: String = connection
            .query_row(
                "SELECT item_key FROM item_lookup WHERE lookup_key = ?1 AND kind = 'name'",
                params!["mesa prime blueprint"],
                |row| row.get(0),
            )
            .expect("blueprint resolves by name");
        assert_eq!(resolved_item_key, "bp");

        let set_members: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT part_key FROM set_parts WHERE set_key = 'root'")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        assert_eq!(set_members, vec!["bp".to_string()]);

        let (tier,): (String,) = connection
            .query_row(
                "SELECT match_tier FROM wfstat_matches WHERE item_key = 'root'",
                [],
                |row| Ok((row.get(0)?,)),
            )
            .expect("root matched wfstat");
        assert_eq!(tier, "game_ref_exact");
    }

    // ─── Subtypes ───────────────────────────────────────────────────────────────────────────

    #[test]
    fn subtypes_are_parsed_from_the_bulk_response_and_preserve_order() {
        let json = serde_json::json!({
            "apiVersion": "0.25.0",
            "data": [{
                "id": "a", "slug": "s", "gameRef": null, "tags": ["misc"],
                "ducats": null, "maxRank": null, "bulkTradable": false,
                "i18n": { "en": { "name": "n" } },
                "subtypes": ["blueprint", "component", "radiant"],
            }],
            "error": null,
        })
        .to_string();
        let items = build_item_rows(&json).expect("parses");
        assert_eq!(
            items[0].subtypes,
            vec!["blueprint".to_string(), "component".to_string(), "radiant".to_string()]
        );
    }

    #[test]
    fn missing_subtypes_defaults_to_empty_not_an_error() {
        let json = bulk_json(&[("a", "s", None, &["misc"], "n")]);
        let items = build_item_rows(&json).expect("parses");
        assert!(items[0].subtypes.is_empty());
    }

    #[test]
    fn subtypes_round_trip_through_the_database() {
        let wfm = serde_json::json!({
            "apiVersion": "0.25.0",
            "data": [{
                "id": "a", "slug": "s", "gameRef": null, "tags": ["misc"],
                "ducats": null, "maxRank": null, "bulkTradable": false,
                "i18n": { "en": { "name": "n" } },
                "subtypes": ["radiant", "flawless"],
            }],
            "error": null,
        })
        .to_string();
        let connection = open_test_db();
        build_and_write_catalog(&connection, &wfm, &HashMap::new(), "[]").unwrap();
        let item = lookup_item_v2_inner(&connection, "s").unwrap().unwrap();
        assert_eq!(item.subtypes, vec!["radiant".to_string(), "flawless".to_string()]);
    }

    // ─── quantity_in_set ────────────────────────────────────────────────────────────────────

    #[test]
    fn quantity_in_set_is_read_from_the_components_own_detail_response() {
        let items_raw = bulk_json(&[
            ("root", "x_set", Some("/x"), &["set"], "X Set"),
            ("part", "x_part", Some("/x/part"), &["component"], "X Part"),
        ]);
        let mut items = build_item_rows(&items_raw).unwrap();
        let mut details = HashMap::new();
        details.insert(
            "root".to_string(),
            serde_json::json!({"data": {"setRoot": true, "setParts": ["root", "part"]}}).to_string(),
        );
        // quantityInSet lives on the COMPONENT's own detail response, not the root's.
        details.insert(
            "part".to_string(),
            serde_json::json!({"data": {"setRoot": false, "setParts": [], "quantityInSet": 3}})
                .to_string(),
        );
        let set_parts = apply_set_details(&mut items, &details).unwrap();
        let row = set_parts.iter().find(|row| row.part_key == "part").unwrap();
        assert_eq!(row.quantity_in_set, 3);
    }

    #[test]
    fn quantity_in_set_defaults_to_one_when_the_component_detail_is_missing() {
        let items_raw = bulk_json(&[
            ("root", "x_set", Some("/x"), &["set"], "X Set"),
            ("part", "x_part", Some("/x/part"), &["component"], "X Part"),
        ]);
        let mut items = build_item_rows(&items_raw).unwrap();
        let mut details = HashMap::new();
        // Only the root's detail was fetched — the component's own fetch failed or wasn't
        // reached — quantity must still default to 1, never left unset or erroring the build.
        details.insert(
            "root".to_string(),
            serde_json::json!({"data": {"setRoot": true, "setParts": ["root", "part"]}}).to_string(),
        );
        let set_parts = apply_set_details(&mut items, &details).unwrap();
        let row = set_parts.iter().find(|row| row.part_key == "part").unwrap();
        assert_eq!(row.quantity_in_set, 1);
    }

    #[test]
    fn quantity_in_set_round_trips_through_lookup() {
        let wfm = bulk_json(&[
            ("root", "x_set", Some("/x"), &["set"], "X Set"),
            ("part", "x_part", Some("/x/part"), &["component"], "X Part"),
        ]);
        let mut details = HashMap::new();
        details.insert(
            "root".to_string(),
            serde_json::json!({"data": {"setRoot": true, "setParts": ["root", "part"]}}).to_string(),
        );
        details.insert(
            "part".to_string(),
            serde_json::json!({"data": {"setRoot": false, "setParts": [], "quantityInSet": 5}})
                .to_string(),
        );
        let connection = open_test_db();
        build_and_write_catalog(&connection, &wfm, &details, "[]").unwrap();
        let root = lookup_item_v2_inner(&connection, "x_set").unwrap().unwrap();
        assert_eq!(root.set_parts.len(), 1);
        assert_eq!(root.set_parts[0].quantity_in_set, 5);
    }

    // ─── Batch lookup ───────────────────────────────────────────────────────────────────────

    #[test]
    fn batch_lookup_resolves_each_query_keyed_by_the_original_string_and_skips_misses() {
        let wfm = bulk_json(&[
            ("a", "item_a", None, &["misc"], "Item A"),
            ("b", "item_b", None, &["misc"], "Item B"),
        ]);
        let connection = open_test_db();
        build_and_write_catalog(&connection, &wfm, &HashMap::new(), "[]").unwrap();

        let queries = vec![
            "item_a".to_string(),
            "item_b".to_string(),
            "does_not_exist".to_string(),
        ];
        let results = lookup_items_v2_batch(&connection, &queries).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results.get("item_a").unwrap().item_key, "a");
        assert_eq!(results.get("item_b").unwrap().item_key, "b");
        assert!(!results.contains_key("does_not_exist"));
    }

    #[test]
    fn ambiguous_keys_are_persisted_for_inspection_not_silently_dropped() {
        let wfm = bulk_json(&[
            ("a", "item_a", None, &["misc"], "Same Name"),
            ("b", "item_b", None, &["misc"], "Same Name"),
        ]);
        let connection = open_test_db();
        let summary =
            build_and_write_catalog(&connection, &wfm, &HashMap::new(), &wfstat_json(&[])).unwrap();
        assert_eq!(summary.rejected_key_count, 1);

        let candidates_json: String = connection
            .query_row(
                "SELECT candidates_json FROM rejected_lookup_keys WHERE lookup_key = 'same name'",
                [],
                |row| row.get(0),
            )
            .expect("the ambiguous key was recorded");
        let candidates: Vec<String> = serde_json::from_str(&candidates_json).unwrap();
        assert_eq!(candidates, vec!["a".to_string(), "b".to_string()]);

        // And it must be genuinely absent from the resolvable table, not just flagged.
        let resolvable: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM item_lookup WHERE lookup_key = 'same name'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(resolvable, 0);
    }

    #[test]
    fn slugs_needing_set_detail_finds_only_set_tagged_items() {
        let wfm = bulk_json(&[
            ("a", "mesa_prime_set", None, &["set", "warframe"], "Mesa Prime Set"),
            ("b", "mesa_prime_blueprint", None, &["blueprint", "warframe"], "Mesa Prime Blueprint"),
        ]);
        let slugs = slugs_needing_set_detail(&wfm).unwrap();
        assert_eq!(slugs, vec!["mesa_prime_set".to_string()]);
    }

    // ─── Live end-to-end harness ────────────────────────────────────────────────────────────
    //
    // `#[ignore]`d: never runs in a normal `cargo test`, so CI and every other developer's test
    // run stay network-free. Run it explicitly to build a REAL, browsable SQLite file from live
    // WFM + WFStat data:
    //
    //   cd src-tauri
    //   WARSTONKS_CATALOG_V2_OUTPUT=/tmp/catalog_v2.sqlite \
    //     cargo test --lib build_real_catalog_v2_live -- --ignored --nocapture
    //
    // If WARSTONKS_CATALOG_V2_OUTPUT is unset it writes to
    // target/item_catalog_v2_live.sqlite instead. Takes roughly 1.5 minutes (the 230 per-item
    // setParts fetches at just under 3 req/s), then prints a full report and leaves the file on
    // disk — open it with `sqlite3 <path>` and query it directly; see the printed hints at the
    // end of the test for example queries.
    #[test]
    #[ignore = "hits live WFM/WFStat APIs and takes ~1.5 minutes; run explicitly, see comment"]
    fn build_real_catalog_v2_live() {
        // Calls the exact same `build_catalog_v2` the app's startup path calls — this test
        // exists to exercise production code against live data, not a parallel copy of it.
        let output_path_string = std::env::var("WARSTONKS_CATALOG_V2_OUTPUT")
            .unwrap_or_else(|_| "target/item_catalog_v2_live.sqlite".to_string());
        let output_path = Path::new(&output_path_string);
        let _ = std::fs::remove_file(output_path);

        println!("Building catalog v2 from live WFM + WFStat data (~1.5 minutes)...");
        let (summary, wfstat_fetch_error) = build_catalog_v2(output_path).expect("catalog build");
        if let Some(reason) = &wfstat_fetch_error {
            println!("WFStat fetch FAILED (catalog still built, zero enrichment): {reason}");
        }

        let (t1, t2, t3, t4, t5) = summary.wfstat_tier_counts;
        let total = summary.item_count;
        println!("\n─── Catalog v2 live build report ───");
        println!("output file:            {output_path_string}");
        println!("items:                  {total}");
        println!("set roots:              {}", summary.set_root_count);
        println!("set parts:              {}", summary.set_part_count);
        println!("lookup keys accepted:   {}", summary.lookup_key_count);
        println!("lookup keys REJECTED:   {}", summary.rejected_key_count);
        println!(
            "wfstat matched: tier1(marketInfo)={t1} tier2(gameRef)={t2} tier3(bounded-exact)={t3} tier4(bounded-by-name)={t4} tier5(global-exact)={t5}"
        );
        println!("wfstat unmatched:       {}", summary.wfstat_unmatched_count);
        println!(
            "wfstat coverage:        {:.1}%",
            (t1 + t2 + t3 + t4 + t5) as f64 / total as f64 * 100.0
        );

        // Sanity-check the read path against the file the build just produced — the same
        // `lookup_item_v2_inner` a real command call would use.
        let connection = Connection::open(output_path).expect("reopen output for read check");
        let mesa = lookup_item_v2_inner(&connection, "Mesa Prime Set")
            .expect("query runs")
            .expect("Mesa Prime Set resolves");
        println!(
            "\nread-path check: 'Mesa Prime Set' -> {} parts via matched_kind={}",
            mesa.set_parts.len(),
            mesa.matched_kind
        );
        assert!(mesa.set_root);
        assert_eq!(mesa.set_parts.len(), 4);

        println!("\nOpen it yourself:  sqlite3 {output_path_string}");
        println!("Example queries:");
        println!("  SELECT * FROM items WHERE slug = 'trumna_prime_receiver';");
        println!("  SELECT i.name_en, l.kind FROM item_lookup l JOIN items i ON i.item_key = l.item_key WHERE l.lookup_key = 'mesa prime';");
        println!("  SELECT * FROM rejected_lookup_keys LIMIT 20;");
        println!("  SELECT p.name_en FROM set_parts sp JOIN items p ON p.item_key = sp.part_key JOIN items s ON s.item_key = sp.set_key WHERE s.slug = 'mesa_prime_set';");
        println!("  SELECT match_tier, COUNT(*) FROM wfstat_matches GROUP BY match_tier;");
    }


    fn bulk_json(items: &[(&str, &str, Option<&str>, &[&str], &str)]) -> String {
        // (id, slug, gameRef, tags, english name)
        let entries: Vec<serde_json::Value> = items
            .iter()
            .map(|(id, slug, game_ref, tags, name)| {
                serde_json::json!({
                    "id": id,
                    "slug": slug,
                    "gameRef": game_ref,
                    "tags": tags,
                    "ducats": 45,
                    "maxRank": null,
                    "bulkTradable": false,
                    "i18n": { "en": { "name": name, "icon": "icon.png", "thumb": "thumb.png" } },
                })
            })
            .collect();
        serde_json::json!({ "apiVersion": "0.25.0", "data": entries, "error": null }).to_string()
    }

    #[test]
    fn builds_items_from_wfm_bulk_alone_no_wfstat_involved() {
        let json = bulk_json(&[(
            "5c182b739603780081b09a53",
            "mesa_prime_set",
            Some("/Lotus/Powersuits/Cowgirl/MesaPrime"),
            &["set", "prime", "warframe"],
            "Mesa Prime Set",
        )]);
        let items = build_item_rows(&json).expect("parses");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_key, "5c182b739603780081b09a53");
        assert_eq!(items[0].item_family, "set");
        assert_eq!(items[0].name_en, "Mesa Prime Set");
        // No WFStat request was made anywhere in this test — identity never depended on it.
    }

    #[test]
    fn missing_game_ref_does_not_fail_the_whole_build() {
        // 35 of 3,837 real WFM items have no gameRef (fusion cores, augment mods, keys). The
        // build must still succeed for them; only cross-referencing loses the exact-match path.
        let json = bulk_json(&[("id1", "ancient_fusion_core", None, &["fusion core"], "Ancient Fusion Core")]);
        let items = build_item_rows(&json).expect("parses");
        assert_eq!(items[0].game_ref, None);
    }

    #[test]
    fn set_parts_exclude_the_root_itself() {
        let mut items = build_item_rows(&bulk_json(&[(
            "root", "mesa_prime_set", Some("/x"), &["set"], "Mesa Prime Set",
        )]))
        .unwrap();
        let mut details = HashMap::new();
        details.insert(
            "root".to_string(),
            serde_json::json!({
                "data": {
                    "id": "root",
                    "setRoot": true,
                    // WFM lists the set's own id among setParts; that must not become a
                    // self-referential "component".
                    "setParts": ["root", "part-a", "part-b"]
                }
            })
            .to_string(),
        );
        let set_parts = apply_set_details(&mut items, &details).unwrap();
        assert!(items[0].set_root);
        let part_keys: HashSet<_> = set_parts.iter().map(|row| row.part_key.as_str()).collect();
        assert_eq!(part_keys, HashSet::from(["part-a", "part-b"]));
        assert!(set_parts.iter().all(|row| row.set_key == "root"));
    }

    #[test]
    fn ambiguous_lookup_keys_are_rejected_not_guessed() {
        // The exact failure mode that made the old catalog non-deterministic: two different
        // items whose English name happens to collide.
        let items = vec![
            ItemRow {
                item_key: "a".into(), slug: "item_a".into(), game_ref: None,
                name_en: "Blueprint".into(), item_family: "blueprint".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
            ItemRow {
                item_key: "b".into(), slug: "item_b".into(), game_ref: None,
                name_en: "Blueprint".into(), item_family: "blueprint".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
        ];
        let (accepted, rejected) = build_item_lookup(&items, &HashMap::new());

        // The ambiguous name must not appear as a resolvable key at all.
        assert!(!accepted.iter().any(|row| row.lookup_key == "blueprint"));
        let rejected_names = rejected.iter().find(|r| r.lookup_key == "blueprint").unwrap();
        assert_eq!(rejected_names.candidates, vec!["a".to_string(), "b".to_string()]);

        // Each item's own slug is still uniquely resolvable — ambiguity in one key must not
        // poison an unrelated one.
        assert!(accepted.iter().any(|row| row.lookup_key == "item_a" && row.item_key == "a"));
        assert!(accepted.iter().any(|row| row.lookup_key == "item_b" && row.item_key == "b"));
    }

    #[test]
    fn game_ref_leaf_is_a_separate_resolvable_key() {
        // AlecaFrame sometimes reports the bare leaf instead of the full path — both forms must
        // resolve to the same item.
        let items = vec![ItemRow {
            item_key: "a".into(), slug: "s".into(),
            game_ref: Some("/Lotus/Types/Recipes/Weapons/WeaponParts/PrimeDualKamasBlade".into()),
            name_en: "Dual Kamas Prime Blade".into(), item_family: "component".into(),
            max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
            icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
        }];
        let (accepted, rejected) = build_item_lookup(&items, &HashMap::new());
        assert!(rejected.is_empty());
        assert!(accepted
            .iter()
            .any(|row| row.lookup_key == "primedualkamasblade" && row.kind == LookupKind::GameRefLeaf));
        assert!(accepted
            .iter()
            .any(|row| row.kind == LookupKind::GameRef && row.item_key == "a"));
    }

    #[test]
    fn wfstat_unique_name_resolves_when_it_diverges_from_wfm_game_ref() {
        // Confirmed live: WFM's own gameRef for Yareli Prime's Systems part is
        // `.../YareliPrimeSystemsBlueprint`, but the game's true internal class name — which
        // WFStat's `uniqueName` carries and AlecaFrame reports verbatim in trade history — is
        // `.../YareliPrimeSystemsComponent`. Without folding WFStat's uniqueName into the same
        // GameRef/GameRefLeaf buckets, AlecaFrame trade names for items like this can never
        // resolve, even though the mapping is fully deterministic (not a guess).
        let items = vec![ItemRow {
            item_key: "a".into(), slug: "yareli_prime_systems_blueprint".into(),
            game_ref: Some(
                "/Lotus/Types/Recipes/WarframeRecipes/YareliPrimeSystemsBlueprint".into(),
            ),
            name_en: "Yareli Prime Systems Blueprint".into(), item_family: "blueprint".into(),
            max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
            icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
        }];
        let mut wfstat_matches = HashMap::new();
        wfstat_matches.insert(
            "a".to_string(),
            (
                "/Lotus/Types/Recipes/WarframeRecipes/YareliPrimeSystemsComponent".to_string(),
                WfstatMatchTier::GameRefExact,
            ),
        );

        let (accepted, rejected) = build_item_lookup(&items, &wfstat_matches);
        assert!(rejected.is_empty());
        // The AlecaFrame-shaped leaf (WFStat's diverging uniqueName) also resolves, to the same item.
        assert!(accepted.iter().any(|row| row.kind == LookupKind::GameRefLeaf
            && row.lookup_key == fold("YareliPrimeSystemsComponent")
            && row.item_key == "a"));
        assert!(accepted.iter().any(|row| row.kind == LookupKind::GameRef
            && row.lookup_key == fold("/Lotus/Types/Recipes/WarframeRecipes/YareliPrimeSystemsComponent")
            && row.item_key == "a"));
        // The original WFM gameRef leaf must still resolve too — this is additive, not a replacement.
        assert!(accepted.iter().any(|row| row.kind == LookupKind::GameRefLeaf
            && row.lookup_key == fold("YareliPrimeSystemsBlueprint")
            && row.item_key == "a"));
    }

    fn wfstat_json(items: &[serde_json::Value]) -> String {
        serde_json::json!(items).to_string()
    }

    #[test]
    fn tier1_market_info_id_is_authoritative_and_deterministic_for_relic_families() {
        // Real shape: one WFM tradeable relic id, four WFStat refinement-tier records all
        // pointing at it via marketInfo.id. Confirmed live for 772 of 3,837 WFM items.
        let items = vec![ItemRow {
            item_key: "wfm-relic".into(), slug: "axi_a1_relic".into(), game_ref: None,
            name_en: "Axi A1 Relic".into(), item_family: "relic".into(),
            max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
            icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
        }];
        let wfstat = wfstat_json(&[
            serde_json::json!({"uniqueName": "/Lotus/.../AxiA1RelicBronze", "name": "Axi A1 (Bronze)", "marketInfo": {"id": "wfm-relic"}}),
            serde_json::json!({"uniqueName": "/Lotus/.../AxiA1RelicGold", "name": "Axi A1 (Gold)", "marketInfo": {"id": "wfm-relic"}}),
        ]);
        let report = build_wfstat_matches(&items, &wfstat, &[]).unwrap();
        let (matched_name, tier) = report.matches.get("wfm-relic").unwrap();
        assert_eq!(tier, &WfstatMatchTier::MarketInfoId);
        // Deterministic pick, not "whichever the map iterates first".
        assert_eq!(matched_name, "/Lotus/.../AxiA1RelicBronze");
    }

    #[test]
    fn tier2_exact_game_ref_match() {
        let items = vec![ItemRow {
            item_key: "a".into(), slug: "s".into(),
            game_ref: Some("/Lotus/Types/Recipes/WarframeRecipes/MesaPrimeBlueprint".into()),
            name_en: "n".into(), item_family: "blueprint".into(),
            max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
            icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
        }];
        let wfstat = wfstat_json(&[serde_json::json!({
            "uniqueName": "/Lotus/Types/Recipes/WarframeRecipes/MesaPrimeBlueprint",
            "name": "Blueprint",
        })]);
        let report = build_wfstat_matches(&items, &wfstat, &[]).unwrap();
        assert_eq!(
            report.matches.get("a").unwrap().1,
            WfstatMatchTier::GameRefExact
        );
    }

    #[test]
    fn tier3_resolves_the_real_zephyr_chassis_suffix_mismatch() {
        // The exact live case from Phase 0: WFM's gameRef for this component ends in
        // "...ChassisBlueprint"; WFStat's component list under the matched parent calls the
        // same real-world part "...ChassisComponent". No exact-string tier can bridge that —
        // only the bounded, name-scoped tier 3 can, and only within the correct parent.
        let items = vec![
            ItemRow {
                item_key: "root".into(), slug: "zephyr_prime_set".into(),
                game_ref: Some("/Lotus/Powersuits/Zephyr/ZephyrPrime".into()),
                name_en: "Zephyr Prime Set".into(), item_family: "set".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: true,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
            ItemRow {
                item_key: "chassis".into(), slug: "zephyr_prime_chassis_blueprint".into(),
                game_ref: Some(
                    "/Lotus/Types/Recipes/WarframeRecipes/ZephyrPrimeChassisBlueprint".into(),
                ),
                name_en: "Zephyr Prime Chassis Blueprint".into(), item_family: "blueprint".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
        ];
        let set_parts = vec![SetPartRow { set_key: "root".into(), part_key: "chassis".into(), quantity_in_set: 1 }];
        let wfstat = wfstat_json(&[serde_json::json!({
            "uniqueName": "/Lotus/Powersuits/Zephyr/ZephyrPrime",
            "name": "Zephyr Prime",
            "components": [
                {"name": "Blueprint", "uniqueName": "/Lotus/.../ZephyrPrimeBlueprint"},
                {"name": "Chassis", "uniqueName": "/Lotus/.../ZephyrPrimeChassisComponent"},
                {"name": "Neuroptics", "uniqueName": "/Lotus/.../ZephyrPrimeHelmetComponent"},
                {"name": "Systems", "uniqueName": "/Lotus/.../ZephyrPrimeSystemsComponent"},
            ],
        })]);

        let report = build_wfstat_matches(&items, &wfstat, &set_parts).unwrap();
        assert_eq!(
            report.matches.get("root").unwrap().1,
            WfstatMatchTier::GameRefExact
        );
        let (chassis_match, chassis_tier) = report.matches.get("chassis").unwrap();
        assert_eq!(chassis_tier, &WfstatMatchTier::BoundedComponentByName);
        assert_eq!(chassis_match, "/Lotus/.../ZephyrPrimeChassisComponent");
    }

    #[test]
    fn bounded_exact_identifier_wins_over_word_matching_and_handles_swapped_names() {
        // The real live case: WFStat's own component named "Limbs" stores the identifier
        // `ArchRocketCrossbowStock`, and its component named "Stock" stores
        // `ArchRocketCrossbowReceiver` — the words are swapped relative to what a naive
        // word-based match would expect. Only exact identifier equality gets both right; a
        // word list can't, because "stock" would incorrectly point at the wrong component.
        let items = vec![
            ItemRow {
                item_key: "root".into(), slug: "fluctus_set".into(),
                game_ref: Some("/Lotus/Powersuits/Archwing/Fluctus".into()),
                name_en: "Fluctus Set".into(), item_family: "set".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: true,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
            ItemRow {
                item_key: "limbs".into(), slug: "fluctus_limbs".into(),
                game_ref: Some(
                    "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchRocketCrossbowStock".into(),
                ),
                name_en: "Fluctus Limbs".into(), item_family: "component".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
            ItemRow {
                item_key: "stock".into(), slug: "fluctus_stock".into(),
                game_ref: Some(
                    "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchRocketCrossbowReceiver".into(),
                ),
                name_en: "Fluctus Stock".into(), item_family: "component".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
        ];
        let set_parts = vec![
            SetPartRow { set_key: "root".into(), part_key: "limbs".into(), quantity_in_set: 1 },
            SetPartRow { set_key: "root".into(), part_key: "stock".into(), quantity_in_set: 1 },
        ];
        // Identifiers must match EXACTLY between the two sides for this tier — that is the
        // entire point of it — so the fixture uses the same real paths as the items above.
        let wfstat = wfstat_json(&[serde_json::json!({
            "uniqueName": "/Lotus/Powersuits/Archwing/Fluctus",
            "name": "Fluctus",
            "components": [
                {"name": "Limbs", "uniqueName": "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchRocketCrossbowStock"},
                {"name": "Stock", "uniqueName": "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchRocketCrossbowReceiver"},
            ],
        })]);

        let report = build_wfstat_matches(&items, &wfstat, &set_parts).unwrap();
        let (limbs_match, limbs_tier) = report.matches.get("limbs").unwrap();
        let (stock_match, stock_tier) = report.matches.get("stock").unwrap();
        assert_eq!(limbs_tier, &WfstatMatchTier::BoundedComponentExact);
        assert_eq!(limbs_match, "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchRocketCrossbowStock");
        assert_eq!(stock_tier, &WfstatMatchTier::BoundedComponentExact);
        assert_eq!(stock_match, "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchRocketCrossbowReceiver");
    }

    #[test]
    fn tier3_leaves_a_component_unresolved_rather_than_guessing() {
        // The root matched, but its component list has no name matching this part's word — the
        // component must stay unmatched (meaning: no bonus stats), not attach to something else.
        let items = vec![
            ItemRow {
                item_key: "root".into(), slug: "x_set".into(), game_ref: Some("/x".into()),
                name_en: "X Set".into(), item_family: "set".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: true,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
            ItemRow {
                item_key: "part".into(), slug: "x_barrel".into(), game_ref: None,
                name_en: "X Barrel".into(), item_family: "component".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
            },
        ];
        let set_parts = vec![SetPartRow { set_key: "root".into(), part_key: "part".into(), quantity_in_set: 1 }];
        let wfstat = wfstat_json(&[serde_json::json!({
            "uniqueName": "/x", "name": "X",
            "components": [{"name": "Blueprint", "uniqueName": "/x/Blueprint"}],
        })]);
        let report = build_wfstat_matches(&items, &wfstat, &set_parts).unwrap();
        assert!(!report.matches.contains_key("part"));
        assert!(report.unmatched.contains(&"part".to_string()));
    }

    #[test]
    fn global_tier_resolves_a_blueprint_with_no_wfm_set_at_all() {
        // The real live case: Quellor's Blueprint has no WFM `setParts` group linking it to
        // anything (it's a single-piece weapon, not a multi-part Prime-style set) — so there is
        // no known parent to bound tier 3/4 against. WFStat DOES list this exact identifier as
        // a component of exactly one parent ("Quellor" itself), which is what makes the global
        // exact-identifier tier both necessary and safe here.
        let items = vec![ItemRow {
            item_key: "bp".into(), slug: "quellor_blueprint".into(),
            game_ref: Some("/Lotus/Types/Recipes/Weapons/RailjackRifleGunBlueprint".into()),
            name_en: "Quellor Blueprint".into(), item_family: "blueprint".into(),
            max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
            icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
        }];
        let wfstat = wfstat_json(&[serde_json::json!({
            "uniqueName": "/Lotus/Weapons/Tenno/LongGuns/TnRailjackRifle/RailjackRifleGun",
            "name": "Quellor",
            "components": [
                {"name": "Alloy Plate", "uniqueName": "/Lotus/Types/Items/MiscItems/AlloyPlate"},
                {"name": "Blueprint", "uniqueName": "/Lotus/Types/Recipes/Weapons/RailjackRifleGunBlueprint"},
            ],
        })]);

        // No set_parts at all — this item is reachable ONLY through the global tier.
        let report = build_wfstat_matches(&items, &wfstat, &[]).unwrap();
        let (matched, tier) = report.matches.get("bp").unwrap();
        assert_eq!(tier, &WfstatMatchTier::GlobalComponentExact);
        assert_eq!(matched, "/Lotus/Types/Recipes/Weapons/RailjackRifleGunBlueprint");
    }

    #[test]
    fn global_tier_refuses_an_identifier_claimed_by_more_than_one_parent() {
        // A raw resource genuinely shared by many different weapons/warframes (Orokin Cell,
        // Circuits, ...) must never be guessed at — it has no single owner to attribute to.
        let items = vec![ItemRow {
            item_key: "shared".into(), slug: "shared_resource".into(),
            game_ref: Some("/Lotus/Types/Items/MiscItems/SharedThing".into()),
            name_en: "Shared Thing".into(), item_family: "misc".into(),
            max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
            icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
        }];
        let wfstat = wfstat_json(&[
            serde_json::json!({
                "uniqueName": "/parent/a", "name": "Parent A",
                "components": [{"name": "Shared", "uniqueName": "/Lotus/Types/Items/MiscItems/SharedThing"}],
            }),
            serde_json::json!({
                "uniqueName": "/parent/b", "name": "Parent B",
                "components": [{"name": "Shared", "uniqueName": "/Lotus/Types/Items/MiscItems/SharedThing"}],
            }),
        ]);
        let report = build_wfstat_matches(&items, &wfstat, &[]).unwrap();
        assert!(!report.matches.contains_key("shared"));
        assert!(report.unmatched.contains(&"shared".to_string()));
    }

    #[test]
    fn an_item_with_no_wfstat_match_at_all_is_reported_not_fatal() {
        let items = vec![ItemRow {
            item_key: "lonely".into(), slug: "s".into(), game_ref: Some("/nowhere".into()),
            name_en: "n".into(), item_family: "misc".into(),
            max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
            icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
        }];
        let report = build_wfstat_matches(&items, &wfstat_json(&[]), &[]).unwrap();
        assert!(report.matches.is_empty());
        assert_eq!(report.unmatched, vec!["lonely".to_string()]);
        assert_eq!(report.tier_counts(), (0, 0, 0, 0, 0));
    }

    #[test]
    fn classify_item_family_prefers_the_most_specific_tag() {
        assert_eq!(
            classify_item_family(&["component".into(), "prime".into(), "weapon".into()]),
            "component"
        );
        assert_eq!(classify_item_family(&["relic".into()]), "relic");
        assert_eq!(classify_item_family(&["unknown_tag".into()]), "misc");
    }

    #[test]
    fn relic_tier_is_derived_from_the_english_name_first_word_relics_only() {
        let json = bulk_json(&[
            (
                "relic-1",
                "axi_a1_relic",
                None,
                &["relic"],
                "Axi A1 Relic",
            ),
            (
                "warframe-1",
                "mesa_prime",
                None,
                &["prime", "warframe"],
                "Mesa Prime",
            ),
        ]);
        let items = build_item_rows(&json).expect("parses");
        assert_eq!(items[0].relic_tier.as_deref(), Some("Axi"));
        // Never derived for a non-relic, even one whose name also starts with a word.
        assert_eq!(items[1].relic_tier, None);
    }

    #[test]
    fn preferred_image_falls_back_from_thumb_to_icon() {
        let json = bulk_json(&[(
            "item-1",
            "mesa_prime",
            None,
            &["warframe"],
            "Mesa Prime",
        )]);
        let items = build_item_rows(&json).expect("parses");
        // The shared bulk_json() test fixture sets both icon and thumb; thumb wins.
        assert_eq!(items[0].preferred_image.as_deref(), Some("thumb.png"));
    }

    #[test]
    fn build_item_i18n_rows_captures_every_locale_not_just_english() {
        let entries = serde_json::json!([{
            "id": "item-1",
            "slug": "mesa_prime",
            "gameRef": null,
            "tags": ["warframe"],
            "ducats": 45,
            "maxRank": null,
            "bulkTradable": false,
            "i18n": {
                "en": {"name": "Mesa Prime", "icon": "en-icon.png", "thumb": "en-thumb.png"},
                "de": {"name": "Mesa Prime DE", "icon": "de-icon.png", "thumb": "de-thumb.png"},
            },
        }]);
        let json = serde_json::json!({ "apiVersion": "0.25.0", "data": entries, "error": null })
            .to_string();
        let rows = build_item_i18n_rows(&json).expect("parses");
        assert_eq!(rows.len(), 2);
        let de_row = rows.iter().find(|row| row.lang_code == "de").expect("de present");
        assert_eq!(de_row.name.as_deref(), Some("Mesa Prime DE"));
        assert_eq!(de_row.item_key, "item-1");
        let en_row = rows.iter().find(|row| row.lang_code == "en").expect("en present");
        assert_eq!(en_row.name.as_deref(), Some("Mesa Prime"));
    }

    #[test]
    fn build_wfstat_category_map_reads_category_and_type_by_unique_name() {
        let wfstat = wfstat_json(&[serde_json::json!({
            "uniqueName": "/Lotus/Powersuits/Cowgirl/MesaPrime",
            "name": "Mesa Prime",
            "category": "Warframes",
            "type": "Warframe",
        })]);
        let map = build_wfstat_category_map(&wfstat).expect("parses");
        let (category, item_type) = map
            .get("/Lotus/Powersuits/Cowgirl/MesaPrime")
            .expect("entry present");
        assert_eq!(category.as_deref(), Some("Warframes"));
        assert_eq!(item_type.as_deref(), Some("Warframe"));
    }

    #[test]
    fn write_and_read_item_i18n_round_trips_through_sqlite() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite opens");
        initialize_schema(&connection).expect("schema initializes");
        let items = vec![ItemRow {
            item_key: "item-1".into(), slug: "mesa_prime".into(), game_ref: None,
            name_en: "Mesa Prime".into(), item_family: "warframe".into(),
            max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
            icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None, preferred_image: None,
        }];
        write_items(&connection, &items).expect("items write");
        let rows = vec![ItemI18nRow {
            item_key: "item-1".into(),
            lang_code: "de".into(),
            name: Some("Mesa Prime DE".into()),
            icon: Some("icon.png".into()),
            thumb: Some("thumb.png".into()),
        }];
        write_item_i18n(&connection, &rows).expect("i18n write");

        let autocomplete = load_autocomplete_items_v2(&connection, "de").expect("reads");
        assert_eq!(autocomplete.len(), 1);
        assert_eq!(autocomplete[0].name, "Mesa Prime DE");
        assert_eq!(autocomplete[0].name_en, "Mesa Prime");

        // A language with no rows falls back to name_en, same contract as the old catalog.
        let autocomplete_en = load_autocomplete_items_v2(&connection, "en").expect("reads");
        assert_eq!(autocomplete_en[0].name, "Mesa Prime");
    }

    #[test]
    fn relic_tier_icons_pick_one_representative_image_per_tier() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite opens");
        initialize_schema(&connection).expect("schema initializes");
        let items = vec![
            ItemRow {
                item_key: "r1".into(), slug: "axi_a1_relic".into(), game_ref: None,
                name_en: "Axi A1 Relic".into(), item_family: "relic".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: Some("axi.png".into()), subtypes: Vec::new(),
                relic_tier: Some("Axi".into()), preferred_image: Some("axi.png".into()),
            },
            ItemRow {
                item_key: "r2".into(), slug: "lith_a1_relic".into(), game_ref: None,
                name_en: "Lith A1 Relic".into(), item_family: "relic".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: Some("lith.png".into()), subtypes: Vec::new(),
                relic_tier: Some("Lith".into()), preferred_image: Some("lith.png".into()),
            },
        ];
        write_items(&connection, &items).expect("items write");
        let icons = load_relic_tier_icons_v2(&connection).expect("reads");
        assert_eq!(icons.len(), 2);
        assert!(icons.iter().any(|row| row.tier == "Axi" && row.image_path == "axi.png"));
        assert!(icons.iter().any(|row| row.tier == "Lith" && row.image_path == "lith.png"));
    }

    #[test]
    fn item_metadata_category_prefers_wfstat_category_then_type_then_item_family() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite opens");
        initialize_schema(&connection).expect("schema initializes");
        let items = vec![
            ItemRow {
                item_key: "with-category".into(), slug: "a".into(), game_ref: None,
                name_en: "A".into(), item_family: "warframe".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None,
                preferred_image: Some("a.png".into()),
            },
            ItemRow {
                item_key: "no-match".into(), slug: "b".into(), game_ref: None,
                name_en: "B".into(), item_family: "weapon".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None, subtypes: Vec::new(), relic_tier: None,
                preferred_image: None,
            },
        ];
        write_items(&connection, &items).expect("items write");
        let mut category_map = HashMap::new();
        category_map.insert(
            "wfstat-a".to_string(),
            (Some("Warframes".to_string()), Some("Warframe".to_string())),
        );
        let report = WfstatMatchReport {
            matches: {
                let mut m = HashMap::new();
                m.insert("with-category".to_string(), ("wfstat-a".to_string(), WfstatMatchTier::MarketInfoId));
                m
            },
            unmatched: vec!["no-match".to_string()],
        };
        write_wfstat_report_with_raw_json(&connection, &report, &category_map, &HashMap::new())
            .expect("report writes");

        let with_category = load_item_metadata_v2(&connection, "with-category")
            .expect("reads")
            .expect("present");
        assert_eq!(with_category.category, "Warframes");
        assert_eq!(with_category.image_path.as_deref(), Some("a.png"));

        // No wfstat match at all -> falls back to item_family.
        let no_match = load_item_metadata_v2(&connection, "no-match")
            .expect("reads")
            .expect("present");
        assert_eq!(no_match.category, "weapon");
    }

    // ─── Language pack tests ────────────────────────────────────────────────────────────────

    fn open_test_db_with_one_item() -> Connection {
        let connection = open_test_db();
        initialize_schema(&connection).expect("schema");
        write_items(
            &connection,
            &[ItemRow {
                item_key: "5537143d3e4b8d0ff44dcdb1".into(),
                slug: "braton_prime_receiver".into(),
                game_ref: None,
                name_en: "Braton Prime Receiver".into(),
                item_family: "weapon".into(),
                max_rank: None,
                ducats: None,
                bulk_tradable: false,
                set_root: false,
                icon: None,
                thumb: None,
                subtypes: Vec::new(),
                relic_tier: None,
                preferred_image: None,
            }],
        )
        .expect("items write");
        connection
    }

    #[test]
    fn ensure_language_pack_schema_is_idempotent_and_adds_sub_icon() {
        let connection = open_test_db_with_one_item();
        // Fresh `initialize_schema` already creates `language_pack_meta` and `item_i18n.sub_icon`
        // — calling this again (as every language-pack command does) must not error.
        ensure_language_pack_schema(&connection).expect("first call");
        ensure_language_pack_schema(&connection).expect("second call is a no-op, not an error");
        // sub_icon is genuinely writable (would error at INSERT time if the ALTER had failed).
        connection
            .execute(
                "INSERT INTO item_i18n (item_key, lang_code, name, sub_icon) VALUES (?1, 'fr', 'x', 'icon.png')",
                params!["5537143d3e4b8d0ff44dcdb1"],
            )
            .expect("sub_icon column is writable");
    }

    #[test]
    fn i18n_row_count_v2_ignores_empty_and_null_names() {
        let connection = open_test_db_with_one_item();
        ensure_language_pack_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO item_i18n (item_key, lang_code, name) VALUES (?1, 'fr', 'Récepteur')",
                params!["5537143d3e4b8d0ff44dcdb1"],
            )
            .unwrap();
        assert_eq!(i18n_row_count_v2(&connection, "fr").unwrap(), 1);
        assert_eq!(i18n_row_count_v2(&connection, "de").unwrap(), 0);
    }

    #[test]
    fn language_built_version_falls_back_to_catalog_collection_hash() {
        let connection = open_test_db_with_one_item();
        write_catalog_meta(&connection, "collection_hash", "wfm-hash-1").unwrap();
        // No per-language record yet -> falls back to the catalog's own stored hash.
        assert_eq!(
            language_built_version_v2(&connection, "fr").unwrap(),
            Some("wfm-hash-1".to_string())
        );
        // A recorded per-language version takes priority over the fallback.
        connection
            .execute(
                "INSERT INTO language_pack_meta (lang_code, wfm_version, item_count, updated_at)
                 VALUES ('fr', 'wfm-hash-2', 1, 'now')",
                [],
            )
            .unwrap();
        assert_eq!(
            language_built_version_v2(&connection, "fr").unwrap(),
            Some("wfm-hash-2".to_string())
        );
    }

    #[test]
    fn import_language_pack_v2_round_trips_and_skips_unknown_items() {
        let mut connection = open_test_db_with_one_item();
        let pack = LanguagePackV2 {
            format: LANGUAGE_PACK_FORMAT_V2.to_string(),
            lang_code: "fr".to_string(),
            wfm_version: Some("wfm-hash-1".to_string()),
            item_count: 2,
            exported_at: "2026-01-01T00:00:00Z".to_string(),
            rows: vec![
                LanguagePackRowV2 {
                    item_key: "5537143d3e4b8d0ff44dcdb1".to_string(),
                    name: Some("Récepteur".to_string()),
                    icon: None,
                    thumb: None,
                    sub_icon: None,
                },
                LanguagePackRowV2 {
                    // Not present in this catalog -> must be skipped (FK-safe), not error.
                    item_key: "does-not-exist".to_string(),
                    name: Some("Ghost".to_string()),
                    icon: None,
                    thumb: None,
                    sub_icon: None,
                },
            ],
        };
        let pack_json = serde_json::to_string(&pack).unwrap();

        // Exercise the same insert logic `import_language_pack_v2` runs, directly against the
        // in-memory connection (the public fn opens its own connection via an AppHandle, which
        // isn't available in a unit test).
        ensure_language_pack_schema(&connection).unwrap();
        let parsed: LanguagePackV2 = serde_json::from_str(&pack_json).unwrap();
        assert_eq!(parsed.format, LANGUAGE_PACK_FORMAT_V2);
        let tx = connection.transaction().unwrap();
        tx.execute("DELETE FROM item_i18n WHERE lang_code = ?1", [&parsed.lang_code])
            .unwrap();
        let mut inserted = 0i64;
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO item_i18n (item_key, lang_code, name, icon, thumb, sub_icon)
                     SELECT ?1, ?2, ?3, ?4, ?5, ?6
                     WHERE EXISTS (SELECT 1 FROM items WHERE item_key = ?1)",
                )
                .unwrap();
            for row in &parsed.rows {
                inserted += insert
                    .execute(params![row.item_key, parsed.lang_code, row.name, row.icon, row.thumb, row.sub_icon])
                    .unwrap() as i64;
            }
        }
        tx.commit().unwrap();

        assert_eq!(inserted, 1, "only the known item_key should be inserted");
        assert_eq!(i18n_row_count_v2(&connection, "fr").unwrap(), 1);
    }
}
