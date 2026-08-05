//! Import/Export of user + market data as portable `.baddie` payloads.
//!
//! Data is spread across two SQLite DBs (market_observatory, trades-cache) plus the settings
//! file, and the snapshot tables are huge (`statistics_cache` alone regularly exceeds 300k rows)
//! — so export is selective at the table level and split into a small "user data" payload and a
//! large "market data" payload.
//!
//! Export/import both go straight to/from a file path the user picks via a native save/open
//! dialog (see `dataTransfer.ts` on the frontend) — NOT through a Tauri `invoke()` string return.
//! A quarter-million-row table serializes to 100+ MB; passing that as a single `invoke()` return
//! value meant Rust built the whole JSON string, Tauri's IPC layer serialized it again, and the
//! webview then `JSON.parse`'d it — three copies of a huge string in memory, on the critical path
//! of a single command call, which is what made large exports appear to hang or silently fail.
//! Export streams every row straight to a gzip writer (peak memory: one row), and import reads
//! straight from the file (still parses one full in-memory JSON tree there — see
//! `apply_user_data_payload`/`apply_market_data_payload` — but that's still one copy in Rust
//! instead of four copies split across two processes).
//!
//! Rows are serialized generically (column name → JSON value); blobs are wrapped as
//! `{ "__blob_b64": "..." }`. Import uses REPLACE semantics: each targeted table is wiped and
//! reloaded inside a transaction.

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::market_observatory::open_market_observatory_database;
use crate::trades::open_trades_cache_database;

const EXPORT_FORMAT: &str = "warstonks-export";
const EXPORT_SCHEMA_VERSION: i64 = 1;

// User-data tables in market_observatory.sqlite.
const MARKET_OBS_USER_TABLES: &[&str] = &[
    "owned_set_components",
    "owned_set_component_trade_sync",
    "owned_relic_inventory_cache",
    "owned_relic_inventory_meta",
    "set_completion_screenshot_baseline",
    "set_completion_import_meta",
    "tracked_items",
    "recommendation_outcomes",
];

// User-data tables in trades-cache.sqlite (the whole trade log + keep flags).
const TRADES_USER_TABLES: &[&str] = &[
    "portfolio_trade_log_cache",
    "portfolio_trade_log_cache_meta",
    "portfolio_trade_log_overrides",
    "portfolio_trade_log_derived",
    "portfolio_trade_log_notifications",
    "trade_set_component_cache",
];

// Every cache/snapshot table in market_observatory.sqlite that isn't already covered by
// `MARKET_OBS_USER_TABLES` above — i.e. "market data" means every remaining table, full stop,
// not a hand-picked subset. Re-derive this from the real schema if a table is ever added; do not
// let it silently drift again (a prior version of this list only covered 4 of the 14 tables here,
// silently dropping the scanner/arbitrage/opportunity caches from every market-data export).
//
// ORDER MATTERS: parents must come before children. `orderbook_snapshot_levels` has a foreign
// key to `orderbook_snapshots` (ON DELETE CASCADE, with `foreign_keys = ON`), so the parent must
// be wiped+reloaded first. Every other table here is independent (verified against the schema:
// it's the only FOREIGN KEY constraint in market_observatory.sqlite) — keep the parent ahead of
// its child if this list is ever reordered.
const MARKET_DATA_TABLES: &[&str] = &[
    "orderbook_snapshots",
    "orderbook_snapshot_levels",
    "statistics_cache",
    "analytics_cache",
    "order_flow_sample",
    "set_component_cache",
    "scanner_cache",
    "scanner_progress",
    "opportunity_board_cache",
    "trade_sell_order_cache",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTableCount {
    pub table: String,
    pub row_count: usize,
}

/// What actually happened, surfaced to the UI so an export/import can be confirmed correct at a
/// glance instead of trusting a bare "success" — the whole point of asking for this was "so that
/// I can see that it did it correctly."
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub tables: Vec<TransferTableCount>,
    pub total_rows: usize,
    pub file_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserDataImportResult {
    pub summary: TransferSummary,
    pub local_storage: HashMap<String, String>,
}

/// The envelope's header fields only — deliberately has no `payload` field, so serde_json skips
/// that section's bytes without ever materializing a `Value` for it (its default behavior for an
/// unrecognized key on a struct without `deny_unknown_fields`). Lets the frontend confirm "this
/// will replace your [user/market] data" BEFORE running the real (destructive) import, without
/// paying for a second full parse of a potentially hundreds-of-MB payload to find out which kind
/// of file was picked.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaddieHeader {
    pub format: String,
    pub kind: String,
    #[serde(default)]
    pub schema_version: Option<i64>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub exported_at: Option<String>,
}

fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn iso_now() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
}

fn json_to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(if *flag { 1 } else { 0 }),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                SqlValue::Integer(integer)
            } else {
                SqlValue::Real(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Object(map) => match map.get("__blob_b64") {
            Some(Value::String(encoded)) => {
                SqlValue::Blob(BASE64.decode(encoded).unwrap_or_default())
            }
            _ => SqlValue::Text(value.to_string()),
        },
        Value::Array(_) => SqlValue::Text(value.to_string()),
    }
}

/// REPLACE one table: wipe it, then bulk-insert the provided rows. Columns not present in the
/// current schema are skipped so minor schema drift between versions doesn't abort the import.
///
/// The INSERT statement is prepared once and reused across rows, keyed by each row's (sorted)
/// column set — every row from a single table dump comes from the same `SELECT *` snapshot, so
/// in practice there's exactly one column set and one statement for the whole table. Preparing a
/// fresh statement per row (as this used to) turned importing a 300k-row table into 300k SQL
/// compilations — minutes of avoidable work on the largest tables, and very likely why market
/// data imports appeared to hang.
fn restore_table(connection: &Connection, table: &str, rows: &Value) -> Result<usize> {
    connection.execute(&format!("DELETE FROM {table}"), [])?;
    let Some(array) = rows.as_array() else {
        return Ok(0);
    };
    if array.is_empty() {
        return Ok(0);
    }

    let existing_columns: HashSet<String> = {
        let statement = connection.prepare(&format!("SELECT * FROM {table} LIMIT 0"))?;
        let count = statement.column_count();
        (0..count)
            .map(|index| statement.column_name(index).map(|name| name.to_string()))
            .collect::<rusqlite::Result<_>>()?
    };

    let mut cached: Option<(Vec<String>, rusqlite::Statement)> = None;
    let mut inserted = 0usize;
    for row in array {
        let Some(object) = row.as_object() else {
            continue;
        };
        let mut columns: Vec<String> = object
            .keys()
            .filter(|key| existing_columns.contains(*key))
            .cloned()
            .collect();
        if columns.is_empty() {
            continue;
        }
        columns.sort();

        let needs_new_statement = !matches!(&cached, Some((cached_columns, _)) if cached_columns == &columns);
        if needs_new_statement {
            let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
            let sql = format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                columns.join(", "),
                placeholders.join(", "),
            );
            cached = Some((columns.clone(), connection.prepare(&sql)?));
        }
        let (_, statement) = cached.as_mut().expect("just set above");
        let params: Vec<SqlValue> =
            columns.iter().map(|column| json_to_sql(&object[column.as_str()])).collect();
        statement.execute(rusqlite::params_from_iter(params.iter()))?;
        inserted += 1;
    }
    Ok(inserted)
}

fn restore_tables(
    connection: &mut Connection,
    tables: &[&str],
    source: &Value,
) -> Result<Vec<TransferTableCount>> {
    let mut counts = Vec::new();
    let Some(object) = source.as_object() else {
        return Ok(counts);
    };
    let transaction = connection.transaction()?;
    for table in tables {
        if let Some(rows) = object.get(*table) {
            let row_count = restore_table(&transaction, table, rows)
                .with_context(|| format!("failed to restore table {table}"))?;
            counts.push(TransferTableCount { table: (*table).to_string(), row_count });
        }
    }
    transaction.commit()?;
    Ok(counts)
}

// ---------- streaming export ----------

