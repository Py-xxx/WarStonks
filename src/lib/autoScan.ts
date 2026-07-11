// Persistence for the opt-in "auto-scan" preference (kept in localStorage, off by default).
// The scanner walks every set + component through the 3 req/s WFM scheduler, so auto-scanning is
// deliberately conservative — see useAutoScanScheduler for the once-a-day, stale-triggered cadence.

const STORAGE_KEY = 'warstonks.autoScanEnabled';

/** Rescan when the last snapshot is at least this old — ~daily, kept under the 48h stale alert so
 *  data never actually goes stale while auto-scan is on. */
export const AUTO_SCAN_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** How often the scheduler re-checks staleness. A daily cadence needs no tighter poll. */
export const AUTO_SCAN_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function loadAutoScanEnabled(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }
  return window.localStorage.getItem(STORAGE_KEY) === 'true';
}

export function saveAutoScanEnabled(enabled: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Best-effort persistence.
  }
}
