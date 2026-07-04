import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
  formatWorldStateCountdown,
  formatWorldStateDateTime,
  isWorldStateWindowActive,
} from '../../lib/worldState';
import { EventsPanelEmpty, EventsPanelNotice } from '../EventsPanelState';
import { useAppStore } from '../../stores/useAppStore';
import type {
  WfstatAlert,
  WfstatArchonHunt,
  WfstatArbitration,
  WfstatEventReward,
  WfstatInvasion,
  WfstatSortie,
  WfstatSyndicateJob,
  WfstatSyndicateMission,
} from '../../types';

function buildRewardLabel(
  reward: WfstatEventReward | null,
  labels: { noRewardData: string; creditsSuffix: (n: string) => string },
): string {
  if (!reward) {
    return labels.noRewardData;
  }

  const itemParts = reward.items;
  const countedParts = reward.countedItems.map((entry) => `${entry.count}x ${entry.type}`);
  const creditParts =
    reward.credits && reward.credits > 0 ? [labels.creditsSuffix(reward.credits.toLocaleString())] : [];

  return [...itemParts, ...countedParts, ...creditParts].join(', ');
}

function buildLevelLabel(minLevel: number | null, maxLevel: number | null): string | null {
  if (minLevel === null && maxLevel === null) {
    return null;
  }

  if (minLevel !== null && maxLevel !== null) {
    return `${minLevel}-${maxLevel}`;
  }

  return `${minLevel ?? maxLevel}`;
}

function formatStandingTotal(stages: number[], standingTotalLabel: (n: string) => string): string | null {
  if (stages.length === 0) {
    return null;
  }

  const total = stages.reduce((sum, value) => sum + value, 0);
  return standingTotalLabel(total.toLocaleString());
}

function buildJobRewardPreview(job: WfstatSyndicateJob): string {
  if (job.rewardPoolDrops.length > 0) {
    return job.rewardPoolDrops
      .slice(0, 3)
      .map((drop) => {
        const countLabel = drop.count && drop.count > 1 ? `${drop.count}x ` : '';
        return `${countLabel}${drop.item}`;
      })
      .join(' • ');
  }

  return job.rewardPool.slice(0, 3).join(' • ');
}

function buildInvasionRewardLabel(
  invasion: WfstatInvasion,
  labels: { noRewardData: string; creditsSuffix: (n: string) => string },
): string {
  const attackerReward = buildRewardLabel(invasion.attacker.reward, labels);
  const defenderReward = buildRewardLabel(invasion.defender.reward, labels);

  if (invasion.vsInfestation) {
    return defenderReward;
  }

  return `${attackerReward} vs ${defenderReward}`;
}

function PanelMeta({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="activity-meta-item">
      <span className="activity-meta-label">{label}</span>
      <span className="activity-meta-value">{value}</span>
    </div>
  );
}

function PanelEmpty({
  title,
  detail,
  actionLabel = null,
  onAction = null,
}: {
  title: string;
  detail: string;
  actionLabel?: string | null;
  onAction?: (() => void) | null;
}) {
  return <EventsPanelEmpty title={title} detail={detail} actionLabel={actionLabel} onAction={onAction} />;
}

function PanelError({
  error,
  tone,
  loading,
  onRefresh,
}: {
  error: string | null;
  tone: 'warning' | 'error';
  loading: boolean;
  onRefresh: () => void;
}) {
  return <EventsPanelNotice message={error} tone={tone} loading={loading} onRefresh={onRefresh} />;
}

