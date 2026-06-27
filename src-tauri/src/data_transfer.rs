//! Import/Export of user + market data as portable `.baddie` payloads.
//!
//! Data is spread across two SQLite DBs (market_observatory, trades-cache) plus the settings
//! file, and the snapshot tables are huge — so export is selective at the table level and split
//! into a small "user data" payload and a large "market data" payload. Import uses REPLACE
//! semantics: each targeted table is wiped and reloaded inside a transaction.
//!
//! Rows are serialized generically (column name → JSON value); blobs are wrapped as
//! `{ "__blob_b64": "..." }`. The frontend owns the file envelope (header + localStorage); these
//! commands only handle the SQLite + settings portions.

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::market_observatory::open_market_observatory_database;
use crate::trades::open_trades_cache_database;

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

// The large market snapshot tables (separate "market data" file).
//
// ORDER MATTERS: parents must come before children. `orderbook_snapshot_levels` has a
// foreign key to `orderbook_snapshots` (ON DELETE CASCADE, with `foreign_keys = ON`), so the
// parent must be wiped+reloaded first. Keep parents ahead of children when editing this list.
const MARKET_DATA_TABLES: &[&str] = &[
    "orderbook_snapshots",
    "orderbook_snapshot_levels",
    "statistics_cache",
    "analytics_cache",
];

