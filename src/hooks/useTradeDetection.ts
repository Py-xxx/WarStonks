import { useEffect } from 'react';
import {
  refreshAlecaframeTradeDetection,
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
const ALECAFRAME_POLL_MIN_MS = 10_000;
const ALECAFRAME_POLL_MAX_MS = 20_000;
const ALECAFRAME_IDLE_STREAK_CAP = 1; // 10s → 20s
// Failure backoff: 30s → 60s → 120s → 180s, independent of the idle cadence.
const ALECAFRAME_ERROR_BACKOFF_BASE_MS = 30_000;
const ALECAFRAME_ERROR_BACKOFF_MAX_MS = 180_000;
const ALECAFRAME_ERROR_STREAK_CAP = 3;
const WFM_INITIAL_DELAY_MS = 1_000;
const ALECAFRAME_INITIAL_DELAY_MS = 2_500;
const MIN_TRADE_REFRESH_GAP_MS = 3_000;

function wfmPollIntervalForStreak(idleStreak: number): number {
  return Math.min(WFM_TRADE_POLL_MIN_MS * 2 ** idleStreak, WFM_TRADE_POLL_MAX_MS);
}

function alecaframePollIntervalForStreak(idleStreak: number): number {
  return Math.min(ALECAFRAME_POLL_MIN_MS * 2 ** idleStreak, ALECAFRAME_POLL_MAX_MS);
}

function alecaframeErrorBackoffMs(errorStreak: number): number {
  return Math.min(
    ALECAFRAME_ERROR_BACKOFF_BASE_MS * 2 ** (errorStreak - 1),
    ALECAFRAME_ERROR_BACKOFF_MAX_MS,
  );
}

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
    let alecaframeInFlight = false;
    let wfmTimer: ReturnType<typeof setTimeout> | null = null;
    let alecaframeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastWfmStartedAt = 0;
    let lastAlecaframeStartedAt = 0;
    let wfmIdleStreak = 0;
    let alecaframeIdleStreak = 0;
    let alecaframeErrorStreak = 0;

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
        // A successful call clears any error backoff. Reset to the fast cadence on activity;
        // otherwise drift to the mild idle cadence.
        alecaframeErrorStreak = 0;
        if (result.newTradeCount > 0) {
          alecaframeIdleStreak = 0;
        } else {
          alecaframeIdleStreak = Math.min(alecaframeIdleStreak + 1, ALECAFRAME_IDLE_STREAK_CAP);
        }
      } catch (error) {
        // Errors back off on their own, much steeper curve — retrying fast against an unhealthy
        // or rate-limited server is what causes 503s. Kept separate from the idle streak so the
        // idle cadence can stay fast without weakening failure handling.
        alecaframeErrorStreak = Math.min(alecaframeErrorStreak + 1, ALECAFRAME_ERROR_STREAK_CAP);
        console.error('[trades] failed to refresh Alecaframe trade detection', error);
      } finally {
        alecaframeInFlight = false;
        const nextDelay =
          alecaframeErrorStreak > 0
            ? alecaframeErrorBackoffMs(alecaframeErrorStreak)
            : alecaframePollIntervalForStreak(alecaframeIdleStreak);
        scheduleAlecaframe(startedAt + nextDelay);
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
  }, [tradeAccountName, handleDetectedBuys, maintenance]);
}
