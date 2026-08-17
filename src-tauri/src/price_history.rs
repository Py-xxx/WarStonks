//! Bulk daily price history for **every** item in the game, ingested from WSHistory.
//!
//! ## Why this exists
//!
//! The arbitrage scanner only ever collected statistics for items it happened to walk, so
//! coverage was whatever the user had scanned — around 1,050 of 3,837 items, and biased toward
//! sets. That is why most mods and arcanes show no price in the inventory.
//!
//! [WSHistory](https://github.com/Py-xxx/WSHistory) republishes relics.run's daily archive in a
//! pre-filtered, pre-compressed form: one ~136 KiB file per UTC day covering the whole game.
//! Thirty days is ~4 MB, against ~117 MB fetching relics.run directly.
//!
//! ## What this is *not*
//!
//! Not a replacement for `statistics_cache`. The two are deliberately opposite shapes:
//!
//! | | `statistics_cache` | `price_history_daily` |
//! |---|---|---|
//! | Source | Warframe.Market, live | WSHistory (relics.run) |
//! | Granularity | hourly, last 48h | daily |
//! | Coverage | only items the user opened | every item in the game |
//! | Answers | "what is it worth *now*" | "what has it been worth" |
//!
//! They never cover the same key space — this table stops at yesterday, live statistics own
//! today — so there is no dedup to get wrong. That separation is the whole point: merging them
//! into one table would mean two provenances colliding on one key.
//!
//! ## Only `closed` and `buy`
//!
//! `closed` is what people actually paid. `buy` is a standing offer, kept as a floor for items
//! that trade rarely. `sell` is excluded upstream — an asking price is what a seller hopes for,
//! nobody has to accept it, and it is where 999p troll listings live.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;

/// The published index. Overridable for testing against a local copy.
const MANIFEST_URL: &str =
    "https://github.com/Py-xxx/WSHistory/releases/download/manifest/manifest.json";
const MANIFEST_URL_ENV: &str = "WARSTONKS_WSHISTORY_MANIFEST";

/// The format this build understands. A file declaring anything else is refused rather than
/// guessed at — see `docs/FORMAT.md` in WSHistory.
const SUPPORTED_SCHEMA: i64 = 1;

/// How many days to pull in one pass. The publisher keeps a rolling 30, so this is really a
/// bound on a *first* run; later runs have at most a day or two outstanding.
const MAX_DAYS_PER_INGEST: usize = 30;

const META_MANIFEST_ETAG: &str = "wshistory_manifest_etag";
const META_LAST_INGEST_AT: &str = "wshistory_last_ingest_at";

// ── schema ──────────────────────────────────────────────────────────────────────────────────

pub(crate) fn ensure_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "
        CREATE TABLE IF NOT EXISTS price_history_daily (
          item_key TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          order_type TEXT NOT NULL,
          day TEXT NOT NULL,

          -- The upstream dimensions are kept alongside the derived `variant_key` so the
          -- mapping can be changed later without re-downloading history. `variant_key` is a
          -- convenience for joining to the rest of the app; these are the source of truth.
          mod_rank INTEGER,
          subtype TEXT,
          amber_stars INTEGER,
          cyan_stars INTEGER,

          volume REAL NOT NULL,
          min_price REAL,
          max_price REAL,
          open_price REAL,
          closed_price REAL,
          avg_price REAL,
          wa_price REAL,
          median REAL,
          moving_avg REAL,
          donch_top REAL,
          donch_bot REAL,

          -- Ordered for the query that actually runs: 'the newest closed row for this item and
          -- variant'. Putting `order_type` before `day` makes that a prefix scan ending at the
          -- first row, rather than a filter over every day we hold.
          PRIMARY KEY (item_key, variant_key, order_type, day)
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS price_history_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        ",
        )
        .context("failed to create the price history schema")?;

    // Resolution of a row: 1 = one day as published, 7 = a week folded together by retention.
    // Added by ALTER so a database written before retention existed upgrades in place, with the
    // default correctly describing every row already in it.
    let has_bucket_days: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('price_history_daily') WHERE name = 'bucket_days'",
            [],
            |row| row.get(0),
        )
        .context("failed to inspect the price history table")?;
    if has_bucket_days == 0 {
        connection
            .execute(
                "ALTER TABLE price_history_daily ADD COLUMN bucket_days INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .context("failed to add bucket_days to the price history table")?;
    }

    Ok(())
}

fn read_meta(connection: &Connection, key: &str) -> Option<String> {
    connection
        .query_row("SELECT value FROM price_history_meta WHERE key = ?1", params![key], |row| {
            row.get::<_, String>(0)
        })
        .ok()
}

fn write_meta(connection: &Connection, key: &str, value: &str) -> Result<()> {
    connection
        .execute(
            "INSERT INTO price_history_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .context("failed to write price history metadata")?;
    Ok(())
}

// ── variant mapping ─────────────────────────────────────────────────────────────────────────

/// Collapses the upstream variant dimensions into this app's `variant_key`.
///
/// Upstream carries four: `mod_rank`, `subtype`, and the Ayatan `amber_stars`/`cyan_stars`
/// pair. Measured on a real day they are **mutually exclusive** — 3,672 rows carry only a rank,
/// 1,385 only a subtype, 33 only stars, 2,400 none at all — but they are combined here in a
/// fixed order anyway, so a future payload that pairs two cannot produce two different keys for
/// one row depending on evaluation order.
///
/// `rank:N` and `base` match what the rest of the app already uses. `subtype:` is new, and
/// usefully so: its values include `intact` / `exceptional` / `flawless` / `radiant`, which is
/// exactly the relic refinement the inventory tracks.
pub(crate) fn variant_key_for(
    mod_rank: Option<i64>,
    subtype: Option<&str>,
    amber_stars: Option<i64>,
    cyan_stars: Option<i64>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(rank) = mod_rank {
        parts.push(format!("rank:{rank}"));
    }
    if let Some(subtype) = subtype.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("subtype:{}", subtype.to_ascii_lowercase()));
    }
    if amber_stars.is_some() || cyan_stars.is_some() {
        parts.push(format!(
            "stars:{}a{}c",
            amber_stars.unwrap_or(0),
            cyan_stars.unwrap_or(0)
        ));
    }
    if parts.is_empty() {
        // Matches `recommended_prices::variant_key_for_rank(None)`.
        return "base".to_string();
    }
    parts.join("+")
}

