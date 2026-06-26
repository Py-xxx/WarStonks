//! In-memory store of recommended entry prices, keyed by (WFM item id, variant key).
//!
//! Populated by the arbitrage scanner and item-analysis (both in `market_observatory`) and read
//! by the realtime `newOrders` firehose in `trades` to flag underpriced market listings. The
//! WFM item id is the hex string the firehose carries; slug + name are stored alongside the
//! price so the firehose can emit a complete card without a catalog lookup per event.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};

/// Running count of `newOrders` firehose events the radar has examined this session — a simple
/// "is the subscription actually flowing" signal surfaced in the UI.
static SCANNED_COUNT: AtomicU64 = AtomicU64::new(0);

pub fn increment_scanned() {
    SCANNED_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub fn scanned_count() -> u64 {
    SCANNED_COUNT.load(Ordering::Relaxed)
}

#[derive(Clone, Debug)]
pub struct RecommendedPriceEntry {
    pub price: f64,
    pub slug: String,
    pub name: String,
}

type Key = (String, String); // (wfm_item_id, variant_key)

fn store() -> &'static RwLock<HashMap<Key, RecommendedPriceEntry>> {
    static STORE: OnceLock<RwLock<HashMap<Key, RecommendedPriceEntry>>> = OnceLock::new();
    STORE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Maps a `newOrders` rank to the catalog variant-key convention used by the scanner/analysis
/// (`"base"` for unranked, `"rank:{n}"` for ranked items).
pub fn variant_key_for_rank(rank: Option<i64>) -> String {
    match rank {
        Some(rank) => format!("rank:{rank}"),
        None => "base".to_string(),
    }
}

/// Inserts or updates a recommended entry price. No-ops on empty id or a non-positive /
/// non-finite price (those can't be a meaningful "underpriced" benchmark).
pub fn set_recommended_price(wfm_item_id: &str, variant_key: &str, entry: RecommendedPriceEntry) {
    if wfm_item_id.is_empty() || !entry.price.is_finite() || entry.price <= 0.0 {
        return;
    }
    if let Ok(mut map) = store().write() {
        map.insert((wfm_item_id.to_string(), variant_key.to_string()), entry);
    }
}

/// Looks up the recommended entry price for a firehose order's (item id, variant key).
pub fn recommended_price(wfm_item_id: &str, variant_key: &str) -> Option<RecommendedPriceEntry> {
    store()
        .read()
        .ok()
        .and_then(|map| map.get(&(wfm_item_id.to_string(), variant_key.to_string())).cloned())
}

/// Number of priced items currently tracked — used to decide whether the radar should hold the
/// WFM websocket open (no point keeping the firehose running with nothing to match against).
pub fn tracked_count() -> usize {
    store().read().map(|map| map.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(price: f64) -> RecommendedPriceEntry {
        RecommendedPriceEntry { price, slug: "test_item".into(), name: "Test Item".into() }
    }

    #[test]
    fn variant_key_matches_catalog_convention() {
        assert_eq!(variant_key_for_rank(None), "base");
        assert_eq!(variant_key_for_rank(Some(0)), "rank:0");
        assert_eq!(variant_key_for_rank(Some(5)), "rank:5");
    }

    #[test]
    fn set_and_get_round_trips_and_is_variant_scoped() {
        // Unique key per test so the shared global store can't be contaminated by other tests.
        set_recommended_price("wfm-roundtrip", "base", entry(42.0));
        let got = recommended_price("wfm-roundtrip", "base").expect("present");
        assert_eq!(got.price, 42.0);
        assert_eq!(got.slug, "test_item");
        // A different variant key for the same item is a distinct entry.
        assert!(recommended_price("wfm-roundtrip", "rank:0").is_none());
    }

    #[test]
    fn rejects_invalid_prices_and_unknown_keys() {
        set_recommended_price("wfm-zero", "base", entry(0.0));
        assert!(recommended_price("wfm-zero", "base").is_none());
        set_recommended_price("wfm-nan", "base", entry(f64::NAN));
        assert!(recommended_price("wfm-nan", "base").is_none());
        set_recommended_price("", "base", entry(10.0));
        assert!(recommended_price("", "base").is_none());
        assert!(recommended_price("wfm-never-set", "base").is_none());
    }
}
