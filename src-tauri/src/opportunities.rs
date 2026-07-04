//! The Opportunities engine — turns the app's caches into a ranked board of concrete, explained
//! "what should I do now" plays.
//!
//! The headline detector is the **Set Decision Engine**: for every set the user owns at least one
//! part of, it compares three strategies and recommends the best one —
//!   A. Complete by buying the missing parts, then sell the assembled set.
//!   B. Sell the parts you already own individually (don't complete).
//!   C. Complete by farming a missing part you own relics for (treated as ~0 plat cost).
//! The recommendation is `max(A, B, C)`, and the reasons spell out the comparison so it's
//! trustworthy.
//!
//! All inputs come from already-persisted caches (the arbitrage scanner, the owned-parts store,
//! cached exit prices) — the engine makes **no** WFM calls. The economic logic lives in the pure,
//! unit-tested `evaluate_set` function; data gathering is isolated in `compute_opportunities`.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{OnceLock, RwLock};

/// A single, actionable, explained play surfaced on the Opportunities board. Every detector emits
/// this shape, so the board, scoring, and UI never need to special-case a detector.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Opportunity {
    /// Stable id (e.g. `set-complete:wisp_prime_set`) for dedupe / dismiss / live-update.
    pub id: String,
    /// Stable key for the underlying SUBJECT (a set, a holding) that survives the recommendation
    /// changing — e.g. `set:wisp_prime_set` stays the same whether the play is complete/sell/flip.
    /// Pins track this, so a pinned "complete set" auto-becomes "sell set" once you own the parts.
    pub subject_key: String,
    pub category: String,
    /// i18n key for the title; the frontend interpolates `title_params` into it. Kept as a key
    /// instead of a pre-formatted English string so the UI can render it in any app language.
    pub title_key: String,
    pub title_params: HashMap<String, String>,
    pub subtitle_key: Option<String>,
    pub subtitle_params: HashMap<String, String>,
    pub set_slug: Option<String>,
    pub image_path: Option<String>,
    /// Estimated plat you gain by acting (meaning depends on `value_basis`).
    pub est_value: i64,
    /// Upfront plat needed to act (buy missing parts / the basket). 0 for sell/reprice/farm plays.
    /// Drives the "what can I afford" budget filter.
    pub cost: i64,
    /// `profit` (complete & sell), `liquidation` (sell parts you hold).
    pub value_basis: String,
    /// When the underlying prices were last computed (the scan time) — for a freshness indicator.
    pub priced_at: Option<String>,
    /// 0..1 — how much to trust the numbers (data freshness / liquidity / price completeness).
    pub confidence: f64,
    pub confidence_label: String,
    /// `persistent` | `expiring` | `timed` — set plays are persistent for now.
    pub urgency: String,
    /// The WHY — structured so the UI renders chips and the user can sanity-check.
    pub reasons: Vec<OpportunityReason>,
    pub actions: Vec<OpportunityAction>,
    /// Ranking score. Currently `est_value * confidence`; the future Strategy tab feeds weights in.
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpportunityReason {
    /// Semantic icon key the frontend maps to a glyph (`inventory` | `market` | `relics` | `math`).
    pub icon: String,
    pub text_key: String,
    pub text_params: HashMap<String, String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpportunityAction {
    /// `buyPart` | `sellPart` | `sellSet` | `farmRelic` | `openWfm`.
    pub kind: String,
    pub label_key: String,
    pub label_params: HashMap<String, String>,
    pub item_slug: Option<String>,
    pub item_name: Option<String>,
    /// Suggested whisper / list price in plat, when applicable.
    pub price: Option<i64>,
}

// ---------------------------------------------------------------------------------------------
// Pure evaluator inputs — plain data so the economic logic is unit-testable without DB/Tauri.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SetComponentInput {
    pub slug: String,
    pub name: String,
    pub quantity_in_set: i64,
    pub owned_qty: i64,
    /// Cost to buy one now (live floor, falling back to recommended entry).
    pub buy_price: Option<f64>,
    /// What you'd realise selling one you own (recommended exit).
    pub sell_price: Option<f64>,
    pub liquidity: f64,
    /// A missing copy can be farmed from relics you own → treat its buy cost as ~0 plat.
    pub farmable_from_relics: bool,
}

#[derive(Debug, Clone)]
pub struct SetEvalInput {
    pub set_slug: String,
    pub set_name: String,
    pub image_path: Option<String>,
    /// What you'd sell the assembled set for (recommended exit).
    pub set_sell_price: Option<f64>,
    pub set_liquidity: f64,
    pub components: Vec<SetComponentInput>,
}

#[derive(Debug, Clone)]
pub struct EvalConfig {
    /// Only suggest *completion* when at most this many distinct parts are missing (≈ "close").
    pub max_missing_distinct: i64,
    /// Ignore an edge (completing vs. selling parts) smaller than this.
    pub min_edge_plat: f64,
    /// Assumed plat value of one WFM trade slot — trades are a scarce, rate-limited resource, so
    /// completing a set that costs fewer total trades than selling its parts individually should
    /// win on a smaller profit edge (or even a slightly negative one), and vice versa.
    pub trade_value_plat: f64,
    /// Ignore opportunities worth less than this.
    pub min_value_plat: f64,
    /// A held position must be up at least this fraction of its cost to flag a "good exit".
    pub holding_min_profit_pct: f64,
    /// …and up at least this many plat in absolute terms.
    pub holding_min_profit_plat: i64,
    /// A speculative set flip (buy all parts → sell set) needs at least this ROI to be worth it.
    pub flip_min_roi_pct: f64,
    /// …and at least this liquidity (0–100) so the set actually sells.
    pub flip_min_liquidity: f64,
    /// An active listing is "overpriced" once it's at least this ratio above where the item sells.
    pub reprice_overpriced_ratio: f64,
    /// …and at least this many plat above it (ignore tiny gaps).
    pub reprice_min_gap: i64,
    /// A held, unlisted position is "stale" once it's been sitting at least this many days.
    pub stale_hold_min_days: i64,
    /// Max cards on the board — a quest board, not a data dump.
    pub board_cap: usize,
    /// Per-category weight decay each time a category is picked, so the board interleaves play
    /// types instead of showing all set-completions then all sells. 1.0 = pure score order; lower
    /// = more variety. The future Strategy tab tunes this.
    pub diversity_factor: f64,
}

impl Default for EvalConfig {
    fn default() -> Self {
        // Balanced defaults; the future Strategy tab will let the user tune these.
        Self {
            max_missing_distinct: 2,
            min_edge_plat: 10.0,
            trade_value_plat: 10.0,
            min_value_plat: 15.0,
            holding_min_profit_pct: 0.25,
            holding_min_profit_plat: 15,
            flip_min_roi_pct: 0.35,
            flip_min_liquidity: 45.0,
            reprice_overpriced_ratio: 1.15,
            reprice_min_gap: 5,
            stale_hold_min_days: 21,
            board_cap: 15,
            diversity_factor: 0.7,
        }
    }
}

/// A slim snapshot of an active sell listing, cached when the Trades overview is built so the
/// engine can judge mispricing without a live WFM fetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSellOrder {
    pub order_id: String,
    pub slug: String,
    pub name: String,
    pub image_path: Option<String>,
    pub item_id: Option<i64>,
    pub rank: Option<i64>,
    pub your_price: i64,
    pub visible: bool,
}

