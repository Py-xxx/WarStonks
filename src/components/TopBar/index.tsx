import { useDeferredValue, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { getWfmAutocompleteItems } from '../../lib/tauriClient';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { WfmAutocompleteItem } from '../../types';

const PlatinumIcon = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
    <circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="1.2" fill="none" opacity="0.4"/>
    <circle cx="5.5" cy="5.5" r="2" fill="currentColor"/>
  </svg>
);

const CreditsIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M8 2.5A3.5 3.5 0 1 0 8 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
  </svg>
);

const EndoIcon = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
    <polygon points="5.5,1 9.5,3.25 9.5,7.75 5.5,10 1.5,7.75 1.5,3.25" stroke="currentColor" strokeWidth="1.2" fill="none"/>
    <circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/>
  </svg>
);

const DucatsIcon = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
    <ellipse cx="5.5" cy="8.5" rx="3.5" ry="1.2" stroke="currentColor" strokeWidth="1" fill="none"/>
    <ellipse cx="5.5" cy="5.5" rx="3.5" ry="1.2" stroke="currentColor" strokeWidth="1" fill="none"/>
    <ellipse cx="5.5" cy="2.5" rx="3.5" ry="1.2" fill="currentColor" opacity="0.6"/>
  </svg>
);

const AyaIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <polygon points="5,1 9,5 5,9 1,5" stroke="currentColor" strokeWidth="1.2" fill="none"/>
    <polygon points="5,3 7,5 5,7 3,5" fill="currentColor" opacity="0.7"/>
  </svg>
);

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"/>
    <path d="m21 21-4.35-4.35"/>
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

function rankAutocompleteItems(items: WfmAutocompleteItem[], query: string): WfmAutocompleteItem[] {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return [];
  }

  const slugQuery = trimmedQuery.replace(/\s+/g, '_');
  const prefixMatches: WfmAutocompleteItem[] = [];
  const substringMatches: WfmAutocompleteItem[] = [];

  for (const item of items) {
    const normalizedName = item.name.toLowerCase();
    const isPrefixMatch =
      normalizedName.startsWith(trimmedQuery) || item.slug.startsWith(slugQuery);
    const isSubstringMatch =
      normalizedName.includes(trimmedQuery) || item.slug.includes(slugQuery);

    if (isPrefixMatch) {
      prefixMatches.push(item);
      continue;
    }

    if (isSubstringMatch) {
      substringMatches.push(item);
    }
  }

  return [...prefixMatches, ...substringMatches].slice(0, 8);
}

export function TopBar() {
  const autoProfile = useAppStore((s) => s.autoProfile);
  const loadQuickViewItem = useAppStore((s) => s.loadQuickViewItem);
  const selectedQuickViewItem = useAppStore((s) => s.quickView.selectedItem);

  const [searchValue, setSearchValue] = useState('');
  const [autocompleteItems, setAutocompleteItems] = useState<WfmAutocompleteItem[]>([]);
  const [autocompleteState, setAutocompleteState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [autocompleteError, setAutocompleteError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const deferredSearchValue = useDeferredValue(searchValue);
  const suggestions = rankAutocompleteItems(autocompleteItems, deferredSearchValue);

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
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, []);

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

  return (
    <header className="topbar">
      <div className="logo">WarStonks<span>v3</span></div>

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

      <div className="currency-strip" role="status" aria-label="Currency balances">
        <div className="currency-item ci-platinum">
          <div className="currency-icon"><PlatinumIcon /></div>
          <div className="currency-info">
            <span className="currency-name">Platinum</span>
            <span className="currency-val no-data">-</span>
          </div>
        </div>
        <div className="currency-item ci-credits">
          <div className="currency-icon"><CreditsIcon /></div>
          <div className="currency-info">
            <span className="currency-name">Credits</span>
            <span className="currency-val no-data">-</span>
          </div>
        </div>
        <div className="currency-item ci-endo">
          <div className="currency-icon"><EndoIcon /></div>
          <div className="currency-info">
            <span className="currency-name">Endo</span>
            <span className="currency-val no-data">-</span>
          </div>
        </div>
        <div className="currency-item ci-ducats">
          <div className="currency-icon"><DucatsIcon /></div>
          <div className="currency-info">
            <span className="currency-name">Ducats</span>
            <span className="currency-val no-data">-</span>
          </div>
        </div>
        <div className="currency-item ci-aya">
          <div className="currency-icon"><AyaIcon /></div>
          <div className="currency-info">
            <span className="currency-name">Aya</span>
            <span className="currency-val no-data">-</span>
          </div>
        </div>
      </div>

      <div className="topbar-right">
        <div className="strategy-pill" title="Strategy configuration">
          CUSTOM · H:VERY SHORT · C:{autoProfile ? 'AUTO' : 'BALANCED'}
        </div>
        <button className="btn-connect" aria-label="Connect to Warframe">
          <ArrowIcon />
          Connect
        </button>
        <button className="settings-btn" title="Settings" aria-label="Open settings">
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
