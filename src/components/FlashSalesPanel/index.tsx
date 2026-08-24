/**
 * Flash sales — market discounts on platinum bundles and cosmetics.
 *
 * These were **fetched and stored since the Phase 1 worldstate work and rendered nowhere.** They
 * are also the least important thing on this page: nothing here is tradeable, so none of it feeds
 * a trading decision. That is why this is a fixed-height scroller in a corner of News rather than
 * a panel that grows with the list — the value is "is there a discount on right now", and the
 * answer fits in the first two rows.
 */
import { useEffect, useState } from 'react';

import { useTranslation } from '../../i18n';
import { formatWorldStateCountdown } from '../../lib/worldState';
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

  const active = flashSales.filter((sale) => !sale.expired);

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
        /* Fixed height on purpose: the value is "is there a discount on right now", which fits in
           the first two rows, and nothing here is tradeable. */
        <div className="flex max-h-52 flex-col overflow-y-auto">
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
