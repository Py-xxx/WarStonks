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

    // Added after the table shipped, so they arrive by ALTER rather than in the CREATE above.
    // Both stay nullable: rows recorded before this existed have no knowable outcome, and
    // guessing one for them would be worse than showing "unknown".
    for (column, ddl) in [
        ("ingest_status", "ALTER TABLE ee_log_trade_shadow ADD COLUMN ingest_status TEXT"),
        ("ingest_reason", "ALTER TABLE ee_log_trade_shadow ADD COLUMN ingest_reason TEXT"),
        ("ingest_detail", "ALTER TABLE ee_log_trade_shadow ADD COLUMN ingest_detail TEXT"),
        ("expected_rows", "ALTER TABLE ee_log_trade_shadow ADD COLUMN expected_rows INTEGER"),
        ("logged_rows", "ALTER TABLE ee_log_trade_shadow ADD COLUMN logged_rows INTEGER"),
    ] {
        if !shadow_column_exists(connection, column)? {
            connection
                .execute(ddl, [])
                .with_context(|| format!("failed to add {column} to the shadow trade table"))?;
        }
    }

    Ok(())
}

fn shadow_column_exists(connection: &Connection, column: &str) -> Result<bool> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('ee_log_trade_shadow') WHERE name = ?1",
            params![column],
            |row| row.get(0),
        )
        .context("failed to inspect the shadow trade table")?;
    Ok(count > 0)
}

/// Stamps what became of one parsed trade. Best-effort by contract — the caller has already
/// done the important work (writing the trade to the ledger), and losing the diagnostic must
/// never fail that.
pub(crate) fn record_ingest_outcome(
    connection: &Connection,
    trade_key: &str,
    status: TradeIngestStatus,
    reason: Option<TradeIngestReason>,
    detail: Option<&str>,
    expected_rows: usize,
    logged_rows: usize,
) -> Result<()> {
    connection
        .execute(
            "UPDATE ee_log_trade_shadow
                SET ingest_status = ?2,
                    ingest_reason = ?3,
                    ingest_detail = ?4,
                    expected_rows = ?5,
                    logged_rows = ?6
              WHERE trade_key = ?1",
            params![
                trade_key,
                status.as_str(),
                reason.map(|value| value.as_str()),
                detail,
                expected_rows as i64,
                logged_rows as i64,
            ],
        )
        .context("failed to record a trade ingest outcome")?;
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
    /// What became of this trade at the ledger. `None` for rows recorded before outcomes were
    /// tracked — deliberately not backfilled, because their real outcome is unknowable.
    pub ingest_status: Option<TradeIngestStatus>,
    pub ingest_reason: Option<TradeIngestReason>,
    /// Free-text specifics for the UI to show under the reason (e.g. which item was involved).
    pub ingest_detail: Option<String>,
    /// Rows the converter built, and how many of them are in the ledger. A mismatch is the
    /// whole point of the pair.
    pub expected_rows: Option<i64>,
    pub logged_rows: Option<i64>,
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
                    items_json, recorded_at,
                    ingest_status, ingest_reason, ingest_detail, expected_rows, logged_rows
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
                // An unrecognised stored value reads as absent rather than failing the query:
                // this is diagnostic data, and a stale spelling must not hide the whole tab.
                ingest_status: row
                    .get::<_, Option<String>>(7)?
                    .as_deref()
                    .and_then(TradeIngestStatus::from_str),
                ingest_reason: row
                    .get::<_, Option<String>>(8)?
                    .as_deref()
                    .and_then(TradeIngestReason::from_str),
                ingest_detail: row.get(9)?,
                expected_rows: row.get(10)?,
                logged_rows: row.get(11)?,
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

/// What became of a parsed trade when it was offered to the trade log.
///
/// EE.log is truncated on the next game launch, so a trade that the parser saw but the ledger
/// did not keep is gone the moment the game restarts. Every one of these states used to be a
/// silent `return Vec::new()` or a `continue` — the trade simply never appeared and the user
/// had no way to tell a parser gap from a deliberate exclusion. Recording the outcome is what
/// makes "detected but not logged" answerable instead of guessable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TradeIngestStatus {
    /// Every row the trade produced is in the ledger.
    Logged,
    /// The trade produced rows, but only some of them survived. Always worth investigating —
    /// a partial trade misstates what was exchanged.
    PartiallyLogged,
    /// The trade produced rows and none of them reached the ledger.
    NotLogged,
    /// Deliberately excluded: there is no price to record. Not a fault.
    NotPriceable,
}

