import type { WfmAutocompleteItem } from '../types';
import { MATCH_NONE, MATCH_PREFIX, scoreItemQuery } from './itemSearch';

/**
 * Ranks the item catalog against a search query, best matches first.
 *
 * Matching lives in `itemSearch` so this behaves identically to every other search box in the
 * app — including finding items by the localized name the player actually sees on screen.
 */
export function rankWfmAutocompleteItems(
  items: WfmAutocompleteItem[],
  query: string,
  limit = 8,
): WfmAutocompleteItem[] {
  if (!query.trim()) {
    return [];
  }

  const prefixMatches: WfmAutocompleteItem[] = [];
  const substringMatches: WfmAutocompleteItem[] = [];

  for (const item of items) {
    const score = scoreItemQuery(query, {
      name: item.name,
      nameEn: item.nameEn,
      slug: item.slug,
    });
    if (score === MATCH_PREFIX) {
      prefixMatches.push(item);
    } else if (score !== MATCH_NONE) {
      substringMatches.push(item);
    }
  }

  return [...prefixMatches, ...substringMatches].slice(0, limit);
}