/// Streams one table's rows as a JSON array directly to `writer`, one row at a time — see the
/// module doc comment for why this must never materialize a whole table as an in-memory value.
fn stream_table_rows<W: Write>(connection: &Connection, table: &str, writer: &mut W) -> Result<usize> {
    let mut statement = match connection.prepare(&format!("SELECT * FROM {table}")) {
        Ok(statement) => statement,
        Err(_) => {
            // Table doesn't exist in this schema (renamed/removed since this export code was
            // last touched) — export it as empty rather than failing the whole transfer.
            writer.write_all(b"[]")?;
            return Ok(0);
        }
    };
    let column_count = statement.column_count();
    let columns: Vec<String> = (0..column_count)
        .map(|index| statement.column_name(index).map(|name| name.to_string()))
        .collect::<rusqlite::Result<_>>()?;

    writer.write_all(b"[")?;
    let mut rows = statement.query([])?;
    let mut count = 0usize;
    while let Some(row) = rows.next()? {
        if count > 0 {
            writer.write_all(b",")?;
        }
        let mut object = Map::new();
        for index in 0..column_count {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(number) => Value::from(number),
                ValueRef::Real(number) => Value::from(number),
                ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
                ValueRef::Blob(bytes) => {
                    let mut blob = Map::new();
                    blob.insert("__blob_b64".to_string(), Value::from(BASE64.encode(bytes)));
                    Value::Object(blob)
                }
            };
            object.insert(columns[index].clone(), value);
        }
        serde_json::to_writer(&mut *writer, &Value::Object(object))?;
        count += 1;
    }
    writer.write_all(b"]")?;
    Ok(count)
}

/// Streams `{"table_a":[...],"table_b":[...]}` for the given tables to `writer`, returning each
/// table's row count for the caller's `TransferSummary`.
fn stream_tables<W: Write>(
    connection: &Connection,
    tables: &[&str],
    writer: &mut W,
) -> Result<Vec<TransferTableCount>> {
    writer.write_all(b"{")?;
    let mut counts = Vec::with_capacity(tables.len());
    for (index, table) in tables.iter().enumerate() {
        if index > 0 {
            writer.write_all(b",")?;
        }
        serde_json::to_writer(&mut *writer, table)?;
        writer.write_all(b":")?;
        let row_count = stream_table_rows(connection, table, writer)?;
        counts.push(TransferTableCount { table: (*table).to_string(), row_count });
    }
    writer.write_all(b"}")?;
    Ok(counts)
}

/// `BufWriter` wraps the `GzEncoder`, not the other way around: `serde_json::to_writer` makes
/// many small `write()` calls per row (roughly one per JSON token, unbuffered), and `GzEncoder`
/// does real DEFLATE work on every call it receives — without this outer buffer, streaming a
/// 300k-row table meant hundreds of thousands of individual compression calls instead of a much
/// smaller number of well-sized ones, which was most of why a large export was slow.
fn open_gzip_writer(path: &Path) -> Result<BufWriter<GzEncoder<File>>> {
    let file =
        File::create(path).with_context(|| format!("failed to create {}", path.display()))?;
    Ok(BufWriter::new(GzEncoder::new(file, Compression::default())))
}

/// Flushes the outer buffer, finalizes the gzip stream (writes its footer/CRC — `flush()` alone
/// does not do this), and flushes the underlying file.
fn finish_gzip_writer(mut writer: BufWriter<GzEncoder<File>>) -> Result<()> {
    writer.flush().context("failed to flush the export buffer")?;
    let mut file = writer
        .into_inner()
        .map_err(|error| anyhow::anyhow!("failed to unwrap the export buffer: {error}"))?
        .finish()
        .context("failed to finalize the export file")?;
    file.flush().context("failed to flush the export file")?;
    Ok(())
}

