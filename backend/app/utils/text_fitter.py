import math
from typing import List, Dict, Tuple, Any

def get_inscribed_ellipse_bounds(bbox: List[int]) -> Dict[str, float]:
    """
    Computes the maximum inscribed ellipse for a speech bubble bounding box [x, y, w, h].
    Center: (cx, cy) = (x + w/2, y + h/2)
    Semi-major/minor axes: rx = w/2, ry = h/2
    Usable area = pi * rx * ry (approx 78.5% of the bounding rectangle).
    """
    x, y, w, h = bbox
    cx = x + (w / 2.0)
    cy = y + (h / 2.0)
    rx = w / 2.0
    ry = h / 2.0
    area = math.pi * rx * ry
    
    return {
        "cx": cx,
        "cy": cy,
        "rx": rx,
        "ry": ry,
        "usable_area": area,
        "box_area": float(w * h)
    }


def estimate_optimal_font_size(
    text: str,
    bbox: List[int],
    target_occupancy: float = 0.75,
    min_font_size: int = 10,
    max_font_size: int = 48
) -> int:
    """
    Estimates optimal font size using a geometric heuristic prior to frontend rendering.
    Manga font glyphs generally have an average aspect ratio of ~0.60 (width/height).
    Line height is typically 1.15 to 1.25 of font size.
    """
    _, _, w, h = bbox
    usable_width = w * 0.85
    usable_height = h * 0.85
    usable_area = usable_width * usable_height * (math.pi / 4.0)  # Ellipse approximation
    
    char_count = max(len(text), 1)
    # Binary search simulation for target font size
    low = min_font_size
    high = max_font_size
    best_size = min_font_size
    
    while low <= high:
        mid = (low + high) // 2
        # Rough estimated text area for font size 'mid'
        # Average character width approx 0.55 * font_size
        char_w = mid * 0.55
        char_h = mid * 1.20
        total_text_area = char_count * (char_w * char_h)
        
        ratio = total_text_area / max(usable_area, 1.0)
        
        if ratio <= target_occupancy:
            best_size = mid
            low = mid + 1
        else:
            high = mid - 1
            
    return max(min_font_size, min(best_size, max_font_size))


def calculate_occupancy_ratio(
    text_width: float,
    text_height: float,
    bubble_w: float,
    bubble_h: float
) -> float:
    """
    Calculates actual area occupancy ratio within speech bubble boundaries.
    """
    text_area = text_width * text_height
    bubble_area = (bubble_w * bubble_h) * (math.pi / 4.0)  # oval usable area
    if bubble_area <= 0:
        return 0.0
    return min(1.0, text_area / bubble_area)

