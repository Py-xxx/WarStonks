import { createWorker, PSM } from 'tesseract.js';
import ssIgnoreAssetUrl from '../assets/set-completion/ss-ignore.png';
import ssQtyAssetUrl from '../assets/set-completion/ss-qty.png';

export interface SetCompletionImportCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SetCompletionScreenshotProgress {
  progress: number;
  stage: string;
  detail: string;
}

export interface SetCompletionDetectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SetCompletionDetectionCell {
  rowId: string;
  tileIndex: number;
  itemBox: SetCompletionDetectionBox;
  nameBox: SetCompletionDetectionBox | null;
  quantityBox: SetCompletionDetectionBox | null;
  ignoreBox: SetCompletionDetectionBox | null;
}

export interface SetCompletionScreenshotDetectionPreview {
  annotatedPreviewDataUrl: string;
  detectedItemCount: number;
  quantityCount: number;
  ignoreCount: number;
  nameCount: number;
  cells: SetCompletionDetectionCell[];
  readings: SetCompletionDetectedReading[];
}

export interface SetCompletionDetectedReading {
  rowId: string;
  tileIndex: number;
  detectedText: string;
  detectedQuantity: string | null;
}

interface TileDescriptor {
  tileIndex: number;
  rowId: string;
  cropRect: SetCompletionDetectionBox;
  maskRect: SetCompletionDetectionBox;
}

interface TemplateMask {
  width: number;
  height: number;
  pixels: Uint8Array;
  onPixelCount: number;
}

interface TemplateMatch {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

interface OcrTextCandidate {
  text: string;
  confidence: number;
}

const STRICT_SET_COMPLETION_IMPORT_COLORS = [
  { red: 0x8f, green: 0x80, blue: 0x52, hex: '#8f8052' },
  { red: 0xbe, green: 0xa9, blue: 0x66, hex: '#bea966' },
  { red: 0xbb, green: 0xa6, blue: 0x65, hex: '#bba665' },
  { red: 0xad, green: 0x9a, blue: 0x5f, hex: '#ad9a5f' },
] as const;
const DEFAULT_SET_COMPLETION_IMPORT_TOLERANCE = 8;
const MASK_SCALE = 4;
const GRID_COLUMNS = 7;
const GRID_ROWS = 3;
const GRID_CELL_INSET = {
  left: 0.035,
  top: 0.04,
  right: 0.035,
  bottom: 0.055,
};
const BADGE_REGION = {
  left: 0.01,
  top: 0.01,
  width: 0.34,
  height: 0.24,
};
const NAME_REGION = {
  left: 0.04,
  top: 0.36,
  width: 0.92,
  height: 0.64,
};
const QTY_TEMPLATE_RATIOS = [0.18, 0.2, 0.22, 0.24, 0.26, 0.28, 0.3];
const IGNORE_TEMPLATE_RATIOS = [0.15, 0.17, 0.19, 0.21, 0.23, 0.25];
const PRIME_COMPONENT_HINTS = [
  'prime',
  'blueprint',
  'systems',
  'neuroptics',
  'chassis',
  'receiver',
  'barrel',
  'blade',
  'handle',
  'stock',
  'grip',
  'gauntlet',
  'disc',
  'ornament',
  'harness',
];

const DEFAULT_CROP: SetCompletionImportCrop = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
};

let templatePromise:
  | Promise<{
      qty: TemplateMask;
      ignore: TemplateMask;
    }>
  | null = null;
let ocrWorkerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null = null;

export function getDefaultSetCompletionImportCrop(): SetCompletionImportCrop {
  return { ...DEFAULT_CROP };
}

export function getDefaultSetCompletionImportTolerance(): number {
  return DEFAULT_SET_COMPLETION_IMPORT_TOLERANCE;
}

export function getSetCompletionImportStrictColors(): string[] {
  return STRICT_SET_COMPLETION_IMPORT_COLORS.map((color) => color.hex);
}

