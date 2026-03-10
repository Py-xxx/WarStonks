use anyhow::{anyhow, Context, Result};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const ITEM_CATALOG_SCHEMA_SQL: &str = include_str!("../sql/item_catalog.sql");
const MANUAL_ALIAS_SEED_JSON: &str = include_str!("../sql/manual_aliases.json");

const STARTUP_PROGRESS_EVENT: &str = "startup-progress";
const WFM_ITEMS_URL: &str = "https://api.warframe.market/v2/items";
const WFSTAT_ITEMS_URL: &str = "https://api.warframestat.us/items/";

const WFM_SOURCE_NAME: &str = "wfm_v2_items";
const WFSTAT_SOURCE_NAME: &str = "wfstat_items";
const SCHEMA_SOURCE_NAME: &str = "item_catalog_schema";
const MANUAL_ALIAS_SOURCE_NAME: &str = "item_manual_alias_seed";
const CURRENT_SCHEMA_VERSION: &str = "2026-03-10.item-catalog.v1";

const WFM_DATA_FILE: &str = "WFM-items.json";
const WFSTAT_DATA_FILE: &str = "WFStat-items.json";
const DATABASE_FILE: &str = "item_catalog.sqlite";
#[cfg(test)]
const WFSTAT_ITEMS_COLUMN_COUNT: usize = 85;
const WFSTAT_ITEMS_INSERT_SQL: &str = "INSERT INTO wfstat_items (
            wfstat_unique_name,
            item_id,
            name,
            normalized_name,
            item_family,
            variant_group_name,
            variant_group_name_normalized,
            variant_kind,
            variant_value,
            variant_value_normalized,
            variant_rank,
            description,
            category,
            type,
            image_name,
            compat_name,
            rarity,
            polarity,
            stance_polarity,
            product_category,
            mod_set,
            tradable,
            masterable,
            transmutable,
            is_augment,
            is_prime,
            is_exilus,
            is_utility,
            vaulted,
            wiki_available,
            exclude_from_codex,
            show_in_inventory,
            consume_on_build,
            base_drain,
            fusion_limit,
            item_count,
            mastery_req,
            market_cost,
            bp_cost,
            build_price,
            build_quantity,
            build_time,
            skip_build_time_price,
            accuracy,
            critical_chance,
            critical_multiplier,
            fire_rate,
            omega_attenuation,
            proc_chance,
            reload_time,
            magazine_size,
            multishot,
            slot,
            total_damage,
            disposition,
            range,
            follow_through,
            blocking_angle,
            combo_duration,
            heavy_attack_damage,
            heavy_slam_attack,
            heavy_slam_radial_damage,
            heavy_slam_radius,
            slam_attack,
            slam_radial_damage,
            slam_radius,
            slide_attack,
            wind_up,
            power,
            stamina,
            health,
            shield,
            armor,
            sprint_speed,
            region_bits,
            release_date,
            vault_date,
            estimated_vault_date,
            wikia_thumbnail,
            wikia_url,
            noise,
            trigger,
            market_info_id,
            market_info_url_name,
            raw_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44, ?45, ?46, ?47, ?48, ?49, ?50, ?51, ?52, ?53, ?54, ?55, ?56, ?57, ?58, ?59, ?60, ?61, ?62, ?63, ?64, ?65, ?66, ?67, ?68, ?69, ?70, ?71, ?72, ?73, ?74, ?75, ?76, ?77, ?78, ?79, ?80, ?81, ?82, ?83, ?84, ?85)";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupProgress {
    pub stage_key: String,
    pub stage_label: String,
    pub status_text: String,
    pub progress_value: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub total_wfm_items: usize,
    pub total_wfstat_items: usize,
    pub matched_by_direct_ref: usize,
    pub matched_by_component_ref: usize,
    pub matched_by_market_slug: usize,
    pub matched_by_market_id: usize,
    pub matched_by_normalized_name: usize,
    pub matched_by_blueprint_decomposition: usize,
    pub matched_by_manual_alias: usize,
    pub unmatched_wfm_items: usize,
    pub wfm_only_canonical_items: usize,
    pub wfstat_only_canonical_items: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSummary {
    pub ready: bool,
    pub refreshed: bool,
    pub database_path: String,
    pub data_dir: String,
    pub wfm_source_file: String,
    pub wfstat_source_file: Option<String>,
    pub stats: ImportStats,
    pub current_wfm_api_version: Option<String>,
}

#[derive(Debug, Clone)]
struct AppPaths {
    data_dir: PathBuf,
    db_path: PathBuf,
    wfm_file_path: PathBuf,
    wfstat_file_path: PathBuf,
}

#[derive(Debug, Clone)]
struct SourceMeta {
    source_name: String,
    api_version: Option<String>,
    content_sha256: String,
    item_count: i64,
    fetched_at: String,
    source_file: String,
    notes: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct VersionRow {
    api_version: Option<String>,
    content_sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManualAliasSeedRow {
    #[serde(default = "default_wfm_source_name")]
    source_name: String,
    #[serde(default = "default_wfm_table_name")]
    source_table: String,
    lookup_type: String,
    lookup_value: String,
    target_type: String,
    target_value: String,
    #[serde(default = "default_true")]
    is_active: bool,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Debug, Clone)]
struct WfmRecord {
    id: String,
    slug: String,
    game_ref: Option<String>,
    name_en: Option<String>,
    normalized_name_en: Option<String>,
    variant: Option<VariantInfo>,
    item_family: Option<String>,
    raw: Value,
}

#[derive(Debug, Clone)]
struct WfstatRecord {
    unique_name: String,
    name: String,
    normalized_name: String,
    market_info_id: Option<String>,
    market_info_url_name: Option<String>,
    variant: Option<VariantInfo>,
    item_family: Option<String>,
    raw: Value,
}

#[derive(Debug, Clone)]
struct WfstatComponentRecord {
    parent_unique_name: String,
    component_index: usize,
    unique_name: Option<String>,
    name: Option<String>,
    normalized_name: Option<String>,
    variant: Option<VariantInfo>,
    item_family: Option<String>,
    raw: Value,
}

#[derive(Debug, Clone)]
struct VariantInfo {
    group_name: String,
    group_name_normalized: String,
    kind: String,
    value: String,
    value_normalized: String,
    rank: i64,
}

#[derive(Debug, Clone)]
struct BlueprintParts {
    parent_name: String,
    component_name: String,
}

#[derive(Debug, Clone)]
struct CanonicalItem {
    key: String,
    canonical_name: Option<String>,
    canonical_name_normalized: Option<String>,
    base_name: Option<String>,
    item_family: Option<String>,
    parent_key: Option<String>,
    preferred_name: Option<String>,
    preferred_slug: Option<String>,
    preferred_image: Option<String>,
    wfm_id: Option<String>,
    wfm_slug: Option<String>,
    wfm_game_ref: Option<String>,
    primary_wfstat_unique_name: Option<String>,
    wfstat_name: Option<String>,
    relic_tier: Option<String>,
    relic_code: Option<String>,
    notes: Option<String>,
    has_wfm: bool,
    has_wfstat: bool,
    primary_match_method: Option<String>,
    match_status: String,
}

#[derive(Debug, Clone)]
struct MatchOutcome {
    canonical_key: String,
    method: &'static str,
    matched_field: Option<String>,
    matched_value: Option<String>,
    notes: Option<String>,
}

#[derive(Default)]
struct MatchIndexes {
    top_by_unique_name: HashMap<String, String>,
    component_by_unique_name: HashMap<String, String>,
    top_by_market_url_name: HashMap<String, String>,
    top_by_market_id: HashMap<String, String>,
    top_by_normalized_name: HashMap<String, Vec<String>>,
    component_by_parent_and_name: HashMap<(String, String), String>,
}

#[derive(Default)]
struct ImportContext {
    canonical_items: BTreeMap<String, CanonicalItem>,
    wfm_records: Vec<WfmRecord>,
    wfstat_records: Vec<WfstatRecord>,
    wfstat_components: Vec<WfstatComponentRecord>,
    wfm_matches: HashMap<String, MatchOutcome>,
    indexes: MatchIndexes,
    stats: ImportStats,
}

#[derive(Debug)]
struct ReferenceSql {
    sql: &'static str,
    checksum: String,
}

pub fn initialize_app_catalog(app: AppHandle) -> Result<StartupSummary, String> {
    initialize_app_catalog_inner(app).map_err(|error| error.to_string())
}

fn initialize_app_catalog_inner(app: AppHandle) -> Result<StartupSummary> {
    emit_progress(
        &app,
        "startup",
        "Starting catalog sync",
        "Preparing storage and fetching source metadata.",
        0.02,
    );

    let paths = resolve_app_paths(&app)?;
    let now = iso_timestamp_now();
    let schema = reference_sql();
    let alias_seed = parse_manual_alias_seed()?;
    let alias_seed_checksum = sha256_hex(MANUAL_ALIAS_SEED_JSON.as_bytes());

    emit_progress(
        &app,
        "wfm-fetch",
        "Checking warframe.market",
        "Downloading the latest item catalog from warframe.market.",
        0.08,
    );
    let wfm_bytes = fetch_to_file(WFM_ITEMS_URL, &paths.wfm_file_path)?;
    let wfm_json: Value =
        serde_json::from_slice(&wfm_bytes).context("failed to parse WFM item response JSON")?;
    let wfm_meta = build_wfm_meta(&wfm_json, &paths.wfm_file_path, &now, &wfm_bytes)?;

    emit_progress(
        &app,
        "database-open",
        "Opening local catalog",
        "Ensuring the local item database schema is available.",
        0.14,
    );
    let mut connection = open_database(&paths.db_path)?;
    apply_reference_schema(&connection, schema.sql)?;

    let should_refresh = should_refresh_catalog(
        &connection,
        &wfm_meta,
        &schema.checksum,
        &alias_seed_checksum,
    )?;

    if !should_refresh {
        emit_progress(
            &app,
            "startup-complete",
            "Catalog ready",
            "The local item catalog is already current.",
            1.0,
        );

        return Ok(StartupSummary {
            ready: true,
            refreshed: false,
            database_path: paths.db_path.display().to_string(),
            data_dir: paths.data_dir.display().to_string(),
            wfm_source_file: paths.wfm_file_path.display().to_string(),
            wfstat_source_file: Some(paths.wfstat_file_path.display().to_string()),
            stats: load_existing_stats(&connection).unwrap_or_default(),
            current_wfm_api_version: wfm_meta.api_version.clone(),
        });
    }

    emit_progress(
        &app,
        "wfstat-fetch",
        "Refreshing WFStat",
        "Downloading the full unfiltered WFStat item catalog.",
        0.22,
    );
    let wfstat_bytes = fetch_to_file(WFSTAT_ITEMS_URL, &paths.wfstat_file_path)?;
    let wfstat_json: Value = serde_json::from_slice(&wfstat_bytes)
        .context("failed to parse WFStat item response JSON")?;
    let wfstat_meta =
        build_wfstat_meta(&wfstat_json, &paths.wfstat_file_path, &now, &wfstat_bytes)?;

    emit_progress(
        &app,
        "catalog-build",
        "Building canonical catalog",
        "Resolving canonical items, aliases, and cross-source matches.",
        0.36,
    );
    let import_context = build_import_context(&wfm_json, &wfstat_json)?;

    if import_context.stats.unmatched_wfm_items > 0 {
        return Err(anyhow!(
            "catalog import aborted: {} WFM items remain unmatched",
            import_context.stats.unmatched_wfm_items
        ));
    }

    emit_progress(
        &app,
        "database-import",
        "Writing SQLite catalog",
        "Replacing catalog rows in a single SQLite transaction.",
        0.58,
    );
    let summary = import_into_database(
        &mut connection,
        &paths,
        &schema,
        &alias_seed,
        &alias_seed_checksum,
        &wfm_meta,
        &wfstat_meta,
        &now,
        import_context,
    )?;

    emit_progress(
        &app,
        "startup-complete",
        "Catalog ready",
        "Startup item import completed successfully.",
        1.0,
    );

    Ok(summary)
}

fn build_import_context(wfm_json: &Value, wfstat_json: &Value) -> Result<ImportContext> {
    let mut context = ImportContext::default();
    let wfstat_values = wfstat_json
        .as_array()
        .ok_or_else(|| anyhow!("WFStat item payload is not an array"))?;

    for wfstat_value in wfstat_values {
        let record = parse_wfstat_record(wfstat_value)?;
        let canonical_key = build_top_level_canonical_key(&record);
        register_top_level_record(&mut context, &record, &canonical_key);

        if let Some(components) = get_array(wfstat_value, "components") {
            for (component_index, component_value) in components.iter().enumerate() {
                let component = parse_wfstat_component_record(
                    &record.unique_name,
                    component_index,
                    component_value,
                );
                let component_key = build_component_canonical_key(&record, &component);
                register_component_record(&mut context, &record, &component, &component_key);
            }
        }

        context.wfstat_records.push(record);
    }

    let wfm_values = wfm_json
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("WFM item payload is missing the data array"))?;

