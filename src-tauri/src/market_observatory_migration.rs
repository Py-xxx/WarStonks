//! Market Observatory's one-time migration to the v2 item catalog's stable `item_key`.
//!
//! Same status as `item_catalog_v2.rs` was at the start of its own rebuild: this module is
//! self-contained, proven by its own tests, and NOT yet wired into `market_observatory.rs`'s
//! real schema or any of its ~388 query sites that reference `item_id`. Wiring it in has to
//! happen in the same pass as rewriting those queries — changing the schema without updating
//! every query that touches it would compile fine (SQLite isn't type-checked at compile time)
//! but break at runtime the moment any of them ran. That rewrite is real, separate work.
//!
//! ## What this covers
//!
//! Of Market Observatory's 18 tables, 16 carry (or should carry) an item identity column:
//!
//! - **5 preserved, re-keyed**: `tracked_items` (the user's watchlist), `owned_set_components`
//!   and `set_completion_screenshot_baseline` (from the screenshot-import feature —
//!   irretrievable without redoing that import), `owned_set_component_trade_sync` (an
//!   idempotency ledger with no item id at all, carried through untouched), and
//!   `set_completion_import_meta` (metadata for the same import, also no item id).
//! - **11 rebuilt empty**: `statistics_cache`, `analytics_cache`, `orderbook_snapshots` +
//!   `orderbook_snapshot_levels`, `order_flow_sample`, `recommendation_outcomes`,
//!   `opportunity_board_cache`, `scanner_cache`, `scanner_progress`, `set_component_cache`,
//!   `trade_sell_order_cache` — pure derived/live data, refetched or recomputed automatically.
//!
//! The remaining 2 (`owned_relic_inventory_cache`, `owned_relic_inventory_meta`) carry no item
//! identity column at all and are untouched by this migration entirely — there's nothing on
//! them to re-key.
//!
//! ## Naming convention
//!
//! Every identity column becomes `item_key` (or `<role>_item_key` where a table plays more than
//! one role, e.g. `set_item_key` / `component_item_key`), always `TEXT`, always paired with its
//! `_slug` column. Before this, the same concept was spelled `item_id`, `wfm_item_id`, and
//! `component_item_id` in different tables — one name, so a human reading the schema doesn't
//! have to guess whether two differently-named columns mean the same thing.

// Test-only for now: this module is proven by its own tests but not yet wired into
// market_observatory.rs's real schema or queries — see the module doc comment above. Same
// treatment as item_catalog_v2.rs got before its own cutover; remove once this is wired in.
#![cfg_attr(not(test), allow(dead_code))]

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;

/// The 16 tables this migration touches, plus whether resolving a row's identity is required
/// for it to survive. Table lists are named constants (not scattered through the function
/// bodies) so the roadmap's "5 preserved / 11 rebuilt" split is visible in one place and can't
/// silently drift out of sync with what the code actually does.
const REBUILT_TABLES: &[&str] = &[
    "statistics_cache",
    "analytics_cache",
    "orderbook_snapshots",
    "orderbook_snapshot_levels",
    "order_flow_sample",
    "recommendation_outcomes",
    "opportunity_board_cache",
    "scanner_cache",
    "scanner_progress",
    "set_component_cache",
    "trade_sell_order_cache",
];

/// Whether the observatory database is still on the pre-`item_key` schema. Checked once, up
/// front, so the migration is naturally a no-op both for a fresh install (table doesn't exist
/// yet) and for a machine that already migrated (column already renamed) — no separate "have we
/// migrated" marker needed; the schema itself is the marker.
pub(crate) fn needs_migration(connection: &Connection) -> Result<bool> {
    let tracked_items_exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tracked_items'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .context("failed to check for tracked_items")?
        .is_some();
    if !tracked_items_exists {
        // Fresh install: nothing to migrate. The normal schema-creation path builds the new
        // shape directly.
        return Ok(false);
    }
    let has_item_key = connection
        .query_row(
            "SELECT 1 FROM pragma_table_info('tracked_items') WHERE name = 'item_key'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .context("failed to inspect tracked_items columns")?
        .is_some();
    Ok(!has_item_key)
}

/// One preserved row, generic across all 5 tables — carries whichever columns that table has
/// beyond identity, as raw SQL values, so this module doesn't need a bespoke struct per table.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreservedRow {
    /// The slug this row's identity is resolved through — the trusted anchor throughout this
    /// whole rebuild, exactly as it was for the original item-id corruption repair.
    pub slug: String,
    /// Every other column, in table-declaration order, as text (sqlite is dynamically typed
    /// per-value anyway, and re-inserting as text through a bound parameter round-trips
    /// integers/reals/nulls correctly).
    pub other_columns: Vec<rusqlite::types::Value>,
}

