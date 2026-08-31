/**
 * How long the app is willing to go between worldstate polls.
 *
 * Its own module, not part of `worldState.ts`, for the same reason `worldStateExpiry.ts` is:
 * `worldState.ts` imports the `i18n` directory, which Node's native ESM resolver cannot load, so
 * nothing in it can be reached from `node --test`. This is the piece worth pinning, so it lives
 * where a test can import it.
 */

/** No expiry to go on — how often worldstate is worth re-reading anyway. */
export const NO_EXPIRY_WORLDSTATE_REFRESH_MS = 5 * 60_000;

/**
 * The longest we will ever wait between polls.
 *
 * Every `selectWorldState*RefreshAt` derives the next poll from *what is on screen now* — an
 * entity's own expiry, or the earliest expiry in an array. That answers "when does this thing
 * end", and on its own it is the wrong question: it says nothing about when the **next** thing
 * arrives. Unclamped it meant the archon hunt was re-fetched weekly, Baro when he left (~2 days),
 * a world event when the event ended, and fissures only once the earliest current one lapsed — so
 * a new fissure, a new alert or a completed invasion stayed invisible until then. That is the
 * "worldstate never updates" report.
 *
 * The expiry still wins when it is *sooner*, so a panel refreshes the moment its content lapses.
 * This is only the ceiling.
 */
export const MAX_WORLDSTATE_REFRESH_MS = NO_EXPIRY_WORLDSTATE_REFRESH_MS;

/** Never let a derived refresh time sit further out than the ceiling. */
export function clampRefreshAt(refreshAt: string, nowMs: number): string {
  const ceiling = nowMs + MAX_WORLDSTATE_REFRESH_MS;
  const parsed = Date.parse(refreshAt);
  if (!Number.isFinite(parsed) || parsed > ceiling) {
    return new Date(ceiling).toISOString();
  }
  return refreshAt;
}
