# WarStonks

[![Latest Release](https://img.shields.io/github/v/release/Py-xxx/WarStonks?display_name=tag&style=for-the-badge)](https://github.com/Py-xxx/WarStonks/releases)
[![Windows](https://img.shields.io/badge/platform-Windows-0f172a?style=for-the-badge)](https://github.com/Py-xxx/WarStonks/releases)
[![Auto Updates](https://img.shields.io/badge/updates-automatic-15803d?style=for-the-badge)](https://github.com/Py-xxx/WarStonks/releases)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)

## Download

The latest version can be downloaded directly from [Releases](https://github.com/Py-xxx/WarStonks/releases).

For normal use, only download the Windows `.exe` file from the latest release.

- Do not download the source code zip
- Install the app once from the release `.exe`
- After that, WarStonks can check for released updates and update itself automatically in-app

## What WarStonks Does

WarStonks is a desktop assistant for Warframe trading, scanning, and planning.

It helps you:

- find profitable flips and set opportunities
- track items you want to buy
- monitor your orders and trade account
- understand market posture and price zones
- manage owned prime components and relics
- keep a local trade ledger and P&L summary

The app is built to feel fast and practical:

- local-first data and caching
- live market requests where they matter
- scanner workflows for bulk decision-making
- one place for analysis, planning, trades, and portfolio tracking

## Why It Is Useful

Warframe market data is spread across listings, statistics, relic drops, and your own inventory. WarStonks brings those together into one workflow so you can:

- decide what to flip
- decide what to farm
- decide what to complete
- manage active buy and sell orders
- review how your trades are actually performing

## Tabs

### Home

Your day-to-day command center.

- global item search
- quick view for live pricing
- watchlist management
- alerts and match notifications

### Market

Deep analysis for a selected item.

- entry and exit zones
- trade posture
- execution quality
- trend and analytics panels
- drop sources and supply context

### Events

Live worldstate information that can affect supply, timing, and demand.

- alerts
- fissures
- void trader
- invasions
- activities and news

### Scanners

Bulk scanning tools for opportunity discovery.

- Arbitrage: compares set value against component entry cost
- Relic ROI: compares relic rewards against expected value and exit opportunity

### Opportunities

Planning tools built from the scanner data.

- What To Farm Now
- Set Completion Planner
- owned prime component tracking
- owned relic-aware planning

### Trades

Your active Warframe Market trading workspace.

- buy orders
- sell orders
- account status
- linked watchlist automation

### Portfolio

Your local trade ledger and performance summary.

- trade log
- realized profit
- estimated inventory value
- estimated total P&L
- breakdowns and coverage metrics

### Guide

Reserved for onboarding and user guidance. This is currently a future feature.

### Strategy

Reserved for future higher-level trading workflows and presets.

## Typical Workflow

1. Search an item on Home or Market
2. Review Analysis and Analytics
3. Add it to the watchlist if the setup looks good
4. Let alerts tell you when a buy opportunity appears
5. Use Trades to manage orders
6. Use Portfolio to review results
7. Use Scanners and Opportunities to find the next move

## Main Features

- rank-aware item markets
- market analysis and analytics
- watchlist alerts
- buy-order sync with watchlist
- arbitrage scanner
- relic ROI scanner
- set completion planning
- owned relic cache support
- local trade history and P&L
- worldstate panels

## Developer Notes

WarStonks is a Tauri desktop app with:

- React
- TypeScript
- Rust
- SQLite

Basic local development:

```bash
pnpm install
pnpm tauri dev
```

Windows releases are built from the repo and published through GitHub Releases. The user-facing install artifact is the release `.exe`.
