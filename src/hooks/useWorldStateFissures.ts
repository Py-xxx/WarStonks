import { useEffect } from 'react';
import { WORLDSTATE_RETRY_DELAY_MS } from '../lib/worldState';
import { useAppStore } from '../stores/useAppStore';

export function useWorldStateFissures() {
  const lastUpdatedAt = useAppStore((state) => state.worldStateFissuresLastUpdatedAt);
  const nextRefreshAt = useAppStore((state) => state.worldStateFissuresNextRefreshAt);
  const error = useAppStore((state) => state.worldStateFissuresError);
  const loading = useAppStore((state) => state.worldStateFissuresLoading);
  const refreshWorldStateFissures = useAppStore((state) => state.refreshWorldStateFissures);

  useEffect(() => {
    if (lastUpdatedAt || nextRefreshAt || error || loading) {
      return;
    }

    void refreshWorldStateFissures();
  }, [error, lastUpdatedAt, loading, nextRefreshAt, refreshWorldStateFissures]);

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
      void refreshWorldStateFissures();
    }, Math.max(0, targetMs - Date.now()));

    return () => window.clearTimeout(timeoutId);
  }, [error, nextRefreshAt, refreshWorldStateFissures]);
}
