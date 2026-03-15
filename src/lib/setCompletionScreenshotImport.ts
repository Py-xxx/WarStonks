import type { SetCompletionScreenshotOcrVariant } from '../types';

export interface SetCompletionImportCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SetCompletionScreenshotOcrRow {
  rowId: string;
  tileIndex: number;
  thumbnailDataUrl: string;
  detectedName: string;
  nameConfidence: number;
  ocrVariants: SetCompletionScreenshotOcrVariant[];
  quantity: number | null;
  quantityConfidence: number;
  quantityState: 'detected' | 'defaulted' | 'unresolved';
}

export interface SetCompletionScreenshotProgress {
  progress: number;
  stage: string;
  detail: string;
}

const STRICT_SET_COMPLETION_IMPORT_COLORS = [
  { red: 0x8f, green: 0x80, blue: 0x52, hex: '#8f8052' },
  { red: 0xbe, green: 0xa9, blue: 0x66, hex: '#bea966' },
  { red: 0xbb, green: 0xa6, blue: 0x65, hex: '#bba665' },
  { red: 0xad, green: 0x9a, blue: 0x5f, hex: '#ad9a5f' },
] as const;
const DEFAULT_SET_COMPLETION_IMPORT_TOLERANCE = 0;

const DEFAULT_CROP: SetCompletionImportCrop = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
};

const GRID_COLUMNS = 7;
const GRID_ROWS = 3;
const GRID_CELL_INSET = {
  left: 0.035,
  top: 0.04,
  right: 0.035,
  bottom: 0.055,
};

export function getDefaultSetCompletionImportCrop(): SetCompletionImportCrop {
  return { ...DEFAULT_CROP };
}

export function getDefaultSetCompletionImportTolerance(): number {
  return DEFAULT_SET_COMPLETION_IMPORT_TOLERANCE;
}

export async function processSetCompletionInventoryScreenshot(
  file: File,
  crop: SetCompletionImportCrop,
  tolerance: number,
  onProgress?: (progress: SetCompletionScreenshotProgress) => void,
): Promise<SetCompletionScreenshotOcrRow[]> {
  const [{ createWorker, PSM }, image] = await Promise.all([
    import('tesseract.js'),
    loadFileImage(file),
  ]);

  const tileCanvases = extractTileCanvases(image, crop);
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (!onProgress) {
        return;
      }
      onProgress({
        progress: message.progress ?? 0,
        stage: 'ocr',
        detail: message.status ?? 'Recognizing screenshot text…',
      });
    },
  });

  try {
    const rows: SetCompletionScreenshotOcrRow[] = [];

    for (let index = 0; index < tileCanvases.length; index += 1) {
      const tileCanvas = tileCanvases[index];
      onProgress?.({
        progress: tileCanvases.length ? index / tileCanvases.length : 0,
        stage: 'tile',
        detail: `Reading visible tile ${index + 1}/${tileCanvases.length}…`,
      });

      const quantityResult = await recognizeQuantityFromTile(
        worker,
        PSM,
        tileCanvas,
        tolerance,
      );
      const { quantity, quantityConfidence, quantityState } = quantityResult;

      const ocrVariants = await recognizeNameVariants(
        worker,
        PSM,
        tileCanvas,
        tolerance,
      );
      const bestVariant = chooseBestOcrVariant(ocrVariants);
      const detectedName = bestVariant?.text ?? '';
      const nameConfidence = bestVariant?.confidence ?? 0;

      if (
        !detectedName &&
        quantityState === 'defaulted' &&
        !tileHasNameSignal(tileCanvas, tolerance)
      ) {
        continue;
      }

      rows.push({
        rowId: `tile-${index + 1}`,
        tileIndex: index,
        thumbnailDataUrl: tileCanvas.toDataURL('image/png'),
        detectedName,
        nameConfidence,
        ocrVariants,
        quantity,
        quantityConfidence,
        quantityState,
      });
    }

    onProgress?.({
      progress: 1,
      stage: 'complete',
      detail: `Processed ${rows.length} visible inventory rows.`,
    });
    return rows;
  } finally {
    await worker.terminate();
  }
}

