//! Durable price book — "what is this item actually worth right now", persisted.
//!
//! This exists because `recommended_prices` cannot answer that question. That store is an
//! in-memory `HashMap`, empty on every launch, holding recommended **entry** prices for the
//! items the arbitrage scanner or Analysis happened to touch. It is the right input for the
//! underpriced-listing radar ("what should I pay?") and the wrong one for valuing inventory
//! ("what would I get?"). Both stores stay — they answer different questions, and this module
//! deliberately does not write to the radar's.
//!
//! ## Where the numbers come from
//!
//! Nothing here fetches. `statistics_cache` already holds durable per-item price history that
//! the market tracker and scanner fill in as a side effect of their normal work — on the
//! reference database, 1052 distinct items, versus 40 in `orderbook_snapshots`. So the price
//! book is a **derivation** over data the app already has, not a new source, which is what lets
//! it survive restarts and cover items no scan ran on this session.
//!
//! ## The ladder
//!
//! An exit price is taken from the best available of, in order:
//!
//! 1. **`closed` in the 48-hour domain** — the median of trades that actually completed in the
//!    last two days. The most honest answer there is.
//! 2. **`closed` in the 90-day domain** — same thing, older. On the reference database this is
//!    the tier that takes coverage to 1052/1052.
//! 3. **`live_buy`** — the median standing bid. Not what the item is worth; what someone is
//!    already willing to pay for it today. A deliberate floor, and flagged as such.
//!
//! `live_sell` is **not** in the ladder. Asking prices are what sellers hope for, and on the
//! reference data they run consistently above the closed median (Primed Flow: 50p asked, 23p
//! traded). Valuing a user's inventory off asks would inflate every total in the app.
//!
//! The tier is carried out to the UI as `basis` rather than being flattened into one number,
//! because "23p, from trades in the last 2 days" and "23p, because someone bid it" deserve to
//! read differently.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Which rung of the ladder a price came from. Ordered weakest-last, and surfaced to the UI so
/// a bid-derived number is never presented with the same confidence as a traded one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PriceBasis {
    /// Median of trades closed in the last 48 hours.
    RecentTrades,
    /// Median of closed trades across the 90-day window.
    HistoricalTrades,
    /// Median standing buy order — a floor, not a valuation.
    StandingBids,
}

impl PriceBasis {
    /// Stored as text so the table stays readable in a SQLite browser during debugging.
    fn as_str(self) -> &'static str {
        match self {
            PriceBasis::RecentTrades => "recentTrades",
            PriceBasis::HistoricalTrades => "historicalTrades",
            PriceBasis::StandingBids => "standingBids",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "recentTrades" => Some(PriceBasis::RecentTrades),
            "historicalTrades" => Some(PriceBasis::HistoricalTrades),
            "standingBids" => Some(PriceBasis::StandingBids),
            _ => None,
        }
    }
}

/// One observation off a single rung, before the ladder picks between them.
#[derive(Debug, Clone, PartialEq)]
pub struct PriceSample {
    pub price: f64,
    /// Trade count (closed rungs) or order count (bid rung) behind the median — carried through
    /// so the UI can distinguish a price set by 24 trades from one set by a single trade.
    pub volume: f64,
    /// Bucket timestamp the sample was observed at, ISO-8601 as stored.
    pub observed_at: String,
}

/// The rungs for one (item, variant), any or all of which may be missing.
///
/// The first three come from `statistics_cache` (Warframe.Market, fetched when the user opens an
/// item or runs a scan). The last two come from `price_history_daily` (WSHistory, refreshed
/// daily, covering every item in the game).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PriceSamples {
    pub closed_recent: Option<PriceSample>,
    pub closed_historical: Option<PriceSample>,
    pub standing_bid: Option<PriceSample>,
    /// Newest `closed` row from the bulk daily history.
    pub history_closed: Option<PriceSample>,
    /// Newest `buy` row from the bulk daily history.
    pub history_bid: Option<PriceSample>,
}

/// A resolved price: one number, plus enough provenance to defend it.
#[derive(Debug, Clone, PartialEq)]
pub struct DerivedPrice {
    pub exit_price: f64,
    pub basis: PriceBasis,
    pub sample_volume: f64,
    pub observed_at: String,
}

