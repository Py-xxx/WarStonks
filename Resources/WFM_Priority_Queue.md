# WFM Priority Queue

This file documents the shared Warframe Market request scheduler used by WarStonks.

---

## Purpose

Every Warframe Market API request must go through the shared scheduler.

This is required because:
- Warframe Market enforces a rate limit (currently **3 requests per rolling second**).
- Multiple app features run concurrently (scanner, watchlist, trades, search).
- User-facing requests must stay responsive even while background work is active.
- Duplicate requests must be merged where possible instead of wasting slots.

The scheduler is the **single source of truth** for all WFM HTTP request pacing.

---

## Hard Rule

Any code that calls a `warframe.market` endpoint must go through the shared scheduler.

**Never:**
- Call `reqwest` directly for a WFM endpoint without going through the scheduler
- Create ad-hoc retry loops around WFM calls outside the scheduler
- Implement a separate per-feature rate limiter for WFM
- Bypass priority selection via front-end workarounds

**Always:**
- Use the shared scheduler helpers (documented below)
- Assign an explicit `RequestPriority`
- Provide a human-readable label
- Provide a coalescing key when the response can be shared across callers

---

## Implementation Files

| File | Role |
|---|---|
| `src-tauri/src/wfm_scheduler.rs` | Scheduler core — rate window, deficit queuing, coalescing |
| `src-tauri/src/market_observatory.rs` | All WFM calls for analytics, scanner, watchlist, orders |
| `src-tauri/src/trades.rs` | WFM calls for trade-related endpoints |

Frontend code does **not** call WFM directly. It invokes Tauri commands that already go through the scheduler.

---

## How To Add A New WFM Request — Step By Step

### 1. Ask: can local cache satisfy this?

Check the SQLite observatory DB first. If the data is fresh enough, return it without queuing anything. Network calls should be the fallback, not the default.

```rust
if statistics_cache_is_usable(&connection, item_id, variant_key, domain_key)? {
    return build_model_from_cache(&connection, item_id, variant_key);
}
// only fetch if the cache is missing or stale
```

### 2. Build the request builder (do not send yet)

Use `reqwest::blocking::Client` to build — but **do not call `.send()`**. The scheduler owns the send.

```rust
let client = wfm_http_client()?; // shared singleton from market_observatory.rs
let builder = client
    .get(format!("{WFM_API_BASE_URL_V1}/items/{slug}/orders"))
    .header("Language", WFM_LANGUAGE_HEADER)
    .header("Platform", WFM_PLATFORM_HEADER)
    .header("Crossplay", WFM_CROSSPLAY_HEADER);
```

### 3. Choose a priority

| Priority | When to use |
|---|---|
| `Instant` | User just clicked/searched and is waiting right now |
| `High` | Time-sensitive refresh the user will notice if delayed, but not click-path critical |
| `Medium` | Active panel refresh — visible, but a few hundred ms is acceptable |
| `Low` | Scanner work, bulk hydration, non-urgent analytical refreshes |
| `Background` | Maintenance-only — can wait behind almost anything |

```rust
use crate::wfm_scheduler::RequestPriority;

let priority = RequestPriority::Low; // scanner work
```

### 4. Choose a coalescing key

A coalescing key merges concurrent callers requesting the same resource into a single in-flight HTTP call. The second caller receives the same result as the first.

**Format:** `"<resource-type>:<priority-scope>:<slug-or-identifier>"`

The priority scope is embedded so that a `High` caller and a `Low` caller never share a key. This prevents a stale Background response from being served to a High caller that arrived later.

```rust
// Helper already exists in market_observatory.rs:
fn scoped_wfm_coalesce_key(prefix: &str, priority: RequestPriority, slug: &str) -> String

// Usage:
let coalesce_key = Some(scoped_wfm_coalesce_key("statistics", priority, slug));
// → "statistics:low:wisp_prime_set"

let coalesce_key = Some(scoped_wfm_coalesce_key("orders", priority, slug));
// → "orders:medium:arcane_energize"
```