    context.stats.total_wfm_items = wfm_values.len();
    context.stats.total_wfstat_items = context.wfstat_records.len();

    let manual_alias_seed = parse_manual_alias_seed()?;
    for wfm_value in wfm_values {
        let record = parse_wfm_record(wfm_value)?;
        let match_outcome = match_wfm_record(&record, &context.indexes, &manual_alias_seed)?;

        update_stats_for_match(&mut context.stats, match_outcome.method);
        context
            .wfm_matches
            .insert(record.id.clone(), match_outcome.clone());
        update_canonical_from_wfm(&mut context.canonical_items, &record, &match_outcome)?;
        context.wfm_records.push(record);
    }

    finalize_canonical_statuses(&mut context);

    Ok(context)
}

fn import_into_database(
    connection: &mut Connection,
    paths: &AppPaths,
    schema: &ReferenceSql,
    alias_seed: &[ManualAliasSeedRow],
    alias_seed_checksum: &str,
    wfm_meta: &SourceMeta,
    wfstat_meta: &SourceMeta,
    fetched_at: &str,
    import_context: ImportContext,
) -> Result<StartupSummary> {
    let tx = connection.transaction()?;
    reset_catalog_tables(&tx)?;

    upsert_source_version(&tx, wfm_meta)?;
    upsert_source_version(&tx, wfstat_meta)?;
    upsert_source_version(
        &tx,
        &SourceMeta {
            source_name: SCHEMA_SOURCE_NAME.to_string(),
            api_version: Some(CURRENT_SCHEMA_VERSION.to_string()),
            content_sha256: schema.checksum.clone(),
            item_count: 0,
            fetched_at: fetched_at.to_string(),
            source_file: paths.db_path.display().to_string(),
            notes: Some("Reference schema copied into the runtime migration file.".to_string()),
        },
    )?;
    upsert_source_version(
        &tx,
        &SourceMeta {
            source_name: MANUAL_ALIAS_SOURCE_NAME.to_string(),
            api_version: None,
            content_sha256: alias_seed_checksum.to_string(),
            item_count: alias_seed.len() as i64,
            fetched_at: fetched_at.to_string(),
            source_file: paths.db_path.display().to_string(),
            notes: Some("Manual alias seed used by the startup item importer.".to_string()),
        },
    )?;
    insert_manual_alias_rows(&tx, alias_seed)?;

    let item_ids = insert_canonical_items(&tx, &import_context.canonical_items)?;
    apply_parent_item_links(&tx, &import_context.canonical_items, &item_ids)?;

    for record in &import_context.wfstat_records {
        insert_wfstat_record(&tx, record, &import_context, &item_ids)?;
    }

    for component in &import_context.wfstat_components {
        insert_wfstat_component_record(&tx, component, &import_context, &item_ids)?;
    }

    for record in &import_context.wfm_records {
        insert_wfm_record(&tx, record, &import_context, &item_ids)?;
    }

    tx.commit()?;

    log_import_stats(&import_context.stats);

    Ok(StartupSummary {
        ready: true,
        refreshed: true,
        database_path: paths.db_path.display().to_string(),
        data_dir: paths.data_dir.display().to_string(),
        wfm_source_file: paths.wfm_file_path.display().to_string(),
        wfstat_source_file: Some(paths.wfstat_file_path.display().to_string()),
        stats: import_context.stats,
        current_wfm_api_version: wfm_meta.api_version.clone(),
    })
}

fn register_top_level_record(
    context: &mut ImportContext,
    record: &WfstatRecord,
    canonical_key: &str,
) {
    let canonical_entry = context
        .canonical_items
        .entry(canonical_key.to_string())
        .or_insert_with(|| CanonicalItem {
            key: canonical_key.to_string(),
            canonical_name: Some(
                record
                    .variant
                    .as_ref()
                    .map(|variant| variant.group_name.clone())
                    .unwrap_or_else(|| record.name.clone()),
            ),
            canonical_name_normalized: Some(
                record
                    .variant
                    .as_ref()
                    .map(|variant| variant.group_name_normalized.clone())
                    .unwrap_or_else(|| record.normalized_name.clone()),
            ),
            base_name: Some(record.name.clone()),
            item_family: record.item_family.clone(),
            parent_key: None,
            preferred_name: Some(record.name.clone()),
            preferred_slug: record.market_info_url_name.clone(),
            preferred_image: get_string(&record.raw, "imageName"),
            wfm_id: None,
            wfm_slug: None,
            wfm_game_ref: None,
            primary_wfstat_unique_name: Some(record.unique_name.clone()),
            wfstat_name: Some(record.name.clone()),
            relic_tier: record.variant.as_ref().and_then(|variant| {
                variant
                    .group_name
                    .split_whitespace()
                    .next()
                    .map(str::to_string)
            }),
            relic_code: record.variant.as_ref().and_then(|variant| {
                variant
                    .group_name
                    .split_whitespace()
                    .nth(1)
                    .map(str::to_string)
            }),
            notes: None,
            has_wfm: false,
            has_wfstat: true,
            primary_match_method: Some("wfstat_top_level".to_string()),
            match_status: "wfstat_only".to_string(),
        });

    if canonical_entry.item_family.is_none() {
        canonical_entry.item_family = record.item_family.clone();
    }

    context
        .indexes
        .top_by_unique_name
        .insert(record.unique_name.clone(), canonical_key.to_string());
    if let Some(market_url_name) = &record.market_info_url_name {
        context
            .indexes
            .top_by_market_url_name
            .insert(market_url_name.clone(), canonical_key.to_string());
    }
    if let Some(market_id) = &record.market_info_id {
        context
            .indexes
            .top_by_market_id
            .insert(market_id.clone(), canonical_key.to_string());
    }
    context
        .indexes
        .top_by_normalized_name
        .entry(record.normalized_name.clone())
        .or_default()
        .push(canonical_key.to_string());

    if let Some(variant) = &record.variant {
        context
            .indexes
            .top_by_normalized_name
            .entry(variant.group_name_normalized.clone())
            .or_default()
            .push(canonical_key.to_string());
    }
}

fn register_component_record(
    context: &mut ImportContext,
    parent: &WfstatRecord,
    component: &WfstatComponentRecord,
    canonical_key: &str,
) {
    let canonical_name = component
        .variant
        .as_ref()
        .map(|variant| variant.group_name.clone())
        .or_else(|| component.name.clone());
    let canonical_name_normalized = component
        .variant
        .as_ref()
        .map(|variant| variant.group_name_normalized.clone())
        .or_else(|| component.normalized_name.clone());

    context
        .canonical_items
        .entry(canonical_key.to_string())
        .or_insert_with(|| CanonicalItem {
            key: canonical_key.to_string(),
            canonical_name,
            canonical_name_normalized,
            base_name: component.name.clone(),
            item_family: component
                .item_family
                .clone()
                .or_else(|| parent.item_family.clone()),
            parent_key: Some(build_top_level_canonical_key(parent)),
            preferred_name: component.name.clone(),
            preferred_slug: None,
            preferred_image: get_string(&component.raw, "imageName"),
            wfm_id: None,
            wfm_slug: None,
            wfm_game_ref: None,
            primary_wfstat_unique_name: component.unique_name.clone(),
            wfstat_name: component.name.clone(),
            relic_tier: None,
            relic_code: None,
            notes: Some("Canonical item created from a WFStat component record.".to_string()),
            has_wfm: false,
            has_wfstat: true,
            primary_match_method: Some("wfstat_component".to_string()),
            match_status: "wfstat_only".to_string(),
        });

    if let Some(unique_name) = &component.unique_name {
        context
            .indexes
            .component_by_unique_name
            .insert(unique_name.clone(), canonical_key.to_string());
    }
    if let Some(normalized_name) = &component.normalized_name {
        context.indexes.component_by_parent_and_name.insert(
            (parent.normalized_name.clone(), normalized_name.clone()),
            canonical_key.to_string(),
        );
        context.indexes.component_by_parent_and_name.insert(
            (
                parent.normalized_name.clone(),
                normalize_name(&format!(
                    "{} {}",
                    parent.name,
                    component.name.clone().unwrap_or_default()
                )),
            ),
            canonical_key.to_string(),
        );
    }

    context.wfstat_components.push(component.clone());
}

fn update_canonical_from_wfm(
    canonical_items: &mut BTreeMap<String, CanonicalItem>,
    record: &WfmRecord,
    outcome: &MatchOutcome,
) -> Result<()> {
    let canonical = canonical_items
        .entry(outcome.canonical_key.clone())
        .or_insert_with(|| CanonicalItem {
            key: outcome.canonical_key.clone(),
            canonical_name: record
                .variant
                .as_ref()
                .map(|variant| variant.group_name.clone())
                .or_else(|| record.name_en.clone()),
            canonical_name_normalized: record
                .variant
                .as_ref()
                .map(|variant| variant.group_name_normalized.clone())
                .or_else(|| record.normalized_name_en.clone()),
            base_name: record.name_en.clone(),
            item_family: record.item_family.clone(),
            parent_key: None,
            preferred_name: record.name_en.clone(),
            preferred_slug: Some(record.slug.clone()),
            preferred_image: record
                .raw
                .get("i18n")
                .and_then(|value| value.get("en"))
                .and_then(|value| get_string(value, "thumb").or_else(|| get_string(value, "icon"))),
            wfm_id: None,
            wfm_slug: None,
            wfm_game_ref: None,
            primary_wfstat_unique_name: None,
            wfstat_name: None,
            relic_tier: None,
            relic_code: None,
            notes: Some("Canonical item created from a manual WFM alias fallback.".to_string()),
            has_wfm: false,
            has_wfstat: false,
            primary_match_method: Some(outcome.method.to_string()),
            match_status: "wfm_only".to_string(),
        });

    canonical.has_wfm = true;
    canonical.match_status = if canonical.has_wfstat {
        "matched".to_string()
    } else {
        "wfm_only".to_string()
    };
    if canonical.primary_match_method.is_none()
        || canonical.primary_match_method.as_deref() == Some("wfstat_top_level")
    {
        canonical.primary_match_method = Some(outcome.method.to_string());
    }
    if canonical.wfm_id.is_none() {
        canonical.wfm_id = Some(record.id.clone());
        canonical.wfm_slug = Some(record.slug.clone());
        canonical.wfm_game_ref = record.game_ref.clone();
        canonical.preferred_slug = Some(record.slug.clone());
        canonical.preferred_name = record
            .name_en
            .clone()
            .or_else(|| canonical.preferred_name.clone());
        canonical.preferred_image = record
            .raw
            .get("i18n")
            .and_then(|value| value.get("en"))
            .and_then(|value| get_string(value, "thumb").or_else(|| get_string(value, "icon")));
    }
    if canonical.canonical_name.is_none() {
        canonical.canonical_name = record.name_en.clone();
        canonical.canonical_name_normalized = record.normalized_name_en.clone();
    }
    if let Some(variant) = &record.variant {
        if canonical.relic_tier.is_none() {
            canonical.relic_tier = variant
                .group_name
                .split_whitespace()
                .next()
                .map(str::to_string);
        }
        if canonical.relic_code.is_none() {
            canonical.relic_code = variant
                .group_name
                .split_whitespace()
                .nth(1)
                .map(str::to_string);
        }
    }

    Ok(())
}

