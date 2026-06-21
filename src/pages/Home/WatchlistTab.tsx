import { WatchlistAddControls } from '../../components/WatchlistAddControls';
import { WatchlistTable } from '../../components/WatchlistTable';
import { useAppStore } from '../../stores/useAppStore';

export function WatchlistTab() {
  const watchlistCount = useAppStore((state) => state.watchlist.length);

  return (
    <div className="wl-fullscreen">
      <div className="panel-title-row">
        <span className="panel-title-eyebrow">Watchlist</span>
        <span className="badge badge-blue">{watchlistCount} items</span>
      </div>

      <div className="watchlist-controls-card">
        <WatchlistAddControls />
      </div>

      <div className="card">
        <WatchlistTable variant="full" />
      </div>
    </div>
  );
}