export async function buildSetCompletionImportMaskPreview(
  file: File,
  crop: SetCompletionImportCrop,
  tolerance: number,
): Promise<string> {
  const image = await loadFileImage(file);
  const sourceCanvas = createCanvas(image.naturalWidth, image.naturalHeight);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) {
    throw new Error('Could not prepare screenshot preview canvas.');
  }
  sourceContext.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);

  const cropX = Math.round(image.naturalWidth * crop.left);
  const cropY = Math.round(image.naturalHeight * crop.top);
  const cropWidth = Math.max(1, Math.round(image.naturalWidth * (1 - crop.left - crop.right)));
  const cropHeight = Math.max(1, Math.round(image.naturalHeight * (1 - crop.top - crop.bottom)));
  const croppedCanvas = extractPixelCanvas(sourceCanvas, cropX, cropY, cropWidth, cropHeight);
  return buildColorMaskCanvas(croppedCanvas, tolerance).toDataURL('image/png');
}

export function getSetCompletionImportStrictColors(): string[] {
  return STRICT_SET_COMPLETION_IMPORT_COLORS.map((color) => color.hex);
}

async function loadFileImage(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function extractTileCanvases(
  image: HTMLImageElement,
  crop: SetCompletionImportCrop,
): HTMLCanvasElement[] {
  const sourceCanvas = createCanvas(image.naturalWidth, image.naturalHeight);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) {
    throw new Error('Could not prepare screenshot canvas.');
  }
  sourceContext.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);

  const cropX = Math.round(image.naturalWidth * crop.left);
  const cropY = Math.round(image.naturalHeight * crop.top);
  const cropWidth = Math.round(image.naturalWidth * (1 - crop.left - crop.right));
  const cropHeight = Math.round(image.naturalHeight * (1 - crop.top - crop.bottom));

  const tileWidth = cropWidth / GRID_COLUMNS;
  const tileHeight = cropHeight / GRID_ROWS;
  const tiles: HTMLCanvasElement[] = [];

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const x = Math.round(cropX + column * tileWidth);
      const y = Math.round(cropY + row * tileHeight);
      const width = Math.max(1, Math.round(tileWidth));
      const height = Math.max(1, Math.round(tileHeight));
      const insetX = Math.round(width * GRID_CELL_INSET.left);
      const insetY = Math.round(height * GRID_CELL_INSET.top);
      const insetWidth = Math.max(
        1,
        Math.round(width * (1 - GRID_CELL_INSET.left - GRID_CELL_INSET.right)),
      );
      const insetHeight = Math.max(
        1,
        Math.round(height * (1 - GRID_CELL_INSET.top - GRID_CELL_INSET.bottom)),
      );
      tiles.push(
        extractPixelCanvas(
          sourceCanvas,
          x + insetX,
          y + insetY,
          insetWidth,
          insetHeight,
        ),
      );
    }
  }

  return tiles;
}

function extractRegionCanvas(
  source: HTMLCanvasElement,
  region: { left: number; top: number; width: number; height: number },
): HTMLCanvasElement {
  const x = Math.round(source.width * region.left);
  const y = Math.round(source.height * region.top);
  const width = Math.max(1, Math.round(source.width * region.width));
  const height = Math.max(1, Math.round(source.height * region.height));
  return extractPixelCanvas(source, x, y, width, height);
}

function extractPixelCanvas(
  source: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not extract screenshot region.');
  }
  context.drawImage(source, x, y, width, height, 0, 0, width, height);
  return canvas;
}

