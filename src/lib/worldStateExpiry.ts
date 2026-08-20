/**
 * Expiry rules for world-state entries.
 *
 * Deliberately its own module with no imports: `worldState.ts` pulls in `../i18n`, which is a
 * directory import that Node's ESM test runner cannot resolve — so nothing in that file is
 * testable. This rule governs what the user does and does not see, so it needs coverage.
 * `worldState.ts` re-exports it, and callers may import from either.
 */

/** Sentinel the worldstate parser uses for an expiry the API sent as unusable. */
export const INVALID_WORLDSTATE_EXPIRY = '1970-01-01T00:00:00.000Z';

/**
 * Whether an entry's countdown is still worth showing.
 *
 * Two checks, because neither is sufficient alone. `expired` is computed by the worldstate
 * parser at poll time, so it reflects what the API told us but goes stale between polls; the
 * clock comparison catches anything that ran out since. Home's rail rendered recently-expired
 * fissures under "Your relics" with a countdown reading `Expired` because it checked neither.
 *
 * NOT for the Void Trader, where `expired` means he is away and `expiry` is his arrival — a
 * countdown worth showing, not a finished one.
 */
export function isWorldStateEntryOpen(
  expiry: string | null,
  expired: boolean | undefined,
  nowMs: number,
): boolean {
  if (expired) {
    return false;
  }
  if (!expiry || expiry === INVALID_WORLDSTATE_EXPIRY) {
    return false;
  }
  const expiryMs = Date.parse(expiry);
  return Number.isFinite(expiryMs) && expiryMs > nowMs;
}
