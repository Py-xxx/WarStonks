import { useAppStore } from '../stores/useAppStore';
import { useWorldStateRefresh } from './useWorldStateRefresh';

export function useWorldStateMarketNews() {
  const lastUpdatedAt = useAppStore((state) => state.worldStateMarketNewsLastUpdatedAt);
  const nextRefreshAt = useAppStore((state) => state.worldStateMarketNewsNextRefreshAt);
  const error = useAppStore((state) => state.worldStateMarketNewsError);
  const loading = useAppStore((state) => state.worldStateMarketNewsLoading);
  const refreshWorldStateMarketNews = useAppStore((state) => state.refreshWorldStateMarketNews);

  useWorldStateRefresh({
    lastUpdatedAt,
    nextRefreshAt,
    error,
    loading,
    refresh: refreshWorldStateMarketNews,
  });
}