impl TradeIngestStatus {
    fn as_str(self) -> &'static str {
        match self {
            TradeIngestStatus::Logged => "logged",
            TradeIngestStatus::PartiallyLogged => "partiallyLogged",
            TradeIngestStatus::NotLogged => "notLogged",
            TradeIngestStatus::NotPriceable => "notPriceable",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "logged" => Some(TradeIngestStatus::Logged),
            "partiallyLogged" => Some(TradeIngestStatus::PartiallyLogged),
            "notLogged" => Some(TradeIngestStatus::NotLogged),
            "notPriceable" => Some(TradeIngestStatus::NotPriceable),
            _ => None,
        }
    }
}

/// Why a trade did not reach the ledger intact. A closed set rather than free text, so the UI
/// can translate it and so a new drop path cannot be added without naming itself here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TradeIngestReason {
    /// Item-for-item, or a side mixing platinum with goods. No derivable per-item price, so
    /// the ledger would have to invent a cost basis. See [`classify_trade`].
    NoPlatinumPrice,
    /// The priced side held nothing but platinum.
    NoTradableItems,
    /// Nobody was signed in, so there was no trade log to write to. The trade is recoverable
    /// from this table until the next game launch truncates EE.log.
    NotSignedIn,
    /// The ledger rejected the rows as duplicates of trades it already held.
    RejectedAsDuplicate,
    /// Rows were built but are absent from the ledger for a reason this code cannot name —
    /// the honest fallback, so an unknown drop path still shows up rather than reading as
    /// success.
    Unknown,
}

impl TradeIngestReason {
    fn as_str(self) -> &'static str {
        match self {
            TradeIngestReason::NoPlatinumPrice => "noPlatinumPrice",
            TradeIngestReason::NoTradableItems => "noTradableItems",
            TradeIngestReason::NotSignedIn => "notSignedIn",
            TradeIngestReason::RejectedAsDuplicate => "rejectedAsDuplicate",
            TradeIngestReason::Unknown => "unknown",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "noPlatinumPrice" => Some(TradeIngestReason::NoPlatinumPrice),
            "noTradableItems" => Some(TradeIngestReason::NoTradableItems),
            "notSignedIn" => Some(TradeIngestReason::NotSignedIn),
            "rejectedAsDuplicate" => Some(TradeIngestReason::RejectedAsDuplicate),
            "unknown" => Some(TradeIngestReason::Unknown),
            _ => None,
        }
    }
}

/// One traded item after identical copies have been folded together.
struct MergedItem {
    name: String,
    rank: Option<i64>,
    quantity: i64,
}

