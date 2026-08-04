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
use tauri::Manager;

use crate::error_log::{log_feature_error_best_effort, log_feature_event_best_effort};
use crate::wfm_scheduler::{execute_coalesced_wfm_request, RequestPriority, WfmHttpResponse};

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
    // tradingTax / reqMasteryRank: present on the wire, not yet promoted to ItemRow — Phase 1
    // proves identity and set wiring; add these columns when a real consumer needs them rather
    // than carrying unused fields now.
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
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SetPartRow {
    pub set_key: String,
    pub part_key: String,
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
            ItemRow {
                item_key: item.id,
                slug: item.slug,
                game_ref,
                name_en: en
                    .and_then(|entry| entry.name.clone())
                    .unwrap_or_default(),
                item_family: classify_item_family(&item.tags),
                max_rank: item.max_rank,
                ducats: item.ducats,
                bulk_tradable: item.bulk_tradable.unwrap_or(false),
                // Filled in once per-item detail is fetched for set-tagged items; the bulk
                // response alone can't tell us this, so it starts false.
                set_root: false,
                icon: en.and_then(|entry| entry.icon.clone()),
                thumb: en.and_then(|entry| entry.thumb.clone()),
            }
        })
        .collect())
}

/// Applies `setRoot`/`setParts` from the per-item detail fetch — the ONLY per-item network cost
/// this design pays, and only for the ~230 items tagged "set" in bulk.
pub(crate) fn apply_set_details(
    items: &mut [ItemRow],
    details_json_by_item_key: &HashMap<String, String>,
) -> serde_json::Result<Vec<SetPartRow>> {
    #[derive(Deserialize)]
    struct DetailResponse {
        data: WfmItemDetail,
    }
    // A &str key borrowing `item_key` and a `&mut ItemRow` value borrowing the whole row can't
    // coexist for the same element, so the lookup goes by index instead of by mutable reference.
    // Owned keys, not borrowed: a `&str` index would keep `items` borrowed for the map's whole
    // lifetime, conflicting with the mutation below.
    let index_by_key: HashMap<String, usize> = items
        .iter()
        .enumerate()
        .map(|(index, item)| (item.item_key.clone(), index))
        .collect();
    let mut set_parts = Vec::new();

    for (item_key, json) in details_json_by_item_key {
        let parsed: DetailResponse = serde_json::from_str(json)?;
        let detail = parsed.data;
        if let Some(&index) = index_by_key.get(item_key.as_str()) {
            items[index].set_root = detail.set_root;
        }
        if detail.set_root {
            for part_key in &detail.set_parts {
                // A set's own root id is listed among its parts by WFM; that isn't a
                // "component" relationship and would make the set falsely include itself.
                if part_key != item_key {
                    set_parts.push(SetPartRow {
                        set_key: item_key.clone(),
                        part_key: part_key.clone(),
                    });
                }
            }
        }
    }
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
pub(crate) fn build_item_lookup(items: &[ItemRow]) -> (Vec<LookupRow>, Vec<RejectedLookupKey>) {
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
                item_key      TEXT PRIMARY KEY,
                slug          TEXT NOT NULL UNIQUE,
                game_ref      TEXT,
                name_en       TEXT NOT NULL,
                item_family   TEXT NOT NULL,
                max_rank      INTEGER,
                ducats        INTEGER,
                bulk_tradable INTEGER NOT NULL,
                set_root      INTEGER NOT NULL,
                icon          TEXT,
                thumb         TEXT
            );
            CREATE INDEX idx_items_family ON items (item_family);

            CREATE TABLE set_parts (
                set_key  TEXT NOT NULL REFERENCES items (item_key),
                part_key TEXT NOT NULL REFERENCES items (item_key),
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
                match_tier         TEXT NOT NULL
            );
            CREATE TABLE wfstat_unmatched (
                item_key TEXT PRIMARY KEY REFERENCES items (item_key)
            );

            CREATE TABLE catalog_meta (
                meta_key   TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL
            );
            ",
        )
        .context("failed to initialize the v2 catalog schema")
}

