import { useAppStore } from '../stores/useAppStore';
import { useWorldStateRefresh } from './useWorldStateRefresh';

export function useWorldStateVoidTrader() {
  const lastUpdatedAt = useAppStore((state) => state.worldStateVoidTraderLastUpdatedAt);
  const nextRefreshAt = useAppStore((state) => state.worldStateVoidTraderNextRefreshAt);
  const error = useAppStore((state) => state.worldStateVoidTraderError);
  const loading = useAppStore((state) => state.worldStateVoidTraderLoading);
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);

  useWorldStateRefresh({
    lastUpdatedAt,
    nextRefreshAt,
    error,
    loading,
    refresh: refreshWorldStateVoidTrader,
  });
}
