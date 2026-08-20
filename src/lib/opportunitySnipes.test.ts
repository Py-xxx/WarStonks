import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  SNIPE_SCORE_FLOOR,
  buildOpportunityQueue,
  isActionableSnipe,
  snipeToOpportunity,
  type SnipeSource,
} from './opportunitySnipes.ts';
import type { Opportunity } from './tauriClient.ts';

/**
 * Guards the same class of bug as `opportunityView.test.ts`: two surfaces rendering the same
 * `Opportunity` objects and silently disagreeing about them.
 *
 * Snipe synthesis lived inside `OpportunityBoard`, so Home's "Act now" queue — the surface whose
 * whole job is "what do I act on right now" — never showed a single expiring play. Nothing about
 * that is visible in a type error or a rendering test; the lists just quietly differ.
 */

function listing(overrides: Partial<SnipeSource> = {}): SnipeSource {
  return {
    orderId: 'order-1',
    slug: 'mesa_prime_systems',
    itemName: 'Mesa Prime Systems',
    username: 'MagSnake',
    listedPrice: 40,
    recommendedPrice: 100,
    pctBelow: 60,
    tier: 'red',
    completesSet: {
      setSlug: 'mesa_prime_set',
      setName: 'Mesa Prime',
      ownedDistinct: 2,
      neededDistinct: 3,
    },
    status: 'new',
    ...overrides,
  };
}

function computed(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'computed-1',
    subjectKey: 'set:mesa_prime_set',
    category: 'setCompletion',
    titleKey: 'opp.snipeTitle',
    titleParams: {},
    subtitleKey: null,
    subtitleParams: {},
    setSlug: null,
    imagePath: null,
    estValue: 500,
    cost: 0,
    valueBasis: 'profit',
    pricedAt: null,
    confidence: 0.9,
    confidenceLabel: 'High',
    urgency: 'normal',
    reasons: [],
    actions: [],
    score: 450,
    ...overrides,
  } as Opportunity;
}

test('savings is the gap to recommended entry, never negative', () => {
  assert.equal(snipeToOpportunity(listing()).estValue, 60);
  assert.equal(
    snipeToOpportunity(listing({ listedPrice: 120, recommendedPrice: 100 })).estValue,
    0,
  );
});

test('value basis is savings, not profit — the queue ranks the two against each other', () => {
  assert.equal(snipeToOpportunity(listing()).valueBasis, 'savings');
});

test('a snipe outranks any computed play, however valuable', () => {
  const queue = buildOpportunityQueue(
    [computed({ score: 99_999 })],
    [listing()],
    new Set<string>(),
  );
  assert.equal(queue[0].category, 'snipe');
  assert.ok(queue[0].score >= SNIPE_SCORE_FLOOR);
});

test('only listings that complete a set become opportunities', () => {
  assert.equal(isActionableSnipe(listing({ completesSet: null })), false);
  assert.equal(buildOpportunityQueue([], [listing({ completesSet: null })], new Set()).length, 0);
});

test('a pulled or repriced listing is no longer a play', () => {
  for (const status of ['gone', 'overpriced']) {
    assert.equal(isActionableSnipe(listing({ status })), false, status);
  }
  assert.equal(isActionableSnipe(listing({ status: 'verified' })), true);
});

test('dismissals apply to snipes and computed plays alike', () => {
  const dismissed = new Set(['snipe:order-1', 'set:mesa_prime_set']);
  assert.equal(buildOpportunityQueue([computed()], [listing()], dismissed).length, 0);
});

test('confidence label follows the tier, and matches the thresholds it is derived from', () => {
  assert.equal(snipeToOpportunity(listing({ tier: 'red' })).confidenceLabel, 'High');
  assert.equal(snipeToOpportunity(listing({ tier: 'yellow' })).confidenceLabel, 'Medium');
  assert.equal(snipeToOpportunity(listing({ tier: 'normal' })).confidenceLabel, 'Medium');
});
