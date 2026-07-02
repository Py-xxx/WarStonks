/**
 * languagePack.ts — export/import of `.wslang` files (item-name translations for one language).
 * The heavy lifting (DB read/write + version guards) lives in the Rust backend; this module
 * only handles the browser-side file plumbing (gzip, download, read) and calls the commands.
 */
import { exportLanguagePack, importLanguagePack, type LanguagePackImportResult } from './tauriClient';
import { maybeGzip, maybeGunzip, downloadBlob } from './dataTransfer';

function timestampSlug(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Exports the given language's item-name pack to a `.wslang` file.
 * Rejects with a `LANGPACK_*` code (EMPTY / OFFLINE / STALE) if the backend guard blocks it.
 */
export async function exportLanguagePackFile(langCode: string): Promise<number> {
  const packJson = await exportLanguagePack(langCode);
  const blob = await maybeGzip(packJson);
  downloadBlob(blob, `warstonks-${langCode}-${timestampSlug()}.wslang`);
  try {
    return (JSON.parse(packJson) as { itemCount?: number }).itemCount ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Reads a `.wslang` file and applies it. Returns the imported language + count.
 * Throws `LANGPACK_BADFORMAT` (or a backend error) if the file isn't a valid pack.
 */
export async function importLanguagePackFile(file: File): Promise<LanguagePackImportResult> {
  const text = await maybeGunzip(file);
  // Light client-side sanity check before handing the (possibly large) payload to the backend.
  try {
    const parsed = JSON.parse(text) as { format?: string };
    if (parsed.format !== 'warstonks-language-pack') {
      throw new Error('LANGPACK_BADFORMAT');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'LANGPACK_BADFORMAT') {
      throw error;
    }
    throw new Error('LANGPACK_BADFORMAT');
  }
  return importLanguagePack(text);
}
