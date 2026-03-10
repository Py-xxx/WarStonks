use serde::{Deserialize, Serialize};
use std::sync::{Condvar, Mutex, OnceLock};

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

#[derive(Debug, Default)]
struct StartupCommandState {
    in_progress: bool,
    last_result: Option<Result<item_catalog::StartupSummary, String>>,
}

fn startup_command_state() -> &'static (Mutex<StartupCommandState>, Condvar) {
    static STATE: OnceLock<(Mutex<StartupCommandState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(StartupCommandState::default()), Condvar::new()))
}

fn cached_startup_summary(
    state: &StartupCommandState,
) -> Option<Result<item_catalog::StartupSummary, String>> {
    match &state.last_result {
        Some(Ok(summary)) => Some(Ok(summary.clone())),
        Some(Err(_)) | None => None,
    }
}

fn run_initialize_app_catalog(
    app: tauri::AppHandle,
) -> Result<item_catalog::StartupSummary, String> {
    let (state_lock, state_signal) = startup_command_state();
    let mut state = state_lock
        .lock()
        .map_err(|_| "startup command state lock poisoned".to_string())?;

    if let Some(result) = cached_startup_summary(&state) {
        return result;
    }

    while state.in_progress {
        state = state_signal
            .wait(state)
            .map_err(|_| "startup command state lock poisoned".to_string())?;

        if let Some(result) = &state.last_result {
            return result.clone();
        }
    }

    state.in_progress = true;
    state.last_result = None;
    drop(state);

    let result = item_catalog::initialize_app_catalog(app);

    let mut state = state_lock
        .lock()
        .map_err(|_| "startup command state lock poisoned".to_string())?;
    state.in_progress = false;
    state.last_result = Some(result.clone());
    state_signal.notify_all();

    result
}

#[tauri::command]
pub async fn initialize_app_catalog(
    app: tauri::AppHandle,
) -> Result<item_catalog::StartupSummary, String> {
    tauri::async_runtime::spawn_blocking(move || run_initialize_app_catalog(app))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{cached_startup_summary, StartupCommandState};
    use crate::item_catalog::{ImportStats, StartupSummary};

    fn sample_summary() -> StartupSummary {
        StartupSummary {
            ready: true,
            refreshed: false,
            database_path: "/tmp/item_catalog.sqlite".to_string(),
            data_dir: "/tmp".to_string(),
            wfm_source_file: "/tmp/WFM-items.json".to_string(),
            wfstat_source_file: Some("/tmp/WFStat-items.json".to_string()),
            stats: ImportStats::default(),
            current_wfm_api_version: Some("v2".to_string()),
        }
    }

    #[test]
    fn caches_successful_startup_result() {
        let state = StartupCommandState {
            in_progress: false,
            last_result: Some(Ok(sample_summary())),
        };

        let cached = cached_startup_summary(&state).expect("cached success");
        assert!(cached.is_ok());
    }

    #[test]
    fn does_not_cache_failed_startup_result() {
        let state = StartupCommandState {
            in_progress: false,
            last_result: Some(Err("startup failed".to_string())),
        };

        assert!(cached_startup_summary(&state).is_none());
    }
}
