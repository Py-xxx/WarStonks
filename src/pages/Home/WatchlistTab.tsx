import { useState } from 'react';
import { WatchlistPurchaseModal } from '../../components/WatchlistPurchaseModal';
import { WatchlistAddControls } from '../../components/WatchlistAddControls';
import { formatElapsedTime } from '../../lib/dateTime';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { getWatchlistVisualState } from '../../lib/watchlist';
import { useAppStore } from '../../stores/useAppStore';

const COPY_RESET_DELAY_MS = 1800;
export function WatchlistTab() {
  const watchlist = useAppStore((state) => state.watchlist);
  const selectedId = useAppStore((state) => state.selectedWatchlistId);
  const setSelected = useAppStore((state) => state.setSelectedWatchlist);
  const removeItem = useAppStore((state) => state.removeWatchlistItem);
  const markWatchlistItemBought = useAppStore((state) => state.markWatchlistItemBought);
  const [purchaseItemId, setPurchaseItemId] = useState<string | null>(null);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);
  const [copiedWatchlistId, setCopiedWatchlistId] = useState<string | null>(null);
  const purchaseItem = watchlist.find((item) => item.id === purchaseItemId) ?? null;

  return (
    <div className="wl-fullscreen">
      <div className="panel-title-row">
        <span className="panel-title-eyebrow">Watchlist</span>
        <span className="badge badge-blue">{watchlist.length} items</span>
      </div>

      <div className="watchlist-controls-card">
        <WatchlistAddControls />
      </div>

      {purchaseSuccess ? <div className="settings-inline-success">{purchaseSuccess}</div> : null}

      <div className="card">
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
            <table className="wl-fs-table">
              <thead>
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
              </thead>
              <tbody>
                {watchlist.map((item) => {
                  const imageUrl = resolveWfmAssetUrl(item.imagePath);
                  const hasRank = item.currentRank !== null && item.currentRank !== undefined;
                  const visualState = getWatchlistVisualState(item);

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
                          <span className="wl-item-thumb">
                            {imageUrl ? (
                              <img src={imageUrl} alt="" loading="lazy" />
                            ) : (
                              <span>{item.displayName.slice(0, 1)}</span>
                            )}
                          </span>
                          <span>{item.displayName}</span>
                        </div>
                      </td>
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
                          {visualState.tone === 'red' && item.currentSeller && item.currentPrice !== null ? (
                            <button
                              className="act-btn"
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void copyWhisperMessage(
                                  { username: item.currentSeller!, platinum: item.currentPrice! },
                                  item.displayName,
                                )
                                  .then(() => {
                                    setCopiedWatchlistId(item.id);
                                    window.setTimeout(() => {
                                      setCopiedWatchlistId((current) =>
                                        current === item.id ? null : current,
                                      );
                                    }, COPY_RESET_DELAY_MS);
                                  })
                                  .catch(() => {
                                    setPurchaseError(
                                      formatHomeErrorMessage(
                                        'watchlist-copy',
                                        new Error('copy failed'),
                                      ),
                                    );
                                  });
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
                              removeItem(item.id);
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
              <span>Adaptive scans · min 10s per item · retry on rate limits</span>
            </div>
          </>
        )}
      </div>

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
    </div>
  );
}
