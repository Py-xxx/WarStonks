import { useEffect, useRef } from 'react';
import { playAlertSound, primeAlertAudio } from '../lib/alertAudio';
import {
  getNextWatchlistScanDelayMs,
  selectNextWatchlistItemToScan,
} from '../lib/watchlist';
import { useAppStore } from '../stores/useAppStore';

export function useWatchlistScanner() {
  const watchlistScheduleVersion = useAppStore((state) => {
    let nextScanAt = Number.POSITIVE_INFINITY;

    for (const item of state.watchlist) {
      if (item.nextScanAt < nextScanAt) {
        nextScanAt = item.nextScanAt;
      }
    }

    return `${state.watchlist.length}:${Number.isFinite(nextScanAt) ? nextScanAt : 0}`;
  });
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

    scheduleNextTick(getNextWatchlistScanDelayMs(useAppStore.getState().watchlist));

    return () => {
      disposed = true;
      clearScheduledTick();
    };
  }, [watchlistScheduleVersion]);
}
