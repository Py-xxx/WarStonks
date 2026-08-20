import { useMemo } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { WatchlistTable } from '../../components/WatchlistTable';
import { useTranslation } from '../../i18n';
import { getWatchlistVisualState } from '../../lib/watchlist';
import { useAppStore } from '../../stores/useAppStore';
import { HomePanel } from './HomePanel';

/** Rows worth acting on: at or under target (green), or close to it (amber). Everything else is
 *  just being watched and belongs on the Watchlist page. */
const ACTIONABLE_TONES = ['green', 'amber'] as const;

/**
 * Watchlist, reduced to what needs acting on.
 *
 * A dashboard is the wrong place to do CRUD, so adding, retargeting and bulk management live on
 * the Watchlist page. This panel shows only rows at or near target and links to the full list.
 *
 * Row behaviour is unchanged: this reuses `WatchlistTable`, so Copy whisper / Mark as bought /
 * Remove keep working exactly as they always have. A change of surface, not of function.
 */
export function WatchlistSummary() {
  const { t } = useTranslation();
  const watchlist = useAppStore((s) => s.watchlist);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const actionableCount = useMemo(
    () =>
      watchlist.filter((item) => {
        const tone = getWatchlistVisualState(item).tone;
        return tone === 'green' || tone === 'amber';
      }).length,
    [watchlist],
  );

  return (
    <HomePanel
      title={t('wl.watchlist')}
      dotClass="bg-accent-green"
      count={actionableCount}
      meta={t('home.ofTracked', { n: watchlist.length })}
      linkLabel={t('home.openWatchlist')}
      onLink={() => setActivePage('watchlist')}
    >
      {actionableCount === 0 ? (
        <EmptyState
          icon={watchlist.length === 0 ? 'ti-target' : 'ti-eye'}
          tone="neutral"
          title={watchlist.length === 0 ? t('home.watchlistEmpty') : t('home.watchlistNothingReady')}
          detail={
            watchlist.length === 0
              ? t('home.watchlistEmptyDetail')
              : t('home.watchlistNothingReadyDetail', { n: watchlist.length })
          }
        />
      ) : (
        <WatchlistTable variant="compact" toneFilter={[...ACTIONABLE_TONES]} />
      )}
    </HomePanel>
  );
}
