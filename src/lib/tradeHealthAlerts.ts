import { tActive } from '../i18n';
import { fireAlertNotification, loadNotificationSettings } from './notifications';
import { sendListingHealthDiscordNotification, isTauriRuntime } from './tauriClient';
import type { TradeSellOrder } from '../types';

// #15 Proactive "listings need action" alert. Throttled module-wide (single shared timestamp)
// so it fires at most once per window regardless of which loop triggers it — the foreground
// Trades page or the always-on background refresher. Opt-in via the listingHealth notification
// event, so it never surprises users who didn't ask for it. Fires the desktop alert and the
// Discord webhook independently — each gated by its own setting (Discord is gated backend-side).
let lastHealthAlertAt = 0;
const HEALTH_ALERT_THROTTLE_MS = 30 * 60 * 1000;

export function maybeFireHealthAlert(orders: TradeSellOrder[]): void {
  const settings = loadNotificationSettings();
  const needing = orders.filter((order) => {
    const label = order.health?.label ?? '';
    return label === 'Action Needed' || label === 'Weak';
  });
  if (needing.length < 1) {
    return;
  }
  const now = Date.now();
  if (now - lastHealthAlertAt < HEALTH_ALERT_THROTTLE_MS) {
    return;
  }
  lastHealthAlertAt = now;

  if (settings.events.listingHealth) {
    fireAlertNotification(
      settings,
      'listingHealth',
      tActive('trades.health.alertTitle'),
      tActive('trades.health.alertBody', { count: String(needing.length) }),
    );
  }

  // Discord (gated backend-side on discord.enabled && listing_health). Send the worst few as
  // examples so the embed is useful at a glance.
  if (isTauriRuntime()) {
    void sendListingHealthDiscordNotification({
      count: needing.length,
      examples: needing.slice(0, 4).map((order) => ({
        itemName: order.name,
        yourPrice: order.yourPrice,
        marketLow: order.marketLow ?? null,
        status: order.health?.label ?? '',
      })),
    }).catch(() => undefined);
  }
}
