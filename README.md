# Local GPU Manga Translation Web Extension & Pipeline

An end-to-end, fully local, GPU-accelerated manga translation tool engineered for Windows 11 and NVIDIA RTX 40-Series GPUs (12GB VRAM, CUDA 12.x).

---

## 1. System Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                      Browser (Manifest V3 Extension)                   │
│                                                                        │
│  [Manga Reader Page]  ──>  [MutationObserver / ResizeObserver]         │
│                                   │                                    │
│                                   ▼                                    │
│                      [content.js (DOM Overlay)]                        │
│                                   │                                    │
│                          (CORS-free fetch)                             │
│                                   │                                    │
│                                   ▼                                    │
│                         [background.js (Worker)]                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ POST /translate-page
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Local Backend Engine (FastAPI + CUDA)                │
│                                                                        │
│  1. Comic Text Detector   ──> Extract bboxes & bubble polygons (FP16)  │
│  2. Manga-OCR             ──> Transcribe Japanese text via ViT on CUDA │
│  3. LaMa Inpainting       ──> Erase text & restore screentones (FP16)  │
│  4. Local 4-bit LLM       ──> Context-aware dialogue translation       │
│  5. Typography Classifier ──> dialogue | shout | whisper | sfx         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ JSON Response (clean_image_base64 + bubbles)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Typesetting & Overlay (renderer.js)                │
│                                                                        │
│  - Clean Inpainted Canvas Base                                         │
│  - Binary-Search Font Auto-Fitter (70%–80% bubble occupancy)           │
│  - Authentic Manga White Stroke Contrast (-webkit-text-stroke)         │
│  - Comic Typography Styles (Anime Ace, Komika Axis)                    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Directory Layout

```text
manga-local-translator/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py            # FastAPI endpoints (/health, /translate-page)
│   │   ├── config.py          # Model paths, VRAM limits (10GB ceiling), CUDA config
│   │   ├── models/
│   │   │   ├── __init__.py
│   │   │   ├── detector.py    # Comic text detection wrapper (DBNet/CV heuristic)
│   │   │   ├── ocr.py         # Manga-OCR ViT runner
│   │   │   ├── inpainter.py   # LaMa inpainting inference (TorchScript/ONNX/FP16)
│   │   │   └── translator.py  # Local 4-bit quantized LLM interface (Qwen2.5/Gemma)
│   │   └── utils/
│   │       ├── __init__.py
│   │       ├── image_ops.py   # Crop, 4px padding, mask dilation, contour classifier
│   │       └── text_fitter.py # Coordinate scaling, ellipse math & occupancy heuristics
│   ├── weights/               # Local model weights directory
│   ├── requirements.txt       # Python dependencies with CUDA 12 instructions
│   ├── setup_env.bat          # Automated venv creation & PyTorch CUDA setup
│   └── run_server.bat         # Windows launcher for FastAPI Uvicorn server
└── extension/
    ├── manifest.json          # Manifest V3 specification
    ├── background.js          # Service worker (CORS image fetching, API proxy)
    ├── content.js             # Non-destructive ResizeObserver overlay & floating dock
    ├── renderer.js            # Canvas typesetting & binary search font auto-fitter
    ├── styles.css             # Glassmorphism toolbar, typography & overlay styles
    ├── popup/
    │   ├── popup.html         # Hardware monitor & configuration panel
    │   ├── popup.js           # Live VRAM meter & settings sync
    │   └── popup.css          # Dark glassmorphism popup theme
    └── assets/
        ├── icon16.png, icon48.png, icon128.png
        └── fonts/             # Embedded open comic fonts (Anime Ace, Komika Axis)
```

---

## 3. Hardware Budget & VRAM Allocation

Target Hardware: **Windows 11, NVIDIA GeForce RTX 4070 (12GB VRAM), CUDA 12.x**

| Component | Architecture | Precision / Quantization | VRAM Footprint |
| :--- | :--- | :--- | :--- |
| **Comic Text Detector** | DBNet / Manga-Detector | PyTorch FP16 | ~0.8 GB |
| **Manga-OCR** | Vision Transformer (ViT) | PyTorch FP16 | ~0.9 GB |
| **LaMa Inpainter** | Fast Large Mask Inpainting | TorchScript / ONNX FP16 | ~1.4 GB |
| **Translation LLM** | Qwen2.5-7B-Instruct | GGUF Q4_K_M (full GPU offload) | ~4.5 GB |
| **PyTorch Context / Buffers** | CUDA runtime & scratch buffers | Dynamic | ~0.6 GB |
| **TOTAL PERSISTENT VRAM** | | | **~8.2 GB** *(< 10 GB limit)* |

---

## 4. Quickstart Guide

### Step 1: Install & Launch Backend
1. Open PowerShell / Command Prompt in `backend/`:
   ```cmd
   cd backend
   setup_env.bat
   ```
2. Start the GPU server:
   ```cmd
   run_server.bat
   ```
3. Test health check in your browser: `http://localhost:8000/health`

### Step 2: Download Model Weights (Optional for Full Deep Learning)
The backend includes built-in computer vision heuristics and fallback translators, so it functions immediately out-of-the-box. To enable state-of-the-art deep learning models:
- **Comic Text Detector**: Place `comictextdetector.pt` in `backend/weights/`
- **LaMa Inpainting**: Place `big-lama.pt` or `lama.onnx` in `backend/weights/`
- **Qwen2.5 7B GGUF**: Place `Qwen2.5-7B-Instruct-Q4_K_M.gguf` in `backend/weights/`

### Step 3: Install Chrome Extension (Manifest V3)
1. Open Google Chrome or any Chromium browser.
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `manga-local-translator/extension` folder.
5. Open any manga website (e.g. MangaDex).
6. Click the floating **⚡ Translate View** button on the bottom-right corner!

