import { useEffect, useMemo, useState } from 'react';
import { formatWorldStateCountdown, formatWorldStateDateTime } from '../../lib/worldState';
import { getRelicTierIcons } from '../../lib/tauriClient';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { RelicTierIcon, WfstatFissure } from '../../types';

type FissureMode = 'normal' | 'steel-path';

const FISSURE_MODE_LABELS: Record<FissureMode, string> = {
  normal: 'Normal fissures',
  'steel-path': 'Steel Path fissures',
};

const EXCLUDED_FISSURE_MISSION_TYPES = new Set(['skirmish', 'volatile']);

function normalizeMissionTypeKey(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? null;
  return normalized && normalized.length > 0 ? normalized : null;
}

function getFissureTierLabel(fissure: WfstatFissure): string {
  return fissure.tier?.trim() || 'Unknown';
}

function compareFissures(left: WfstatFissure, right: WfstatFissure): number {
  return (left.tierNum ?? Number.MAX_SAFE_INTEGER) - (right.tierNum ?? Number.MAX_SAFE_INTEGER)
    || getFissureTierLabel(left).localeCompare(getFissureTierLabel(right))
    || (left.node ?? '').localeCompare(right.node ?? '')
    || (left.missionType ?? '').localeCompare(right.missionType ?? '');
}

function groupFissuresByTier(fissures: WfstatFissure[]) {
  const grouped = new Map<string, WfstatFissure[]>();

  for (const fissure of [...fissures].sort(compareFissures)) {
    const tier = getFissureTierLabel(fissure);
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
  const imageUrl = resolveWfmAssetUrl(imagePath);

  return (
    <span className="fissure-tier-icon" aria-hidden="true">
      {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : tier.slice(0, 1)}
    </span>
  );
}

export function FissuresPanel() {
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
    () => groupFissuresByTier(filteredFissures),
    [filteredFissures],
  );
  const tierIconMap = useMemo(
    () =>
      new Map(
        tierIcons.map((icon) => [icon.tier.trim().toLowerCase(), icon.imagePath]),
      ),
    [tierIcons],
  );
  const fallbackTierIcon = tierIcons[0]?.imagePath ?? null;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Fissures</span>
        <span className={`badge ${filteredFissures.length > 0 ? 'badge-blue' : 'badge-muted'}`}>
          {filteredFissures.length} active
        </span>
        <div className="card-actions fissure-mode-toggle" role="tablist" aria-label="Fissure mode">
          <button
            className={`fissure-mode-btn${mode === 'normal' ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={mode === 'normal'}
            aria-label={FISSURE_MODE_LABELS.normal}
            title={FISSURE_MODE_LABELS.normal}
            onClick={() => setMode('normal')}
          >
            <NormalModeIcon />
          </button>
          <button
            className={`fissure-mode-btn${mode === 'steel-path' ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={mode === 'steel-path'}
            aria-label={FISSURE_MODE_LABELS['steel-path']}
            title={FISSURE_MODE_LABELS['steel-path']}
            onClick={() => setMode('steel-path')}
          >
            <SteelPathModeIcon />
          </button>
          <button
            className="text-btn"
            type="button"
            onClick={() => {
              void refreshWorldStateFissures();
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

        {loading && fissures.length === 0 ? (
          <div className="empty-state">
            <span className="empty-primary">Loading live fissures…</span>
            <span className="empty-sub">
              Fetching `GET /pc/fissures?language=en` from WarframeStat.
            </span>
          </div>
        ) : null}

        {!loading && groupedFissures.length === 0 ? (
          <div className="empty-state">
            <span className="empty-primary">No {mode === 'steel-path' ? 'Steel Path ' : ''}fissures active</span>
            <span className="empty-sub">
              Switch modes or wait for the next worldstate refresh.
            </span>
          </div>
        ) : null}

        {groupedFissures.length > 0 ? (
          <div className="fissure-group-grid">
            {groupedFissures.map((group) => (
              <section key={group.tier} className="fissure-group-card">
                <div className="fissure-group-header">
                  <span className="fissure-group-title-wrap">
                    <FissureTierIcon
                      tier={group.tier}
                      imagePath={tierIconMap.get(group.tier.trim().toLowerCase()) ?? fallbackTierIcon}
                    />
                    <span className="fissure-group-title">{group.tier}</span>
                  </span>
                  <span className="badge badge-muted">{group.fissures.length}</span>
                </div>

                <div className="fissure-list">
                  {group.fissures.map((fissure) => (
                    <article key={fissure.id} className="fissure-item">
                      <div className="fissure-item-topline">
                        <span className="fissure-item-node">{fissure.node ?? 'Unknown node'}</span>
                        <span className="badge badge-green">
                          {formatWorldStateCountdown(fissure.expiry, nowMs)}
                        </span>
                      </div>
                      <div className="fissure-item-meta">
                        <span>{fissure.missionType ?? 'Unknown mission'}</span>
                        <span>{fissure.enemy ?? 'Unknown faction'}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
