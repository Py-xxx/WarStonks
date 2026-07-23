//! Order-flow intelligence derived from the Warframe.Market `newOrders` websocket firehose.
//!
//! The firehose streams every newly-created order market-wide. Two hard realities shape what we
//! can trust from it:
//!   1. **We never see removals.** An order leaving the book (sold or cancelled) produces no
//!      event. So we can NOT reconstruct a live orderbook or a true "sellers ahead" from the
//!      stream — REST remains the source of truth for the book itself. What the stream *can*
//!      give us reliably is **arrivals**: how fast new sell/buy orders show up, and how often a
//!      new order undercuts the running floor. Arrival flow is removal-agnostic and robust.
//!   2. **Trolls / fat-fingers.** A 1p listing on a 200p item, or a 99999p one, are almost
//!      always accidents or trolls. We reject prices far outside a sane band around the item's
//!      recommended price before they touch any signal (see [`is_plausible_price`]).
//!
//! We only track items the user actually "uses" (open listings, watchlist, owned inventory), so
//! the volume stays bounded and we never persist junk for items nobody here cares about.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use time::OffsetDateTime;

/// How far back the in-memory arrival window reaches. Older events are pruned on insert.
const FLOW_WINDOW_SECONDS: f64 = 6.0 * 3600.0;
/// Hard cap on retained events per (item, variant) so a busy item can't grow unbounded.
const MAX_EVENTS_PER_KEY: usize = 240;
/// A firehose price below `recommended * this` is treated as a troll/typo and dropped.
/// Minimum observation window before a per-seller rate is reported (avoids "1 order in 20
/// seconds = 180/hour").
const MIN_RATE_SAMPLE_SECONDS: f64 = 900.0;

const OUTLIER_LOW_RATIO: f64 = 0.1;
/// A firehose price above `recommended * this` is treated as a troll/typo and dropped.
const OUTLIER_HIGH_RATIO: f64 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowSide {
    Sell,
    Buy,
}

#[derive(Clone, Debug)]
struct FlowEvent {
    at_epoch: f64,
    side: FlowSide,
    price: f64,
    /// True when this sell arrival set or matched a new running floor (an undercut).
    undercut: bool,
    /// Who posted it, when the firehose told us. Lets us tell an actively-defended floor (one
    /// seller re-listing over and over) from a floor that simply happens to be low.
    seller: Option<String>,
}

#[derive(Default)]
struct FlowState {
    events: Vec<FlowEvent>,
    /// Lowest plausible sell price observed in the current window ("the floor is at least this
    /// low" — it may actually be lower if a cheaper order was removed unseen).
    observed_floor: Option<f64>,
}

/// Aggregated, query-time view of an item's recent order flow.
#[derive(Clone, Copy, Debug, Default)]
pub struct FlowStats {
    pub sell_arrivals_per_hour: f64,
    pub buy_arrivals_per_hour: f64,
    /// New sell orders per hour that set/matched a fresh floor — the real price-war intensity.
    pub undercut_per_hour: f64,
    pub observed_floor: Option<f64>,
    /// Seconds of history the rates are computed over (small windows are low-confidence).
    pub sample_seconds: f64,
    pub sell_count: i64,
    pub buy_count: i64,
}

/// A point-in-time flow sample for a used item, persisted so the stream builds real history.
#[derive(Clone, Debug)]
pub struct FlowSample {
    pub wfm_item_id: String,
    pub variant_key: String,
    pub captured_at_epoch: f64,
    pub sell_arrivals_per_hour: f64,
    pub buy_arrivals_per_hour: f64,
    pub undercut_per_hour: f64,
    pub observed_floor: Option<f64>,
    pub sample_seconds: f64,
}

type Key = (String, String); // (wfm_item_id, variant_key)

fn flow_store() -> &'static Mutex<HashMap<Key, FlowState>> {
    static STORE: OnceLock<Mutex<HashMap<Key, FlowState>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Used-item ids grouped by source, so each source (watchlist / listings / owned) can replace
/// its own contribution independently. An item is "used" if it appears in any source.
fn used_store() -> &'static Mutex<HashMap<&'static str, HashSet<String>>> {
    static STORE: OnceLock<Mutex<HashMap<&'static str, HashSet<String>>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_epoch() -> f64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() as f64) / 1_000_000_000.0
}

