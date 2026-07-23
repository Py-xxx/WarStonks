//! Smart Manage — the pure pricing brain behind optional auto-repricing of your sell listings.
//!
//! The entire policy reduces to one objective: **maximize expected profit = margin ×
//! probability-of-selling**, over a small set of candidate prices read from the live book,
//! subject to a hard profit floor and anti-price-war guardrails. That single principle yields
//! every behavior we want — raise into a gap, trim to compete when it's worth it, hold when
//! we're already near-optimal, and refuse to chase a race to the bottom.
//!
//! This module is deliberately **pure and I/O-free** so the make-or-break logic is fully
//! unit-testable and deterministic. All persistence, WFM calls, scheduling, and notifications
//! live in the caller (`trades`/`settings`). Prices are whole platinum (`i64`).

/// How aggressively to trade profit for speed-of-sale. Maps to the horizon constant in the
/// sell-probability model: patient (Conservative) tolerates slow sales for more margin;
/// impatient (Aggressive) accepts thinner margins to move faster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aggressiveness {
    Conservative,
    Balanced,
    Aggressive,
}

impl Aggressiveness {
    pub fn from_wire(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "conservative" => Aggressiveness::Conservative,
            "aggressive" => Aggressiveness::Aggressive,
            _ => Aggressiveness::Balanced,
        }
    }

    /// Horizon (hours) at which sell-probability halves. Larger = more patient = holds higher
    /// prices; smaller = more impatient = prices lower to sell faster.
    fn sell_horizon_hours(self) -> f64 {
        match self {
            Aggressiveness::Conservative => 96.0,
            Aggressiveness::Balanced => 36.0,
            Aggressiveness::Aggressive => 12.0,
        }
    }

    /// When lowering to compete, do we undercut the floor by 1 (chase the sale) or just match it
    /// (war-averse)? Aggressive undercuts; Conservative matches; Balanced matches unless the
    /// listing is clearly stuck (handled by the EV math preferring the undercut candidate).
    fn undercuts_to_lead(self) -> bool {
        matches!(self, Aggressiveness::Aggressive)
    }
}

/// Tunables the caller derives from `Aggressiveness` + settings. Broken out so tests can pin
/// exact values.
#[derive(Debug, Clone, Copy)]
pub struct SmartParams {
    pub sell_horizon_hours: f64,
    /// Minimum absolute plat move required to bother changing (anti-thrash).
    pub hysteresis_abs: i64,
    /// Minimum fraction-of-price move required (anti-thrash), whichever is larger.
    pub hysteresis_pct: f64,
    /// Max single-step move as a fraction of current price (a bad read can't tank a price).
    pub max_step_pct: f64,
    /// Percent of margin to keep above cost basis when the cost floor applies (e.g. 10 = the
    /// floor is 10% above your cost).
    pub min_margin_pct: f64,
    /// Undercut the leading competitor by 1 when lowering to compete (vs. matching).
    pub undercuts_to_lead: bool,
    /// Undercut velocity (steps/hour) at or above which we treat it as an active price war.
    pub price_war_threshold: f64,
    /// Upper bound the step cap may stretch to when a listing sits far outside fair value —
    /// a badly mispriced listing shouldn't need many cycles to become sellable.
    pub max_step_pct_far: f64,
}

impl SmartParams {
    pub fn from_settings(aggressiveness: Aggressiveness, min_margin_pct: f64) -> Self {
        SmartParams {
            sell_horizon_hours: aggressiveness.sell_horizon_hours(),
            hysteresis_abs: 2,
            hysteresis_pct: 0.03,
            max_step_pct: 0.20,
            min_margin_pct: min_margin_pct.max(0.0),
            undercuts_to_lead: aggressiveness.undercuts_to_lead(),
            price_war_threshold: 0.45,
            max_step_pct_far: 0.40,
        }
    }
}

