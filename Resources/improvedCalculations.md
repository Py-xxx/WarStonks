# WarStonks Improved Calculations Reference

This document explains how every major calculation in WarStonks works, what data it uses,
how outputs are produced, and how all the connected features share the same logic.
It is written for a normal user who wants to understand what the numbers mean.

---

## Table of Contents

1. [Where the data comes from](#1-where-the-data-comes-from)
2. [Core prices — Entry, Exit, and Zones](#2-core-prices--entry-exit-and-zones)
3. [Outlier handling](#3-outlier-handling)
4. [Bot wall detection](#4-bot-wall-detection)
5. [Liquidity score](#5-liquidity-score)
6. [Confidence levels](#6-confidence-levels)
7. [Trend and stability](#7-trend-and-stability)
8. [Efficiency and capital score](#8-efficiency-and-capital-score)
9. [Opportunity score](#9-opportunity-score)
10. [Arbitrage scanner score](#10-arbitrage-scanner-score)
11. [Relic ROI score and run value](#11-relic-roi-score-and-run-value)
12. [Which features share the same calculation path](#12-which-features-share-the-same-calculation-path)
13. [What was fixed in the latest audit](#13-what-was-fixed-in-the-latest-audit)

---

## 1. Where the data comes from

WarStonks uses two types of market data.

### Closed statistics (the most reliable source)

This is the record of actual completed trades, pulled from the Warframe Market statistics API
and stored in the local SQLite cache. It shows:

- How many items actually sold in each time bucket
- The median, weighted average, minimum, and maximum prices of those sales
- A moving average over recent history
- How prices have drifted over the past 48 hours and 90 days

Because this data reflects real deals that happened, it is the primary anchor for all
entry and exit price recommendations. If the live order book looks weird (e.g. a bot wall),
the closed statistics keep the app grounded in reality.

### Live orderbook (timing and execution layer)

This is the current list of open sell and buy orders on Warframe Market right now.
It is useful for:

- Seeing exactly where you can buy or sell this minute
- Understanding how crowded the sell floor is
- Measuring buy/sell pressure
- Deciding whether the historical target is currently reachable

The live orderbook is used as an adjustment layer on top of the historical anchor, not as the
primary truth. If the live floor is temporarily depressed by a bot wall, the app will not
blindly anchor a "recommended exit" to that wall price.

---

## 2. Core prices — Entry, Exit, and Zones

### How entry zones are found

The app uses up to 90 days of completed trade history to find where the price has historically
found support — meaning where buyers tend to step in and prices stabilize.

Step 1 — Build price series:
- Collect the low prices (min_price, Donchian bottom) from each daily bucket. These represent
  dip levels the market has seen.
- Collect the fair-value prices (median, weighted average, moving average) from each bucket.
  These represent where most trades actually happen.
- Collect the ceiling prices (max_price, Donchian top) from each bucket. These represent the
  upper range the market has reached.

Step 2 — Find support anchors:
- The entry floor is the 18th percentile of the dip series — a conservatively low buy target
  that is below most recent lows.
- The entry high is the 38th percentile of the dip series — the "support recurrence" level
  where dips tend to find buyers regularly.
- These two values define the bottom and top of the entry zone.

Step 3 — Find fair center:
- The 55th percentile of the fair-value series gives the center of the normal trading range.

Step 4 — Define zone widths:
- The zone width is 20% of the total price range, clamped between 3 and 6 platinum.
- Entry zone: from entry_floor up to support_recurrence.
- Exit zone: from upper_bound minus zone_width up to upper_bound.

**The entry zone represents: "if the price dips to this range, historical data says buyers
have repeatedly stepped in here. This is a reasonable buy level."**

### How exit zones are found

The exit target is built from a blend of historical anchors, then adjusted by live market
conditions.

Step 1 — Historical target (four inputs blended):
- Recent fair anchor (38% weight): average of the last 3 daily median prices. This captures
  where the market has been trading in the most recent days.
- Recent mid anchor (27% weight): average of the last 7 daily median prices. This is a
  slightly smoother version of recent fair value.
- Fair high anchor (20% weight): the 68th percentile of the IQR-filtered fair-value series
  over the last 14 days. This captures the upper end of where prices have been without being
  corrupted by single-day spikes.
- Zone target (15% weight): the midpoint of the computed exit zone band from the historical
  analysis above.

Step 2 — Downward adjustments:
- If recent 7-day volume is below 65% of the historical daily average, the target is reduced by
  3 platinum. Volume dropping typically means fewer buyers and harder exits.
- If recent 7-day volume is 65–90% of historical average, reduce by 1.5 platinum.
- If the price has been drifting down more than 8% compared to the prior period, reduce by 3
  platinum. A sustained downtrend means your target needs to be lower.
- If drift is between −4% and −8%, reduce by 1.5 platinum.

Step 3 — Hard bounds:
- The target cannot exceed the zone high (the historical ceiling).
- The target cannot go below the zone low (the historical exit floor).
- The exit must be at least 1 platinum above the entry price.

Step 4 — Live execution check (Analysis tab only):
The app also computes a live exit cap from the current sell ladder. It selects a percentile
of the sell orders (roughly 25–58% depending on market pressure and liquidity) and adds a small
execution cushion. The final recommended exit is the lower of:
- the historically computed target
- the live cap

This ensures the recommendation is not higher than what the current order book can realistically
deliver in a normal queue position.

### Entry and exit zone bands shown in the UI

The entry zone band (e.g. "84–88p") shows: "buy anywhere in this range is historically
well-supported."

The exit zone band (e.g. "90–94p") shows: "selling in this range is consistent with recent
completed trade history."

The recommended entry and exit prices are the specific midpoints within those bands.

---

## 3. Outlier handling

The app uses IQR filtering (interquartile range) to remove extreme outlier prices before
computing anchors.

How IQR filtering works:
1. Sort all prices.
2. Find Q1 (25th percentile) and Q3 (75th percentile).
3. Compute IQR = Q3 − Q1.
4. Remove any price below Q1 − 1.5×IQR or above Q3 + 1.5×IQR.

This is applied to the fair-value series before computing the "fair high anchor" used in
exit pricing. It prevents one unusual day (like a spike to 200% of normal) from inflating
the anchor and making the exit target unrealistically high.

For recent anchors (last 3 or 7 days), raw prices are used because recency matters more than
filtering — if prices genuinely moved higher this week, the app should reflect that.

---

## 4. Bot wall detection

Warframe Market sometimes has large listings — one seller posting 9000 units at a single
price. This is called a "wall." Walls distort the live order book in two ways:

1. **Exit price distortion** — The wall's huge quantity gives it overwhelming influence in
   a quantity-weighted percentile calculation. Without a fix, the "40th percentile exit price"
   becomes the wall price even if 89 other sellers are priced 4–8 platinum higher.

2. **Market depth inflation** — The raw quantity (9000 units) made the market look extremely
   deep and liquid when in reality only 1–2 actual humans are active.

### How the app now handles walls

**Sell ladder percentile (for exit price):**
Every sell order's quantity is capped at 50 units before computing the sqrt weight used in
the weighted percentile. A seller with 9000 units gets the same weight as a seller with 50
units — because from a "how hard is it to get ahead of them in the queue" perspective, a
wall of any size is equally hard to beat. This makes the exit price reflect where the
normal competitive sellers are, not the wall.

**Market depth (for liquidity score):**
The raw sell and buy quantities are capped at 10× their respective order counts before being
fed into the activity index. One order with 9000 units is treated as no more than 10 normal
orders' worth of quantity. This prevents a single bot listing from pushing the depth score to
the maximum tier.

---

## 5. Liquidity score

The liquidity score (0–100%) measures how easy it is to trade an item right now, based on
the current live order book. It is used in every part of the app that shows trade quality.

Four components are blended:

### Demand balance (40% weight)
How many buyers are there relative to sellers?

The app measures a pressure ratio combining both order count and total quantity on each side.
- If buyers are at least 1.35× sellers → 100%
- If 1.10–1.35× → 80%
- If 0.85–1.10× → 60%
- If 0.60–0.85× → 40%
- Below 0.60× → 20%

This is the most important factor. An item where buyers heavily outnumber sellers is the
easiest to sell quickly.

### Low-price competition (25% weight)
How crowded is the floor?

The app counts how many sellers are priced within 2 platinum of the cheapest seller
(within-2-pt band). If this band is empty or very thin, your listing has a clear path to the
front of the queue.
- ≤2 sellers, ≤5 units, ≤2 unique users → 100%
- ≤4 sellers, ≤10 units, ≤4 unique users → 80%
- ≤7 sellers and ≤20 units → 60%
- ≤12 sellers and ≤40 units → 40%
- Otherwise → 20%

### Market depth (20% weight)
How many real participants are actively trading?

The activity index combines:
- 35% weight on order count (buyers + sellers)
- 45% weight on quantity (buy + sell), capped at 10× order count to prevent wall inflation
- 20% weight on unique user count

Higher activity = more competing buyers = faster fills.

### Spread tightness (15% weight)
How wide is the gap between the lowest sell and highest buy?

- Spread ≤2% → 100%
- Spread ≤5% → 80%
- Spread ≤10% → 60%
- Spread ≤20% → 40%
- Spread >20% → 20%

A tight spread means buyers and sellers broadly agree on price — ideal trading conditions.
A negative spread (buyer is paying more than seller is asking) gives 100%.

### Stats-based liquidity score (scanner path)

When the scanner runs without live order data, it uses a different signal based on closed
trade history:

- 50% weight: recent 48-hour volume (how many units actually sold in the last two days)
- 30% weight: active-day cadence (how many days in the last month had at least one trade)
- 20% weight: price stability (how consistent prices have been, computed from closed stats)

This gives the scanner a realistic measure of whether an item trades regularly or sits idle.

---

## 6. Confidence levels

Every calculation in the app carries a confidence level: **High**, **Medium**, or **Low**.

This answers the question: "how much should I trust this recommendation?"

Confidence degrades when:
- There are fewer than 12 historical anchor points (sparse data → Low or Medium)
- The most recent data is more than 24 hours old (stale → Low or Medium)
- There are fewer than 6 sell orders or 3 buy orders visible (thin orderbook)
- The zone bands are very narrow (less than 4 platinum wide), suggesting the anchors may
  not be reliable

The confidence level is shown in the UI alongside every price recommendation and score.
When confidence is Low, treat the numbers as rough guidance rather than firm targets.

### How confidence affects scores

All scoring functions use a unified confidence numeric scale:
- High → 100
- Medium → 72
- Low → 44

This scale is the same across the arbitrage scanner, relic ROI scorer, efficiency score,
and opportunity score. Previously, the relic and arbitrage scorers used slightly different
numbers (42 vs 44 for "low"), which has now been corrected.

---

## 7. Trend and stability

### Trend direction

The trend is computed from short-term (1-hour, 3-hour) and longer-horizon (6-hour) slopes
of the median price series from orderbook snapshots.

- **Rising** — price is trending upward
- **Falling** — price is trending downward
- **Flat** — no meaningful directional movement

### Trend quality (Analytics tab)

Trend quality (0–100%) measures how clean and reliable the trend signal is. It has three
components:

- 45% Stability — how consistent the price moves are (less volatility = more stable)
- 40% Momentum — how strong the directional slope is
- 15% Low noise — the share of price moves that are small (< 10% swing)

Higher trend quality means: "if the trend continues, it is likely to keep going in the
same direction."

### Price stability (for the scanner)

In the stats-based scanner path, stability is computed from the closed price series
(weighted average, average price, or closing price), because snapshot median_sell data
is not available. Previously, the stability fell back to a neutral default (50%) when this
data was absent. Now it correctly reflects the actual price consistency from closed statistics.

---

## 8. Efficiency and capital score

The efficiency score (0–100%) measures how attractive a trade is as a use of capital,
combining profit potential with market quality and risk.

Formula:
```
Profit % = (exit − entry) / entry
Profit normalization = profit % / 25%, capped at 1.0
Market quality = liquidity score / 100
Base score = 65% × profit normalization + 35% × market quality
Liquidity multiplier = 0.70 + 0.60 × market quality
Risk penalty = (100 − manipulation penalty %) / 100

Efficiency score = 100 × base_score × liquidity_multiplier × risk_penalty
```

Labels:
- 75%+ → Plat Machine
- 50–74% → Balanced
- 25–49% → Slow Burn
- Below 25% → Capital Trap

The liquidity multiplier means a profitable trade in a deep market scores much higher than
the same profit margin in a thin market — because thin markets are harder to actually execute.

---

## 9. Opportunity score

The opportunity score is the main ranking score used in the Farm Now and Opportunities
features. It combines five dimensions into one weighted composite.

Dimensions:
1. Liquidity (how easy to trade)
2. Efficiency (how good the capital use is)
3. Margin (how wide the buy/sell spread is in percentage terms)
4. Trend (Rising=100%, Flat=50%, Falling=10%)
5. Risk safety (Low risk=100%, Moderate=50%, High=10%)

The five dimensions are weighted according to the active strategy profile. For example,
a Fast Flipper profile puts 35% on liquidity, while a Margin Hunter puts 45% on margin.

The final score is multiplied by the confidence modifier and capped at 100%.

Labels:
- 80%+ → Prime Action
- 60–79% → Good Trade
- 40–59% → Marginal
- Below 40% → Skip

---

## 10. Arbitrage scanner score

The arbitrage scanner looks for sets where buying all the components separately is cheaper
than buying the assembled set, or vice versa.

**Direction A profit:** set sale price minus total cost of buying the parts individually.

**Direction B profit:** total realistic part sell value minus the set purchase price.

### Arbitrage score (0–100%)

The score ranks how attractive an arbitrage opportunity is:

- 45% weight: margin score (based on gross profit and ROI%)
  - ROI ≥ 35% or gross ≥ 40p → 100 points
  - ROI ≥ 22% or gross ≥ 25p → 82 points
  - ROI ≥ 14% or gross ≥ 15p → 64 points
  - ROI ≥ 8% or gross ≥ 8p → 46 points
  - Any positive margin → 28 points
  - No margin → 0 points
- 30% weight: set liquidity score
- 15% weight: component acquisition score (average component confidence + liquidity,
  with a bonus if the current price is already at or below the target entry)
- 10% weight: overall confidence

All prices used in arbitrage come from the same `build_statistics_price_model` path as
Analysis and Analytics — there is one shared calculation source for entry and exit zones.

---

## 11. Relic ROI score and run value

### Run value

Run value (plat/run) is the expected platinum earned per relic run at a given refinement level.

```
Run value = Σ over all drops: (drop chance %) × (recommended exit price for that drop)
```

For example, if a relic at Intact has:
- 25% chance for a drop worth 20p → contributes 5.0p
- 11% chance for a drop worth 50p → contributes 5.5p
- Common drops (credits etc.) → contributes 0p

Run value = 5.0 + 5.5 = 10.5p per run (Intact).

Drop exit prices come from `build_statistics_price_model` — the same historical anchor
system used across the entire app.

### Relic ROI score (0–100%)

The score ranks relics against each other:

- 75% weight: run value component, scaled linearly from 0 to 80p EV
  (a relic with 40p EV scores ~37.5 points; 80p EV scores 75 points)
- 28% weight: weighted liquidity score across all drops
  (weighted by each drop's expected value contribution, so common high-value drops matter more)
- 18% weight: confidence score

**Important improvement:** Previously the run value component was capped at 33p EV, meaning
all relics above 33p EV scored identically in this component. The cap is now 80p, so a relic
with 60p EV is meaningfully ranked higher than one with 30p EV.

---

## 12. Which features share the same calculation path

This is critical: multiple features must show consistent numbers because they use the same
shared backend functions.

| Feature | Entry price source | Exit price source | Liquidity source |
|---|---|---|---|
| Market → Analysis | `build_item_analysis_inner` → `build_shared_exit_pricing` (with live orders) | Same, with live cap | `liquidity_score_percent` (live snapshot) |
| Market → Analytics | Same as Analysis | Same | Same |
| Scanners → Arbitrage | `build_statistics_price_model` → `build_shared_exit_pricing` (stats-only) | Same, historical only | `score_stats_liquidity` (closed stats) |
| Scanners → Relic ROI | `build_statistics_price_model` for each drop | Same | `score_stats_liquidity` per drop |
| Opportunities / Farm Now | Uses relic/arbitrage scanner results | Same | Same |

### The shared core

All paths flow through these shared helpers:

- **`build_historical_zone_anchors`** — finds support/resistance from closed statistics
- **`compute_zone_bands`** — converts anchors into entry and exit zones
- **`build_historical_exit_profile`** — builds the 4-anchor weighted exit target
- **`build_shared_exit_pricing`** — combines historical target with live cap
- **`efficiency_score_percent`** — one function used by Analysis, Analytics, and all scanners

If a calculation changes in any of these core helpers, it automatically propagates to all
features that depend on them.

---

## 13. What was fixed in the latest audit

### Real-data issues found

The audit used the live SQLite cache with real Warframe Market data (363,065 statistics rows
across 987 items). Key findings:

**Vauban Prime Set had a bot wall distortion:**
The live order book showed 1 seller listing 9,179 units at 85p (out of 9,409 total sell
quantity). Before the fix, this made the weighted exit percentile return ~85p, and the
market depth score return 100% (as if it were the most liquid item in the game). Both were
clearly wrong — actual completed trades showed prices of 89–90p, and the market was
dominated by a single seller.

**Relic ROI score plateau:**
Any relic with an expected run value above 33 platinum per run scored identically in the
main relic component, making it impossible to distinguish a 35p/run relic from an 80p/run
relic. This was fixed by extending the linear scale to 80p/run.

**Confidence scoring inconsistency:**
The arbitrage and relic scorers used slightly different numeric values for "low" confidence
(42 vs 44). After unification, all features use the same scale.

**Stability always defaulted in the scanner path:**
The stability calculation used `median_sell` from chart points, which is only populated
when live snapshot data is present. In the stats-only path (scanner, arbitrage, relic ROI),
`median_sell` was always None, so stability always returned the neutral default of 50%.
Now it falls back to `weighted_avg`, `average_price`, and `closed_price` from the closed
statistics — giving a real measure of how stable an item's price has been.

### Changes made

| Change | What it does | Features affected |
|---|---|---|
| Wall quantity cap (`SELL_ORDER_WALL_QTY_CAP = 50`) | Prevents bot walls from dominating exit price in the live analysis | Market → Analysis, Analytics |
| Market depth quantity cap (10× order count) | Prevents bot walls from inflating the liquidity score | Market → Analysis, Analytics |
| `confidence_score` unified with `confidence_percent` | Fixes 44 vs 42 discrepancy for "low" confidence | Arbitrage, Relic ROI, Efficiency |
| `compute_stability` fallback prices | Makes stability meaningful in the stats-only path | Arbitrage, Relic ROI scanner |
| `build_relic_roi_score` linear scaling to 80p | Better differentiation of high-value relics | Scanners → Relic ROI, Farm Now |

---

## Quick reference: what a score means to you

| Score | What to ask |
|---|---|
| Liquidity 75%+ | "This item trades fast — I can likely buy and sell within hours." |
| Liquidity <35% | "This item is thin — I may wait days for a fill." |
| Efficiency 75%+ | "The margin is wide and the market is deep — strong use of capital." |
| Efficiency <25% | "Margins are thin or risk is high — this trade is a poor use of capital." |
| Relic ROI score 80+ | "Running this relic is among the best use of relic resources right now." |
| Arbitrage score 80+ | "This set has meaningful arbitrage margin with liquid components." |
| Confidence Low | "The data is sparse or stale — treat these numbers as rough estimates." |
| Confidence High | "The data is fresh and the history is deep — trust these numbers." |
