import type { WatchlistItem, WfmTopSellOrder } from '../types';

export type WatchlistRequestPriority = 'background' | 'medium' | 'high';

export const WATCHLIST_MIN_ITEM_SCAN_INTERVAL_MS = 15_000;
export const WATCHLIST_HIGH_PRIORITY_AGE_MS = 30_000;
export const WATCHLIST_SAFE_REQUESTS_PER_SECOND = 2;
export const WATCHLIST_SCANNER_TICK_MS = Math.ceil(
  1000 / WATCHLIST_SAFE_REQUESTS_PER_SECOND,
);
export const WATCHLIST_RETRY_BASE_DELAY_MS = 2_500;
export const WATCHLIST_RETRY_MAX_DELAY_MS = 15_000;

export function buildWatchlistUserKey(
  username: string,
  userSlug: string | null | undefined,
): string {
  const normalizedUsername = username.trim().toLowerCase();
  const normalizedUserSlug = userSlug?.trim().toLowerCase();

  return normalizedUserSlug ? `${normalizedUsername}:${normalizedUserSlug}` : normalizedUsername;
}

export function getWatchlistPollIntervalMs(itemCount: number): number {
  if (itemCount <= 0) {
    return WATCHLIST_MIN_ITEM_SCAN_INTERVAL_MS;
  }

  const adaptiveInterval = Math.ceil(
    (itemCount / WATCHLIST_SAFE_REQUESTS_PER_SECOND) * 1000,
  );

  return Math.max(WATCHLIST_MIN_ITEM_SCAN_INTERVAL_MS, adaptiveInterval);
}

export function getWatchlistRequestPriority(
  item: Pick<WatchlistItem, 'lastUpdatedAt'>,
  nowMs: number = Date.now(),
): WatchlistRequestPriority {
  if (!item.lastUpdatedAt) {
    return 'high';
  }

  const lastUpdatedMs = Date.parse(item.lastUpdatedAt);
  if (Number.isNaN(lastUpdatedMs)) {
    return 'high';
  }

  const ageMs = Math.max(0, nowMs - lastUpdatedMs);
  if (ageMs >= WATCHLIST_HIGH_PRIORITY_AGE_MS) {
    return 'high';
  }

  if (ageMs >= WATCHLIST_MIN_ITEM_SCAN_INTERVAL_MS) {
    return 'medium';
  }

  return 'background';
}

export function getWatchlistRetryDelayMs(
  retryCount: number,
  itemCount: number,
): number {
  const exponentialDelay = WATCHLIST_RETRY_BASE_DELAY_MS * 2 ** retryCount;

  return Math.min(
    Math.max(WATCHLIST_RETRY_BASE_DELAY_MS, exponentialDelay),
    Math.max(WATCHLIST_RETRY_MAX_DELAY_MS, getWatchlistPollIntervalMs(itemCount)),
  );
}

export function selectPreferredWatchlistOrder(
  orders: WfmTopSellOrder[],
  ignoredUserKeys: string[],
): WfmTopSellOrder | null {
  const ignoredUsers = new Set(ignoredUserKeys);

  for (const order of orders) {
    if (!ignoredUsers.has(buildWatchlistUserKey(order.username, order.userSlug))) {
      return order;
    }
  }

  return null;
}

export function selectNextWatchlistItemToScan(
  items: WatchlistItem[],
  nowMs: number = Date.now(),
): WatchlistItem | null {
  let nextDueItem: WatchlistItem | null = null;

  for (const item of items) {
    if (item.nextScanAt <= nowMs) {
      if (!nextDueItem || item.nextScanAt < nextDueItem.nextScanAt) {
        nextDueItem = item;
      }
    }
  }

  return nextDueItem;
}

export function getNextWatchlistScanDelayMs(
  items: WatchlistItem[],
  nowMs: number = Date.now(),
): number {
  let nextScanAt: number | null = null;

  for (const item of items) {
    if (nextScanAt === null || item.nextScanAt < nextScanAt) {
      nextScanAt = item.nextScanAt;
    }
  }

  if (nextScanAt === null) {
    return WATCHLIST_SCANNER_TICK_MS;
  }

  return Math.max(0, nextScanAt - nowMs);
}

export function getWatchlistVisualState(item: WatchlistItem): {
  tone: 'neutral' | 'yellow' | 'red';
  label: string;
} {
  if (item.currentPrice !== null && item.currentPrice <= item.targetPrice) {
    return {
      tone: 'red',
      label: 'Found',
    };
  }

  if (
    item.currentPrice !== null &&
    item.currentPrice <= item.targetPrice * 1.1
  ) {
    return {
      tone: 'yellow',
      label: 'Within 10%',
    };
  }

  if (item.lastError) {
    return {
      tone: 'neutral',
      label: 'Retrying',
    };
  }

  return {
    tone: 'neutral',
    label: 'Watching',
  };
}
