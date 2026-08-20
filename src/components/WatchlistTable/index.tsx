import { useEffect, useState } from 'react';
import { ItemName } from '../ItemName';
import { ModalPortal } from '../ModalPortal';
import { useTranslation } from '../../i18n';
import { WatchlistPurchaseModal } from '../WatchlistPurchaseModal';
import { QuantityStepper } from '../QuantityStepper';
import { useModalA11y } from '../../hooks/useModalA11y';
import { formatElapsedTime } from '../../lib/dateTime';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { getWatchlistVisualState } from '../../lib/watchlist';
import type { WatchlistTone } from '../../lib/watchlist';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { EmptyState } from '@/components/ui/empty-state';
import { useAppStore } from '../../stores/useAppStore';
import type { WatchlistItem } from '../../types';

const COPY_RESET_DELAY_MS = 1800;
const SUCCESS_DISMISS_DELAY_MS = 4000;

type WatchlistTableVariant = 'compact' | 'full';

/** Urgency order for the compact card: target hit first, then closest to target. */
const TONE_RANK: Record<WatchlistTone, number> = { green: 0, amber: 1, neutral: 2 };

/** The three row actions, always rendered as one adjacent group so the column never changes
 *  width and the buttons never move. An action that doesn't apply is disabled, not removed. */
