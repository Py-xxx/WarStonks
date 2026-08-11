//! Closing the Warframe.Market listing behind a completed trade.
//!
//! This is the **only** place trade detection writes to WFM, and a wrong write destroys a real
//! listing, so the decision is separated from the doing: [`plan_listing_close`] is pure and
//! exhaustively tested, and [`execute`] does nothing but carry out a plan it was handed.
//!
//! ## Why it is not simply "mark it sold"
//!
//! A listing's price is what the user *asked*, not necessarily what they *got*. Selling a 40p
//! listing for 30p and closing it as-is would record 30p of trade at 40p — wrong in WFM's own
//! history and wrong in every number we derive from it. The rules below keep the recorded price
//! honest **and** leave the user's standing listing exactly as they priced it:
//!
//! | Traded vs listed | Price | What happens |
//! |---|---|---|
//! | all units | same | close the listing |
//! | all units | differs | correct the listing's price, then close it — nothing is left to keep |
//! | some units | same | close just those units; the listing keeps the rest at its price |
//! | some units | differs | record the true price on a throwaway **invisible** listing and close *that*, then shrink the original — the standing listing keeps the price the user chose |
//!
//! The last row is the case that matters. Editing the real listing down to the traded price and
//! reducing its quantity — what the manual "mark as bought" used to do — silently rewrites the
//! user's asking price for every unit they still hold.

use serde::{Deserialize, Serialize};

use crate::trades::TradeSellOrder;

/// A trade that has been detected and needs its listing settled.
#[derive(Debug, Clone)]
pub struct DetectedTrade<'a> {
    pub slug: &'a str,
    /// `"buy"` or `"sell"` — a purchase settles a buy order, a sale settles a sell order.
    pub order_type: &'a str,
    pub rank: Option<i64>,
    pub quantity: i64,
    /// What each unit actually changed hands for.
    pub unit_price: i64,
}

/// Why no listing was settled. Surfaced rather than swallowed: silence here is
/// indistinguishable from "it worked", and the user needs to know their listing is still open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoCloseReason {
    /// Nothing listed for this item — the ordinary case for a trade outside the Market.
    NoMatchingListing,
    /// More than one listing could be the one. Guessing risks closing the wrong listing, so
    /// this always stops.
    AmbiguousListing { candidates: usize },
    /// The trade moved more units than the listing holds, so it cannot be the whole story.
    QuantityExceedsListing { traded: i64, listed: i64 },
    /// Nonsense input — a zero quantity or a non-positive price.
    Unusable,
}

/// The write (or writes) that settle a listing. Ordered: every step assumes the previous one
/// succeeded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListingClosePlan {
    /// Traded every unit at the listed price. Close it and it is done.
    Close { order_id: String, quantity: i64 },
    /// Traded every unit at a different price. The listing is about to disappear anyway, so
    /// correcting its price in place is safe and keeps WFM's history accurate.
    RepriceThenClose {
        order_id: String,
        price: i64,
        quantity: i64,
    },
    /// Traded some units at the listed price. Closing part of a listing leaves the rest
    /// standing, which is exactly what is wanted.
    ClosePartial {
        order_id: String,
        quantity: i64,
        remaining: i64,
    },
    /// Traded some units at a different price. Mirror the sale onto a throwaway invisible
    /// listing so the recorded price is true, then shrink the original — which keeps the
    /// price the user actually chose for the units they still hold.
    MirrorThenShrink {
        order_id: String,
        /// Everything needed to recreate the sale as its own listing.
        mirror: MirrorListing,
        remaining: i64,
        /// The original's price, carried so shrinking it cannot accidentally change it. This
        /// is the entire point of the mirror — the user's asking price must survive.
        keep_price: i64,
    },
}

/// The throwaway listing used to record a sale at a price the standing listing does not carry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorListing {
    pub wfm_id: String,
    pub order_type: String,
    pub price: i64,
    pub quantity: i64,
    pub rank: Option<i64>,
    /// Carried through because WFM rejects a bulk item's order without it.
    pub per_trade: Option<i64>,
    pub bulk_tradable: bool,
}