/// A sample only counts if its price is a number you could actually trade at. Zero and negative
/// medians do occur in the cache (an empty bucket serialises as 0.0), and letting one through
/// would price an item at 0p rather than falling to the next rung.
fn usable(sample: &Option<PriceSample>) -> Option<&PriceSample> {
    sample
        .as_ref()
        .filter(|sample| sample.price.is_finite() && sample.price > 0.0)
        .filter(|sample| sample.volume.is_finite() && sample.volume >= 0.0)
}

/// Picks the price. Pure, and the whole reason the derivation lives in Rust instead of being
/// buried in the rebuild's SQL — the choice is the part with judgement in it, so it is the part
/// that gets tests.
///
/// ## Actual trades beat bids; within each, the freshest observation wins
///
/// The obvious rule would be "live source first, bulk history as a fallback". Measured against a
/// real database, that is wrong: `statistics_cache` is only refilled when the user opens an item
/// or runs a scan, so its rows were 7–30 days old for 1,033 of 1,051 items, with none under two
/// days. `price_history_daily` refreshes daily and is at most ~2 days behind. Preferring the
/// "live" table by name would routinely serve a nine-day-old price over yesterday's.
///
/// So sources are not ranked. Every `closed` sample competes on its observation date, and only
/// if none exists do the bids compete the same way. Live data still wins whenever it genuinely
/// is fresher, which is what "live first" was reaching for.
///
/// Ties go to `statistics_cache`, which buckets hourly rather than daily and is therefore the
/// finer-grained reading of the same day.
pub fn derive_exit_price(samples: &PriceSamples) -> Option<DerivedPrice> {
    // Ordered so that, at equal observation dates, the earlier entry wins.
    let traded = [
        (PriceBasis::RecentTrades, usable(&samples.closed_recent)),
        (PriceBasis::HistoricalTrades, usable(&samples.closed_historical)),
        (PriceBasis::HistoricalTrades, usable(&samples.history_closed)),
    ];
    if let Some(best) = freshest(traded) {
        return Some(best);
    }

    // Nothing has actually traded — fall back to what someone is offering to pay. Still the
    // freshest such offer, and reported as a bid so the UI can mark it a floor.
    freshest([
        (PriceBasis::StandingBids, usable(&samples.standing_bid)),
        (PriceBasis::StandingBids, usable(&samples.history_bid)),
    ])
}

/// The most recently observed of a set of candidates, `None` if all are absent.
///
/// Compared on the **calendar day only**. The two sources spell their timestamps differently —
/// `statistics_cache` stores a full `2026-08-07T21:00:00Z`, `price_history_daily` a bare
/// `2026-08-16` — and a plain string comparison across those would be deciding on formatting as
/// much as on time. Taking the first ten characters compares like with like.
///
/// Within one day the candidates tie, and the tie is broken by argument order, which is how the
/// caller expresses "prefer the hourly source over the daily one".
fn freshest<const N: usize>(
    candidates: [(PriceBasis, Option<&PriceSample>); N],
) -> Option<DerivedPrice> {
    candidates
        .into_iter()
        .filter_map(|(basis, sample)| sample.map(|sample| (basis, sample)))
        // `max_by_key` keeps the *last* maximum; reversing the key and taking the minimum keeps
        // the first, so the documented tie-break holds rather than depending on iteration order.
        .min_by_key(|(_, sample)| {
            std::cmp::Reverse(sample.observed_at.chars().take(10).collect::<String>())
        })
        .map(|(basis, sample)| DerivedPrice {
            exit_price: sample.price,
            basis,
            sample_volume: sample.volume,
            observed_at: sample.observed_at.clone(),
        })
}

/// Created here rather than in the migration module's `create_new_schema`: the price book is
/// purely derived and rebuildable from `statistics_cache`, so it needs none of the identity
/// re-keying that module exists to perform, and adding it to those table lists would put a
/// 17th entry into counts the migration's own tests assert on.
pub(crate) fn ensure_price_book_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "
        CREATE TABLE IF NOT EXISTS price_book (
          item_key TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          slug TEXT NOT NULL,
          exit_price REAL NOT NULL,
          basis TEXT NOT NULL,
          sample_volume REAL NOT NULL,
          observed_at TEXT NOT NULL,
          refreshed_at TEXT NOT NULL,
          PRIMARY KEY (item_key, variant_key)
        );
        ",
        )
        .context("failed to create the price_book table")
}

