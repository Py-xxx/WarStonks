import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { getArbitrageScannerState, readAlecaframeInventory } from '../../lib/tauriClient';
import { formatElapsedTime } from '../../lib/dateTime';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { partKeyForSlug } from '../../lib/partImages';
import { useTranslation } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import type {
  AlecaframeInventory,
  AlecaframeItem,
  AlecaframeItemCategory,
  RelicRoiDropEntry,
  RelicRoiEntry,
} from '../../types';
import { ModalPortal } from '../ModalPortal';
import { useModalA11y } from '../../hooks/useModalA11y';

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

/**
 * Splits an item's name across the tile's two lines: what it is on top, which part of it below.
 *
 * "Baruuk Prime Neuroptics Blueprint" reads faster as "Baruuk Prime" over "Neuroptics" than as
 * one truncated line, and it puts the varying word on its own row so a column of one warframe's
 * parts scans vertically. The split is driven by the **slug**, which is language-independent and
 * already tells us whether the item is a component and how many words its part name has.
 *
 * Anything that isn't a component keeps its whole name on the first line.
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
  const [relicDrops, setRelicDrops] = useState<RelicDropIndex>(new Map());
  const [openRelic, setOpenRelic] = useState<AlecaframeItem | null>(null);

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
      .filter((item) => {
        if (!query) {
          return true;
        }
        if (item.name.toLowerCase().includes(query)) {
          return true;
        }
        // Searching a relic tab by *drop* — "octavia prime systems" finds every relic that
        // drops it. This is how the manual relic view worked and it is the main reason to
        // search relics at all; you almost never want a relic by name.
        return (
          relicDrops
            .get(item.slug)
            ?.drops.some((drop) => drop.name.toLowerCase().includes(query)) ?? false
        );
      })
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
  }, [inventory, tab, deferredSearch, sortKey, relicDrops]);

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
        <div className="af-inv-grid">
          {rows.map((item) => (
            <InventoryTile
              onOpen={tab === 'relics' ? setOpenRelic : undefined}
              /* Rank and refinement are separate dimensions — collapsing them into one `??`
                 made a rankless, refinementless row key-identical to its neighbours, and React
                 reused their DOM across tab switches. */
              key={`${item.bucket}:${item.uniqueName}:${item.rank ?? 'na'}:${item.refinement ?? 'na'}`}
              item={item}
              showsRank={showsRank}
            />
          ))}
        </div>
      )}

      {openRelic ? (
        <RelicDropModal
          item={openRelic}
          relic={relicDrops.get(openRelic.slug) ?? null}
          onClose={() => setOpenRelic(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * One inventory item.
 *
 * The same tile is used on every tab, so the eye learns one layout: icon, name over part, rank
 * pips where the item ranks, value, and an owned count pinned to the corner. Parts and mods
 * differ by a single row rather than by shape.
 */
function InventoryTile({
  item,
  showsRank,
  onOpen,
}: {
  item: AlecaframeItem;
  showsRank: boolean;
  /** Present only where a tile has something to open — relics, which have a drop table. */
  onOpen?: (item: AlecaframeItem) => void;
}) {
  const { primary, secondary } = splitItemLabel(item);
  // Components resolve to our own part art; everything else keeps Warframe.Market's, which is
  // already unique per mod and per arcane.
  const iconUrl = resolveWfmAssetUrl(item.imagePath, item.slug);

  const body = (
    <>
      <span className="af-tile-count">{item.count}</span>
      <span className="af-tile-icon" aria-hidden="true">
        {iconUrl ? (
          <img src={iconUrl} alt="" loading="lazy" />
        ) : (
          <span className="af-tile-icon-fallback">{item.name.charAt(0)}</span>
        )}
      </span>
      <span className="af-tile-name">
        <span className="af-tile-name-primary">{primary}</span>
        {secondary ? <span className="af-tile-name-secondary">{secondary}</span> : null}
      </span>
      {showsRank ? <RankPips item={item} /> : null}
      {/* Placeholder until the price book is durable: `recommended_prices` is in-memory and
          only covers items the scanner has touched, so most tiles would read a stale price. */}
      <span className="af-tile-value af-inv-muted">—</span>
    </>
  );

  if (!onOpen) {
    return (
      <article className="af-tile" title={item.name}>
        {body}
      </article>
    );
  }

  return (
    <button className="af-tile af-tile-button" type="button" title={item.name} onClick={() => onOpen(item)}>
      {body}
    </button>
  );
}

/**
 * Rank drawn the way the game draws it — one pip per level, filled up to the current rank.
 *
 * A fraction makes you read and compare; pips are scannable, and they make two stacks of the
 * same arcane at different ranks obviously different goods rather than a repeated row.
 * Relics have no levels, so their refinement stays a word.
 */
function RankPips({ item }: { item: AlecaframeItem }) {
  const { t } = useTranslation();
  if (item.refinement) {
    return <span className="af-tile-refinement">{formatRank(item, t)}</span>;
  }
  if (item.rank === null || item.maxRank === null || item.maxRank <= 0) {
    return <span className="af-tile-pips af-tile-pips-empty" />;
  }

  return (
    <span
      className="af-tile-pips"
      role="img"
      aria-label={t('inv.rankOf', { rank: String(item.rank), max: String(item.maxRank) })}
    >
      {Array.from({ length: item.maxRank }, (_, index) => (
        <span key={index} className={`af-pip${index < (item.rank ?? 0) ? ' is-filled' : ''}`} />
      ))}
    </span>
  );
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
function RelicDropModal({
  item,
  relic,
  onClose,
}: {
  item: AlecaframeItem;
  relic: RelicRoiEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const refinement = item.refinement ?? 'intact';

  const drops = useMemo(() => {
    if (!relic) {
      return [];
    }
    // Most valuable first: the question this table answers is "is this worth cracking".
    return [...relic.drops].sort((left, right) => (dropValue(right) ?? -1) - (dropValue(left) ?? -1));
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

  // Focus trap, Escape and restore-focus, same as every other modal here.
  const modalRef = useModalA11y<HTMLDivElement>({ onClose, active: true });

  return (
    <ModalPortal>
      <div className="modal-backdrop" onClick={onClose}>
        <div
          ref={modalRef}
          className="af-relic-modal"
          role="dialog"
          aria-modal="true"
          aria-label={item.name}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="af-relic-modal-head">
            <div>
              <span className="panel-title-eyebrow">
                {item.refinement ? t(REFINEMENT_LABEL_KEYS[item.refinement]) : t('opp.unknown')}
                {' · '}
                {t('inv.ownedCount', { n: String(item.count) })}
              </span>
              <h3>{item.name}</h3>
            </div>
            <button type="button" className="act-btn" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>

          {expectedValue !== null ? (
            <div className="af-relic-expected">
              {t('inv.expectedValue')}
              <strong>{expectedValue}p</strong>
            </div>
          ) : null}

          {drops.length === 0 ? (
            <div className="af-inv-state">{t('opp.noDropData')}</div>
          ) : (
            <ul className="af-relic-drops">
              {drops.map((drop) => {
                const chance = drop.chanceProfile[CHANCE_FIELD[refinement]];
                const value = dropValue(drop);
                const icon = resolveWfmAssetUrl(drop.imagePath, drop.slug);
                return (
                  <li key={drop.slug} className="af-relic-drop">
                    <span className="af-relic-drop-thumb">
                      {icon ? <img src={icon} alt="" loading="lazy" /> : <span>{drop.name.charAt(0)}</span>}
                    </span>
                    <span className="af-relic-drop-name">{drop.name}</span>
                    <span className="af-relic-drop-chance">
                      {chance === null ? '—' : `${chance}%`}
                    </span>
                    <span className={`af-relic-drop-value${value === null ? ' af-inv-muted' : ''}`}>
                      {value === null ? '—' : `${value}p`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
