import { useCallback, useEffect, useState } from 'react';
import { getTradeDetectionComparison } from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import type { ComparisonStatus, TradeComparison } from '../../types';

const STATUS_TONE: Record<ComparisonStatus, string> = {
  matched: 'badge-green',
  shadowOnly: 'badge-blue',
  // The only status that should stop a cutover.
  wfmOnly: 'badge-red',
};

const STATUS_LABEL_KEYS = {
  matched: 'det.matched',
  shadowOnly: 'det.shadowOnly',
  wfmOnly: 'det.wfmOnly',
} as const;

/**
 * Shadow-mode diagnostic: EE.log trade detection versus WFM's.
 *
 * Temporary by design. It exists to answer one question — *can WFM polling be deleted yet?* —
 * and should be removed once the cutover lands. `EE.log` is a debug log DE can change in any
 * patch without notice, so a parser that looks correct is not evidence; sustained agreement
 * with an independent source is.
 */
export function TradeDetectionComparison() {
  const { t } = useTranslation();
  const tradeAccount = useAppStore((state) => state.tradeAccount);
  const [comparison, setComparison] = useState<TradeComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const username = tradeAccount?.name ?? '';

  const load = useCallback(async () => {
    if (!username) {
      return;
    }
    setLoading(true);
    try {
      setComparison(await getTradeDetectionComparison(username));
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!username) {
    return <div className="det-state">{t('det.signInRequired')}</div>;
  }
  if (loading && !comparison) {
    return <div className="det-state">{t('common.loading')}</div>;
  }
  if (error) {
    return (
      <div className="det-state det-error" role="alert">
        {error}
      </div>
    );
  }
  if (!comparison) {
    return <div className="det-state">{t('det.noData')}</div>;
  }

  const { matchedCount, shadowOnlyCount, wfmOnlyCount, unresolvedItemCount, rows } = comparison;
  // Everything hinges on this: a trade WFM saw and the parser did not is a trade the cutover
  // would lose. Anything above zero means not yet.
  const readyToCutOver = wfmOnlyCount === 0 && matchedCount > 0;

  return (
    <div className="det">
      <div className="det-summary">
        <div className="det-stat">
          <span className="det-stat-value tone-green">{matchedCount}</span>
          <span className="det-stat-label">{t('det.matched')}</span>
        </div>
        <div className="det-stat">
          <span className="det-stat-value tone-blue">{shadowOnlyCount}</span>
          <span className="det-stat-label">{t('det.shadowOnly')}</span>
        </div>
        <div className="det-stat">
          <span className={`det-stat-value${wfmOnlyCount > 0 ? ' tone-red' : ''}`}>
            {wfmOnlyCount}
          </span>
          <span className="det-stat-label">{t('det.wfmOnly')}</span>
        </div>
        <div className="det-stat">
          <span className={`det-stat-value${unresolvedItemCount > 0 ? ' tone-amber' : ''}`}>
            {unresolvedItemCount}
          </span>
          <span className="det-stat-label">{t('det.unresolved')}</span>
        </div>
        <button className="det-refresh" type="button" onClick={() => void load()}>
          {t('common.refresh')}
        </button>
      </div>

      <p className={`det-verdict${readyToCutOver ? ' ok' : ''}`}>
        {readyToCutOver ? t('det.verdictReady') : t('det.verdictNotReady')}
      </p>

      {rows.length === 0 ? (
        <div className="det-state">{t('det.empty')}</div>
      ) : (
        <table className="det-table">
          <thead>
            <tr>
              <th>{t('det.colStatus')}</th>
              <th>{t('det.colItem')}</th>
              <th>{t('det.colWhen')}</th>
              <th>{t('det.colPartner')}</th>
              <th>{t('det.colPlat')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.status}:${row.itemName}:${row.occurredAt ?? index}`}>
                <td>
                  <span className={`badge ${STATUS_TONE[row.status]}`}>
                    {t(STATUS_LABEL_KEYS[row.status])}
                  </span>
                </td>
                <td>
                  <span className="det-item">{row.itemName}</span>
                  {/* An item the catalog could not identify would reach the trade log
                      unnamed, so it is called out even when the trade itself matched. */}
                  {row.slug === null ? (
                    <span className="det-unresolved" title={t('det.unresolvedHelp')}>
                      {t('det.unresolvedTag')}
                    </span>
                  ) : null}
                </td>
                <td className="det-num">
                  {row.occurredAt ? formatShortLocalDateTime(row.occurredAt) : '—'}
                </td>
                <td>{row.partner ?? '—'}</td>
                <td className="det-num">{row.platinum}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
