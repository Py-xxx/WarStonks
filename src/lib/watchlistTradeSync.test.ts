import test from 'node:test';
import assert from 'node:assert/strict';
import type { TradeSellOrder, WatchlistItem } from '../types';
import {
  buildTradeBuyOrderVariantKey,
  findMissingWatchlistBuyOrderIds,
  indexTradeBuyOrdersByVariant,
} from './watchlistTradeSync.ts';

function createBuyOrder(input: Partial<TradeSellOrder> & Pick<TradeSellOrder, 'orderId' | 'slug' | 'updatedAt'>): TradeSellOrder {
  return {
    orderId: input.orderId,
    orderType: 'buy',
    wfmId: input.wfmId ?? 'wfm-id',
    itemId: input.itemId ?? 1,
    name: input.name ?? 'Test Item',
    slug: input.slug,
    imagePath: input.imagePath ?? null,
    rank: input.rank ?? null,
    maxRank: input.maxRank ?? null,
    quantity: input.quantity ?? 1,
    yourPrice: input.yourPrice ?? 10,
    marketLow: input.marketLow ?? null,
    priceGap: input.priceGap ?? null,
    visible: input.visible ?? true,
    updatedAt: input.updatedAt,
    healthScore: input.healthScore ?? null,
    healthNote: input.healthNote ?? null,
  };
}

function createWatchlistItem(input: Pick<WatchlistItem, 'id' | 'slug' | 'variantKey'>): WatchlistItem {
  return {
    id: input.id,
    itemId: 1,
    name: 'Test Item',
    displayName: 'Test Item',
    slug: input.slug,
    variantKey: input.variantKey,
    variantLabel: 'Base Market',
    imagePath: null,
    itemFamily: null,
    targetPrice: 10,
    currentPrice: null,
    currentSeller: null,
    currentUserSlug: null,
    currentOrderId: null,
    currentQuantity: null,
    currentRank: null,
    entryPrice: null,
    exitPrice: null,
    volume: 0,
    delta24h: 0,
    score: 0,
    lastUpdatedAt: null,
    nextScanAt: 0,
    retryCount: 0,
    lastError: null,
    ignoredUserKeys: [],
    linkedBuyOrderId: null,
  };
}

test('buildTradeBuyOrderVariantKey normalizes rank values', () => {
  assert.equal(buildTradeBuyOrderVariantKey(null), 'base');
  assert.equal(buildTradeBuyOrderVariantKey(3), 'rank:3');
});

test('indexTradeBuyOrdersByVariant keeps the latest order per slug and rank', () => {
  const orderMap = indexTradeBuyOrdersByVariant([
    createBuyOrder({ orderId: 'old', slug: 'barrel-diffusion', rank: 0, updatedAt: '2026-03-15T08:00:00Z' }),
    createBuyOrder({ orderId: 'new', slug: 'barrel-diffusion', rank: 0, updatedAt: '2026-03-15T09:00:00Z' }),
    createBuyOrder({ orderId: 'base', slug: 'barrel-diffusion', rank: null, updatedAt: '2026-03-15T07:00:00Z' }),
  ]);

  assert.equal(orderMap.get('barrel-diffusion:rank:0')?.orderId, 'new');
  assert.equal(orderMap.get('barrel-diffusion:base')?.orderId, 'base');
});

test('findMissingWatchlistBuyOrderIds only returns watchlist rows without matching remote buy orders', () => {
  const watchlist = [
    createWatchlistItem({ id: 'base', slug: 'barrel-diffusion', variantKey: 'base' }),
    createWatchlistItem({ id: 'rank0', slug: 'barrel-diffusion', variantKey: 'rank:0' }),
    createWatchlistItem({ id: 'other', slug: 'blind-rage', variantKey: 'base' }),
  ];
  const buyOrders = [
    createBuyOrder({ orderId: 'one', slug: 'barrel-diffusion', rank: null, updatedAt: '2026-03-15T07:00:00Z' }),
    createBuyOrder({ orderId: 'two', slug: 'barrel-diffusion', rank: 0, updatedAt: '2026-03-15T08:00:00Z' }),
  ];

  assert.deepEqual(findMissingWatchlistBuyOrderIds(watchlist, buyOrders), ['other']);
});
