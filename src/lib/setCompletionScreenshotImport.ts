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
  quantity: number | null;
  quantityConfidence: number;
  quantityState: 'detected' | 'defaulted' | 'unresolved';
}

export interface SetCompletionScreenshotProgress {
  progress: number;
  stage: string;
  detail: string;
}

const DEFAULT_CROP: SetCompletionImportCrop = {
  left: 0.005,
  top: 0.12,
  right: 0.235,
  bottom: 0.165,
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

export async function processSetCompletionInventoryScreenshot(
  file: File,
  crop: SetCompletionImportCrop,
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

      const quantityCanvas = preprocessForOcr(
        extractRegionCanvas(tileCanvas, {
          left: 0.02,
          top: 0.01,
          width: 0.27,
          height: 0.22,
        }),
        'digits',
      );

      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_WORD,
        tessedit_char_whitelist: '0123456789',
      });
      const quantityResult = await worker.recognize(quantityCanvas);
      const quantityText = quantityResult.data.text.trim();
      const quantityDigits = quantityText.replace(/\D/g, '');
      const quantityConfidence = (quantityResult.data.confidence ?? 0) / 100;
      const hasBadgeSignal = regionHasSignal(quantityCanvas);

      let quantity: number | null = null;
      let quantityState: SetCompletionScreenshotOcrRow['quantityState'] = 'defaulted';
      if (quantityDigits) {
        quantity = Math.max(Number.parseInt(quantityDigits, 10) || 1, 1);
        quantityState = 'detected';
      } else if (!hasBadgeSignal) {
        quantity = 1;
        quantityState = 'defaulted';
      } else {
        quantity = null;
        quantityState = 'unresolved';
      }

      const nameCanvas = preprocessForOcr(
        extractRegionCanvas(tileCanvas, {
          left: 0.08,
          top: 0.5,
          width: 0.84,
          height: 0.42,
        }),
        'text',
      );

      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: '1',
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-",
      });
      const nameResult = await worker.recognize(nameCanvas);
      const detectedName = cleanupDetectedName(nameResult.data.text);
      const nameConfidence = (nameResult.data.confidence ?? 0) / 100;

      if (!detectedName && quantityState === 'defaulted' && !regionHasSignal(nameCanvas)) {
        continue;
      }

      rows.push({
        rowId: `tile-${index + 1}`,
        tileIndex: index,
        thumbnailDataUrl: tileCanvas.toDataURL('image/png'),
        detectedName,
        nameConfidence,
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
  mode: 'text' | 'digits',
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
    const boosted = Math.max(0, Math.min(255, (luminance - 50) * 2.25));
    const threshold = mode === 'digits' ? 130 : 118;
    const value = boosted >= threshold ? 255 : 0;
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

function cleanupDetectedName(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*[\|/\\]\s*/g, ' ')
    .trim();
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
