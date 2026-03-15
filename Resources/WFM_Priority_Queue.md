# WFM Priority Queue

This file documents the shared Warframe Market request scheduler used by WarStonks.

## Purpose

Every Warframe Market API request must go through the shared scheduler.

This is required because:
- Warframe Market is rate limited.
- Multiple app features run concurrently.
- User-facing requests must stay responsive even while background work is active.
- Duplicate requests should be merged where possible instead of wasting request slots.

This scheduler is the single source of truth for WFM HTTP request pacing.

## Hard Rule

Any WFM API request must be placed into the shared queue.

Never:
- call `reqwest` directly for a WFM endpoint without scheduler access
- create ad-hoc retry loops around WFM calls outside the scheduler
- implement separate per-feature rate limiters for WFM
- bypass queue priority selection in frontend or backend code

Always:
- use the shared scheduler utilities
- assign an explicit priority
- provide a clear request label
- provide a coalescing key when the request can be shared

## Current Implementation

Primary implementation:
- [/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/src-tauri/src/wfm_scheduler.rs](/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/src-tauri/src/wfm_scheduler.rs)

Common WFM request entry points:
- [/Users/nathan/Documents/VSCodeProjects/WarStonks/WarStonks/src-tauri/src/trades.rs](/Users/nathan/Documents/VSCodeProjects/WarStonks/WarStonks/src-tauri/src/trades.rs)
- [/Users/nathan/Documents/VSCodeProjects/WarStonks/WarStonks/src-tauri/src/market_observatory.rs](/Users/nathan/Documents/VSCodeProjects/WarStonks/WarStonks/src-tauri/src/market_observatory.rs)
- [/Users/nathan/Documents/VSCodeProjects/WarStonks/WarStonks/src-tauri/src/commands/mod.rs](/Users/nathan/Documents/VSCodeProjects/WarStonks/WarStonks/src-tauri/src/commands/mod.rs)

Frontend callers should route through Tauri commands that already use the scheduler.

## Rate Limit Model

Current global limit:
- `3` granted requests per rolling `1` second window

Current scheduler behavior:
- tracks recent grants in a rolling window
- uses a dedicated `instant` lane plus a normal weighted scheduler
- pauses grants if the window is full
- reserves one slot for `instant` traffic
- applies cooldown backoff after WFM rate-limit responses
- logs queue state for debugging

Current cooldown constants:
- base backoff: `2s`
- max backoff: `15s`

## Priority Levels

Current priorities:
- `instant`
- `high`
- `medium`
- `low`
- `background`

### Instant

Use for requests that must feel immediate to the user.

Examples:
- search result market loads
- opening Trades tab
- opening Market Analysis
- opening Market Analytics
- direct trade account/profile loads

Behavior:
- has a dedicated queue lane
- drains ahead of all normal work
- may use all 3 grants in the rolling window
- should be used sparingly

### High

Use for important refreshes that are overdue and user-relevant, but not quite instant.

Examples:
- trade history polling
- watchlist items that have become stale past their high-priority threshold

### Medium

Use for normal user-facing requests that are important but not urgent.

Examples:
- active panel refreshes
- watchlist items that are due but not critically stale

### Low

Use for bulk work that matters, but can yield to active user flows.

Examples:
- scanners
- market cache hydration
- non-urgent analytical refreshes

### Background

Use for the least urgent WFM work.

Examples:
- watchlist items that were refreshed recently and are only being maintained

## Fairness Model

Non-instant priorities use weighted fairness with queue deficits.

Current quanta:
- `high = 8`
- `medium = 4`
- `low = 2`
- `background = 1`

Meaning:
- high gets the most turns
- background gets the fewest
- lower priorities still continue to get served

This prevents starvation for long-running scanner or watchlist work.

Reserved-capacity rule:
- normal traffic may only consume 2 grants in the rolling window
- the 3rd slot is reserved for `instant` traffic
- this prevents scanners/watchlist/pollers from filling the whole window before a user action arrives

## Coalescing

Coalescing is required whenever multiple callers may request the same WFM resource at nearly the same time.

Use coalescing for:
- profile fetches
- `orders/my`
- item orders for the same slug
- item statistics for the same slug
- trade history for the same account

Good coalescing key examples:
- `profile:me`
- `orders:my`
- `orders:arcane_energize`
- `statistics:arcane_energize`
- `trade-history:https://api.warframe.market/v1/profile/<name>/statistics`

Rules:
- same resource + same logical response = same coalescing key
- different response shapes or filters = different keys
- if a result is safe to share, coalesce it

## Labels

Every queued WFM request should use a human-readable label.