/// Flags an active sell listing priced well above where the item actually sells — it's just
/// sitting there. Recommends lowering toward the realistic price to actually move it.
pub fn evaluate_reprice(
    order: &CachedSellOrder,
    recommended_exit: i64,
    config: &EvalConfig,
) -> Option<Opportunity> {
    if !order.visible || recommended_exit <= 0 || order.your_price <= recommended_exit {
        return None;
    }
    let gap = order.your_price - recommended_exit;
    let ratio = order.your_price as f64 / recommended_exit as f64;
    if ratio < config.reprice_overpriced_ratio
        || gap < config.reprice_min_gap
        || recommended_exit < config.min_value_plat as i64
    {
        return None;
    }

    let confidence = 0.6;
    Some(Opportunity {
        id: format!("reprice:{}", order.order_id),
        subject_key: format!("order:{}", order.order_id),
        category: "reprice".into(),
        title_key: "opp.repriceTitle".into(),
        title_params: params(&[("name", order.name.clone())]),
        subtitle_key: Some("opp.repriceSubtitle".into()),
        subtitle_params: HashMap::new(),
        set_slug: None,
        image_path: order.image_path.clone(),
        est_value: recommended_exit,
        cost: 0,
        value_basis: "unlock".into(),
        priced_at: None,
        confidence,
        confidence_label: confidence_label(confidence).into(),
        urgency: "persistent".into(),
        reasons: vec![
            OpportunityReason {
                icon: "market".into(),
                text_key: "opp.reasonListedVsSells".into(),
                text_params: params(&[
                    ("price", order.your_price.to_string()),
                    ("exit", recommended_exit.to_string()),
                ]),
                source: "market".into(),
            },
            OpportunityReason {
                icon: "math".into(),
                text_key: "opp.reasonOverByGap".into(),
                text_params: params(&[("gap", gap.to_string())]),
                source: "market".into(),
            },
        ],
        actions: vec![OpportunityAction {
            kind: "editOrder".into(),
            label_key: "opp.actionEditListing".into(),
            label_params: HashMap::new(),
            item_slug: Some(order.slug.clone()),
            item_name: Some(order.name.clone()),
            price: Some(recommended_exit),
        }],
        score: recommended_exit as f64 * confidence,
    })
}

/// A speculative set flip (own none of it; buy all parts, build, sell the set), for the market
/// "lucky find" detector.
#[derive(Debug, Clone)]
pub struct FlipInput {
    pub set_slug: String,
    pub set_name: String,
    pub image_path: Option<String>,
    pub component_count: i64,
    /// Cost to buy the whole basket of parts now.
    pub basket_entry_cost: Option<f64>,
    /// What the assembled set sells for.
    pub set_sell_price: Option<f64>,
    pub liquidity: f64,
}

/// Flags a set whose parts are cheap enough vs. the assembled set to flip for profit. Speculative
/// (you must buy every part), so it's gated hard on ROI + liquidity and rated low confidence.
pub fn evaluate_set_flip(flip: &FlipInput, config: &EvalConfig) -> Option<Opportunity> {
    let cost = flip.basket_entry_cost?;
    let sell = flip.set_sell_price?;
    if cost <= 0.0 {
        return None;
    }
    let margin = sell - cost;
    let roi = margin / cost;
    if margin < config.min_value_plat
        || roi < config.flip_min_roi_pct
        || flip.liquidity < config.flip_min_liquidity
    {
        return None;
    }

    // Discounted vs. owned-item plays — full-basket execution risk + it's not personal.
    let confidence = ((flip.liquidity / 100.0) * 0.7).clamp(0.0, 0.7);
    let est_value = round_plat(margin);

    Some(Opportunity {
        id: format!("set-flip:{}", flip.set_slug),
        subject_key: format!("set:{}", flip.set_slug),
        category: "flip".into(),
        title_key: "opp.flipTitle".into(),
        title_params: params(&[("name", flip.set_name.clone())]),
        subtitle_key: Some("opp.flipSubtitle".into()),
        subtitle_params: params(&[("n", flip.component_count.to_string())]),
        set_slug: Some(flip.set_slug.clone()),
        image_path: flip.image_path.clone(),
        est_value,
        cost: round_plat(cost),
        value_basis: "profit".into(),
        priced_at: None,
        confidence,
        confidence_label: confidence_label(confidence).into(),
        urgency: "persistent".into(),
        reasons: vec![
            OpportunityReason {
                icon: "math".into(),
                text_key: "opp.reasonPartsCostVsSell".into(),
                text_params: params(&[
                    ("cost", round_plat(cost).to_string()),
                    ("sell", round_plat(sell).to_string()),
                    ("roi", ((roi * 100.0).round() as i64).to_string()),
                ]),
                source: "market".into(),
            },
            OpportunityReason {
                icon: "market".into(),
                text_key: "opp.reasonSpeculative".into(),
                text_params: HashMap::new(),
                source: "market".into(),
            },
        ],
        actions: vec![OpportunityAction {
            kind: "viewItem".into(),
            label_key: "opp.actionViewSetAnalysis".into(),
            label_params: HashMap::new(),
            item_slug: Some(flip.set_slug.clone()),
            item_name: Some(flip.set_name.clone()),
            price: Some(round_plat(sell)),
        }],
        score: est_value as f64 * confidence,
    })
}

/// A currently-held position (an open buy), for the sell-inventory "good exit" detector.
#[derive(Debug, Clone)]
pub struct HoldingInput {
    /// Stable order id (drives the opportunity id).
    pub id: String,
    pub item_name: String,
    pub slug: String,
    pub image_path: Option<String>,
    pub quantity: i64,
    /// `open` (waiting to sell) or `kept` (deliberately held — we don't nudge those).
    pub status: String,
    /// Total plat paid for the position.
    pub cost_basis: i64,
    /// Current total market value of the position.
    pub estimated_value: i64,
}

/// Flags a held position that's appreciated enough to be worth taking profit on. Returns `None`
/// for kept items, positions with no cost basis, or gains below the configured floors.
pub fn evaluate_holding(holding: &HoldingInput, config: &EvalConfig) -> Option<Opportunity> {
    if holding.status != "open" || holding.quantity <= 0 || holding.cost_basis <= 0 {
        return None;
    }
    let profit = holding.estimated_value - holding.cost_basis;
    if profit < config.holding_min_profit_plat {
        return None;
    }
    let pct = profit as f64 / holding.cost_basis as f64;
    if pct < config.holding_min_profit_pct {
        return None;
    }

    let pct_label = (pct * 100.0).round() as i64;
    let unit_price = (holding.estimated_value as f64 / holding.quantity as f64).round() as i64;
    let confidence = 0.6; // No liquidity signal here yet; a steady "Medium".

    Some(Opportunity {
        id: format!("sell-holding:{}", holding.id),
        subject_key: format!("holding:{}", holding.id),
        category: "sellInventory".into(),
        title_key: "opp.sellTitle".into(),
        title_params: params(&[("name", holding.item_name.clone())]),
        subtitle_key: Some("opp.upPctSubtitle".into()),
        subtitle_params: params(&[("pct", pct_label.to_string())]),
        set_slug: None,
        image_path: holding.image_path.clone(),
        est_value: profit,
        cost: 0,
        value_basis: "profit".into(),
        priced_at: None,
        confidence,
        confidence_label: confidence_label(confidence).into(),
        urgency: "persistent".into(),
        reasons: vec![
            OpportunityReason {
                icon: "inventory".into(),
                text_key: "opp.reasonHoldBoughtFor".into(),
                text_params: params(&[
                    ("qty", holding.quantity.to_string()),
                    ("cost", holding.cost_basis.to_string()),
                ]),
                source: "history".into(),
            },
            OpportunityReason {
                icon: "math".into(),
                text_key: "opp.reasonNowWorthUp".into(),
                text_params: params(&[
                    ("value", holding.estimated_value.to_string()),
                    ("profit", profit.to_string()),
                    ("pct", pct_label.to_string()),
                ]),
                source: "market".into(),
            },
        ],
        actions: vec![OpportunityAction {
            kind: "sellPart".into(),
            label_key: "opp.actionSell".into(),
            label_params: params(&[("name", holding.item_name.clone())]),
            item_slug: Some(holding.slug.clone()),
            item_name: Some(holding.item_name.clone()),
            price: Some(unit_price),
        }],
        score: profit as f64 * confidence,
    })
}

