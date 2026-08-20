import test from 'node:test';
import assert from 'node:assert/strict';

import { isWorldStateEntryOpen } from './worldStateExpiry.ts';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const inOneHour = new Date(NOW + 3_600_000).toISOString();
const anHourAgo = new Date(NOW - 3_600_000).toISOString();

test('an entry with time left is open', () => {
  assert.equal(isWorldStateEntryOpen(inOneHour, false, NOW), true);
  assert.equal(isWorldStateEntryOpen(inOneHour, undefined, NOW), true);
});

test('the API\'s expired flag closes an entry even if its expiry still parses in the future', () => {
  // warframestat.us returns recently-ended fissures with expired: true. Trusting only the clock
  // is what put "Expired" rows in Home's relic panel.
  assert.equal(isWorldStateEntryOpen(inOneHour, true, NOW), false);
});

test('an entry whose expiry has passed is closed even while the flag still says otherwise', () => {
  // The flag is computed at poll time, so between polls it lags. The clock catches that.
  assert.equal(isWorldStateEntryOpen(anHourAgo, false, NOW), false);
});

test('missing or unparseable expiries are closed, not open', () => {
  assert.equal(isWorldStateEntryOpen(null, false, NOW), false);
  assert.equal(isWorldStateEntryOpen('not-a-date', false, NOW), false);
});

test('an expiry exactly at now is closed', () => {
  assert.equal(isWorldStateEntryOpen(new Date(NOW).toISOString(), false, NOW), false);
});
