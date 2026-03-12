# WarStonks

[![Status](https://img.shields.io/badge/status-active%20development-2563eb?style=for-the-badge)](https://github.com/Py-xxx/WarStonks)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows-111827?style=for-the-badge)](https://github.com/Py-xxx/WarStonks)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-20232a?style=for-the-badge&logo=react&logoColor=61dafb)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-backend-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-local%20cache-003b57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646cff?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)
[![warframe.market](https://img.shields.io/badge/Data-warframe.market-f97316?style=for-the-badge)](https://api.warframe.market/)
[![warframestat.us](https://img.shields.io/badge/Data-warframestat.us-16a34a?style=for-the-badge)](https://api.warframestat.us/)
[![Last Commit](https://img.shields.io/github/last-commit/Py-xxx/WarStonks?style=for-the-badge)](https://github.com/Py-xxx/WarStonks/commits/main)

WarStonks is a desktop Warframe market assistant built with Tauri, React, TypeScript, and Rust.

The app focuses on:

- local-first market tooling
- live Warframe market lookups
- cached analytics and scanner workflows
- worldstate/event tracking
- watchlists, alerts, and item analysis

It is designed to run as a native desktop app on macOS and Windows without requiring a separate backend server.

## What Is Implemented

### Dashboard

- Global item search with local autocomplete from the catalog database
- Rank-aware item selection for mods, arcanes, and other variant-backed markets
- Quick View with:
  - current cheapest eligible sell order
  - seller name
  - copy whisper message
  - spread
  - 24-hour lowest-price sparkline
- Watchlist with:
  - desired price targets
  - adaptive background polling
  - seller blacklist support per item
  - alert creation when target conditions are met
- Notification bell with actionable alerts
- Shared analysis preview that reuses full Market analysis output

### Market

- `Analysis` tab with:
  - trade posture summary
  - flip analysis
  - liquidity detail
  - trend summary
  - event context
  - manipulation risk
  - time-of-day liquidity
  - drop sources / set components
  - type-aware item details sidebar
- `Analytics` tab with:
  - real market chart
  - domain and bucket controls
  - line / candlestick toggle
  - integrated volume bars
  - entry / exit zones
  - confidence-aware calculations
- Shared observatory cache so Dashboard and Market reuse analysis data for the selected item

### Events

- Active Events
- Void Trader
- Fissures
- Activities
- Market & News

Worldstate responses are cached locally so the app can still show the last known state when an upstream API is unavailable.

### Scanners

- Arbitrage scanner
  - scans set items against their components
  - caches set composition
  - calculates basket entry, set exit zone, margin, ROI, liquidity, score, and confidence
  - expandable component rows with quick add to watchlist
- Relic ROI scanner
  - shares the same scan/cache as Arbitrage
  - refinement-aware ROI
  - expected value per run based on drop chances and exit pricing

The scan runs in the background and persists the last completed results locally.

## Current Project Status

The strongest parts of the app right now are:

- Dashboard
- Market
- Events
- Scanners

The following areas still exist but are not feature-complete yet:

- Opportunities
- Trades
- Portfolio
- Strategy

Those pages are still scaffolded or partially mocked and should be treated as work in progress.

## Tech Stack

- Tauri 2
- React 18
- TypeScript
- Zustand
- Rust
- SQLite
- Vite

## Data Sources

WarStonks currently uses these live sources:

- [warframe.market v2](https://api.warframe.market/)
- [warframe.market v1 statistics](https://api.warframe.market/)
- [warframestat.us](https://api.warframestat.us/)

It also maintains local SQLite caches for:

- item catalog data
- market observatory snapshots
- analysis and scanner caches
- worldstate cache

## Local Storage

On macOS, app data is stored under:

```text
/Users/<you>/Library/Application Support/com.warstonks.app/
```

Typical files created there:

- `item_catalog.sqlite`
- `market_observatory.sqlite`
- `data/WFM-items.json`
- `data/WFStat-items.json`

On Windows, equivalent files are stored in the Tauri app data directory for `com.warstonks.app`.

## Prerequisites

### All Platforms

- Node.js 18+
- `pnpm`
- Rust via `rustup`

### macOS

- Xcode Command Line Tools

Install if needed:

```bash
xcode-select --install
```

### Windows

- Rust MSVC toolchain
- Visual Studio Build Tools with `Desktop development with C++`
- WebView2 Runtime

## Development

Install dependencies:

```bash
pnpm install
```

Start the desktop app in development:

```bash
pnpm tauri dev
```

The project includes a small Tauri wrapper that helps with dev-port handling.

## Production Builds

Build the app natively on the target OS.

### macOS

```bash
pnpm install
pnpm tauri build
```

### Windows

```powershell
pnpm install
pnpm tauri build
```

Build output is generated under:

```text
src-tauri/target/release/bundle
```

## Useful Commands

```bash
pnpm install
pnpm dev
pnpm build
pnpm tauri dev
pnpm tauri build
```

## Project Structure

```text
src/          React UI
src-tauri/    Rust backend, Tauri commands, SQLite logic
scripts/      helper scripts such as the Tauri wrapper
```

## Notes

- The app is local-first and cache-heavy by design.
- Many calculations are confidence-aware and intentionally degrade when data is sparse or stale.
- Seller filtering supports:
  - `Ingame`
  - `Ingame + Online`
- Offline sellers are not used in market analysis calculations.

## Roadmap Direction

Planned and expanding areas include:

- deeper scanner coverage
- richer trade-health workflows
- portfolio and strategy completion
- more calibration and validation across item classes
- continued refinement of market confidence and scoring models

## License

No license has been added to this repository yet.
