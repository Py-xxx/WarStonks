import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
  formatWorldStateCountdown,
  formatWorldStateDateTime,
  isWorldStateWindowActive,
} from '../../lib/worldState';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Countdown,
  EventEmpty,
  EventError,
  EventPanel,
  EventRow,
  EventTag,
} from '../Events/parts';
import { useAppStore } from '../../stores/useAppStore';
import { normalizeRewardName } from '../../lib/worldStatePricing';
import type {
  WfstatEventReward,
  WfstatInvasion,
} from '../../types';

export function buildRewardLabel(
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

export function buildLevelLabel(minLevel: number | null, maxLevel: number | null): string | null {
  if (minLevel === null && maxLevel === null) {
    return null;
  }

  if (minLevel !== null && maxLevel !== null) {
    return `${minLevel}-${maxLevel}`;
  }

  return `${minLevel ?? maxLevel}`;
}

/**
 * The same parts `buildRewardLabel` joins into a string, kept separate so each item can carry its
 * own price. Credits are dropped here — they are not an item and have no platinum value.
 */
function rewardItemParts(
  reward: WfstatEventReward | null,
): Array<{ name: string; label: string }> {
  if (!reward) {
    return [];
  }
  return [
    ...reward.items.map((item) => ({ name: item, label: item })),
    ...reward.countedItems.map((entry) => ({
      name: entry.type,
      label: `${entry.count}x ${entry.type}`,
    })),
  ];
}

/**
 * One side of an invasion, with a platinum price beside anything the catalog could resolve.
 *
 * Most invasion rewards are not tradeable, so an unpriced item simply shows its name — a `—` on
 * every second reward would be noise about something that was never going to have a price.
 */
function RewardSide({
  reward,
  prices,
  labels,
}: {
  reward: WfstatEventReward | null;
  prices: Record<string, number | null>;
  labels: { noRewardData: string; creditsSuffix: (n: string) => string };
}) {
  const parts = rewardItemParts(reward);
  if (parts.length === 0) {
    return <>{buildRewardLabel(reward, labels)}</>;
  }

  return (
    <>
      {parts.map((part, index) => {
        const price = prices[part.name] ?? prices[normalizeRewardName(part.name)] ?? null;
        return (
          <span key={`${part.name}-${index}`}>
            {index > 0 ? ', ' : ''}
            {part.label}
            {price !== null && price > 0 ? (
              <span className="ml-1 font-mono text-[11px] text-accent-green tabular-nums">
                {price}p
              </span>
            ) : null}
          </span>
        );
      })}
    </>
  );
}

/**
 * A multi-stage activity — a sortie's three variants, an archon hunt's three missions. They are
 * the same object: a boss, a faction, a countdown, and an ordered list of missions with modifiers.
 * They had two near-identical 90-line card implementations.
 */
function StagedActivityCard({
  title,
  headline,
  subline,
  expiry,
  active,
  loading,
  error,
  lastUpdatedAt,
  stages,
  nowMs,
  emptyTitle,
  onRefresh,
  hasData,
}: {
  title: string;
  headline: string;
  subline: string;
  expiry: string | null;
  active: boolean;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  stages: Array<{ label: string; title: string; detail?: string | null; tags?: React.ReactNode }>;
  nowMs: number;
  emptyTitle: string;
  onRefresh: () => void;
  hasData: boolean;
}) {
  const { t } = useTranslation();
  return (
    <EventPanel
      title={title}
      updatedAt={
        lastUpdatedAt ? t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) }) : null
      }
      aside={
        active && expiry ? (
          <Countdown value={formatWorldStateCountdown(expiry, nowMs)} />
        ) : null
      }
      bodyClassName="flex flex-col gap-1 p-2"
    >
      {error ? <EventError error={error} stale={hasData} onRetry={onRefresh} /> : null}
      {loading && !hasData ? <Skeleton type="table-row@3" leafClassName="h-5" /> : null}

      {!active ? (
        !error ? <EventEmpty icon="ti-clock" title={emptyTitle} /> : null
      ) : (
        <>
          <div className="flex min-w-0 items-baseline gap-2 px-1 pb-1">
            <span className="truncate text-xs font-semibold text-ink">{headline}</span>
            <span className="truncate text-[10px] text-ink-dim">{subline}</span>
          </div>
          {stages.map((stage, index) => (
            <EventRow
              key={index}
              lead={
                <span className="w-4 shrink-0 text-center font-mono text-[10px] tabular-nums text-ink-faint">
                  {index + 1}
                </span>
              }
              title={stage.title}
              meta={stage.detail || undefined}
              trailing={stage.tags}
            />
          ))}
        </>
      )}
    </EventPanel>
  );
}

