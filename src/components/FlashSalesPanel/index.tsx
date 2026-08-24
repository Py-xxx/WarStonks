/**
 * Flash sales — market discounts on platinum bundles and cosmetics.
 *
 * These were **fetched and stored since the Phase 1 worldstate work and rendered nowhere.** They
 * are also the least important thing on this page: nothing here is tradeable, so none of it feeds
 * a trading decision. That is why this is a fixed-height scroller in a corner of News rather than
 * a panel that grows with the list — the value is "is there a discount on right now", and the
 * answer fits in the first two rows.
 */
import { useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../i18n';
import { formatWorldStateCountdown, isWorldStateWindowActive } from '../../lib/worldState';
import { useAppStore } from '../../stores/useAppStore';
import { Countdown, EventEmpty, EventPanel, EventRow, EventTag } from '../Events/parts';

export function FlashSalesPanel() {
  const { t } = useTranslation();
  const flashSales = useAppStore((state) => state.worldStateFlashSales);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  /**
   * Live first, then **soonest to expire**. The list arrives in whatever order the worldstate
   * feed emits, which put the permanent market bundles — the ones reading `1225d` — at the top and
   * buried the sale ending in eight hours below them. The only reason to look at this panel is to
   * catch something before it goes, so the thing closest to going leads.
   *
   * A missing or unparseable expiry sorts last rather than first: "no end date" is not "ending
   * now", and treating it as `0` would put every undated row above every real countdown.
   */
  const active = useMemo(
    () =>
      flashSales
        .filter((sale) => !sale.expired)
        .sort((left, right) => {
          const leftLive = Number(isWorldStateWindowActive(left.activation, left.expiry));
          const rightLive = Number(isWorldStateWindowActive(right.activation, right.expiry));
          const leftEnds = Date.parse(left.expiry ?? '');
          const rightEnds = Date.parse(right.expiry ?? '');
          return (
            rightLive - leftLive ||
            (Number.isFinite(leftEnds) ? leftEnds : Number.MAX_SAFE_INTEGER) -
              (Number.isFinite(rightEnds) ? rightEnds : Number.MAX_SAFE_INTEGER) ||
            left.item.localeCompare(right.item)
          );
        }),
    [flashSales],
  );

  return (
    <EventPanel
      title={t('evt.flashSales')}
      count={active.length}
      countTone={active.length > 0 ? 'positive' : 'muted'}
      bodyClassName="p-2"
    >
      {active.length === 0 ? (
        <EventEmpty icon="ti-tag" title={t('evt.noFlashSales')} detail={t('evt.flashSalesHint')} />
      ) : (
        /* Capped and scrollable: there are ~40 of these and most are permanent market bundles,
           so the column must not grow to their length. The cap is generous now that this is a
           real column on the News tab rather than a block in a corner. */
        <div className="flex max-h-[70vh] flex-col overflow-y-auto">
          {active.map((sale) => (
            <EventRow
              key={sale.id}
              title={sale.item}
              trailing={
                <>
                  {sale.discount !== null && sale.discount > 0 ? (
                    <EventTag tone="green">-{sale.discount}%</EventTag>
                  ) : null}
                  {sale.premiumOverride !== null ? (
                    <span className="font-mono text-[11px] tabular-nums text-ink">
                      {sale.premiumOverride}p
                    </span>
                  ) : null}
                  <Countdown value={formatWorldStateCountdown(sale.expiry, nowMs)} tone="dim" />
                </>
              }
            />
          ))}
        </div>
      )}
    </EventPanel>
  );
}
