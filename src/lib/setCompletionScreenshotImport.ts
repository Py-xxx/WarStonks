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

export interface SetCompletionTraceSettings {
  smoothness: number;
  thickness: number;
  noiseCutoff: number;
}

export interface SetCompletionDetectionCell {
  rowId: string;
  tileIndex: number;
  itemBox: SetCompletionDetectionBox;
  nameBox: SetCompletionDetectionBox | null;
  quantityBox: SetCompletionDetectionBox | null;
}

export interface SetCompletionScreenshotDetectionPreview {
  annotatedPreviewDataUrl: string;
  detectedItemCount: number;
  quantityCount: number;
  nameCount: number;
  cells: SetCompletionDetectionCell[];
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

const STRICT_SET_COMPLETION_IMPORT_COLORS = [
  { red: 0x8f, green: 0x80, blue: 0x52, hex: '#8f8052' },
  { red: 0xbe, green: 0xa9, blue: 0x66, hex: '#bea966' },
  { red: 0xbb, green: 0xa6, blue: 0x65, hex: '#bba665' },
  { red: 0xad, green: 0x9a, blue: 0x5f, hex: '#ad9a5f' },
] as const;
const DEFAULT_SET_COMPLETION_IMPORT_TOLERANCE = 8;
const DEFAULT_SET_COMPLETION_TRACE_SETTINGS: SetCompletionTraceSettings = {
  smoothness: 2,
  thickness: 2,
  noiseCutoff: 10,
};
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
const DEFAULT_CROP: SetCompletionImportCrop = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
};

let templatePromise: Promise<{ qty: TemplateMask }> | null = null;

export function getDefaultSetCompletionImportCrop(): SetCompletionImportCrop {
  return { ...DEFAULT_CROP };
}

export function getDefaultSetCompletionImportTolerance(): number {
  return DEFAULT_SET_COMPLETION_IMPORT_TOLERANCE;
}

export function getDefaultSetCompletionTraceSettings(): SetCompletionTraceSettings {
  return { ...DEFAULT_SET_COMPLETION_TRACE_SETTINGS };
}

export function getSetCompletionImportStrictColors(): string[] {
  return STRICT_SET_COMPLETION_IMPORT_COLORS.map((color) => color.hex);
}

