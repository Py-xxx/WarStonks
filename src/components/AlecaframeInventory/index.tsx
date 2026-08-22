import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { ItemThumb } from '../ListRow';
import { getArbitrageScannerState, getPriceBook, readAlecaframeInventory } from '../../lib/tauriClient';
import { indexPriceBook, totalValue, valueItem, type PriceBookIndex } from '../../lib/priceBook';
import { formatElapsedTime } from '../../lib/dateTime';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { partKeyForSlug } from '../../lib/partImages';
import { useTranslation } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import type {
  AlecaframeInventory,
  AlecaframeItem,
  AlecaframeItemCategory,
  RelicRoiDropEntry,
  RelicRoiEntry,
} from '../../types';

/** The categories worth listing on their own. Everything else (resources, fish, gems) is
 *  high-count noise that belongs in the game, not a trading tool. */
export type AlecaframeInventoryTab = 'prime-parts' | 'mods' | 'arcanes' | 'relics';

const TAB_CATEGORY: Record<AlecaframeInventoryTab, AlecaframeItemCategory> = {
  'prime-parts': 'blueprint',
  mods: 'mod',
  arcanes: 'arcane',
  relics: 'relic',
};

const TAB_TITLE_KEY: Record<AlecaframeInventoryTab, TranslationKey> = {
  'prime-parts': 'inv.tabPrimeParts',
  mods: 'inv.tabMods',
  arcanes: 'inv.tabArcanes',
  relics: 'opp.tabOwnedRelics',
};

/** Refinement order, worst to best — the game's own progression. */
const REFINEMENT_ORDER = ['intact', 'exceptional', 'flawless', 'radiant'] as const;

const REFINEMENT_LABEL_KEYS = {
  intact: 'refine.intact',
  exceptional: 'refine.exceptional',
  flawless: 'refine.flawless',
  radiant: 'refine.radiant',
} as const;

/**
 * How often to re-read AlecaFrame's snapshot.
 *
 * Nothing about this integration requires AlecaFrame to be "connected" to anything — we read
 * a file off disk. But the file only changes when AlecaFrame receives a push (which needs the
 * game running), so re-reading faster than this would just re-decrypt 700 KB for no reason.
 */
const REFRESH_INTERVAL_MS = 15_000;

/**
 * How old AlecaFrame's own sync stamp can get before we say something.
 *
 * We never gate on this — the file is read fresh every time regardless. But AlecaFrame only
 * rewrites the file when Overwolf pushes it an update, and starting AlecaFrame *after*
 * Warframe can leave it not receiving pushes at all. When that happens the inventory looks
 * plausible but is hours old, and the failure is invisible unless we say so.
 *
 * Measured push gaps within a healthy session were 17s to ~29min, so an hour is comfortably
 * past normal without nagging someone parked in their dojo.
 */
const STALE_SYNC_MS = 60 * 60 * 1000;

type SortKey = 'name' | 'count' | 'rank' | 'value';
type ViewMode = 'list' | 'grid';

/** Rank as a proportion of this item's own maximum.
 *
 *  Sorting on the raw level would be wrong across items with different caps — a 5/5 arcane
 *  is fully ranked while a 7/10 mod is not, yet 7 > 5. Unrankable items sort last rather
 *  than pretending to be rank 0. */
function rankFraction(item: AlecaframeItem): number {
  // A relic's "rank" is its refinement, so it is scored on the same 0..1 scale rather than
  // being excluded from rank sorting entirely.
  if (item.refinement) {
    return REFINEMENT_ORDER.indexOf(item.refinement) / (REFINEMENT_ORDER.length - 1);
  }
  if (item.rank === null || item.maxRank === null || item.maxRank <= 0) {
    return -1;
  }
  return item.rank / item.maxRank;
}

/**
 * Splits an item's name across two lines: what it is on top, which part of it below.
 *
 * "Baruuk Prime Neuroptics Blueprint" reads faster as "Baruuk Prime" + "Neuroptics" than as one
 * truncated line, and it puts the varying word in its own slot so a column of one warframe's parts
 * scans vertically. The split is driven by the **slug**, which is language-independent and already
 * tells us whether the item is a component and how many words its part name has.
 *
 * Anything that isn't a component keeps its whole name.
 */
