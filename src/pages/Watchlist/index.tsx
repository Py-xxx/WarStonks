import { WatchlistTab } from './WatchlistTab';

/**
 * Full watchlist management, promoted out of Home's sub-tabs to a top-level page.
 *
 * The watchlist is a primary workflow with its own CRUD surface (add, target, quantity, tone
 * filters), which is a poor fit for a dashboard: Home shows only the items that need acting on
 * and links here for everything else. Body is unchanged from the old sub-tab — this move is
 * navigation only, so nothing about how the watchlist behaves changes with it.
 */
export function WatchlistPage() {
  return <WatchlistTab />;
}
