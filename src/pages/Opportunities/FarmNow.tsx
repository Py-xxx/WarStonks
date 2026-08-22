import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

import { DetailGroup, ItemThumb, ListRow, RowMetric } from '../../components/ListRow';
import { InfoHint } from '../../components/InfoHint';
import { useTranslation } from '../../i18n';
import { formatElapsedTime } from '../../lib/dateTime';
import { tHealth } from '../../lib/healthLabels';
import type { DropOddsSummary } from '../../lib/relicDropOdds';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import {
  formatChance,
  formatPlat,
  formatPlatDecimal,
  relicRarityTone,
  relicRefinementTone,
  REFINEMENT_CLASS,
  RARITY_CLASS,
  type FarmNowGate,
  type FarmNowMode,
  type FarmNowRelicRow,
  type FarmNowSetCompletionRow,
  type RefinementGuidance,
} from './farmNowModel';

/**
 * "What To Farm Now" — which relic should I run right now, and at what refinement.
 *
 * The rebuild is about **order**, not decoration. What shipped read as messy for four structural
 * reasons, all fixed here:
 *
 * 1. The mode switch — the control that decides what every number on the page *means* — was the
 *    fourth thing you met, below two blocks of mode-dependent numbers. It is now the first.
 * 2. The drop-odds panel rendered **above** the search box that produces it, so typing a part name
 *    made a large panel appear upstream and shove the page down. An answer follows its question.
 * 3. A "top picks" strip printed the first three rows of the list immediately above the list.
 * 4. The gate ladder was a nine-deep nested ternary, written out once per mode. It is one
 *    `FarmNowGate` value now, rendered once.
 *
 * The page still owns the derivation (it joins three caches that live in its state); this file is
 * only the rendering, and the two agree through `./farmNowModel`.
 */

const ODDS_RELIC_PREVIEW_COUNT = 3;

export type FarmNowSuggestion = { label: string; kind: 'relic' | 'drop'; detail: string };

export type FarmNowDropOdds = DropOddsSummary & {
  targetName: string;
  targetSlug: string;
  exitPrice: number | null;
};

/** What `useLocalizedName` accepts. Kept structural so this file does not need the backend row
 *  types just to render a name. */
type NamedItem = { name: string; slug?: string | null };

export type FarmNowProps = {
  mode: FarmNowMode;
  onModeChange: (mode: FarmNowMode) => void;

  search: string;
  onSearchChange: (value: string) => void;
  suggestions: FarmNowSuggestion[];
  suggestOpen: boolean;
  onSuggestOpenChange: (open: boolean) => void;
  era: string;
  onEraChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;

  ownedRelicTotal: number;
  setsInProgress: number;
  missingComponentCount: number;
  relicsWorthRunning: number;
  bestRunProfit: number | null;
  lastScan: string | null;
  relicsRefreshing: boolean;
  onRunScan: () => void;

  dropOdds: FarmNowDropOdds | null;
  onFarmItem: (slug: string, name: string) => void;

  gate: FarmNowGate;
  errorMessage: string | null;
  partRows: FarmNowRelicRow[];
  setRows: FarmNowSetCompletionRow[];
  expandedKey: string | null;
  onToggleExpanded: (key: string) => void;
  activeFarmingRelicSlug: string | null;
  onFarmPartRelic: (row: FarmNowRelicRow) => void;
  onFarmSetRelic: (row: FarmNowSetCompletionRow) => void;

  onOpenScanners: () => void;
  onRetryRelics: () => void;
  onOpenOwnedRelics: () => void;
  onOpenInventory: () => void;

  localizeName: (item: NamedItem) => string;
};

/* ------------------------------------------------------------------ pieces */

/** `×3` when you hold some, "none owned" when you don't. Owned count is a shortfall, not a tick —
 *  a relic you own none of is still worth showing, because the answer may be "go get one". */
