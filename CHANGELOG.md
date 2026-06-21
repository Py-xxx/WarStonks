# Changelog

All notable changes since the `3.0.5-Fix` release (`eb3c3b7`).

## Unreleased

### Trade authentication & sessions

- **Secrets moved to the OS keychain.** WFM credentials and the session JWT are now
  stored in the OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret
  Service) instead of cleartext JSON files. Any legacy `wfm-session.json` /
  `wfm-credentials.json` files are deleted on startup.
- **In-memory session cache.** The active session is held in memory and trusted for
  high-frequency internal calls, so the app no longer makes a `/me` validation request on
  every operation. Re-authentication is triggered on a real `401` instead.
- **Automatic re-login on expiry.** Opening the Trades tab (and startup auto-sign-in) now
  validates the session with a live `/me` call and, if it has expired, silently
  re-authenticates from saved credentials — so a normal session expiry no longer shows a
  stuck "logged out" state when "remember me" is enabled.
- **Retry with backoff on re-auth.** Automatic re-authentication now retries transient
  failures (network blips, timeouts, rate limiting, `5xx`) up to 3 times with exponential
  backoff. Permanent failures (wrong/changed password — `400/401/403`) return immediately
  and never hammer the login endpoint.
- Only a manual **Disconnect** clears the saved credentials.
- **Persistent presence connection.** While you're signed in, the app now holds a single
  long-lived background WebSocket to Warframe.Market — the same thing a browser tab does —
  for the whole time the app is open. This keeps your session alive and holds your
  online/ingame status instead of WFM dropping you offline shortly after it's set. The
  connection reconnects automatically (including after a session re-auth), re-applies your
  chosen status, and persists your choice across app restarts. Choosing "invisible" keeps
  the connection (so you stay logged in) while appearing offline; only signing out releases
  it. This removes the need to keep a warframe.market browser tab open, and — because an
  active connection keeps the WFM session alive — should also reduce how often the session
  expires and signs you out.

### Fixes

- **Trade history failed to parse.** WFM changed the `platinum` field in the v1 profile
  statistics response from an integer to a float (e.g. `30` → `30.0`), which broke parsing
  with "failed to parse WFM trade history response". Numeric trade fields (`platinum`,
  `quantity`, `mod_rank`) now accept both integer and float encodings. The same tolerance
  was applied defensively to the live-orders parse.
- **Windows unresponsiveness after long periods tabbed out.** On WebView2 (Windows) a
  minimized/occluded window throttles timers and floods on restore. Background polling
  (market tracking, watchlist scanner, wallet refresh, worldstate refresh) now pauses
  while the window is hidden and resumes cleanly, avoiding the resume flood through the
  rate-limited scheduler. Trade detection deliberately keeps running so background trades
  and notifications are still captured while minimized.

### Recommendation backtesting & calibration

- **Self-grading recommendation engine.** Every analytics recommendation (entry/exit
  zones, action, liquidity) is recorded and later graded by replaying order-book snapshots
  forward — entry when the floor reaches the entry zone within 48h, exit when it reaches
  the exit zone within 7 days, otherwise marked to market. Grading runs automatically on
  each market-tracking refresh.
- **New "Calibration" tab** in Market, showing per-action hit rate, median return, return
  range, median days held, and a rolling 30-day hit rate. Recommendations with fewer than
  5 graded trades show an "insufficient data" state rather than misleading numbers.
- **Inline track record** on the Action Card, summarizing how recommendations with the
  current action have historically performed.
- Outcome rows are deduped (one per item per 6h), use a non-overlapping-trade guard,
  self-heal abandoned rows, and are retained for 90 days.

### Scoring accuracy

- **Cliff effects removed.** Stepped score tables (liquidity sub-scores and the arbitrage
  margin score) were replaced with piecewise-linear interpolation between the same anchor
  points, producing stable rankings instead of large jumps at threshold boundaries.
- **Liquidity double-count fixed** in the efficiency score, so the headline weights reflect
  the actual contribution of profit vs. liquidity.
- **Order-book pressure gated** behind a minimum buy-order count — sparse WTB books no
  longer swing the action card on noise.
- **Manipulation signals gated** behind minimum liquidity (price-wall and unstable-buy-
  pressure signals) to cut false positives on thin markets.
- Fixed a relative-volume unit mismatch and a weighted-percentile outlier fallback that
  could return a price above the intended cap.

### Reliability

- **Analytics cache key** now includes `seller_mode`, preventing cross-mode cache
  collisions (with an automatic schema migration).
- **Request coalescing** TTL raised so identical in-flight WFM requests actually coalesce
  instead of expiring before followers can read the result.
- **Atomic trade-log replacement** — the cached trade log is now replaced within a single
  transaction instead of a delete-then-insert across two.
- **Worldstate cache writes synchronized** to prevent concurrent read-modify-write cycles
  from dropping entries.

### Documentation

- Added `STATS_FOR_NERDS.md` explaining, in user-facing terms, exactly how the Analysis
  and Analytics figures are calculated — formulas, weights, percentiles, and exceptions.
