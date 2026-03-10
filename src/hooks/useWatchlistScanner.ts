import { useEffect, useRef } from 'react';
import { playAlertSound, primeAlertAudio } from '../lib/alertAudio';
import { WATCHLIST_SCANNER_TICK_MS } from '../lib/watchlist';
import { useAppStore } from '../stores/useAppStore';

export function useWatchlistScanner() {
  const requestInFlightRef = useRef(false);

  useEffect(() => {
    primeAlertAudio();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (requestInFlightRef.current) {
        return;
      }

      const state = useAppStore.getState();
      const nextItem = state.watchlist
        .filter((item) => item.nextScanAt <= Date.now())
        .sort((left, right) => left.nextScanAt - right.nextScanAt)[0];

      if (!nextItem) {
        return;
      }

      requestInFlightRef.current = true;

      void state
        .refreshWatchlistItem(nextItem.id)
        .then((result) => {
          if (result.alertTriggered) {
            void playAlertSound().catch(() => undefined);
          }
        })
        .finally(() => {
          requestInFlightRef.current = false;
        });
    }, WATCHLIST_SCANNER_TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);
}
