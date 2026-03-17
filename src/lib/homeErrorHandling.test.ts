import test from 'node:test';
import assert from 'node:assert/strict';

import { formatHomeErrorMessage } from './homeErrorHandling.ts';

test('preserves direct watchlist validation copy', () => {
  const raw = 'Enter a desired price greater than 0.';
  assert.equal(formatHomeErrorMessage('watchlist-add', new Error(raw)), raw);
});

test('preserves already friendly home messages', () => {
  const raw =
    'Couldn’t mark this item as bought right now. Please try again. If it keeps happening, report it in Discord.';
  assert.equal(formatHomeErrorMessage('watchlist-mark-bought', new Error(raw)), raw);
});

test('falls back to quick view copy message for raw failures', () => {
  assert.equal(
    formatHomeErrorMessage('dashboard-quick-view-copy', new Error('clipboard denied')),
    'Couldn’t copy the whisper message right now. Please try again. If it keeps happening, report it in Discord.',
  );
});