fn finalize_canonical_statuses(context: &mut ImportContext) {
    for canonical in context.canonical_items.values_mut() {
        canonical.match_status = match (canonical.has_wfm, canonical.has_wfstat) {
            (true, true) => "matched".to_string(),
            (true, false) => "wfm_only".to_string(),
            (false, true) => "wfstat_only".to_string(),
            (false, false) => "orphaned".to_string(),
        };
    }

    context.stats.wfm_only_canonical_items = context
        .canonical_items
        .values()
        .filter(|item| item.match_status == "wfm_only")
        .count();
    context.stats.wfstat_only_canonical_items = context
        .canonical_items
        .values()
        .filter(|item| item.match_status == "wfstat_only")
        .count();
}

fn match_wfm_record(
    record: &WfmRecord,
    indexes: &MatchIndexes,
    alias_seed: &[ManualAliasSeedRow],
) -> Result<MatchOutcome> {
    if let Some(game_ref) = &record.game_ref {
        if let Some(canonical_key) = indexes.top_by_unique_name.get(game_ref) {
            return Ok(MatchOutcome {
                canonical_key: canonical_key.clone(),
                method: "gameRef_to_wfstat_uniqueName",
                matched_field: Some("gameRef".to_string()),
                matched_value: Some(game_ref.clone()),
                notes: None,
            });
        }
        if let Some(canonical_key) = indexes.component_by_unique_name.get(game_ref) {
            return Ok(MatchOutcome {
                canonical_key: canonical_key.clone(),
                method: "gameRef_to_wfstat_component_uniqueName",
                matched_field: Some("gameRef".to_string()),
                matched_value: Some(game_ref.clone()),
                notes: None,
            });
        }
    }

    if let Some(canonical_key) = indexes.top_by_market_url_name.get(&record.slug) {
        return Ok(MatchOutcome {
            canonical_key: canonical_key.clone(),
            method: "wfm_slug_to_wfstat_market_url_name",
            matched_field: Some("slug".to_string()),
            matched_value: Some(record.slug.clone()),
            notes: None,
        });
    }

    if let Some(canonical_key) = indexes.top_by_market_id.get(&record.id) {
        return Ok(MatchOutcome {
            canonical_key: canonical_key.clone(),
            method: "wfm_id_to_wfstat_market_id",
            matched_field: Some("id".to_string()),
            matched_value: Some(record.id.clone()),
            notes: None,
        });
    }

    if let Some(variant) = &record.variant {
        if let Some(canonical_key) =
            resolve_unique_name_match(indexes, &variant.group_name_normalized)
        {
            return Ok(MatchOutcome {
                canonical_key,
                method: "normalized_name_to_wfstat_name",
                matched_field: Some("i18n.en.name".to_string()),
                matched_value: Some(variant.group_name.clone()),
                notes: Some(
                    "Resolved a relic refinement to the base relic canonical item.".to_string(),
                ),
            });
        }
    }

    if let Some(normalized_name) = &record.normalized_name_en {
        if let Some(canonical_key) = resolve_unique_name_match(indexes, normalized_name) {
            return Ok(MatchOutcome {
                canonical_key,
                method: "normalized_name_to_wfstat_name",
                matched_field: Some("i18n.en.name".to_string()),
                matched_value: record.name_en.clone(),
                notes: None,
            });
        }
    }

    if let Some(name) = &record.name_en {
        if let Some(parts) = split_blueprint_name(name) {
            let parent_key = normalize_name(&parts.parent_name);
            let component_key = normalize_name(&parts.component_name);
            if let Some(canonical_key) = indexes
                .component_by_parent_and_name
                .get(&(parent_key, component_key))
            {
                return Ok(MatchOutcome {
                    canonical_key: canonical_key.clone(),
                    method: "blueprint_parent_component_name",
                    matched_field: Some("i18n.en.name".to_string()),
                    matched_value: Some(name.clone()),
                    notes: None,
                });
            }
        }
    }

    if let Some(outcome) = match_manual_alias(record, indexes, alias_seed) {
        return Ok(outcome);
    }

    Ok(MatchOutcome {
        canonical_key: format!("unmatched:{}", record.id),
        method: "unmatched",
        matched_field: None,
        matched_value: None,
        notes: Some("No canonical match satisfied the required import rules.".to_string()),
    })
}

fn match_manual_alias(
    record: &WfmRecord,
    indexes: &MatchIndexes,
    alias_seed: &[ManualAliasSeedRow],
) -> Option<MatchOutcome> {
    for alias in alias_seed.iter().filter(|entry| entry.is_active) {
        if !manual_alias_matches_record(alias, record) {
            continue;
        }

        if let Some(canonical_key) = resolve_manual_alias_target(alias, indexes) {
            return Some(MatchOutcome {
                canonical_key,
                method: "manual_alias",
                matched_field: Some(alias.lookup_type.clone()),
                matched_value: Some(alias.lookup_value.clone()),
                notes: alias.notes.clone(),
            });
        }
    }

    None
}

fn manual_alias_matches_record(alias: &ManualAliasSeedRow, record: &WfmRecord) -> bool {
    match alias.lookup_type.as_str() {
        "wfm_id" => alias.lookup_value == record.id,
        "wfm_slug" => alias.lookup_value == record.slug,
        "wfm_game_ref" => record.game_ref.as_deref() == Some(alias.lookup_value.as_str()),
        "wfm_name" => record.name_en.as_deref() == Some(alias.lookup_value.as_str()),
        "wfm_normalized_name" => {
            record.normalized_name_en.as_deref() == Some(alias.lookup_value.as_str())
        }
        _ => false,
    }
}

fn resolve_manual_alias_target(
    alias: &ManualAliasSeedRow,
    indexes: &MatchIndexes,
) -> Option<String> {
    match alias.target_type.as_str() {
        "wfstat_unique_name" => indexes.top_by_unique_name.get(&alias.target_value).cloned(),
        "wfstat_component_unique_name" => indexes
            .component_by_unique_name
            .get(&alias.target_value)
            .cloned(),
        "wfstat_name" => resolve_unique_name_match(indexes, &normalize_name(&alias.target_value)),
        "canonical_key" => Some(alias.target_value.clone()),
        _ => None,
    }
}

fn resolve_unique_name_match(indexes: &MatchIndexes, normalized_name: &str) -> Option<String> {
    let matches = indexes.top_by_normalized_name.get(normalized_name)?;
    let unique_matches = matches.iter().cloned().collect::<BTreeSet<_>>();
    if unique_matches.len() == 1 {
        unique_matches.into_iter().next()
    } else {
        None
    }
}

fn parse_wfm_record(value: &Value) -> Result<WfmRecord> {
    let id = get_required_string(value, "id")?;
    let slug = get_required_string(value, "slug")?;
    let name_en = value
        .get("i18n")
        .and_then(|entry| entry.get("en"))
        .and_then(|entry| get_string(entry, "name"));

    Ok(WfmRecord {
        id,
        slug,
        game_ref: get_string(value, "gameRef"),
        normalized_name_en: name_en.as_deref().map(normalize_name),
        variant: name_en.as_deref().and_then(parse_variant_info),
        item_family: derive_wfm_item_family(value),
        name_en,
        raw: value.clone(),
    })
}

fn parse_wfstat_record(value: &Value) -> Result<WfstatRecord> {
    let unique_name = get_required_string(value, "uniqueName")?;
    let name = get_required_string(value, "name")?;

    Ok(WfstatRecord {
        unique_name,
        name: name.clone(),
        normalized_name: normalize_name(&name),
        market_info_id: value
            .get("marketInfo")
            .and_then(|entry| get_string(entry, "id")),
        market_info_url_name: value
            .get("marketInfo")
            .and_then(|entry| get_string(entry, "urlName")),
        variant: parse_variant_info(&name),
        item_family: derive_wfstat_item_family(value),
        raw: value.clone(),
    })
}

fn parse_wfstat_component_record(
    parent_unique_name: &str,
    component_index: usize,
    value: &Value,
) -> WfstatComponentRecord {
    let name = get_string(value, "name");
    WfstatComponentRecord {
        parent_unique_name: parent_unique_name.to_string(),
        component_index,
        unique_name: get_string(value, "uniqueName"),
        normalized_name: name.as_deref().map(normalize_name),
        variant: name.as_deref().and_then(parse_variant_info),
        item_family: derive_wfstat_item_family(value),
        name,
        raw: value.clone(),
    }
}

fn build_top_level_canonical_key(record: &WfstatRecord) -> String {
    if let Some(variant) = &record.variant {
        if variant.kind == "relic_refinement" {
            return format!("relic:{}", variant.group_name_normalized);
        }
    }

    format!("wfstat:{}", record.unique_name)
}

fn build_component_canonical_key(
    parent: &WfstatRecord,
    component: &WfstatComponentRecord,
) -> String {
    if let Some(unique_name) = &component.unique_name {
        return format!("wfstat_component:{}", unique_name);
    }

    format!(
        "wfstat_component:{}:{}:{}",
        parent.unique_name,
        component.component_index,
        component
            .normalized_name
            .clone()
            .unwrap_or_else(|| "unnamed_component".to_string())
    )
}

fn wfstat_component_source_record_key(component: &WfstatComponentRecord) -> String {
    format!(
        "{}#{}",
        component.parent_unique_name, component.component_index
    )
}

fn insert_canonical_items(
    tx: &Transaction<'_>,
    canonical_items: &BTreeMap<String, CanonicalItem>,
) -> Result<HashMap<String, i64>> {
    let mut item_ids = HashMap::new();

    for canonical in canonical_items.values() {
        tx.execute(
            "INSERT INTO items (
                canonical_ref,
                canonical_name,
                canonical_name_normalized,
                base_name,
                item_family,
                parent_item_id,
                match_status,
                primary_match_method,
                preferred_name,
                preferred_slug,
                preferred_image,
                wfm_id,
                wfm_slug,
                wfm_game_ref,
                primary_wfstat_unique_name,
                wfstat_name,
                relic_tier,
                relic_code,
                notes
            ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                canonical.key,
                canonical.canonical_name,
                canonical.canonical_name_normalized,
                canonical.base_name,
                canonical.item_family,
                canonical.match_status,
                canonical.primary_match_method,
                canonical.preferred_name,
                canonical.preferred_slug,
                canonical.preferred_image,
                canonical.wfm_id,
                canonical.wfm_slug,
                canonical.wfm_game_ref,
                canonical.primary_wfstat_unique_name,
                canonical.wfstat_name,
                canonical.relic_tier,
                canonical.relic_code,
                canonical.notes,
            ],
        )?;
        item_ids.insert(canonical.key.clone(), tx.last_insert_rowid());
    }

    Ok(item_ids)
}

fn apply_parent_item_links(
    tx: &Transaction<'_>,
    canonical_items: &BTreeMap<String, CanonicalItem>,
    item_ids: &HashMap<String, i64>,
) -> Result<()> {
    for canonical in canonical_items.values() {
        let Some(parent_key) = &canonical.parent_key else {
            continue;
        };
        let Some(item_id) = item_ids.get(&canonical.key) else {
            continue;
        };
        let Some(parent_item_id) = item_ids.get(parent_key) else {
            continue;
        };

        tx.execute(
            "UPDATE items SET parent_item_id = ?1 WHERE item_id = ?2",
            params![parent_item_id, item_id],
        )?;
    }

    Ok(())
}

