use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_GRANTS_PER_WINDOW: usize = 3;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
const PRIORITY_COUNT: usize = 5;
const PRIORITY_QUANTA: [i32; PRIORITY_COUNT] = [0, 8, 4, 2, 1];
const MAX_DEFICIT_MULTIPLIER: i32 = 4;
const SCHEDULER_POLL_INTERVAL: Duration = Duration::from_millis(20);
const COALESCED_SUCCESS_TTL: Duration = Duration::from_millis(1);
const COALESCED_ERROR_TTL: Duration = Duration::from_millis(1);
const BASE_RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(2);
const MAX_RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(15);
const SLOW_WAIT_LOG_THRESHOLD: Duration = Duration::from_millis(250);

#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RequestPriority {
    Instant,
    High,
    Medium,
    Low,
    Background,
}

impl RequestPriority {
    fn index(self) -> usize {
        match self {
            Self::Instant => 0,
            Self::High => 1,
            Self::Medium => 2,
            Self::Low => 3,
            Self::Background => 4,
        }
    }

    pub fn from_wire(value: Option<&str>, default: Self) -> Self {
        match value
            .map(|entry| entry.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("instant") => Self::Instant,
            Some("high") => Self::High,
            Some("medium") => Self::Medium,
            Some("low") => Self::Low,
            Some("background") => Self::Background,
            _ => default,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Instant => "instant",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
            Self::Background => "background",
        }
    }
}

#[derive(Debug, Clone)]
struct RequestTicket {
    id: u64,
    label: String,
    enqueued_at: Instant,
    priority: RequestPriority,
}

#[derive(Debug, Clone)]
pub struct WfmHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub retry_after: Option<Duration>,
}

