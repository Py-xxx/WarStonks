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

/// What kind of transaction a parsed trade is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TradeShape {
    /// The user paid platinum and received items.
    Buy,
    /// The user gave items and received platinum.
    Sell,
}

/// Classifies a trade, or `None` when it is not a priced purchase or sale.
///
/// Only a **clean** exchange counts: one side is nothing but platinum, the other nothing but
/// items. Anything else — item-for-item swaps, or a side mixing platinum with goods — has no
/// derivable per-item price, so a cost basis for it would be invented rather than measured.
/// Those are left out of the ledger entirely (they remain in the EE.log shadow store).
fn classify_trade(trade: &TradeEvent) -> Option<TradeShape> {
    let is_platinum = |item: &&crate::ee_log::TradedItem| item.name.eq_ignore_ascii_case("platinum");

    let giving_items = trade.giving.iter().filter(|item| !is_platinum(item)).count();
    let getting_items = trade.getting.iter().filter(|item| !is_platinum(item)).count();

    // `platinum_out` is what the user handed over, `platinum_in` what they received.
    match (
        giving_items,
        getting_items,
        trade.platinum_out,
        trade.platinum_in,
    ) {
        // Paid platinum, received goods, and nothing came back the other way.
        (0, getting, paid, 0) if getting > 0 && paid > 0 => Some(TradeShape::Buy),
        // Gave goods, received platinum only.
        (giving, 0, 0, received) if giving > 0 && received > 0 => Some(TradeShape::Sell),
        _ => None,
    }
}

/// Splits a platinum total across rows in proportion to quantity.
///
/// The remainder goes to the earliest rows one platinum at a time, so the shares always add
/// back up to exactly the total — the trade-log allocation editor rejects a group whose parts
/// do not sum to its total, and a rounding gap would make every multi-item trade unsaveable.
fn split_platinum(total: i64, quantities: &[i64]) -> Vec<i64> {
    let units: i64 = quantities.iter().map(|value| value.max(&1)).sum();
    if units <= 0 || total <= 0 {
        return quantities.iter().map(|_| 0).collect();
    }

    let mut shares: Vec<i64> = quantities
        .iter()
        .map(|quantity| total * quantity.max(&1) / units)
        .collect();

    let mut remainder = total - shares.iter().sum::<i64>();
    for share in shares.iter_mut() {
        if remainder <= 0 {
            break;
        }
        *share += 1;
        remainder -= 1;
    }

    shares
}

