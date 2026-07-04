import type { Opportunity } from './tauriClient';

const STORAGE_KEY = 'warstonks.pinnedOpportunities';

/** Pinned opportunities, keyed by `subjectKey`. The stored snapshot is the last-known card, so a
 *  pinned opportunity survives recomputes and app restarts even if it's not currently produced. */
export type PinnedOpportunities = Record<string, Opportunity>;

export function loadPinnedOpportunities(): PinnedOpportunities {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    // Drop pins saved before the titleKey/titleParams i18n schema (pre-3.0.x) — they can't be
    // re-translated and would otherwise render blank/undefined.
    const entries = Object.entries(parsed as Record<string, Partial<Opportunity>>).filter(
      ([, opp]) => typeof opp?.titleKey === 'string',
    );
    return Object.fromEntries(entries) as PinnedOpportunities;
  } catch {
    return {};
  }
}

export function savePinnedOpportunities(pins: PinnedOpportunities): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Best-effort persistence.
  }
}

/** Updates each pinned subject to its latest computed opportunity (if the recompute produced one);
 *  subjects with no current opportunity keep their last-known snapshot (frozen, still pinned). */
export function mergePinSnapshots(
  pins: PinnedOpportunities,
  opportunities: Opportunity[],
): PinnedOpportunities {
  if (Object.keys(pins).length === 0) {
    return pins;
  }
  const bySubject = new Map(opportunities.map((opp) => [opp.subjectKey, opp]));
  let changed = false;
  const next: PinnedOpportunities = { ...pins };
  for (const key of Object.keys(next)) {
    const latest = bySubject.get(key);
    if (latest && latest !== next[key]) {
      next[key] = latest;
      changed = true;
    }
  }
  return changed ? next : pins;
}
