use anyhow::{Context, Result};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const ERROR_LOG_DIRECTORY: &str = "logs";
const ACTIVE_ERROR_LOG_FILE: &str = "error-log.log";
const ARCHIVED_ERROR_LOG_FILE: &str = "error-log-previous.log";
const MAX_ERROR_LOG_BYTES: u64 = 10 * 1024 * 1024;

pub fn log_feature_error(
    app: &AppHandle,
    feature: &str,
    stage: &str,
    detail: &str,
    error: &anyhow::Error,
) -> Result<()> {
    let log_dir = resolve_error_log_dir(app)?;
    let entry = format_error_entry(feature, stage, detail, error);
    append_rotating_error_entry(&log_dir, &entry, MAX_ERROR_LOG_BYTES)
}

pub fn log_feature_error_best_effort(
    app: &AppHandle,
    feature: &str,
    stage: &str,
    detail: &str,
    error: &anyhow::Error,
) {
    if let Err(log_error) = log_feature_error(app, feature, stage, detail, error) {
        eprintln!(
            "[error-log] failed to write error log for feature={feature} stage={stage}: {log_error}"
        );
    }
}

fn resolve_error_log_dir(app: &AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory for error logs")?;
    let log_dir = app_data_dir.join(ERROR_LOG_DIRECTORY);
    fs::create_dir_all(&log_dir)
        .with_context(|| format!("failed to create {}", log_dir.display()))?;
    Ok(log_dir)
}

fn format_error_entry(feature: &str, stage: &str, detail: &str, error: &anyhow::Error) -> String {
    format!(
        "[{timestamp}] [feature:{feature}] [stage:{stage}]\nDetail: {detail}\nError: {chain}\n\n",
        timestamp = now_rfc3339(),
        feature = feature,
        stage = stage,
        detail = detail,
        chain = format_error_chain(error),
    )
}

fn format_error_chain(error: &anyhow::Error) -> String {
    error
        .chain()
        .map(|cause| cause.to_string())
        .collect::<Vec<_>>()
        .join(" -> ")
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn append_rotating_error_entry(log_dir: &Path, entry: &str, max_bytes: u64) -> Result<()> {
    fs::create_dir_all(log_dir)
        .with_context(|| format!("failed to create {}", log_dir.display()))?;

    let active_log = log_dir.join(ACTIVE_ERROR_LOG_FILE);
    let archived_log = log_dir.join(ARCHIVED_ERROR_LOG_FILE);
    let entry_size = entry.as_bytes().len() as u64;

    if active_log.exists() {
        let active_size = fs::metadata(&active_log)
            .with_context(|| format!("failed to inspect {}", active_log.display()))?
            .len();
        if active_size.saturating_add(entry_size) > max_bytes {
            if archived_log.exists() {
                fs::remove_file(&archived_log)
                    .with_context(|| format!("failed to remove {}", archived_log.display()))?;
            }
            fs::rename(&active_log, &archived_log).with_context(|| {
                format!(
                    "failed to rotate {} to {}",
                    active_log.display(),
                    archived_log.display()
                )
            })?;
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&active_log)
        .with_context(|| format!("failed to open {}", active_log.display()))?;
    file.write_all(entry.as_bytes())
        .with_context(|| format!("failed to write {}", active_log.display()))?;
    file.flush()
        .with_context(|| format!("failed to flush {}", active_log.display()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::append_rotating_error_entry;
    use anyhow::Result;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_log_dir(test_name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "warstonks-error-log-{test_name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ))
    }

    #[test]
    fn appends_to_active_log_while_under_limit() -> Result<()> {
        let log_dir = temp_log_dir("append");
        append_rotating_error_entry(&log_dir, "first\n", 128)?;
        append_rotating_error_entry(&log_dir, "second\n", 128)?;

        let active = fs::read_to_string(log_dir.join("error-log.log"))?;
        assert!(active.contains("first"));
        assert!(active.contains("second"));
        assert!(!log_dir.join("error-log-previous.log").exists());

        fs::remove_dir_all(&log_dir)?;
        Ok(())
    }

    #[test]
    fn rotates_and_replaces_previous_log_when_limit_is_exceeded() -> Result<()> {
        let log_dir = temp_log_dir("rotate");
        append_rotating_error_entry(&log_dir, "1234567890\n", 12)?;
        append_rotating_error_entry(&log_dir, "abcdef\n", 12)?;
        append_rotating_error_entry(&log_dir, "fresh\n", 12)?;

        let active = fs::read_to_string(log_dir.join("error-log.log"))?;
        let archived = fs::read_to_string(log_dir.join("error-log-previous.log"))?;

        assert_eq!(active, "fresh\n");
        assert_eq!(archived, "abcdef\n");

        fs::remove_dir_all(&log_dir)?;
        Ok(())
    }
}
