import { useCallback, useEffect, useState } from 'react';
import { getPriceHistoryStatus, refreshPriceHistory } from '../../lib/tauriClient';
import { formatElapsedTime } from '../../lib/dateTime';
import { useTranslation } from '../../i18n';
import type { PriceHistoryStatus } from '../../types';

/**
 * Where the app's baseline prices come from, and how fresh they are.
 *
 * Lives on the Scanners page because that is the page about collecting market data, and both
 * its tabs — arbitrage and relic ROI — now fall back to this history for items no scan has
 * reached. It is also the only place relics.run is credited in the UI, which matters: the data
 * is theirs, republished, and attribution should not live only in a source comment.
 *
 * Deliberately one line. This is ambient context, not a feature — the number worth reading at a
 * glance is how many items are priced.
 */
export function PriceHistoryBar() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PriceHistoryStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await getPriceHistoryStatus());
    } catch {
      // Not fatal, and not worth an error state: the bar simply does not render. The scanner
      // below it works regardless of whether history has been ingested.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshPriceHistory();
      await load();
    } catch {
      // Same reasoning — a failed manual refresh leaves the previous numbers on screen.
    } finally {
      setRefreshing(false);
    }
  };

  if (!status) {
    return null;
  }

  // Nothing ingested yet is a real state on a fresh install: the background pass runs ~45s
  // after launch. Saying so beats showing "0 items", which reads as broken.
  const pending = status.itemCount === 0;

  return (
    <div className="price-history-bar">
      <span className="price-history-primary">
        {pending
          ? t('ph.pending')
          : t('ph.coverage', { items: status.itemCount.toLocaleString() })}
      </span>

      {!pending ? (
        <span className="price-history-meta">
          {t('ph.days', { days: String(status.daysStored) })}
          {status.newestDay ? ` · ${t('ph.newest', { day: status.newestDay })}` : ''}
          {status.lastIngestAt
            ? ` · ${t('ph.checked', { time: formatElapsedTime(status.lastIngestAt) })}`
            : ''}
        </span>
      ) : null}

      {/* The data is relics.run's, republished. Crediting it here rather than only in a code
          comment is the point of having this bar at all. */}
      <span className="price-history-source" title={t('ph.sourceHelp')}>
        {t('ph.source')}
      </span>

      <button
        className="price-history-refresh"
        type="button"
        onClick={() => void handleRefresh()}
        disabled={refreshing}
      >
        {refreshing ? t('common.refreshing') : t('common.refresh')}
      </button>
    </div>
  );
}