/// Resolves a batch of slugs against the v2 catalog's `slug -> item_key` map. Returns the
/// resolved key, or `None` when the slug no longer exists in the current catalog (a removed or
/// renamed item) — never a guess, and never fatal to the row: the row is kept with a null
/// `item_key` rather than dropped, since e.g. an owned component's name/slug/quantity are still
/// meaningful on their own even if its numeric identity can't be re-established.
fn resolve_item_key(slug_to_item_key: &HashMap<String, String>, slug: &str) -> Option<String> {
    slug_to_item_key.get(slug).cloned()
}

/// What the migration actually did, so a caller can log something more useful than "done".
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct MigrationSummary {
    pub tables_rebuilt_empty: usize,
    pub rows_preserved: usize,
    /// Preserved rows whose slug no longer resolves in the current catalog — kept, not
    /// dropped, but flagged so this isn't silently invisible.
    pub rows_with_unresolved_item_key: usize,
}

/// Runs the migration against an already-open connection. Caller's responsibility to have
/// already checked `needs_migration` — calling this unconditionally would needlessly drop and
/// recreate 11 tables' worth of live data on every launch.
///
/// Order matters and is deliberate: read every preserved row out FIRST, then drop tables, then
/// recreate schema, then re-insert. Dropping before reading would destroy the very data this
/// function exists to keep.
pub(crate) fn migrate(
    connection: &mut Connection,
    slug_to_item_key: &HashMap<String, String>,
) -> Result<MigrationSummary> {
    let tracked_items = read_preserved_rows(
        connection,
        "tracked_items",
        "item_id",
        &["variant_key", "seller_mode", "variant_label", "tracking_sources",
          "first_tracked_at", "last_tracked_at", "last_snapshot_at", "next_snapshot_at", "is_active"],
    )?;
    let owned_set_components = read_preserved_rows(
        connection,
        "owned_set_components",
        "component_item_id",
        &["component_name", "component_image_path", "quantity", "updated_at"],
    )?;
    let screenshot_baseline = read_preserved_rows(
        connection,
        "set_completion_screenshot_baseline",
        "component_item_id",
        &["component_name", "component_image_path", "quantity", "imported_at"],
    )?;
    // No item id at all on these two — carried through byte-for-byte, not re-keyed.
    let trade_sync_rows: Vec<Vec<rusqlite::types::Value>> =
        read_raw_rows(connection, "owned_set_component_trade_sync", &["sync_key", "component_slug", "applied_at"])?;
    let import_meta_rows: Vec<Vec<rusqlite::types::Value>> =
        read_raw_rows(connection, "set_completion_import_meta", &["meta_key", "value_text"])?;

    let tx = connection.transaction().context("failed to start migration transaction")?;

    for table in REBUILT_TABLES.iter().chain(["tracked_items", "owned_set_components", "set_completion_screenshot_baseline", "owned_set_component_trade_sync", "set_completion_import_meta"].iter()) {
        tx.execute(&format!("DROP TABLE IF EXISTS \"{table}\""), [])
            .with_context(|| format!("failed to drop {table}"))?;
    }

    create_new_schema(&tx)?;

    let mut summary = MigrationSummary {
        tables_rebuilt_empty: REBUILT_TABLES.len(),
        ..Default::default()
    };

    write_preserved_rows(
        &tx,
        "tracked_items",
        // Column order here MUST be (slug, item_key, ...) — `write_preserved_rows` always binds
        // in that fixed order regardless of which table it's writing to. This exact mismatch
        // (item_key/slug swapped) was the first bug this module's own tests caught.
        "INSERT INTO tracked_items (slug, item_key, variant_key, seller_mode, variant_label, \
         tracking_sources, first_tracked_at, last_tracked_at, last_snapshot_at, next_snapshot_at, is_active) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        &tracked_items,
        slug_to_item_key,
        &mut summary,
    )?;
    write_preserved_rows(
        &tx,
        "owned_set_components",
        "INSERT INTO owned_set_components (component_slug, component_item_key, component_name, \
         component_image_path, quantity, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        &owned_set_components,
        slug_to_item_key,
        &mut summary,
    )?;
    write_preserved_rows(
        &tx,
        "set_completion_screenshot_baseline",
        "INSERT INTO set_completion_screenshot_baseline (component_slug, component_item_key, \
         component_name, component_image_path, quantity, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        &screenshot_baseline,
        slug_to_item_key,
        &mut summary,
    )?;

    for row in &trade_sync_rows {
        tx.execute(
            "INSERT INTO owned_set_component_trade_sync (sync_key, component_slug, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params_from_iter(row.iter()),
        )?;
        summary.rows_preserved += 1;
    }
    for row in &import_meta_rows {
        tx.execute(
            "INSERT INTO set_completion_import_meta (meta_key, value_text) VALUES (?1, ?2)",
            rusqlite::params_from_iter(row.iter()),
        )?;
        summary.rows_preserved += 1;
    }

    tx.commit().context("failed to commit migration transaction")?;
    Ok(summary)
}

