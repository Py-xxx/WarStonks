import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRewardScanSignature,
  buildWatchedNameSet,
  normalizeRewardName,
} from './worldStatePricing.ts';

test('names differing only in case, punctuation or spacing normalize to the same key', () => {
  assert.equal(normalizeRewardName('Orokin Catalyst Blueprint'), 'orokin catalyst blueprint');
  assert.equal(normalizeRewardName('  OROKIN  Catalyst   Blueprint '), 'orokin catalyst blueprint');
  assert.equal(normalizeRewardName("Vauban's Helmet"), 'vaubans helmet');
  assert.equal(normalizeRewardName('Vauban’s Helmet'), 'vaubans helmet');
});

test('the watched set carries both the English name and the displayed one', () => {
  // A user on another language sees a localized displayName, but every worldstate payload is
  // English — matching on displayName alone would show no markers at all for them.
  const watched = buildWatchedNameSet([{ name: 'Prisma Gorgon', displayName: '棱镜戈尔工' }]);
  assert.ok(watched.has('prisma gorgon'));
  assert.ok(watched.has(normalizeRewardName('棱镜戈尔工')));
});

test('an empty name never enters the watched set', () => {
  // '' would otherwise match every reward whose name normalizes to nothing.
  assert.equal(buildWatchedNameSet([{ name: '', displayName: '' }]).size, 0);
});

test('the scan signature ignores order and duplicates', () => {
  // Invasions poll on a timer and repeat the same rewards; the signature is what keeps the scan
  // from re-running against WFM on every poll.
  const a = buildRewardScanSignature(['Mutagen Mass', 'Fieldron', 'Mutagen Mass']);
  const b = buildRewardScanSignature(['fieldron', 'MUTAGEN MASS']);
  assert.equal(a, b);
});

test('a changed reward set produces a different signature', () => {
  const before = buildRewardScanSignature(['Mutagen Mass']);
  const after = buildRewardScanSignature(['Mutagen Mass', 'Detonite Injector']);
  assert.notEqual(before, after);
});
