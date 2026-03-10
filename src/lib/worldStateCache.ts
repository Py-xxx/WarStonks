import {
  getWorldStateCache,
  isTauriRuntime,
  saveWorldStateCacheEntry,
} from './tauriClient';
import type { PersistedWorldStateCacheEntry, WorldStateEndpointKey } from '../types';

const WORLDSTATE_CACHE_STORAGE_KEY = 'warstonks.worldstate.cache';

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

export async function readWorldStateCacheEntry(
  endpoint: WorldStateEndpointKey,
): Promise<PersistedWorldStateCacheEntry | null> {
  if (isTauriRuntime()) {
    const cache = await getWorldStateCache();
    return cache[endpoint] ?? null;
  }

  return parseBrowserCache()[endpoint] ?? null;
}

export async function persistWorldStateCacheEntry(
  endpoint: WorldStateEndpointKey,
  entry: PersistedWorldStateCacheEntry,
): Promise<void> {
  if (isTauriRuntime()) {
    await saveWorldStateCacheEntry(endpoint, entry);
    return;
  }

  const cache = parseBrowserCache();
  cache[endpoint] = entry;
  saveBrowserCache(cache);
}
