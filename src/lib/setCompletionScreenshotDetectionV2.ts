// V2 screenshot detector for the Set Completion inventory importer.
//
// Goals over the original detector: theme-independent and grid-size-independent.
// Instead of colour-keying to one UI theme and assuming a fixed 7x3 layout, it:
//   1. Builds a "glyph mask" of thin bright strokes — Warframe item names and
//      quantity numbers are light text on every theme, while icon highlights are
//      broad blobs, so a thin-run brightness filter isolates text on any theme.
//   2. Recovers the tile pitch (cell size) via autocorrelation of an edge-energy
//      projection, then locates the tile region from the periodic name bands.
//      This works for any column/row count (cropped grids, ultrawide, etc.).
//   3. Emits per-tile name + quantity crops (raw + binarised) in the exact shape
//      `scanAndMatchSetCompletionDetectionPreview` already consumes, so the OCR +
//      catalog fuzzy-matching backend is reused unchanged.
//
// The detector intentionally over-includes ambiguous tiles (empty tiles are
// dropped) and leans on the downstream closed-catalog fuzzy matcher for name
// reliability — that is what makes a names-only pipeline trustworthy.

import type {
  SetCompletionDetectionBox,
  SetCompletionDetectionCell,
  SetCompletionImportCrop,
  SetCompletionScreenshotDetectionPreview,
  SetCompletionScreenshotProgress,
} from './setCompletionScreenshotImport';

// Upscale factor applied to OCR crops — Tesseract is far more reliable on larger
// glyphs than on native-resolution game text.
const OCR_UPSCALE = 3;
// Quantity badge lives in the top-left corner of the tile (fractions of a tile).
const QTY_BOX = { x: 0.02, y: 0.03, w: 0.32, h: 0.24 };
// A tile is considered occupied if its name band has at least this glyph density.
const MIN_NAME_DENSITY = 0.004;

interface Gray {
  width: number;
  height: number;
  Y: Float32Array;
}

