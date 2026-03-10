import { useEffect, useState } from 'react';
import {
  formatWorldStateCountdown,
  formatWorldStateDateTime,
  getWorldStateEventProgressPercent,
} from '../../lib/worldState';
import { useAppStore } from '../../stores/useAppStore';
import type { WfstatEventReward, WfstatWorldStateEvent } from '../../types';

function buildRewardLabel(reward: WfstatEventReward): string {
  const itemParts = reward.items;
  const countedParts = reward.countedItems.map((entry) => `${entry.count}x ${entry.type}`);
  const creditPart = reward.credits && reward.credits > 0 ? [`${reward.credits} Credits`] : [];

  return [...itemParts, ...countedParts, ...creditPart].join(', ');
}

function buildEventRewardPreview(event: WfstatWorldStateEvent): string {
  const labels = event.rewards
    .map((reward) => buildRewardLabel(reward))
    .filter((label) => label.length > 0);

  return labels.join(' • ');
}

function formatEventScore(event: WfstatWorldStateEvent): string {
  if (event.currentScore !== null && event.maximumScore !== null) {
    return `${event.currentScore}/${event.maximumScore}`;
  }

  if (event.health !== null) {
    return `${event.health}%`;
  }

  return '—';
}

export function ActiveEventsPanel() {
  const events = useAppStore((state) => state.worldStateEvents);
  const loading = useAppStore((state) => state.worldStateEventsLoading);
  const error = useAppStore((state) => state.worldStateEventsError);
  const lastUpdatedAt = useAppStore((state) => state.worldStateEventsLastUpdatedAt);
  const refreshWorldStateEvents = useAppStore((state) => state.refreshWorldStateEvents);

  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const toggleExpanded = (eventId: string) => {
    setExpandedIds((current) =>
      current.includes(eventId)
        ? current.filter((id) => id !== eventId)
        : [...current, eventId],
    );
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Active Events</span>
        <span className={`badge ${events.length > 0 ? 'badge-purple' : 'badge-muted'}`}>
          {events.length} active
        </span>
        <div className="card-actions">
          <button
            className="text-btn"
            type="button"
            onClick={() => {
              void refreshWorldStateEvents();
            }}
          >
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

        {error ? <div className="settings-inline-error">{error}</div> : null}

        {loading && events.length === 0 ? (
          <div className="empty-state">
            <span className="empty-primary">Loading live worldstate events…</span>
            <span className="empty-sub">
              Fetching `GET /pc/events?language=en` from WarframeStat.
            </span>
          </div>
        ) : null}

        {!loading && events.length === 0 ? (
          <div className="empty-state">
            <span className="empty-primary">No active events right now</span>
            <span className="empty-sub">
              Active event data will appear here as soon as WFStat reports live events.
            </span>
          </div>
        ) : null}

        {events.length > 0 ? (
          <div className="world-event-list">
            {events.map((event) => {
              const progressPercent = getWorldStateEventProgressPercent(event, nowMs);
              const rewardPreview = buildEventRewardPreview(event);
              const expanded = expandedIds.includes(event.id);

              return (
                <article key={event.id} className="world-event-card">
                  <button
                    className="world-event-toggle"
                    type="button"
                    onClick={() => toggleExpanded(event.id)}
                  >
                    <div className="world-event-topline">
                      <div className="world-event-main">
                        <div className="world-event-name">{event.description}</div>
                        {event.tooltip ? (
                          <div className="world-event-tooltip">{event.tooltip}</div>
                        ) : null}
                      </div>

                      <div className="world-event-badges">
                        <span className="badge badge-green">
                          {formatWorldStateCountdown(event.expiry, nowMs)}
                        </span>
                        {event.isCommunity ? (
                          <span className="badge badge-blue">Community</span>
                        ) : null}
                        {event.isPersonal ? (
                          <span className="badge badge-purple">Personal</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="world-event-meta-grid">
                      <div className="world-event-meta-item">
                        <span className="world-event-meta-label">Node</span>
                        <span className="world-event-meta-value">
                          {event.node ?? 'Unknown'}
                        </span>
                      </div>
                      <div className="world-event-meta-item">
                        <span className="world-event-meta-label">Activation</span>
                        <span className="world-event-meta-value">
                          {formatWorldStateDateTime(event.activation)}
                        </span>
                      </div>
                      <div className="world-event-meta-item">
                        <span className="world-event-meta-label">Expiry</span>
                        <span className="world-event-meta-value">
                          {formatWorldStateDateTime(event.expiry)}
                        </span>
                      </div>
                      <div className="world-event-meta-item">
                        <span className="world-event-meta-label">Progress</span>
                        <span className="world-event-meta-value">
                          {formatEventScore(event)}
                        </span>
                      </div>
                    </div>

                    {progressPercent !== null ? (
                      <div className="world-event-progress">
                        <div
                          className="world-event-progress-fill"
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    ) : null}

                    {rewardPreview ? (
                      <div className="world-event-reward-preview">{rewardPreview}</div>
                    ) : null}

                    <div className="world-event-expand-copy">
                      {expanded ? 'Hide rewards and step details' : 'Show rewards and step details'}
                    </div>
                  </button>

                  {expanded ? (
                    <div className="world-event-expanded">
                      {event.rewards.length > 0 ? (
                        <div className="world-event-expanded-block">
                          <span className="card-label">Rewards</span>
                          <div className="world-event-tag-list">
                            {event.rewards.map((reward, index) => (
                              <span key={`${event.id}-reward-${index}`} className="world-event-tag">
                                {buildRewardLabel(reward)}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {event.interimSteps.length > 0 ? (
                        <div className="world-event-expanded-block">
                          <span className="card-label">Interim Steps</span>
                          <div className="world-event-step-list">
                            {event.interimSteps.map((step, index) => (
                              <div key={`${event.id}-step-${index}`} className="world-event-step">
                                <span className="world-event-step-goal">
                                  Goal {step.goal ?? '—'}
                                </span>
                                <span className="world-event-step-reward">
                                  {step.reward ? buildRewardLabel(step.reward) : 'No reward data'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {event.concurrentNodes.length > 0 ? (
                        <div className="world-event-expanded-block">
                          <span className="card-label">Concurrent Nodes</span>
                          <div className="world-event-tag-list">
                            {event.concurrentNodes.map((node) => (
                              <span key={`${event.id}-${node}`} className="world-event-tag">
                                {node}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
