use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_GRANTS_PER_WINDOW: usize = 3;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
const PRIORITY_COUNT: usize = 3;
const PRIORITY_QUANTA: [i32; PRIORITY_COUNT] = [3, 2, 1];
const MAX_DEFICIT_MULTIPLIER: i32 = 3;

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
}

#[derive(Debug, Clone)]
struct RequestTicket {
    id: u64,
    priority: RequestPriority,
    #[allow(dead_code)]
    label: String,
    #[allow(dead_code)]
    enqueued_at: Instant,
}

#[derive(Debug)]
struct SchedulerState {
    queues: [VecDeque<RequestTicket>; PRIORITY_COUNT],
    deficits: [i32; PRIORITY_COUNT],
    cursor: usize,
    next_id: u64,
    recent_grants: VecDeque<Instant>,
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self {
            queues: [VecDeque::new(), VecDeque::new(), VecDeque::new()],
            deficits: [0; PRIORITY_COUNT],
            cursor: 0,
            next_id: 1,
            recent_grants: VecDeque::new(),
        }
    }
}

fn scheduler_state() -> &'static (Mutex<SchedulerState>, Condvar) {
    static STATE: OnceLock<(Mutex<SchedulerState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(SchedulerState::default()), Condvar::new()))
}

pub fn acquire_wfm_slot(priority: RequestPriority, label: &str) {
    let (lock, condvar) = scheduler_state();
    let mut state = lock.lock().expect("wfm scheduler lock poisoned");
    let ticket_id = state.next_id;
    state.next_id = state.next_id.wrapping_add(1);
    let ticket = RequestTicket {
        id: ticket_id,
        priority,
        label: label.to_string(),
        enqueued_at: Instant::now(),
    };
    state.queues[priority.index()].push_back(ticket);

    loop {
        let now = Instant::now();
        prune_old_grants(&mut state, now);

        if let Some(granted_id) = try_grant(&mut state, now) {
            condvar.notify_all();
            if granted_id == ticket_id {
                return;
            }
        }

        if let Some(wait_for) = next_wait_duration(&state, now) {
            let (next_state, _) = condvar.wait_timeout(state, wait_for).unwrap();
            state = next_state;
        } else {
            state = condvar.wait(state).unwrap();
        }
    }
}

fn prune_old_grants(state: &mut SchedulerState, now: Instant) {
    while let Some(front) = state.recent_grants.front() {
        if now.duration_since(*front) >= RATE_LIMIT_WINDOW {
            state.recent_grants.pop_front();
        } else {
            break;
        }
    }
}

fn rate_available(state: &SchedulerState) -> bool {
    state.recent_grants.len() < MAX_GRANTS_PER_WINDOW
}

fn next_wait_duration(state: &SchedulerState, now: Instant) -> Option<Duration> {
    if rate_available(state) {
        return None;
    }
    state
        .recent_grants
        .front()
        .map(|oldest| {
            let elapsed = now.duration_since(*oldest);
            if elapsed >= RATE_LIMIT_WINDOW {
                Duration::from_millis(0)
            } else {
                RATE_LIMIT_WINDOW - elapsed
            }
        })
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

fn try_grant(state: &mut SchedulerState, now: Instant) -> Option<u64> {
    if state.queues.iter().all(|queue| queue.is_empty()) {
        return None;
    }

    if !rate_available(state) {
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
    Some(ticket.id)
}