/// A held position that may be sitting idle — for the stale-hold nudge.
#[derive(Debug, Clone)]
pub struct StaleHoldInput {
    pub id: String,
    pub item_name: String,
    pub slug: String,
    pub image_path: Option<String>,
    pub quantity: i64,
    pub status: String,
    pub estimated_value: i64,
    pub days_held: i64,
    /// Whether the user already has this item listed for sale (don't nudge if so).
    pub is_listed: bool,
}

/// Nudges the user to list a sellable position they've been sitting on for a while and that isn't
/// already on the market — idle capital. Returns `None` for kept/listed/too-recent/low-value holds.
pub fn evaluate_stale_hold(hold: &StaleHoldInput, config: &EvalConfig) -> Option<Opportunity> {
    if hold.status != "open"
        || hold.quantity <= 0
        || hold.is_listed
        || hold.days_held < config.stale_hold_min_days
        || hold.estimated_value < config.min_value_plat as i64
    {
        return None;
    }

    let unit_price = (hold.estimated_value as f64 / hold.quantity as f64).round() as i64;
    let confidence = 0.5; // We know it's sellable and unlisted, but not how fast it'll move.

    Some(Opportunity {
        id: format!("stale-hold:{}", hold.id),
        subject_key: format!("holding:{}", hold.id),
        category: "sellInventory".into(),
        title_key: "opp.listTitle".into(),
        title_params: params(&[("name", hold.item_name.clone())]),
        subtitle_key: Some("opp.heldDaysSubtitle".into()),
        subtitle_params: params(&[("days", hold.days_held.to_string())]),
        set_slug: None,
        image_path: hold.image_path.clone(),
        est_value: hold.estimated_value,
        cost: 0,
        value_basis: "liquidation".into(),
        priced_at: None,
        confidence,
        confidence_label: confidence_label(confidence).into(),
        urgency: "persistent".into(),
        reasons: vec![
            OpportunityReason {
                icon: "inventory".into(),
                text_key: "opp.reasonHeldNotListed".into(),
                text_params: params(&[
                    ("qty", hold.quantity.to_string()),
                    ("days", hold.days_held.to_string()),
                ]),
                source: "history".into(),
            },
            OpportunityReason {
                icon: "market".into(),
                text_key: "opp.reasonWorthIdle".into(),
                text_params: params(&[("value", hold.estimated_value.to_string())]),
                source: "market".into(),
            },
        ],
        actions: vec![OpportunityAction {
            kind: "sellPart".into(),
            label_key: "opp.actionList".into(),
            label_params: params(&[("name", hold.item_name.clone())]),
            item_slug: Some(hold.slug.clone()),
            item_name: Some(hold.item_name.clone()),
            price: Some(unit_price),
        }],
        score: hold.estimated_value as f64 * confidence,
    })
}

/// Whole days between an RFC3339 timestamp and now (0 if unparseable or in the future).
fn days_since(timestamp: &str) -> i64 {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    match OffsetDateTime::parse(timestamp, &Rfc3339) {
        Ok(then) => (OffsetDateTime::now_utc() - then).whole_days().max(0),
        Err(_) => 0,
    }
}

/// Per-component breakdown of the completion math, used to build reasons/actions.
struct CompletionPlan {
    /// Components still needed to build one set (missing > 0), with per-unit buy cost.
    missing: Vec<MissingPart>,
    /// Total plat to buy everything missing (farmable parts count as 0).
    completion_cost: f64,
    /// True if every missing part had a known price or was farmable.
    fully_priced: bool,
    /// Any missing part is covered by relics the user owns.
    has_farmable: bool,
}

struct MissingPart {
    slug: String,
    name: String,
    qty: i64,
    unit_cost: f64,
    farmable: bool,
}

fn plan_completion(components: &[SetComponentInput]) -> CompletionPlan {
    let mut missing = Vec::new();
    let mut completion_cost = 0.0;
    let mut fully_priced = true;
    let mut has_farmable = false;

    for component in components {
        let toward = component.owned_qty.min(component.quantity_in_set);
        let short = component.quantity_in_set - toward;
        if short <= 0 {
            continue;
        }
        if component.farmable_from_relics {
            has_farmable = true;
            missing.push(MissingPart {
                slug: component.slug.clone(),
                name: component.name.clone(),
                qty: short,
                unit_cost: 0.0,
                farmable: true,
            });
            continue;
        }
        match component.buy_price {
            Some(price) if price > 0.0 => {
                completion_cost += price * short as f64;
                missing.push(MissingPart {
                    slug: component.slug.clone(),
                    name: component.name.clone(),
                    qty: short,
                    unit_cost: price,
                    farmable: false,
                });
            }
            _ => {
                // A missing part with no known price — completion cost is unknowable.
                fully_priced = false;
                missing.push(MissingPart {
                    slug: component.slug.clone(),
                    name: component.name.clone(),
                    qty: short,
                    unit_cost: 0.0,
                    farmable: false,
                });
            }
        }
    }

    CompletionPlan {
        missing,
        completion_cost,
        fully_priced,
        has_farmable,
    }
}

/// Value (plat) of selling the parts that *would be consumed* by completing one set — the
/// apples-to-apples alternative to completing. Returns the value and whether every consumed part
/// was priced.
fn parts_liquidation_value(components: &[SetComponentInput]) -> (f64, bool) {
    let mut value = 0.0;
    let mut fully_priced = true;
    for component in components {
        let consumed = component.owned_qty.min(component.quantity_in_set);
        if consumed <= 0 {
            continue;
        }
        match component.sell_price {
            Some(price) if price > 0.0 => value += price * consumed as f64,
            _ => fully_priced = false,
        }
    }
    (value, fully_priced)
}

