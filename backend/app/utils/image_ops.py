import base64
import io
import math
from typing import List, Tuple, Optional
import cv2
import numpy as np
from PIL import Image


def decode_image_from_bytes(data: bytes) -> np.ndarray:
    """
    Decodes raw image bytes into an OpenCV BGR numpy array.
    """
    nparr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Failed to decode image from provided byte stream.")
    return img


def decode_image_from_base64(b64_str: str) -> np.ndarray:
    """
    Decodes a base64 encoded image string (with or without data URI prefix)
    into an OpenCV BGR numpy array.
    """
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    image_bytes = base64.b64decode(b64_str)
    return decode_image_from_bytes(image_bytes)


def encode_image_to_base64(img: np.ndarray, format: str = "webp", quality: int = 90) -> str:
    """
    Encodes an OpenCV BGR image into a base64 data URI string.
    Default format is WebP for optimal compression and fidelity.
    """
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
    """
    Expands a bounding box [x, y, w, h] by padding pixels on all sides,
    clamping safely within image boundaries [0, 0, img_w, img_h].
    """
    x, y, w, h = bbox
    new_x = max(0, x - padding)
    new_y = max(0, y - padding)
    new_w = min(img_w - new_x, w + (2 * padding))
    new_h = min(img_h - new_y, h + (2 * padding))
    return [int(new_x), int(new_y), int(new_w), int(new_h)]


def crop_image(img: np.ndarray, bbox: List[int]) -> np.ndarray:
    """
    Crops a sub-region from an image using [x, y, w, h].
    """
    x, y, w, h = bbox
    img_h, img_w = img.shape[:2]
    x1 = max(0, min(x, img_w - 1))
    y1 = max(0, min(y, img_h - 1))
    x2 = max(x1 + 1, min(x + w, img_w))
    y2 = max(y1 + 1, min(y + h, img_h))
    return img[y1:y2, x1:x2].copy()


def create_text_mask(
    img_shape: Tuple[int, int],
    polygons: List[List[List[int]]],
    dilate_kernel_size: int = 7
) -> np.ndarray:
    """
    Generates a single-channel binary mask (uint8, 0=background, 255=inpaint mask)
    from detected text and bubble polygons, followed by morphological dilation
    to ensure anti-aliasing character fringes and screentone margins are completely erased.
    """
    height, width = img_shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    
    for poly in polygons:
        if not poly or len(poly) < 3:
            continue
        pts = np.array(poly, dtype=np.int32).reshape((-1, 1, 2))
        cv2.fillPoly(mask, [pts], 255)
        
    if dilate_kernel_size > 1:
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (dilate_kernel_size, dilate_kernel_size)
        )
        mask = cv2.dilate(mask, kernel, iterations=1)
        
    return mask


def classify_bubble_contour(
    polygon: List[List[int]],
    bbox: List[int],
    img_crop: Optional[np.ndarray] = None
) -> str:
    """
    Classifies each detected bubble into one of four comic typography styles:
    - 'dialogue': Smooth contour, standard weight.
    - 'shout': Spiky/jagged contour, bold/heavy sans-serif.
    - 'whisper': Dotted/thin contour, italic serif.
    - 'sfx': Naked text overlay, heavy stroke outline.
    
    Heuristic criteria:
    1. Convexity & Solidity: Ratio of contour area to convex hull area.
       - Shout bubbles have spiky projections giving low solidity (< 0.82)
       - Smooth dialogue bubbles have high solidity (> 0.88)
    2. Contour Circularity / Roughness: 4 * pi * Area / (Perimeter^2)
       - Smooth circles/ovals approach 0.70 - 0.90
       - Jagged shout bubbles have large perimeters relative to area (< 0.50)
    3. SFX Heuristic:
       - If no enclosing uniform bubble background is detected (naked text on art),
         or extreme aspect ratio with high standard deviation in the background.
    """
    x, y, w, h = bbox
    aspect_ratio = max(w, 1) / max(h, 1)
    
    if not polygon or len(polygon) < 4:
        # If no detailed polygon, estimate based on aspect ratio and crop characteristics
        if aspect_ratio > 3.0 or aspect_ratio < 0.25:
            return "sfx"
        return "dialogue"

    pts = np.array(polygon, dtype=np.int32)
    area = cv2.contourArea(pts)
    perimeter = cv2.arcLength(pts, closed=True)
    
    if perimeter == 0 or area == 0:
        return "dialogue"
        
    # Convex Hull & Solidity
    hull = cv2.convexHull(pts)
    hull_area = cv2.contourArea(hull)
    solidity = area / max(hull_area, 1e-5)
    
    # Circularity metric
    circularity = (4.0 * math.pi * area) / (perimeter * perimeter)
    
    # Polygon simplification to count prominent vertices
    epsilon = 0.02 * perimeter
    approx = cv2.approxPolyDP(pts, epsilon, True)
    num_vertices = len(approx)

    # SFX / Naked text detection check
    # Check if crop has high contrast text without a solid white background
    if img_crop is not None and img_crop.size > 0:
        gray = cv2.cvtColor(img_crop, cv2.COLOR_BGR2GRAY)
        # Manga bubbles typically have >70% white/bright background pixels
        bright_pixels = np.count_nonzero(gray > 225)
        bright_ratio = bright_pixels / gray.size
        
        # If very low white background, it's floating art text or SFX
        if bright_ratio < 0.35 and area < (w * h * 0.75):
            return "sfx"

    # Spiky / Shout bubble: jagged perimeter, low solidity, many corners
    if solidity < 0.82 or (circularity < 0.42 and num_vertices > 8):
        return "shout"

    # Whisper bubble: dotted or faint thin boundary, or small quiet text
    # Usually marked by elongated or low-opacity dashed boundaries
    if 0.82 <= solidity <= 0.88 and circularity < 0.55:
        return "whisper"
        
    # Smooth dialogue bubble: high convexity, rounded shape
    return "dialogue"

