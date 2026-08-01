//! Phases 1–2 of the catalog rebuild (see the planning discussion — this module has ZERO
//! consumers: nothing in `lib.rs`'s command list calls into it, and no startup path touches it).
//! It exists to prove the new design against real data before anything is cut over.
//!
//! Design, in one sentence: **Warframe.Market is the spine; warframestat.us is optional
//! decoration that can be entirely absent without breaking anything.**
//!
//! Identity is the WFM item id (`item_key`), never a positional rowid — that one change is the
//! direct fix for the item-id-drift bug that cost a week of chasing "the price is right, for
//! the wrong item." Every join below is either exact (WFM's own `gameRef`/`setParts`/
//! `marketInfo.id`) or explicitly bounded (matched only within a known parent's component
//! list) — nothing falls back to a global fuzzy name search, because that mechanism is what
//! produced 2,753 ambiguous aliases in the old catalog.
//!
//! Phase 2 adds the persistence layer (`initialize_schema` / `build_and_write_catalog`) and a
//! live end-to-end harness (`tests::build_real_catalog_v2_live`, `#[ignore]`d so it never runs
//! in a normal `cargo test`) that fetches real WFM + WFStat data and writes an actual, browsable
//! SQLite file — see the module's test section for how to run it and inspect the result
//! yourself with the `sqlite3` CLI.

// This entire module is Phases 1–2 of the catalog rebuild: proven by its own tests against real
// WFM/WFStat data, but deliberately not wired into any running code path yet (see the module
// doc comment above). Every item here IS used — by the test suite — but `cargo build` only sees
// the non-test build, where nothing calls in yet. Same treatment as the test-only fields on
// `SmartDecision` in smart_manage.rs. Remove this once cutover adds a real caller.
#![cfg_attr(not(test), allow(dead_code))]

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

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
    /// Bounded: matched by name within the specific parent set's component list — never a
    /// search over the full WFStat catalog, so it can't reproduce the old ambiguity.
    BoundedComponent,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct WfstatMatchReport {
    pub matches: HashMap<String, (String, WfstatMatchTier)>,
    pub unmatched: Vec<String>,
}

impl WfstatMatchReport {
    pub(crate) fn tier_counts(&self) -> (usize, usize, usize) {
        let mut counts = (0, 0, 0);
        for (_, tier) in self.matches.values() {
            match tier {
                WfstatMatchTier::MarketInfoId => counts.0 += 1,
                WfstatMatchTier::GameRefExact => counts.1 += 1,
                WfstatMatchTier::BoundedComponent => counts.2 += 1,
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
            Some((first, WfstatMatchTier::BoundedComponent))
        })();

        match resolved {
            Some(value) => {
                report.matches.insert(item_key, value);
            }
            None => report.unmatched.push(item_key),
        }
    }
}

/// Runs all three tiers in order. This is the only function the rest of the app would ever
/// call — the tiers themselves are private because their order is not a caller's decision.
pub(crate) fn build_wfstat_matches(
    items: &[ItemRow],
    wfstat_json: &str,
    set_parts: &[SetPartRow],
) -> serde_json::Result<WfstatMatchReport> {
    let wfstat_items: Vec<WfstatItem> = serde_json::from_str(wfstat_json)?;
    let mut report = match_exact_tiers(items, &wfstat_items);
    match_bounded_component_tier(items, &wfstat_items, set_parts, &mut report);
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
        WfstatMatchTier::BoundedComponent => "bounded_component",
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
    pub wfstat_tier_counts: (usize, usize, usize),
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

// ─── Live fetch (network) — used only by the manual, #[ignore]'d harness below ─────────────

fn fetch_wfm_bulk_items_live() -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;
    let response = client
        .get("https://api.warframe.market/v2/items")
        .header("User-Agent", WFM_USER_AGENT)
        .header("Language", "en")
        .send()
        .context("failed to fetch WFM bulk items")?
        .error_for_status()
        .context("WFM bulk items request returned an error status")?;
    response.text().context("failed to read WFM bulk items body")
}

fn fetch_wfm_item_detail_live(slug: &str) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = client
        .get(format!("https://api.warframe.market/v2/item/{slug}"))
        .header("User-Agent", WFM_USER_AGENT)
        .header("Language", "en")
        .send()
        .with_context(|| format!("failed to fetch WFM item detail for {slug}"))?
        .error_for_status()
        .with_context(|| format!("WFM item detail request for {slug} returned an error status"))?;
    response
        .text()
        .with_context(|| format!("failed to read WFM item detail body for {slug}"))
}

