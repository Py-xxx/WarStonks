import test from 'node:test';
import assert from 'node:assert/strict';

import { formatSettingsErrorMessage } from './settingsErrorHandling.ts';

test('preserves already friendly settings messages', () => {
  const raw =
    'Couldn’t save Alecaframe settings right now. Please try again. If it keeps happening, report it in Discord. Reference: ALECAFRAME-SAVE-01';
  assert.equal(formatSettingsErrorMessage('alecaframe-save', new Error(raw)), raw);
});

test('preserves direct validation guidance', () => {
  const raw = 'Enter a valid Discord webhook URL before enabling Discord notifications.';
  assert.equal(formatSettingsErrorMessage('discord-webhook-save', new Error(raw)), raw);
});

test('falls back to friendly wallet refresh copy for raw errors', () => {
  assert.equal(
    formatSettingsErrorMessage('alecaframe-refresh', new Error('connection refused')),
    'Couldn’t refresh Alecaframe balances right now. Showing the last available wallet data if possible. If it keeps happening, report it in Discord. Reference: ALECAFRAME-WALLET-REFRESH-01',
  );
});