fn insert_wfm_record(
    tx: &Transaction<'_>,
    record: &WfmRecord,
    import_context: &ImportContext,
    item_ids: &HashMap<String, i64>,
) -> Result<()> {
    let outcome = import_context
        .wfm_matches
        .get(&record.id)
        .ok_or_else(|| anyhow!("missing match outcome for WFM record {}", record.id))?;

    if outcome.method == "unmatched" {
        return Err(anyhow!("WFM item {} was left unmatched", record.id));
    }

    let item_id = item_ids
        .get(&outcome.canonical_key)
        .copied()
        .ok_or_else(|| {
            anyhow!(
                "missing item_id for canonical key {}",
                outcome.canonical_key
            )
        })?;

    let i18n_en = record.raw.get("i18n").and_then(|value| value.get("en"));
    tx.execute(
        "INSERT INTO wfm_items (
            wfm_id,
            item_id,
            slug,
            game_ref,
            name_en,
            normalized_name_en,
            item_family,
            variant_group_name,
            variant_group_name_normalized,
            variant_kind,
            variant_value,
            variant_value_normalized,
            variant_rank,
            icon,
            thumb,
            sub_icon,
            base_endo,
            bulk_tradable,
            ducats,
            endo_multiplier,
            max_amber_stars,
            max_cyan_stars,
            max_rank,
            vaulted,
            raw_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
        params![
            record.id,
            item_id,
            record.slug,
            record.game_ref,
            record.name_en,
            record.normalized_name_en,
            record.item_family,
            record.variant.as_ref().map(|value| value.group_name.clone()),
            record
                .variant
                .as_ref()
                .map(|value| value.group_name_normalized.clone()),
            record.variant.as_ref().map(|value| value.kind.clone()),
            record.variant.as_ref().map(|value| value.value.clone()),
            record
                .variant
                .as_ref()
                .map(|value| value.value_normalized.clone()),
            record.variant.as_ref().map(|value| value.rank),
            i18n_en.and_then(|value| get_string(value, "icon")),
            i18n_en.and_then(|value| get_string(value, "thumb")),
            i18n_en.and_then(|value| get_string(value, "subIcon")),
            get_i64(&record.raw, "baseEndo"),
            get_bool_as_i64(&record.raw, "bulkTradable"),
            get_i64(&record.raw, "ducats"),
            get_f64(&record.raw, "endoMultiplier"),
            get_i64(&record.raw, "maxAmberStars"),
            get_i64(&record.raw, "maxCyanStars"),
            get_i64(&record.raw, "maxRank"),
            get_bool_as_i64(&record.raw, "vaulted"),
            serde_json::to_string(&record.raw)?,
        ],
    )?;

    insert_source_match(
        tx,
        Some(item_id),
        WFM_SOURCE_NAME,
        "wfm_items",
        &record.id,
        record.name_en.as_deref(),
        outcome.method,
        outcome.matched_field.as_deref(),
        outcome.matched_value.as_deref(),
        if outcome.method == "manual_alias" {
            Some(1)
        } else {
            Some(0)
        },
        outcome.notes.as_deref(),
    )?;

    insert_alias(
        tx,
        item_id,
        "wfm_id",
        &record.id,
        Some(&normalize_name(&record.id)),
        WFM_SOURCE_NAME,
        "wfm_items",
        &record.id,
        true,
        None,
    )?;
    insert_alias(
        tx,
        item_id,
        "wfm_slug",
        &record.slug,
        Some(&normalize_name(&record.slug)),
        WFM_SOURCE_NAME,
        "wfm_items",
        &record.id,
        false,
        None,
    )?;
    if let Some(game_ref) = &record.game_ref {
        insert_alias(
            tx,
            item_id,
            "wfm_game_ref",
            game_ref,
            Some(&normalize_name(game_ref)),
            WFM_SOURCE_NAME,
            "wfm_items",
            &record.id,
            false,
            None,
        )?;
    }
    if let Some(name_en) = &record.name_en {
        insert_alias(
            tx,
            item_id,
            "wfm_name_en",
            name_en,
            Some(&normalize_name(name_en)),
            WFM_SOURCE_NAME,
            "wfm_items",
            &record.id,
            true,
            None,
        )?;
        insert_alias(
            tx,
            item_id,
            "normalized_name",
            &normalize_name(name_en),
            Some(&normalize_name(name_en)),
            WFM_SOURCE_NAME,
            "wfm_items",
            &record.id,
            false,
            Some("Derived normalized WFM English name."),
        )?;
    }

    if let Some(variant) = &record.variant {
        insert_variant(
            tx,
            item_id,
            WFM_SOURCE_NAME,
            "wfm_items",
            &record.id,
            variant,
            true,
            Some("Variant derived from the WFM display name."),
        )?;
    }

    if let Some(i18n_object) = record.raw.get("i18n").and_then(Value::as_object) {
        for (lang_code, entry) in i18n_object {
            tx.execute(
                "INSERT INTO wfm_item_i18n (wfm_id, lang_code, name, icon, thumb, sub_icon)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    record.id,
                    lang_code,
                    get_string(entry, "name"),
                    get_string(entry, "icon"),
                    get_string(entry, "thumb"),
                    get_string(entry, "subIcon"),
                ],
            )?;
        }
    }

    insert_string_array(
        tx,
        "INSERT INTO wfm_item_tags (wfm_id, tag_index, tag) VALUES (?1, ?2, ?3)",
        &record.id,
        get_array(&record.raw, "tags"),
    )?;
    insert_string_array(
        tx,
        "INSERT INTO wfm_item_subtypes (wfm_id, subtype_index, subtype) VALUES (?1, ?2, ?3)",
        &record.id,
        get_array(&record.raw, "subtypes"),
    )?;

    Ok(())
}

fn insert_wfstat_record(
    tx: &Transaction<'_>,
    record: &WfstatRecord,
    import_context: &ImportContext,
    item_ids: &HashMap<String, i64>,
) -> Result<()> {
    let canonical_key = build_top_level_canonical_key(record);
    let item_id = item_ids
        .get(&canonical_key)
        .copied()
        .ok_or_else(|| anyhow!("missing item_id for {}", canonical_key))?;

    tx.execute(
        WFSTAT_ITEMS_INSERT_SQL,
        params![
            record.unique_name,
            item_id,
            record.name,
            record.normalized_name,
            record.item_family,
            record
                .variant
                .as_ref()
                .map(|value| value.group_name.clone()),
            record
                .variant
                .as_ref()
                .map(|value| value.group_name_normalized.clone()),
            record.variant.as_ref().map(|value| value.kind.clone()),
            record.variant.as_ref().map(|value| value.value.clone()),
            record
                .variant
                .as_ref()
                .map(|value| value.value_normalized.clone()),
            record.variant.as_ref().map(|value| value.rank),
            get_string(&record.raw, "description"),
            get_string(&record.raw, "category"),
            get_string(&record.raw, "type"),
            get_string(&record.raw, "imageName"),
            get_string(&record.raw, "compatName"),
            get_string(&record.raw, "rarity"),
            get_string(&record.raw, "polarity"),
            get_string(&record.raw, "stancePolarity"),
            get_string(&record.raw, "productCategory"),
            get_string(&record.raw, "modSet"),
            get_required_bool_as_i64(&record.raw, "tradable")?,
            get_bool_as_i64(&record.raw, "masterable"),
            get_bool_as_i64(&record.raw, "transmutable"),
            get_bool_as_i64(&record.raw, "isAugment"),
            get_bool_as_i64(&record.raw, "isPrime"),
            get_bool_as_i64(&record.raw, "isExilus"),
            get_bool_as_i64(&record.raw, "isUtility"),
            get_bool_as_i64(&record.raw, "vaulted"),
            get_bool_as_i64(&record.raw, "wikiAvailable"),
            get_bool_as_i64(&record.raw, "excludeFromCodex"),
            get_bool_as_i64(&record.raw, "showInInventory"),
            get_bool_as_i64(&record.raw, "consumeOnBuild"),
            get_i64_any(&record.raw, "baseDrain"),
            get_i64_any(&record.raw, "fusionLimit"),
            get_i64_any(&record.raw, "itemCount"),
            get_i64_any(&record.raw, "masteryReq"),
            get_i64_any(&record.raw, "marketCost"),
            get_i64_any(&record.raw, "bpCost"),
            get_i64_any(&record.raw, "buildPrice"),
            get_i64_any(&record.raw, "buildQuantity"),
            get_i64_any(&record.raw, "buildTime"),
            get_i64_any(&record.raw, "skipBuildTimePrice"),
            get_f64_any(&record.raw, "accuracy"),
            get_f64_any(&record.raw, "criticalChance"),
            get_f64_any(&record.raw, "criticalMultiplier"),
            get_f64_any(&record.raw, "fireRate"),
            get_f64_any(&record.raw, "omegaAttenuation"),
            get_f64_any(&record.raw, "procChance"),
            get_f64_any(&record.raw, "reloadTime"),
            get_i64_any(&record.raw, "magazineSize"),
            get_i64_any(&record.raw, "multishot"),
            get_i64_any(&record.raw, "slot"),
            get_f64_any(&record.raw, "totalDamage"),
            get_i64_any(&record.raw, "disposition"),
            get_f64_any(&record.raw, "range"),
            get_f64_any(&record.raw, "followThrough"),
            get_i64_any(&record.raw, "blockingAngle"),
            get_i64_any(&record.raw, "comboDuration"),
            get_i64_any(&record.raw, "heavyAttackDamage"),
            get_i64_any(&record.raw, "heavySlamAttack"),
            get_i64_any(&record.raw, "heavySlamRadialDamage"),
            get_i64_any(&record.raw, "heavySlamRadius"),
            get_i64_any(&record.raw, "slamAttack"),
            get_i64_any(&record.raw, "slamRadialDamage"),
            get_i64_any(&record.raw, "slamRadius"),
            get_i64_any(&record.raw, "slideAttack"),
            get_f64_any(&record.raw, "windUp"),
            get_i64_any(&record.raw, "power"),
            get_i64_any(&record.raw, "stamina"),
            get_i64_any(&record.raw, "health"),
            get_i64_any(&record.raw, "shield"),
            get_i64_any(&record.raw, "armor"),
            get_f64_any(&record.raw, "sprintSpeed"),
            get_i64_any(&record.raw, "regionBits"),
            get_string_any(&record.raw, "releaseDate"),
            get_string_any(&record.raw, "vaultDate"),
            get_string_any(&record.raw, "estimatedVaultDate"),
            get_string(&record.raw, "wikiaThumbnail"),
            get_string(&record.raw, "wikiaUrl"),
            get_string(&record.raw, "noise"),
            get_string(&record.raw, "trigger"),
            record.market_info_id,
            record.market_info_url_name,
            serde_json::to_string(&record.raw)?,
        ],
    )?;

    insert_source_match(
        tx,
        Some(item_id),
        WFSTAT_SOURCE_NAME,
        "wfstat_items",
        &record.unique_name,
        Some(&record.name),
        "wfstat_top_level",
        Some("uniqueName"),
        Some(&record.unique_name),
        Some(0),
        None,
    )?;

    insert_alias(
        tx,
        item_id,
        "wfstat_unique_name",
        &record.unique_name,
        Some(&normalize_name(&record.unique_name)),
        WFSTAT_SOURCE_NAME,
        "wfstat_items",
        &record.unique_name,
        true,
        None,
    )?;
    insert_alias(
        tx,
        item_id,
        "wfstat_name",
        &record.name,
        Some(&record.normalized_name),
        WFSTAT_SOURCE_NAME,
        "wfstat_items",
        &record.unique_name,
        true,
        None,
    )?;
    insert_alias(
        tx,
        item_id,
        "normalized_name",
        &record.normalized_name,
        Some(&record.normalized_name),
        WFSTAT_SOURCE_NAME,
        "wfstat_items",
        &record.unique_name,
        false,
        Some("Derived normalized WFStat item name."),
    )?;
    if let Some(market_info_id) = &record.market_info_id {
        insert_alias(
            tx,
            item_id,
            "wfstat_market_info_id",
            market_info_id,
            Some(&normalize_name(market_info_id)),
            WFSTAT_SOURCE_NAME,
            "wfstat_items",
            &record.unique_name,
            false,
            None,
        )?;
    }
    if let Some(market_info_url_name) = &record.market_info_url_name {
        insert_alias(
            tx,
            item_id,
            "wfstat_market_info_url_name",
            market_info_url_name,
            Some(&normalize_name(market_info_url_name)),
            WFSTAT_SOURCE_NAME,
            "wfstat_items",
            &record.unique_name,
            false,
            None,
        )?;
    }

    if let Some(variant) = &record.variant {
        insert_variant(
            tx,
            item_id,
            WFSTAT_SOURCE_NAME,
            "wfstat_items",
            &record.unique_name,
            variant,
            true,
            Some("Variant derived from the WFStat item name."),
        )?;
    }

    insert_introduced_record(
        tx,
        "wfstat_item_introduced",
        "wfstat_item_introduced_aliases",
        &record.unique_name,
        &record.raw,
    )?;
    insert_damage_table(
        tx,
        "wfstat_item_damage",
        "wfstat_unique_name",
        &record.unique_name,
        record.raw.get("damage"),
    )?;
    insert_damage_per_shot_table(
        tx,
        "wfstat_item_damage_per_shot",
        "wfstat_unique_name",
        &record.unique_name,
        record.raw.get("damagePerShot"),
    )?;
    insert_string_array(
        tx,
        "INSERT INTO wfstat_item_tags (wfstat_unique_name, tag_index, tag) VALUES (?1, ?2, ?3)",
        &record.unique_name,
        get_array(&record.raw, "tags"),
    )?;
    insert_string_array(
        tx,
        "INSERT INTO wfstat_item_polarities (wfstat_unique_name, polarity_index, polarity) VALUES (?1, ?2, ?3)",
        &record.unique_name,
        get_array(&record.raw, "polarities"),
    )?;
    insert_parent_rows(tx, record, import_context, item_ids)?;
    insert_level_rows(tx, record)?;
    insert_drop_rows(tx, record, import_context, item_ids)?;
    insert_location_rows(tx, record)?;
    insert_patchlog_rows(tx, record)?;
    insert_reward_rows(tx, record, import_context, item_ids)?;
    insert_resistance_rows(tx, record)?;
    insert_ability_rows(tx, record)?;
    insert_attack_rows(
        tx,
        "wfstat_item_attacks",
        "wfstat_item_attack_damage",
        "wfstat_item_attack_falloff",
        "wfstat_unique_name",
        &record.unique_name,
        record.raw.get("attacks"),
    )?;

    Ok(())
}

