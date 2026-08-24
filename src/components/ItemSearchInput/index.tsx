import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ItemThumb } from '../ListRow';
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
      <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-line-strong bg-bg-base px-2">
        <ItemThumb src={imageUrl} fallback={selected.name.slice(0, 1)} size="size-5" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{selected.name}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          static
          className="-mr-1 size-6 shrink-0"
          aria-label={t('wl.clearSelection')}
          onClick={() => onSelect(null)}
        >
          <i className="ti ti-x text-xs" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative min-w-0" ref={containerRef}>
      <Input
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
        // `z-(--z-dropdown)` written in the form Tailwind actually generates — a bare `z-dropdown`
        // produces nothing and leaves the menu at `z-index: auto`. Guard 7 catches that.
        <div
          className="absolute top-full right-0 left-0 z-(--z-dropdown) mt-1 max-h-60 overflow-y-auto rounded-md border border-white/12 bg-bg-overlay p-1 shadow-float"
          role="listbox"
        >
          {loadState === 'error' ? (
            <p className="px-2 py-1.5 text-[11px] text-accent-red">{t('wl.searchUnavailable')}</p>
          ) : null}
          {loadState === 'loading' ? (
            <p className="px-2 py-1.5 text-[11px] text-ink-dim">{t('wl.searchLoading')}</p>
          ) : null}
          {loadState === 'ready' && query.trim().length > 0 && suggestions.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-ink-dim">{t('wl.searchNoMatches')}</p>
          ) : null}
          {suggestions.map((item, index) => {
            const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
            return (
              <Button
                key={item.wfmId}
                variant="ghost"
                size="sm"
                static
                role="option"
                aria-selected={index === highlighted}
                className={`h-auto w-full min-w-0 justify-start gap-2 rounded-sm px-1.5 py-1 text-left ${
                  index === highlighted ? 'bg-bg-elevated text-ink' : 'text-ink-soft'
                }`}
                onMouseEnter={() => setHighlighted(index)}
                // `onMouseDown` + `preventDefault`, not `onClick`: the input's blur fires first
                // and would close the menu before a click could land on it.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
              >
                <ItemThumb src={imageUrl} fallback={item.name.slice(0, 1)} size="size-5" />
                <span className="min-w-0 flex-1 truncate text-xs">{item.name}</span>
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