export async function analyzeSetCompletionInventoryScreenshot(
  file: File,
  crop: SetCompletionImportCrop,
  traceSettings: SetCompletionTraceSettings,
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
    const detection = analyzeTileMask(tileMask, templates, traceSettings);
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
    });
  }

  drawOverlayBoxes(previewContext, cells);

  onProgress?.({
    progress: 1,
    stage: 'complete',
    detail: `Detected ${cells.length} item cells in the screenshot.`,
  });

  return {
    annotatedPreviewDataUrl: previewCanvas.toDataURL('image/png'),
    detectedItemCount: cells.length,
    quantityCount: cells.filter((cell) => cell.quantityBox !== null).length,
    nameCount: cells.filter((cell) => cell.nameBox !== null).length,
    cells,
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

async function loadTemplates(): Promise<{ qty: TemplateMask }> {
  if (!templatePromise) {
    templatePromise = Promise.all([loadAssetMask(ssQtyAssetUrl)]).then(([qty]) => ({ qty }));
  }

  return templatePromise;
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

function analyzeTileMask(
  tileMask: HTMLCanvasElement,
  templates: { qty: TemplateMask },
  traceSettings: SetCompletionTraceSettings,
): {
  detected: boolean;
  previewCanvas: HTMLCanvasElement;
  nameBox: SetCompletionDetectionBox | null;
  quantityBox: SetCompletionDetectionBox | null;
} {
  const badgeRegionRect = toPixelRegion(tileMask, BADGE_REGION);
  const badgeMask = extractPixelCanvas(
    tileMask,
    badgeRegionRect.x,
    badgeRegionRect.y,
    badgeRegionRect.width,
    badgeRegionRect.height,
  );
  const badgePreview = cleanupMaskCanvas(badgeMask);

  const quantityIconMatch = matchTemplateInRegion(
    badgePreview,
    templates.qty,
    QTY_TEMPLATE_RATIOS,
    0.46,
  );

  const quantityBox = quantityIconMatch
    ? deriveQuantityBox(badgePreview, quantityIconMatch, badgeRegionRect)
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

  const previewCanvas = cleanupPreviewMask(tileMask, {
    nameBox,
    quantityBox,
  });
  applyTraceOverlay(previewCanvas, tileMask, nameBox, traceSettings);
  applyTraceOverlay(previewCanvas, tileMask, quantityBox, traceSettings);
  const detected = nameBox !== null || quantityBox !== null;
  return {
    detected,
    previewCanvas,
    nameBox,
    quantityBox,
  };
}

function deriveQuantityBox(
  badgePreview: HTMLCanvasElement,
  quantityIconMatch: TemplateMatch,
  badgeRegionRect: SetCompletionDetectionBox,
): SetCompletionDetectionBox | null {
  const stripX = clamp(
    quantityIconMatch.x + quantityIconMatch.width + Math.round(badgePreview.width * 0.05),
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
  trimMaskToDenseRows(strip);
  trimMaskToDenseColumns(strip);
  const digitsBounds = findMaskBounds(strip, {
    minArea: Math.max(8, Math.round(strip.width * strip.height * 0.01)),
  });
  if (!digitsBounds) {
    return null;
  }

  const rightShift = Math.max(1, Math.round(digitsBounds.width * 0.5));
  const leftPadding = Math.max(1, Math.round(digitsBounds.width * 0.2));
  const rightPadding = Math.max(1, Math.round(digitsBounds.width * 0.1));
  const verticalPadding = Math.max(2, Math.round(digitsBounds.height * 0.1));
  return {
    x:
      Math.max(
        badgeRegionRect.x,
        badgeRegionRect.x +
          stripX +
          digitsBounds.x +
          rightShift -
          leftPadding,
      ),
    y: Math.max(0, badgeRegionRect.y + digitsBounds.y - verticalPadding),
    width: Math.max(
      1,
      digitsBounds.width + leftPadding + rightPadding,
    ),
    height: Math.max(1, digitsBounds.height + verticalPadding * 2),
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

function cleanupPreviewMask(
  source: HTMLCanvasElement,
  boxes: {
    nameBox: SetCompletionDetectionBox | null;
    quantityBox: SetCompletionDetectionBox | null;
  },
): HTMLCanvasElement {
  const canvas = extractPixelCanvas(source, 0, 0, source.width, source.height);
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const visited = new Uint8Array(canvas.width * canvas.height);
  const keepRegions = buildPreviewKeepRegions(canvas, boxes);

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
      const shouldKeep = shouldKeepPreviewComponent(bounds, component.length, keepRegions);
      if (shouldKeep) {
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

function applyTraceOverlay(
  previewCanvas: HTMLCanvasElement,
  sourceMask: HTMLCanvasElement,
  traceBox: SetCompletionDetectionBox | null,
  traceSettings: SetCompletionTraceSettings,
): void {
  if (!traceBox) {
    return;
  }

  const traceRegion = extractPixelCanvas(
    sourceMask,
    traceBox.x,
    traceBox.y,
    traceBox.width,
    traceBox.height,
  );
  const tracePixels = extractBinaryPixels(traceRegion);
  const filteredPixels = filterTracePixels(
    tracePixels,
    traceRegion.width,
    traceRegion.height,
    traceSettings,
  );
  drawTracePixels(
    previewCanvas,
    filteredPixels,
    traceRegion.width,
    traceRegion.height,
    traceBox.x,
    traceBox.y,
    traceSettings.thickness,
  );
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

function filterTracePixels(
  pixels: Uint8Array<ArrayBufferLike>,
  width: number,
  height: number,
  traceSettings: SetCompletionTraceSettings,
): Uint8Array<ArrayBufferLike> {
  let working: Uint8Array<ArrayBufferLike> = new Uint8Array(pixels);
  working = removeSmallBinaryComponents(working, width, height, traceSettings.noiseCutoff);
  for (let step = 0; step < traceSettings.smoothness; step += 1) {
    working = smoothBinaryPixels(working, width, height);
  }
  return working;
}

function removeSmallBinaryComponents(
  pixels: Uint8Array<ArrayBufferLike>,
  width: number,
  height: number,
  minArea: number,
): Uint8Array<ArrayBufferLike> {
  const next = new Uint8Array(pixels);
  const visited = new Uint8Array(width * height);

  for (let index = 0; index < pixels.length; index += 1) {
    if (visited[index] || pixels[index] === 0) {
      continue;
    }
    const component = collectBinaryComponent(pixels, width, height, visited, index);
    if (component.length >= minArea) {
      continue;
    }
    for (const pixelIndex of component) {
      next[pixelIndex] = 0;
    }
  }

  return next;
}

function smoothBinaryPixels(
  pixels: Uint8Array<ArrayBufferLike>,
  width: number,
  height: number,
): Uint8Array<ArrayBufferLike> {
  const next = new Uint8Array(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let activeNeighbors = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          if (pixels[ny * width + nx] === 1) {
            activeNeighbors += 1;
          }
        }
      }
      if (pixels[index] === 1 && activeNeighbors <= 1) {
        next[index] = 0;
      } else if (pixels[index] === 0 && activeNeighbors >= 5) {
        next[index] = 1;
      }
    }
  }
  return next;
}

function collectBinaryComponent(
  pixels: Uint8Array,
  width: number,
  height: number,
  visited: Uint8Array,
  startIndex: number,
): number[] {
  const queue = [startIndex];
  const component: number[] = [];
  visited[startIndex] = 1;

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
      if (visited[neighbor] || pixels[neighbor] === 0) {
        continue;
      }
      visited[neighbor] = 1;
      queue.push(neighbor);
    }
  }

  return component;
}

function drawTracePixels(
  canvas: HTMLCanvasElement,
  pixels: Uint8Array<ArrayBufferLike>,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  thickness: number,
): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  context.fillStyle = '#ff4f5a';
  const radius = Math.max(0, thickness - 1);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (pixels[index] === 0 || !isTraceEdgePixel(pixels, width, height, x, y)) {
        continue;
      }
      context.fillRect(offsetX + x - radius, offsetY + y - radius, radius * 2 + 1, radius * 2 + 1);
    }
  }
}