export async function detectSetCompletionGridV2(
  file: File,
  crop: SetCompletionImportCrop,
  onProgress?: (progress: SetCompletionScreenshotProgress) => void,
): Promise<SetCompletionScreenshotDetectionPreview> {
  onProgress?.({ progress: 0.02, stage: 'prepare', detail: 'Loading screenshot…' });
  const image = await loadImage(file);

  const full = drawToCanvas(image, image.naturalWidth, image.naturalHeight);
  const cropped = applyCrop(full, crop);
  const w = cropped.width;
  const h = cropped.height;

  onProgress?.({ progress: 0.15, stage: 'detect', detail: 'Analysing text regions…' });
  const ctx = cropped.getContext('2d');
  if (!ctx) throw new Error('Could not read screenshot pixels.');
  const imageData = ctx.getImageData(0, 0, w, h);
  const gray = toGray(imageData, w, h);

  const mask = glyphMask(gray, Math.max(4, Math.round(w / 6 / 10)));
  const energy = edgeEnergy(gray);

  onProgress?.({ progress: 0.35, stage: 'detect', detail: 'Detecting grid pitch…' });
  const colEnergy = smooth(projectColumns(energy, w, h), 3);
  const rowEnergy = smooth(projectRows(energy, w, h), 3);
  const colPitch = fundamentalPitch(colEnergy, Math.round(w * 0.05), Math.round(w * 0.32));
  const rowPitch = fundamentalPitch(rowEnergy, Math.round(h * 0.08), Math.round(h * 0.55));

  // Locate the tile region from the periodic name bands so UI chrome (header,
  // search bar, side panels) outside the grid is excluded automatically.
  // Anchor the grid on the actual text rather than a uniform offset: the name
  // bands (rows of light text) and tile centres (columns of centred names) are
  // located directly, so boxes lock onto the names regardless of where the grid
  // begins or how much chrome surrounds it.
  const rowGlyph = smooth(projectRows(mask, w, h), 2);
  const colGlyph = smooth(projectColumns(mask, w, h), Math.round(colPitch * 0.22));
  const rowBands = anchorPeaks(rowGlyph, rowPitch); // y of each name-text band
  const colCenters = anchorPeaks(colGlyph, colPitch); // x of each tile centre

  const tileW = colPitch;
  const nameBandH = Math.round(rowPitch * 0.34);

  const nameBoxAt = (cx: number, by: number): SetCompletionDetectionBox => ({
    x: Math.round(cx - tileW * 0.45),
    y: Math.round(by - nameBandH * 0.5),
    width: Math.round(tileW * 0.9),
    height: nameBandH,
  });
  const isOccupied = (cx: number, by: number): boolean =>
    boxDensity(mask, w, h, nameBoxAt(cx, by)) >= MIN_NAME_DENSITY;

  // Keep only rows where a meaningful fraction of columns hold a name — this
  // rejects toolbars / header labels that aren't inventory rows.
  const minOccupied = Math.max(2, colCenters.length * 0.34);
  const validRows = rowBands.filter((by) => {
    let occupied = 0;
    for (const cx of colCenters) if (isOccupied(cx, by)) occupied += 1;
    return occupied >= minOccupied;
  });

  const cols = colCenters.length;
  const rows = validRows.length;

  onProgress?.({
    progress: 0.5,
    stage: 'detect',
    detail: `Detected ${cols}×${rows} grid. Extracting tiles…`,
  });

  const cells: SetCompletionDetectionCell[] = [];
  const preview = cloneCanvas(cropped);
  const pctx = preview.getContext('2d');
  if (!pctx) throw new Error('Could not prepare preview canvas.');
  pctx.lineWidth = Math.max(1, Math.round(tileW / 80));

  for (let r = 0; r < validRows.length; r += 1) {
    const by = validRows[r];
    const tileTop = Math.round(by - rowPitch * 0.86); // name sits near tile bottom
    for (let c = 0; c < colCenters.length; c += 1) {
      const cx = colCenters[c];
      const nameBox = nameBoxAt(cx, by);
      if (boxDensity(mask, w, h, nameBox) < MIN_NAME_DENSITY) {
        continue;
      }

      const itemBox: SetCompletionDetectionBox = {
        x: Math.round(cx - tileW * 0.5),
        y: tileTop,
        width: Math.round(tileW),
        height: Math.round(rowPitch),
      };
      const quantityBox: SetCompletionDetectionBox = {
        x: Math.round(cx - tileW * 0.46),
        y: tileTop + Math.round(rowPitch * QTY_BOX.y),
        width: Math.round(tileW * QTY_BOX.w),
        height: Math.round(rowPitch * QTY_BOX.h),
      };

      cells.push({
        rowId: `r${r}c${c}`,
        tileIndex: r * colCenters.length + c,
        itemBox,
        nameBox,
        quantityBox,
        ocrCrops: {
          originalCellDataUrl: cropToDataUrl(cropped, itemBox),
          originalTextDataUrl: cropToDataUrl(cropped, nameBox),
          processedTextDataUrl: binarizedCropDataUrl(gray, nameBox),
          originalQuantityDataUrl: cropToDataUrl(cropped, quantityBox),
          processedQuantityDataUrl: binarizedCropDataUrl(gray, quantityBox),
        },
      });

      pctx.strokeStyle = 'rgba(61,214,140,0.9)';
      pctx.strokeRect(itemBox.x, itemBox.y, itemBox.width, itemBox.height);
      pctx.strokeStyle = 'rgba(74,158,255,0.95)';
      pctx.strokeRect(nameBox.x, nameBox.y, nameBox.width, nameBox.height);
      pctx.strokeStyle = 'rgba(240,160,48,0.95)';
      pctx.strokeRect(quantityBox.x, quantityBox.y, quantityBox.width, quantityBox.height);
    }
  }

  onProgress?.({
    progress: 1,
    stage: 'complete',
    detail: `Detected ${cells.length} item tiles in a ${cols}×${rows} grid.`,
  });

  return {
    annotatedPreviewDataUrl: preview.toDataURL('image/png'),
    sourceWidth: w,
    sourceHeight: h,
    overlayWidth: w,
    overlayHeight: h,
    detectedItemCount: cells.length,
    quantityCount: cells.filter((cell) => cell.quantityBox !== null).length,
    nameCount: cells.filter((cell) => cell.nameBox !== null).length,
    cells,
  };
}

