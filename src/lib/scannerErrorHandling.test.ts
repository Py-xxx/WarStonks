import test from 'node:test';
import assert from 'node:assert/strict';

import { formatScannerErrorMessage } from './scannerErrorHandling.ts';

test('falls back to initial scanner load copy for raw failures', () => {
  assert.equal(
    formatScannerErrorMessage('scanner-state-load', new Error('sqlite busy')),
    'Couldn’t load scanner data right now. Please try again. If it keeps happening, report it in Discord.',
  );
});

test('builds degraded scanner refresh copy when a saved scan exists', () => {
  assert.equal(
    formatScannerErrorMessage(
      'scanner-run',
      new Error('scanner worker crashed'),
      { lastCompletedAt: '2026-03-17T08:15:00.000Z' },
    ),
    'Couldn’t complete the scanner refresh right now. Showing the last saved scan from 17 Mar 2026 - 10:15am. If it keeps happening, report it in Discord.',
  );
});

test('preserves already friendly start and stop scanner messages', () => {
  const startRaw =
    'Couldn’t start the scanner right now. Please try again. If it keeps happening, report it in Discord.';
  const stopRaw =
    'Couldn’t stop the scanner right now. Please try again. If it keeps happening, report it in Discord.';

  assert.equal(formatScannerErrorMessage('scanner-start', new Error(startRaw)), startRaw);
  assert.equal(formatScannerErrorMessage('scanner-stop', new Error(stopRaw)), stopRaw);
});
