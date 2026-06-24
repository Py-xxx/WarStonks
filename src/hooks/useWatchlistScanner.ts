import { useEffect, useRef } from 'react';
import { primeAlertAudio } from '../lib/alertAudio';
import { fireAlertNotification } from '../lib/notifications';
import {
  getNextWatchlistScanDelayMs,
  selectNextWatchlistItemToScan,
} from '../lib/watchlist';
import { useAppStore } from '../stores/useAppStore';
import { useDocumentVisibility } from './useDocumentVisibility';

export function useWatchlistScanner() {
  const isVisible = useDocumentVisibility();
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
    // Pause scanning while hidden so WebView2 throttling can't queue a backlog of
    // scans that all flush through the rate-limited WFM scheduler on window restore.
    if (!isVisible) {
      return undefined;
    }

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
            fireAlertNotification(
              useAppStore.getState().notificationSettings,
              'watchlistAlert',
              'Watchlist target hit',
              `${nextItem.displayName || nextItem.name} reached your target price.`,
            );
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
  }, [watchlistScheduleVersion, isVisible]);
}
