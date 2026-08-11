//! Discovery of the two on-disk sources this app reads instead of polling APIs:
//! Warframe's own `EE.log` (real-time events) and AlecaFrame's cached inventory.
//!
//! See `Resources/WFAndAlecaAppData/plan.md`. Both live under `%LOCALAPPDATA%`, so
//! everything here is Windows-shaped — but the probe deliberately compiles and runs
//! everywhere, because "the paths aren't there" is a normal state we must report
//! rather than a build-time impossibility. That also lets the whole pipeline be
//! developed and tested against the committed reference copies in `Resources/`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Overrides the discovered Warframe directory. Set to the folder holding `EE.log`.
pub const WARFRAME_DIR_ENV: &str = "WARSTONKS_WARFRAME_DIR";
/// Overrides the discovered AlecaFrame directory (the one holding `lastData.dat`).
pub const ALECAFRAME_DIR_ENV: &str = "WARSTONKS_ALECAFRAME_DIR";

/// Why a source isn't usable. Kept distinct from "missing" so the UI can say
/// something true: telling a macOS user to "install AlecaFrame" would be wrong,
/// and telling a Windows user "unsupported platform" would be equally wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceUnavailableReason {
    /// The host OS has no `%LOCALAPPDATA%` equivalent for these apps.
    UnsupportedPlatform,
    /// Supported OS, but the directory isn't there — the app was never installed,
    /// or (for Warframe) the game has not been launched on this machine.
    NotInstalled,
    /// Directory exists but the file we need is absent. For `EE.log` this is the
    /// ordinary "game has not run since install" case, not an error.
    FileMissing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SourceStatus {
    Available { path: PathBuf },
    Unavailable { reason: SourceUnavailableReason },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSourceAvailability {
    /// `%LOCALAPPDATA%\Warframe\EE.log` — trades, DMs, mission events.
    pub warframe_log: SourceStatus,
    /// `%LOCALAPPDATA%\AlecaFrame\lastData.dat` — the encrypted inventory snapshot.
    pub alecaframe_inventory: SourceStatus,
    /// True when either override env var is in effect, so the UI can show that it is
    /// pointed at a copy rather than the live install.
    pub using_override: bool,
}

fn local_app_data() -> Option<PathBuf> {
    // Present on Windows; absent elsewhere, which is exactly how we detect platform
    // support without a cfg! gate that would make this untestable off-Windows.
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

fn resolve_dir(env_key: &str, subdirectory: &str) -> Result<PathBuf, SourceUnavailableReason> {
    if let Some(override_dir) = std::env::var_os(env_key) {
        let path = PathBuf::from(override_dir);
        return if path.is_dir() {
            Ok(path)
        } else {
            Err(SourceUnavailableReason::NotInstalled)
        };
    }

    let root = local_app_data().ok_or(SourceUnavailableReason::UnsupportedPlatform)?;
    let path = root.join(subdirectory);
    if path.is_dir() {
        Ok(path)
    } else {
        Err(SourceUnavailableReason::NotInstalled)
    }
}

fn probe_file(
    env_key: &str,
    subdirectory: &str,
    file_name: &str,
) -> SourceStatus {
    match resolve_dir(env_key, subdirectory) {
        Err(reason) => SourceStatus::Unavailable { reason },
        Ok(directory) => {
            let path = directory.join(file_name);
            if path.is_file() {
                SourceStatus::Available { path }
            } else {
                SourceStatus::Unavailable {
                    reason: SourceUnavailableReason::FileMissing,
                }
            }
        }
    }
}

/// Probes both sources. Cheap (a couple of stat calls) and side-effect free, so it is
/// safe to call on every settings render rather than caching a stale answer — a user
/// can install AlecaFrame or launch the game while the app is open.
pub fn probe() -> LocalSourceAvailability {
    LocalSourceAvailability {
        warframe_log: probe_file(WARFRAME_DIR_ENV, "Warframe", "EE.log"),
        alecaframe_inventory: probe_file(ALECAFRAME_DIR_ENV, "AlecaFrame", "lastData.dat"),
        using_override: std::env::var_os(WARFRAME_DIR_ENV).is_some()
            || std::env::var_os(ALECAFRAME_DIR_ENV).is_some(),
    }
}

#[tauri::command]
pub fn probe_local_sources() -> LocalSourceAvailability {
    probe()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    /// The probe reads process-wide env vars, so tests that set them must not overlap.
    fn env_guard() -> &'static Mutex<()> {
        static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        GUARD.get_or_init(|| Mutex::new(()))
    }

    struct ScopedEnv(&'static str);

    impl ScopedEnv {
        fn set(key: &'static str, value: &Path) -> Self {
            std::env::set_var(key, value);
            ScopedEnv(key)
        }
    }

    impl Drop for ScopedEnv {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    #[test]
    fn an_override_pointing_at_a_real_file_reports_available() {
        let _lock = env_guard().lock().unwrap_or_else(|error| error.into_inner());
        let directory = std::env::temp_dir().join("warstonks-probe-available");
        std::fs::create_dir_all(&directory).unwrap();
        let log = directory.join("EE.log");
        std::fs::write(&log, b"0.000 Sys [Diag]: Current time:").unwrap();

        let _env = ScopedEnv::set(WARFRAME_DIR_ENV, &directory);
        let status = probe_file(WARFRAME_DIR_ENV, "Warframe", "EE.log");

        assert_eq!(status, SourceStatus::Available { path: log.clone() });
        assert!(probe().using_override);

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_directory_without_the_file_is_missing_rather_than_uninstalled() {
        // The ordinary "AlecaFrame installed but the game never ran" case. Reporting
        // NotInstalled here would send the user to fix something already fine.
        let _lock = env_guard().lock().unwrap_or_else(|error| error.into_inner());
        let directory = std::env::temp_dir().join("warstonks-probe-empty");
        std::fs::create_dir_all(&directory).unwrap();

        let _env = ScopedEnv::set(ALECAFRAME_DIR_ENV, &directory);
        let status = probe_file(ALECAFRAME_DIR_ENV, "AlecaFrame", "lastData.dat");

        assert_eq!(
            status,
            SourceStatus::Unavailable {
                reason: SourceUnavailableReason::FileMissing
            }
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn an_override_pointing_nowhere_reports_not_installed() {
        let _lock = env_guard().lock().unwrap_or_else(|error| error.into_inner());
        let missing = std::env::temp_dir().join("warstonks-probe-does-not-exist");
        std::fs::remove_dir_all(&missing).ok();

        let _env = ScopedEnv::set(WARFRAME_DIR_ENV, &missing);
        assert_eq!(
            probe_file(WARFRAME_DIR_ENV, "Warframe", "EE.log"),
            SourceStatus::Unavailable {
                reason: SourceUnavailableReason::NotInstalled
            }
        );
    }

    #[test]
    fn the_committed_reference_copies_are_discoverable() {
        // Guards the development path the whole pipeline is built against: the
        // reference EE.log and AlecaFrame folder checked into Resources/. If these
        // move, every downstream parser test loses its fixture silently.
        let resources = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("Resources/WFAndAlecaAppData");
        assert!(
            resources.join("EE.log").is_file(),
            "reference EE.log missing from {}",
            resources.display()
        );
        assert!(
            resources
                .join("AlecaFrame App Data Reference/lastData.dat")
                .is_file(),
            "reference lastData.dat missing"
        );
    }
}
