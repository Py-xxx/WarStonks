import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { readAlecaframeInventory } from '../../lib/tauriClient';
import { formatElapsedTime } from '../../lib/dateTime';
import { useTranslation } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import type { AlecaframeInventory, AlecaframeItem, AlecaframeItemCategory } from '../../types';

/** The categories worth listing on their own. Everything else (resources, fish, gems) is
 *  high-count noise that belongs in the game, not a trading tool. */
export type AlecaframeInventoryTab = 'prime-parts' | 'mods' | 'arcanes' | 'relics';

const TAB_CATEGORY: Record<AlecaframeInventoryTab, AlecaframeItemCategory> = {
  'prime-parts': 'blueprint',
  mods: 'mod',
  arcanes: 'arcane',
  relics: 'relic',
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

type SortKey = 'name' | 'count' | 'rank';

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

function formatRank(item: AlecaframeItem, t: TranslateFn): string {
  if (item.refinement) {
    return t(REFINEMENT_LABEL_KEYS[item.refinement]);
  }
  if (item.rank === null || item.maxRank === null) {
    return '—';
  }
  return `${item.rank}/${item.maxRank}`;
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
  const [sortKey, setSortKey] = useState<SortKey>('count');

  const [refreshedAt, setRefreshedAt] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    // Only the first read blanks the table; later ones swap the data in place so a periodic
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
      .filter((item) => (query ? item.name.toLowerCase().includes(query) : true))
      .sort((left, right) => {
        if (sortKey === 'rank') {
          return (
            rankFraction(right) - rankFraction(left) ||
            left.name.localeCompare(right.name)
          );
        }
        if (sortKey === 'count') {
          return right.count - left.count || left.name.localeCompare(right.name);
        }
        return (
          left.name.localeCompare(right.name) || rankFraction(right) - rankFraction(left)
        );
      });
  }, [inventory, tab, deferredSearch, sortKey]);

  const totalCount = useMemo(
    () => rows.reduce((sum, item) => sum + item.count, 0),
    [rows],
  );

  // Prime parts never rank, so the column would be a wall of dashes.
  const showsRank = tab !== 'prime-parts';

  if (loading) {
    return <div className="af-inv-state">{t('inv.loading')}</div>;
  }

  if (error) {
    return (
      <div className="af-inv-state af-inv-error" role="alert">
        {t('inv.decryptFailed')}
        <span className="af-inv-error-detail">{error}</span>
      </div>
    );
  }

  if (!inventory) {
    return <div className="af-inv-state">{t('inv.alecaframeUnavailable')}</div>;
  }

  const syncedAtMs = inventory.lastInventorySync ? inventory.lastInventorySync * 1000 : null;
  const syncedAt = syncedAtMs ? new Date(syncedAtMs).toISOString() : null;
  // AlecaFrame's own claim about when it last received data — not when we read the file.
  const syncIsStale = syncedAtMs !== null && Date.now() - syncedAtMs > STALE_SYNC_MS;

  return (
    <div className="af-inv">
      <div className="af-inv-toolbar">
        <input
          className="af-inv-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('inv.search')}
          aria-label={t('inv.search')}
        />
        <select
          className="af-inv-select"
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as SortKey)}
          aria-label={t('inv.sortBy')}
        >
          <option value="count">{t('inv.sortCount')}</option>
          <option value="name">{t('inv.sortName')}</option>
          {showsRank ? <option value="rank">{t('inv.sortRank')}</option> : null}
        </select>
        <button
          className="af-inv-refresh"
          type="button"
          onClick={() => setRefreshedAt(Date.now())}
          title={t('inv.refreshHelp')}
        >
          {t('common.refresh')}
        </button>
        <span className="af-inv-meta">
          {t('inv.stackSummary', { stacks: String(rows.length), total: String(totalCount) })}
          {syncedAt ? ` · ${t('inv.syncedAgo', { time: formatElapsedTime(syncedAt) })}` : ''}
        </span>
      </div>

      {syncIsStale ? (
        <div className="af-inv-stale" role="status">
          {t('inv.staleSync', { time: formatElapsedTime(syncedAt ?? '') })}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="af-inv-state">{t('inv.noneMatch')}</div>
      ) : (
        <table className="af-inv-table">
          <thead>
            <tr>
              <th>{t('inv.colItem')}</th>
              {showsRank ? <th>{t('inv.colRank')}</th> : null}
              <th>{t('inv.colOwned')}</th>
              <th>{t('inv.colValue')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <InventoryRow
                key={`${item.bucket}:${item.uniqueName}:${item.refinement ?? item.rank ?? 'na'}`}
                item={item}
                showsRank={showsRank}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function InventoryRow({ item, showsRank }: { item: AlecaframeItem; showsRank: boolean }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td>
        <span className="af-inv-name">{item.name}</span>
      </td>
      {showsRank ? <td className="af-inv-num af-inv-rank">{formatRank(item, t)}</td> : null}
      <td className="af-inv-num">{item.count}</td>
      {/* Placeholder. The slug bridge now exists (item.slug / item.itemKey are populated),
          so what remains is a price book that survives restart — `recommended_prices` is
          in-memory and only covers items the scanner has touched. */}
      <td className="af-inv-num af-inv-muted">—</td>
    </tr>
  );
}
