import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { readAlecaframeInventory } from '../../lib/tauriClient';
import { formatElapsedTime } from '../../lib/dateTime';
import { useTranslation } from '../../i18n';
import type { AlecaframeInventory, AlecaframeItem, AlecaframeItemCategory } from '../../types';

/** The categories worth listing on their own. Everything else (resources, fish, gems) is
 *  high-count noise that belongs in the game, not a trading tool. */
export type AlecaframeInventoryTab = 'prime-parts' | 'mods' | 'arcanes';

const TAB_CATEGORY: Record<AlecaframeInventoryTab, AlecaframeItemCategory> = {
  'prime-parts': 'blueprint',
  mods: 'mod',
  arcanes: 'arcane',
};

type SortKey = 'name' | 'count';

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
  const [hideUnresolved, setHideUnresolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void readAlecaframeInventory()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setInventory(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          // The realistic failure is AlecaFrame rotating its static key, and the backend
          // message says so. Surfacing it beats showing an empty inventory that looks
          // like the user simply owns nothing.
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    if (!inventory) {
      return [];
    }
    const category = TAB_CATEGORY[tab];
    const query = deferredSearch.trim().toLowerCase();

    return inventory.items
      .filter((item) => item.category === category)
      .filter((item) => (hideUnresolved ? item.nameResolved : true))
      .filter((item) => (query ? item.name.toLowerCase().includes(query) : true))
      .sort((left, right) =>
        sortKey === 'count'
          ? right.count - left.count || left.name.localeCompare(right.name)
          : left.name.localeCompare(right.name),
      );
  }, [inventory, tab, deferredSearch, sortKey, hideUnresolved]);

  const totalCount = useMemo(
    () => rows.reduce((sum, item) => sum + item.count, 0),
    [rows],
  );

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

  const syncedAt = inventory.lastInventorySync
    ? new Date(inventory.lastInventorySync * 1000).toISOString()
    : null;

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
        </select>
        {/* ~7% of a real inventory is newer than AlecaFrame's cached codex and shows its
            raw /Lotus/... path. Hiding them is a convenience, never the default — the
            gap should be visible. */}
        {inventory.unresolvedNameCount > 0 ? (
          <label className="af-inv-check">
            <input
              type="checkbox"
              checked={hideUnresolved}
              onChange={(event) => setHideUnresolved(event.target.checked)}
            />
            {t('inv.hideUnnamed')}
          </label>
        ) : null}
        <span className="af-inv-meta">
          {t('inv.stackSummary', { stacks: String(rows.length), total: String(totalCount) })}
          {syncedAt ? ` · ${t('inv.syncedAgo', { time: formatElapsedTime(syncedAt) })}` : ''}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="af-inv-state">{t('inv.noneMatch')}</div>
      ) : (
        <table className="af-inv-table">
          <thead>
            <tr>
              <th>{t('inv.colItem')}</th>
              <th>{t('inv.colOwned')}</th>
              <th>{t('inv.colValue')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <InventoryRow key={`${item.bucket}:${item.uniqueName}`} item={item} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function InventoryRow({ item }: { item: AlecaframeItem }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td>
        <span className={`af-inv-name${item.nameResolved ? '' : ' unresolved'}`}>{item.name}</span>
        {!item.nameResolved ? (
          <span className="af-inv-badge" title={t('inv.unnamedHelp')}>
            {t('inv.unnamed')}
          </span>
        ) : null}
      </td>
      <td className="af-inv-num">{item.count}</td>
      {/* Placeholder: per-item valuation needs uniqueName -> WFM slug resolution (the
          catalog step) and a price book that survives restart. Rendered as an explicit
          dash so the column exists and stays visible rather than being retrofitted. */}
      <td className="af-inv-num af-inv-muted">—</td>
    </tr>
  );
}
