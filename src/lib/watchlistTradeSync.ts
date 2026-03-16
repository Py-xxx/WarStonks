import type { TradeSellOrder, WatchlistItem } from '../types';

export function buildTradeBuyOrderVariantKey(rank: number | null): string {
  return rank === null ? 'base' : `rank:${rank}`;
}

function buildTradeBuyOrderLookupKey(slug: string, variantKey: string): string {
  return `${slug}:${variantKey}`;
}

function chooseLatestTradeBuyOrder(
  current: TradeSellOrder | undefined,
  candidate: TradeSellOrder,
): TradeSellOrder {
  if (!current) {
    return candidate;
  }

  return candidate.updatedAt.localeCompare(current.updatedAt) > 0 ? candidate : current;
}

export function indexTradeBuyOrdersByVariant(
  buyOrders: TradeSellOrder[],
): Map<string, TradeSellOrder> {
  const orderMap = new Map<string, TradeSellOrder>();

  for (const order of buyOrders) {
    const key = buildTradeBuyOrderLookupKey(order.slug, buildTradeBuyOrderVariantKey(order.rank));
    orderMap.set(key, chooseLatestTradeBuyOrder(orderMap.get(key), order));
  }

  return orderMap;
}

export function findMissingWatchlistBuyOrderIds(
  watchlist: WatchlistItem[],
  buyOrders: TradeSellOrder[],
): string[] {
  const orderMap = indexTradeBuyOrdersByVariant(buyOrders);

  return watchlist
    .filter((item) => !orderMap.has(buildTradeBuyOrderLookupKey(item.slug, item.variantKey)))
    .map((item) => item.id);
}
