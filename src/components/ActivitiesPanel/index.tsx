import { useEffect, useMemo, useState } from 'react';
import {
  formatWorldStateCountdown,
  formatWorldStateDateTime,
  isWorldStateWindowActive,
} from '../../lib/worldState';
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

function buildRewardLabel(reward: WfstatEventReward | null): string {
  if (!reward) {
    return 'No reward data';
  }

  const itemParts = reward.items;
  const countedParts = reward.countedItems.map((entry) => `${entry.count}x ${entry.type}`);
  const creditParts =
    reward.credits && reward.credits > 0 ? [`${reward.credits.toLocaleString()} Credits`] : [];

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

function formatStandingTotal(stages: number[]): string | null {
  if (stages.length === 0) {
    return null;
  }

  const total = stages.reduce((sum, value) => sum + value, 0);
  return `${total.toLocaleString()} Standing`;
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

function buildInvasionRewardLabel(invasion: WfstatInvasion): string {
  const attackerReward = buildRewardLabel(invasion.attacker.reward);
  const defenderReward = buildRewardLabel(invasion.defender.reward);

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
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="empty-state activity-empty-state">
      <span className="empty-primary">{title}</span>
      <span className="empty-sub">{detail}</span>
    </div>
  );
}

function PanelError({
  error,
  loading,
  onRefresh,
}: {
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!error) {
    return null;
  }

  return (
    <div className="activity-inline-state">
      <span className="settings-inline-error">{error}</span>
      <button className="text-btn" type="button" onClick={onRefresh}>
        {loading ? 'Refreshing…' : 'Retry'}
      </button>
    </div>
  );
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
  const isActive =
    sortie &&
    !sortie.expired &&
    isWorldStateWindowActive(sortie.activation, sortie.expiry, nowMs);

  return (
    <section className="card activity-panel activity-panel-wide">
      <div className="card-header">
        <span className="card-label">Sorties</span>
        {sortie && isActive ? (
          <span className="badge badge-blue">{formatWorldStateCountdown(sortie.expiry, nowMs)}</span>
        ) : (
          <span className="badge badge-muted">Unavailable</span>
        )}
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            Last sync: {formatWorldStateDateTime(lastUpdatedAt)}
          </div>
        ) : null}
        <PanelError error={error} loading={loading} onRefresh={onRefresh} />

        {!sortie || !isActive ? (
          <PanelEmpty
            title="No active sortie"
            detail="The sortie panel will populate as soon as WFStat reports a live sortie."
          />
        ) : (
          <div className="activity-stack">
            <div className="activity-hero">
              <div>
                <div className="activity-title">{sortie.boss ?? 'Daily Sortie'}</div>
                <div className="activity-subtitle">
                  {sortie.faction ?? 'Unknown faction'} • {sortie.rewardPool ?? 'Reward pool unavailable'}
                </div>
              </div>
              <div className="activity-meta-grid">
                <PanelMeta label="Starts" value={formatWorldStateDateTime(sortie.activation)} />
                <PanelMeta label="Ends In" value={formatWorldStateCountdown(sortie.expiry, nowMs)} />
              </div>
            </div>

            <div className="activity-step-list">
              {sortie.variants.map((variant, index) => (
                <article key={`${sortie.id}-${index}`} className="activity-step-card">
                  <div className="activity-step-index">Mission {index + 1}</div>
                  <div className="activity-step-title">
                    {variant.missionType ?? 'Unknown mission'} • {variant.node ?? 'Unknown node'}
                  </div>
                  <div className="activity-step-detail">{variant.modifier ?? 'No modifier data'}</div>
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
  const isActive =
    archonHunt &&
    !archonHunt.expired &&
    isWorldStateWindowActive(archonHunt.activation, archonHunt.expiry, nowMs);

  return (
    <section className="card activity-panel activity-panel-wide">
      <div className="card-header">
        <span className="card-label">Archon Hunts</span>
        {archonHunt && isActive ? (
          <span className="badge badge-red">{formatWorldStateCountdown(archonHunt.expiry, nowMs)}</span>
        ) : (
          <span className="badge badge-muted">Unavailable</span>
        )}
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            Last sync: {formatWorldStateDateTime(lastUpdatedAt)}
          </div>
        ) : null}
        <PanelError error={error} loading={loading} onRefresh={onRefresh} />

        {!archonHunt || !isActive ? (
          <PanelEmpty
            title="No active archon hunt"
            detail="The weekly Archon Hunt will appear here when the feed reports an active window."
          />
        ) : (
          <div className="activity-stack">
            <div className="activity-hero">
              <div>
                <div className="activity-title">{archonHunt.boss ?? 'Archon Hunt'}</div>
                <div className="activity-subtitle">
                  {archonHunt.faction ?? 'Unknown faction'} • {archonHunt.rewardPool ?? 'Reward pool unavailable'}
                </div>
              </div>
              <div className="activity-meta-grid">
                <PanelMeta label="Starts" value={formatWorldStateDateTime(archonHunt.activation)} />
                <PanelMeta label="Ends In" value={formatWorldStateCountdown(archonHunt.expiry, nowMs)} />
              </div>
            </div>

            <div className="activity-step-list">
              {archonHunt.missions.map((mission, index) => (
                <article key={`${archonHunt.id}-${index}`} className="activity-step-card">
                  <div className="activity-step-index">Stage {index + 1}</div>
                  <div className="activity-step-title">
                    {mission.type ?? 'Unknown mission'} • {mission.node ?? 'Unknown node'}
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
  const activeAlerts = alerts.filter((alert) => !alert.expired && Date.parse(alert.expiry ?? '') > nowMs);

  return (
    <section className="card activity-panel">
      <div className="card-header">
        <span className="card-label">Alerts</span>
        <span className={`badge ${activeAlerts.length > 0 ? 'badge-green' : 'badge-muted'}`}>
          {activeAlerts.length} active
        </span>
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            Last sync: {formatWorldStateDateTime(lastUpdatedAt)}
          </div>
        ) : null}
        <PanelError error={error} loading={loading} onRefresh={onRefresh} />

        {activeAlerts.length === 0 ? (
          <PanelEmpty
            title="No active alerts"
            detail="WFStat is not reporting any live alert missions right now."
          />
        ) : (
          <div className="activity-list">
            {activeAlerts.map((alert) => (
              <article key={alert.id} className="activity-list-card">
                <div className="activity-list-top">
                  <div>
                    <div className="activity-list-title">
                      {alert.mission?.description ?? 'Alert Mission'}
                    </div>
                    <div className="activity-list-subtitle">
                      {alert.mission?.type ?? 'Unknown mission'} • {alert.mission?.node ?? 'Unknown node'}
                    </div>
                  </div>
                  <span className="badge badge-green">
                    {formatWorldStateCountdown(alert.expiry, nowMs)}
                  </span>
                </div>
                <div className="activity-list-copy">{buildRewardLabel(alert.mission?.reward ?? null)}</div>
                <div className="activity-chip-row">
                  {alert.mission?.faction ? <span className="activity-chip">{alert.mission.faction}</span> : null}
                  {buildLevelLabel(alert.mission?.minEnemyLevel ?? null, alert.mission?.maxEnemyLevel ?? null) ? (
                    <span className="activity-chip">
                      Lv {buildLevelLabel(alert.mission?.minEnemyLevel ?? null, alert.mission?.maxEnemyLevel ?? null)}
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
  const isActive =
    arbitration &&
    !arbitration.expired &&
    isWorldStateWindowActive(arbitration.activation, arbitration.expiry, nowMs);

  return (
    <section className="card activity-panel">
      <div className="card-header">
        <span className="card-label">Arbitrations</span>
        {isActive ? (
          <span className="badge badge-amber">{formatWorldStateCountdown(arbitration?.expiry ?? null, nowMs)}</span>
        ) : (
          <span className="badge badge-muted">Unavailable</span>
        )}
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            Last sync: {formatWorldStateDateTime(lastUpdatedAt)}
          </div>
        ) : null}
        <PanelError error={error} loading={loading} onRefresh={onRefresh} />

        {!arbitration || !isActive ? (
          <PanelEmpty
            title="No active arbitration"
            detail="When an arbitration is live, its node, faction, and countdown will show here."
          />
        ) : (
          <div className="activity-stack">
            <div className="activity-title">{arbitration.type ?? 'Unknown mission'}</div>
            <div className="activity-subtitle">{arbitration.node ?? 'Unknown node'}</div>
            <div className="activity-meta-grid activity-meta-grid-single">
              <PanelMeta label="Faction" value={arbitration.enemy ?? 'Unknown'} />
              <PanelMeta label="Ends In" value={formatWorldStateCountdown(arbitration.expiry, nowMs)} />
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
  const activeInvasions = invasions.filter((invasion) => !invasion.completed);

  return (
    <section className="card activity-panel activity-panel-tall">
      <div className="card-header">
        <span className="card-label">Invasions</span>
        <span className={`badge ${activeInvasions.length > 0 ? 'badge-blue' : 'badge-muted'}`}>
          {activeInvasions.length} active
        </span>
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            Last sync: {formatWorldStateDateTime(lastUpdatedAt)}
          </div>
        ) : null}
        <PanelError error={error} loading={loading} onRefresh={onRefresh} />

        {activeInvasions.length === 0 ? (
          <PanelEmpty
            title="No active invasions"
            detail="New invasions will appear here automatically when the worldstate changes."
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
                        {invasion.desc ?? 'Invasion'} • {invasion.node ?? 'Unknown node'}
                      </div>
                      <div className="activity-list-subtitle">
                        {invasion.attacker.faction ?? 'Unknown'} vs {invasion.defender.faction ?? 'Unknown'}
                      </div>
                    </div>
                    <span className="badge badge-purple">{completion.toFixed(1)}%</span>
                  </div>
                  <div className="activity-list-copy">{buildInvasionRewardLabel(invasion)}</div>
                  <div className="activity-progress">
                    <div className="activity-progress-fill" style={{ width: `${completion}%` }} />
                  </div>
                  <div className="activity-chip-row">
                    {invasion.requiredRuns ? <span className="activity-chip">{invasion.requiredRuns.toLocaleString()} runs</span> : null}
                    {invasion.vsInfestation ? <span className="activity-chip">Infested</span> : null}
                    <span className="activity-chip">
                      Started {formatWorldStateDateTime(invasion.activation)}
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
  const activeMissions = missions.filter(
    (mission) => !mission.expired && Date.parse(mission.expiry ?? '') > nowMs,
  );
  const [selectedSyndicate, setSelectedSyndicate] = useState<string | null>(null);

  const syndicateTabs = useMemo(
    () =>
      activeMissions
        .map((mission) => mission.syndicate ?? 'Unknown Syndicate')
        .filter((value, index, list) => list.indexOf(value) === index),
    [activeMissions],
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
    (mission) => (mission.syndicate ?? 'Unknown Syndicate') === selectedSyndicate,
  );

  return (
    <section className="card activity-panel activity-panel-full">
      <div className="card-header">
        <span className="card-label">Syndicate Missions</span>
        <span className={`badge ${activeMissions.length > 0 ? 'badge-green' : 'badge-muted'}`}>
          {activeMissions.length} syndicates
        </span>
        <div className="card-actions">
          <button className="text-btn" type="button" onClick={onRefresh}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            Last sync: {formatWorldStateDateTime(lastUpdatedAt)}
          </div>
        ) : null}
        <PanelError error={error} loading={loading} onRefresh={onRefresh} />

        {activeMissions.length === 0 ? (
          <PanelEmpty
            title="No active syndicate missions"
            detail="Open-world and syndicate job rotations will appear here when active."
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
                      {visibleMission.syndicate ?? 'Unknown Syndicate'}
                    </div>
                    <div className="activity-subtitle">
                      {visibleMission.nodes.join(' • ') || 'Open world rotation'}
                    </div>
                  </div>
                  <div className="activity-meta-grid">
                    <PanelMeta label="Rotation Ends" value={formatWorldStateCountdown(visibleMission.expiry, nowMs)} />
                    <PanelMeta label="Updated" value={formatWorldStateDateTime(lastUpdatedAt)} />
                  </div>
                </div>

                <div className="activities-syndicate-grid">
                  {visibleMission.jobs.map((job) => {
                    const standingTotal = formatStandingTotal(job.standingStages);

                    return (
                      <article key={job.id} className="activity-job-card">
                        <div className="activity-list-top">
                          <div>
                            <div className="activity-list-title">{job.type ?? 'Unknown job'}</div>
                            <div className="activity-list-subtitle">
                              {job.enemyLevels.length > 0
                                ? `Lv ${job.enemyLevels.join('-')}`
                                : 'Enemy levels unavailable'}
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
                            <span className="activity-chip">{job.rewardPoolDrops.length} drops</span>
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
