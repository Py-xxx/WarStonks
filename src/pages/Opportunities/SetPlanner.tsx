import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';

import { DetailGroup, ItemThumb, ListRow, RowMetric } from '../../components/ListRow';
import { ItemName } from '../../components/ItemName';
import { useTranslation } from '../../i18n';
import { tConfidence } from '../../lib/healthLabels';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import type { ArbitrageScannerComponentEntry } from '../../types';
import { formatPlat } from './farmNowModel';
import type {
  PlannerComponentState,
  PlannerOwnedRelicHint,
  PlannerSetEntry,
  SetPlannerGate,
} from './setPlannerModel';

/**
 * Inventory → Set Completion Planner: the sets you are part-way through, what finishing each one
 * costs, and what it is worth when you do.
 *
 * **This is a migration, not a redesign.** Every behaviour is the one that shipped; what changes is
 * that the page is built from the primitives and from the row furniture What To Farm Now
 * established (`components/ListRow`), so the three list pages in this part of the app read as one
 * product rather than three. The accordion is kept deliberately.
 */

const PROGRESS_TONE: Record<string, string> = {
  complete: 'bg-accent-green',
  high: 'bg-accent-blue',
  low: 'bg-accent-amber',
};

export type SetPlannerProps = {
  gate: SetPlannerGate;
  errorMessage: string | null;
  entries: PlannerSetEntry[];
  expandedSlug: string | null;
  onToggle: (slug: string) => void;

  summary: {
    profitableSetCount: number;
    expectedInvestment: number;
    expectedValue: number;
    expectedProfit: number;
  };

  targetInputs: Record<string, string>;
  ownedRelicHints: Map<string, PlannerOwnedRelicHint[]>;
  recentlyAddedKeys: Record<string, boolean>;
  onTargetChange: (component: ArbitrageScannerComponentEntry, value: string, setSlug: string) => void;
  onAddToWatchlist: (
    component: ArbitrageScannerComponentEntry,
    setSlug: string,
    missingQuantity: number,
  ) => void;
  onFarmComponent: (component: ArbitrageScannerComponentEntry) => void;
  onSellSet: (planner: PlannerSetEntry) => void;
  onOpenScanners: () => void;

  defaultTargetFor: (component: ArbitrageScannerComponentEntry) => string;
  localizeName: (item: { name: string; slug?: string | null }) => string;
};

/** Set-completion progress. Plots `ownedPartsCount / totalPartsNeeded` — a real value, and the one
 *  the row is sorted and judged on. */
function ProgressBar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-bg-base" aria-hidden="true">
      <span
        className={`block h-full rounded-full ${PROGRESS_TONE[tone] ?? PROGRESS_TONE.low}`}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

/** Row-shaped placeholders, matching the collapsed row's height and columns. */
function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2.5"
        >
          <Skeleton type="avatar" className="w-auto shrink-0" leafClassName="size-9 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton type="text" className="w-44" />
            <Skeleton type="text" className="w-32" />
          </div>
          <Skeleton type="text" className="w-16 shrink-0" />
          <Skeleton type="text" className="w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A component you still need: what it costs, how many you hold, and the two ways to get it. */
