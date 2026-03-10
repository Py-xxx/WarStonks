import { useEffect } from 'react';
import { WORLDSTATE_RETRY_DELAY_MS } from '../lib/worldState';
import { useAppStore } from '../stores/useAppStore';

export function useWorldStateEvents() {
  const nextRefreshAt = useAppStore((state) => state.worldStateEventsNextRefreshAt);
  const error = useAppStore((state) => state.worldStateEventsError);
  const refreshWorldStateEvents = useAppStore((state) => state.refreshWorldStateEvents);

  useEffect(() => {
    void refreshWorldStateEvents();
  }, [refreshWorldStateEvents]);

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
      void refreshWorldStateEvents();
    }, Math.max(0, targetMs - Date.now()));

    return () => window.clearTimeout(timeoutId);
  }, [error, nextRefreshAt, refreshWorldStateEvents]);
}