// ── published format ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ManifestDay {
    pub day: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub rows: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Manifest {
    pub schema: i64,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub days: Vec<ManifestDay>,
}

/// One day's file, after decompression.
#[derive(Debug, Deserialize)]
struct DayFile {
    schema: i64,
    day: String,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
}

/// A single parsed row, ready to insert.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HistoryRow {
    pub item_key: String,
    pub variant_key: String,
    pub order_type: String,
    pub mod_rank: Option<i64>,
    pub subtype: Option<String>,
    pub amber_stars: Option<i64>,
    pub cyan_stars: Option<i64>,
    pub volume: f64,
    pub min_price: Option<f64>,
    pub max_price: Option<f64>,
    pub open_price: Option<f64>,
    pub closed_price: Option<f64>,
    pub avg_price: Option<f64>,
    pub wa_price: Option<f64>,
    pub median: Option<f64>,
    pub moving_avg: Option<f64>,
    pub donch_top: Option<f64>,
    pub donch_bot: Option<f64>,
}

/// Parses one decompressed day file into rows.
///
/// Column order is read from the file's own `columns` array rather than assumed. That is what
/// makes appending a field upstream a non-breaking change, and it is the whole reason the
/// compact array-row format is safe to use.
pub(crate) fn parse_day(json: &str, expected_day: &str) -> Result<Vec<HistoryRow>> {
    let file: DayFile = serde_json::from_str(json).context("day file is not valid JSON")?;
    if file.schema != SUPPORTED_SCHEMA {
        return Err(anyhow!(
            "day file declares schema {} but this build understands {SUPPORTED_SCHEMA}",
            file.schema
        ));
    }
    if file.day != expected_day {
        return Err(anyhow!(
            "manifest promised {expected_day} but the file contains {}",
            file.day
        ));
    }

    let index = |name: &str| file.columns.iter().position(|column| column == name);
    // Without these a row cannot be stored or joined at all.
    let item_key_at = index("item_key").or_else(|| index("item_id"))
        .ok_or_else(|| anyhow!("day file has no item_id column"))?;
    let order_type_at =
        index("order_type").ok_or_else(|| anyhow!("day file has no order_type column"))?;

    let number = |row: &[serde_json::Value], at: Option<usize>| -> Option<f64> {
        at.and_then(|at| row.get(at)).and_then(serde_json::Value::as_f64)
    };
    let integer = |row: &[serde_json::Value], at: Option<usize>| -> Option<i64> {
        at.and_then(|at| row.get(at)).and_then(serde_json::Value::as_i64)
    };
    let text = |row: &[serde_json::Value], at: Option<usize>| -> Option<String> {
        at.and_then(|at| row.get(at))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };

    let (mod_rank_at, subtype_at) = (index("mod_rank"), index("subtype"));
    let (amber_at, cyan_at) = (index("amber_stars"), index("cyan_stars"));
    let volume_at = index("volume");

    let mut rows = Vec::with_capacity(file.rows.len());
    for row in &file.rows {
        let Some(item_key) = row.get(item_key_at).and_then(serde_json::Value::as_str) else {
            // A row with no id cannot be joined to anything. Skipped rather than fatal: one
            // malformed entry should not cost the other 7,489.
            continue;
        };
        let Some(order_type) = row.get(order_type_at).and_then(serde_json::Value::as_str) else {
            continue;
        };

        let mod_rank = integer(row, mod_rank_at);
        let subtype = text(row, subtype_at);
        let amber_stars = integer(row, amber_at);
        let cyan_stars = integer(row, cyan_at);

        rows.push(HistoryRow {
            item_key: item_key.to_string(),
            variant_key: variant_key_for(mod_rank, subtype.as_deref(), amber_stars, cyan_stars),
            order_type: order_type.to_string(),
            mod_rank,
            subtype,
            amber_stars,
            cyan_stars,
            volume: number(row, volume_at).unwrap_or(0.0),
            min_price: number(row, index("min_price")),
            max_price: number(row, index("max_price")),
            open_price: number(row, index("open_price")),
            closed_price: number(row, index("closed_price")),
            avg_price: number(row, index("avg_price")),
            wa_price: number(row, index("wa_price")),
            median: number(row, index("median")),
            moving_avg: number(row, index("moving_avg")),
            donch_top: number(row, index("donch_top")),
            donch_bot: number(row, index("donch_bot")),
        });
    }

    if rows.is_empty() {
        return Err(anyhow!("day {expected_day} parsed to zero usable rows"));
    }
    Ok(rows)
}

// ── storage ─────────────────────────────────────────────────────────────────────────────────

/// Inserts one day inside a transaction, so a day is either wholly present or wholly absent.
pub(crate) fn store_day(connection: &mut Connection, day: &str, rows: &[HistoryRow]) -> Result<usize> {
    let transaction = connection
        .transaction()
        .context("failed to open the price history transaction")?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO price_history_daily (
                   item_key, variant_key, order_type, day,
                   mod_rank, subtype, amber_stars, cyan_stars,
                   volume, min_price, max_price, open_price, closed_price,
                   avg_price, wa_price, median, moving_avg, donch_top, donch_bot
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
                 ON CONFLICT(item_key, variant_key, order_type, day) DO UPDATE SET
                   volume = excluded.volume,
                   min_price = excluded.min_price,
                   max_price = excluded.max_price,
                   open_price = excluded.open_price,
                   closed_price = excluded.closed_price,
                   avg_price = excluded.avg_price,
                   wa_price = excluded.wa_price,
                   median = excluded.median,
                   moving_avg = excluded.moving_avg,
                   donch_top = excluded.donch_top,
                   donch_bot = excluded.donch_bot",
            )
            .context("failed to prepare the price history insert")?;

        for row in rows {
            statement
                .execute(params![
                    row.item_key, row.variant_key, row.order_type, day,
                    row.mod_rank, row.subtype, row.amber_stars, row.cyan_stars,
                    row.volume, row.min_price, row.max_price, row.open_price, row.closed_price,
                    row.avg_price, row.wa_price, row.median, row.moving_avg,
                    row.donch_top, row.donch_bot,
                ])
                .context("failed to insert a price history row")?;
        }
    }
    transaction.commit().context("failed to commit the price history transaction")?;
    Ok(rows.len())
}