function MissingComponentRow({
  componentState,
  target,
  relicHints,
  added,
  onTargetChange,
  onAddToWatchlist,
  onFarmComponent,
}: {
  componentState: PlannerComponentState;
  target: string;
  relicHints: PlannerOwnedRelicHint[];
  added: boolean;
  onTargetChange: (value: string) => void;
  onAddToWatchlist: () => void;
  onFarmComponent: () => void;
}) {
  const { t } = useTranslation();
  const { component } = componentState;
  const ownedRelicCount = relicHints.reduce((sum, hint) => sum + hint.totalCount, 0);

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-sm border border-line-subtle bg-bg-panel px-2 py-1.5">
      <ItemThumb
        src={resolveWfmAssetUrl(component.imagePath, component.slug)}
        fallback={component.name.slice(0, 1)}
        size="size-7"
      />

      <div className="flex min-w-40 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-medium text-ink">
            <ItemName
              name={component.name}
              slug={component.slug}
              wfmId={component.itemKey ?? undefined}
              imagePath={component.imagePath}
            />
          </span>
          {component.quantityInSet > 1 ? (
            <span className="shrink-0 rounded bg-accent-amber/15 px-1 py-px font-mono text-[9px] font-semibold text-accent-amber tabular-nums">
              {t('opp.needQty', { n: component.quantityInSet })}
            </span>
          ) : null}
        </span>

        <span className="flex flex-wrap items-center gap-x-1.5 font-mono text-[10px] text-ink-faint tabular-nums">
          <span>
            {t('opp.buyZone')} {formatPlat(component.recommendedEntryLow)}–
            {formatPlat(component.recommendedEntryHigh)}
          </span>
          <span aria-hidden="true">·</span>
          {/* Owned is a shortfall, not a tick — 1/3 and 3/3 are different decisions. */}
          <span>
            {component.quantityInSet > 1
              ? t('opp.haveOfNeed', {
                  have: componentState.coveredQuantity,
                  need: component.quantityInSet,
                })
              : t('opp.ownedOfTotal', {
                  owned: componentState.coveredQuantity,
                  total: component.quantityInSet,
                })}
          </span>
          {relicHints.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              {/* You may not need to buy this at all — this is the "or farm it" answer, and it
                  carries you to the odds for the relics you actually hold. */}
              <Button
                variant="ghost"
                size="sm"
                static
                onClick={onFarmComponent}
                title={t('opp.farmThisItemHint', { item: component.name })}
                className="h-5 rounded px-1.5 font-mono text-[10px] text-accent-amber tabular-nums hover:bg-accent-amber/15"
              >
                <i className="ti ti-diamond" aria-hidden="true" />
                {t('opp.relicsOwnedShort', { n: ownedRelicCount })}
              </Button>
            </>
          ) : null}
        </span>
      </div>

      <label className="flex shrink-0 items-center gap-1.5">
        <span className="font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
          {t('wl.target')}
        </span>
        <Input
          type="number"
          min={1}
          step={1}
          className="h-7 w-16 text-right tabular-nums"
          value={target}
          onChange={(event) => onTargetChange(event.target.value)}
          aria-label={t('wl.targetPriceFor', { item: component.name })}
        />
      </label>

      {added ? (
        <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] font-semibold text-accent-green">
          <i className="ti ti-check" aria-hidden="true" />
          {t('wl.addedToWatchlist')}
        </span>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={!target.trim() || !component.itemKey}
          onClick={onAddToWatchlist}
          className="h-7 shrink-0 border-line text-[11px]"
        >
          <i className="ti ti-plus" aria-hidden="true" />
          {t('wl.addToWatchlist')}
        </Button>
      )}
    </div>
  );
}

function OwnedComponentRow({
  componentState,
}: {
  componentState: PlannerComponentState;
}) {
  const { t } = useTranslation();
  const { component } = componentState;
  return (
    <div className="flex items-center gap-2.5 rounded-sm border border-line-subtle bg-bg-panel px-2 py-1.5">
      <ItemThumb
        src={resolveWfmAssetUrl(component.imagePath, component.slug)}
        fallback={component.name.slice(0, 1)}
        size="size-7"
      />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">
        <ItemName
          name={component.name}
          slug={component.slug}
          wfmId={component.itemKey ?? undefined}
          imagePath={component.imagePath}
        />
      </span>
      {component.quantityInSet > 1 ? (
        <span className="shrink-0 rounded bg-bg-elevated px-1 py-px font-mono text-[9px] font-semibold text-ink-dim tabular-nums">
          {t('opp.needQty', { n: component.quantityInSet })}
        </span>
      ) : null}
      <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-semibold text-accent-green tabular-nums">
        <i className="ti ti-check" aria-hidden="true" />
        {componentState.coveredQuantity} / {component.quantityInSet}
      </span>
    </div>
  );
}

