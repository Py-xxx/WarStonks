const WFM_ASSET_BASE_URL = 'https://warframe.market/static/assets/';

export function resolveWfmAssetUrl(assetPath: string | null | undefined): string | null {
  const trimmedAssetPath = assetPath?.trim();
  if (!trimmedAssetPath) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmedAssetPath)) {
    return trimmedAssetPath;
  }

  return `${WFM_ASSET_BASE_URL}${trimmedAssetPath.replace(/^\/+/, '')}`;
}
