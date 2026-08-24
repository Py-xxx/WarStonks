import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
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

  /**
   * Seed the search box from whatever the global search last selected, so opening the Watchlist
   * with an item already searched arrives with it filled in and ready to add.
   *
   * One-directional on purpose. The isolation above exists so this box cannot *disturb* the
   * global selection; reading from it breaks nothing. Keyed on the slug rather than the object,
   * so picking a different item here sticks — the effect only re-runs when the GLOBAL item
   * actually changes, not on every render or on local edits.
   */
  const quickViewSlug = quickViewItem?.slug ?? null;
  useEffect(() => {
    if (mode !== 'search' || !quickViewItem) {
      return;
    }
    // Already a `WfmAutocompleteItem` — pass it straight through rather than rebuilding it
    // field by field, which would invent defaults for anything the shape gains later.
    setSearchItem(quickViewItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the slug: see above.
  }, [mode, quickViewSlug]);

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
    <div className="flex flex-col gap-2.5">
      {isSearchMode ? null : (
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('wl.addSelectedItem')}</span>
          <span className="text-xs font-semibold text-ink">
            {activeItemName ?? t('hm.searchFirst')}
          </span>
        </div>
      )}

      {/* Fixed column widths so the row's controls line up whichever mode it is in — the search
          field only exists in search mode, and everything after it must not shift. */}
      <div
        className={`grid items-end gap-2 border-y border-line-subtle py-2.5 ${
          isSearchMode
            ? '[grid-template-columns:minmax(0,1fr)_132px_92px_96px_auto]'
            : '[grid-template-columns:132px_92px_96px_auto_minmax(0,1fr)]'
        }`}
      >
        {isSearchMode ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('wl.item')}</span>
            <ItemSearchInput selected={searchItem} onSelect={setSearchItem} />
          </div>
        ) : null}

        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('wl.variant')}</span>
          <Select
            className="h-8"
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
          </Select>
        </label>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('wl.target')}</span>
          <span className="relative flex items-center">
            <Input
              className="pr-7 tabular-nums"
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
            <span className="pointer-events-none absolute right-2 font-mono text-[10px] text-ink-dim">
              pt
            </span>
          </span>
        </label>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">{t('wl.boughtQuantity')}</span>
          <QuantityStepper
            value={Math.max(1, Number.parseInt(quantityInput, 10) || 1)}
            onChange={(next) => setQuantityInput(String(next))}
            label={t('wl.boughtQuantity')}
          />
        </label>

        <Button className="h-8 px-4 text-xs" onClick={submit} disabled={!canAdd}>
          {t('wl.add')}
        </Button>
      </div>

      {marketVariantsError && !isSearchMode ? (
        <p className="text-[11px] text-accent-red">{marketVariantsError}</p>
      ) : null}
      {formError ? <p className="text-[11px] text-accent-red">{formError}</p> : null}
    </div>
  );
}
