/**
 * Reading the open-world day/night cycles out of the combined `cycles` payload.
 *
 * Its own module (not `worldState.ts`) so it is reachable from `node --test` — that file imports
 * the `i18n` directory, which Node's ESM resolver cannot load.
 */

/** The four cycles the `get_worldstate_cycles` command extracts from the aggregate `/pc`. */
export const WORLDSTATE_CYCLE_KEYS = [
  'cetusCycle',
  'vallisCycle',
  'cambionCycle',
  'earthCycle',
] as const;

/**
 * A cycle's current state — `day`/`night`, `warm`/`cold`, `fass`/`vome`.
 *
 * Mirrors `WorldClockPanel`'s reader: warframestat.us usually sends `state`, but some payloads
 * carry only the `isDay` / `isWarm` booleans, so both are honoured.
 */
export function readCycleState(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const cycle = (payload as Record<string, unknown>)[key];
  if (!cycle || typeof cycle !== 'object') {
    return null;
  }
  const record = cycle as Record<string, unknown>;
  if (typeof record.state === 'string' && record.state.trim()) {
    return record.state.trim().toLowerCase();
  }
  if (record.isDay === true) return 'day';
  if (record.isDay === false) return 'night';
  if (record.isWarm === true) return 'warm';
  if (record.isWarm === false) return 'cold';
  return null;
}

/**
 * A comparable fingerprint of every cycle's state.
 *
 * `null` when the payload carries no readable cycle at all — the caller must treat that as "no
 * information", never as a change, or a failed fetch would trigger a full worldstate refresh.
 *
 * Cycle flips are what make this worth watching: bounties, fissure rotations and the open-world
 * content all turn over with them, so a flip is the one moment the rest of the worldstate is
 * guaranteed to be out of date.
 */
export function worldStateCycleSignature(payload: unknown): string | null {
  const parts = WORLDSTATE_CYCLE_KEYS.map((key) => `${key}:${readCycleState(payload, key) ?? '?'}`);
  return parts.every((part) => part.endsWith(':?')) ? null : parts.join('|');
}