#[derive(Debug, Clone)]
struct CachedResponse {
    result: std::result::Result<WfmHttpResponse, String>,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
enum CoalescedEntry {
    InFlight,
    Ready(CachedResponse),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmQueuedRequestSnapshot {
    pub id: u64,
    pub label: String,
    pub priority: String,
    pub queued_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmSchedulerSnapshot {
    pub instant_queue_depth: usize,
    pub high_queue_depth: usize,
    pub medium_queue_depth: usize,
    pub low_queue_depth: usize,
    pub background_queue_depth: usize,
    pub recent_grants_in_window: usize,
    pub in_flight_coalesced_keys: usize,
    pub cached_coalesced_keys: usize,
    pub total_grants: u64,
    pub total_coalesced_hits: u64,
    pub total_rate_limited_responses: u64,
    pub cooldown_remaining_ms: u64,
    pub queued_requests: Vec<WfmQueuedRequestSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueDebugEvent {
    timestamp_ms: u64,
    event: String,
    request_label: String,
    request_priority: String,
    ticket_id: Option<u64>,
    coalesce_key: Option<String>,
    waited_ms: Option<u64>,
    total_ms: Option<u64>,
    network_ms: Option<u64>,
    status: Option<u16>,
    cooldown_remaining_ms: u64,
    snapshot: WfmSchedulerSnapshot,
}

#[derive(Debug)]
struct SchedulerState {
    queues: [VecDeque<RequestTicket>; PRIORITY_COUNT],
    deficits: [i32; PRIORITY_COUNT],
    cursor: usize,
    next_id: u64,
    recent_grants: VecDeque<Instant>,
    cooldown_until: Option<Instant>,
    rate_limit_streak: u32,
    coalesced: HashMap<String, CoalescedEntry>,
    total_grants: u64,
    total_coalesced_hits: u64,
    total_rate_limited_responses: u64,
    debug_log_path: Option<PathBuf>,
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self {
            queues: [
                VecDeque::new(),
                VecDeque::new(),
                VecDeque::new(),
                VecDeque::new(),
                VecDeque::new(),
            ],
            deficits: [0; PRIORITY_COUNT],
            cursor: RequestPriority::High.index(),
            next_id: 1,
            recent_grants: VecDeque::new(),
            cooldown_until: None,
            rate_limit_streak: 0,
            coalesced: HashMap::new(),
            total_grants: 0,
            total_coalesced_hits: 0,
            total_rate_limited_responses: 0,
            debug_log_path: None,
        }
    }
}

fn scheduler_state() -> &'static (Mutex<SchedulerState>, Condvar) {
    static STATE: OnceLock<(Mutex<SchedulerState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(SchedulerState::default()), Condvar::new()))
}

pub fn configure_wfm_scheduler_debug_log(path: Option<PathBuf>) {
    let (lock, _) = scheduler_state();
    if let Ok(mut state) = lock.lock() {
        state.debug_log_path = path;
    }
}

pub fn acquire_wfm_slot(priority: RequestPriority, label: &str) {
    let _ = acquire_wfm_slot_interruptible(priority, label, || false);
}

pub fn acquire_wfm_slot_interruptible<C>(
    priority: RequestPriority,
    label: &str,
    mut is_cancelled: C,
) -> Result<()>
where
    C: FnMut() -> bool,
{
    let (lock, condvar) = scheduler_state();
    let mut state = lock.lock().expect("wfm scheduler lock poisoned");
    let ticket_id = state.next_id;
    state.next_id = state.next_id.wrapping_add(1);
    let ticket = RequestTicket {
        id: ticket_id,
        label: label.to_string(),
        enqueued_at: Instant::now(),
        priority,
    };
    state.queues[priority.index()].push_back(ticket.clone());
    log_scheduler_event(
        &state,
        Instant::now(),
        "queued",
        &ticket.label,
        ticket.priority,
        Some(ticket.id),
        None,
        None,
        None,
        None,
        None,
    );
    condvar.notify_all();

    loop {
        let now = Instant::now();
        prune_old_grants(&mut state, now);
        cleanup_expired_coalesced(&mut state, now);

        if is_cancelled() {
            remove_ticket(&mut state, priority.index(), ticket_id);
            log_scheduler_event(
                &state,
                now,
                "cancelled",
                label,
                priority,
                Some(ticket_id),
                None,
                None,
                None,
                None,
                None,
            );
            condvar.notify_all();
            return Err(anyhow!("{label} cancelled before dispatch"));
        }

        if let Some(granted_ticket) = try_grant(&mut state, now) {
            let waited_ms = now
                .saturating_duration_since(granted_ticket.enqueued_at)
                .as_millis() as u64;
            log_scheduler_event(
                &state,
                now,
                "granted",
                &granted_ticket.label,
                granted_ticket.priority,
                Some(granted_ticket.id),
                None,
                Some(waited_ms),
                None,
                None,
                None,
            );
            condvar.notify_all();
            if granted_ticket.id == ticket_id {
                if waited_ms >= SLOW_WAIT_LOG_THRESHOLD.as_millis() as u64 {
                    eprintln!(
                        "[wfm-scheduler] delayed {} request '{}' by {} ms",
                        priority.as_str(),
                        granted_ticket.label,
                        waited_ms
                    );
                }
                return Ok(());
            }
        }

        let timeout = scheduler_wait_duration(&state, now).unwrap_or(SCHEDULER_POLL_INTERVAL);
        let (next_state, _) = condvar.wait_timeout(state, timeout).unwrap();
        state = next_state;
    }
}

pub fn execute_coalesced_wfm_request<C, F>(
    priority: RequestPriority,
    label: &str,
    coalesce_key: Option<String>,
    mut is_cancelled: C,
    request_fn: F,
) -> Result<WfmHttpResponse>
where
    C: FnMut() -> bool,
    F: FnOnce() -> Result<WfmHttpResponse>,
{
    let total_started_at = Instant::now();
    let Some(coalesce_key) = coalesce_key else {
        acquire_wfm_slot_interruptible(priority, label, || is_cancelled())?;
        let request_started_at = Instant::now();
        let outcome = request_fn();
        if let Ok(response) = &outcome {
            record_wfm_response(response.status, response.retry_after, label);
        }
        log_request_resolution(
            label,
            priority,
            None,
            total_started_at,
            request_started_at,
            outcome.as_ref().ok().map(|response| response.status),
        );
        return outcome;
    };

    let mut request_fn = Some(request_fn);
    loop {
        if is_cancelled() {
            return Err(anyhow!("{label} cancelled before request coalesced"));
        }

        let mut wait_for_existing = false;
        {
            let (lock, condvar) = scheduler_state();
            let mut state = lock.lock().expect("wfm scheduler lock poisoned");
            let now = Instant::now();
            prune_old_grants(&mut state, now);
            cleanup_expired_coalesced(&mut state, now);

            match state.coalesced.get(&coalesce_key) {
                Some(CoalescedEntry::Ready(cached)) => {
                    let cached_response = clone_cached_response(cached);
                    state.total_coalesced_hits = state.total_coalesced_hits.saturating_add(1);
                    log_scheduler_event(
                        &state,
                        now,
                        "coalesced-hit",
                        label,
                        priority,
                        None,
                        Some(coalesce_key.clone()),
                        None,
                        Some(total_started_at.elapsed().as_millis() as u64),
                        Some(0),
                        cached_response.as_ref().ok().map(|response| response.status),
                    );
                    condvar.notify_all();
                    return cached_response;
                }
                Some(CoalescedEntry::InFlight) => {
                    wait_for_existing = true;
                }
                None => {
                    state
                        .coalesced
                        .insert(coalesce_key.clone(), CoalescedEntry::InFlight);
                    log_scheduler_event(
                        &state,
                        now,
                        "coalesced-leader",
                        label,
                        priority,
                        None,
                        Some(coalesce_key.clone()),
                        None,
                        None,
                        None,
                        None,
                    );
                }
            }

            if wait_for_existing {
                let (next_state, _) = condvar.wait_timeout(state, SCHEDULER_POLL_INTERVAL).unwrap();
                drop(next_state);
                continue;
            }
        }

        let request_started_at = Instant::now();
        let outcome = (|| {
            acquire_wfm_slot_interruptible(priority, label, || is_cancelled())?;
            request_fn
                .take()
                .expect("coalesced WFM request already executed")()
        })();

        let cached = match &outcome {
            Ok(response) => {
                record_wfm_response(response.status, response.retry_after, label);
                CachedResponse {
                    result: Ok(response.clone()),
                    expires_at: Instant::now() + COALESCED_SUCCESS_TTL,
                }
            }
            Err(error) => CachedResponse {
                result: Err(error.to_string()),
                expires_at: Instant::now() + COALESCED_ERROR_TTL,
            },
        };

        let (lock, condvar) = scheduler_state();
        let mut state = lock.lock().expect("wfm scheduler lock poisoned");
        if cached.expires_at > Instant::now() {
            state
                .coalesced
                .insert(coalesce_key.clone(), CoalescedEntry::Ready(cached));
        } else {
            state.coalesced.remove(&coalesce_key);
        }
        log_scheduler_event(
            &state,
            Instant::now(),
            "resolved",
            label,
            priority,
            None,
            Some(coalesce_key.clone()),
            None,
            Some(total_started_at.elapsed().as_millis() as u64),
            Some(request_started_at.elapsed().as_millis() as u64),
            outcome.as_ref().ok().map(|response| response.status),
        );
        condvar.notify_all();
        return outcome;
    }
}

pub fn record_wfm_response(status: u16, retry_after: Option<Duration>, label: &str) {
    let (lock, condvar) = scheduler_state();
    let mut state = lock.lock().expect("wfm scheduler lock poisoned");
    let now = Instant::now();
    if status == 429 {
        state.total_rate_limited_responses = state.total_rate_limited_responses.saturating_add(1);
        state.rate_limit_streak = state.rate_limit_streak.saturating_add(1).min(6);
        let multiplier = 1_u32 << state.rate_limit_streak.saturating_sub(1);
        let computed = BASE_RATE_LIMIT_BACKOFF.saturating_mul(multiplier);
        let backoff = retry_after.unwrap_or(computed).min(MAX_RATE_LIMIT_BACKOFF);
        let next_cooldown = now + backoff;
        state.cooldown_until = Some(
            state
                .cooldown_until
                .map(|existing| existing.max(next_cooldown))
                .unwrap_or(next_cooldown),
        );
        eprintln!(
            "[wfm-scheduler] received 429 for '{}' - cooling down for {} ms",
            label,
            backoff.as_millis()
        );
        log_scheduler_event(
            &state,
            now,
            "rate-limited",
            label,
            RequestPriority::High,
            None,
            None,
            None,
            None,
            None,
            Some(status),
        );
        condvar.notify_all();
        return;
    }

    if status < 400 {
        state.rate_limit_streak = 0;
        if state
            .cooldown_until
            .map(|instant| instant <= now)
            .unwrap_or(false)
        {
            state.cooldown_until = None;
        }
    }
}

pub fn wfm_scheduler_snapshot() -> WfmSchedulerSnapshot {
    let (lock, _) = scheduler_state();
    let mut state = lock.lock().expect("wfm scheduler lock poisoned");
    let now = Instant::now();
    prune_old_grants(&mut state, now);
    cleanup_expired_coalesced(&mut state, now);
    build_snapshot(&state, now)
}

fn clone_cached_response(cached: &CachedResponse) -> Result<WfmHttpResponse> {
    cached.result.clone().map_err(|error| anyhow!(error))
}

fn cleanup_expired_coalesced(state: &mut SchedulerState, now: Instant) {
    state.coalesced.retain(|_, entry| match entry {
        CoalescedEntry::InFlight => true,
        CoalescedEntry::Ready(cached) => cached.expires_at > now,
    });
}

fn prune_old_grants(state: &mut SchedulerState, now: Instant) {
    while let Some(front) = state.recent_grants.front() {
        if now.duration_since(*front) >= RATE_LIMIT_WINDOW {
            state.recent_grants.pop_front();
        } else {
            break;
        }
    }

    if state
        .cooldown_until
        .map(|instant| instant <= now)
        .unwrap_or(false)
    {
        state.cooldown_until = None;
    }
}

fn scheduler_available(state: &SchedulerState, now: Instant) -> bool {
    let cooldown_ready = state
        .cooldown_until
        .map(|instant| instant <= now)
        .unwrap_or(true);
    cooldown_ready && state.recent_grants.len() < MAX_GRANTS_PER_WINDOW
}

fn scheduler_wait_duration(state: &SchedulerState, now: Instant) -> Option<Duration> {
    let rate_wait = state.recent_grants.front().map(|oldest| {
        let elapsed = now.duration_since(*oldest);
        if elapsed >= RATE_LIMIT_WINDOW {
            Duration::from_millis(0)
        } else {
            RATE_LIMIT_WINDOW - elapsed
        }
    });
    let cooldown_wait = state
        .cooldown_until
        .and_then(|instant| instant.checked_duration_since(now));

    match (rate_wait, cooldown_wait) {
        (Some(left), Some(right)) => Some(left.min(right).min(SCHEDULER_POLL_INTERVAL)),
        (Some(left), None) => Some(left.min(SCHEDULER_POLL_INTERVAL)),
        (None, Some(right)) => Some(right.min(SCHEDULER_POLL_INTERVAL)),
        (None, None) => None,
    }
}

fn replenish_deficits(state: &mut SchedulerState) {
    for index in RequestPriority::High.index()..PRIORITY_COUNT {
        let max_deficit = PRIORITY_QUANTA[index] * MAX_DEFICIT_MULTIPLIER;
        let updated = state.deficits[index] + PRIORITY_QUANTA[index];
        state.deficits[index] = updated.min(max_deficit);
    }
}

fn select_weighted_queue_index(state: &mut SchedulerState) -> Option<usize> {
    for _ in RequestPriority::High.index()..PRIORITY_COUNT {
        let index = state.cursor;
        state.cursor += 1;
        if state.cursor >= PRIORITY_COUNT {
            state.cursor = RequestPriority::High.index();
        }

        if !state.queues[index].is_empty() && state.deficits[index] > 0 {
            return Some(index);
        }
    }
    None
}

fn try_grant(state: &mut SchedulerState, now: Instant) -> Option<RequestTicket> {
    if state.queues.iter().all(|queue| queue.is_empty()) {
        return None;
    }

    if !scheduler_available(state, now) {
        return None;
    }

    if let Some(ticket) = state.queues[RequestPriority::Instant.index()].pop_front() {
        state.recent_grants.push_back(now);
        state.total_grants = state.total_grants.saturating_add(1);
        return Some(ticket);
    }

    let has_credit = state
        .queues
        .iter()
        .enumerate()
        .skip(RequestPriority::High.index())
        .any(|(index, queue)| !queue.is_empty() && state.deficits[index] > 0);
    if !has_credit {
        replenish_deficits(state);
    }

    let index = select_weighted_queue_index(state).or_else(|| {
        replenish_deficits(state);
        select_weighted_queue_index(state)
    })?;

    let ticket = state.queues[index].pop_front()?;
    state.deficits[index] = state.deficits[index].saturating_sub(1);
    state.recent_grants.push_back(now);
    state.total_grants = state.total_grants.saturating_add(1);
    Some(ticket)
}

fn remove_ticket(state: &mut SchedulerState, queue_index: usize, ticket_id: u64) {
    if let Some(position) = state.queues[queue_index]
        .iter()
        .position(|ticket| ticket.id == ticket_id)
    {
        state.queues[queue_index].remove(position);
    }
}

fn build_snapshot(state: &SchedulerState, now: Instant) -> WfmSchedulerSnapshot {
    let in_flight_coalesced_keys = state
        .coalesced
        .values()
        .filter(|entry| matches!(entry, CoalescedEntry::InFlight))
        .count();
    let cached_coalesced_keys = state
        .coalesced
        .values()
        .filter(|entry| matches!(entry, CoalescedEntry::Ready(_)))
        .count();
    let cooldown_remaining_ms = state
        .cooldown_until
        .and_then(|instant| instant.checked_duration_since(now))
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);