/// The latest sample per (item, variant, rung) from both sources, pivoted to one row per item so
/// the derivation sees every rung together.
///
/// `ROW_NUMBER` rather than `MAX(bucket_at)` throughout, because the price has to come from the
/// *same row* as the timestamp it is reported with.
///
/// The two sources are **unioned, not joined**: `statistics_cache` holds ~1,050 items (only what
/// the user opened or scanned) while `price_history_daily` holds ~3,800 (the whole game). A join
/// from either side would silently drop the items only the other one knows — which is the entire
/// coverage problem this feature exists to fix. `keys` is therefore the union of both key spaces,
/// with both sources left-joined onto it.
///
/// `slug` comes only from `statistics_cache`; history rows carry an `item_key` but no slug, so
/// an item known only to history stores an empty one. Nothing reads that field — the app keys on
/// (item_key, variant_key) — and resolving it would mean opening the catalogue here purely to
/// populate something unused.
const LATEST_SAMPLES_SQL: &str = "
    WITH stats_ranked AS (
      SELECT item_key, variant_key, slug, domain_key, source_kind,
             median, volume, bucket_at,
             ROW_NUMBER() OVER (
               PARTITION BY item_key, variant_key, domain_key, source_kind
               ORDER BY bucket_at DESC
             ) AS rn
      FROM statistics_cache
      WHERE source_kind IN ('closed', 'live_buy')
    ),
    stats AS (
      SELECT
        item_key,
        variant_key,
        MAX(slug) AS slug,
        MAX(CASE WHEN domain_key = '48hours' AND source_kind = 'closed' THEN median END) AS c48_median,
        MAX(CASE WHEN domain_key = '48hours' AND source_kind = 'closed' THEN volume END) AS c48_volume,
        MAX(CASE WHEN domain_key = '48hours' AND source_kind = 'closed' THEN bucket_at END) AS c48_at,
        MAX(CASE WHEN domain_key = '90days' AND source_kind = 'closed' THEN median END) AS c90_median,
        MAX(CASE WHEN domain_key = '90days' AND source_kind = 'closed' THEN volume END) AS c90_volume,
        MAX(CASE WHEN domain_key = '90days' AND source_kind = 'closed' THEN bucket_at END) AS c90_at,
        MAX(CASE WHEN source_kind = 'live_buy' THEN median END) AS bid_median,
        MAX(CASE WHEN source_kind = 'live_buy' THEN volume END) AS bid_volume,
        MAX(CASE WHEN source_kind = 'live_buy' THEN bucket_at END) AS bid_at
      FROM stats_ranked
      WHERE rn = 1
      GROUP BY item_key, variant_key
    ),
    hist_ranked AS (
      SELECT item_key, variant_key, order_type, median, volume, day,
             ROW_NUMBER() OVER (
               PARTITION BY item_key, variant_key, order_type
               ORDER BY day DESC
             ) AS rn
      FROM price_history_daily
    ),
    hist AS (
      SELECT
        item_key,
        variant_key,
        MAX(CASE WHEN order_type = 'closed' THEN median END) AS h_closed_median,
        MAX(CASE WHEN order_type = 'closed' THEN volume END) AS h_closed_volume,
        MAX(CASE WHEN order_type = 'closed' THEN day END) AS h_closed_at,
        MAX(CASE WHEN order_type = 'buy' THEN median END) AS h_bid_median,
        MAX(CASE WHEN order_type = 'buy' THEN volume END) AS h_bid_volume,
        MAX(CASE WHEN order_type = 'buy' THEN day END) AS h_bid_at
      FROM hist_ranked
      WHERE rn = 1
      GROUP BY item_key, variant_key
    ),
    keys AS (
      SELECT item_key, variant_key FROM stats
      UNION
      SELECT item_key, variant_key FROM hist
    )
    SELECT
      keys.item_key,
      keys.variant_key,
      COALESCE(stats.slug, ''),
      stats.c48_median, stats.c48_volume, stats.c48_at,
      stats.c90_median, stats.c90_volume, stats.c90_at,
      stats.bid_median, stats.bid_volume, stats.bid_at,
      hist.h_closed_median, hist.h_closed_volume, hist.h_closed_at,
      hist.h_bid_median, hist.h_bid_volume, hist.h_bid_at
    FROM keys
    LEFT JOIN stats ON stats.item_key = keys.item_key AND stats.variant_key = keys.variant_key
    LEFT JOIN hist ON hist.item_key = keys.item_key AND hist.variant_key = keys.variant_key
    WHERE 1 = 1
