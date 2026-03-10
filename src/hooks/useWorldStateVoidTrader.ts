import { useEffect } from 'react';
import { WORLDSTATE_RETRY_DELAY_MS } from '../lib/worldState';
import { useAppStore } from '../stores/useAppStore';

export function useWorldStateVoidTrader() {
  const lastUpdatedAt = useAppStore((state) => state.worldStateVoidTraderLastUpdatedAt);
  const nextRefreshAt = useAppStore((state) => state.worldStateVoidTraderNextRefreshAt);
  const error = useAppStore((state) => state.worldStateVoidTraderError);
  const loading = useAppStore((state) => state.worldStateVoidTraderLoading);
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);

  useEffect(() => {
    if (lastUpdatedAt || nextRefreshAt || error || loading) {
      return;
    }

    void refreshWorldStateVoidTrader();
  }, [error, lastUpdatedAt, loading, nextRefreshAt, refreshWorldStateVoidTrader]);

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
      void refreshWorldStateVoidTrader();
    }, Math.max(0, targetMs - Date.now()));

    return () => window.clearTimeout(timeoutId);
  }, [error, nextRefreshAt, refreshWorldStateVoidTrader]);
}