    WfmSchedulerSnapshot {
        instant_queue_depth: state.queues[RequestPriority::Instant.index()].len(),
        high_queue_depth: state.queues[RequestPriority::High.index()].len(),
        medium_queue_depth: state.queues[RequestPriority::Medium.index()].len(),
        low_queue_depth: state.queues[RequestPriority::Low.index()].len(),
        background_queue_depth: state.queues[RequestPriority::Background.index()].len(),
        recent_grants_in_window: state.recent_grants.len(),
        in_flight_coalesced_keys,
        cached_coalesced_keys,
        total_grants: state.total_grants,
        total_coalesced_hits: state.total_coalesced_hits,
        total_rate_limited_responses: state.total_rate_limited_responses,
        cooldown_remaining_ms,
        queued_requests: state
            .queues
            .iter()
            .flat_map(|queue| queue.iter())
            .map(|ticket| WfmQueuedRequestSnapshot {
                id: ticket.id,
                label: ticket.label.clone(),
                priority: ticket.priority.as_str().to_string(),
                queued_ms: now.saturating_duration_since(ticket.enqueued_at).as_millis() as u64,
            })
            .collect(),
    }
}

fn log_request_resolution(
    label: &str,
    priority: RequestPriority,
    coalesce_key: Option<String>,
    total_started_at: Instant,
    request_started_at: Instant,
    status: Option<u16>,
) {
    let (lock, _) = scheduler_state();
    let state = lock.lock().expect("wfm scheduler lock poisoned");
    log_scheduler_event(
        &state,
        Instant::now(),
        "request-finished",
        label,
        priority,
        None,
        coalesce_key,
        None,
        Some(total_started_at.elapsed().as_millis() as u64),
        Some(request_started_at.elapsed().as_millis() as u64),
        status,
    );
}

