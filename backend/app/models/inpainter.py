import os
import logging
from typing import Tuple, Optional
import cv2
import numpy as np

logger = logging.getLogger(__name__)

class LaMaInpainter:
    """
    High-performance LaMa (Large Mask Inpainting) model wrapper for CUDA.
    Erases Japanese text characters while reconstructing intricate manga screentones,
    halftone patterns, and comic linework.
    Runs in FP16 to minimize VRAM footprint.
    """
    def __init__(
        self,
        torchscript_path: str,
        onnx_path: Optional[str] = None,
        device: str = "cuda",
        use_fp16: bool = True
    ):
        self.torchscript_path = torchscript_path
        self.onnx_path = onnx_path
        self.device = device
        self.use_fp16 = use_fp16
        self.model = None
        self.session = None  # ONNX session if used
        self.backend = None  # 'torchscript', 'onnx', or 'opencv_fallback'
        self.is_loaded = False

    def load(self):
        """
        Loads the LaMa inpainting model into GPU memory.
        Prioritizes TorchScript (.pt) on PyTorch CUDA FP16, then ONNX Runtime GPU.
        """
        try:
            import torch
            if not torch.cuda.is_available() and self.device == "cuda":
                logger.warning("CUDA unavailable for Inpainting; switching to CPU.")
                self.device = "cpu"
                self.use_fp16 = False

            # 1. Try TorchScript export
            if os.path.exists(self.torchscript_path):
                logger.info(f"Loading LaMa TorchScript model from {self.torchscript_path}...")
                self.model = torch.jit.load(self.torchscript_path, map_location=self.device)
                self.model.eval()
                if self.use_fp16 and self.device == "cuda":
                    self.model = self.model.half()
                self.backend = "torchscript"
                self.is_loaded = True
                logger.info("LaMa TorchScript initialized on GPU (FP16).")
                return

            # 2. Try ONNX model
            if self.onnx_path and os.path.exists(self.onnx_path):
                import onnxruntime as ort
                logger.info(f"Loading LaMa ONNX model from {self.onnx_path}...")
                providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if self.device == "cuda" else ['CPUExecutionProvider']
                self.session = ort.InferenceSession(self.onnx_path, providers=providers)
                self.backend = "onnx"
                self.is_loaded = True
                logger.info("LaMa ONNX Runtime session initialized.")
                return

            # 3. Fallback to OpenCV Navier-Stokes/Telea inpainting
            logger.warning(
                f"LaMa weights not found at '{self.torchscript_path}'. "
                f"Falling back to OpenCV Navier-Stokes inpainting engine. "
                f"To enable deep screentone reconstruction, download 'big-lama.pt' to: {self.torchscript_path}"
            )
            self.backend = "opencv_fallback"
            self.is_loaded = True
        except Exception as e:
            logger.error(f"Failed to load LaMa model: {e}. Using OpenCV fallback.")
            self.backend = "opencv_fallback"
            self.is_loaded = True

    def inpaint(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """
        Inpaints the regions of 'image' (OpenCV BGR) marked by non-zero values in 'mask' (uint8).
        Only masked pixels are replaced; untouched comic artwork outside the mask is preserved with 100% fidelity.
        """
        if mask is None or np.count_nonzero(mask) == 0:
            return image.copy()

        if self.backend == "torchscript" and self.model is not None:
            return self._inpaint_torchscript(image, mask)
        elif self.backend == "onnx" and self.session is not None:
            return self._inpaint_onnx(image, mask)
        else:
            return self._inpaint_opencv(image, mask)

    def _pad_to_multiple(self, img: np.ndarray, mod: int = 8) -> Tuple[np.ndarray, int, int]:
        """
        Pads an image to dimensions that are multiples of 'mod' (required by convolution down/up-sampling).
        """
        h, w = img.shape[:2]
        pad_h = (mod - (h % mod)) % mod
        pad_w = (mod - (w % mod)) % mod
        if pad_h > 0 or pad_w > 0:
            padded = cv2.copyMakeBorder(img, 0, pad_h, 0, pad_w, cv2.BORDER_REFLECT)
            return padded, pad_h, pad_w
        return img, 0, 0

    def _inpaint_torchscript(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """
        Inpainting execution on PyTorch CUDA with FP16 precision.
        """
        import torch
        orig_h, orig_w = image.shape[:2]
        padded_img, pad_h, pad_w = self._pad_to_multiple(image, 8)
        padded_mask, _, _ = self._pad_to_multiple(mask, 8)

        # Convert to RGB tensor [1, 3, H, W] in [0, 1]
        rgb = cv2.cvtColor(padded_img, cv2.COLOR_BGR2RGB)
        img_tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0).float() / 255.0
        mask_tensor = torch.from_numpy(padded_mask).unsqueeze(0).unsqueeze(0).float() / 255.0
        mask_tensor = (mask_tensor > 0).float()

        img_tensor = img_tensor.to(self.device)
        mask_tensor = mask_tensor.to(self.device)

        if self.use_fp16 and self.device == "cuda":
            img_tensor = img_tensor.half()
            mask_tensor = mask_tensor.half()

        with torch.no_grad():
            inpainted_tensor = self.model(img_tensor, mask_tensor)
            if self.use_fp16:
                inpainted_tensor = inpainted_tensor.float()

            inpainted_np = inpainted_tensor.squeeze(0).permute(1, 2, 0).cpu().numpy()
            inpainted_np = np.clip(inpainted_np * 255.0, 0, 255).astype(np.uint8)
            inpainted_bgr = cv2.cvtColor(inpainted_np, cv2.COLOR_RGB2BGR)

        # Remove padding
        if pad_h > 0 or pad_w > 0:
            inpainted_bgr = inpainted_bgr[:orig_h, :orig_w]

        # Composite: only replace masked pixels
        result = image.copy()
        binary_mask = (mask > 0)
        result[binary_mask] = inpainted_bgr[binary_mask]
        return result

    def _inpaint_onnx(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """
        Inpainting execution using ONNX Runtime GPU.
        """
        orig_h, orig_w = image.shape[:2]
        padded_img, pad_h, pad_w = self._pad_to_multiple(image, 8)
        padded_mask, _, _ = self._pad_to_multiple(mask, 8)

        rgb = cv2.cvtColor(padded_img, cv2.COLOR_BGR2RGB)
        img_input = np.transpose(rgb, (2, 0, 1))[None, ...].astype(np.float32) / 255.0
        mask_input = (padded_mask[None, None, ...].astype(np.float32) / 255.0 > 0).astype(np.float32)

        inputs = {
            self.session.get_inputs()[0].name: img_input,
            self.session.get_inputs()[1].name: mask_input
        }
        outputs = self.session.run(None, inputs)
        res = np.clip(outputs[0][0].transpose((1, 2, 0)) * 255.0, 0, 255).astype(np.uint8)
        res_bgr = cv2.cvtColor(res, cv2.COLOR_RGB2BGR)

        if pad_h > 0 or pad_w > 0:
            res_bgr = res_bgr[:orig_h, :orig_w]

        result = image.copy()
        result[mask > 0] = res_bgr[mask > 0]
        return result

    def _inpaint_opencv(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """
        Fast, clean OpenCV Navier-Stokes inpainting fallback.
        Preserves original artwork outside the text mask.
        """
        inpainted = cv2.inpaint(image, mask, inpaintRadius=4, flags=cv2.INPAINT_NS)
        result = image.copy()
        result[mask > 0] = inpainted[mask > 0]
        return result

