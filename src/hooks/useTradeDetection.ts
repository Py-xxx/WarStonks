import { useEffect } from 'react';
import {
  refreshAlecaframeTradeDetection,
  refreshWfmTradeDetection,
} from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

const WFM_TRADE_POLL_INTERVAL_MS = 5_000;
const ALECAFRAME_TRADE_POLL_INTERVAL_MS = 10_000;
const WFM_INITIAL_DELAY_MS = 1_000;
const ALECAFRAME_INITIAL_DELAY_MS = 2_500;

export function useTradeDetection() {
  const tradeAccountName = useAppStore((state) => state.tradeAccount?.name ?? null);
  const handleDetectedBuys = useAppStore((state) => state.handleDetectedTradeBuys);

  useEffect(() => {
    if (!tradeAccountName) {
      return;
    }

    const sessionStartedAt = new Date().toISOString();

    let cancelled = false;
    let wfmInFlight = false;
    let alecaframeInFlight = false;

    const runWfm = async () => {
      if (cancelled || wfmInFlight) {
        return;
      }

      wfmInFlight = true;
      try {
        await refreshWfmTradeDetection(tradeAccountName, {
          sessionStartedAt,
        });
      } catch (error) {
        console.error('[trades] failed to refresh WFM trade detection', error);
      } finally {
        wfmInFlight = false;
      }
    };

    const runAlecaframe = async () => {
      if (cancelled || alecaframeInFlight) {
        return;
      }

      alecaframeInFlight = true;
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
        alecaframeInFlight = false;
      }
    };

    const wfmInitialTimer = setTimeout(() => {
      void runWfm();
    }, WFM_INITIAL_DELAY_MS);
    const alecaframeInitialTimer = setTimeout(() => {
      void runAlecaframe();
    }, ALECAFRAME_INITIAL_DELAY_MS);
    const wfmInterval = setInterval(() => {
      void runWfm();
    }, WFM_TRADE_POLL_INTERVAL_MS);
    const alecaframeInterval = setInterval(() => {
      void runAlecaframe();
    }, ALECAFRAME_TRADE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(wfmInitialTimer);
      clearTimeout(alecaframeInitialTimer);
      clearInterval(wfmInterval);
      clearInterval(alecaframeInterval);
    };
  }, [tradeAccountName, handleDetectedBuys]);
}
