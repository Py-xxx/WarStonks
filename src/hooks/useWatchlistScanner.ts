import { useEffect, useRef } from 'react';
import { playAlertSound, primeAlertAudio } from '../lib/alertAudio';
import {
  selectNextWatchlistItemToScan,
  WATCHLIST_SCANNER_TICK_MS,
} from '../lib/watchlist';
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
      const nextItem = selectNextWatchlistItemToScan(state.watchlist);

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
