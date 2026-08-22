/**
 * Which relic icon an item maps to.
 *
 * Deliberately holds no asset imports, so the rule can be unit-tested on its own — the files are
 * wired up in `wfmAssets.ts`, the same split `partImages.ts` uses.
 *
 * **Era is the whole identity.** Refinement does not change a relic's picture, and WFM's per-item
 * art gave us four near-identical images per relic plus different pictures for the same relic on
 * different surfaces, depending on which backend table the path came from. One image per era is
 * both more consistent and more informative, because era is the thing you actually sort on.
 */

/** The eras we ship art for. Anything else falls through to WFM's own image. */
export const RELIC_ERAS = ['lith', 'meso', 'neo', 'axi', 'requiem', 'vanguard'] as const;

export type RelicEra = (typeof RELIC_ERAS)[number];

const ERA_SET = new Set<string>(RELIC_ERAS);

/**
 * Relic identity as it arrives from the backend. Every relic surface has at least one of these:
 * `tier` on owned relics, `name` ("Lith K1 Relic") on the scanner's rows, `slug` on catalog items.
 */
export type RelicIdentity = {
  slug?: string | null;
  name?: string | null;
  tier?: string | null;
};

/**
 * The era, or `null` when this isn't a relic.
 *
 * `tier` is checked first and `slug` before `name`, cheapest and most reliable first: a tier is
 * already the answer, a slug is language-independent, and a name may be localized. In practice the
 * era words are proper nouns that survive translation, but relying on that would be luck.
 */
export function relicEraKey(identity: RelicIdentity): RelicEra | null {
  const tier = identity.tier?.trim().toLowerCase();
  if (tier && ERA_SET.has(tier)) {
    return tier as RelicEra;
  }

  // `lith_k1_relic`, and defensively `lith-k1-relic`.
  const slug = identity.slug?.trim().toLowerCase();
  if (slug) {
    const head = slug.split(/[_-]/)[0];
    if (ERA_SET.has(head) && /(^|[_-])relic($|[_-])/.test(slug)) {
      return head as RelicEra;
    }
  }

  // "Lith K1 Relic" / "Lith K1 Radiant" — the shape every relic name the app handles takes.
  const name = identity.name?.trim().toLowerCase();
  if (name) {
    const [head, code] = name.split(/\s+/);
    // A code is required: "Lith" alone is not a relic, and this keeps an item that merely starts
    // with an era word from picking up relic art.
    if (head && code && ERA_SET.has(head)) {
      return head as RelicEra;
    }
  }

  return null;
}
