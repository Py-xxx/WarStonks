import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { KNOWN_PARTS, partKeyForSlug, registerNeverOverrideSlugs } from './partImages.ts';

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), '../assets/partImages');

/**
 * The parts list and the shipped art are two halves of one fact. If they drift, a slug resolves
 * to a key with no file behind it and the icon silently falls back to Warframe.Market's
 * parent-item art — the exact bug this feature exists to fix, and invisible in review.
 */
test('every declared part has art, and every asset is declared', () => {
  const onDisk = new Set(
    readdirSync(ASSET_DIR)
      .filter((name) => name !== 'index.ts' && !name.startsWith('.'))
      .map((name) => name.replace(/\.[^.]+$/, '')),
  );

  const declared = new Set<string>();
  for (const [part, hasPrime] of KNOWN_PARTS) {
    declared.add(part);
    if (hasPrime) {
      declared.add(`${part}_prime`);
    }
  }

  assert.deepEqual(
    [...declared].sort(),
    [...onDisk].sort(),
    'KNOWN_PARTS and src/assets/partImages/ disagree',
  );
});

test('component slugs resolve to their part, prime-aware', () => {
  assert.equal(partKeyForSlug('grendel_prime_neuroptics'), 'neuroptics_prime');
  assert.equal(partKeyForSlug('grendel_prime_neuroptics_blueprint'), 'neuroptics_prime');
  assert.equal(partKeyForSlug('braton_prime_barrel'), 'barrel_prime');
  assert.equal(partKeyForSlug('boltor_barrel'), 'barrel');
  assert.equal(partKeyForSlug('excalibur_neuroptics_blueprint'), 'neuroptics');
});

test('two-word parts are matched before their last word', () => {
  assert.equal(partKeyForSlug('cernos_prime_upper_limb'), 'upper_limb_prime');
  assert.equal(partKeyForSlug('cernos_lower_limb'), 'lower_limb');
  // Nothing precedes the part, so it is not a component of anything.
  assert.equal(partKeyForSlug('upper_limb'), null);
});

test('parts without prime art fall back to the plain icon', () => {
  assert.equal(partKeyForSlug('odonata_prime_harness'), 'harness_prime');
  assert.equal(partKeyForSlug('something_prime_grip'), 'grip');
  assert.equal(partKeyForSlug('something_prime_hook'), 'hook');
});

/** Anchoring to the end of the slug is what prevents these. */
test('sets and whole items are not components', () => {
  assert.equal(partKeyForSlug('ash_prime_set'), null);
  assert.equal(partKeyForSlug('ash_prime_blueprint'), null);
  assert.equal(partKeyForSlug('braton_prime'), null);
  assert.equal(partKeyForSlug('stock'), null);
  assert.equal(partKeyForSlug(null), null);
  assert.equal(partKeyForSlug(''), null);
});

/**
 * "Conductive Blade" and "Tempered Blade" are mods, not components — but their slugs end in a
 * part word, so the naming rule replaced their card art with a sword blade. Nothing in the slug
 * distinguishes them from `boltor_blade`; only the catalog's item family does.
 */
test('mods and arcanes named like parts keep their own art', () => {
  // Before the catalog answers, the rule cannot know — this is the bug's original behaviour.
  assert.equal(partKeyForSlug('conductive_blade'), 'blade');

  registerNeverOverrideSlugs([
    'conductive_blade',
    'tempered_blade',
    // A mod that could never collide is not worth remembering.
    'serration',
  ]);

  assert.equal(partKeyForSlug('conductive_blade'), null);
  assert.equal(partKeyForSlug('tempered_blade'), null);
  // Real components are untouched by the exclusion.
  assert.equal(partKeyForSlug('boltor_prime_barrel'), 'barrel_prime');
  assert.equal(partKeyForSlug('dakra_prime_blade'), 'blade_prime');
});
