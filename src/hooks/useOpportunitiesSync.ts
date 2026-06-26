import { useEffect } from 'react';
import { listenToOpportunitiesStale } from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

const DEBOUNCE_MS = 1_500;

/**
 * Mounts the always-on opportunity-board sync: when the backend signals that a board input changed
 * (owned parts edited, relics refreshed, a market scan finished), recompute the board — debounced
 * so a burst (e.g. a screenshot import) coalesces into one recompute. Mounted once on the AppShell
 * so the board stays fresh regardless of which tab is open.
 */
export function useOpportunitiesSync(): void {
  const refresh = useAppStore((state) => state.refreshOpportunities);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | null = null;
    let timer: number | null = null;

    const scheduleRefresh = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        if (active) {
          void refresh();
        }
      }, DEBOUNCE_MS);
    };

    void listenToOpportunitiesStale(scheduleRefresh)
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unsubscribe = cleanup;
      })
      .catch((error) => {
        console.error('[opportunities] failed to subscribe to stale signal', error);
      });

    return () => {
      active = false;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      unsubscribe?.();
    };
  }, [refresh]);
}