function SortieCard({
  sortie,
  loading,
  error,
  lastUpdatedAt,
  nowMs,
  onRefresh,
}: {
  sortie: WfstatSortie | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  nowMs: number;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const isActive =
    sortie &&
    !sortie.expired &&
    isWorldStateWindowActive(sortie.activation, sortie.expiry, nowMs);
  const hasUsableSortie = Boolean(sortie);

  return (
    <section className="card activity-panel activity-panel-wide">
      <div className="card-header">
        <span className="card-label">{t('ws.sorties')}</span>
        {sortie && isActive ? (
          <span className="badge badge-blue">{formatWorldStateCountdown(sortie.expiry, nowMs)}</span>
        ) : (
          <span className="badge badge-muted">{t('ws.unavailable')}</span>
        )}
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            {t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) })}
          </div>
        ) : null}
        <PanelError error={error} tone={hasUsableSortie ? 'warning' : 'error'} loading={loading} onRefresh={onRefresh} />

        {!sortie || !isActive ? (
          <PanelEmpty
            title={!sortie && error ? t('evt.sortieCouldNotLoad') : t('evt.noActiveSortie')}
            detail={!sortie && error
              ? error
              : t('evt.sortieHint')}
            actionLabel={!sortie && error ? t('common.retry') : null}
            onAction={!sortie && error ? onRefresh : null}
          />
        ) : (
          <div className="activity-stack">
            <div className="activity-hero">
              <div>
                <div className="activity-title">{sortie.boss ?? t('evt.dailySortie')}</div>
                <div className="activity-subtitle">
                  {sortie.faction ?? t('evt.unknownFaction')} • {sortie.rewardPool ?? t('evt.rewardPoolUnavailable')}
                </div>
              </div>
              <div className="activity-meta-grid">
                <PanelMeta label={t('evt.starts')} value={formatWorldStateDateTime(sortie.activation)} />
                <PanelMeta label={t('evt.endsIn')} value={formatWorldStateCountdown(sortie.expiry, nowMs)} />
              </div>
            </div>

            <div className="activity-step-list">
              {sortie.variants.map((variant, index) => (
                <article key={`${sortie.id}-${index}`} className="activity-step-card">
                  <div className="activity-step-index">{t('evt.mission', { n: index + 1 })}</div>
                  <div className="activity-step-title">
                    {variant.missionType ?? t('evt.unknownMission')} • {variant.node ?? t('mkt.unknownNode')}
                  </div>
                  <div className="activity-step-detail">{variant.modifier ?? t('evt.noModifierData')}</div>
                  {variant.modifierDescription ? (
                    <div className="activity-step-copy">{variant.modifierDescription}</div>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ArchonHuntCard({
  archonHunt,
  loading,
  error,
  lastUpdatedAt,
  nowMs,
  onRefresh,
}: {
  archonHunt: WfstatArchonHunt | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  nowMs: number;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const isActive =
    archonHunt &&
    !archonHunt.expired &&
    isWorldStateWindowActive(archonHunt.activation, archonHunt.expiry, nowMs);
  const hasUsableArchonHunt = Boolean(archonHunt);

  return (
    <section className="card activity-panel activity-panel-wide">
      <div className="card-header">
        <span className="card-label">{t('ws.archonHunts')}</span>
        {archonHunt && isActive ? (
          <span className="badge badge-red">{formatWorldStateCountdown(archonHunt.expiry, nowMs)}</span>
        ) : (
          <span className="badge badge-muted">{t('ws.unavailable')}</span>
        )}
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            {t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) })}
          </div>
        ) : null}
        <PanelError error={error} tone={hasUsableArchonHunt ? 'warning' : 'error'} loading={loading} onRefresh={onRefresh} />

        {!archonHunt || !isActive ? (
          <PanelEmpty
            title={!archonHunt && error ? t('evt.archonCouldNotLoad') : t('evt.noActiveArchon')}
            detail={!archonHunt && error
              ? error
              : t('evt.archonHint')}
            actionLabel={!archonHunt && error ? t('common.retry') : null}
            onAction={!archonHunt && error ? onRefresh : null}
          />
        ) : (
          <div className="activity-stack">
            <div className="activity-hero">
              <div>
                <div className="activity-title">{archonHunt.boss ?? t('evt.archonHuntLabel')}</div>
                <div className="activity-subtitle">
                  {archonHunt.faction ?? t('evt.unknownFaction')} • {archonHunt.rewardPool ?? t('evt.rewardPoolUnavailable')}
                </div>
              </div>
              <div className="activity-meta-grid">
                <PanelMeta label={t('evt.starts')} value={formatWorldStateDateTime(archonHunt.activation)} />
                <PanelMeta label={t('evt.endsIn')} value={formatWorldStateCountdown(archonHunt.expiry, nowMs)} />
              </div>
            </div>

            <div className="activity-step-list">
              {archonHunt.missions.map((mission, index) => (
                <article key={`${archonHunt.id}-${index}`} className="activity-step-card">
                  <div className="activity-step-index">{t('evt.stage', { n: index + 1 })}</div>
                  <div className="activity-step-title">
                    {mission.type ?? t('evt.unknownMission')} • {mission.node ?? t('mkt.unknownNode')}
                  </div>
                  <div className="activity-flag-row">
                    {mission.archwingRequired ? <span className="badge badge-purple">Archwing</span> : null}
                    {mission.isSharkwing ? <span className="badge badge-blue">Sharkwing</span> : null}
                    {mission.nightmare ? <span className="badge badge-red">Nightmare</span> : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function AlertsCard({
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
  const activeAlerts = alerts.filter((alert) => !alert.expired && Date.parse(alert.expiry ?? '') > nowMs);
  const hasUsableAlerts = alerts.length > 0;
  const rewardLabels = { noRewardData: t('evt.noRewardData'), creditsSuffix: (n: string) => t('evt.creditsSuffix', { n }) };

  return (
    <section className="card activity-panel">
      <div className="card-header">
        <span className="card-label">{t('ws.alerts')}</span>
        <span className={`badge ${activeAlerts.length > 0 ? 'badge-green' : 'badge-muted'}`}>
          {t('evt.activeCount', { n: activeAlerts.length })}
        </span>
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            {t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) })}
          </div>
        ) : null}
        <PanelError error={error} tone={hasUsableAlerts ? 'warning' : 'error'} loading={loading} onRefresh={onRefresh} />

        {activeAlerts.length === 0 ? (
          <PanelEmpty
            title={error && !hasUsableAlerts ? t('evt.alertsCouldNotLoad') : t('evt.noActiveAlerts')}
            detail={error && !hasUsableAlerts
              ? error
              : t('evt.alertsHint')}
            actionLabel={error && !hasUsableAlerts ? t('common.retry') : null}
            onAction={error && !hasUsableAlerts ? onRefresh : null}
          />
        ) : (
          <div className="activity-list">
            {activeAlerts.map((alert) => (
              <article key={alert.id} className="activity-list-card">
                <div className="activity-list-top">
                  <div>
                    <div className="activity-list-title">
                      {alert.mission?.description ?? t('evt.alertMission')}
                    </div>
                    <div className="activity-list-subtitle">
                      {alert.mission?.type ?? t('evt.unknownMission')} • {alert.mission?.node ?? t('mkt.unknownNode')}
                    </div>
                  </div>
                  <span className="badge badge-green">
                    {formatWorldStateCountdown(alert.expiry, nowMs)}
                  </span>
                </div>
                <div className="activity-list-copy">{buildRewardLabel(alert.mission?.reward ?? null, rewardLabels)}</div>
                <div className="activity-chip-row">
                  {alert.mission?.faction ? <span className="activity-chip">{alert.mission.faction}</span> : null}
                  {buildLevelLabel(alert.mission?.minEnemyLevel ?? null, alert.mission?.maxEnemyLevel ?? null) ? (
                    <span className="activity-chip">
                      {t('evt.lvLabel', { value: buildLevelLabel(alert.mission?.minEnemyLevel ?? null, alert.mission?.maxEnemyLevel ?? null) ?? '' })}
                    </span>
                  ) : null}
                  {alert.tag ? <span className="activity-chip">{alert.tag}</span> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ArbitrationCard({
  arbitration,
  loading,
  error,
  lastUpdatedAt,
  nowMs,
  onRefresh,
}: {
  arbitration: WfstatArbitration | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  nowMs: number;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const isActive =
    arbitration &&
    !arbitration.expired &&
    isWorldStateWindowActive(arbitration.activation, arbitration.expiry, nowMs);
  const hasUsableArbitration = Boolean(arbitration);

  return (
    <section className="card activity-panel">
      <div className="card-header">
        <span className="card-label">{t('ws.arbitrations')}</span>
        {isActive ? (
          <span className="badge badge-amber">{formatWorldStateCountdown(arbitration?.expiry ?? null, nowMs)}</span>
        ) : (
          <span className="badge badge-muted">{t('ws.unavailable')}</span>
        )}
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            {t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) })}
          </div>
        ) : null}
        <PanelError error={error} tone={hasUsableArbitration ? 'warning' : 'error'} loading={loading} onRefresh={onRefresh} />

        {!arbitration || !isActive ? (
          <PanelEmpty
            title={!arbitration && error ? t('evt.arbitrationCouldNotLoad') : t('evt.noActiveArbitration')}
            detail={!arbitration && error
              ? error
              : t('evt.arbitrationHint')}
            actionLabel={!arbitration && error ? t('common.retry') : null}
            onAction={!arbitration && error ? onRefresh : null}
          />
        ) : (
          <div className="activity-stack">
            <div className="activity-title">{arbitration.type ?? t('evt.unknownMission')}</div>
            <div className="activity-subtitle">{arbitration.node ?? t('mkt.unknownNode')}</div>
            <div className="activity-meta-grid activity-meta-grid-single">
              <PanelMeta label={t('evt.faction')} value={arbitration.enemy ?? t('evt.unknown')} />
              <PanelMeta label={t('evt.endsIn')} value={formatWorldStateCountdown(arbitration.expiry, nowMs)} />
            </div>
            <div className="activity-flag-row">
              {arbitration.archwing ? <span className="badge badge-purple">Archwing</span> : null}
              {arbitration.sharkwing ? <span className="badge badge-blue">Sharkwing</span> : null}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function InvasionsCard({
  invasions,
  loading,
  error,
  lastUpdatedAt,
  onRefresh,
}: {
  invasions: WfstatInvasion[];
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const activeInvasions = invasions.filter((invasion) => !invasion.completed);
  const hasUsableInvasions = invasions.length > 0;
  const rewardLabels = { noRewardData: t('evt.noRewardData'), creditsSuffix: (n: string) => t('evt.creditsSuffix', { n }) };

  return (
    <section className="card activity-panel activity-panel-tall">
      <div className="card-header">
        <span className="card-label">{t('ws.invasions')}</span>
        <span className={`badge ${activeInvasions.length > 0 ? 'badge-blue' : 'badge-muted'}`}>
          {t('evt.activeCount', { n: activeInvasions.length })}
        </span>
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            {t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) })}
          </div>
        ) : null}
        <PanelError error={error} tone={hasUsableInvasions ? 'warning' : 'error'} loading={loading} onRefresh={onRefresh} />

        {activeInvasions.length === 0 ? (
          <PanelEmpty
            title={error && !hasUsableInvasions ? t('evt.invasionsCouldNotLoad') : t('evt.noActiveInvasions')}
            detail={error && !hasUsableInvasions
              ? error
              : t('evt.invasionsHint')}
            actionLabel={error && !hasUsableInvasions ? t('common.retry') : null}
            onAction={error && !hasUsableInvasions ? onRefresh : null}
          />
        ) : (
          <div className="activity-list">
            {activeInvasions.map((invasion) => {
              const completion = Math.max(0, Math.min(100, invasion.completion ?? 0));
              return (
                <article key={invasion.id} className="activity-list-card invasion-card">
                  <div className="activity-list-top">
                    <div>
                      <div className="activity-list-title">
                        {invasion.desc ?? t('evt.invasionLabel')} • {invasion.node ?? t('mkt.unknownNode')}
                      </div>
                      <div className="activity-list-subtitle">
                        {invasion.attacker.faction ?? t('evt.unknown')} vs {invasion.defender.faction ?? t('evt.unknown')}
                      </div>
                    </div>
                    <span className="badge badge-purple">{completion.toFixed(1)}%</span>
                  </div>
                  <div className="activity-list-copy">{buildInvasionRewardLabel(invasion, rewardLabels)}</div>
                  <div className="activity-progress">
                    <div className="activity-progress-fill" style={{ width: `${completion}%` }} />
                  </div>
                  <div className="activity-chip-row">
                    {invasion.requiredRuns ? <span className="activity-chip">{t('evt.runsSuffix', { n: invasion.requiredRuns.toLocaleString() })}</span> : null}
                    {invasion.vsInfestation ? <span className="activity-chip">Infested</span> : null}
                    <span className="activity-chip">
                      {t('evt.startedAt', { time: formatWorldStateDateTime(invasion.activation) })}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function SyndicateMissionsCard({
  missions,
  loading,
  error,
  lastUpdatedAt,
  nowMs,
  onRefresh,
}: {
  missions: WfstatSyndicateMission[];
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  nowMs: number;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const activeMissions = missions.filter(
    (mission) => !mission.expired && Date.parse(mission.expiry ?? '') > nowMs,
  );
  const [selectedSyndicate, setSelectedSyndicate] = useState<string | null>(null);
  const unknownSyndicate = t('evt.unknownSyndicate');

  const syndicateTabs = useMemo(
    () =>
      activeMissions
        .map((mission) => mission.syndicate ?? unknownSyndicate)
        .filter((value, index, list) => list.indexOf(value) === index),
    [activeMissions, unknownSyndicate],
  );

  useEffect(() => {
    if (syndicateTabs.length === 0) {
      setSelectedSyndicate(null);
      return;
    }

    setSelectedSyndicate((current) =>
      current && syndicateTabs.includes(current) ? current : (syndicateTabs[0] ?? null),
    );
  }, [syndicateTabs]);

  const visibleMission = activeMissions.find(
    (mission) => (mission.syndicate ?? unknownSyndicate) === selectedSyndicate,
  );
  const hasUsableMissions = missions.length > 0;

  return (
    <section className="card activity-panel activity-panel-full">
      <div className="card-header">
        <span className="card-label">{t('ws.syndicateMissions')}</span>
        <span className={`badge ${activeMissions.length > 0 ? 'badge-green' : 'badge-muted'}`}>
          {t('evt.syndicatesCount', { n: activeMissions.length })}
        </span>
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            {t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) })}
          </div>
        ) : null}
        <PanelError error={error} tone={hasUsableMissions ? 'warning' : 'error'} loading={loading} onRefresh={onRefresh} />

        {activeMissions.length === 0 ? (
          <PanelEmpty
            title={error && !hasUsableMissions ? t('evt.syndicateCouldNotLoad') : t('evt.noActiveSyndicate')}
            detail={error && !hasUsableMissions
              ? error
              : t('evt.syndicateHint')}
            actionLabel={error && !hasUsableMissions ? t('common.retry') : null}
            onAction={error && !hasUsableMissions ? onRefresh : null}
          />
        ) : (
          <div className="activity-stack">
            <div className="activities-syndicate-tabs">
              {syndicateTabs.map((syndicate) => (
                <button
                  key={syndicate}
                  className={`activities-syndicate-tab${
                    selectedSyndicate === syndicate ? ' active' : ''
                  }`}
                  type="button"
                  onClick={() => setSelectedSyndicate(syndicate)}
                >
                  {syndicate}
                </button>
              ))}
            </div>

            {visibleMission ? (
              <>
                <div className="activity-hero activity-hero-row">
                  <div>
                    <div className="activity-title">
                      {visibleMission.syndicate ?? unknownSyndicate}
                    </div>
                    <div className="activity-subtitle">
                      {visibleMission.nodes.join(' • ') || t('evt.openWorldRotation')}
                    </div>
                  </div>
                  <div className="activity-meta-grid">
                    <PanelMeta label={t('evt.rotationEnds')} value={formatWorldStateCountdown(visibleMission.expiry, nowMs)} />
                    <PanelMeta label={t('evt.updated')} value={formatWorldStateDateTime(lastUpdatedAt)} />
                  </div>
                </div>

                <div className="activities-syndicate-grid">
                  {visibleMission.jobs.map((job) => {
                    const standingTotal = formatStandingTotal(job.standingStages, (n) => t('evt.standingTotal', { n }));

                    return (
                      <article key={job.id} className="activity-job-card">
                        <div className="activity-list-top">
                          <div>
                            <div className="activity-list-title">{job.type ?? t('evt.unknownJob')}</div>
                            <div className="activity-list-subtitle">
                              {job.enemyLevels.length > 0
                                ? t('evt.lvLabel', { value: job.enemyLevels.join('-') })
                                : t('evt.enemyLevelsUnavailable')}
                            </div>
                          </div>
                          <span className="badge badge-blue">
                            {formatWorldStateCountdown(job.expiry ?? visibleMission.expiry, nowMs)}
                          </span>
                        </div>
                        <div className="activity-list-copy">{buildJobRewardPreview(job)}</div>
                        <div className="activity-chip-row">
                          {standingTotal ? <span className="activity-chip">{standingTotal}</span> : null}
                          {job.minMR !== null ? <span className="activity-chip">MR {job.minMR}+</span> : null}
                          {job.rewardPoolDrops.length > 0 ? (
                            <span className="activity-chip">{t('evt.dropsSuffix', { n: job.rewardPoolDrops.length })}</span>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

export function ActivitiesPanel() {
  const alerts = useAppStore((state) => state.worldStateAlerts);
  const alertsLoading = useAppStore((state) => state.worldStateAlertsLoading);
  const alertsError = useAppStore((state) => state.worldStateAlertsError);
  const alertsLastUpdatedAt = useAppStore((state) => state.worldStateAlertsLastUpdatedAt);
  const refreshWorldStateAlerts = useAppStore((state) => state.refreshWorldStateAlerts);

  const sortie = useAppStore((state) => state.worldStateSortie);
  const sortieLoading = useAppStore((state) => state.worldStateSortieLoading);
  const sortieError = useAppStore((state) => state.worldStateSortieError);
  const sortieLastUpdatedAt = useAppStore((state) => state.worldStateSortieLastUpdatedAt);
  const refreshWorldStateSortie = useAppStore((state) => state.refreshWorldStateSortie);

  const arbitration = useAppStore((state) => state.worldStateArbitration);
  const arbitrationLoading = useAppStore((state) => state.worldStateArbitrationLoading);
  const arbitrationError = useAppStore((state) => state.worldStateArbitrationError);
  const arbitrationLastUpdatedAt = useAppStore((state) => state.worldStateArbitrationLastUpdatedAt);
  const refreshWorldStateArbitration = useAppStore((state) => state.refreshWorldStateArbitration);

  const archonHunt = useAppStore((state) => state.worldStateArchonHunt);
  const archonHuntLoading = useAppStore((state) => state.worldStateArchonHuntLoading);
  const archonHuntError = useAppStore((state) => state.worldStateArchonHuntError);
  const archonHuntLastUpdatedAt = useAppStore((state) => state.worldStateArchonHuntLastUpdatedAt);
  const refreshWorldStateArchonHunt = useAppStore((state) => state.refreshWorldStateArchonHunt);

  const invasions = useAppStore((state) => state.worldStateInvasions);
  const invasionsLoading = useAppStore((state) => state.worldStateInvasionsLoading);
  const invasionsError = useAppStore((state) => state.worldStateInvasionsError);
  const invasionsLastUpdatedAt = useAppStore((state) => state.worldStateInvasionsLastUpdatedAt);
  const refreshWorldStateInvasions = useAppStore((state) => state.refreshWorldStateInvasions);

  const syndicateMissions = useAppStore((state) => state.worldStateSyndicateMissions);
  const syndicateMissionsLoading = useAppStore((state) => state.worldStateSyndicateMissionsLoading);
  const syndicateMissionsError = useAppStore((state) => state.worldStateSyndicateMissionsError);
  const syndicateMissionsLastUpdatedAt = useAppStore(
    (state) => state.worldStateSyndicateMissionsLastUpdatedAt,
  );
  const refreshWorldStateSyndicateMissions = useAppStore(
    (state) => state.refreshWorldStateSyndicateMissions,
  );

  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className="activities-grid">
      <SortieCard
        sortie={sortie}
        loading={sortieLoading}
        error={sortieError}
        lastUpdatedAt={sortieLastUpdatedAt}
        nowMs={nowMs}
        onRefresh={() => {
          void refreshWorldStateSortie();
        }}
      />
      <ArchonHuntCard
        archonHunt={archonHunt}
        loading={archonHuntLoading}
        error={archonHuntError}
        lastUpdatedAt={archonHuntLastUpdatedAt}
        nowMs={nowMs}
        onRefresh={() => {
          void refreshWorldStateArchonHunt();
        }}
      />
      <AlertsCard
        alerts={alerts}
        loading={alertsLoading}
        error={alertsError}
        lastUpdatedAt={alertsLastUpdatedAt}
        nowMs={nowMs}
        onRefresh={() => {
          void refreshWorldStateAlerts();
        }}
      />
      <ArbitrationCard
        arbitration={arbitration}
        loading={arbitrationLoading}
        error={arbitrationError}
        lastUpdatedAt={arbitrationLastUpdatedAt}
        nowMs={nowMs}
        onRefresh={() => {
          void refreshWorldStateArbitration();
        }}
      />
      <InvasionsCard
        invasions={invasions}
        loading={invasionsLoading}
        error={invasionsError}
        lastUpdatedAt={invasionsLastUpdatedAt}
        onRefresh={() => {
          void refreshWorldStateInvasions();
        }}
      />
      <SyndicateMissionsCard
        missions={syndicateMissions}
        loading={syndicateMissionsLoading}
        error={syndicateMissionsError}
        lastUpdatedAt={syndicateMissionsLastUpdatedAt}
        nowMs={nowMs}
        onRefresh={() => {
          void refreshWorldStateSyndicateMissions();
        }}
      />
    </div>
  );
}
