import { useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { resolveLocalizedName } from '../lib/itemNames';
import type { ItemQuickViewTarget } from '../types';

/**
 * Returns a resolver that localizes an item's display name from the store's name map
 * (keyed by wfmId/slug), falling back to the passed English name. Use for raw name renders
 * that don't go through the <ItemName> component.
 */
export function useLocalizedName(): (
  target: Pick<ItemQuickViewTarget, 'wfmId' | 'slug' | 'name'>,
) => string {
  const map = useAppStore((s) => s.itemNameMap);
  return useCallback((target) => resolveLocalizedName(map, target), [map]);
}
