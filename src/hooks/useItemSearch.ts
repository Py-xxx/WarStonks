import { useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { resolveLocalizedName } from '../lib/itemNames';
import { matchesItemQuery } from '../lib/itemSearch';

/** The shape every searchable row has, whatever page it came from. */
export interface SearchableItem {
  name: string;
  slug?: string | null;
  wfmId?: string | null;
}

/**
 * Returns a matcher that searches an item by the name the user can actually see.
 *
 * Backend rows (scanner results, relic drops, owned parts) always carry the **English** name —
 * the display queries don't join `wfm_item_i18n`, so the UI localizes on the frontend via the
 * name map. Filtering on the raw row therefore meant a localized player had to type a name
 * that appeared nowhere on their screen. This resolves the localized name first, then matches
 * against it *and* the original English one, so either works in any language.
 */
export function useItemQueryMatcher(): (query: string, item: SearchableItem) => boolean {
  const map = useAppStore((state) => state.itemNameMap);
  return useCallback(
    (query, item) =>
      matchesItemQuery(query, {
        name: resolveLocalizedName(map, {
          name: item.name,
          slug: item.slug ?? null,
          wfmId: item.wfmId ?? null,
        }),
        // The row's own name is the English one; keep it searchable so a player who knows the
        // English term is never worse off for having the app localized.
        nameEn: item.name,
        slug: item.slug,
      }),
    [map],
  );
}
