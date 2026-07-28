/**
 * One matcher for every item search box in the app.
 *
 * This exists because the same filter was written ~12 times inline, each comparing the query
 * against the *English* name while the row rendered a localized one — so a Chinese or French
 * player had to type what they could not see. Centralizing it means "search works in your
 * language" is one implementation to get right, not twelve to remember.
 */

/** Characters that should never decide whether a query matches. */
const DIACRITIC_PATTERN = /\p{Diacritic}/gu;

/**
 * Letters whose "plain" form isn't reachable by Unicode decomposition. NFD splits `é` into
 * `e` + a combining accent, but `ß` and `ø` are atomic — without this map, a German player
 * typing "grosse" would never find "Größe".
 */
const ATOMIC_FOLDINGS: Array<[RegExp, string]> = [
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ø/g, 'o'],
  [/đ/g, 'd'],
  [/ł/g, 'l'],
];

/**
 * Folds text to a comparable form: lowercased, diacritics removed, whitespace collapsed.
 *
 * Safe for CJK — `toLowerCase` and the diacritic strip are both no-ops on Chinese, Japanese,
 * and Korean text, so those scripts pass through unchanged and match exactly.
 */
export function normalizeSearchText(value: string): string {
  let folded = value.trim().toLowerCase();
  for (const [pattern, replacement] of ATOMIC_FOLDINGS) {
    folded = folded.replace(pattern, replacement);
  }
  return folded
    .normalize('NFD')
    .replace(DIACRITIC_PATTERN, '')
    .replace(/\s+/g, ' ');
}

/** The fields a query is matched against. All optional except the displayed name. */
export interface ItemSearchTarget {
  /** What the user actually sees — localized when a translation exists. */
  name: string;
  /** The English name, when known. Lets a bilingual user search either way. */
  nameEn?: string | null;
  /** WFM slug (`mesa_prime_set`) — an underscore-joined English fallback. */
  slug?: string | null;
}

/** How well a target matched, for ranking. Higher is better; 0 means no match. */
export const MATCH_NONE = 0;
export const MATCH_SUBSTRING = 1;
export const MATCH_PREFIX = 2;

/**
 * Scores one item against a query. Returns `MATCH_NONE` when nothing matched.
 *
 * Every field is checked, so an item is findable by its localized name, its English name, or
 * its slug regardless of the active language.
 */
export function scoreItemQuery(query: string, target: ItemSearchTarget): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return MATCH_NONE;
  }
  // The slug joins words with underscores, so a spaced query has to be re-joined to match it.
  const slugQuery = normalizedQuery.replace(/ /g, '_');

  const candidates: Array<[string | null | undefined, string]> = [
    [target.name, normalizedQuery],
    [target.nameEn, normalizedQuery],
    [target.slug, slugQuery],
  ];

  let best = MATCH_NONE;
  for (const [raw, needle] of candidates) {
    if (!raw) {
      continue;
    }
    const haystack = normalizeSearchText(raw);
    if (haystack.startsWith(needle)) {
      return MATCH_PREFIX;
    }
    if (haystack.includes(needle)) {
      best = MATCH_SUBSTRING;
    }
  }
  return best;
}

/** Convenience predicate for the many places that only need yes/no. */
export function matchesItemQuery(query: string, target: ItemSearchTarget): boolean {
  return scoreItemQuery(query, target) !== MATCH_NONE;
}
