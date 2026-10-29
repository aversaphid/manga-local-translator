import os
import logging
from typing import List, Dict, Any, Tuple
import cv2
import numpy as np

logger = logging.getLogger(__name__)

class ComicTextDetector:
    """
    Detector wrapper supporting comic-text-detector / DBNet models on CUDA with FP16.
    Extracts text bounding boxes [x, y, w, h], polygon contours, and speech bubbles.
    Includes a robust computer vision heuristic detector for zero-downtime execution.
    """
    def __init__(self, weights_path: str, device: str = "cuda", use_fp16: bool = True):
        self.weights_path = weights_path
        self.device = device
        self.use_fp16 = use_fp16
        self.model = None
        self.is_loaded = False
        
    def load(self):
        """
        Loads the detection model into GPU VRAM with FP16 precision.
        """
        try:
            import torch
            if not torch.cuda.is_available() and self.device == "cuda":
                logger.warning("CUDA not available; falling back to CPU.")
                self.device = "cpu"
                self.use_fp16 = False
                
            if os.path.exists(self.weights_path):
                logger.info(f"Loading ComicTextDetector weights from {self.weights_path}...")
                self.model = torch.jit.load(self.weights_path, map_location=self.device)
                self.model.eval()
                if self.use_fp16 and self.device == "cuda":
                    self.model = self.model.half()
                self.is_loaded = True
                logger.info("ComicTextDetector successfully initialized on GPU (FP16).")
            else:
                logger.warning(
                    f"Weights not found at '{self.weights_path}'. "
                    f"Operating in Computer Vision heuristic mode."
                )
                self.is_loaded = False
        except Exception as e:
            logger.error(f"Failed to load ComicTextDetector model: {e}")
            self.is_loaded = False

    def detect(self, img: np.ndarray, conf_threshold: float = 0.45) -> List[Dict[str, Any]]:
        """
        Performs text & bubble detection on a manga page image (OpenCV BGR).
        """
        if self.is_loaded and self.model is not None:
            return self._detect_pytorch(img, conf_threshold)
        else:
            return self._detect_heuristic(img)

    def _detect_pytorch(self, img: np.ndarray, conf_threshold: float) -> List[Dict[str, Any]]:
        """
        Inference using DBNet / comic-text-detector FP16 tensor pipeline.
        """
        import torch
        img_h, img_w = img.shape[:2]
        
        target_size = 1024
        scale = target_size / max(img_h, img_w)
        resized_w = (int(img_w * scale) // 32) * 32
        resized_h = (int(img_h * scale) // 32) * 32
        
        resized_img = cv2.resize(img, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
        rgb_img = cv2.cvtColor(resized_img, cv2.COLOR_BGR2RGB)
        
        tensor = torch.from_numpy(rgb_img).permute(2, 0, 1).unsqueeze(0).float() / 255.0
        tensor = tensor.to(self.device)
        if self.use_fp16 and self.device == "cuda":
            tensor = tensor.half()
            
        with torch.no_grad():
            preds = self.model(tensor)
            prob_map = preds[0] if isinstance(preds, (list, tuple)) else preds
            prob_map = prob_map.squeeze().float().cpu().numpy()
            
        binary_map = (prob_map > conf_threshold).astype(np.uint8) * 255
        contours, _ = cv2.findContours(binary_map, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        
        results = []
        scale_x = img_w / resized_w
        scale_y = img_h / resized_h
        page_area = img_w * img_h
        
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < 100 or area > (page_area * 0.20):
                continue
                
            rx, ry, rw, rh = cv2.boundingRect(cnt)
            orig_x = int(rx * scale_x)
            orig_y = int(ry * scale_y)
            orig_w = int(rw * scale_x)
            orig_h = int(rh * scale_y)
            
            scaled_poly = [[int(pt[0][0] * scale_x), int(pt[0][1] * scale_y)] for pt in cnt]
                
            results.append({
                "bbox": [orig_x, orig_y, orig_w, orig_h],
                "polygon": scaled_poly,
                "confidence": 0.95
            })
            
        return results

    def _detect_heuristic(self, img: np.ndarray) -> List[Dict[str, Any]]:
        """
        High-precision speech bubble & text region detector.
        Identifies actual speech bubbles by segmenting high-brightness regions
        and filtering for text stroke density. Strict area and boundary checks
        prevent false positive full-page detections.
        """
        img_h, img_w = img.shape[:2]
        page_area = img_w * img_h
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # 1. Detect bright speech bubble backgrounds (manga bubbles are primarily white)
        _, thresh_white = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY)
        
        # Morphological opening removes small noise dots, then closing seals bubble boundaries
        kernel_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        opened = cv2.morphologyEx(thresh_white, cv2.MORPH_OPEN, kernel_open)
        kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        bubble_mask = cv2.morphologyEx(opened, cv2.MORPH_CLOSE, kernel_close)
        
        contours, _ = cv2.findContours(bubble_mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        
        # Strict bubble area boundaries (between 0.15% and 18% of the page)
        min_bubble_area = page_area * 0.0015
        max_bubble_area = page_area * 0.18
        
        results = []
        
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_bubble_area or area > max_bubble_area:
                continue
                
            x, y, w, h = cv2.boundingRect(cnt)
            
            # Reject contours touching multiple image borders (these are outer page margins)
            touch_borders = sum([
                x <= 3,
                y <= 3,
                (x + w) >= (img_w - 3),
                (y + h) >= (img_h - 3)
            ])
            if touch_borders >= 2:
                continue
                
            aspect_ratio = max(w, 1) / max(h, 1)
            if aspect_ratio > 3.5 or aspect_ratio < 0.2:
                continue
                
            # Verify text stroke presence inside the candidate bubble
            crop_gray = gray[y:y+h, x:x+w]
            dark_pixels = np.count_nonzero(crop_gray < 110)
            text_density = dark_pixels / max(crop_gray.size, 1)
            
            # Legitimate comic speech bubbles have between 1.5% and 35% text stroke density
            if 0.015 <= text_density <= 0.35:
                epsilon = 0.015 * cv2.arcLength(cnt, True)
                approx = cv2.approxPolyDP(cnt, epsilon, True)
                poly = [[int(pt[0][0]), int(pt[0][1])] for pt in approx]
                
                results.append({
                    "bbox": [int(x), int(y), int(w), int(h)],
                    "polygon": poly,
                    "confidence": 0.90
                })
                
        # 2. Text line cluster search for floating text / SFX (strictly bounded)
        if len(results) < 2:
            thresh_text = cv2.adaptiveThreshold(
                gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv2.THRESH_BINARY_INV, 15, 8
            )
            # Remove giant borders
            thresh_text[0:4, :] = 0
            thresh_text[-4:, :] = 0
            thresh_text[:, 0:4] = 0
            thresh_text[:, -4:] = 0
            
            kernel_line = cv2.getStructuringElement(cv2.MORPH_RECT, (4, 12))
            dilated = cv2.dilate(thresh_text, kernel_line, iterations=1)
            text_cnts, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            for cnt in text_cnts:
                area = cv2.contourArea(cnt)
                # Text cluster must be modest in size (never exceeding 12% of page)
                if 400 < area < (page_area * 0.12):
                    bx, by, bw, bh = cv2.boundingRect(cnt)
                    if (bw * bh) < (page_area * 0.15) and max(bw, bh) < (max(img_w, img_h) * 0.5):
                        # Avoid duplicates
                        overlap = any(
                            abs(bx - r["bbox"][0]) < 30 and abs(by - r["bbox"][1]) < 30
                            for r in results
                        )
                        if not overlap:
                            poly = [[int(pt[0][0]), int(pt[0][1])] for pt in cnt]
                            results.append({
                                "bbox": [int(bx), int(by), int(bw), int(bh)],
                                "polygon": poly,
                                "confidence": 0.80
                            })
                            
        return results