/// Converts one parsed trade into trade-log entries — one row per item.
///
/// * **Only clean buys and sells become rows** (see [`classify_trade`]). An item-for-item swap
///   has no price to record, and guessing one would corrupt every downstream number.
/// * **The platinum total is divided across the items**, weighted by quantity, never repeated
///   on each row. The split is provisional — the game records a total per *trade*, never a
///   price per item — so the UI marks the group as needing pricing and the user can reassign
///   it. Provisional is not the same as wrong-by-construction: giving four parts the full
///   total each would quadruple the trade's value everywhere it is summed.
/// * **A single-item trade is not a group.** Group fields are set only when the trade really
///   did contain more than one item, otherwise the log renders a one-item trade as "Grouped".
pub fn trade_log_entries_from_event(
    trade: &TradeEvent,
    resolve: &dyn Fn(&str) -> Option<(String, String)>,
) -> Vec<crate::trades::PortfolioTradeLogEntry> {
    let Some(shape) = classify_trade(trade) else {
        return Vec::new();
    };

    // Never empty. A row with no `closed_at` is not a usable trade — it cannot be sorted,
    // filtered, matched to a buy lot, or counted in P&L — and an empty string here is exactly
    // what a missing session anchor used to produce. The tailer now always supplies a time;
    // this is the backstop, and an approximately-right timestamp beats an unusable row.
    let closed_at = trade
        .occurred_at
        .unwrap_or_else(time::OffsetDateTime::now_utc)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let (items, order_type, total) = match shape {
        TradeShape::Buy => (&trade.getting, "buy", trade.platinum_out),
        TradeShape::Sell => (&trade.giving, "sell", trade.platinum_in),
    };

    let tradable: Vec<_> = items
        .iter()
        .filter(|item| !item.name.eq_ignore_ascii_case("platinum"))
        .collect();
    if tradable.is_empty() {
        return Vec::new();
    }

    let quantities: Vec<i64> = tradable.iter().map(|item| item.quantity.max(1)).collect();
    let shares = split_platinum(total, &quantities);
    let is_group = tradable.len() > 1;

    tradable
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let (slug, name) =
                resolve(&item.name).unwrap_or_else(|| (String::new(), item.name.clone()));
            let quantity = item.quantity.max(1);
            let share = shares.get(index).copied().unwrap_or(0);
            let sort_order = index as i64;

            crate::trades::PortfolioTradeLogEntry {
                // Deterministic: re-reading the same session updates rather than duplicating.
                id: format!("ee-{}-{}-{}", trade.key, order_type, sort_order),
                item_name: name,
                slug,
                image_path: None,
                order_type: order_type.to_string(),
                source: TRADE_SOURCE_EELOG.to_string(),
                // Per unit, matching what a Warframe.Market row stores.
                platinum: share / quantity,
                quantity,
                rank: item.rank,
                closed_at: closed_at.clone(),
                updated_at: closed_at.clone(),
                profit: None,
                margin: None,
                status: None,
                keep_item: false,
                group_id: is_group.then(|| trade.key.clone()),
                group_label: is_group.then(|| trade.partner.clone()),
                group_total_platinum: is_group.then_some(total),
                group_item_count: is_group.then_some(tradable.len() as i64),
                // The row's exact share, so the group's parts always sum to its total even
                // when the per-unit price had to be rounded.
                allocation_total_platinum: Some(share),
                group_sort_order: is_group.then_some(sort_order),
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
            }
        })
        .collect()
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
    session_started_at: Option<String>,
) -> Result<crate::trades::DetectedTradeOutcome, String> {
    if trades.is_empty() || username.trim().is_empty() {
        return Ok(crate::trades::DetectedTradeOutcome::default());
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
        return Ok(crate::trades::DetectedTradeOutcome::default());
    }

    // Only trades that happened during this app session may notify; anything older is
    // history the user has already seen.
    let session_started_at = session_started_at
        .as_deref()
        .and_then(crate::trades::parse_timestamp);

    crate::trades::apply_detected_trade_entries(
        &app,
        username.trim(),
        &incoming,
        TRADE_SOURCE_EELOG,
        session_started_at.as_ref(),
    )
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

    /// An untimed trade is an unusable trade-log row: nothing can sort, filter, match or
    /// account for it. This is the contract the missing session anchor broke.
    #[test]
    fn every_converted_entry_carries_a_timestamp() {
        let mut trade = trade_of(vec![plat(8)], vec![item("Ash Prime Blueprint", 1)]);
        trade.occurred_at = None;

        let entries = trade_log_entries_from_event(&trade, &|_| None);

        assert!(!entries.is_empty());
        for entry in entries {
            assert!(!entry.closed_at.is_empty(), "closed_at must never be empty");
            assert!(
                crate::trades::parse_timestamp(&entry.closed_at).is_some(),
                "closed_at must parse",
            );
        }
    }

    fn item(name: &str, quantity: i64) -> TradedItem {
        TradedItem { name: name.to_string(), quantity, rank: None, max_rank: None }
    }

    fn plat(amount: i64) -> TradedItem {
        TradedItem { name: "Platinum".to_string(), quantity: amount, rank: None, max_rank: None }
    }

    /// `giving` is what the user handed over, `getting` what they received.
    fn trade_of(giving: Vec<TradedItem>, getting: Vec<TradedItem>) -> TradeEvent {
        let platinum_out = giving.iter().filter(|i| i.name == "Platinum").map(|i| i.quantity).sum();
        let platinum_in = getting.iter().filter(|i| i.name == "Platinum").map(|i| i.quantity).sum();
        TradeEvent {
            partner: "Partner".to_string(),
            giving,
            getting,
            platinum_in,
            platinum_out,
            elapsed_s: 100.0,
            occurred_at: Some(time::OffsetDateTime::now_utc()),
            key: "k-shape".to_string(),
        }
    }

    fn entries_for(trade: &TradeEvent) -> Vec<crate::trades::PortfolioTradeLogEntry> {
        trade_log_entries_from_event(trade, &|name| {
            Some((name.to_lowercase().replace(' ', "_"), name.to_string()))
        })
    }

    /// The reported bug: four parts bought for 24p each showed 24p, quadrupling the trade's
    /// value everywhere it was summed. The total must be *divided*, and the parts must add
    /// back up to it exactly or the allocation editor refuses to save the group.
    #[test]
    fn a_multi_item_trade_divides_the_total_instead_of_repeating_it() {
        let trade = trade_of(
            vec![plat(24)],
            vec![
                item("Alternox Prime Blueprint", 1),
                item("Alternox Prime Barrel", 1),
                item("Alternox Prime Receiver", 1),
                item("Alternox Prime Stock", 1),
            ],
        );

        let entries = entries_for(&trade);

        assert_eq!(entries.len(), 4);
        for entry in &entries {
            assert_eq!(entry.allocation_total_platinum, Some(6));
            assert_eq!(entry.platinum, 6);
            assert_eq!(entry.order_type, "buy");
        }
        let allocated: i64 = entries.iter().filter_map(|e| e.allocation_total_platinum).sum();
        assert_eq!(allocated, 24, "the parts must sum back to the trade total");
        assert_eq!(entries[0].group_total_platinum, Some(24));
    }

    /// An uneven split still has to reconcile; the remainder goes to the earliest rows.
    #[test]
    fn an_uneven_split_still_sums_to_the_total() {
        let trade = trade_of(
            vec![plat(10)],
            vec![item("Part A", 1), item("Part B", 1), item("Part C", 1)],
        );

        let entries = entries_for(&trade);
        let shares: Vec<i64> = entries.iter().filter_map(|e| e.allocation_total_platinum).collect();

        assert_eq!(shares, vec![4, 3, 3]);
        assert_eq!(shares.iter().sum::<i64>(), 10);
    }

    /// Quantity matters: a stack of three is three units of value, not one.
    #[test]
    fn the_split_is_weighted_by_quantity() {
        let trade = trade_of(vec![plat(40)], vec![item("Part A", 3), item("Part B", 1)]);

        let entries = entries_for(&trade);

        assert_eq!(entries[0].allocation_total_platinum, Some(30));
        assert_eq!(entries[0].platinum, 10, "per-unit price, as a WFM row stores it");
        assert_eq!(entries[1].allocation_total_platinum, Some(10));
    }

    /// The other reported bug: a one-item trade was rendering as "Grouped".
    #[test]
    fn a_single_item_trade_is_not_a_group() {
        let trade = trade_of(vec![plat(8)], vec![item("Grendel Prime Neuroptics Blueprint", 1)]);

        let entries = entries_for(&trade);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].group_id, None, "one item is not a group");
        assert_eq!(entries[0].group_label, None);
        assert_eq!(entries[0].group_total_platinum, None);
        assert_eq!(entries[0].group_sort_order, None);
        assert_eq!(entries[0].platinum, 8);
    }

    /// Only a clean platinum-for-items exchange has a derivable price. Everything else is
    /// kept in the shadow store but must never reach the ledger, where it would be counted.
    #[test]
    fn only_clean_buys_and_sells_reach_the_trade_log() {
        // Item for item: no platinum anywhere, so no cost basis exists.
        assert!(entries_for(&trade_of(vec![item("Part A", 1)], vec![item("Part B", 1)])).is_empty());

        // Platinum mixed with goods on one side: the total cannot be attributed.
        assert!(entries_for(&trade_of(
            vec![plat(10), item("Part A", 1)],
            vec![item("Part B", 1)],
        ))
        .is_empty());

        // Platinum on both sides.
        assert!(entries_for(&trade_of(vec![plat(10)], vec![plat(5), item("Part B", 1)])).is_empty());

        // Platinum only, nothing traded.
        assert!(entries_for(&trade_of(vec![plat(10)], vec![plat(10)])).is_empty());
    }

    #[test]
    fn a_clean_sale_is_recorded_as_a_sell() {
        let trade = trade_of(vec![item("Wisp Prime Chassis", 1)], vec![plat(34)]);

        let entries = entries_for(&trade);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].order_type, "sell");
        assert_eq!(entries[0].platinum, 34);
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