/// Decides what to do about a detected trade, given every listing the user currently holds.
///
/// Matching is deliberately strict — same item, same rank, same direction, and exactly one
/// candidate. §4.5 of the plan treats a wrong auto-close as destructive, and the cost of
/// declining to act is merely that the user closes the listing themselves.
pub fn plan_listing_close(
    trade: &DetectedTrade<'_>,
    listings: &[TradeSellOrder],
) -> Result<ListingClosePlan, NoCloseReason> {
    if trade.quantity <= 0 || trade.unit_price <= 0 || trade.slug.trim().is_empty() {
        return Err(NoCloseReason::Unusable);
    }

    let candidates: Vec<&TradeSellOrder> = listings
        .iter()
        .filter(|listing| {
            listing.order_type.eq_ignore_ascii_case(trade.order_type)
                && listing.slug.eq_ignore_ascii_case(trade.slug)
                // A rank-0 arcane and a rank-5 one are different goods at different prices.
                && listing.rank == trade.rank
                && listing.quantity > 0
        })
        .collect();

    let listing = match candidates.as_slice() {
        [] => return Err(NoCloseReason::NoMatchingListing),
        [only] => *only,
        many => {
            return Err(NoCloseReason::AmbiguousListing {
                candidates: many.len(),
            })
        }
    };

    if trade.quantity > listing.quantity {
        return Err(NoCloseReason::QuantityExceedsListing {
            traded: trade.quantity,
            listed: listing.quantity,
        });
    }

    let price_matches = listing.your_price == trade.unit_price;
    let fills_listing = trade.quantity == listing.quantity;
    let remaining = listing.quantity - trade.quantity;

    Ok(match (fills_listing, price_matches) {
        (true, true) => ListingClosePlan::Close {
            order_id: listing.order_id.clone(),
            quantity: trade.quantity,
        },
        (true, false) => ListingClosePlan::RepriceThenClose {
            order_id: listing.order_id.clone(),
            price: trade.unit_price,
            quantity: trade.quantity,
        },
        (false, true) => ListingClosePlan::ClosePartial {
            order_id: listing.order_id.clone(),
            quantity: trade.quantity,
            remaining,
        },
        (false, false) => ListingClosePlan::MirrorThenShrink {
            order_id: listing.order_id.clone(),
            keep_price: listing.your_price,
            mirror: MirrorListing {
                wfm_id: listing.wfm_id.clone(),
                order_type: listing.order_type.clone(),
                price: trade.unit_price,
                quantity: trade.quantity,
                rank: listing.rank,
                // Only bulk items carry it; WFM rejects it on everything else.
                per_trade: listing.bulk_tradable.then_some(listing.per_trade),
                bulk_tradable: listing.bulk_tradable,
            },
            remaining,
        },
    })
}

/// Carries out a plan. Every step is a real write to Warframe.Market.
///
/// Order matters and is not negotiable: the mirror is created and closed **before** the
/// original is shrunk, so a failure part-way leaves the user with a listing that is too large
/// rather than one that has silently lost units it never sold.
fn execute(
    app: &tauri::AppHandle,
    plan: &ListingClosePlan,
    seller_mode: &str,
) -> anyhow::Result<()> {
    match plan {
        ListingClosePlan::Close { order_id, quantity }
        | ListingClosePlan::ClosePartial {
            order_id, quantity, ..
        } => {
            crate::trades::close_order_inner(app, order_id, *quantity, order_type_of(plan), seller_mode)?;
        }
        ListingClosePlan::RepriceThenClose {
            order_id,
            price,
            quantity,
        } => {
            // Nothing survives this listing, so correcting it in place costs the user nothing.
            crate::trades::update_order_inner(
                app,
                &crate::trades::TradeUpdateListingInput {
                    order_id: order_id.clone(),
                    price: *price,
                    quantity: *quantity,
                    rank: None,
                    visible: true,
                    wfm_id: None,
                    per_trade: None,
                },
                order_type_of(plan),
                seller_mode,
                crate::wfm_scheduler::RequestPriority::Instant,
            )?;
            crate::trades::close_order_inner(app, order_id, *quantity, order_type_of(plan), seller_mode)?;
        }
        ListingClosePlan::MirrorThenShrink {
            order_id,
            mirror,
            remaining,
            keep_price,
        } => {
            // Invisible so it never appears to other traders in the moment it exists.
            let overview = crate::trades::create_order_inner(
                app,
                &crate::trades::TradeCreateListingInput {
                    wfm_id: mirror.wfm_id.clone(),
                    price: mirror.price,
                    quantity: mirror.quantity,
                    rank: mirror.rank,
                    visible: false,
                    per_trade: mirror.per_trade,
                    subtype: None,
                },
                &mirror.order_type,
                seller_mode,
            )?;

            let mirror_id = find_mirror_order_id(&overview, mirror).ok_or_else(|| {
                anyhow::anyhow!(
                    "created the mirror listing but could not find it again, so it was left open"
                )
            })?;
            crate::trades::close_order_inner(
                app,
                &mirror_id,
                mirror.quantity,
                &mirror.order_type,
                seller_mode,
            )?;

            // Only now shrink the original — and at its own price, never the traded one.
            crate::trades::update_order_inner(
                app,
                &crate::trades::TradeUpdateListingInput {
                    order_id: order_id.clone(),
                    price: *keep_price,
                    quantity: *remaining,
                    rank: mirror.rank,
                    visible: true,
                    wfm_id: Some(mirror.wfm_id.clone()),
                    per_trade: mirror.per_trade,
                },
                &mirror.order_type,
                seller_mode,
                crate::wfm_scheduler::RequestPriority::Instant,
            )?;
        }
    }
    Ok(())
}

