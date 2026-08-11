import { partIcons } from '../assets/partImages';
import { partKeyForSlug } from './partImages';

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
 */
export function resolveWfmAssetUrl(
  assetPath: string | null | undefined,
  slug?: string | null,
): string | null {
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
