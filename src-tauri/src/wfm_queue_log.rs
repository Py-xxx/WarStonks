use anyhow::{Context, Result};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const QUEUE_LOG_DIRECTORY: &str = "logs";
const ACTIVE_QUEUE_LOG_FILE: &str = "wfm-priority-queue.log";
const ARCHIVED_QUEUE_LOG_FILE: &str = "wfm-priority-queue-previous.log";
const MAX_QUEUE_LOG_BYTES: u64 = 10 * 1024 * 1024;

struct QueueLogWriter {
    sender: mpsc::Sender<String>,
}

fn queue_log_writer() -> &'static OnceLock<QueueLogWriter> {
    static WRITER: OnceLock<QueueLogWriter> = OnceLock::new();
    &WRITER
}

pub fn initialize_wfm_queue_log(app: &AppHandle) -> Result<()> {
    let log_dir = resolve_queue_log_dir(app)?;
    if queue_log_writer().get().is_some() {
        return Ok(());
    }

    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("wfm-queue-log-writer".to_string())
        .spawn(move || {
            while let Ok(entry) = receiver.recv() {
                if let Err(error) =
                    append_rotating_queue_entry(&log_dir, entry.as_str(), MAX_QUEUE_LOG_BYTES)
                {
                    eprintln!("[wfm-queue-log] failed to write entry: {error}");
                }
            }
        })
        .context("failed to spawn WFM queue log writer thread")?;

    let _ = queue_log_writer().set(QueueLogWriter { sender });
    Ok(())
}

pub fn initialize_wfm_queue_log_best_effort(app: &AppHandle) {
    if let Err(error) = initialize_wfm_queue_log(app) {
        eprintln!("[wfm-queue-log] failed to initialize: {error}");
    }
}

pub fn log_wfm_queue_event_best_effort(entry: String) {
    let Some(writer) = queue_log_writer().get() else {
        return;
    };
    let _ = writer.sender.send(entry);
}

fn resolve_queue_log_dir(app: &AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory for WFM queue logs")?;
    let log_dir = app_data_dir.join(QUEUE_LOG_DIRECTORY);
    fs::create_dir_all(&log_dir)
        .with_context(|| format!("failed to create {}", log_dir.display()))?;
    Ok(log_dir)
}

fn append_rotating_queue_entry(log_dir: &Path, entry: &str, max_bytes: u64) -> Result<()> {
    fs::create_dir_all(log_dir)
        .with_context(|| format!("failed to create {}", log_dir.display()))?;

    let active_log = log_dir.join(ACTIVE_QUEUE_LOG_FILE);
    let archived_log = log_dir.join(ARCHIVED_QUEUE_LOG_FILE);
    let entry_size = entry.len() as u64;

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
    use super::append_rotating_queue_entry;
    use anyhow::Result;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_log_dir(test_name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "warstonks-wfm-queue-log-{test_name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ))
    }

    #[test]
    fn appends_to_active_log_while_under_limit() -> Result<()> {
        let log_dir = temp_log_dir("append");
        append_rotating_queue_entry(&log_dir, "first\n", 128)?;
        append_rotating_queue_entry(&log_dir, "second\n", 128)?;

        let active = fs::read_to_string(log_dir.join("wfm-priority-queue.log"))?;
        assert!(active.contains("first"));
        assert!(active.contains("second"));
        assert!(!log_dir.join("wfm-priority-queue-previous.log").exists());

        fs::remove_dir_all(&log_dir)?;
        Ok(())
    }

    #[test]
    fn rotates_and_replaces_previous_log_when_limit_is_exceeded() -> Result<()> {
        let log_dir = temp_log_dir("rotate");
        append_rotating_queue_entry(&log_dir, "1234567890\n", 12)?;
        append_rotating_queue_entry(&log_dir, "abcdef\n", 12)?;
        append_rotating_queue_entry(&log_dir, "fresh\n", 12)?;

        let active = fs::read_to_string(log_dir.join("wfm-priority-queue.log"))?;
        let archived = fs::read_to_string(log_dir.join("wfm-priority-queue-previous.log"))?;

        assert_eq!(active, "fresh\n");
        assert_eq!(archived, "abcdef\n");

        fs::remove_dir_all(&log_dir)?;
        Ok(())
    }
}
