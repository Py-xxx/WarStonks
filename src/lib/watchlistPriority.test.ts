import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWatchlistRequestPriority,
  WATCHLIST_MEDIUM_PRIORITY_AGE_MS,
  WATCHLIST_HIGH_PRIORITY_AGE_MS,
} from './watchlist.ts';

test('watchlist priority is high when an item has never been refreshed', () => {
  assert.equal(getWatchlistRequestPriority({ lastUpdatedAt: null }), 'high');
});

test('watchlist priority stays low while the item is fresh', () => {
  assert.equal(
    getWatchlistRequestPriority(
      { lastUpdatedAt: new Date(20_000 - (WATCHLIST_MEDIUM_PRIORITY_AGE_MS - 1)).toISOString() },
      20_000,
    ),
    'low',
  );
});

test('watchlist priority escalates to medium once the item is overdue', () => {
  assert.equal(
    getWatchlistRequestPriority(
      { lastUpdatedAt: new Date(60_000 - WATCHLIST_MEDIUM_PRIORITY_AGE_MS).toISOString() },
      60_000,
    ),
    'medium',
  );
});

test('watchlist priority escalates to high after a long delay', () => {
  assert.equal(
    getWatchlistRequestPriority(
      { lastUpdatedAt: new Date(90_000 - WATCHLIST_HIGH_PRIORITY_AGE_MS).toISOString() },
      90_000,
    ),
    'high',
  );
});
