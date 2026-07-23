import { useEffect } from 'react';
import { subscribeToSmartManageChanges, isTauriRuntime } from '../lib/tauriClient';
import { fireAlertNotification, loadNotificationSettings } from '../lib/notifications';
import { tActive } from '../i18n';
import { formatPlatinumValue } from '../lib/trades';
import { useAppStore } from '../stores/useAppStore';

// Fires an in-app / desktop notification when Smart Manage changes (or, in preview, would change)
// a listing price. Backend already handles the Discord webhook; this is the local alert. Mounted
// once on the AppShell so it works regardless of which page is open.
export function useSmartManageAlerts(): void {
  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void subscribeToSmartManageChanges((change) => {
      // An applied change moved the real listing price on WFM — ask the Trades view to reload so
      // the new price shows immediately.
      if (change.applied) {
        useAppStore.getState().requestTradeOverviewReload();
      }
      // Only a genuine price change is worth a notification — "held" observations are feed-only.
      if (change.newPrice === change.oldPrice) {
        return;
      }
      const settings = loadNotificationSettings();
      const raised = change.newPrice > change.oldPrice;
      const verb = raised
        ? tActive('smart.notif.raisedVerb')
        : tActive('smart.notif.trimmedVerb');
      fireAlertNotification(
        settings,
        'priceChange',
        tActive('smart.notif.title'),
        tActive('smart.notif.body', {
          item: change.slug.replace(/_/g, ' '),
          verb,
          from: formatPlatinumValue(change.oldPrice),
          to: formatPlatinumValue(change.newPrice),
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