/// Folds repeated copies of the same item into one entry with a summed quantity.
///
/// **The game prints one line per copy.** Two arcanes arrive as two `TradedItem`s of quantity
/// 1, not one of quantity 2 (see `ee_log.rs::parses_the_real_trade_from_the_reference_log`,
/// pinned against a real two-arcane trade). Passing that straight through cost real data twice
/// over:
///
/// * it made a single-item trade look like a two-item **group**, so the log rendered it as
///   "Grouped" and asked the user to price a split between an item and itself; and
/// * both rows then carried the same order type, item, quantity **and** `closed_at`, which is
///   exactly the tuple `find_duplicate_trade_record` matches on — so the trade log's dedup
///   read the second copy as a re-read of the first and dropped it. Buying two arcanes for
///   10p recorded one arcane for 5p.
///
/// Merging here, before any row exists, fixes the quantity and removes the collision at
/// source rather than teaching the dedup about a shape it should never have been handed.
///
/// **Rank is part of the key.** A rank 0 and a rank 5 arcane are different goods with
/// different prices; folding them together would understate one and overstate the other.
/// First-appearance order is preserved so row ids stay stable across re-reads of a session.
fn merge_identical_items(items: &[crate::ee_log::TradedItem]) -> Vec<MergedItem> {
    let mut merged: Vec<MergedItem> = Vec::new();

    for item in items
        .iter()
        .filter(|item| !item.name.eq_ignore_ascii_case("platinum"))
    {
        // A line with no explicit count is one copy; the parser already defaults to 1, and
        // `max(1)` guards a malformed `x 0`.
        let quantity = item.quantity.max(1);
        match merged
            .iter_mut()
            .find(|existing| existing.name == item.name && existing.rank == item.rank)
        {
            Some(existing) => existing.quantity += quantity,
            None => merged.push(MergedItem {
                name: item.name.clone(),
                rank: item.rank,
                quantity,
            }),
        }
    }

    merged
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

    let tradable = merge_identical_items(items);
    if tradable.is_empty() {
        return Vec::new();
    }

    let quantities: Vec<i64> = tradable.iter().map(|item| item.quantity).collect();
    let shares = split_platinum(total, &quantities);
    // Distinct items, not lines. Two copies of one arcane is a single-item trade, and calling
    // it a group made the log render it as "Grouped" and demand a per-item price split for
    // items that are all the same item.
    let is_group = tradable.len() > 1;

    tradable
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let (slug, name) =
                resolve(&item.name).unwrap_or_else(|| (String::new(), item.name.clone()));
            let quantity = item.quantity;
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
    if trades.is_empty() {
        return Ok(crate::trades::DetectedTradeOutcome::default());
    }

    // Persist the parsed trade *before* attempting the ledger, for two reasons. EE.log is
    // truncated on the next game launch (plan §0.2), so anything not archived as it appears is
    // gone — the raw trade must survive even if the ledger write fails. And the outcome stamp
    // below is an UPDATE keyed on `trade_key`, so the row it targets has to exist first;
    // relying on the frontend's separate `record_ee_log_trades` call would make the stamp
    // depend on which of two fire-and-forget calls happened to land first.
    persist_shadow_trades_best_effort(&app, &trades);

    // Not signed in is a real data-loss path, not a no-op: the trade was parsed, there is
    // nowhere to write it, and EE.log is truncated on the next game launch. Stamp it so the
    // Detection tab can say so while the shadow row still holds the trade.
    if username.trim().is_empty() {
        stamp_outcomes_best_effort(&app, &trades, |trade| {
            (
                TradeIngestStatus::NotLogged,
                Some(TradeIngestReason::NotSignedIn),
                None,
                trade_row_ids(trade).len(),
                0,
            )
        });
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

    // Per trade, not flattened yet: attributing an outcome back to a trade afterwards needs
    // to know which rows came from which trade.
    let converted: Vec<(&TradeEvent, Vec<crate::trades::PortfolioTradeLogEntry>)> = trades
        .iter()
        .map(|trade| (trade, trade_log_entries_from_event(trade, &resolve)))
        .collect();

    let incoming: Vec<_> = converted
        .iter()
        .flat_map(|(_, entries)| entries.iter().cloned())
        .collect();

    if incoming.is_empty() {
        stamp_outcomes_best_effort(&app, &trades, |trade| {
            let (status, reason) = excluded_trade_outcome(trade);
            (status, Some(reason), None, 0, 0)
        });
        return Ok(crate::trades::DetectedTradeOutcome::default());
    }

    // Only trades that happened during this app session may notify; anything older is
    // history the user has already seen.
    let session_started_at = session_started_at
        .as_deref()
        .and_then(crate::trades::parse_timestamp);

    let outcome = crate::trades::apply_detected_trade_entries(
        &app,
        username.trim(),
        &incoming,
        TRADE_SOURCE_EELOG,
        session_started_at.as_ref(),
    )
    .map_err(|error| error.to_string())?;

    // Ask the ledger what it actually holds rather than trusting the count it returned:
    // `added` counts rows accepted this call, so a row rejected as a duplicate of one stored
    // by an earlier call is indistinguishable from one that was never offered.
    stamp_converted_outcomes_best_effort(&app, username.trim(), &converted);

    Ok(outcome)
}

/// Archives the raw parsed trades. Best-effort: the ledger write is the caller's real job, and
/// a diagnostic-store hiccup must not stop it — but this runs first, so a trade that the ledger
/// then refuses is still recoverable from disk.
fn persist_shadow_trades_best_effort(app: &tauri::AppHandle, trades: &[TradeEvent]) {
    let Ok(connection) = crate::trades::open_trades_cache_database(app) else {
        return;
    };
    if initialize_schema(&connection).is_err() {
        return;
    }
    let Ok(now) = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339)
    else {
        return;
    };
    let _ = record_trades_inner(&connection, trades, &now);
}

