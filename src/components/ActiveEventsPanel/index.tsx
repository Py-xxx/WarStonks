import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
  formatWorldStateCountdown,
  formatWorldStateDateTime,
  getWorldStateEventProgressPercent,
} from '../../lib/worldState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Countdown, EventEmpty, EventError, EventPanel, EventRow, EventTag } from '../Events/parts';
import { useAppStore } from '../../stores/useAppStore';
import type { WfstatEventReward, WfstatWorldStateEvent } from '../../types';

function buildRewardLabel(reward: WfstatEventReward, creditsLabel: (n: number) => string): string {
  const itemParts = reward.items;
  const countedParts = reward.countedItems.map((entry) => `${entry.count}x ${entry.type}`);
  const creditPart = reward.credits && reward.credits > 0 ? [creditsLabel(reward.credits)] : [];

  return [...itemParts, ...countedParts, ...creditPart].join(', ');
}

function buildEventRewardPreview(event: WfstatWorldStateEvent, creditsLabel: (n: number) => string): string {
  const labels = event.rewards
    .map((reward) => buildRewardLabel(reward, creditsLabel))
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
  const { t } = useTranslation();
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

  const hasUsableEvents = events.length > 0;
  const creditsLabel = (n: number) => t('evt.creditsSuffix', { n });

  return (
    <EventPanel
      title={t('ws.activeEvents')}
      count={events.length}
      countTone={events.length > 0 ? 'positive' : 'muted'}
      updatedAt={
        lastUpdatedAt ? t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) }) : null
      }
      bodyClassName="flex flex-col gap-1 p-2"
    >
      {error ? (
        <EventError
          error={error}
          stale={hasUsableEvents}
          onRetry={() => void refreshWorldStateEvents()}
        />
      ) : null}

      {loading && events.length === 0 ? <Skeleton type="table-row@2" leafClassName="h-5" /> : null}

      {!loading && events.length === 0 && !error ? (
        <EventEmpty icon="ti-flame" title={t('a11y.noActiveEvents')} />
      ) : null}

      {events.map((event) => {
        const progressPercent = getWorldStateEventProgressPercent(event, nowMs);
        const rewardPreview = buildEventRewardPreview(event, creditsLabel);
        const expanded = expandedIds.includes(event.id);

        return (
          <div key={event.id} className="min-w-0">
            <Button
              variant="ghost"
              static
              aria-expanded={expanded}
              onClick={() => toggleExpanded(event.id)}
              className="h-auto w-full justify-start rounded-sm p-0 text-left hover:bg-transparent"
            >
              <EventRow
                className="w-full border-b-0"
                title={event.description}
                meta={event.tooltip || undefined}
                trailing={
                  <>
                    {event.isCommunity ? <EventTag tone="blue">{t('ov.community')}</EventTag> : null}
                    {progressPercent !== null ? (
                      <span className="font-mono text-[11px] font-semibold tabular-nums text-accent-green">
                        {Math.round(progressPercent)}%
                      </span>
                    ) : null}
                    <Countdown value={formatWorldStateCountdown(event.expiry, nowMs)} />
                    <i
                      className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'} text-sm text-ink-dim`}
                      aria-hidden="true"
                    />
                  </>
                }
              />
            </Button>

            {/* The progress bar plots a REAL value — `getWorldStateEventProgressPercent` — and is
                rendered only when there is one to plot. */}
            {progressPercent !== null ? (
              <span className="mx-2 mb-1 block h-1 overflow-hidden rounded-full bg-bg-base" aria-hidden="true">
                <span
                  className="block h-full rounded-full bg-accent-green"
                  style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                />
              </span>
            ) : null}

            {expanded ? (
              <div className="flex flex-col gap-1.5 border-t border-line-subtle px-2 py-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-ink-dim">
                  <span>
                    {t('ws.progress')} <span className="text-ink">{formatEventScore(event)}</span>
                  </span>
                  {event.node ? <span className="text-ink">{event.node}</span> : null}
                </div>
                {rewardPreview ? (
                  <p className="text-[11px] leading-relaxed text-ink-soft">{rewardPreview}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </EventPanel>
  );
}
