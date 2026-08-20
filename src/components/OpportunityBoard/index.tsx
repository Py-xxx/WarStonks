import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';

import { OpportunityCard } from '../OpportunityCard';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { formatElapsedTime } from '../../lib/dateTime';
import { buildOpportunityQueue } from '../../lib/opportunitySnipes';
import type { Opportunity } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';

const REFRESH_INTERVAL_MS = 30_000;

/**
 * The board is a grid of cards, as it shipped: `repeat(auto-fill, minmax(320px, 1fr))`.
 *
 * A stacked list reads more densely, but a play is a self-contained decision with its own reasons
 * and its own buttons — the grid is what makes each one a unit you can take in at a glance, and it
 * uses the width a desktop window actually has. 320px is the floor at which a title, a value and
 * two action chips still fit on their own lines.
 */
const GRID_CLASS = 'grid gap-3 p-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]';

// Intent-based filters (not strictly category — "Farm" is any play with a farm action).
const BOARD_FILTERS: { id: string; match: (opp: Opportunity) => boolean }[] = [
  { id: 'all', match: () => true },
  { id: 'snipe', match: (opp) => opp.category === 'snipe' },
  { id: 'complete', match: (opp) => opp.category === 'setCompletion' },
  { id: 'sell', match: (opp) => opp.category === 'sellInventory' },
  { id: 'farm', match: (opp) => opp.actions.some((a) => a.kind === 'farmRelic') },
  { id: 'flip', match: (opp) => opp.category === 'flip' },
  { id: 'reprice', match: (opp) => opp.category === 'reprice' },
];

/** Card-shaped placeholders. Same box model as `OpportunityCard` — art, two title lines, value,
 *  two reason rows, a footer — so nothing shifts when the real board lands. */
function BoardSkeleton() {
  return (
    <div className={GRID_CLASS}>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-lg border border-l-[3px] border-line-strong bg-bg-elevated p-3.5"
        >
          <div className="flex items-start gap-3">
            <Skeleton type="avatar" className="w-auto shrink-0" leafClassName="size-12 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton type="text" className="w-48" />
              <Skeleton type="text" className="w-32" />
            </div>
            <Skeleton type="text" className="w-16 shrink-0" />
          </div>
          <Skeleton type="text@2" />
          <Skeleton type="button" className="w-auto" leafClassName="h-7 w-28" />
        </div>
      ))}
    </div>
  );
}

/**
 * The Opportunities board — every play the engine found, ranked, with the reasoning shown.
 *
 * Home's "Act now" is the compressed view of this list; both read the same queue from
 * `lib/opportunitySnipes` and render the same `OpportunityCard` parts, so the two surfaces cannot
 * disagree about what a play is worth or what colour it is.
 *
 * What only exists here: accepting a play (pinning it so a recompute can't drop it), hiding one,
 * and the filters.
 */
