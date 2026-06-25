# WarStonks — Patch Notes

### ✨ New

- **See every seller.** Quick View's new **All Sell Orders** popup lists the full order book —
  every online / in-game seller, sorted by price — not just the cheapest few.
- **Inventory value in Portfolio.** Your owned prime parts are now priced and totalled, so the
  Portfolio shows the live platinum value of what you're holding.
- **Bulk arcane trading.** Listings for bulk-tradable items (arcanes) now include a **Per Trade**
  selector so you can trade them in batches, matching Warframe.Market's bulk-trade feature.
- **Desktop & sound notifications.** A Notifications settings panel with native OS desktop
  notifications and in-app alert sounds — pick a ringtone (with preview) and choose what fires:
  watchlist hits, a stale-scan reminder, and app-update notices.

### ⚡ Improved

- **Cleaner whisper messages.** Copied whispers wrap the item name in pipes —
  `… I would like to buy | Wisp Prime Chassis Blueprint | …` — and include the rank for ranked
  items (e.g. `(Rank 0/10)`) so the seller knows exactly which variant you mean.
- **Friendlier errors, everywhere.** When something goes wrong, you now get a clear, plain
  message — never a raw status code or JSON dump. Failed actions surface where you clicked
  (toasts), not just at the top of the page, and an expired session offers a one-click "Sign in
  again".
- **Accessibility pass.** Full keyboard navigation (tabs, nav, menus, modals all work without a
  mouse), screen-reader announcements for toasts and alerts, a "reduce motion" option that
  respects your OS setting, and clearer focus outlines.
- **Home & UI polish** across the Top Bar, Scanners, Opportunities, and Home, plus error
  boundaries so a hiccup in one panel no longer takes down the page.

### 🐛 Fixed

- **Couldn't list arcanes.** Creating a sell/buy order for an arcane failed with a "status 400"
  error — bulk-tradable items now send the required batch size and list correctly.
- **Desktop notifications now actually turn on.** Enabling them previously did nothing because
  the app couldn't request OS permission from inside its window. It now triggers the proper
  macOS / Windows permission prompt.
- **No more double-fired trade actions.** Rapidly clicking Mark-as-Sold / Remove / visibility no
  longer sends duplicate requests (e.g. closing more than intended).
- **Silent failures fixed.** Add-to-watchlist, "Open Wiki", and background refreshes now report
  problems instead of failing quietly.

### 🔧 Stability & under the hood

- **Resilient startup when services are down.** A WarStonks update no longer wipes cached data
  or refuses to launch when warframestat.us is briefly offline — it falls back to your last
  saved catalog and shows a dismissible "data may be out of date" banner that clears itself once
  the service is back. It only hard-stops in the truly unrecoverable cases (Warframe.Market down
  with no saved data, or a first-ever launch while warframestat.us is offline), each with a
  clear message.
- **More accurate catalog refresh.** Item-catalog updates are now detected reliably (so vault /
  drop / price data doesn't go stale), and refreshes only happen when sources actually change.
- **Self-healing item thumbnails** — broken images recover automatically.
- **Hardened data writes & scanner.** Settings and cache files are now written atomically (a
  crash mid-save can't corrupt them), the arbitrage scanner can't start twice or get stuck
  showing "running", and a number of background timing/race issues were closed out.