/// Days already stored, so a re-run fetches only what is missing.
pub(crate) fn stored_days(connection: &Connection) -> Result<HashSet<String>> {
    let mut statement = connection
        .prepare("SELECT DISTINCT day FROM price_history_daily")
        .context("failed to prepare the stored-days query")?;
    let days = statement
        .query_map([], |row| row.get::<_, String>(0))
        .context("failed to read stored days")?
        .filter_map(Result::ok)
        .collect();
    Ok(days)
}

// ── fetching ────────────────────────────────────────────────────────────────────────────────

fn manifest_url() -> String {
    std::env::var(MANIFEST_URL_ENV).unwrap_or_else(|_| MANIFEST_URL.to_string())
}

/// Fetches the manifest, or `None` when it has not changed since last time.
///
/// The 304 path is the normal case and costs zero bytes — the whole reason the publisher stores
/// an ETag. Returns the new ETag alongside so the caller can persist it *after* a successful
/// ingest, never before: recording it early would skip a day whose download later failed.
fn fetch_manifest(
    client: &reqwest::blocking::Client,
    etag: Option<&str>,
) -> Result<Option<(Manifest, Option<String>)>> {
    let mut request = client.get(manifest_url());
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = request.send().context("failed to reach the WSHistory manifest")?;

    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(anyhow!("WSHistory manifest returned HTTP {}", response.status()));
    }

    let next_etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let manifest: Manifest = response.json().context("WSHistory manifest is not valid JSON")?;

    if manifest.schema != SUPPORTED_SCHEMA {
        return Err(anyhow!(
            "WSHistory manifest declares schema {} but this build understands {SUPPORTED_SCHEMA}",
            manifest.schema
        ));
    }
    Ok(Some((manifest, next_etag)))
}

/// Downloads one day, verifies it, and decompresses it.
///
/// The checksum is not ceremony: these files are fetched over the public internet from a CDN and
/// then written into the database that prices the user's inventory. A truncated or substituted
/// payload must fail loudly here rather than become silently wrong prices.
fn fetch_day(client: &reqwest::blocking::Client, entry: &ManifestDay) -> Result<String> {
    let response = client
        .get(&entry.url)
        .send()
        .with_context(|| format!("failed to download {}", entry.day))?;
    if !response.status().is_success() {
        return Err(anyhow!("{} returned HTTP {}", entry.day, response.status()));
    }
    let bytes = response.bytes().with_context(|| format!("failed to read {}", entry.day))?;

    if entry.bytes != 0 && bytes.len() as u64 != entry.bytes {
        return Err(anyhow!(
            "{}: expected {} bytes, got {}",
            entry.day,
            entry.bytes,
            bytes.len()
        ));
    }
    if !entry.sha256.is_empty() {
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if !digest.eq_ignore_ascii_case(&entry.sha256) {
            return Err(anyhow!("{}: checksum mismatch — refusing to ingest", entry.day));
        }
    }

    let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
    let mut json = String::new();
    decoder
        .read_to_string(&mut json)
        .with_context(|| format!("failed to decompress {}", entry.day))?;
    Ok(json)
}

// ── ingest ──────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestOutcome {
    /// True when the manifest was unchanged — the common case, and not a failure.
    pub up_to_date: bool,
    pub days_added: usize,
    pub rows_added: usize,
    /// Days that failed, with why. One bad day never aborts the rest.
    pub failures: Vec<String>,
    pub newest_day: Option<String>,
    /// Who the data ultimately comes from, carried from the manifest so attribution reaches the
    /// UI rather than being hardcoded in two places.
    pub source: String,
}

