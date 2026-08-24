import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTranslation } from '../../i18n';

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

  return (
    // `Dialog`, not a `createPortal` + `modal-backdrop` + `useModalA11y` stack. Outside clicks are
    // allowed to close it — unlike the listing dialog, there is nothing here worth losing: two
    // pre-filled numbers you can retype in a second.
    <Dialog open onOpenChange={(open) => !open && !loading && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('wl.markAsBought')}</DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed text-ink-soft">
            {t('wl.purchaseCopy', { item: itemName })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              className="font-mono text-[10px] tracking-[0.08em] text-ink-dim uppercase"
              htmlFor="watchlist-purchase-price"
            >
              {t('wl.boughtPrice')}
            </label>
            <Input
              id="watchlist-purchase-price"
              className="tabular-nums"
              type="number"
              min={1}
              step={1}
              autoFocus
              value={priceInput}
              onChange={(event) => setPriceInput(event.target.value)}
              disabled={loading}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              className="font-mono text-[10px] tracking-[0.08em] text-ink-dim uppercase"
              htmlFor="watchlist-purchase-quantity"
            >
              {t('wl.boughtQuantity')}
            </label>
            <Input
              id="watchlist-purchase-quantity"
              className="tabular-nums"
              type="number"
              min={1}
              max={cap}
              step={1}
              value={quantityInput}
              onChange={(event) => setQuantityInput(event.target.value)}
              // Disabled at a cap of 1: there is only one valid value, and an editable field
              // that rejects everything you type is worse than one you cannot touch.
              disabled={loading || cap === 1}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
            {cap > 1 ? (
              <span className="text-[10px] text-ink-dim">{t('wl.ofOutstanding', { n: cap })}</span>
            ) : null}
          </div>
        </div>

        {errorMessage ? (
          <p role="alert" className="text-[11px] leading-relaxed text-accent-red">
            {errorMessage}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit}>
            {loading ? t('common.saving') : t('wl.confirmBought')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