Use `None` when the request is inherently unique (e.g. posting a new order, deleting an order, fetching the user's own mutable data that changes between calls).

### 5. Route through `execute_wfm_bytes_request`

This is the **standard call site** for all WFM HTTP requests in `market_observatory.rs`.
It wraps `execute_coalesced_wfm_request` from `wfm_scheduler.rs`.

```rust
let response = execute_wfm_bytes_request(
    builder,                    // reqwest::blocking::RequestBuilder, not yet sent
    priority,                   // RequestPriority
    "request WFM item orders",  // human-readable label for logs
    coalesce_key,               // Option<String>
    request_timeout,            // Option<Duration> — use Some(...) for scanner calls
    || is_cancelled(),          // FnMut() -> bool — cancellation check
)?;
```

`execute_wfm_bytes_request` does the following in order:
1. Calls `execute_coalesced_wfm_request` (scheduler core).
2. Checks the coalescing map — if another caller is already in-flight for this key, waits and shares the result.
3. Calls `acquire_wfm_slot_interruptible` — waits for a rate-limit slot at the correct priority.
4. Spawns the HTTP call on a thread (when a timeout is provided) and waits with `recv_timeout`.
5. Calls `record_wfm_response` to register the HTTP status code (triggers cooldown on 429).
6. Writes the result back to the coalescing map for any followers.

### 6. Check the response status and parse

```rust
if response.status < 200 || response.status >= 300 {
    return Err(extract_wfm_error_body("request WFM item orders", &response));
}
let parsed: MyResponseType = serde_json::from_slice(&response.body)?;
```

### 7. Write to the SQLite cache

Never hold parsed WFM data only in memory across request boundaries. Write it to the observatory DB so it is available for cache-hit paths and survives app restarts.

### 8. Handle the result at the call site

Callers must handle `Err` explicitly. Do not let WFM errors propagate silently.

```rust
match fetch_and_cache_statistics_impl(...) {
    Ok(_) => { /* proceed */ }
    Err(e) if statistics_cache_is_usable(...)? => {
        // stale cache is usable — degrade gracefully
    }
    Err(e) => return Err(e), // or record skip and continue
}
```

---

## Cancellable Requests (`is_cancelled`)

All long-running or queued requests accept an `is_cancelled: impl FnMut() -> bool` closure.
This is checked:
- While waiting for a scheduler slot (inside `acquire_wfm_slot_interruptible`)
- At the start of each coalescing loop iteration
- In scanner loops before and after each item

**For scanner work:**
```rust
let item_started = Instant::now();
get_or_build_scanner_price_model(
    ...,
    || {
        item_started.elapsed().as_secs() >= SCANNER_ITEM_TOTAL_DEADLINE_SECONDS
            || arbitrage_scanner_stop_requested(&connection).unwrap_or(false)
    },
)
```

**For non-cancellable callers:**
```rust
|| false
```

---

## Request Timeout

Always pass a `Some(Duration)` timeout for scanner and background requests. This is the deadline
on the raw HTTP call inside `run_wfm_request_with_timeout`.

```rust
// Scanner:
Some(Duration::from_secs(SCANNER_WFM_STATS_TIMEOUT_SECONDS)) // currently 5s

// Non-scanner analytics / watchlist:
Some(Duration::from_secs(WFM_DEFAULT_REQUEST_TIMEOUT_SECONDS)) // currently 20s

// User-facing instant path (rare — short timeout for snappy failure):
Some(Duration::from_secs(8))
```

Pass `None` only when you are certain the caller's thread has its own deadline or you explicitly
want the request to block as long as needed. The coalescing stale-eviction timer
(`COALESCED_IN_FLIGHT_TIMEOUT = 5s`) acts as a backstop, but timeout `None` means a dead leader
can hold a coalesced slot for the full 5 seconds before followers recover.

---

## Rate Limit Model

```
MAX_GRANTS_PER_WINDOW          = 3   (total per 1s rolling window)
MAX_NON_INSTANT_GRANTS_PER_WINDOW = 2   (reserved-slot rule when instant queue is non-empty)
RATE_LIMIT_WINDOW              = 1s
SCHEDULER_POLL_INTERVAL        = 5ms  (condvar timeout fallback)
BASE_RATE_LIMIT_BACKOFF        = 2s   (on first 429)
MAX_RATE_LIMIT_BACKOFF         = 15s  (exponential cap)
```

Reserved-capacity rule:
- When the **instant queue is non-empty**, normal priorities may only consume 2 of 3 slots per window. The 3rd is held for instant traffic.
- When the **instant queue is empty**, all 3 slots are available to normal priorities.

---

## Coalescing Model

```
COALESCED_IN_FLIGHT_TIMEOUT = 5s   (stale-leader eviction)
COALESCED_SUCCESS_TTL       = 1ms  (how long a Ready result is cached for followers)
COALESCED_ERROR_TTL         = 1ms
```

**Follower behaviour:** If a key is `InFlight`, the follower sleeps in 5ms increments until
the leader writes a `Ready` result. If the leader is gone (died, timed out) and the entry is
older than `COALESCED_IN_FLIGHT_TIMEOUT`, the follower evicts the stale entry and promotes
itself to leader — then retries the full request.

**Implication:** A request with `None` timeout can hold a coalescing slot for up to 30 seconds
(the reqwest client-level timeout). During that time any followers for the same key are blocked.
This is why scanner paths always use `Some(SCANNER_WFM_STATS_TIMEOUT_SECONDS)`.

---

## Priority Levels

### `Instant`

For requests that must feel immediate — user just interacted with the UI.

- Examples: search panel orders load, opening Trades tab, Market Analysis/Analytics open, direct profile load.
- Behaviour: dedicated queue lane, drains ahead of all normal work, may use all 3 grants per window.
- **Do not use for scanners or background work.**

### `High`

For important refreshes that are overdue and user-relevant, but not a direct click.

- Examples: trade history polling when stale, watchlist item past its high-priority threshold.

### `Medium`

For normal user-facing refreshes that are visible but not blocking first paint.

- Examples: active panel auto-refresh, watchlist items due for refresh.

### `Low`

For bulk work that matters but should yield to active user flows.

- Examples: arbitrage scanner, market cache hydration, scanner prefetch threads.

### `Background`

For the least urgent work — can wait behind almost anything.

- Examples: watchlist items refreshed recently and being maintained, prefetch threads for upcoming scanner items.

---

## Fairness Model (Deficit Weighted Queuing)

Non-instant priorities share slots using a weighted deficit counter:

```
PRIORITY_QUANTA:
  high       = 8
  medium     = 4
  low        = 2
  background = 1
```

Each time `try_grant` runs, it finds the queue with the most accumulated deficit credit and serves one ticket. After spending a quantum, the deficit for that priority decreases by 1. When all non-empty queues have zero credit, all deficits are replenished simultaneously.

This guarantees that over time:
- High gets 8x as many slots as Background
- Low gets 2x as many as Background
- No priority ever starves completely

---

## Scanner-Specific Rules

### Scanners must pipeline

A sequential scanner (fetch → wait → process → fetch → wait...) only ever occupies **1 of 3** rate-limit slots. The other 2 are wasted.

The arbitrage scanner uses a **prefetch lookahead** to keep all 3 slots occupied:

```rust
// Before blocking on item N, kick background prefetch threads for items N+1 and N+2.
for ahead in work_queue.iter().take(SCANNER_PREFETCH_LOOKAHEAD) {
    if let Some(ahead_item_id) = ahead.item_id {
        kick_prefetch(ahead_item_id, ahead.slug.clone());
    }
}
```

Each prefetch thread:
- Opens its own SQLite connection (WAL mode handles concurrent writes)
- Calls `ensure_statistics_cached_for_scan` at `Low` priority
- Stores the result to the SQLite cache
- Exits

When the main loop reaches item N+1, `statistics_cache_is_usable` returns true and no HTTP call is made. The rate-limit slot was already used by the prefetch thread.

**`SCANNER_PREFETCH_LOOKAHEAD = 2`** keeps exactly 3 total concurrent requests in flight at any time (1 main + 2 prefetch), saturating the 3 req/s window.

### Scanner item deadline

Each scanner item has a total wall-clock deadline to prevent a single slow item from stalling the whole scan:

```
SCANNER_ITEM_TOTAL_DEADLINE_SECONDS = 25s
```

This deadline is passed as the `is_cancelled` closure and checked at every scheduler wake-up:

```rust
let item_started = Instant::now();
get_or_build_scanner_price_model(
    ...,
    || item_started.elapsed().as_secs() >= SCANNER_ITEM_TOTAL_DEADLINE_SECONDS
        || arbitrage_scanner_stop_requested(&connection).unwrap_or(false),
)
```

If the deadline fires, the item is retried up to `SCANNER_ITEM_MAX_ATTEMPTS = 3` times, then skipped.

---

## Watchlist Scheduling

Watchlist refreshes use due-time scheduling, not fixed-interval polling.

Each tracked item has a `nextScanAt`. Priority escalates with staleness:

| Age | Priority |
|---|---|
| < 15s | `Background` |
| ≥ 15s | `Medium` |
| ≥ 30s | `High` |

The watchlist scanner picks only the next due item, refreshes it, then reschedules and picks the next. It does not batch-fire multiple parallel requests.

---

## Trade Tab Rules

Trade data must feel instant.

- `orders/my` loads → `Instant`
- Profile/session checks → `Instant`
- Duplicate loads must be coalesced: `Some(scoped_wfm_coalesce_key("orders", RequestPriority::Instant, "my"))`
- Switching Sell ↔ Buy tabs must not retrigger full blank-state reloads if data is available

---

## Labels Reference

| Subsystem | Example label |
|---|---|
| Orders (items) | `"request WFM item orders"` |
| Orders (own) | `"load own orders"` |
| Statistics | `"request WFM statistics"` |
| Watchlist | `"request WFM watchlist orders"` |
| Profile | `"request WFM profile"` |
| Trade history | `"request WFM trade history"` |

Labels appear in `queueDebug.jsonl` and stderr. Make them specific enough to identify the subsystem at a glance.

---

## Logging

| Log file | Contents |
|---|---|
| `<app-data>/log/queueDebug.jsonl` | One JSON line per scheduler event |
| `<app-data>/log/queueHealth.md` | Rolling summary (overwritten on each event) |

Useful events to grep for:
- `queued` — request entered the scheduler
- `granted` — slot was given; `waited_ms` shows how long it waited
- `resolved` — coalesced request finished; `total_ms` and `network_ms` available
- `coalesced-leader` — this caller is making the real HTTP call
- `coalesced-hit` — this caller reused an in-flight result
- `coalesced-stale-evicted` — dead leader was cleaned up, follower retries as leader
- `rate-limited` — WFM returned 429; `cooldown_remaining_ms` shows backoff length
- `cancelled` — caller was cancelled while waiting

Health report fields to watch:
- `avg wait ms` / `max wait ms` per priority — should be < 1000ms for Low
- `blocked by instant-queue` — how often normal work yielded for instant traffic
- `coalesced hits / leaders ratio` — higher is better (means callers are sharing results)
- `429 count over time` — if this grows, reduce request frequency or check coalescing gaps

---

## Checklist Before Merging A New WFM Call

- [ ] Request goes through `execute_wfm_bytes_request` (or `execute_coalesced_wfm_request` directly)
- [ ] `reqwest` builder is built but **not sent** before passing to the scheduler
- [ ] Priority is appropriate for the use case
- [ ] Coalescing key is set where the response can be shared
- [ ] `is_cancelled` closure is wired correctly (not hardcoded `|| false` for cancellable flows)
- [ ] A `Some(Duration)` timeout is passed for scanner and background requests
- [ ] Non-success HTTP status codes are handled explicitly
- [ ] Result is written to the SQLite cache for future cache-hit paths
- [ ] `queueDebug.jsonl` shows the request entering the queue at the correct priority
- [ ] The call does not introduce a duplicate request burst (check coalescing coverage)
- [ ] The feature degrades gracefully if the queue is busy or the API is slow

---

## Common Mistakes

| Mistake | Fix |
|---|---|
| Calling `.send()` on the `reqwest` builder directly | Pass the `builder` to `execute_wfm_bytes_request` instead |
| Forgetting `request_timeout` on scanner calls | Always pass `Some(Duration::from_secs(SCANNER_WFM_STATS_TIMEOUT_SECONDS))` |
| Using the same coalescing key for different priority levels | Use `scoped_wfm_coalesce_key` — it embeds the priority scope automatically |
| Triggering multiple identical requests from different UI layers | Add a coalescing key so they share a single in-flight request |
| Using `Instant` priority for scanner or background work | Scanner uses `Low`; maintenance uses `Background` |
| Creating a per-feature retry loop around WFM calls | The scheduler owns 429 backoff; callers should just propagate the error |
| Running a sequential scanner without prefetch | Use `SCANNER_PREFETCH_LOOKAHEAD` to keep all 3 slots occupied |
| Polling WFM on a fixed interval | Use due-time scheduling with `nextScanAt` like the watchlist does |

---

## Summary

WarStonks behaves as a single coordinated WFM client:

- **One scheduler** — `wfm_scheduler.rs`
- **One rate-limit policy** — 3/s rolling window, exponential 429 backoff
- **One logging path** — `queueDebug.jsonl` + `queueHealth.md`
- **Explicit priorities** — every caller declares its urgency
- **Coalescing by default** — duplicate in-flight requests share one HTTP call
- **No direct bypasses** — `reqwest` is never called for WFM endpoints outside the scheduler stack
