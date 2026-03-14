use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_GRANTS_PER_WINDOW: usize = 3;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
const PRIORITY_COUNT: usize = 3;
const PRIORITY_QUANTA: [i32; PRIORITY_COUNT] = [3, 2, 1];
const MAX_DEFICIT_MULTIPLIER: i32 = 3;
const SCHEDULER_POLL_INTERVAL: Duration = Duration::from_millis(250);
const COALESCED_SUCCESS_TTL: Duration = Duration::from_millis(750);
const COALESCED_ERROR_TTL: Duration = Duration::from_millis(300);
const BASE_RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(2);
const MAX_RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(15);
const SLOW_WAIT_LOG_THRESHOLD: Duration = Duration::from_millis(500);

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum RequestPriority {
    High,
    Medium,
    Low,
}

impl RequestPriority {
    fn index(self) -> usize {
        match self {
            Self::High => 0,
            Self::Medium => 1,
            Self::Low => 2,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}

#[derive(Debug, Clone)]
struct RequestTicket {
    id: u64,
    label: String,
    enqueued_at: Instant,
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
pub struct WfmSchedulerSnapshot {
    pub high_queue_depth: usize,
    pub medium_queue_depth: usize,
    pub low_queue_depth: usize,
    pub recent_grants_in_window: usize,
    pub in_flight_coalesced_keys: usize,
    pub cached_coalesced_keys: usize,
    pub total_grants: u64,
    pub total_coalesced_hits: u64,
    pub total_rate_limited_responses: u64,
    pub cooldown_remaining_ms: u64,
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
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self {
            queues: [VecDeque::new(), VecDeque::new(), VecDeque::new()],
            deficits: [0; PRIORITY_COUNT],
            cursor: 0,
            next_id: 1,
            recent_grants: VecDeque::new(),
            cooldown_until: None,
            rate_limit_streak: 0,
            coalesced: HashMap::new(),
            total_grants: 0,
            total_coalesced_hits: 0,
            total_rate_limited_responses: 0,
        }
    }
}

fn scheduler_state() -> &'static (Mutex<SchedulerState>, Condvar) {
    static STATE: OnceLock<(Mutex<SchedulerState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(SchedulerState::default()), Condvar::new()))
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
    };
    state.queues[priority.index()].push_back(ticket);

    loop {
        let now = Instant::now();
        prune_old_grants(&mut state, now);
        cleanup_expired_coalesced(&mut state, now);

        if is_cancelled() {
            remove_ticket(&mut state, priority.index(), ticket_id);
            condvar.notify_all();
            return Err(anyhow!("{label} cancelled before dispatch"));
        }

        if let Some(granted_ticket) = try_grant(&mut state, now) {
            condvar.notify_all();
            if granted_ticket.id == ticket_id {
                let wait_time = now.saturating_duration_since(granted_ticket.enqueued_at);
                if wait_time >= SLOW_WAIT_LOG_THRESHOLD {
                    eprintln!(
                        "[wfm-scheduler] delayed {} request '{}' by {} ms",
                        priority.as_str(),
                        granted_ticket.label,
                        wait_time.as_millis()
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
    let Some(coalesce_key) = coalesce_key else {
        acquire_wfm_slot_interruptible(priority, label, || is_cancelled())?;
        let outcome = request_fn();
        if let Ok(response) = &outcome {
            record_wfm_response(response.status, response.retry_after, label);
        }
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
                }
            }

            if wait_for_existing {
                let (next_state, _) = condvar.wait_timeout(state, SCHEDULER_POLL_INTERVAL).unwrap();
                drop(next_state);
                continue;
            }
        }

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
        state
            .coalesced
            .insert(coalesce_key.clone(), CoalescedEntry::Ready(cached));
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
        let backoff = retry_after
            .unwrap_or(computed)
            .min(MAX_RATE_LIMIT_BACKOFF);
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
        high_queue_depth: state.queues[RequestPriority::High.index()].len(),
        medium_queue_depth: state.queues[RequestPriority::Medium.index()].len(),
        low_queue_depth: state.queues[RequestPriority::Low.index()].len(),
        recent_grants_in_window: state.recent_grants.len(),
        in_flight_coalesced_keys,
        cached_coalesced_keys,
        total_grants: state.total_grants,
        total_coalesced_hits: state.total_coalesced_hits,
        total_rate_limited_responses: state.total_rate_limited_responses,
        cooldown_remaining_ms,
    }
}

fn clone_cached_response(cached: &CachedResponse) -> Result<WfmHttpResponse> {
    cached
        .result
        .clone()
        .map_err(|error| anyhow!(error))
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
    for index in 0..PRIORITY_COUNT {
        let max_deficit = PRIORITY_QUANTA[index] * MAX_DEFICIT_MULTIPLIER;
        let updated = state.deficits[index] + PRIORITY_QUANTA[index];
        state.deficits[index] = updated.min(max_deficit);
    }
}

fn select_queue_index(state: &mut SchedulerState) -> Option<usize> {
    for _ in 0..PRIORITY_COUNT {
        let index = state.cursor;
        state.cursor = (state.cursor + 1) % PRIORITY_COUNT;
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

    let has_credit = state
        .queues
        .iter()
        .enumerate()
        .any(|(index, queue)| !queue.is_empty() && state.deficits[index] > 0);
    if !has_credit {
        replenish_deficits(state);
    }

    let index = select_queue_index(state).or_else(|| {
        replenish_deficits(state);
        select_queue_index(state)
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
