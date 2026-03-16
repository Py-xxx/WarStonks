import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWatchlistMarketSignals } from './watchlistMarketSignals.ts';
import type { WatchlistItem } from '../types';

const NOW_MS = Date.parse('2026-03-16T10:00:00.000Z');

function makeItem(overrides: Partial<WatchlistItem>): WatchlistItem {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    itemId: overrides.itemId ?? 1,
    name: overrides.name ?? 'Test Prime Blueprint',
    displayName: overrides.displayName ?? 'Test Prime Blueprint',
    slug: overrides.slug ?? 'test_prime_blueprint',
    variantKey: overrides.variantKey ?? 'base',
    variantLabel: overrides.variantLabel ?? 'Base Market',
    imagePath: overrides.imagePath ?? null,
    itemFamily: overrides.itemFamily ?? 'Prime Parts',
    targetPrice: overrides.targetPrice ?? 50,
    currentPrice: overrides.currentPrice ?? 40,
    currentSeller: overrides.currentSeller ?? null,
    currentUserSlug: overrides.currentUserSlug ?? null,
    currentOrderId: overrides.currentOrderId ?? null,
    currentQuantity: overrides.currentQuantity ?? null,
    currentRank: overrides.currentRank ?? null,
    entryPrice: overrides.entryPrice ?? 35,
    exitPrice: overrides.exitPrice ?? 55,
    volume: overrides.volume ?? 12,
    delta24h: overrides.delta24h ?? 6,
    score: overrides.score ?? 50,
    lastUpdatedAt: overrides.lastUpdatedAt ?? new Date(NOW_MS - 5 * 60_000).toISOString(),
    nextScanAt: overrides.nextScanAt ?? NOW_MS + 60_000,
    retryCount: overrides.retryCount ?? 0,
    lastError: overrides.lastError ?? null,
    ignoredUserKeys: overrides.ignoredUserKeys ?? [],
    linkedBuyOrderId: overrides.linkedBuyOrderId ?? null,
  };
}

test('returns empty signals when not enough fresh watchlist items qualify', () => {
  const signals = buildWatchlistMarketSignals(
    [
      makeItem({ id: '1' }),
      makeItem({ id: '2' }),
      makeItem({ id: '3', lastUpdatedAt: new Date(NOW_MS - 40 * 60_000).toISOString() }),
      makeItem({ id: '4', currentPrice: null }),
    ],
    NOW_MS,
  );

  assert.equal(signals.length, 3);
  for (const signal of signals) {
    assert.equal(signal.score, null);
    assert.equal(signal.valueText, '—');
  }
});

test('builds positive momentum and tradable spread quality from fresh items', () => {
  const items = [
    makeItem({ id: '1', delta24h: 12, currentPrice: 38, entryPrice: 35, exitPrice: 56, volume: 20 }),
    makeItem({ id: '2', delta24h: 10, currentPrice: 39, entryPrice: 34, exitPrice: 58, volume: 18 }),
    makeItem({ id: '3', delta24h: 8, currentPrice: 37, entryPrice: 35, exitPrice: 54, volume: 16 }),
    makeItem({ id: '4', delta24h: 7, currentPrice: 36, entryPrice: 33, exitPrice: 52, volume: 15 }),
    makeItem({ id: '5', delta24h: 6, currentPrice: 35, entryPrice: 32, exitPrice: 50, volume: 14 }),
    makeItem({ id: '6', delta24h: 9, currentPrice: 37, entryPrice: 34, exitPrice: 55, volume: 17 }),
  ];

  const [momentum, spreadQuality, volatility] = buildWatchlistMarketSignals(items, NOW_MS);

  assert.ok(momentum.score !== null && momentum.score > 20);
  assert.equal(momentum.valueText, 'Bullish');
  assert.ok(spreadQuality.score !== null && spreadQuality.score > 45);
  assert.equal(spreadQuality.sampleCount, 6);
  assert.ok(volatility.score !== null && volatility.score > 0);
});

test('ignores stale and errored items in signal calculations', () => {
  const freshItems = [
    makeItem({ id: '1', delta24h: -6 }),
    makeItem({ id: '2', delta24h: -7 }),
    makeItem({ id: '3', delta24h: -8 }),
    makeItem({ id: '4', delta24h: -5 }),
    makeItem({ id: '5', delta24h: -9 }),
  ];
  const staleItem = makeItem({
    id: 'stale',
    delta24h: 40,
    lastUpdatedAt: new Date(NOW_MS - 45 * 60_000).toISOString(),
  });
  const erroredItem = makeItem({ id: 'err', delta24h: 40, lastError: 'network' });

  const [momentum] = buildWatchlistMarketSignals([...freshItems, staleItem, erroredItem], NOW_MS);

  assert.equal(momentum.sampleCount, 5);
  assert.ok(momentum.score !== null && momentum.score < 0);
  assert.equal(momentum.valueText, 'Weak');
});
