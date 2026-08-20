import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import {
  useAppStore,
  UNDERPRICED_LISTING_TTL_MS,
  type UnderpricedListingCard,
} from '../../stores/useAppStore';
import { getRadarStats, verifyMarketListing, type RadarStats } from '../../lib/tauriClient';
import { useTranslation } from '../../i18n';
import { copyWhisperMessage } from '../../lib/marketMessages';

/**
 * The underpriced radar — live sell listings priced well below their recommended entry.
 *
 * Deliberately NOT merged into the opportunity board beside it. A board play is computed and
 * keeps: you can come back to it in an hour. A radar listing is somebody else's order that
 * expires from the list in five minutes and may be gone before you whisper. Same platinum,
 * different clock, and the countdown column is what says so.
 */

/** Ported from `.radar-card-*`: the tier colours the left edge, the frame stays neutral. `normal`
 *  is muted ink rather than an accent — an ordinary listing is not a signal. */
const TIER_CLASS: Record<string, string> = {
  red: 'border-l-accent-red',
  yellow: 'border-l-accent-amber',
  normal: 'border-l-ink-faint',
};

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function UnderpricedCard({ card, now }: { card: UnderpricedListingCard; now: number }) {
  const { t } = useTranslation();
  const updateListing = useAppStore((state) => state.updateUnderpricedListing);
  const removeListing = useAppStore((state) => state.removeUnderpricedListing);
  const pushToast = useAppStore((state) => state.pushToast);

  const remainingMs = UNDERPRICED_LISTING_TTL_MS - (now - card.receivedAt);
  const buyPrice = Math.round(card.verifiedPrice ?? card.listedPrice);
  const dead = card.status === 'gone' || card.status === 'overpriced';

  const copyWhisper = async () => {
    await copyWhisperMessage(
      { username: card.username, platinum: buyPrice, rank: card.rank },
      card.itemName,
    );
  };

  const handleVerify = async () => {
    if (!card.userSlug) {
      pushToast(t('up.noHandle'), 'error');
      return;
    }
    updateListing(card.orderId, { status: 'verifying' });
    try {
      const result = await verifyMarketListing({
        orderId: card.orderId,
        userSlug: card.userSlug,
        itemId: card.itemId,
        rank: card.rank,
        expectedPrice: Math.round(card.listedPrice),
        recommendedPrice: card.recommendedPrice,
      });

      if (!result.stillListed) {
        updateListing(card.orderId, { status: 'gone' });
        pushToast(t('up.unavailable'), 'info');
        return;
      }

      const priceNow = Math.round(result.currentPrice ?? card.listedPrice);
      const priceBefore = Math.round(card.verifiedPrice ?? card.listedPrice);
      // Preserve the *original* delta across repeated verifies, so a second edit still shows
      // the change from what the user was first told rather than from the last check.
      const repricedFrom =
        priceNow === priceBefore
          ? card.repricedFrom
          : card.repricedFrom ?? { price: priceBefore, pctBelow: card.pctBelow };
      const pctBelowNow =
        card.recommendedPrice > 0
          ? Math.max(0, (1 - priceNow / card.recommendedPrice) * 100)
          : card.pctBelow;

      // The seller priced it out of deal territory. Still buyable, but not worth a whisper —
      // so don't copy a message the user didn't ask for at a price they'd reject.
      if (result.stillUnderpriced === false) {
        updateListing(card.orderId, {
          status: 'overpriced',
          verifiedPrice: priceNow,
          pctBelow: pctBelowNow,
          repricedFrom,
        });
        pushToast(t('up.nowOverpriced', { from: priceBefore, to: priceNow }), 'info');
        return;
      }

      updateListing(card.orderId, {
        status: 'verified',
        verifiedPrice: priceNow,
        pctBelow: pctBelowNow,
        repricedFrom,
      });
      // Auto-copy the whisper at the confirmed current price.
      await copyWhisperMessage(
        { username: card.username, platinum: priceNow, rank: card.rank },
        card.itemName,
      );
      // Never report a bare "copied" when the number moved — the user is about to whisper a
      // price they haven't seen, which is the whole bug this guards against.
      pushToast(
        repricedFrom && repricedFrom.price !== priceNow
          ? t('up.repricedCopied', { from: repricedFrom.price, to: priceNow })
          : t('up.stillActive'),
        repricedFrom && repricedFrom.price !== priceNow ? 'info' : 'success',
      );
    } catch (error) {
      updateListing(card.orderId, { status: 'new' });
      pushToast(error instanceof Error ? error.message : t('up.verifyFailed'), 'error');
    }
  };

  const handleCopyAgain = async () => {
    try {
      await copyWhisper();
      pushToast(t('up.msgCopied'), 'success');
    } catch {
      pushToast(t('up.copyFailed'), 'error');
    }
  };

  return (
    <article
      className={`flex flex-col gap-1.5 rounded-md border border-l-[3px] border-line-strong bg-bg-elevated px-2.5 py-2 ${
        TIER_CLASS[card.tier] ?? TIER_CLASS.normal
      } ${dead ? 'opacity-50' : ''}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate text-xs font-semibold text-ink" title={card.itemName}>
          {card.itemName}
          {card.rank !== null ? (
            <span className="ml-1 font-mono text-[10px] text-ink-dim tabular-nums">
              R{card.rank}
            </span>
          ) : null}
        </span>
        <span className="min-w-0 flex-1" />
        {/* The one fact the board can't tell you: how long this listing has left on the radar. */}
        <span
          className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums"
          aria-label={t('a11y.timeRemaining')}
        >
          {formatCountdown(remainingMs)}
        </span>
      </div>

      {card.completesSet ? (
        <span
          className="w-fit rounded bg-accent-purple/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent-purple tabular-nums"
          title={t('up.ownParts', {
            owned: card.completesSet.ownedDistinct,
            needed: card.completesSet.neededDistinct,
          })}
        >
          {t('up.completesSetShort', {
            set: card.completesSet.setName,
            owned: card.completesSet.ownedDistinct,
            needed: card.completesSet.neededDistinct,
          })}
        </span>
      ) : null}

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm font-bold text-ink tabular-nums">{buyPrice}p</span>
        <span className="font-mono text-[11px] font-semibold text-accent-green tabular-nums">
          −{Math.round(card.pctBelow)}%
        </span>
        <span className="min-w-0 flex-1" />
        <span className="font-mono text-[10px] text-ink-faint tabular-nums">
          {t('wl.usualEntry')} {Math.round(card.recommendedPrice)}p
        </span>
      </div>

      <div className="truncate text-[11px] text-ink-dim">{card.username}</div>

      {/* The seller edited their price after we surfaced this. Shown on the card itself — a
          toast alone is too easy to miss before whispering. */}
      {card.repricedFrom ? (
        <div
          className="flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] text-accent-red tabular-nums"
          role="status"
        >
          <span className="font-semibold">{t('up.priceChanged')}</span>
          <span>
            {card.repricedFrom.price}p <span aria-hidden="true">→</span> {buyPrice}p
          </span>
          <span>
            −{Math.round(card.repricedFrom.pctBelow)}% <span aria-hidden="true">→</span> −
            {Math.round(card.pctBelow)}%
          </span>
        </div>
      ) : null}

      <div className="mt-0.5 flex items-center gap-1.5">
        {card.status === 'gone' ? (
          <span className="text-[11px] text-ink-faint">{t('wl.noLongerListed')}</span>
        ) : card.status === 'overpriced' ? (
          <span className="text-[11px] text-ink-faint">{t('up.noLongerUnderpriced')}</span>
        ) : card.status === 'verified' ? (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 border-line px-2.5 text-[11px] font-semibold"
            onClick={() => void handleCopyAgain()}
          >
            <i className="ti ti-copy" aria-hidden="true" />
            {t('up.copyMessage')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 border-line px-2.5 text-[11px] font-semibold"
            disabled={card.status === 'verifying' || !card.userSlug}
            onClick={() => void handleVerify()}
          >
            {card.status === 'verifying' ? t('up.verifying') : t('up.verify')}
          </Button>
        )}

        <span className="min-w-0 flex-1" />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('a11y.dismissListing')}
                onClick={() => removeListing(card.orderId)}
                className="-my-1 size-10 shrink-0 text-ink-faint hover:text-ink"
              />
            }
          >
            <i className="ti ti-x text-sm" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{t('a11y.dismissListing')}</TooltipContent>
        </Tooltip>
      </div>
    </article>
  );
}

export function UnderpricedListingsPanel() {
  const { t } = useTranslation();
  const listings = useAppStore((state) => state.underpricedListings);
  const [now, setNow] = useState(() => Date.now());
  const [stats, setStats] = useState<RadarStats>({ scannedCount: 0, trackedItems: 0 });

  // Tick once a second so the countdowns stay live and expired cards drop out immediately.
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Poll the radar throughput so you can confirm the live subscription is flowing.
  useEffect(() => {
    let active = true;
    const tick = () => {
      void getRadarStats()
        .then((next) => {
          if (active) {
            setStats(next);
          }
        })
        .catch(() => undefined);
    };
    tick();
    const interval = window.setInterval(tick, 2000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  // Most underpriced first (largest discount vs recommended), ties broken by most recent.
  const visible = listings
    .filter((card) => now - card.receivedAt < UNDERPRICED_LISTING_TTL_MS)
    .sort((a, b) => b.pctBelow - a.pctBelow || b.receivedAt - a.receivedAt);

  return (
    <Panel className="gap-0" aria-label={t('a11y.underpricedListings')}>
      <PanelHeader>
        <PanelTitle variant="heading">{t('up.title')}</PanelTitle>
        {/* Throughput, not decoration: it is how you tell a quiet market from a dead
            subscription. */}
        <span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
          {t('up.radarStats', {
            scanned: stats.scannedCount.toLocaleString(),
            tracked: stats.trackedItems.toLocaleString(),
          })}
        </span>
      </PanelHeader>

      {visible.length === 0 ? (
        <EmptyState icon="ti-radar" title={t('up.watching')} />
      ) : (
        <div className="flex max-h-[calc(100vh-12rem)] flex-col gap-2 overflow-y-auto overscroll-contain p-3">
          {visible.map((card) => (
            <UnderpricedCard key={card.orderId} card={card} now={now} />
          ))}
        </div>
      )}
    </Panel>
  );
}
