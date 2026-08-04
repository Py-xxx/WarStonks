import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getArbitrageScannerState,
  listenToArbitrageScannerProgress,
  startArbitrageScanner,
  stopArbitrageScanner,
  getSetCompletionOwnedItems,
  isTauriRuntime,
} from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { ItemName } from '../../components/ItemName';
import { useLocalizedName } from '../../hooks/useLocalizedName';
import { useItemQueryMatcher } from '../../hooks/useItemSearch';
import { tConfidence, tHealth } from '../../lib/healthLabels';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import {
  formatScannerErrorMessage,
  type ScannerErrorContext,
} from '../../lib/scannerErrorHandling';
import {
  clearWatchlistAddFeedbackTimeouts,
  markWatchlistAddFeedback,
} from '../../lib/watchlistAddFeedback';
import { useAppStore } from '../../stores/useAppStore';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import type {
  ArbitrageScannerComponentEntry,
  ArbitrageScannerProgress,
  ArbitrageScannerSetEntry,
  ArbitrageScannerResponse,
  RelicRefinementChanceProfile,
  RelicRoiDropEntry,
  RelicRoiEntry,
  RelicRoiRefinementSummary,
  WfmAutocompleteItem,
} from '../../types';

type ScannerTab = 'arbitrage' | 'relic-roi';

const ScanChevron = ({ up }: { up?: boolean }) => (
  <svg className="sp-set-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={up ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
  </svg>
);
type RelicRefinementKey = 'intact' | 'exceptional' | 'flawless' | 'radiant';
type ScannerErrorState = {
  context: ScannerErrorContext;
  message: string;
  tone: 'warning' | 'error';
};
const RELIC_REFINEMENT_KEYS: RelicRefinementKey[] = ['intact', 'exceptional', 'flawless', 'radiant'];
const RELIC_REFINEMENT_LABEL_KEYS: Record<RelicRefinementKey, TranslationKey> = {
  intact: 'refine.intact',
  exceptional: 'refine.exceptional',
  flawless: 'refine.flawless',
  radiant: 'refine.radiant',
};

function formatPlat(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return `${Math.round(value)}p`;
}

function formatPlatPrecise(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return `${value.toFixed(2).replace(/\.?0+$/, '')}p`;
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return `${Math.round(value)}%`;
}

function formatChance(value: number | null): string {
  if (value === null) {
    return '—';
  }

  const decimals = value >= 10 ? 2 : value >= 1 ? 2 : 3;
  const formatted = value.toFixed(decimals).replace(/\.?0+$/, '');
  return `${formatted}%`;
}

function normalizeRelicChance(value: number | null): number | null {
  if (value === null) {
    return null;
  }

  return Math.max(0, value) / 100;
}

function confidenceTone(level: string): 'green' | 'blue' | 'amber' {
  switch (level) {
    case 'high':
      return 'green';
    case 'medium':
      return 'blue';
    default:
      return 'amber';
  }
}

function getDefaultComponentTarget(component: ArbitrageScannerComponentEntry): string {
  if (
    component.recommendedEntryLow !== null &&
    component.recommendedEntryHigh !== null
  ) {
    return String(
      Math.max(
        1,
        Math.ceil((component.recommendedEntryLow + component.recommendedEntryHigh) / 2),
      ),
    );
  }

  if (component.recommendedEntryPrice !== null) {
    return String(Math.max(1, Math.ceil(component.recommendedEntryPrice)));
  }

  if (component.currentStatsPrice !== null) {
    return String(Math.max(1, Math.ceil(component.currentStatsPrice)));
  }

  return '';
}

function getRepresentativeZonePrice(
  low: number | null,
  high: number | null,
  fallback: number | null,
): number | null {
  if (low !== null && high !== null) {
    return (low + high) / 2;
  }

  return fallback;
}

function chanceForRefinement(
  chanceProfile: RelicRefinementChanceProfile,
  refinementKey: RelicRefinementKey,
): number | null {
  switch (refinementKey) {
    case 'exceptional':
      return chanceProfile.exceptional;
    case 'flawless':
      return chanceProfile.flawless;
    case 'radiant':
      return chanceProfile.radiant;
    default:
      return chanceProfile.intact;
  }
}

function getRelicRefinementSummary(
  entry: RelicRoiEntry,
  refinementKey: RelicRefinementKey,
): RelicRoiRefinementSummary | null {
  return (
    entry.refinements.find((summary) => summary.refinementKey === refinementKey) ??
    entry.refinements[0] ??
    null
  );
}

