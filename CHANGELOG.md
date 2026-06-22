# Changelog

All notable changes since the `3.0.6` release (`72a83d9`).

## Unreleased

### New: in-app Guide

- **Guide tab is now live.** The previously "coming soon" Guide is a full, searchable
  reference that explains how to use the app to anyone — no prior knowledge assumed.
- Sections cover **Quick Start**, a **Typical Workflow**, a **tab-by-tab** breakdown (each
  with an "Open this tab" jump link), and an extensive **Glossary**.
- **Deep analytics documentation.** Dedicated "Reading the Analytics Tab" and "Reading the
  Analysis Tab" sections explain every chart line, zone, and panel — median vs live floor,
  fair value, entry/exit zones, orderbook pressure, trend quality, the action card, trade
  posture, margins, liquidity, manipulation risk, supply/event context, and the backtest
  track record.
- The glossary is grouped into **Warframe terms**, **Trading basics**, and **Data &
  analytics terms**, defining the concepts behind the numbers (closed vs live data,
  median, weighted average, percentiles, slope, volatility, confidence, and more).
- A live **search box** filters every section and glossary term, and section pills
  smooth-scroll to each part.

### Analytics & market data

- **Fixed the current-bucket price spike.** The latest hour's median was always inflated
  because it pulled in *live open listings* (sellers' asking prices) instead of confirmed
  sales. The price chart's median/average/candle now use **confirmed closed trades only**;
  live open-order data is limited to the genuinely-live fields (current floor and highest
  buy). Unsold overpriced listings can no longer distort the history.
  - If the current hour has no confirmed sales yet, the median is simply left blank (you
    still see the live floor) rather than showing a misleading number.
- **Cleaner entry/exit pricing.** Entry and exit zones are anchored to closed-trade history
  and only capped against the live book for actionability, so recommendations reflect what
  items actually sell for.
- **Recency- and volume-weighted zones.** Historical zone anchors now weight recent and
  higher-volume trades more heavily, with a regime guard, improving entry/exit accuracy and
  arbitrage reads.

### Quality-of-life

- **Clickable item names everywhere.** Any item name in the app can be clicked to open it,
  with a right-click menu to open in Quick View, copy the name, or open it on
  warframe.market. Applied across the Watchlist, Trades, Scanners, and Opportunities.
- **Rank included in whisper messages.** Copying a whisper for a ranked item now includes
  the rank (e.g. `(Rank 0/10)`) so the seller knows exactly which variant you want.
- **Toast notifications** for lightweight in-app feedback.
- **Quick-view, back navigation, and recent items** added to the store, with a search-focus
  shortcut.
- **Loading states now match the loaded layout.** The Analytics and Analysis tabs no longer
  flash an empty page with a lone placeholder card while loading. They render the real panel
  layout with per-panel loading overlays — the surface stays visible with content pending,
  consistent with the rest of the app.

### Home & UI

- **Home screen improvements** and a refactor that extracts a shared `WatchlistTable` used by
  both the dashboard Overview and the full Watchlist tab, centralising row actions (copy
  whisper, mark bought, remove) and their error/success handling.
- **Error boundaries** added so a failure in one panel no longer takes down the page.
- General UI polish across the Top Bar, Scanners, Opportunities, and Home.

### Trade authentication & sessions

- **Resolved sign-in and credential persistence failures.** The keychain integration was
  compiled without its platform backend, so credentials silently fell back to an in-memory
  store and were never actually saved. The native backends (macOS Keychain, Windows
  Credential Manager, Linux Secret Service) are now enabled, fixing "no credentials saved"
  and repeated forced logins.
- **Non-destructive presence keeper.** A dropped background WebSocket no longer wipes your
  saved session/keychain. Credentials are only cleared by a manual **Disconnect** — if the
  app can't read them, you're simply asked to log in again.
- **More resilient session restore.** The in-memory session is trusted for high-frequency
  calls, and lenient numeric parsing handles WFM returning platinum as either an integer or
  a float.

### Fixes

- **AlecaFrame relic loading.** Fixed an off-by-one in the relic header parse that dropped
  the last entry; the loader now reads the correct number of relic entries.
