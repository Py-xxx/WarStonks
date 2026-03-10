import { useAppStore } from '../stores/useAppStore';
import { useWorldStateRefresh } from './useWorldStateRefresh';

export function useWorldStateEvents() {
  const lastUpdatedAt = useAppStore((state) => state.worldStateEventsLastUpdatedAt);
  const nextRefreshAt = useAppStore((state) => state.worldStateEventsNextRefreshAt);
  const error = useAppStore((state) => state.worldStateEventsError);
  const loading = useAppStore((state) => state.worldStateEventsLoading);
  const refreshWorldStateEvents = useAppStore((state) => state.refreshWorldStateEvents);

  useWorldStateRefresh({
    lastUpdatedAt,
    nextRefreshAt,
    error,
    loading,
    refresh: refreshWorldStateEvents,
  });
}
