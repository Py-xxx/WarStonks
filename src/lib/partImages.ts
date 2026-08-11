/**
 * Which component icon an item's **slug** maps to.
 *
 * Deliberately holds no asset imports, so the rule can be unit-tested on its own — the icon
 * files are wired up in `wfmAssets.ts`, and a bundler is needed to load them.
 *
 * Warframe.Market serves every component of a set the parent item's art, so a Neuroptics, a
 * Chassis and a Systems all arrive as the same warframe picture. These replace that.
 *
 * Two things make the slug the right key:
 *
 * * **It is language-independent.** Display names are localized; `grendel_prime_neuroptics` is
 *   not. Keying on the name would silently stop working the moment the user switches language.
 * * **Every payload already carries it.** Icons come from a dozen different backend tables —
 *   the watchlist, the scanner cache, owned components, the planner — and most never resolve
 *   through the item catalog. Anything keyed on where the *image path* came from is therefore
 *   inconsistent by construction, which is exactly the bug this replaced: icons appearing on
 *   some surfaces and not others. The slug is the one identifier all of them share.
 */

/** Parts we ship art for, and whether a Prime variant exists. */
const PARTS: ReadonlyArray<readonly [string, boolean]> = [
  ['avionics', false],
  ['band', true],
  ['barrel', true],
  ['blade', true],
  ['buckle', true],
  ['carapace', true],
  ['cerebrum', true],
  ['chassis', true],
  ['collar', true],
  ['disk', true],
  ['engines', false],
  ['fuselage', false],
  ['gauntlet', true],
  ['grip', false],
  ['guard', true],
  ['handle', true],
  ['harness', true],
  ['head', true],
  ['hilt', true],
  ['hook', false],
  ['link', true],
  ['lower_limb', true],
  ['neuroptics', true],
  ['ornament', true],
  ['pouch', true],
  ['receiver', true],
  ['stars', true],
  ['stock', true],
  ['string', true],
  ['systems', true],
  ['upper_limb', true],
  ['wings', true],
];

const PART_LOOKUP = new Map<string, boolean>(PARTS.map(([part, hasPrime]) => [part, hasPrime]));

/** Exposed for the test that keeps this list and the shipped art in step. */
export const KNOWN_PARTS = PARTS;

/**
 * Slugs that must keep Warframe.Market's own art, whatever their name ends in.
 *
 * A slug cannot distinguish "Conductive Blade" — a mod — from "Boltor Barrel", a component:
 * both end in a part word, so the rule below happily replaced the mod's card art with a sword
 * blade. Only the catalog knows the difference, and it does: WFM tags them, and mods and
 * arcanes already have distinct art of their own.
 *
 * Held as a module-level set rather than threaded through every call site, because
 * `resolveWfmAssetUrl` is synchronous and called from three dozen render paths.
 */
const neverOverride = new Set<string>();

/**
 * Registers the catalog's mods and arcanes. Only the ones that would actually collide are
 * kept — of ~1,500 mods a handful end in a part word, and there is no reason to hold the rest.
 *
 * Until this runs nothing is excluded, so a mod named like a part shows the part icon for the
 * moment between startup and the catalog answering. That is the pre-existing behaviour, not a
 * regression, and it self-corrects on the next render.
 */
export function registerNeverOverrideSlugs(slugs: readonly string[]): void {
  for (const slug of slugs) {
    if (matchPartKey(slug) !== null) {
      neverOverride.add(slug.trim().toLowerCase());
    }
  }
}

/**
 * The art key for a component slug, or `null` when the slug is not a component.
 *
 * Matching is anchored to the **end** of the slug, after an optional trailing `_blueprint`.
 * That is what stops it firing on things that merely contain a part word: `ash_prime_systems`
 * is a component, `ash_prime_set` and `ash_prime_blueprint` are not, and neither is a weapon
 * whose whole name is a part word.
 */
export function partKeyForSlug(slug: string | null | undefined): string | null {
  const trimmed = slug?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (neverOverride.has(trimmed)) {
    return null;
  }
  return matchPartKey(trimmed);
}

/** The naming rule on its own, with no regard for what kind of item the slug belongs to. */
function matchPartKey(slug: string): string | null {
  const trimmed = slug.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  let tokens = trimmed.split('_').filter(Boolean);
  if (tokens[tokens.length - 1] === 'blueprint') {
    tokens = tokens.slice(0, -1);
  }
  // A bare part word is a weapon in its own right, never a component of a set.
  if (tokens.length < 2) {
    return null;
  }

  // Two-token parts first, so `upper_limb` isn't read as a stray `limb`. They need a word in
  // front of them to be a component at all.
  let part: string | null = null;
  if (tokens.length >= 3) {
    const candidate = tokens.slice(-2).join('_');
    if (PART_LOOKUP.has(candidate)) {
      part = candidate;
    }
  }
  if (part === null) {
    const candidate = tokens[tokens.length - 1];
    if (PART_LOOKUP.has(candidate)) {
      part = candidate;
    }
  }
  if (part === null) {
    return null;
  }

  // Prime art only exists for some parts; fall back to the plain icon rather than pointing at
  // a file that isn't there.
  const wantsPrime = tokens.includes('prime') && PART_LOOKUP.get(part) === true;

  return wantsPrime ? `${part}_prime` : part;
}
