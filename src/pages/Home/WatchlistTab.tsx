import { WatchlistAddControls } from '../../components/WatchlistAddControls';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { getWatchlistVisualState } from '../../lib/watchlist';
import { useAppStore } from '../../stores/useAppStore';

function formatLastScan(lastUpdatedAt: string | null): string {
  if (!lastUpdatedAt) {
    return 'Pending';
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(lastUpdatedAt).getTime()) / 1000),
  );

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  return `${Math.floor(elapsedMinutes / 60)}h ago`;
}

export function WatchlistTab() {
  const watchlist = useAppStore((state) => state.watchlist);
  const selectedId = useAppStore((state) => state.selectedWatchlistId);
  const setSelected = useAppStore((state) => state.setSelectedWatchlist);
  const removeItem = useAppStore((state) => state.removeWatchlistItem);

  return (
    <div className="wl-fullscreen">
      <div className="panel-title-row">
        <span className="panel-title-eyebrow">Watchlist</span>
        <span className="badge badge-blue">{watchlist.length} items</span>
      </div>

      <div className="watchlist-controls-card">
        <WatchlistAddControls />
      </div>

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
                      <td className="td-muted">{formatLastScan(item.lastUpdatedAt)}</td>
                      <td className={`watchlist-status watchlist-status-${visualState.tone}`}>
                        {visualState.label}
                      </td>
                      <td>
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
    </div>
  );
}
