import { tActive } from '../i18n';
import { fireAlertNotification, loadNotificationSettings } from './notifications';
import type { TradeSellOrder } from '../types';

// #15 Proactive "listings need action" alert. Throttled module-wide (single shared timestamp)
// so it fires at most once per window regardless of which loop triggers it — the foreground
// Trades page or the always-on background refresher. Opt-in via the listingHealth notification
// event (off by default), so it never surprises users who didn't ask for it.
let lastHealthAlertAt = 0;
const HEALTH_ALERT_THROTTLE_MS = 30 * 60 * 1000;

export function maybeFireHealthAlert(orders: TradeSellOrder[]): void {
  const settings = loadNotificationSettings();
  if (!settings.events.listingHealth) {
    return;
  }
  const needsAction = orders.filter((order) => {
    const label = order.health?.label ?? '';
    return label === 'Action Needed' || label === 'Weak';
  }).length;
  if (needsAction < 1) {
    return;
  }
  const now = Date.now();
  if (now - lastHealthAlertAt < HEALTH_ALERT_THROTTLE_MS) {
    return;
  }
  lastHealthAlertAt = now;
  fireAlertNotification(
    settings,
    'listingHealth',
    tActive('trades.health.alertTitle'),
    tActive('trades.health.alertBody', { count: String(needsAction) }),
  );
}
