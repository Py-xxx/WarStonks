import { useEffect } from 'react';
import { fireAlertNotification } from '../lib/notifications';
import {
  listenToWatchlistOrders,
  setWatchlistTargets,
  type WatchlistTargetSync,
} from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

/** Variant keys are `rank:N` or `base`; matching needs the numeric rank (or null). */
function rankFromVariantKey(variantKey: string): number | null {
  if (variantKey.startsWith('rank:')) {
    const parsed = Number.parseInt(variantKey.slice('rank:'.length), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Bridges the watchlist to the backend realtime newOrders subscription:
 *  1. Pushes the current watchlist (slug + target + rank) and seller mode to the backend
 *     whenever it changes, so the subscription matches the right items.
 *  2. Listens for pushed matches and raises alerts instantly — no polling needed for these.
 *
 * The periodic scanner still runs for reconciliation (sold-out / removed / price-dropped
 * orders the creation-only feed can't report); this just makes the common case real-time.
 */
export function useWatchlistSubscription() {
  // Re-sync only when the matching-relevant fields change.
  const syncKey = useAppStore((state) => {
    const items = state.watchlist
      .map((item) => `${item.id}|${item.slug}|${item.targetPrice}|${item.variantKey}`)
      .join(';');
    return `${items}#${state.sellerMode}`;
  });

  useEffect(() => {
    const state = useAppStore.getState();
    const targets: WatchlistTargetSync[] = state.watchlist.map((item) => ({
      watchlistId: item.id,
      slug: item.slug,
      targetPrice: item.targetPrice,
      rank: rankFromVariantKey(item.variantKey),
    }));

    void setWatchlistTargets(targets, state.sellerMode).catch((error) => {
      console.error('[watchlist-subscription] failed to sync targets', error);
    });
  }, [syncKey]);

  useEffect(() => {
    let active = true;
    let unlisten: () => void = () => undefined;

    void listenToWatchlistOrders((order) => {
      const triggered = useAppStore.getState().ingestRealtimeWatchlistOrder(order);
      if (triggered) {
        const state = useAppStore.getState();
        const latest = state.alerts.find((alert) => alert.orderId === order.orderId);
        const itemLabel = latest?.itemName ?? order.slug;
        fireAlertNotification(
          state.notificationSettings,
          'watchlistAlert',
          'Watchlist target hit',
          `${itemLabel} — ${order.platinum} pt from ${order.username}`,
        );
      }
    })
      .then((dispose) => {
        if (active) {
          unlisten = dispose;
        } else {
          dispose();
        }
      })
      .catch((error) => {
        console.error('[watchlist-subscription] failed to listen for orders', error);
      });

    return () => {
      active = false;
      unlisten();
    };
  }, []);
}
