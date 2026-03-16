import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { isTauriRuntime } from './tauriClient';

export interface AppUpdateSummary {
  currentVersion: string;
  version: string;
  notes: string | null;
  publishedAt: string | null;
}

let pendingUpdate: Update | null = null;

async function closePendingUpdateResource(): Promise<void> {
  if (!pendingUpdate) {
    return;
  }

  try {
    await pendingUpdate.close();
  } catch (error) {
    console.warn('[updater] failed to close pending update resource', error);
  } finally {
    pendingUpdate = null;
  }
}

export function isAppUpdaterSupported(): boolean {
  return isTauriRuntime() && !import.meta.env.DEV;
}

export async function checkForAppUpdate(): Promise<AppUpdateSummary | null> {
  if (!isAppUpdaterSupported()) {
    return null;
  }

  await closePendingUpdateResource();

  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) {
    return null;
  }

  pendingUpdate = update;
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    notes: update.body ?? null,
    publishedAt: update.date ?? null,
  };
}

export async function installPendingAppUpdate(
  onEvent?: (event: DownloadEvent) => void,
): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('No downloaded update is available to install.');
  }

  await pendingUpdate.downloadAndInstall(onEvent);
}

export async function clearPendingAppUpdate(): Promise<void> {
  await closePendingUpdateResource();
}
