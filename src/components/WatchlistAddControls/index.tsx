import { useAppStore } from '../../stores/useAppStore';

interface WatchlistAddControlsProps {
  compact?: boolean;
}

export function WatchlistAddControls({ compact = false }: WatchlistAddControlsProps) {
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const targetInput = useAppStore((state) => state.watchlistTargetInput);
  const formError = useAppStore((state) => state.watchlistFormError);
  const setTargetInput = useAppStore((state) => state.setWatchlistTargetInput);
  const addSelectedQuickViewToWatchlist = useAppStore(
    (state) => state.addSelectedQuickViewToWatchlist,
  );

  return (
    <div className={`watchlist-add${compact ? ' compact' : ''}`}>
      <div className="watchlist-add-copy">
        <span className="watchlist-add-label">Watch Target</span>
        <span className="watchlist-add-selected">
          {selectedItem ? selectedItem.name : 'Search an item first'}
        </span>
      </div>

      <div className="watchlist-add-actions">
        <span className="input-label">pt</span>
        <input
          className="price-input"
          type="number"
          min="0"
          step="0.1"
          placeholder="0"
          title="Desired price"
          value={targetInput}
          onChange={(event) => setTargetInput(event.target.value)}
        />
        <button
          className="btn-sm"
          type="button"
          onClick={addSelectedQuickViewToWatchlist}
          disabled={!selectedItem}
        >
          Add to Watchlist
        </button>
      </div>

      {formError ? <div className="watchlist-form-error">{formError}</div> : null}
    </div>
  );
}
