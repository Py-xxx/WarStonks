# WarStonks

[![Latest Release](https://img.shields.io/github/v/release/Py-xxx/WarStonks?display_name=tag&style=for-the-badge)](https://github.com/Py-xxx/WarStonks/releases)
[![Windows](https://img.shields.io/badge/platform-Windows-0f172a?style=for-the-badge)](https://github.com/Py-xxx/WarStonks/releases)
[![Auto Updates](https://img.shields.io/badge/updates-automatic-15803d?style=for-the-badge)](https://github.com/Py-xxx/WarStonks/releases)
[![Local-First](https://img.shields.io/badge/local--first-SQLite%20cache-075985?style=for-the-badge)](https://github.com/Py-xxx/WarStonks)

[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-20232a?style=for-the-badge&logo=react&logoColor=61dafb)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-bundled-003b57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org/)

[![warframe.market](https://img.shields.io/badge/data-warframe.market-f97316?style=for-the-badge)](https://api.warframe.market/)
[![warframestat.us](https://img.shields.io/badge/data-warframestat.us-16a34a?style=for-the-badge)](https://api.warframestat.us/)
[![Alecaframe](https://img.shields.io/badge/integration-Alecaframe-0891b2?style=for-the-badge)](https://stats.alecaframe.com/api/swagger/index.html)

[![Scanners](https://img.shields.io/badge/scanners-arbitrage%20%26%20relic%20ROI-b45309?style=for-the-badge)](https://github.com/Py-xxx/WarStonks)
[![WorldState](https://img.shields.io/badge/worldstate-tracking-7c3aed?style=for-the-badge)](https://github.com/Py-xxx/WarStonks)
[![Watchlists](https://img.shields.io/badge/watchlists-alerts-dc2626?style=for-the-badge)](https://github.com/Py-xxx/WarStonks)

[![Stars](https://img.shields.io/github/stars/Py-xxx/WarStonks?style=for-the-badge)](https://github.com/Py-xxx/WarStonks/stargazers)
[![Open Issues](https://img.shields.io/github/issues/Py-xxx/WarStonks?style=for-the-badge)](https://github.com/Py-xxx/WarStonks/issues)
[![Last Commit](https://img.shields.io/github/last-commit/Py-xxx/WarStonks?style=for-the-badge)](https://github.com/Py-xxx/WarStonks/commits/main)

WarStonks is a desktop trading companion for Warframe players who want to stop guessing and start making cleaner, faster market decisions.

It brings live market data, analysis, scanners, watchlists, relic planning, and portfolio tracking into one app so you can see:

- what is worth flipping
- what is worth farming
- what is worth completing
- what your trades are actually doing over time

If you actively use Warframe Market and want better timing, better visibility, and less manual checking, this app is built for that.

## Download

Download the latest version from [Releases](https://github.com/Py-xxx/WarStonks/releases).

For normal use:

- download the latest Windows `.exe`
- do not download the source code zip
- install once, then let the app handle updates from there

WarStonks supports in-app automatic updates, so once installed, future updates can be delivered directly through the app.

## Why People Use It

Warframe trading usually means bouncing between listings, statistics, relic data, personal notes, and your own inventory. WarStonks pulls those together into one workflow.

That means you can:

- spot flips faster
- track your buy targets properly
- understand entry and exit zones before committing
- see whether a relic helps complete sets you are already building
- manage active orders without losing context
- keep a real local record of your trading performance

## What The App Does

WarStonks is designed around practical decisions, not just raw data dumps.

It helps you:

- search and analyze items quickly
- compare market posture and execution quality
- run scanner-based opportunity discovery
- manage a live watchlist with actionable alerts
- sync watchlist behavior with buy orders
- plan set completion using owned parts and owned relics
- track your trade history and P&L locally

## Tabs

### Home

Your day-to-day trading dashboard.

- global search
- quick view pricing
- watchlist management
- alert handling
- fast action flow for items you are actively monitoring

### Market

The deep-dive page for a specific item.

- analysis
- analytics
- entry and exit zones
- liquidity and execution readouts
- trend context
- supply and drop-source context

This is where you decide whether an item is worth acting on.

### Events

Warframe worldstate tracking in one place.

- alerts
- fissures
- void trader
- invasions
- activity/news context

Useful when timing and supply pressure matter.

### Scanners

Bulk opportunity discovery.

- Arbitrage scanner for set-versus-component opportunities
- Relic ROI scanner for relic value and reward quality

This is where you go when you want the app to surface opportunities for you instead of searching manually.

### Opportunities

Actionable planning tools powered by scanner and inventory data.

- What To Farm Now
- Set Completion Planner
- owned component tracking
- owned relic-aware recommendations

This is the part of the app that turns raw data into a next move.

### Trades

Your Warframe Market operations tab.

- buy orders
- sell orders
- account status
- watchlist-linked order automation

Built for keeping active trading organized.

### Portfolio

Your local trade record and performance layer.

- trade log
- realized profit
- estimated inventory value
- estimated total P&L
- trade breakdowns and coverage metrics

This is where you see whether your process is actually working.

### Guide

A future onboarding/help area for users.

### Strategy

A future feature area for higher-level trading workflows, presets, and planning.

## Typical Workflow

1. Search an item on Home or Market
2. Review the analysis and current market posture
3. Add it to your watchlist if the setup is good
4. Let alerts surface the moment it becomes actionable
5. Use Trades to manage orders
6. Use Portfolio to measure results
7. Use Scanners and Opportunities to find the next edge

## Core Highlights

- live item search and quick view
- watchlist alerts and fast buy handling
- item analysis and analytics
- arbitrage scanning
- relic ROI scanning
- set completion planning
- owned relic support
- local trade ledger and P&L
- worldstate visibility

## Developer Notes

WarStonks is a Tauri desktop app built with:

- React
- TypeScript
- Rust
- SQLite

Local development:

```bash
pnpm install
pnpm tauri dev
```

Releases are published through GitHub Releases. For users, the install artifact is the Windows `.exe`.
