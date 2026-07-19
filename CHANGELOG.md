# WarStonks — Patch Notes

### ✨ New

- **Opportunities (beta).** A whole new page that tells you what to do right now: reprice
  stale listings, flip undervalued items, complete almost-finished prime sets, or sell parts —
  each card with a clear reason and a one-click action. Includes a **Set Decision Engine** that
  weighs completing a set against selling the parts (it even counts the daily trades each route
  costs), an **Inventory** view of what you're holding, and pinnable cards so a good opportunity
  doesn't slip away.
- **WarStonks now speaks your language.** Full multi-language support — English, German,
  Spanish, French, Portuguese, and Simplified Chinese. The entire UI is translated, and item
  names use Warframe.Market's official translations so they match what traders in your region
  actually call things. Language packs download automatically and can also be exported/imported
  offline. Dates and times follow your language's format too.
- **Auto-scan (daily).** An opt-in toggle on the Scanner page that re-runs the arbitrage scan
  automatically once a day when it goes stale. It runs at low priority so it never delays live
  trading, and it's off by default.
- **Backup, import & export.** Move your watchlist, settings, and data between machines — or
  just keep a backup — from the new Import/Export panel.
- **Variant selector for listings.** Mods that exist in multiple variants (e.g. regular vs.
  **Atragraph** archon mods) now get a variant dropdown when creating a listing, so the right
  version goes up on Warframe.Market.
- **Item ranks in Trades.** Sell and buy orders now show the item's rank (e.g. `3/10`) in its
  own column, and the market analysis when creating a listing is rank-aware — rank-0 and maxed
  copies are priced separately.

### ⚡ Improved

- **Trade Log redesigned.** The Portfolio trade log got a full overhaul: everything fits on
  screen, column headers stay visible while you scroll, and each row shows its price, quantity,
  profit, and margin at a glance.
- **Smarter opportunity pricing.** Buy/sell suggestions now use recommended entry and exit
  zones instead of over-trusting the most recent sale — a single price spike no longer distorts
  what the app tells you to pay.
- **Cleaner top bar.** The placeholder logo and the strategy summary pill are gone, the
  currency strip is more compact, and the market rank selector is now a simple
  **R0 / max-rank** toggle instead of a dropdown.
- **Strategy page reworked.** Strategy settings moved into a slim side panel (minimum edge and
  trade value are configurable there); the main area is reserved for what's coming next.
- **Consistent panel styling** — panel titles now use one indicator style across Set Completion
  Planner, Inventory, What To Farm Now, Owned Relics, and friends.
- **Smooth, freeze-free UI.** Heavy actions like switching language no longer lock up the
  window — big tasks show a loading screen and the app stays responsive, including after long
  idle periods or sleep.

### 🐛 Fixed

- **Archon mod listings rejected.** Listing Archon Vitality (and other multi-variant mods)
  failed with "Warframe Market rejected this order" — the listing now sends the required
  variant and posts correctly.
- **Trade Log force-resync errors.** "Force Resync" could fail with a catalog-lookup error, and
  items could show raw internal names like `StyanaxPrimeChassisComponent` instead of real item
  names. Lookups are fixed, and a single problem item can no longer abort the whole resync.
- **AlecaFrame request flooding.** A background wallet poll was re-requesting relic data every
  minute, bypassing its cooldown — AlecaFrame calls are now properly spaced.
- **Chinese item names doubled the "Set" suffix** and some translations didn't match the
  market's official names — item names now come straight from Warframe.Market in every
  language.
- **Date formats follow your language** — e.g. Chinese now shows year-month-day order instead
  of an English-style date.
- Assorted smaller fixes across opportunities scoring, listing modals, and error reporting.

### 🔧 Stability & under the hood

- **The app keeps working in the background.** Windows/WebView background throttling is fully
  disabled, so scans, watchlists, and trade detection keep running while the app is minimized
  or your PC has been idle — no more waking up to a stalled session.
- **Better error diagnostics.** Rejected Warframe.Market orders now log the raw API response,
  and backend errors report their full cause chain instead of a vague summary — so problems
  are much easier to track down and report.
- **Fewer, smarter API calls.** Rank analysis while typing is debounced, identical in-flight
  requests are coalesced, and language packs only re-download when Warframe.Market's catalog
  actually changes.
