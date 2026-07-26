import { useEffect } from 'react';
import { subscribeToTradeDetected, isTauriRuntime } from '../lib/tauriClient';
import { fireAlertNotification, loadNotificationSettings } from '../lib/notifications';
import { tActive } from '../i18n';

// Fires a desktop / sound notification when the backend detects a completed trade. The backend
// already handles the Discord webhook and emits `wfm-trade-detected`; this is the local alert,
// gated on the tradeDetected event. Mounted once on the AppShell so it works on any page.
export function useTradeDetectedAlerts(): void {
  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void subscribeToTradeDetected((trade) => {
      const settings = loadNotificationSettings();
      if (!settings.events.tradeDetected) {
        return;
      }
      const kind = trade.orderType.toLowerCase() === 'buy'
        ? tActive('trades.detected.buy')
        : tActive('trades.detected.sell');
      fireAlertNotification(
        settings,
        'tradeDetected',
        tActive('trades.detected.title', { kind }),
        tActive('trades.detected.body', {
          item: trade.itemName ?? tActive('trades.detected.items', { count: String(trade.itemCount) }),
          plat: String(trade.totalPlatinum),
        }),
      );
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        dispose = unlisten;
      }
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
}
