import assert from 'node:assert/strict';
import { test } from 'node:test';

import { indexPriceBook, totalValue, valueItem, variantKeyForRank } from './priceBook.ts';
import type { AlecaframeItem, PriceBookEntry } from '../types/index.ts';

function entry(overrides: Partial<PriceBookEntry> = {}): PriceBookEntry {
  return {
    itemKey: 'key-mesa',
    variantKey: 'base',
    slug: 'mesa_prime_set',
    exitPrice: 70,
    basis: 'recentTrades',
    sampleVolume: 7,
    observedAt: '2026-08-07T21:00:00Z',
    ...overrides,
  };
}

function item(overrides: Partial<AlecaframeItem> = {}): AlecaframeItem {
  return {
    uniqueName: '/Lotus/Test',
    name: 'Mesa Prime Set',
    slug: 'mesa_prime_set',
    itemKey: 'key-mesa',
    count: 1,
    rank: null,
    maxRank: null,
    refinement: null,
    imagePath: null,
    bucket: 'MiscItems',
    category: 'part',
    ...overrides,
  } as AlecaframeItem;
}

test('variant keys mirror the backend convention', () => {
  assert.equal(variantKeyForRank(null), 'base');
  assert.equal(variantKeyForRank(0), 'rank:0');
  assert.equal(variantKeyForRank(5), 'rank:5');
});

test('an unranked item takes the base price and multiplies by the stack', () => {
  const index = indexPriceBook([entry()]);
  const valuation = valueItem(item({ count: 3 }), index);
  assert.ok(valuation);
  assert.equal(valuation.entry.exitPrice, 70);
  assert.equal(valuation.totalPlatinum, 210);
  assert.equal(valuation.fromUnrankedVariant, false);
});

test('an exact ranked match is preferred over the base row', () => {
  const index = indexPriceBook([
    entry({ exitPrice: 15 }),
    entry({ variantKey: 'rank:5', exitPrice: 180 }),
  ]);
  const valuation = valueItem(item({ rank: 5, maxRank: 5 }), index);
  assert.ok(valuation);
  assert.equal(valuation.entry.exitPrice, 180);
  assert.equal(valuation.fromUnrankedVariant, false);
});

test('a ranked item with no ranked price falls back to base, flagged as a floor', () => {
  // The whole point of the flag: a rank-5 arcane is worth far more than its rank-0 price, so the
  // number is usable only if the tile says the rank is not priced in.
  const index = indexPriceBook([entry({ exitPrice: 15 })]);
  const valuation = valueItem(item({ rank: 5, maxRank: 5 }), index);
  assert.ok(valuation);
  assert.equal(valuation.entry.exitPrice, 15);
  assert.equal(valuation.fromUnrankedVariant, true);
});

test('rank 0 is the base variant, not a fallback', () => {
  const index = indexPriceBook([entry({ exitPrice: 15 })]);
  const valuation = valueItem(item({ rank: 0, maxRank: 5 }), index);
  assert.ok(valuation);
  assert.equal(valuation.fromUnrankedVariant, false, 'an unranked mod is genuinely the base variant');
});

test('an item the book does not know is unpriced rather than free', () => {
  const index = indexPriceBook([entry()]);
  assert.equal(valueItem(item({ itemKey: 'key-unknown' }), index), null);
});

test('variants of one item do not collide in the index', () => {
  const index = indexPriceBook([entry({ exitPrice: 15 }), entry({ variantKey: 'rank:5', exitPrice: 180 })]);
  assert.equal(index.size, 2);
  assert.equal(index.get('key-mesa', 'base')?.exitPrice, 15);
  assert.equal(index.get('key-mesa', 'rank:5')?.exitPrice, 180);
});

test('totals count unpriced items separately instead of hiding them', () => {
  const index = indexPriceBook([entry({ exitPrice: 70 })]);
  const total = totalValue(
    [item({ count: 2 }), item({ itemKey: 'key-unknown', count: 5 })],
    index,
  );
  assert.equal(total.platinum, 140);
  assert.equal(total.pricedItems, 1);
  assert.equal(total.unpricedItems, 1, 'an unpriced item must not silently read as 0p');
});

test('an empty book values nothing and totals zero', () => {
  const index = indexPriceBook([]);
  assert.equal(index.size, 0);
  assert.equal(valueItem(item(), index), null);
  assert.deepEqual(totalValue([item()], index), {
    platinum: 0,
    pricedItems: 0,
    unpricedItems: 1,
  });
});
