import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { worldStateCycleSignature } from '../lib/worldStateCycles';
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
  const refreshAllWorldState = useAppStore((state) => state.refreshAllWorldState);
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);

  /**
   * A cycle flip refreshes **everything**, not just the clock.
   *
   * Cetus turning night, Vallis turning cold and Cambion turning Fass are the moments the rest of
   * the worldstate turns over with them — bounties, open-world content and the fissure rotation
   * all change. Waiting for each source's own timer means showing the previous cycle's world for
   * up to the ceiling in `worldStateRefreshWindow.ts`.
   *
   * The signature is compared, not the payload: the cycles source re-fetches on its own timer and
   * most of those polls report the same states. `null` means "nothing readable" — a failed fetch
   * must not read as a flip.
   */
  const lastCycleSignatureRef = useRef<string | null>(null);
  const cyclesPayload = extra.cycles.payload;
  useEffect(() => {
    const signature = worldStateCycleSignature(cyclesPayload);
    if (signature === null) {
      return;
    }
    const previous = lastCycleSignatureRef.current;
    lastCycleSignatureRef.current = signature;
    // First reading is the baseline, never a change — otherwise every app start would fire a
    // full refresh on top of the one startup already does.
    if (previous === null || previous === signature || maintenance) {
      return;
    }
    void refreshAllWorldState();
  }, [cyclesPayload, maintenance, refreshAllWorldState]);

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
