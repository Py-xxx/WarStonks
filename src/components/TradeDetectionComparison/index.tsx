import { useCallback, useEffect, useMemo, useState } from 'react';
import { getEeLogShadowTrades, getTradeDetectionComparison } from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
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
    <Panel className="min-w-0 gap-2 p-3">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-xs font-semibold text-ink">{t('det.ingest.title')}</h3>
        <span className="text-[10px] leading-relaxed text-ink-dim">{t('det.ingest.subtitle')}</span>
      </header>

      {problems.length === 0 ? (
        <p className="rounded-md border border-accent-green/25 bg-accent-green/8 px-2.5 py-2 text-[11px] text-accent-green">{t('det.ingest.allLogged')}</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="[&>th]:border-b [&>th]:border-line [&>th]:px-2.5 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-mono [&>th]:text-[9px] [&>th]:font-semibold [&>th]:tracking-[0.07em] [&>th]:text-ink-dim [&>th]:uppercase">
              <th>{t('det.colStatus')}</th>
              <th>{t('det.ingest.colReason')}</th>
              <th>{t('det.colItem')}</th>
              <th>{t('det.colWhen')}</th>
              <th>{t('det.colPartner')}</th>
              <th className="text-right">{t('det.ingest.colRows')}</th>
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
                <td>
                  <span>
                    {row.ingestReason
                      ? t(INGEST_REASON_KEYS[row.ingestReason as TradeIngestReason])
                      : t('det.reason.unknown')}
                  </span>
                  {/* Which rows are missing, when the backend could name them — "a trade was
                      dropped" is far less actionable than "this item's row was dropped". */}
                  {row.ingestDetail ? (
                    <span className="block text-[10px] text-ink-faint">{row.ingestDetail}</span>
                  ) : null}
                </td>
                <td>{tradeItemSummary(row)}</td>
                <td className="text-right font-mono tabular-nums">
                  {row.occurredAt ? formatShortLocalDateTime(row.occurredAt) : '—'}
                </td>
                <td>{row.partner || '—'}</td>
                <td className="text-right font-mono tabular-nums">
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
        <p className="text-[10px] text-ink-faint">{t('det.ingest.untracked', { count: String(untracked) })}</p>
      ) : null}
    </Panel>
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
    return <p className="px-1 py-2 text-[11px] text-ink-dim">{t('det.signInRequired')}</p>;
  }
  if (loading && !comparison) {
    return <p className="px-1 py-2 text-[11px] text-ink-dim">{t('common.loading')}</p>;
  }
  if (error) {
    return (
      <p className="rounded-md border border-accent-red/25 bg-accent-red/8 px-2.5 py-2 text-[11px] text-accent-red" role="alert">
        {error}
      </p>
    );
  }
  if (!comparison) {
    return <p className="px-1 py-2 text-[11px] text-ink-dim">{t('det.noData')}</p>;
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

      <Panel className="flex-row flex-wrap items-center gap-5 px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-lg font-bold tabular-nums text-accent-green">{matchedCount}</span>
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('det.matched')}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-lg font-bold tabular-nums text-accent-blue">{shadowOnlyCount}</span>
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('det.shadowOnly')}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={`font-mono text-lg font-bold tabular-nums ${wfmOnlyCount > 0 ? 'text-accent-red' : 'text-ink'}`}>
            {wfmOnlyCount}
          </span>
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('det.wfmOnly')}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={`font-mono text-lg font-bold tabular-nums ${unresolvedItemCount > 0 ? 'text-accent-amber' : 'text-ink'}`}>
            {unresolvedItemCount}
          </span>
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('det.unresolved')}</span>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void load()}>
          <i className="ti ti-refresh" aria-hidden="true" />
          {t('common.refresh')}
        </Button>
      </Panel>

      {/* The whole point of this debug tab: whether local detection can replace the WFM poll. */}
      <p
        className={`rounded-md border px-2.5 py-2 text-[11px] leading-relaxed ${
          readyToCutOver
            ? 'border-accent-green/25 bg-accent-green/8 text-accent-green'
            : 'border-accent-amber/25 bg-accent-amber/8 text-accent-amber'
        }`}
      >
        {readyToCutOver ? t('det.verdictReady') : t('det.verdictNotReady')}
      </p>

      {rows.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-ink-dim">{t('det.empty')}</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="[&>th]:border-b [&>th]:border-line [&>th]:px-2.5 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-mono [&>th]:text-[9px] [&>th]:font-semibold [&>th]:tracking-[0.07em] [&>th]:text-ink-dim [&>th]:uppercase">
              <th>{t('det.colStatus')}</th>
              <th>{t('det.colItem')}</th>
              <th>{t('det.colWhen')}</th>
              <th>{t('det.colPartner')}</th>
              <th>{t('det.colPlat')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.status}:${row.itemName}:${row.occurredAt ?? index}`} className="[&>td]:border-b [&>td]:border-line-subtle [&>td]:px-2.5 [&>td]:py-1.5 [&>td]:text-[11px] [&>td]:text-ink-soft">
                <td>
                  <span className={`badge ${STATUS_TONE[row.status]}`}>
                    {t(STATUS_LABEL_KEYS[row.status])}
                  </span>
                </td>
                <td>
                  <span className="text-ink">{row.itemName}</span>
                  {/* An item the catalog could not identify would reach the trade log
                      unnamed, so it is called out even when the trade itself matched. */}
                  {row.slug === null ? (
                    <span
                      className="ml-1 rounded bg-accent-amber/15 px-1 py-px font-mono text-[9px] font-semibold text-accent-amber uppercase"
                      title={t('det.unresolvedHelp')}
                    >
                      {t('det.unresolvedTag')}
                    </span>
                  ) : null}
                </td>
                <td className="text-right font-mono tabular-nums">
                  {row.occurredAt ? formatShortLocalDateTime(row.occurredAt) : '—'}
                </td>
                <td>{row.partner ?? '—'}</td>
                <td className="text-right font-mono tabular-nums">{row.platinum}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