pub(crate) fn write_items(connection: &Connection, items: &[ItemRow]) -> Result<()> {
    let mut statement = connection.prepare(
        "INSERT INTO items (
            item_key, slug, game_ref, name_en, item_family,
            max_rank, ducats, bulk_tradable, set_root, icon, thumb
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
        ])?;
    }
    Ok(())
}

pub(crate) fn write_set_parts(connection: &Connection, set_parts: &[SetPartRow]) -> Result<()> {
    let mut statement =
        connection.prepare("INSERT INTO set_parts (set_key, part_key) VALUES (?1, ?2)")?;
    for row in set_parts {
        statement.execute(params![row.set_key, row.part_key])?;
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

pub(crate) fn write_wfstat_report(
    connection: &Connection,
    report: &WfstatMatchReport,
) -> Result<()> {
    {
        let mut statement = connection.prepare(
            "INSERT INTO wfstat_matches (item_key, wfstat_unique_name, match_tier)
             VALUES (?1, ?2, ?3)",
        )?;
        for (item_key, (unique_name, tier)) in &report.matches {
            statement.execute(params![item_key, unique_name, wfstat_tier_label(*tier)])?;
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
    let (lookup, rejected) = build_item_lookup(&items);
    let wfstat_report = build_wfstat_matches(&items, wfstat_json, &set_parts)
        .context("failed to parse WFStat item response")?;

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
    write_set_parts(connection, &set_parts)?;
    write_lookup(connection, &lookup, &rejected)?;
    write_wfstat_report(connection, &wfstat_report)?;
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
    let total_set_slugs = set_slugs.len();
    let mut details_by_key: HashMap<String, String> = HashMap::with_capacity(total_set_slugs);
    for (index, slug) in set_slugs.iter().enumerate() {
        // One item's detail failing must not abort the whole build — it just means that one
        // set's parts stay unknown, same tolerance the rest of the app gives a single bad fetch.
        match fetch_wfm_item_detail(slug) {
            Ok(body) => {
                if let Some(item_key) = item_keys.get(slug) {
                    details_by_key.insert(item_key.clone(), body);
                }
            }
            Err(_) => continue,
        }
        let completed = index + 1;
        if completed % SET_DETAIL_PROGRESS_REPORT_INTERVAL == 0 || completed == total_set_slugs {
            on_phase(BuildPhase::FetchingSetDetails {
                completed,
                total: total_set_slugs,
            });
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
fn catalog_v2_needs_rebuild(
    file_exists: bool,
    latest_collection_hash: Option<&str>,
    stored_collection_hash: Option<&str>,
) -> bool {
    if !file_exists {
        return true;
    }
    match (latest_collection_hash, stored_collection_hash) {
        (Some(latest), Some(stored)) => latest != stored,
        (None, _) => false,
        (Some(_), None) => true,
    }
}

fn read_stored_collection_hash(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let connection = Connection::open(path).ok()?;
    connection
        .query_row(
            "SELECT meta_value FROM catalog_meta WHERE meta_key = 'collection_hash'",
            [],
            |row| row.get(0),
        )
        .ok()
}

/// Runs the v2 catalog build as a blocking step in the app's existing startup sequence (see
/// `commands::run_initialize_app_catalog`, which calls this right after the current catalog
/// settles) — NOT a background thread. The whole rebuild is deliberately allowed to leave the
/// app unusable until every piece of it lands; this is one piece of it, so it runs on the same
/// loading screen the user already watches for the existing catalog, using the same
/// `startup-progress` event the frontend already listens to.
///
/// Freshness-gated like the existing catalog: a cheap WFM version probe decides whether anything
/// actually changed before paying for the full rebuild (bulk fetch + up to ~230 rate-limited
/// per-item fetches + WFStat fetch, a few minutes total) — without this, EVERY launch would pay
/// that cost, not just the first one or ones where the catalog actually changed.
///
/// Best-effort end to end: nothing in this module is read by the running app yet (see the module
/// doc comment), so a failure here must never block startup or surface as an app-level error —
/// it's logged, and the boot sequence continues exactly as if this step had succeeded but found
/// nothing to do.
pub fn initialize_catalog_v2_on_startup(app: &tauri::AppHandle) {
    use crate::item_catalog::{emit_progress, fetch_items_collection_version};

    let outcome = (|| -> Result<Option<(CatalogBuildSummary, Option<String>)>> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .context("failed to resolve the app data directory")?;
        std::fs::create_dir_all(&app_data_dir)
            .with_context(|| format!("failed to create {}", app_data_dir.display()))?;
        let final_path = app_data_dir.join(CATALOG_V2_DATABASE_FILE);
        let tmp_path = app_data_dir.join(CATALOG_V2_DATABASE_TMP_FILE);
        // A previous run that crashed mid-build could leave this behind; starting from nothing
        // is correct since `initialize_schema` cannot run twice against the same tables anyway.
        let _ = std::fs::remove_file(&tmp_path);

        emit_progress(
            app,
            "catalog-v2-check",
            "Checking item catalog",
            "Checking whether the item catalog needs refreshing.",
            0.62,
        );
        let latest_collection_hash = fetch_items_collection_version().ok();
        let stored_collection_hash = read_stored_collection_hash(&final_path);
        let need_rebuild = catalog_v2_needs_rebuild(
            final_path.exists(),
            latest_collection_hash.as_deref(),
            stored_collection_hash.as_deref(),
        );

        if !need_rebuild {
            emit_progress(
                app,
                "catalog-v2-cached",
                "Item catalog ready",
                "Using the cached item catalog — no changes detected.",
                0.8,
            );
            return Ok(None);
        }

        emit_progress(
            app,
            "catalog-v2-fetch",
            "Downloading market items",
            "Fetching the latest item list from Warframe Market.",
            0.64,
        );
        let (summary, wfstat_fetch_error) = build_catalog_v2_with_progress(&tmp_path, |phase| {
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
        })?;

        // Record what we built against BEFORE the rename, so the file that lands at `final_path`
        // already carries the hash a future launch needs — there is no window where the live
        // file exists but is missing this.
        if let Some(hash) = &latest_collection_hash {
            let connection = Connection::open(&tmp_path)
                .with_context(|| format!("failed to reopen {}", tmp_path.display()))?;
            write_catalog_meta(&connection, "collection_hash", hash)?;
        }

        std::fs::rename(&tmp_path, &final_path)
            .with_context(|| format!("failed to finalize {}", final_path.display()))?;

        emit_progress(
            app,
            "catalog-v2-ready",
            "Item catalog ready",
            "Item catalog refreshed.",
            0.8,
        );
        Ok(Some((summary, wfstat_fetch_error)))
    })();

    match outcome {
        Ok(None) => {
            log_feature_event_best_effort(
                app,
                "catalog-v2",
                "build",
                "Item catalog v2 unchanged since last launch — reused the existing file.",
            );
        }
        Ok(Some((summary, wfstat_fetch_error))) => {
            let (t1, t2, t3, t4, t5) = summary.wfstat_tier_counts;
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
                    t1 + t2 + t3 + t4 + t5,
                    summary.item_count,
                    summary.wfstat_unmatched_count,
                ),
            );
            // Logged as a distinct ERROR entry, not folded into the info line above — the first
            // real run of this build silently produced 0/3837 WFStat matches with no trace of
            // why, because the failure reason was discarded instead of surfaced. It must never
            // be quiet again: a catalog with zero enrichment matches is a symptom, not a
            // successful outcome, even though the build itself did not fail.
            if let Some(reason) = wfstat_fetch_error {
                log_feature_error_best_effort(
                    app,
                    "catalog-v2",
                    "wfstat-fetch",
                    "Catalog v2 built successfully but WFStat was unreachable, so every item is \
                     missing enrichment data (damage/magazine/range/etc. once that layer exists). \
                     This is not fatal — the catalog is otherwise fully correct — but it should \
                     not happen every run. If it keeps happening, the fetch timeout or network \
                     conditions during startup need attention.",
                    &anyhow!(reason),
                );
            }
        }
        Err(error) => {
            log_feature_error_best_effort(
                app,
                "catalog-v2",
                "build",
                "Failed to build item catalog v2. Anything reading from it will report the \
                 catalog as not yet ready until the next successful build. The rest of startup \
                 continues normally — nothing running today depends on this catalog yet.",
                &error,
            );
        }
    }
}

// ─── Read path ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemV2SetPart {
    pub item_key: String,
    pub slug: String,
    pub name_en: String,
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
            "SELECT p.item_key, p.slug, p.name_en
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
        // No file at all: nothing to reuse, must build regardless of hash state.
        assert!(catalog_v2_needs_rebuild(false, Some("a"), None));
        assert!(catalog_v2_needs_rebuild(false, None, None));

        // File exists, WFM reachable, hash changed: WFM's own item collection actually moved.
        assert!(catalog_v2_needs_rebuild(true, Some("new"), Some("old")));
        // File exists, WFM reachable, hash unchanged: nothing to do.
        assert!(!catalog_v2_needs_rebuild(true, Some("same"), Some("same")));
        // File exists, WFM unreachable: can't confirm either way — keep what we have rather than
        // force a rebuild we can't complete.
        assert!(!catalog_v2_needs_rebuild(true, None, Some("old")));
        assert!(!catalog_v2_needs_rebuild(true, None, None));
        // File exists but predates this check (no recorded hash) even though WFM IS reachable:
        // rebuild once to backfill it, so every launch after this one can fast-skip correctly.
        assert!(catalog_v2_needs_rebuild(true, Some("new"), None));
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
                icon: None, thumb: None,
            },
            ItemRow {
                item_key: "b".into(), slug: "item_b".into(), game_ref: None,
                name_en: "Blueprint".into(), item_family: "blueprint".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None,
            },
        ];
        let (accepted, rejected) = build_item_lookup(&items);

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
            icon: None, thumb: None,
        }];
        let (accepted, rejected) = build_item_lookup(&items);
        assert!(rejected.is_empty());
        assert!(accepted
            .iter()
            .any(|row| row.lookup_key == "primedualkamasblade" && row.kind == LookupKind::GameRefLeaf));
        assert!(accepted
            .iter()
            .any(|row| row.kind == LookupKind::GameRef && row.item_key == "a"));
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
            icon: None, thumb: None,
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
            icon: None, thumb: None,
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
                icon: None, thumb: None,
            },
            ItemRow {
                item_key: "chassis".into(), slug: "zephyr_prime_chassis_blueprint".into(),
                game_ref: Some(
                    "/Lotus/Types/Recipes/WarframeRecipes/ZephyrPrimeChassisBlueprint".into(),
                ),
                name_en: "Zephyr Prime Chassis Blueprint".into(), item_family: "blueprint".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None,
            },
        ];
        let set_parts = vec![SetPartRow { set_key: "root".into(), part_key: "chassis".into() }];
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
                icon: None, thumb: None,
            },
            ItemRow {
                item_key: "limbs".into(), slug: "fluctus_limbs".into(),
                game_ref: Some(
                    "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchRocketCrossbowStock".into(),
                ),
                name_en: "Fluctus Limbs".into(), item_family: "component".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None,
            },
            ItemRow {
                item_key: "stock".into(), slug: "fluctus_stock".into(),
                game_ref: Some(
                    "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchRocketCrossbowReceiver".into(),
                ),
                name_en: "Fluctus Stock".into(), item_family: "component".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None,
            },
        ];
        let set_parts = vec![
            SetPartRow { set_key: "root".into(), part_key: "limbs".into() },
            SetPartRow { set_key: "root".into(), part_key: "stock".into() },
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
                icon: None, thumb: None,
            },
            ItemRow {
                item_key: "part".into(), slug: "x_barrel".into(), game_ref: None,
                name_en: "X Barrel".into(), item_family: "component".into(),
                max_rank: None, ducats: None, bulk_tradable: false, set_root: false,
                icon: None, thumb: None,
            },
        ];
        let set_parts = vec![SetPartRow { set_key: "root".into(), part_key: "part".into() }];
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
            icon: None, thumb: None,
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
            icon: None, thumb: None,
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
            icon: None, thumb: None,
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
}
