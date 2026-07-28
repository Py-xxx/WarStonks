import type { SellerMode, TradeListingHealth, TradeOverview } from '../types';

/**
 * Cross-page trade caches.
 *
 * These live outside the Trades page component so the always-on background refresher can keep
 * them warm while the page is closed. Without that, reopening Trades always painted a cold
 * loading state and refetched everything, even though a background pass had just scored the
 * exact same orders.
 */
export const tradeOverviewCache = new Map<SellerMode, TradeOverview>();
export const tradeOverviewLoadPromises = new Map<SellerMode, Promise<TradeOverview>>();

/** Last known market low + timestamp, keyed "slug:rank" so it survives order-id changes. */
export const marketLowCache = new Map<string, { marketLow: number | null; refreshedAt: number }>();

/** Last scored health per order, guarded by the price it was scored at. */
export const tradeHealthCache = new Map<
  string,
  { health: TradeListingHealth; yourPrice: number }
>();

export function marketLowKey(slug: string, rank: number | null): string {
  return rank !== null && rank !== undefined ? `${slug}:${rank}` : slug;
}

/** Records a freshly scored order so any later render can paint it without refetching. */
export function cacheOrderHealth(
  orderId: string,
  slug: string,
  rank: number | null,
  yourPrice: number,
  health: TradeListingHealth,
): void {
  tradeHealthCache.set(orderId, { health, yourPrice });
  if (health.marketLow !== null && health.marketLow !== undefined) {
    marketLowCache.set(marketLowKey(slug, rank), {
      marketLow: health.marketLow,
      refreshedAt: Date.now(),
    });
  }
}