function preprocessForOcr(
  source: HTMLCanvasElement,
  mode: 'text' | 'text-strong' | 'digits',
): HTMLCanvasElement {
  const scale = mode === 'digits' ? 4 : 3;
  const canvas = createCanvas(source.width * scale, source.height * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create OCR canvas.');
  }

  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    const boosted = Math.max(
      0,
      Math.min(255, (luminance - (mode === 'text-strong' ? 62 : 50)) * (mode === 'text-strong' ? 2.8 : 2.25)),
    );
    const threshold =
      mode === 'digits' ? 130 : mode === 'text-strong' ? 108 : 118;
    const value = boosted >= threshold ? 255 : 0;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function buildColorMaskCanvas(
  source: HTMLCanvasElement,
  tolerance: number,
): HTMLCanvasElement {
  const scale = 4;
  const canvas = createCanvas(source.width * scale, source.height * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create color mask canvas.');
  }

  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const matches = STRICT_SET_COMPLETION_IMPORT_COLORS.some(
      (color) =>
        Math.abs(data[index] - color.red) <= tolerance &&
        Math.abs(data[index + 1] - color.green) <= tolerance &&
        Math.abs(data[index + 2] - color.blue) <= tolerance,
    );
    const value = matches ? 255 : 0;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function regionHasSignal(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext('2d');
  if (!context) {
    return false;
  }
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let brightPixels = 0;
  let sampledPixels = 0;

  for (let index = 0; index < data.length; index += 16) {
    sampledPixels += 1;
    const luminance = data[index];
    if (luminance > 180) {
      brightPixels += 1;
    }
  }

  return sampledPixels > 0 && brightPixels / sampledPixels > 0.03;
}

function findMaskBounds(
  canvas: HTMLCanvasElement,
  options?: { maxXRatio?: number; minArea?: number },
): { x: number; y: number; width: number; height: number; area: number } | null {
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  const maxX = options?.maxXRatio ? Math.floor(canvas.width * options.maxXRatio) : canvas.width;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let minX = canvas.width;
  let minY = canvas.height;
  let maxFoundX = -1;
  let maxFoundY = -1;
  let area = 0;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < maxX; x += 1) {
      const index = (y * canvas.width + x) * 4;
      if (data[index] > 180) {
        area += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxFoundX = Math.max(maxFoundX, x);
        maxFoundY = Math.max(maxFoundY, y);
      }
    }
  }

  if (
    maxFoundX < 0 ||
    maxFoundY < 0 ||
    area < (options?.minArea ?? Math.max(18, Math.round(canvas.width * canvas.height * 0.01)))
  ) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxFoundX - minX + 1,
    height: maxFoundY - minY + 1,
    area,
  };
}