function OwnedPill({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
        count > 0 ? 'bg-accent-green/15 text-accent-green' : 'bg-bg-elevated text-ink-faint'
      }`}
    >
      {count > 0 ? t('opp.ownedTimes', { n: count }) : t('opp.noneOwned')}
    </span>
  );
}

/**
 * The refinement recommendation: which one to run, what each is worth, and how many you hold.
 *
 * `unit` switches the whole panel between platinum-per-run and chance-at-a-part, because when the
 * search targets a specific drop the question changes from "what earns most" to "what is likeliest
 * to give me that part".
 */
function RefinementGuidancePanel({
  guidance,
  unit,
  heading,
}: {
  guidance: RefinementGuidance;
  unit: 'plat' | 'pct';
  heading?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-bg-base p-2.5">
      <p className="text-[11px] text-ink-soft">
        <span className="font-semibold text-ink">
          {heading ?? (unit === 'plat' ? t('opp.bestPlatPerRun') : t('opp.chanceAtNeededPart'))}
        </span>{' '}
        {guidance.hint}
      </p>

      {/* Running what you already hold usually beats farming or refining fresh copies, so this
          is a real recommendation rather than a footnote. */}
      {guidance.ownedNote ? (
        <p className="text-[11px] text-accent-amber">
          {t('opp.youOwnRefine', {
            count: guidance.ownedNote.count,
            label: guidance.ownedNote.label,
          })}
        </p>
      ) : null}

      <div className="grid grid-cols-4 gap-1.5">
        {guidance.metrics.map((metric) => {
          const best = metric.key === guidance.bestKey;
          return (
            <div
              key={metric.key}
              className={`flex flex-col gap-0.5 rounded-sm border px-2 py-1.5 ${
                best ? 'border-accent-green/40 bg-accent-green/[0.07]' : 'border-line bg-bg-panel'
              }`}
            >
              <span className="truncate font-mono text-[9px] tracking-[0.06em] text-ink-dim uppercase">
                {metric.label}
              </span>
              <span
                className={`font-mono text-xs font-bold tabular-nums ${best ? 'text-accent-green' : 'text-ink'}`}
              >
                {metric.value === null
                  ? '—'
                  : unit === 'plat'
                    ? `${metric.value}p`
                    : formatChance(metric.value)}
              </span>
              <span className="font-mono text-[9px] text-ink-faint tabular-nums">
                {t('opp.ownedTimes', { n: metric.owned })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One drop inside an expanded relic: art, name, rarity, and whatever number the mode cares
 *  about. Rendered identically in both modes so a drop reads the same wherever you meet it. */
function DropRow({
  name,
  imageUrl,
  rarity,
  meta,
  badge,
  value,
  valueLabel,
}: {
  name: string;
  imageUrl: string | null;
  rarity: string | null;
  meta?: string;
  badge?: { text: string; tone: 'needed' | 'best' };
  value?: string;
  valueLabel?: string;
}) {
  const { t } = useTranslation();
  const tone = relicRarityTone(rarity);
  return (
    <div className="flex items-center gap-2.5 rounded-sm border border-line-subtle bg-bg-panel px-2 py-1.5">
      <ItemThumb src={imageUrl} fallback={name.slice(0, 1)} size="size-7" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-medium text-ink">{name}</span>
          {badge ? (
            <span
              className={`shrink-0 rounded px-1 py-px font-mono text-[9px] font-semibold tabular-nums ${
                badge.tone === 'needed'
                  ? 'bg-accent-amber/15 text-accent-amber'
                  : 'bg-accent-green/15 text-accent-green'
              }`}
            >
              {badge.text}
            </span>
          ) : null}
        </span>
        <span className="truncate font-mono text-[10px] text-ink-faint tabular-nums">
          <span className={RARITY_CLASS[tone]}>{rarity ?? t('opp.unknown')}</span>
          {meta ? ` · ${meta}` : ''}
        </span>
      </div>
      {value ? (
        <span className="flex shrink-0 flex-col items-end">
          {valueLabel ? (
            <span className="font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
              {valueLabel}
            </span>
          ) : null}
          <span className="font-mono text-xs font-bold text-ink tabular-nums">{value}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * Starting a farming run — the one action this whole tab exists to lead you to.
 *
 * **Amber, and a pill.** This is not an accent spent for decoration: amber is the farming
 * session's colour throughout the app — the floating session panel this button opens is
 * amber-bordered with an amber eyebrow — and the shipped `.fn-farm-this-btn` was an amber pill for
 * exactly that reason. An earlier pass ported it as a plain `secondary` chip, which made the
 * page's primary action look identical to "Copy" and easy to read straight past.
 *
 * The ring is the Expressive tier's one indulgence on this view: it gives the button presence
 * without motion, on a page where everything else is deliberately quiet.
 */
function FarmThisButton({
  active,
  onClick,
  label,
  size = 'default',
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  size?: 'sm' | 'default';
}) {
  return (
    <Button
      size={size}
      disabled={active}
      onClick={onClick}
      className={
        'w-fit rounded-full border-accent-amber/40 bg-accent-amber/15 font-semibold text-accent-amber ' +
        'ring-1 ring-accent-amber/10 ' +
        'hover:bg-accent-amber/25 hover:ring-accent-amber/25 ' +
        'disabled:ring-0'
      }
    >
      <i className="ti ti-flame" aria-hidden="true" />
      {label}
    </Button>
  );
}

/** Row-shaped placeholders. Matches the collapsed row's height and columns so nothing shifts. */
function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2.5"
        >
          <Skeleton type="avatar" className="w-auto shrink-0" leafClassName="size-9 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton type="text" className="w-40" />
            <Skeleton type="text" className="w-56" />
          </div>
          <Skeleton type="text" className="w-16 shrink-0" />
          <Skeleton type="text" className="w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ the tab */

export function FarmNow(props: FarmNowProps) {
  const { t } = useTranslation();
  const { mode, search, dropOdds, gate } = props;

  const modes: { id: FarmNowMode; label: string }[] = [
    { id: 'part-profit', label: t('opp.forPartProfit') },
    { id: 'set-completion', label: t('opp.forSetCompletion') },
  ];

  /** Every gate resolves to the same shape: a medallion, a line, and the one place that fixes it. */
  const renderGate = () => {
    switch (gate.kind) {
      case 'loading':
      case 'relicsLoading':
        return <RowsSkeleton />;
      case 'noScan':
        return (
          <EmptyState
            icon="ti-radar"
            title={t('opp.runRelicScanFirst')}
            detail={t('opp.relicRoiNeedScan')}
            action={
              <Button variant="secondary" size="sm" onClick={props.onOpenScanners}>
                {t('opp.openScanners')}
              </Button>
            }
          />
        );
      case 'relicsError':
        return (
          <EmptyState
            icon="ti-alert-triangle"
            title={gate.message}
            detail={t('opp.relicsNeedAlecaframe')}
            action={
              <Button variant="secondary" size="sm" onClick={props.onRetryRelics}>
                {t('opp.retry')}
              </Button>
            }
          />
        );
      case 'needsRelicLoad':
        return (
          <EmptyState
            icon="ti-diamond"
            title={t('opp.loadRelicFirst')}
            detail={t('opp.ownedRelicsProfitHint')}
            action={
              <Button variant="secondary" size="sm" onClick={props.onOpenOwnedRelics}>
                {t('opp.openOwnedRelics')}
              </Button>
            }
          />
        );
      case 'noOwnedRelics':
        return (
          <EmptyState
            icon="ti-diamond"
            title={t('opp.noOwnedRelicsDetected')}
            detail={t('opp.relicsAlecaframeEmpty')}
          />
        );
      case 'noInventory':
        return (
          <EmptyState
            icon="ti-box"
            title={t('opp.addComponentsFirst')}
            detail={t('opp.setPlannerInventoryHint')}
            action={
              <Button variant="secondary" size="sm" onClick={props.onOpenInventory}>
                {t('opp.openSetPlanner')}
              </Button>
            }
          />
        );
      default:
        return null;
    }
  };

  const rows = mode === 'set-completion' ? props.setRows : props.partRows;

  return (
    <div className="flex flex-col gap-4 p-4">
      <Panel className="gap-0">
        {/* 1. What am I optimising for? The mode decides what every number below means, so it is
              the first thing on the page rather than the fourth. */}
        <PanelHeader className="flex-wrap gap-3 py-2">
          <PanelTitle variant="heading">{t('opp.whatToFarmNow')}</PanelTitle>

          <div
            className="flex items-center gap-1 rounded-md bg-bg-base p-0.5"
            role="group"
            aria-label={t('opp.whatToFarmNow')}
          >
            {modes.map((entry) => {
              const active = mode === entry.id;
              return (
                <Button
                  key={entry.id}
                  variant="ghost"
                  size="sm"
                  static
                  aria-pressed={active}
                  onClick={() => props.onModeChange(entry.id)}
                  className={`h-7 rounded-sm px-3 text-[11px] font-semibold ${
                    active
                      ? 'bg-bg-elevated text-ink'
                      : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink'
                  }`}
                >
                  {entry.label}
                </Button>
              );
            })}
          </div>

          <span className="ml-auto flex items-center gap-3">
            {/* One freshness fact. The relic inventory refreshing is a different fact and only
                appears while it is actually happening. */}
            {props.relicsRefreshing ? (
              <span className="font-mono text-[10px] text-ink-dim">
                {t('opp.refreshingRelics')}
              </span>
            ) : null}
            <span className="font-mono text-[10px] text-ink-faint tabular-nums">
              {props.lastScan
                ? t('opp.lastScanElapsed', { time: formatElapsedTime(props.lastScan) })
                : t('opp.noScanData')}
            </span>
            <Button variant="outline" size="sm" onClick={props.onRunScan}>
              <i className="ti ti-refresh" aria-hidden="true" />
              {t('opp.runScan')}
            </Button>
          </span>
        </PanelHeader>

        {/* Context, not a headline: a strip of tiles here competed with the rows for attention,
            and one of its two tiles changed which quantity it held between modes. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2 font-mono text-[10px] text-ink-dim tabular-nums">
          <span>{t('opp.youOwnRelics', { n: props.ownedRelicTotal })}</span>
          <span aria-hidden="true" className="text-ink-faint">·</span>
          {mode === 'set-completion' ? (
            <>
              <span>{t('opp.setsInProgress', { n: props.setsInProgress })}</span>
              <span aria-hidden="true" className="text-ink-faint">·</span>
              <span>{t('opp.missingComponents', { n: props.missingComponentCount })}</span>
            </>
          ) : (
            <>
              <span>{t('opp.relicsWorthRunning', { n: props.relicsWorthRunning })}</span>
              <span aria-hidden="true" className="text-ink-faint">·</span>
              <span>
                {t('opp.bestRunValue', { value: formatPlatDecimal(props.bestRunProfit) })}
              </span>
            </>
          )}
        </div>

        {/* 2. Find, narrow, order — directly above the rows they act on, in the order you use
              them. Controls survive their own empty result; only the rows swap out. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <div className="relative min-w-56 flex-1">
            <i
              className="ti ti-search pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[13px] text-ink-faint"
              aria-hidden="true"
            />
            <Input
              type="search"
              role="combobox"
              aria-expanded={props.suggestOpen && props.suggestions.length > 0}
              aria-autocomplete="list"
              className="h-7 pl-7"
              placeholder={t('opp.searchRelicsPlaceholder')}
              value={search}
              spellCheck={false}
              onChange={(event) => {
                props.onSearchChange(event.target.value);
                props.onSuggestOpenChange(true);
              }}
              onFocus={() => props.onSuggestOpenChange(true)}
              // Delayed so a suggestion click lands before the list unmounts.
              onBlur={() => window.setTimeout(() => props.onSuggestOpenChange(false), 120)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') props.onSuggestOpenChange(false);
              }}
            />
            {search ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('opp.clear')}
                onClick={() => {
                  props.onSearchChange('');
                  props.onSuggestOpenChange(false);
                }}
                className="absolute top-1/2 right-0.5 size-6 -translate-y-1/2 text-ink-faint"
              >
                <i className="ti ti-x" aria-hidden="true" />
              </Button>
            ) : null}

            {/* Kept as a hand-rolled listbox rather than a Popover, like TopBar's search: this is
                a combobox, and a Popover is the wrong role for one. It is anchored to a
                position:relative parent, not measured — no collision math to get wrong. */}
            {props.suggestOpen && props.suggestions.length > 0 ? (
              <div
                role="listbox"
                className="absolute top-full right-0 left-0 z-(--z-dropdown) mt-1 overflow-hidden rounded-md border border-white/12 bg-bg-overlay shadow-float"
              >
                {props.suggestions.map((suggestion) => (
                  <Button
                    key={`${suggestion.kind}-${suggestion.label}`}
                    role="option"
                    aria-selected={false}
                    variant="ghost"
                    size="sm"
                    static
                    className="h-8 w-full justify-start gap-2 rounded-none px-2 text-[11px]"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      props.onSearchChange(suggestion.label);
                      props.onSuggestOpenChange(false);
                    }}
                  >
                    <span
                      className={`shrink-0 rounded px-1 py-px font-mono text-[9px] font-semibold uppercase ${
                        suggestion.kind === 'relic'
                          ? 'bg-accent-blue/15 text-accent-blue'
                          : 'bg-accent-purple/15 text-accent-purple'
                      }`}
                    >
                      {suggestion.kind === 'relic' ? t('opp.relic') : t('opp.drop')}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{suggestion.label}</span>
                    {suggestion.detail ? (
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
                        {suggestion.detail}
                      </span>
                    ) : null}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
            {t('opp.era')}
            <Select
              value={props.era}
              onChange={(event) => props.onEraChange(event.target.value)}
              aria-label={t('a11y.filterByEra')}
              className="w-28"
            >
              <option value="all">{t('opp.allEras')}</option>
              <option value="Lith">Lith</option>
              <option value="Meso">Meso</option>
              <option value="Neo">Neo</option>
              <option value="Axi">Axi</option>
            </Select>
          </label>

          <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
            {t('opp.sortBy')}
            <Select
              value={props.sort}
              onChange={(event) => props.onSortChange(event.target.value)}
              aria-label={t('a11y.sortRelics')}
              className="w-40"
            >
              {/* The label beside the control already says "Sort by", so the options must not
                  repeat it — the shipped strings read "Sort: completion priority" inside a
                  control labelled Sort by, and truncated because of it. */}
              {mode === 'set-completion' ? (
                <>
                  <option value="default">{t('opp.sortCompletionShort')}</option>
                  <option value="coverage">{t('opp.sortSetsHelpedShort')}</option>
                  <option value="owned">{t('opp.sortOwnedShort')}</option>
                </>
              ) : (
                <>
                  <option value="default">{t('opp.sortPlatHourShort')}</option>
                  <option value="owned">{t('opp.sortOwnedShort')}</option>
                </>
              )}
            </Select>
          </label>
        </div>

        {props.errorMessage ? (
          <div className="border-b border-line bg-accent-red/[0.06] px-3 py-2 text-[11px] text-accent-red">
            {props.errorMessage}
          </div>
        ) : null}

        {/* 3. The answer to the search, below the search that asked it. */}
        {dropOdds ? <DropOddsPanel odds={dropOdds} onFarmItem={props.onFarmItem} /> : null}

        {/* 4. The rows. */}
        <div className="p-3">
          {gate.kind !== 'ready' ? (
            renderGate()
          ) : rows.length === 0 ? (
            search ? (
              <EmptyState icon="ti-search-off" title={t('opp.noRelicsMatch', { query: search })} />
            ) : (
              <EmptyState
                icon="ti-diamond"
                title={
                  mode === 'set-completion' ? t('opp.noRelicsCover') : t('opp.noOwnedRefinements')
                }
              />
            )
          ) : (
            <div className="flex flex-col gap-2">
              {mode === 'set-completion'
                ? props.setRows.map((row) => (
                    <SetCompletionRow
                      key={`${row.relic.slug}:set-completion`}
                      row={row}
                      expanded={props.expandedKey === `${row.relic.slug}:set-completion`}
                      onToggle={() => props.onToggleExpanded(`${row.relic.slug}:set-completion`)}
                      farming={props.activeFarmingRelicSlug === row.relic.slug}
                      onFarm={() => props.onFarmSetRelic(row)}
                      localizeName={props.localizeName}
                    />
                  ))
                : props.partRows.map((row) => (
                    <PartProfitRow
                      key={`${row.relic.slug}:part-profit`}
                      row={row}
                      expanded={props.expandedKey === `${row.relic.slug}:part-profit`}
                      onToggle={() => props.onToggleExpanded(`${row.relic.slug}:part-profit`)}
                      farming={props.activeFarmingRelicSlug === row.relic.slug}
                      onFarm={() => props.onFarmPartRelic(row)}
                      localizeName={props.localizeName}
                    />
                  ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------- drop odds */

/**
 * "Can I actually get this part?" — the odds of pulling the searched item from the relics you
 * hold, at the refinements you hold them in.
 *
 * This is the page's one Expressive moment: it only appears when you have asked a specific
 * question, and it is the answer.
 */
function DropOddsPanel({
  odds,
  onFarmItem,
}: {
  odds: FarmNowDropOdds;
  onFarmItem: (slug: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const pct = Math.round(odds.atLeastOne * 100);
  const lead = odds.relics[0];

  return (
    <section className="border-b border-line bg-accent-purple/[0.04] px-3 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="truncate text-sm font-semibold text-ink">
            {t('opp.oddsTitle', { item: odds.targetName })}
          </h3>
          <span className="font-mono text-[10px] text-ink-dim tabular-nums">
            {t('opp.oddsRunAll', { n: odds.totalRelics })}
            {odds.exitPrice !== null
              ? ` · ${t('opp.oddsSellsFor', { price: formatPlat(odds.exitPrice) })}`
              : ''}
          </span>
        </div>
        <FarmThisButton
          active={false}
          onClick={() => onFarmItem(odds.targetSlug, odds.targetName)}
          label={t('farm.farmItem')}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-2xl leading-none font-bold text-accent-purple tabular-nums">
              {pct}%
            </span>
            <span className="flex items-center gap-1 font-mono text-[9px] tracking-[0.06em] text-ink-dim uppercase">
              {t('opp.oddsAtLeastOne')}
              <InfoHint text={t('opp.oddsAtLeastOneInfo')} placement="bottom" />
            </span>
          </span>
          {/* Plots the real probability — the one bar on this page, bound to a computed value. */}
          <span className="h-1.5 overflow-hidden rounded-full bg-bg-base" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-accent-purple"
              style={{ width: `${pct}%` }}
            />
          </span>
        </div>

        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1 font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
            {t('opp.oddsExpected')}
            <InfoHint text={t('opp.oddsExpectedInfo')} placement="bottom" />
          </span>
          <span className="font-mono text-sm font-bold text-ink tabular-nums">
            {odds.expectedDrops.toFixed(2)}
          </span>
        </span>

        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1 font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">
            {t('opp.oddsRelicsOwned')}
            <InfoHint text={t('opp.oddsRelicsOwnedInfo')} placement="bottom" />
          </span>
          <span className="font-mono text-sm font-bold text-ink tabular-nums">
            {odds.totalRelics}
          </span>
        </span>
      </div>

      {/* Only the relics that actually move your odds — the full list is the rows below, so
          repeating a long inventory here is noise. */}
      <div className="mt-3 flex flex-col gap-1">
        {odds.relics.slice(0, ODDS_RELIC_PREVIEW_COUNT).map((relic) => (
          <div
            key={relic.label}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-sm bg-bg-base/60 px-2 py-1"
          >
            <span className="w-24 shrink-0 font-mono text-[11px] font-semibold text-ink">
              {relic.label}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {relic.breakdown.map((entry) => (
                <span
                  key={entry.refinement}
                  className={`flex items-center gap-1 rounded px-1.5 py-px font-mono text-[10px] tabular-nums ${
                    REFINEMENT_CLASS[relicRefinementTone(entry.refinement)]
                  }`}
                >
                  <span className="font-bold">×{entry.count}</span>
                  {tHealth(t, entry.refinement.charAt(0).toUpperCase() + entry.refinement.slice(1))}
                  <span className="opacity-70">
                    {Math.round(entry.chance * 100)}% {t('opp.oddsPerRun')}
                  </span>
                </span>
              ))}
            </span>
            <span className="shrink-0 font-mono text-[11px] font-bold text-ink tabular-nums">
              {Math.round(relic.atLeastOne * 100)}%
            </span>
          </div>
        ))}
        {odds.relics.length > ODDS_RELIC_PREVIEW_COUNT ? (
          <span className="px-2 font-mono text-[10px] text-ink-faint tabular-nums">
            {t('opp.oddsMoreRelics', {
              n: odds.relics.length - ODDS_RELIC_PREVIEW_COUNT,
            })}
          </span>
        ) : null}
      </div>

      {lead?.bestRefinement ? (
        <p className="mt-2 text-[11px] text-ink-soft">
          {t('opp.oddsBestHint', {
            refinement: lead.bestRefinement,
            chance: `${Math.round((lead.bestChance ?? 0) * 100)}%`,
          })}
          {lead.missingBest
            ? ` ${t('opp.oddsUpgradeHint', { refinement: lead.bestRefinement })}`
            : ''}
          {odds.runsForTargetOdds !== null
            ? ` ${t('opp.oddsTargetRuns', {
                n: odds.runsForTargetOdds,
                refinement: lead.bestRefinement,
              })}`
            : ''}
        </p>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------------- rows */

function PartProfitRow({
  row,
  expanded,
  onToggle,
  farming,
  onFarm,
  localizeName,
}: {
  row: FarmNowRelicRow;
  expanded: boolean;
  onToggle: () => void;
  farming: boolean;
  onFarm: () => void;
  localizeName: (item: NamedItem) => string;
}) {
  const { t } = useTranslation();
  const bestDrop = row.drops.find((entry) => entry.drop.slug === row.bestDropSlug);

  // Split by expected value so the drops worth farming stand apart from the Forma-tier filler.
  const ranked = [...row.drops].sort((a, b) => (b.expectedValue ?? 0) - (a.expectedValue ?? 0));
  const worth = ranked.filter(
    (entry) => (entry.expectedValue ?? 0) >= 1 || entry.drop.slug === row.bestDropSlug,
  );
  const low = ranked.filter((entry) => !worth.includes(entry));

  return (
    <ListRow
      expanded={expanded}
      onToggle={onToggle}
      toggleLabel={expanded ? t('opp.collapseSet') : t('opp.expandSet')}
      head={
        <>
          <ItemThumb
            src={resolveWfmAssetUrl(row.relic.imagePath, row.relic.slug, row.relic.name)}
            fallback={row.relic.name.slice(0, 2)}
            size="size-9"
            chrome={false}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold text-ink">
                {localizeName(row.relic)}
              </span>
              <OwnedPill count={row.ownedCount} />
            </span>
            <span className="truncate text-[11px] font-normal text-ink-dim">
              {bestDrop
                ? t('opp.dropsBest', {
                    n: row.relic.dropCount,
                    name: localizeName(bestDrop.drop),
                    price: formatPlat(bestDrop.drop.recommendedExitPrice),
                  })
                : t('opp.dropsCount', { n: row.relic.dropCount })}
            </span>
          </span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
              REFINEMENT_CLASS[relicRefinementTone(row.guidance.bestKey)]
            }`}
            title={t('a11y.bestRefinement')}
          >
            {t('opp.runRefinement', { refinement: row.guidance.bestLabel })}
          </span>
          <RowMetric
            label={t('opp.perRun')}
            value={formatPlatDecimal(row.expectedProfit)}
            tone="positive"
          />
          <RowMetric label={t('opp.perHour')} value={formatPlatDecimal(row.platPerHour)} />
        </>
      }
    >
      <FarmThisButton
        active={farming}
        onClick={onFarm}
        size="sm"
        label={farming ? t('farm.nowFarming') : t('farm.farmThis')}
      />
      <RefinementGuidancePanel
        guidance={row.guidance}
        unit={row.targetedDropName ? 'pct' : 'plat'}
        heading={
          row.targetedDropName ? t('opp.chanceAt', { item: row.targetedDropName }) : undefined
        }
      />
      {worth.length > 0 ? (
        <DetailGroup label={t('opp.worthKeeping')} tone="primary">
          {worth.map((entry) => (
            <DropRow
              key={entry.drop.slug}
              name={localizeName(entry.drop)}
              imageUrl={resolveWfmAssetUrl(entry.drop.imagePath, entry.drop.slug)}
              rarity={entry.drop.rarity}
              meta={`${formatChance(entry.chance)} · ${t('opp.exitValue', {
                price: formatPlat(entry.drop.recommendedExitPrice),
              })}`}
              badge={
                row.bestDropSlug === entry.drop.slug
                  ? { text: t('opp.topPick'), tone: 'best' }
                  : undefined
              }
              value={formatPlatDecimal(entry.expectedValue)}
              valueLabel={t('opp.value')}
            />
          ))}
        </DetailGroup>
      ) : null}
      {low.length > 0 ? (
        <DetailGroup label={t('opp.lowValue', { n: low.length })} tone="muted">
          {low.map((entry) => (
            <DropRow
              key={entry.drop.slug}
              name={localizeName(entry.drop)}
              imageUrl={resolveWfmAssetUrl(entry.drop.imagePath, entry.drop.slug)}
              rarity={entry.drop.rarity}
              meta={formatChance(entry.chance)}
              value={formatPlatDecimal(entry.expectedValue)}
              valueLabel={t('opp.value')}
            />
          ))}
        </DetailGroup>
      ) : null}
    </ListRow>
  );
}