Good labels:
- `request WFM profile`
- `load own orders`
- `request WFM watchlist orders`
- `request WFM statistics`
- `request WFM item orders`

Labels should describe:
- what is being requested
- which subsystem it belongs to when useful

Labels are used in:
- queue debug logs
- wait diagnostics
- rate-limit debugging

## Watchlist Scheduling

Watchlist refreshes are not supposed to spam continuously.

Current intended behavior:
- each watchlist item has its own `nextScanAt`
- once refreshed, it is rescheduled by updating `nextScanAt`
- the watchlist scanner picks the next due item only
- after a refresh completes, the scanner schedules the next due item again

Priority escalation for watchlist items:
- age under `15s` -> `background`
- age `15s` or more -> `medium`
- age `30s` or more -> `high`

This means:
- scanners can keep working
- watchlist items move up only when stale enough

## Trade Tab Requirements

Trades must always feel immediate.

Required behavior:
- profile/session checks must use `instant`
- `orders/my` loads must use `instant`
- duplicate profile and overview loads must be coalesced or deduplicated
- switching between Sell and Buy tabs must not create a new blank-state loading cycle unless data is genuinely unavailable

## Search / Market Requirements

Search and Market tabs are user-triggered and must not sit behind background work.

Required behavior:
- quick-view item order loads: `instant`
- Market Analysis live work: `instant`
- Market Analytics live work: `instant`

If extra work is derived from those loads:
- prefer local cache / SQLite data where possible
- do not recursively trigger large numbers of new live WFM calls inside an instant path

## Scanner Requirements

Scanners must be queue-friendly.

Required behavior:
- scanner traffic should use `low` unless there is a specific reason otherwise
- scanners must tolerate waiting
- scanners must reuse cached/statistical models whenever possible
- scanners must not use instant priority

If a scanner can reuse:
- cached statistics
- cached set map data
- cached observatory snapshots

it should do so instead of forcing new live calls.

## Retry / Backoff Rules

The scheduler owns WFM retry pressure management.

Required behavior:
- rate-limit responses should be recorded centrally
- cooldown/backoff should happen in the scheduler
- individual callers should not each invent their own retry timing

Callers may still:
- surface errors to the UI
- reschedule future work logically

Callers must not:
- create independent high-frequency retry loops against WFM

## Logging

Queue debug log path:
- app data `/log/queueDebug.jsonl`
- app data `/log/queueHealth.md`

The log should be used to verify:
- a request entered the queue
- its priority was correct
- it waited too long or not
- duplicate calls are being coalesced correctly
- instant traffic is not being drowned by lower-priority work

Useful events include:
- `queued`
- `granted`
- `resolved`
- `coalesced-leader`
- `coalesced-hit`
- `rate-limited`

Queue health report should summarize:
- average wait time by priority
- max wait time by priority
- blocked-by-instant-queue count
- blocked-by-reserved-instant-slot count
- coalesced hits vs leaders
- 429 count over time

## How To Add A New WFM Request

1. Decide whether the request is truly necessary.
2. Decide whether local cache/database data can satisfy it first.
3. Pick the correct priority.
4. Choose a stable request label.
5. Add a coalescing key if the response can be shared.
6. Route the request through the shared scheduler utility.
7. Make sure the caller handles failure explicitly.
8. Verify the request appears correctly in `queueDebug.jsonl`.

## Priority Selection Guide

Use `instant` when:
- the user just clicked/opened/searched and expects an immediate answer

Use `high` when:
- the request is time-sensitive and overdue, but not direct click-path critical
- startup WFM catalog fetch is required during bootstrap

Use `medium` when:
- it supports an active screen but is not blocking first paint

Use `low` when:
- it is background work that still matters

Use `background` when:
- it is maintenance work that can wait behind almost anything else

## Common Mistakes To Avoid

- Triggering multiple identical WFM requests from different UI layers
- Using live WFM calls inside loops when cached local data already exists
- Leaving a user-facing panel dependent on a background-only request
- Forgetting to add a descriptive request label
- Forgetting to add a coalescing key
- Using `instant` for scanners or other bulk work
- Polling WFM on a fixed interval when a due-time scheduler is more appropriate

## Review Checklist

Before merging any WFM integration change, verify:
- the request goes through the shared scheduler
- the priority is appropriate
- coalescing is used when possible
- labels are clear
- logs show the request correctly
- the call does not introduce duplicate queue bursts
- the feature still behaves correctly under queue delay

## Summary

WarStonks must behave like a single coordinated WFM client.

That means:
- one scheduler
- one rate-limit policy
- one logging path
- explicit priorities
- coalescing by default where safe
- no direct WFM bypasses