function cleanupDetectedName(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*[\|/\\]\s*/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

async function recognizeNameVariants(
  worker: any,
  PSM: any,
  tileCanvas: HTMLCanvasElement,
  tolerance: number,
): Promise<SetCompletionScreenshotOcrVariant[]> {
  const baseRegion = extractRegionCanvas(tileCanvas, {
    left: 0.05,
    top: 0.38,
    width: 0.9,
    height: 0.58,
  });
  const tightBand = detectTextBandCanvas(baseRegion, tolerance) ?? baseRegion;

  const passes = [
    {
      key: 'color-exact',
      label: 'Strict Palette Mask',
      canvas: buildColorMaskCanvas(tightBand, tolerance),
      psm: PSM.SPARSE_TEXT,
      splitLines: false,
    },
    {
      key: 'color-clean',
      label: 'Cleaned Palette Mask',
      canvas: cleanupMaskCanvas(buildColorMaskCanvas(tightBand, tolerance)),
      psm: PSM.SPARSE_TEXT,
      splitLines: false,
    },
    {
      key: 'split-lines',
      label: 'Split Line Recovery',
      canvas: cleanupMaskCanvas(buildColorMaskCanvas(tightBand, tolerance)),
      psm: PSM.SINGLE_LINE,
      splitLines: true,
    },
    {
      key: 'line-clean',
      label: 'Icon Line Cleanup',
      canvas: removeWideMaskComponents(cleanupMaskCanvas(buildColorMaskCanvas(tightBand, tolerance))),
      psm: PSM.SPARSE_TEXT,
      splitLines: false,
    },
    {
      key: 'fallback-contrast',
      label: 'Fallback Contrast',
      canvas: preprocessForOcr(tightBand, 'text-strong'),
      psm: PSM.SPARSE_TEXT,
      splitLines: false,
    },
  ];

  const variants: SetCompletionScreenshotOcrVariant[] = [];
  for (const pass of passes) {
    await worker.setParameters({
      tessedit_pageseg_mode: pass.psm as unknown as string,
      preserve_interword_spaces: '1',
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-",
    });
    const mergedText = pass.splitLines
      ? await recognizeSplitNameLines(worker, PSM, pass.canvas)
      : await recognizeNameCanvas(worker, pass.canvas);
    if (!mergedText && !regionHasSignal(pass.canvas)) {
      continue;
    }
    variants.push({
      key: pass.key,
      label: pass.label,
      text: mergedText,
      confidence: mergedText ? estimateOcrConfidence(mergedText, pass.canvas) : 0,
    });
  }

  return dedupeOcrVariants(variants);
}

function chooseBestOcrVariant(
  variants: SetCompletionScreenshotOcrVariant[],
): SetCompletionScreenshotOcrVariant | null {
  if (!variants.length) {
    return null;
  }

  return [...variants].sort((left, right) => {
    const lengthDelta = right.text.length - left.text.length;
    if (lengthDelta !== 0) {
      return lengthDelta;
    }
    return right.confidence - left.confidence;
  })[0];
}

function dedupeOcrVariants(
  variants: SetCompletionScreenshotOcrVariant[],
): SetCompletionScreenshotOcrVariant[] {
  const byText = new Map<string, SetCompletionScreenshotOcrVariant>();
  for (const variant of variants) {
    const normalized = cleanupDetectedName(variant.text).toLowerCase();
    if (!normalized) {
      continue;
    }
    const existing = byText.get(normalized);
    if (!existing || variant.confidence > existing.confidence) {
      byText.set(normalized, { ...variant, text: cleanupDetectedName(variant.text) });
    }
  }

  return [...byText.values()].sort((left, right) => right.confidence - left.confidence);
}

async function recognizeNameCanvas(worker: any, canvas: HTMLCanvasElement): Promise<string> {
  const result = await worker.recognize(canvas, {}, { blocks: true });
  const linesText = extractBlockLinesText(result.data.blocks);
  const rawText = cleanupDetectedName(result.data.text);
  return cleanupDetectedName(linesText || rawText);
}

async function recognizeSplitNameLines(
  worker: any,
  PSM: any,
  canvas: HTMLCanvasElement,
): Promise<string> {
  const bounds = findMaskBounds(canvas);
  if (!bounds) {
    return '';
  }
  const lineSplit = clamp(bounds.y + Math.round(bounds.height * 0.52), 1, canvas.height - 1);
  const upperCanvas = extractPixelCanvas(canvas, 0, 0, canvas.width, lineSplit);
  const lowerCanvas = extractPixelCanvas(canvas, 0, lineSplit, canvas.width, canvas.height - lineSplit);

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE as unknown as string,
    preserve_interword_spaces: '1',
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-",
  });

  const [upperText, lowerText] = await Promise.all([
    regionHasSignal(upperCanvas) ? recognizeNameCanvas(worker, upperCanvas) : Promise.resolve(''),
    regionHasSignal(lowerCanvas) ? recognizeNameCanvas(worker, lowerCanvas) : Promise.resolve(''),
  ]);

  return cleanupDetectedName([upperText, lowerText].filter(Boolean).join(' '));
}

function estimateOcrConfidence(value: string, canvas: HTMLCanvasElement): number {
  const base = Math.min(0.98, 0.45 + value.length * 0.03);
  return regionHasSignal(canvas) ? base : Math.min(base, 0.35);
}

function extractBlockLinesText(blocks: Array<{ paragraphs?: Array<{ lines?: Array<{ text: string }> }> }> | null): string {
  if (!blocks?.length) {
    return '';
  }

  const lines: string[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const cleaned = cleanupDetectedName(line.text);
        if (cleaned) {
          lines.push(cleaned);
        }
      }
    }
  }

  return lines.join(' ');
}

