import {
  exportMarketDataPayload,
  exportUserDataPayload,
  getAppVersion,
  importMarketDataPayload,
  importUserDataPayload,
} from './tauriClient';

export type BaddieKind = 'user' | 'market';

const FORMAT = 'warstonks-export';
const SCHEMA_VERSION = 1;

// localStorage keys that belong to the user-data export (watchlist, recents, accepted
// opportunities, notification settings). The worldstate cache is excluded — it's live data.
const USER_LOCAL_STORAGE_KEYS = [
  'warstonks.watchlist.v1',
  'warstonks.recentItems.v1',
  'warstonks.pinnedOpportunities',
  'warstonks.notificationSettings',
];

export interface BaddieBundle {
  format: string;
  kind: BaddieKind;
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  localStorage?: Record<string, string>;
  // Backend SQLite + settings payload (parsed JSON).
  payload: unknown;
}

// ---------- gzip helpers (feature-detected; falls back to plain text) ----------

export async function maybeGzip(text: string): Promise<Blob> {
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).blob();
  }
  return new Blob([text]);
}

export async function maybeGunzip(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) {
    return new TextDecoder().decode(bytes);
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This file is compressed but this app build cannot decompress it.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

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

async function buildBundle(
  kind: BaddieKind,
  payloadJson: string,
  includeLocalStorage: boolean,
): Promise<string> {
  // Build the envelope WITHOUT the (potentially huge) payload, then splice the backend's
  // already-serialized payload JSON in raw. This avoids parsing + re-stringifying a
  // hundreds-of-MB market payload, which would otherwise spike webview memory.
  const header: Omit<BaddieBundle, 'payload'> = {
    format: FORMAT,
    kind,
    schemaVersion: SCHEMA_VERSION,
    appVersion: await getAppVersion().catch(() => 'unknown'),
    exportedAt: new Date().toISOString(),
    ...(includeLocalStorage ? { localStorage: collectUserLocalStorage() } : {}),
  };
  const headerJson = JSON.stringify(header);
  // Insert `,"payload":<raw>` before the closing brace.
  return `${headerJson.slice(0, -1)},"payload":${payloadJson}}`;
}

function timestampSlug(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- exports ----------

export type ProgressFn = (label: string) => void;

export async function exportUserData(onProgress?: ProgressFn): Promise<void> {
  onProgress?.('Collecting app data…');
  const payloadJson = await exportUserDataPayload();
  onProgress?.('Packaging & compressing…');
  const bundleText = await buildBundle('user', payloadJson, true);
  const blob = await maybeGzip(bundleText);
  onProgress?.('Saving file…');
  downloadBlob(blob, `warstonks-data-${timestampSlug()}.baddie`);
}

export async function exportMarketData(onProgress?: ProgressFn): Promise<void> {
  onProgress?.('Collecting market data (this can take a moment)…');
  const payloadJson = await exportMarketDataPayload();
  onProgress?.('Packaging & compressing…');
  const bundleText = await buildBundle('market', payloadJson, false);
  const blob = await maybeGzip(bundleText);
  onProgress?.('Saving file…');
  downloadBlob(blob, `warstonks-market-${timestampSlug()}.baddie`);
}

// ---------- imports ----------

export async function readBaddieFile(file: File): Promise<BaddieBundle> {
  const text = await maybeGunzip(file);
  let bundle: BaddieBundle;
  try {
    bundle = JSON.parse(text) as BaddieBundle;
  } catch {
    throw new Error('This file isn’t a valid WarStonks export (could not be read).');
  }
  if (bundle.format !== FORMAT || (bundle.kind !== 'user' && bundle.kind !== 'market')) {
    throw new Error('This file isn’t a recognised WarStonks .baddie export.');
  }
  // Older exports import fine (restore tolerates missing columns); a newer schema may rely on
  // fields this build doesn't have, so refuse it with a clear message rather than failing mid-import.
  if (typeof bundle.schemaVersion === 'number' && bundle.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `This file was exported by a newer version of WarStonks (format v${bundle.schemaVersion}). Update the app, then import again.`,
    );
  }
  return bundle;
}

/** Applies a parsed bundle with REPLACE semantics. Returns the kind that was applied. */
export async function applyBaddieBundle(
  bundle: BaddieBundle,
  onProgress?: ProgressFn,
): Promise<BaddieKind> {
  const payloadJson = JSON.stringify(bundle.payload ?? {});
  if (bundle.kind === 'user') {
    // Restore the backend (transactional, the part that can fail) FIRST, then localStorage —
    // so a backend failure doesn't leave localStorage already overwritten against old SQLite.
    onProgress?.('Restoring app data…');
    await importUserDataPayload(payloadJson);
    onProgress?.('Restoring local data…');
    if (bundle.localStorage && typeof window !== 'undefined' && window.localStorage) {
      for (const [key, value] of Object.entries(bundle.localStorage)) {
        if (USER_LOCAL_STORAGE_KEYS.includes(key)) {
          window.localStorage.setItem(key, value);
        }
      }
    }
    return 'user';
  }
  onProgress?.('Restoring market data…');
  await importMarketDataPayload(payloadJson);
  return 'market';
}
