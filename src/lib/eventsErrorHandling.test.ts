import test from 'node:test';
import assert from 'node:assert/strict';

import { formatEventsErrorMessage } from './eventsErrorHandling.ts';

test('falls back to friendly initial load copy for raw failures', () => {
  assert.equal(
    formatEventsErrorMessage('events-fissures', new Error('WFStat fissures request failed with 500')),
    'Couldn’t load fissures right now. Please try again. If it keeps happening, report it in Discord.',
  );
});

test('builds degraded message when cached data exists', () => {
  assert.equal(
    formatEventsErrorMessage(
      'events-void-trader',
      new Error('network timeout'),
      { lastAvailableAt: '2026-03-17T08:15:00.000Z' },
    ),
    'Couldn’t refresh Void Trader data right now. Showing the last available data from 17 Mar 2026 - 10:15am. If it keeps happening, report it in Discord.',
  );
});

test('preserves already friendly event messages', () => {
  const raw =
    'Couldn’t refresh market and news data right now. Showing the last available data if possible. If it keeps happening, report it in Discord.';
  assert.equal(
    formatEventsErrorMessage('events-market-news', new Error(raw), { lastAvailableAt: null }),
    raw,
  );
});
