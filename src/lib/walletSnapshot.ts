import type { CurrencyBalance, WalletSnapshot } from '../types';

/**
 * Keeping the currency strip populated across a failed refresh.
 *
 * `refresh_wallet_from_appdata` does not fail loudly. Every recoverable problem — AlecaFrame's
 * data file missing, unreadable, or failing to decrypt — comes back as a successful `Ok` whose
 * balances are all `null`, with the detail in `errorMessage`. The store's `catch` therefore
 * never runs for those, and the success path used to write that empty snapshot straight over a
 * good one, blanking every currency to `-` until the next poll up to a minute later.
 *
 * That is not a rare path: AlecaFrame rewrites `lastData.dat` whenever Overwolf pushes it an
 * update, so a poll that lands mid-write reads a partial file and wipes the strip.
 *
 * The fix is to treat *whether the read succeeded* as the signal, never *whether the numbers
 * look empty*. On a successful read a `null` is meaningful — that currency genuinely is not in
 * the payload — and must be shown as such. On a failed read no `null` means anything, so the
 * last known values stay on screen.
 */

const CURRENCY_KEYS = ['platinum', 'credits', 'endo', 'ducats', 'aya'] as const;

export function hasAnyBalance(balances: CurrencyBalance): boolean {
  return CURRENCY_KEYS.some((key) => balances[key] !== null);
}

/**
 * Chooses between a newly fetched snapshot and the one already on screen.
 *
 * Returns `next` whenever it is trustworthy, so fresh data — including legitimate `null`s —
 * always wins. Falls back to the previous *balances* only when the refresh failed, and carries
 * the previous `lastUpdate` with them so the UI's "synced N ago" describes the age of the
 * numbers being shown rather than the moment of the failed attempt.
 */
export function mergeWalletSnapshot(
  previous: WalletSnapshot,
  next: WalletSnapshot,
): WalletSnapshot {
  // Switching AlecaFrame off is an authoritative clear, not a failure — holding stale
  // currencies after the user disabled the source would be the wrong kind of sticky.
  if (!next.enabled) {
    return next;
  }

  // An all-empty payload with no error should not happen: a real read yields at least one
  // balance, and every known failure sets `errorMessage`. Treating it as untrustworthy anyway
  // costs nothing and keeps an unforeseen empty-read path from blanking the strip.
  const refreshFailed = next.errorMessage !== null || !hasAnyBalance(next.balances);
  if (!refreshFailed) {
    return next;
  }

  // Nothing cached worth keeping — show the failure honestly rather than inventing continuity.
  if (!hasAnyBalance(previous.balances)) {
    return next;
  }

  return {
    ...next,
    balances: previous.balances,
    lastUpdate: previous.lastUpdate,
  };
}

/**
 * The only parts of a snapshot worth surviving a restart.
 *
 * Deliberately **not** `enabled` / `configured` / `errorMessage`: those describe the current
 * state of the integration, and restoring a stale "enabled" would claim a source is live
 * before anything has checked. They are re-established by the first refresh; these two are
 * what that refresh cannot reconstruct if it fails.
 */
export interface PersistedWalletBalances {
  balances: CurrencyBalance;
  /** AlecaFrame's own "as of" for these numbers, so their age survives with them. */
  lastUpdate: string | null;
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Reads a persisted payload back, rejecting anything malformed.
 *
 * Strict about shape because this is currency the user makes trading decisions against: a
 * half-parsed cache showing a plausible-but-wrong platinum count is worse than showing none.
 */
export function parsePersistedWalletBalances(raw: string | null): PersistedWalletBalances | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedWalletBalances>;
    const balances = parsed.balances;
    if (!balances || typeof balances !== 'object') {
      return null;
    }
    if (!CURRENCY_KEYS.every((key) => isFiniteOrNull(balances[key]))) {
      return null;
    }
    // A cache with nothing in it is not worth restoring.
    if (!hasAnyBalance(balances as CurrencyBalance)) {
      return null;
    }

    return {
      balances: {
        platinum: balances.platinum ?? null,
        credits: balances.credits ?? null,
        endo: balances.endo ?? null,
        ducats: balances.ducats ?? null,
        aya: balances.aya ?? null,
      },
      lastUpdate: typeof parsed.lastUpdate === 'string' ? parsed.lastUpdate : null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a snapshot is worth writing to disk. Only a trustworthy read qualifies — persisting
 * a failure would overwrite good cached numbers with the very emptiness the cache exists to
 * paper over.
 */
export function shouldPersistWalletSnapshot(snapshot: WalletSnapshot): boolean {
  return snapshot.enabled && snapshot.errorMessage === null && hasAnyBalance(snapshot.balances);
}

export function serializeWalletBalances(snapshot: WalletSnapshot): string {
  const payload: PersistedWalletBalances = {
    balances: snapshot.balances,
    lastUpdate: snapshot.lastUpdate,
  };
  return JSON.stringify(payload);
}
