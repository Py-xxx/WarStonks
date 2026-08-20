import { useDeferredValue, useEffect, useRef, useState, useMemo } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AlertsPanel } from '../AlertsPanel';
import { walletIcons } from '../../assets/wallet';
import { getWfmAutocompleteItems } from '../../lib/tauriClient';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { formatElapsedTime } from '../../lib/dateTime';
import { formatTradeStatusLabel, getTradeStatusToneClass } from '../../lib/trades';
import { rankWfmAutocompleteItems } from '../../lib/wfmAutocomplete';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { WfmAutocompleteItem } from '../../types';

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"/>
    <path d="m21 21-4.35-4.35"/>
  </svg>
);

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

const GearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);

const ArrowIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M5 12h14M12 5l7 7-7 7"/>
  </svg>
);

const BellIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/**
 * Compact figures for the secondary currencies.
 *
 * Credits run into the millions and endo into the tens of thousands; at full precision they
 * dominate a strip whose point is platinum. Platinum itself is never abbreviated — it is the
 * working number and the exact value matters.
 */
/**
 * The four currencies that ride behind platinum, in the order they appear.
 *
 * Held as data rather than five copy-pasted blocks: they render identically, and the previous
 * markup repeated the same eight lines per currency.
 */
const SECONDARY_CURRENCIES = [
  { key: 'credits', icon: walletIcons.credits, labelKey: 'bal.credits' },
  { key: 'endo', icon: walletIcons.endo, labelKey: 'bal.endo' },
  { key: 'ducats', icon: walletIcons.ducats, labelKey: 'bal.ducats' },
  { key: 'aya', icon: walletIcons.aya, labelKey: 'bal.aya' },
] as const satisfies ReadonlyArray<{
  key: 'credits' | 'endo' | 'ducats' | 'aya';
  icon: string;
  labelKey: TranslationKey;
}>;

function formatCompactCurrencyValue(value: number | null, loading: boolean): string {
  if (loading) {
    return '…';
  }
  if (value === null) {
    return '-';
  }
  if (Math.abs(value) >= 1000) {
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }
  return new Intl.NumberFormat().format(value);
}

/** Matches `STALE_SYNC_MS` in the inventory tab — the same measured push-gap reasoning. */
const CURRENCY_STALE_MS = 60 * 60 * 1000;

function formatCurrencyValue(value: number | null, loading: boolean): string {
  if (loading) {
    return '…';
  }

  if (value === null) {
    return '-';
  }

  return new Intl.NumberFormat().format(value);
}

function formatTopBarVariantLabel(variantKey: string, fallbackLabel: string, t: (key: TranslationKey) => string): string {
  if (variantKey.startsWith('rank:')) {
    return variantKey.slice(5);
  }

  return fallbackLabel === 'Base Market' ? t('mkt.baseMarketVariant') : fallbackLabel;
}