function isTraceEdgePixel(
  pixels: Uint8Array<ArrayBufferLike>,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  if (pixels[y * width + x] === 0) {
    return false;
  }
  const neighbors = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ];
  for (const [nx, ny] of neighbors) {
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      return true;
    }
    if (pixels[ny * width + nx] === 0) {
      return true;
    }
  }
  return false;
}

function buildPreviewKeepRegions(
  canvas: HTMLCanvasElement,
  boxes: {
    nameBox: SetCompletionDetectionBox | null;
    quantityBox: SetCompletionDetectionBox | null;
  },
): SetCompletionDetectionBox[] {
  const keepRegions: SetCompletionDetectionBox[] = [];

  if (boxes.nameBox) {
    keepRegions.push(
      expandPreviewBox(boxes.nameBox, canvas.width, canvas.height, {
        left: Math.max(8, Math.round(boxes.nameBox.width * 0.08)),
        right: Math.max(8, Math.round(boxes.nameBox.width * 0.08)),
        top: Math.max(8, Math.round(boxes.nameBox.height * 0.08)),
        bottom: 0,
      }),
    );
  }

  if (boxes.quantityBox) {
    keepRegions.push(
      expandPreviewBox(boxes.quantityBox, canvas.width, canvas.height, {
        left: Math.max(3, Math.round(boxes.quantityBox.width * 0.12)),
        right: Math.max(8, Math.round(boxes.quantityBox.width * 0.22)),
        top: Math.max(3, Math.round(boxes.quantityBox.height * 0.2)),
        bottom: Math.max(3, Math.round(boxes.quantityBox.height * 0.2)),
      }),
    );
  }

  return keepRegions;
}

function expandPreviewBox(
  box: SetCompletionDetectionBox,
  maxWidth: number,
  maxHeight: number,
  padding: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  },
): SetCompletionDetectionBox {
  const left = clamp(box.x - padding.left, 0, Math.max(0, maxWidth - 1));
  const top = clamp(box.y - padding.top, 0, Math.max(0, maxHeight - 1));
  const right = clamp(
    box.x + box.width - 1 + padding.right,
    left,
    Math.max(0, maxWidth - 1),
  );
  const bottom = clamp(
    box.y + box.height - 1 + padding.bottom,
    top,
    Math.max(0, maxHeight - 1),
  );
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

function shouldKeepPreviewComponent(
  bounds: SetCompletionDetectionBox,
  area: number,
  keepRegions: SetCompletionDetectionBox[],
): boolean {
  if (keepRegions.some((region) => boxesIntersect(bounds, region))) {
    return true;
  }

  const fill = area / Math.max(1, bounds.width * bounds.height);
  const aspect = bounds.width / Math.max(1, bounds.height);
  if (area < 10) {
    return false;
  }
  if ((aspect > 7 || aspect < 0.12) && fill < 0.4) {
    return false;
  }
  return false;
}

function boxesIntersect(
  left: SetCompletionDetectionBox,
  right: SetCompletionDetectionBox,
): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
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
