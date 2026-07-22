import { useEffect } from 'react';
import {
  getTradeBuyOrderHealth,
  getTradeSellOrderHealth,
  getWfmTradeOverview,
  isTauriRuntime,
} from '../lib/tauriClient';
import { maybeFireHealthAlert } from '../lib/tradeHealthAlerts';
import { useAppStore } from '../stores/useAppStore';
import type { TradeListingHealth, TradeSellOrder } from '../types';

// Keeps trade-order health fresh app-wide — even when the Trades page is closed or the window is
// minimized. The Trades page runs its own faster loop for live UI updates; this background pass
// exists so that while you're on another page (or in-game with WarStonks minimized) your listing
// health, cost-basis warnings, and the proactive "needs action" alert stay current.
//
// Cadence is deliberately gentler than the foreground loop, and it steps down to the WFM
// scheduler's Low priority, so live trading traffic always wins. Urgent undercuts are handled
// separately by the firehose event-driven refresh, so this only needs to catch removals/edits
// and slow drift.
const BACKGROUND_REFRESH_INTERVAL_MS = 90_000;
// Small gap between per-order health calls so a big book doesn't burst the WFM scheduler.
const PER_ORDER_GAP_MS = 400;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useTradeHealthBackground(): void {
  const tradeAccountName = useAppStore((state) => state.tradeAccount?.name ?? null);
  const sellerMode = useAppStore((state) => state.sellerMode);
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);

  useEffect(() => {
    if (!tradeAccountName || !isTauriRuntime()) {
      return;
    }

    let cancelled = false;

    const refreshHealthFor = async (
      order: TradeSellOrder,
    ): Promise<TradeListingHealth | null> => {
      try {
        if (order.orderType === 'sell') {
          return await getTradeSellOrderHealth(
            order.itemId,
            order.slug,
            order.rank,
            order.yourPrice,
            sellerMode,
            'low',
            order.createdAt,
            order.bulkTradable ? order.perTrade : null,
            order.orderId,
            order.wfmId,
          );
        }
        return await getTradeBuyOrderHealth(
          order.itemId,
          order.slug,
          order.rank,
          order.yourPrice,
          sellerMode,
          'low',
        );
      } catch {
        return null;
      }
    };

    const runCycle = async () => {
      // Don't fight a data import/export, and don't duplicate the foreground loop while the user
      // is actively on the Trades page (it refreshes faster there).
      if (cancelled || maintenance) {
        return;
      }
      if (useAppStore.getState().activePage === 'trades') {
        return;
      }

      let overview;
      try {
        overview = await getWfmTradeOverview(sellerMode);
      } catch {
        return;
      }
      if (cancelled) {
        return;
      }

      const sellWithHealth: TradeSellOrder[] = [];
      for (const order of [...overview.sellOrders, ...overview.buyOrders]) {
        if (cancelled || useAppStore.getState().activePage === 'trades') {
          return;
        }
        const health = await refreshHealthFor(order);
        if (order.orderType === 'sell') {
          sellWithHealth.push(health ? { ...order, health } : order);
        }
        await sleep(PER_ORDER_GAP_MS);
      }

      if (!cancelled) {
        // Proactive alert (opt-in, throttled) off the freshly-scored sell orders.
        maybeFireHealthAlert(sellWithHealth);
      }
    };

    // Kick off shortly after mount, then poll. The initial delay lets startup settle.
    const initialTimer = window.setTimeout(() => void runCycle(), 15_000);
    const interval = window.setInterval(() => void runCycle(), BACKGROUND_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [tradeAccountName, sellerMode, maintenance]);
}
