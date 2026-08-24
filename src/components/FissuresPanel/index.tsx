import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import { formatWorldStateCountdown, formatWorldStateDateTime } from '../../lib/worldState';
import { getRelicTierIcons } from '../../lib/tauriClient';
import { resolveRelicAssetUrl, resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Countdown, EventEmpty, EventError, EventPanel, EventRow } from '../Events/parts';
import type { RelicTierIcon, WfstatFissure } from '../../types';

type FissureMode = 'normal' | 'steel-path';

const EXCLUDED_FISSURE_MISSION_TYPES = new Set(['skirmish', 'volatile']);

function normalizeMissionTypeKey(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? null;
  return normalized && normalized.length > 0 ? normalized : null;
}

function getFissureTierLabel(fissure: WfstatFissure, unknownLabel: string): string {
  return fissure.tier?.trim() || unknownLabel;
}

function compareFissures(left: WfstatFissure, right: WfstatFissure, unknownLabel: string): number {
  return (left.tierNum ?? Number.MAX_SAFE_INTEGER) - (right.tierNum ?? Number.MAX_SAFE_INTEGER)
    || getFissureTierLabel(left, unknownLabel).localeCompare(getFissureTierLabel(right, unknownLabel))
    || (left.node ?? '').localeCompare(right.node ?? '')
    || (left.missionType ?? '').localeCompare(right.missionType ?? '');
}

function groupFissuresByTier(fissures: WfstatFissure[], unknownLabel: string) {
  const grouped = new Map<string, WfstatFissure[]>();

  for (const fissure of [...fissures].sort((a, b) => compareFissures(a, b, unknownLabel))) {
    const tier = getFissureTierLabel(fissure, unknownLabel);
    const bucket = grouped.get(tier) ?? [];
    bucket.push(fissure);
    grouped.set(tier, bucket);
  }

  return [...grouped.entries()].map(([tier, entries]) => ({
    tier,
    tierNum: entries[0]?.tierNum ?? Number.MAX_SAFE_INTEGER,
    fissures: entries,
  }))
  .sort((left, right) => left.tierNum - right.tierNum || left.tier.localeCompare(right.tier));
}

function isActiveFissure(fissure: WfstatFissure, nowMs: number): boolean {
  if (fissure.expired) {
    return false;
  }

  if (!fissure.expiry) {
    return true;
  }

  const expiryMs = Date.parse(fissure.expiry);
  return !Number.isFinite(expiryMs) || expiryMs > nowMs;
}

function isSupportedFissureMissionType(fissure: WfstatFissure): boolean {
  const missionTypeKey = normalizeMissionTypeKey(fissure.missionTypeKey);
  const missionType = normalizeMissionTypeKey(fissure.missionType);

  return !(
    (missionTypeKey && EXCLUDED_FISSURE_MISSION_TYPES.has(missionTypeKey)) ||
    (missionType && EXCLUDED_FISSURE_MISSION_TYPES.has(missionType))
  );
}

function NormalModeIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="10" cy="10" r="2.25" fill="currentColor" />
    </svg>
  );
}

function SteelPathModeIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2.2 15.8 4.6v4.6c0 3.8-2.2 6.4-5.8 8.6-3.6-2.2-5.8-4.8-5.8-8.6V4.6L10 2.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M10 6.1 11 8.5l2.5.2-1.9 1.6.6 2.4L10 11.3 7.8 12.7l.6-2.4-1.9-1.6 2.5-.2L10 6.1Z" fill="currentColor" />
    </svg>
  );
}

function FissureTierIcon({ tier, imagePath }: { tier: string; imagePath: string | null }) {
  const imageUrl = resolveRelicAssetUrl({ tier }) ?? resolveWfmAssetUrl(imagePath);

  return (
    /* No thumbnail chrome — relic art is a shaped icon on transparency, so a box around it reads
       as a chip drawn over a picture (`ELEMENTS.md` §7). */
    <span className="grid size-4 shrink-0 place-items-center font-mono text-[9px] text-ink-faint" aria-hidden="true">
      {imageUrl ? (
        <img src={imageUrl} alt="" loading="lazy" className="size-full object-contain" />
      ) : (
        tier.slice(0, 1)
      )}
    </span>
  );
}

/**
 * `grid` fills the width with one column per relic era — the Fissures tab.
 * `rail` is a single narrow column for the overview's side pane, where the eras stack.
 */