#[allow(clippy::too_many_arguments)]
fn log_scheduler_event(
    state: &SchedulerState,
    now: Instant,
    event: &str,
    request_label: &str,
    request_priority: RequestPriority,
    ticket_id: Option<u64>,
    coalesce_key: Option<String>,
    waited_ms: Option<u64>,
    total_ms: Option<u64>,
    network_ms: Option<u64>,
    status: Option<u16>,
) {
    let Some(path) = state.debug_log_path.clone() else {
        return;
    };

    let payload = QueueDebugEvent {
        timestamp_ms: unix_timestamp_ms(),
        event: event.to_string(),
        request_label: request_label.to_string(),
        request_priority: request_priority.as_str().to_string(),
        ticket_id,
        coalesce_key,
        waited_ms,
        total_ms,
        network_ms,
        status,
        cooldown_remaining_ms: state
            .cooldown_until
            .and_then(|instant| instant.checked_duration_since(now))
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        snapshot: build_snapshot(state, now),
    };

    let Ok(serialized) = serde_json::to_string(&payload) else {
        return;
    };
    let _ = append_json_line(&path, &serialized);
}

fn append_json_line(path: &PathBuf, line: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        try_grant, RequestPriority, RequestTicket, SchedulerState,
    };
    use std::time::Instant;

    #[test]
    fn instant_priority_jumps_the_queue() {
        let now = Instant::now();
        let mut state = SchedulerState::default();
        state.queues[RequestPriority::Low.index()].push_back(RequestTicket {
            id: 1,
            label: "scanner".to_string(),
            enqueued_at: now,
            priority: RequestPriority::Low,
        });
        state.queues[RequestPriority::Instant.index()].push_back(RequestTicket {
            id: 2,
            label: "search".to_string(),
            enqueued_at: now,
            priority: RequestPriority::Instant,
        });

        let granted = try_grant(&mut state, now).expect("expected a granted ticket");
        assert_eq!(granted.id, 2);
        assert_eq!(granted.priority, RequestPriority::Instant);
    }

    #[test]
    fn request_priority_parses_wire_values() {
        assert_eq!(
            RequestPriority::from_wire(Some("instant"), RequestPriority::Low),
            RequestPriority::Instant
        );
        assert_eq!(
            RequestPriority::from_wire(Some("background"), RequestPriority::High),
            RequestPriority::Background
        );
        assert_eq!(
            RequestPriority::from_wire(Some("unknown"), RequestPriority::Medium),
            RequestPriority::Medium
        );
    }
}
