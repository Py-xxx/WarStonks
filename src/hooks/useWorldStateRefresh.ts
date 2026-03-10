import { useEffect } from 'react';
import { WORLDSTATE_RETRY_DELAY_MS } from '../lib/worldState';

interface UseWorldStateRefreshOptions {
  lastUpdatedAt: string | null;
  nextRefreshAt: string | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useWorldStateRefresh(options: UseWorldStateRefreshOptions) {
  const { lastUpdatedAt, nextRefreshAt, error, loading, refresh } = options;

  useEffect(() => {
    if (lastUpdatedAt || nextRefreshAt || error || loading) {
      return;
    }

    void refresh();
  }, [error, lastUpdatedAt, loading, nextRefreshAt, refresh]);

  useEffect(() => {
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
  }, [error, nextRefreshAt, refresh]);
}