fn insert_wfstat_component_record(
    tx: &Transaction<'_>,
    component: &WfstatComponentRecord,
    import_context: &ImportContext,
    item_ids: &HashMap<String, i64>,
) -> Result<()> {
    let parent_record = import_context
        .wfstat_records
        .iter()
        .find(|record| record.unique_name == component.parent_unique_name)
        .ok_or_else(|| anyhow!("missing WFStat parent {}", component.parent_unique_name))?;
    let canonical_key = build_component_canonical_key(parent_record, component);
    let component_item_id = item_ids
        .get(&canonical_key)
        .copied()
        .ok_or_else(|| anyhow!("missing component item_id for {}", canonical_key))?;
    let parent_item_id = item_ids
        .get(&build_top_level_canonical_key(parent_record))
        .copied()
        .ok_or_else(|| anyhow!("missing parent item_id for {}", parent_record.unique_name))?;
    let component_source_record_key = wfstat_component_source_record_key(component);

    tx.execute(
        "INSERT INTO wfstat_item_components (
            wfstat_unique_name,
            component_item_id,
            component_index,
            component_unique_name,
            name,
            description,
            image_name,
            type,
            product_category,
            release_date,
            estimated_vault_date,
            wikia_thumbnail,
            wikia_url,
            wiki_available,
            tradable,
            masterable,
            vaulted,
            accuracy,
            critical_chance,
            critical_multiplier,
            fire_rate,
            omega_attenuation,
            proc_chance,
            reload_time,
            magazine_size,
            multishot,
            slot,
            total_damage,
            disposition,
            mastery_req,
            ducats,
            prime_selling_price,
            item_count,
            noise,
            trigger,
            raw_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36)",
        params![
            component.parent_unique_name,
            component_item_id,
            component.component_index as i64,
            component.unique_name,
            component.name,
            get_string(&component.raw, "description"),
            get_string(&component.raw, "imageName"),
            get_string(&component.raw, "type"),
            get_string(&component.raw, "productCategory"),
            get_string_any(&component.raw, "releaseDate"),
            get_string_any(&component.raw, "estimatedVaultDate"),
            get_string(&component.raw, "wikiaThumbnail"),
            get_string(&component.raw, "wikiaUrl"),
            get_bool_as_i64(&component.raw, "wikiAvailable"),
            get_bool_as_i64(&component.raw, "tradable"),
            get_bool_as_i64(&component.raw, "masterable"),
            get_bool_as_i64(&component.raw, "vaulted"),
            get_f64_any(&component.raw, "accuracy"),
            get_f64_any(&component.raw, "criticalChance"),
            get_f64_any(&component.raw, "criticalMultiplier"),
            get_f64_any(&component.raw, "fireRate"),
            get_f64_any(&component.raw, "omegaAttenuation"),
            get_f64_any(&component.raw, "procChance"),
            get_f64_any(&component.raw, "reloadTime"),
            get_i64_any(&component.raw, "magazineSize"),
            get_i64_any(&component.raw, "multishot"),
            get_i64_any(&component.raw, "slot"),
            get_f64_any(&component.raw, "totalDamage"),
            get_i64_any(&component.raw, "disposition"),
            get_i64_any(&component.raw, "masteryReq"),
            get_i64_any(&component.raw, "ducats"),
            get_i64_any(&component.raw, "primeSellingPrice"),
            get_i64_any(&component.raw, "itemCount"),
            get_string(&component.raw, "noise"),
            get_string(&component.raw, "trigger"),
            serde_json::to_string(&component.raw)?,
        ],
    )?;

    let component_id = tx.last_insert_rowid();

    insert_source_match(
        tx,
        Some(component_item_id),
        WFSTAT_SOURCE_NAME,
        "wfstat_item_components",
        &component_source_record_key,
        component.name.as_deref(),
        "wfstat_component",
        Some("component_unique_name"),
        component
            .unique_name
            .as_deref()
            .or(component.name.as_deref()),
        Some(0),
        None,
    )?;

    if let Some(unique_name) = &component.unique_name {
        insert_alias(
            tx,
            component_item_id,
            "wfstat_component_unique_name",
            unique_name,
            Some(&normalize_name(unique_name)),
            WFSTAT_SOURCE_NAME,
            "wfstat_item_components",
            &component_source_record_key,
            true,
            None,
        )?;
    }
    if let Some(name) = &component.name {
        insert_alias(
            tx,
            component_item_id,
            "wfstat_component_name",
            name,
            Some(&normalize_name(name)),
            WFSTAT_SOURCE_NAME,
            "wfstat_item_components",
            &component_source_record_key,
            true,
            None,
        )?;
        insert_alias(
            tx,
            component_item_id,
            "normalized_name",
            &normalize_name(name),
            Some(&normalize_name(name)),
            WFSTAT_SOURCE_NAME,
            "wfstat_item_components",
            &component_source_record_key,
            false,
            Some("Derived normalized WFStat component name."),
        )?;
    }

    if let Some(variant) = &component.variant {
        insert_variant(
            tx,
            component_item_id,
            WFSTAT_SOURCE_NAME,
            "wfstat_item_components",
            &component_source_record_key,
            variant,
            true,
            Some("Variant derived from the WFStat component name."),
        )?;
    }

    insert_relationship(
        tx,
        parent_item_id,
        component_item_id,
        "wfstat_component_of",
        Some(WFSTAT_SOURCE_NAME),
        Some(&component.parent_unique_name),
        component.name.as_deref(),
        Some(component.component_index as i64),
        None,
    )?;

    insert_component_introduced_record(tx, component_id, &component.raw)?;
    insert_damage_table(
        tx,
        "wfstat_component_damage",
        "component_id",
        &component_id.to_string(),
        component.raw.get("damage"),
    )?;
    insert_damage_per_shot_table(
        tx,
        "wfstat_component_damage_per_shot",
        "component_id",
        &component_id.to_string(),
        component.raw.get("damagePerShot"),
    )?;
    insert_component_string_array(
        tx,
        "INSERT INTO wfstat_component_tags (component_id, tag_index, tag) VALUES (?1, ?2, ?3)",
        component_id,
        get_array(&component.raw, "tags"),
    )?;
    insert_component_string_array(
        tx,
        "INSERT INTO wfstat_component_polarities (component_id, polarity_index, polarity) VALUES (?1, ?2, ?3)",
        component_id,
        get_array(&component.raw, "polarities"),
    )?;
    insert_component_drop_rows(tx, component_id, component, import_context, item_ids)?;
    insert_attack_rows(
        tx,
        "wfstat_component_attacks",
        "wfstat_component_attack_damage",
        "wfstat_component_attack_falloff",
        "component_id",
        &component_id.to_string(),
        component.raw.get("attacks"),
    )?;

    Ok(())
}

fn insert_parent_rows(
    tx: &Transaction<'_>,
    record: &WfstatRecord,
    import_context: &ImportContext,
    item_ids: &HashMap<String, i64>,
) -> Result<()> {
    if let Some(parents) = get_array(&record.raw, "parents") {
        for (index, parent_value) in parents.iter().enumerate() {
            let parent_text = parent_value.as_str().unwrap_or_default().to_string();
            let parent_item_id =
                resolve_nested_item_id(Some(&parent_text), None, import_context, item_ids);
            tx.execute(
                "INSERT INTO wfstat_item_parents (wfstat_unique_name, parent_index, parent_item_id, parent_value)
                 VALUES (?1, ?2, ?3, ?4)",
                params![record.unique_name, index as i64, parent_item_id, parent_text],
            )?;
            if let Some(parent_item_id) = parent_item_id {
                let child_item_id = item_ids
                    .get(&build_top_level_canonical_key(record))
                    .copied()
                    .ok_or_else(|| anyhow!("missing child item_id for {}", record.unique_name))?;
                insert_relationship(
                    tx,
                    parent_item_id,
                    child_item_id,
                    "wfstat_parent",
                    Some(WFSTAT_SOURCE_NAME),
                    Some(&record.unique_name),
                    parent_value.as_str(),
                    Some(index as i64),
                    None,
                )?;
            }
        }
    }

    Ok(())
}

fn insert_level_rows(tx: &Transaction<'_>, record: &WfstatRecord) -> Result<()> {
    if let Some(levels) = get_array(&record.raw, "levelStats") {
        for (level_index, level_value) in levels.iter().enumerate() {
            tx.execute(
                "INSERT INTO wfstat_item_levels (wfstat_unique_name, level_index) VALUES (?1, ?2)",
                params![record.unique_name, level_index as i64],
            )?;
            let level_id = tx.last_insert_rowid();
            if let Some(lines) = level_value.as_array() {
                for (line_index, line_value) in lines.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO wfstat_item_level_stat_lines (level_id, line_index, stat_text) VALUES (?1, ?2, ?3)",
                        params![level_id, line_index as i64, line_value.as_str()],
                    )?;
                }
            }
        }
    }

    Ok(())
}

fn insert_drop_rows(
    tx: &Transaction<'_>,
    record: &WfstatRecord,
    import_context: &ImportContext,
    item_ids: &HashMap<String, i64>,
) -> Result<()> {
    if let Some(drops) = get_array(&record.raw, "drops") {
        for (index, drop_value) in drops.iter().enumerate() {
            let drop_name = get_string(drop_value, "item");
            tx.execute(
                "INSERT INTO wfstat_item_drops (wfstat_unique_name, drop_index, drop_item_id, chance, location, rarity, type)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    record.unique_name,
                    index as i64,
                    resolve_nested_item_id(drop_name.as_deref(), None, import_context, item_ids),
                    get_f64_any(drop_value, "chance"),
                    get_string(drop_value, "place").or_else(|| get_string(drop_value, "location")),
                    get_string(drop_value, "rarity"),
                    drop_name,
                ],
            )?;
        }
    }

    Ok(())
}

