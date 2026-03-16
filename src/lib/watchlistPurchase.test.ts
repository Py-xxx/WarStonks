import test from 'node:test';
import assert from 'node:assert/strict';
import type { PortfolioTradeLogEntry, TradeSellOrder, WatchlistItem } from '../types';
import {
  findActiveWatchlistBuyOrder,
  hasRecentClosedBuyTradeAtPrice,
  WATCHLIST_PURCHASE_RECENT_CLOSE_WINDOW_MS,
} from './watchlistPurchase.ts';

function createWatchlistItem(input: Partial<WatchlistItem> & Pick<WatchlistItem, 'id' | 'slug' | 'variantKey'>): WatchlistItem {
  return {
    id: input.id,
    itemId: input.itemId ?? 1,
    name: input.name ?? 'Test Item',
    displayName: input.displayName ?? 'Test Item',
    slug: input.slug,
    variantKey: input.variantKey,
    variantLabel: input.variantLabel ?? 'Base Market',
    imagePath: input.imagePath ?? null,
    itemFamily: input.itemFamily ?? null,
    targetPrice: input.targetPrice ?? 10,
    currentPrice: input.currentPrice ?? null,
    currentSeller: input.currentSeller ?? null,
    currentUserSlug: input.currentUserSlug ?? null,
    currentOrderId: input.currentOrderId ?? null,
    currentQuantity: input.currentQuantity ?? null,
    currentRank: input.currentRank ?? null,
    entryPrice: input.entryPrice ?? null,
    exitPrice: input.exitPrice ?? null,
    volume: input.volume ?? 0,
    delta24h: input.delta24h ?? 0,
    score: input.score ?? 0,
    lastUpdatedAt: input.lastUpdatedAt ?? null,
    nextScanAt: input.nextScanAt ?? 0,
    retryCount: input.retryCount ?? 0,
    lastError: input.lastError ?? null,
    ignoredUserKeys: input.ignoredUserKeys ?? [],
    linkedBuyOrderId: input.linkedBuyOrderId ?? null,
  };
}

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

function createTradeLogEntry(input: Partial<PortfolioTradeLogEntry> & Pick<PortfolioTradeLogEntry, 'id' | 'slug' | 'orderType' | 'platinum' | 'closedAt' | 'updatedAt'>): PortfolioTradeLogEntry {
  return {
    id: input.id,
    itemName: input.itemName ?? 'Test Item',
    slug: input.slug,
    imagePath: input.imagePath ?? null,
    orderType: input.orderType,
    source: input.source ?? 'wfm',
    platinum: input.platinum,
    quantity: input.quantity ?? 1,
    rank: input.rank ?? null,
    closedAt: input.closedAt,
    updatedAt: input.updatedAt,
    profit: input.profit ?? null,
    margin: input.margin ?? null,
    status: input.status ?? null,
    keepItem: input.keepItem ?? false,
    groupId: input.groupId ?? null,
    groupLabel: input.groupLabel ?? null,
    groupTotalPlatinum: input.groupTotalPlatinum ?? null,
    groupItemCount: input.groupItemCount ?? null,
    allocationTotalPlatinum: input.allocationTotalPlatinum ?? null,
    groupSortOrder: input.groupSortOrder ?? null,
    allocationMode: input.allocationMode ?? null,
    costBasisConfidence: input.costBasisConfidence ?? null,
    costBasisLabel: input.costBasisLabel ?? null,
    matchedCost: input.matchedCost ?? null,
    matchedQuantity: input.matchedQuantity ?? null,
    matchedBuyCount: input.matchedBuyCount ?? 0,
    matchedBuyRows: input.matchedBuyRows ?? [],
    setComponentRows: input.setComponentRows ?? [],
    profitFormula: input.profitFormula ?? null,
    duplicateRisk: input.duplicateRisk ?? false,
  };
}

test('findActiveWatchlistBuyOrder prefers the linked order id', () => {
  const item = createWatchlistItem({
    id: 'one',
    slug: 'barrel-diffusion',
    variantKey: 'rank:0',
    linkedBuyOrderId: 'linked',
  });
  const orders = [
    createBuyOrder({ orderId: 'older', slug: 'barrel-diffusion', rank: 0, updatedAt: '2026-03-16T08:00:00Z' }),
    createBuyOrder({ orderId: 'linked', slug: 'barrel-diffusion', rank: 0, updatedAt: '2026-03-16T07:00:00Z' }),
  ];

  assert.equal(findActiveWatchlistBuyOrder(item, orders)?.orderId, 'linked');
});

test('findActiveWatchlistBuyOrder falls back to the latest order for the same slug and variant', () => {
  const item = createWatchlistItem({
    id: 'one',
    slug: 'barrel-diffusion',
    variantKey: 'rank:0',
  });
  const orders = [
    createBuyOrder({ orderId: 'base', slug: 'barrel-diffusion', rank: null, updatedAt: '2026-03-16T08:00:00Z' }),
    createBuyOrder({ orderId: 'old', slug: 'barrel-diffusion', rank: 0, updatedAt: '2026-03-16T08:00:00Z' }),
    createBuyOrder({ orderId: 'new', slug: 'barrel-diffusion', rank: 0, updatedAt: '2026-03-16T09:00:00Z' }),
  ];

  assert.equal(findActiveWatchlistBuyOrder(item, orders)?.orderId, 'new');
});

test('hasRecentClosedBuyTradeAtPrice only matches recent WFM buy rows at the exact price and variant', () => {
  const nowMs = Date.parse('2026-03-16T10:00:00Z');
  const item = createWatchlistItem({
    id: 'one',
    slug: 'barrel-diffusion',
    variantKey: 'rank:0',
  });
  const entries = [
    createTradeLogEntry({
      id: 'wrong-price',
      slug: 'barrel-diffusion',
      orderType: 'buy',
      platinum: 11,
      rank: 0,
      closedAt: '2026-03-16T09:58:30Z',
      updatedAt: '2026-03-16T09:58:30Z',
    }),
    createTradeLogEntry({
      id: 'wrong-source',
      slug: 'barrel-diffusion',
      orderType: 'buy',
      source: 'alecaframe',
      platinum: 10,
      rank: 0,
      closedAt: '2026-03-16T09:58:30Z',
      updatedAt: '2026-03-16T09:58:30Z',
    }),
    createTradeLogEntry({
      id: 'stale',
      slug: 'barrel-diffusion',
      orderType: 'buy',
      platinum: 10,
      rank: 0,
      closedAt: new Date(nowMs - WATCHLIST_PURCHASE_RECENT_CLOSE_WINDOW_MS - 1).toISOString(),
      updatedAt: new Date(nowMs - WATCHLIST_PURCHASE_RECENT_CLOSE_WINDOW_MS - 1).toISOString(),
    }),
    createTradeLogEntry({
      id: 'match',
      slug: 'barrel-diffusion',
      orderType: 'buy',
      platinum: 10,
      rank: 0,
      closedAt: '2026-03-16T09:58:30Z',
      updatedAt: '2026-03-16T09:58:30Z',
    }),
  ];

  assert.equal(hasRecentClosedBuyTradeAtPrice(item, 10, entries, nowMs), true);
  assert.equal(hasRecentClosedBuyTradeAtPrice(item, 15, entries, nowMs), false);
});
