use serde::{Deserialize, Serialize};

use crate::item_catalog;

#[derive(Debug, Serialize, Deserialize)]
pub struct AppShellInfo {
    pub version: String,
    pub name: String,
    pub platform: String,
}

/// Returns static metadata about the app shell.
/// Used by the frontend tauriClient to verify connectivity.
#[tauri::command]
pub fn get_app_shell_info() -> AppShellInfo {
    AppShellInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        name: "WarStonks".to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

/// Placeholder — returns the current app version string.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn initialize_app_catalog(app: tauri::AppHandle) -> Result<item_catalog::StartupSummary, String> {
    tauri::async_runtime::spawn_blocking(move || item_catalog::initialize_app_catalog(app))
        .await
        .map_err(|error| error.to_string())?
}
