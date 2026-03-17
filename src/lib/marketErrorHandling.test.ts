import test from 'node:test';
import assert from 'node:assert/strict';

import { formatMarketErrorMessage } from './marketErrorHandling.ts';

test('preserves already friendly market error messages', () => {
  const raw =
    'Couldn’t load market analytics right now. Please try again. If it keeps happening, report it in Discord.';
  assert.equal(formatMarketErrorMessage('market-analytics-load', new Error(raw)), raw);
});

test('falls back to friendly analysis refresh copy for raw failures', () => {
  assert.equal(
    formatMarketErrorMessage('market-analysis-refresh', new Error('database busy')),
    'Couldn’t refresh the market analysis right now. Showing the last available analysis if possible. If it keeps happening, report it in Discord.',
  );
});

test('falls back to friendly item detail copy for raw failures', () => {
  assert.equal(
    formatMarketErrorMessage('market-item-details-load', new Error('no row returned')),
    'Couldn’t load item details right now. Showing the best available item info if possible. If it keeps happening, report it in Discord.',
  );
});
