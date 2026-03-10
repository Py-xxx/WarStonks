import { useAppStore } from '../stores/useAppStore';
import { useWorldStateRefresh } from './useWorldStateRefresh';

export function useWorldStateFissures() {
  const lastUpdatedAt = useAppStore((state) => state.worldStateFissuresLastUpdatedAt);
  const nextRefreshAt = useAppStore((state) => state.worldStateFissuresNextRefreshAt);
  const error = useAppStore((state) => state.worldStateFissuresError);
  const loading = useAppStore((state) => state.worldStateFissuresLoading);
  const refreshWorldStateFissures = useAppStore((state) => state.refreshWorldStateFissures);

  useWorldStateRefresh({
    lastUpdatedAt,
    nextRefreshAt,
    error,
    loading,
    refresh: refreshWorldStateFissures,
  });
}
