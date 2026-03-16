import base64
import io
import json
import os
import re
import sys
from typing import Any

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import numpy as np
from PIL import Image, ImageOps
from paddleocr import PaddleOCR


def build_ocr() -> PaddleOCR:
    try:
        return PaddleOCR(
            lang="en",
            use_textline_orientation=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
        )
    except TypeError:
        return PaddleOCR(lang="en", use_angle_cls=False)


def inset_crop(image: Image.Image, box: dict[str, int] | None, inset: int) -> Image.Image | None:
    if not box:
        return None
    left = max(0, int(box["x"]) + inset)
    top = max(0, int(box["y"]) + inset)
    right = min(image.width, max(left + 1, int(box["x"]) + int(box["width"]) - inset))
    bottom = min(image.height, max(top + 1, int(box["y"]) + int(box["height"]) - inset))
    return image.crop((left, top, right, bottom))


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\n", " ").replace("\r", " ")).strip()


def parse_recognition_segments(value: Any) -> list[str]:
    texts: list[str] = []
    if value is None:
        return texts
    if isinstance(value, dict):
        rec_texts = value.get("rec_texts")
        if isinstance(rec_texts, list):
            for item in rec_texts:
                if isinstance(item, str):
                    cleaned = normalize_text(item)
                    if cleaned:
                        texts.append(cleaned)
        return texts
    if isinstance(value, (list, tuple)):
        for item in value:
            texts.extend(parse_recognition_segments(item))
    return texts


def prepare_name_image(image: Image.Image | None) -> Image.Image | None:
    if image is None:
        return None
    grayscale = ImageOps.autocontrast(image.convert("L"))
    width, height = grayscale.size
    return grayscale.resize((max(1, width * 4), max(1, height * 4)), Image.Resampling.NEAREST)


def prepare_quantity_image(image: Image.Image | None) -> Image.Image | None:
    if image is None:
        return None
    grayscale = ImageOps.autocontrast(image.convert("L"))
    thresholded = grayscale.point(lambda value: 255 if value > 48 else 0, mode="L")
    width, height = thresholded.size
    return thresholded.resize((max(1, width * 6), max(1, height * 6)), Image.Resampling.NEAREST)


def run_paddle(ocr: PaddleOCR, image: Image.Image | None) -> list[str]:
    if image is None:
        return []
    array = np.array(image.convert("RGB"))
    result = None
    if hasattr(ocr, "ocr"):
        try:
            result = ocr.ocr(array, cls=False)
        except TypeError:
            result = ocr.ocr(array)
    if result is None and hasattr(ocr, "predict"):
        result = ocr.predict(array)
    return parse_recognition_segments(result)


def read_name_line(ocr: PaddleOCR, image: Image.Image | None) -> str:
    segments = run_paddle(ocr, prepare_name_image(image))
    return normalize_text(" ".join(segments))


def read_quantity(ocr: PaddleOCR, image: Image.Image | None) -> str | None:
    segments = run_paddle(ocr, prepare_quantity_image(image))
    merged = normalize_text(" ".join(segments))
    digits = re.findall(r"\d+", merged)
    if digits:
        return "".join(digits)
    return None


def main() -> int:
    payload = json.load(sys.stdin)
    image_data = base64.b64decode(payload["imageBase64"])
    image = Image.open(io.BytesIO(image_data)).convert("RGB")
    ocr = build_ocr()
    readings: list[dict[str, Any]] = []

    for cell in payload["cells"]:
        line_texts: list[str] = []
        for box in cell.get("nameLineBoxes", []):
            line_text = read_name_line(ocr, inset_crop(image, box, 3))
            if line_text:
                line_texts.append(line_text)

        quantity_text = None
        quantity_box = cell.get("quantityBox")
        if quantity_box is not None:
            quantity_text = read_quantity(ocr, inset_crop(image, quantity_box, 3))

        readings.append(
            {
                "rowId": cell["rowId"],
                "tileIndex": cell["tileIndex"],
                "detectedText": normalize_text(" ".join(line_texts)),
                "detectedQuantity": quantity_text,
            }
        )

    json.dump(readings, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