fn insert_location_rows(tx: &Transaction<'_>, record: &WfstatRecord) -> Result<()> {
    if let Some(locations) = get_array(&record.raw, "locations") {
        for (index, location_value) in locations.iter().enumerate() {
            tx.execute(
                "INSERT INTO wfstat_item_locations (wfstat_unique_name, location_index, chance, location, rarity)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    record.unique_name,
                    index as i64,
                    get_f64_any(location_value, "chance"),
                    get_string(location_value, "location").or_else(|| get_string(location_value, "place")),
                    get_string(location_value, "rarity"),
                ],
            )?;
        }
    }

    Ok(())
}

fn insert_patchlog_rows(tx: &Transaction<'_>, record: &WfstatRecord) -> Result<()> {
    if let Some(patchlogs) = get_array(&record.raw, "patchlogs") {
        for (index, patchlog_value) in patchlogs.iter().enumerate() {
            tx.execute(
                "INSERT INTO wfstat_item_patchlogs (wfstat_unique_name, patchlog_index, patch_name, patch_date, patch_url, additions, changes, fixes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    record.unique_name,
                    index as i64,
                    get_string(patchlog_value, "name"),
                    get_string_any(patchlog_value, "date"),
                    get_string(patchlog_value, "url"),
                    get_string(patchlog_value, "additions"),
                    get_string(patchlog_value, "changes"),
                    get_string(patchlog_value, "fixes"),
                ],
            )?;
        }
    }

    Ok(())
}

fn insert_reward_rows(
    tx: &Transaction<'_>,
    record: &WfstatRecord,
    import_context: &ImportContext,
    item_ids: &HashMap<String, i64>,
) -> Result<()> {
    if let Some(rewards) = get_array(&record.raw, "rewards") {
        for (index, reward_value) in rewards.iter().enumerate() {
            let reward_unique_name = get_string(reward_value, "uniqueName");
            let reward_name =
                get_string(reward_value, "name").or_else(|| get_string(reward_value, "item"));
            tx.execute(
                "INSERT INTO wfstat_item_rewards (
                    wfstat_unique_name,
                    reward_index,
                    reward_item_id,
                    chance,
                    rarity,
                    reward_item_name,
                    reward_item_unique_name,
                    reward_wfm_id,
                    reward_wfm_url_name
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    record.unique_name,
                    index as i64,
                    resolve_nested_item_id(
                        reward_name.as_deref(),
                        reward_unique_name.as_deref(),
                        import_context,
                        item_ids,
                    ),
                    get_f64_any(reward_value, "chance"),
                    get_string(reward_value, "rarity"),
                    reward_name,
                    reward_unique_name,
                    reward_value
                        .get("marketInfo")
                        .and_then(|value| get_string(value, "id")),
                    reward_value
                        .get("marketInfo")
                        .and_then(|value| get_string(value, "urlName")),
                ],
            )?;
        }
    }

    Ok(())
}

fn insert_resistance_rows(tx: &Transaction<'_>, record: &WfstatRecord) -> Result<()> {
    if let Some(resistances) = get_array(&record.raw, "resistances") {
        for (index, resistance_value) in resistances.iter().enumerate() {
            tx.execute(
                "INSERT INTO wfstat_item_resistances (wfstat_unique_name, resistance_index, resistance_type, amount)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    record.unique_name,
                    index as i64,
                    get_string(resistance_value, "amountType")
                        .or_else(|| get_string(resistance_value, "type")),
                    get_f64_any(resistance_value, "amount"),
                ],
            )?;
            let resistance_id = tx.last_insert_rowid();
            if let Some(effectors) = get_array(resistance_value, "affectedBy") {
                for (affector_index, affector_value) in effectors.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO wfstat_item_resistance_affectors (resistance_id, affector_index, element, modifier)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![
                            resistance_id,
                            affector_index as i64,
                            get_string(affector_value, "element")
                                .or_else(|| get_string(affector_value, "damageType")),
                            get_f64_any(affector_value, "modifier"),
                        ],
                    )?;
                }
            }
        }
    }

    Ok(())
}

fn insert_ability_rows(tx: &Transaction<'_>, record: &WfstatRecord) -> Result<()> {
    if let Some(abilities) = get_array(&record.raw, "abilities") {
        for (index, ability_value) in abilities.iter().enumerate() {
            tx.execute(
                "INSERT INTO wfstat_item_abilities (wfstat_unique_name, ability_index, ability_name, description, image_name, ability_unique_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    record.unique_name,
                    index as i64,
                    get_string(ability_value, "name"),
                    get_string(ability_value, "description"),
                    get_string(ability_value, "imageName"),
                    get_string(ability_value, "uniqueName"),
                ],
            )?;
        }
    }

    Ok(())
}

fn insert_component_drop_rows(
    tx: &Transaction<'_>,
    component_id: i64,
    component: &WfstatComponentRecord,
    import_context: &ImportContext,
    item_ids: &HashMap<String, i64>,
) -> Result<()> {
    if let Some(drops) = get_array(&component.raw, "drops") {
        for (index, drop_value) in drops.iter().enumerate() {
            let drop_unique_name = get_string(drop_value, "uniqueName");
            let drop_item_name = get_string(drop_value, "item");
            tx.execute(
                "INSERT INTO wfstat_component_drops (component_id, drop_index, component_drop_item_id, chance, location, rarity, type, component_drop_unique_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    component_id,
                    index as i64,
                    resolve_nested_item_id(
                        drop_item_name.as_deref(),
                        drop_unique_name.as_deref(),
                        import_context,
                        item_ids,
                    ),
                    get_f64_any(drop_value, "chance"),
                    get_string(drop_value, "place").or_else(|| get_string(drop_value, "location")),
                    get_string(drop_value, "rarity"),
                    drop_item_name,
                    drop_unique_name,
                ],
            )?;
        }
    }

    Ok(())
}

fn insert_attack_rows(
    tx: &Transaction<'_>,
    attack_table: &str,
    damage_table: &str,
    falloff_table: &str,
    owner_column: &str,
    owner_key: &str,
    attack_values: Option<&Value>,
) -> Result<()> {
    let Some(attacks) = attack_values.and_then(Value::as_array) else {
        return Ok(());
    };

    for (index, attack_value) in attacks.iter().enumerate() {
        let insert_attack_sql = format!(
            "INSERT INTO {attack_table} ({owner_column}, attack_index, attack_name, charge_time, crit_chance, crit_mult, flight, shot_speed, shot_type, slide, speed, status_chance)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
        );
        tx.execute(
            &insert_attack_sql,
            params![
                owner_key,
                index as i64,
                get_string(attack_value, "name"),
                get_f64_any(attack_value, "charge_time"),
                get_f64_any(attack_value, "crit_chance"),
                get_f64_any(attack_value, "crit_mult"),
                get_i64_any(attack_value, "flight"),
                get_i64_any(attack_value, "shot_speed"),
                get_string(attack_value, "shot_type"),
                get_string(attack_value, "slide"),
                get_f64_any(attack_value, "speed"),
                get_f64_any(attack_value, "status_chance"),
            ],
        )?;
        let attack_id = tx.last_insert_rowid();
        insert_attack_damage_row(
            tx,
            damage_table,
            damage_table.contains("component"),
            attack_id,
            attack_value.get("damage"),
        )?;
        insert_attack_falloff_row(
            tx,
            falloff_table,
            falloff_table.contains("component"),
            attack_id,
            attack_value.get("falloff"),
        )?;
    }

    Ok(())
}

fn insert_attack_damage_row(
    tx: &Transaction<'_>,
    table_name: &str,
    is_component: bool,
    attack_id: i64,
    damage_value: Option<&Value>,
) -> Result<()> {
    let Some(damage_value) = damage_value else {
        return Ok(());
    };
    let id_column = if is_component {
        "component_attack_id"
    } else {
        "attack_id"
    };
    let sql = format!(
        "INSERT INTO {table_name} ({id_column}, blast, cold, electricity, heat, impact, magnetic, puncture, radiation, slash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
    );
    tx.execute(
        &sql,
        params![
            attack_id,
            get_f64_multi(damage_value, &["blast"]),
            get_f64_multi(damage_value, &["cold"]),
            get_f64_multi(damage_value, &["electricity", "electric"]),
            get_f64_multi(damage_value, &["heat"]),
            get_f64_multi(damage_value, &["impact"]),
            get_f64_multi(damage_value, &["magnetic"]),
            get_f64_multi(damage_value, &["puncture"]),
            get_f64_multi(damage_value, &["radiation"]),
            get_f64_multi(damage_value, &["slash"]),
        ],
    )?;

    Ok(())
}

fn insert_attack_falloff_row(
    tx: &Transaction<'_>,
    table_name: &str,
    is_component: bool,
    attack_id: i64,
    falloff_value: Option<&Value>,
) -> Result<()> {
    let Some(falloff_value) = falloff_value else {
        return Ok(());
    };
    let id_column = if is_component {
        "component_attack_id"
    } else {
        "attack_id"
    };
    let sql = format!(
        "INSERT INTO {table_name} ({id_column}, start_range, end_range, reduction)
         VALUES (?1, ?2, ?3, ?4)"
    );
    tx.execute(
        &sql,
        params![
            attack_id,
            get_f64_any(falloff_value, "start"),
            get_f64_any(falloff_value, "end"),
            get_f64_any(falloff_value, "reduction"),
        ],
    )?;

    Ok(())
}

fn insert_damage_table(
    tx: &Transaction<'_>,
    table_name: &str,
    owner_column: &str,
    owner_key: &str,
    damage_value: Option<&Value>,
) -> Result<()> {
    let Some(damage_value) = damage_value else {
        return Ok(());
    };
    let sql = format!(
        "INSERT INTO {table_name} ({owner_column}, blast, cinematic, cold, corrosive, electricity, energy_drain, gas, health_drain, heat, impact, magnetic, puncture, radiation, shield_drain, slash, tau, total, toxin, true_damage, viral, void)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)"
    );
    tx.execute(
        &sql,
        params![
            owner_key,
            get_f64_multi(damage_value, &["blast"]),
            get_f64_multi(damage_value, &["cinematic"]),
            get_f64_multi(damage_value, &["cold"]),
            get_f64_multi(damage_value, &["corrosive"]),
            get_f64_multi(damage_value, &["electricity", "electric"]),
            get_f64_multi(damage_value, &["energyDrain"]),
            get_f64_multi(damage_value, &["gas"]),
            get_f64_multi(damage_value, &["healthDrain"]),
            get_f64_multi(damage_value, &["heat"]),
            get_f64_multi(damage_value, &["impact"]),
            get_f64_multi(damage_value, &["magnetic"]),
            get_f64_multi(damage_value, &["puncture"]),
            get_f64_multi(damage_value, &["radiation"]),
            get_f64_multi(damage_value, &["shieldDrain"]),
            get_f64_multi(damage_value, &["slash"]),
            get_f64_multi(damage_value, &["tau"]),
            get_f64_multi(damage_value, &["total"]),
            get_f64_multi(damage_value, &["toxin"]),
            get_f64_multi(damage_value, &["true_damage", "true"]),
            get_f64_multi(damage_value, &["viral"]),
            get_f64_multi(damage_value, &["void"]),
        ],
    )?;
    Ok(())
}

fn insert_damage_per_shot_table(
    tx: &Transaction<'_>,
    table_name: &str,
    owner_column: &str,
    owner_key: &str,
    values: Option<&Value>,
) -> Result<()> {
    let Some(values) = values.and_then(Value::as_array) else {
        return Ok(());
    };
    let sql = format!(
        "INSERT INTO {table_name} ({owner_column}, shot_index, damage_value) VALUES (?1, ?2, ?3)"
    );
    for (index, value) in values.iter().enumerate() {
        tx.execute(&sql, params![owner_key, index as i64, value.as_f64()])?;
    }
    Ok(())
}