async function recognizeQuantityFromTile(
  worker: any,
  PSM: any,
  tileCanvas: HTMLCanvasElement,
  tolerance: number,
): Promise<{
  quantity: number | null;
  quantityConfidence: number;
  quantityState: SetCompletionScreenshotOcrRow['quantityState'];
}> {
  const badgeRegion = extractRegionCanvas(tileCanvas, {
    left: 0.015,
    top: 0.01,
    width: 0.3,
    height: 0.22,
  });
  const tightMask = cleanupMaskCanvas(buildColorMaskCanvas(badgeRegion, tolerance));
  const anchorBounds = findMaskBounds(tightMask, { maxXRatio: 0.62, minArea: 24 });
  const anchorRight = anchorBounds
    ? clamp(
        Math.ceil((anchorBounds.x + anchorBounds.width) / 4) + 2,
        0,
        badgeRegion.width - 1,
      )
    : null;
  const digitRegion = anchorRight !== null
    ? extractPixelCanvas(
        badgeRegion,
        Math.max(anchorRight, Math.floor(badgeRegion.width * 0.28)),
        Math.max(0, Math.floor(badgeRegion.height * 0.02)),
        Math.max(
          1,
          Math.floor(badgeRegion.width * 0.94) -
            Math.max(anchorRight, Math.floor(badgeRegion.width * 0.28)),
        ),
        Math.max(1, Math.floor(badgeRegion.height * 0.88)),
      )
    : extractRegionCanvas(badgeRegion, {
        left: 0.34,
        top: 0.02,
        width: 0.6,
        height: 0.88,
      });

  const exactDigitMask = focusDigitMaskCanvas(buildColorMaskCanvas(digitRegion, tolerance));
  const cleanedDigitMask =
    focusDigitMaskCanvas(cleanupMaskCanvas(buildColorMaskCanvas(digitRegion, tolerance)));
  const grayscaleDigitMask = focusDigitMaskCanvas(preprocessForOcr(digitRegion, 'digits'));

  const digitPasses = [
    { canvas: exactDigitMask, psm: PSM.SINGLE_WORD, label: 'exact-word' },
    { canvas: cleanedDigitMask, psm: PSM.SINGLE_WORD, label: 'cleaned-word' },
    { canvas: cleanedDigitMask, psm: PSM.SINGLE_CHAR, label: 'cleaned-char' },
    { canvas: grayscaleDigitMask, psm: PSM.SINGLE_WORD, label: 'grayscale-word' },
    { canvas: grayscaleDigitMask, psm: PSM.SINGLE_CHAR, label: 'grayscale-char' },
  ];

  const candidates: Array<{ digits: string; confidence: number }> = [];
  for (const pass of digitPasses) {
    await worker.setParameters({
      tessedit_pageseg_mode: pass.psm as unknown as string,
      tessedit_char_whitelist: '0123456789',
    });
    const result = await worker.recognize(pass.canvas);
    const digits = result.data.text.trim().replace(/\D/g, '');
    if (digits) {
      candidates.push({
        digits,
        confidence: scoreDigitCandidate(digits, pass.canvas, (result.data.confidence ?? 0) / 100),
      });
    }
  }

  const digitSignal = digitPasses.some((pass) => regionHasSignal(pass.canvas));
  const best = chooseBestDigitCandidate(candidates);
  if (best) {
    return {
      quantity: Math.max(Number.parseInt(best.digits, 10) || 1, 1),
      quantityConfidence: best.confidence,
      quantityState: 'detected',
    };
  }
  if (!anchorBounds || !digitSignal) {
    return {
      quantity: 1,
      quantityConfidence: 0,
      quantityState: 'defaulted',
    };
  }
  return {
    quantity: null,
    quantityConfidence: 0,
    quantityState: 'unresolved',
  };
}

function focusDigitMaskCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = cleanupMaskCanvas(source);
  trimMaskToDenseColumns(canvas);
  removeDigitLeftNoise(canvas);
  return canvas;
}

function chooseBestDigitCandidate(
  candidates: Array<{ digits: string; confidence: number }>,
): { digits: string; confidence: number } | null {
  if (!candidates.length) {
    return null;
  }
  const byDigits = new Map<string, { digits: string; confidence: number; count: number }>();
  for (const candidate of candidates) {
    const existing = byDigits.get(candidate.digits);
    if (existing) {
      existing.count += 1;
      existing.confidence += candidate.confidence;
    } else {
      byDigits.set(candidate.digits, { ...candidate, count: 1 });
    }
  }
  return [...byDigits.values()].sort((left, right) => {
    const countDelta = right.count - left.count;
    if (countDelta !== 0) {
      return countDelta;
    }
    return right.confidence - left.confidence;
  })[0] ?? null;
}