";

/// One item's samples as read back out of the pivot above.
struct SampledItem {
    item_key: String,
    variant_key: String,
    slug: String,
    samples: PriceSamples,
}

fn sample_from_columns(
    price: Option<f64>,
    volume: Option<f64>,
    observed_at: Option<String>,
) -> Option<PriceSample> {
    // All three must be present together: a price with no timestamp cannot be aged, and the
    // UI states an "as of" next to every number.
    Some(PriceSample { price: price?, volume: volume.unwrap_or(0.0), observed_at: observed_at? })
}

fn read_sampled_items(connection: &Connection, filter: Option<(&str, &str)>) -> Result<Vec<SampledItem>> {
    let (sql, bound): (String, Vec<String>) = match filter {
        Some((item_key, variant_key)) => (
            format!("{LATEST_SAMPLES_SQL} AND keys.item_key = ?1 AND keys.variant_key = ?2"),
            vec![item_key.to_string(), variant_key.to_string()],
        ),
        None => (LATEST_SAMPLES_SQL.to_string(), Vec::new()),
    };

    let mut statement = connection.prepare(&sql).context("failed to prepare the price sample query")?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(bound.iter()), |row| {
            Ok(SampledItem {
                item_key: row.get(0)?,
                variant_key: row.get(1)?,
                slug: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                samples: PriceSamples {
                    closed_recent: sample_from_columns(row.get(3)?, row.get(4)?, row.get(5)?),
                    closed_historical: sample_from_columns(row.get(6)?, row.get(7)?, row.get(8)?),
                    standing_bid: sample_from_columns(row.get(9)?, row.get(10)?, row.get(11)?),
                    history_closed: sample_from_columns(row.get(12)?, row.get(13)?, row.get(14)?),
                    history_bid: sample_from_columns(row.get(15)?, row.get(16)?, row.get(17)?),
                },
            })
        })
        .context("failed to read price samples")?;

    Ok(rows.flatten().collect())
}

fn upsert_price(
    connection: &Connection,
    item: &SampledItem,
    price: &DerivedPrice,
    refreshed_at: &str,
) -> Result<()> {
    connection
        .execute(
            "INSERT INTO price_book (
               item_key, variant_key, slug, exit_price, basis, sample_volume, observed_at, refreshed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(item_key, variant_key) DO UPDATE SET
               slug = excluded.slug,
               exit_price = excluded.exit_price,
               basis = excluded.basis,
               sample_volume = excluded.sample_volume,
               observed_at = excluded.observed_at,
               refreshed_at = excluded.refreshed_at",
            params![
                item.item_key,
                item.variant_key,
                item.slug,
                price.exit_price,
                price.basis.as_str(),
                price.sample_volume,
                price.observed_at,
                refreshed_at,
            ],
        )
        .context("failed to write a price book row")?;
    Ok(())
}

/// `refreshed_at` is bookkeeping — when we last recomputed, never shown as a price's age — so an
/// unformattable clock falls back to an empty string rather than failing the rebuild.
fn now_iso() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
}

/// Rebuilds the whole book from `statistics_cache`. Cheap enough to run at startup — one
/// indexed pass over the cache — and idempotent, so a partial previous run costs nothing.
///
/// Rows whose samples have gone are **left in place** rather than deleted. A stale price with an
/// honest `observed_at` beats an empty value slot, and `statistics_cache` is pruned on its own
/// schedule for reasons that have nothing to do with an item having stopped being worth
/// something.
pub(crate) fn rebuild_price_book(connection: &Connection) -> Result<usize> {
    ensure_price_book_schema(connection)?;
    // The sample query unions bulk history in, so its table must exist even on an install that
    // has never ingested a day.
    crate::price_history::ensure_schema(connection)?;
    let items = read_sampled_items(connection, None)?;
    let refreshed_at = now_iso();

    connection.execute_batch("BEGIN")?;
    let mut written = 0usize;
    for item in &items {
        let Some(price) = derive_exit_price(&item.samples) else {
            continue;
        };
        if let Err(error) = upsert_price(connection, item, &price, &refreshed_at) {
            let _ = connection.execute_batch("ROLLBACK");
            return Err(error);
        }
        written += 1;
    }
    connection.execute_batch("COMMIT")?;

    Ok(written)
}