function InvasionsCard({
  invasions,
  invasionRewardPrices,
  loading,
  error,
  lastUpdatedAt,
  onRefresh,
}: {
  invasions: WfstatInvasion[];
  invasionRewardPrices: Record<string, number | null>;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const activeInvasions = invasions.filter((invasion) => !invasion.completed);
  const hasUsableInvasions = invasions.length > 0;
  const rewardLabels = {
    noRewardData: t('evt.noRewardData'),
    creditsSuffix: (n: string) => t('evt.creditsSuffix', { n }),
  };

  return (
    <EventPanel
      title={t('ws.invasions')}
      count={activeInvasions.length}
      countTone={activeInvasions.length > 0 ? 'info' : 'muted'}
      updatedAt={
        lastUpdatedAt ? t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) }) : null
      }
      bodyClassName="flex flex-col gap-1 p-2"
    >
      {error ? <EventError error={error} stale={hasUsableInvasions} onRetry={onRefresh} /> : null}
      {loading && !hasUsableInvasions ? <Skeleton type="table-row@3" leafClassName="h-5" /> : null}

      {!loading && activeInvasions.length === 0 && !error ? (
        <EventEmpty icon="ti-swords" title={t('evt.noActiveInvasions')} />
      ) : null}

      {activeInvasions.map((invasion) => {
        const completion = Math.max(0, Math.min(100, invasion.completion ?? 0));
        return (
          <div key={invasion.id} className="min-w-0">
            <EventRow
              className="border-b-0 pb-0.5"
              title={
                <span className="truncate">
                  {/* Order is the shipped one — attacker first, and against infestation only the
                      defender side pays out at all. */}
                  {invasion.vsInfestation ? null : (
                    <>
                      <RewardSide
                        reward={invasion.attacker.reward}
                        prices={invasionRewardPrices}
                        labels={rewardLabels}
                      />
                      <span className="mx-1 text-ink-faint">vs</span>
                    </>
                  )}
                  <RewardSide
                    reward={invasion.defender.reward}
                    prices={invasionRewardPrices}
                    labels={rewardLabels}
                  />
                </span>
              }
              meta={`${invasion.node ?? t('mkt.unknownNode')} · ${invasion.attacker.faction ?? t('evt.unknown')} vs ${invasion.defender.faction ?? t('evt.unknown')}`}
              trailing={
                <span className="font-mono text-[11px] tabular-nums text-ink-soft">
                  {Math.round(completion)}%
                </span>
              }
            />
            {/* Real completion, from the payload — the bar plots a value, never a tone. */}
            <span
              className="mx-2 mb-1.5 block h-1 overflow-hidden rounded-full bg-bg-base"
              aria-hidden="true"
            >
              <span
                className="block h-full rounded-full bg-accent-blue"
                style={{ width: `${completion}%` }}
              />
            </span>
          </div>
        );
      })}
    </EventPanel>
  );
}

