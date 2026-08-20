import { useMemo } from 'react';

import { Stat } from '@/components/ui/stat';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { useTranslation } from '../../i18n';
import { getWatchlistVisualState } from '../../lib/watchlist';
import { useAppStore } from '../../stores/useAppStore';
import { ActNow } from './ActNow';
import { HomeRail } from './HomeRail';
import { useRankedOpportunities } from './useRankedOpportunities';
import { WatchlistSummary } from './WatchlistSummary';

/**
 * Home — a live board answering "what should I act on right now".
 *
 * Replaces the old Overview/Watchlist/Alerts sub-tabs:
 * - Quick View and Analysis Preview moved to Market, where the analysis they defer to lives.
 * - The full watchlist is now its own top-level page; Home keeps only what needs acting on.
 * - Alerts are covered by the rail's "closing soon" and by the Events page.
 *
 * Layout is a main column plus a sticky rail rather than a fixed grid, so it reflows honestly
 * from ultrawide down to a narrow window — the old 2×2 quadrants could not.
 */

/**
 * Three plain counts, on the Trades → Health model (`NEEDS ACTION / COMPETITIVE / LIKELY SOON`).
 *
 * Every figure here is a count of the queue directly below it, so the header never asserts
 * anything the page doesn't already show — which is what makes Health's version trustworthy.
 * An earlier version carried units, badges and sub-notes, and rendered "0 live snipes" beside a
 * badge stating the same number.
 */
function StatStrip() {
  const { t } = useTranslation();
  const watchlist = useAppStore((s) => s.watchlist);
  const { ranked } = useRankedOpportunities();

  const expiring = useMemo(
    () => ranked.filter((opportunity) => opportunity.urgency === 'expiring').length,
    [ranked],
  );

  const atTarget = useMemo(
    () => watchlist.filter((item) => getWatchlistVisualState(item).tone === 'green').length,
    [watchlist],
  );

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {/* Icons reuse the app's existing vocabulary rather than introducing new glyphs: flame
          already means urgent here, bolt means a play, target means a watchlist hit. */}
      <Stat
        label={t('home.statExpiring')}
        value={String(expiring)}
        icon="ti-flame"
        tone={expiring > 0 ? 'negative' : 'muted'}
      />
      <Stat
        label={t('home.statPlays')}
        value={String(ranked.length)}
        icon="ti-bolt"
        tone={ranked.length > 0 ? 'neutral' : 'muted'}
      />
      <Stat
        label={t('home.statTarget')}
        value={String(atTarget)}
        icon="ti-target"
        tone={atTarget > 0 ? 'positive' : 'muted'}
      />
    </div>
  );
}

export function HomePage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">{t('nav.home')}</h1>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.04em] text-ink-dim">
          <i
            className="size-1.5 rounded-full bg-accent-green shadow-[0_0_0_3px_rgba(61,214,140,0.15)]"
            aria-hidden="true"
          />
          {t('home.live')}
        </span>
      </div>

      <StatStrip />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_276px]">
        <div className="flex min-w-0 flex-col gap-4">
          <ErrorBoundary label="Act now">
            <ActNow />
          </ErrorBoundary>
          <ErrorBoundary label="Watchlist summary">
            <WatchlistSummary />
          </ErrorBoundary>
        </div>
        <ErrorBoundary label="Home rail">
          <HomeRail />
        </ErrorBoundary>
      </div>
    </div>
  );
}
