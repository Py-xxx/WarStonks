import { useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { resolveLocalizedName } from '../lib/itemNames';

/**
 * Parameter names the backend uses to carry an item name into a translated string. Anything
 * else (counts, prices, percentages) is left alone.
 */
const ITEM_NAME_PARAMS = new Set(['name', 'item', 'itemName', 'setName', 'relic', 'relicName']);

/**
 * Localizes the item names inside an interpolation parameter bag.
 *
 * The backend builds strings like `label_params: { name: "Gara Prime Set" }` using the English
 * catalog, and the frontend drops that straight into a translated template — producing a
 * Chinese sentence wrapped around an English item name. Running the bag through here first
 * means the whole sentence is in one language.
 */
export function useLocalizedParams(): (
  params: Record<string, string> | undefined | null,
) => Record<string, string> | undefined {
  const map = useAppStore((state) => state.itemNameMap);
  return useCallback(
    (params) => {
      if (!params) {
        return undefined;
      }
      let changed = false;
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) {
        if (ITEM_NAME_PARAMS.has(key) && typeof value === 'string') {
          // No id or slug travels with these, so resolution falls to the English-name index.
          const localized = resolveLocalizedName(map, { name: value, slug: null, wfmId: null });
          next[key] = localized;
          changed ||= localized !== value;
        } else {
          next[key] = value;
        }
      }
      return changed ? next : params;
    },
    [map],
  );
}
