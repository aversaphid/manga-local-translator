import base64
import io
import math
from typing import List, Tuple, Optional, Dict, Any
import cv2
import numpy as np
from PIL import Image

def decode_image_from_bytes(data: bytes) -> np.ndarray:
    nparr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Failed to decode image from provided byte stream.")
    return img

def decode_image_from_base64(b64_str: str) -> np.ndarray:
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    image_bytes = base64.b64decode(b64_str)
    return decode_image_from_bytes(image_bytes)

def encode_image_to_base64(img: np.ndarray, format: str = "webp", quality: int = 90) -> str:
    fmt = format.lower().strip(".")
    if fmt == "webp":
        ext = ".webp"
        encode_params = [int(cv2.IMWRITE_WEBP_QUALITY), quality]
    elif fmt in ["jpg", "jpeg"]:
        ext = ".jpg"
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), quality]
    else:
        ext = ".png"
        encode_params = [int(cv2.IMWRITE_PNG_COMPRESSION), 4]
        
    success, buffer = cv2.imencode(ext, img, encode_params)
    if not success:
        raise ValueError(f"Failed to encode image to format: {format}")
        
    encoded_b64 = base64.b64encode(buffer).decode("utf-8")
    mime = "image/webp" if fmt == "webp" else ("image/jpeg" if fmt in ["jpg", "jpeg"] else "image/png")
    return f"data:{mime};base64,{encoded_b64}"

def expand_bbox(bbox: List[int], padding: int, img_w: int, img_h: int) -> List[int]:
    x, y, w, h = bbox
    new_x = max(0, x - padding)
    new_y = max(0, y - padding)
    new_w = min(img_w - new_x, w + (2 * padding))
    new_h = min(img_h - new_y, h + (2 * padding))
    return [int(new_x), int(new_y), int(new_w), int(new_h)]

def crop_image(img: np.ndarray, bbox: List[int]) -> np.ndarray:
    x, y, w, h = bbox
    img_h, img_w = img.shape[:2]
    x1 = max(0, min(x, img_w - 1))
    y1 = max(0, min(y, img_h - 1))
    x2 = max(x1 + 1, min(x + w, img_w))
    y2 = max(y1 + 1, min(y + h, img_h))
    return img[y1:y2, x1:x2].copy()

def create_text_character_mask(
    img: np.ndarray,
    detections: List[Dict[str, Any]],
    dilate_kernel_size: int = 3
) -> np.ndarray:
    """
    Creates a stroke-level inpainting mask.
    Instead of masking the entire speech bubble (which causes massive smearing),
    it isolates ONLY the dark character glyphs (text strokes) inside each bubble.
    This preserves 100% of the surrounding manga linework, screentones, and illustrations.
    """
    height, width = img.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    kernel_dilate = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_kernel_size, dilate_kernel_size))

    for det in detections:
        bx, by, bw, bh = det["bbox"]
        if bw <= 0 or bh <= 0:
            continue

        x1 = max(0, bx)
        y1 = max(0, by)
        x2 = min(width, bx + bw)
        y2 = min(height, by + bh)

        crop_gray = gray[y1:y2, x1:x2]
        if crop_gray.size == 0:
            continue

        # In manga, text consists of dark ink strokes
        # Isolate text strokes: pixels significantly darker than the surrounding bubble background
        mean_val = np.mean(crop_gray)
        if mean_val > 180:
            # White bubble: text is dark pixels < 130
            text_pixels = (crop_gray < 135).astype(np.uint8) * 255
        else:
            # Dark/tone background: adaptive threshold
            text_pixels = cv2.adaptiveThreshold(
                crop_gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                cv2.THRESH_BINARY_INV, 15, 6
            )

        # Dilate slightly so glyph edge anti-aliasing is covered
        text_dilated = cv2.dilate(text_pixels, kernel_dilate, iterations=1)
        mask[y1:y2, x1:x2] = np.maximum(mask[y1:y2, x1:x2], text_dilated)

    return mask

def classify_bubble_contour(
    polygon: List[List[int]],
    bbox: List[int],
    img_crop: Optional[np.ndarray] = None
) -> str:
    x, y, w, h = bbox
    aspect_ratio = max(w, 1) / max(h, 1)
    
    if not polygon or len(polygon) < 4:
        if aspect_ratio > 3.0 or aspect_ratio < 0.25:
            return "sfx"
        return "dialogue"

    pts = np.array(polygon, dtype=np.int32)
    area = cv2.contourArea(pts)
    perimeter = cv2.arcLength(pts, closed=True)
    
    if perimeter == 0 or area == 0:
        return "dialogue"
        
    hull = cv2.convexHull(pts)
    hull_area = cv2.contourArea(hull)
    solidity = area / max(hull_area, 1e-5)
    circularity = (4.0 * math.pi * area) / (perimeter * perimeter)
    
    epsilon = 0.02 * perimeter
    approx = cv2.approxPolyDP(pts, epsilon, True)
    num_vertices = len(approx)

    if img_crop is not None and img_crop.size > 0:
        gray = cv2.cvtColor(img_crop, cv2.COLOR_BGR2GRAY)
        bright_pixels = np.count_nonzero(gray > 225)
        bright_ratio = bright_pixels / gray.size
        if bright_ratio < 0.35 and area < (w * h * 0.75):
            return "sfx"

    if solidity < 0.82 or (circularity < 0.42 and num_vertices > 8):
        return "shout"

    if 0.82 <= solidity <= 0.88 and circularity < 0.55:
        return "whisper"
        
    return "dialogue"
