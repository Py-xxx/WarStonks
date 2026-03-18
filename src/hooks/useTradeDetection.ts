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
const MIN_TRADE_REFRESH_GAP_MS = 3_000;

function computeNextRefreshDelay(
  preferredAt: number,
  otherLastStartedAt: number,
  now: number,
): number {
  const preferredDelay = Math.max(0, preferredAt - now);
  if (!otherLastStartedAt) {
    return preferredDelay;
  }

  const safeStartAt = otherLastStartedAt + MIN_TRADE_REFRESH_GAP_MS;
  return Math.max(preferredDelay, Math.max(0, safeStartAt - now));
}

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
    let wfmTimer: ReturnType<typeof setTimeout> | null = null;
    let alecaframeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastWfmStartedAt = 0;
    let lastAlecaframeStartedAt = 0;

    const scheduleWfm = (preferredAt: number) => {
      if (cancelled) {
        return;
      }

      if (wfmTimer) {
        clearTimeout(wfmTimer);
      }

      const delay = computeNextRefreshDelay(preferredAt, lastAlecaframeStartedAt, Date.now());
      wfmTimer = setTimeout(() => {
        void runWfm();
      }, delay);
    };

    const scheduleAlecaframe = (preferredAt: number) => {
      if (cancelled) {
        return;
      }

      if (alecaframeTimer) {
        clearTimeout(alecaframeTimer);
      }

      const delay = computeNextRefreshDelay(preferredAt, lastWfmStartedAt, Date.now());
      alecaframeTimer = setTimeout(() => {
        void runAlecaframe();
      }, delay);
    };

    const runWfm = async () => {
      if (cancelled || wfmInFlight) {
        return;
      }

      const startedAt = Date.now();
      lastWfmStartedAt = startedAt;
      wfmInFlight = true;
      try {
        await refreshWfmTradeDetection(tradeAccountName, {
          sessionStartedAt,
        });
      } catch (error) {
        console.error('[trades] failed to refresh WFM trade detection', error);
      } finally {
        wfmInFlight = false;
        scheduleWfm(startedAt + WFM_TRADE_POLL_INTERVAL_MS);
      }
    };

    const runAlecaframe = async () => {
      if (cancelled || alecaframeInFlight) {
        return;
      }

      const startedAt = Date.now();
      lastAlecaframeStartedAt = startedAt;
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
        scheduleAlecaframe(startedAt + ALECAFRAME_TRADE_POLL_INTERVAL_MS);
      }
    };

    scheduleWfm(Date.now() + WFM_INITIAL_DELAY_MS);
    scheduleAlecaframe(Date.now() + ALECAFRAME_INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      if (wfmTimer) {
        clearTimeout(wfmTimer);
      }
      if (alecaframeTimer) {
        clearTimeout(alecaframeTimer);
      }
    };
  }, [tradeAccountName, handleDetectedBuys]);
}
