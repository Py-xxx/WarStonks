import type { WfmAutocompleteItem } from '../types';

export function rankWfmAutocompleteItems(
  items: WfmAutocompleteItem[],
  query: string,
  limit = 8,
): WfmAutocompleteItem[] {
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

  return [...prefixMatches, ...substringMatches].slice(0, limit);
}
