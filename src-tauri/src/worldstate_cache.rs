use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const WORLDSTATE_CACHE_DIR_NAME: &str = "worldstate";
const WORLDSTATE_CACHE_FILE_NAME: &str = "cache.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldStateCacheEntry {
    pub payload: serde_json::Value,
    pub fetched_at: String,
    pub next_refresh_at: Option<String>,
}

type WorldStateCacheMap = HashMap<String, WorldStateCacheEntry>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorldStateCacheFile {
    #[serde(default)]
    warstonks_version: Option<String>,
    #[serde(default)]
    entries: WorldStateCacheMap,
}

fn build_worldstate_cache_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve the app data directory")?;
    Ok(app_data_dir
        .join(WORLDSTATE_CACHE_DIR_NAME)
        .join(WORLDSTATE_CACHE_FILE_NAME))
}

fn load_cache_from_path(path: &Path) -> Result<WorldStateCacheMap> {
    if !path.exists() {
        return Ok(WorldStateCacheMap::new());
    }

    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read worldstate cache at {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(WorldStateCacheMap::new());
    }

    if let Ok(file) = serde_json::from_str::<WorldStateCacheFile>(&raw) {
        return Ok(file.entries);
    }

    serde_json::from_str::<WorldStateCacheMap>(&raw)
        .with_context(|| format!("failed to parse worldstate cache at {}", path.display()))
}

fn save_cache_to_path(path: &Path, cache: &WorldStateCacheMap) -> Result<()> {
    if let Some(parent_dir) = path.parent() {
        fs::create_dir_all(parent_dir).with_context(|| {
            format!(
                "failed to create worldstate cache directory {}",
                parent_dir.display()
            )
        })?;
    }

    let file = WorldStateCacheFile {
        warstonks_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        entries: cache.clone(),
    };
    let serialized =
        serde_json::to_string_pretty(&file).context("failed to serialize worldstate cache")?;
    fs::write(path, serialized)
        .with_context(|| format!("failed to write worldstate cache at {}", path.display()))
}

fn load_worldstate_cache_inner(app: &tauri::AppHandle) -> Result<WorldStateCacheMap> {
    let path = build_worldstate_cache_path(app)?;
    load_cache_from_path(&path)
}

fn save_worldstate_cache_entry_inner(
    app: &tauri::AppHandle,
    endpoint: &str,
    entry: WorldStateCacheEntry,
) -> Result<()> {
    let trimmed_endpoint = endpoint.trim();
    if trimmed_endpoint.is_empty() {
        anyhow::bail!("worldstate cache endpoint key cannot be empty");
    }

    let path = build_worldstate_cache_path(app)?;
    let mut cache = load_cache_from_path(&path)?;
    cache.insert(trimmed_endpoint.to_string(), entry);
    save_cache_to_path(&path, &cache)
}

#[tauri::command]
pub fn get_worldstate_cache(app: tauri::AppHandle) -> Result<WorldStateCacheMap, String> {
    load_worldstate_cache_inner(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_worldstate_cache_entry(
    app: tauri::AppHandle,
    endpoint: String,
    entry: WorldStateCacheEntry,
) -> Result<(), String> {
    save_worldstate_cache_entry_inner(&app, &endpoint, entry).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worldstate_cache_round_trip_uses_json_file() {
        let temp_dir =
            std::env::temp_dir().join(format!("warstonks-worldstate-cache-{}", std::process::id()));
        let cache_path = temp_dir.join("cache.json");

        if temp_dir.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
        }

        let mut cache = WorldStateCacheMap::new();
        cache.insert(
            "events".to_string(),
            WorldStateCacheEntry {
                payload: serde_json::json!([{ "id": "one" }]),
                fetched_at: "2026-03-11T10:00:00.000Z".to_string(),
                next_refresh_at: Some("2026-03-11T11:00:00.000Z".to_string()),
            },
        );

        save_cache_to_path(&cache_path, &cache).expect("cache file should save");
        let loaded = load_cache_from_path(&cache_path).expect("cache file should load");

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded["events"].fetched_at, "2026-03-11T10:00:00.000Z");

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
