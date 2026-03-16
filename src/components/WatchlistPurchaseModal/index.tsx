import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface WatchlistPurchaseModalProps {
  itemName: string;
  defaultPrice: number;
  loading: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSubmit: (price: number) => void;
}

export function WatchlistPurchaseModal({
  itemName,
  defaultPrice,
  loading,
  errorMessage,
  onClose,
  onSubmit,
}: WatchlistPurchaseModalProps) {
  const [priceInput, setPriceInput] = useState(String(Math.max(1, Math.round(defaultPrice))));

  useEffect(() => {
    setPriceInput(String(Math.max(1, Math.round(defaultPrice))));
  }, [defaultPrice]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="settings-modal watchlist-purchase-modal watchlist-purchase-modal-fullscreen"
        role="dialog"
        aria-modal="true"
        aria-labelledby="watchlist-purchase-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Watchlist</span>
            <h3 id="watchlist-purchase-modal-title">Mark as bought</h3>
          </div>
        </div>

        <div className="settings-modal-body">
          <p className="watchlist-purchase-copy">
            Confirm how much <strong>{itemName}</strong> was bought for. The default value uses
            your desired watch price.
          </p>
          <label className="trade-listing-label" htmlFor="watchlist-purchase-price">
            Bought price
          </label>
          <input
            id="watchlist-purchase-price"
            className="field-input"
            type="number"
            min={1}
            step={1}
            value={priceInput}
            onChange={(event) => setPriceInput(event.target.value)}
            disabled={loading}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const parsed = Number.parseInt(priceInput, 10);
                if (Number.isInteger(parsed) && parsed > 0) {
                  onSubmit(parsed);
                }
              }
            }}
          />

          {errorMessage ? <div className="trade-inline-error">{errorMessage}</div> : null}
        </div>

        <div className="settings-modal-actions">
          <button className="act-btn" type="button" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={() => {
              const parsed = Number.parseInt(priceInput, 10);
              if (Number.isInteger(parsed) && parsed > 0) {
                onSubmit(parsed);
              }
            }}
            disabled={loading}
          >
            {loading ? 'Updating…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