/// Brings the local table up to date with what WSHistory publishes.
pub(crate) fn ingest(connection: &mut Connection) -> Result<IngestOutcome> {
    ensure_schema(connection)?;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        // Identifies us to GitHub and to anyone reading logs downstream.
        .user_agent(concat!("WarStonks/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to build the WSHistory client")?;

    let etag = read_meta(connection, META_MANIFEST_ETAG);
    let Some((manifest, next_etag)) = fetch_manifest(&client, etag.as_deref())? else {
        return Ok(IngestOutcome { up_to_date: true, ..Default::default() });
    };

    let have = stored_days(connection)?;
    // Newest first: if the run is cut short, what landed is the most useful window.
    let mut wanted: Vec<&ManifestDay> =
        manifest.days.iter().filter(|entry| !have.contains(&entry.day)).collect();
    wanted.sort_by(|left, right| right.day.cmp(&left.day));
    wanted.truncate(MAX_DAYS_PER_INGEST);

    let mut outcome = IngestOutcome {
        newest_day: manifest.days.iter().map(|entry| entry.day.clone()).max(),
        ..Default::default()
    };

    outcome.source = manifest.source.clone();

    for entry in wanted {
        let parsed = fetch_day(&client, entry).and_then(|json| parse_day(&json, &entry.day));
        match parsed {
            Ok(rows) => {
                // The manifest states the row count independently of the file. Disagreement
                // means the two were produced from different data, so trust neither — this is
                // the cheapest place to catch a partially-written asset.
                if entry.rows > 0 && entry.rows as usize != rows.len() {
                    outcome.failures.push(format!(
                        "{}: manifest claims {} rows, file parsed {}",
                        entry.day,
                        entry.rows,
                        rows.len()
                    ));
                    continue;
                }
                match store_day(connection, &entry.day, &rows) {
                    Ok(count) => {
                        outcome.days_added += 1;
                        outcome.rows_added += count;
                    }
                    Err(error) => outcome.failures.push(format!("{}: {error}", entry.day)),
                }
            }
            Err(error) => outcome.failures.push(format!("{}: {error}", entry.day)),
        }
    }

    // Only after the work: an ETag stored ahead of a failed download would make the next run
    // see 304 and skip the day permanently.
    if outcome.failures.is_empty() {
        if let Some(next_etag) = next_etag {
            write_meta(connection, META_MANIFEST_ETAG, &next_etag)?;
        }
    }
    write_meta(
        connection,
        META_LAST_INGEST_AT,
        &time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default(),
    )?;

    Ok(outcome)
}

// ── retention ───────────────────────────────────────────────────────────────────────────────

/// Days kept at full daily resolution. Recent history is what trend and volatility work reads.
const FULL_RESOLUTION_DAYS: i64 = 90;
/// Beyond that, days are folded into weeks until they age out entirely.
const COMPACTED_BUCKET_DAYS: i64 = 7;
/// Older than this is deleted outright.
const MAX_RETENTION_DAYS: i64 = 365;

/// `YYYY-MM-DD` to a day number, for arithmetic without calendar edge cases.
fn day_number(day: &str) -> Option<i64> {
    let mut parts = day.splitn(3, '-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let date: u8 = parts.next()?.parse().ok()?;
    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, date)
        .ok()
        .map(|date| date.to_julian_day() as i64)
}

/// Which weekly bucket a day belongs to. Fixed-width weeks from the Julian day rather than ISO
/// weeks, so the grouping never depends on locale or year boundaries.
fn week_bucket(day: &str) -> Option<i64> {
    day_number(day).map(|number| number / COMPACTED_BUCKET_DAYS)
}

/// Folds several daily rows for one (item, variant, order type) into a single weekly row.
///
/// ## What survives compaction, and what deliberately does not
///
/// Some of these aggregate exactly, and some cannot aggregate at all:
///
/// | Field | Rule | Exact? |
/// |---|---|---|
/// | `volume` | sum | yes |
/// | `min_price` / `max_price` | min / max | yes |
/// | `open_price` / `closed_price` | first day's open, last day's close | yes — that is what OHLC means |
/// | `avg_price` / `wa_price` | volume-weighted mean | close enough to be useful |
/// | `median` | volume-weighted mean of the daily medians | **an approximation** |
/// | `moving_avg`, `donch_top`, `donch_bot` | dropped to `NULL` | see below |
///
/// A median of medians is not a median, and there is no way to recover the real one without the
/// underlying trades. The volume-weighted mean is the honest best effort, and the row is marked
/// `bucket_days = 7` so nothing downstream can mistake it for a daily observation.
///
/// The three indicators are **discarded rather than approximated**. They are rolling-window
/// calculations Warframe.Market computed over its own window; averaging them across a week
/// yields a number with the shape of data and none of the meaning. A null says "not known at
/// this resolution", which is true, where a computed value would quietly lie.
pub(crate) fn compact_group(days: &mut Vec<(String, HistoryRow)>) -> Option<(String, HistoryRow)> {
    if days.is_empty() {
        return None;
    }
    days.sort_by(|left, right| left.0.cmp(&right.0));

    let first = days.first()?.1.clone();
    let last = days.last()?;
    // Labelled with the newest day it covers, so `ORDER BY day DESC` still means "most recent"
    // and a compacted row can never sort ahead of a daily one that came after it.
    let bucket_day = last.0.clone();

    let total_volume: f64 = days.iter().map(|(_, row)| row.volume.max(0.0)).sum();
    // Volume-weighted where there is volume to weight by; a plain mean when every day recorded
    // zero, which happens for bid rows on items nobody is bidding on.
    let weighted = |pick: fn(&HistoryRow) -> Option<f64>| -> Option<f64> {
        let samples: Vec<(f64, f64)> = days
            .iter()
            .filter_map(|(_, row)| pick(row).map(|value| (value, row.volume.max(0.0))))
            .collect();
        if samples.is_empty() {
            return None;
        }
        if total_volume > 0.0 {
            Some(samples.iter().map(|(value, weight)| value * weight).sum::<f64>() / total_volume)
        } else {
            Some(samples.iter().map(|(value, _)| value).sum::<f64>() / samples.len() as f64)
        }
    };

    let min_of = |pick: fn(&HistoryRow) -> Option<f64>| {
        days.iter().filter_map(|(_, row)| pick(row)).fold(None::<f64>, |best, value| {
            Some(best.map_or(value, |best| best.min(value)))
        })
    };
    let max_of = |pick: fn(&HistoryRow) -> Option<f64>| {
        days.iter().filter_map(|(_, row)| pick(row)).fold(None::<f64>, |best, value| {
            Some(best.map_or(value, |best| best.max(value)))
        })
    };

    Some((
        bucket_day,
        HistoryRow {
            volume: total_volume,
            min_price: min_of(|row| row.min_price),
            max_price: max_of(|row| row.max_price),
            open_price: first.open_price,
            closed_price: last.1.closed_price,
            avg_price: weighted(|row| row.avg_price),
            wa_price: weighted(|row| row.wa_price),
            median: weighted(|row| row.median),
            // Rolling-window indicators. See the doc comment: approximating these would
            // manufacture data rather than preserve it.
            moving_avg: None,
            donch_top: None,
            donch_bot: None,
            ..first
        },
    ))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionOutcome {
    pub rows_deleted: usize,
    pub rows_compacted: usize,
    pub weeks_compacted: usize,
}

/// Applies the retention policy: full daily detail for 90 days, weekly beyond that, nothing
/// past a year.
///
/// `today` is passed in rather than read from the clock so the policy is testable without
/// waiting a year.
pub(crate) fn apply_retention(connection: &mut Connection, today: &str) -> Result<RetentionOutcome> {
    ensure_schema(connection)?;
    let Some(today_number) = day_number(today) else {
        return Err(anyhow!("retention needs a YYYY-MM-DD date, got {today}"));
    };

    let mut outcome = RetentionOutcome::default();

    // 1. Drop everything past the horizon. Cheap, and shrinks the work step 2 has to do.
    let delete_before = today_number - MAX_RETENTION_DAYS;
    let expired: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT DISTINCT day FROM price_history_daily")
            .context("failed to list days for retention")?;
        // Bound before the block ends so the statement's borrow of `connection` is released
        // before the next step needs it mutably.
        let days: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .context("failed to read days for retention")?
            .filter_map(Result::ok)
            .filter(|day| day_number(day).is_some_and(|number| number < delete_before))
            .collect();
        days
    };
    for day in &expired {
        outcome.rows_deleted += connection
            .execute("DELETE FROM price_history_daily WHERE day = ?1", params![day])
            .context("failed to delete expired history")?;
    }

    // 2. Fold anything past the full-resolution window into weeks. Only untouched daily rows
    //    qualify, so re-running is a no-op rather than compacting already-compacted data.
    let compact_before = today_number - FULL_RESOLUTION_DAYS;
    let candidates: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT DISTINCT day FROM price_history_daily WHERE bucket_days = 1")
            .context("failed to list compaction candidates")?;
        let days: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .context("failed to read compaction candidates")?
            .filter_map(Result::ok)
            .filter(|day| day_number(day).is_some_and(|number| number < compact_before))
            .collect();
        days
    };

    // Grouped by week so each pass is bounded, and a failure costs one week rather than a year.
    let mut weeks: std::collections::BTreeMap<i64, Vec<String>> = Default::default();
    for day in candidates {
        if let Some(bucket) = week_bucket(&day) {
            weeks.entry(bucket).or_default().push(day);
        }
    }

    for (_, days) in weeks {
        let compacted = compact_week(connection, &days)?;
        if compacted > 0 {
            outcome.weeks_compacted += 1;
            outcome.rows_compacted += compacted;
        }
    }

    Ok(outcome)
}

