# WarStonks Case Study

## Overview

WarStonks is a desktop market intelligence and trading companion for Warframe players who actively use Warframe Market.

I built it to solve a practical problem: serious players often juggle live listings, historical price context, relic planning, watchlists, trade logs, farming decisions, and personal inventory across multiple tools. The result is fragmented workflows, slow decisions, and a lot of manual checking.

WarStonks brings those workflows into one local-first desktop application that helps users:

- understand whether an item is worth trading
- identify what is worth farming
- plan which sets to complete
- manage live buy and sell orders
- track trade performance over time

The app is built with Tauri, React, TypeScript, Rust, and SQLite.

## Project Snapshot

- **Product:** Desktop trading and planning tool for Warframe Market users
- **Role:** Product design, UX, frontend engineering, backend engineering, data workflow design
- **Stack:** Tauri 2, React 18, TypeScript, Rust, SQLite
- **Integrations:** warframe.market, warframestat.us, Alecaframe
- **Release status:** Official release line beginning with `3.0.4`

## The Problem

Warframe trading has a surprisingly high operational overhead if you want to do it well.

A user might need to:

- search the live market for an item
- judge whether the current price is attractive
- compare live conditions to broader historical context
- keep track of items they want to buy later
- manage existing buy and sell orders
- estimate which relics or prime sets are worth farming
- track whether their trading process is actually profitable

Most of that work is usually split between browser tabs, spreadsheets, screenshots, memory, and rough intuition.

That creates three core problems:

1. **Decision latency**  
   Good opportunities are easy to miss when users need to gather information manually.

2. **Lack of context**  
   Raw prices alone do not explain market posture, liquidity, trend strength, or whether a listing is competitive.

3. **Workflow fragmentation**  
   Trading, farming, and set planning are closely related, but most tools treat them as separate problems.

## The Goal

My goal was to design and build a single application that could support the full decision loop:

- monitor the market
- identify opportunities
- act on those opportunities
- manage the resulting orders
- evaluate outcomes over time

The product needed to feel practical rather than theoretical. It was not meant to be a passive statistics viewer. It needed to help users make better decisions quickly.

## The Solution

I built WarStonks as a local-first desktop app organized around real player workflows rather than data categories.

Instead of centering the product around raw API responses, I centered it around questions users actually ask:

- What should I buy?
- What should I sell?
- What should I farm?
- Which set is close to completion?
- Is my listing still competitive?
- Is my trading process working?

That led to a feature set that combines live market inspection, scanner-driven discovery, inventory-aware planning, and portfolio tracking into one product.

## What I Built

### 1. Home Dashboard

I designed Home as the operational center of the app.

It brings together:

- global item search
- quick market inspection
- watchlist management
- alerts and action prompts

This gives the user a single place to check what matters right now instead of navigating across multiple tabs just to understand the current state of their setup.

### 2. Market Analysis and Analytics

The Market area is the deep-dive view for a single item.

I split it into:

- **Quick View** for fast orderbook reads
- **Analysis** for entry price, exit price, margin, liquidity, trade posture, and supply context
- **Analytics** for historical structure, market state, trend quality, and execution context

The aim was to move beyond simple “current lowest price” logic and instead give users a structured picture of the market.

### 3. Watchlist and Alerts

I built a watchlist system for users who do not want to constantly re-check items manually.

It supports:

- target-price tracking
- alerts when live listings match user-defined conditions
- fast action flows when a match is found
- synchronization between watchlist state and relevant buy-order workflows

This turns market monitoring from a repetitive manual process into a more event-driven one.

### 4. Scanners

I added scanner-driven discovery for users who want the app to surface opportunities automatically.

Current scanner areas include:

- **Arbitrage Scanner** for set-versus-component opportunities
- **Relic ROI Scanner** for relic value and reward quality analysis

The scanners are designed to summarize large data sets into concise, ranked results that can be acted on quickly.

### 5. Opportunities and Set Completion Planning

One of the most useful workflows in the app is set planning.

I built a **Set Completion Planner** that lets users:

- track owned prime components
- estimate investment, value, expected profit, and margin
- see which sets are close to completion
- use owned relic information to identify missing pieces more intelligently

I also added screenshot-assisted import flows for prime component ownership review, with an explicit confirmation step before data is applied.

### 6. Trades

The Trades area connects market intelligence to operational execution.

It includes:

- live sell order management
- live buy order management
- order editing and removal
- account status controls
- listing health feedback

One of the more important additions here was the **Trades Health** workflow, which helps explain:

- whether a listing is competitively priced
- how much queue is ahead of it
- whether the market is rising, flat, or falling
- whether the user should hold, trim, reprice, or wait

That shifted the product from simply showing listings to actively helping users interpret performance in context.

### 7. Portfolio and P&L

I built a local portfolio layer so users can review whether their trading process is actually working over time.

This includes:

- trade log views
- realized profit
- estimated inventory value
- total P&L style summaries
- broader performance context

The goal here was to make WarStonks useful not just for finding opportunities, but also for evaluating trading quality after the fact.

## Product and UX Approach

My design approach focused on reducing friction and increasing decision confidence.

That meant a few consistent product principles:

### Organize around decisions, not raw data