function RowActions({
  canCopy,
  copied,
  onCopy,
  onMarkBought,
  onRemove,
  copyLabel,
  boughtLabel,
  removeLabel,
}: {
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
  onMarkBought: () => void;
  onRemove: () => void;
  copyLabel: string;
  boughtLabel: string;
  removeLabel: string;
}) {
  return (
    <div className="wl-actions" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`wl-action${copied ? ' copied' : ''}`}
        title={copyLabel}
        aria-label={copyLabel}
        disabled={!canCopy}
        onClick={onCopy}
      >
        <i className="ti ti-copy" aria-hidden="true" />
      </button>
      <button type="button" className="wl-action" title={boughtLabel} aria-label={boughtLabel} onClick={onMarkBought}>
        <i className="ti ti-shopping-cart" aria-hidden="true" />
      </button>
      <button type="button" className="wl-action danger" title={removeLabel} aria-label={removeLabel} onClick={onRemove}>
        <i className="ti ti-trash" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Shared watchlist table used by both the dashboard Overview card and the full-screen
 * Watchlist tab. Centralises row actions (copy whisper, mark bought, remove) plus their
 * error/success handling so fixes only have to happen in one place.
 */
export function WatchlistTable({
  variant,
  toneFilter = null,
}: {
  variant: WatchlistTableVariant;
  /** Full tab only — restricts rows to one status. `null` shows everything. */
  /** One tone, or several. Home passes `['green','amber']` to show only rows worth acting on. */
  toneFilter?: WatchlistTone | WatchlistTone[] | null;
}) {
  const { t } = useTranslation();
  const watchlist = useAppStore((state) => state.watchlist);
  const selectedId = useAppStore((state) => state.selectedWatchlistId);
  const setSelected = useAppStore((state) => state.setSelectedWatchlist);
  const removeItem = useAppStore((state) => state.removeWatchlistItem);
  const markWatchlistItemBought = useAppStore((state) => state.markWatchlistItemBought);
  const setWatchlistItemQuantity = useAppStore((state) => state.setWatchlistItemQuantity);
  const watchlistActionError = useAppStore((state) => state.watchlistActionError);
  const setWatchlistActionError = useAppStore((state) => state.setWatchlistActionError);

  const [purchaseItemId, setPurchaseItemId] = useState<string | null>(null);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);
  const [copiedWatchlistId, setCopiedWatchlistId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [removeItemId, setRemoveItemId] = useState<string | null>(null);

  const purchaseItem = watchlist.find((item) => item.id === purchaseItemId) ?? null;
  const removeTarget = watchlist.find((item) => item.id === removeItemId) ?? null;
  const removeModalRef = useModalA11y<HTMLDivElement>({
    onClose: () => setRemoveItemId(null),
    active: removeTarget !== null,
  });

  // Auto-dismiss the success banner so it doesn't linger forever (#5).
  useEffect(() => {
    if (!purchaseSuccess) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => setPurchaseSuccess(null), SUCCESS_DISMISS_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [purchaseSuccess]);

  const handleCopy = (item: WatchlistItem) => {
    if (!item.currentSeller || item.currentPrice === null) {
      return;
    }
    setCopyError(null);
    void copyWhisperMessage(
      {
        username: item.currentSeller,
        platinum: item.currentPrice,
        rank: item.currentRank,
        maxRank: item.maxRank,
      },
      item.displayName,
    )
      .then(() => {
        setCopiedWatchlistId(item.id);
        window.setTimeout(() => {
          setCopiedWatchlistId((current) => (current === item.id ? null : current));
        }, COPY_RESET_DELAY_MS);
      })
      .catch(() => {
        // Surface the failure on its own banner — previously it was written to the
        // purchase-modal error slot and never shown (#1, #8).
        setCopyError(formatHomeErrorMessage('watchlist-copy', new Error('copy failed')));
      });
  };

  return (
    <>
      {purchaseSuccess ? <div className="settings-inline-success">{purchaseSuccess}</div> : null}
      {copyError ? (
        <div className="settings-inline-error watchlist-copy-error">
          {copyError}
          <button type="button" className="text-btn" onClick={() => setCopyError(null)}>
            {t('wl.dismiss')}
          </button>
        </div>
      ) : null}
      {watchlistActionError ? (
        <div className="settings-inline-error watchlist-copy-error">
          {watchlistActionError}
          <button type="button" className="text-btn" onClick={() => setWatchlistActionError(null)}>
            {t('wl.dismiss')}
          </button>
        </div>
      ) : null}

      {(() => {
        const ordered = [...watchlist].sort((left, right) => {
          const leftState = getWatchlistVisualState(left);
          const rightState = getWatchlistVisualState(right);
          const byTone = TONE_RANK[leftState.tone] - TONE_RANK[rightState.tone];
          if (byTone !== 0) {
            return byTone;
          }
          // Within a tone, closest to its own target first — "how near am I?" is the question
          // this card exists to answer, and it's comparable across items of different prices.
          const distance = (item: WatchlistItem) =>
            item.currentPrice === null || item.targetPrice <= 0
              ? Number.POSITIVE_INFINITY
              : (item.currentPrice - item.targetPrice) / item.targetPrice;
          return distance(left) - distance(right);
        });
        const wantedTones = toneFilter
          ? new Set(Array.isArray(toneFilter) ? toneFilter : [toneFilter])
          : null;
        const rows = wantedTones
          ? ordered.filter((item) => wantedTones.has(getWatchlistVisualState(item).tone))
          : ordered;

        if (watchlist.length === 0) {
          return (
            <EmptyState icon="ti-target" title={t('wl.noItems')} detail={t('wl.searchToAddHint')} />
          );
        }
        if (rows.length === 0) {
          return (
            <EmptyState icon="ti-filter" title={t('wl.noneMatchFilter')} />
          );
        }

        const renderActions = (item: WatchlistItem, canCopy: boolean) => (
          <RowActions
            canCopy={canCopy}
            copied={copiedWatchlistId === item.id}
            copyLabel={t('hm.copyMessage')}
            boughtLabel={t('wl.markBought')}
            removeLabel={t('wl.remove')}
            onCopy={() => handleCopy(item)}
            onMarkBought={() => {
              setPurchaseError(null);
              setPurchaseSuccess(null);
              setPurchaseItemId(item.id);
            }}
            onRemove={() => setRemoveItemId(item.id)}
          />
        );

        if (variant === 'compact') {
          return (
            <div className="wl-compact-list">
              {rows.map((item) => {
                const visualState = getWatchlistVisualState(item);
                const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
                const canCopy =
                  visualState.tone === 'green' && Boolean(item.currentSeller) && item.currentPrice !== null;
                return (
                  <div
                    key={item.id}
                    className={`wl-row tone-${visualState.tone}${selectedId === item.id ? ' selected' : ''}`}
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="wl-row-thumb">
                      {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{item.displayName.slice(0, 1)}</span>}
                    </span>
                    <span className="wl-row-identity">
                      <ItemName
                        name={item.displayName}
                        slug={item.slug}
                        itemId={item.itemId}
                        imagePath={item.imagePath}
                      />
                      <span className="wl-row-meta">
                        {visualState.label}
                        {item.currentSeller ? ` · ${item.currentSeller}` : ''}
                      </span>
                    </span>
                    <span className="wl-row-prices">
                      <span className={`wl-row-price tone-${visualState.tone}`}>
                        {item.currentPrice !== null ? `${item.currentPrice} pt` : '—'}
                      </span>
                      <span className="wl-row-target">{t('wl.targetShort', { n: item.targetPrice })}</span>
                    </span>
                    {renderActions(item, canCopy)}
                  </div>
                );
              })}
            </div>
          );
        }

        return (
          <table className="wl-fs-table">
            <thead>
              <tr>
                <th>{t('wl.item')}</th>
                <th className="wl-col-num">{t('wl.target')}</th>
                <th className="wl-col-num">{t('wl.lowest')}</th>
                <th className="wl-col-qty">{t('wl.want')}</th>
                <th className="wl-col-seller">{t('wl.seller')}</th>
                <th className="wl-col-actions">{t('wl.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const visualState = getWatchlistVisualState(item);
                const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
                const canCopy =
                  visualState.tone === 'green' && Boolean(item.currentSeller) && item.currentPrice !== null;
                return (
                  <tr
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                    className={`wl-row tone-${visualState.tone}${selectedId === item.id ? ' selected' : ''}`}
                    title={t('wl.refreshedAt', { time: formatElapsedTime(item.lastUpdatedAt) })}
                  >
                    <td>
                      <div className="wl-item-cell">
                        <span className="wl-row-thumb">
                          {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{item.displayName.slice(0, 1)}</span>}
                        </span>
                        <ItemName
                          name={item.displayName}
                          slug={item.slug}
                          itemId={item.itemId}
                          imagePath={item.imagePath}
                        />
                      </div>
                    </td>
                    <td className="wl-col-num td-muted">{item.targetPrice}</td>
                    <td className={`wl-col-num wl-row-price tone-${visualState.tone}`}>
                      {item.currentPrice !== null ? item.currentPrice : '—'}
                    </td>
                    <td className="wl-col-qty">
                      <QuantityStepper
                        value={item.quantity}
                        onChange={(next) => setWatchlistItemQuantity(item.id, next)}
                      />
                    </td>
                    <td className="wl-col-seller">{item.currentSeller ?? '—'}</td>
                    <td className="wl-col-actions">{renderActions(item, canCopy)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        );
      })()}

      {purchaseItem ? (
        <WatchlistPurchaseModal
          itemName={purchaseItem.displayName}
          defaultPrice={purchaseItem.targetPrice}
          maxQuantity={purchaseItem.quantity}
          loading={purchaseLoading}
          errorMessage={purchaseError}
          onClose={() => {
            if (purchaseLoading) {
              return;
            }
            setPurchaseItemId(null);
            setPurchaseError(null);
          }}
          onSubmit={(price, quantity) => {
            setPurchaseLoading(true);
            setPurchaseError(null);
            void markWatchlistItemBought(purchaseItem.id, price, quantity)
              .then((result) => {
                setPurchaseSuccess(result.confirmationMessage);
                setPurchaseItemId(null);
              })
              .catch((error) => {
                setPurchaseError(formatHomeErrorMessage('watchlist-mark-bought', error));
              })
              .finally(() => {
                setPurchaseLoading(false);
              });
          }}
        />
      ) : null}

      {removeTarget ? (
        <ModalPortal>
        <div className="modal-backdrop" role="presentation" onClick={() => setRemoveItemId(null)}>
          <div
            ref={removeModalRef}
            className="settings-modal watchlist-remove-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="watchlist-remove-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <span className="card-label">{t('wl.watchlist')}</span>
                <h3 id="watchlist-remove-title">{t('wl.removeTitle')}</h3>
              </div>
              <button
                className="settings-close-btn"
                type="button"
                onClick={() => setRemoveItemId(null)}
                aria-label={t('a11y.cancelRemove')}
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <p>
                {(() => {
                  const [before, after] = t('wl.removeBody', { name: '\u0000' }).split('\u0000');
                  return (
                    <>
                      {before}
                      <strong>{removeTarget.displayName}</strong>
                      {after}
                    </>
                  );
                })()}
                {removeTarget.linkedBuyOrderId ? ` ${t('wl.removeLinked')}` : ''}
              </p>
            </div>
            <div className="settings-modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setRemoveItemId(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn-primary danger"
                onClick={() => {
                  removeItem(removeTarget.id);
                  setRemoveItemId(null);
                }}
              >
                {t('trades.row.remove')}
              </button>
            </div>
          </div>
        </div>
        </ModalPortal>
      ) : null}
    </>
  );
}