fn dump_table(connection: &Connection, table: &str) -> Result<Value> {
    let mut statement = connection.prepare(&format!("SELECT * FROM {table}"))?;
    let column_count = statement.column_count();
    let columns: Vec<String> = (0..column_count)
        .map(|index| statement.column_name(index).map(|name| name.to_string()))
        .collect::<rusqlite::Result<_>>()?;

    let rows = statement
        .query_map([], |row| {
            let mut object = Map::new();
            for index in 0..column_count {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(number) => Value::from(number),
                    ValueRef::Real(number) => Value::from(number),
                    ValueRef::Text(text) => {
                        Value::from(String::from_utf8_lossy(text).into_owned())
                    }
                    ValueRef::Blob(bytes) => {
                        let mut blob = Map::new();
                        blob.insert("__blob_b64".to_string(), Value::from(BASE64.encode(bytes)));
                        Value::Object(blob)
                    }
                };
                object.insert(columns[index].clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Value::Array(rows))
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
fn restore_table(connection: &Connection, table: &str, rows: &Value) -> Result<()> {
    connection.execute(&format!("DELETE FROM {table}"), [])?;
    let Some(array) = rows.as_array() else {
        return Ok(());
    };

    let existing_columns: HashSet<String> = {
        let statement = connection.prepare(&format!("SELECT * FROM {table} LIMIT 0"))?;
        let count = statement.column_count();
        (0..count)
            .map(|index| statement.column_name(index).map(|name| name.to_string()))
            .collect::<rusqlite::Result<_>>()?
    };

    for row in array {
        let Some(object) = row.as_object() else {
            continue;
        };
        let columns: Vec<&String> = object
            .keys()
            .filter(|key| existing_columns.contains(*key))
            .collect();
        if columns.is_empty() {
            continue;
        }
        let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "INSERT INTO {table} ({}) VALUES ({})",
            columns
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            placeholders.join(", "),
        );
        let params: Vec<SqlValue> = columns.iter().map(|c| json_to_sql(&object[*c])).collect();
        connection.execute(&sql, rusqlite::params_from_iter(params.iter()))?;
    }
    Ok(())
}

fn dump_tables(connection: &Connection, tables: &[&str]) -> Map<String, Value> {
    let mut map = Map::new();
    for table in tables {
        // Best-effort per table: a missing/renamed table just exports as an empty array.
        let value = dump_table(connection, table).unwrap_or_else(|_| Value::Array(vec![]));
        map.insert((*table).to_string(), value);
    }
    map
}

fn restore_tables(connection: &mut Connection, tables: &[&str], source: &Value) -> Result<()> {
    let Some(object) = source.as_object() else {
        return Ok(());
    };
    let transaction = connection.transaction()?;
    for table in tables {
        if let Some(rows) = object.get(*table) {
            restore_table(&transaction, table, rows)
                .with_context(|| format!("failed to restore table {table}"))?;
        }
    }
    transaction.commit()?;
    Ok(())
}

// ---------- payload builders ----------

pub fn build_user_data_payload(app: &tauri::AppHandle) -> Result<Value> {
    let observatory = open_market_observatory_database(app)?;
    let market_obs = dump_tables(&observatory, MARKET_OBS_USER_TABLES);
    let trades = open_trades_cache_database(app)?;
    let trades_cache = dump_tables(&trades, TRADES_USER_TABLES);
    let settings = crate::settings::export_settings_stripped(app)?;

    Ok(json!({
        "settings": settings,
        "sqlite": {
            "market_observatory": market_obs,
            "trades_cache": trades_cache,
        },
    }))
}

pub fn apply_user_data_payload(app: &tauri::AppHandle, payload: &Value) -> Result<()> {
    if let Some(settings_value) = payload.get("settings") {
        if let Ok(settings) =
            serde_json::from_value::<crate::settings::AppSettings>(settings_value.clone())
        {
            crate::settings::import_settings_preserving_secrets(app, &settings)?;
        }
    }

    let sqlite = payload
        .get("sqlite")
        .ok_or_else(|| anyhow!("import file is missing its data section"))?;

    if let Some(market_obs) = sqlite.get("market_observatory") {
        let mut observatory = open_market_observatory_database(app)?;
        restore_tables(&mut observatory, MARKET_OBS_USER_TABLES, market_obs)?;
    }
    if let Some(trades_cache) = sqlite.get("trades_cache") {
        let mut trades = open_trades_cache_database(app)?;
        restore_tables(&mut trades, TRADES_USER_TABLES, trades_cache)?;
    }
    Ok(())
}

pub fn build_market_data_payload(app: &tauri::AppHandle) -> Result<Value> {
    let observatory = open_market_observatory_database(app)?;
    let market = dump_tables(&observatory, MARKET_DATA_TABLES);
    Ok(json!({ "sqlite": { "market_observatory": market } }))
}

pub fn apply_market_data_payload(app: &tauri::AppHandle, payload: &Value) -> Result<()> {
    let sqlite = payload
        .get("sqlite")
        .ok_or_else(|| anyhow!("import file is missing its data section"))?;
    if let Some(market) = sqlite.get("market_observatory") {
        let mut observatory = open_market_observatory_database(app)?;
        restore_tables(&mut observatory, MARKET_DATA_TABLES, market)?;
    }
    Ok(())
}

// ---------- Tauri commands ----------

/// Pause for in-flight WFM work to drain after maintenance is engaged but before we start
/// rewriting tables, so a request that already passed the scheduler gate can finish its write.
fn settle_before_write() {
    std::thread::sleep(std::time::Duration::from_millis(250));
}

#[tauri::command]
pub async fn export_user_data(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        // Hold all scans/API requests for a consistent snapshot.
        let _maintenance = crate::maintenance::MaintenanceGuard::acquire();
        Ok(serde_json::to_string(&build_user_data_payload(&app)?)?)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn export_market_data(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        let _maintenance = crate::maintenance::MaintenanceGuard::acquire();
        Ok(serde_json::to_string(&build_market_data_payload(&app)?)?)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_user_data(app: tauri::AppHandle, payload: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let _maintenance = crate::maintenance::MaintenanceGuard::acquire();
        let value: Value =
            serde_json::from_str(&payload).context("import file payload was not valid JSON")?;
        settle_before_write();
        apply_user_data_payload(&app, &value)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_market_data(app: tauri::AppHandle, payload: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let _maintenance = crate::maintenance::MaintenanceGuard::acquire();
        let value: Value =
            serde_json::from_str(&payload).context("import file payload was not valid JSON")?;
        settle_before_write();
        apply_market_data_payload(&app, &value)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}
