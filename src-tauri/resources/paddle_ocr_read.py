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


def parse_recognition_segments(value: Any) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    if value is None:
        return segments
    if isinstance(value, dict):
        texts = value.get("rec_texts")
        boxes = value.get("rec_boxes")
        scores = value.get("rec_scores")
        if isinstance(texts, list):
            for index, text in enumerate(texts):
                if not isinstance(text, str):
                    continue
                cleaned = normalize_text(text)
                if not cleaned:
                    continue
                score = 0.0
                if isinstance(scores, list) and index < len(scores):
                    try:
                        score = float(scores[index])
                    except Exception:
                        score = 0.0
                bbox = parse_box(boxes[index]) if isinstance(boxes, (list, tuple)) and index < len(boxes) else None
                segments.append(
                    {
                        "text": cleaned,
                        "score": score,
                        "bbox": bbox,
                    }
                )
        return segments
    if isinstance(value, (list, tuple)):
        for item in value:
            segments.extend(parse_recognition_segments(item))
    return segments


def parse_box(box: Any) -> dict[str, float] | None:
    if box is None:
        return None
    try:
        array = np.asarray(box, dtype=float)
    except Exception:
        return None
    if array.size == 0:
        return None
    if array.ndim == 1 and array.size >= 4:
        x_values = [float(array[0]), float(array[2])]
        y_values = [float(array[1]), float(array[3])]
    elif array.ndim >= 2 and array.shape[-1] >= 2:
        flattened = array.reshape(-1, array.shape[-1])
        x_values = [float(point[0]) for point in flattened]
        y_values = [float(point[1]) for point in flattened]
    else:
        return None
    left = min(x_values)
    right = max(x_values)
    top = min(y_values)
    bottom = max(y_values)
    return {
        "left": left,
        "right": right,
        "top": top,
        "bottom": bottom,
        "center_x": (left + right) / 2,
        "center_y": (top + bottom) / 2,
        "height": max(1.0, bottom - top),
    }


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


def group_segments_into_lines(segments: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    ordered = sorted(
        segments,
        key=lambda segment: (
            segment["bbox"]["center_y"] if segment["bbox"] else 0.0,
            segment["bbox"]["center_x"] if segment["bbox"] else 0.0,
        ),
    )
    lines: list[list[dict[str, Any]]] = []
    for segment in ordered:
        bbox = segment.get("bbox")
        if bbox is None:
            lines.append([segment])
            continue
        placed = False
        for line in lines:
            line_bboxes = [item["bbox"] for item in line if item.get("bbox") is not None]
            if not line_bboxes:
                continue
            mean_center_y = sum(item["center_y"] for item in line_bboxes) / len(line_bboxes)
            max_height = max(item["height"] for item in line_bboxes + [bbox])
            if abs(bbox["center_y"] - mean_center_y) <= max_height * 0.65:
                line.append(segment)
                placed = True
                break
        if not placed:
            lines.append([segment])
    for line in lines:
        line.sort(key=lambda segment: segment["bbox"]["center_x"] if segment.get("bbox") else 0.0)
    lines.sort(
        key=lambda line: min(
            (segment["bbox"]["top"] if segment.get("bbox") else 0.0) for segment in line
        )
    )
    return lines


def build_name_text(segments: list[dict[str, Any]]) -> str:
    if not segments:
        return ""
    lines = group_segments_into_lines(segments)
    line_texts = [unique_join([segment["text"] for segment in line]) for line in lines]
    return unique_join([line for line in line_texts if line])


def build_quantity_text(segments: list[dict[str, Any]]) -> str | None:
    if not segments:
        return None
    ordered = build_name_text(segments)
    digits = re.findall(r"\d+", ordered)
    if digits:
        return "".join(digits)
    for segment in segments:
        digits = re.findall(r"\d+", segment["text"])
        if digits:
            return "".join(digits)
    return None


def run_ocr(ocr: PaddleOCR, image: Image.Image | None, mode: str) -> str | None:
    if image is None:
        return None
    array = np.array(image.convert("RGB"))
    result = None
    if hasattr(ocr, "ocr"):
        try:
            result = ocr.ocr(array, cls=False)
        except TypeError:
            result = ocr.ocr(array)
    if result is None and hasattr(ocr, "predict"):
        result = ocr.predict(array)
    segments = parse_recognition_segments(result)
    if mode == "quantity":
        return build_quantity_text(segments)
    return build_name_text(segments)


def main() -> int:
    payload = json.load(sys.stdin)
    image_data = base64.b64decode(payload["imageBase64"])
    image = Image.open(io.BytesIO(image_data)).convert("RGB")
    ocr = build_ocr()
    readings: list[dict[str, Any]] = []

    for cell in payload["cells"]:
        name_text = run_ocr(ocr, crop_box(image, cell.get("nameBox")), "name")
        quantity_text = run_ocr(ocr, crop_box(image, cell.get("quantityBox")), "quantity")
        readings.append(
            {
                "rowId": cell["rowId"],
                "tileIndex": cell["tileIndex"],
                "detectedText": name_text or "",
                "detectedQuantity": quantity_text or None,
            }
        )

    json.dump(readings, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
