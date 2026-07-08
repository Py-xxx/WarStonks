import { useEffect, useRef } from 'react';
import { WORLDSTATE_RETRY_DELAY_MS } from '../lib/worldState';
import { useAppStore } from '../stores/useAppStore';

interface UseWorldStateRefreshOptions {
  lastUpdatedAt: string | null;
  nextRefreshAt: string | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useWorldStateRefresh(options: UseWorldStateRefreshOptions) {
  const { lastUpdatedAt, nextRefreshAt, error, loading, refresh } = options;
  // Pause refreshes while a data import/export is running. Refreshes deliberately continue
  // while the window is hidden (webview throttling is disabled app-wide) so worldstate
  // alerts stay live during gameplay.
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);
  // Force an immediate refetch when the display language changes (worldstate is localized
  // server-side, so cached data is stale in the new language).
  const worldstateEpoch = useAppStore((state) => state.worldstateEpoch);
  const lastEpochRef = useRef(worldstateEpoch);

  useEffect(() => {
    if (lastEpochRef.current === worldstateEpoch) {
      return;
    }
    lastEpochRef.current = worldstateEpoch;
    if (maintenance) {
      return;
    }
    void refresh();
  }, [worldstateEpoch, maintenance, refresh]);

  useEffect(() => {
    if (maintenance || lastUpdatedAt || nextRefreshAt || error || loading) {
      return;
    }

    void refresh();
  }, [error, lastUpdatedAt, loading, maintenance, nextRefreshAt, refresh]);

  useEffect(() => {
    if (maintenance) {
      return undefined;
    }

    const targetMs = nextRefreshAt
      ? Date.parse(nextRefreshAt)
      : error
        ? Date.now() + WORLDSTATE_RETRY_DELAY_MS
        : null;

    if (targetMs === null || !Number.isFinite(targetMs)) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, Math.max(0, targetMs - Date.now()));

    return () => window.clearTimeout(timeoutId);
  }, [error, maintenance, nextRefreshAt, refresh]);
}
