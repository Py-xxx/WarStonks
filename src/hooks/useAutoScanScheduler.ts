import { useEffect } from 'react';
import { getArbitrageScannerState, isTauriRuntime, startArbitrageScanner } from '../lib/tauriClient';
import { AUTO_SCAN_CHECK_INTERVAL_MS, AUTO_SCAN_STALE_THRESHOLD_MS } from '../lib/autoScan';
import { useAppStore } from '../stores/useAppStore';

/**
 * Opt-in background scheduler that keeps the arbitrage scan fresh automatically. Deliberately
 * conservative to stay well inside WFM's rate rules: it only triggers a scan when the last
 * snapshot is ≥24h old (so ~once/day, close to a diligent manual user), never stacks scans, and
 * relies on the scanner's existing `Low` scheduler priority so live watchlist/order traffic always
 * wins. Disabled by default; pauses during data maintenance; no-op outside the Tauri shell.
 */
export function useAutoScanScheduler(): void {
  const enabled = useAppStore((state) => state.autoScanEnabled);
  const dataMaintenanceActive = useAppStore((state) => state.dataMaintenanceActive);

  useEffect(() => {
    if (!enabled || !isTauriRuntime()) {
      return;
    }

    let cancelled = false;

    const maybeScan = async () => {
      if (cancelled || dataMaintenanceActive) {
        return;
      }
      try {
        const state = await getArbitrageScannerState();
        if (cancelled) {
          return;
        }
        // Never launch over a running scan — one frozen snapshot is the model.
        if (state.progress?.status === 'running') {
          return;
        }
        const finishedAt = state.latestScan?.scanFinishedAt ?? null;
        const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN;
        const isStale =
          !Number.isFinite(finishedMs) || Date.now() - finishedMs >= AUTO_SCAN_STALE_THRESHOLD_MS;
        if (isStale) {
          await startArbitrageScanner();
        }
      } catch (error) {
        // Best-effort: a failed probe/start just retries on the next tick.
        console.warn('[auto-scan] staleness check failed', error);
      }
    };

    // Check shortly after mount/enable (not instantly — let startup's own scan settle), then poll.
    const initialTimeout = window.setTimeout(() => void maybeScan(), 30_000);
    const intervalId = window.setInterval(() => void maybeScan(), AUTO_SCAN_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initialTimeout);
      window.clearInterval(intervalId);
    };
  }, [enabled, dataMaintenanceActive]);
}
