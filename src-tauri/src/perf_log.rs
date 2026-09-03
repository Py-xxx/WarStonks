//! Stage timings for the market read path.
//!
//! **Why this exists:** the only instrumented layer in the market pipeline was the WFM scheduler,
//! and the scheduler is provably healthy — across 2,536 logged requests the queue wait was 0ms at
//! p50 for every priority and `rateLimited` never left 0. Selecting an item is nonetheless slow,
//! and it is *equally* slow on a warm item that needs no network at all. So the time goes
//! somewhere between "command entered" and "response returned", and until this module there was
//! exactly one `Instant::now()` in all of `market_observatory.rs`.
//!
//! Entries are written through the WFM queue log's own writer, so local stage timings interleave
//! with the network lines on **one timeline** — which is the only way to see whether a stage is
//! waiting on a request or on itself. They carry `event=timing`, so they are trivially separable
//! from the scheduler's `event=` lines.
//!
//! **Off unless asked for.** This is a hot path; set `WARSTONKS_PERF_LOG=1` before launching.

use std::sync::OnceLock;
use std::time::Instant;

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn perf_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("WARSTONKS_PERF_LOG")
            .map(|value| {
                let value = value.trim().to_ascii_lowercase();
                value == "1" || value == "true" || value == "yes"
            })
            .unwrap_or(false)
    })
}

/// A timed region. Drop it, or call `finish`, to record how long it took.
///
/// Cheap to construct when logging is off — no allocation, no clock read beyond one `Instant`.
pub struct PerfSpan {
    scope: &'static str,
    subject: String,
    started: Instant,
    enabled: bool,
}

impl PerfSpan {
    pub fn start(scope: &'static str, subject: impl Into<String>) -> Self {
        let enabled = perf_enabled();
        Self {
            scope,
            subject: if enabled { subject.into() } else { String::new() },
            started: Instant::now(),
            enabled,
        }
    }

    /// Record a completed stage without ending the span, so one span can report several steps
    /// against a single start time.
    pub fn mark(&self, stage: &str) {
        if !self.enabled {
            return;
        }
        self.emit(stage, self.started.elapsed().as_micros());
    }

    pub fn finish(self, stage: &str) {
        if !self.enabled {
            return;
        }
        self.emit(stage, self.started.elapsed().as_micros());
    }

    fn emit(&self, stage: &str, micros: u128) {
        let entry = format!(
            "[{}] event=timing scope={} stage={} elapsedMs={:.2} subject=\"{}\"",
            now_rfc3339(),
            self.scope,
            stage,
            micros as f64 / 1000.0,
            self.subject,
        );
        crate::wfm_queue_log::log_wfm_queue_event_best_effort(entry);
    }
}

/// Times a single expression and records it as one stage.
#[macro_export]
macro_rules! perf_stage {
    ($scope:expr, $subject:expr, $stage:expr, $body:expr) => {{
        let __span = $crate::perf_log::PerfSpan::start($scope, $subject);
        let __result = $body;
        __span.finish($stage);
        __result
    }};
}

/// Records a size alongside the timings — a payload that crosses the Tauri bridge as JSON is a
/// cost the stage timers cannot see.
pub fn log_payload_size(scope: &'static str, subject: &str, bytes: usize) {
    if !perf_enabled() {
        return;
    }
    let entry = format!(
        "[{}] event=timing scope={} stage=payload bytes={} subject=\"{}\"",
        now_rfc3339(),
        scope,
        bytes,
        subject,
    );
    crate::wfm_queue_log::log_wfm_queue_event_best_effort(entry);
}
