import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { getNeverOverrideIconSlugs } from '../lib/tauriClient';
import { registerNeverOverrideSlugs } from '../lib/partImages';
import { useDocumentVisibility } from './useDocumentVisibility';

const WALLET_REFRESH_INTERVAL_MS = 60_000;

export function useIntegrationSettings() {
  const alecaframeEnabled = useAppStore((state) => state.appSettings.alecaframe.enabled);
  const loadAppSettings = useAppStore((state) => state.loadAppSettings);
  const refreshWalletSnapshotSilently = useAppStore((state) => state.refreshWalletSnapshotSilently);
  const isVisible = useDocumentVisibility();

  useEffect(() => {
    void loadAppSettings();
  }, [loadAppSettings]);

  // Teaches the icon resolver which slugs are mods and arcanes, so a mod whose name ends in a
  // part word ("Conductive Blade") keeps its own card art. Read once — it changes only when the
  // catalog is rebuilt, which happens before the UI mounts.
  useEffect(() => {
    void getNeverOverrideIconSlugs()
      .then(registerNeverOverrideSlugs)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // The public link used to be required here, because the wallet came from AlecaFrame's
    // *API*. It now comes from `lastData.dat` on disk, which needs no link — and since the
    // pivot deleted that setting, the condition could never be true again and the balances
    // simply never loaded. The only gate left is the one the backend actually applies.
    //
    // Still paused while hidden: it decrypts ~700 KB per read, and becoming visible re-runs
    // this effect, so the strip refreshes the moment it is looked at.
    if (!alecaframeEnabled || !isVisible) {
      return undefined;
    }

    void refreshWalletSnapshotSilently();

    const intervalId = window.setInterval(() => {
      void refreshWalletSnapshotSilently();
    }, WALLET_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [alecaframeEnabled, refreshWalletSnapshotSilently, isVisible]);
}