/// Builds a param map for an i18n key from `(name, value)` pairs — used for `title_params`,
/// `subtitle_params`, `text_params`, and `label_params` so the frontend can interpolate the
/// English-language key into the user's chosen app language.
fn params(pairs: &[(&str, String)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

fn confidence_label(confidence: f64) -> &'static str {
    if confidence >= 0.75 {
        "High"
    } else if confidence >= 0.45 {
        "Medium"
    } else {
        "Low"
    }
}

fn round_plat(value: f64) -> i64 {
    value.round() as i64
}

/// The Set Decision Engine for a single set. Returns the single best play (complete vs. sell
/// parts) for a set the user has a stake in, or `None` if there's no worthwhile, confident move.
pub fn evaluate_set(input: &SetEvalInput, config: &EvalConfig) -> Option<Opportunity> {
    let owns_any = input.components.iter().any(|c| c.owned_qty > 0);
    if !owns_any {
        return None; // No stake in this set — leave it to the generic market detectors.
    }

    let needed_distinct = input.components.len() as i64;
    let owned_distinct = input
        .components
        .iter()
        .filter(|c| c.owned_qty.min(c.quantity_in_set) > 0)
        .count() as i64;

    let plan = plan_completion(&input.components);
    let missing_distinct = plan.missing.len() as i64;
    let (sell_parts_value, sell_fully_priced) = parts_liquidation_value(&input.components);

    // Liquidity-driven confidence: blend the set's liquidity with the owned components' liquidity.
    let owned_liquidity_avg = {
        let owned: Vec<f64> = input
            .components
            .iter()
            .filter(|c| c.owned_qty > 0)
            .map(|c| c.liquidity)
            .collect();
        if owned.is_empty() {
            input.set_liquidity
        } else {
            owned.iter().sum::<f64>() / owned.len() as f64
        }
    };
    let liquidity_factor = ((input.set_liquidity * 0.6 + owned_liquidity_avg * 0.4) / 100.0)
        .clamp(0.2, 1.0);

    // --- Strategy A/C: complete (by buying and/or farming), then sell the set ---
    // Only viable when we're close to a set, fully priced, and we know the set's sell value.
    let complete_value = if missing_distinct <= config.max_missing_distinct
        && plan.fully_priced
        && input.set_sell_price.is_some()
    {
        Some(input.set_sell_price.unwrap() - plan.completion_cost)
    } else {
        None
    };

    // --- Strategy B: sell the parts you already own ---
    let sell_value = if sell_parts_value > 0.0 {
        Some(sell_parts_value)
    } else {
        None
    };

    // Decide the winner. The min-edge buffer exists to justify the cost/risk of BUYING missing
    // parts — when you already own the full set there's nothing to buy, so building & selling the
    // set wins whenever it's worth at least as much as dumping the parts.
    //
    // Trades are a scarce, rate-limited resource, so the buffer also scales with how many WFM
    // trades each strategy actually costs: selling parts individually costs one trade per distinct
    // owned part, while completing costs one buy per missing non-farmable part plus one final sell.
    // Every trade the completion path SAVES relative to selling parts knocks a `trade_value_plat`
    // chunk off the required edge (floored at 0); every extra trade completion COSTS raises it —
    // e.g. owning 4/5 parts of a set only needs 2 trades to complete (buy + sell) vs. 4 to sell
    // everything individually, so completing should win even on a fairly small profit edge.
    let buy_trades = plan.missing.iter().filter(|part| !part.farmable).count() as i64;
    let complete_trades = buy_trades + 1;
    let sell_trades = owned_distinct;
    let edge_threshold = if missing_distinct == 0 {
        0.0
    } else {
        let trades_saved = sell_trades - complete_trades;
        (config.min_edge_plat - trades_saved as f64 * config.trade_value_plat).max(0.0)
    };
    let prefer_complete = match (complete_value, sell_value) {
        (Some(a), Some(b)) => a >= b + edge_threshold,
        (Some(_), None) => true,
        (None, _) => false,
    };

    if prefer_complete {
        let a = complete_value.unwrap();
        if a < config.min_value_plat {
            return None;
        }
        let edge = sell_value.map(|b| a - b);
        let price_completeness = 1.0; // gated on fully_priced above
        let confidence = (0.55 + 0.45 * liquidity_factor) * price_completeness;
        let confidence = confidence.clamp(0.0, 1.0);

        let mut reasons = vec![OpportunityReason {
            icon: "inventory".into(),
            text_key: "opp.reasonOwnPartsOf".into(),
            text_params: params(&[
                ("owned", owned_distinct.to_string()),
                ("needed", needed_distinct.to_string()),
                ("set", input.set_name.clone()),
            ]),
            source: "inventory".into(),
        }];
        if plan.has_farmable {
            let farm_names: Vec<&str> = plan
                .missing
                .iter()
                .filter(|m| m.farmable)
                .map(|m| m.name.as_str())
                .collect();
            reasons.push(OpportunityReason {
                icon: "relics".into(),
                text_key: "opp.reasonOwnRelicsThatDrop".into(),
                text_params: params(&[("names", farm_names.join(", "))]),
                source: "relics".into(),
            });
        }
        let buy_names: Vec<String> = plan
            .missing
            .iter()
            .filter(|m| !m.farmable)
            .map(|m| format!("{} ({}p)", m.name, round_plat(m.unit_cost * m.qty as f64)))
            .collect();
        if !buy_names.is_empty() {
            reasons.push(OpportunityReason {
                icon: "market".into(),
                text_key: "opp.reasonStillNeed".into(),
                text_params: params(&[("names", buy_names.join(", "))]),
                source: "market".into(),
            });
        }
        reasons.push(match edge {
            Some(b_edge) => OpportunityReason {
                icon: "math".into(),
                text_key: "opp.reasonCompletingNetsVs".into(),
                text_params: params(&[
                    ("a", round_plat(a).to_string()),
                    ("b", round_plat(a - b_edge).to_string()),
                ]),
                source: "market".into(),
            },
            None => OpportunityReason {
                icon: "math".into(),
                text_key: "opp.reasonCompletedSetSells".into(),
                text_params: params(&[
                    ("price", round_plat(input.set_sell_price.unwrap()).to_string()),
                    ("cost", round_plat(plan.completion_cost).to_string()),
                ]),
                source: "market".into(),
            },
        });
        // Surface the trade-count tiebreaker so a completion pick on a slim plat edge is
        // self-evident — trades are rate-limited, and this path may be winning on trades saved.
        if sell_trades > 0 && complete_trades != sell_trades {
            reasons.push(OpportunityReason {
                icon: "math".into(),
                text_key: "opp.reasonTradeCount".into(),
                text_params: params(&[
                    ("complete", complete_trades.to_string()),
                    ("sell", sell_trades.to_string()),
                ]),
                source: "math".into(),
            });
        }

        let mut actions: Vec<OpportunityAction> = plan
            .missing
            .iter()
            .map(|m| {
                if m.farmable {
                    OpportunityAction {
                        kind: "farmRelic".into(),
                        label_key: "opp.actionFarm".into(),
                        label_params: params(&[("name", m.name.clone())]),
                        item_slug: Some(m.slug.clone()),
                        item_name: Some(m.name.clone()),
                        price: None,
                    }
                } else {
                    OpportunityAction {
                        kind: "buyPart".into(),
                        label_key: "opp.actionBuy".into(),
                        label_params: params(&[("name", m.name.clone())]),
                        item_slug: Some(m.slug.clone()),
                        item_name: Some(m.name.clone()),
                        price: Some(round_plat(m.unit_cost)),
                    }
                }
            })
            .collect();
        actions.push(OpportunityAction {
            kind: "sellSet".into(),
            label_key: "opp.actionSellCompletedSet".into(),
            label_params: HashMap::new(),
            item_slug: Some(input.set_slug.clone()),
            item_name: Some(input.set_name.clone()),
            price: input.set_sell_price.map(round_plat),
        });

        let est_value = round_plat(a);
        // Owning a full set's worth of parts → recommend selling the assembled set, not "complete".
        let owns_full_set = missing_distinct == 0;
        return Some(Opportunity {
            id: format!("set-complete:{}", input.set_slug),
            subject_key: format!("set:{}", input.set_slug),
            category: "setCompletion".into(),
            title_key: if owns_full_set {
                "opp.sellCompletedTitle".into()
            } else {
                "opp.completeTitle".into()
            },
            title_params: params(&[("name", input.set_name.clone())]),
            subtitle_key: Some(if owns_full_set {
                "opp.ownFullSetSubtitle".into()
            } else {
                "opp.buyMorePartsSubtitle".into()
            }),
            subtitle_params: if owns_full_set {
                HashMap::new()
            } else {
                params(&[("n", missing_distinct.to_string())])
            },
            set_slug: Some(input.set_slug.clone()),
            image_path: input.image_path.clone(),
            est_value,
            cost: round_plat(plan.completion_cost),
            value_basis: "profit".into(),
            priced_at: None,
            confidence,
            confidence_label: confidence_label(confidence).into(),
            urgency: "persistent".into(),
            reasons,
            actions,
            score: est_value as f64 * confidence,
        });
    }

    // Otherwise: completing isn't the move — recommend selling the parts you hold (the user's
    // "the set's too expensive to finish, just sell the item" case).
    let b = sell_value?;
    if b < config.min_value_plat {
        return None;
    }
    let confidence = (0.5 + 0.5 * liquidity_factor) * if sell_fully_priced { 1.0 } else { 0.7 };
    let confidence = confidence.clamp(0.0, 1.0);

    let owned_parts: Vec<&SetComponentInput> = input
        .components
        .iter()
        .filter(|c| c.owned_qty > 0 && c.sell_price.is_some())
        .collect();

    let mut reasons = vec![OpportunityReason {
        icon: "inventory".into(),
        text_key: "opp.reasonOwnPartsOf".into(),
        text_params: params(&[
            ("owned", owned_distinct.to_string()),
            ("needed", needed_distinct.to_string()),
            ("set", input.set_name.clone()),
        ]),
        source: "inventory".into(),
    }];
    if let Some(set_price) = input.set_sell_price {
        if missing_distinct <= config.max_missing_distinct && plan.fully_priced {
            reasons.push(OpportunityReason {
                icon: "math".into(),
                text_key: "opp.reasonFinishingNetsOnly".into(),
                text_params: params(&[
                    ("a", round_plat(set_price - plan.completion_cost).to_string()),
                    ("b", round_plat(b).to_string()),
                ]),
                source: "math".into(),
            });
        } else {
            reasons.push(OpportunityReason {
                icon: "market".into(),
                text_key: "opp.reasonPartsWorthNow".into(),
                text_params: params(&[("b", round_plat(b).to_string())]),
                source: "market".into(),
            });
        }
    } else {
        reasons.push(OpportunityReason {
            icon: "market".into(),
            text_key: "opp.reasonPartsWorthNow".into(),
            text_params: params(&[("b", round_plat(b).to_string())]),
            source: "market".into(),
        });
    }

    let actions: Vec<OpportunityAction> = owned_parts
        .iter()
        .map(|c| OpportunityAction {
            kind: "sellPart".into(),
            label_key: "opp.actionSell".into(),
            label_params: params(&[("name", c.name.clone())]),
            item_slug: Some(c.slug.clone()),
            item_name: Some(c.name.clone()),
            price: c.sell_price.map(round_plat),
        })
        .collect();

    let est_value = round_plat(b);
    Some(Opportunity {
        id: format!("set-sell-parts:{}", input.set_slug),
        subject_key: format!("set:{}", input.set_slug),
        category: "sellInventory".into(),
        title_key: "opp.sellYourPartsTitle".into(),
        title_params: params(&[("name", input.set_name.clone())]),
        subtitle_key: Some("opp.notWorthCompletingSubtitle".into()),
        subtitle_params: HashMap::new(),
        set_slug: Some(input.set_slug.clone()),
        image_path: input.image_path.clone(),
        est_value,
        cost: 0,
        value_basis: "liquidation".into(),
        priced_at: None,
        confidence,
        confidence_label: confidence_label(confidence).into(),
        urgency: "persistent".into(),
        reasons,
        actions,
        score: est_value as f64 * confidence,
    })
}

/// Orders the board for a quest-board feel: highest value first, but interleaving categories so a
/// run of high-value set-completions doesn't bury every sell/snipe play. Each time a category is
/// picked its remaining items are weighted down by `diversity_factor`, so a much-higher-value
/// category can still repeat — variety, not rigid round-robin. Capped at `board_cap`.
pub fn rank_and_diversify(opportunities: Vec<Opportunity>, config: &EvalConfig) -> Vec<Opportunity> {
    let mut remaining = opportunities;
    let mut picked = Vec::with_capacity(remaining.len().min(config.board_cap));
    let mut picks_per_category: HashMap<String, i32> = HashMap::new();

    while !remaining.is_empty() && picked.len() < config.board_cap {
        let best = remaining
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                let weight =
                    |opp: &Opportunity| {
                        let n = *picks_per_category.get(&opp.category).unwrap_or(&0);
                        opp.score * config.diversity_factor.powi(n)
                    };
                weight(a)
                    .partial_cmp(&weight(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(index, _)| index);

        let Some(index) = best else { break };
        let opportunity = remaining.remove(index);
        *picks_per_category.entry(opportunity.category.clone()).or_insert(0) += 1;
        picked.push(opportunity);
    }

    picked
}

// ---------------------------------------------------------------------------------------------
// Data gathering — joins the persisted caches into evaluator inputs (no WFM calls).
// ---------------------------------------------------------------------------------------------

/// Computes the current opportunity board. Reads only from caches; safe to call frequently.
/// Buy cost for a missing part: the live floor when it sits inside the zone-derived entry band,
/// otherwise clamped to that band. The floor comes from the single most recent stats bucket, so
/// one dumped/overpriced listing would otherwise flow straight into the completion math as truth.
fn clamped_buy_price(
    live_floor: Option<f64>,
    entry_low: Option<f64>,
    entry_high: Option<f64>,
    recommended_entry: Option<f64>,
) -> Option<f64> {
    match (live_floor, entry_low, entry_high) {
        (Some(live), Some(low), Some(high)) if low <= high => Some(live.clamp(low, high)),
        (Some(live), _, _) => Some(recommended_entry.unwrap_or(live)),
        (None, _, _) => recommended_entry,
    }
}

pub fn compute_opportunities(app: &tauri::AppHandle) -> anyhow::Result<Vec<Opportunity>> {
    let Some(scanner) = crate::market_observatory::load_latest_arbitrage_scanner(app)? else {
        return Ok(Vec::new()); // No priced data yet — nothing to evaluate.
    };

    let owned_qty: HashMap<String, i64> = crate::market_observatory::load_owned_set_components(app)?
        .into_iter()
        .map(|item| (item.slug, item.quantity))
        .collect();

    let owned_exit: HashMap<String, i64> =
        crate::market_observatory::compute_set_completion_owned_item_prices(app)?
            .into_iter()
            .filter_map(|value| value.recommended_exit_price.map(|price| (value.slug, price)))
            .collect();

    // Component slugs the user can farm from relics they already own (Strategy C). Best-effort:
    // a missing relic cache (AlecaFrame off) just means nothing is marked farmable.
    let farmable: HashSet<String> = crate::market_observatory::load_owned_relics(app)
        .map(|cache| {
            cache
                .entries
                .into_iter()
                .filter(|entry| entry.counts.total > 0)
                .flat_map(|entry| entry.drops.into_iter().map(|drop| drop.slug))
                .collect()
        })
        .unwrap_or_default();

    // Strategy-tab overrides on top of the balanced defaults; best-effort so a missing/corrupt
    // settings file never blocks the board.
    let mut config = EvalConfig::default();
    if let Ok(settings) = crate::settings::load_settings_for_internal_use(app) {
        config.min_edge_plat = settings.strategy.min_edge_plat;
        config.trade_value_plat = settings.strategy.trade_value_plat;
    }
    let mut opportunities = Vec::new();

    for set in &scanner.results {
        // Sets the user owns no part of → consider a speculative buy-all-parts flip instead of the
        // personal set engine. Gated hard on ROI + liquidity, so most are filtered out.
        if !set.components.iter().any(|c| owned_qty.get(&c.slug).copied().unwrap_or(0) > 0) {
            let flip = FlipInput {
                set_slug: set.slug.clone(),
                set_name: set.name.clone(),
                image_path: set.image_path.clone(),
                component_count: set.component_count as i64,
                basket_entry_cost: set.basket_entry_cost,
                set_sell_price: set.recommended_set_exit_price,
                liquidity: set.liquidity_score,
            };
            if let Some(opportunity) = evaluate_set_flip(&flip, &config) {
                opportunities.push(opportunity);
            }
            continue;
        }

        let components: Vec<SetComponentInput> = set
            .components
            .iter()
            .map(|component| SetComponentInput {
                slug: component.slug.clone(),
                name: component.name.clone(),
                quantity_in_set: component.quantity_in_set.max(1),
                owned_qty: owned_qty.get(&component.slug).copied().unwrap_or(0),
                // Cost to buy now: the live floor is what you'd actually pay, but it comes from a
                // single latest bucket and one weird listing can spike it either way. Clamp it to
                // the zone-derived entry band so a one-bucket outlier can't distort the completion
                // math; with no zone band, fall back to recommended entry, then the raw floor.
                buy_price: clamped_buy_price(
                    component.current_stats_price,
                    component.recommended_entry_low,
                    component.recommended_entry_high,
                    component.recommended_entry_price,
                ),
                sell_price: owned_exit.get(&component.slug).map(|price| *price as f64),
                liquidity: component.liquidity_score,
                farmable_from_relics: farmable.contains(&component.slug),
            })
            .collect();

        let eval_input = SetEvalInput {
            set_slug: set.slug.clone(),
            set_name: set.name.clone(),
            image_path: set.image_path.clone(),
            set_sell_price: set.recommended_set_exit_price,
            set_liquidity: set.liquidity_score,
            components,
        };

        if let Some(opportunity) = evaluate_set(&eval_input, &config) {
            opportunities.push(opportunity);
        }
    }

    // The user's cached active sell orders — feed both the reprice detector and the "what's already
    // listed" set (so we don't tell you to sell something that's already on the market).
    let cached_orders: Vec<CachedSellOrder> =
        crate::market_observatory::load_trade_sell_orders_json(app)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
    let listed_slugs: HashSet<String> = cached_orders
        .iter()
        .filter(|order| order.visible)
        .map(|order| order.slug.clone())
        .collect();

    // Reprice: active sell listings sitting well above where the item actually sells.
    let order_item_ids: Vec<i64> = cached_orders.iter().filter_map(|o| o.item_id).collect();
    let order_exits = crate::market_observatory::recommended_exit_prices_for_items(app, &order_item_ids)
        .unwrap_or_default();
    for order in &cached_orders {
        let Some(exit) = order.item_id.and_then(|id| order_exits.get(&id).copied()) else {
            continue;
        };
        if let Some(opportunity) = evaluate_reprice(order, exit, &config) {
            opportunities.push(opportunity);
        }
    }

    // Sell-inventory: held positions worth acting on. Skip any item already covered by a
    // set/reprice play above (dedupe by the slugs those plays act on).
    let covered_slugs: HashSet<String> = opportunities
        .iter()
        .flat_map(|opp| opp.actions.iter().filter_map(|a| a.item_slug.clone()))
        .collect();

    for row in crate::trades::load_portfolio_holdings(app).unwrap_or_default() {
        if covered_slugs.contains(&row.slug) {
            continue;
        }
        let holding = HoldingInput {
            id: row.id.clone(),
            item_name: row.item_name.clone(),
            slug: row.slug.clone(),
            image_path: row.image_path.clone(),
            quantity: row.quantity,
            status: row.status.clone(),
            cost_basis: row.cost_basis,
            estimated_value: row.estimated_value,
        };
        // Appreciated → "good exit" takes precedence; otherwise an old, unlisted, sellable
        // position → "stale hold" nudge.
        if let Some(opportunity) = evaluate_holding(&holding, &config) {
            opportunities.push(opportunity);
            continue;
        }
        let stale = StaleHoldInput {
            id: row.id,
            item_name: row.item_name,
            slug: row.slug.clone(),
            image_path: row.image_path,
            quantity: row.quantity,
            status: row.status,
            estimated_value: row.estimated_value,
            days_held: days_since(&row.last_updated_at),
            is_listed: listed_slugs.contains(&row.slug),
        };
        if let Some(opportunity) = evaluate_stale_hold(&stale, &config) {
            opportunities.push(opportunity);
        }
    }

    // Stamp every play with the price-data freshness (the scan time) for the UI's "priced X ago".
    for opportunity in &mut opportunities {
        opportunity.priced_at = Some(scanner.computed_at.clone());
    }

    // Rank for the quest-board feel: high value first, but interleave categories and cap the list.
    let ranked = rank_and_diversify(opportunities, &config);

    // Warm the persisted cache so the tab paints instantly next open (best-effort).
    if let Ok(json) = serde_json::to_string(&ranked) {
        let _ = crate::market_observatory::persist_opportunity_board(app, &json);
    }

    Ok(ranked)
}

/// Event emitted when an input the board depends on changes (owned parts, relics, a fresh scan),
/// so the always-on frontend sync can recompute promptly instead of waiting for the poll.
pub const OPPORTUNITIES_STALE_EVENT: &str = "opportunities-stale";

/// Signals (best-effort) that the opportunity board is stale and should be recomputed.
pub fn signal_stale(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit(OPPORTUNITIES_STALE_EVENT, ());
}

/// The last persisted board (instant; no recompute) — for stale-while-revalidate tab paint.
pub fn cached_opportunities(app: &tauri::AppHandle) -> anyhow::Result<Vec<Opportunity>> {
    match crate::market_observatory::load_opportunity_board_json(app)? {
        Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
        None => Ok(Vec::new()),
    }
}

// ---------------------------------------------------------------------------------------------
// Owned-set-part index — lets the always-on firehose cheaply recognise that an underpriced part
// would complete/advance a set the user is close to, so a snipe can be flagged "completes your set".
// ---------------------------------------------------------------------------------------------

/// A hint that a given component slug is a *missing* part of a near-complete set the user owns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedSetPartHint {
    pub set_slug: String,
    pub set_name: String,
    pub owned_distinct: i64,
    pub needed_distinct: i64,
}

fn owned_set_part_index() -> &'static RwLock<HashMap<String, OwnedSetPartHint>> {
    static INDEX: OnceLock<RwLock<HashMap<String, OwnedSetPartHint>>> = OnceLock::new();
    INDEX.get_or_init(|| RwLock::new(HashMap::new()))
}