I avoided building the app as a collection of disconnected data panels. Instead, I designed major sections around user intent:

- inspect
- monitor
- discover
- manage
- review

### Keep the app responsive

A lot of the work in this product involves background refreshes, queueing, caching, and integration sync. I treated responsiveness as a product requirement, not just a technical detail.

### Prefer clear action language

Wherever possible, I shaped outputs around practical guidance rather than vague status text. That is especially important in places like market posture, listing health, and scanner views.

### Reduce visual noise

As the app grew, one of the ongoing design tasks was removing redundant labels, duplicate notes, overly noisy pills, and low-signal status text so the highest-value information could stand out.

## Technical Architecture

WarStonks is built as a Tauri desktop application with a split architecture:

### Frontend

- React
- TypeScript
- local UI state and workflow orchestration
- cache-aware rendering patterns

The frontend is responsible for:

- presenting live and cached data cleanly
- managing modal and review flows
- keeping background refreshes visually unobtrusive
- making complex market information easier to understand

### Backend

- Rust
- Tauri commands
- local persistence and data orchestration
- API integration control

The backend is responsible for:

- external API calls
- local database reads and writes
- scheduler enforcement
- analysis and scanner logic
- log and error handling

### Data Layer

- SQLite
- local-first caching
- persisted scanner and observatory state
- owned inventory and relic cache support

This architecture allows the app to load useful local data immediately and then refresh live data in the background where appropriate.

## Key Engineering Decisions

### 1. Shared Warframe Market Request Scheduler

Warframe Market enforces rate limits, and multiple app features can request data concurrently.

To handle that cleanly, I built a shared scheduler / priority queue so all Warframe Market requests pass through one controlled pathway. This prevents ad hoc request behavior, reduces duplication, and makes the app more predictable under load.

This was important because the app includes:

- search
- quick view
- watchlist refreshes
- trades refreshes
- scanners

Without centralized control, those workflows would compete badly and degrade the UX.

### 2. Cache-First, Refresh-in-Background Behavior

I leaned heavily into local-first behavior.

Where cached data is safe to use, the app loads that immediately, then refreshes in the background. This gives users a responsive experience while still keeping data reasonably fresh.

This approach became especially important for:

- owned relic inventory
- planner data
- scanner data
- historical market context

### 3. Degraded-Mode Error Handling

I treated error handling as part of product quality, not just backend stability.

Instead of letting features fail hard whenever a refresh or upstream source had trouble, I built the app to prefer degraded mode where safe. That means cached data can remain usable while the app communicates that a live refresh did not succeed.

This made the experience feel much more stable and professional.

### 4. Multi-Source Workflow Integration

WarStonks does not depend on a single source.

It combines:

- Warframe Market for market data and trading operations
- WarframeStat for worldstate context
- Alecaframe-linked data for cache and inventory-related workflows

One of the core technical challenges was deciding where data should be live, where it should be cached, and where it should be treated as advisory rather than authoritative.

### 5. Safety in Trade Actions

Trade-related actions can have real consequences for users if handled poorly.

For that reason, I paid particular attention to:

- confirmation flows
- order sequencing
- queue priority rules for user-triggered actions
- watchlist and buy-order reconciliation

The goal was to reduce the chance of the app doing the wrong thing during fast trading workflows.

## Challenges

### Challenge 1: Balancing live data with app responsiveness

The app depends on live market data, but users should never feel like the UI is freezing or waiting unnecessarily.

I addressed this through:

- local caching
- background refresh patterns
- request scheduling
- coalescing repeated work

### Challenge 2: Turning noisy data into actionable insight

The APIs provide a lot of raw information, but not necessarily a clean decision layer.

A major part of the work was designing:

- market summaries
- scanner scoring
- listing health logic
- planning-oriented UI outputs

The value of the app comes from interpretation, not just retrieval.

### Challenge 3: Handling feature growth without losing coherence

As the app expanded from market analysis into scanners, planning, trades, and portfolio features, there was a real risk of it becoming a collection of loosely connected tools.

I handled that by continually refining the product around one larger system:

- discover opportunities
- act on them
- manage the resulting state
- review performance

## Outcome

WarStonks became a much broader and more polished tool than a simple trading helper.

By the official `3.0.4` release, it covered the full workflow of:

- market inspection
- opportunity discovery
- farming guidance
- set completion planning
- live order management
- portfolio review

The result is a desktop product that gives Warframe Market users a more structured, informed, and efficient way to trade and plan.

I am not including public usage metrics here, but the project demonstrates strong product depth, significant systems design work, and a clear progression from early beta utility into an official release-quality desktop application.

## What This Project Demonstrates

This project reflects my ability to:

- identify and frame a real user workflow problem
- design a product around decisions rather than raw data
- build across frontend, backend, data, and UX layers
- manage complex external integrations and caching strategy
- design systems that remain usable under real-world constraints
- refine a product iteratively toward a more release-ready state

## Reflection

WarStonks is a strong example of the kind of product work I enjoy most: taking a messy, high-friction workflow and turning it into a tool that feels more cohesive, useful, and operationally sharp.

The most important lesson from the project was that technical correctness alone is not enough. For a product like this, the real value comes from how well the system translates raw data into confidence, speed, and clarity for the user.
