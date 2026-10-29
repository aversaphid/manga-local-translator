import os
from pathlib import Path
from pydantic_settings import BaseSettings
from typing import List, Dict, Any

class Settings(BaseSettings):
    # Server configuration
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    DEBUG: bool = False
    
    # Target Hardware & Precision
    DEVICE: str = "cuda"  # "cuda" or "cpu"
    USE_FP16: bool = True
    MAX_VRAM_BUDGET_MB: float = 10240.0  # 10.0 GB strict persistent VRAM ceiling
    
    # Base paths
    BASE_DIR: Path = Path(__file__).resolve().parent.parent
    WEIGHTS_DIR: Path = BASE_DIR / "weights"
    
    # Model Weights & Hugging Face Checkpoints
    # 1. Comic Text Detector
    DETECTOR_WEIGHTS_PATH: str = str(WEIGHTS_DIR / "comictextdetector.pt")
    DETECTOR_CONF_THRESHOLD: float = 0.45
    DETECTOR_EXPAND_PADDING_PX: int = 4
    
    # 2. Manga OCR
    MANGA_OCR_PRETRAINED: str = "kha-white/manga-ocr-base"
    
    # 3. LaMa Inpainting
    LAMA_MODEL_PATH: str = str(WEIGHTS_DIR / "big-lama.pt")
    LAMA_ONNX_PATH: str = str(WEIGHTS_DIR / "lama.onnx")
    LAMA_MASK_DILATION_KERNEL: int = 7
    
    # 4. Local Quantized Translation LLM (Qwen2.5-7B-Instruct Q4_K_M GGUF)
    LLM_GGUF_PATH: str = str(WEIGHTS_DIR / "Qwen2.5-7B-Instruct-Q4_K_M.gguf")
    LLM_GPU_LAYERS: int = -1  # Offload all layers to GPU
    LLM_CONTEXT_SIZE: int = 4096
    LLM_TEMPERATURE: float = 0.3
    
    # Typography & Bubble Area Constraints
    MIN_BUBBLE_OCCUPANCY: float = 0.65
    MAX_BUBBLE_OCCUPANCY: float = 0.85
    
    # CORS Configuration
    CORS_ORIGINS: List[str] = [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "chrome-extension://*",
        "*"
    ]

    class Config:
        env_file = ".env"
        case_sensitive = True

settings = Settings()

# Ensure weights directory exists
os.makedirs(settings.WEIGHTS_DIR, exist_ok=True)


def get_gpu_memory_status() -> Dict[str, Any]:
    """
    Query real-time VRAM usage from PyTorch CUDA runtime.
    Falls back gracefully if CUDA is not initialized.
    """
    try:
        import torch
        if torch.cuda.is_available():
            device_idx = 0
            dev_name = torch.cuda.get_device_name(device_idx)
            total_mem = torch.cuda.get_device_properties(device_idx).total_memory / (1024 ** 2)
            allocated_mem = torch.cuda.memory_allocated(device_idx) / (1024 ** 2)
            reserved_mem = torch.cuda.memory_reserved(device_idx) / (1024 ** 2)
            free_mem = total_mem - reserved_mem
            
            return {
                "cuda_available": True,
                "device_name": dev_name,
                "allocated_mb": round(allocated_mem, 2),
                "reserved_mb": round(reserved_mem, 2),
                "total_mb": round(total_mem, 2),
                "free_mb": round(free_mem, 2),
                "budget_ceiling_mb": settings.MAX_VRAM_BUDGET_MB,
                "within_budget": reserved_mem <= settings.MAX_VRAM_BUDGET_MB
            }
    except Exception as e:
        pass
        
    return {
        "cuda_available": False,
        "device_name": "CPU Fallback",
        "allocated_mb": 0.0,
        "reserved_mb": 0.0,
        "total_mb": 0.0,
        "free_mb": 0.0,
        "budget_ceiling_mb": settings.MAX_VRAM_BUDGET_MB,
        "within_budget": True
    }

