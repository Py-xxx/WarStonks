import type { PortfolioTradeLogEntry, TradeSellOrder, WatchlistItem } from '../types';
import { buildTradeBuyOrderVariantKey } from './watchlistTradeSync.ts';

export const WATCHLIST_PURCHASE_RECENT_CLOSE_WINDOW_MS = 3 * 60 * 1000;

function isMatchingWatchlistVariant(item: WatchlistItem, order: TradeSellOrder): boolean {
  return order.slug === item.slug && buildTradeBuyOrderVariantKey(order.rank) === item.variantKey;
}

function chooseLatestOrder(
  current: TradeSellOrder | null,
  candidate: TradeSellOrder,
): TradeSellOrder {
  if (!current) {
    return candidate;
  }

  return candidate.updatedAt.localeCompare(current.updatedAt) > 0 ? candidate : current;
}

export function findActiveWatchlistBuyOrder(
  item: WatchlistItem,
  buyOrders: TradeSellOrder[],
): TradeSellOrder | null {
  if (item.linkedBuyOrderId) {
    const linkedOrder = buyOrders.find((order) => order.orderId === item.linkedBuyOrderId);
    if (linkedOrder) {
      return linkedOrder;
    }
  }

  let latestMatch: TradeSellOrder | null = null;
  for (const order of buyOrders) {
    if (isMatchingWatchlistVariant(item, order)) {
      latestMatch = chooseLatestOrder(latestMatch, order);
    }
  }

  return latestMatch;
}

function parseTradeTimestamp(entry: PortfolioTradeLogEntry): number | null {
  const updatedAt = Date.parse(entry.updatedAt);
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }

  const closedAt = Date.parse(entry.closedAt);
  return Number.isFinite(closedAt) ? closedAt : null;
}

export function hasRecentClosedBuyTradeAtPrice(
  item: WatchlistItem,
  price: number,
  entries: PortfolioTradeLogEntry[],
  nowMs: number,
  recentWindowMs: number = WATCHLIST_PURCHASE_RECENT_CLOSE_WINDOW_MS,
): boolean {
  return entries.some((entry) => {
    if (entry.source !== 'wfm' || entry.orderType !== 'buy') {
      return false;
    }
    if (entry.slug !== item.slug) {
      return false;
    }
    if (buildTradeBuyOrderVariantKey(entry.rank ?? null) !== item.variantKey) {
      return false;
    }
    if (entry.platinum !== price) {
      return false;
    }

    const timestamp = parseTradeTimestamp(entry);
    return timestamp !== null && nowMs - timestamp <= recentWindowMs;
  });
}