function scoreDigitCandidate(
  digits: string,
  canvas: HTMLCanvasElement,
  ocrConfidence: number,
): number {
  const bounds = findMaskBounds(canvas);
  const signalBoost = bounds ? Math.min(0.16, bounds.area / Math.max(1, canvas.width * canvas.height)) : 0;
  const lengthPenalty = digits.length > 2 ? 0.18 : 0;
  return Math.max(0, ocrConfidence + signalBoost - lengthPenalty);
}

function detectTextBandCanvas(
  source: HTMLCanvasElement,
  tolerance: number,
): HTMLCanvasElement | null {
  const maskCanvas = buildColorMaskCanvas(source, tolerance);
  const context = maskCanvas.getContext('2d');
  if (!context) {
    return null;
  }
  const { data } = context.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const rowScores = new Array(maskCanvas.height).fill(0);
  let maxScore = 0;

  for (let y = 0; y < maskCanvas.height; y += 1) {
    let score = 0;
    for (let x = 0; x < maskCanvas.width; x += 1) {
      const index = (y * maskCanvas.width + x) * 4;
      if (data[index] > 180) {
        score += 1;
      }
    }
    rowScores[y] = score;
    maxScore = Math.max(maxScore, score);
  }

  if (maxScore === 0) {
    return null;
  }

  const threshold = Math.max(2, Math.round(maxScore * 0.12));
  let start = rowScores.findIndex((score) => score >= threshold);
  let end = rowScores.length - 1 - [...rowScores].reverse().findIndex((score) => score >= threshold);
  if (start < 0 || end < start) {
    return null;
  }

  start = clamp(start - 6, 0, maskCanvas.height - 1);
  end = clamp(end + 6, start + 1, maskCanvas.height);
  const unscaledStart = clamp(Math.floor(start / 4), 0, source.height - 1);
  const unscaledEnd = clamp(Math.ceil(end / 4), unscaledStart + 1, source.height);
  return extractPixelCanvas(source, 0, unscaledStart, source.width, unscaledEnd - unscaledStart);
}

function cleanupMaskCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = extractPixelCanvas(source, 0, 0, source.width, source.height);
  trimMaskToDenseRows(canvas);
  removeThinMaskComponents(canvas);
  return canvas;
}

