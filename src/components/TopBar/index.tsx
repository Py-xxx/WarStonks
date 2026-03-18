import { useDeferredValue, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertsPanel } from '../AlertsPanel';
import { walletIcons } from '../../assets/wallet';
import { getWfmAutocompleteItems } from '../../lib/tauriClient';
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

function formatCurrencyValue(value: number | null, loading: boolean): string {
  if (loading) {
    return '…';
  }

  if (value === null) {
    return '-';
  }

  return new Intl.NumberFormat().format(value);
}

function formatTopBarVariantLabel(variantKey: string, fallbackLabel: string): string {
  if (variantKey.startsWith('rank:')) {
    return variantKey.slice(5);
  }

  return fallbackLabel;
}

export function TopBar() {
  const autoProfile = useAppStore((s) => s.autoProfile);
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
  const walletLoading = useAppStore((s) => s.walletLoading);
  const openSettingsSidebar = useAppStore((s) => s.openSettingsSidebar);

  const [searchValue, setSearchValue] = useState('');
  const [autocompleteItems, setAutocompleteItems] = useState<WfmAutocompleteItem[]>([]);
  const [autocompleteState, setAutocompleteState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [autocompleteError, setAutocompleteError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [tradeMenuOpen, setTradeMenuOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const notificationsRef = useRef<HTMLDivElement | null>(null);
  const tradeMenuRef = useRef<HTMLDivElement | null>(null);
  const previousAlertCountRef = useRef(0);
  const deferredSearchValue = useDeferredValue(searchValue);
  const suggestions = rankWfmAutocompleteItems(autocompleteItems, deferredSearchValue);
  const notificationCount = alerts.length + systemAlerts.length;
  const showMarketVariantSelect =
    Boolean(selectedQuickViewItem)
    && !marketVariantsLoading
    && marketVariants.length > 1;

  useEffect(() => {
    void loadTradeAccount();
  }, [loadTradeAccount]);

  useEffect(() => {
    let isMounted = true;

    const loadItems = async () => {
      setAutocompleteState('loading');
      setAutocompleteError(null);

      try {
        const items = await getWfmAutocompleteItems();
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
  }, []);

  useEffect(() => {
    if (selectedQuickViewItem) {
      setSearchValue(selectedQuickViewItem.name);
    }
  }, [selectedQuickViewItem]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [deferredSearchValue]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) {
        setDropdownOpen(false);
      }

      if (!notificationsRef.current?.contains(event.target as Node)) {
        setNotificationsOpen(false);
      }

      if (!tradeMenuRef.current?.contains(event.target as Node)) {
        setTradeMenuOpen(false);
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
    void loadQuickViewItem(item);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
    setTradesSubTab('sell-orders');
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
    <header className="topbar">
      <div className="logo">WarStonks</div>

      <div className="topbar-search-group">
        <div
          ref={searchRef}
          className={`search-bar${dropdownOpen ? ' open' : ''}`}
          role="search"
          aria-label="Search items"
        >
          <SearchIcon />
          <input
            className="search-input"
            type="text"
            value={searchValue}
            placeholder="Search WFM items, sets, relics…"
            onFocus={() => setDropdownOpen(suggestions.length > 0)}
            onChange={(event) => {
              setSearchValue(event.target.value);
              setDropdownOpen(event.target.value.trim().length > 0);
            }}
            onKeyDown={handleKeyDown}
            aria-autocomplete="list"
            aria-expanded={dropdownOpen}
            aria-controls="global-search-results"
          />
          <span className="kbd">⌘K</span>

          {dropdownOpen ? (
            <div className="search-dropdown" id="global-search-results" role="listbox">
              {autocompleteState === 'loading' ? (
                <div className="search-state">Loading local item catalog…</div>
              ) : null}

              {autocompleteState === 'error' ? (
                <div className="search-state error">
                  {autocompleteError ?? 'Failed to load the local item catalog.'}
                </div>
              ) : null}

              {autocompleteState === 'ready' && suggestions.length === 0 ? (
                <div className="search-state">No WFM items match that search.</div>
              ) : null}

              {autocompleteState === 'ready'
                ? suggestions.map((item, index) => (
                    <button
                      key={item.slug}
                      className={`search-suggestion${index === highlightedIndex ? ' active' : ''}`}
                      type="button"
                      role="option"
                      aria-selected={index === highlightedIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectItem(item)}
                    >
                      <span className="search-suggestion-main">
                        <span className="search-suggestion-thumb">
                          {resolveWfmAssetUrl(item.imagePath) ? (
                            <img
                              src={resolveWfmAssetUrl(item.imagePath) ?? undefined}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span>{item.name.slice(0, 1)}</span>
                          )}
                        </span>
                        <span className="search-suggestion-copy">
                          <span className="search-suggestion-name">{item.name}</span>
                          <span className="search-suggestion-meta">
                            {item.itemFamily ?? 'item'}
                          </span>
                        </span>
                      </span>
                    </button>
                  ))
                : null}
            </div>
          ) : null}
        </div>

        <button
          className={`topbar-search-refresh${quickViewLoading ? ' is-loading' : ''}`}
          type="button"
          onClick={() => {
            void handleRefreshSelectedItem();
          }}
          disabled={!selectedQuickViewItem || quickViewLoading}
          aria-label="Refresh selected item"
          title={selectedQuickViewItem ? 'Refresh selected item' : 'Search and select an item first'}
        >
          <RefreshIcon />
        </button>

        {showMarketVariantSelect ? (
          <div className="topbar-market-variant">
            <span className="topbar-market-variant-label">Rank</span>
            <select
              className="topbar-market-variant-select"
              value={selectedMarketVariantKey ?? ''}
              onChange={(event) => {
                void setSelectedMarketVariantKey(event.target.value || null);
              }}
              aria-label="Select rank market"
            >
              {marketVariants.map((variant) => (
                <option key={variant.key} value={variant.key}>
                  {formatTopBarVariantLabel(variant.key, variant.label)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="currency-strip" role="status" aria-label="Currency balances">
        <div className="currency-item ci-platinum">
          <div className="currency-icon">
            <img src={walletIcons.platinum} alt="" />
          </div>
          <div className="currency-info">
            <span className="currency-name">Platinum</span>
            <span className={`currency-val${walletSnapshot.balances.platinum === null ? ' no-data' : ''}`}>
              {formatCurrencyValue(walletSnapshot.balances.platinum, walletLoading)}
            </span>
          </div>
        </div>
        <div className="currency-item ci-credits">
          <div className="currency-icon">
            <img src={walletIcons.credits} alt="" />
          </div>
          <div className="currency-info">
            <span className="currency-name">Credits</span>
            <span className={`currency-val${walletSnapshot.balances.credits === null ? ' no-data' : ''}`}>
              {formatCurrencyValue(walletSnapshot.balances.credits, walletLoading)}
            </span>
          </div>
        </div>
        <div className="currency-item ci-endo">
          <div className="currency-icon">
            <img src={walletIcons.endo} alt="" />
          </div>
          <div className="currency-info">
            <span className="currency-name">Endo</span>
            <span className={`currency-val${walletSnapshot.balances.endo === null ? ' no-data' : ''}`}>
              {formatCurrencyValue(walletSnapshot.balances.endo, walletLoading)}
            </span>
          </div>
        </div>
        <div className="currency-item ci-ducats">
          <div className="currency-icon">
            <img src={walletIcons.ducats} alt="" />
          </div>
          <div className="currency-info">
            <span className="currency-name">Ducats</span>
            <span className={`currency-val${walletSnapshot.balances.ducats === null ? ' no-data' : ''}`}>
              {formatCurrencyValue(walletSnapshot.balances.ducats, walletLoading)}
            </span>
          </div>
        </div>
        <div className="currency-item ci-aya">
          <div className="currency-icon">
            <img src={walletIcons.aya} alt="" />
          </div>
          <div className="currency-info">
            <span className="currency-name">Aya</span>
            <span className={`currency-val${walletSnapshot.balances.aya === null ? ' no-data' : ''}`}>
              {formatCurrencyValue(walletSnapshot.balances.aya, walletLoading)}
            </span>
          </div>
        </div>
      </div>

      <div className="topbar-right">
        <div className="strategy-pill" title="Strategy configuration">
          CUSTOM · H:VERY SHORT · C:{autoProfile ? 'AUTO' : 'BALANCED'}
        </div>
        <div ref={notificationsRef} className="notification-wrap">
        <button
          className={`notification-btn${notificationsOpen ? ' open' : ''}`}
            type="button"
            aria-label="Open notifications"
            aria-expanded={notificationsOpen}
            onClick={() => setNotificationsOpen((current) => !current)}
          >
            <BellIcon />
            {notificationCount > 0 ? (
              <span className="notification-count">{notificationCount}</span>
            ) : null}
          </button>

          {notificationsOpen ? (
            <div className="notification-panel">
              <div className="notification-panel-header">
                <span className="card-label">Notifications</span>
                <span
                  className={`badge ${notificationCount > 0 ? 'badge-green' : 'badge-muted'}`}
                >
                  {notificationCount}
                </span>
              </div>
              <AlertsPanel />
            </div>
          ) : null}
        </div>
        {!tradeAccount ? (
          <button
            className="btn-connect"
            aria-label="Open trades"
            onClick={handleOpenTrades}
          >
            <ArrowIcon />
            {tradeAccountLoading ? 'Loading…' : 'Connect'}
          </button>
        ) : (
          <div ref={tradeMenuRef} className="trade-menu-wrap">
            <button
              className="btn-connect trade-connected"
              aria-label="Open trade account menu"
              aria-expanded={tradeMenuOpen}
              onClick={() => setTradeMenuOpen((value) => !value)}
            >
              <span>{tradeAccount.name}</span>
              <span className="trade-connected-separator">·</span>
              <span className={`trade-connected-status ${getTradeStatusToneClass(tradeAccount.status)}`}>
                {formatTradeStatusLabel(tradeAccount.status)}
              </span>
              <ChevronDownIcon />
            </button>

            {tradeMenuOpen ? (
              <div className="trade-menu-dropdown">
                <div className="trade-menu-header">
                  <span className="card-label">Warframe Market</span>
                  <span className="trade-menu-status-copy">
                    Choose how your presence appears on warframe.market.
                  </span>
                </div>

                <div className="trade-menu-section">
                  <span className="trade-menu-section-title">Presence</span>
                  <div className="trade-menu-status-grid">
                    {([
                      { value: 'ingame', label: 'Ingame' },
                      { value: 'online', label: 'Online' },
                      { value: 'invisible', label: 'Invisible' },
                    ] as const).map((option) => {
                      const isActive =
                        (tradeAccount.status === 'offline' ? 'invisible' : tradeAccount.status) === option.value;
                      return (
                        <button
                          key={option.value}
                          className={`trade-menu-status-btn${isActive ? ' active' : ''}`}
                          type="button"
                          disabled={tradeAccountLoading}
                          onClick={() => void handleSetPresence(option.value)}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="trade-menu-actions">
                  <button type="button" className="trade-menu-link" onClick={handleOpenTrades}>
                    Open Trades
                  </button>
                </div>

                {tradeAccountError ? (
                  <div className="trade-menu-error">{tradeAccountError}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
        <button
          className="settings-btn"
          title="Settings"
          aria-label="Open settings"
          onClick={() => openSettingsSidebar('alecaframe')}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
