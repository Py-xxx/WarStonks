import { useEffect, useRef } from 'react';
import { refreshMarketTracking } from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

const MARKET_TRACKING_REFRESH_MS = 60_000;
// Small delay before the first refresh after mount / seller-mode change, so startup
// doesn't immediately kick off heavy DB work (refresh + outcome grading) while the
// webview is still rendering.
const MARKET_TRACKING_RESUME_DELAY_MS = 1_500;

export function useMarketTracking() {
  const requestInFlightRef = useRef(false);
  const sellerMode = useAppStore((state) => state.sellerMode);
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);

  useEffect(() => {
    // Tracking keeps polling while the window is hidden (webview throttling is disabled
    // app-wide) so alerts and price data stay live during gameplay. Only a data
    // import/export pauses it.
    if (maintenance) {
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
  }, [sellerMode, maintenance]);
}
