import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { PageHeading } from '../../components/PageHeading';
import { WatchlistAddControls } from '../../components/WatchlistAddControls';
import { WatchlistTable } from '../../components/WatchlistTable';
import { getWatchlistVisualState } from '../../lib/watchlist';
import type { WatchlistTone } from '../../lib/watchlist';
import { formatElapsedTime } from '../../lib/dateTime';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';

/**
 * The watchlist. **Layout is deliberately unchanged** — it works, and this pass is only about
 * bringing its surfaces, type and controls onto the app's primitives:
 *
 * - `.panel-title-row` + `.badge-blue` → `PageHeading`, so the title comes from `nav.watchlist`
 *   and matches every other page rather than being a bespoke header.
 * - `.card` / `.wl-add-card` → `Panel` (8px radius, `border-line`, no shadow or fade-in).
 * - Filter chips → `Button`, which carries `appearance-none`; they were raw `<button>`s and
 *   would render as white UA controls the moment preflight is enabled.
 */
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

  const filters: Array<{ key: WatchlistTone | null; label: string; count: number; dot: string }> = [
    { key: null, label: t('wl.filterAll'), count: watchlist.length, dot: 'bg-ink-faint' },
    { key: 'green', label: t('wl.filterHit'), count: counts.green, dot: 'bg-accent-green' },
    { key: 'amber', label: t('wl.filterClose'), count: counts.amber, dot: 'bg-accent-amber' },
    { key: 'neutral', label: t('wl.filterWatching'), count: counts.neutral, dot: 'bg-ink-faint' },
  ];

  return (
    <>
      <PageHeading
        page="watchlist"
        aside={
          <span className="font-mono text-[10px] tracking-[0.06em] text-ink-faint uppercase tabular-nums">
            {t('evt.itemsCount', { n: watchlist.length })}
          </span>
        }
      />

      <div className="flex flex-col gap-4 p-4">
        <Panel className="gap-2 p-3">
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
            {t('wl.addToWatchlist')}
          </span>
          <WatchlistAddControls mode="search" />
        </Panel>

        <Panel className="gap-0">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
            {filters.map((filter) => {
              const active = toneFilter === filter.key;
              return (
                <Button
                  key={filter.key ?? 'all'}
                  variant="ghost"
                  size="sm"
                  static
                  aria-pressed={active}
                  onClick={() => setToneFilter(filter.key)}
                  className={`h-7 gap-1.5 rounded-md px-2.5 text-[11px] font-medium ${
                    active
                      ? 'bg-bg-elevated text-ink'
                      : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink'
                  }`}
                >
                  <i className={`size-1.5 shrink-0 rounded-full ${filter.dot}`} aria-hidden="true" />
                  {filter.label}
                  <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                    {filter.count}
                  </span>
                </Button>
              );
            })}
            {lastScanned ? (
              <span className="ml-auto font-mono text-[10px] text-ink-faint tabular-nums">
                {t('wl.refreshedAt', { time: formatElapsedTime(lastScanned) })}
              </span>
            ) : null}
          </div>
          <WatchlistTable variant="full" toneFilter={toneFilter} />
        </Panel>
      </div>
    </>
  );
}
