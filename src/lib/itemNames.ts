// Localized item-name resolution for the UI. Backend display queries return English names
// (they don't join wfm_item_i18n), so we localize on the frontend using a map built from the
// localized autocomplete catalog (which already carries every item's localized-or-English name,
// keyed by wfmId and slug). Anything not in the map falls back to the original English name.
import type { ItemQuickViewTarget } from '../types';

export type ItemNameMap = Record<string, string>;

export function resolveLocalizedName(
  map: ItemNameMap | undefined,
  target: Pick<ItemQuickViewTarget, 'wfmId' | 'slug' | 'name'>,
): string {
  if (!map) {
    return target.name;
  }
  if (target.wfmId && map[target.wfmId]) {
    return map[target.wfmId];
  }
  if (target.slug && map[target.slug]) {
    return map[target.slug];
  }
  return target.name;
}
