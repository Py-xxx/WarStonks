import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';

const WALLET_REFRESH_INTERVAL_MS = 60_000;

export function useIntegrationSettings() {
  const alecaframeEnabled = useAppStore((state) => state.appSettings.alecaframe.enabled);
  const alecaframePublicLink = useAppStore((state) => state.appSettings.alecaframe.publicLink);
  const loadAppSettings = useAppStore((state) => state.loadAppSettings);
  const refreshWalletSnapshot = useAppStore((state) => state.refreshWalletSnapshot);

  useEffect(() => {
    void loadAppSettings();
  }, [loadAppSettings]);

  useEffect(() => {
    if (!alecaframeEnabled || !alecaframePublicLink) {
      return undefined;
    }

    void refreshWalletSnapshot();

    const intervalId = window.setInterval(() => {
      void refreshWalletSnapshot();
    }, WALLET_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [alecaframeEnabled, alecaframePublicLink, refreshWalletSnapshot]);
}