export function OpportunityBoard() {
  const { t } = useTranslation();
  const opportunities = useAppStore((state) => state.opportunities);
  const underpricedListings = useAppStore((state) => state.underpricedListings);
  const loading = useAppStore((state) => state.opportunitiesLoading);
  const error = useAppStore((state) => state.opportunitiesError);
  const loadedAt = useAppStore((state) => state.opportunitiesLoadedAt);
  const loadCached = useAppStore((state) => state.loadCachedOpportunities);
  const refresh = useAppStore((state) => state.refreshOpportunities);
  const pinnedOpportunities = useAppStore((state) => state.pinnedOpportunities);
  const pin = useAppStore((state) => state.pinOpportunity);
  const unpin = useAppStore((state) => state.unpinOpportunity);
  const dismissedKeys = useAppStore((state) => state.dismissedOpportunityKeys);
  const dismiss = useAppStore((state) => state.dismissOpportunity);
  const restoreDismissed = useAppStore((state) => state.restoreDismissedOpportunities);
  const [activeFilter, setActiveFilter] = useState('all');
  const [budget, setBudget] = useState('');

  // Pinned ("accepted") plays sit on top and never disappear; the rest is the recompute minus
  // anything pinned or dismissed this session.
  const pinnedAll = useMemo(
    () => Object.values(pinnedOpportunities).sort((a, b) => b.score - a.score),
    [pinnedOpportunities],
  );
  const unpinnedAll = useMemo(
    () =>
      buildOpportunityQueue(opportunities, underpricedListings, dismissedKeys).filter(
        (opp) => !(opp.subjectKey in pinnedOpportunities),
      ),
    [opportunities, underpricedListings, dismissedKeys, pinnedOpportunities],
  );

  // Budget filter — only show plays whose upfront buy-in fits (sell/farm/reprice cost 0, always pass).
  const budgetNum = budget.trim() ? Number.parseInt(budget, 10) : null;
  const budgetMatch = (opp: Opportunity) =>
    budgetNum === null || !Number.isFinite(budgetNum) || opp.cost <= budgetNum;

  const activeMatch =
    BOARD_FILTERS.find((filter) => filter.id === activeFilter)?.match ?? (() => true);
  const matches = (opp: Opportunity) => activeMatch(opp) && budgetMatch(opp);
  const pinnedList = pinnedAll.filter(matches);
  const unpinnedList = unpinnedAll.filter(matches);
  const pricedAt = opportunities.find((opp) => opp.pricedAt)?.pricedAt ?? null;

  // Only show a filter when something matches it (plus "All" and whichever is selected), with the
  // count on the chip — an empty filter is a dead end you can only find by clicking it.
  const filters = useMemo(() => {
    const combined = [...pinnedAll, ...unpinnedAll];
    return BOARD_FILTERS.map((filter) => ({
      ...filter,
      count: combined.filter(filter.match).length,
    })).filter((filter) => filter.id === 'all' || filter.id === activeFilter || filter.count > 0);
  }, [pinnedAll, unpinnedAll, activeFilter]);

  // Stale-while-revalidate: paint the last persisted board instantly, then recompute. A slow timer
  // keeps it fresh while open (the backend computes from caches, so this is cheap).
  useEffect(() => {
    void loadCached();
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadCached, refresh]);

  const nothing = pinnedList.length === 0 && unpinnedList.length === 0;
  // A refresh over a board the user is already reading must not skeleton it away; only a board
  // that has never been computed is genuinely loading.
  const firstLoad = nothing && loadedAt === null;
  const filtered = activeFilter !== 'all' || budgetNum !== null;

  return (
    <Panel className="gap-0">
      <PanelHeader>
        <PanelTitle variant="heading">{t('opp.whatToDoNow')}</PanelTitle>
        <div className="flex items-center gap-3">
          {pricedAt ? (
            <span
              className="font-mono text-[10px] text-ink-faint tabular-nums"
              title={t('a11y.pricesLastComputed')}
            >
              {t('opp.pricesElapsed', { time: formatElapsedTime(pricedAt) })}
            </span>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? t('opp.scanning') : t('common.refresh')}
          </Button>
        </div>
      </PanelHeader>

      {/* Filters and budget survive their own empty result — only the rows below swap out. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('a11y.filterOpportunities')}>
          {filters.map((filter) => {
            const active = activeFilter === filter.id;
            return (
              <Button
                key={filter.id}
                variant="ghost"
                size="sm"
                static
                aria-pressed={active}
                onClick={() => setActiveFilter(filter.id)}
                className={`h-7 gap-1.5 rounded-md px-2.5 text-[11px] font-medium ${
                  active ? 'bg-bg-elevated text-ink' : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink'
                }`}
              >
                {t(`oppf.${filter.id}` as TranslationKey)}
                <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                  {filter.count}
                </span>
              </Button>
            );
          })}
        </div>

        <label className="ml-auto flex items-center gap-2 text-[11px] text-ink-dim">
          {t('wl.budget')}
          <span className="relative">
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              className="h-7 w-20 pr-5 text-right tabular-nums"
              placeholder={t('a11y.any')}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center font-mono text-[10px] text-ink-faint">
              p
            </span>
          </span>
        </label>
      </div>

      {error ? (
        <div className="border-b border-line bg-accent-red/[0.06] px-3 py-2 text-[11px] text-accent-red">
          {error}
        </div>
      ) : null}

      {firstLoad ? (
        <BoardSkeleton />
      ) : nothing ? (
        filtered ? (
          <EmptyState icon="ti-filter-off" title={t('opp.nothingMatchesFiltersShort')} />
        ) : (
          <EmptyState
            icon="ti-checks"
            tone="positive"
            title={t('opp.noStandoutMovesShort')}
            detail={t('opp.noStandoutMovesDetail')}
          />
        )
      ) : (
        <>
          {pinnedList.length > 0 ? (
            <>
              <SectionLabel>{t('wl.accepted')}</SectionLabel>
              <div className={GRID_CLASS}>
                {pinnedList.map((opp) => (
                  <OpportunityCard
                    key={opp.id}
                    opportunity={opp}
                    pinned
                    onPin={() => unpin(opp.subjectKey)}
                    onDismiss={() => dismiss(opp.subjectKey)}
                  />
                ))}
              </div>
            </>
          ) : null}

          {unpinnedList.length > 0 ? (
            <>
              {pinnedList.length > 0 ? <SectionLabel>{t('wl.more')}</SectionLabel> : null}
              <div className={GRID_CLASS}>
                {unpinnedList.map((opp) => (
                  <OpportunityCard
                    key={opp.id}
                    opportunity={opp}
                    onPin={() => pin(opp)}
                    onDismiss={() => dismiss(opp.subjectKey)}
                  />
                ))}
              </div>
            </>
          ) : null}
        </>
      )}

      {dismissedKeys.size > 0 ? (
        <div className="flex justify-center border-t border-line px-3 py-2">
          <Button variant="ghost" size="sm" onClick={() => restoreDismissed()}>
            {t('opp.restoreHidden', { n: dismissedKeys.size })}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-3 pt-3 font-mono text-[10px] font-bold tracking-[0.08em] text-ink-dim uppercase">
      {children}
    </span>
  );
}