function SetRow({
  planner,
  expanded,
  onToggle,
  props,
}: {
  planner: PlannerSetEntry;
  expanded: boolean;
  onToggle: () => void;
  props: SetPlannerProps;
}) {
  const { t } = useTranslation();
  const isComplete =
    planner.totalPartsNeeded > 0 && planner.ownedPartsCount >= planner.totalPartsNeeded;
  const progressPct = planner.totalPartsNeeded
    ? Math.round((planner.ownedPartsCount / planner.totalPartsNeeded) * 100)
    : 0;
  const progressTone = isComplete ? 'complete' : progressPct >= 50 ? 'high' : 'low';

  const missing = planner.components.filter((component) => component.missingQuantity > 0);
  const owned = planner.components.filter((component) => component.missingQuantity === 0);

  return (
    <ListRow
      expanded={expanded}
      onToggle={onToggle}
      toggleLabel={expanded ? t('opp.collapseSet') : t('opp.expandSet')}
      tone={isComplete ? 'green' : undefined}
      head={
        <>
          <ItemThumb
            src={resolveWfmAssetUrl(planner.entry.imagePath, planner.entry.slug)}
            fallback={planner.entry.name.slice(0, 2)}
            size="size-9"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-xs font-semibold text-ink">
              {props.localizeName(planner.entry)}
            </span>
            <span className="flex items-center gap-2">
              <ProgressBar pct={progressPct} tone={progressTone} />
              <span className="font-mono text-[10px] font-normal text-ink-dim tabular-nums">
                {t('opp.partsOwned', {
                  owned: planner.ownedPartsCount,
                  total: planner.totalPartsNeeded,
                })}
              </span>
            </span>
          </span>
          <RowMetric label={t('opp.investment')} value={formatPlat(planner.remainingInvestment)} />
          <RowMetric
            label={t('opp.profit')}
            value={`${planner.completionProfit !== null && planner.completionProfit >= 0 ? '+' : ''}${formatPlat(planner.completionProfit)}`}
            tone={
              planner.completionProfit !== null && planner.completionProfit < 0
                ? 'negative'
                : 'positive'
            }
          />
        </>
      }
      aside={
        isComplete ? (
          // A finished set's status IS its next action, so the pill becomes the button rather
          // than sitting beside one.
          <Button
            variant="secondary"
            size="sm"
            onClick={() => props.onSellSet(planner)}
            title={t('opp.sellNowHint', { item: planner.entry.name })}
            className="h-7 border-accent-green/40 bg-accent-green/15 text-[11px] font-semibold text-accent-green hover:bg-accent-green/25"
          >
            <i className="ti ti-tag" aria-hidden="true" />
            {t('opp.sellNow')}
          </Button>
        ) : (
          <span className="font-mono text-[11px] text-ink-dim tabular-nums">
            {planner.completionRoiPct === null
              ? '—'
              : t('opp.roiValue', { value: Math.round(planner.completionRoiPct) })}
          </span>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-ink-dim tabular-nums">
        <span>
          {t('mkt.exit')}{' '}
          <strong className="text-ink">
            {formatPlat(planner.entry.recommendedSetExitPrice)}
          </strong>
        </span>
        <span>
          {t('opp.liquidity')}{' '}
          <strong className="text-ink">{Math.round(planner.entry.liquidityScore)}%</strong>
        </span>
        <span>
          {t('opp.confidence')}{' '}
          <strong className="text-ink">{tConfidence(t, planner.entry.confidenceSummary)}</strong>
        </span>
      </div>

      {missing.length > 0 ? (
        <DetailGroup label={t('opp.missingToBuy', { n: missing.length })} tone="primary">
          {missing.map((componentState) => {
            const key = `${planner.entry.slug}:${componentState.component.slug}`;
            const hints =
              (componentState.component.itemKey !== null
                ? props.ownedRelicHints.get(`item:${componentState.component.itemKey}`)
                : undefined) ??
              props.ownedRelicHints.get(`slug:${componentState.component.slug}`) ??
              [];
            return (
              <MissingComponentRow
                key={key}
                componentState={componentState}
                target={
                  props.targetInputs[key] ?? props.defaultTargetFor(componentState.component)
                }
                relicHints={hints}
                added={Boolean(props.recentlyAddedKeys[key])}
                onTargetChange={(value) =>
                  props.onTargetChange(componentState.component, value, planner.entry.slug)
                }
                onAddToWatchlist={() =>
                  props.onAddToWatchlist(
                    componentState.component,
                    planner.entry.slug,
                    componentState.missingQuantity,
                  )
                }
                onFarmComponent={() => props.onFarmComponent(componentState.component)}
              />
            );
          })}
        </DetailGroup>
      ) : null}

      {owned.length > 0 ? (
        <DetailGroup label={t('opp.ownedCount', { n: owned.length })} tone="muted">
          {owned.map((componentState) => (
            <OwnedComponentRow
              key={`${planner.entry.slug}:${componentState.component.slug}`}
              componentState={componentState}
            />
          ))}
        </DetailGroup>
      ) : null}
    </ListRow>
  );
}

export function SetPlanner(props: SetPlannerProps) {
  const { t } = useTranslation();
  const { gate, summary } = props;

  const renderGate = () => {
    switch (gate.kind) {
      case 'loading':
        return <RowsSkeleton />;
      case 'noScan':
        return (
          <EmptyState
            icon="ti-radar"
            title={t('opp.runArbitrageFirst')}
            detail={t('opp.arbitrageNeedScan')}
            action={
              <Button variant="secondary" size="sm" onClick={props.onOpenScanners}>
                {t('opp.openScanners')}
              </Button>
            }
          />
        );
      case 'noOwnedParts':
        return (
          <EmptyState
            icon="ti-box"
            title={t('opp.addOwnedParts')}
            detail={t('opp.ownedPartsDrawerDesc')}
          />
        );
      default:
        return null;
    }
  };

  const hasSummary = summary.profitableSetCount > 0;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* The headline. These four figures are the answer the page exists to give — what you are
          close to, what finishing costs, and what it returns — so they get `Stat`'s typographic
          jump rather than a line of meta text.
          Rendered for the whole `ready` state, zeros included: a strip that appears only once the
          numbers turn positive moves the list under the user's cursor the moment a scan lands. */}
      {gate.kind === 'ready' ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label={t('opp.profitableSets')}
            value={String(summary.profitableSetCount)}
            icon="ti-target"
            tone={hasSummary ? 'neutral' : 'muted'}
          />
          <Stat
            label={t('opp.investment')}
            value={formatPlat(summary.expectedInvestment)}
            icon="ti-shopping-cart"
            tone={hasSummary ? 'neutral' : 'muted'}
          />
          <Stat
            label={t('mkt.exit')}
            value={formatPlat(summary.expectedValue)}
            icon="ti-tag"
            tone={hasSummary ? 'neutral' : 'muted'}
          />
          <Stat
            label={t('opp.profit')}
            // Whole platinum: a headline figure carrying `.0` reads as precision it does not have.
            value={`${summary.expectedProfit >= 0 ? '+' : ''}${formatPlat(summary.expectedProfit)}`}
            icon="ti-trending-up"
            tone={hasSummary ? 'positive' : 'muted'}
          />
        </div>
      ) : null}

      <Panel className="gap-0">
        <PanelHeader>
          <PanelTitle variant="heading">{t('opp.setCompletionPlanner')}</PanelTitle>
        </PanelHeader>

        {props.errorMessage ? (
          <div className="border-b border-line bg-accent-red/[0.06] px-3 py-2 text-[11px] text-accent-red">
            {props.errorMessage}
          </div>
        ) : null}

        <div className="p-3">
          {gate.kind !== 'ready' ? (
            renderGate()
          ) : (
            <div className="flex flex-col gap-2">
              {props.entries.map((planner) => (
                <SetRow
                  key={planner.entry.slug}
                  planner={planner}
                  expanded={props.expandedSlug === planner.entry.slug}
                  onToggle={() => props.onToggle(planner.entry.slug)}
                  props={props}
                />
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