fn insert_introduced_record(
    tx: &Transaction<'_>,
    introduced_table: &str,
    aliases_table: &str,
    owner_key: &str,
    owner_value: &Value,
) -> Result<()> {
    let Some(introduced) = owner_value.get("introduced") else {
        return Ok(());
    };

    let sql = format!(
        "INSERT INTO {introduced_table} (wfstat_unique_name, introduced_name, introduced_url, introduced_parent, introduced_date, raw_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    );
    tx.execute(
        &sql,
        params![
            owner_key,
            get_string(introduced, "name"),
            get_string(introduced, "url"),
            get_string(introduced, "parent"),
            get_string_any(introduced, "date"),
            serde_json::to_string(introduced)?,
        ],
    )?;

    if let Some(aliases) = get_array(introduced, "aliases") {
        let alias_sql = format!(
            "INSERT INTO {aliases_table} (wfstat_unique_name, alias_index, alias) VALUES (?1, ?2, ?3)"
        );
        for (index, alias) in aliases.iter().enumerate() {
            tx.execute(&alias_sql, params![owner_key, index as i64, alias.as_str()])?;
        }
    }

    Ok(())
}

fn insert_component_introduced_record(
    tx: &Transaction<'_>,
    component_id: i64,
    owner_value: &Value,
) -> Result<()> {
    let Some(introduced) = owner_value.get("introduced") else {
        return Ok(());
    };

    tx.execute(
        "INSERT INTO wfstat_component_introduced (component_id, introduced_name, introduced_url, introduced_parent, introduced_date, raw_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            component_id,
            get_string(introduced, "name"),
            get_string(introduced, "url"),
            get_string(introduced, "parent"),
            get_string_any(introduced, "date"),
            serde_json::to_string(introduced)?,
        ],
    )?;

    if let Some(aliases) = get_array(introduced, "aliases") {
        for (index, alias) in aliases.iter().enumerate() {
            tx.execute(
                "INSERT INTO wfstat_component_introduced_aliases (component_id, alias_index, alias) VALUES (?1, ?2, ?3)",
                params![component_id, index as i64, alias.as_str()],
            )?;
        }
    }

    Ok(())
}

fn resolve_nested_item_id(
    item_name: Option<&str>,
    unique_name: Option<&str>,
    import_context: &ImportContext,
    item_ids: &HashMap<String, i64>,
) -> Option<i64> {
    if let Some(unique_name) = unique_name {
        if let Some(canonical_key) = import_context.indexes.top_by_unique_name.get(unique_name) {
            return item_ids.get(canonical_key).copied();
        }
        if let Some(canonical_key) = import_context
            .indexes
            .component_by_unique_name
            .get(unique_name)
        {
            return item_ids.get(canonical_key).copied();
        }
    }

    let normalized_name = item_name.map(normalize_name)?;
    if let Some(canonical_key) =
        resolve_unique_name_match(&import_context.indexes, &normalized_name)
    {
        return item_ids.get(&canonical_key).copied();
    }

    None
}

fn insert_source_match(
    tx: &Transaction<'_>,
    item_id: Option<i64>,
    source_name: &str,
    source_table: &str,
    source_record_key: &str,
    source_record_label: Option<&str>,
    match_method: &str,
    matched_field: Option<&str>,
    matched_value: Option<&str>,
    is_manual: Option<i64>,
    notes: Option<&str>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO item_source_matches (
            item_id,
            source_name,
            source_table,
            source_record_key,
            source_record_label,
            match_method,
            matched_field,
            matched_value,
            confidence,
            is_manual,
            notes
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, COALESCE(?9, 0), ?10)",
        params![
            item_id,
            source_name,
            source_table,
            source_record_key,
            source_record_label,
            match_method,
            matched_field,
            matched_value,
            is_manual,
            notes,
        ],
    )?;
    Ok(())
}

fn insert_alias(
    tx: &Transaction<'_>,
    item_id: i64,
    alias_scope: &str,
    alias_value: &str,
    normalized_alias_value: Option<&str>,
    source_name: &str,
    source_table: &str,
    source_record_key: &str,
    is_primary: bool,
    notes: Option<&str>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO item_aliases (
            item_id,
            alias_scope,
            alias_value,
            normalized_alias_value,
            source_name,
            source_table,
            source_record_key,
            is_primary,
            notes
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            item_id,
            alias_scope,
            alias_value,
            normalized_alias_value,
            source_name,
            source_table,
            source_record_key,
            if is_primary { 1 } else { 0 },
            notes,
        ],
    )?;
    Ok(())
}

fn insert_variant(
    tx: &Transaction<'_>,
    item_id: i64,
    source_name: &str,
    source_table: &str,
    source_record_key: &str,
    variant: &VariantInfo,
    is_primary: bool,
    notes: Option<&str>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO item_variants (
            item_id,
            source_name,
            source_table,
            source_record_key,
            variant_group_name,
            variant_group_name_normalized,
            variant_kind,
            variant_value,
            variant_value_normalized,
            variant_rank,
            is_primary,
            notes
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            item_id,
            source_name,
            source_table,
            source_record_key,
            variant.group_name,
            variant.group_name_normalized,
            variant.kind,
            variant.value,
            variant.value_normalized,
            variant.rank,
            if is_primary { 1 } else { 0 },
            notes,
        ],
    )?;
    Ok(())
}

fn insert_relationship(
    tx: &Transaction<'_>,
    parent_item_id: i64,
    child_item_id: i64,
    relationship_type: &str,
    source_name: Option<&str>,
    source_record_key: Option<&str>,
    relationship_label: Option<&str>,
    sort_order: Option<i64>,
    notes: Option<&str>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO item_relationships (
            parent_item_id,
            child_item_id,
            relationship_type,
            source_name,
            source_record_key,
            relationship_label,
            sort_order,
            notes
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            parent_item_id,
            child_item_id,
            relationship_type,
            source_name,
            source_record_key,
            relationship_label,
            sort_order,
            notes,
        ],
    )?;
    Ok(())
}

fn insert_string_array(
    tx: &Transaction<'_>,
    sql: &str,
    owner_key: &str,
    values: Option<&Vec<Value>>,
) -> Result<()> {
    let Some(values) = values else {
        return Ok(());
    };
    for (index, value) in values.iter().enumerate() {
        tx.execute(sql, params![owner_key, index as i64, value.as_str()])?;
    }
    Ok(())
}

fn insert_component_string_array(
    tx: &Transaction<'_>,
    sql: &str,
    owner_id: i64,
    values: Option<&Vec<Value>>,
) -> Result<()> {
    let Some(values) = values else {
        return Ok(());
    };
    for (index, value) in values.iter().enumerate() {
        tx.execute(sql, params![owner_id, index as i64, value.as_str()])?;
    }
    Ok(())
}

fn insert_manual_alias_rows(tx: &Transaction<'_>, alias_seed: &[ManualAliasSeedRow]) -> Result<()> {
    for alias in alias_seed {
        tx.execute(
            "INSERT INTO item_manual_aliases (
                source_name,
                source_table,
                lookup_type,
                lookup_value,
                target_type,
                target_value,
                is_active,
                notes
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                alias.source_name,
                alias.source_table,
                alias.lookup_type,
                alias.lookup_value,
                alias.target_type,
                alias.target_value,
                if alias.is_active { 1 } else { 0 },
                alias.notes,
            ],
        )?;
    }

    Ok(())
}

fn reset_catalog_tables(tx: &Transaction<'_>) -> Result<()> {
    for table in [
        "item_source_matches",
        "item_relationships",
        "item_variants",
        "item_aliases",
        "item_manual_aliases",
        "items",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    Ok(())
}

fn should_refresh_catalog(
    connection: &Connection,
    wfm_meta: &SourceMeta,
    schema_checksum: &str,
    alias_seed_checksum: &str,
) -> Result<bool> {
    let has_items =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM items LIMIT 1)", [], |row| {
            row.get::<_, i64>(0)
        })? == 1;
    let previous_wfm = load_version_row(connection, WFM_SOURCE_NAME)?;
    let previous_schema = load_version_row(connection, SCHEMA_SOURCE_NAME)?;
    let previous_alias_seed = load_version_row(connection, MANUAL_ALIAS_SOURCE_NAME)?;

    let wfm_matches = previous_wfm.api_version == wfm_meta.api_version;
    let schema_matches = previous_schema.api_version.as_deref() == Some(CURRENT_SCHEMA_VERSION)
        && previous_schema.content_sha256.as_deref() == Some(schema_checksum);
    let alias_matches = previous_alias_seed.content_sha256.as_deref() == Some(alias_seed_checksum);

    Ok(!(has_items && wfm_matches && schema_matches && alias_matches))
}

fn load_version_row(connection: &Connection, source_name: &str) -> Result<VersionRow> {
    let row = connection
        .query_row(
            "SELECT api_version, content_sha256 FROM source_versions WHERE source_name = ?1",
            params![source_name],
            |row| {
                Ok(VersionRow {
                    api_version: row.get(0)?,
                    content_sha256: row.get(1)?,
                })
            },
        )
        .optional()?;

    Ok(row.unwrap_or_default())
}

fn upsert_source_version(tx: &Transaction<'_>, meta: &SourceMeta) -> Result<()> {
    tx.execute(
        "INSERT INTO source_versions (
            source_name,
            api_version,
            content_sha256,
            item_count,
            fetched_at,
            source_file,
            notes
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(source_name) DO UPDATE SET
            api_version = excluded.api_version,
            content_sha256 = excluded.content_sha256,
            item_count = excluded.item_count,
            fetched_at = excluded.fetched_at,
            source_file = excluded.source_file,
            notes = excluded.notes",
        params![
            meta.source_name,
            meta.api_version,
            meta.content_sha256,
            meta.item_count,
            meta.fetched_at,
            meta.source_file,
            meta.notes,
        ],
    )?;
    Ok(())
}

fn load_existing_stats(connection: &Connection) -> Result<ImportStats> {
    let total_wfm_items = connection.query_row("SELECT COUNT(*) FROM wfm_items", [], |row| {
        row.get::<_, i64>(0)
    })? as usize;
    let total_wfstat_items =
        connection.query_row("SELECT COUNT(*) FROM wfstat_items", [], |row| {
            row.get::<_, i64>(0)
        })? as usize;
    let matched_by_direct_ref = count_match_method(connection, "gameRef_to_wfstat_uniqueName")?;
    let matched_by_component_ref =
        count_match_method(connection, "gameRef_to_wfstat_component_uniqueName")?;
    let matched_by_market_slug =
        count_match_method(connection, "wfm_slug_to_wfstat_market_url_name")?;
    let matched_by_market_id = count_match_method(connection, "wfm_id_to_wfstat_market_id")?;
    let matched_by_normalized_name =
        count_match_method(connection, "normalized_name_to_wfstat_name")?;
    let matched_by_blueprint_decomposition =
        count_match_method(connection, "blueprint_parent_component_name")?;
    let matched_by_manual_alias = count_match_method(connection, "manual_alias")?;
    let unmatched_wfm_items = count_match_method(connection, "unmatched")?;
    let wfm_only_canonical_items = connection.query_row(
        "SELECT COUNT(*) FROM items WHERE match_status = 'wfm_only'",
        [],
        |row| row.get::<_, i64>(0),
    )? as usize;
    let wfstat_only_canonical_items = connection.query_row(
        "SELECT COUNT(*) FROM items WHERE match_status = 'wfstat_only'",
        [],
        |row| row.get::<_, i64>(0),
    )? as usize;

    Ok(ImportStats {
        total_wfm_items,
        total_wfstat_items,
        matched_by_direct_ref,
        matched_by_component_ref,
        matched_by_market_slug,
        matched_by_market_id,
        matched_by_normalized_name,
        matched_by_blueprint_decomposition,
        matched_by_manual_alias,
        unmatched_wfm_items,
        wfm_only_canonical_items,
        wfstat_only_canonical_items,
    })
}

fn count_match_method(connection: &Connection, method: &str) -> Result<usize> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM item_source_matches WHERE match_method = ?1",
        params![method],
        |row| row.get::<_, i64>(0),
    )? as usize)
}