/// Auto-detects gzip vs. plain text by magic bytes (mirrors `maybeGunzip` on the frontend, which
/// falls back to plain text when `CompressionStream` isn't available) so an older plain-JSON
/// export still imports.
fn open_gzip_or_plain_reader(path: &Path) -> Result<Box<dyn Read>> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut magic = [0u8; 2];
    let read_bytes = file.read(&mut magic).unwrap_or(0);
    file.rewind().context("failed to rewind import file")?;
    if read_bytes == 2 && magic == [0x1f, 0x8b] {
        Ok(Box::new(GzDecoder::new(BufReader::new(file))))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

fn read_import_envelope(path: &Path) -> Result<Value> {
    let reader = open_gzip_or_plain_reader(path)?;
    serde_json::from_reader(reader).context("import file was not valid JSON")
}

fn read_baddie_header(path: &Path) -> Result<BaddieHeader> {
    let reader = open_gzip_or_plain_reader(path)?;
    let header: BaddieHeader =
        serde_json::from_reader(reader).context("file isn't a recognized WarStonks export")?;
    if header.format != EXPORT_FORMAT || (header.kind != "user" && header.kind != "market") {
        anyhow::bail!("file isn't a recognized WarStonks .baddie export");
    }
    if header.schema_version.is_some_and(|version| version > EXPORT_SCHEMA_VERSION) {
        anyhow::bail!(
            "this file was exported by a newer version of WarStonks (format v{}); update the \
             app, then import again",
            header.schema_version.unwrap_or_default()
        );
    }
    Ok(header)
}

// ---------- payload appliers (import side; still one in-memory JSON tree, see module doc) ----------

pub fn apply_user_data_payload(app: &tauri::AppHandle, payload: &Value) -> Result<TransferSummary> {
    if let Some(settings_value) = payload.get("settings") {
        if let Ok(settings) =
            serde_json::from_value::<crate::settings::AppSettings>(settings_value.clone())
        {
            crate::settings::import_settings_preserving_secrets(app, &settings)?;
        }
    }

    let sqlite = payload
        .get("sqlite")
        .ok_or_else(|| anyhow::anyhow!("import file is missing its data section"))?;

    let mut counts = Vec::new();
    if let Some(market_obs) = sqlite.get("market_observatory") {
        let mut observatory = open_market_observatory_database(app)?;
        counts.extend(restore_tables(&mut observatory, MARKET_OBS_USER_TABLES, market_obs)?);
    }
    if let Some(trades_cache) = sqlite.get("trades_cache") {
        let mut trades = open_trades_cache_database(app)?;
        counts.extend(restore_tables(&mut trades, TRADES_USER_TABLES, trades_cache)?);
    }
    let total_rows = counts.iter().map(|entry| entry.row_count).sum();
    Ok(TransferSummary { tables: counts, total_rows, file_size_bytes: 0 })
}

pub fn apply_market_data_payload(app: &tauri::AppHandle, payload: &Value) -> Result<TransferSummary> {
    let sqlite = payload
        .get("sqlite")
        .ok_or_else(|| anyhow::anyhow!("import file is missing its data section"))?;
    let mut counts = Vec::new();
    if let Some(market) = sqlite.get("market_observatory") {
        let mut observatory = open_market_observatory_database(app)?;
        counts.extend(restore_tables(&mut observatory, MARKET_DATA_TABLES, market)?);
    }
    let total_rows = counts.iter().map(|entry| entry.row_count).sum();
    Ok(TransferSummary { tables: counts, total_rows, file_size_bytes: 0 })
}

// ---------- Tauri commands ----------

/// Pause for in-flight WFM work to drain after maintenance is engaged but before we start
/// rewriting tables, so a request that already passed the scheduler gate can finish its write.
fn settle_before_write() {
    std::thread::sleep(std::time::Duration::from_millis(250));
}

#[tauri::command]
pub async fn export_user_data(
    app: tauri::AppHandle,
    path: String,
    local_storage: HashMap<String, String>,
) -> Result<TransferSummary, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<TransferSummary> {
        let _maintenance = crate::maintenance::MaintenanceGuard::acquire();
        let path = PathBuf::from(path);
        let mut writer = open_gzip_writer(&path)?;

        write!(writer, r#"{{"format":"#)?;
        serde_json::to_writer(&mut writer, EXPORT_FORMAT)?;
        write!(
            writer,
            r#","kind":"user","schemaVersion":{EXPORT_SCHEMA_VERSION},"appVersion":"#
        )?;
        serde_json::to_writer(&mut writer, &app_version())?;
        write!(writer, r#","exportedAt":"#)?;
        serde_json::to_writer(&mut writer, &iso_now())?;
        write!(writer, r#","localStorage":"#)?;
        serde_json::to_writer(&mut writer, &local_storage)?;
        write!(writer, r#","payload":{{"settings":"#)?;
        let settings = crate::settings::export_settings_stripped(&app)?;
        serde_json::to_writer(&mut writer, &settings)?;

        write!(writer, r#","sqlite":{{"market_observatory":"#)?;
        let observatory = open_market_observatory_database(&app)?;
        let mut counts = stream_tables(&observatory, MARKET_OBS_USER_TABLES, &mut writer)?;
        write!(writer, r#","trades_cache":"#)?;
        let trades = open_trades_cache_database(&app)?;
        counts.extend(stream_tables(&trades, TRADES_USER_TABLES, &mut writer)?);
        write!(writer, "}}}}}}")?; // close sqlite, close payload, close envelope

        finish_gzip_writer(writer).context("failed to finalize the export file")?;
        let file_size_bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let total_rows = counts.iter().map(|entry| entry.row_count).sum();
        Ok(TransferSummary { tables: counts, total_rows, file_size_bytes })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn export_market_data(app: tauri::AppHandle, path: String) -> Result<TransferSummary, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<TransferSummary> {
        let _maintenance = crate::maintenance::MaintenanceGuard::acquire();
        let path = PathBuf::from(path);
        let mut writer = open_gzip_writer(&path)?;

        write!(writer, r#"{{"format":"#)?;
        serde_json::to_writer(&mut writer, EXPORT_FORMAT)?;
        write!(
            writer,
            r#","kind":"market","schemaVersion":{EXPORT_SCHEMA_VERSION},"appVersion":"#
        )?;
        serde_json::to_writer(&mut writer, &app_version())?;
        write!(writer, r#","exportedAt":"#)?;
        serde_json::to_writer(&mut writer, &iso_now())?;
        write!(writer, r#","payload":{{"sqlite":{{"market_observatory":"#)?;
        let observatory = open_market_observatory_database(&app)?;
        let counts = stream_tables(&observatory, MARKET_DATA_TABLES, &mut writer)?;
        write!(writer, "}}}}}}")?; // close sqlite, close payload, close envelope

        finish_gzip_writer(writer).context("failed to finalize the export file")?;
        let file_size_bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let total_rows = counts.iter().map(|entry| entry.row_count).sum();
        Ok(TransferSummary { tables: counts, total_rows, file_size_bytes })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn peek_baddie_file(path: String) -> Result<BaddieHeader, String> {
    tauri::async_runtime::spawn_blocking(move || read_baddie_header(&PathBuf::from(path)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_user_data(app: tauri::AppHandle, path: String) -> Result<UserDataImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<UserDataImportResult> {
        let _maintenance = crate::maintenance::MaintenanceGuard::acquire();
        let path = PathBuf::from(path);
        let envelope = read_import_envelope(&path)?;
        let local_storage = envelope
            .get("localStorage")
            .and_then(|value| serde_json::from_value::<HashMap<String, String>>(value.clone()).ok())
            .unwrap_or_default();
        let payload = envelope
            .get("payload")
            .ok_or_else(|| anyhow::anyhow!("import file is missing its payload section"))?;
        settle_before_write();
        let mut summary = apply_user_data_payload(&app, payload)?;
        summary.file_size_bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Ok(UserDataImportResult { summary, local_storage })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_market_data(app: tauri::AppHandle, path: String) -> Result<TransferSummary, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<TransferSummary> {
        let _maintenance = crate::maintenance::MaintenanceGuard::acquire();
        let path = PathBuf::from(path);
        let envelope = read_import_envelope(&path)?;
        let payload = envelope
            .get("payload")
            .ok_or_else(|| anyhow::anyhow!("import file is missing its payload section"))?;
        settle_before_write();
        let mut summary = apply_market_data_payload(&app, payload)?;
        summary.file_size_bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Ok(summary)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_memory_market_observatory() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE orderbook_snapshots (snapshot_id INTEGER PRIMARY KEY, slug TEXT NOT NULL);
                 CREATE TABLE orderbook_snapshot_levels (
                    level_id INTEGER PRIMARY KEY,
                    snapshot_id INTEGER NOT NULL,
                    price REAL NOT NULL
                 );
                 CREATE TABLE statistics_cache (item_key TEXT NOT NULL, volume REAL NOT NULL);
                 CREATE TABLE analytics_cache (item_key TEXT NOT NULL, score REAL);
                 CREATE TABLE order_flow_sample (wfm_item_id TEXT NOT NULL);
                 CREATE TABLE set_component_cache (set_item_key TEXT, set_slug TEXT);
                 CREATE TABLE scanner_cache (scanner_key TEXT PRIMARY KEY, payload TEXT);
                 CREATE TABLE scanner_progress (scanner_key TEXT PRIMARY KEY, state TEXT);
                 CREATE TABLE opportunity_board_cache (cache_key TEXT PRIMARY KEY, payload TEXT);
                 CREATE TABLE trade_sell_order_cache (cache_key TEXT PRIMARY KEY, payload TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO orderbook_snapshots (snapshot_id, slug) VALUES (1, 'mesa_prime_set')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO orderbook_snapshot_levels (level_id, snapshot_id, price) VALUES (1, 1, 42.5)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO statistics_cache (item_key, volume) VALUES ('a', 12.0), ('b', 34.0)",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO scanner_cache (scanner_key, payload) VALUES ('main', '{}')", [])
            .unwrap();
        connection
    }

    #[test]
    fn market_data_tables_covers_every_table_stream_table_rows_can_see() {
        // The whole point of this list is "everything" — a table added to the schema without
        // being added here would silently vanish from every future market-data export, exactly
        // the bug this rewrite fixes for the 6 tables that were already missing.
        let connection = open_memory_market_observatory();
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap();
        let real_tables: HashSet<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        let listed: HashSet<String> = MARKET_DATA_TABLES.iter().map(|table| table.to_string()).collect();
        assert_eq!(real_tables, listed, "MARKET_DATA_TABLES must list every table exactly once");
    }

    #[test]
    fn stream_table_rows_matches_the_old_whole_value_dump_shape() {
        let connection = open_memory_market_observatory();
        let mut buffer = Vec::new();
        let count = stream_table_rows(&connection, "statistics_cache", &mut buffer).unwrap();
        assert_eq!(count, 2);
        let value: Value = serde_json::from_slice(&buffer).unwrap();
        let rows = value.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["item_key"], Value::from("a"));
        assert_eq!(rows[0]["volume"], Value::from(12.0));
    }

    #[test]
    fn stream_table_rows_exports_a_missing_table_as_empty_not_an_error() {
        let connection = open_memory_market_observatory();
        let mut buffer = Vec::new();
        let count = stream_table_rows(&connection, "table_that_does_not_exist", &mut buffer).unwrap();
        assert_eq!(count, 0);
        assert_eq!(String::from_utf8(buffer).unwrap(), "[]");
    }

    #[test]
    fn stream_tables_produces_valid_json_with_accurate_counts() {
        let connection = open_memory_market_observatory();
        let mut buffer = Vec::new();
        let counts = stream_tables(&connection, MARKET_DATA_TABLES, &mut buffer).unwrap();
        let value: Value = serde_json::from_slice(&buffer).expect("valid JSON");
        for table in MARKET_DATA_TABLES {
            assert!(value.get(table).is_some(), "missing table {table} in streamed output");
        }
        let statistics_count = counts
            .iter()
            .find(|entry| entry.table == "statistics_cache")
            .unwrap();
        assert_eq!(statistics_count.row_count, 2);
        let scanner_count = counts.iter().find(|entry| entry.table == "scanner_cache").unwrap();
        assert_eq!(scanner_count.row_count, 1);
    }

    #[test]
    fn restore_table_round_trips_through_stream_table_rows() {
        let connection = open_memory_market_observatory();
        let mut buffer = Vec::new();
        stream_table_rows(&connection, "statistics_cache", &mut buffer).unwrap();
        let dumped: Value = serde_json::from_slice(&buffer).unwrap();

        connection.execute("DELETE FROM statistics_cache", []).unwrap();
        let restored = restore_table(&connection, "statistics_cache", &dumped).unwrap();
        assert_eq!(restored, 2);
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM statistics_cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 2);
    }

    #[test]
    fn gzip_round_trip_via_open_gzip_writer_and_or_plain_reader() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("warstonks_test_export_{}.baddie", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mut writer = open_gzip_writer(&path).unwrap();
            writer.write_all(br#"{"hello":"world"}"#).unwrap();
            finish_gzip_writer(writer).unwrap();
        }
        let value: Value =
            serde_json::from_reader(open_gzip_or_plain_reader(&path).unwrap()).unwrap();
        assert_eq!(value["hello"], Value::from("world"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn plain_json_file_without_gzip_magic_bytes_still_reads() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("warstonks_test_export_plain_{}.baddie", std::process::id()));
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, br#"{"hello":"plain"}"#).unwrap();
        let value: Value =
            serde_json::from_reader(open_gzip_or_plain_reader(&path).unwrap()).unwrap();
        assert_eq!(value["hello"], Value::from("plain"));
        let _ = std::fs::remove_file(&path);
    }
}
