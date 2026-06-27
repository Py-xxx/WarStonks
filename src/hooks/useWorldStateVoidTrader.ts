import { useEffect } from 'react';
import { isWorldStateWindowActive } from '../lib/worldState';
import { useAppStore } from '../stores/useAppStore';
import { useWorldStateRefresh } from './useWorldStateRefresh';

export function useWorldStateVoidTrader() {
  const lastUpdatedAt = useAppStore((state) => state.worldStateVoidTraderLastUpdatedAt);
  const nextRefreshAt = useAppStore((state) => state.worldStateVoidTraderNextRefreshAt);
  const error = useAppStore((state) => state.worldStateVoidTraderError);
  const loading = useAppStore((state) => state.worldStateVoidTraderLoading);
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);
  const voidTrader = useAppStore((state) => state.worldStateVoidTrader);
  const scanVoidTraderPricesIfNeeded = useAppStore((state) => state.scanVoidTraderPricesIfNeeded);
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);

  useWorldStateRefresh({
    lastUpdatedAt,
    nextRefreshAt,
    error,
    loading,
    refresh: refreshWorldStateVoidTrader,
  });

  // This hook is mounted once on the AppShell, so the inventory price scan runs in the
  // background as soon as Baro is detected active — whether he just arrived or the app was
  // opened after his arrival — regardless of which tab is open. Guarded to once per visit.
  useEffect(() => {
    if (
      !maintenance &&
      voidTrader &&
      voidTrader.inventory.length > 0 &&
      isWorldStateWindowActive(voidTrader.activation, voidTrader.expiry)
    ) {
      void scanVoidTraderPricesIfNeeded();
    }
  }, [
    maintenance,
    voidTrader?.id,
    voidTrader?.inventory.length,
    voidTrader?.activation,
    voidTrader?.expiry,
    scanVoidTraderPricesIfNeeded,
  ]);
}
