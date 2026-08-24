/**
 * Worldstate alerts, as a standalone panel.
 *
 * **Moved out of `ActivitiesPanel`, not copied.** It was one of six cards in an 825-line file,
 * given equal billing with syndicate bounties despite being the only time-critical one; alerts now
 * live on the Events overview where they are seen without navigating. The card body is the shipped
 * one, unchanged — it composes `buildRewardLabel`, `buildLevelLabel`, `PanelEmpty` and `PanelError`
 * from `ActivitiesPanel` rather than growing its own copies.
 *
 * Named `WorldStateAlertsPanel` on purpose: `components/AlertsPanel` is the TopBar notifications
 * popup and has nothing to do with this. That collision has already caused confusion once.
 */
import { useEffect, useState } from 'react';

import { useTranslation } from '../../i18n';
import { formatWorldStateCountdown, formatWorldStateDateTime } from '../../lib/worldState';
import { useAppStore } from '../../stores/useAppStore';
import type { WfstatAlert } from '../../types';
import { buildLevelLabel, buildRewardLabel } from '../ActivitiesPanel';
import { Skeleton } from '@/components/ui/skeleton';
import { Countdown, EventEmpty, EventError, EventPanel, EventRow } from '../Events/parts';

function AlertsCardView({
  alerts,
  loading,
  error,
  lastUpdatedAt,
  nowMs,
  onRefresh,
}: {
  alerts: WfstatAlert[];
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  nowMs: number;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const activeAlerts = alerts.filter(
    (alert) => !alert.expired && Date.parse(alert.expiry ?? '') > nowMs,
  );
  const rewardLabels = {
    noRewardData: t('evt.noRewardData'),
    creditsSuffix: (n: string) => t('evt.creditsSuffix', { n }),
  };

  return (
    <EventPanel
      title={t('ws.alerts')}
      count={activeAlerts.length}
      countTone={activeAlerts.length > 0 ? 'positive' : 'muted'}
      updatedAt={
        lastUpdatedAt ? t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) }) : null
      }
      bodyClassName="flex flex-col gap-1 p-2"
    >
      {error ? <EventError error={error} stale={alerts.length > 0} onRetry={onRefresh} /> : null}
      {loading && alerts.length === 0 ? <Skeleton type="table-row@2" leafClassName="h-5" /> : null}

      {!loading && activeAlerts.length === 0 && !error ? (
        <EventEmpty icon="ti-bell-check" title={t('evt.noActiveAlerts')} />
      ) : null}

      {/* The reward is why you would run an alert, so it is the headline; the mission and node are
          the meta line. This was a bordered card with a chip row per alert. */}
      {activeAlerts.map((alert) => {
        const level = buildLevelLabel(
          alert.mission?.minEnemyLevel ?? null,
          alert.mission?.maxEnemyLevel ?? null,
        );
        return (
          <EventRow
            key={alert.id}
            title={buildRewardLabel(alert.mission?.reward ?? null, rewardLabels)}
            meta={[
              alert.mission?.type ?? t('evt.unknownMission'),
              alert.mission?.node ?? t('mkt.unknownNode'),
              alert.mission?.faction,
              level ? t('evt.lvLabel', { value: level }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            trailing={<Countdown value={formatWorldStateCountdown(alert.expiry, nowMs)} />}
          />
        );
      })}
    </EventPanel>
  );
}

export function WorldStateAlertsPanel() {
  const alerts = useAppStore((state) => state.worldStateAlerts);
  const loading = useAppStore((state) => state.worldStateAlertsLoading);
  const error = useAppStore((state) => state.worldStateAlertsError);
  const lastUpdatedAt = useAppStore((state) => state.worldStateAlertsLastUpdatedAt);
  const refreshWorldStateAlerts = useAppStore((state) => state.refreshWorldStateAlerts);

  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <AlertsCardView
      alerts={alerts}
      loading={loading}
      error={error}
      lastUpdatedAt={lastUpdatedAt}
      nowMs={nowMs}
      onRefresh={() => {
        void refreshWorldStateAlerts();
      }}
    />
  );
}
