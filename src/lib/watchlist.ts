import type { WfmTopSellOrder } from '../types';

export const WATCHLIST_MIN_ITEM_SCAN_INTERVAL_MS = 10_500;
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
