import { useCallback, useEffect, useState } from 'react';
import {
  getSmartManageStates,
  setSmartManageForListing,
  setSmartManageOverrides,
  isTauriRuntime,
} from '../lib/tauriClient';
import type { SmartListingOverrides } from '../types';
import { useAppStore } from '../stores/useAppStore';

function variantKeyForRank(rank: number | null): string {
  return rank === null || rank === undefined ? 'base' : `rank:${rank}`;
}

/**
 * Per-listing Smart Manage opt-in state. An explicit override wins; otherwise the listing
 * follows the global master toggle. Toggling writes the override and refreshes.
 */
export function useSmartManageStates() {
  const globalEnabled = useAppStore((s) => s.appSettings.smartManage.enabled);
  const [explicit, setExplicit] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, SmartListingOverrides>>({});

  const refresh = useCallback(() => {
    if (!isTauriRuntime()) {
      return;
    }
    void getSmartManageStates()
      .then((rows) => {
        setExplicit(
          Object.fromEntries(rows.map((row) => [`${row.wfmId}:${row.variantKey}`, row.enabled])),
        );
        setOverrides(
          Object.fromEntries(
            rows.map((row) => [
              `${row.wfmId}:${row.variantKey}`,
              {
                aggressiveness: row.aggressiveness,
                minPrice: row.minPrice,
                maxPrice: row.maxPrice,
              },
            ]),
          ),
        );
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isManaged = useCallback(
    (wfmId: string, rank: number | null): boolean => {
      const key = `${wfmId}:${variantKeyForRank(rank)}`;
      return key in explicit ? explicit[key] : globalEnabled;
    },
    [explicit, globalEnabled],
  );

  const toggle = useCallback(
    async (wfmId: string, rank: number | null) => {
      const next = !isManaged(wfmId, rank);
      // Optimistic: reflect immediately, then persist + refresh.
      setExplicit((current) => ({ ...current, [`${wfmId}:${variantKeyForRank(rank)}`]: next }));
      try {
        await setSmartManageForListing(wfmId, rank, next);
      } finally {
        refresh();
      }
    },
    [isManaged, refresh],
  );

  const overridesFor = useCallback(
    (wfmId: string, rank: number | null): SmartListingOverrides =>
      overrides[`${wfmId}:${variantKeyForRank(rank)}`] ?? {
        aggressiveness: null,
        minPrice: null,
        maxPrice: null,
      },
    [overrides],
  );

  const saveOverrides = useCallback(
    async (wfmId: string, rank: number | null, next: SmartListingOverrides) => {
      await setSmartManageOverrides(wfmId, rank, next);
      refresh();
    },
    [refresh],
  );

  return { isManaged, toggle, globalEnabled, refresh, overridesFor, saveOverrides };
}
