import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atLeastOneChance,
  bestRefinementFor,
  computeDropOdds,
  expectedDropCount,
  runsForTarget,
} from './relicDropOdds.ts';

const near = (actual: number, expected: number, tolerance = 1e-6) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );
};

test('at-least-one uses real probability, not naive chance x count', () => {
  // 5 radiant at 20% is 67%, NOT the naive 100% — the whole point of this module.
  near(atLeastOneChance([{ chance: 0.2, count: 5 }]), 1 - Math.pow(0.8, 5));
  near(atLeastOneChance([{ chance: 0.2, count: 5 }]), 0.67232, 1e-5);
  // 20 intact at 2% is 33%, not 40%.
  near(atLeastOneChance([{ chance: 0.02, count: 20 }]), 0.332392, 1e-5);
  // Never exceeds 1 no matter how many runs (100 runs at 50% rounds to exactly 1.0 in float).
  assert.ok(atLeastOneChance([{ chance: 0.5, count: 100 }]) <= 1);
});

test('at-least-one combines mixed refinements', () => {
  const odds = atLeastOneChance([
    { chance: 0.2, count: 2 },
    { chance: 0.02, count: 5 },
  ]);
  near(odds, 1 - Math.pow(0.8, 2) * Math.pow(0.98, 5));
});

test('zero counts and zero chances contribute nothing', () => {
  near(atLeastOneChance([{ chance: 0.5, count: 0 }]), 0);
  near(atLeastOneChance([{ chance: 0, count: 10 }]), 0);
  near(atLeastOneChance([]), 0);
});

test('expected drops is the linear sum and may exceed one', () => {
  near(expectedDropCount([{ chance: 0.2, count: 5 }]), 1);
  near(expectedDropCount([{ chance: 0.2, count: 10 }]), 2);
});

test('runs needed for a target probability', () => {
  // Default target is 80%: at 20% per run that's 8 runs (0.8^7 = 0.21 > 0.20, 0.8^8 = 0.168).
  assert.equal(runsForTarget(0.2), 8);
  assert.equal(runsForTarget(0.2, 0.9), 11);
  assert.equal(runsForTarget(0), null);
});

test('best refinement is the highest chance, not simply radiant', () => {
  assert.deepEqual(
    bestRefinementFor({ intact: 0.02, exceptional: 0.11, flawless: 0.2, radiant: 0.1 }),
    { key: 'flawless', chance: 0.2 },
  );
  assert.equal(bestRefinementFor({ intact: 0, radiant: 0 }), null);
});

test('computeDropOdds reports your real odds at the refinements you hold', () => {
  const summary = computeDropOdds([
    {
      label: 'Meso O2',
      chances: { intact: 0.02, exceptional: 0.04, flawless: 0.11, radiant: 0.2 },
      counts: { intact: 20, radiant: 5 },
    },
  ]);

  assert.equal(summary.totalRelics, 25);
  near(summary.atLeastOne, 1 - Math.pow(0.98, 20) * Math.pow(0.8, 5), 1e-9);
  near(summary.expectedDrops, 0.02 * 20 + 0.2 * 5, 1e-9);

  const relic = summary.relics[0];
  assert.equal(relic.totalCount, 25);
  // Breakdown is best-chance first and only covers refinements actually held.
  assert.deepEqual(relic.breakdown.map((entry) => entry.refinement), ['radiant', 'intact']);
  assert.equal(relic.missingBest, false, 'holds radiant, which ties the best chance');
});

test('computeDropOdds flags when you hold none at the best refinement', () => {
  const summary = computeDropOdds([
    {
      label: 'Neo V8',
      chances: { intact: 0.02, radiant: 0.2 },
      counts: { intact: 10 },
    },
  ]);
  const relic = summary.relics[0];
  assert.equal(relic.bestRefinement, 'radiant');
  assert.equal(relic.missingBest, true, 'upgrading to radiant would help');
  near(relic.atLeastOne, 1 - Math.pow(0.98, 10), 1e-9);
});

test('relics you own none of are excluded entirely', () => {
  const summary = computeDropOdds([
    { label: 'Owned', chances: { radiant: 0.2 }, counts: { radiant: 3 } },
    { label: 'Not owned', chances: { radiant: 0.5 }, counts: {} },
  ]);
  assert.deepEqual(summary.relics.map((relic) => relic.label), ['Owned']);
  assert.equal(summary.totalRelics, 3);
});