/// Refreshes exactly one (item, variant) — called right after that item's statistics are
/// written, so the book tracks the tracker instead of waiting for the next full rebuild.
/// Best-effort by contract: a failure here must never fail the statistics write that triggered
/// it, so callers discard the result.
pub(crate) fn refresh_price_book_entry(
    connection: &Connection,
    item_key: &str,
    variant_key: &str,
) -> Result<bool> {
    ensure_price_book_schema(connection)?;
    let items = read_sampled_items(connection, Some((item_key, variant_key)))?;
    let refreshed_at = now_iso();

    for item in &items {
        if let Some(price) = derive_exit_price(&item.samples) {
            upsert_price(connection, item, &price, &refreshed_at)?;
            return Ok(true);
        }
    }
    Ok(false)
}

/// One row as it crosses the Tauri bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceBookEntry {
    pub item_key: String,
    pub variant_key: String,
    pub slug: String,
    /// Platinum a holder could realistically expect to receive for one unit.
    pub exit_price: f64,
    pub basis: PriceBasis,
    pub sample_volume: f64,
    /// When the underlying market observation was made — not when we last recomputed.
    pub observed_at: String,
}

pub(crate) fn load_price_book(connection: &Connection) -> Result<Vec<PriceBookEntry>> {
    ensure_price_book_schema(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT item_key, variant_key, slug, exit_price, basis, sample_volume, observed_at
             FROM price_book",
        )
        .context("failed to prepare the price book read")?;

    let rows = statement
        .query_map([], |row| {
            let basis: String = row.get(4)?;
            Ok((
                PriceBookEntry {
                    item_key: row.get(0)?,
                    variant_key: row.get(1)?,
                    slug: row.get(2)?,
                    exit_price: row.get(3)?,
                    // Placeholder overwritten below; `basis` is validated outside the row
                    // closure because an unknown string is a skip, not a SQLite error.
                    basis: PriceBasis::StandingBids,
                    sample_volume: row.get(5)?,
                    observed_at: row.get(6)?,
                },
                basis,
            ))
        })
        .context("failed to read the price book")?;

    Ok(rows
        .flatten()
        .filter_map(|(entry, basis)| {
            PriceBasis::from_str(&basis).map(|basis| PriceBookEntry { basis, ..entry })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(price: f64, volume: f64) -> Option<PriceSample> {
        Some(PriceSample { price, volume, observed_at: "2026-08-07T21:00:00Z".to_string() })
    }

    fn dated(price: f64, volume: f64, observed_at: &str) -> Option<PriceSample> {
        Some(PriceSample { price, volume, observed_at: observed_at.to_string() })
    }

    /// The whole feature, end to end: ingest real bulk history, rebuild, and count how many
    /// items come out priced. Ignored by default because it needs the network.
    ///
    /// `cargo test price_book_coverage -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the network"]
    fn price_book_coverage_with_real_history() {
        let mut connection = statistics_fixture();

        // A handful of statistics rows, standing in for items the user actually opened.
        insert_stat(&connection, "mesa_prime_set", "48hours", "closed", "2026-08-07T21:00:00Z", 70.0, 7.0);
        let before = rebuild_price_book(&connection).expect("rebuild without history");

        let ingested = crate::price_history::ingest(&mut connection).expect("ingest");
        let after = rebuild_price_book(&connection).expect("rebuild with history");

        println!("history: {} days, {} rows", ingested.days_added, ingested.rows_added);
        println!("price book: {before} priced before, {after} after");

        let book = load_price_book(&connection).expect("read");
        let bids = book.iter().filter(|e| e.basis == PriceBasis::StandingBids).count();
        println!(
            "  traded {} / bid-floor {} ({:.0}% from real trades)",
            book.len() - bids,
            bids,
            100.0 * (book.len() - bids) as f64 / book.len() as f64
        );

        assert!(after > before, "history must add coverage");
        assert!(after > 3_000, "expected whole-game coverage, got {after}");
        assert!(book.iter().all(|entry| entry.exit_price > 0.0), "no zero prices");
    }

    /// The measured reality this whole design turns on: `statistics_cache` is only refilled when
    /// the user opens an item, so its "live" rows were 7–30 days old for 1,033 of 1,051 items,
    /// while bulk history is at most ~2 days behind. Ranking by source would serve the stale one.
    #[test]
    fn fresher_bulk_history_beats_a_stale_live_statistic() {
        let derived = derive_exit_price(&PriceSamples {
            closed_recent: dated(70.0, 20.0, "2026-08-07T21:00:00Z"),
            history_closed: dated(88.0, 9.0, "2026-08-16"),
            ..Default::default()
        })
        .expect("a price");

        assert_eq!(derived.exit_price, 88.0, "yesterday's trade beats one from nine days ago");
        assert_eq!(derived.observed_at, "2026-08-16");
    }

    /// ...and the converse, which is what "live first" was actually reaching for.
    #[test]
    fn fresher_live_statistic_beats_older_history() {
        let derived = derive_exit_price(&PriceSamples {
            closed_recent: dated(70.0, 20.0, "2026-08-16T21:00:00Z"),
            history_closed: dated(88.0, 9.0, "2026-08-10"),
            ..Default::default()
        })
        .expect("a price");

        assert_eq!(derived.exit_price, 70.0);
        assert_eq!(derived.basis, PriceBasis::RecentTrades);
    }

    /// Same calendar day: the hourly source is the finer-grained reading, so it wins.
    #[test]
    fn on_the_same_day_the_hourly_source_wins() {
        let derived = derive_exit_price(&PriceSamples {
            closed_recent: dated(70.0, 20.0, "2026-08-16T21:00:00Z"),
            history_closed: dated(88.0, 9.0, "2026-08-16"),
            ..Default::default()
        })
        .expect("a price");

        assert_eq!(
            derived.exit_price, 70.0,
            "a full timestamp and a bare date on one day must not be compared as strings",
        );
    }

    /// A real trade outranks a bid regardless of age — a bid is what someone hopes to pay, and
    /// promoting a fresh one over an actual sale would overstate nothing but understate plenty.
    #[test]
    fn a_stale_trade_still_beats_a_fresh_bid() {
        let derived = derive_exit_price(&PriceSamples {
            history_closed: dated(88.0, 9.0, "2026-07-20"),
            standing_bid: dated(46.0, 2229.0, "2026-08-16T21:00:00Z"),
            ..Default::default()
        })
        .expect("a price");

        assert_eq!(derived.exit_price, 88.0);
        assert_eq!(derived.basis, PriceBasis::HistoricalTrades);
    }

    /// The long tail: an item that has not traded in the window at all still gets a floor from
    /// the bulk history's bids, which is the coverage bid data was included for.
    #[test]
    fn history_bids_price_items_that_never_traded() {
        let derived = derive_exit_price(&PriceSamples {
            history_bid: dated(12.0, 30.0, "2026-08-16"),
            ..Default::default()
        })
        .expect("a price");

        assert_eq!(derived.exit_price, 12.0);
        assert_eq!(derived.basis, PriceBasis::StandingBids);
    }

    #[test]
    fn the_freshest_bid_wins_when_nothing_traded() {
        let derived = derive_exit_price(&PriceSamples {
            standing_bid: dated(46.0, 10.0, "2026-08-07T21:00:00Z"),
            history_bid: dated(12.0, 30.0, "2026-08-16"),
            ..Default::default()
        })
        .expect("a price");

        assert_eq!(derived.exit_price, 12.0, "the newer bid, even though it is lower");
    }

    #[test]
    fn prefers_recent_trades_over_every_other_rung() {
        let derived = derive_exit_price(&PriceSamples {
            closed_recent: sample(70.0, 20.0),
            closed_historical: sample(65.0, 900.0),
            standing_bid: sample(46.0, 2229.0),
            ..Default::default()
        })
        .expect("a price");
        assert_eq!(derived.exit_price, 70.0);
        assert_eq!(derived.basis, PriceBasis::RecentTrades);
        // Volume travels with the chosen rung, not the largest one.
        assert_eq!(derived.sample_volume, 20.0);
    }

    #[test]
    fn falls_through_to_history_then_to_bids() {
        let history = derive_exit_price(&PriceSamples {
            closed_historical: sample(65.0, 900.0),
            standing_bid: sample(46.0, 2229.0),
            ..Default::default()
        })
        .expect("a price");
        assert_eq!(history.basis, PriceBasis::HistoricalTrades);
        assert_eq!(history.exit_price, 65.0);

        let bids = derive_exit_price(&PriceSamples {
            standing_bid: sample(46.0, 2229.0),
            ..Default::default()
        })
        .expect("a price");
        assert_eq!(bids.basis, PriceBasis::StandingBids);
        assert_eq!(bids.exit_price, 46.0);
    }

    #[test]
    fn no_samples_yields_no_price_rather_than_zero() {
        assert!(derive_exit_price(&PriceSamples::default()).is_none());
    }

    #[test]
    fn unusable_rungs_are_skipped_not_taken_as_zero() {
        // An empty 48h bucket serialises as a 0.0 median. Taking it would price the item at 0p;
        // the ladder must step past it to the rung that has a real number.
        for bad in [0.0, -5.0, f64::NAN, f64::INFINITY] {
            let derived = derive_exit_price(&PriceSamples {
                closed_recent: sample(bad, 3.0),
                closed_historical: sample(65.0, 900.0),
                ..Default::default()
            })
            .expect("a price");
            assert_eq!(derived.basis, PriceBasis::HistoricalTrades, "for median {bad}");
            assert_eq!(derived.exit_price, 65.0);
        }
    }

    #[test]
    fn zero_volume_is_kept_but_broken_volume_is_not() {
        // Zero trades with a real median is a legitimate live_buy state; NaN is corruption.
        let zero = derive_exit_price(&PriceSamples {
            closed_recent: sample(70.0, 0.0),
            ..Default::default()
        })
        .expect("a price");
        assert_eq!(zero.exit_price, 70.0);

        let broken = derive_exit_price(&PriceSamples {
            closed_recent: sample(70.0, f64::NAN),
            closed_historical: sample(65.0, 4.0),
            ..Default::default()
        })
        .expect("a price");
        assert_eq!(broken.basis, PriceBasis::HistoricalTrades);
    }

    #[test]
    fn basis_round_trips_through_its_stored_spelling() {
        for basis in [
            PriceBasis::RecentTrades,
            PriceBasis::HistoricalTrades,
            PriceBasis::StandingBids,
        ] {
            assert_eq!(PriceBasis::from_str(basis.as_str()), Some(basis));
        }
        assert_eq!(PriceBasis::from_str("liveSell"), None);
    }

    /// An in-memory database standing in for `statistics_cache`, carrying only the columns the
    /// pivot reads.
    fn statistics_fixture() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db");
        connection
            .execute_batch(
                "CREATE TABLE statistics_cache (
                   item_key TEXT NOT NULL, slug TEXT NOT NULL, variant_key TEXT NOT NULL,
                   domain_key TEXT NOT NULL, source_kind TEXT NOT NULL,
                   bucket_at TEXT NOT NULL, volume REAL NOT NULL, median REAL
                 );",
            )
            .expect("schema");
        // The sample query unions both sources, so the history table has to exist even when a
        // test only exercises statistics.
        crate::price_history::ensure_schema(&connection).expect("history schema");
        connection
    }

    fn insert_stat(
        connection: &Connection,
        slug: &str,
        domain: &str,
        kind: &str,
        bucket_at: &str,
        median: f64,
        volume: f64,
    ) {
        connection
            .execute(
                "INSERT INTO statistics_cache
                   (item_key, slug, variant_key, domain_key, source_kind, bucket_at, volume, median)
                 VALUES (?1, ?2, 'base', ?3, ?4, ?5, ?6, ?7)",
                params![format!("key-{slug}"), slug, domain, kind, bucket_at, volume, median],
            )
            .expect("insert");
    }

    #[test]
    fn rebuild_takes_the_newest_bucket_and_stores_its_own_timestamp() {
        let connection = statistics_fixture();
        // Two 48h closed buckets: the older one is the trap. The stored price and the stored
        // observed_at must come from the same (newest) row.
        insert_stat(&connection, "mesa_prime_set", "48hours", "closed", "2026-08-06T21:00:00Z", 55.0, 3.0);
        insert_stat(&connection, "mesa_prime_set", "48hours", "closed", "2026-08-07T21:00:00Z", 70.0, 7.0);
        insert_stat(&connection, "mesa_prime_set", "48hours", "live_buy", "2026-08-07T21:00:00Z", 47.5, 2229.0);

        let written = rebuild_price_book(&connection).expect("rebuild");
        assert_eq!(written, 1);

        let book = load_price_book(&connection).expect("read");
        assert_eq!(book.len(), 1);
        assert_eq!(book[0].slug, "mesa_prime_set");
        assert_eq!(book[0].exit_price, 70.0);
        assert_eq!(book[0].sample_volume, 7.0);
        assert_eq!(book[0].observed_at, "2026-08-07T21:00:00Z");
        assert_eq!(book[0].basis, PriceBasis::RecentTrades);
    }

    #[test]
    fn rebuild_uses_ninety_day_history_when_there_are_no_recent_trades() {
        let connection = statistics_fixture();
        insert_stat(&connection, "quiet_item", "90days", "closed", "2026-07-01T00:00:00Z", 12.0, 4.0);
        insert_stat(&connection, "quiet_item", "48hours", "live_buy", "2026-08-07T21:00:00Z", 8.0, 11.0);

        rebuild_price_book(&connection).expect("rebuild");
        let book = load_price_book(&connection).expect("read");
        assert_eq!(book.len(), 1);
        assert_eq!(book[0].exit_price, 12.0);
        assert_eq!(book[0].basis, PriceBasis::HistoricalTrades);
    }

    #[test]
    fn live_sell_alone_never_produces_a_price() {
        // Asks are excluded on purpose — valuing inventory off them would inflate every total.
        let connection = statistics_fixture();
        insert_stat(&connection, "asked_only", "48hours", "live_sell", "2026-08-07T21:00:00Z", 999.0, 5.0);

        assert_eq!(rebuild_price_book(&connection).expect("rebuild"), 0);
        assert!(load_price_book(&connection).expect("read").is_empty());
    }

    #[test]
    fn rebuild_is_idempotent_and_refreshes_in_place() {
        let connection = statistics_fixture();
        insert_stat(&connection, "mesa_prime_set", "48hours", "closed", "2026-08-07T21:00:00Z", 70.0, 7.0);
        rebuild_price_book(&connection).expect("first");
        rebuild_price_book(&connection).expect("second");
        assert_eq!(load_price_book(&connection).expect("read").len(), 1);

        // A newer bucket moves the price rather than adding a second row.
        insert_stat(&connection, "mesa_prime_set", "48hours", "closed", "2026-08-08T21:00:00Z", 82.0, 9.0);
        rebuild_price_book(&connection).expect("third");
        let book = load_price_book(&connection).expect("read");
        assert_eq!(book.len(), 1);
        assert_eq!(book[0].exit_price, 82.0);
    }

    #[test]
    fn a_vanished_sample_leaves_the_last_known_price_standing() {
        let connection = statistics_fixture();
        insert_stat(&connection, "mesa_prime_set", "48hours", "closed", "2026-08-07T21:00:00Z", 70.0, 7.0);
        rebuild_price_book(&connection).expect("rebuild");

        connection.execute("DELETE FROM statistics_cache", []).expect("prune");
        assert_eq!(rebuild_price_book(&connection).expect("rebuild"), 0);

        let book = load_price_book(&connection).expect("read");
        assert_eq!(book.len(), 1, "a pruned cache must not blank the value slot");
        assert_eq!(book[0].observed_at, "2026-08-07T21:00:00Z");
    }

    #[test]
    fn single_entry_refresh_touches_only_its_own_item() {
        let connection = statistics_fixture();
        insert_stat(&connection, "mesa_prime_set", "48hours", "closed", "2026-08-07T21:00:00Z", 70.0, 7.0);
        insert_stat(&connection, "wisp_prime_set", "48hours", "closed", "2026-08-07T21:00:00Z", 70.0, 20.0);
        rebuild_price_book(&connection).expect("rebuild");

        insert_stat(&connection, "mesa_prime_set", "48hours", "closed", "2026-08-08T21:00:00Z", 88.0, 9.0);
        insert_stat(&connection, "wisp_prime_set", "48hours", "closed", "2026-08-08T21:00:00Z", 99.0, 9.0);
        assert!(refresh_price_book_entry(&connection, "key-mesa_prime_set", "base").expect("refresh"));

        let book = load_price_book(&connection).expect("read");
        let price_of = |slug: &str| {
            book.iter().find(|entry| entry.slug == slug).expect("present").exit_price
        };
        assert_eq!(price_of("mesa_prime_set"), 88.0);
        assert_eq!(price_of("wisp_prime_set"), 70.0, "untouched item must not move");
    }

    #[test]
    fn refresh_reports_false_when_the_item_has_no_usable_rung() {
        let connection = statistics_fixture();
        insert_stat(&connection, "asked_only", "48hours", "live_sell", "2026-08-07T21:00:00Z", 999.0, 5.0);
        assert!(!refresh_price_book_entry(&connection, "key-asked_only", "base").expect("refresh"));
    }
}