fn fetch_wfstat_items_live() -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;
    let response = client
        .get("https://api.warframestat.us/items/")
        .header("User-Agent", WFM_USER_AGENT)
        .send()
        .context("failed to fetch WFStat items")?
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

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Persistence tests ──────────────────────────────────────────────────────────────────

    fn open_test_db() -> Connection {
        Connection::open_in_memory().expect("in-memory sqlite opens")
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
        let output_path = std::env::var("WARSTONKS_CATALOG_V2_OUTPUT")
            .unwrap_or_else(|_| "target/item_catalog_v2_live.sqlite".to_string());
        let _ = std::fs::remove_file(&output_path);

        println!("Fetching WFM bulk items...");
        let wfm_bulk_json = fetch_wfm_bulk_items_live().expect("WFM bulk fetch");

        let set_slugs = slugs_needing_set_detail(&wfm_bulk_json).expect("slug extraction");
        println!("Fetching setParts for {} set-tagged items (~{:.1} min at 3 req/s)...", set_slugs.len(), set_slugs.len() as f64 / 3.0 / 60.0);
        let mut details_by_key: HashMap<String, String> = HashMap::new();
        // Slug -> item_key map, built from the same bulk data, so the detail responses (which
        // don't carry their own id after the id field was dropped as unused) can be filed under
        // the right key: keyed here by slug and translated once bulk items are parsed below.
        #[derive(Deserialize)]
        struct SlimRow {
            id: String,
            slug: String,
        }
        #[derive(Deserialize)]
        struct SlimResponse {
            data: Vec<SlimRow>,
        }
        let slim: SlimResponse = serde_json::from_str(&wfm_bulk_json).expect("slim parse");
        let item_key_by_slug: HashMap<String, String> =
            slim.data.into_iter().map(|row| (row.slug, row.id)).collect();

        for (index, slug) in set_slugs.iter().enumerate() {
            match fetch_wfm_item_detail_live(slug) {
                Ok(body) => {
                    if let Some(item_key) = item_key_by_slug.get(slug) {
                        details_by_key.insert(item_key.clone(), body);
                    }
                }
                Err(error) => {
                    // Best-effort, matching how this would behave for real: one item's detail
                    // failing must not abort the whole build.
                    println!("  (skipped {slug}: {error})");
                }
            }
            if (index + 1) % 50 == 0 {
                println!("  ...{}/{}", index + 1, set_slugs.len());
            }
            // Just under 3 req/s — this is a manual harness, not the production scheduler.
            std::thread::sleep(Duration::from_millis(350));
        }
        println!("Fetched {} set details.", details_by_key.len());

        println!("Fetching WFStat items...");
        let wfstat_json_data = fetch_wfstat_items_live().expect("WFStat fetch");

        println!("Building catalog...");
        let connection = Connection::open(&output_path).expect("open output sqlite file");
        let summary =
            build_and_write_catalog(&connection, &wfm_bulk_json, &details_by_key, &wfstat_json_data)
                .expect("catalog build");

        let (t1, t2, t3) = summary.wfstat_tier_counts;
        let total = summary.item_count;
        println!("\n─── Catalog v2 live build report ───");
        println!("output file:            {output_path}");
        println!("items:                  {total}");
        println!("set roots:              {}", summary.set_root_count);
        println!("set parts:              {}", summary.set_part_count);
        println!("lookup keys accepted:   {}", summary.lookup_key_count);
        println!("lookup keys REJECTED:   {}", summary.rejected_key_count);
        println!(
            "wfstat matched: tier1(marketInfo)={t1} tier2(gameRef)={t2} tier3(bounded-component)={t3}"
        );
        println!("wfstat unmatched:       {}", summary.wfstat_unmatched_count);
        println!(
            "wfstat coverage:        {:.1}%",
            (t1 + t2 + t3) as f64 / total as f64 * 100.0
        );
        println!("\nOpen it yourself:  sqlite3 {output_path}");
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
        assert_eq!(chassis_tier, &WfstatMatchTier::BoundedComponent);
        assert_eq!(chassis_match, "/Lotus/.../ZephyrPrimeChassisComponent");
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
        assert_eq!(report.tier_counts(), (0, 0, 0));
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
