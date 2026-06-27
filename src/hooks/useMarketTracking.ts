import { useEffect, useRef } from 'react';
import { refreshMarketTracking } from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';
import { useDocumentVisibility } from './useDocumentVisibility';

const MARKET_TRACKING_REFRESH_MS = 60_000;
// Small delay before the first refresh after (re)becoming visible, so a window
// restore doesn't immediately kick off heavy DB work (refresh + outcome grading)
// while the webview is still waking up and re-rendering.
const MARKET_TRACKING_RESUME_DELAY_MS = 1_500;

export function useMarketTracking() {
  const requestInFlightRef = useRef(false);
  const sellerMode = useAppStore((state) => state.sellerMode);
  const isVisible = useDocumentVisibility();
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);

  useEffect(() => {
    // Pause polling while the window is hidden or a data import/export is in progress.
    if (!isVisible || maintenance) {
      return undefined;
    }

    const runRefresh = () => {
      if (requestInFlightRef.current) {
        return;
      }

      requestInFlightRef.current = true;
      void refreshMarketTracking(sellerMode)
        .catch((error) => {
          console.error('[market-tracking] refresh failed', error);
        })
        .finally(() => {
          requestInFlightRef.current = false;
        });
    };

    const initialTimeoutId = window.setTimeout(runRefresh, MARKET_TRACKING_RESUME_DELAY_MS);
    const intervalId = window.setInterval(runRefresh, MARKET_TRACKING_REFRESH_MS);

    return () => {
      window.clearTimeout(initialTimeoutId);
      window.clearInterval(intervalId);
    };
  }, [sellerMode, isVisible, maintenance]);
}
