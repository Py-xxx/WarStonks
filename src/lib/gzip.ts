// Shared browser-side gzip helpers (feature-detected; falls back to plain text when the
// Compression Streams API isn't available). Used by both the `.wslang` language-pack file flow
// (small files, still handled entirely in the browser) and previously by the `.baddie` export
// flow — that one has since moved to writing/reading files directly from Rust (see
// data_transfer.rs's module doc comment for why), so this module is now language-pack-only, but
// stays generic in case another small-file browser download is added later.

import { tActive } from '../i18n';

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
    throw new Error(tActive('dt.cantDecompress'));
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