fn order_type_of(plan: &ListingClosePlan) -> &str {
    match plan {
        ListingClosePlan::MirrorThenShrink { mirror, .. } => &mirror.order_type,
        // The others close an existing order by id, where WFM already knows the type; the
        // value is only used for our own bookkeeping and error text.
        _ => "sell",
    }
}

/// Finds the just-created mirror in the overview WFM returned.
///
/// Matched on being invisible at exactly the mirror's item, price and quantity — the created
/// order's id is not returned directly, and closing the wrong order here would be destructive.
fn find_mirror_order_id(
    overview: &crate::trades::TradeOverview,
    mirror: &MirrorListing,
) -> Option<String> {
    let pool = if mirror.order_type.eq_ignore_ascii_case("buy") {
        &overview.buy_orders
    } else {
        &overview.sell_orders
    };

    pool.iter()
        .filter(|order| {
            !order.visible
                && order.wfm_id == mirror.wfm_id
                && order.your_price == mirror.price
                && order.quantity == mirror.quantity
                && order.rank == mirror.rank
        })
        .map(|order| order.order_id.clone())
        // Newest last: if a previous run left one behind, act on the one just made.
        .next_back()
}

/// Settles the listing behind one detected trade, when the user has opted in.
///
/// Never fails the caller: trade detection has already recorded the trade, and an unclosed
/// listing is a nuisance where a failed detection would be data loss. The outcome is logged.
pub fn settle_listing_for_trade(
    app: &tauri::AppHandle,
    trade: &DetectedTrade<'_>,
    listings: &[TradeSellOrder],
    seller_mode: &str,
) {
    match plan_listing_close(trade, listings) {
        Ok(plan) => {
            if let Err(error) = execute(app, &plan, seller_mode) {
                crate::error_log::log_feature_error_best_effort(
                    app,
                    "trades",
                    "listing-auto-close",
                    &format!("failed to settle the listing for {}", trade.slug),
                    &error,
                );
            }
        }
        // Not an error: most trades have no listing behind them at all.
        Err(NoCloseReason::NoMatchingListing) => {}
        Err(reason) => {
            crate::error_log::log_feature_event_best_effort(
                app,
                "trades",
                "listing-auto-close-skipped",
                &format!("left {} listing open: {reason:?}", trade.slug),
            );
        }
    }
}