fn apply_reference_schema(connection: &Connection, schema_sql: &str) -> Result<()> {
    connection.execute_batch(schema_sql)?;
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    connection.busy_timeout(Duration::from_secs(30))?;
    Ok(connection)
}

fn fetch_to_file(url: &str, output_path: &Path) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()?;
    let bytes = client
        .get(url)
        .send()?
        .error_for_status()?
        .bytes()?
        .to_vec();
    fs::write(output_path, &bytes)
        .with_context(|| format!("failed to write {}", output_path.display()))?;
    Ok(bytes)
}

fn resolve_app_paths(app: &AppHandle) -> Result<AppPaths> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve the app data directory")?;
    let data_dir = app_data_dir.join("data");
    fs::create_dir_all(&data_dir)
        .with_context(|| format!("failed to create {}", data_dir.display()))?;

    Ok(AppPaths {
        db_path: app_data_dir.join(DATABASE_FILE),
        wfm_file_path: data_dir.join(WFM_DATA_FILE),
        wfstat_file_path: data_dir.join(WFSTAT_DATA_FILE),
        data_dir,
    })
}

fn build_wfm_meta(
    wfm_json: &Value,
    path: &Path,
    fetched_at: &str,
    bytes: &[u8],
) -> Result<SourceMeta> {
    let api_version = get_string(wfm_json, "apiVersion");
    let item_count = wfm_json
        .get("data")
        .and_then(Value::as_array)
        .map(|rows| rows.len() as i64)
        .ok_or_else(|| anyhow!("WFM response is missing the data array"))?;
    Ok(SourceMeta {
        source_name: WFM_SOURCE_NAME.to_string(),
        api_version,
        content_sha256: sha256_hex(bytes),
        item_count,
        fetched_at: fetched_at.to_string(),
        source_file: path.display().to_string(),
        notes: Some("Saved from GET https://api.warframe.market/v2/items.".to_string()),
    })
}

fn build_wfstat_meta(
    wfstat_json: &Value,
    path: &Path,
    fetched_at: &str,
    bytes: &[u8],
) -> Result<SourceMeta> {
    let item_count = wfstat_json
        .as_array()
        .map(|rows| rows.len() as i64)
        .ok_or_else(|| anyhow!("WFStat response is not an array"))?;
    Ok(SourceMeta {
        source_name: WFSTAT_SOURCE_NAME.to_string(),
        api_version: None,
        content_sha256: sha256_hex(bytes),
        item_count,
        fetched_at: fetched_at.to_string(),
        source_file: path.display().to_string(),
        notes: Some(
            "Saved from GET https://api.warframestat.us/items/ without tradable filtering."
                .to_string(),
        ),
    })
}

fn parse_manual_alias_seed() -> Result<Vec<ManualAliasSeedRow>> {
    let rows: Vec<ManualAliasSeedRow> = serde_json::from_str(MANUAL_ALIAS_SEED_JSON)
        .context("failed to parse manual alias seed JSON")?;
    for row in &rows {
        if row.lookup_type.trim().is_empty()
            || row.lookup_value.trim().is_empty()
            || row.target_type.trim().is_empty()
            || row.target_value.trim().is_empty()
        {
            return Err(anyhow!(
                "manual alias entries must have non-empty lookup and target fields"
            ));
        }
    }
    Ok(rows)
}

fn log_import_stats(stats: &ImportStats) {
    println!(
        "Item catalog import: WFM={}, WFStat={}, direct={}, component={}, slug={}, id={}, normalized={}, blueprint={}, manual={}, unmatched={}, wfm_only={}, wfstat_only={}",
        stats.total_wfm_items,
        stats.total_wfstat_items,
        stats.matched_by_direct_ref,
        stats.matched_by_component_ref,
        stats.matched_by_market_slug,
        stats.matched_by_market_id,
        stats.matched_by_normalized_name,
        stats.matched_by_blueprint_decomposition,
        stats.matched_by_manual_alias,
        stats.unmatched_wfm_items,
        stats.wfm_only_canonical_items,
        stats.wfstat_only_canonical_items,
    );
}

fn update_stats_for_match(stats: &mut ImportStats, method: &str) {
    match method {
        "gameRef_to_wfstat_uniqueName" => stats.matched_by_direct_ref += 1,
        "gameRef_to_wfstat_component_uniqueName" => stats.matched_by_component_ref += 1,
        "wfm_slug_to_wfstat_market_url_name" => stats.matched_by_market_slug += 1,
        "wfm_id_to_wfstat_market_id" => stats.matched_by_market_id += 1,
        "normalized_name_to_wfstat_name" => stats.matched_by_normalized_name += 1,
        "blueprint_parent_component_name" => stats.matched_by_blueprint_decomposition += 1,
        "manual_alias" => stats.matched_by_manual_alias += 1,
        "unmatched" => stats.unmatched_wfm_items += 1,
        _ => {}
    }
}

fn emit_progress(
    app: &AppHandle,
    stage_key: &str,
    stage_label: &str,
    status_text: &str,
    progress_value: f64,
) {
    let _ = app.emit(
        STARTUP_PROGRESS_EVENT,
        StartupProgress {
            stage_key: stage_key.to_string(),
            stage_label: stage_label.to_string(),
            status_text: status_text.to_string(),
            progress_value,
        },
    );
}

fn reference_sql() -> ReferenceSql {
    ReferenceSql {
        sql: ITEM_CATALOG_SCHEMA_SQL,
        checksum: sha256_hex(ITEM_CATALOG_SCHEMA_SQL.as_bytes()),
    }
}

fn default_wfm_source_name() -> String {
    WFM_SOURCE_NAME.to_string()
}

fn default_wfm_table_name() -> String {
    "wfm_items".to_string()
}

fn default_true() -> bool {
    true
}

fn iso_timestamp_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn normalize_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_lowercase()
}

fn parse_variant_info(name: &str) -> Option<VariantInfo> {
    let captures = relic_variant_regex().captures(name)?;
    let tier = captures.get(1)?.as_str();
    let code = captures.get(2)?.as_str();
    let refinement = captures.get(3)?.as_str();
    Some(VariantInfo {
        group_name: format!("{tier} {code} Relic"),
        group_name_normalized: normalize_name(&format!("{tier} {code} Relic")),
        kind: "relic_refinement".to_string(),
        value: refinement.to_string(),
        value_normalized: normalize_name(refinement),
        rank: match refinement.to_ascii_lowercase().as_str() {
            "intact" => 0,
            "exceptional" => 1,
            "flawless" => 2,
            "radiant" => 3,
            _ => 0,
        },
    })
}

fn split_blueprint_name(name: &str) -> Option<BlueprintParts> {
    let captures = blueprint_regex().captures(name)?;
    Some(BlueprintParts {
        parent_name: captures.get(1)?.as_str().to_string(),
        component_name: captures.get(2)?.as_str().replace(" Blueprint", ""),
    })
}

fn relic_variant_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"^(Lith|Meso|Neo|Axi|Requiem)\s+([A-Za-z0-9]+)(?:\s+Relic)?\s+(Intact|Exceptional|Flawless|Radiant)$",
        )
        .expect("valid relic regex")
    })
}

fn blueprint_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"^(.*?)\s+(Chassis Blueprint|Neuroptics Blueprint|Systems Blueprint|Harness Blueprint|Blade Blueprint|Handle Blueprint|Hilt Blueprint|Stock Blueprint|Barrel Blueprint|Receiver Blueprint|Grip Blueprint|String Blueprint|Disc Blueprint|Gauntlet Blueprint|Cerebrum Blueprint|Carapace Blueprint|Pouch Blueprint|Head Blueprint|Wings Blueprint|Avionics Blueprint|Engines Blueprint|Fuselage Blueprint|Lower Limb Blueprint|Upper Limb Blueprint|Blueprint)$",
        )
        .expect("valid blueprint regex")
    })
}

fn derive_wfm_item_family(value: &Value) -> Option<String> {
    let tags = get_array(value, "tags")?;
    let tag_values = tags.iter().filter_map(Value::as_str).collect::<Vec<_>>();
    for candidate in [
        "relic",
        "component",
        "set",
        "mod",
        "weapon",
        "warframe",
        "blueprint",
    ] {
        if tag_values.iter().any(|tag| *tag == candidate) {
            return Some(candidate.to_string());
        }
    }
    tag_values.first().map(|value| (*value).to_string())
}

fn derive_wfstat_item_family(value: &Value) -> Option<String> {
    get_string(value, "category")
        .or_else(|| get_string(value, "type"))
        .map(|value| normalize_name(&value))
}

fn get_required_string(value: &Value, key: &str) -> Result<String> {
    get_string(value, key).ok_or_else(|| anyhow!("missing required string field {key}"))
}

fn get_required_bool_as_i64(value: &Value, key: &str) -> Result<i64> {
    get_bool_as_i64(value, key).ok_or_else(|| anyhow!("missing required bool field {key}"))
}

fn get_array<'a>(value: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    value.get(key).and_then(Value::as_array)
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    })
}

fn get_string_any(value: &Value, key: &str) -> Option<String> {
    get_string(value, key)
}

fn get_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn get_i64_any(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value as i64)),
        Value::String(text) => text
            .parse::<i64>()
            .ok()
            .or_else(|| text.parse::<f64>().ok().map(|value| value as i64)),
        Value::Bool(boolean) => Some(if *boolean { 1 } else { 0 }),
        _ => None,
    })
}

fn get_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn get_f64_any(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    })
}

fn get_f64_multi(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| get_f64_any(value, key))
}

fn get_bool_as_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| match value {
        Value::Bool(boolean) => Some(if *boolean { 1 } else { 0 }),
        Value::Number(number) => number.as_i64(),
        Value::String(text) => match text.as_str() {
            "true" => Some(1),
            "false" => Some(0),
            _ => None,
        },
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_name, parse_variant_info, split_blueprint_name,
        wfstat_component_source_record_key, WfstatComponentRecord, WFSTAT_ITEMS_COLUMN_COUNT,
        WFSTAT_ITEMS_INSERT_SQL,
    };
    use serde_json::json;

    #[test]
    fn normalizes_whitespace_and_case() {
        assert_eq!(normalize_name("  Zephyr   Prime  "), "zephyr prime");
    }

    #[test]
    fn parses_relic_variants() {
        let variant = parse_variant_info("Neo N1 Radiant").expect("variant");
        assert_eq!(variant.group_name, "Neo N1 Relic");
        assert_eq!(variant.kind, "relic_refinement");
        assert_eq!(variant.rank, 3);
    }

    #[test]
    fn splits_blueprint_names() {
        let parts = split_blueprint_name("Wisp Prime Blueprint").expect("blueprint");
        assert_eq!(parts.parent_name, "Wisp Prime");
        assert_eq!(parts.component_name, "Blueprint");
    }

    #[test]
    fn wfstat_items_insert_placeholder_count_matches_columns() {
        assert_eq!(
            WFSTAT_ITEMS_INSERT_SQL.matches('?').count(),
            WFSTAT_ITEMS_COLUMN_COUNT
        );
    }

    #[test]
    fn wfstat_component_source_record_key_is_parent_scoped() {
        let left = WfstatComponentRecord {
            parent_unique_name: "/Lotus/Weapons/Foo".to_string(),
            component_index: 0,
            unique_name: Some("/Lotus/Types/Items/MiscItems/OrokinCell".to_string()),
            name: Some("Orokin Cell".to_string()),
            normalized_name: Some("orokin cell".to_string()),
            variant: None,
            item_family: None,
            raw: json!({}),
        };
        let right = WfstatComponentRecord {
            parent_unique_name: "/Lotus/Weapons/Bar".to_string(),
            component_index: 0,
            unique_name: Some("/Lotus/Types/Items/MiscItems/OrokinCell".to_string()),
            name: Some("Orokin Cell".to_string()),
            normalized_name: Some("orokin cell".to_string()),
            variant: None,
            item_family: None,
            raw: json!({}),
        };

        assert_ne!(
            wfstat_component_source_record_key(&left),
            wfstat_component_source_record_key(&right)
        );
    }
}