export async function analyzeSetCompletionInventoryScreenshot(
  file: File,
  crop: SetCompletionImportCrop,
  onProgress?: (progress: SetCompletionScreenshotProgress) => void,
): Promise<SetCompletionScreenshotDetectionPreview> {
  const [image, templates] = await Promise.all([loadFileImage(file), loadTemplates()]);
  const sourceCanvas = createCanvas(image.naturalWidth, image.naturalHeight);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) {
    throw new Error('Could not prepare screenshot canvas.');
  }
  sourceContext.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);

  const croppedCanvas = extractCropCanvas(sourceCanvas, crop);
  const maskedCanvas = buildColorMaskCanvas(
    croppedCanvas,
    DEFAULT_SET_COMPLETION_IMPORT_TOLERANCE,
  );
  const previewCanvas = createCanvas(maskedCanvas.width, maskedCanvas.height);
  const previewContext = previewCanvas.getContext('2d');
  if (!previewContext) {
    throw new Error('Could not create annotated preview canvas.');
  }
  previewContext.fillStyle = '#000000';
  previewContext.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

  const tiles = buildTileDescriptors(croppedCanvas.width, croppedCanvas.height);
  const cells: SetCompletionDetectionCell[] = [];

  for (let index = 0; index < tiles.length; index += 1) {
    const descriptor = tiles[index];
    onProgress?.({
      progress: tiles.length ? index / tiles.length : 0,
      stage: 'detect',
      detail: `Detecting visible tile ${index + 1}/${tiles.length}…`,
    });

    const tileMask = extractPixelCanvas(
      maskedCanvas,
      descriptor.maskRect.x,
      descriptor.maskRect.y,
      descriptor.maskRect.width,
      descriptor.maskRect.height,
    );
    const detection = analyzeTileMask(tileMask, templates);
    if (!detection.detected) {
      continue;
    }

    previewContext.drawImage(
      detection.previewCanvas,
      descriptor.maskRect.x,
      descriptor.maskRect.y,
      descriptor.maskRect.width,
      descriptor.maskRect.height,
    );

    cells.push({
      rowId: descriptor.rowId,
      tileIndex: descriptor.tileIndex,
      itemBox: { ...descriptor.maskRect },
      nameBox: detection.nameBox
        ? translateBox(detection.nameBox, descriptor.maskRect.x, descriptor.maskRect.y)
        : null,
      quantityBox: detection.quantityBox
        ? translateBox(detection.quantityBox, descriptor.maskRect.x, descriptor.maskRect.y)
        : null,
      ignoreBox: detection.ignoreBox
        ? translateBox(detection.ignoreBox, descriptor.maskRect.x, descriptor.maskRect.y)
        : null,
    });
  }

  drawOverlayBoxes(previewContext, cells);

  const readings = await readDetectedTextFromCells(maskedCanvas, cells, onProgress);

  onProgress?.({
    progress: 1,
    stage: 'complete',
    detail: `Detected ${cells.length} item cells in the screenshot.`,
  });

  return {
    annotatedPreviewDataUrl: previewCanvas.toDataURL('image/png'),
    detectedItemCount: cells.length,
    quantityCount: cells.filter((cell) => cell.quantityBox !== null).length,
    ignoreCount: cells.filter((cell) => cell.ignoreBox !== null).length,
    nameCount: cells.filter((cell) => cell.nameBox !== null).length,
    cells,
    readings,
  };
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

async function loadTemplates(): Promise<{ qty: TemplateMask; ignore: TemplateMask }> {
  if (!templatePromise) {
    templatePromise = Promise.all([
      loadAssetMask(ssQtyAssetUrl),
      loadAssetMask(ssIgnoreAssetUrl),
    ]).then(([qty, ignore]) => ({ qty, ignore }));
  }

  return templatePromise;
}

async function getOcrWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker('eng', 1, {
      logger: () => undefined,
      errorHandler: () => undefined,
    });
  }
  return ocrWorkerPromise;
}

async function loadAssetMask(url: string): Promise<TemplateMask> {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  const canvas = createCanvas(image.naturalWidth, image.naturalHeight);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create template canvas.');
  }
  context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = new Uint8Array(canvas.width * canvas.height);
  let onPixelCount = 0;

  for (let index = 0; index < pixels.length; index += 1) {
    const dataIndex = index * 4;
    const alpha = imageData.data[dataIndex + 3];
    const luminance =
      imageData.data[dataIndex] * 0.299 +
      imageData.data[dataIndex + 1] * 0.587 +
      imageData.data[dataIndex + 2] * 0.114;
    if (alpha > 10 && luminance > 96) {
      pixels[index] = 1;
      onPixelCount += 1;
    }
  }

  return {
    width: canvas.width,
    height: canvas.height,
    pixels,
    onPixelCount,
  };
}

