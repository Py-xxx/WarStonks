import { useEffect, useRef } from 'react';
import { WORLDSTATE_RETRY_DELAY_MS } from '../lib/worldState';
import { useAppStore } from '../stores/useAppStore';
import { useDocumentVisibility } from './useDocumentVisibility';

interface UseWorldStateRefreshOptions {
  lastUpdatedAt: string | null;
  nextRefreshAt: string | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useWorldStateRefresh(options: UseWorldStateRefreshOptions) {
  const { lastUpdatedAt, nextRefreshAt, error, loading, refresh } = options;
  const isVisible = useDocumentVisibility();
  // Pause refreshes while a data import/export is running.
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
    if (maintenance || !isVisible || lastUpdatedAt || nextRefreshAt || error || loading) {
      return;
    }

    void refresh();
  }, [error, isVisible, lastUpdatedAt, loading, maintenance, nextRefreshAt, refresh]);

  useEffect(() => {
    // Don't keep a refresh timer armed while hidden; re-arm on resume. The effect
    // re-runs when isVisible flips, so a due refresh fires promptly once visible.
    if (!isVisible || maintenance) {
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
  }, [error, isVisible, maintenance, nextRefreshAt, refresh]);
}