export function ActivitiesPanel() {
  const { t } = useTranslation();

  const sortie = useAppStore((state) => state.worldStateSortie);
  const sortieLoading = useAppStore((state) => state.worldStateSortieLoading);
  const sortieError = useAppStore((state) => state.worldStateSortieError);
  const sortieLastUpdatedAt = useAppStore((state) => state.worldStateSortieLastUpdatedAt);
  const refreshWorldStateSortie = useAppStore((state) => state.refreshWorldStateSortie);

  const archonHunt = useAppStore((state) => state.worldStateArchonHunt);
  const archonHuntLoading = useAppStore((state) => state.worldStateArchonHuntLoading);
  const archonHuntError = useAppStore((state) => state.worldStateArchonHuntError);
  const archonHuntLastUpdatedAt = useAppStore((state) => state.worldStateArchonHuntLastUpdatedAt);
  const refreshWorldStateArchonHunt = useAppStore((state) => state.refreshWorldStateArchonHunt);

  const invasions = useAppStore((state) => state.worldStateInvasions);
  const invasionRewardPrices = useAppStore((state) => state.invasionRewardPrices);
  const invasionsLoading = useAppStore((state) => state.worldStateInvasionsLoading);
  const invasionsError = useAppStore((state) => state.worldStateInvasionsError);
  const invasionsLastUpdatedAt = useAppStore((state) => state.worldStateInvasionsLastUpdatedAt);
  const refreshWorldStateInvasions = useAppStore((state) => state.refreshWorldStateInvasions);

  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const sortieActive = Boolean(
    sortie && !sortie.expired && isWorldStateWindowActive(sortie.activation, sortie.expiry, nowMs),
  );
  const archonActive = Boolean(
    archonHunt &&
      !archonHunt.expired &&
      isWorldStateWindowActive(archonHunt.activation, archonHunt.expiry, nowMs),
  );

  return (
    /* Two flex columns, not a grid: these panels differ in height and a grid row is as tall as
       its tallest cell (`ELEMENTS.md` §6). */
    <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <StagedActivityCard
          title={t('ws.sorties')}
          headline={sortie?.boss ?? t('evt.dailySortie')}
          subline={[sortie?.faction, sortie?.rewardPool].filter(Boolean).join(' · ')}
          expiry={sortie?.expiry ?? null}
          active={sortieActive}
          loading={sortieLoading}
          error={sortieError}
          lastUpdatedAt={sortieLastUpdatedAt}
          hasData={Boolean(sortie)}
          emptyTitle={t('evt.noActiveSortie')}
          nowMs={nowMs}
          onRefresh={() => void refreshWorldStateSortie()}
          stages={(sortie?.variants ?? []).map((variant) => ({
            label: '',
            title: `${variant.missionType ?? t('evt.unknownMission')} · ${variant.node ?? t('mkt.unknownNode')}`,
            detail: variant.modifier ?? t('evt.noModifierData'),
          }))}
        />
        <StagedActivityCard
          title={t('ws.archonHunts')}
          headline={archonHunt?.boss ?? t('evt.archonHuntLabel')}
          subline={[archonHunt?.faction, archonHunt?.rewardPool].filter(Boolean).join(' · ')}
          expiry={archonHunt?.expiry ?? null}
          active={archonActive}
          loading={archonHuntLoading}
          error={archonHuntError}
          lastUpdatedAt={archonHuntLastUpdatedAt}
          hasData={Boolean(archonHunt)}
          emptyTitle={t('evt.noActiveArchonHunt')}
          nowMs={nowMs}
          onRefresh={() => void refreshWorldStateArchonHunt()}
          stages={(archonHunt?.missions ?? []).map((mission) => ({
            label: '',
            title: `${mission.type ?? t('evt.unknownMission')} · ${mission.node ?? t('mkt.unknownNode')}`,
            tags: (
              <>
                {mission.archwingRequired ? <EventTag tone="purple">Archwing</EventTag> : null}
                {mission.isSharkwing ? <EventTag tone="blue">Sharkwing</EventTag> : null}
                {mission.nightmare ? <EventTag tone="red">Nightmare</EventTag> : null}
              </>
            ),
          }))}
        />
      </div>

      <InvasionsCard
        invasions={invasions}
        invasionRewardPrices={invasionRewardPrices}
        loading={invasionsLoading}
        error={invasionsError}
        lastUpdatedAt={invasionsLastUpdatedAt}
        onRefresh={() => void refreshWorldStateInvasions()}
      />
    </div>
  );
}
