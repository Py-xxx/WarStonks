import { useEffect } from 'react';
import {
  refreshAlecaframeTradeDetection,
  refreshWfmTradeDetection,
} from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

const WFM_POLL_INTERVAL_MS = 10_000;
const ALECAFRAME_POLL_INTERVAL_MS = 20_000;
const WFM_INITIAL_DELAY_MS = 1_000;
const ALECAFRAME_INITIAL_DELAY_MS = 6_000;

export function useTradeDetection() {
  const tradeAccountName = useAppStore((state) => state.tradeAccount?.name ?? null);

  useEffect(() => {
    if (!tradeAccountName) {
      return;
    }

    const sessionStartedAt = new Date().toISOString();

    let cancelled = false;
    let wfmTimer: ReturnType<typeof setTimeout> | null = null;
    let alecaframeTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleWfm = (delay: number) => {
      if (cancelled) {
        return;
      }
      wfmTimer = setTimeout(() => {
        void runWfm();
      }, delay);
    };

    const scheduleAlecaframe = (delay: number) => {
      if (cancelled) {
        return;
      }
      alecaframeTimer = setTimeout(() => {
        void runAlecaframe();
      }, delay);
    };

    const runWfm = async () => {
      try {
        await refreshWfmTradeDetection(tradeAccountName, {
          sessionStartedAt,
        });
      } catch (error) {
        console.error('[trades] failed to refresh WFM trade detection', error);
      } finally {
        scheduleWfm(WFM_POLL_INTERVAL_MS);
      }
    };

    const runAlecaframe = async () => {
      try {
        await refreshAlecaframeTradeDetection(tradeAccountName, {
          sessionStartedAt,
        });
      } catch (error) {
        console.error('[trades] failed to refresh Alecaframe trade detection', error);
      } finally {
        scheduleAlecaframe(ALECAFRAME_POLL_INTERVAL_MS);
      }
    };

    scheduleWfm(WFM_INITIAL_DELAY_MS);
    scheduleAlecaframe(ALECAFRAME_INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      if (wfmTimer) {
        clearTimeout(wfmTimer);
      }
      if (alecaframeTimer) {
        clearTimeout(alecaframeTimer);
      }
    };
  }, [tradeAccountName]);
}