function extractCropCanvas(
  sourceCanvas: HTMLCanvasElement,
  crop: SetCompletionImportCrop,
): HTMLCanvasElement {
  const cropX = Math.round(sourceCanvas.width * crop.left);
  const cropY = Math.round(sourceCanvas.height * crop.top);
  const cropWidth = Math.max(
    1,
    Math.round(sourceCanvas.width * (1 - crop.left - crop.right)),
  );
  const cropHeight = Math.max(
    1,
    Math.round(sourceCanvas.height * (1 - crop.top - crop.bottom)),
  );
  return extractPixelCanvas(sourceCanvas, cropX, cropY, cropWidth, cropHeight);
}

function extractBoxCanvas(
  sourceCanvas: HTMLCanvasElement,
  box: SetCompletionDetectionBox,
  padding?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  },
): HTMLCanvasElement {
  const leftPadding = padding?.left ?? 0;
  const rightPadding = padding?.right ?? 0;
  const topPadding = padding?.top ?? 0;
  const bottomPadding = padding?.bottom ?? 0;
  const x = clamp(box.x - leftPadding, 0, Math.max(0, sourceCanvas.width - 1));
  const y = clamp(box.y - topPadding, 0, Math.max(0, sourceCanvas.height - 1));
  const maxRight = Math.max(0, sourceCanvas.width - 1);
  const maxBottom = Math.max(0, sourceCanvas.height - 1);
  const right = clamp(box.x + box.width - 1 + rightPadding, x, maxRight);
  const bottom = clamp(box.y + box.height - 1 + bottomPadding, y, maxBottom);
  return extractPixelCanvas(sourceCanvas, x, y, right - x + 1, bottom - y + 1);
}

function buildTileDescriptors(
  cropWidth: number,
  cropHeight: number,
): TileDescriptor[] {
  const tileWidth = cropWidth / GRID_COLUMNS;
  const tileHeight = cropHeight / GRID_ROWS;
  const tiles: TileDescriptor[] = [];

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const x = Math.round(column * tileWidth);
      const y = Math.round(row * tileHeight);
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
      const cropRect = {
        x: x + insetX,
        y: y + insetY,
        width: insetWidth,
        height: insetHeight,
      };
      tiles.push({
        tileIndex: row * GRID_COLUMNS + column,
        rowId: `tile-${row * GRID_COLUMNS + column + 1}`,
        cropRect,
        maskRect: {
          x: cropRect.x * MASK_SCALE,
          y: cropRect.y * MASK_SCALE,
          width: cropRect.width * MASK_SCALE,
          height: cropRect.height * MASK_SCALE,
        },
      });
    }
  }

  return tiles;
}

async function readDetectedTextFromCells(
  maskedCanvas: HTMLCanvasElement,
  cells: SetCompletionDetectionCell[],
  onProgress?: (progress: SetCompletionScreenshotProgress) => void,
): Promise<SetCompletionDetectedReading[]> {
  if (!cells.length) {
    return [];
  }

  const worker = await getOcrWorker();
  const readings: SetCompletionDetectedReading[] = [];

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    onProgress?.({
      progress: cells.length ? index / cells.length : 0,
      stage: 'read',
      detail: `Reading detected text ${index + 1}/${cells.length}…`,
    });

    const [detectedText, detectedQuantity] = await Promise.all([
      cell.nameBox
        ? readNameText(worker, maskedCanvas, cell.nameBox)
        : Promise.resolve(''),
      cell.quantityBox
        ? readQuantityText(worker, maskedCanvas, cell.quantityBox)
        : Promise.resolve(null),
    ]);

    readings.push({
      rowId: cell.rowId,
      tileIndex: cell.tileIndex,
      detectedText,
      detectedQuantity,
    });
  }

  return readings;
}

