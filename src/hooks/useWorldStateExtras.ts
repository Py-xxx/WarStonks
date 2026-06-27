import { useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useWorldStateRefresh } from './useWorldStateRefresh';

/**
 * Drives the refresh timers for the four reference worldstate sources (cycles, steel path,
 * nightwave, vault trader). Each polls on its own expiry via the shared `useWorldStateRefresh`.
 * Mounted once on the AppShell.
 */
export function useWorldStateExtras(): void {
  const refresh = useAppStore((state) => state.refreshWorldStateExtra);
  const extra = useAppStore((state) => state.worldStateExtra);

  const refreshCycles = useCallback(() => refresh('cycles'), [refresh]);
  const refreshSteelPath = useCallback(() => refresh('steel-path'), [refresh]);
  const refreshNightwave = useCallback(() => refresh('nightwave'), [refresh]);
  const refreshVault = useCallback(() => refresh('vault-trader'), [refresh]);

  useWorldStateRefresh({
    lastUpdatedAt: extra.cycles.lastUpdatedAt,
    nextRefreshAt: extra.cycles.nextRefreshAt,
    error: extra.cycles.error,
    loading: extra.cycles.loading,
    refresh: refreshCycles,
  });
  useWorldStateRefresh({
    lastUpdatedAt: extra['steel-path'].lastUpdatedAt,
    nextRefreshAt: extra['steel-path'].nextRefreshAt,
    error: extra['steel-path'].error,
    loading: extra['steel-path'].loading,
    refresh: refreshSteelPath,
  });
  useWorldStateRefresh({
    lastUpdatedAt: extra.nightwave.lastUpdatedAt,
    nextRefreshAt: extra.nightwave.nextRefreshAt,
    error: extra.nightwave.error,
    loading: extra.nightwave.loading,
    refresh: refreshNightwave,
  });
  useWorldStateRefresh({
    lastUpdatedAt: extra['vault-trader'].lastUpdatedAt,
    nextRefreshAt: extra['vault-trader'].nextRefreshAt,
    error: extra['vault-trader'].error,
    loading: extra['vault-trader'].loading,
    refresh: refreshVault,
  });
}