/// Replace the set of used item ids contributed by `source` (e.g. "listings", "watchlist",
/// "owned"). Ids are the hex Warframe.Market item ids the firehose carries.
pub fn set_used_items(source: &'static str, item_ids: &[String]) {
    if let Ok(mut map) = used_store().lock() {
        map.insert(source, item_ids.iter().cloned().collect());
    }
}

/// Whether the firehose should bother recording flow for this item.
pub fn is_used(item_id: &str) -> bool {
    used_store()
        .lock()
        .map(|map| map.values().any(|set| set.contains(item_id)))
        .unwrap_or(false)
}

/// True when `price` is within a sane band of the item's recommended price. Massively over- or
/// under-priced orders (trolls / fat-fingers) are excluded so they can't poison flow, floor, or
/// snapshots. When there is no recommended price to anchor against, we accept any finite,
/// positive price — better a little noise than dropping all data for un-benchmarked items.
pub fn is_plausible_price(item_id: &str, variant_key: &str, price: f64) -> bool {
    if !price.is_finite() || price <= 0.0 {
        return false;
    }
    match crate::recommended_prices::recommended_price(item_id, variant_key) {
        Some(entry) if entry.price > 0.0 => {
            let ratio = price / entry.price;
            ratio >= OUTLIER_LOW_RATIO && ratio <= OUTLIER_HIGH_RATIO
        }
        _ => true,
    }
}

/// Record a firehose order arrival for a used item, after outlier filtering. Returns `true` when
/// the arrival was a fresh undercut of the running floor (a live price-war step the caller may
/// want to react to immediately).
pub fn record_order(
    item_id: &str,
    variant_key: &str,
    side: FlowSide,
    price: f64,
    seller: Option<&str>,
) -> bool {
    if !is_plausible_price(item_id, variant_key, price) {
        return false;
    }
    let now = now_epoch();
    let mut store = match flow_store().lock() {
        Ok(store) => store,
        Err(_) => return false,
    };
    let state = store
        .entry((item_id.to_string(), variant_key.to_string()))
        .or_default();

    let mut is_undercut = false;
    if side == FlowSide::Sell {
        // An undercut = a new sell at or below the running observed floor.
        is_undercut = match state.observed_floor {
            Some(floor) => price <= floor + 0.5,
            None => true,
        };
        state.observed_floor = Some(match state.observed_floor {
            Some(floor) => floor.min(price),
            None => price,
        });
    }

    state.events.push(FlowEvent {
        at_epoch: now,
        side,
        price,
        undercut: is_undercut,
        seller: seller.map(|name| name.trim().to_ascii_lowercase()),
    });
    prune(state, now);
    is_undercut
}

fn prune(state: &mut FlowState, now: f64) {
    let cutoff = now - FLOW_WINDOW_SECONDS;
    state.events.retain(|event| event.at_epoch >= cutoff);
    if state.events.len() > MAX_EVENTS_PER_KEY {
        let overflow = state.events.len() - MAX_EVENTS_PER_KEY;
        state.events.drain(0..overflow);
    }
    // Recompute the observed floor from what remains (the previous floor may have aged out).
    state.observed_floor = state
        .events
        .iter()
        .filter(|event| event.side == FlowSide::Sell)
        .map(|event| event.price)
        .fold(None, |acc: Option<f64>, price| {
            Some(acc.map_or(price, |current| current.min(price)))
        });
}

fn stats_from_state(state: &FlowState, now: f64) -> Option<FlowStats> {
    if state.events.is_empty() {
        return None;
    }
    let earliest = state
        .events
        .iter()
        .map(|event| event.at_epoch)
        .fold(now, f64::min);
    let sample_seconds = (now - earliest).max(1.0);
    let hours = sample_seconds / 3600.0;
    let sell_count = state.events.iter().filter(|e| e.side == FlowSide::Sell).count() as i64;
    let buy_count = state.events.iter().filter(|e| e.side == FlowSide::Buy).count() as i64;
    let undercut_count = state.events.iter().filter(|e| e.undercut).count() as i64;
    Some(FlowStats {
        sell_arrivals_per_hour: sell_count as f64 / hours,
        buy_arrivals_per_hour: buy_count as f64 / hours,
        undercut_per_hour: undercut_count as f64 / hours,
        observed_floor: state.observed_floor,
        sample_seconds,
        sell_count,
        buy_count,
    })
}