async function readNameText(
  worker: Awaited<ReturnType<typeof createWorker>>,
  maskedCanvas: HTMLCanvasElement,
  box: SetCompletionDetectionBox,
): Promise<string> {
  const maskedRegion = extractBoxCanvas(maskedCanvas, box, {
    left: 14,
    right: 14,
    top: 6,
    bottom: 10,
  });
  const variants = [
    { canvas: upscaleCanvas(trimTransparentColumns(maskedRegion), 2), psm: PSM.SINGLE_BLOCK },
    {
      canvas: upscaleCanvas(thickenMaskCanvas(trimTransparentColumns(maskedRegion)), 2),
      psm: PSM.SINGLE_BLOCK,
    },
    {
      canvas: upscaleCanvas(thickenMaskCanvas(trimTransparentColumns(maskedRegion)), 2),
      psm: PSM.SPARSE_TEXT,
    },
  ];

  const candidates: OcrTextCandidate[] = [];
  for (const variant of variants) {
    const candidate = await recognizeTextCandidate(worker, variant.canvas, variant.psm, {
      whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -',
      preserveSpaces: true,
    });
    if (candidate.text) {
      candidates.push(candidate);
    }
  }

  const bestCandidate = pickBestNameCandidate(candidates);
  return bestCandidate?.text ?? '';
}

async function readQuantityText(
  worker: Awaited<ReturnType<typeof createWorker>>,
  maskedCanvas: HTMLCanvasElement,
  box: SetCompletionDetectionBox,
): Promise<string | null> {
  const maskedRegion = trimTransparentColumns(
    extractBoxCanvas(maskedCanvas, box, {
      left: 0,
      right: 4,
      top: 4,
      bottom: 4,
    }),
  );
  const variants = [
    { canvas: upscaleCanvas(maskedRegion, 3), psm: PSM.SINGLE_CHAR },
    { canvas: upscaleCanvas(maskedRegion, 3), psm: PSM.SINGLE_WORD },
    { canvas: upscaleCanvas(thickenMaskCanvas(maskedRegion), 3), psm: PSM.SINGLE_CHAR },
    { canvas: upscaleCanvas(thickenMaskCanvas(maskedRegion), 3), psm: PSM.SINGLE_WORD },
  ];

  const candidates: OcrTextCandidate[] = [];
  for (const variant of variants) {
    const candidate = await recognizeTextCandidate(worker, variant.canvas, variant.psm, {
      whitelist: '0123456789',
      preserveSpaces: false,
    });
    const digits = candidate.text.match(/\d+/)?.[0] ?? '';
    if (!digits) {
      continue;
    }
    candidates.push({
      text: digits,
      confidence: candidate.confidence,
    });
  }

  const bestCandidate = pickBestQuantityCandidate(candidates);
  return bestCandidate?.text ?? null;
}

function normalizeDetectedText(value: string): string {
  return value
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function recognizeTextCandidate(
  worker: Awaited<ReturnType<typeof createWorker>>,
  canvas: HTMLCanvasElement,
  psm: Tesseract.PSM,
  options: {
    whitelist: string;
    preserveSpaces: boolean;
  },
): Promise<OcrTextCandidate> {
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: options.preserveSpaces ? '1' : '0',
    tessedit_char_whitelist: options.whitelist,
    user_defined_dpi: '300',
  });
  const { data } = await worker.recognize(canvas, {}, { text: true });
  return {
    text: normalizeDetectedText(data.text),
    confidence: data.confidence ?? 0,
  };
}

