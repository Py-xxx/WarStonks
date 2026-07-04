import { useEffect, useState } from 'react';
import {
  useAppStore,
  UNDERPRICED_LISTING_TTL_MS,
  type UnderpricedListingCard,
} from '../../stores/useAppStore';
import { getRadarStats, verifyMarketListing, type RadarStats } from '../../lib/tauriClient';
import { useTranslation } from '../../i18n';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { OpportunityBoard } from '../OpportunityBoard';

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
      });
      if (result.stillListed) {
        updateListing(card.orderId, { status: 'verified', verifiedPrice: result.currentPrice });
        // Auto-copy the whisper at the confirmed current price.
        await copyWhisperMessage(
          {
            username: card.username,
            platinum: Math.round(result.currentPrice ?? card.listedPrice),
            rank: card.rank,
          },
          card.itemName,
        );
        pushToast(t('up.stillActive'), 'success');
      } else {
        updateListing(card.orderId, { status: 'gone' });
        pushToast(t('up.unavailable'), 'info');
      }
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
    <div
      className={`radar-card radar-card-${card.tier}${card.status === 'gone' ? ' is-gone' : ''}${
        card.completesSet ? ' radar-card-completes' : ''
      }`}
    >
      <div className="radar-card-top">
        <span className="radar-card-name" title={card.itemName}>
          {card.itemName}
          {card.rank !== null ? <span className="radar-card-rank"> · R{card.rank}</span> : null}
        </span>
        <span className="radar-card-timer" aria-label={t('a11y.timeRemaining')}>
          {formatCountdown(remainingMs)}
        </span>
      </div>

      {card.completesSet ? (
        <div className="radar-card-completes-badge" title={t('up.ownParts', { owned: card.completesSet.ownedDistinct, needed: card.completesSet.neededDistinct })}>
          ⭐ Completes your {card.completesSet.setName} ({card.completesSet.ownedDistinct}/
          {card.completesSet.neededDistinct})
        </div>
      ) : null}

      <div className="radar-card-seller">{card.username}</div>

      <div className="radar-card-prices">
        <span className="radar-card-listed">{buyPrice}p</span>
        <span className="radar-card-pct">−{Math.round(card.pctBelow)}%</span>
        <span className="radar-card-rec">
          <span className="radar-card-rec-label">{t('wl.usualEntry')}</span>
          <span className="radar-card-rec-value">{Math.round(card.recommendedPrice)}p</span>
        </span>
      </div>

      <div className="radar-card-actions">
        {card.status === 'gone' ? (
          <span className="radar-card-gone">{t('wl.noLongerListed')}</span>
        ) : card.status === 'verified' ? (
          <button className="act-btn" type="button" onClick={() => void handleCopyAgain()}>
            Copy Message
          </button>
        ) : (
          <button
            className="act-btn"
            type="button"
            disabled={card.status === 'verifying' || !card.userSlug}
            onClick={() => void handleVerify()}
          >
            {card.status === 'verifying' ? t('up.verifying') : t('up.verify')}
          </button>
        )}
        <button
          className="act-btn radar-card-dismiss"
          type="button"
          aria-label={t('a11y.dismissListing')}
          onClick={() => removeListing(card.orderId)}
        >
          ×
        </button>
      </div>
    </div>
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
    <div className="radar-layout">
      <div className="radar-main">
        <OpportunityBoard />
      </div>
      <aside className="radar-side" aria-label={t('a11y.underpricedListings')}>
        <div className="radar-side-header">
          <span className="panel-title-eyebrow">
            <span className="panel-dot panel-dot-green" aria-hidden="true" />
            {t('up.title')}
          </span>
          <p>
            Live sell listings priced well below their recommended entry. Verify before whispering
            — listings clear after 5 minutes.
          </p>
          <div className="radar-stats">
            Scanned {stats.scannedCount.toLocaleString()} listings · watching{' '}
            {stats.trackedItems.toLocaleString()} priced items
          </div>
        </div>
        {visible.length === 0 ? (
          <div className="radar-empty">
            Watching the live market… underpriced listings will appear here as they’re posted.
          </div>
        ) : (
          <div className="radar-list">
            {visible.map((card) => (
              <UnderpricedCard key={card.orderId} card={card} now={now} />
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