function trimMaskToDenseRows(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const rowScores = new Array(canvas.height).fill(0);
  let maxScore = 0;

  for (let y = 0; y < canvas.height; y += 1) {
    let score = 0;
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4;
      if (data[index] > 180) {
        score += 1;
      }
    }
    rowScores[y] = score;
    maxScore = Math.max(maxScore, score);
  }
  if (maxScore === 0) {
    return;
  }
  const threshold = Math.max(2, Math.round(maxScore * 0.16));
  let start = rowScores.findIndex((score) => score >= threshold);
  let end = rowScores.length - 1 - [...rowScores].reverse().findIndex((score) => score >= threshold);
  if (start < 0 || end < start) {
    return;
  }
  start = clamp(start - 4, 0, canvas.height - 1);
  end = clamp(end + 4, start, canvas.height - 1);

  for (let y = 0; y < canvas.height; y += 1) {
    if (y >= start && y <= end) {
      continue;
    }
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function trimMaskToDenseColumns(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const columnScores = new Array(canvas.width).fill(0);
  let maxScore = 0;

  for (let x = 0; x < canvas.width; x += 1) {
    let score = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      const index = (y * canvas.width + x) * 4;
      if (data[index] > 180) {
        score += 1;
      }
    }
    columnScores[x] = score;
    maxScore = Math.max(maxScore, score);
  }

  if (maxScore === 0) {
    return;
  }

  const threshold = Math.max(1, Math.round(maxScore * 0.12));
  let start = columnScores.findIndex((score) => score >= threshold);
  let end =
    columnScores.length - 1 - [...columnScores].reverse().findIndex((score) => score >= threshold);
  if (start < 0 || end < start) {
    return;
  }
  start = clamp(start - 3, 0, canvas.width - 1);
  end = clamp(end + 3, start, canvas.width - 1);

  for (let x = 0; x < canvas.width; x += 1) {
    if (x >= start && x <= end) {
      continue;
    }
    for (let y = 0; y < canvas.height; y += 1) {
      const index = (y * canvas.width + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function removeDigitLeftNoise(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const cutoff = Math.floor(canvas.width * 0.18);

  for (let x = 0; x < cutoff; x += 1) {
    let brightCount = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      const index = (y * canvas.width + x) * 4;
      if (data[index] > 180) {
        brightCount += 1;
      }
    }
    if (brightCount > Math.max(2, Math.round(canvas.height * 0.42))) {
      for (let y = 0; y < canvas.height; y += 1) {
        const index = (y * canvas.width + x) * 4;
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 255;
      }
    }
  }

  context.putImageData(imageData, 0, 0);
}

function removeThinMaskComponents(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const visited = new Uint8Array(canvas.width * canvas.height);

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const flatIndex = y * canvas.width + x;
      if (visited[flatIndex]) {
        continue;
      }
      visited[flatIndex] = 1;
      const pixelIndex = flatIndex * 4;
      if (data[pixelIndex] <= 180) {
        continue;
      }

      const queue = [flatIndex];
      const component: number[] = [];
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (queue.length) {
        const current = queue.pop()!;
        component.push(current);
        const cx = current % canvas.width;
        const cy = Math.floor(current / canvas.width);
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= canvas.width || ny < 0 || ny >= canvas.height) {
            continue;
          }
          const neighbor = ny * canvas.width + nx;
          if (visited[neighbor]) {
            continue;
          }
          visited[neighbor] = 1;
          const neighborPixelIndex = neighbor * 4;
          if (data[neighborPixelIndex] > 180) {
            queue.push(neighbor);
          }
        }
      }

      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      const fill = component.length / Math.max(1, componentWidth * componentHeight);
      const aspect = componentWidth / Math.max(1, componentHeight);
      const shouldRemove =
        component.length < 10 ||
        ((aspect > 6 || aspect < 0.16) && fill < 0.35);
      if (!shouldRemove) {
        continue;
      }

      for (const pixel of component) {
        const index = pixel * 4;
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 255;
      }
    }
  }

  context.putImageData(imageData, 0, 0);
}

function tileHasNameSignal(
  tileCanvas: HTMLCanvasElement,
  tolerance: number,
): boolean {
  const nameRegion = extractRegionCanvas(tileCanvas, {
    left: 0.05,
    top: 0.38,
    width: 0.9,
    height: 0.58,
  });
  return regionHasSignal(buildColorMaskCanvas(nameRegion, tolerance));
}

function removeWideMaskComponents(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = extractPixelCanvas(source, 0, 0, source.width, source.height);
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const visited = new Uint8Array(canvas.width * canvas.height);

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const flatIndex = y * canvas.width + x;
      if (visited[flatIndex]) {
        continue;
      }
      visited[flatIndex] = 1;
      const pixelIndex = flatIndex * 4;
      if (data[pixelIndex] <= 180) {
        continue;
      }

      const queue = [flatIndex];
      const component: number[] = [];
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (queue.length) {
        const current = queue.pop()!;
        component.push(current);
        const cx = current % canvas.width;
        const cy = Math.floor(current / canvas.width);
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= canvas.width || ny < 0 || ny >= canvas.height) {
            continue;
          }
          const neighbor = ny * canvas.width + nx;
          if (visited[neighbor]) {
            continue;
          }
          visited[neighbor] = 1;
          const neighborPixelIndex = neighbor * 4;
          if (data[neighborPixelIndex] > 180) {
            queue.push(neighbor);
          }
        }
      }

      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      const fill = component.length / Math.max(1, componentWidth * componentHeight);
      if (componentWidth < Math.round(canvas.width * 0.32) || fill > 0.35) {
        continue;
      }
      for (const pixel of component) {
        const index = pixel * 4;
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 255;
      }
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
