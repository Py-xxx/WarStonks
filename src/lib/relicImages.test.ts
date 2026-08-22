import { strict as assert } from 'node:assert';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

import { RELIC_ERAS, relicEraKey } from './relicImages.ts';

/**
 * "These images should overwrite ALL relics anywhere" is a rule whose failure is silent: a relic
 * that misses the match just keeps WFM's own art, and nobody notices until they spot two different
 * pictures for the same relic on two screens. That is the bug the era art exists to remove, so the
 * matching rule is pinned here rather than left to the eye.
 */

test('every era we ship art for has a file, and every file has an era', () => {
  const files = readdirSync('src/assets/relicImages')
    .filter((name) => name.endsWith('.webp'))
    .map((name) => name.replace(/\.webp$/, ''))
    .sort();
  assert.deepEqual(files, [...RELIC_ERAS].sort());
});

test('a relic is matched by tier, slug or name — whichever the surface happens to hold', () => {
  assert.equal(relicEraKey({ tier: 'Lith' }), 'lith');
  assert.equal(relicEraKey({ slug: 'meso_k1_relic' }), 'meso');
  assert.equal(relicEraKey({ name: 'Neo V8 Relic' }), 'neo');
  // Refinement is not part of the identity — all four share one picture.
  for (const refinement of ['Intact', 'Exceptional', 'Flawless', 'Radiant']) {
    assert.equal(relicEraKey({ name: `Axi A1 ${refinement}` }), 'axi', refinement);
  }
});

test('tier wins over slug and name, so a mismatched payload cannot flip the art', () => {
  assert.equal(relicEraKey({ tier: 'Axi', slug: 'lith_k1_relic', name: 'Neo V8 Relic' }), 'axi');
});

test('non-relics get no relic art', () => {
  assert.equal(relicEraKey({ name: 'Mesa Prime Systems', slug: 'mesa_prime_systems' }), null);
  assert.equal(relicEraKey({}), null);
  assert.equal(relicEraKey({ name: '', slug: null, tier: undefined }), null);
  // An era word alone is not a relic — a relic always carries a code.
  assert.equal(relicEraKey({ name: 'Lith' }), null);
  // …and a slug must actually say "relic", so an item merely starting with an era word is safe.
  assert.equal(relicEraKey({ slug: 'lith_something_else' }), null);
});

test('matching is case- and whitespace-insensitive, because these come from six backends', () => {
  assert.equal(relicEraKey({ tier: '  AXI  ' }), 'axi');
  assert.equal(relicEraKey({ name: 'lith k1 relic' }), 'lith');
  assert.equal(relicEraKey({ slug: 'REQUIEM_I_RELIC' }), 'requiem');
});
