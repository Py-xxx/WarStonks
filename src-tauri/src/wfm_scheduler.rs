use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_GRANTS_PER_WINDOW: usize = 3;
const MAX_NON_INSTANT_GRANTS_PER_WINDOW: usize = 2;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
const NORMAL_PRIORITY_COUNT: usize = 4;
const PRIORITY_QUANTA: [i32; NORMAL_PRIORITY_COUNT] = [8, 4, 2, 1];
const MAX_DEFICIT_MULTIPLIER: i32 = 4;
const SCHEDULER_POLL_INTERVAL: Duration = Duration::from_millis(5);
const COALESCED_SUCCESS_TTL: Duration = Duration::from_millis(1);
const COALESCED_ERROR_TTL: Duration = Duration::from_millis(1);
const COALESCED_IN_FLIGHT_TIMEOUT: Duration = Duration::from_secs(5);
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
    fn metrics_index(self) -> usize {
        match self {
            Self::Instant => 0,
            Self::High => 1,
            Self::Medium => 2,
            Self::Low => 3,
            Self::Background => 4,
        }
    }

    fn normal_index(self) -> Option<usize> {
        match self {
            Self::Instant => None,
            Self::High => Some(0),
            Self::Medium => Some(1),
            Self::Low => Some(2),
            Self::Background => Some(3),
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

    fn lane(self) -> &'static str {
        match self {
            Self::Instant => "instant",
            Self::High | Self::Medium | Self::Low | Self::Background => "normal",
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
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct CachedResponse {
    result: std::result::Result<WfmHttpResponse, String>,
    expires_at: Instant,
}

#[derive(Debug, Clone, Default)]
struct QueueHealthPriorityMetrics {
    total_wait_ms: u64,
    wait_samples: u64,
    max_wait_ms: u64,
}

#[derive(Debug, Clone)]
enum CoalescedEntry {
    InFlight {
        started_at: Instant,
        generation: u64,
    },
    Ready(CachedResponse),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfmQueuedRequestSnapshot {
    pub id: u64,
    pub label: String,
    pub lane: String,
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

#[derive(Debug)]
struct SchedulerState {
    instant_queue: VecDeque<RequestTicket>,
    normal_queues: [VecDeque<RequestTicket>; NORMAL_PRIORITY_COUNT],
    deficits: [i32; NORMAL_PRIORITY_COUNT],
    cursor: usize,
    next_id: u64,
    recent_grants: VecDeque<Instant>,
    cooldown_until: Option<Instant>,
    rate_limit_streak: u32,
    coalesced: HashMap<String, CoalescedEntry>,
    total_grants: u64,
    total_coalesced_hits: u64,
    total_coalesced_leaders: u64,
    total_coalesced_stale_evictions: u64,
    total_rate_limited_responses: u64,
    priority_metrics: [QueueHealthPriorityMetrics; 5],
    blocked_by_instant_queue: u64,
    blocked_by_reserved_instant_slot: u64,
    next_coalesced_generation: u64,
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self {
            instant_queue: VecDeque::new(),
            normal_queues: [
                VecDeque::new(),
                VecDeque::new(),
                VecDeque::new(),
                VecDeque::new(),
            ],
            deficits: [0; NORMAL_PRIORITY_COUNT],
            cursor: 0,
            next_id: 1,
            recent_grants: VecDeque::new(),
            cooldown_until: None,
            rate_limit_streak: 0,
            coalesced: HashMap::new(),
            total_grants: 0,
            total_coalesced_hits: 0,
            total_coalesced_leaders: 0,
            total_coalesced_stale_evictions: 0,
            total_rate_limited_responses: 0,
            priority_metrics: std::array::from_fn(|_| QueueHealthPriorityMetrics::default()),
            blocked_by_instant_queue: 0,
            blocked_by_reserved_instant_slot: 0,
            next_coalesced_generation: 1,
        }
    }
}

fn scheduler_state() -> &'static (Mutex<SchedulerState>, Condvar) {
    static STATE: OnceLock<(Mutex<SchedulerState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(SchedulerState::default()), Condvar::new()))
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
    if let Some(index) = priority.normal_index() {
        state.normal_queues[index].push_back(ticket.clone());
    } else {
        state.instant_queue.push_back(ticket.clone());
    }
    log_scheduler_event(
        &mut state,
        Instant::now(),
        "queued",
        &ticket.label,
        ticket.priority,
        Some(ticket.id),
        None,
        None,
        false,
        None,
        None,
        None,
        None,
    );
    condvar.notify_all();
    let mut last_wait_reason: Option<&'static str> = None;

    loop {
        let now = Instant::now();
        prune_old_grants(&mut state, now);
        cleanup_expired_coalesced(&mut state, now);

        if is_cancelled() {
            remove_ticket(&mut state, priority, ticket_id);
            log_scheduler_event(
                &mut state,
                now,
                "cancelled",
                label,
                priority,
                Some(ticket_id),
                None,
                None,
                false,
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
            let reserved_instant_capacity = reserved_instant_capacity_in_use(&state);
            log_scheduler_event(
                &mut state,
                now,
                "granted",
                &granted_ticket.label,
                granted_ticket.priority,
                Some(granted_ticket.id),
                None,
                None,
                reserved_instant_capacity,
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

        let wait_reason = scheduler_wait_reason(&state, priority, now);
        if last_wait_reason != Some(wait_reason.reason) {
            log_scheduler_event(
                &mut state,
                now,
                "waiting",
                label,
                priority,
                Some(ticket_id),
                None,
                Some(wait_reason.reason.to_string()),
                wait_reason.reserved_instant_capacity,
                None,
                None,
                None,
                None,
            );
            last_wait_reason = Some(wait_reason.reason);
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
    request_timeout: Option<Duration>,
    mut is_cancelled: C,
    request_fn: F,
) -> Result<WfmHttpResponse>
where
    C: FnMut() -> bool,
    F: FnOnce() -> Result<WfmHttpResponse> + Send + 'static,
{
    let total_started_at = Instant::now();
    let Some(coalesce_key) = coalesce_key else {
        acquire_wfm_slot_interruptible(priority, label, || is_cancelled())?;
        let request_started_at = Instant::now();
        let outcome = run_wfm_request_with_timeout(label, request_timeout, request_fn);
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
    let mut leader_generation: Option<u64> = None;
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

            if let Some(stale_generation) = stale_in_flight_generation(&state, &coalesce_key, now) {
                state.coalesced.remove(&coalesce_key);
                state.total_coalesced_stale_evictions =
                    state.total_coalesced_stale_evictions.saturating_add(1);
                log_scheduler_event(
                    &mut state,
                    now,
                    "coalesced-stale-evicted",
                    label,
                    priority,
                    None,
                    Some(coalesce_key.clone()),
                    Some(format!("stale-generation:{stale_generation}")),
                    false,
                    None,
                    None,
                    None,
                    None,
                );
                condvar.notify_all();
            }

            match state.coalesced.get(&coalesce_key) {
                Some(CoalescedEntry::Ready(cached)) => {
                    let cached_response = clone_cached_response(cached);
                    state.total_coalesced_hits = state.total_coalesced_hits.saturating_add(1);
                    log_scheduler_event(
                        &mut state,
                        now,
                        "coalesced-hit",
                        label,
                        priority,
                        None,
                        Some(coalesce_key.clone()),
                        None,
                        false,
                        None,
                        Some(total_started_at.elapsed().as_millis() as u64),
                        Some(0),
                        cached_response
                            .as_ref()
                            .ok()
                            .map(|response| response.status),
                    );
                    condvar.notify_all();
                    return cached_response;
                }
                Some(CoalescedEntry::InFlight { .. }) => {
                    wait_for_existing = true;
                }
                None => {
                    let generation = state.next_coalesced_generation;
                    state.next_coalesced_generation =
                        state.next_coalesced_generation.wrapping_add(1);
                    state.coalesced.insert(
                        coalesce_key.clone(),
                        CoalescedEntry::InFlight {
                            started_at: now,
                            generation,
                        },
                    );
                    leader_generation = Some(generation);
                    log_scheduler_event(
                        &mut state,
                        now,
                        "coalesced-leader",
                        label,
                        priority,
                        None,
                        Some(coalesce_key.clone()),
                        Some(format!("generation:{generation}")),
                        false,
                        None,
                        None,
                        None,
                        None,
                    );
                }
            }

            if wait_for_existing {
                log_scheduler_event(
                    &mut state,
                    now,
                    "waiting",
                    label,
                    priority,
                    None,
                    Some(coalesce_key.clone()),
                    Some("coalesced".to_string()),
                    false,
                    None,
                    None,
                    None,
                    None,
                );
                let (next_state, _) = condvar
                    .wait_timeout(state, SCHEDULER_POLL_INTERVAL)
                    .unwrap();
                drop(next_state);
                continue;
            }
        }

        let request_started_at = Instant::now();
        let outcome = (|| {
            acquire_wfm_slot_interruptible(priority, label, || is_cancelled())?;
            run_wfm_request_with_timeout(
                label,
                request_timeout,
                request_fn
                    .take()
                    .expect("coalesced WFM request already executed"),
            )
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
        let still_own_leader = matches!(
            state.coalesced.get(&coalesce_key),
            Some(CoalescedEntry::InFlight { generation, .. })
                if Some(*generation) == leader_generation
        );
        if still_own_leader {
            if cached.expires_at > Instant::now() {
                state
                    .coalesced
                    .insert(coalesce_key.clone(), CoalescedEntry::Ready(cached));
            } else {
                state.coalesced.remove(&coalesce_key);
            }
        }
        let reserved_instant_capacity = reserved_instant_capacity_in_use(&state);
        log_scheduler_event(
            &mut state,
            Instant::now(),
            "resolved",
            label,
            priority,
            None,
            Some(coalesce_key.clone()),
            None,
            reserved_instant_capacity,
            None,
            Some(total_started_at.elapsed().as_millis() as u64),
            Some(request_started_at.elapsed().as_millis() as u64),
            outcome.as_ref().ok().map(|response| response.status),
        );
        condvar.notify_all();
        return outcome;
    }
}

fn run_wfm_request_with_timeout<F>(
    label: &str,
    request_timeout: Option<Duration>,
    request_fn: F,
) -> Result<WfmHttpResponse>
where
    F: FnOnce() -> Result<WfmHttpResponse> + Send + 'static,
{
    let Some(timeout) = request_timeout else {
        return request_fn();
    };

    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = sender.send(request_fn());
    });

    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(anyhow!(
            "{label} timed out after {} ms",
            timeout.as_millis()
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(anyhow!("{label} failed before returning a response"))
        }
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
            &mut state,
            now,
            "rate-limited",
            label,
            RequestPriority::High,
            None,
            None,
            Some("cooldown".to_string()),
            false,
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

fn stale_in_flight_generation(
    state: &SchedulerState,
    coalesce_key: &str,
    now: Instant,
) -> Option<u64> {
    match state.coalesced.get(coalesce_key) {
        Some(CoalescedEntry::InFlight {
            started_at,
            generation,
        }) if now.saturating_duration_since(*started_at) >= COALESCED_IN_FLIGHT_TIMEOUT => {
            Some(*generation)
        }
        _ => None,
    }
}

struct SchedulerWaitReason {
    reason: &'static str,
    reserved_instant_capacity: bool,
}

fn update_priority_wait_metrics(
    state: &mut SchedulerState,
    priority: RequestPriority,
    waited_ms: u64,
) {
    let metrics = &mut state.priority_metrics[priority.metrics_index()];
    metrics.total_wait_ms = metrics.total_wait_ms.saturating_add(waited_ms);
    metrics.wait_samples = metrics.wait_samples.saturating_add(1);
    metrics.max_wait_ms = metrics.max_wait_ms.max(waited_ms);
}

fn cleanup_expired_coalesced(state: &mut SchedulerState, now: Instant) {
    state.coalesced.retain(|_, entry| match entry {
        CoalescedEntry::InFlight { .. } => true,
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

fn scheduler_available_for_priority(
    state: &SchedulerState,
    now: Instant,
    priority: RequestPriority,
) -> bool {
    let cooldown_ready = state
        .cooldown_until
        .map(|instant| instant <= now)
        .unwrap_or(true);
    if !cooldown_ready {
        return false;
    }

    let grant_limit = match priority {
        RequestPriority::Instant => MAX_GRANTS_PER_WINDOW,
        RequestPriority::High
        | RequestPriority::Medium
        | RequestPriority::Low
        | RequestPriority::Background => MAX_NON_INSTANT_GRANTS_PER_WINDOW,
    };

    state.recent_grants.len() < grant_limit
}

fn reserved_instant_capacity_in_use(state: &SchedulerState) -> bool {
    !state.instant_queue.is_empty()
        && state.recent_grants.len() >= MAX_NON_INSTANT_GRANTS_PER_WINDOW
        && state.recent_grants.len() < MAX_GRANTS_PER_WINDOW
}

fn scheduler_wait_reason(
    state: &SchedulerState,
    priority: RequestPriority,
    now: Instant,
) -> SchedulerWaitReason {
    if state
        .cooldown_until
        .map(|instant| instant > now)
        .unwrap_or(false)
    {
        return SchedulerWaitReason {
            reason: "cooldown",
            reserved_instant_capacity: false,
        };
    }

    if priority != RequestPriority::Instant && !state.instant_queue.is_empty() {
        return SchedulerWaitReason {
            reason: "instant-queue",
            reserved_instant_capacity: reserved_instant_capacity_in_use(state),
        };
    }

    // When instant queue is empty, normal work may use all 3 slots.
    let grant_limit = match priority {
        RequestPriority::Instant => MAX_GRANTS_PER_WINDOW,
        _ => {
            if state.instant_queue.is_empty() {
                MAX_GRANTS_PER_WINDOW
            } else {
                MAX_NON_INSTANT_GRANTS_PER_WINDOW
            }
        }
    };

    if state.recent_grants.len() >= grant_limit {
        let reason = if priority == RequestPriority::Instant {
            "rate-window"
        } else if reserved_instant_capacity_in_use(state) {
            "reserved-instant-slot"
        } else {
            "rate-window"
        };
        return SchedulerWaitReason {
            reason,
            reserved_instant_capacity: reserved_instant_capacity_in_use(state),
        };
    }

    SchedulerWaitReason {
        reason: "normal-queue",
        reserved_instant_capacity: false,
    }
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
    for index in 0..NORMAL_PRIORITY_COUNT {
        let max_deficit = PRIORITY_QUANTA[index] * MAX_DEFICIT_MULTIPLIER;
        let updated = state.deficits[index] + PRIORITY_QUANTA[index];
        state.deficits[index] = updated.min(max_deficit);
    }
}

fn select_weighted_queue_index(state: &mut SchedulerState) -> Option<usize> {
    for _ in 0..NORMAL_PRIORITY_COUNT {
        let index = state.cursor;
        state.cursor += 1;
        if state.cursor >= NORMAL_PRIORITY_COUNT {
            state.cursor = 0;
        }

        if !state.normal_queues[index].is_empty() && state.deficits[index] > 0 {
            return Some(index);
        }
    }
    None
}

fn try_grant(state: &mut SchedulerState, now: Instant) -> Option<RequestTicket> {
    if state.instant_queue.is_empty() && state.normal_queues.iter().all(|queue| queue.is_empty()) {
        return None;
    }

    if scheduler_available_for_priority(state, now, RequestPriority::Instant) {
        if let Some(ticket) = state.instant_queue.pop_front() {
            state.recent_grants.push_back(now);
            state.total_grants = state.total_grants.saturating_add(1);
            return Some(ticket);
        }
    } else {
        return None;
    }

    if !state.instant_queue.is_empty() {
        return None;
    }

    // Reserve the 3rd slot for instant traffic only when instant work is actually pending.
    // When instant queue is empty, normal work may use all 3 slots.
    let normal_grant_limit = if state.instant_queue.is_empty() {
        MAX_GRANTS_PER_WINDOW
    } else {
        MAX_NON_INSTANT_GRANTS_PER_WINDOW
    };
    if state.recent_grants.len() >= normal_grant_limit {
        return None;
    }

    let has_credit = state
        .normal_queues
        .iter()
        .enumerate()
        .any(|(index, queue)| !queue.is_empty() && state.deficits[index] > 0);
    if !has_credit {
        replenish_deficits(state);
    }

    let index = select_weighted_queue_index(state).or_else(|| {
        replenish_deficits(state);
        select_weighted_queue_index(state)
    })?;

    let ticket = state.normal_queues[index].pop_front()?;
    state.deficits[index] = state.deficits[index].saturating_sub(1);
    state.recent_grants.push_back(now);
    state.total_grants = state.total_grants.saturating_add(1);
    Some(ticket)
}

fn remove_ticket(state: &mut SchedulerState, priority: RequestPriority, ticket_id: u64) {
    let queue = if let Some(index) = priority.normal_index() {
        &mut state.normal_queues[index]
    } else {
        &mut state.instant_queue
    };

    if let Some(position) = queue.iter().position(|ticket| ticket.id == ticket_id) {
        queue.remove(position);
    }
}

fn build_snapshot(state: &SchedulerState, now: Instant) -> WfmSchedulerSnapshot {
    let in_flight_coalesced_keys = state
        .coalesced
        .values()
        .filter(|entry| matches!(entry, CoalescedEntry::InFlight { .. }))
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
        instant_queue_depth: state.instant_queue.len(),
        high_queue_depth: state.normal_queues[RequestPriority::High.normal_index().unwrap()].len(),
        medium_queue_depth: state.normal_queues[RequestPriority::Medium.normal_index().unwrap()]
            .len(),
        low_queue_depth: state.normal_queues[RequestPriority::Low.normal_index().unwrap()].len(),
        background_queue_depth: state.normal_queues
            [RequestPriority::Background.normal_index().unwrap()]
        .len(),
        recent_grants_in_window: state.recent_grants.len(),
        in_flight_coalesced_keys,
        cached_coalesced_keys,
        total_grants: state.total_grants,
        total_coalesced_hits: state.total_coalesced_hits,
        total_rate_limited_responses: state.total_rate_limited_responses,
        cooldown_remaining_ms,
        queued_requests: state
            .instant_queue
            .iter()
            .chain(state.normal_queues.iter().flat_map(|queue| queue.iter()))
            .map(|ticket| WfmQueuedRequestSnapshot {
                id: ticket.id,
                label: ticket.label.clone(),
                lane: ticket.priority.lane().to_string(),
                priority: ticket.priority.as_str().to_string(),
                queued_ms: now
                    .saturating_duration_since(ticket.enqueued_at)
                    .as_millis() as u64,
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
    let mut state = lock.lock().expect("wfm scheduler lock poisoned");
    let reserved_instant_capacity = reserved_instant_capacity_in_use(&state);
    log_scheduler_event(
        &mut state,
        Instant::now(),
        "request-finished",
        label,
        priority,
        None,
        coalesce_key,
        None,
        reserved_instant_capacity,
        None,
        Some(total_started_at.elapsed().as_millis() as u64),
        Some(request_started_at.elapsed().as_millis() as u64),
        status,
    );
}

#[allow(clippy::too_many_arguments)]
fn log_scheduler_event(
    state: &mut SchedulerState,
    _now: Instant,
    event: &str,
    _request_label: &str,
    request_priority: RequestPriority,
    _ticket_id: Option<u64>,
    _coalesce_key: Option<String>,
    blocked_reason: Option<String>,
    _reserved_instant_capacity: bool,
    waited_ms: Option<u64>,
    _total_ms: Option<u64>,
    _network_ms: Option<u64>,
    _status: Option<u16>,
) {
    if let Some(waited_ms) = waited_ms {
        if event == "granted" {
            update_priority_wait_metrics(state, request_priority, waited_ms);
        }
    }

    if event == "coalesced-leader" {
        state.total_coalesced_leaders = state.total_coalesced_leaders.saturating_add(1);
    }

    if event == "waiting" {
        match blocked_reason.as_deref() {
            Some("instant-queue") => {
                state.blocked_by_instant_queue = state.blocked_by_instant_queue.saturating_add(1);
            }
            Some("reserved-instant-slot") => {
                state.blocked_by_reserved_instant_slot =
                    state.blocked_by_reserved_instant_slot.saturating_add(1);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        stale_in_flight_generation, try_grant, CoalescedEntry, RequestPriority, RequestTicket,
        SchedulerState, COALESCED_IN_FLIGHT_TIMEOUT, RATE_LIMIT_WINDOW,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn instant_priority_jumps_the_queue() {
        let now = Instant::now();
        let mut state = SchedulerState::default();
        state.normal_queues[RequestPriority::Low.normal_index().unwrap()].push_back(
            RequestTicket {
                id: 1,
                label: "scanner".to_string(),
                enqueued_at: now,
                priority: RequestPriority::Low,
            },
        );
        state.instant_queue.push_back(RequestTicket {
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

    #[test]
    fn low_priority_cannot_consume_reserved_instant_slot() {
        // With 2 recent grants and an instant item pending, the 3rd slot is reserved.
        // try_grant should service the instant item, not the low-priority item.
        let now = Instant::now();
        let mut state = SchedulerState::default();
        state
            .recent_grants
            .push_back(now - Duration::from_millis(200));
        state
            .recent_grants
            .push_back(now - Duration::from_millis(100));
        state.normal_queues[RequestPriority::Low.normal_index().unwrap()].push_back(
            RequestTicket {
                id: 1,
                label: "scanner".to_string(),
                enqueued_at: now,
                priority: RequestPriority::Low,
            },
        );
        // instant queue has a pending item, so the 3rd slot is reserved for it
        state.instant_queue.push_back(RequestTicket {
            id: 2,
            label: "analysis".to_string(),
            enqueued_at: now,
            priority: RequestPriority::Instant,
        });

        let granted = try_grant(&mut state, now).expect("expected instant ticket on reserved slot");
        assert_eq!(granted.priority, RequestPriority::Instant);
        assert_eq!(
            state.normal_queues[RequestPriority::Low.normal_index().unwrap()].len(),
            1,
            "low-priority item must remain queued"
        );
    }

    #[test]
    fn normal_priority_can_use_third_slot_when_instant_queue_is_empty() {
        let now = Instant::now();
        let mut state = SchedulerState::default();
        state
            .recent_grants
            .push_back(now - Duration::from_millis(200));
        state
            .recent_grants
            .push_back(now - Duration::from_millis(100));
        state.normal_queues[RequestPriority::Low.normal_index().unwrap()].push_back(
            RequestTicket {
                id: 1,
                label: "scanner".to_string(),
                enqueued_at: now,
                priority: RequestPriority::Low,
            },
        );
        // instant queue is empty, so scanner can use the 3rd slot
        let granted = try_grant(&mut state, now).expect("expected low ticket via 3rd slot");
        assert_eq!(granted.priority, RequestPriority::Low);
        assert_eq!(state.recent_grants.len(), 3);
    }

    #[test]
    fn instant_priority_can_use_reserved_slot_after_two_recent_grants() {
        let now = Instant::now();
        let mut state = SchedulerState::default();
        state
            .recent_grants
            .push_back(now - Duration::from_millis(200));
        state
            .recent_grants
            .push_back(now - Duration::from_millis(100));
        state.instant_queue.push_back(RequestTicket {
            id: 1,
            label: "analysis".to_string(),
            enqueued_at: now,
            priority: RequestPriority::Instant,
        });

        let granted = try_grant(&mut state, now).expect("expected instant ticket");
        assert_eq!(granted.priority, RequestPriority::Instant);
        assert_eq!(state.recent_grants.len(), 3);
    }

    #[test]
    fn low_priority_can_resume_after_window_expires() {
        let now = Instant::now();
        let mut state = SchedulerState::default();
        state
            .recent_grants
            .push_back(now - RATE_LIMIT_WINDOW - Duration::from_millis(10));
        state
            .recent_grants
            .push_back(now - Duration::from_millis(100));
        state.normal_queues[RequestPriority::Low.normal_index().unwrap()].push_back(
            RequestTicket {
                id: 1,
                label: "scanner".to_string(),
                enqueued_at: now,
                priority: RequestPriority::Low,
            },
        );

        let granted = try_grant(&mut state, now).expect("expected low ticket");
        assert_eq!(granted.priority, RequestPriority::Low);
    }

    #[test]
    fn detects_stale_in_flight_coalesced_entries() {
        let now = Instant::now();
        let mut state = SchedulerState::default();
        state.coalesced.insert(
            "statistics:instant:wisp_prime_set".to_string(),
            CoalescedEntry::InFlight {
                started_at: now - COALESCED_IN_FLIGHT_TIMEOUT - Duration::from_millis(1),
                generation: 7,
            },
        );

        assert_eq!(
            stale_in_flight_generation(&state, "statistics:instant:wisp_prime_set", now),
            Some(7)
        );
    }
}
