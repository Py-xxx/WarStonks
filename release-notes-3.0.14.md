# WarStonks — Patch Notes

### ✨ New

- **Trades no longer rely on polling Warframe.Market.** The app now reads trades straight out
  of the game's own log the moment they happen, with AlecaFrame covering inventory and relic
  counts — faster and more reliable than waiting on a periodic API check. The manual **Import
  from WFM** button still exists for backfilling anything missed while the app was closed.
- **Sold listings close automatically.** Once a sale is detected, the matching sell order is
  removed for you — no more manually clearing listings you've already sold.
- **Events → Overview.** A new default tab: active alerts and events in full, fissures in a
  side rail, and Baro Ki'Teer, Varzia, Nightwave, and Steel Path as at-a-glance summary cards
  linking to their own tabs.
- **Baro and invasions now show recommended sell prices**, the same pricing the rest of the app
  uses.

### ⚡ Improved

- **The whole app was rebuilt on one consistent design system.** Every page — Home, Market,
  Portfolio, Trades, Scanners, Watchlist, Opportunities, Strategy, Guide, Events — now shares
  the same panels, buttons, tooltips, and loading states.
- **Market's Charts tab loads instantly.** It now paints the last known chart right away while
  fresh data loads behind it, instead of a blank chart while two requests complete in sequence.
- **Worldstate updates the moment a cycle flips.** Cetus turning night, Vallis turning cold, or
  Cambion shifting Fass/Vome now triggers an immediate refresh of fissures, bounties, and the
  rest of the rotating content, rather than waiting on each panel's own timer.
- **Set Completion Planner works from first launch.** It now prices your sets from the app's
  existing 30-day price history — running a Scanner pass is no longer required before it shows
  anything.
- **Faster catalog rebuilds.** Item and set-composition rebuilds (first launch, or after a game
  update) now take seconds instead of minutes.
- **More sets recognized correctly**, including ones where the two data sources name a
  component differently.

### 🐛 Fixed

- **Worldstate could go stale for up to a week.** Fissures, alerts, and other timers were
  refreshed based on when the *current* thing ends, not when the *next* one appears — so a
  quiet stretch (Baro away, no active alerts) could leave the app checking far less often than
  it should have.
- **Home's "Closing Soon" showed Baro Ki'Teer as leaving before he'd arrived.** It now only
  lists him while he's actually at his relay.
- **Market's price panels could show a stale price as current.** A caching gap meant an old
  exit price could render as if it were live.
- **Arbitration removed from Events.** The upstream source has been serving a placeholder
  record for this activity for a long time, not real data.
- Weapon and mod stat lines could run a highlighted number range into the next word (e.g.
  `6%weapon`); spacing is now preserved.
- Item descriptions rendered as a stack of short, ragged lines instead of flowing text.
- Invasion rewards were being re-priced on every worldstate update even when already priced,
  costing extra Warframe.Market lookups for no reason.

### 🔧 Stability & under the hood

- `legacy.css`, a 16,000-line stylesheet from the app's earliest days, is gone — `src/index.css`
  is now the app's entire stylesheet.
- Item catalog builds now derive set composition from bulk game data instead of thousands of
  individual lookups.
