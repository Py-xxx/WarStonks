import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';

/**
 * Brings owned relics up at app startup so they're ready everywhere without opening the
 * Opportunities tab:
 *  - loads the persisted SQLite relic cache into the store (instant, survives restarts), and
 *  - if AlecaFrame is connected, kicks off a background, cooldown-gated refresh.
 *
 * Mounted on the AppShell — deliberately NOT part of the bootloader, so it never blocks startup.
 */
export function useOwnedRelicsBootstrap(): void {
  const loadCache = useAppStore((state) => state.loadOwnedRelicsCache);
  const refresh = useAppStore((state) => state.refreshOwnedRelics);
  const alecaframeConnected = useAppStore(
    (state) =>
      state.appSettings.alecaframe.enabled && Boolean(state.appSettings.alecaframe.publicLink),
  );

  // Load the cached relics once the shell is up.
  useEffect(() => {
    void loadCache();
  }, [loadCache]);

  // Refresh from AlecaFrame in the background once we know it's connected (settings load async).
  // The store's 3-minute cooldown keeps this from stacking with the Opportunities-tab refresh.
  useEffect(() => {
    if (alecaframeConnected) {
      void refresh(false);
    }
  }, [alecaframeConnected, refresh]);
}
