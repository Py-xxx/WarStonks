import { useEffect, useRef } from 'react';
import { refreshMarketTracking } from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

const MARKET_TRACKING_REFRESH_MS = 60_000;

export function useMarketTracking() {
  const requestInFlightRef = useRef(false);
  const sellerMode = useAppStore((state) => state.sellerMode);

  useEffect(() => {
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

    runRefresh();
    const intervalId = window.setInterval(runRefresh, MARKET_TRACKING_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [sellerMode]);
}
