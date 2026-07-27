import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import { createPortal } from 'react-dom';
import { useModalA11y } from '../../hooks/useModalA11y';

interface WatchlistPurchaseModalProps {
  itemName: string;
  defaultPrice: number;
  /** Units still outstanding on the linked buy order — caps how many can be marked bought. */
  maxQuantity: number;
  loading: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSubmit: (price: number, quantity: number) => void;
}

export function WatchlistPurchaseModal({
  itemName,
  defaultPrice,
  maxQuantity,
  loading,
  errorMessage,
  onClose,
  onSubmit,
}: WatchlistPurchaseModalProps) {
  const { t } = useTranslation();
  const [priceInput, setPriceInput] = useState(String(Math.max(1, Math.round(defaultPrice))));
  // Defaults to 1: buying one unit of a multi-unit order is the common case, and the old
  // behaviour of always closing the whole order is exactly the bug this fixes.
  const [quantityInput, setQuantityInput] = useState('1');

  useEffect(() => {
    setPriceInput(String(Math.max(1, Math.round(defaultPrice))));
  }, [defaultPrice]);

  const modalRef = useModalA11y<HTMLDivElement>({ onClose });

  if (typeof document === 'undefined') {
    return null;
  }

  const cap = Math.max(1, Math.round(maxQuantity));
  const parsedPrice = Number.parseInt(priceInput, 10);
  const parsedQuantity = Number.parseInt(quantityInput, 10);
  const validPrice = Number.isInteger(parsedPrice) && parsedPrice > 0;
  const validQuantity = Number.isInteger(parsedQuantity) && parsedQuantity > 0 && parsedQuantity <= cap;
  const canSubmit = validPrice && validQuantity && !loading;

  const submit = () => {
    if (canSubmit) {
      onSubmit(parsedPrice, parsedQuantity);
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        ref={modalRef}
        className="settings-modal watchlist-purchase-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="watchlist-purchase-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('wl.watchlist')}</span>
            <h3 id="watchlist-purchase-modal-title">{t('wl.markAsBought')}</h3>
          </div>
        </div>

        <div className="settings-modal-body">
          <p className="watchlist-purchase-copy">
            {t('wl.purchaseCopy', { item: itemName })}
          </p>

          <div className="watchlist-purchase-fields">
            <label className="watchlist-purchase-field" htmlFor="watchlist-purchase-price">
              <span>{t('wl.boughtPrice')}</span>
              <input
                id="watchlist-purchase-price"
                type="number"
                min={1}
                step={1}
                value={priceInput}
                onChange={(event) => setPriceInput(event.target.value)}
                disabled={loading}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit();
                }}
              />
            </label>
            <label className="watchlist-purchase-field" htmlFor="watchlist-purchase-quantity">
              <span>{t('wl.boughtQuantity')}</span>
              <input
                id="watchlist-purchase-quantity"
                type="number"
                min={1}
                max={cap}
                step={1}
                value={quantityInput}
                onChange={(event) => setQuantityInput(event.target.value)}
                disabled={loading || cap === 1}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit();
                }}
              />
            </label>
          </div>

          {cap > 1 ? (
            <p className="watchlist-purchase-hint">{t('wl.ofOutstanding', { n: cap })}</p>
          ) : null}
          {errorMessage ? <div className="settings-inline-error">{errorMessage}</div> : null}
        </div>

        <div className="settings-modal-actions">
          <button className="btn-secondary" type="button" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" type="button" onClick={submit} disabled={!canSubmit}>
            {loading ? t('common.saving') : t('wl.confirmBought')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