/// Compacts one week inside a transaction: read, aggregate, delete the dailies, insert the
/// weekly. All or nothing, so a crash can never leave a week half-collapsed.
fn compact_week(connection: &mut Connection, days: &[String]) -> Result<usize> {
    let placeholders = days.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT item_key, variant_key, order_type, day, mod_rank, subtype, amber_stars,
                cyan_stars, volume, min_price, max_price, open_price, closed_price,
                avg_price, wa_price, median, moving_avg, donch_top, donch_bot
         FROM price_history_daily
         WHERE bucket_days = 1 AND day IN ({placeholders})"
    );

    let mut groups: std::collections::HashMap<(String, String, String), Vec<(String, HistoryRow)>> =
        Default::default();
    {
        let mut statement = connection.prepare(&sql).context("failed to prepare week read")?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(days.iter()), |row| {
                let day: String = row.get(3)?;
                Ok((
                    day,
                    HistoryRow {
                        item_key: row.get(0)?,
                        variant_key: row.get(1)?,
                        order_type: row.get(2)?,
                        mod_rank: row.get(4)?,
                        subtype: row.get(5)?,
                        amber_stars: row.get(6)?,
                        cyan_stars: row.get(7)?,
                        volume: row.get(8)?,
                        min_price: row.get(9)?,
                        max_price: row.get(10)?,
                        open_price: row.get(11)?,
                        closed_price: row.get(12)?,
                        avg_price: row.get(13)?,
                        wa_price: row.get(14)?,
                        median: row.get(15)?,
                        moving_avg: row.get(16)?,
                        donch_top: row.get(17)?,
                        donch_bot: row.get(18)?,
                    },
                ))
            })
            .context("failed to read week rows")?;
        for (day, row) in rows.flatten() {
            groups
                .entry((row.item_key.clone(), row.variant_key.clone(), row.order_type.clone()))
                .or_default()
                .push((day, row));
        }
    }
    if groups.is_empty() {
        return Ok(0);
    }

    let original_rows: usize = groups.values().map(Vec::len).sum();
    let compacted: Vec<(String, HistoryRow)> =
        groups.values_mut().filter_map(compact_group).collect();

    let transaction = connection.transaction().context("failed to open compaction transaction")?;
    {
        let delete_sql =
            format!("DELETE FROM price_history_daily WHERE bucket_days = 1 AND day IN ({placeholders})");
        transaction
            .execute(&delete_sql, rusqlite::params_from_iter(days.iter()))
            .context("failed to clear compacted days")?;

        let mut statement = transaction
            .prepare(
                "INSERT INTO price_history_daily (
                   item_key, variant_key, order_type, day, bucket_days,
                   mod_rank, subtype, amber_stars, cyan_stars,
                   volume, min_price, max_price, open_price, closed_price,
                   avg_price, wa_price, median, moving_avg, donch_top, donch_bot
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
                 ON CONFLICT(item_key, variant_key, order_type, day) DO UPDATE SET
                   bucket_days = excluded.bucket_days,
                   volume = excluded.volume,
                   min_price = excluded.min_price,
                   max_price = excluded.max_price,
                   open_price = excluded.open_price,
                   closed_price = excluded.closed_price,
                   avg_price = excluded.avg_price,
                   wa_price = excluded.wa_price,
                   median = excluded.median,
                   moving_avg = excluded.moving_avg,
                   donch_top = excluded.donch_top,
                   donch_bot = excluded.donch_bot",
            )
            .context("failed to prepare compacted insert")?;
        for (day, row) in &compacted {
            statement
                .execute(params![
                    row.item_key, row.variant_key, row.order_type, day, COMPACTED_BUCKET_DAYS,
                    row.mod_rank, row.subtype, row.amber_stars, row.cyan_stars,
                    row.volume, row.min_price, row.max_price, row.open_price, row.closed_price,
                    row.avg_price, row.wa_price, row.median, row.moving_avg,
                    row.donch_top, row.donch_bot,
                ])
                .context("failed to insert a compacted row")?;
        }
    }
    transaction.commit().context("failed to commit compaction")?;

    Ok(original_rows.saturating_sub(compacted.len()))
}

/// What the app currently holds, for the UI and for diagnosing "why is this item unpriced".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceHistoryStatus {
    pub days_stored: i64,
    pub newest_day: Option<String>,
    pub oldest_day: Option<String>,
    pub row_count: i64,
    /// Distinct items covered — the number that answers "is my inventory priced?".
    pub item_count: i64,
    pub last_ingest_at: Option<String>,
}

