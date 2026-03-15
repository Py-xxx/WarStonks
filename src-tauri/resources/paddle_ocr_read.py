import base64
import io
import json
import os
import re
import sys
from typing import Any

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import numpy as np
from PIL import Image
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


def crop_box(image: Image.Image, box: dict[str, int] | None) -> Image.Image | None:
    if not box:
        return None
    left = max(0, int(box["x"]))
    top = max(0, int(box["y"]))
    right = max(left + 1, left + int(box["width"]))
    bottom = max(top + 1, top + int(box["height"]))
    return image.crop((left, top, right, bottom))


def extract_texts(value: Any) -> list[str]:
    texts: list[str] = []
    if value is None:
        return texts
    if isinstance(value, str):
        cleaned = normalize_text(value)
        if cleaned:
            texts.append(cleaned)
        return texts
    if isinstance(value, dict):
        for key in ("rec_texts", "text", "rec_text"):
            field = value.get(key)
            if isinstance(field, list):
                for item in field:
                    if isinstance(item, str):
                        cleaned = normalize_text(item)
                        if cleaned:
                            texts.append(cleaned)
            elif isinstance(field, str):
                cleaned = normalize_text(field)
                if cleaned:
                    texts.append(cleaned)
        for item in value.values():
            texts.extend(extract_texts(item))
        return texts
    if isinstance(value, (list, tuple)):
        if len(value) == 2 and isinstance(value[1], (list, tuple)):
            maybe_text = value[1][0] if value[1] else None
            if isinstance(maybe_text, str):
                cleaned = normalize_text(maybe_text)
                if cleaned:
                    texts.append(cleaned)
        for item in value:
            texts.extend(extract_texts(item))
    return texts


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\n", " ").replace("\r", " ")).strip()


def unique_join(values: list[str]) -> str:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        lowered = value.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        output.append(value)
    return " ".join(output).strip()


def run_ocr(ocr: PaddleOCR, image: Image.Image | None) -> str:
    if image is None:
        return ""
    array = np.array(image.convert("RGB"))
    result = None
    if hasattr(ocr, "ocr"):
        try:
            result = ocr.ocr(array, cls=False)
        except TypeError:
            result = ocr.ocr(array)
    if result is None and hasattr(ocr, "predict"):
        result = ocr.predict(array)
    texts = extract_texts(result)
    return unique_join(texts)


def main() -> int:
    payload = json.load(sys.stdin)
    image_data = base64.b64decode(payload["imageBase64"])
    image = Image.open(io.BytesIO(image_data)).convert("RGB")
    ocr = build_ocr()
    readings: list[dict[str, Any]] = []

    for cell in payload["cells"]:
        name_text = run_ocr(ocr, crop_box(image, cell.get("nameBox")))
        quantity_text = run_ocr(ocr, crop_box(image, cell.get("quantityBox")))
        readings.append(
            {
                "rowId": cell["rowId"],
                "tileIndex": cell["tileIndex"],
                "detectedText": name_text,
                "detectedQuantity": quantity_text or None,
            }
        )

    json.dump(readings, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