/// The row ids one trade would produce, used to ask the ledger whether they landed.
fn trade_row_ids(trade: &TradeEvent) -> Vec<String> {
    trade_log_entries_from_event(trade, &|name| Some((String::new(), name.to_string())))
        .into_iter()
        .map(|entry| entry.id)
        .collect()
}

/// Why a trade produced no rows at all. Mirrors the two early returns in
/// [`trade_log_entries_from_event`], which are the only ways to get here.
fn excluded_trade_outcome(trade: &TradeEvent) -> (TradeIngestStatus, TradeIngestReason) {
    if classify_trade(trade).is_none() {
        // Deliberate: an item-for-item swap has no price. Not a fault, and shown as such.
        return (TradeIngestStatus::NotPriceable, TradeIngestReason::NoPlatinumPrice);
    }
    (TradeIngestStatus::NotLogged, TradeIngestReason::NoTradableItems)
}

fn stamp_outcomes_best_effort<F>(app: &tauri::AppHandle, trades: &[TradeEvent], classify: F)
where
    F: Fn(
        &TradeEvent,
    ) -> (TradeIngestStatus, Option<TradeIngestReason>, Option<String>, usize, usize),
{
    let Ok(connection) = crate::trades::open_trades_cache_database(app) else {
        return;
    };
    if initialize_schema(&connection).is_err() {
        return;
    }
    for trade in trades {
        let (status, reason, detail, expected, logged) = classify(trade);
        let _ = record_ingest_outcome(
            &connection,
            &trade.key,
            status,
            reason,
            detail.as_deref(),
            expected,
            logged,
        );
    }
}

/// Compares each trade's expected rows against what the ledger holds, and stamps the result.
fn stamp_converted_outcomes_best_effort(
    app: &tauri::AppHandle,
    username: &str,
    converted: &[(&TradeEvent, Vec<crate::trades::PortfolioTradeLogEntry>)],
) {
    let Ok(connection) = crate::trades::open_trades_cache_database(app) else {
        return;
    };
    if initialize_schema(&connection).is_err() {
        return;
    }
    let stored: std::collections::HashSet<String> =
        crate::trades::load_stored_trade_log_records_inner(&connection, username)
            .unwrap_or_default()
            .into_iter()
            .map(|record| record.id)
            .collect();

    for (trade, entries) in converted {
        if entries.is_empty() {
            let (status, reason) = excluded_trade_outcome(trade);
            let _ =
                record_ingest_outcome(&connection, &trade.key, status, Some(reason), None, 0, 0);
            continue;
        }

        let expected = entries.len();
        let landed = entries.iter().filter(|entry| stored.contains(&entry.id)).count();

        let (status, reason, detail) = match landed {
            0 => (
                TradeIngestStatus::NotLogged,
                Some(TradeIngestReason::RejectedAsDuplicate),
                Some(missing_row_detail(entries, &stored)),
            ),
            n if n < expected => (
                TradeIngestStatus::PartiallyLogged,
                Some(TradeIngestReason::RejectedAsDuplicate),
                Some(missing_row_detail(entries, &stored)),
            ),
            _ => (TradeIngestStatus::Logged, None, None),
        };

        let _ = record_ingest_outcome(
            &connection,
            &trade.key,
            status,
            reason,
            detail.as_deref(),
            expected,
            landed,
        );
    }
}