function SetCompletionRow({
  row,
  expanded,
  onToggle,
  farming,
  onFarm,
  localizeName,
}: {
  row: FarmNowSetCompletionRow;
  expanded: boolean;
  onToggle: () => void;
  farming: boolean;
  onFarm: () => void;
  localizeName: (item: NamedItem) => string;
}) {
  const { t } = useTranslation();
  const needed = row.drops.filter((entry) => entry.isNeeded);
  const others = row.drops.filter((entry) => !entry.isNeeded);

  return (
    <ListRow
      expanded={expanded}
      onToggle={onToggle}
      toggleLabel={expanded ? t('opp.collapseSet') : t('opp.expandSet')}
      head={
        <>
          <ItemThumb
            src={resolveWfmAssetUrl(row.relic.imagePath, row.relic.slug, row.relic.name)}
            fallback={row.relic.name.slice(0, 2)}
            size="size-9"
            chrome={false}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold text-ink">
                {localizeName(row.relic)}
              </span>
              <OwnedPill count={row.ownedCount} />
            </span>
            <span className="truncate text-[11px] font-normal text-ink-dim">
              {row.bestSetProgress
                ? t('opp.closestSetProgress', {
                    name: row.bestSetProgress.name,
                    owned: row.bestSetProgress.owned,
                    total: row.bestSetProgress.total,
                  })
                : t('opp.missingPartsCovered', { n: row.totalMissingQuantity })}
            </span>
          </span>
          <RowMetric
            label={t('opp.neededDrops')}
            value={String(row.neededDropCount)}
            tone="positive"
          />
          <RowMetric label={t('opp.setsHelped')} value={String(row.coveredSetCount)} />
        </>
      }
    >
      <FarmThisButton
        active={farming}
        onClick={onFarm}
        size="sm"
        label={farming ? t('farm.nowFarming') : t('farm.farmThis')}
      />
      <RefinementGuidancePanel guidance={row.guidance} unit="pct" />
      {needed.length > 0 ? (
        <DetailGroup label={t('opp.neededForSets')} tone="primary">
          {needed.map((entry) => (
            <DropRow
              key={entry.drop.slug}
              name={localizeName(entry.drop)}
              imageUrl={resolveWfmAssetUrl(entry.drop.imagePath, entry.drop.slug)}
              rarity={entry.drop.rarity}
              meta={`${t('opp.setsCoveredCount', { n: entry.coveredSetCount })}${
                entry.setNames.length ? ` · ${entry.setNames.join(' · ')}` : ''
              }`}
              badge={
                entry.missingQuantity > 0
                  ? { text: t('opp.missingCount', { n: entry.missingQuantity }), tone: 'needed' }
                  : undefined
              }
            />
          ))}
        </DetailGroup>
      ) : null}
      {others.length > 0 ? (
        <DetailGroup label={t('opp.notNeeded', { n: others.length })} tone="muted">
          {others.map((entry) => (
            <DropRow
              key={entry.drop.slug}
              name={localizeName(entry.drop)}
              imageUrl={resolveWfmAssetUrl(entry.drop.imagePath, entry.drop.slug)}
              rarity={entry.drop.rarity}
            />
          ))}
        </DetailGroup>
      ) : null}
    </ListRow>
  );
}
