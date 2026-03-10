use serde::{Deserialize, Serialize};

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
