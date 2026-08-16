import { useCallback, useEffect, useMemo, useState } from 'react';
import { getEeLogShadowTrades, getTradeDetectionComparison } from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { useTranslation } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import type {
  ComparisonStatus,
  ShadowTradeRow,
  TradeComparison,
  TradeIngestReason,
  TradeIngestStatus,
} from '../../types';

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

/** Tone by severity. A deliberate exclusion is not a failure and must not read like one. */
const INGEST_TONE: Record<TradeIngestStatus, string> = {
  logged: 'badge-green',
  partiallyLogged: 'badge-amber',
  notLogged: 'badge-red',
  notPriceable: 'badge-muted',
};

const INGEST_STATUS_KEYS = {
  logged: 'det.ingest.logged',
  partiallyLogged: 'det.ingest.partiallyLogged',
  notLogged: 'det.ingest.notLogged',
  notPriceable: 'det.ingest.notPriceable',
} as const;

const INGEST_REASON_KEYS = {
  noPlatinumPrice: 'det.reason.noPlatinumPrice',
  noTradableItems: 'det.reason.noTradableItems',
  notSignedIn: 'det.reason.notSignedIn',
  rejectedAsDuplicate: 'det.reason.rejectedAsDuplicate',
  unknown: 'det.reason.unknown',
} as const;

/** Every item on the priced side, for naming what the trade actually contained. */
function tradeItemSummary(row: ShadowTradeRow): string {
  const items = [...row.giving, ...row.getting].filter(
    (item) => item.name.toLowerCase() !== 'platinum',
  );
  if (items.length === 0) {
    return '—';
  }
  return items.map((item) => `${item.name}${item.quantity > 1 ? ` x${item.quantity}` : ''}`).join(', ');
}

/**
 * One row per trade EE.log saw that the ledger did not keep intact.
 *
 * This is the tab's real job now. EE.log is truncated on the next game launch, so a trade that
 * was detected and then dropped is unrecoverable once the game restarts — and every drop path
 * used to be silent, which made "my trade wasn't logged" impossible to answer. A trade with no
 * recorded outcome is shown as unknown rather than assumed successful.
 */
function NotLoggedPanel({ rows, t }: { rows: ShadowTradeRow[]; t: TranslateFn }) {
  const problems = useMemo(
    () => rows.filter((row) => row.ingestStatus !== null && row.ingestStatus !== 'logged'),
    [rows],
  );
  const untracked = useMemo(
    () => rows.filter((row) => row.ingestStatus === null).length,
    [rows],
  );

  return (
    <section className="det-ingest">
      <header className="det-ingest-head">
        <h3 className="det-ingest-title">{t('det.ingest.title')}</h3>
        <span className="det-ingest-sub">{t('det.ingest.subtitle')}</span>
      </header>

      {problems.length === 0 ? (
        <div className="det-state det-ingest-clear">{t('det.ingest.allLogged')}</div>
      ) : (
        <table className="det-table det-ingest-table">
          <thead>
            <tr>
              <th>{t('det.colStatus')}</th>
              <th>{t('det.ingest.colReason')}</th>
              <th>{t('det.colItem')}</th>
              <th>{t('det.colWhen')}</th>
              <th>{t('det.colPartner')}</th>
              <th className="det-num">{t('det.ingest.colRows')}</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((row) => (
              <tr key={row.tradeKey}>
                <td>
                  <span className={`badge ${INGEST_TONE[row.ingestStatus!]}`}>
                    {t(INGEST_STATUS_KEYS[row.ingestStatus!])}
                  </span>
                </td>
                <td className="det-reason">
                  <span>
                    {row.ingestReason
                      ? t(INGEST_REASON_KEYS[row.ingestReason as TradeIngestReason])
                      : t('det.reason.unknown')}
                  </span>
                  {/* Which rows are missing, when the backend could name them — "a trade was
                      dropped" is far less actionable than "this item's row was dropped". */}
                  {row.ingestDetail ? (
                    <span className="det-reason-detail">{row.ingestDetail}</span>
                  ) : null}
                </td>
                <td>{tradeItemSummary(row)}</td>
                <td className="det-num">
                  {row.occurredAt ? formatShortLocalDateTime(row.occurredAt) : '—'}
                </td>
                <td>{row.partner || '—'}</td>
                <td className="det-num">
                  {row.expectedRows === null
                    ? '—'
                    : `${row.loggedRows ?? 0}/${row.expectedRows}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Trades recorded before outcomes were tracked. Counted rather than listed, and never
          folded in with the successes — their real outcome is genuinely unknown. */}
      {untracked > 0 ? (
        <p className="det-ingest-untracked">{t('det.ingest.untracked', { count: String(untracked) })}</p>
      ) : null}
    </section>
  );
}

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
  const [shadowRows, setShadowRows] = useState<ShadowTradeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const username = tradeAccount?.name ?? '';

  const load = useCallback(async () => {
    if (!username) {
      return;
    }
    setLoading(true);
    try {
      // The ingest outcomes are the part worth showing, so they are not gated on the legacy
      // comparison succeeding — a WFM-side failure must not hide "your trade wasn't logged".
      const [nextComparison, nextShadow] = await Promise.all([
        getTradeDetectionComparison(username),
        getEeLogShadowTrades(),
      ]);
      setComparison(nextComparison);
      setShadowRows(nextShadow);
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
      {/* First, because it is the only part that reports live data loss. The WFM comparison
          below is a cutover-era artefact kept for debugging. */}
      <NotLoggedPanel rows={shadowRows} t={t} />

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
