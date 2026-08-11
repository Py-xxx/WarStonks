import { useEffect } from 'react';
import {
  refreshWfmTradeDetection,
} from '../lib/tauriClient';
import { getTradeDetectionRequestPriority } from '../lib/tradeDetectionPriority';
import { useAppStore } from '../stores/useAppStore';

// Adaptive WFM trade-detection cadence: poll fast right after a detected trade, then back
// off while idle so we don't hammer /orders/my at a fixed 5s forever (per WFM's
// "avoid tight polling loops" rule). Any detection resets to the fast interval.
const WFM_TRADE_POLL_MIN_MS = 5_000;
const WFM_TRADE_POLL_MAX_MS = 30_000;
const WFM_TRADE_IDLE_STREAK_CAP = 3; // 5s → 10s → 20s → 30s
// `/api/stats/public` returns trades AND wallet in one response, and AlecaFrame rate-limits at
// 1 rps per IP — so a flat 10s poll is only ~10% of the budget while making trade detection feel
// immediate. The old 30s→180s idle backoff meant a trade could go unnoticed for three minutes,
// which is the wrong trade-off when the whole point is auto-detection.
//
// Idle backoff is deliberately mild (10s → 20s) rather than absent: it still trims requests when
// the app sits open untouched for a long time. Error backoff is separate and stays aggressive —
// hammering an unhealthy server is what causes 503s in the first place.
// Failure backoff: 30s → 60s → 120s → 180s, independent of the idle cadence.
const WFM_INITIAL_DELAY_MS = 1_000;

function wfmPollIntervalForStreak(idleStreak: number): number {
  return Math.min(WFM_TRADE_POLL_MIN_MS * 2 ** idleStreak, WFM_TRADE_POLL_MAX_MS);
}

export function useTradeDetection() {
  const tradeAccountName = useAppStore((state) => state.tradeAccount?.name ?? null);
  const handleDetectedBuys = useAppStore((state) => state.handleDetectedTradeBuys);
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);

  // NOTE: trade detection deliberately keeps running while the window is hidden, so
  // background trades (and Discord notifications) are still captured while the user is
  // in-game with the app minimized. It is lightweight and self-rescheduling with an
  // in-flight guard, so — unlike the heavier market/watchlist pollers — it cannot
  // build up a WebView2-throttled backlog that floods the scheduler on resume.
  useEffect(() => {
    // Pause trade detection during a data import/export so it can't write mid-operation.
    if (!tradeAccountName || maintenance) {
      return;
    }

    const sessionStartedAt = new Date().toISOString();

    let cancelled = false;
    let wfmInFlight = false;
    let wfmTimer: ReturnType<typeof setTimeout> | null = null;
    let lastWfmStartedAt = 0;
    let wfmIdleStreak = 0;

    const scheduleWfm = (preferredAt: number) => {
      if (cancelled) {
        return;
      }

      if (wfmTimer) {
        clearTimeout(wfmTimer);
      }

      const delay = Math.max(0, preferredAt - Date.now());
      wfmTimer = setTimeout(() => {
        void runWfm();
      }, delay);
    };

    const runWfm = async () => {
      if (cancelled || wfmInFlight) {
        return;
      }

      const startedAt = Date.now();
      const requestPriority = getTradeDetectionRequestPriority(lastWfmStartedAt, startedAt);
      lastWfmStartedAt = startedAt;
      wfmInFlight = true;
      try {
        const result = await refreshWfmTradeDetection(tradeAccountName, {
          sessionStartedAt,
          requestPriority,
        });
        // Reset to the fast cadence on activity; otherwise back off while idle.
        if (result.detectedBuys && result.detectedBuys.length > 0) {
          wfmIdleStreak = 0;
        } else {
          wfmIdleStreak = Math.min(wfmIdleStreak + 1, WFM_TRADE_IDLE_STREAK_CAP);
        }
      } catch (error) {
        console.error('[trades] failed to refresh WFM trade detection', error);
      } finally {
        wfmInFlight = false;
        scheduleWfm(startedAt + wfmPollIntervalForStreak(wfmIdleStreak));
      }
    };


    scheduleWfm(Date.now() + WFM_INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      if (wfmTimer) {
        clearTimeout(wfmTimer);
      }
    };
  }, [tradeAccountName, handleDetectedBuys, maintenance]);
}
