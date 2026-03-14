import { useEffect } from 'react';
import {
  refreshAlecaframeTradeDetection,
  refreshWfmTradeDetection,
} from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

const TRADE_POLL_INTERVAL_MS = 5_000;
const TRADE_INITIAL_DELAY_MS = 1_000;

export function useTradeDetection() {
  const tradeAccountName = useAppStore((state) => state.tradeAccount?.name ?? null);
  const handleDetectedBuys = useAppStore((state) => state.handleDetectedTradeBuys);

  useEffect(() => {
    if (!tradeAccountName) {
      return;
    }

    const sessionStartedAt = new Date().toISOString();

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let nextSource: 'wfm' | 'alecaframe' = 'wfm';

    const scheduleNext = (delay: number) => {
      if (cancelled) {
        return;
      }
      timer = setTimeout(() => {
        void runNext();
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
        nextSource = 'alecaframe';
        scheduleNext(TRADE_POLL_INTERVAL_MS);
      }
    };

    const runAlecaframe = async () => {
      try {
        const result = await refreshAlecaframeTradeDetection(tradeAccountName, {
          sessionStartedAt,
        });
        if (result.detectedBuys && result.detectedBuys.length > 0) {
          await handleDetectedBuys(result.detectedBuys);
        }
      } catch (error) {
        console.error('[trades] failed to refresh Alecaframe trade detection', error);
      } finally {
        nextSource = 'wfm';
        scheduleNext(TRADE_POLL_INTERVAL_MS);
      }
    };

    const runNext = async () => {
      if (nextSource === 'wfm') {
        await runWfm();
      } else {
        await runAlecaframe();
      }
    };

    scheduleNext(TRADE_INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [tradeAccountName, handleDetectedBuys]);
}
