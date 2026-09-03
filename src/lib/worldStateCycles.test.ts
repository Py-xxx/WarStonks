import test from 'node:test';
import assert from 'node:assert/strict';

import { readCycleState, worldStateCycleSignature } from './worldStateCycles.ts';

const payload = (over: Record<string, unknown> = {}) => ({
  cetusCycle: { state: 'day' },
  vallisCycle: { state: 'warm' },
  cambionCycle: { state: 'fass' },
  earthCycle: { state: 'day' },
  ...over,
});

test('a flip changes the signature', () => {
  assert.notEqual(
    worldStateCycleSignature(payload()),
    worldStateCycleSignature(payload({ cetusCycle: { state: 'night' } })),
  );
});

test('a re-fetch with the same states produces the same signature', () => {
  // This is what stops every cycles poll triggering a full worldstate refresh.
  assert.equal(worldStateCycleSignature(payload()), worldStateCycleSignature(payload()));
});

test('state is read case-insensitively and trimmed', () => {
  assert.equal(readCycleState({ cetusCycle: { state: ' Night ' } }, 'cetusCycle'), 'night');
});

test('the boolean-only payloads are honoured', () => {
  // Some payloads carry isDay / isWarm and no `state` string at all.
  assert.equal(readCycleState({ cetusCycle: { isDay: false } }, 'cetusCycle'), 'night');
  assert.equal(readCycleState({ vallisCycle: { isWarm: true } }, 'vallisCycle'), 'warm');
});

test('an unreadable payload is null, not a signature', () => {
  // A failed fetch must read as "no information". Returning a string of all-unknowns would
  // differ from the last good signature and fire a full worldstate refresh on every error.
  assert.equal(worldStateCycleSignature(null), null);
  assert.equal(worldStateCycleSignature({}), null);
  assert.equal(worldStateCycleSignature({ cetusCycle: {} }), null);
});

test('a partially readable payload still yields a signature', () => {
  const sig = worldStateCycleSignature({ cetusCycle: { state: 'night' } });
  assert.ok(sig?.includes('cetusCycle:night'));
  assert.ok(sig?.includes('vallisCycle:?'));
});