export function TopBar() {
  const language = useAppStore((s) => s.language);
  const { t } = useTranslation();
  const alerts = useAppStore((s) => s.alerts);
  const marketVariants = useAppStore((s) => s.marketVariants);
  const marketVariantsLoading = useAppStore((s) => s.marketVariantsLoading);
  const selectedMarketVariantKey = useAppStore((s) => s.selectedMarketVariantKey);
  const systemAlerts = useAppStore((s) => s.systemAlerts);
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const tradeAccountLoading = useAppStore((s) => s.tradeAccountLoading);
  const tradeAccountError = useAppStore((s) => s.tradeAccountError);
  const loadTradeAccount = useAppStore((s) => s.loadTradeAccount);
  const setTradeAccountStatus = useAppStore((s) => s.setTradeAccountStatus);
  const loadQuickViewItem = useAppStore((s) => s.loadQuickViewItem);
  const loadSelectedMarketAnalysis = useAppStore((s) => s.loadSelectedMarketAnalysis);
  const selectedQuickViewItem = useAppStore((s) => s.quickView.selectedItem);
  const quickViewLoading = useAppStore((s) => s.quickView.loading);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const setSelectedMarketVariantKey = useAppStore((s) => s.setSelectedMarketVariantKey);
  const setTradesSubTab = useAppStore((s) => s.setTradesSubTab);
  const walletSnapshot = useAppStore((s) => s.walletSnapshot);
  const walletSessionPlatinum = useAppStore((s) => s.walletSessionPlatinum);
  const walletLoading = useAppStore((s) => s.walletLoading);
  /** Platinum moved since the app opened. Hidden at zero — a "+0" chip is noise, and this is
   *  meant to catch the eye only when a trade has actually changed the balance. */
  const platinumDelta = useMemo(() => {
    const current = walletSnapshot.balances.platinum;
    if (current === null || walletSessionPlatinum === null) {
      return null;
    }
    const delta = current - walletSessionPlatinum;
    return delta === 0 ? null : delta;
  }, [walletSnapshot.balances.platinum, walletSessionPlatinum]);
  /**
   * Whether the balances on screen are old enough to say so.
   *
   * Keyed on AlecaFrame's own "as of", which is preserved when a failed read carries the last
   * known values forward and when they are restored from the on-disk cache at startup — so
   * this reflects the age of the numbers rather than of the last attempt to fetch them.
   * One hour matches the inventory tab's measured threshold.
   */
  const currencyIsStale = useMemo(() => {
    if (!walletSnapshot.lastUpdate) {
      return false;
    }
    const asOf = Date.parse(walletSnapshot.lastUpdate);
    return Number.isFinite(asOf) && Date.now() - asOf > CURRENCY_STALE_MS;
  }, [walletSnapshot.lastUpdate]);
  const openSettingsSidebar = useAppStore((s) => s.openSettingsSidebar);
  const openItemInQuickView = useAppStore((s) => s.openItemInQuickView);
  const navigationBack = useAppStore((s) => s.navigationBack);
  const goBack = useAppStore((s) => s.goBack);
  const recentItems = useAppStore((s) => s.recentItems);
  const searchFocusNonce = useAppStore((s) => s.searchFocusNonce);
  const requestSearchFocus = useAppStore((s) => s.requestSearchFocus);

  const [searchValue, setSearchValue] = useState('');
  const [autocompleteItems, setAutocompleteItems] = useState<WfmAutocompleteItem[]>([]);
  const [autocompleteState, setAutocompleteState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [autocompleteError, setAutocompleteError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [tradeMenuOpen, setTradeMenuOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const previousAlertCountRef = useRef(0);
  const deferredSearchValue = useDeferredValue(searchValue);
  const suggestions = rankWfmAutocompleteItems(autocompleteItems, deferredSearchValue);
  const notificationCount = alerts.length + systemAlerts.length;
  const showMarketVariantSelect =
    Boolean(selectedQuickViewItem)
    && !marketVariantsLoading
    && marketVariants.length > 1;
  // For plain ranked items every variant is a rank — collapse the dropdown into a
  // rank-0 / max-rank toggle. Mixed variant kinds (e.g. subtypes) keep the select.
  const rankToggleVariants = (() => {
    if (!showMarketVariantSelect || !marketVariants.every((v) => v.key.startsWith('rank:') && v.rank !== null)) {
      return null;
    }
    const sorted = [...marketVariants].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    return min.key === max.key ? null : { min, max };
  })();

  useEffect(() => {
    void loadTradeAccount();
  }, [loadTradeAccount]);

  useEffect(() => {
    let isMounted = true;

    const loadItems = async () => {
      setAutocompleteState('loading');
      setAutocompleteError(null);

      try {
        const items = await getWfmAutocompleteItems(language);
        if (!isMounted) {
          return;
        }

        setAutocompleteItems(items);
        setAutocompleteState('ready');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setAutocompleteState('error');
        setAutocompleteError(error instanceof Error ? error.message : String(error));
      }
    };

    void loadItems();

    return () => {
      isMounted = false;
    };
  }, [language]);

  useEffect(() => {
    if (selectedQuickViewItem) {
      setSearchValue(selectedQuickViewItem.name);
    }
  }, [selectedQuickViewItem]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [deferredSearchValue]);

  useEffect(() => {
    // Only the search dropdown still needs this. The notification and presence menus are Base UI
    // popovers now, which handle their own dismissal, Escape and focus return.
    const handlePointerDown = (event: MouseEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) {
        setDropdownOpen(false);
      }

    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    if (notificationCount > previousAlertCountRef.current) {
      setNotificationsOpen(true);
    }

    previousAlertCountRef.current = notificationCount;
  }, [notificationCount]);

  const selectItem = (item: WfmAutocompleteItem) => {
    setSearchValue(item.name);
    setDropdownOpen(false);
    // `'stay'` — searching selects an item, it does not navigate. It used to jump you to Home,
    // which yanked you off whatever you were doing and (since Quick View moved to Market) did not
    // even show the item you searched for. Selecting still loads Quick View, records the item in
    // recents and kicks off the market refresh; the page you are on is your business.
    void openItemInQuickView(item, 'stay');
  };

  useEffect(() => {
    const handleHotkey = (event: WindowEventMap['keydown']) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        requestSearchFocus();
      }
    };
    window.addEventListener('keydown', handleHotkey);
    return () => window.removeEventListener('keydown', handleHotkey);
  }, [requestSearchFocus]);

  useEffect(() => {
    if (searchFocusNonce === 0) {
      return;
    }
    const input = searchRef.current?.querySelector<HTMLInputElement>('input');
    input?.focus();
    input?.select();
    setDropdownOpen(suggestions.length > 0 || recentItems.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFocusNonce]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // While an IME is composing (Chinese, Japanese, Korean), Enter and the arrow keys belong to
    // the candidate picker, not to us — stealing them makes the input unusable in those
    // languages. `isComposing` is false for every Latin-script keystroke, so this costs nothing.
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!dropdownOpen && suggestions.length > 0) {
        setDropdownOpen(true);
        return;
      }

      setHighlightedIndex((current) =>
        suggestions.length === 0 ? 0 : Math.min(current + 1, suggestions.length - 1),
      );
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === 'Enter') {
      if (!dropdownOpen || suggestions.length === 0) {
        return;
      }

      event.preventDefault();
      selectItem(suggestions[highlightedIndex] ?? suggestions[0]);
      return;
    }

    if (event.key === 'Escape') {
      setDropdownOpen(false);
    }
  };

  const handleOpenTrades = () => {
    setActivePage('trades');
    setTradesSubTab('orders');
    void loadTradeAccount();
    setTradeMenuOpen(false);
  };

  const handleSetPresence = async (status: 'ingame' | 'online' | 'invisible') => {
    try {
      await setTradeAccountStatus(status);
      setTradeMenuOpen(false);
    } catch (error) {
      console.error('[trades] failed to update presence', error);
    }
  };

  const handleRefreshSelectedItem = async () => {
    if (!selectedQuickViewItem || quickViewLoading) {
      return;
    }

    try {
      await loadQuickViewItem(selectedQuickViewItem);
      await loadSelectedMarketAnalysis({ force: true });
    } catch (error) {
      console.error('[market] failed to refresh selected item', error);
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-bg-surface px-3">
      <span className="shrink-0 font-mono text-[13px] font-bold tracking-[0.02em] text-ink">
        WarStonks
      </span>

      {navigationBack ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={goBack}
          title={t('a11y.goBack')}
          className="h-7 shrink-0 px-2 text-[11px]"
        >
          ← {t('common.back')}
        </Button>
      ) : null}

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          ref={searchRef}
          className="relative flex h-8 min-w-0 max-w-[420px] flex-1 items-center gap-2 rounded-md border border-line bg-bg-base px-2.5 focus-within:border-line-strong"
          role="search"
          aria-label={t('search.placeholder')}
        >
          <span className="shrink-0 text-ink-faint" aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            className="min-w-0 flex-1 border-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
            type="text"
            value={searchValue}
            placeholder={t('search.placeholder')}
            onFocus={() => setDropdownOpen(suggestions.length > 0 || recentItems.length > 0)}
            onChange={(event) => {
              setSearchValue(event.target.value);
              setDropdownOpen(event.target.value.trim().length > 0);
            }}
            onKeyDown={handleKeyDown}
            aria-autocomplete="list"
            aria-expanded={dropdownOpen}
            aria-controls="global-search-results"
          />
          <span className="shrink-0 rounded border border-line-strong bg-bg-elevated px-1 font-mono text-[9px] text-ink-faint">
            ⌘K
          </span>

          {dropdownOpen ? (
            <div
              className="absolute top-[calc(100%+6px)] right-0 left-0 z-(--z-dropdown) max-h-96 overflow-y-auto rounded-md border border-line-strong bg-bg-elevated p-1 shadow-float"
              id="global-search-results"
              role="listbox"
            >
              {searchValue.trim() === '' && recentItems.length > 0 ? (
                <>
                  <div className="px-2 py-1 font-mono text-[9px] tracking-[0.07em] text-ink-faint uppercase">
                    {t('topbar.recent')}
                  </div>
                  {recentItems.map((item) => (
                    <Button
                      key={`recent-${item.slug}`}
                      variant="ghost"
                      size="sm"
                      static
                      className="h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-left"
                      role="option"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectItem(item)}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-sm bg-bg-panel text-[10px] text-ink-faint [&>img]:size-full [&>img]:object-cover">
                          {resolveWfmAssetUrl(item.imagePath, item.slug) ? (
                            <img src={resolveWfmAssetUrl(item.imagePath, item.slug) ?? undefined} alt="" loading="lazy" />
                          ) : (
                            <span>{item.name.slice(0, 1)}</span>
                          )}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-xs text-ink">{item.name}</span>
                          <span className="truncate text-[10px] text-ink-dim">
                            {item.itemFamily ?? 'item'}
                          </span>
                        </span>
                      </span>
                    </Button>
                  ))}
                </>
              ) : null}

              {searchValue.trim() !== '' && autocompleteState === 'loading' ? (
                <div className="px-2 py-3 text-center text-[11px] text-ink-dim">
                  {t('topbar.loadingCatalog')}
                </div>
              ) : null}

              {searchValue.trim() !== '' && autocompleteState === 'error' ? (
                <div className="px-2 py-3 text-center text-[11px] text-accent-red">
                  {autocompleteError ?? t('topbar.catalogLoadFailed')}
                </div>
              ) : null}

              {searchValue.trim() !== '' && autocompleteState === 'ready' && suggestions.length === 0 ? (
                <div className="px-2 py-3 text-center text-[11px] text-ink-dim">
                  {t('topbar.noItemsMatch')}
                </div>
              ) : null}

              {searchValue.trim() !== '' && autocompleteState === 'ready'
                ? suggestions.map((item, index) => (
                    <Button
                      key={item.slug}
                      variant="ghost"
                      size="sm"
                      static
                      className={`h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-left ${
                        index === highlightedIndex ? 'bg-white/[0.07]' : ''
                      }`}
                      role="option"
                      aria-selected={index === highlightedIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectItem(item)}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-sm bg-bg-panel text-[10px] text-ink-faint [&>img]:size-full [&>img]:object-cover">
                          {resolveWfmAssetUrl(item.imagePath, item.slug) ? (
                            <img
                              src={resolveWfmAssetUrl(item.imagePath, item.slug) ?? undefined}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span>{item.name.slice(0, 1)}</span>
                          )}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-xs text-ink">{item.name}</span>
                          <span className="truncate text-[10px] text-ink-dim">
                            {item.itemFamily ?? 'item'}
                          </span>
                        </span>
                      </span>
                    </Button>
                  ))
                : null}
            </div>
          ) : null}
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void handleRefreshSelectedItem();
          }}
          disabled={!selectedQuickViewItem || quickViewLoading}
          aria-label={t('a11y.refreshSelectedItem')}
          title={selectedQuickViewItem ? t('topbar.refreshSelectedItem') : t('topbar.searchSelectFirst')}
          className="shrink-0 text-ink-dim hover:text-ink"
        >
          <RefreshIcon />
        </Button>

        {showMarketVariantSelect ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono text-[9px] tracking-[0.07em] text-ink-faint uppercase">
              {t('wl.rank')}
            </span>
            {rankToggleVariants ? (
              <div
                className="flex overflow-hidden rounded-md border border-line-strong"
                role="group"
                aria-label={t('a11y.selectRankMarket')}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  static
                  className={`h-6 border-0 px-2 font-mono text-[10px] font-semibold tabular-nums ${
                    selectedMarketVariantKey === rankToggleVariants.min.key
                      ? 'bg-bg-elevated text-ink'
                      : 'text-ink-dim hover:text-ink'
                  }`}
                  aria-pressed={selectedMarketVariantKey === rankToggleVariants.min.key}
                  title={t('trades.modal.rankUnranked')}
                  onClick={() => {
                    void setSelectedMarketVariantKey(rankToggleVariants.min.key);
                  }}
                >
                  R{rankToggleVariants.min.rank ?? 0}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  static
                  className={`h-6 border-0 border-l border-line-strong px-2 font-mono text-[10px] font-semibold tabular-nums ${
                    selectedMarketVariantKey === rankToggleVariants.max.key
                      ? 'bg-bg-elevated text-ink'
                      : 'text-ink-dim hover:text-ink'
                  }`}
                  aria-pressed={selectedMarketVariantKey === rankToggleVariants.max.key}
                  title={t('trades.modal.rankMax')}
                  onClick={() => {
                    void setSelectedMarketVariantKey(rankToggleVariants.max.key);
                  }}
                >
                  R{rankToggleVariants.max.rank ?? 0}
                </Button>
              </div>
            ) : (
              <select
                className="h-6 rounded-md border border-line-strong bg-bg-elevated px-1.5 text-[11px] text-ink outline-none"
                value={selectedMarketVariantKey ?? ''}
                onChange={(event) => {
                  void setSelectedMarketVariantKey(event.target.value || null);
                }}
                aria-label={t('a11y.selectRankMarket')}
              >
                {marketVariants.map((variant) => (
                  <option key={variant.key} value={variant.key}>
                    {formatTopBarVariantLabel(variant.key, variant.label, t)}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : null}
      </div>

      {/* role="group" (not "status"): balances update on every poll, and a live region would
          re-announce all of them on each refresh. */}
      {/* Balances now survive a failed read and an app restart, so they can be genuinely old.
          The strip has no other age cue, and a stale platinum count read as current is a
          trading decision made on bad data — so mark it, using the same one-hour threshold the
          inventory tab settled on from measured push gaps. */}
      <div
        className={`flex shrink-0 items-center gap-2.5 rounded-md border border-line bg-bg-base px-2.5 py-1 ${
          currencyIsStale ? 'opacity-60' : ''
        }`}
        role="group"
        aria-label={t('a11y.currencyBalances')}
        title={currencyIsStale ? t('bal.stale', { time: formatElapsedTime(walletSnapshot.lastUpdate) }) : undefined}
      >
        <div className="flex items-center gap-1.5" title={t('bal.platinum')}>
          <span className="grid size-4 shrink-0 place-items-center [&>img]:size-full [&>img]:object-contain">
            <img src={walletIcons.platinum} alt="" />
          </span>
          <span
            className={`font-mono text-xs font-semibold tabular-nums ${
              walletSnapshot.balances.platinum === null ? 'text-ink-faint' : 'text-ink'
            }`}
          >
            {formatCurrencyValue(walletSnapshot.balances.platinum, walletLoading)}
          </span>
          {/* Only present once platinum has moved — an empty reserved slot reads as a gap. */}
          {platinumDelta !== null ? (
            <span
              className={`font-mono text-[10px] font-semibold tabular-nums ${
                platinumDelta < 0 ? 'text-accent-red' : 'text-accent-green'
              }`}
            >
              {platinumDelta > 0 ? '+' : ''}
              {new Intl.NumberFormat().format(platinumDelta)}
            </span>
          ) : null}
        </div>

        <span className="h-3.5 w-px shrink-0 bg-line" aria-hidden="true" />

        {SECONDARY_CURRENCIES.map(({ key, icon, labelKey }) => (
          <div key={key} className="flex items-center gap-1.5" title={t(labelKey)}>
            <span className="grid size-4 shrink-0 place-items-center [&>img]:size-full [&>img]:object-contain">
              <img src={icon} alt="" />
            </span>
            <span
              className={`font-mono text-xs tabular-nums ${
                walletSnapshot.balances[key] === null ? 'text-ink-faint' : 'text-ink-soft'
              }`}
            >
              {formatCompactCurrencyValue(walletSnapshot.balances[key], walletLoading)}
            </span>
          </div>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* Was a hand-rolled absolutely-positioned panel with its own click-outside listener.
            Base UI portals it, handles dismissal and Escape, and does real collision detection —
            which matters here because the panel is up to 460px wide and right-aligned. */}
        <Popover open={notificationsOpen} onOpenChange={setNotificationsOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('a11y.openNotifications')}
                className="relative text-ink-dim hover:text-ink"
              />
            }
          >
            <BellIcon />
            {notificationCount > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-accent-red px-1 font-mono text-[9px] font-bold text-ink tabular-nums">
                {notificationCount}
              </span>
            ) : null}
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" className="w-[min(460px,calc(100vw-40px))] p-0">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <span className="font-mono text-xs font-semibold tracking-[0.06em] text-ink-soft uppercase">
                {t('settings.section.notifications.label')}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                  notificationCount > 0
                    ? 'bg-accent-green/15 text-accent-green'
                    : 'bg-bg-elevated text-ink-faint'
                }`}
              >
                {notificationCount}
              </span>
            </div>
            <AlertsPanel />
          </PopoverContent>
        </Popover>
        {!tradeAccount ? (
          <Button
            size="sm"
            aria-label={t('a11y.openTrades')}
            onClick={handleOpenTrades}
            className="h-7 gap-1.5 px-2.5 text-[11px]"
          >
            <ArrowIcon />
            {tradeAccountLoading ? t('common.loading') : t('common.connect')}
          </Button>
        ) : (
          <Popover open={tradeMenuOpen} onOpenChange={setTradeMenuOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('a11y.openTradeMenu')}
                  className="h-7 gap-1.5 border-line-strong px-2 text-[11px]"
                />
              }
            >
              <span className="max-w-32 truncate">{tradeAccount.name}</span>
              <span className="text-ink-faint">·</span>
              <span className={getTradeStatusToneClass(tradeAccount.status)}>
                {formatTradeStatusLabel(tradeAccount.status)}
              </span>
              <ChevronDownIcon />
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-44">
              <div role="listbox" aria-label={t('a11y.presence')} className="flex flex-col gap-0.5">
                {([
                  { value: 'online', label: t('status.online') },
                  { value: 'ingame', label: t('home.seller.ingame') },
                  { value: 'invisible', label: t('status.invisible') },
                ] as const).map((option) => {
                  const isActive =
                    (tradeAccount.status === 'offline' ? 'invisible' : tradeAccount.status) === option.value;
                  return (
                    <Button
                      key={option.value}
                      variant="ghost"
                      size="sm"
                      static
                      role="option"
                      aria-selected={isActive}
                      disabled={tradeAccountLoading}
                      onClick={() => void handleSetPresence(option.value)}
                      className={`h-7 w-full justify-start gap-2 px-2 text-[12px] ${
                        isActive ? 'bg-white/[0.05] text-ink' : 'text-ink-dim hover:text-ink'
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${getTradeStatusToneClass(option.value)}`}
                      />
                      {option.label}
                    </Button>
                  );
                })}

                {tradeAccountError ? (
                  <div className="px-2 py-1 text-[11px] text-accent-red">{tradeAccountError}</div>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('settings.title')}
          aria-label={t('a11y.openSettings')}
          onClick={() => openSettingsSidebar('alecaframe')}
          className="text-ink-dim hover:text-ink"
        >
          <GearIcon />
        </Button>
      </div>
    </header>
  );
}