/// Names the items whose rows are missing, so the tab can say *which* part of a trade was lost
/// rather than only that something was.
fn missing_row_detail(
    entries: &[crate::trades::PortfolioTradeLogEntry],
    stored: &std::collections::HashSet<String>,
) -> String {
    let missing: Vec<String> = entries
        .iter()
        .filter(|entry| !stored.contains(&entry.id))
        .map(|entry| format!("{} x{}", entry.item_name, entry.quantity))
        .collect();
    missing.join(", ")
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

    /// The schema migration has to be safe on a database created before the outcome columns
    /// existed — that is every user upgrading into this build.
    #[test]
    fn outcome_columns_are_added_to_a_pre_existing_table_and_initialize_is_idempotent() {
        let connection = Connection::open_in_memory().unwrap();
        // The original shape, exactly as it shipped.
        connection
            .execute_batch(
                "CREATE TABLE ee_log_trade_shadow (
                   trade_key TEXT PRIMARY KEY, partner TEXT NOT NULL, occurred_at TEXT,
                   elapsed_s REAL NOT NULL, platinum_in INTEGER NOT NULL,
                   platinum_out INTEGER NOT NULL, items_json TEXT NOT NULL,
                   recorded_at TEXT NOT NULL);",
            )
            .unwrap();

        initialize_schema(&connection).unwrap();
        initialize_schema(&connection).unwrap();

        for column in ["ingest_status", "ingest_reason", "ingest_detail", "expected_rows", "logged_rows"] {
            assert!(shadow_column_exists(&connection, column).unwrap(), "{column} missing");
        }
    }

    /// Rows written before outcomes were tracked must read as "unknown", not as success —
    /// claiming a trade was logged when nobody recorded that is the one answer this tab
    /// cannot give.
    #[test]
    fn a_trade_with_no_recorded_outcome_reads_as_absent_not_logged() {
        let connection = memory_db();
        record_trades_inner(&connection, &[sample_trade("k-old", 10)], "t").unwrap();

        let rows = load_trades_inner(&connection).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].ingest_status, None);
        assert_eq!(rows[0].ingest_reason, None);
    }

    #[test]
    fn an_outcome_round_trips_through_the_store() {
        let connection = memory_db();
        record_trades_inner(&connection, &[sample_trade("k-1", 10)], "t").unwrap();

        record_ingest_outcome(
            &connection,
            "k-1",
            TradeIngestStatus::PartiallyLogged,
            Some(TradeIngestReason::RejectedAsDuplicate),
            Some("Arcane Universal Fallout x2"),
            2,
            1,
        )
        .unwrap();

        let rows = load_trades_inner(&connection).unwrap();
        assert_eq!(rows[0].ingest_status, Some(TradeIngestStatus::PartiallyLogged));
        assert_eq!(rows[0].ingest_reason, Some(TradeIngestReason::RejectedAsDuplicate));
        assert_eq!(rows[0].ingest_detail.as_deref(), Some("Arcane Universal Fallout x2"));
        assert_eq!((rows[0].expected_rows, rows[0].logged_rows), (Some(2), Some(1)));
    }

    /// An unrecognised stored spelling must not fail the whole read — the tab showing every
    /// other trade with one blank status beats the tab showing nothing.
    #[test]
    fn an_unknown_stored_status_reads_as_absent_rather_than_erroring() {
        let connection = memory_db();
        record_trades_inner(&connection, &[sample_trade("k-2", 10)], "t").unwrap();
        connection
            .execute(
                "UPDATE ee_log_trade_shadow SET ingest_status = 'invented' WHERE trade_key = 'k-2'",
                [],
            )
            .unwrap();

        let rows = load_trades_inner(&connection).unwrap();
        assert_eq!(rows.len(), 1, "the row still loads");
        assert_eq!(rows[0].ingest_status, None);
    }

    /// An item-for-item swap is excluded on purpose, so it must read as a deliberate exclusion
    /// rather than as a failure the user should chase.
    #[test]
    fn an_item_for_item_swap_is_reported_as_not_priceable() {
        let trade = trade_of(
            vec![item("Ash Prime Blueprint", 1)],
            vec![item("Mesa Prime Blueprint", 1)],
        );
        assert!(entries_for(&trade).is_empty(), "no rows, as designed");
        assert_eq!(
            excluded_trade_outcome(&trade),
            (TradeIngestStatus::NotPriceable, TradeIngestReason::NoPlatinumPrice),
        );
    }

    /// A priced trade whose only "item" was platinum is a different case from an unpriceable
    /// swap, and is a fault rather than a deliberate exclusion.
    #[test]
    fn a_platinum_only_side_is_reported_as_having_no_tradable_items() {
        let mut trade = trade_of(vec![plat(10)], vec![plat(5)]);
        // Force the classifier to see a buy shape while the getting side holds no goods.
        trade.getting = vec![plat(5)];
        trade.platinum_in = 0;
        let (status, reason) = excluded_trade_outcome(&trade);
        // classify_trade rejects this shape outright, so it reports as unpriceable — the
        // assertion documents which branch actually owns it rather than assuming.
        assert_eq!(status, TradeIngestStatus::NotPriceable);
        assert_eq!(reason, TradeIngestReason::NoPlatinumPrice);
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

    /// End-to-end guard on the reported bug, across both modules: the rows the converter
    /// emits must survive the trade log's dedup with their full quantity intact.
    ///
    /// Kept as one test because neither half is sufficient alone — before the fix the
    /// converter produced two rows (looking correct in isolation) and the dedup then deleted
    /// one of them (also looking correct in isolation). Only the pair shows the data loss.
    #[test]
    fn two_copies_reach_the_trade_log_as_one_row_of_quantity_two() {
        let trade = trade_of(
            vec![plat(10)],
            vec![
                item("Arcane Universal Fallout", 1),
                item("Arcane Universal Fallout", 1),
            ],
        );

        let converted = entries_for(&trade);
        let stored = crate::trades::append_unique_trade_entries_for_test(&[], &converted);

        assert_eq!(stored.len(), 1, "the trade must survive dedup");
        assert_eq!(stored[0].quantity, 2, "both copies, not one");
        let recorded: i64 = stored
            .iter()
            .map(|entry| entry.allocation_total_platinum.unwrap_or(entry.platinum * entry.quantity))
            .sum();
        assert_eq!(recorded, 10, "the full 10p paid, not half of it");
    }

    /// The reported bug: trading two of the same item logged one of them.
    ///
    /// The game prints a line per copy, so this is the shape of the reference log's real
    /// trade. Unmerged it produced two rows of quantity 1 that were identical in every field
    /// the trade-log dedup compares, so the second was discarded as a re-read of the first.
    #[test]
    fn two_copies_of_one_item_become_a_single_row_with_quantity_two() {
        let trade = trade_of(
            vec![plat(10)],
            vec![
                item("Arcane Universal Fallout", 1),
                item("Arcane Universal Fallout", 1),
            ],
        );

        let entries = entries_for(&trade);

        assert_eq!(entries.len(), 1, "two copies are one item, not two rows");
        assert_eq!(entries[0].quantity, 2);
        assert_eq!(entries[0].platinum, 5, "per unit");
        assert_eq!(entries[0].allocation_total_platinum, Some(10));
        assert_eq!(
            entries[0].group_id, None,
            "one distinct item is not a group, however many copies were traded"
        );
    }

    /// Quantities add up rather than the larger one winning, and an explicit `x N` count
    /// merges with bare lines of the same item.
    #[test]
    fn repeated_lines_sum_their_quantities() {
        let trade = trade_of(
            vec![plat(30)],
            vec![item("Forma Blueprint", 3), item("Forma Blueprint", 2)],
        );

        let entries = entries_for(&trade);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].quantity, 5);
        assert_eq!(entries[0].allocation_total_platinum, Some(30));
    }

    /// Rank is part of the merge key: the same arcane at two ranks is two different goods
    /// with different prices, so folding them together would misprice both.
    #[test]
    fn the_same_item_at_different_ranks_does_not_merge() {
        let trade = trade_of(
            vec![plat(100)],
            vec![
                TradedItem {
                    name: "Arcane Energize".to_string(),
                    quantity: 1,
                    rank: Some(0),
                    max_rank: Some(5),
                },
                TradedItem {
                    name: "Arcane Energize".to_string(),
                    quantity: 1,
                    rank: Some(5),
                    max_rank: Some(5),
                },
            ],
        );

        let entries = entries_for(&trade);
        assert_eq!(entries.len(), 2, "different ranks stay separate rows");
        assert_eq!(entries[0].rank, Some(0));
        assert_eq!(entries[1].rank, Some(5));
        assert!(entries[0].group_id.is_some(), "genuinely two items, so a group");
    }

    /// Merging must not disturb a trade that really did contain several distinct items.
    #[test]
    fn distinct_items_still_produce_one_row_each() {
        let trade = trade_of(
            vec![plat(24)],
            vec![
                item("Alternox Prime Blueprint", 1),
                item("Alternox Prime Barrel", 1),
                item("Alternox Prime Barrel", 1),
            ],
        );

        let entries = entries_for(&trade);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].quantity, 1);
        assert_eq!(entries[1].quantity, 2, "the repeated barrel merged");
        let allocated: i64 = entries.iter().filter_map(|e| e.allocation_total_platinum).sum();
        assert_eq!(allocated, 24, "the split still reconciles after merging");
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
            ingest_status: None,
            ingest_reason: None,
            ingest_detail: None,
            expected_rows: None,
            logged_rows: None,
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
            allocation_mode: None,
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