function splitItemLabel(item: AlecaframeItem): { primary: string; secondary: string | null } {
  const partKey = partKeyForSlug(item.slug);
  if (!partKey) {
    return { primary: item.name, secondary: null };
  }

  // `lower_limb` is two words, `barrel` is one; the key tells us which without re-parsing.
  const partWordCount = partKey.replace(/_prime$/, '').split('_').length;
  const words = item.name.split(/\s+/).filter(Boolean);
  // Drop a trailing "Blueprint" so the part word is the last one, matching the slug rule.
  const last = words[words.length - 1];
  const trimmed = last?.toLowerCase() === 'blueprint' ? words.slice(0, -1) : words;

  if (trimmed.length <= partWordCount) {
    return { primary: item.name, secondary: null };
  }

  return {
    primary: trimmed.slice(0, -partWordCount).join(' '),
    secondary: trimmed.slice(-partWordCount).join(' '),
  };
}

/** Refinement → the field holding that refinement's drop chance. */
const CHANCE_FIELD = {
  intact: 'intact',
  exceptional: 'exceptional',
  flawless: 'flawless',
  radiant: 'radiant',
} as const;

/**
 * A relic's drops, keyed by slug.
 *
 * Sourced from the arbitrage scanner's relic ROI results — the same data "what to farm now"
 * reads, so a drop's value here is the same number shown there rather than a second estimate
 * that could disagree with it.
 */
type RelicDropIndex = Map<string, RelicRoiEntry>;

function dropValue(drop: RelicRoiDropEntry): number | null {
  return drop.recommendedExitPrice ?? drop.currentStatsPrice;
}

function formatRank(item: AlecaframeItem, t: TranslateFn): string {
  if (item.refinement) {
    return t(REFINEMENT_LABEL_KEYS[item.refinement]);
  }
  if (item.rank === null || item.maxRank === null) {
    return '—';
  }
  return `${item.rank}/${item.maxRank}`;
}

/** Platinum with no decimals — inventory values are compared at a glance, not audited. */
function formatPlatinum(value: number): string {
  return `${Math.round(value).toLocaleString()}p`;
}

/**
 * The tooltip behind a value: where the number came from and how old it is. The price book
 * deliberately keeps its basis rather than flattening every rung into one figure, so this is where
 * that distinction is spent — a bid-derived price should not read like a traded one.
 */
function valuationTitle(
  valuation: NonNullable<ReturnType<typeof valueItem>>,
  item: AlecaframeItem,
  t: TranslateFn,
): string {
  const basis = t(`inv.basis.${valuation.entry.basis}` as TranslationKey);
  const observed = formatElapsedTime(valuation.entry.observedAt);
  const lines = [
    `${formatPlatinum(valuation.entry.exitPrice)} — ${basis}`,
    t('inv.valueObserved', { elapsed: observed }),
  ];
  if (valuation.fromUnrankedVariant) {
    lines.push(t('inv.valueUnrankedFloor', { rank: String(item.rank ?? 0) }));
  }
  return lines.join('\n');
}

/**
 * Rank drawn the way the game draws it — one pip per level, filled up to the current rank.
 *
 * A fraction makes you read and compare; pips are scannable, and they make two stacks of the same
 * arcane at different ranks obviously different goods rather than a repeated row.
 * Relics have no levels, so their refinement stays a word.
 */
function RankPips({ item }: { item: AlecaframeItem }) {
  const { t } = useTranslation();
  if (item.refinement) {
    return (
      <span className="font-mono text-[10px] text-ink-dim">{formatRank(item, t)}</span>
    );
  }
  if (item.rank === null || item.maxRank === null || item.maxRank <= 0) {
    return <span className="text-[10px] text-ink-faint">—</span>;
  }

  return (
    <span
      className="flex items-center gap-0.5"
      role="img"
      aria-label={t('inv.rankOf', { rank: String(item.rank), max: String(item.maxRank) })}
    >
      {Array.from({ length: item.maxRank }, (_, index) => (
        <span
          key={index}
          className={`size-1.5 rounded-full ${
            index < (item.rank ?? 0) ? 'bg-accent-amber' : 'bg-line-strong'
          }`}
        />
      ))}
    </span>
  );
}