/// Reads every row of a table whose first identity column is being re-keyed, capturing the slug
/// (the anchor) and every other requested column as dynamically-typed values.
fn read_preserved_rows(
    connection: &Connection,
    table: &str,
    _old_item_id_column: &str,
    other_columns: &[&str],
    // slug column is always named `slug` on tracked_items but `component_slug` on the other
    // two — resolved by the caller via a fixed lookup below rather than passed separately, to
    // keep call sites short.
) -> Result<Vec<PreservedRow>> {
    let slug_column = match table {
        "tracked_items" => "slug",
        _ => "component_slug",
    };
    let column_list = std::iter::once(slug_column)
        .chain(other_columns.iter().copied())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {column_list} FROM \"{table}\"");
    let mut statement = connection
        .prepare(&sql)
        .with_context(|| format!("failed to prepare read of {table}"))?;
    let rows = statement
        .query_map([], |row| {
            let slug: String = row.get(0)?;
            let mut other = Vec::with_capacity(other_columns.len());
            for index in 0..other_columns.len() {
                other.push(row.get::<_, rusqlite::types::Value>(index + 1)?);
            }
            Ok(PreservedRow {
                slug,
                other_columns: other,
            })
        })
        .with_context(|| format!("failed to read rows from {table}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .with_context(|| format!("failed to collect rows from {table}"))
}

/// Reads a table that carries no item identity at all — straight passthrough, no re-keying.
fn read_raw_rows(
    connection: &Connection,
    table: &str,
    columns: &[&str],
) -> Result<Vec<Vec<rusqlite::types::Value>>> {
    let column_list = columns.join(", ");
    let sql = format!("SELECT {column_list} FROM \"{table}\"");
    let mut statement = connection
        .prepare(&sql)
        .with_context(|| format!("failed to prepare read of {table}"))?;
    let rows = statement
        .query_map([], |row| {
            (0..columns.len())
                .map(|index| row.get::<_, rusqlite::types::Value>(index))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .with_context(|| format!("failed to read rows from {table}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .with_context(|| format!("failed to collect rows from {table}"))
}

fn write_preserved_rows(
    tx: &rusqlite::Transaction,
    table: &str,
    insert_sql: &str,
    rows: &[PreservedRow],
    slug_to_item_key: &HashMap<String, String>,
    summary: &mut MigrationSummary,
) -> Result<()> {
    let mut statement = tx
        .prepare(insert_sql)
        .with_context(|| format!("failed to prepare insert for {table}"))?;
    for row in rows {
        let item_key = resolve_item_key(slug_to_item_key, &row.slug);
        if item_key.is_none() {
            summary.rows_with_unresolved_item_key += 1;
        }
        let mut bound: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(row.slug.clone()),
            item_key.map_or(rusqlite::types::Value::Null, rusqlite::types::Value::Text),
        ];
        bound.extend(row.other_columns.iter().cloned());
        statement
            .execute(rusqlite::params_from_iter(bound.iter()))
            .with_context(|| format!("failed to insert a preserved row into {table}"))?;
        summary.rows_preserved += 1;
    }
    Ok(())
}

/// The new schema for all 16 migrated tables (the 2 relic-inventory tables are untouched and
/// not recreated here — `market_observatory.rs`'s normal `CREATE TABLE IF NOT EXISTS` already
/// leaves them alone). This mirrors the table shapes already in `market_observatory.rs` at the
/// time of writing, with every identity column renamed per the new convention.
pub(crate) fn create_new_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS tracked_items (
              item_key TEXT NOT NULL,
              slug TEXT NOT NULL,
              variant_key TEXT NOT NULL,
              seller_mode TEXT NOT NULL DEFAULT 'ingame',
              variant_label TEXT NOT NULL,
              tracking_sources TEXT NOT NULL,
              first_tracked_at TEXT NOT NULL,
              last_tracked_at TEXT NOT NULL,
              last_snapshot_at TEXT,
              next_snapshot_at TEXT,
              is_active INTEGER NOT NULL DEFAULT 1,
              PRIMARY KEY (item_key, slug, variant_key)
            );

            CREATE TABLE IF NOT EXISTS order_flow_sample (
              sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
              item_key TEXT NOT NULL,
              slug TEXT,
              variant_key TEXT NOT NULL,
              captured_at TEXT NOT NULL,
              sell_arrivals_per_hour REAL NOT NULL,
              buy_arrivals_per_hour REAL NOT NULL,
              undercut_per_hour REAL NOT NULL,
              observed_floor REAL,
              sample_seconds REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_order_flow_sample_lookup
              ON order_flow_sample (item_key, variant_key, captured_at DESC);

            CREATE TABLE IF NOT EXISTS orderbook_snapshots (
              snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
              item_key TEXT NOT NULL,
              slug TEXT NOT NULL,
              variant_key TEXT NOT NULL,
              seller_mode TEXT NOT NULL DEFAULT 'ingame',
              captured_at TEXT NOT NULL,
              lowest_sell REAL,
              median_sell REAL,
              highest_buy REAL,
              spread REAL,
              spread_pct REAL,
              sell_order_count INTEGER NOT NULL,
              sell_quantity INTEGER NOT NULL,
              buy_order_count INTEGER NOT NULL,
              buy_quantity INTEGER NOT NULL,
              near_floor_seller_count INTEGER NOT NULL,
              near_floor_quantity INTEGER NOT NULL,
              unique_sell_users INTEGER NOT NULL,
              unique_buy_users INTEGER NOT NULL,
              pressure_ratio REAL,
              entry_depth REAL NOT NULL,
              exit_depth REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orderbook_snapshots_lookup
              ON orderbook_snapshots (item_key, variant_key, seller_mode, captured_at DESC);

            CREATE TABLE IF NOT EXISTS orderbook_snapshot_levels (
              snapshot_id INTEGER NOT NULL,
              side TEXT NOT NULL,
              price REAL NOT NULL,
              quantity INTEGER NOT NULL,
              order_count INTEGER NOT NULL,
              band_kind TEXT NOT NULL,
              PRIMARY KEY (snapshot_id, side, price, band_kind),
              FOREIGN KEY (snapshot_id) REFERENCES orderbook_snapshots(snapshot_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS statistics_cache (
              item_key TEXT NOT NULL,
              slug TEXT NOT NULL,
              variant_key TEXT NOT NULL,
              domain_key TEXT NOT NULL,
              bucket_origin TEXT NOT NULL,
              bucket_at TEXT NOT NULL,
              source_kind TEXT NOT NULL,
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
              fetched_at TEXT NOT NULL,
              PRIMARY KEY (item_key, variant_key, domain_key, bucket_origin, bucket_at, source_kind)
            );
            CREATE INDEX IF NOT EXISTS idx_statistics_cache_lookup
              ON statistics_cache (item_key, variant_key, domain_key, source_kind, bucket_at DESC);

            CREATE TABLE IF NOT EXISTS set_component_cache (
              set_item_key TEXT NOT NULL,
              set_slug TEXT NOT NULL,
              set_name TEXT NOT NULL,
              set_image_path TEXT,
              component_item_key TEXT,
              component_slug TEXT NOT NULL,
              component_name TEXT NOT NULL,
              component_image_path TEXT,
              quantity_in_set INTEGER NOT NULL DEFAULT 1,
              sort_order INTEGER NOT NULL,
              fetched_at TEXT NOT NULL,
              PRIMARY KEY (set_slug, component_slug)
            );
            CREATE INDEX IF NOT EXISTS idx_set_component_cache_set_slug
              ON set_component_cache (set_slug, sort_order ASC);

            CREATE TABLE IF NOT EXISTS owned_set_components (
              component_slug TEXT PRIMARY KEY,
              component_item_key TEXT,
              component_name TEXT NOT NULL,
              component_image_path TEXT,
              quantity INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_owned_set_components_name
              ON owned_set_components (component_name COLLATE NOCASE ASC);

            CREATE TABLE IF NOT EXISTS owned_set_component_trade_sync (
              sync_key TEXT PRIMARY KEY,
              component_slug TEXT NOT NULL,
              applied_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS set_completion_screenshot_baseline (
              component_slug TEXT PRIMARY KEY,
              component_item_key TEXT,
              component_name TEXT NOT NULL,
              component_image_path TEXT,
              quantity INTEGER NOT NULL,
              imported_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS set_completion_import_meta (
              meta_key TEXT PRIMARY KEY,
              value_text TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS scanner_cache (
              scanner_key TEXT PRIMARY KEY,
              computed_at TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS opportunity_board_cache (
              cache_key TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              computed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trade_sell_order_cache (
              cache_key TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              computed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS scanner_progress (
              scanner_key TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              progress_value REAL NOT NULL,
              stage_label TEXT NOT NULL,
              status_text TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              started_at TEXT,
              last_completed_at TEXT,
              last_error TEXT,
              current_set_name TEXT,
              current_component_name TEXT,
              completed_set_count INTEGER NOT NULL DEFAULT 0,
              total_set_count INTEGER NOT NULL DEFAULT 0,
              completed_component_count INTEGER NOT NULL DEFAULT 0,
              total_component_count INTEGER NOT NULL DEFAULT 0,
              skipped_entry_count INTEGER NOT NULL DEFAULT 0,
              retrying_item_name TEXT,
              retry_attempt INTEGER,
              stop_requested INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS analytics_cache (
              item_key TEXT NOT NULL,
              slug TEXT NOT NULL,
              variant_key TEXT NOT NULL,
              seller_mode TEXT NOT NULL DEFAULT 'ingame',
              domain_key TEXT NOT NULL,
              bucket_size_key TEXT NOT NULL,
              cache_version INTEGER NOT NULL DEFAULT 1,
              computed_at TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              source_snapshot_at TEXT,
              source_stats_fetched_at TEXT,
              PRIMARY KEY (item_key, variant_key, seller_mode, domain_key, bucket_size_key)
            );

            CREATE TABLE IF NOT EXISTS recommendation_outcomes (
              outcome_id          INTEGER PRIMARY KEY AUTOINCREMENT,
              item_key            TEXT NOT NULL,
              slug                TEXT NOT NULL,
              variant_key         TEXT NOT NULL,
              seller_mode         TEXT NOT NULL,
              outcome_type        TEXT NOT NULL DEFAULT 'buy_trade',
              recommended_at      TEXT NOT NULL,
              efficiency_score    REAL,
              efficiency_label    TEXT,
              liquidity_score     REAL,
              liquidity_label     TEXT,
              pressure_label      TEXT,
              suggested_action    TEXT,
              action_tone         TEXT,
              entry_zone_low      REAL,
              entry_zone_high     REAL,
              exit_zone_low       REAL,
              exit_zone_high      REAL,
              floor_at_rec        REAL,
              entry_window_hours  INTEGER NOT NULL DEFAULT 48,
              holding_window_days INTEGER NOT NULL DEFAULT 7,
              entry_triggered     INTEGER,
              entry_price         REAL,
              entry_triggered_at  TEXT,
              exit_triggered      INTEGER,
              exit_price          REAL,
              exit_triggered_at   TEXT,
              mark_to_market_price REAL,
              realized_return     REAL,
              return_per_day      REAL,
              days_held           REAL,
              outcome_graded_at   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_rec_outcomes_grading
              ON recommendation_outcomes (outcome_graded_at, recommended_at);
            CREATE INDEX IF NOT EXISTS idx_rec_outcomes_item
              ON recommendation_outcomes (item_key, variant_key, seller_mode, recommended_at DESC);
            ",
        )
        .context("failed to create the migrated market observatory schema")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn old_schema_fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE tracked_items (
                  item_id INTEGER NOT NULL, slug TEXT NOT NULL, variant_key TEXT NOT NULL,
                  seller_mode TEXT NOT NULL DEFAULT 'ingame', variant_label TEXT NOT NULL,
                  tracking_sources TEXT NOT NULL, first_tracked_at TEXT NOT NULL,
                  last_tracked_at TEXT NOT NULL, last_snapshot_at TEXT, next_snapshot_at TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  PRIMARY KEY (item_id, slug, variant_key)
                );
                CREATE TABLE owned_set_components (
                  component_slug TEXT PRIMARY KEY, component_item_id INTEGER,
                  component_name TEXT NOT NULL, component_image_path TEXT,
                  quantity INTEGER NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE set_completion_screenshot_baseline (
                  component_slug TEXT PRIMARY KEY, component_item_id INTEGER,
                  component_name TEXT NOT NULL, component_image_path TEXT,
                  quantity INTEGER NOT NULL, imported_at TEXT NOT NULL
                );
                CREATE TABLE owned_set_component_trade_sync (
                  sync_key TEXT PRIMARY KEY, component_slug TEXT NOT NULL, applied_at TEXT NOT NULL
                );
                CREATE TABLE set_completion_import_meta (
                  meta_key TEXT PRIMARY KEY, value_text TEXT NOT NULL
                );
                CREATE TABLE statistics_cache (item_id INTEGER NOT NULL, slug TEXT NOT NULL);
                CREATE TABLE analytics_cache (item_id INTEGER NOT NULL, slug TEXT NOT NULL);
                CREATE TABLE orderbook_snapshots (item_id INTEGER NOT NULL, slug TEXT NOT NULL);
                CREATE TABLE orderbook_snapshot_levels (snapshot_id INTEGER NOT NULL);
                CREATE TABLE order_flow_sample (wfm_item_id TEXT NOT NULL);
                CREATE TABLE recommendation_outcomes (item_id INTEGER NOT NULL, slug TEXT NOT NULL);
                CREATE TABLE opportunity_board_cache (cache_key TEXT PRIMARY KEY);
                CREATE TABLE scanner_cache (scanner_key TEXT PRIMARY KEY);
                CREATE TABLE scanner_progress (scanner_key TEXT PRIMARY KEY);
                CREATE TABLE set_component_cache (set_item_id INTEGER, set_slug TEXT);
                CREATE TABLE trade_sell_order_cache (cache_key TEXT PRIMARY KEY);
                CREATE TABLE owned_relic_inventory_cache (
                  relic_tier TEXT, relic_code TEXT, intact_count INTEGER, exceptional_count INTEGER,
                  flawless_count INTEGER, radiant_count INTEGER, total_count INTEGER, updated_at TEXT
                );
                CREATE TABLE owned_relic_inventory_meta (cache_key TEXT PRIMARY KEY);

                INSERT INTO tracked_items VALUES
                  (111, 'mesa_prime_set', 'base', 'ingame', 'Base', 'watchlist', '2026-01-01', '2026-01-01', NULL, NULL, 1);
                INSERT INTO owned_set_components VALUES
                  ('mesa_prime_blueprint', 222, 'Mesa Prime Blueprint', NULL, 1, '2026-01-01');
                INSERT INTO owned_set_components VALUES
                  ('removed_item_slug', 999, 'A Removed Item', NULL, 1, '2026-01-01');
                INSERT INTO set_completion_screenshot_baseline VALUES
                  ('mesa_prime_blueprint', 222, 'Mesa Prime Blueprint', NULL, 1, '2026-01-01');
                INSERT INTO owned_set_component_trade_sync VALUES
                  ('sync-1', 'mesa_prime_blueprint', '2026-01-01');
                INSERT INTO set_completion_import_meta VALUES ('cutoff', '2026-01-01');
                ",
            )
            .unwrap();
        connection
    }

    fn fixture_slug_map() -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert("mesa_prime_set".to_string(), "new-key-mesa-set".to_string());
        map.insert("mesa_prime_blueprint".to_string(), "new-key-mesa-bp".to_string());
        // Deliberately no entry for "removed_item_slug" — simulates an item that no longer
        // exists in the current catalog.
        map
    }

    #[test]
    fn detects_the_old_schema_and_a_fresh_install_correctly() {
        let old = old_schema_fixture();
        assert!(needs_migration(&old).unwrap());

        let fresh = Connection::open_in_memory().unwrap();
        assert!(!needs_migration(&fresh).unwrap(), "no tracked_items table at all = fresh install, nothing to migrate");

        let mut migrated = old_schema_fixture();
        migrate(&mut migrated, &fixture_slug_map()).unwrap();
        assert!(!needs_migration(&migrated).unwrap(), "already migrated must not be re-detected as needing migration");
    }

    #[test]
    fn preserves_the_watchlist_with_resolved_item_key() {
        let mut connection = old_schema_fixture();
        migrate(&mut connection, &fixture_slug_map()).unwrap();

        let (item_key, slug): (String, String) = connection
            .query_row("SELECT item_key, slug FROM tracked_items", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!(item_key, "new-key-mesa-set");
        assert_eq!(slug, "mesa_prime_set");
    }

    #[test]
    fn preserves_owned_components_including_one_with_an_unresolvable_item() {
        let mut connection = old_schema_fixture();
        let summary = migrate(&mut connection, &fixture_slug_map()).unwrap();

        let rows: Vec<(String, Option<String>)> = {
            let mut statement = connection
                .prepare("SELECT component_slug, component_item_key FROM owned_set_components ORDER BY component_slug")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        assert_eq!(
            rows,
            vec![
                ("mesa_prime_blueprint".to_string(), Some("new-key-mesa-bp".to_string())),
                ("removed_item_slug".to_string(), None),
            ],
            "an unresolvable item must be KEPT with a null item_key, not dropped"
        );
        assert_eq!(summary.rows_with_unresolved_item_key, 1);
    }

    #[test]
    fn preserves_tables_with_no_item_id_at_all_byte_for_byte() {
        let mut connection = old_schema_fixture();
        migrate(&mut connection, &fixture_slug_map()).unwrap();

        let sync_row: (String, String, String) = connection
            .query_row(
                "SELECT sync_key, component_slug, applied_at FROM owned_set_component_trade_sync",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(sync_row, ("sync-1".to_string(), "mesa_prime_blueprint".to_string(), "2026-01-01".to_string()));

        let meta_row: (String, String) = connection
            .query_row("SELECT meta_key, value_text FROM set_completion_import_meta", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(meta_row, ("cutoff".to_string(), "2026-01-01".to_string()));
    }

    #[test]
    fn rebuilds_the_eleven_cache_tables_empty_with_the_new_schema() {
        let mut connection = old_schema_fixture();
        let summary = migrate(&mut connection, &fixture_slug_map()).unwrap();
        assert_eq!(summary.tables_rebuilt_empty, 11);

        for table in REBUILT_TABLES {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} must be empty after migration");
        }
        // Spot-check the renamed column actually exists on the rebuilt tables.
        let has_item_key: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('statistics_cache') WHERE name = 'item_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_item_key, 1);
    }

    #[test]
    fn leaves_the_two_relic_inventory_tables_completely_untouched() {
        let mut connection = old_schema_fixture();
        connection
            .execute(
                "INSERT INTO owned_relic_inventory_cache VALUES ('lith', 'a1', 0, 0, 0, 0, 0, '2026-01-01')",
                [],
            )
            .unwrap();
        migrate(&mut connection, &fixture_slug_map()).unwrap();

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM owned_relic_inventory_cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "this table has no item id and must not be dropped or touched");
    }

    #[test]
    fn order_flow_sample_gains_a_slug_column_it_never_had() {
        let mut connection = old_schema_fixture();
        migrate(&mut connection, &fixture_slug_map()).unwrap();
        let has_slug: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('order_flow_sample') WHERE name = 'slug'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_slug, 1);
    }
}