/// If `slug` is a missing part of a near-complete set the user owns, returns the closest such set.
pub fn owned_set_part_hint(slug: &str) -> Option<OwnedSetPartHint> {
    owned_set_part_index()
        .read()
        .ok()
        .and_then(|index| index.get(slug).cloned())
}

/// Rebuilds the owned-set-part index from cached scanner composition + owned parts. Cache-only.
/// Called periodically (independent of the board) so the firehose enrichment stays fresh.
pub fn refresh_owned_set_index(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let Some(scanner) = crate::market_observatory::load_latest_arbitrage_scanner(app)? else {
        return Ok(());
    };
    let owned_qty: HashMap<String, i64> = crate::market_observatory::load_owned_set_components(app)?
        .into_iter()
        .map(|item| (item.slug, item.quantity))
        .collect();

    let max_missing = EvalConfig::default().max_missing_distinct;
    let mut index: HashMap<String, OwnedSetPartHint> = HashMap::new();

    for set in &scanner.results {
        let needed_distinct = set.components.len() as i64;
        let owned_distinct = set
            .components
            .iter()
            .filter(|c| owned_qty.get(&c.slug).copied().unwrap_or(0) >= 1)
            .count() as i64;
        if owned_distinct == 0 {
            continue; // No stake in this set.
        }
        let missing: Vec<&str> = set
            .components
            .iter()
            .filter(|c| {
                owned_qty.get(&c.slug).copied().unwrap_or(0) < c.quantity_in_set.max(1)
            })
            .map(|c| c.slug.as_str())
            .collect();
        if missing.is_empty() || missing.len() as i64 > max_missing {
            continue; // Already complete, or too far away to be a "you're close" snipe.
        }
        for slug in missing {
            let hint = OwnedSetPartHint {
                set_slug: set.slug.clone(),
                set_name: set.name.clone(),
                owned_distinct,
                needed_distinct,
            };
            // Keep the closest-to-complete set if a part is needed by several.
            index
                .entry(slug.to_string())
                .and_modify(|existing| {
                    if owned_distinct > existing.owned_distinct {
                        *existing = hint.clone();
                    }
                })
                .or_insert(hint);
        }
    }

    if let Ok(mut guard) = owned_set_part_index().write() {
        *guard = index;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_opportunities(app: tauri::AppHandle) -> Result<Vec<Opportunity>, String> {
    tauri::async_runtime::spawn_blocking(move || compute_opportunities(&app))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Returns the last persisted board instantly (no recompute) so the tab can paint immediately
/// while a fresh `get_opportunities` runs in the background.
#[tauri::command]
pub async fn get_cached_opportunities(app: tauri::AppHandle) -> Result<Vec<Opportunity>, String> {
    tauri::async_runtime::spawn_blocking(move || cached_opportunities(&app))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn component(
        slug: &str,
        qty_in_set: i64,
        owned: i64,
        buy: Option<f64>,
        sell: Option<f64>,
    ) -> SetComponentInput {
        SetComponentInput {
            slug: slug.into(),
            name: slug.into(),
            quantity_in_set: qty_in_set,
            owned_qty: owned,
            buy_price: buy,
            sell_price: sell,
            liquidity: 80.0,
            farmable_from_relics: false,
        }
    }

    fn set(components: Vec<SetComponentInput>, set_sell: Option<f64>) -> SetEvalInput {
        SetEvalInput {
            set_slug: "test_set".into(),
            set_name: "Test".into(),
            image_path: None,
            set_sell_price: set_sell,
            set_liquidity: 80.0,
            components,
        }
    }

    #[test]
    fn recommends_completing_when_missing_parts_are_cheap() {
        // Own 3/4; finishing costs 1 expensive + 1 cheap but the set is worth far more.
        let input = set(
            vec![
                component("a", 1, 1, Some(5.0), Some(10.0)),
                component("b", 1, 1, Some(5.0), Some(10.0)),
                component("c", 1, 1, Some(5.0), Some(10.0)),
                component("d", 1, 0, Some(20.0), Some(15.0)),
            ],
            Some(180.0),
        );
        let opp = evaluate_set(&input, &EvalConfig::default()).expect("should produce a play");
        assert_eq!(opp.category, "setCompletion");
        // Net = 180 set - 20 to buy the missing part = 160.
        assert_eq!(opp.est_value, 160);
        assert!(opp.actions.iter().any(|a| a.kind == "buyPart"));
        assert!(opp.actions.iter().any(|a| a.kind == "sellSet"));
    }

    #[test]
    fn recommends_selling_parts_when_completion_is_too_expensive() {
        // Own a high-value part; the missing parts cost more than the completion is worth.
        let input = set(
            vec![
                component("a", 1, 1, Some(120.0), Some(110.0)),
                component("b", 1, 0, Some(150.0), Some(140.0)),
            ],
            Some(220.0),
        );
        let opp = evaluate_set(&input, &EvalConfig::default()).expect("should produce a play");
        // Complete nets 220 - 150 = 70; selling the owned part gets 110 → sell wins.
        assert_eq!(opp.category, "sellInventory");
        assert_eq!(opp.est_value, 110);
        assert!(opp.actions.iter().all(|a| a.kind == "sellPart"));
    }

    #[test]
    fn prefers_completing_over_selling_parts_when_it_saves_trades() {
        // Own 4/5 parts (would cost 4 sell trades to liquidate); completing costs only 2 trades
        // (1 buy + 1 sell). Complete nets 40 - 8 = 32p vs. 26p selling the 4 owned parts — an edge
        // of only 6p, below the flat 10p buffer, but completing uses half as many trades, so it
        // should still win.
        let input = set(
            vec![
                component("a", 1, 1, Some(4.0), Some(5.0)),
                component("b", 1, 1, Some(4.0), Some(7.0)),
                component("c", 1, 1, Some(4.0), Some(6.0)),
                component("d", 1, 1, Some(4.0), Some(8.0)),
                component("e", 1, 0, Some(8.0), Some(7.0)),
            ],
            Some(40.0),
        );
        let opp = evaluate_set(&input, &EvalConfig::default()).expect("should produce a play");
        assert_eq!(opp.category, "setCompletion");
        assert_eq!(opp.est_value, 32);
    }

    #[test]
    fn still_prefers_selling_parts_when_trades_dont_favor_completing() {
        // Own 1/3 parts — completing costs 3 trades (2 buys + 1 sell) vs. 1 trade to sell the part
        // you hold. Even a tied edge shouldn't flip this: completing costs more trades than it
        // saves, so the raised threshold keeps it on "sell parts".
        let input = set(
            vec![
                component("a", 1, 1, Some(12.0), Some(27.0)),
                component("b", 1, 0, Some(12.0), Some(12.0)),
                component("c", 1, 0, Some(12.0), Some(12.0)),
            ],
            Some(51.0),
        );
        let opp = evaluate_set(&input, &EvalConfig::default()).expect("should produce a play");
        // Complete nets 51 - 24 = 27, tied with selling the one owned part for 27 — but completing
        // costs 2 more trades than it saves (trades_saved = 1 - 3 = -2), raising the required edge.
        assert_eq!(opp.category, "sellInventory");
        assert_eq!(opp.est_value, 27);
    }

    #[test]
    fn clamps_spiky_live_floor_to_the_entry_band() {
        // Floor inside the band → trusted as-is.
        assert_eq!(clamped_buy_price(Some(12.0), Some(10.0), Some(15.0), Some(11.0)), Some(12.0));
        // One dumped listing far below the band → clamped up to the band floor.
        assert_eq!(clamped_buy_price(Some(2.0), Some(10.0), Some(15.0), Some(11.0)), Some(10.0));
        // Floor cleared out / spiked high → clamped down to the band ceiling.
        assert_eq!(clamped_buy_price(Some(40.0), Some(10.0), Some(15.0), Some(11.0)), Some(15.0));
        // No zone band → recommended entry, then the raw floor, then nothing.
        assert_eq!(clamped_buy_price(Some(12.0), None, None, Some(11.0)), Some(11.0));
        assert_eq!(clamped_buy_price(Some(12.0), None, None, None), Some(12.0));
        assert_eq!(clamped_buy_price(None, None, None, Some(11.0)), Some(11.0));
        assert_eq!(clamped_buy_price(None, None, None, None), None);
    }

    #[test]
    fn recommends_building_when_all_parts_owned() {
        // Own every part — completion cost is 0, just build and sell.
        let input = set(
            vec![
                component("a", 1, 1, Some(5.0), Some(10.0)),
                component("b", 1, 1, Some(5.0), Some(10.0)),
            ],
            Some(60.0),
        );
        let opp = evaluate_set(&input, &EvalConfig::default()).expect("should produce a play");
        assert_eq!(opp.category, "setCompletion");
        assert_eq!(opp.est_value, 60); // 60 set - 0 to buy.
    }

    #[test]
    fn sells_full_set_when_only_marginally_better_than_parts() {
        // Own all 4 parts; the set (85) beats the parts (4×~19.25=77) by only 8p — below the 10p
        // edge buffer. Since nothing needs buying, it should still recommend selling the SET.
        let input = set(
            vec![
                component("a", 1, 1, Some(0.0), Some(19.0)),
                component("b", 1, 1, Some(0.0), Some(19.0)),
                component("c", 1, 1, Some(0.0), Some(19.0)),
                component("d", 1, 1, Some(0.0), Some(20.0)),
            ],
            Some(85.0),
        );
        let opp = evaluate_set(&input, &EvalConfig::default()).expect("should produce a play");
        assert_eq!(opp.category, "setCompletion"); // sell the set, NOT "sell parts"
        assert_eq!(opp.est_value, 85);
        assert_eq!(opp.title_key, "opp.sellCompletedTitle");
    }

    #[test]
    fn ignores_sets_with_no_owned_parts() {
        let input = set(
            vec![
                component("a", 1, 0, Some(5.0), Some(10.0)),
                component("b", 1, 0, Some(5.0), Some(10.0)),
            ],
            Some(60.0),
        );
        assert!(evaluate_set(&input, &EvalConfig::default()).is_none());
    }

    #[test]
    fn does_not_recommend_completion_when_too_many_parts_missing() {
        // Own 1/5 — too far from completion; falls back to a sell-parts play (or nothing).
        let input = set(
            vec![
                component("a", 1, 1, Some(5.0), Some(40.0)),
                component("b", 1, 0, Some(5.0), Some(10.0)),
                component("c", 1, 0, Some(5.0), Some(10.0)),
                component("d", 1, 0, Some(5.0), Some(10.0)),
                component("e", 1, 0, Some(5.0), Some(10.0)),
            ],
            Some(80.0),
        );
        let opp = evaluate_set(&input, &EvalConfig::default());
        // 4 distinct missing > max_missing_distinct(2): no completion. Owned part sells for 40 → sell.
        assert_eq!(opp.map(|o| o.category), Some("sellInventory".to_string()));
    }

    #[test]
    fn farmable_missing_part_lowers_completion_cost() {
        // Missing part is farmable from owned relics → its buy cost is treated as 0.
        let mut input = set(
            vec![
                component("a", 1, 1, Some(5.0), Some(10.0)),
                component("b", 1, 0, Some(200.0), Some(180.0)),
            ],
            Some(150.0),
        );
        input.components[1].farmable_from_relics = true;
        let opp = evaluate_set(&input, &EvalConfig::default()).expect("should produce a play");
        // Without farming, completion nets 150-200 = -50 (sell would win). With farming, cost is 0
        // → completion nets 150, beating selling the 10p part.
        assert_eq!(opp.category, "setCompletion");
        assert_eq!(opp.est_value, 150);
        assert!(opp.actions.iter().any(|a| a.kind == "farmRelic"));
    }

    fn holding(status: &str, qty: i64, cost: i64, value: i64) -> HoldingInput {
        HoldingInput {
            id: "order1".into(),
            item_name: "Thing".into(),
            slug: "thing".into(),
            image_path: None,
            quantity: qty,
            status: status.into(),
            cost_basis: cost,
            estimated_value: value,
        }
    }

    #[test]
    fn flags_an_appreciated_open_holding() {
        // Bought for 50, now worth 80 → +30 (60%): a good exit.
        let opp = evaluate_holding(&holding("open", 1, 50, 80), &EvalConfig::default())
            .expect("should flag");
        assert_eq!(opp.category, "sellInventory");
        assert_eq!(opp.est_value, 30);
        assert_eq!(opp.actions[0].kind, "sellPart");
        assert_eq!(opp.actions[0].price, Some(80));
    }

    #[test]
    fn ignores_kept_items_and_small_gains() {
        // Kept items aren't nudged.
        assert!(evaluate_holding(&holding("kept", 1, 50, 200), &EvalConfig::default()).is_none());
        // Up only 10% (< 25% floor).
        assert!(evaluate_holding(&holding("open", 1, 100, 110), &EvalConfig::default()).is_none());
        // No cost basis → can't judge.
        assert!(evaluate_holding(&holding("open", 1, 0, 80), &EvalConfig::default()).is_none());
    }

    fn scored(category: &str, score: f64) -> Opportunity {
        Opportunity {
            id: format!("{category}:{score}"),
            subject_key: format!("{category}:{score}"),
            category: category.into(),
            title_key: String::new(),
            title_params: HashMap::new(),
            subtitle_key: None,
            subtitle_params: HashMap::new(),
            set_slug: None,
            image_path: None,
            est_value: score as i64,
            cost: 0,
            value_basis: "profit".into(),
            priced_at: None,
            confidence: 1.0,
            confidence_label: "High".into(),
            urgency: "persistent".into(),
            reasons: vec![],
            actions: vec![],
            score,
        }
    }

    fn stale(days: i64, value: i64, listed: bool, status: &str) -> StaleHoldInput {
        StaleHoldInput {
            id: "h1".into(),
            item_name: "Thing".into(),
            slug: "thing".into(),
            image_path: None,
            quantity: 1,
            status: status.into(),
            estimated_value: value,
            days_held: days,
            is_listed: listed,
        }
    }

    #[test]
    fn flags_an_old_unlisted_sellable_hold() {
        let opp = evaluate_stale_hold(&stale(40, 50, false, "open"), &EvalConfig::default())
            .expect("should flag");
        assert_eq!(opp.category, "sellInventory");
        assert_eq!(opp.est_value, 50);
        assert!(opp.id.starts_with("stale-hold:"));
    }

    #[test]
    fn ignores_recent_listed_or_kept_holds() {
        // Already listed → don't nudge.
        assert!(evaluate_stale_hold(&stale(40, 50, true, "open"), &EvalConfig::default()).is_none());
        // Held only 5 days (< 21).
        assert!(evaluate_stale_hold(&stale(5, 50, false, "open"), &EvalConfig::default()).is_none());
        // Kept items aren't nudged.
        assert!(evaluate_stale_hold(&stale(40, 50, false, "kept"), &EvalConfig::default()).is_none());
    }

    fn order(your_price: i64, visible: bool) -> CachedSellOrder {
        CachedSellOrder {
            order_id: "o1".into(),
            slug: "thing".into(),
            name: "Thing".into(),
            image_path: None,
            item_id: Some(1),
            rank: None,
            your_price,
            visible,
        }
    }

    #[test]
    fn flags_an_overpriced_listing() {
        // Listed at 100, sells around 60 → 67% over → reprice.
        let opp = evaluate_reprice(&order(100, true), 60, &EvalConfig::default())
            .expect("should flag");
        assert_eq!(opp.category, "reprice");
        assert_eq!(opp.est_value, 60);
        assert_eq!(opp.actions[0].price, Some(60));
    }

    #[test]
    fn ignores_fair_or_hidden_listings() {
        // Priced at/under the realistic sell price → not overpriced.
        assert!(evaluate_reprice(&order(60, true), 60, &EvalConfig::default()).is_none());
        // Only 5% over (< 1.15 ratio).
        assert!(evaluate_reprice(&order(63, true), 60, &EvalConfig::default()).is_none());
        // Hidden listings aren't actionable.
        assert!(evaluate_reprice(&order(100, false), 60, &EvalConfig::default()).is_none());
    }

    fn flip(cost: Option<f64>, sell: Option<f64>, liquidity: f64) -> FlipInput {
        FlipInput {
            set_slug: "s".into(),
            set_name: "S".into(),
            image_path: None,
            component_count: 4,
            basket_entry_cost: cost,
            set_sell_price: sell,
            liquidity,
        }
    }

    #[test]
    fn flags_a_strong_liquid_set_flip() {
        // Parts 100, set 160 → +60 (60% ROI), liquid → a flip worth noting (low confidence).
        let opp = evaluate_set_flip(&flip(Some(100.0), Some(160.0), 80.0), &EvalConfig::default())
            .expect("should flag");
        assert_eq!(opp.category, "flip");
        assert_eq!(opp.est_value, 60);
        assert!(opp.confidence <= 0.7);
    }

    #[test]
    fn ignores_thin_or_low_roi_flips() {
        // Good ROI but illiquid (won't sell).
        assert!(evaluate_set_flip(&flip(Some(100.0), Some(160.0), 20.0), &EvalConfig::default()).is_none());
        // Liquid but ROI too low (10%).
        assert!(evaluate_set_flip(&flip(Some(100.0), Some(110.0), 80.0), &EvalConfig::default()).is_none());
    }

    #[test]
    fn diversify_interleaves_categories_and_caps() {
        let config = EvalConfig::default();
        let input = vec![
            scored("setCompletion", 100.0),
            scored("setCompletion", 90.0),
            scored("setCompletion", 80.0),
            scored("sellInventory", 70.0),
            scored("sellInventory", 60.0),
        ];
        let ranked = rank_and_diversify(input, &config);
        let order: Vec<&str> = ranked.iter().map(|o| o.category.as_str()).collect();
        // Top is still the highest score, but the second-best set (90×0.7=63) yields to the top
        // sell (70) → the board interleaves rather than listing all sets first.
        assert_eq!(order[0], "setCompletion");
        assert_eq!(order[1], "sellInventory");
        assert_eq!(order[2], "setCompletion");
    }

    #[test]
    fn diversify_respects_board_cap() {
        let config = EvalConfig {
            board_cap: 2,
            ..EvalConfig::default()
        };
        let input = vec![
            scored("setCompletion", 100.0),
            scored("setCompletion", 90.0),
            scored("sellInventory", 80.0),
        ];
        assert_eq!(rank_and_diversify(input, &config).len(), 2);
    }

    #[test]
    fn skips_trivial_opportunities() {
        let input = set(
            vec![
                component("a", 1, 1, Some(1.0), Some(2.0)),
                component("b", 1, 0, Some(1.0), Some(2.0)),
            ],
            Some(5.0),
        );
        // Completion nets 5-1=4 and parts sell for ~2 — both below min_value_plat(15).
        assert!(evaluate_set(&input, &EvalConfig::default()).is_none());
    }
}
