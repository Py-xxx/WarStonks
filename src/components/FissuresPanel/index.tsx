import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import { formatWorldStateCountdown, formatWorldStateDateTime } from '../../lib/worldState';
import { getRelicTierIcons } from '../../lib/tauriClient';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import { EventsPanelEmpty, EventsPanelNotice } from '../EventsPanelState';
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
  const imageUrl = resolveWfmAssetUrl(imagePath);

  return (
    <span className="fissure-tier-icon" aria-hidden="true">
      {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : tier.slice(0, 1)}
    </span>
  );
}

export function FissuresPanel() {
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
    <div className="card">
      <div className="card-header">
        <span className="card-label">{t('ws.fissures')}</span>
        <span className={`badge ${filteredFissures.length > 0 ? 'badge-blue' : 'badge-muted'}`}>
          {t('evt.activeCount', { n: filteredFissures.length })}
        </span>
        <div className="card-actions fissure-mode-toggle" role="tablist" aria-label={t('a11y.fissureMode')}>
          <button
            className={`fissure-mode-btn${mode === 'normal' ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={mode === 'normal'}
            aria-label={t('evt.fissuresNormal')}
            title={t('evt.fissuresNormal')}
            onClick={() => setMode('normal')}
          >
            <NormalModeIcon />
          </button>
          <button
            className={`fissure-mode-btn${mode === 'steel-path' ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={mode === 'steel-path'}
            aria-label={t('evt.fissuresSteelPath')}
            title={t('evt.fissuresSteelPath')}
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

        <EventsPanelNotice
          message={error}
          tone={hasUsableFissures ? 'warning' : 'error'}
          loading={loading}
          onRefresh={() => {
            void refreshWorldStateFissures();
          }}
        />

        {loading && fissures.length === 0 ? (
          <EventsPanelEmpty
            title={t('a11y.loadingFissures')}
            detail={t('evt.checkingFissures')}
          />
        ) : null}

        {!loading && groupedFissures.length === 0 && error && !hasUsableFissures ? (
          <EventsPanelEmpty
            title={t('a11y.fissuresFailed')}
            detail={error}
            actionLabel={t('common.retry')}
            onAction={() => {
              void refreshWorldStateFissures();
            }}
          />
        ) : null}

        {!loading && groupedFissures.length === 0 && (!error || hasUsableFissures) ? (
          <EventsPanelEmpty
            title={mode === 'steel-path' ? t('evt.noFissuresActiveSteel') : t('evt.noFissuresActiveNormal')}
            detail={t('evt.switchModesHint')}
          />
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
                        <span className="fissure-item-node">{fissure.node ?? t('mkt.unknownNode')}</span>
                        <span className="badge badge-green">
                          {formatWorldStateCountdown(fissure.expiry, nowMs)}
                        </span>
                      </div>
                      <div className="fissure-item-meta">
                        <span>{fissure.missionType ?? t('evt.unknownMission')}</span>
                        <span>{fissure.enemy ?? t('evt.unknownFaction')}</span>
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