/// Current aggregated flow for an item, if we've recorded anything for it.
/// Sell arrivals per hour posted by one specific seller on this item. A high rate means an
/// active repricer (often a bot): a lead taken by undercutting them lasts minutes, not hours, so
/// the pricing model must discount how much that lead is worth. `None` until the observation
/// window is long enough for a rate to mean anything.
pub fn seller_repricing_rate(item_id: &str, variant_key: &str, seller: &str) -> Option<f64> {
    let needle = seller.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return None;
    }
    let store = flow_store().lock().ok()?;
    let state = store.get(&(item_id.to_string(), variant_key.to_string()))?;
    let now = now_epoch();
    let oldest = state.events.first()?.at_epoch;
    let sample_seconds = (now - oldest).max(1.0);
    if sample_seconds < MIN_RATE_SAMPLE_SECONDS {
        return None;
    }
    let count = state
        .events
        .iter()
        .filter(|event| event.side == FlowSide::Sell)
        .filter(|event| event.seller.as_deref() == Some(needle.as_str()))
        .count() as f64;
    Some(count / (sample_seconds / 3600.0))
}

pub fn flow_stats(item_id: &str, variant_key: &str) -> Option<FlowStats> {
    let now = now_epoch();
    let mut store = flow_store().lock().ok()?;
    let state = store.get_mut(&(item_id.to_string(), variant_key.to_string()))?;
    prune(state, now);
    stats_from_state(state, now)
}

/// Snapshot the current flow for every tracked key into persistable samples. Read-only: it does
/// not clear state (the rolling window keeps accumulating), so callers can flush on a cadence.
pub fn collect_samples() -> Vec<FlowSample> {
    let now = now_epoch();
    let mut store = match flow_store().lock() {
        Ok(store) => store,
        Err(_) => return Vec::new(),
    };
    let mut samples = Vec::new();
    for ((item_id, variant_key), state) in store.iter_mut() {
        prune(state, now);
        if let Some(stats) = stats_from_state(state, now) {
            samples.push(FlowSample {
                wfm_item_id: item_id.clone(),
                variant_key: variant_key.clone(),
                captured_at_epoch: now,
                sell_arrivals_per_hour: stats.sell_arrivals_per_hour,
                buy_arrivals_per_hour: stats.buy_arrivals_per_hour,
                undercut_per_hour: stats.undercut_per_hour,
                observed_floor: stats.observed_floor,
                sample_seconds: stats.sample_seconds,
            });
        }
    }
    samples
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_outlier_prices_against_recommended() {
        crate::recommended_prices::set_recommended_price(
            "flow-outlier",
            "base",
            crate::recommended_prices::RecommendedPriceEntry {
                price: 100.0,
                slug: "x".into(),
                name: "X".into(),
            },
        );
        assert!(!is_plausible_price("flow-outlier", "base", 1.0)); // 1% of rec → troll
        assert!(!is_plausible_price("flow-outlier", "base", 5000.0)); // 50× → troll
        assert!(is_plausible_price("flow-outlier", "base", 60.0)); // genuinely cheap, kept
        assert!(is_plausible_price("flow-outlier", "base", 140.0));
    }

    #[test]
    fn unbenchmarked_items_accept_any_positive_finite_price() {
        assert!(is_plausible_price("flow-unknown", "base", 3.0));
        assert!(!is_plausible_price("flow-unknown", "base", 0.0));
        assert!(!is_plausible_price("flow-unknown", "base", f64::NAN));
    }

    #[test]
    fn records_flow_and_counts_undercuts() {
        let item = "flow-record";
        // No recommended price → all plausible.
        assert!(record_order(item, "base", FlowSide::Sell, 50.0, None)); // first sell = undercut
        assert!(record_order(item, "base", FlowSide::Sell, 45.0, None)); // lower = undercut
        assert!(!record_order(item, "base", FlowSide::Sell, 60.0, None)); // higher = not undercut
        record_order(item, "base", FlowSide::Buy, 40.0, None);
        let stats = flow_stats(item, "base").expect("stats present");
        assert_eq!(stats.sell_count, 3);
        assert_eq!(stats.buy_count, 1);
        assert_eq!(stats.observed_floor, Some(45.0));
        assert!(stats.undercut_per_hour > 0.0);
    }

    #[test]
    fn used_items_membership_is_union_across_sources() {
        set_used_items("listings", &["a".to_string(), "b".to_string()]);
        set_used_items("watchlist", &["c".to_string()]);
        assert!(is_used("a"));
        assert!(is_used("c"));
        assert!(!is_used("z"));
        // Replacing one source doesn't drop the others.
        set_used_items("listings", &["b".to_string()]);
        assert!(!is_used("a"));
        assert!(is_used("b"));
        assert!(is_used("c"));
    }
}
