import {
  getWorldStateCache,
  isTauriRuntime,
  saveWorldStateCacheEntry,
} from './tauriClient';
import type { PersistedWorldStateCacheEntry, WorldStateEndpointKey } from '../types';

const WORLDSTATE_CACHE_STORAGE_KEY = 'warstonks.worldstate.cache';
let worldStateCacheMap: Record<string, PersistedWorldStateCacheEntry> | null = null;
let worldStateCacheLoadPromise: Promise<Record<string, PersistedWorldStateCacheEntry>> | null = null;

function parseBrowserCache(): Record<string, PersistedWorldStateCacheEntry> {
  try {
    const raw = window.localStorage.getItem(WORLDSTATE_CACHE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, PersistedWorldStateCacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function saveBrowserCache(cache: Record<string, PersistedWorldStateCacheEntry>) {
  window.localStorage.setItem(WORLDSTATE_CACHE_STORAGE_KEY, JSON.stringify(cache));
}

async function loadWorldStateCacheMap(): Promise<Record<string, PersistedWorldStateCacheEntry>> {
  if (worldStateCacheMap) {
    return worldStateCacheMap;
  }

  if (!worldStateCacheLoadPromise) {
    worldStateCacheLoadPromise = (async () => {
      const nextCache = isTauriRuntime() ? await getWorldStateCache() : parseBrowserCache();
      worldStateCacheMap = nextCache;
      return nextCache;
    })().finally(() => {
      worldStateCacheLoadPromise = null;
    });
  }

  return worldStateCacheLoadPromise;
}

export async function readWorldStateCacheEntry(
  endpoint: WorldStateEndpointKey,
): Promise<PersistedWorldStateCacheEntry | null> {
  const cache = await loadWorldStateCacheMap();
  return cache[endpoint] ?? null;
}

export async function persistWorldStateCacheEntry(
  endpoint: WorldStateEndpointKey,
  entry: PersistedWorldStateCacheEntry,
): Promise<void> {
  const cache = { ...(worldStateCacheMap ?? (await loadWorldStateCacheMap())) };
  cache[endpoint] = entry;
  worldStateCacheMap = cache;

  if (isTauriRuntime()) {
    await saveWorldStateCacheEntry(endpoint, entry);
    return;
  }

  saveBrowserCache(cache);
}
