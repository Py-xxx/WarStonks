import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PriceHistoryBar } from '../../components/PriceHistoryBar';
import {
  getArbitrageScannerState,
  listenToArbitrageScannerProgress,
  startArbitrageScanner,
  stopArbitrageScanner,
  getSetCompletionOwnedItems,
  isTauriRuntime,
} from '../../lib/tauriClient';
import { formatElapsedTime, formatShortLocalDateTime } from '../../lib/dateTime';
import { ItemName } from '../../components/ItemName';
import { useLocalizedName } from '../../hooks/useLocalizedName';
import { useItemQueryMatcher } from '../../hooks/useItemSearch';
import { tConfidence, tHealth } from '../../lib/healthLabels';
import { useTranslation } from '../../i18n';
import { ScanGroup, ScanItemRow, ScanPill, ScanRank, ScanSearch, ScanSummary } from './parts';
import { ItemThumb, ListRow, RowMetric } from '../../components/ListRow';
import type { TranslationKey } from '../../i18n/en';
import {
  formatScannerErrorMessage,
  type ScannerErrorContext,
} from '../../lib/scannerErrorHandling';
import {
  clearWatchlistAddFeedbackTimeouts,
  markWatchlistAddFeedback,
} from '../../lib/watchlistAddFeedback';
import { PageContent } from '../../components/PageContent';
import { PageHeading } from '../../components/PageHeading';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Metric, MetricGrid } from '@/components/ui/metric';
import { Panel } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
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


/**
 * Placeholder rows for the scanner lists.
 *
 * Shown ONLY while the first `getArbitrageScannerState()` call is in flight — a real wait, however
 * short. Once it returns, either results or the genuine empty state takes over; there is no timed
 * delay and nothing that keeps pulsing over data that has already arrived.
 *
 * Shaped like the collapsed set row (rank, thumb, title, trailing figures) so nothing reflows when
 * the real rows land.
 */
function ScannerRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line-subtle px-3 py-3 last:border-b-0"
        >
          <Skeleton type="text" className="w-4 shrink-0" leafClassName="h-3" />
          <Skeleton type="avatar" className="w-auto shrink-0" leafClassName="size-8 rounded-md" />
          <Skeleton type="text" className="w-48 shrink-0" />
          <span className="min-w-0 flex-1" />
          <Skeleton type="text" className="w-16 shrink-0" />
          <Skeleton type="text" className="w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function ArbitrageComponentRow({
  component,
  targetValue,
  recentlyAdded,
  owned,
  onTargetChange,
  onAdd,
}: {
  component: ArbitrageScannerComponentEntry;
  targetValue: string;
  recentlyAdded: boolean;
  /** From the AlecaFrame inventory cache. 0 when no inventory is loaded. */
  owned: number;
  onTargetChange: (value: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const isDisabled = !component.itemKey || !targetValue.trim();

  return (
    <ScanItemRow
      imageUrl={resolveWfmAssetUrl(component.imagePath, component.slug)}
      fallback={component.name.slice(0, 1)}
      name={
        <>
          {component.quantityInSet}x{' '}
          <ItemName
            name={component.name}
            slug={component.slug}
            wfmId={component.itemKey ?? undefined}
            imagePath={component.imagePath}
          />
        </>
      }
      badges={
        <ScanPill tone={confidenceTone(component.confidenceSummary.level)}>
          {tConfidence(t, component.confidenceSummary)}
        </ScanPill>
      }
      metrics={[
        {
          label: t('scan.entryZone'),
          value: `${formatPlat(component.recommendedEntryLow)} - ${formatPlat(component.recommendedEntryHigh)}`,
        },
      ]}
      actions={
        <>
          {/* Owned vs needed, never a binary "owned" tick. Half a set is the common case and the
              useful number is the SHORTFALL — 1/3 and 3/3 are different decisions, and a tick
              would collapse them. Reads 0 when no inventory is loaded, which is honest: we do not
              know that you own none, we know we have not been told. */}
          <span
            className="shrink-0 font-mono text-[11px] tabular-nums"
            title={t('scan.ownedOfNeeded', { owned, needed: component.quantityInSet })}
          >
            <span className={owned > 0 ? 'text-accent-green' : 'text-ink-faint'}>{owned}</span>
            <span className="text-ink-faint">/{component.quantityInSet}</span>
          </span>
          <Input
            type="number"
            min="0"
            step="1"
            aria-label={t('wl.targetPriceFor', { item: component.name })}
            className="h-7 w-20 tabular-nums"
            value={targetValue}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => onTargetChange(event.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 border-line px-2 text-[11px]"
            disabled={isDisabled}
            onClick={onAdd}
          >
            {recentlyAdded ? t('wl.added') : t('common.add')}
          </Button>
        </>
      }
    />
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
  ownedQuantities,
  onAddMany,
}: {
  entry: ArbitrageScannerSetEntry;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  targetInputs: Record<string, string>;
  recentlyAddedKeys: Record<string, boolean>;
  onTargetChange: (component: ArbitrageScannerComponentEntry, value: string) => void;
  onAddToWatchlist: (component: ArbitrageScannerComponentEntry) => void;
  /** Owned counts from the inventory cache, keyed by component slug. */
  ownedQuantities: Map<string, number>;
  onAddMany: (components: ArbitrageScannerComponentEntry[]) => void;
}) {
  const { t } = useTranslation();
  const imageUrl = resolveWfmAssetUrl(entry.imagePath, entry.slug);
  // Short of the set requirement, not "not owned at all" — holding 1 of 3 still leaves 2 to buy.
  const unownedComponents = entry.components.filter(
    (component) => (ownedQuantities.get(component.slug) ?? 0) < (component.quantityInSet ?? 1),
  );

  return (
    <ListRow
      expanded={expanded}
      onToggle={onToggle}
      toggleLabel={expanded ? t('opp.collapseSet') : t('opp.expandSet')}
      head={
        <>
          <ScanRank index={index} />
          <ItemThumb src={imageUrl} fallback={entry.name.slice(0, 2)} size="size-9" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-ink">
                <ItemName
                  name={entry.name}
                  slug={entry.slug}
                  wfmId={entry.setItemKey}
                  imagePath={entry.imagePath}
                />
              </span>
              <ScanPill tone={confidenceTone(entry.confidenceSummary.level)}>
                {tConfidence(t, entry.confidenceSummary)}
              </ScanPill>
            </span>
            <span className="truncate font-mono text-[10px] font-normal text-ink-dim">
              {t('scan.partsAndLiquidity', {
                n: entry.componentCount,
                pct: `${Math.round(entry.liquidityScore)}%`,
              })}
            </span>
          </span>
          <RowMetric label={t('scan.buyIn')} value={formatPlat(entry.basketEntryCost)} />
          <RowMetric label={t('scan.sellAt')} value={formatPlat(entry.recommendedSetExitPrice)} />
          <RowMetric
            label={t('scan.margin')}
            value={formatPlat(entry.grossMargin)}
            tone={(entry.grossMargin ?? 0) >= 0 ? 'positive' : 'negative'}
          />
        </>
      }
      aside={
        <span className="rounded-md border border-line bg-bg-base px-2 py-1 font-mono text-xs font-semibold tabular-nums text-ink-soft">
          {formatPercent(entry.roiPct)} ROI
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-ink-dim">
        <span>
          {t('scan.exitZone')}{' '}
          <span className="text-ink">
            {formatPlat(entry.setExitLow)}–{formatPlat(entry.setExitHigh)}
          </span>
        </span>
        <span>
          {t('scan.score')} <span className="text-ink">{Math.round(entry.arbitrageScore)}</span>
        </span>
        <span>
          {t('scan.liquidity')} <span className="text-ink">{Math.round(entry.liquidityScore)}%</span>
        </span>
      </div>

      <ScanGroup
        label={t('scan.partsToBuy', { n: entry.componentCount })}
        actions={
          <>
            {/* Two buttons, because they answer different questions. "Add all" watches the whole
                set. "Add unowned" watches only what you are short of — which is what you actually
                want once you already hold half the parts, and is the reason the owned counts are
                on screen at all. */}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-ink-dim hover:text-ink"
              disabled={unownedComponents.length === 0}
              title={unownedComponents.length === 0 ? t('scan.allOwned') : t('scan.addUnownedHint')}
              onClick={() => onAddMany(unownedComponents)}
            >
              {t('scan.addUnowned')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 border-line px-2.5 text-[11px]"
              onClick={() => onAddMany(entry.components)}
            >
              {t('scan.addAll')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          {entry.components.map((component) => (
            <ArbitrageComponentRow
              key={`${entry.slug}-${component.slug}`}
              component={component}
              targetValue={targetInputs[component.slug] ?? getDefaultComponentTarget(component)}
              recentlyAdded={Boolean(recentlyAddedKeys[component.slug])}
              owned={ownedQuantities.get(component.slug) ?? 0}
              onTargetChange={(value) => onTargetChange(component, value)}
              onAdd={() => onAddToWatchlist(component)}
            />
          ))}
        </div>
      </ScanGroup>
    </ListRow>
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
  const imageUrl = resolveWfmAssetUrl(drop.imagePath, drop.slug);
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
    <ScanItemRow
      imageUrl={imageUrl}
      fallback={drop.name.slice(0, 1)}
      name={localizeName(drop)}
      badges={
        <>
          {drop.rarity ? <ScanPill tone="blue">{drop.rarity}</ScanPill> : null}
          <ScanPill tone={confidenceTone(drop.confidenceSummary.level)}>
            {tConfidence(t, drop.confidenceSummary)}
          </ScanPill>
        </>
      }
      metrics={[
        { label: t('scan.chance'), value: formatChance(chance) },
        {
          label: t('scan.optimalExit'),
          value: `${formatPlat(drop.recommendedExitLow)} - ${formatPlat(drop.recommendedExitHigh)}`,
        },
        // Chance × exit price: what this drop is worth to a run on average, which is the number
        // that decides whether a relic is worth running at all.
        { label: t('scan.ev'), value: formatPlat(expectedContribution) },
      ]}
    />
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
  const imageUrl = resolveWfmAssetUrl(entry.imagePath, entry.slug, entry.name);
  const summary = getRelicRefinementSummary(entry, refinementKey);

  // Highest-value drop at the active refinement — the single most useful fact about a relic,
  // previously hidden until the row was expanded.
  const bestDrop = [...(entry.drops ?? [])]
    .sort((a, b) => (b.recommendedExitPrice ?? 0) - (a.recommendedExitPrice ?? 0))[0];

  return (
    <ListRow
      expanded={expanded}
      onToggle={onToggle}
      toggleLabel={expanded ? t('opp.collapseSet') : t('opp.expandSet')}
      head={
        <>
          <ScanRank index={index} />
          {/* Relic art draws no thumbnail chrome — it is a shaped icon on transparency, so a box
              around it reads as a chip drawn over a picture (`ELEMENTS.md` §7). */}
          <ItemThumb src={imageUrl} fallback={entry.name.slice(0, 2)} size="size-9" chrome={false} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-ink">
                <ItemName
                  name={entry.name}
                  slug={entry.slug}
                  wfmId={entry.relicItemId}
                  imagePath={entry.imagePath}
                />
              </span>
              <ScanPill tone={entry.isUnvaulted ? 'green' : 'amber'}>
                {entry.isUnvaulted ? t('scan.unvaulted') : t('scan.vaulted')}
              </ScanPill>
            </span>
            {/* The best drop at the active refinement — the single most useful fact about a
                relic, and it used to be hidden until the row was expanded. */}
            <span className="truncate font-mono text-[10px] font-normal text-ink-dim">
              {bestDrop
                ? t('scan.bestDrop', {
                    name: bestDrop.name,
                    price: formatPlat(bestDrop.recommendedExitPrice),
                  })
                : tConfidence(t, summary?.confidenceSummary ?? entry.confidenceSummary)}
            </span>
          </span>
          <RowMetric
            label={t('scan.runValueLabel')}
            value={formatPlatPrecise(summary?.runValue ?? null)}
            tone="positive"
          />
          <RowMetric
            label={t('scan.liquidity')}
            value={`${Math.round(summary?.liquidityScore ?? 0)}%`}
            width="w-14"
          />
        </>
      }
      aside={
        <ScanPill tone="blue">
          {t('opp.runRefinement', { refinement: tHealth(t, summary?.refinementLabel) || '—' })}
        </ScanPill>
      }
    >
      <MetricGrid columns={4}>
        <Metric label={t('scan.refinement')} value={tHealth(t, summary?.refinementLabel) || '—'} />
        <Metric label={t('scan.runValue')} value={formatPlatPrecise(summary?.runValue ?? null)} />
        <Metric label={t('scan.liquidity')} value={`${Math.round(summary?.liquidityScore ?? 0)}%`} />
        <Metric label={t('scan.drops')} value={entry.dropCount} />
      </MetricGrid>

      <ScanGroup
        label={t('scan.primeRewards')}
        meta={t('scan.ratesApplied', {
          label: summary?.refinementLabel
            ? tHealth(t, summary.refinementLabel)
            : t('scan.selectedRefinement'),
        })}
      >
        <div className="flex flex-col gap-1.5">
          {entry.drops.map((drop) => (
            <RelicDropRow
              key={`${entry.slug}-${refinementKey}-${drop.slug}`}
              drop={drop}
              refinementKey={refinementKey}
            />
          ))}
        </div>
      </ScanGroup>
    </ListRow>
  );
}

export function ScannersPage() {
  const { t } = useTranslation();
  // Sub-view selection lives in the store: the sidebar renders this page's sub-navigation.
  const activeTab = useAppStore((s) => s.scannersSubTab);
  const [arbitrage, setArbitrage] = useState<ArbitrageScannerResponse | null>(null);
  /** Owned prime-part counts, so "add to watchlist" can want only the shortfall. Best-effort:
   *  an empty map simply means "own nothing", which watches the full requirement. */
  const [ownedPartQuantities, setOwnedPartQuantities] = useState<Map<string, number>>(new Map());
  const [progress, setProgress] = useState<ArbitrageScannerProgress | null>(null);
  const [scannerError, setScannerError] = useState<ScannerErrorState | null>(null);
  /**
   * Whether the first `getArbitrageScannerState()` call has come back — success OR failure.
   *
   * Needed because `arbitrage === null` means two different things: "we have not asked yet" and
   * "there is genuinely no saved scan". Skeletoning on the second would be a fake loading state
   * that never resolves. This flips exactly once, on a real response.
   */
  const [scannerStateLoaded, setScannerStateLoaded] = useState(false);
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
    } finally {
      // `finally`, not the success branch: a failed load has still finished loading, and leaving
      // the skeleton up would hide the error the catch block just set.
      if (scannerEffectActiveRef.current) {
        setScannerStateLoaded(true);
      }
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

  /**
   * "Add all" / "Add unowned" — the same single-component path in a loop, deliberately.
   *
   * Reusing it means the shortfall maths, the target-price parsing and the per-row "added"
   * feedback stay in one place; a separate bulk implementation would drift from the single one
   * the first time either changed. Components with no `itemKey` or an unusable target are skipped
   * by that path already, so a partial set adds what it can rather than failing wholesale.
   */
  const addComponentsToWatchlist = (components: ArbitrageScannerComponentEntry[]) => {
    for (const component of components) {
      addComponentToWatchlist(component);
    }
  };

  // While a scan runs the stamp shows live progress; otherwise it's the elapsed time since the
  // last finished scan, with the full timestamp on hover.
  const lastScanAt = arbitrage?.scanFinishedAt ?? progress?.lastCompletedAt ?? null;
  const lastScanLabel = isRunning
    ? `${Math.round(progress?.progressValue ?? 0)}%`
    : lastScanAt
      ? formatElapsedTime(lastScanAt)
      : t('scan.noSavedScan');
  const lastScanTitle = lastScanAt
    ? t('common.updatedAt', { time: formatShortLocalDateTime(lastScanAt) })
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
      <PageHeading
        page="scanners"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2" title={t('scan.autoScanHelp')}>
              <span className="text-[11px] text-ink-dim">{t('scan.autoScan')}</span>
              <Switch
                tone="positive"
                checked={autoScanEnabled}
                aria-label={t('scan.autoScan')}
                onCheckedChange={setAutoScanEnabled}
              />
            </label>
            <span
              className="font-mono text-[10px] tracking-[0.04em] text-ink-dim"
              title={lastScanTitle ?? undefined}
            >
              {lastScanLabel}
            </span>
            <Button
              variant={isRunning ? 'outline' : 'default'}
              size="sm"
              onClick={() => {
                if (isRunning) {
                  void stopArbitrageScan();
                  return;
                }
                void runArbitrageScan();
              }}
            >
              <i className={`ti ${isRunning ? 'ti-player-pause' : 'ti-radar'}`} aria-hidden="true" />
              {isRunning ? t('scan.stopScan') : actionLabel}
            </Button>
          </div>
        }
      />

      {/* `[&>*]:shrink-0` — `.page-content` is `flex: 1` + `overflow-y: auto`, so without it the
          browser squashes short children instead of scrolling. See the handoff's traps. */}
      <PageContent stack>
        <div className="flex min-w-0 flex-col gap-3">
            {/* Above the scanner's own status: this is the baseline both tabs now fall back to
                for items no scan has reached, so it belongs before the scan-specific counts. */}
            <PriceHistoryBar />
            <Panel className="flex-row flex-wrap items-center gap-4 px-3 py-2.5">
              <div className="flex min-w-40 flex-1 items-center gap-2">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-bg-base">
                  {/* Plots the scanner's real `progressValue`. The bar is the only motion on this
                      strip, and it is driven by a running scan, never by a poll. */}
                  <span
                    className={`block h-full rounded-full transition-[width] duration-300 ease-out ${
                      isRunning ? 'bg-accent-blue' : 'bg-line-strong'
                    }`}
                    style={{ width: `${Math.max(0, Math.min(100, progress?.progressValue ?? 0))}%` }}
                  />
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-soft">
                  {Math.round(progress?.progressValue ?? 0)}%
                </span>
              </div>
              {arbitrage ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-ink-dim">
                  {(
                    [
                      [arbitrage.scannedSetCount, t('scan.sets')],
                      [arbitrage.scannedComponentCount, t('scan.components')],
                      [arbitrage.scannedRelicCount, t('scan.relics')],
                    ] as const
                  ).map(([count, label]) => (
                    <span key={label}>
                      <span className="font-semibold text-ink">{count}</span> {label}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="font-mono text-[10px] text-ink-faint">{t('scan.noSavedScan')}</span>
              )}
            </Panel>

            {showInlineScannerNotice && scannerError ? (
              <p
                role="alert"
                className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-relaxed ${
                  scannerError.tone === 'warning'
                    ? 'border-accent-amber/25 bg-accent-amber/8 text-accent-amber'
                    : 'border-accent-red/25 bg-accent-red/8 text-accent-red'
                }`}
              >
                <i className="ti ti-alert-triangle mt-px shrink-0 text-sm" aria-hidden="true" />
                <span className="min-w-0 flex-1">{scannerError.message}</span>
                {scannerErrorAction ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    static
                    onClick={scannerErrorAction.onClick}
                    className="-my-0.5 h-5 shrink-0 px-1.5 text-[10px] text-current hover:bg-white/10 hover:text-current"
                  >
                    {scannerErrorAction.label}
                  </Button>
                ) : null}
              </p>
            ) : null}

            {/* `|| !scannerStateLoaded` so the list shell (and its skeleton) renders while the
                first state call is still out. Gating on `arbitrage` alone made the skeleton
                unreachable — `arbitrage` is null for exactly the period the skeleton is for. */}
            {activeTab === 'arbitrage' && (arbitrage || !scannerStateLoaded) ? (
              <div className="flex min-w-0 flex-col gap-2">
                <ScanSummary
                  icon="ti-radar"
                  title={t('scan.setsWorthFlipping', { n: arbitrageResults.length })}
                  subtitle={t('scan.flipSubtitle')}
                  stats={[
                    {
                      label: t('scan.bestMargin'),
                      value: formatPlat(arbitrageResults[0]?.grossMargin ?? null),
                    },
                    {
                      label: t('scan.bestRoi'),
                      value: formatPercent(arbitrageResults[0]?.roiPct ?? null),
                      positive: true,
                    },
                  ]}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <ScanSearch
                    value={arbitrageSearch}
                    placeholder={t('scan.searchSetsOrParts')}
                    onChange={setArbitrageSearch}
                  />
                </div>
                {!scannerStateLoaded ? (
                  <ScannerRowsSkeleton />
                ) : arbitrageResults.length > 0 ? (
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
                  ownedQuantities={ownedPartQuantities}
                  onAddMany={addComponentsToWatchlist}
                    />
                  ))
                ) : (
                  <EmptyState icon="ti-search-off" title={t('scan.noSets')} detail={t('scan.tryAnotherSet')} />
                )}
              </div>
            ) : activeTab === 'relic-roi' && (arbitrage || !scannerStateLoaded) ? (
              /* The search and filters render whatever the result count is. They used to sit
                 INSIDE `relicResults.length > 0`, so searching something with no matches removed
                 the search box along with the rows — leaving no way to change or clear the query
                 that caused it. Only the ROWS swap for the empty state now. */
              <div className="flex min-w-0 flex-col gap-2">
                  <ScanSummary
                    icon="ti-flame"
                    title={t('scan.relicsRanked2', { n: relicResults.length })}
                    subtitle={t('scan.relicSubtitle')}
                    stats={[
                      {
                        label: t('scan.bestRun'),
                        value:
                          relicResults.length > 0
                            ? formatPlatPrecise(
                                getRelicRefinementSummary(relicResults[0], relicRefinement)?.runValue ??
                                  null,
                              )
                            : '—',
                        positive: true,
                      },
                    ]}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <ScanSearch
                      value={relicSearch}
                      placeholder={t('scan.searchRelicsOrDrops')}
                      onChange={setRelicSearch}
                    />
                    <label className="flex shrink-0 items-center gap-1.5">
                      <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
                        {t('scan.refinement')}
                      </span>
                      <Select
                        className="h-8 w-32"
                        value={relicRefinement}
                        onChange={(event) =>
                          setRelicRefinement(event.target.value as RelicRefinementKey)
                        }
                      >
                        {RELIC_REFINEMENT_KEYS.map((key) => (
                          <option key={key} value={key}>
                            {t(RELIC_REFINEMENT_LABEL_KEYS[key])}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="flex shrink-0 cursor-pointer items-center gap-2">
                      <span className="text-[11px] text-ink-dim">{t('scan.unvaultedOnly')}</span>
                      <Switch
                        tone="positive"
                        checked={showOnlyUnvaulted}
                        aria-label={t('scan.unvaultedOnly')}
                        onCheckedChange={setShowOnlyUnvaulted}
                      />
                    </label>
                  </div>
                  {!scannerStateLoaded ? (
                    <ScannerRowsSkeleton rows={5} />
                  ) : relicResults.length > 0 ? (
                    relicResults.map((entry, index) => (
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
                    ))
                  ) : (
                    <EmptyState
                      icon={normalizedRelicSearch ? 'ti-search' : 'ti-diamond'}
                      title={
                        normalizedRelicSearch
                          ? t('scan.noRelicsMatchSearch')
                          : showOnlyUnvaulted
                            ? t('scan.noUnvaultedResults')
                            : t('scan.noRelicRoiRows')
                      }
                    />
                  )}
                </div>
            ) : showBlockingScannerEmptyState && scannerError ? (
              <EmptyState
                icon="ti-alert-triangle"
                title={t('scan.dataCouldNotLoad')}
                detail={scannerError.message}
                action={
                  scannerErrorAction ? (
                    <Button variant="outline" size="sm" onClick={scannerErrorAction.onClick}>
                      {scannerErrorAction.label}
                    </Button>
                  ) : null
                }
              />
            ) : !isRunning ? (
              <EmptyState
                icon={normalizedArbitrageSearch ? 'ti-search-off' : 'ti-radar'}
                title={
                  normalizedArbitrageSearch
                    ? t('scan.noSetsMatchSearch')
                    : t('scan.noCachedResults')
                }
                detail={
                  normalizedArbitrageSearch
                    ? t('scan.tryAnotherSetSearch')
                    : t('scan.startScanFirstResult')
                }
                action={
                  !normalizedArbitrageSearch ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        void runArbitrageScan();
                      }}
                    >
                      {actionLabel}
                    </Button>
                  ) : null
                }
              />
            ) : null}
        </div>
      </PageContent>
    </>
  );
}
