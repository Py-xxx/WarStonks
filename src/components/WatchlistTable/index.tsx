import { useEffect, useState } from 'react';
import { ItemName } from '../ItemName';
import { WatchlistPurchaseModal } from '../WatchlistPurchaseModal';
import { formatElapsedTime } from '../../lib/dateTime';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { getWatchlistVisualState } from '../../lib/watchlist';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { WatchlistItem } from '../../types';

const COPY_RESET_DELAY_MS = 1800;
const SUCCESS_DISMISS_DELAY_MS = 4000;

type WatchlistTableVariant = 'compact' | 'full';

/**
 * Shared watchlist table used by both the dashboard Overview card and the full-screen
 * Watchlist tab. Centralises row actions (copy whisper, mark bought, remove) plus their
 * error/success handling so fixes only have to happen in one place.
 */
export function WatchlistTable({ variant }: { variant: WatchlistTableVariant }) {
  const watchlist = useAppStore((state) => state.watchlist);
  const selectedId = useAppStore((state) => state.selectedWatchlistId);
  const setSelected = useAppStore((state) => state.setSelectedWatchlist);
  const removeItem = useAppStore((state) => state.removeWatchlistItem);
  const markWatchlistItemBought = useAppStore((state) => state.markWatchlistItemBought);
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
            Dismiss
          </button>
        </div>
      ) : null}
      {watchlistActionError ? (
        <div className="settings-inline-error watchlist-copy-error">
          {watchlistActionError}
          <button type="button" className="text-btn" onClick={() => setWatchlistActionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {watchlist.length === 0 ? (
        <div className="empty-state">
          <span className="empty-primary">No watchlist items yet</span>
          <span className="empty-sub">
            Search for an item, set your desired price, and add it to start monitoring live
            sell orders.
          </span>
        </div>
      ) : (
        <>
          <table className={variant === 'full' ? 'wl-fs-table' : 'wl-table'}>
            <thead>
              {variant === 'full' ? (
                <tr>
                  <th>Item</th>
                  <th>Desired</th>
                  <th>Lowest</th>
                  <th>Seller</th>
                  <th>Qty</th>
                  <th>Rank</th>
                  <th>Last Scan</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              ) : (
                <tr>
                  <th>Item</th>
                  <th>Target</th>
                  <th>Current</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              )}
            </thead>
            <tbody>
              {watchlist.map((item) => {
                const visualState = getWatchlistVisualState(item);
                const imageUrl = resolveWfmAssetUrl(item.imagePath);
                const hasRank = item.currentRank !== null && item.currentRank !== undefined;
                const canCopy =
                  visualState.tone === 'red' && Boolean(item.currentSeller) && item.currentPrice !== null;

                return (
                  <tr
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                    className={`watchlist-row watchlist-row-${visualState.tone}${
                      selectedId === item.id ? ' selected' : ''
                    }`}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div className="wl-item-cell">
                        {variant === 'full' ? (
                          <span className="wl-item-thumb">
                            {imageUrl ? (
                              <img src={imageUrl} alt="" loading="lazy" />
                            ) : (
                              <span>{item.displayName.slice(0, 1)}</span>
                            )}
                          </span>
                        ) : null}
                        <ItemName
                          name={item.displayName}
                          slug={item.slug}
                          itemId={item.itemId}
                          imagePath={item.imagePath}
                        />
                        {variant === 'compact' ? (
                          <span className="td-muted">Refreshed {formatElapsedTime(item.lastUpdatedAt)}</span>
                        ) : null}
                      </div>
                    </td>

                    {variant === 'full' ? (
                      <>
                        <td>{item.targetPrice} pt</td>
                        <td
                          style={{
                            color:
                              item.currentPrice !== null && item.currentPrice <= item.targetPrice
                                ? 'var(--accent-green)'
                                : 'var(--text-primary)',
                          }}
                        >
                          {item.currentPrice !== null ? `${item.currentPrice} pt` : '—'}
                        </td>
                        <td>{item.currentSeller ?? '—'}</td>
                        <td>{item.currentQuantity ?? '—'}</td>
                        <td>{hasRank ? item.currentRank : '—'}</td>
                        <td className="td-muted">Refreshed {formatElapsedTime(item.lastUpdatedAt)}</td>
                      </>
                    ) : (
                      <>
                        <td className="td-muted">{item.targetPrice} pt</td>
                        <td>{item.currentPrice !== null ? `${item.currentPrice} pt` : '—'}</td>
                      </>
                    )}

                    <td className={`watchlist-status watchlist-status-${visualState.tone}`}>
                      {visualState.label}
                    </td>
                    <td>
                      <div className="watchlist-actions">
                        <button
                          className="act-btn"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPurchaseError(null);
                            setPurchaseSuccess(null);
                            setPurchaseItemId(item.id);
                          }}
                        >
                          Mark as bought
                        </button>
                        {canCopy ? (
                          <button
                            className="act-btn"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleCopy(item);
                            }}
                          >
                            {copiedWatchlistId === item.id ? 'Copied' : 'Copy Message'}
                          </button>
                        ) : null}
                        <button
                          className="act-btn danger"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setRemoveItemId(item.id);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="wl-footer">
            <span>Adaptive scans · min 10s per item</span>
            {variant === 'compact' && selectedId ? (
              <span className="selected">
                Selected:{' '}
                <span style={{ color: 'var(--text-primary)' }}>
                  {watchlist.find((entry) => entry.id === selectedId)?.displayName}
                </span>
              </span>
            ) : null}
          </div>
        </>
      )}

      {purchaseItem ? (
        <WatchlistPurchaseModal
          itemName={purchaseItem.displayName}
          defaultPrice={purchaseItem.targetPrice}
          loading={purchaseLoading}
          errorMessage={purchaseError}
          onClose={() => {
            if (purchaseLoading) {
              return;
            }
            setPurchaseItemId(null);
            setPurchaseError(null);
          }}
          onSubmit={(price) => {
            setPurchaseLoading(true);
            setPurchaseError(null);
            void markWatchlistItemBought(purchaseItem.id, price)
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
        <div className="modal-backdrop" role="presentation" onClick={() => setRemoveItemId(null)}>
          <div
            className="settings-modal watchlist-remove-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="watchlist-remove-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <span className="card-label">Watchlist</span>
                <h3 id="watchlist-remove-title">Remove item?</h3>
              </div>
              <button
                className="settings-close-btn"
                type="button"
                onClick={() => setRemoveItemId(null)}
                aria-label="Cancel remove"
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <p>
                Remove <strong>{removeTarget.displayName}</strong> from your watchlist?
                {removeTarget.linkedBuyOrderId
                  ? ' This will also cancel its linked Warframe.Market buy order.'
                  : ''}
              </p>
            </div>
            <div className="settings-modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setRemoveItemId(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary danger"
                onClick={() => {
                  removeItem(removeTarget.id);
                  setRemoveItemId(null);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
