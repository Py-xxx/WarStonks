import { useMemo, useState } from 'react';
import { WatchlistAddControls } from '../../components/WatchlistAddControls';
import { WatchlistTable } from '../../components/WatchlistTable';
import { getWatchlistVisualState } from '../../lib/watchlist';
import type { WatchlistTone } from '../../lib/watchlist';
import { formatElapsedTime } from '../../lib/dateTime';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';

export function WatchlistTab() {
  const { t } = useTranslation();
  const watchlist = useAppStore((state) => state.watchlist);
  const [toneFilter, setToneFilter] = useState<WatchlistTone | null>(null);

  const counts = useMemo(() => {
    const tally: Record<WatchlistTone, number> = { green: 0, amber: 0, neutral: 0 };
    for (const item of watchlist) {
      tally[getWatchlistVisualState(item).tone] += 1;
    }
    return tally;
  }, [watchlist]);

  // The freshest scan across the list — one honest "when did this last update" rather than a
  // per-row column that repeated nearly the same value on every line.
  const lastScanned = useMemo(() => {
    const stamps = watchlist
      .map((item) => item.lastUpdatedAt)
      .filter((value): value is string => Boolean(value));
    return stamps.length ? stamps.sort()[stamps.length - 1] : null;
  }, [watchlist]);

  const filters: Array<{ key: WatchlistTone | null; label: string; count: number }> = [
    { key: null, label: t('wl.filterAll'), count: watchlist.length },
    { key: 'green', label: t('wl.filterHit'), count: counts.green },
    { key: 'amber', label: t('wl.filterClose'), count: counts.amber },
    { key: 'neutral', label: t('wl.filterWatching'), count: counts.neutral },
  ];

  return (
    <div className="wl-fullscreen">
      <div className="panel-title-row">
        <span className="panel-title-eyebrow">{t('wl.watchlist')}</span>
        <span className="badge badge-blue">{t('evt.itemsCount', { n: watchlist.length })}</span>
      </div>

      <div className="wl-add-card">
        <span className="wl-add-eyebrow">{t('wl.addToWatchlist')}</span>
        <WatchlistAddControls mode="search" />
      </div>

      <div className="card wl-table-card">
        <div className="wl-filter-bar">
          {filters.map((filter) => (
            <button
              key={filter.key ?? 'all'}
              type="button"
              className={`wl-filter-chip tone-${filter.key ?? 'all'}${toneFilter === filter.key ? ' active' : ''}`}
              onClick={() => setToneFilter(filter.key)}
            >
              {filter.label} {filter.count}
            </button>
          ))}
          {lastScanned ? (
            <span className="wl-filter-scanned">
              {t('wl.refreshedAt', { time: formatElapsedTime(lastScanned) })}
            </span>
          ) : null}
        </div>
        <WatchlistTable variant="full" toneFilter={toneFilter} />
      </div>
    </div>
  );
}