/// Settles the listing behind a **manually** confirmed trade — the watchlist's "mark as
/// bought", and its sell-side equivalent.
///
/// Shares `plan_listing_close` with automatic detection on purpose. The manual path used to
/// edit the real order's price down to what was paid and then close part of it, which left
/// every unit the user still held repriced to a number they never chose. One engine, one set
/// of rules, one place to get it right.
#[tauri::command]
pub async fn settle_listing_for_manual_trade(
    app: tauri::AppHandle,
    slug: String,
    order_type: String,
    rank: Option<i64>,
    quantity: i64,
    unit_price: i64,
    seller_mode: String,
) -> Result<crate::trades::TradeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let overview = crate::trades::build_trade_overview_inner(&app, &seller_mode)?;
        let listings: Vec<TradeSellOrder> = overview
            .sell_orders
            .iter()
            .chain(overview.buy_orders.iter())
            .cloned()
            .collect();

        let trade = DetectedTrade {
            slug: &slug,
            order_type: &order_type,
            rank,
            quantity,
            unit_price,
        };

        match plan_listing_close(&trade, &listings) {
            Ok(plan) => {
                execute(&app, &plan, &seller_mode)?;
                crate::trades::build_trade_overview_inner(&app, &seller_mode)
            }
            // Nothing to settle is a normal outcome, not a failure: the caller still recorded
            // the purchase. Hand back the overview unchanged.
            Err(NoCloseReason::NoMatchingListing) => Ok(overview),
            Err(reason) => Err(anyhow::anyhow!(
                "left the {slug} listing open rather than risk closing the wrong one: {reason:?}"
            )),
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing(order_id: &str, slug: &str, price: i64, quantity: i64) -> TradeSellOrder {
        TradeSellOrder {
            order_id: order_id.to_string(),
            order_type: "sell".to_string(),
            wfm_id: format!("wfm-{slug}"),
            item_id: None,
            name: slug.replace('_', " "),
            slug: slug.to_string(),
            image_path: None,
            rank: None,
            max_rank: None,
            quantity,
            per_trade: 1,
            bulk_tradable: false,
            your_price: price,
            market_low: None,
            price_gap: None,
            visible: true,
            updated_at: String::new(),
            created_at: None,
            health_score: None,
            health_note: None,
            health: None,
        }
    }

    fn sale(slug: &str, quantity: i64, unit_price: i64) -> DetectedTrade<'_> {
        DetectedTrade {
            slug,
            order_type: "sell",
            rank: None,
            quantity,
            unit_price,
        }
    }

    #[test]
    fn a_full_fill_at_the_listed_price_just_closes() {
        let plan = plan_listing_close(
            &sale("baruuk_prime_set", 1, 60),
            &[listing("o1", "baruuk_prime_set", 60, 1)],
        )
        .expect("a plan");

        assert_eq!(
            plan,
            ListingClosePlan::Close {
                order_id: "o1".to_string(),
                quantity: 1
            }
        );
    }

    /// Listed at 40, sold at 30, nothing left over. Closing as-is would record the sale at 40.
    #[test]
    fn a_full_fill_at_a_different_price_is_repriced_first() {
        let plan = plan_listing_close(
            &sale("baruuk_prime_set", 1, 30),
            &[listing("o1", "baruuk_prime_set", 40, 1)],
        )
        .expect("a plan");

        assert_eq!(
            plan,
            ListingClosePlan::RepriceThenClose {
                order_id: "o1".to_string(),
                price: 30,
                quantity: 1,
            }
        );
    }

    #[test]
    fn a_partial_fill_at_the_listed_price_closes_only_those_units() {
        let plan = plan_listing_close(
            &sale("forma", 2, 10),
            &[listing("o1", "forma", 10, 5)],
        )
        .expect("a plan");

        assert_eq!(
            plan,
            ListingClosePlan::ClosePartial {
                order_id: "o1".to_string(),
                quantity: 2,
                remaining: 3,
            }
        );
    }

    /// The case the whole module exists for: the user still holds 3 units they price at 40, and
    /// that price must survive recording a 30p sale of the other 2.
    #[test]
    fn a_partial_fill_at_a_different_price_mirrors_instead_of_repricing_the_original() {
        let plan = plan_listing_close(
            &sale("forma", 2, 30),
            &[listing("o1", "forma", 40, 5)],
        )
        .expect("a plan");

        let ListingClosePlan::MirrorThenShrink {
            order_id,
            mirror,
            remaining,
            keep_price,
        } = plan
        else {
            panic!("expected a mirrored close, got {plan:?}");
        };

        assert_eq!(order_id, "o1");
        assert_eq!(remaining, 3, "the untraded units stay listed");
        assert_eq!(keep_price, 40, "the standing listing keeps the user's asking price");
        assert_eq!(mirror.price, 30, "the mirror records what was actually paid");
        assert_eq!(mirror.quantity, 2);
        assert_eq!(mirror.order_type, "sell");
    }

    #[test]
    fn a_bulk_item_carries_per_trade_onto_the_mirror() {
        let mut bulk = listing("o1", "arcane_energize", 40, 5);
        bulk.bulk_tradable = true;
        bulk.per_trade = 3;

        let plan = plan_listing_close(&sale("arcane_energize", 2, 30), &[bulk]).expect("a plan");

        let ListingClosePlan::MirrorThenShrink { mirror, .. } = plan else {
            panic!("expected a mirrored close");
        };
        assert_eq!(mirror.per_trade, Some(3), "WFM rejects a bulk order without it");
    }

    #[test]
    fn a_non_bulk_item_never_carries_per_trade() {
        let plan =
            plan_listing_close(&sale("forma", 2, 30), &[listing("o1", "forma", 40, 5)]).expect("a plan");

        let ListingClosePlan::MirrorThenShrink { mirror, .. } = plan else {
            panic!("expected a mirrored close");
        };
        assert_eq!(mirror.per_trade, None, "WFM rejects it on non-bulk items");
    }

    #[test]
    fn a_buy_settles_a_buy_order_and_never_a_sell_order() {
        let mut buy_listing = listing("o1", "baruuk_prime_set", 60, 1);
        buy_listing.order_type = "buy".to_string();
        let sell_listing = listing("o2", "baruuk_prime_set", 60, 1);

        let purchase = DetectedTrade {
            slug: "baruuk_prime_set",
            order_type: "buy",
            rank: None,
            quantity: 1,
            unit_price: 60,
        };

        let plan = plan_listing_close(&purchase, &[buy_listing, sell_listing]).expect("a plan");
        assert_eq!(
            plan,
            ListingClosePlan::Close {
                order_id: "o1".to_string(),
                quantity: 1
            },
            "the sell order of the same item must be untouched",
        );
    }

    /// Rank is part of the item's identity: a 0/5 arcane and a 5/5 are priced separately.
    #[test]
    fn a_rank_mismatch_is_not_a_match() {
        let mut ranked = listing("o1", "arcane_energize", 40, 1);
        ranked.rank = Some(5);

        let unranked_sale = DetectedTrade {
            slug: "arcane_energize",
            order_type: "sell",
            rank: Some(0),
            quantity: 1,
            unit_price: 40,
        };

        assert_eq!(
            plan_listing_close(&unranked_sale, &[ranked]),
            Err(NoCloseReason::NoMatchingListing)
        );
    }

    /// Two listings for the same item at different prices: there is no way to know which one
    /// the trade came from, and closing the wrong one destroys it.
    #[test]
    fn two_candidate_listings_stop_rather_than_guess() {
        let listings = vec![
            listing("o1", "forma", 40, 5),
            listing("o2", "forma", 35, 5),
        ];

        assert_eq!(
            plan_listing_close(&sale("forma", 1, 35), &listings),
            Err(NoCloseReason::AmbiguousListing { candidates: 2 })
        );
    }

    /// Selling more than the listing holds means the listing cannot account for the trade — some
    /// of it came from somewhere else, so closing it would misreport what happened.
    #[test]
    fn trading_more_units_than_are_listed_stops() {
        assert_eq!(
            plan_listing_close(&sale("forma", 9, 10), &[listing("o1", "forma", 10, 5)]),
            Err(NoCloseReason::QuantityExceedsListing {
                traded: 9,
                listed: 5
            })
        );
    }

    #[test]
    fn no_listing_at_all_is_the_ordinary_case_not_an_error() {
        assert_eq!(
            plan_listing_close(&sale("forma", 1, 10), &[]),
            Err(NoCloseReason::NoMatchingListing)
        );
    }

    #[test]
    fn nonsense_input_is_rejected_before_any_matching() {
        assert_eq!(
            plan_listing_close(&sale("forma", 0, 10), &[listing("o1", "forma", 10, 5)]),
            Err(NoCloseReason::Unusable)
        );
        assert_eq!(
            plan_listing_close(&sale("forma", 1, 0), &[listing("o1", "forma", 10, 5)]),
            Err(NoCloseReason::Unusable)
        );
    }
}
