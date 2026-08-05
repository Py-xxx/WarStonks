import { tActive } from '../i18n';
import {
  exportMarketData,
  exportUserData,
  importMarketData,
  importUserData,
  isTauriRuntime,
  peekBaddieFile,
  type TransferSummary,
} from './tauriClient';

export type BaddieKind = 'user' | 'market';

// localStorage keys that belong to the user-data export (watchlist, recents, accepted
// opportunities, notification settings). The worldstate cache is excluded — it's live data.
const USER_LOCAL_STORAGE_KEYS = [
  'warstonks.watchlist.v1',
  'warstonks.recentItems.v1',
  'warstonks.pinnedOpportunities',
  'warstonks.notificationSettings',
];

export type ProgressFn = (label: string) => void;

function collectUserLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === 'undefined' || !window.localStorage) {
    return out;
  }
  for (const key of USER_LOCAL_STORAGE_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

function timestampSlug(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- exports ----------
//
// Export writes straight to a file the user picks via a native save dialog — the Rust side
// streams every row directly to a gzip writer on disk (see data_transfer.rs's module doc
// comment). Nothing here holds the payload in memory or passes it through `invoke()`'s return
// value; only the small `TransferSummary` (row counts, not row data) comes back.

async function pickSaveTarget(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new Error(tActive('dt.desktopOnly'));
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: 'WarStonks export', extensions: ['baddie'] }],
  });
  return path;
}

async function pickOpenTarget(): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new Error(tActive('dt.desktopOnly'));
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({
    multiple: false,
    filters: [{ name: 'WarStonks export', extensions: ['baddie'] }],
  });
  return typeof path === 'string' ? path : null;
}

/** Returns the summary on success, or `null` if the user cancelled the save dialog. */
export async function exportUserDataFile(onProgress?: ProgressFn): Promise<TransferSummary | null> {
  onProgress?.(tActive('dt.choosingLocation'));
  const path = await pickSaveTarget(`warstonks-data-${timestampSlug()}.baddie`);
  if (!path) {
    return null;
  }
  onProgress?.(tActive('dt.exportingApp'));
  return exportUserData(path, collectUserLocalStorage());
}

/** Returns the summary on success, or `null` if the user cancelled the save dialog. */
export async function exportMarketDataFile(onProgress?: ProgressFn): Promise<TransferSummary | null> {
  onProgress?.(tActive('dt.choosingLocation'));
  const path = await pickSaveTarget(`warstonks-market-${timestampSlug()}.baddie`);
  if (!path) {
    return null;
  }
  onProgress?.(tActive('dt.exportingMarket'));
  return exportMarketData(path);
}

// ---------- imports ----------

export interface PendingImport {
  kind: BaddieKind;
  path: string;
  exportedAt: string | null;
  appVersion: string | null;
}

/** Opens the file picker, then reads just the file's header (kind/version/exported-at — never
 * the payload) so the UI can show a confirmation ("this will replace your user/market data,
 * exported <date>") before running the real, destructive import. Returns `null` if the user
 * cancelled the picker. */
export async function pickImportFile(): Promise<PendingImport | null> {
  const path = await pickOpenTarget();
  if (!path) {
    return null;
  }
  const header = await peekBaddieFile(path);
  if (header.kind !== 'user' && header.kind !== 'market') {
    throw new Error(tActive('dt.notBaddie'));
  }
  return { kind: header.kind, path, exportedAt: header.exportedAt, appVersion: header.appVersion };
}

/** Applies a picked import with REPLACE semantics. Returns a row-count summary so the UI can
 * confirm it actually restored what the user expected. */
export async function applyPendingImport(
  pending: PendingImport,
  onProgress?: ProgressFn,
): Promise<TransferSummary> {
  if (pending.kind === 'user') {
    onProgress?.(tActive('dt.restoreApp'));
    const result = await importUserData(pending.path);
    onProgress?.(tActive('dt.restoreLocal'));
    if (typeof window !== 'undefined' && window.localStorage) {
      for (const [key, value] of Object.entries(result.localStorage)) {
        if (USER_LOCAL_STORAGE_KEYS.includes(key)) {
          window.localStorage.setItem(key, value);
        }
      }
    }
    return result.summary;
  }
  onProgress?.(tActive('dt.restoreMarket'));
  return importMarketData(pending.path);
}
