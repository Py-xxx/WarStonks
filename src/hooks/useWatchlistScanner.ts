import { useEffect, useRef } from 'react';
import { playAlertSound, primeAlertAudio } from '../lib/alertAudio';
import {
  getNextWatchlistScanDelayMs,
  selectNextWatchlistItemToScan,
} from '../lib/watchlist';
import { useAppStore } from '../stores/useAppStore';

export function useWatchlistScanner() {
  const requestInFlightRef = useRef(false);
  const timeoutIdRef = useRef<number | null>(null);

  useEffect(() => {
    primeAlertAudio();
  }, []);

  useEffect(() => {
    let disposed = false;

    const clearScheduledTick = () => {
      if (timeoutIdRef.current !== null) {
        window.clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
    };

    const scheduleNextTick = (delayMs: number) => {
      if (disposed) {
        return;
      }
      clearScheduledTick();
      timeoutIdRef.current = window.setTimeout(runTick, Math.max(0, delayMs));
    };

    const runTick = () => {
      if (disposed) {
        return;
      }

      if (requestInFlightRef.current) {
        scheduleNextTick(250);
        return;
      }

      const state = useAppStore.getState();
      const nextItem = selectNextWatchlistItemToScan(state.watchlist);

      if (!nextItem) {
        scheduleNextTick(getNextWatchlistScanDelayMs(state.watchlist));
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
          scheduleNextTick(getNextWatchlistScanDelayMs(useAppStore.getState().watchlist));
        });
    };

    scheduleNextTick(0);

    return () => {
      disposed = true;
      clearScheduledTick();
    };
  }, []);
}
