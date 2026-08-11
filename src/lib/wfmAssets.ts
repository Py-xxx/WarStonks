import { partIcons } from '../assets/partImages';

const WFM_ASSET_BASE_URL = 'https://warframe.market/static/assets/';

/**
 * Marks an image as one of our own bundled part icons rather than a Warframe.Market path.
 *
 * The catalog stamps this onto a component's `preferred_image` (see `part_images.rs`), because
 * WFM serves every component of a set the parent item's art — a Neuroptics, a Chassis and a
 * Systems all arrive as the same warframe picture. Resolving it here rather than at the call
 * sites means every surface that already renders an item icon picks the override up for free.
 */
const PART_IMAGE_SENTINEL = 'warstonks:part/';

export function resolveWfmAssetUrl(assetPath: string | null | undefined): string | null {
  const trimmedAssetPath = assetPath?.trim();
  if (!trimmedAssetPath) {
    return null;
  }

  if (trimmedAssetPath.startsWith(PART_IMAGE_SENTINEL)) {
    // An unknown key means the catalog and the shipped art have drifted. Fall back to null
    // rather than a broken URL, so the caller's own placeholder shows instead.
    return partIcons[trimmedAssetPath.slice(PART_IMAGE_SENTINEL.length)] ?? null;
  }

  if (/^https?:\/\//i.test(trimmedAssetPath)) {
    return trimmedAssetPath;
  }

  return `${WFM_ASSET_BASE_URL}${trimmedAssetPath.replace(/^\/+/, '')}`;
}
