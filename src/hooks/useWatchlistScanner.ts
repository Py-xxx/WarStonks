import { useEffect, useRef } from 'react';
import { primeAlertAudio } from '../lib/alertAudio';
import { fireAlertNotification } from '../lib/notifications';
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
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);

  useEffect(() => {
    primeAlertAudio();
  }, []);

  useEffect(() => {
    // Scanning deliberately continues while the window is hidden — price alerts firing while
    // the user is in-game (app backgrounded) is the core use case. Webview timer throttling is
    // disabled app-wide (additionalBrowserArgs / backgroundThrottling in tauri.conf.json), so
    // background ticks run at full cadence. Only a data import/export pauses the scanner.
    if (maintenance) {
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
  }, [watchlistScheduleVersion, maintenance]);
}