function buildScannerProgressDetails(
  progress: ArbitrageScannerProgress | null,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string[] {
  if (!progress) {
    return [];
  }

  const details: string[] = [];

  if (progress.currentSetName) {
    details.push(t('scan.progress.currentSet', { name: progress.currentSetName }));
  }

  if (progress.currentComponentName) {
    details.push(t('scan.progress.currentComponent', { name: progress.currentComponentName }));
  }

  if (progress.totalComponentCount > 0) {
    details.push(
      t('scan.progress.componentsProgress', {
        done: progress.completedComponentCount,
        total: progress.totalComponentCount,
      }),
    );
  }

  if (progress.totalSetCount > 0) {
    details.push(
      t('scan.progress.setsProgress', { done: progress.completedSetCount, total: progress.totalSetCount }),
    );
  }

  details.push(t('scan.progress.skipped', { n: progress.skippedEntryCount }));

  if (progress.retryingItemName && progress.retryAttempt) {
    details.push(
      t('scan.progress.retry', { attempt: progress.retryAttempt, name: progress.retryingItemName }),
    );
  }

  return details;
}

function ArbitrageComponentRow({
  component,
  targetValue,
  recentlyAdded,
  onTargetChange,
  onAdd,
}: {
  component: ArbitrageScannerComponentEntry;
  targetValue: string;
  recentlyAdded: boolean;
  onTargetChange: (value: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const imageUrl = resolveWfmAssetUrl(component.imagePath);
  const isDisabled = !component.itemKey || !targetValue.trim();

  return (
    <div className="scanner-component-row">
      <div className="scanner-component-main">
        <span className="scanner-component-thumb">
          {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{component.name.slice(0, 1)}</span>}
        </span>
        <div className="scanner-component-copy">
          <div className="scanner-component-name-row">
            <span className="scanner-component-name">
              {component.quantityInSet}x{' '}
              <ItemName
                name={component.name}
                slug={component.slug}
                wfmId={component.itemKey ?? undefined}
                imagePath={component.imagePath}
              />
            </span>
            <span className={`market-panel-badge tone-${confidenceTone(component.confidenceSummary.level)}`}>
              {tConfidence(t, component.confidenceSummary)}
            </span>
          </div>
          <div className="scanner-component-pill-row">
            <span className="scanner-stat-pill scanner-stat-pill-highlight">
              <span className="scanner-stat-pill-label">{t('scan.entryZone')}</span>
              <span className="scanner-stat-pill-value">
                {formatPlat(component.recommendedEntryLow)} - {formatPlat(component.recommendedEntryHigh)}
              </span>
            </span>
          </div>
        </div>
      </div>
      <div className="scanner-component-actions">
        <input
          className="price-input scanner-component-input"
          type="number"
          min="0"
          step="1"
          value={targetValue}
          onChange={(event) => onTargetChange(event.target.value)}
        />
        <div className="watchlist-add-feedback-stack">
          {recentlyAdded ? (
            <span className="watchlist-add-success">{t('wl.addedToWatchlist')}</span>
          ) : null}
          <button
            className="btn-sm scanner-component-watch-button"
            type="button"
            disabled={isDisabled}
            onClick={onAdd}
          >
            {t('wl.addToWatchlist')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ArbitrageRow({
  entry,
  index,
  expanded,
  onToggle,
  targetInputs,
  recentlyAddedKeys,
  onTargetChange,
  onAddToWatchlist,
}: {
  entry: ArbitrageScannerSetEntry;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  targetInputs: Record<string, string>;
  recentlyAddedKeys: Record<string, boolean>;
  onTargetChange: (component: ArbitrageScannerComponentEntry, value: string) => void;
  onAddToWatchlist: (component: ArbitrageScannerComponentEntry) => void;
}) {
  const { t } = useTranslation();
  const imageUrl = resolveWfmAssetUrl(entry.imagePath);

  return (
    <article className={`sp-set${expanded ? ' is-expanded' : ''}`}>
      <button className="sp-set-head" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className="scan-rank">{index + 1}</span>
        <span className="sp-set-thumb">
          {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{entry.name.slice(0, 2)}</span>}
        </span>
        <div className="sp-set-copy">
          <span className="fn-row-title">
            <span className="sp-set-name">
              <ItemName
                name={entry.name}
                slug={entry.slug}
                wfmId={entry.setItemKey}
                imagePath={entry.imagePath}
              />
            </span>
            <span className={`scan-confidence-pill tone-${confidenceTone(entry.confidenceSummary.level)}`}>
              {tConfidence(t, entry.confidenceSummary)}
            </span>
          </span>
          <span className="fn-row-sub">
            {t('scan.partsAndLiquidity', {
              n: entry.componentCount,
              pct: `${Math.round(entry.liquidityScore)}%`,
            })}
          </span>
        </div>
        <div className="sp-set-metrics">
          <div className="sp-set-metric">
            <span className="sp-set-metric-label">{t('scan.buyIn')}</span>
            <span className="sp-set-metric-value">{formatPlat(entry.basketEntryCost)}</span>
          </div>
          <div className="sp-set-metric">
            <span className="sp-set-metric-label">{t('scan.sellAt')}</span>
            <span className="sp-set-metric-value">{formatPlat(entry.recommendedSetExitPrice)}</span>
          </div>
          <div className="sp-set-metric">
            <span className="sp-set-metric-label">{t('scan.margin')}</span>
            <span className="sp-set-metric-value pos">{formatPlat(entry.grossMargin)}</span>
          </div>
          <span className="sp-set-roi">{formatPercent(entry.roiPct)} ROI</span>
        </div>
        <ScanChevron up={expanded} />
      </button>

      {expanded ? (
        <div className="sp-set-body">
          <div className="sp-set-detail-stats">
            <span>{t('scan.exitZone')} <strong>{formatPlat(entry.setExitLow)}–{formatPlat(entry.setExitHigh)}</strong></span>
            <span>{t('scan.score')} <strong>{Math.round(entry.arbitrageScore)}</strong></span>
            <span>{t('scan.liquidity')} <strong>{Math.round(entry.liquidityScore)}%</strong></span>
          </div>

          <div className="sp-part-group-label missing">
            {t('scan.partsToBuy', { n: entry.componentCount })}
          </div>
          <div className="sp-part-list">
              {entry.components.map((component) => (
                <ArbitrageComponentRow
                  key={`${entry.slug}-${component.slug}`}
                  component={component}
                  targetValue={targetInputs[component.slug] ?? getDefaultComponentTarget(component)}
                  recentlyAdded={Boolean(recentlyAddedKeys[component.slug])}
                  onTargetChange={(value) => onTargetChange(component, value)}
                  onAdd={() => onAddToWatchlist(component)}
                />
              ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function RelicDropRow({
  drop,
  refinementKey,
}: {
  drop: RelicRoiDropEntry;
  refinementKey: RelicRefinementKey;
}) {
  const { t } = useTranslation();
  const localizeName = useLocalizedName();
  const imageUrl = resolveWfmAssetUrl(drop.imagePath);
  const chance = chanceForRefinement(drop.chanceProfile, refinementKey);
  const normalizedChance = normalizeRelicChance(chance);
  const representativeExitPrice = getRepresentativeZonePrice(
    drop.recommendedExitLow,
    drop.recommendedExitHigh,
    drop.recommendedExitPrice,
  );
  const expectedContribution =
    normalizedChance !== null && representativeExitPrice !== null
      ? Math.round(normalizedChance * representativeExitPrice)
      : null;

  return (
    <div className="scanner-component-row scanner-component-row-inline">
      <div className="scanner-component-main">
        <span className="scanner-component-thumb">
          {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{drop.name.slice(0, 1)}</span>}
        </span>
        <div className="scanner-component-copy">
          <div className="scanner-component-name-row">
            <span className="scanner-component-name">{localizeName(drop)}</span>
            {drop.rarity ? <span className="market-panel-badge tone-blue">{drop.rarity}</span> : null}
            <span className={`market-panel-badge tone-${confidenceTone(drop.confidenceSummary.level)}`}>
              {tConfidence(t, drop.confidenceSummary)}
            </span>
          </div>
          <div className="scanner-component-pill-row">
            <span className="scanner-stat-pill">
              <span className="scanner-stat-pill-label">{t('scan.chance')}</span>
              <span className="scanner-stat-pill-value">{formatChance(chance)}</span>
            </span>
            <span className="scanner-stat-pill scanner-stat-pill-highlight">
              <span className="scanner-stat-pill-label">{t('scan.optimalExit')}</span>
              <span className="scanner-stat-pill-value">
                {formatPlat(drop.recommendedExitLow)} - {formatPlat(drop.recommendedExitHigh)}
              </span>
            </span>
            <span className="scanner-stat-pill">
              <span className="scanner-stat-pill-label">EV</span>
              <span className="scanner-stat-pill-value">{formatPlat(expectedContribution)}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RelicRoiRow({
  entry,
  index,
  refinementKey,
  expanded,
  onToggle,
}: {
  entry: RelicRoiEntry;
  index: number;
  refinementKey: RelicRefinementKey;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const imageUrl = resolveWfmAssetUrl(entry.imagePath);
  const summary = getRelicRefinementSummary(entry, refinementKey);

  // Highest-value drop at the active refinement — the single most useful fact about a relic,
  // previously hidden until the row was expanded.
  const bestDrop = [...(entry.drops ?? [])]
    .sort((a, b) => (b.recommendedExitPrice ?? 0) - (a.recommendedExitPrice ?? 0))[0];

  return (
    <article className={`sp-set${expanded ? ' is-expanded' : ''}`}>
      <button className="sp-set-head" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className="scan-rank">{index + 1}</span>
        <span className="sp-set-thumb">
          {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{entry.name.slice(0, 2)}</span>}
        </span>
        <div className="sp-set-copy">
          <span className="fn-row-title">
            <span className="sp-set-name">
              <ItemName
                name={entry.name}
                slug={entry.slug}
                itemId={entry.relicItemId}
                imagePath={entry.imagePath}
              />
            </span>
            <span className={`scan-confidence-pill tone-${entry.isUnvaulted ? 'green' : 'amber'}`}>
              {entry.isUnvaulted ? t('scan.unvaulted') : t('scan.vaulted')}
            </span>
          </span>
          <span className="fn-row-sub">
            {bestDrop
              ? t('scan.bestDrop', {
                  name: bestDrop.name,
                  price: formatPlat(bestDrop.recommendedExitPrice),
                })
              : tConfidence(t, summary?.confidenceSummary ?? entry.confidenceSummary)}
          </span>
        </div>
        <div className="sp-set-metrics">
          <span className="relic-refinement-pill relic-refinement-pill-blue">
            {t('opp.runRefinement', { refinement: tHealth(t, summary?.refinementLabel) || '—' })}
          </span>
          <div className="sp-set-metric">
            <span className="sp-set-metric-label">{t('scan.runValueLabel')}</span>
            <span className="sp-set-metric-value pos">{formatPlatPrecise(summary?.runValue ?? null)}</span>
          </div>
          <div className="sp-set-metric">
            <span className="sp-set-metric-label">{t('scan.liquidity')}</span>
            <span className="sp-set-metric-value">{Math.round(summary?.liquidityScore ?? 0)}%</span>
          </div>
        </div>
        <ScanChevron up={expanded} />
      </button>

      {expanded ? (
        <div className="sp-set-body">
          <div className="scanner-inline-summary">
            <span className="scanner-stat-pill">
              <span className="scanner-stat-pill-label">{t('scan.refinement')}</span>
              <span className="scanner-stat-pill-value">{tHealth(t, summary?.refinementLabel) || '—'}</span>
            </span>
            <span className="scanner-stat-pill">
              <span className="scanner-stat-pill-label">{t('scan.runValue')}</span>
              <span className="scanner-stat-pill-value">{formatPlatPrecise(summary?.runValue ?? null)}</span>
            </span>
            <span className="scanner-stat-pill">
              <span className="scanner-stat-pill-label">{t('scan.liquidity')}</span>
              <span className="scanner-stat-pill-value">{Math.round(summary?.liquidityScore ?? 0)}%</span>
            </span>
            <span className="scanner-stat-pill">
              <span className="scanner-stat-pill-label">{t('scan.drops')}</span>
              <span className="scanner-stat-pill-value">{entry.dropCount}</span>
            </span>
          </div>

          <div className="scanner-components-panel">
            <div className="scanner-components-header">
              <span className="card-label">{t('scan.primeRewards')}</span>
              <span className="scanner-components-meta">
                {t('scan.ratesApplied', { label: summary?.refinementLabel ? tHealth(t, summary.refinementLabel) : t('scan.selectedRefinement') })}
              </span>
            </div>
            <div className="scanner-components-list">
              {entry.drops.map((drop) => (
                <RelicDropRow
                  key={`${entry.slug}-${refinementKey}-${drop.slug}`}
                  drop={drop}
                  refinementKey={refinementKey}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function ScannersPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ScannerTab>('arbitrage');
  const [arbitrage, setArbitrage] = useState<ArbitrageScannerResponse | null>(null);
  /** Owned prime-part counts, so "add to watchlist" can want only the shortfall. Best-effort:
   *  an empty map simply means "own nothing", which watches the full requirement. */
  const [ownedPartQuantities, setOwnedPartQuantities] = useState<Map<string, number>>(new Map());
  const [progress, setProgress] = useState<ArbitrageScannerProgress | null>(null);
  const [scannerError, setScannerError] = useState<ScannerErrorState | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [expandedRelicSlug, setExpandedRelicSlug] = useState<string | null>(null);
  const [componentTargets, setComponentTargets] = useState<Record<string, string>>({});
  const [watchlistAddFeedback, setWatchlistAddFeedback] = useState<Record<string, boolean>>({});
  const [relicRefinement, setRelicRefinement] = useState<RelicRefinementKey>('intact');
  const [showOnlyUnvaulted, setShowOnlyUnvaulted] = useState(false);
  const [arbitrageSearch, setArbitrageSearch] = useState('');
  const [relicSearch, setRelicSearch] = useState('');
  const watchlistAddFeedbackTimeoutsRef = useRef(new Map<string, number>());
  const lastSavedScanAtRef = useRef<string | null>(null);
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);
  const syncScannerStaleAlert = useAppStore((state) => state.syncScannerStaleAlert);
  const autoScanEnabled = useAppStore((state) => state.autoScanEnabled);
  const setAutoScanEnabled = useAppStore((state) => state.setAutoScanEnabled);

  useEffect(() => {
    lastSavedScanAtRef.current = arbitrage?.scanFinishedAt ?? progress?.lastCompletedAt ?? null;
  }, [arbitrage?.scanFinishedAt, progress?.lastCompletedAt]);

  const setScannerErrorFrom = useCallback(
    (
      context: ScannerErrorContext,
      error: unknown,
      options?: { lastCompletedAt?: string | null; tone?: 'warning' | 'error' },
    ) => {
      const lastCompletedAt = options?.lastCompletedAt ?? lastSavedScanAtRef.current;
      setScannerError({
        context,
        message: formatScannerErrorMessage(context, error, { lastCompletedAt }),
        tone: options?.tone ?? (lastCompletedAt ? 'warning' : 'error'),
      });
    },
    [],
  );

  // True only while the live effect (mount → cleanup) is active. loadScannerState reads this
  // instead of taking a `cancelled` argument, so every call site (mount, poll, progress event,
  // start/stop) is guarded uniformly and can never setState after unmount.
  const scannerEffectActiveRef = useRef(false);

  const loadScannerState = useCallback(async () => {
    try {
      const response = await getArbitrageScannerState();
      if (!scannerEffectActiveRef.current) {
        return;
      }
      setArbitrage(response.latestScan);
      setProgress(response.progress);
      syncScannerStaleAlert(response.latestScan?.scanFinishedAt ?? null);
      if (response.progress.status === 'error') {
        const lastCompletedAt = response.latestScan?.scanFinishedAt ?? response.progress.lastCompletedAt;
        setScannerErrorFrom('scanner-run', response.progress.lastError, {
          lastCompletedAt,
          tone: lastCompletedAt ? 'warning' : 'error',
        });
      } else {
        setScannerError(null);
      }
    } catch (error) {
      if (!scannerEffectActiveRef.current) {
        return;
      }
      const lastCompletedAt = lastSavedScanAtRef.current;
      setScannerErrorFrom(lastCompletedAt ? 'scanner-state-refresh' : 'scanner-state-load', error, {
        lastCompletedAt,
        tone: lastCompletedAt ? 'warning' : 'error',
      });
    }
  }, [setScannerErrorFrom, syncScannerStaleAlert]);

  useEffect(() => {
    scannerEffectActiveRef.current = true;
    void loadScannerState();

    let unsubscribe: (() => void) | null = null;
    void listenToArbitrageScannerProgress((nextProgress) => {
      if (!scannerEffectActiveRef.current) {
        return;
      }

      setProgress(nextProgress);
      if (nextProgress.status === 'error') {
        setScannerErrorFrom('scanner-run', nextProgress.lastError, {
          lastCompletedAt: nextProgress.lastCompletedAt,
          tone: nextProgress.lastCompletedAt ? 'warning' : 'error',
        });
      } else {
        setScannerError(null);
      }

      if (nextProgress.status === 'success' || nextProgress.status === 'error') {
        void loadScannerState();
      }
    })
      .then((cleanup) => {
        // If we already unmounted before the subscription resolved, tear it down immediately —
        // otherwise the real unlisten is never wired up and the listener leaks.
        if (!scannerEffectActiveRef.current) {
          cleanup();
          return;
        }
        unsubscribe = cleanup;
      })
      .catch((error) => {
        // A failed subscription must not silently stop progress — the 1250ms poll below is the
        // backstop, so just log and keep going.
        console.error('[scanners] failed to subscribe to scanner progress', error);
      });

    const pollInterval = window.setInterval(() => {
      void loadScannerState();
    }, 1250);

    return () => {
      scannerEffectActiveRef.current = false;
      window.clearInterval(pollInterval);
      unsubscribe?.();
    };
  }, [loadScannerState, setScannerErrorFrom]);

  const runArbitrageScan = async () => {
    setScannerError(null);
    try {
      const started = await startArbitrageScanner();
      if (started) {
        setProgress((current) => ({
          scannerKey: current?.scannerKey ?? 'arbitrage',
          status: 'running',
          progressValue: 0,
          stageLabel: t('scan.queued'),
          statusText: t('scan.arbitrageQueued'),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          lastCompletedAt: current?.lastCompletedAt ?? null,
          lastError: null,
          currentSetName: null,
          currentComponentName: null,
          completedSetCount: 0,
          totalSetCount: current?.totalSetCount ?? 0,
          completedComponentCount: 0,
          totalComponentCount: current?.totalComponentCount ?? 0,
          skippedEntryCount: 0,
          retryingItemName: null,
          retryAttempt: null,
        }));
        void loadScannerState();
      } else {
        setProgress((current) =>
          current
            ? {
                ...current,
                statusText: current.status === 'running'
                  ? current.statusText
                  : t('scan.arbitrageAlreadyRunning'),
              }
            : current,
        );
      }
    } catch (error) {
      const lastCompletedAt = lastSavedScanAtRef.current;
      setScannerErrorFrom('scanner-start', error, {
        lastCompletedAt,
        tone: lastCompletedAt ? 'warning' : 'error',
      });
    }
  };

  const stopArbitrageScan = async () => {
    setScannerError(null);
    try {
      const stopped = await stopArbitrageScanner();
      if (stopped) {
        setProgress((current) =>
          current
            ? {
                ...current,
                status: 'running',
                stageLabel: t('scan.stopping'),
                statusText: t('scan.stoppingArbitrage'),
                updatedAt: new Date().toISOString(),
              }
            : current,
        );
        void loadScannerState();
      }
      if (!stopped) {
        setProgress((current) =>
          current
            ? {
                ...current,
                statusText: current.statusText || t('scan.noArbitrageToStop'),
              }
            : current,
        );
      }
    } catch (error) {
      setScannerErrorFrom('scanner-stop', error, { tone: 'error' });
    }
  };

  const isRunning = progress?.status === 'running';
  const hasSavedScan = Boolean(arbitrage);
  const actionLabel = hasSavedScan ? t('scan.rescan') : t('scan.startScan');
  const normalizedArbitrageSearch = arbitrageSearch.trim();
  const normalizedRelicSearch = relicSearch.trim();
  // Matches against the localized name shown on the row, not just the English one behind it.
  const matchesItem = useItemQueryMatcher();
  const arbitrageResults = useMemo(() => {
    const source = arbitrage?.results ?? [];
    if (!normalizedArbitrageSearch) {
      return source;
    }

    return source.filter((entry) => matchesItem(normalizedArbitrageSearch, entry));
  }, [arbitrage?.results, normalizedArbitrageSearch, matchesItem]);
  const relicResults = useMemo(() => {
    const source = arbitrage?.relicRoiResults ?? [];
    const filtered = showOnlyUnvaulted
      ? source.filter((entry) => entry.isUnvaulted)
      : source;
    const searchFiltered = normalizedRelicSearch
      ? filtered.filter((entry) => {
          if (matchesItem(normalizedRelicSearch, entry)) {
            return true;
          }

          return entry.drops.some((drop) => matchesItem(normalizedRelicSearch, drop));
        })
      : filtered;
    return [...searchFiltered].sort((left, right) => {
      const rightSummary = getRelicRefinementSummary(right, relicRefinement);
      const leftSummary = getRelicRefinementSummary(left, relicRefinement);
      return (rightSummary?.relicRoiScore ?? 0) - (leftSummary?.relicRoiScore ?? 0);
    });
  }, [arbitrage?.relicRoiResults, normalizedRelicSearch, relicRefinement, showOnlyUnvaulted, matchesItem]);

  useEffect(() => {
    if (!arbitrageResults.length) {
      setExpandedSlug(null);
      return;
    }

    setExpandedSlug((current) =>
      current && arbitrageResults.some((entry) => entry.slug === current)
        ? current
        : null,
    );
  }, [arbitrageResults]);

  useEffect(() => {
    if (!relicResults.length) {
      setExpandedRelicSlug(null);
      return;
    }

    setExpandedRelicSlug((current) =>
      current && relicResults.some((entry) => entry.slug === current)
        ? current
        : null,
    );
  }, [relicResults]);

  useEffect(
    () => () => {
      clearWatchlistAddFeedbackTimeouts(watchlistAddFeedbackTimeoutsRef);
    },
    [],
  );

  const updateComponentTarget = (
    component: ArbitrageScannerComponentEntry,
    value: string,
  ) => {
    setComponentTargets((current) => ({
      ...current,
      [component.slug]: value,
    }));
  };

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let cancelled = false;
    void getSetCompletionOwnedItems()
      .then((items) => {
        if (!cancelled) {
          setOwnedPartQuantities(new Map(items.map((item) => [item.slug, item.quantity])));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const addComponentToWatchlist = (component: ArbitrageScannerComponentEntry) => {
    if (component.itemKey === null) {
      return;
    }
    // Want only the shortfall. No inventory loaded (or item absent) reads as 0 owned, so the
    // full set requirement is watched — which is the right default for a fresh flip.
    const owned = ownedPartQuantities.get(component.slug) ?? 0;
    const needed = Math.max(1, (component.quantityInSet ?? 1) - owned);

    const rawTarget = componentTargets[component.slug] ?? getDefaultComponentTarget(component);
    const targetPrice = Number.parseInt(rawTarget || '0', 10);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      return;
    }

    const item: WfmAutocompleteItem = {
      itemId: 0,
      wfmId: component.itemKey,
      name: component.name,
      slug: component.slug,
      maxRank: null,
      itemFamily: null,
      imagePath: component.imagePath,
      bulkTradable: false,
    };

    addExplicitItemToWatchlist(item, 'base', 'Base Market', targetPrice, needed);
    markWatchlistAddFeedback(component.slug, setWatchlistAddFeedback, watchlistAddFeedbackTimeoutsRef);
  };

  const scanSummaryCounts = arbitrage
    ? `${arbitrage.scannedSetCount} sets · ${arbitrage.scannedComponentCount} components · ${arbitrage.scannedRelicCount} relics`
    : null;
  const showInlineScannerNotice = Boolean(scannerError && hasSavedScan);
  const showBlockingScannerEmptyState = Boolean(scannerError && !hasSavedScan && !isRunning);
  const scannerErrorAction = scannerError
    ? scannerError.context === 'scanner-run' || scannerError.context === 'scanner-start'
      ? {
          label: actionLabel,
          onClick: () => {
            void runArbitrageScan();
          },
        }
      : scannerError.context === 'scanner-stop'
        ? {
            label: t('scan.tryAgain'),
            onClick: () => {
              void stopArbitrageScan();
            },
          }
        : {
            label: t('common.retry'),
            onClick: () => {
              void loadScannerState();
            },
          }
    : null;

  return (
    <>
      <div className="subnav scanners-page-subnav">
        <div className="subnav-left">
          <span className="page-title">{t('scan.title')}</span>
          <span
            className={`subtab${activeTab === 'arbitrage' ? ' active' : ''}`}
            onClick={() => setActiveTab('arbitrage')}
            role="tab"
            tabIndex={0}
          >
            {t('scan.arbitrage')}
          </span>
          <span
            className={`subtab${activeTab === 'relic-roi' ? ' active' : ''}`}
            onClick={() => setActiveTab('relic-roi')}
            role="tab"
            tabIndex={0}
          >
            {t('scan.tab.relicRoi')}
          </span>
        </div>
        {(activeTab === 'arbitrage' || activeTab === 'relic-roi') ? (
          <div className="subnav-right">
            <button
              className="scanner-action-button"
              type="button"
              onClick={() => {
                if (isRunning) {
                  void stopArbitrageScan();
                  return;
                }
                void runArbitrageScan();
              }}
            >
              {isRunning ? t('scan.stopScan') : actionLabel}
            </button>
          </div>
        ) : null}
      </div>

      <div className="page-content scanners-page-content">
        <div className="scanners-shell">
            <div className="market-panel scanners-intro-panel">
              <div className="market-panel-header">
                <div className="market-panel-header-copy">
                  {activeTab === 'arbitrage' ? (
                    <p>{t('scan.arbitrageIntro')}</p>
                  ) : (
                    <p>{t('scan.relicRoiIntro')}</p>
                  )}
                  <label className="scanner-auto-scan-toggle" title={t('scan.autoScanHelp')}>
                    <span className="scanner-auto-scan-copy">
                      <span className="scanner-auto-scan-label">{t('scan.autoScan')}</span>
                      <span className="scanner-auto-scan-help">{t('scan.autoScanHelp')}</span>
                    </span>
                    <button
                      type="button"
                      className={`toggle${autoScanEnabled ? ' on' : ''}`}
                      role="switch"
                      aria-checked={autoScanEnabled}
                      aria-label={t('scan.autoScan')}
                      onClick={() => setAutoScanEnabled(!autoScanEnabled)}
                    />
                  </label>
                  {progress ? (
                    <div className="scanner-header-status-line">
                      <span className="market-panel-badge tone-neutral">
                        {progress.status === 'running'
                          ? `${progress.stageLabel} · ${Math.round(progress.progressValue)}%`
                          : progress.lastCompletedAt
                            ? t('common.updatedAt', { time: formatShortLocalDateTime(progress.lastCompletedAt) })
                            : t('scan.noSavedScan')}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="scanner-progress-layout">
                <div className="scanner-progress-block">
                  <div className="scanner-progress-meta">
                    <span>{progress?.stageLabel ?? t('scan.ready')}</span>
                    <span>{Math.round(progress?.progressValue ?? 0)}%</span>
                  </div>
                  <div className="scanner-progress-track">
                    <div
                      className="scanner-progress-fill"
                      style={{ width: `${Math.max(0, Math.min(100, progress?.progressValue ?? 0))}%` }}
                    />
                  </div>
                  {buildScannerProgressDetails(progress, t).length > 0 ? (
                    <div className="scanner-progress-meta">
                      <span>{buildScannerProgressDetails(progress, t).join(' · ')}</span>
                    </div>
                  ) : null}
                  {arbitrage?.skippedSummaryText ? (
                    <div className="scanner-progress-meta">
                      <span>{arbitrage.skippedSummaryText}</span>
                    </div>
                  ) : null}
                  {showInlineScannerNotice && scannerError ? (
                    <div className="activity-inline-state scanner-inline-state" role="alert">
                      <span
                        className={
                          scannerError.tone === 'warning'
                            ? 'settings-inline-warning'
                            : 'settings-inline-error'
                        }
                      >
                        {scannerError.message}
                      </span>
                      {scannerErrorAction ? (
                        <button className="text-btn" type="button" onClick={scannerErrorAction.onClick}>
                          {scannerErrorAction.label}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="scanner-summary-card--compact">
                  <span className="scanner-summary-stat">
                    {scanSummaryCounts ?? t('scan.noSavedScan')}
                  </span>
                </div>
              </div>
            </div>

            {activeTab === 'arbitrage' && arbitrage ? (
              <div className="scanner-results-list">
                <div className="sp-summary">
                  <div className="sp-summary-lead">
                    <span className="sp-summary-lead-icon"><i className="ti ti-radar" aria-hidden="true" /></span>
                    <div>
                      <span className="sp-summary-title">
                        {t('scan.setsWorthFlipping', { n: arbitrageResults.length })}
                      </span>
                      <span className="sp-summary-sub">{t('scan.flipSubtitle')}</span>
                    </div>
                  </div>
                  <div className="sp-summary-flow">
                    <div className="sp-summary-stat">
                      <span className="sp-summary-stat-label">{t('scan.bestMargin')}</span>
                      <span className="sp-summary-stat-value">
                        {formatPlat(arbitrageResults[0]?.grossMargin ?? null)}
                      </span>
                    </div>
                    <div className="sp-summary-stat sp-summary-stat-profit">
                      <span className="sp-summary-stat-label">{t('scan.bestRoi')}</span>
                      <span className="sp-summary-stat-value">
                        {formatPercent(arbitrageResults[0]?.roiPct ?? null)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="fn-controls">
                  <div className="fn-controls-row">
                    <div className="fn-search">
                      <i className="ti ti-search fn-search-icon" aria-hidden="true" />
                      <input
                        className="fn-search-input"
                        type="search"
                        value={arbitrageSearch}
                        onChange={(event) => setArbitrageSearch(event.target.value)}
                        placeholder={t('scan.searchSetsOrParts')}
                      />
                    </div>
                  </div>
                </div>
                {arbitrageResults.length > 0 ? (
                  arbitrageResults.map((entry, index) => (
                    <ArbitrageRow
                      key={entry.slug}
                      entry={entry}
                      index={index}
                      expanded={expandedSlug === entry.slug}
                      onToggle={() =>
                        setExpandedSlug((current) => (current === entry.slug ? null : entry.slug))
                      }
                      targetInputs={componentTargets}
                      recentlyAddedKeys={watchlistAddFeedback}
                      onTargetChange={updateComponentTarget}
                      onAddToWatchlist={addComponentToWatchlist}
                    />
                  ))
                ) : (
                  <div className="empty-state scanners-empty-state scanner-results-empty-state">
                    <span className="empty-primary">{t('scan.noSets')}</span>
                    <span className="empty-sub">
                      {t('scan.tryAnotherSet')}
                    </span>
                  </div>
                )}
              </div>
            ) : activeTab === 'relic-roi' && arbitrage ? (
              relicResults.length > 0 ? (
                <div className="scanner-results-list">
                  <div className="sp-summary">
                    <div className="sp-summary-lead">
                      <span className="sp-summary-lead-icon"><i className="ti ti-flame" aria-hidden="true" /></span>
                      <div>
                        <span className="sp-summary-title">
                          {t('scan.relicsRanked2', { n: relicResults.length })}
                        </span>
                        <span className="sp-summary-sub">{t('scan.relicSubtitle')}</span>
                      </div>
                    </div>
                    <div className="sp-summary-flow">
                      <div className="sp-summary-stat sp-summary-stat-profit">
                        <span className="sp-summary-stat-label">{t('scan.bestRun')}</span>
                        <span className="sp-summary-stat-value">
                          {formatPlatPrecise(
                            getRelicRefinementSummary(relicResults[0], relicRefinement)?.runValue ?? null,
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="fn-controls">
                    <div className="fn-controls-row">
                      <div className="fn-search">
                        <i className="ti ti-search fn-search-icon" aria-hidden="true" />
                        <input
                          className="fn-search-input"
                          type="search"
                          value={relicSearch}
                          onChange={(event) => setRelicSearch(event.target.value)}
                          placeholder={t('scan.searchRelicsOrDrops')}
                        />
                      </div>
                      <div className="fn-filters">
                        <label className="fn-filter">
                          <span>{t('scan.refinement')}</span>
                          <select
                            value={relicRefinement}
                            onChange={(event) => setRelicRefinement(event.target.value as RelicRefinementKey)}
                          >
                            {RELIC_REFINEMENT_KEYS.map((key) => (
                              <option key={key} value={key}>
                                {t(RELIC_REFINEMENT_LABEL_KEYS[key])}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="toggle-wrap scan-unvaulted-toggle" htmlFor="relic-unvaulted-toggle">
                          <span>{t('scan.unvaultedOnly')}</span>
                          <button
                            id="relic-unvaulted-toggle"
                            className={`toggle${showOnlyUnvaulted ? ' on' : ''}`}
                            type="button"
                            aria-pressed={showOnlyUnvaulted}
                            onClick={() => setShowOnlyUnvaulted((current) => !current)}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                  {relicResults.map((entry, index) => (
                    <RelicRoiRow
                      key={entry.slug}
                      entry={entry}
                      index={index}
                      refinementKey={relicRefinement}
                      expanded={expandedRelicSlug === entry.slug}
                      onToggle={() =>
                        setExpandedRelicSlug((current) => (current === entry.slug ? null : entry.slug))
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state scanners-empty-state">
                  <span className="empty-primary">
                    {normalizedRelicSearch
                      ? t('scan.noRelicsMatchSearch')
                      : showOnlyUnvaulted
                        ? t('scan.noUnvaultedResults')
                        : t('scan.noRelicRoiRows')}
                  </span>
                  <span className="empty-sub">
                    {normalizedRelicSearch
                      ? t('scan.tryAnotherRelicSearch')
                      : showOnlyUnvaulted
                        ? t('scan.unvaultedHint')
                        : t('scan.runFreshRelicScan')}
                  </span>
                </div>
              )
            ) : showBlockingScannerEmptyState && scannerError ? (
              <div className="empty-state scanners-empty-state">
                <span className="empty-primary">{t('scan.dataCouldNotLoad')}</span>
                <span className="empty-sub">{scannerError.message}</span>
                {scannerErrorAction ? (
                  <button
                    type="button"
                    className="market-empty-state-action"
                    onClick={scannerErrorAction.onClick}
                  >
                    {scannerErrorAction.label}
                  </button>
                ) : null}
              </div>
            ) : !isRunning ? (
              <div className="empty-state scanners-empty-state">
                <span className="empty-primary">
                  {normalizedArbitrageSearch
                    ? t('scan.noSetsMatchSearch')
                    : t('scan.noCachedResults')}
                </span>
                <span className="empty-sub">
                  {normalizedArbitrageSearch
                    ? t('scan.tryAnotherSetSearch')
                    : t('scan.startScanFirstResult')}
                </span>
                {!normalizedArbitrageSearch ? (
                  <button
                    type="button"
                    className="market-empty-state-action"
                    onClick={() => {
                      void runArbitrageScan();
                    }}
                  >
                    {actionLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
        </div>
      </div>
    </>
  );
}