pub(crate) fn status(connection: &Connection) -> Result<PriceHistoryStatus> {
    ensure_schema(connection)?;
    let (days_stored, newest_day, oldest_day, row_count, item_count) = connection
        .query_row(
            "SELECT COUNT(DISTINCT day), MAX(day), MIN(day), COUNT(*), COUNT(DISTINCT item_key)
             FROM price_history_daily",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .context("failed to read price history status")?;

    Ok(PriceHistoryStatus {
        days_stored,
        newest_day,
        oldest_day,
        row_count,
        item_count,
        last_ingest_at: read_meta(connection, META_LAST_INGEST_AT),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db");
        ensure_schema(&connection).expect("schema");
        connection
    }

    #[test]
    fn variant_keys_match_the_conventions_the_app_already_uses() {
        assert_eq!(variant_key_for(None, None, None, None), "base");
        assert_eq!(variant_key_for(Some(0), None, None, None), "rank:0");
        assert_eq!(variant_key_for(Some(10), None, None, None), "rank:10");
    }

    /// Relic refinement arrives as a `subtype`, which is the same vocabulary the inventory
    /// already uses — so relics become priceable by refinement rather than collapsing together.
    #[test]
    fn relic_refinements_become_their_own_variants() {
        for refinement in ["intact", "exceptional", "flawless", "radiant"] {
            assert_eq!(
                variant_key_for(None, Some(refinement), None, None),
                format!("subtype:{refinement}"),
            );
        }
        // Case and stray whitespace must not produce a second key for one variant.
        assert_eq!(variant_key_for(None, Some(" Radiant "), None, None), "subtype:radiant");
        assert_eq!(variant_key_for(None, Some(""), None, None), "base");
    }

    #[test]
    fn ayatan_stars_are_distinguishable() {
        assert_eq!(variant_key_for(None, None, Some(2), Some(0)), "stars:2a0c");
        // A missing half is zero, not absent — otherwise two real variants collide.
        assert_eq!(variant_key_for(None, None, Some(1), None), "stars:1a0c");
    }

    /// Combined dimensions do not occur in the data today, but the key must still be stable
    /// rather than depending on which branch ran first.
    #[test]
    fn combined_dimensions_are_deterministic() {
        let key = variant_key_for(Some(3), Some("adorned"), None, None);
        assert_eq!(key, "rank:3+subtype:adorned");
        assert_eq!(key, variant_key_for(Some(3), Some("adorned"), None, None));
    }

    fn day_json(day: &str, rows: &str) -> String {
        format!(
            r#"{{"schema":1,"day":"{day}","source":"relics.run",
                 "columns":["item_id","mod_rank","subtype","amber_stars","cyan_stars",
                            "order_type","volume","min_price","max_price","open_price",
                            "closed_price","avg_price","wa_price","median","moving_avg",
                            "donch_top","donch_bot"],
                 "rows":[{rows}]}}"#
        )
    }

    #[test]
    fn parses_a_day_into_rows() {
        let json = day_json(
            "2026-08-16",
            r#"["abc",null,null,null,null,"closed",23,20.0,40.0,40.0,30.0,30.0,29.6,30.0,30.0,40.0,20.0]"#,
        );
        let rows = parse_day(&json, "2026-08-16").expect("parses");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].item_key, "abc");
        assert_eq!(rows[0].variant_key, "base");
        assert_eq!(rows[0].order_type, "closed");
        assert_eq!(rows[0].median, Some(30.0));
        assert_eq!(rows[0].volume, 23.0);
    }

    /// The compact row format is only safe because order is read from the file. A consumer that
    /// hardcoded positions would silently mis-assign every field if upstream inserted a column.
    #[test]
    fn column_order_is_read_from_the_file_not_assumed() {
        let json = r#"{"schema":1,"day":"2026-08-16",
            "columns":["order_type","item_id","median","volume"],
            "rows":[["closed","abc",42.0,7]]}"#;
        let rows = parse_day(json, "2026-08-16").expect("parses");
        assert_eq!(rows[0].item_key, "abc");
        assert_eq!(rows[0].median, Some(42.0));
        assert_eq!(rows[0].volume, 7.0);
    }

    /// An unknown column is ignored rather than fatal, so upstream can add fields freely.
    #[test]
    fn unknown_columns_are_ignored() {
        let json = r#"{"schema":1,"day":"2026-08-16",
            "columns":["item_id","order_type","volume","something_new"],
            "rows":[["abc","closed",5,"whatever"]]}"#;
        assert_eq!(parse_day(json, "2026-08-16").expect("parses").len(), 1);
    }

    #[test]
    fn refuses_a_schema_it_does_not_understand() {
        let json = r#"{"schema":99,"day":"2026-08-16","columns":["item_id","order_type"],
                       "rows":[["abc","closed"]]}"#;
        let error = parse_day(json, "2026-08-16").unwrap_err().to_string();
        assert!(error.contains("schema 99"), "{error}");
    }

    /// Guards against a manifest and a file disagreeing, which would file a day's prices under
    /// the wrong date and quietly skew every trend built on top.
    #[test]
    fn refuses_a_file_whose_day_disagrees_with_the_manifest() {
        let json = day_json("2026-08-11", r#"["abc",null,null,null,null,"closed",1,1,1,1,1,1,1,1,1,1,1]"#);
        let error = parse_day(&json, "2026-08-16").unwrap_err().to_string();
        assert!(error.contains("promised 2026-08-16"), "{error}");
    }

    #[test]
    fn a_row_without_an_id_is_skipped_but_the_day_survives() {
        let json = day_json(
            "2026-08-16",
            r#"[null,null,null,null,null,"closed",1,1,1,1,1,1,1,1,1,1,1],
               ["abc",null,null,null,null,"closed",2,2,2,2,2,2,2,2,2,2,2]"#,
        );
        let rows = parse_day(&json, "2026-08-16").expect("parses");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].item_key, "abc");
    }

    #[test]
    fn a_day_with_no_usable_rows_is_an_error() {
        let json = day_json("2026-08-16", "");
        assert!(parse_day(&json, "2026-08-16").is_err());
    }

    #[test]
    fn storing_a_day_is_idempotent() {
        let mut connection = memory_db();
        let rows = parse_day(
            &day_json("2026-08-16", r#"["abc",null,null,null,null,"closed",23,1,1,1,1,1,1,30.0,1,1,1]"#),
            "2026-08-16",
        )
        .expect("parses");

        store_day(&mut connection, "2026-08-16", &rows).expect("first");
        store_day(&mut connection, "2026-08-16", &rows).expect("second");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM price_history_daily", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1, "re-ingesting a day must update, never duplicate");
        assert_eq!(stored_days(&connection).expect("days").len(), 1);
    }

    /// Same item and day, different order types — these are two rows, not a collision.
    #[test]
    fn closed_and_buy_coexist_for_one_item_and_day() {
        let mut connection = memory_db();
        let rows = parse_day(
            &day_json(
                "2026-08-16",
                r#"["abc",null,null,null,null,"closed",1,1,1,1,1,1,1,30.0,1,1,1],
                   ["abc",null,null,null,null,"buy",1,1,1,1,1,1,1,20.0,1,1,1]"#,
            ),
            "2026-08-16",
        )
        .expect("parses");
        store_day(&mut connection, "2026-08-16", &rows).expect("store");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM price_history_daily", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 2);
    }

    /// End-to-end against the live publisher: manifest, download, checksum, decompress, parse,
    /// store. Ignored by default because it needs the network — run explicitly with
    /// `cargo test real_ingest -- --ignored --nocapture` after changing anything in the fetch
    /// path, since none of the unit tests above exercise HTTP or gzip.
    #[test]
    #[ignore = "hits the network"]
    fn real_ingest_against_the_live_publisher() {
        let mut connection = memory_db();
        let outcome = ingest(&mut connection).expect("ingest");

        println!(
            "days_added={} rows_added={} failures={:?} newest={:?}",
            outcome.days_added, outcome.rows_added, outcome.failures, outcome.newest_day
        );
        assert!(outcome.failures.is_empty(), "no day should fail: {:?}", outcome.failures);
        assert!(outcome.days_added > 0, "expected to ingest at least one day");

        let (items, variants): (i64, i64) = connection
            .query_row(
                "SELECT COUNT(DISTINCT item_key), COUNT(DISTINCT item_key || '|' || variant_key)
                 FROM price_history_daily",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("coverage");
        println!("distinct items={items} variants={variants}");
        // The whole point of this feature: coverage far beyond what the scanner ever reached.
        assert!(items > 2_000, "expected broad coverage, got {items} items");

        // A second run must be a no-op: the ETag is stored and every day is already present.
        let again = ingest(&mut connection).expect("second ingest");
        println!("second run: up_to_date={} days_added={}", again.up_to_date, again.days_added);
        assert_eq!(again.days_added, 0, "re-ingesting must add nothing");
    }

    /// Measures what 30 days actually costs on disk, against a file-backed database so page
    /// overhead and the WITHOUT ROWID layout are real rather than estimated.
    #[test]
    #[ignore = "hits the network"]
    fn real_ingest_disk_footprint() {
        let path = std::env::temp_dir().join("wsh_size_probe.sqlite");
        let _ = std::fs::remove_file(&path);
        let mut connection = Connection::open(&path).expect("file db");
        ensure_schema(&connection).expect("schema");
        let outcome = ingest(&mut connection).expect("ingest");
        connection.execute_batch("VACUUM").expect("vacuum");
        drop(connection);

        let bytes = std::fs::metadata(&path).expect("stat").len();
        println!(
            "rows={} bytes={} ({:.1} MB, {:.0} B/row)",
            outcome.rows_added,
            bytes,
            bytes as f64 / 1e6,
            bytes as f64 / outcome.rows_added.max(1) as f64
        );
        let _ = std::fs::remove_file(&path);
    }

    fn history_row(volume: f64, median: f64, min: f64, max: f64) -> HistoryRow {
        HistoryRow {
            item_key: "abc".into(),
            variant_key: "base".into(),
            order_type: "closed".into(),
            mod_rank: None,
            subtype: None,
            amber_stars: None,
            cyan_stars: None,
            volume,
            min_price: Some(min),
            max_price: Some(max),
            open_price: Some(min),
            closed_price: Some(max),
            avg_price: Some(median),
            wa_price: Some(median),
            median: Some(median),
            moving_avg: Some(99.0),
            donch_top: Some(99.0),
            donch_bot: Some(99.0),
        }
    }

    #[test]
    fn compaction_sums_volume_and_keeps_the_real_extremes() {
        let mut days = vec![
            ("2026-05-01".to_string(), history_row(10.0, 20.0, 15.0, 25.0)),
            ("2026-05-02".to_string(), history_row(30.0, 40.0, 10.0, 60.0)),
        ];
        let (day, row) = compact_group(&mut days).expect("compacts");

        assert_eq!(day, "2026-05-02", "labelled with the newest day it covers");
        assert_eq!(row.volume, 40.0, "volume sums exactly");
        assert_eq!(row.min_price, Some(10.0));
        assert_eq!(row.max_price, Some(60.0));
    }

    /// OHLC only means anything if open comes from the first day and close from the last.
    #[test]
    fn compaction_takes_open_from_the_first_day_and_close_from_the_last() {
        // Deliberately out of order: the function must sort rather than trust input order.
        let mut days = vec![
            ("2026-05-03".to_string(), HistoryRow { closed_price: Some(77.0), ..history_row(1.0, 1.0, 1.0, 1.0) }),
            ("2026-05-01".to_string(), HistoryRow { open_price: Some(11.0), ..history_row(1.0, 1.0, 1.0, 1.0) }),
        ];
        let (_, row) = compact_group(&mut days).expect("compacts");
        assert_eq!(row.open_price, Some(11.0));
        assert_eq!(row.closed_price, Some(77.0));
    }

    /// Prices are weighted by the volume behind them — a day with one trade must not sway the
    /// week as much as a day with a hundred.
    #[test]
    fn compaction_weights_prices_by_volume() {
        let mut days = vec![
            ("2026-05-01".to_string(), history_row(1.0, 100.0, 1.0, 1.0)),
            ("2026-05-02".to_string(), history_row(99.0, 10.0, 1.0, 1.0)),
        ];
        let (_, row) = compact_group(&mut days).expect("compacts");
        let median = row.median.expect("a median");
        assert!(median < 12.0, "expected ~10.9, got {median} — the 1-trade day dominated");
    }

    /// Rolling-window indicators cannot be aggregated meaningfully, so they are dropped rather
    /// than approximated. A null says "unknown at this resolution"; a number would lie.
    #[test]
    fn compaction_discards_window_indicators_rather_than_faking_them() {
        let mut days = vec![
            ("2026-05-01".to_string(), history_row(1.0, 1.0, 1.0, 1.0)),
            ("2026-05-02".to_string(), history_row(1.0, 1.0, 1.0, 1.0)),
        ];
        let (_, row) = compact_group(&mut days).expect("compacts");
        assert_eq!(row.moving_avg, None);
        assert_eq!(row.donch_top, None);
        assert_eq!(row.donch_bot, None);
    }

    /// Zero-volume rows are real (a bid nobody has taken), so they must still yield a price
    /// rather than dividing by zero.
    #[test]
    fn compaction_handles_a_week_with_no_volume() {
        let mut days = vec![
            ("2026-05-01".to_string(), history_row(0.0, 10.0, 10.0, 10.0)),
            ("2026-05-02".to_string(), history_row(0.0, 20.0, 20.0, 20.0)),
        ];
        let (_, row) = compact_group(&mut days).expect("compacts");
        assert_eq!(row.median, Some(15.0), "falls back to a plain mean");
        assert_eq!(row.volume, 0.0);
    }

    fn seed_day(connection: &mut Connection, day: &str) {
        let rows = parse_day(
            &day_json(day, r#"["abc",null,null,null,null,"closed",5,1,9,1,9,5,5,5,1,1,1]"#),
            day,
        )
        .expect("parses");
        store_day(connection, day, &rows).expect("store");
    }

    #[test]
    fn retention_keeps_recent_days_at_full_resolution() {
        let mut connection = memory_db();
        for day in ["2026-08-16", "2026-08-10", "2026-07-01"] {
            seed_day(&mut connection, day);
        }
        let outcome = apply_retention(&mut connection, "2026-08-17").expect("retention");

        assert_eq!(outcome.rows_deleted, 0);
        assert_eq!(outcome.rows_compacted, 0, "everything is inside the 90-day window");
        assert_eq!(stored_days(&connection).expect("days").len(), 3);
    }

    #[test]
    fn retention_compacts_beyond_ninety_days_and_deletes_beyond_a_year() {
        let mut connection = memory_db();
        // Two days in one week, well past 90 days — should collapse to one row.
        seed_day(&mut connection, "2026-01-05");
        seed_day(&mut connection, "2026-01-06");
        // Older than a year — should vanish.
        seed_day(&mut connection, "2025-01-05");

        let outcome = apply_retention(&mut connection, "2026-08-17").expect("retention");

        assert!(outcome.rows_deleted > 0, "the year-old day must be deleted");
        assert_eq!(outcome.weeks_compacted, 1);

        let remaining: Vec<(String, i64)> = connection
            .prepare("SELECT day, bucket_days FROM price_history_daily ORDER BY day")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        assert_eq!(remaining.len(), 1, "one weekly row replaces the two dailies");
        assert_eq!(remaining[0].0, "2026-01-06", "labelled with the newest day covered");
        assert_eq!(remaining[0].1, 7, "marked as a weekly bucket");
    }

    /// Running retention twice must not compact the compacted — the second pass has nothing to
    /// do, and re-folding a weekly row would degrade it further every time the app started.
    #[test]
    fn retention_is_idempotent() {
        let mut connection = memory_db();
        seed_day(&mut connection, "2026-01-05");
        seed_day(&mut connection, "2026-01-06");

        let first = apply_retention(&mut connection, "2026-08-17").expect("first");
        let second = apply_retention(&mut connection, "2026-08-17").expect("second");

        assert_eq!(first.weeks_compacted, 1);
        assert_eq!(second.weeks_compacted, 0, "already compacted rows are left alone");
        assert_eq!(second.rows_compacted, 0);
    }

    /// Retention against the real 30-day corpus, with the clock wound forward so every day is
    /// past the full-resolution window. Measures the actual reduction rather than projecting it.
    ///
    /// `cargo test real_retention -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the network"]
    fn real_retention_compaction_ratio() {
        let path = std::env::temp_dir().join("wsh_retention_probe.sqlite");
        let _ = std::fs::remove_file(&path);
        let mut connection = Connection::open(&path).expect("file db");
        ensure_schema(&connection).expect("schema");
        ingest(&mut connection).expect("ingest");

        let before: i64 = connection
            .query_row("SELECT COUNT(*) FROM price_history_daily", [], |row| row.get(0))
            .expect("count");
        connection.execute_batch("VACUUM").expect("vacuum");
        let bytes_before = std::fs::metadata(&path).expect("stat").len();

        // Far enough ahead that all 30 days are outside the 90-day window but inside the year.
        let outcome = apply_retention(&mut connection, "2026-12-01").expect("retention");
        connection.execute_batch("VACUUM").expect("vacuum");

        let after: i64 = connection
            .query_row("SELECT COUNT(*) FROM price_history_daily", [], |row| row.get(0))
            .expect("count");
        let bytes_after = std::fs::metadata(&path).expect("stat").len();

        println!(
            "rows {before} -> {after} ({:.1}x), bytes {:.1} MB -> {:.1} MB, {} week(s)",
            before as f64 / after.max(1) as f64,
            bytes_before as f64 / 1e6,
            bytes_after as f64 / 1e6,
            outcome.weeks_compacted,
        );

        assert!(after < before, "compaction must reduce the row count");
        let weekly: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM price_history_daily WHERE bucket_days = 7",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(weekly, after, "every surviving row should be a weekly bucket");

        drop(connection);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn status_reports_what_is_held() {
        let mut connection = memory_db();
        // Empty is a valid state — a fresh install before the first background pass.
        let empty = status(&connection).expect("status");
        assert_eq!(empty.days_stored, 0);
        assert_eq!(empty.item_count, 0);
        assert_eq!(empty.newest_day, None);
        assert_eq!(empty.last_ingest_at, None);

        for day in ["2026-08-16", "2026-08-15"] {
            let rows = parse_day(
                &day_json(
                    day,
                    r#"["abc",null,null,null,null,"closed",1,1,1,1,1,1,1,1,1,1,1],
                       ["def",null,null,null,null,"buy",1,1,1,1,1,1,1,1,1,1,1]"#,
                ),
                day,
            )
            .expect("parses");
            store_day(&mut connection, day, &rows).expect("store");
        }

        let filled = status(&connection).expect("status");
        assert_eq!(filled.days_stored, 2);
        assert_eq!(filled.newest_day.as_deref(), Some("2026-08-16"));
        assert_eq!(filled.oldest_day.as_deref(), Some("2026-08-15"));
        assert_eq!(filled.row_count, 4);
        assert_eq!(filled.item_count, 2, "distinct items, not rows");
    }

    #[test]
    fn stored_days_reports_what_can_be_skipped() {
        let mut connection = memory_db();
        for day in ["2026-08-16", "2026-08-15"] {
            let rows = parse_day(
                &day_json(day, r#"["abc",null,null,null,null,"closed",1,1,1,1,1,1,1,1,1,1,1]"#),
                day,
            )
            .expect("parses");
            store_day(&mut connection, day, &rows).expect("store");
        }
        let days = stored_days(&connection).expect("days");
        assert_eq!(days.len(), 2);
        assert!(days.contains("2026-08-16") && days.contains("2026-08-15"));
    }
}
