import { useAppStore } from '../../stores/useAppStore';

interface WatchlistAddControlsProps {
  compact?: boolean;
}

export function WatchlistAddControls({ compact = false }: WatchlistAddControlsProps) {
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const marketVariants = useAppStore((state) => state.marketVariants);
  const selectedVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const marketVariantsLoading = useAppStore((state) => state.marketVariantsLoading);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const targetInput = useAppStore((state) => state.watchlistTargetInput);
  const formError = useAppStore((state) => state.watchlistFormError);
  const setTargetInput = useAppStore((state) => state.setWatchlistTargetInput);
  const setSelectedMarketVariantKey = useAppStore((state) => state.setSelectedMarketVariantKey);
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
        {selectedItem && marketVariants.length > 1 ? (
          <select
            className="watchlist-variant-select"
            value={selectedVariantKey ?? ''}
            onChange={(event) => {
              void setSelectedMarketVariantKey(event.target.value || null);
            }}
            aria-label="Select rank variant"
          >
            <option value="">Select Variant</option>
            {marketVariants.map((variant) => (
              <option key={variant.key} value={variant.key}>
                {variant.label}
              </option>
            ))}
          </select>
        ) : null}
        <span className="input-label">pt</span>
        <input
          className="price-input"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          pattern="[0-9]*"
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

      {selectedItem && marketVariantsLoading ? (
        <div className="watchlist-form-note">Loading market variants…</div>
      ) : null}
      {selectedItem && marketVariantsError ? (
        <div className="watchlist-form-error">{marketVariantsError}</div>
      ) : null}
      {formError ? <div className="watchlist-form-error">{formError}</div> : null}
    </div>
  );
}
