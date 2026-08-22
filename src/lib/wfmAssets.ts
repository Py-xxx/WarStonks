import { partIcons } from '../assets/partImages';
import { relicIcons } from '../assets/relicImages';
import { partKeyForSlug } from './partImages';
import { relicEraKey, type RelicIdentity } from './relicImages';

const WFM_ASSET_BASE_URL = 'https://warframe.market/static/assets/';

/**
 * Resolves an item's icon URL.
 *
 * Pass `slug` wherever the surface is rendering a specific item. Components of a set all share
 * the parent item's art on Warframe.Market — a Neuroptics and a Systems come back as the same
 * warframe picture — so a slug that names a part resolves to our own bundled icon instead.
 * Resolving it here, from the slug, is what makes every surface agree: icons arrive from a
 * dozen different backend tables, so anything keyed on the image path is inconsistent by
 * construction.
 *
 * Omit `slug` deliberately where the parent art is the right picture — an opportunity to
 * complete a set is about the set, not the part.
 *
 * `name` exists for **relics**, which WFM gives per-item art: four near-identical pictures per
 * relic, and a different picture for the same relic depending on which backend table the path came
 * from. Era is a relic's whole visual identity, so our own era art replaces WFM's everywhere —
 * pass whatever identity the surface has (`name`, or a `tier` via `resolveRelicAssetUrl`).
 */
export function resolveWfmAssetUrl(
  assetPath: string | null | undefined,
  slug?: string | null,
  name?: string | null,
): string | null {
  // Relics first: a relic is never a set component, and its era art outranks anything WFM sends.
  const relicIcon = resolveRelicAssetUrl({ slug, name });
  if (relicIcon) {
    return relicIcon;
  }

  const partKey = partKeyForSlug(slug);
  // A key with no art behind it means the parts list and the shipped files have drifted
  // (`partImages.test.ts` guards that); fall through to WFM's art rather than render nothing.
  if (partKey && partIcons[partKey]) {
    return partIcons[partKey];
  }

  const trimmedAssetPath = assetPath?.trim();
  if (!trimmedAssetPath) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmedAssetPath)) {
    return trimmedAssetPath;
  }

  return `${WFM_ASSET_BASE_URL}${trimmedAssetPath.replace(/^\/+/, '')}`;
}

/**
 * Relic art by era, for surfaces that hold a `tier` rather than a name — owned relics and farming
 * sessions both carry `tier`/`code` separately and never assemble the display name.
 *
 * Returns `null` for anything that isn't a relic, so it composes: callers fall through to
 * `resolveWfmAssetUrl` unchanged.
 */
export function resolveRelicAssetUrl(identity: RelicIdentity): string | null {
  const era = relicEraKey(identity);
  return era ? relicIcons[era] ?? null : null;
}
