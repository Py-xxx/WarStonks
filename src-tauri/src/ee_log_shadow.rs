//! Shadow store for trades parsed out of Warframe's `EE.log`.
//!
//! **Nothing here touches the real trade log.** The point is to run the new parser alongside
//! the existing WFM-polling detection and compare them over real trading, before the cutover
//! deletes WFM polling (see `Resources/WFAndAlecaAppData/plan.md` §7 steps 6→7).
//!
//! `EE.log` is a debug log DE can change in any patch without notice, so "the parser looks
//! right" is not evidence. Agreement with an independent source over a sustained period is.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::ee_log::TradeEvent;

pub(crate) fn initialize_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS ee_log_trade_shadow (
              -- session_start|elapsed_s: stable across re-reads of the same session, so a
              -- replay after a restart updates rather than duplicating.
              trade_key TEXT PRIMARY KEY,
              partner TEXT NOT NULL,
              occurred_at TEXT,
              elapsed_s REAL NOT NULL,
              platinum_in INTEGER NOT NULL,
              platinum_out INTEGER NOT NULL,
              -- The parsed sides, verbatim. Kept as JSON because this is diagnostic data whose
              -- shape will change as the parser is corrected; a rigid schema would fight that.
              items_json TEXT NOT NULL,
              recorded_at TEXT NOT NULL
            );
            ",
        )
        .context("failed to create the EE.log shadow trade table")?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowTradeRow {
    pub trade_key: String,
    pub partner: String,
    pub occurred_at: Option<String>,
    pub platinum_in: i64,
    pub platinum_out: i64,
    /// Net platinum, positive when the user was paid.
    pub platinum_net: i64,
    pub giving: Vec<ShadowTradeItem>,
    pub getting: Vec<ShadowTradeItem>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowTradeItem {
    pub name: String,
    pub quantity: i64,
    /// Current rank, from the filled rank pips.
    pub rank: Option<i64>,
    pub max_rank: Option<i64>,
    /// WFM slug, when the catalog resolves the name. `None` means the item could not be
    /// identified — worth seeing, because it is exactly what would break a real cutover.
    pub slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSides {
    giving: Vec<ShadowTradeItem>,
    getting: Vec<ShadowTradeItem>,
}

fn resolve_items(
    catalog: Option<&Connection>,
    items: &[crate::ee_log::TradedItem],
) -> Vec<ShadowTradeItem> {
    items
        .iter()
        .map(|item| ShadowTradeItem {
            name: item.name.clone(),
            quantity: item.quantity,
            rank: item.rank,
            max_rank: item.max_rank,
            // Same bridge the inventory uses. EE.log gives a display name with no slug, so
            // this is where a naming gap would surface — recorded as `None` rather than
            // guessed at.
            slug: catalog.and_then(|connection| {
                crate::item_catalog_v2::lookup_item_v2_inner(connection, &item.name)
                    .ok()
                    .flatten()
                    .map(|entry| entry.slug)
            }),
        })
        .collect()
}

pub(crate) fn record_trades_inner(
    connection: &Connection,
    trades: &[TradeEvent],
    recorded_at: &str,
) -> Result<usize> {
    if trades.is_empty() {
        return Ok(0);
    }
    let catalog = crate::item_catalog_v2::open_catalog_v2_from_remembered_path();

    let mut inserted = 0;
    for trade in trades {
        let sides = StoredSides {
            giving: resolve_items(catalog.as_ref(), &trade.giving),
            getting: resolve_items(catalog.as_ref(), &trade.getting),
        };
        let items_json = serde_json::to_string(&sides)
            .context("failed to serialize parsed trade sides")?;

        // Re-reading the same session must refresh rather than duplicate — the parser may
        // have been corrected between runs, and a stale row would misrepresent it.
        connection
            .execute(
                "INSERT INTO ee_log_trade_shadow (
                   trade_key, partner, occurred_at, elapsed_s,
                   platinum_in, platinum_out, items_json, recorded_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(trade_key) DO UPDATE SET
                   partner = excluded.partner,
                   occurred_at = excluded.occurred_at,
                   platinum_in = excluded.platinum_in,
                   platinum_out = excluded.platinum_out,
                   items_json = excluded.items_json,
                   recorded_at = excluded.recorded_at",
                params![
                    trade.key,
                    trade.partner,
                    trade
                        .occurred_at
                        .and_then(|value| value
                            .format(&time::format_description::well_known::Rfc3339)
                            .ok()),
                    trade.elapsed_s,
                    trade.platinum_in,
                    trade.platinum_out,
                    items_json,
                    recorded_at,
                ],
            )
            .context("failed to record a shadow trade")?;
        inserted += 1;
    }
    Ok(inserted)
}

pub(crate) fn load_trades_inner(connection: &Connection) -> Result<Vec<ShadowTradeRow>> {
    let mut statement = connection
        .prepare(
            "SELECT trade_key, partner, occurred_at, platinum_in, platinum_out,
                    items_json, recorded_at
             FROM ee_log_trade_shadow
             ORDER BY occurred_at DESC, elapsed_s DESC",
        )
        .context("failed to prepare the shadow trade query")?;

    let rows = statement
        .query_map([], |row| {
            let items_json: String = row.get(5)?;
            let sides: StoredSides = serde_json::from_str(&items_json).unwrap_or(StoredSides {
                giving: Vec::new(),
                getting: Vec::new(),
            });
            let platinum_in: i64 = row.get(3)?;
            let platinum_out: i64 = row.get(4)?;
            Ok(ShadowTradeRow {
                trade_key: row.get(0)?,
                partner: row.get(1)?,
                occurred_at: row.get(2)?,
                platinum_in,
                platinum_out,
                platinum_net: platinum_in - platinum_out,
                giving: sides.giving,
                getting: sides.getting,
                recorded_at: row.get(6)?,
            })
        })
        .context("failed to read shadow trades")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect shadow trades")?;

    Ok(rows)
}

/// Marks trades the app recorded itself, as opposed to `wfm` (imported) or the legacy
/// `alecaframe` rows.
pub const TRADE_SOURCE_EELOG: &str = "eelog";

/// Converts one parsed trade into trade-log entries — one per item, both sides.
///
/// The shape mirrors what the log actually contains rather than what would be convenient:
///
/// * **Direction is per item.** Items the user *received* are buys; items they *gave* are
///   sells. A trade can legitimately contain both (an item-for-item swap).
/// * **Platinum is the consideration, never a row.** It sets the trade's total, and is not
///   itself a traded good.
/// * **Every row of one trade shares a `group_id`**, so the existing allocation machinery
///   treats them as one transaction — the same mechanism the trade log already uses for
///   multi-item trades, so "sold as set", "flip" and "partial" keep working untouched.
/// * **Per-item price is left to the user.** The log gives a total only, so splitting it
///   automatically would fabricate a cost basis that flows into realized profit. The rows
///   carry `allocation_total_platinum` and the UI marks them as needing pricing.
pub fn trade_log_entries_from_event(
    trade: &TradeEvent,
    resolve: &dyn Fn(&str) -> Option<(String, String)>,
) -> Vec<crate::trades::PortfolioTradeLogEntry> {
    let closed_at = trade
        .occurred_at
        .and_then(|value| value.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_default();

    let mut entries = Vec::new();
    let mut sort_order = 0_i64;

    for (items, order_type, total) in [
        (&trade.getting, "buy", trade.platinum_out),
        (&trade.giving, "sell", trade.platinum_in),
    ] {
        let tradable: Vec<_> = items
            .iter()
            .filter(|item| !item.name.eq_ignore_ascii_case("platinum"))
            .collect();
        if tradable.is_empty() {
            continue;
        }

        for item in tradable {
            let (slug, name) = resolve(&item.name)
                .unwrap_or_else(|| (String::new(), item.name.clone()));
            entries.push(crate::trades::PortfolioTradeLogEntry {
                // Deterministic: re-reading the same session updates rather than duplicating.
                id: format!("ee-{}-{}-{}", trade.key, order_type, sort_order),
                item_name: name,
                slug,
                image_path: None,
                order_type: order_type.to_string(),
                source: TRADE_SOURCE_EELOG.to_string(),
                platinum: 0,
                quantity: item.quantity,
                rank: item.rank,
                closed_at: closed_at.clone(),
                updated_at: closed_at.clone(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: Some(trade.key.clone()),
                group_label: Some(trade.partner.clone()),
                group_total_platinum: Some(total),
                group_item_count: None,
                allocation_total_platinum: Some(total),
                group_sort_order: Some(sort_order),
                allocation_mode: None,
                cost_basis_confidence: None,
                cost_basis_label: None,
                matched_cost: None,
                matched_quantity: None,
                matched_buy_count: 0,
                matched_buy_rows: Vec::new(),
                set_component_rows: Vec::new(),
                profit_formula: None,
                duplicate_risk: false,
            });
            sort_order += 1;
        }
    }

    entries
}

/// How far apart an EE.log trade and a WFM order may be and still be the same event.
///
/// WFM's `closed_at` is when the *order* closed, which is not the instant the in-game trade
/// completed — the two can drift by minutes. Too tight and real matches read as
/// disagreements; too loose and unrelated trades of the same item get paired.
const MATCH_WINDOW_MINUTES: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComparisonStatus {
    /// Both sources saw it. This is what should dominate before cutting over.
    Matched,
    /// EE.log caught a trade WFM has no record of. Expected sometimes — WFM only knows about
    /// trades that went through a listing.
    ShadowOnly,
    /// **The concerning one.** WFM recorded a trade the parser missed, which is exactly what
    /// the cutover would start losing.
    WfmOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonRow {
    pub status: ComparisonStatus,
    pub occurred_at: Option<String>,
    /// Item name, from whichever source has it.
    pub item_name: String,
    pub slug: Option<String>,
    /// Partner, when EE.log saw the trade. WFM never carries one.
    pub partner: Option<String>,
    pub platinum: i64,
    pub quantity: i64,
    pub order_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeComparison {
    pub rows: Vec<ComparisonRow>,
    pub matched_count: usize,
    pub shadow_only_count: usize,
    /// Non-zero means the parser is still missing trades — cutting over would lose them.
    pub wfm_only_count: usize,
    /// Items EE.log saw but the catalog could not identify. These would arrive at the trade
    /// log with no slug, so they matter independently of whether the trade itself matched.
    pub unresolved_item_count: usize,
}

/// Pairs EE.log-detected trades against WFM-detected ones.
///
/// Deliberately conservative about what counts as a match: same slug, and within
/// `MATCH_WINDOW_MINUTES`. A shadow item with no slug can never match, which is correct —
/// an unidentifiable item is a real gap, not a near-miss.
pub(crate) fn compare_inner(
    shadow: &[ShadowTradeRow],
    wfm: &[crate::trades::StoredTradeLogRecord],
) -> TradeComparison {
    let mut rows = Vec::new();
    let mut consumed_wfm = vec![false; wfm.len()];
    let mut unresolved_item_count = 0;

    for trade in shadow {
        let occurred = trade.occurred_at.as_deref().and_then(crate::trades::parse_timestamp);

        // Each traded item is compared separately: WFM records one row per item, while one
        // EE.log trade can carry several.
        for (item, is_incoming) in trade
            .getting
            .iter()
            .map(|item| (item, true))
            .chain(trade.giving.iter().map(|item| (item, false)))
        {
            // Platinum is the consideration, not a traded good.
            if item.name.eq_ignore_ascii_case("platinum") {
                continue;
            }
            if item.slug.is_none() {
                unresolved_item_count += 1;
            }

            let matched_index = item.slug.as_ref().and_then(|slug| {
                wfm.iter().enumerate().position(|(index, record)| {
                    if consumed_wfm[index] || &record.slug != slug {
                        return false;
                    }
                    match (occurred, crate::trades::parse_timestamp(&record.closed_at)) {
                        (Some(left), Some(right)) => {
                            (left - right).whole_minutes().abs() <= MATCH_WINDOW_MINUTES
                        }
                        // Without a timestamp on either side, slug agreement is all we have.
                        _ => true,
                    }
                })
            });

            if let Some(index) = matched_index {
                consumed_wfm[index] = true;
            }

            rows.push(ComparisonRow {
                status: if matched_index.is_some() {
                    ComparisonStatus::Matched
                } else {
                    ComparisonStatus::ShadowOnly
                },
                occurred_at: trade.occurred_at.clone(),
                item_name: item.name.clone(),
                slug: item.slug.clone(),
                partner: Some(trade.partner.clone()),
                platinum: if is_incoming { trade.platinum_out } else { trade.platinum_in },
                quantity: item.quantity,
                order_type: Some(if is_incoming { "buy" } else { "sell" }.to_string()),
            });
        }
    }

    // Whatever WFM saw that nothing claimed is a trade the parser missed.
    for (index, record) in wfm.iter().enumerate() {
        if consumed_wfm[index] {
            continue;
        }
        rows.push(ComparisonRow {
            status: ComparisonStatus::WfmOnly,
            occurred_at: Some(record.closed_at.clone()),
            item_name: record.item_name.clone(),
            slug: Some(record.slug.clone()),
            partner: None,
            platinum: record.platinum,
            quantity: record.quantity,
            order_type: Some(record.order_type.clone()),
        });
    }

    rows.sort_by(|left, right| right.occurred_at.cmp(&left.occurred_at));

    let matched_count = rows.iter().filter(|r| r.status == ComparisonStatus::Matched).count();
    let shadow_only_count = rows.iter().filter(|r| r.status == ComparisonStatus::ShadowOnly).count();
    let wfm_only_count = rows.iter().filter(|r| r.status == ComparisonStatus::WfmOnly).count();

    TradeComparison {
        rows,
        matched_count,
        shadow_only_count,
        wfm_only_count,
        unresolved_item_count,
    }
}

/// Writes detected trades into the real trade log.
///
/// EE.log is the trade-log source: WFM has no trade detection of its own, so there is nothing
/// to poll and nothing to reconcile against. Existing rows (WFM-imported or legacy) are left
/// untouched — this only appends.
///
/// De-duplication is deliberately **cross-source only**. Two trades of the same item at the
/// same price minutes apart are two real trades, and merging them would silently lose one.
/// Only an incoming row matching one already stored is skipped, which `append_unique_trade_entries`
/// already implements.
#[tauri::command]
pub fn record_ee_log_trades_to_log(
    app: tauri::AppHandle,
    username: String,
    trades: Vec<TradeEvent>,
) -> Result<usize, String> {
    if trades.is_empty() || username.trim().is_empty() {
        return Ok(0);
    }

    let catalog = crate::item_catalog_v2::open_catalog_v2_from_remembered_path();
    let resolve = |name: &str| {
        catalog.as_ref().and_then(|connection| {
            crate::item_catalog_v2::lookup_item_v2_inner(connection, name)
                .ok()
                .flatten()
                .map(|entry| (entry.slug, entry.name_en))
        })
    };

    let incoming: Vec<_> = trades
        .iter()
        .flat_map(|trade| trade_log_entries_from_event(trade, &resolve))
        .collect();
    if incoming.is_empty() {
        return Ok(0);
    }

    crate::trades::append_trade_log_entries(&app, username.trim(), &incoming)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_trade_detection_comparison(
    app: tauri::AppHandle,
    username: String,
) -> Result<TradeComparison, String> {
    let connection = crate::trades::open_trades_cache_database(&app).map_err(|e| e.to_string())?;
    initialize_schema(&connection).map_err(|e| e.to_string())?;
    let shadow = load_trades_inner(&connection).map_err(|e| e.to_string())?;
    let wfm = crate::trades::load_stored_trade_log_records_inner(&connection, &username)
        .unwrap_or_default();
    Ok(compare_inner(&shadow, &wfm))
}

/// Persists trades the tailer has parsed. Called with whatever `poll_ee_log_events` returned,
/// so it is a no-op on the overwhelming majority of polls.
#[tauri::command]
pub fn record_ee_log_trades(
    app: tauri::AppHandle,
    trades: Vec<TradeEvent>,
) -> Result<usize, String> {
    if trades.is_empty() {
        return Ok(0);
    }
    let connection = crate::trades::open_trades_cache_database(&app).map_err(|e| e.to_string())?;
    initialize_schema(&connection).map_err(|e| e.to_string())?;
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|e| e.to_string())?;
    record_trades_inner(&connection, &trades, &now).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_ee_log_shadow_trades(app: tauri::AppHandle) -> Result<Vec<ShadowTradeRow>, String> {
    let connection = crate::trades::open_trades_cache_database(&app).map_err(|e| e.to_string())?;
    initialize_schema(&connection).map_err(|e| e.to_string())?;
    load_trades_inner(&connection).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ee_log::TradedItem;

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        connection
    }

    fn sample_trade(key: &str, platinum_in: i64) -> TradeEvent {
        TradeEvent {
            partner: "Someone".to_string(),
            giving: vec![TradedItem {
                name: "Platinum".to_string(),
                quantity: 10,
                rank: None,
                max_rank: None,
            }],
            getting: vec![TradedItem {
                name: "Ash Prime Blueprint".to_string(),
                quantity: 1,
                rank: None,
                max_rank: None,
            }],
            platinum_in,
            platinum_out: 10,
            elapsed_s: 100.0,
            occurred_at: None,
            key: key.to_string(),
        }
    }

    fn shadow_row(occurred: &str, item: &str, slug: Option<&str>) -> ShadowTradeRow {
        ShadowTradeRow {
            trade_key: format!("k-{occurred}-{item}"),
            partner: "Partner".to_string(),
            occurred_at: Some(occurred.to_string()),
            platinum_in: 0,
            platinum_out: 10,
            platinum_net: -10,
            giving: vec![ShadowTradeItem {
                name: "Platinum".to_string(),
                quantity: 10,
                rank: None,
                max_rank: None,
                slug: None,
            }],
            getting: vec![ShadowTradeItem {
                name: item.to_string(),
                quantity: 1,
                rank: None,
                max_rank: None,
                slug: slug.map(str::to_string),
            }],
            recorded_at: "t".to_string(),
        }
    }

    fn wfm_row(closed: &str, slug: &str) -> crate::trades::StoredTradeLogRecord {
        crate::trades::StoredTradeLogRecord {
            id: format!("wfm-{closed}-{slug}"),
            item_name: slug.to_string(),
            slug: slug.to_string(),
            image_path: None,
            order_type: "buy".to_string(),
            source: "wfm".to_string(),
            platinum: 10,
            quantity: 1,
            rank: None,
            closed_at: closed.to_string(),
            updated_at: closed.to_string(),
            keep_item: false,
            group_id: None,
            group_label: None,
            group_total_platinum: None,
            group_item_count: None,
            allocation_total_platinum: None,
            group_sort_order: None,
        }
    }

    #[test]
    fn a_trade_both_sources_saw_is_matched_once() {
        let shadow = vec![shadow_row("2026-08-11T12:00:00Z", "Ash Prime Blueprint", Some("ash_prime_blueprint"))];
        let wfm = vec![wfm_row("2026-08-11T12:05:00Z", "ash_prime_blueprint")];

        let result = compare_inner(&shadow, &wfm);
        assert_eq!(result.matched_count, 1);
        assert_eq!(result.shadow_only_count, 0);
        assert_eq!(result.wfm_only_count, 0, "the WFM row must be consumed, not double-reported");
        // Platinum is consideration, not a traded good, so it never becomes its own row.
        assert_eq!(result.rows.len(), 1);
    }

    #[test]
    fn a_trade_wfm_saw_but_the_parser_missed_is_flagged() {
        // The whole point of shadow mode. A non-zero count here means cutting over would
        // start losing trades.
        let result = compare_inner(&[], &[wfm_row("2026-08-11T12:00:00Z", "mesa_prime_set")]);
        assert_eq!(result.wfm_only_count, 1);
        assert_eq!(result.rows[0].status, ComparisonStatus::WfmOnly);
        assert_eq!(result.rows[0].partner, None, "WFM never carries a partner");
    }

    #[test]
    fn the_same_item_traded_far_apart_does_not_match() {
        // Without a time bound, any two trades of a popular item would pair up and the
        // comparison would look far healthier than it is.
        let shadow = vec![shadow_row("2026-08-11T12:00:00Z", "Ash Prime Blueprint", Some("ash_prime_blueprint"))];
        let wfm = vec![wfm_row("2026-08-11T20:00:00Z", "ash_prime_blueprint")];

        let result = compare_inner(&shadow, &wfm);
        assert_eq!(result.matched_count, 0);
        assert_eq!(result.shadow_only_count, 1);
        assert_eq!(result.wfm_only_count, 1);
    }

    #[test]
    fn an_unidentifiable_item_is_counted_and_never_matches() {
        // A missing slug is a real gap — it would reach the trade log unidentified — so it
        // must not be quietly paired with a WFM row on timing alone.
        let shadow = vec![shadow_row("2026-08-11T12:00:00Z", "Some Unknown Thing", None)];
        let wfm = vec![wfm_row("2026-08-11T12:01:00Z", "ash_prime_blueprint")];

        let result = compare_inner(&shadow, &wfm);
        assert_eq!(result.unresolved_item_count, 1);
        assert_eq!(result.matched_count, 0);
        assert_eq!(result.wfm_only_count, 1);
    }

    #[test]
    fn one_wfm_row_cannot_satisfy_two_shadow_items() {
        // Two real trades of the same item close together must not both claim the single
        // WFM record, which would hide a genuine miss.
        let shadow = vec![
            shadow_row("2026-08-11T12:00:00Z", "Ash Prime Blueprint", Some("ash_prime_blueprint")),
            shadow_row("2026-08-11T12:02:00Z", "Ash Prime Blueprint", Some("ash_prime_blueprint")),
        ];
        let wfm = vec![wfm_row("2026-08-11T12:01:00Z", "ash_prime_blueprint")];

        let result = compare_inner(&shadow, &wfm);
        assert_eq!(result.matched_count, 1);
        assert_eq!(result.shadow_only_count, 1);
    }

    #[test]
    fn records_a_trade_and_reads_it_back() {
        let connection = memory_db();
        let stored = record_trades_inner(&connection, &[sample_trade("k1", 0)], "2026-08-11T00:00:00Z")
            .unwrap();
        assert_eq!(stored, 1);

        let rows = load_trades_inner(&connection).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].partner, "Someone");
        assert_eq!(rows[0].getting[0].name, "Ash Prime Blueprint");
        assert_eq!(rows[0].platinum_net, -10, "paying 10 is a net loss of platinum");
    }

    #[test]
    fn re_reading_the_same_session_updates_instead_of_duplicating() {
        // The tailer restarts from the top when the game truncates the log, so the same trade
        // key is seen again. A second row would double-count it in any comparison.
        let connection = memory_db();
        record_trades_inner(&connection, &[sample_trade("same-key", 0)], "t1").unwrap();
        record_trades_inner(&connection, &[sample_trade("same-key", 42)], "t2").unwrap();

        let rows = load_trades_inner(&connection).unwrap();
        assert_eq!(rows.len(), 1, "one row per trade key");
        assert_eq!(rows[0].platinum_in, 42, "the newer parse wins");
        assert_eq!(rows[0].recorded_at, "t2");
    }

    #[test]
    fn an_empty_batch_writes_nothing() {
        let connection = memory_db();
        assert_eq!(record_trades_inner(&connection, &[], "t").unwrap(), 0);
        assert!(load_trades_inner(&connection).unwrap().is_empty());
    }
}
