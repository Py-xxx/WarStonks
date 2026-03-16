import test from 'node:test';
import assert from 'node:assert/strict';
import { orderQuickViewVariants } from './marketVariantFallback.ts';

test('keeps the default variant first and then prefers higher ranks', () => {
  const ordered = orderQuickViewVariants([
    { key: 'rank:2', label: 'Rank 2', rank: 2, isDefault: false },
    { key: 'rank:0', label: 'Rank 0', rank: 0, isDefault: true },
    { key: 'rank:5', label: 'Rank 5', rank: 5, isDefault: false },
    { key: 'rank:3', label: 'Rank 3', rank: 3, isDefault: false },
  ]);

  assert.deepEqual(
    ordered.map((variant) => variant.key),
    ['rank:0', 'rank:5', 'rank:3', 'rank:2'],
  );
});

test('returns a stable copy for single-variant items', () => {
  const ordered = orderQuickViewVariants([
    { key: 'base', label: 'Base Market', rank: null, isDefault: true },
  ]);

  assert.deepEqual(ordered, [{ key: 'base', label: 'Base Market', rank: null, isDefault: true }]);
});

