import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasAnyBalance,
  mergeWalletSnapshot,
  parsePersistedWalletBalances,
  serializeWalletBalances,
  shouldPersistWalletSnapshot,
} from './walletSnapshot.ts';
import type { CurrencyBalance, WalletSnapshot } from '../types/index.ts';

const EMPTY: CurrencyBalance = {
  platinum: null,
  credits: null,
  endo: null,
  ducats: null,
  aya: null,
};

const FULL: CurrencyBalance = {
  platinum: 672,
  credits: 1_250_000,
  endo: 4200,
  ducats: 286,
  aya: 15,
};

function snapshot(overrides: Partial<WalletSnapshot> = {}): WalletSnapshot {
  return {
    enabled: true,
    configured: true,
    balances: EMPTY,
    usernameWhenPublic: null,
    lastUpdate: null,
    errorMessage: null,
    ...overrides,
  };
}

test('a successful refresh replaces the previous snapshot wholesale', () => {
  const previous = snapshot({ balances: FULL, lastUpdate: '2026-08-16T09:00:00Z' });
  const next = snapshot({
    balances: { ...FULL, platinum: 700 },
    lastUpdate: '2026-08-16T09:05:00Z',
  });

  assert.deepEqual(mergeWalletSnapshot(previous, next), next);
});

test('a failed refresh keeps the last known balances instead of blanking them', () => {
  // The reported bug: AlecaFrame rewrites its data file, the poll reads it mid-write, and the
  // backend returns Ok with every balance null.
  const previous = snapshot({ balances: FULL, lastUpdate: '2026-08-16T09:00:00Z' });
  const next = snapshot({ errorMessage: 'AlecaFrame data was not found on this PC.' });

  const merged = mergeWalletSnapshot(previous, next);

  assert.deepEqual(merged.balances, FULL, 'currencies must stay on screen');
  assert.equal(
    merged.lastUpdate,
    '2026-08-16T09:00:00Z',
    'the timestamp must describe the numbers shown, not the failed attempt',
  );
  assert.equal(
    merged.errorMessage,
    'AlecaFrame data was not found on this PC.',
    'the failure is still reported',
  );
});

test('an empty payload with no error is also treated as a failed read', () => {
  const previous = snapshot({ balances: FULL });
  const next = snapshot({ balances: EMPTY });

  assert.deepEqual(mergeWalletSnapshot(previous, next).balances, FULL);
});

test('a null on a successful read is meaningful and is shown', () => {
  // A player with no Regal Aya: the payload parsed, aya is genuinely absent, and holding a
  // stale 15 would be a lie rather than a kindness.
  const previous = snapshot({ balances: FULL });
  const next = snapshot({ balances: { ...FULL, aya: null } });

  assert.equal(mergeWalletSnapshot(previous, next).balances.aya, null);
});

test('disabling AlecaFrame clears the strip rather than holding stale values', () => {
  const previous = snapshot({ balances: FULL });
  const next = snapshot({ enabled: false, configured: false, balances: EMPTY });

  assert.deepEqual(mergeWalletSnapshot(previous, next).balances, EMPTY);
});

test('a first failure with nothing cached reports the failure honestly', () => {
  const previous = snapshot({ balances: EMPTY });
  const next = snapshot({ errorMessage: 'decrypt failed' });

  const merged = mergeWalletSnapshot(previous, next);
  assert.deepEqual(merged.balances, EMPTY);
  assert.equal(merged.errorMessage, 'decrypt failed');
});

test('a partial payload is trusted, because a real read produced it', () => {
  // Ducats come from an inventory stack, not a wallet field, so a player holding none yields
  // a genuine null alongside real balances. That is a successful read, not a failure.
  const previous = snapshot({ balances: FULL });
  const next = snapshot({ balances: { ...EMPTY, platinum: 700, ducats: null } });

  const merged = mergeWalletSnapshot(previous, next);
  assert.equal(merged.balances.platinum, 700);
  assert.equal(merged.balances.ducats, null);
});

test('hasAnyBalance distinguishes empty from zero', () => {
  assert.equal(hasAnyBalance(EMPTY), false);
  // Zero platinum is a real balance and must not read as "no data".
  assert.equal(hasAnyBalance({ ...EMPTY, platinum: 0 }), true);
});

test('persisted balances round-trip', () => {
  const stored = serializeWalletBalances(
    snapshot({ balances: FULL, lastUpdate: '2026-08-16T09:00:00Z' }),
  );
  assert.deepEqual(parsePersistedWalletBalances(stored), {
    balances: FULL,
    lastUpdate: '2026-08-16T09:00:00Z',
  });
});

test('only a trustworthy read is persisted', () => {
  assert.equal(shouldPersistWalletSnapshot(snapshot({ balances: FULL })), true);
  // Persisting a failure would overwrite the good numbers the cache exists to preserve.
  assert.equal(
    shouldPersistWalletSnapshot(snapshot({ balances: FULL, errorMessage: 'decrypt failed' })),
    false,
  );
  assert.equal(shouldPersistWalletSnapshot(snapshot({ balances: EMPTY })), false);
  assert.equal(
    shouldPersistWalletSnapshot(snapshot({ enabled: false, balances: FULL })),
    false,
  );
});

test('a malformed or empty cache is rejected rather than half-restored', () => {
  // Currency the user trades against: a plausible-but-wrong platinum count is worse than none.
  assert.equal(parsePersistedWalletBalances(null), null);
  assert.equal(parsePersistedWalletBalances(''), null);
  assert.equal(parsePersistedWalletBalances('not json'), null);
  assert.equal(parsePersistedWalletBalances('{"balances":null}'), null);
  assert.equal(parsePersistedWalletBalances('{"balances":{"platinum":"672"}}'), null);
  assert.equal(parsePersistedWalletBalances('{"balances":{"platinum":null}}'), null);
  assert.equal(
    parsePersistedWalletBalances(JSON.stringify({ balances: EMPTY })),
    null,
    'an all-empty cache is not worth restoring',
  );
});

test('a cache missing its timestamp still restores, with a null age', () => {
  const restored = parsePersistedWalletBalances(JSON.stringify({ balances: FULL }));
  assert.deepEqual(restored, { balances: FULL, lastUpdate: null });
});