/// Everything the engine needs about one listing and its market, all outlier-filtered by the
/// caller (competitor prices must already exclude trolls and the user's own listings).
#[derive(Debug, Clone)]
pub struct SmartInputs {
    pub your_price: i64,
    /// Confident cost basis (≥2 logged buys). `None` = unknown → no loss protection possible.
    pub cost_basis: Option<i64>,
    /// Competitor sell prices in the current seller-mode scope, ascending, outlier-filtered,
    /// excluding your own listings.
    pub competitor_prices: Vec<i64>,
    pub exit_zone_low: Option<f64>,
    pub exit_zone_high: Option<f64>,
    /// Recent units sold per day (velocity). `None` = unknown → sell-time is a rough guess.
    pub daily_volume: Option<f64>,
    /// Floor undercut rate (steps/hour) from the live firehose / snapshots.
    pub undercut_velocity: Option<f64>,
    /// Live buyer depth (demand behind the book).
    pub buy_depth: i64,
    /// Graded confidence in the market context: "high" / "medium" / "low".
    pub confidence_level: String,
    pub is_only_seller: bool,
    /// Empirical correction for the sell-time model, learned from this user's own resolved
    /// predictions (median actual/predicted). 1.0 = the model is calibrated; >1 = it has been
    /// over-optimistic about speed, so be more patient. `None` until enough samples exist.
    pub sell_time_calibration: Option<f64>,
    /// Sell orders per hour posted by whoever currently holds the market floor. High = an active
    /// repricer, so a lead won by undercutting them will not survive the selling horizon.
    pub floor_defender_rate: Option<f64>,
    /// Live buy-order prices, descending. Real money on the table right now — the only direct
    /// evidence of demand we have. Used gently: buy orders skew lowball, so they inform the model
    /// rather than dictate the price.
    pub buy_prices: Vec<i64>,
    /// Per-listing hard bounds set by the user. These beat every computed floor/ceiling.
    pub price_floor_override: Option<i64>,
    pub price_ceiling_override: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmartAction {
    Raise,
    Trim,
    Hold,
    /// Would compete lower, but a price war is active — sit out at the floor.
    WaitOutWar,
    /// Would reprice lower, but that breaches the cost floor — hold above cost.
    HoldAboveCost,
    /// Not enough trustworthy data to manage this listing.
    InsufficientData,
}

impl SmartAction {
    pub fn as_str(self) -> &'static str {
        match self {
            SmartAction::Raise => "raise",
            SmartAction::Trim => "trim",
            SmartAction::Hold => "hold",
            SmartAction::WaitOutWar => "wait_out_war",
            SmartAction::HoldAboveCost => "hold_above_cost",
            SmartAction::InsufficientData => "insufficient_data",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SmartDecision {
    pub target_price: i64,
    pub action: SmartAction,
    /// True when the target differs from the current price by more than the hysteresis band and
    /// the EV gain is meaningful — i.e. the caller should actually apply it.
    pub should_change: bool,
    /// True when we have the data needed to act (a fair-value zone). False only for
    /// `InsufficientData` — the caller must then treat it as informational, never auto-act.
    /// Note: low *confidence* (e.g. slightly stale analytics) deliberately does NOT block here —
    /// the hard guardrails (cost floor, price-war brake, max-step, zone bounds, rate limits) are
    /// what keep an auto-change safe, and gating on staleness silently disabled the feature.
    pub auto_allowed: bool,
    pub floor: i64,
    pub ceiling: i64,
    pub ev_before: f64,
    pub ev_after: f64,
    /// Machine-readable driver tags for building a localized reason on the frontend.
    pub reason_code: String,
}

/// How far the fair-value zone may diverge from the live floor before we stop trusting it.
/// How far a fragile lead can be discounted. A lead that evaporates in minutes is worth much
/// less than a durable one, but never worthless — we still sell some of the time.
const MIN_LEAD_DURABILITY: f64 = 0.25;
/// Demand evidence is deliberately mild: buy orders are usually lowball, so they must never be
/// able to drag a price down on their own.
const DEMAND_SWING: f64 = 0.15;

const ZONE_SANITY_FACTOR: f64 = 2.5;
/// Bounds on the learned sell-time correction, so a small or noisy sample can't run away.
const MIN_CALIBRATION: f64 = 0.5;
const MAX_CALIBRATION: f64 = 2.0;

const ABS_MIN_PRICE: i64 = 1;

fn round_f64(value: f64) -> i64 {
    value.round() as i64
}

/// Sell-probability model: monotonically decreasing in the estimated hours-to-sell at a given
/// queue position. `1 / (1 + eta/horizon)` — eta 0 → ~1.0, eta == horizon → 0.5.
fn sell_probability(units_ahead: i64, daily_volume: Option<f64>, horizon_hours: f64) -> f64 {
    let velocity = daily_volume.unwrap_or(1.0).max(0.05);
    let eta_hours = ((units_ahead.max(0) as f64) + 1.0) / velocity * 24.0;
    1.0 / (1.0 + eta_hours / horizon_hours.max(1.0))
}

/// Our queue position at `price`: competitors priced at or below us are served first (strictly
/// cheaper are ahead; a tie at our exact price is first-come, so counts as ahead too). This is
/// what makes undercutting by 1 beat matching — matching leaves the tied seller ahead of us.
fn units_ahead_at(price: i64, competitor_prices: &[i64]) -> i64 {
    competitor_prices.iter().filter(|&&p| p <= price).count() as i64
}

/// Expected value of listing at `price`: margin over cost × probability of selling. When cost is
/// unknown we optimize revenue × sell-prob (still favors a real sale over a stale high price).
/// How likely a buyer is to take *your* listing given how far above the cheapest one it sits.
///
/// Queue position alone is not enough: if every competitor is under 77p, then 78p and 150p have
/// the identical "units ahead" count, yet 150p is effectively unsellable. Without this term the
/// model rates them equally and then prefers the higher price for margin — which is exactly how a
/// wildly overpriced listing ends up refusing to trim ("gain is too little"). Decays sharply:
/// at market → 1.0, ~15% over → ~0.5, ~50% over → ~0.08.
fn price_competitiveness(price: i64, market_low: Option<i64>) -> f64 {
    match market_low {
        Some(low) if low > 0 && price > low => {
            let over_fraction = (price - low) as f64 / low as f64;
            1.0 / (1.0 + (over_fraction / 0.15).powi(2))
        }
        _ => 1.0,
    }
}

/// How much of the selling horizon we actually keep a lead won by undercutting. A seller who
/// re-lists r times an hour takes roughly 1/r hours to undercut us back; over a horizon of h
/// hours we hold the lead for about (1/r)/h of it. Only applies when we're taking the lead —
/// sitting above the floor was never relying on a lead in the first place.
fn lead_durability(
    price: i64,
    competitor_prices: &[i64],
    floor_defender_rate: Option<f64>,
    horizon_hours: f64,
) -> f64 {
    let Some(rate) = floor_defender_rate else {
        return 1.0;
    };
    let Some(&market_low) = competitor_prices.first() else {
        return 1.0;
    };
    if price >= market_low || rate <= 0.0 || horizon_hours <= 0.0 {
        return 1.0;
    }
    let hours_of_lead = 1.0 / rate;
    (hours_of_lead / horizon_hours).clamp(MIN_LEAD_DURABILITY, 1.0)
}

/// Gentle demand signal: the share of live buy orders willing to pay at least this price. With no
/// buy orders at all this is neutral — an empty bid book is normal and proves nothing.
fn demand_support(price: i64, buy_prices: &[i64]) -> f64 {
    if buy_prices.is_empty() {
        return 1.0;
    }
    let supporting = buy_prices.iter().filter(|&&bid| bid >= price).count() as f64;
    let share = supporting / buy_prices.len() as f64;
    1.0 - DEMAND_SWING + (2.0 * DEMAND_SWING * share)
}

/// Expected value of listing at `price`: what we'd make, times how likely we are to actually
/// make it. Every term is a separate piece of evidence — queue position, how far above the floor
/// we are, whether a lead would survive, and whether anyone is bidding near this price.
fn expected_value(price: i64, inputs: &SmartInputs, horizon_hours: f64) -> f64 {
    let margin = (price - inputs.cost_basis.unwrap_or(0)) as f64;
    if margin <= 0.0 {
        return 0.0;
    }
    let competitor_prices = &inputs.competitor_prices;
    let units_ahead = units_ahead_at(price, competitor_prices);
    let market_low = competitor_prices.first().copied();
    margin
        * sell_probability(units_ahead, inputs.daily_volume, horizon_hours)
        * price_competitiveness(price, market_low)
        * lead_durability(price, competitor_prices, inputs.floor_defender_rate, horizon_hours)
        * demand_support(price, &inputs.buy_prices)
}

/// The lowest price we'll accept given a cost basis and a percentage margin requirement.
fn cost_floor_price(cost_basis: i64, min_margin_pct: f64) -> i64 {
    (cost_basis as f64 * (1.0 + min_margin_pct / 100.0)).round() as i64
}

/// The heart of Smart Manage. Given a listing and its market, returns the profit-maximizing
/// price and the action to get there, with all guardrails applied.
/// Corrects the modelled sell horizon with what actually happened to this user's listings.
/// `sell_time_calibration` is median(actual / predicted) hours: >1 means the model has been
/// over-optimistic about how fast things sell, so we shrink the horizon to make the sell
/// probabilities honest. Clamped hard so a noisy sample can never distort pricing wildly.
fn effective_horizon(inputs: &SmartInputs, params: &SmartParams) -> f64 {
    match inputs.sell_time_calibration {
        Some(k) if k.is_finite() && k > 0.0 => {
            params.sell_horizon_hours / k.clamp(MIN_CALIBRATION, MAX_CALIBRATION)
        }
        _ => params.sell_horizon_hours,
    }
}

/// True when the fair-value zone and the live order book disagree so badly that the zone can't
/// be trusted — almost always stale or thin-market analytics. Repricing to a fantasy number is
/// far worse than doing nothing, so we treat this as "no usable data" rather than acting on it.
fn zone_conflicts_with_market(zone_low: f64, zone_high: f64, market_low: Option<i64>) -> bool {
    match market_low {
        Some(low) if low > 0 => {
            let low = low as f64;
            zone_low > low * ZONE_SANITY_FACTOR || zone_high < low / ZONE_SANITY_FACTOR
        }
        _ => false,
    }
}

pub fn smart_target(inputs: &SmartInputs, params: &SmartParams) -> SmartDecision {
    let current = inputs.your_price;
    let confidence = inputs.confidence_level.to_ascii_lowercase();
    let horizon = effective_horizon(inputs, params);

    // Insufficient data → never auto-manage. We need a fair-value zone to anchor against.
    let (zone_low, zone_high) = match (inputs.exit_zone_low, inputs.exit_zone_high) {
        (Some(low), Some(high)) if high > 0.0 => (low, high),
        _ => {
            return SmartDecision {
                target_price: current,
                action: SmartAction::InsufficientData,
                should_change: false,
                auto_allowed: false,
                floor: current,
                ceiling: current,
                ev_before: 0.0,
                ev_after: 0.0,
                reason_code: "no_zone".to_string(),
            };
        }
    };

    // The zone is the anchor for every decision below it, so it gets one cross-check against
    // reality before we trust it. A zone that flatly contradicts the live book is stale.
    if zone_conflicts_with_market(zone_low, zone_high, inputs.competitor_prices.first().copied()) {
        return SmartDecision {
            target_price: current,
            action: SmartAction::InsufficientData,
            should_change: false,
            auto_allowed: false,
            floor: current,
            ceiling: current,
            ev_before: 0.0,
            ev_after: 0.0,
            reason_code: "zone_conflicts_market".to_string(),
        };
    }

    // ---- Floor: the price we will never go below. Cost basis is a HARD wall when known. ----
    let zone_floor = round_f64(zone_low);
    let cost_floor = inputs
        .cost_basis
        .map(|cost| cost_floor_price(cost, params.min_margin_pct));
    let floor = [
        Some(zone_floor),
        cost_floor,
        inputs.price_floor_override,
        Some(ABS_MIN_PRICE),
    ]
    .into_iter()
    .flatten()
    .max()
    .unwrap_or(ABS_MIN_PRICE);

    // ---- Ceiling: fair-value top, nudged up when we're the only seller / demand is strong. ----
    let mut ceiling = round_f64(zone_high);
    if inputs.is_only_seller || inputs.buy_depth >= 8 {
        ceiling = round_f64(zone_high * 1.05);
    }
    if let Some(cap) = inputs.price_ceiling_override {
        ceiling = ceiling.min(cap);
    }
    ceiling = ceiling.max(floor);

    // Market has crashed below our cost floor: we can't both respect cost and undercut. Hold.
    if let Some(cost) = inputs.cost_basis {
        let market_low = inputs.competitor_prices.first().copied();
        if let Some(low) = market_low {
            if low < cost_floor_price(cost, params.min_margin_pct) && floor > low {
                let target = current.max(floor).min(ceiling.max(floor));
                return SmartDecision {
                    target_price: target,
                    action: SmartAction::HoldAboveCost,
                    should_change: target != current,
                    auto_allowed: true,
                    floor,
                    ceiling,
                    ev_before: expected_value(current, inputs, horizon),
                    ev_after: expected_value(target, inputs, horizon),
                    reason_code: "market_below_cost".to_string(),
                };
            }
        }
    }

    // ---- Price-war brake: during an active race to the bottom the live book is falling faster
    //      than a static EV read can see, so both chasing down and sitting way up are traps.
    //      Hold where we are (clamped to the band) and wait it out. ----
    let is_price_war = inputs.undercut_velocity.unwrap_or(0.0) >= params.price_war_threshold;
    if is_price_war {
        let held = current.clamp(floor, ceiling);
        let ev_now = expected_value(current, inputs, horizon);
        return SmartDecision {
            target_price: held,
            action: SmartAction::WaitOutWar,
            should_change: false,
            auto_allowed: true,
            floor,
            ceiling,
            ev_before: ev_now,
            ev_after: expected_value(held, inputs, horizon),
            reason_code: "price_war".to_string(),
        };
    }

    // When there's a competitor priced above us, we never voluntarily raise *past* them — the
    // best a raise does is sit 1 under the cheapest seller above us (stay the price leader while
    // capturing the gap). This is the "raise by 3 to sit just under the 2nd-cheapest" behavior
    // and it's what stops the model from leapfrogging into a worse queue position.
    let next_above = inputs
        .competitor_prices
        .iter()
        .copied()
        .find(|&p| p > current);
    let raise_cap = match next_above {
        Some(n) => (n - 1).clamp(floor, ceiling),
        None => ceiling,
    };

    // ---- Candidate prices to evaluate, all clamped into [floor, raise_cap]. ----
    let mut candidates: Vec<i64> = vec![current, floor, raise_cap];
    if let Some(&l1) = inputs.competitor_prices.first() {
        candidates.push(l1); // match the floor seller
        candidates.push(l1 - 1); // undercut by 1
    }
    // Normalize: clamp to band, drop non-positive, dedupe.
    let mut seen = std::collections::BTreeSet::new();
    let candidates: Vec<i64> = candidates
        .into_iter()
        .map(|p| p.clamp(floor, raise_cap.max(floor)))
        .filter(|&p| p >= ABS_MIN_PRICE)
        .filter(|p| seen.insert(*p))
        .collect();

    // ---- Pick the expected-value maximizer. On a tie, prefer the price closest to our current
    //      one (least churn), then the higher price (more margin). ----
    let _ = params.undercuts_to_lead; // aggressiveness influences horizon; lead-undercut handled by EV
    let ev_before = expected_value(current, inputs, horizon);
    let mut best = current;
    let mut best_ev = ev_before;
    for &candidate in &candidates {
        let ev = expected_value(candidate, inputs, horizon);
        if ev > best_ev + 1e-9 {
            best = candidate;
            best_ev = ev;
        } else if (ev - best_ev).abs() <= 1e-9 {
            let cand_dist = (candidate - current).abs();
            let best_dist = (best - current).abs();
            if cand_dist < best_dist || (cand_dist == best_dist && candidate > best) {
                best = candidate;
                best_ev = ev;
            }
        }
    }
    let mut target = best;

    // ---- Max single-step clamp: a bad read can't move the price too far at once. The band clamp
    //      wins over the step cap, so a sub-floor listing can still climb straight to the floor. ----
    // Keep the unclamped optimum: the step cap limits how far we move per cycle, but the
    // *decision* must be judged against the real target. Judging the clamped step instead can
    // veto its own progress — a badly overpriced listing clamps to a price that's still worse
    // than standing still, so the EV check refuses it and the listing freezes forever.
    let optimal = target;
    let ev_optimal = expected_value(optimal, inputs, horizon);

    // A listing sitting far above fair value shouldn't need a dozen cycles to become sellable, so
    // the step cap stretches with the size of the correction. Deliberately downward-only: a trim
    // moves toward the live book, which we can see and sanity-check, while a raise moves away
    // from it on the strength of the zone alone — and when we're the only seller there are no
    // competitor prices to catch a bad zone. Big moves are only allowed toward evidence.
    let gap_pct = if current > 0 {
        (optimal - current).abs() as f64 / current as f64
    } else {
        0.0
    };
    let step_pct = if optimal < current && gap_pct > 0.25 {
        params.max_step_pct_far.max(params.max_step_pct)
    } else {
        params.max_step_pct
    };
    let max_step = (current as f64 * step_pct).round() as i64;
    if max_step > 0 {
        target = target.clamp(current - max_step, current + max_step);
    }
    target = target.clamp(floor, raise_cap.max(floor));

    let ev_after = expected_value(target, inputs, horizon);

    // ---- Action + change decision. ----
    let action = if target > current {
        SmartAction::Raise
    } else if target < current {
        SmartAction::Trim
    } else {
        SmartAction::Hold
    };

    // Judge the gap to the true optimum (not the capped step), but still require that this
    // cycle actually moves the price — so we converge over several steps instead of stalling.
    let move_abs = (optimal - current).abs();
    let hysteresis = params
        .hysteresis_abs
        .max((current as f64 * params.hysteresis_pct).round() as i64);
    let should_change =
        move_abs >= hysteresis.max(1) && ev_optimal > ev_before + 1e-6 && target != current;

    let reason_code = match action {
        SmartAction::Raise if inputs.is_only_seller => "raise_only_seller",
        SmartAction::Raise => "raise_capture_gap",
        SmartAction::Trim => "trim_to_compete",
        _ => "hold_optimal",
    }
    .to_string();

    SmartDecision {
        target_price: target,
        action,
        should_change,
        auto_allowed: true,
        floor,
        ceiling,
        ev_before,
        ev_after,
        reason_code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn balanced() -> SmartParams {
        SmartParams::from_settings(Aggressiveness::Balanced, 0.0)
    }

    fn base(your_price: i64) -> SmartInputs {
        SmartInputs {
            your_price,
            cost_basis: None,
            competitor_prices: vec![],
            exit_zone_low: Some(15.0),
            exit_zone_high: Some(30.0),
            daily_volume: Some(6.0),
            undercut_velocity: None,
            buy_depth: 2,
            confidence_level: "high".to_string(),
            sell_time_calibration: None,
            floor_defender_rate: None,
            buy_prices: Vec::new(),
            price_floor_override: None,
            price_ceiling_override: None,
            is_only_seller: false,
        }
    }

    #[test]
    fn raises_into_a_gap_when_we_are_the_cheap_floor() {
        // We're at 20, next seller is at 24 → sit at 23, capture the spread.
        let mut inputs = base(20);
        inputs.competitor_prices = vec![24, 26, 30];
        let d = smart_target(&inputs, &balanced());
        assert_eq!(d.action, SmartAction::Raise);
        assert_eq!(d.target_price, 23);
        assert!(d.should_change);
    }

    #[test]
    fn only_seller_prices_up_toward_the_ceiling() {
        // Alone in the market → climb toward the ceiling (gated by the per-step cap, so it
        // ratchets up over cycles rather than jumping).
        let mut inputs = base(20);
        inputs.competitor_prices = vec![];
        inputs.is_only_seller = true;
        let d = smart_target(&inputs, &balanced());
        assert_eq!(d.action, SmartAction::Raise);
        assert!(d.target_price > 20, "should move up, got {}", d.target_price);
        assert!(d.should_change);
    }

    #[test]
    fn never_prices_below_confident_cost_basis() {
        // Cost 25, market has dropped to 18 — the hard floor forbids going below 25.
        let mut inputs = base(28);
        inputs.cost_basis = Some(25);
        inputs.competitor_prices = vec![18, 19, 20];
        let d = smart_target(&inputs, &balanced());
        assert!(d.target_price >= 25, "breached cost floor: {}", d.target_price);
        assert_eq!(d.action, SmartAction::HoldAboveCost);
    }

    #[test]
    fn holds_out_of_a_price_war_instead_of_chasing_down() {
        let mut inputs = base(26);
        inputs.competitor_prices = vec![22, 23, 24];
        inputs.undercut_velocity = Some(0.9); // active war
        let d = smart_target(&inputs, &balanced());
        assert_eq!(d.action, SmartAction::WaitOutWar);
        assert!(!d.should_change);
        assert!(d.target_price >= inputs.your_price.min(d.ceiling));
    }

    #[test]
    fn trims_toward_market_when_buried_and_its_worth_it() {
        // Slow-moving item, buried behind many cheaper sellers: being 6th in a thin market means
        // a very long wait, so trimming to compete beats holding high.
        let mut inputs = base(29);
        inputs.competitor_prices = vec![20, 21, 22, 23, 24];
        inputs.daily_volume = Some(1.0);
        let d = smart_target(&inputs, &balanced());
        assert_eq!(d.action, SmartAction::Trim);
        assert!(d.target_price < 29 && d.target_price >= d.floor);
    }

    #[test]
    fn trims_a_wildly_overpriced_listing_that_would_never_sell() {
        // Real case: market floor 77p, listed at 150p. Every competitor is below both 78p and
        // 150p, so queue position alone rates them identically and the old model preferred 150p
        // for margin — the listing froze with "gain is too little". It must now trim.
        let mut inputs = base(150);
        inputs.competitor_prices = vec![77, 80, 85, 90];
        inputs.exit_zone_low = Some(70.0);
        inputs.exit_zone_high = Some(95.0);
        let d = smart_target(&inputs, &balanced());
        assert_eq!(d.action, SmartAction::Trim, "target was {}", d.target_price);
        assert!(d.should_change, "must act; target {}", d.target_price);
        // It drops straight into the fair-value band (the zone ceiling wins over the step cap —
        // the zone is a well-established bound, so entering it immediately is safe and faster),
        // then converges toward the optimum on later cycles.
        assert!(d.target_price < 150, "must come down, got {}", d.target_price);
        assert!(d.target_price <= d.ceiling, "must not exceed fair value");
        assert!(d.target_price >= d.floor, "must respect the floor");
    }

    #[test]
    fn overpriced_listing_keeps_converging_across_cycles() {
        // Following on from the case above: from 120p it must keep stepping down, not stall.
        let mut inputs = base(120);
        inputs.competitor_prices = vec![77, 80, 85, 90];
        inputs.exit_zone_low = Some(70.0);
        inputs.exit_zone_high = Some(95.0);
        let d = smart_target(&inputs, &balanced());
        assert_eq!(d.action, SmartAction::Trim);
        assert!(d.should_change);
        assert!(d.target_price < 120, "should keep descending, got {}", d.target_price);
    }

    #[test]
    fn holds_when_already_near_optimal() {
        // Already sitting just under the next seller — nothing meaningful to gain.
        let mut inputs = base(23);
        inputs.competitor_prices = vec![24, 26, 30];
        let d = smart_target(&inputs, &balanced());
        assert!(!d.should_change, "should hold, targeted {}", d.target_price);
    }

    #[test]
    fn will_not_undercut_a_floor_defended_by_an_active_repricer() {
        // Floor seller re-lists ~6x/hour: a lead won by undercutting is gone in ten minutes.
        let mut inputs = base(24);
        inputs.competitor_prices = vec![22, 26, 30];
        let passive = smart_target(&inputs, &balanced());
        inputs.floor_defender_rate = Some(6.0);
        let defended = smart_target(&inputs, &balanced());
        assert!(
            defended.target_price >= passive.target_price,
            "a fragile lead should not be bought more eagerly than a durable one ({} vs {})",
            defended.target_price,
            passive.target_price
        );
    }

    #[test]
    fn lead_durability_is_neutral_when_we_are_not_taking_the_lead() {
        // Priced above the floor, so we were never relying on a lead — the defender is irrelevant.
        let inputs = base(30);
        assert_eq!(lead_durability(30, &[22, 26], Some(10.0), 36.0), 1.0);
        assert_eq!(lead_durability(30, &[], Some(10.0), 36.0), 1.0);
        let _ = inputs;
    }

    #[test]
    fn demand_support_is_neutral_without_bids_and_rewards_real_ones() {
        assert_eq!(demand_support(50, &[]), 1.0);
        // Every bid is at or above 20 → full support; none reach 500 → minimum support.
        assert!(demand_support(20, &[40, 30, 25]) > demand_support(500, &[40, 30, 25]));
        assert!(demand_support(500, &[40, 30, 25]) >= 1.0 - DEMAND_SWING - f64::EPSILON);
    }

    #[test]
    fn a_per_listing_ceiling_caps_the_price() {
        let mut inputs = base(20);
        inputs.exit_zone_high = Some(60.0);
        inputs.is_only_seller = true;
        inputs.price_ceiling_override = Some(22);
        let d = smart_target(&inputs, &balanced());
        assert!(d.target_price <= 22, "ceiling override ignored: {}", d.target_price);
    }

    #[test]
    fn a_per_listing_floor_beats_the_computed_floor() {
        let mut inputs = base(40);
        inputs.competitor_prices = vec![20, 21, 22];
        inputs.exit_zone_low = Some(18.0);
        inputs.exit_zone_high = Some(30.0);
        inputs.price_floor_override = Some(35);
        let d = smart_target(&inputs, &balanced());
        assert!(d.target_price >= 35, "floor override ignored: {}", d.target_price);
        assert!(d.floor >= 35);
    }

    #[test]
    fn distrusts_a_zone_that_contradicts_the_live_book() {
        // Analytics claim fair value is 80-95 while the entire book sits at 20. Stale zone —
        // repricing up to a fantasy number is worse than doing nothing.
        let mut inputs = base(25);
        inputs.exit_zone_low = Some(80.0);
        inputs.exit_zone_high = Some(95.0);
        inputs.competitor_prices = vec![20, 21, 22];
        let d = smart_target(&inputs, &balanced());
        assert_eq!(d.action, SmartAction::InsufficientData);
        assert_eq!(d.reason_code, "zone_conflicts_market");
        assert!(!d.auto_allowed);
    }

    #[test]
    fn a_zone_broadly_agreeing_with_the_book_is_still_trusted() {
        let mut inputs = base(25);
        inputs.exit_zone_low = Some(18.0);
        inputs.exit_zone_high = Some(30.0);
        inputs.competitor_prices = vec![20, 21, 22];
        let d = smart_target(&inputs, &balanced());
        assert_ne!(d.action, SmartAction::InsufficientData);
    }

    #[test]
    fn a_badly_mispriced_listing_gets_a_larger_single_step() {
        // 150 against a 70-95 zone: the stretched step cap must beat the plain 20% cap (>=30 off).
        let mut inputs = base(150);
        inputs.exit_zone_low = Some(70.0);
        inputs.exit_zone_high = Some(95.0);
        inputs.competitor_prices = vec![77, 80, 88];
        let d = smart_target(&inputs, &balanced());
        assert!(d.should_change);
        assert!(
            150 - d.target_price > 30,
            "expected a stretched step, got {}",
            d.target_price
        );
    }

    #[test]
    fn calibration_shrinks_the_horizon_when_sales_run_slower_than_predicted() {
        let mut fast = base(28);
        fast.competitor_prices = vec![20, 22, 24];
        let mut slow = fast.clone();
        slow.sell_time_calibration = Some(2.0); // reality is twice as slow as modelled
        let uncalibrated = smart_target(&fast, &balanced());
        let calibrated = smart_target(&slow, &balanced());
        // A pessimistic sell model should never price *higher* than the optimistic one.
        assert!(calibrated.target_price <= uncalibrated.target_price);
    }

    #[test]
    fn insufficient_data_without_a_zone_never_auto_manages() {
        let mut inputs = base(20);
        inputs.exit_zone_low = None;
        inputs.exit_zone_high = None;
        let d = smart_target(&inputs, &balanced());
        assert_eq!(d.action, SmartAction::InsufficientData);
        assert!(!d.auto_allowed);
        assert!(!d.should_change);
    }

    #[test]
    fn low_confidence_does_not_block_when_a_zone_exists() {
        // Slightly stale analytics grade as "low" confidence, but we still have a fair-value
        // zone and a live book — the hard guardrails cover safety, so this must stay actionable.
        // (Gating on staleness here silently disabled auto-repricing entirely.)
        let mut inputs = base(20);
        inputs.competitor_prices = vec![24, 26];
        inputs.confidence_level = "low".to_string();
        let d = smart_target(&inputs, &balanced());
        assert!(d.auto_allowed);
        assert_eq!(d.action, SmartAction::Raise);
        assert!(d.should_change);
    }

    #[test]
    fn max_step_caps_a_single_move() {
        // Huge upside, but a *raise* can never exceed 20% of the current price (20 → ≤24) —
        // only trims get the stretched cap, since they move toward observable market evidence.
        let mut inputs = base(20);
        inputs.exit_zone_high = Some(100.0);
        inputs.is_only_seller = true;
        let d = smart_target(&inputs, &balanced());
        assert!(d.target_price <= 24, "step too large: {}", d.target_price);
        assert!(d.target_price > 20);
    }
}
