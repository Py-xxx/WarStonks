import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useWorldStateRefresh } from './useWorldStateRefresh';

export function useWorldStateActivities() {
  const worldStateAlertsLastUpdatedAt = useAppStore((state) => state.worldStateAlertsLastUpdatedAt);
  const worldStateAlertsNextRefreshAt = useAppStore((state) => state.worldStateAlertsNextRefreshAt);
  const worldStateAlertsError = useAppStore((state) => state.worldStateAlertsError);
  const worldStateAlertsLoading = useAppStore((state) => state.worldStateAlertsLoading);
  const refreshWorldStateAlerts = useAppStore((state) => state.refreshWorldStateAlerts);

  const worldStateSortieLastUpdatedAt = useAppStore((state) => state.worldStateSortieLastUpdatedAt);
  const worldStateSortieNextRefreshAt = useAppStore((state) => state.worldStateSortieNextRefreshAt);
  const worldStateSortieError = useAppStore((state) => state.worldStateSortieError);
  const worldStateSortieLoading = useAppStore((state) => state.worldStateSortieLoading);
  const refreshWorldStateSortie = useAppStore((state) => state.refreshWorldStateSortie);

  const worldStateArbitrationLastUpdatedAt = useAppStore(
    (state) => state.worldStateArbitrationLastUpdatedAt,
  );
  const worldStateArbitrationNextRefreshAt = useAppStore(
    (state) => state.worldStateArbitrationNextRefreshAt,
  );
  const worldStateArbitrationError = useAppStore((state) => state.worldStateArbitrationError);
  const worldStateArbitrationLoading = useAppStore((state) => state.worldStateArbitrationLoading);
  const refreshWorldStateArbitration = useAppStore((state) => state.refreshWorldStateArbitration);

  const worldStateArchonHuntLastUpdatedAt = useAppStore(
    (state) => state.worldStateArchonHuntLastUpdatedAt,
  );
  const worldStateArchonHuntNextRefreshAt = useAppStore(
    (state) => state.worldStateArchonHuntNextRefreshAt,
  );
  const worldStateArchonHuntError = useAppStore((state) => state.worldStateArchonHuntError);
  const worldStateArchonHuntLoading = useAppStore((state) => state.worldStateArchonHuntLoading);
  const refreshWorldStateArchonHunt = useAppStore((state) => state.refreshWorldStateArchonHunt);

  const worldStateInvasionsLastUpdatedAt = useAppStore(
    (state) => state.worldStateInvasionsLastUpdatedAt,
  );
  const worldStateInvasionsNextRefreshAt = useAppStore(
    (state) => state.worldStateInvasionsNextRefreshAt,
  );
  const worldStateInvasionsError = useAppStore((state) => state.worldStateInvasionsError);
  const worldStateInvasionsLoading = useAppStore((state) => state.worldStateInvasionsLoading);
  const refreshWorldStateInvasions = useAppStore((state) => state.refreshWorldStateInvasions);
  const worldStateInvasions = useAppStore((state) => state.worldStateInvasions);
  const scanInvasionRewardPricesIfNeeded = useAppStore(
    (state) => state.scanInvasionRewardPricesIfNeeded,
  );
  const maintenance = useAppStore((state) => state.dataMaintenanceActive);

  const worldStateSyndicateMissionsLastUpdatedAt = useAppStore(
    (state) => state.worldStateSyndicateMissionsLastUpdatedAt,
  );
  const worldStateSyndicateMissionsNextRefreshAt = useAppStore(
    (state) => state.worldStateSyndicateMissionsNextRefreshAt,
  );
  const worldStateSyndicateMissionsError = useAppStore(
    (state) => state.worldStateSyndicateMissionsError,
  );
  const worldStateSyndicateMissionsLoading = useAppStore(
    (state) => state.worldStateSyndicateMissionsLoading,
  );
  const refreshWorldStateSyndicateMissions = useAppStore(
    (state) => state.refreshWorldStateSyndicateMissions,
  );

  useWorldStateRefresh({
    lastUpdatedAt: worldStateAlertsLastUpdatedAt,
    nextRefreshAt: worldStateAlertsNextRefreshAt,
    error: worldStateAlertsError,
    loading: worldStateAlertsLoading,
    refresh: refreshWorldStateAlerts,
  });
  useWorldStateRefresh({
    lastUpdatedAt: worldStateSortieLastUpdatedAt,
    nextRefreshAt: worldStateSortieNextRefreshAt,
    error: worldStateSortieError,
    loading: worldStateSortieLoading,
    refresh: refreshWorldStateSortie,
  });
  useWorldStateRefresh({
    lastUpdatedAt: worldStateArbitrationLastUpdatedAt,
    nextRefreshAt: worldStateArbitrationNextRefreshAt,
    error: worldStateArbitrationError,
    loading: worldStateArbitrationLoading,
    refresh: refreshWorldStateArbitration,
  });
  useWorldStateRefresh({
    lastUpdatedAt: worldStateArchonHuntLastUpdatedAt,
    nextRefreshAt: worldStateArchonHuntNextRefreshAt,
    error: worldStateArchonHuntError,
    loading: worldStateArchonHuntLoading,
    refresh: refreshWorldStateArchonHunt,
  });
  useWorldStateRefresh({
    lastUpdatedAt: worldStateInvasionsLastUpdatedAt,
    nextRefreshAt: worldStateInvasionsNextRefreshAt,
    error: worldStateInvasionsError,
    loading: worldStateInvasionsLoading,
    refresh: refreshWorldStateInvasions,
  });
  useWorldStateRefresh({
    lastUpdatedAt: worldStateSyndicateMissionsLastUpdatedAt,
    nextRefreshAt: worldStateSyndicateMissionsNextRefreshAt,
    error: worldStateSyndicateMissionsError,
    loading: worldStateSyndicateMissionsLoading,
    refresh: refreshWorldStateSyndicateMissions,
  });

  // Mounted once on the AppShell, so reward prices resolve in the background whatever tab is
  // open — same arrangement as Baro's inventory scan. The effect re-runs on every invasion
  // refresh; the store's reward-set signature is what stops that reaching WFM each time.
  useEffect(() => {
    if (!maintenance && worldStateInvasions.length > 0) {
      void scanInvasionRewardPricesIfNeeded();
    }
  }, [maintenance, worldStateInvasions, scanInvasionRewardPricesIfNeeded]);
}