// ---------- image plumbing ----------

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode the screenshot image.'));
    };
    img.src = url;
  });
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function drawToCanvas(image: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare screenshot canvas.');
  ctx.drawImage(image, 0, 0, w, h);
  return canvas;
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = makeCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not clone canvas.');
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function applyCrop(source: HTMLCanvasElement, crop: SetCompletionImportCrop): HTMLCanvasElement {
  const x = Math.round(source.width * crop.left);
  const y = Math.round(source.height * crop.top);
  const width = Math.max(1, Math.round(source.width * (1 - crop.left - crop.right)));
  const height = Math.max(1, Math.round(source.height * (1 - crop.top - crop.bottom)));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not crop screenshot.');
  ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
  return canvas;
}

function toGray(imageData: ImageData, w: number, h: number): Gray {
  const { data } = imageData;
  const Y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    Y[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return { width: w, height: h, Y };
}

// ---------- signal extraction ----------

// Thin bright runs = text strokes. Broad bright runs (icon highlights) are rejected.
function glyphMask(gray: Gray, maxRun: number): Uint8Array {
  const { width: w, height: h, Y } = gray;
  const mask = new Uint8Array(w * h);
  const T = 170;
  for (let y = 0; y < h; y += 1) {
    let x = 0;
    while (x < w) {
      if (Y[y * w + x] < T) {
        x += 1;
        continue;
      }
      let x2 = x;
      while (x2 < w && Y[y * w + x2] >= T) x2 += 1;
      if (x2 - x <= maxRun) {
        for (let k = x; k < x2; k += 1) mask[y * w + k] = 1;
      }
      x = x2;
    }
  }
  return mask;
}

function edgeEnergy(gray: Gray): Float32Array {
  const { width: w, height: h, Y } = gray;
  const E = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const gx = Y[y * w + x + 1] - Y[y * w + x - 1];
      const gy = Y[(y + 1) * w + x] - Y[(y - 1) * w + x];
      E[y * w + x] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return E;
}

function projectColumns(src: Float32Array | Uint8Array, w: number, h: number): Float32Array {
  const p = new Float32Array(w);
  for (let x = 0; x < w; x += 1) {
    let s = 0;
    for (let y = 0; y < h; y += 1) s += src[y * w + x];
    p[x] = s;
  }
  return p;
}

function projectRows(src: Float32Array | Uint8Array, w: number, h: number): Float32Array {
  const p = new Float32Array(h);
  for (let y = 0; y < h; y += 1) {
    let s = 0;
    for (let x = 0; x < w; x += 1) s += src[y * w + x];
    p[y] = s;
  }
  return p;
}

function smooth(prof: Float32Array, radius: number): Float32Array {
  const n = prof.length;
  const out = new Float32Array(n);
  const r = Math.max(0, Math.round(radius));
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    let c = 0;
    for (let k = -r; k <= r; k += 1) {
      const j = i + k;
      if (j >= 0 && j < n) {
        s += prof[j];
        c += 1;
      }
    }
    out[i] = s / c;
  }
  return out;
}

// Autocorrelation; pick the fundamental period (smallest strong peak that has a
// harmonic at 2x/3x/4x), avoiding the doubled-period traps autocorrelation hits.
function fundamentalPitch(prof: Float32Array, minP: number, maxP: number): number {
  const n = prof.length;
  const lo = Math.max(2, minP);
  const hi = Math.min(n - 2, maxP);
  const mean = prof.reduce((a, b) => a + b, 0) / n;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i += 1) c[i] = prof[i] - mean;
  const ac: { p: number; s: number }[] = [];
  for (let p = lo; p <= hi; p += 1) {
    let s = 0;
    for (let i = 0; i + p < n; i += 1) s += c[i] * c[i + p];
    ac.push({ p, s: s / (n - p) });
  }
  if (!ac.length) return Math.round((lo + hi) / 2);
  const maxS = Math.max(...ac.map((a) => a.s));
  const peaks = ac.filter(
    (a, i) =>
      i > 0 &&
      i < ac.length - 1 &&
      a.s > ac[i - 1].s &&
      a.s >= ac[i + 1].s &&
      a.s > 0.45 * maxS,
  );
  peaks.sort((a, b) => a.p - b.p);
  for (const cand of peaks) {
    for (const other of peaks) {
      for (let m = 2; m <= 4; m += 1) {
        if (Math.abs(other.p - cand.p * m) < cand.p * 0.12 && other.s > 0.3 * maxS) {
          return cand.p;
        }
      }
    }
  }
  return ac.reduce((best, a) => (a.s > best.s ? a : best)).p;
}

