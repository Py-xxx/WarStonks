import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { getWfmAutocompleteItems } from '../../lib/tauriClient';
import { rankWfmAutocompleteItems } from '../../lib/wfmAutocomplete';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import type { WfmAutocompleteItem } from '../../types';

interface ItemSearchInputProps {
  selected: WfmAutocompleteItem | null;
  onSelect: (item: WfmAutocompleteItem | null) => void;
  placeholder?: string;
}

/**
 * A self-contained item autocomplete, so a surface can let the user pick an item without
 * depending on the top bar's search having been used first.
 *
 * The watchlist tab previously had no way to add anything: its form read the globally selected
 * Quick View item, so adding meant going to Home, searching there, then coming back.
 */
export function ItemSearchInput({ selected, onSelect, placeholder }: ItemSearchInputProps) {
  const { t } = useTranslation();
  const language = useAppStore((state) => state.language);
  const [items, setItems] = useState<WfmAutocompleteItem[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const deferredQuery = useDeferredValue(query);
  const suggestions = rankWfmAutocompleteItems(items, deferredQuery);

  useEffect(() => {
    let isMounted = true;
    setLoadState('loading');
    void getWfmAutocompleteItems(language)
      .then((loaded) => {
        if (isMounted) {
          setItems(loaded);
          setLoadState('ready');
        }
      })
      .catch(() => {
        if (isMounted) {
          setLoadState('error');
        }
      });
    return () => {
      isMounted = false;
    };
  }, [language]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    setHighlighted(0);
  }, [deferredQuery]);

  const choose = (item: WfmAutocompleteItem) => {
    onSelect(item);
    setQuery('');
    setOpen(false);
  };

  // Once an item is chosen the input shows it as a clearable chip — the field can't drift out of
  // sync with what will actually be added.
  if (selected) {
    const imageUrl = resolveWfmAssetUrl(selected.imagePath, selected.slug);
    return (
      <div className="wl-field-control wl-search-chip">
        <span className="wl-row-thumb">
          {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{selected.name.slice(0, 1)}</span>}
        </span>
        <span className="wl-search-chip-name">{selected.name}</span>
        <button
          type="button"
          className="wl-search-clear"
          aria-label={t('wl.clearSelection')}
          onClick={() => onSelect(null)}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="wl-search" ref={containerRef}>
      <input
        className="wl-field-control wl-search-input"
        type="text"
        value={query}
        placeholder={placeholder ?? t('wl.searchItems')}
        aria-label={placeholder ?? t('wl.searchItems')}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (!suggestions.length) {
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlighted((current) => (current + 1) % suggestions.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlighted((current) => (current - 1 + suggestions.length) % suggestions.length);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(suggestions[highlighted]);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (suggestions.length > 0 || query.trim().length > 0 || loadState !== 'ready') ? (
        <div className="wl-search-menu" role="listbox">
          {loadState === 'error' ? (
            <div className="wl-search-note">{t('wl.searchUnavailable')}</div>
          ) : null}
          {loadState === 'loading' ? (
            <div className="wl-search-note">{t('wl.searchLoading')}</div>
          ) : null}
          {loadState === 'ready' && query.trim().length > 0 && suggestions.length === 0 ? (
            <div className="wl-search-note">{t('wl.searchNoMatches')}</div>
          ) : null}
          {suggestions.map((item, index) => {
            const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
            return (
              <button
                key={item.wfmId}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={`wl-search-option${index === highlighted ? ' highlighted' : ''}`}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
              >
                <span className="wl-row-thumb">
                  {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{item.name.slice(0, 1)}</span>}
                </span>
                <span className="wl-search-option-name">{item.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