function pickBestNameCandidate(candidates: OcrTextCandidate[]): OcrTextCandidate | null {
  let best: { candidate: OcrTextCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const score = scoreNameCandidate(candidate);
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}

function scoreNameCandidate(candidate: OcrTextCandidate): number {
  const text = candidate.text;
  if (!text) {
    return -1;
  }
  const normalized = text.toLowerCase();
  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  const hintHits = PRIME_COMPONENT_HINTS.filter((hint) => normalized.includes(hint)).length;
  const alphaNumericRatio =
    normalized.replace(/[^a-z0-9]/g, '').length / Math.max(1, normalized.length);
  return (
    candidate.confidence * 0.55 +
    normalized.length * 1.1 +
    tokenCount * 8 +
    hintHits * 14 +
    (normalized.includes('prime') ? 18 : 0) +
    alphaNumericRatio * 20
  );
}

function pickBestQuantityCandidate(candidates: OcrTextCandidate[]): OcrTextCandidate | null {
  let best: { candidate: OcrTextCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const digits = candidate.text;
    const digitCount = digits.length;
    const score =
      candidate.confidence * 0.6 +
      (digitCount <= 2 ? 20 : 0) +
      (digits === '0' ? -30 : 0) +
      Math.max(0, 12 - digitCount * 4);
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}

function trimTransparentColumns(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = extractPixelCanvas(source, 0, 0, source.width, source.height);
  trimMaskToDenseColumns(canvas, {
    thresholdRatio: 0.04,
    minThreshold: 1,
    padding: 2,
  });
  trimMaskToDenseRows(canvas, {
    thresholdRatio: 0.04,
    minThreshold: 1,
    padding: 2,
  });
  return canvas;
}

function thickenMaskCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = extractPixelCanvas(source, 0, 0, source.width, source.height);
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const sourceData = new Uint8ClampedArray(imageData.data);
  const { data } = imageData;

  for (let y = 1; y < canvas.height - 1; y += 1) {
    for (let x = 1; x < canvas.width - 1; x += 1) {
      const index = (y * canvas.width + x) * 4;
      if (sourceData[index] > 180) {
        continue;
      }
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const neighborIndex = ((y + dy) * canvas.width + (x + dx)) * 4;
          if (sourceData[neighborIndex] > 180) {
            neighbors += 1;
          }
        }
      }
      if (neighbors >= 2) {
        data[index] = 255;
        data[index + 1] = 255;
        data[index + 2] = 255;
        data[index + 3] = 255;
      }
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function upscaleCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  if (scale <= 1) {
    return source;
  }
  const canvas = createCanvas(source.width * scale, source.height * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    return source;
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function analyzeTileMask(
  tileMask: HTMLCanvasElement,
  templates: { qty: TemplateMask; ignore: TemplateMask },
): {
  detected: boolean;
  previewCanvas: HTMLCanvasElement;
  nameBox: SetCompletionDetectionBox | null;
  quantityBox: SetCompletionDetectionBox | null;
  ignoreBox: SetCompletionDetectionBox | null;
} {
  const previewCanvas = createCanvas(tileMask.width, tileMask.height);
  const previewContext = previewCanvas.getContext('2d');
  if (!previewContext) {
    throw new Error('Could not create tile preview canvas.');
  }
  previewContext.fillStyle = '#000000';
  previewContext.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewContext.drawImage(tileMask, 0, 0, previewCanvas.width, previewCanvas.height);

  const badgeRegionRect = toPixelRegion(tileMask, BADGE_REGION);
  const badgeMask = extractPixelCanvas(
    tileMask,
    badgeRegionRect.x,
    badgeRegionRect.y,
    badgeRegionRect.width,
    badgeRegionRect.height,
  );
  const badgePreview = cleanupMaskCanvas(badgeMask);
  previewContext.drawImage(
    badgePreview,
    badgeRegionRect.x,
    badgeRegionRect.y,
    badgeRegionRect.width,
    badgeRegionRect.height,
  );

  const ignoreMatch = matchTemplateInRegion(
    badgePreview,
    templates.ignore,
    IGNORE_TEMPLATE_RATIOS,
    0.56,
  );
  const quantityIconMatch = matchTemplateInRegion(
    badgePreview,
    templates.qty,
    QTY_TEMPLATE_RATIOS,
    0.46,
  );

  const ignoreBox = ignoreMatch
    ? translateBox(ignoreMatch, badgeRegionRect.x, badgeRegionRect.y)
    : null;
  const quantityBox = quantityIconMatch
    ? deriveQuantityBox(badgePreview, quantityIconMatch, ignoreMatch, badgeRegionRect)
    : null;

  const nameRegionRect = toPixelRegion(tileMask, NAME_REGION);
  const nameMask = cleanupNameDetectionMask(
    extractPixelCanvas(
      tileMask,
      nameRegionRect.x,
      nameRegionRect.y,
      nameRegionRect.width,
      nameRegionRect.height,
    ),
  );
  const localNameBounds = findMaskBounds(nameMask, {
    minArea: Math.max(12, Math.round(nameMask.width * nameMask.height * 0.004)),
  });
  const nameBox = localNameBounds
    ? translateBox(
        expandBoundsToBottom(localNameBounds, nameMask.width, nameMask.height, {
          left: Math.max(8, Math.round(nameMask.width * 0.03)),
          right: Math.max(8, Math.round(nameMask.width * 0.03)),
          top: Math.max(6, Math.round(nameMask.height * 0.03)),
        }),
        nameRegionRect.x,
        nameRegionRect.y,
      )
    : null;

  const detected = nameBox !== null || quantityBox !== null || ignoreBox !== null;
  return {
    detected,
    previewCanvas,
    nameBox,
    quantityBox,
    ignoreBox,
  };
}

function deriveQuantityBox(
  badgePreview: HTMLCanvasElement,
  quantityIconMatch: TemplateMatch,
  ignoreMatch: TemplateMatch | null,
  badgeRegionRect: SetCompletionDetectionBox,
): SetCompletionDetectionBox | null {
  const stripX = clamp(
    quantityIconMatch.x + quantityIconMatch.width + Math.round(badgePreview.width * 0.015),
    0,
    badgePreview.width - 1,
  );
  const stripWidth = Math.max(
    1,
    Math.floor(badgePreview.width * 0.96) - stripX,
  );
  const strip = extractPixelCanvas(
    badgePreview,
    stripX,
    0,
    stripWidth,
    badgePreview.height,
  );
  if (ignoreMatch) {
    suppressOverlap(
      strip,
      {
        x: ignoreMatch.x - stripX,
        y: ignoreMatch.y,
        width: ignoreMatch.width,
        height: ignoreMatch.height,
      },
    );
  }
  trimMaskToDenseRows(strip);
  trimMaskToDenseColumns(strip);
  const digitsBounds = findMaskBounds(strip, {
    minArea: Math.max(8, Math.round(strip.width * strip.height * 0.01)),
  });
  if (!digitsBounds) {
    return null;
  }

  return {
    x: badgeRegionRect.x + stripX + digitsBounds.x,
    y: badgeRegionRect.y + digitsBounds.y,
    width: digitsBounds.width,
    height: digitsBounds.height,
  };
}

function matchTemplateInRegion(
  regionCanvas: HTMLCanvasElement,
  template: TemplateMask,
  scaleRatios: number[],
  minScore: number,
): TemplateMatch | null {
  const regionMask = extractBinaryPixels(regionCanvas);
  let bestMatch: TemplateMatch | null = null;

  for (const ratio of scaleRatios) {
    const targetHeight = Math.max(8, Math.round(regionCanvas.height * ratio));
    const scale = targetHeight / template.height;
    const scaledTemplate = scaleTemplate(template, scale);
    if (
      scaledTemplate.width > regionCanvas.width ||
      scaledTemplate.height > regionCanvas.height ||
      scaledTemplate.onPixelCount < 12
    ) {
      continue;
    }
    const step = scaledTemplate.width < 40 ? 2 : 3;

    for (let y = 0; y <= regionCanvas.height - scaledTemplate.height; y += step) {
      for (let x = 0; x <= regionCanvas.width - scaledTemplate.width; x += step) {
        const score = scoreTemplateAtPosition(
          regionMask,
          regionCanvas.width,
          scaledTemplate,
          x,
          y,
        );
        if (score < minScore) {
          continue;
        }
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            x,
            y,
            width: scaledTemplate.width,
            height: scaledTemplate.height,
            score,
          };
        }
      }
    }
  }

  return bestMatch;
}

function scoreTemplateAtPosition(
  regionPixels: Uint8Array,
  regionWidth: number,
  template: TemplateMask,
  offsetX: number,
  offsetY: number,
): number {
  let matched = 0;
  let extra = 0;

  for (let y = 0; y < template.height; y += 1) {
    for (let x = 0; x < template.width; x += 1) {
      const templateIndex = y * template.width + x;
      const regionIndex = (offsetY + y) * regionWidth + offsetX + x;
      const templateOn = template.pixels[templateIndex] === 1;
      const regionOn = regionPixels[regionIndex] === 1;
      if (templateOn && regionOn) {
        matched += 1;
      } else if (!templateOn && regionOn) {
        extra += 1;
      }
    }
  }

  const recall = matched / Math.max(1, template.onPixelCount);
  const precision = matched / Math.max(1, matched + extra);
  return recall * 0.74 + precision * 0.26;
}

function scaleTemplate(template: TemplateMask, scale: number): TemplateMask {
  const width = Math.max(1, Math.round(template.width * scale));
  const height = Math.max(1, Math.round(template.height * scale));
  const canvas = createCanvas(template.width, template.height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create template source canvas.');
  }
  const imageData = context.createImageData(template.width, template.height);
  for (let index = 0; index < template.pixels.length; index += 1) {
    const dataIndex = index * 4;
    const value = template.pixels[index] ? 255 : 0;
    imageData.data[dataIndex] = value;
    imageData.data[dataIndex + 1] = value;
    imageData.data[dataIndex + 2] = value;
    imageData.data[dataIndex + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);

  const scaledCanvas = createCanvas(width, height);
  const scaledContext = scaledCanvas.getContext('2d');
  if (!scaledContext) {
    throw new Error('Could not create scaled template canvas.');
  }
  scaledContext.imageSmoothingEnabled = false;
  scaledContext.drawImage(canvas, 0, 0, width, height);
  const scaledPixels = extractBinaryPixels(scaledCanvas);
  let onPixelCount = 0;
  for (const value of scaledPixels) {
    if (value === 1) {
      onPixelCount += 1;
    }
  }
  return {
    width,
    height,
    pixels: scaledPixels,
    onPixelCount,
  };
}

function drawOverlayBoxes(
  context: CanvasRenderingContext2D,
  cells: SetCompletionDetectionCell[],
): void {
  for (const cell of cells) {
    strokeBox(context, cell.itemBox, '#f04f58', 3);
  }
  for (const cell of cells) {
    if (cell.nameBox) {
      strokeBox(context, cell.nameBox, '#4a9eff', 3);
    }
  }
  for (const cell of cells) {
    if (cell.quantityBox) {
      strokeBox(context, cell.quantityBox, '#3dd68c', 3);
    }
  }
  for (const cell of cells) {
    if (cell.ignoreBox) {
      strokeBox(context, cell.ignoreBox, '#8b6fff', 3);
    }
  }
}

function strokeBox(
  context: CanvasRenderingContext2D,
  box: SetCompletionDetectionBox,
  color: string,
  lineWidth: number,
): void {
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.strokeRect(
    box.x + lineWidth * 0.5,
    box.y + lineWidth * 0.5,
    Math.max(1, box.width - lineWidth),
    Math.max(1, box.height - lineWidth),
  );
}

function buildColorMaskCanvas(
  source: HTMLCanvasElement,
  tolerance: number,
): HTMLCanvasElement {
  const canvas = createCanvas(source.width * MASK_SCALE, source.height * MASK_SCALE);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create color mask canvas.');
  }

  context.imageSmoothingEnabled = false;
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

function cleanupMaskCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = extractPixelCanvas(source, 0, 0, source.width, source.height);
  trimMaskToDenseRows(canvas);
  removeThinMaskComponents(canvas);
  return canvas;
}

function cleanupNameDetectionMask(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = extractPixelCanvas(source, 0, 0, source.width, source.height);
  removeThinMaskComponents(canvas);
  const trimmed = removeWideMaskComponents(canvas);
  retainBottomTextBand(trimmed);
  trimMaskToDenseColumns(trimmed, {
    thresholdRatio: 0.08,
    minThreshold: 1,
    padding: 4,
  });
  return trimmed;
}

function trimMaskToDenseRows(
  canvas: HTMLCanvasElement,
  options?: {
    thresholdRatio?: number;
    minThreshold?: number;
    padding?: number;
  },
): void {
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
  const threshold = Math.max(
    options?.minThreshold ?? 2,
    Math.round(maxScore * (options?.thresholdRatio ?? 0.16)),
  );
  let start = rowScores.findIndex((score) => score >= threshold);
  let end = rowScores.length - 1 - [...rowScores].reverse().findIndex((score) => score >= threshold);
  if (start < 0 || end < start) {
    return;
  }
  const padding = options?.padding ?? 4;
  start = clamp(start - padding, 0, canvas.height - 1);
  end = clamp(end + padding, start, canvas.height - 1);

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

function trimMaskToDenseColumns(
  canvas: HTMLCanvasElement,
  options?: {
    thresholdRatio?: number;
    minThreshold?: number;
    padding?: number;
  },
): void {
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

  const threshold = Math.max(
    options?.minThreshold ?? 1,
    Math.round(maxScore * (options?.thresholdRatio ?? 0.12)),
  );
  let start = columnScores.findIndex((score) => score >= threshold);
  let end =
    columnScores.length - 1 - [...columnScores].reverse().findIndex((score) => score >= threshold);
  if (start < 0 || end < start) {
    return;
  }
  const padding = options?.padding ?? 3;
  start = clamp(start - padding, 0, canvas.width - 1);
  end = clamp(end + padding, start, canvas.width - 1);

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

      const component = collectMaskComponent(canvas.width, canvas.height, data, visited, flatIndex);
      const bounds = componentBounds(canvas.width, component);
      const componentWidth = bounds.width;
      const componentHeight = bounds.height;
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

      const component = collectMaskComponent(canvas.width, canvas.height, data, visited, flatIndex);
      const bounds = componentBounds(canvas.width, component);
      const fill = component.length / Math.max(1, bounds.width * bounds.height);
      if (bounds.width < Math.round(canvas.width * 0.32) || fill > 0.35) {
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

function findMaskBounds(
  canvas: HTMLCanvasElement,
  options?: { maxXRatio?: number; minArea?: number },
): SetCompletionDetectionBox | null {
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
  };
}

function expandBoundsToBottom(
  bounds: SetCompletionDetectionBox,
  maxWidth: number,
  maxHeight: number,
  padding: {
    left: number;
    right: number;
    top: number;
  },
): SetCompletionDetectionBox {
  const left = clamp(bounds.x - padding.left, 0, Math.max(0, maxWidth - 1));
  const top = clamp(bounds.y - padding.top, 0, Math.max(0, maxHeight - 1));
  const right = clamp(
    bounds.x + bounds.width - 1 + padding.right,
    left,
    Math.max(0, maxWidth - 1),
  );
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: maxHeight - top,
  };
}

function retainBottomTextBand(canvas: HTMLCanvasElement): void {
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

  const threshold = Math.max(1, Math.round(maxScore * 0.06));
  const activeRows: number[] = [];
  for (let y = 0; y < rowScores.length; y += 1) {
    if (rowScores[y] >= threshold) {
      activeRows.push(y);
    }
  }

  if (!activeRows.length) {
    return;
  }

  let startRow = activeRows[activeRows.length - 1];
  let previousRow = startRow;
  const maxGap = Math.max(10, Math.round(canvas.height * 0.09));

  for (let index = activeRows.length - 2; index >= 0; index -= 1) {
    const row = activeRows[index];
    if (previousRow - row > maxGap) {
      break;
    }
    startRow = row;
    previousRow = row;
  }

  startRow = clamp(startRow - Math.max(8, Math.round(canvas.height * 0.05)), 0, canvas.height - 1);

  for (let y = 0; y < startRow; y += 1) {
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

function extractBinaryPixels(canvas: HTMLCanvasElement): Uint8Array {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not read canvas pixels.');
  }
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = new Uint8Array(canvas.width * canvas.height);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = data[index * 4] > 180 ? 1 : 0;
  }
  return pixels;
}

function collectMaskComponent(
  width: number,
  height: number,
  data: Uint8ClampedArray,
  visited: Uint8Array,
  startFlatIndex: number,
): number[] {
  const queue = [startFlatIndex];
  const component: number[] = [];

  while (queue.length) {
    const current = queue.pop()!;
    component.push(current);
    const cx = current % width;
    const cy = Math.floor(current / width);
    const neighbors = [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
        continue;
      }
      const neighbor = ny * width + nx;
      if (visited[neighbor]) {
        continue;
      }
      visited[neighbor] = 1;
      const pixelIndex = neighbor * 4;
      if (data[pixelIndex] > 180) {
        queue.push(neighbor);
      }
    }
  }

  return component;
}

function componentBounds(width: number, component: number[]): SetCompletionDetectionBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;

  for (const pixel of component) {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function suppressOverlap(canvas: HTMLCanvasElement, box: SetCompletionDetectionBox): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const startX = clamp(box.x, 0, canvas.width - 1);
  const startY = clamp(box.y, 0, canvas.height - 1);
  const endX = clamp(box.x + box.width, startX, canvas.width);
  const endY = clamp(box.y + box.height, startY, canvas.height);

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = (y * canvas.width + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function toPixelRegion(
  source: HTMLCanvasElement,
  region: { left: number; top: number; width: number; height: number },
): SetCompletionDetectionBox {
  return {
    x: Math.round(source.width * region.left),
    y: Math.round(source.height * region.top),
    width: Math.max(1, Math.round(source.width * region.width)),
    height: Math.max(1, Math.round(source.height * region.height)),
  };
}

function translateBox(
  box: SetCompletionDetectionBox,
  offsetX: number,
  offsetY: number,
): SetCompletionDetectionBox {
  return {
    x: box.x + offsetX,
    y: box.y + offsetY,
    width: box.width,
    height: box.height,
  };
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
