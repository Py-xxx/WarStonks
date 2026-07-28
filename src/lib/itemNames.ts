// Localized item-name resolution for the UI. Backend display queries return English names
// (they don't join wfm_item_i18n), so we localize on the frontend using a map built from the
// localized autocomplete catalog (which already carries every item's localized-or-English name,
// keyed by wfmId and slug). Anything not in the map falls back to the original English name.
import type { ItemQuickViewTarget } from '../types';

export type ItemNameMap = Record<string, string>;

/**
 * Key prefix for the English-name index. Prefixed so an item called "mesa_prime_set" can never
 * collide with the slug entries that share the same map.
 */
export const ENGLISH_NAME_KEY_PREFIX = 'en:';

/** Builds the lookup key for an English item name. */
export function englishNameKey(name: string): string {
  return `${ENGLISH_NAME_KEY_PREFIX}${name.trim().toLowerCase()}`;
}

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
  // Last resort: match on the English name itself. Backend-built strings (opportunity action
  // labels, subtitles, reasons) carry a bare English item name with no id or slug attached, so
  // without this they interpolate untranslated into an otherwise localized sentence.
  const byEnglish = map[englishNameKey(target.name)];
  return byEnglish ?? target.name;
}
