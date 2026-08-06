import { useEffect, useState } from 'react';
import { ItemSearchInput } from '../ItemSearchInput';
import { QuantityStepper } from '../QuantityStepper';
import { getItemVariantsForMarket } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import type { MarketVariant, WfmAutocompleteItem } from '../../types';

/**
 * `selected` follows whatever the top bar has loaded into Quick View (the dashboard card sits
 * right beside it). `search` owns its own item picker, so the watchlist tab can add an item
 * without first selecting it somewhere else.
 */
type WatchlistAddMode = 'selected' | 'search';

const BASE_VARIANT_KEY = 'base';

/**
 * The add form, as a fixed grid of labelled fields.
 *
 * Every control keeps its column whatever the state — the variant select always renders (showing
 * the base market when an item has only one), so the Add button can't move. The previous layout
 * was one flex row with `space-between`, which meant the button's position tracked the length of
 * the selected item's name and whether a variant dropdown happened to be showing.
 */
export function WatchlistAddControls({ mode = 'selected' }: { mode?: WatchlistAddMode }) {
  const { t } = useTranslation();
  const quickViewItem = useAppStore((state) => state.quickView.selectedItem);
  const storeVariants = useAppStore((state) => state.marketVariants);
  const storeVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const formError = useAppStore((state) => state.watchlistFormError);
  const targetInput = useAppStore((state) => state.watchlistTargetInput);
  const setTargetInput = useAppStore((state) => state.setWatchlistTargetInput);
  const quantityInput = useAppStore((state) => state.watchlistQuantityInput);
  const setQuantityInput = useAppStore((state) => state.setWatchlistQuantityInput);
  const setSelectedMarketVariantKey = useAppStore((state) => state.setSelectedMarketVariantKey);
  const addSelectedQuickViewToWatchlist = useAppStore((state) => state.addSelectedQuickViewToWatchlist);
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);

  // Search mode keeps its own item + variant state so it never disturbs the globally selected
  // Quick View item that the rest of the dashboard is showing.
  const [searchItem, setSearchItem] = useState<WfmAutocompleteItem | null>(null);
  const [searchVariants, setSearchVariants] = useState<MarketVariant[]>([]);
  const [searchVariantKey, setSearchVariantKey] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'search' || !searchItem) {
      setSearchVariants([]);
      setSearchVariantKey(null);
      return undefined;
    }
    let isMounted = true;
    void getItemVariantsForMarket(searchItem.wfmId ?? '', searchItem.slug)
      .then((variants) => {
        if (!isMounted) {
          return;
        }
        setSearchVariants(variants);
        setSearchVariantKey(variants.find((variant) => variant.isDefault)?.key ?? variants[0]?.key ?? null);
      })
      .catch(() => {
        if (isMounted) {
          setSearchVariants([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [mode, searchItem]);

  const isSearchMode = mode === 'search';
  const variants = isSearchMode ? searchVariants : storeVariants;
  const variantKey = isSearchMode ? searchVariantKey : storeVariantKey;
  const activeItemName = isSearchMode ? searchItem?.name ?? null : quickViewItem?.name ?? null;
  const canAdd = Boolean(isSearchMode ? searchItem : quickViewItem);

  const submit = () => {
    if (isSearchMode) {
      if (!searchItem) {
        return;
      }
      const variant = variants.find((entry) => entry.key === variantKey);
      addExplicitItemToWatchlist(
        searchItem,
        variant?.key ?? BASE_VARIANT_KEY,
        variant?.label ?? t('mkt.baseMarketVariant'),
        Number.parseInt(targetInput, 10),
        Math.max(1, Number.parseInt(quantityInput, 10) || 1),
      );
      setSearchItem(null);
      return;
    }
    addSelectedQuickViewToWatchlist();
  };

  return (
    <div className="wl-add">
      {isSearchMode ? null : (
        <div className="wl-add-head">
          <span className="wl-add-eyebrow">{t('wl.addSelectedItem')}</span>
          <span className="wl-add-item">{activeItemName ?? t('hm.searchFirst')}</span>
        </div>
      )}

      <div className={`wl-add-grid${isSearchMode ? ' with-search' : ''}`}>
        {isSearchMode ? (
          <div className="wl-field">
            <span className="wl-field-label">{t('wl.item')}</span>
            <ItemSearchInput selected={searchItem} onSelect={setSearchItem} />
          </div>
        ) : null}

        <label className="wl-field">
          <span className="wl-field-label">{t('wl.variant')}</span>
          <select
            className="wl-field-control"
            value={variantKey ?? ''}
            disabled={variants.length <= 1}
            onChange={(event) => {
              const next = event.target.value || null;
              if (isSearchMode) {
                setSearchVariantKey(next);
              } else {
                void setSelectedMarketVariantKey(next);
              }
            }}
            aria-label={t('a11y.selectRankVariant')}
          >
            {variants.length === 0 ? (
              <option value="">{t('mkt.baseMarketVariant')}</option>
            ) : null}
            {variants.map((variant) => (
              <option key={variant.key} value={variant.key}>
                {variant.label === 'Base Market' ? t('mkt.baseMarketVariant') : variant.label}
              </option>
            ))}
          </select>
        </label>

        <label className="wl-field">
          <span className="wl-field-label">{t('wl.target')}</span>
          <div className="wl-field-control wl-target-control">
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="0"
              value={targetInput}
              aria-label={t('a11y.desiredPrice')}
              onChange={(event) => setTargetInput(event.target.value)}
            />
            <span className="wl-target-unit">pt</span>
          </div>
        </label>

        <label className="wl-field">
          <span className="wl-field-label">{t('wl.boughtQuantity')}</span>
          <QuantityStepper
            value={Math.max(1, Number.parseInt(quantityInput, 10) || 1)}
            onChange={(next) => setQuantityInput(String(next))}
            label={t('wl.boughtQuantity')}
          />
        </label>

        <button className="btn-primary wl-add-btn" type="button" onClick={submit} disabled={!canAdd}>
          {t('wl.add')}
        </button>
      </div>

      {marketVariantsError && !isSearchMode ? (
        <div className="wl-add-error">{marketVariantsError}</div>
      ) : null}
      {formError ? <div className="wl-add-error">{formError}</div> : null}
    </div>
  );
}