/** The value cell, with its provenance on the tooltip. Unpriced reads as `—`, never as `0p`. */
function ValueCell({
  item,
  prices,
  align,
}: {
  item: AlecaframeItem;
  prices: PriceBookIndex;
  align: 'row' | 'tile';
}) {
  const { t } = useTranslation();
  const valuation = valueItem(item, prices);

  if (!valuation) {
    return (
      <span
        className={`font-mono text-ink-faint tabular-nums ${align === 'row' ? 'text-xs' : 'text-[11px]'}`}
        title={t('inv.valueUnpriced')}
      >
        —
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={`cursor-default font-mono font-semibold tabular-nums ${
              align === 'row' ? 'text-xs' : 'text-[11px]'
            } ${valuation.fromUnrankedVariant ? 'text-ink-dim' : 'text-ink'}`}
          />
        }
      >
        {valuation.fromUnrankedVariant ? '≥' : ''}
        {formatPlatinum(valuation.entry.exitPrice)}
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">
        {valuationTitle(valuation, item, t)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One inventory item as a **row** — the default.
 *
 * The grid this replaced could not answer the question you open an inventory to ask. Unit prices
 * in 10px text scattered across fifteen columns of near-identical dark icons are not comparable;
 * the same numbers in a column are. Rows also have room for the **stack total**, which is the
 * figure that actually decides a sale and which the tiles had nowhere to put.
 */
function InventoryRow({
  item,
  showsRank,
  prices,
  onOpen,
}: {
  item: AlecaframeItem;
  showsRank: boolean;
  prices: PriceBookIndex;
  onOpen?: (item: AlecaframeItem) => void;
}) {
  const { t } = useTranslation();
  const { primary, secondary } = splitItemLabel(item);
  const valuation = valueItem(item, prices);

  const content = (
    <>
      <ItemThumb
        src={resolveWfmAssetUrl(item.imagePath, item.slug)}
        fallback={item.name.charAt(0)}
        size="size-8"
        chrome={!item.refinement}
      />

      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-xs font-medium text-ink">{primary}</span>
        {secondary ? (
          <span className="shrink-0 truncate text-[11px] text-ink-dim">{secondary}</span>
        ) : null}
      </span>

      {showsRank ? <span className="flex w-24 shrink-0 justify-end">
        <RankPips item={item} />
      </span> : null}

      {/* Count and stack total sit together: `3 × 15p = 45p` is one thought, and splitting them
          across the row is what made the tile grid unable to state it at all. */}
      <span className="w-12 shrink-0 text-right font-mono text-xs text-ink-soft tabular-nums">
        ×{item.count}
      </span>
      <span className="w-16 shrink-0 text-right">
        <ValueCell item={item} prices={prices} align="row" />
      </span>
      <span className="w-20 shrink-0 text-right font-mono text-xs font-bold text-accent-green tabular-nums">
        {valuation ? formatPlatinum(valuation.totalPlatinum) : '—'}
      </span>
    </>
  );

  if (!onOpen) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-line-subtle bg-bg-panel px-2.5 py-1.5">
        {content}
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      static
      onClick={() => onOpen(item)}
      title={t('inv.openDrops')}
      className="h-auto w-full justify-start gap-3 rounded-md border border-line-subtle bg-bg-panel px-2.5 py-1.5 text-left hover:border-line-strong hover:bg-bg-elevated"
    >
      {content}
    </Button>
  );
}

/**
 * One inventory item as a **tile** — the optional view.
 *
 * Kept because Mods and Arcanes have genuinely distinctive art and few enough entries to browse
 * visually. Deliberately larger than the tiles it replaces: at the old size the art was a grey
 * blob and the grid was doing no recognition work at all.
 */
function InventoryTile({
  item,
  showsRank,
  prices,
  onOpen,
}: {
  item: AlecaframeItem;
  showsRank: boolean;
  prices: PriceBookIndex;
  onOpen?: (item: AlecaframeItem) => void;
}) {
  const { t } = useTranslation();
  const { primary, secondary } = splitItemLabel(item);
  const valuation = valueItem(item, prices);

  const content = (
    <>
      <span className="absolute top-1.5 right-2 font-mono text-[11px] font-bold text-ink-soft tabular-nums">
        ×{item.count}
      </span>
      <ItemThumb
        src={resolveWfmAssetUrl(item.imagePath, item.slug)}
        fallback={item.name.charAt(0)}
        size="size-14"
        chrome={false}
      />
      <span className="flex w-full min-w-0 flex-col items-center gap-0.5">
        <span className="w-full truncate text-center text-[11px] font-medium text-ink">
          {primary}
        </span>
        {secondary ? (
          <span className="w-full truncate text-center text-[10px] text-ink-dim">{secondary}</span>
        ) : null}
      </span>
      {showsRank ? <RankPips item={item} /> : null}
      <span className="flex items-baseline gap-1.5">
        <ValueCell item={item} prices={prices} align="tile" />
        {valuation && item.count > 1 ? (
          <span className="font-mono text-[10px] font-bold text-accent-green tabular-nums">
            {formatPlatinum(valuation.totalPlatinum)}
          </span>
        ) : null}
      </span>
    </>
  );

  const shell =
    'relative flex flex-col items-center gap-1.5 rounded-lg border border-line-subtle bg-bg-panel px-2 py-2.5';

  if (!onOpen) {
    return (
      <div className={shell} title={item.name}>
        {content}
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      static
      onClick={() => onOpen(item)}
      title={t('inv.openDrops')}
      className={`${shell} h-auto hover:border-line-strong hover:bg-bg-elevated`}
    >
      {content}
    </Button>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 10 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-md border border-line-subtle bg-bg-panel px-2.5 py-1.5"
        >
          <Skeleton type="avatar" className="w-auto shrink-0" leafClassName="size-8 rounded-md" />
          <Skeleton type="text" className="w-48" />
          <span className="min-w-0 flex-1" />
          <Skeleton type="text" className="w-12 shrink-0" />
          <Skeleton type="text" className="w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * AlecaFrame-sourced inventory for one category.
 *
 * This is a *snapshot*, not a live feed: AlecaFrame rewrites it when the user crosses a
 * session boundary (mission start/end, leaving the dojo), so it can be arbitrarily old
 * while someone sits in one place. The sync age is shown for exactly that reason and
 * should not be hidden — a silently stale count is worse than an obviously old one.
 */
export function AlecaframeInventoryPanel({ tab }: { tab: AlecaframeInventoryTab }) {
  const { t } = useTranslation();
  const [inventory, setInventory] = useState<AlecaframeInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [view, setView] = useState<ViewMode>('list');

  const [refreshedAt, setRefreshedAt] = useState<number>(0);
  const [relicDrops, setRelicDrops] = useState<RelicDropIndex>(new Map());
  const [openRelic, setOpenRelic] = useState<AlecaframeItem | null>(null);
  const [prices, setPrices] = useState<PriceBookIndex>(() => indexPriceBook([]));

  // The durable price book — every item the app has ever fetched statistics for, not just what
  // the last scan touched. One fetch per mount: it is a plain SQLite read of ~1k rows, and the
  // book only moves when the market tracker writes new statistics.
  useEffect(() => {
    let cancelled = false;
    void getPriceBook()
      .then((entries) => {
        if (!cancelled) {
          setPrices(indexPriceBook(entries));
        }
      })
      // Not fatal: rows fall back to showing no value, which is what they did before the book
      // existed. An inventory the user cannot see is a worse outcome than one without prices.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Relics only: the scanner's ROI results carry each relic's drop table and what those drops
  // are worth. Fetched once per mount — it is a cached read, and the drop tables change only
  // when a scan runs.
  useEffect(() => {
    if (tab !== 'relics') {
      return;
    }
    let cancelled = false;
    void getArbitrageScannerState()
      .then((state) => {
        if (cancelled) {
          return;
        }
        const index: RelicDropIndex = new Map();
        for (const relic of state.latestScan?.relicRoiResults ?? []) {
          index.set(relic.slug, relic);
        }
        setRelicDrops(index);
      })
      // Not fatal: without it the tab still lists relics, just without drops or values.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    // Only the first read blanks the list; later ones swap the data in place so a periodic
    // refresh doesn't flash a loading state over what the user is reading.
    let isFirstRead = true;

    const read = async () => {
      if (isFirstRead) {
        setLoading(true);
      }
      try {
        const result = await readAlecaframeInventory();
        if (cancelled) {
          return;
        }
        setInventory(result);
        setError(null);
      } catch (cause: unknown) {
        if (!cancelled) {
          // The realistic failure is AlecaFrame rotating its static key, and the backend
          // message says so. Surfacing it beats showing an empty inventory that looks
          // like the user simply owns nothing.
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          isFirstRead = false;
        }
      }
    };

    void read();
    // The file is rewritten whenever the user crosses a session boundary, so polling is what
    // makes the tab reflect a mission that ended while it was open. Without this it showed
    // whatever was on disk at mount and never changed again.
    const timer = window.setInterval(() => void read(), REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshedAt]);

  const rows = useMemo(() => {
    if (!inventory) {
      return [];
    }
    const category = TAB_CATEGORY[tab];
    const query = deferredSearch.trim().toLowerCase();

    return inventory.items
      .filter((item) => item.category === category)
      .filter((item) => {
        if (!query) {
          return true;
        }
        if (item.name.toLowerCase().includes(query)) {
          return true;
        }
        // Searching the relic tab by *drop* — "octavia prime systems" finds every relic that
        // drops it. This is the main reason to search relics at all; you almost never want a
        // relic by name.
        return (
          relicDrops
            .get(item.slug)
            ?.drops.some((drop) => drop.name.toLowerCase().includes(query)) ?? false
        );
      })
      .sort((left, right) => {
        if (sortKey === 'value') {
          // Stack total, not unit price: the list shows both, and "what is my most valuable
          // holding" is a question about the stack. The tile grid sorted on unit price because
          // it had nowhere to show a total.
          const leftValue = valueItem(left, prices)?.totalPlatinum ?? -1;
          const rightValue = valueItem(right, prices)?.totalPlatinum ?? -1;
          return rightValue - leftValue || left.name.localeCompare(right.name);
        }
        if (sortKey === 'rank') {
          return rankFraction(right) - rankFraction(left) || left.name.localeCompare(right.name);
        }
        if (sortKey === 'count') {
          return right.count - left.count || left.name.localeCompare(right.name);
        }
        return left.name.localeCompare(right.name) || rankFraction(right) - rankFraction(left);
      });
  }, [inventory, tab, deferredSearch, sortKey, relicDrops, prices]);

  const totalCount = useMemo(() => rows.reduce((sum, item) => sum + item.count, 0), [rows]);

  // Of what is on screen, not of the whole inventory — the number has to agree with the rows
  // under it, or a filtered view turns it into a lie.
  const valuation = useMemo(() => totalValue(rows, prices), [rows, prices]);

  // Prime parts never rank, so the column would be a wall of dashes.
  const showsRank = tab !== 'prime-parts';
  const onOpen = tab === 'relics' ? setOpenRelic : undefined;

  const syncedAtMs = inventory?.lastInventorySync ? inventory.lastInventorySync * 1000 : null;
  const syncedAt = syncedAtMs ? new Date(syncedAtMs).toISOString() : null;
  // AlecaFrame's own claim about when it last received data — not when we read the file.
  const syncIsStale = syncedAtMs !== null && Date.now() - syncedAtMs > STALE_SYNC_MS;

  const sorts: { id: SortKey; label: string }[] = [
    { id: 'value', label: t('inv.sortValue') },
    { id: 'count', label: t('inv.sortCount') },
    ...(showsRank ? [{ id: 'rank' as SortKey, label: t('inv.sortRank') }] : []),
    { id: 'name', label: t('inv.sortName') },
  ];

  const body = () => {
    if (loading) {
      return <RowsSkeleton />;
    }
    if (error) {
      return <EmptyState icon="ti-alert-triangle" title={t('inv.decryptFailed')} detail={error} />;
    }
    if (!inventory) {
      return <EmptyState icon="ti-plug-connected-x" title={t('inv.alecaframeUnavailable')} />;
    }
    if (rows.length === 0) {
      return <EmptyState icon="ti-search-off" title={t('inv.noneMatch')} />;
    }
    if (view === 'grid') {
      return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {rows.map((item) => (
            <InventoryTile
              key={itemKeyFor(item)}
              item={item}
              showsRank={showsRank}
              prices={prices}
              onOpen={onOpen}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        {rows.map((item) => (
          <InventoryRow
            key={itemKeyFor(item)}
            item={item}
            showsRank={showsRank}
            prices={prices}
            onOpen={onOpen}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* What the inventory is worth is the headline of an inventory page. It used to sit in a
          10px run-on beside the sync stamp. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat
          label={t('inv.colValue')}
          value={formatPlatinum(valuation.platinum)}
          icon="ti-coins"
          tone={valuation.platinum > 0 ? 'positive' : 'muted'}
        />
        <Stat
          label={t('inv.colOwned')}
          value={totalCount.toLocaleString()}
          icon="ti-package"
          tone={totalCount > 0 ? 'neutral' : 'muted'}
        />
        <Stat
          label={t('inv.statStacks')}
          value={rows.length.toLocaleString()}
          icon="ti-layers-intersect"
          tone={rows.length > 0 ? 'neutral' : 'muted'}
        />
      </div>

      <Panel className="gap-0">
        <PanelHeader className="flex-wrap gap-2">
          <PanelTitle variant="heading">{t(TAB_TITLE_KEY[tab])}</PanelTitle>
          {/* One freshness fact — how old AlecaFrame's own data is, not when we read the file. */}
          {syncedAt ? (
            <span
              className={`font-mono text-[10px] tabular-nums ${
                syncIsStale ? 'text-accent-amber' : 'text-ink-faint'
              }`}
            >
              {t('inv.syncedAgo', { time: formatElapsedTime(syncedAt) })}
            </span>
          ) : null}
          {valuation.unpricedItems > 0 ? (
            // Keeps the total above honest: a partial sum otherwise reads as the whole worth.
            <span className="font-mono text-[10px] text-ink-faint tabular-nums">
              {t('inv.valueUnpricedCount', { count: String(valuation.unpricedItems) })}
            </span>
          ) : null}

          <span className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRefreshedAt(Date.now())}
              title={t('inv.refreshHelp')}
            >
              <i className="ti ti-refresh" aria-hidden="true" />
              {t('common.refresh')}
            </Button>
          </span>
        </PanelHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <div className="relative min-w-56 flex-1">
            <i
              className="ti ti-search pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[13px] text-ink-faint"
              aria-hidden="true"
            />
            <Input
              type="search"
              className="h-7 pl-7"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('inv.search')}
              aria-label={t('inv.search')}
            />
          </div>

          <div className="flex items-center gap-1" role="group" aria-label={t('inv.sortBy')}>
            {sorts.map((sort) => {
              const active = sortKey === sort.id;
              return (
                <Button
                  key={sort.id}
                  variant="ghost"
                  size="sm"
                  static
                  aria-pressed={active}
                  onClick={() => setSortKey(sort.id)}
                  className={`h-7 rounded-md px-2.5 text-[11px] font-medium ${
                    active
                      ? 'bg-bg-elevated text-ink'
                      : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink'
                  }`}
                >
                  {sort.label}
                </Button>
              );
            })}
          </div>

          {/* Two icons, always both present, the unselected one dimmed — the segmented-icon-group
              pattern from the watchlist rows. */}
          <div
            className="flex items-center gap-0.5 rounded-md bg-bg-base p-0.5"
            role="group"
            aria-label={t('inv.viewMode')}
          >
            {(
              [
                ['list', 'ti-list', t('inv.viewList')],
                ['grid', 'ti-layout-grid', t('inv.viewGrid')],
              ] as const
            ).map(([id, icon, label]) => (
              <Button
                key={id}
                variant="ghost"
                size="icon-sm"
                static
                aria-pressed={view === id}
                aria-label={label}
                title={label}
                onClick={() => setView(id)}
                className={`size-7 rounded-sm ${
                  view === id ? 'bg-bg-elevated text-ink' : 'text-ink-dim hover:text-ink'
                }`}
              >
                <i className={`ti ${icon}`} aria-hidden="true" />
              </Button>
            ))}
          </div>
        </div>

        {syncIsStale ? (
          <div
            className="border-b border-line bg-accent-amber/[0.08] px-3 py-2 text-[11px] text-accent-amber"
            role="status"
          >
            {t('inv.staleSync', { time: formatElapsedTime(syncedAt ?? '') })}
          </div>
        ) : null}

        <div className="p-3">{body()}</div>
      </Panel>

      <RelicDropDialog
        item={openRelic}
        relic={openRelic ? relicDrops.get(openRelic.slug) ?? null : null}
        onClose={() => setOpenRelic(null)}
      />
    </div>
  );
}

/* Rank and refinement are separate dimensions — collapsing them into one `??` made a rankless,
   refinementless row key-identical to its neighbours, and React reused their DOM across tab
   switches. */
function itemKeyFor(item: AlecaframeItem): string {
  return `${item.bucket}:${item.uniqueName}:${item.rank ?? 'na'}:${item.refinement ?? 'na'}`;
}

/**
 * A relic's full drop table, with what each drop is worth.
 *
 * The values come from the arbitrage scanner's relic ROI results — the same source "what to
 * farm now" reads — so a drop priced here matches what that tab says rather than being a
 * second estimate that can disagree with it.
 *
 * Chances are shown for the refinement of the stack you clicked, because that is the relic you
 * actually hold: a radiant's rare chance is several times an intact's, and showing a single
 * blended number would misstate both.
 */
function RelicDropDialog({
  item,
  relic,
  onClose,
}: {
  item: AlecaframeItem | null;
  relic: RelicRoiEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const refinement = item?.refinement ?? 'intact';

  const drops = useMemo(() => {
    if (!relic) {
      return [];
    }
    // Most valuable first: the question this table answers is "is this worth cracking".
    return [...relic.drops].sort(
      (left, right) => (dropValue(right) ?? -1) - (dropValue(left) ?? -1),
    );
  }, [relic]);

  /** Chance-weighted value of one crack at this refinement — the relic's expected return. */
  const expectedValue = useMemo(() => {
    let total = 0;
    let priced = false;
    for (const drop of drops) {
      const chance = drop.chanceProfile[CHANCE_FIELD[refinement]];
      const value = dropValue(drop);
      if (chance === null || value === null) {
        continue;
      }
      priced = true;
      total += (chance / 100) * value;
    }
    return priced ? Math.round(total) : null;
  }, [drops, refinement]);

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle>{item.name}</DialogTitle>
              <DialogDescription>
                {item.refinement ? t(REFINEMENT_LABEL_KEYS[item.refinement]) : t('opp.unknown')}
                {' · '}
                {t('inv.ownedCount', { n: String(item.count) })}
                {expectedValue !== null ? (
                  <>
                    {' · '}
                    <span className="font-mono font-semibold text-accent-green tabular-nums">
                      {t('inv.expectedValue')} {expectedValue}p
                    </span>
                  </>
                ) : null}
              </DialogDescription>
            </DialogHeader>

            {drops.length === 0 ? (
              <EmptyState icon="ti-diamond" title={t('opp.noDropData')} />
            ) : (
              <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
                {drops.map((drop) => {
                  const chance = drop.chanceProfile[CHANCE_FIELD[refinement]];
                  const value = dropValue(drop);
                  return (
                    <li
                      key={drop.slug}
                      className="flex items-center gap-2.5 rounded-sm border border-line-subtle bg-bg-panel px-2 py-1.5"
                    >
                      <ItemThumb
                        src={resolveWfmAssetUrl(drop.imagePath, drop.slug)}
                        fallback={drop.name.charAt(0)}
                        size="size-7"
                      />
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                        {drop.name}
                      </span>
                      <span className="w-12 shrink-0 text-right font-mono text-[11px] text-ink-dim tabular-nums">
                        {chance === null ? '—' : `${chance}%`}
                      </span>
                      <span
                        className={`w-14 shrink-0 text-right font-mono text-[11px] font-semibold tabular-nums ${
                          value === null ? 'text-ink-faint' : 'text-ink'
                        }`}
                      >
                        {value === null ? '—' : `${value}p`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
