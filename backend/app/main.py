import logging
import time
from typing import Dict, Any, Optional, List
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.config import settings, get_gpu_memory_status
from app.utils.image_ops import (
    decode_image_from_bytes,
    decode_image_from_base64,
    encode_image_to_base64,
    expand_bbox,
    crop_image,
    create_text_mask,
    classify_bubble_contour
)
from app.models.detector import ComicTextDetector
from app.models.ocr import MangaOcrRunner
from app.models.inpainter import LaMaInpainter
from app.models.translator import LocalLlmTranslator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("manga-translator")

app = FastAPI(
    title="Local GPU Manga Translation Server",
    description="High-performance CUDA inference pipeline for comic text detection, Manga-OCR, LaMa inpainting, and LLM translation.",
    version="1.0.0"
)

# Enable CORS for browser extension access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Model instances (Modular lazy-loaded to verify VRAM allocation cleanly)
detector = ComicTextDetector(
    weights_path=settings.DETECTOR_WEIGHTS_PATH,
    device=settings.DEVICE,
    use_fp16=settings.USE_FP16
)
ocr_engine = MangaOcrRunner(
    pretrained_model=settings.MANGA_OCR_PRETRAINED,
    device=settings.DEVICE
)
inpainter = LaMaInpainter(
    torchscript_path=settings.LAMA_MODEL_PATH,
    onnx_path=settings.LAMA_ONNX_PATH,
    device=settings.DEVICE,
    use_fp16=settings.USE_FP16
)
translator = LocalLlmTranslator(
    model_path=settings.LLM_GGUF_PATH,
    n_gpu_layers=settings.LLM_GPU_LAYERS,
    n_ctx=settings.LLM_CONTEXT_SIZE,
    temperature=settings.LLM_TEMPERATURE
)

models_initialized = False

def initialize_models():
    """
    Initializes models and checks VRAM consumption against the 10 GB budget ceiling.
    """
    global models_initialized
    if models_initialized:
        return
        
    logger.info("Initializing GPU translation pipeline models...")
    detector.load()
    ocr_engine.load()
    inpainter.load()
    translator.load()
    
    mem_status = get_gpu_memory_status()
    logger.info(
        f"Pipeline initialized. Current VRAM: {mem_status['reserved_mb']} MB / "
        f"Ceiling: {mem_status['budget_ceiling_mb']} MB (Within budget: {mem_status['within_budget']})"
    )
    models_initialized = True

@app.on_event("startup")
async def startup_event():
    logger.info("Starting Manga Local Translation Service...")
    initialize_models()

class TranslationRequest(BaseModel):
    image: Optional[str] = None  # Base64 data URI or bare base64 string

class BubbleResponse(BaseModel):
    id: str
    bbox: List[int]
    polygon: List[List[int]]
    style: str
    japanese_raw: str
    english_translation: str

class TranslationResponse(BaseModel):
    clean_image_base64: str
    bubbles: List[BubbleResponse]
    processing_time_ms: float

@app.get("/health")
def health_check() -> Dict[str, Any]:
    """
    Returns GPU status, VRAM usage, and model warm-up status.
    Ensures persistent VRAM usage is strictly monitored under 10 GB.
    """
    vram_info = get_gpu_memory_status()
    return {
        "status": "healthy",
        "device": settings.DEVICE,
        "fp16_enabled": settings.USE_FP16,
        "vram": vram_info,
        "models": {
            "detector": "loaded (FP16)" if detector.is_loaded else "CV heuristic fallback",
            "ocr": "loaded (Manga-OCR ViT)" if ocr_engine.is_loaded else "mock fallback",
            "inpainter": f"loaded ({inpainter.backend})" if inpainter.is_loaded else "offline",
            "translator": "loaded (Qwen2.5 4-bit)" if translator.is_loaded else "mock fallback"
        }
    }

@app.post("/translate-page", response_model=TranslationResponse)
async def translate_page(
    request: Request,
    file: Optional[UploadFile] = File(None)
):
    """
    End-to-end manga page translation pipeline:
    1. Ingest image (multipart file upload or JSON base64)
    2. Detect comic speech bubbles & text polygons
    3. Crop with 4px padding & transcribe with Manga-OCR
    4. Classify typography styles (dialogue, shout, whisper, sfx)
    5. Clean background using LaMa inpainting
    6. Batch translate dialogue preserving context with local LLM
    7. Return clean base64 image and bubble metadata
    """
    start_time = time.time()
    initialize_models()
    
    # 1. Image Ingestion
    img = None
    if file:
        content = await file.read()
        img = decode_image_from_bytes(content)
    else:
        try:
            body = await request.json()
            b64_str = body.get("image")
            if not b64_str:
                raise HTTPException(status_code=400, detail="No image provided in request body.")
            img = decode_image_from_base64(b64_str)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to read image payload: {e}")

    if img is None or img.size == 0:
        raise HTTPException(status_code=400, detail="Invalid image payload.")

    img_h, img_w = img.shape[:2]

    # 2. Text & Bubble Detection
    detections = detector.detect(img, conf_threshold=settings.DETECTOR_CONF_THRESHOLD)

    # 3. OCR Transcription, Crop Padding, & Style Classification
    bubbles_data = []
    polygons_for_inpainting = []

    for idx, det in enumerate(detections):
        orig_bbox = det["bbox"]
        poly = det.get("polygon", [])
        bubble_id = f"bubble_{idx}"

        # Expand bounding box by 4px padding
        padded_bbox = expand_bbox(orig_bbox, settings.DETECTOR_EXPAND_PADDING_PX, img_w, img_h)
        crop = crop_image(img, padded_bbox)

        # Transcribe Japanese text
        japanese_text = ocr_engine.transcribe(crop)

        # Bubble typography classification
        style = classify_bubble_contour(poly, orig_bbox, crop)

        bubbles_data.append({
            "id": bubble_id,
            "bbox": orig_bbox,
            "polygon": poly,
            "style": style,
            "japanese_raw": japanese_text,
            "english_translation": ""
        })

        # Register polygon for inpainting mask
        if poly and len(poly) >= 3:
            polygons_for_inpainting.append(poly)
        else:
            # Fallback to rect polygon if contour is empty
            bx, by, bw, bh = orig_bbox
            rect_poly = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]]
            polygons_for_inpainting.append(rect_poly)

    # 4. Inpainting / Clean Background Fill
    text_mask = create_text_mask(
        (img_h, img_w),
        polygons_for_inpainting,
        dilate_kernel_size=settings.LAMA_MASK_DILATION_KERNEL
    )
    clean_img = inpainter.inpaint(img, text_mask)

    # 5. Batched LLM Dialogue Translation
    translated_bubbles = translator.translate_batch(bubbles_data)

    # 6. Encode Clean Inpainted Image to WebP
    clean_b64 = encode_image_to_base64(clean_img, format="webp", quality=90)
    processing_time = round((time.time() - start_time) * 1000, 2)

    return {
        "clean_image_base64": clean_b64,
        "bubbles": translated_bubbles,
        "processing_time_ms": processing_time
    }