export function FissuresPanel({ layout = 'grid' }: { layout?: 'grid' | 'rail' } = {}) {
  const { t } = useTranslation();
  const fissures = useAppStore((state) => state.worldStateFissures);
  const loading = useAppStore((state) => state.worldStateFissuresLoading);
  const error = useAppStore((state) => state.worldStateFissuresError);
  const lastUpdatedAt = useAppStore((state) => state.worldStateFissuresLastUpdatedAt);
  const refreshWorldStateFissures = useAppStore((state) => state.refreshWorldStateFissures);

  const [mode, setMode] = useState<FissureMode>('normal');
  const [nowMs, setNowMs] = useState(Date.now());
  const [tierIcons, setTierIcons] = useState<RelicTierIcon[]>([]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    let isMounted = true;

    void getRelicTierIcons()
      .then((icons) => {
        if (isMounted) {
          setTierIcons(icons);
        }
      })
      .catch((loadError) => {
        console.error('[fissures] failed to load relic tier icons', loadError);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const filteredFissures = useMemo(
    () =>
      fissures.filter(
        (fissure) =>
          fissure.isHard === (mode === 'steel-path') &&
          isActiveFissure(fissure, nowMs) &&
          isSupportedFissureMissionType(fissure),
      ),
    [fissures, mode, nowMs],
  );
  const groupedFissures = useMemo(
    () => groupFissuresByTier(filteredFissures, t('evt.unknown')),
    [filteredFissures, t],
  );
  const tierIconMap = useMemo(
    () =>
      new Map(
        tierIcons.map((icon) => [icon.tier.trim().toLowerCase(), icon.imagePath]),
      ),
    [tierIcons],
  );
  const fallbackTierIcon = tierIcons[0]?.imagePath ?? null;
  const hasUsableFissures = fissures.length > 0;

  return (
    <EventPanel
      title={t('ws.fissures')}
      count={filteredFissures.length}
      countTone={filteredFissures.length > 0 ? 'info' : 'muted'}
      updatedAt={
        lastUpdatedAt ? t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) }) : null
      }
      aside={
        /* Two unlabelled icons gave no way to tell which mode you were reading. The selected one
           now carries its name; the other stays an icon, so the pair never shifts more than the
           label's width. */
        <span className="flex items-center gap-0.5 rounded-md bg-bg-base p-0.5" role="tablist" aria-label={t('a11y.fissureMode')}>
          {(
            [
              ['normal', NormalModeIcon, t('evt.fissuresNormal')],
              ['steel-path', SteelPathModeIcon, t('evt.fissuresSteelPath')],
            ] as const
          ).map(([id, Icon, label]) => {
            const active = mode === id;
            return (
              <Button
                key={id}
                variant="ghost"
                size="sm"
                static
                role="tab"
                aria-selected={active}
                aria-label={label}
                title={label}
                onClick={() => setMode(id)}
                className={`h-6 gap-1.5 rounded-sm px-1.5 font-mono text-[9px] font-semibold tracking-[0.06em] uppercase [&_svg]:size-3.5 ${
                  active ? 'bg-bg-elevated text-ink' : 'text-ink-dim hover:text-ink'
                }`}
              >
                <Icon />
                {active ? label : null}
              </Button>
            );
          })}
        </span>
      }
      bodyClassName="flex flex-col gap-2 p-2"
    >
      {error ? (
        <EventError
          error={error}
          stale={hasUsableFissures}
          onRetry={() => void refreshWorldStateFissures()}
        />
      ) : null}

      {loading && fissures.length === 0 ? (
        <Skeleton type="table-row@4" leafClassName="h-5" />
      ) : null}

      {!loading && groupedFissures.length === 0 ? (
        <EventEmpty
          icon="ti-diamond"
          title={
            mode === 'steel-path'
              ? t('evt.noFissuresActiveSteel')
              : t('evt.noFissuresActiveNormal')
          }
          detail={t('evt.switchModesHint')}
        />
      ) : null}

      {/* Each era gets its own recessed ground rather than a border. Wrapping columns make
          `divide-x` lie — in a 3-wide grid it draws a left border on the item that STARTS the
          second row — and the eras were previously separated by nothing but a gap, so Axi's five
          rows ran straight into Lith's two. A change of surface reads as a group at any wrap
          point. `Panel p-1` + well `rounded-sm` is the registered concentric pairing
          (`ELEMENTS.md` §2). */}
      {groupedFissures.length > 0 ? (
        <div
          className={
            layout === 'rail'
              ? 'flex flex-col gap-1.5'
              : 'grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]'
          }
        >
          {groupedFissures.map((group) => (
            <section
              key={group.tier}
              className="flex min-w-0 flex-col gap-0.5 rounded-sm bg-bg-base p-1.5"
            >
              <div className="flex items-center gap-1.5 px-1 pb-1">
                <FissureTierIcon
                  tier={group.tier}
                  imagePath={tierIconMap.get(group.tier.trim().toLowerCase()) ?? fallbackTierIcon}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold tracking-[0.08em] text-ink uppercase">
                  {group.tier}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-ink-dim">
                  {group.fissures.length}
                </span>
              </div>

              {/* The MISSION TYPE is the headline: you choose a fissure by what the mission IS.
                  The node and faction are the detail you read after. */}
              {group.fissures.map((fissure) => (
                <EventRow
                  key={fissure.id}
                  className="gap-2 rounded-sm border-b-0 bg-bg-panel px-1.5 py-1"
                  title={fissure.missionType ?? t('evt.unknownMission')}
                  meta={`${fissure.node ?? t('mkt.unknownNode')} · ${fissure.enemy ?? t('evt.unknownFaction')}`}
                  trailing={<Countdown value={formatWorldStateCountdown(fissure.expiry, nowMs)} />}
                />
              ))}
            </section>
          ))}
        </div>
      ) : null}
    </EventPanel>
  );
}