// Generate evenly-spaced anchor positions locked onto the actual peaks of a
// profile. Seeds on the strongest peak, then walks outward by `pitch`, re-locking
// to the nearest local maximum each step so the anchors track real text bands /
// tile centres (handling missing or faint tiles) instead of a rigid offset.
function anchorPeaks(prof: Float32Array, pitch: number): number[] {
  const n = prof.length;
  let max = 0;
  for (let i = 0; i < n; i += 1) if (prof[i] > max) max = prof[i];
  const thr = max * 0.2;
  const win = Math.max(1, Math.round(pitch * 0.35));
  let seed = 0;
  for (let i = 1; i < n; i += 1) if (prof[i] > prof[seed]) seed = i;

  const refine = (guess: number): { i: number; v: number } => {
    const lo = Math.max(0, Math.round(guess - win));
    const hi = Math.min(n - 1, Math.round(guess + win));
    let bi = lo;
    let bv = -1;
    for (let x = lo; x <= hi; x += 1) if (prof[x] > bv) { bv = prof[x]; bi = x; }
    return { i: bi, v: bv };
  };

  const out = [seed];
  for (let g = seed - pitch; g > -win; ) {
    const r = refine(g);
    if (r.v > thr) { out.push(r.i); g = r.i - pitch; } else { g -= pitch; }
  }
  for (let g = seed + pitch; g < n + win; ) {
    const r = refine(g);
    if (r.v > thr) { out.push(r.i); g = r.i + pitch; } else { g += pitch; }
  }

  out.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const v of out) {
    const last = deduped[deduped.length - 1];
    if (deduped.length && v - last < pitch * 0.5) {
      if (prof[v] > prof[last]) deduped[deduped.length - 1] = v;
      continue;
    }
    deduped.push(v);
  }
  return deduped;
}

function boxDensity(mask: Uint8Array, w: number, h: number, box: SetCompletionDetectionBox): number {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(w, box.x + box.width);
  const y1 = Math.min(h, box.y + box.height);
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) count += mask[y * w + x];
  }
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  return count / area;
}

// ---------- crop generation ----------

function clampBox(box: SetCompletionDetectionBox, w: number, h: number): SetCompletionDetectionBox {
  const x = Math.max(0, Math.min(box.x, w - 1));
  const y = Math.max(0, Math.min(box.y, h - 1));
  const right = Math.max(x + 1, Math.min(box.x + box.width, w));
  const bottom = Math.max(y + 1, Math.min(box.y + box.height, h));
  return { x, y, width: right - x, height: bottom - y };
}

function cropToDataUrl(source: HTMLCanvasElement, box: SetCompletionDetectionBox): string {
  const b = clampBox(box, source.width, source.height);
  const canvas = makeCanvas(b.width, b.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not crop tile region.');
  ctx.drawImage(source, b.x, b.y, b.width, b.height, 0, 0, b.width, b.height);
  return canvas.toDataURL('image/png');
}

// Binarised, upscaled crop for OCR: Otsu threshold on the region's luminance,
// rendered as dark glyphs on a white background (Tesseract's preferred input).
function binarizedCropDataUrl(gray: Gray, box: SetCompletionDetectionBox): string {
  const b = clampBox(box, gray.width, gray.height);
  const region = new Float32Array(b.width * b.height);
  let min = 255;
  let max = 0;
  for (let y = 0; y < b.height; y += 1) {
    for (let x = 0; x < b.width; x += 1) {
      const v = gray.Y[(b.y + y) * gray.width + (b.x + x)];
      region[y * b.width + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const threshold = otsu(region, min, max);
  const scale = OCR_UPSCALE;
  const canvas = makeCanvas(b.width * scale, b.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not build OCR crop.');
  const out = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < canvas.width; x += 1) {
      const sx = Math.floor(x / scale);
      // text is bright -> foreground when above threshold -> render black
      const fg = region[sy * b.width + sx] >= threshold;
      const px = fg ? 0 : 255;
      const di = (y * canvas.width + x) * 4;
      out.data[di] = px;
      out.data[di + 1] = px;
      out.data[di + 2] = px;
      out.data[di + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
}

function otsu(region: Float32Array, min: number, max: number): number {
  const bins = 64;
  const range = Math.max(1, max - min);
  const hist = new Float32Array(bins);
  for (let i = 0; i < region.length; i += 1) {
    const b = Math.min(bins - 1, Math.floor(((region[i] - min) / range) * bins));
    hist[b] += 1;
  }
  const total = region.length;
  let sum = 0;
  for (let i = 0; i < bins; i += 1) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let i = 0; i < bins; i += 1) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  return min + (best / bins) * range;
}
