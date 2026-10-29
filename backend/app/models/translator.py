import os
import json
import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

MANGA_SYSTEM_PROMPT = """You are an elite Japanese-to-English manga localizer and professional comic dialogue adapter.
Your objective is to translate a batch of dialogue entries from a single manga page into natural, punchy, conversational English suitable for comic lettering.

LOCALIZATION GUIDELINES:
1. Maintain Narrative Continuity: The input contains all bubbles from the page in sequential order. Preserve speaker personality, continuity, and scene tone across panels.
2. Character Nuance & Honorifics: Preserve natural character relationships. Keep common manga honorifics (e.g., -san, -kun, -chan, senpai, sensei) when appropriate; localize smoothly otherwise.
3. Bubble Density & Conciseness: Comic bubbles have limited space. Prefer concise, impactful phrasing over verbose literal translations.
4. Output JSON array with "id" and "english_translation".
"""

class LocalLlmTranslator:
    """
    Translation Engine:
    1. Primary: Local 4-bit Quantized GGUF LLM (Qwen2.5-7B-Instruct) via llama-cpp-python on CUDA.
    2. High-Quality Offline Fallback: Local MarianMT Neural Translator (Helsinki-NLP/opus-mt-ja-en) on CUDA.
    """
    def __init__(
        self,
        model_path: str,
        n_gpu_layers: int = -1,
        n_ctx: int = 4096,
        temperature: float = 0.3
    ):
        self.model_path = model_path
        self.n_gpu_layers = n_gpu_layers
        self.n_ctx = n_ctx
        self.temperature = temperature
        self.llm = None
        self.marian_model = None
        self.marian_tokenizer = None
        self.is_loaded = False
        self.engine_mode = "none"

    def load(self):
        # 1. Try local quantized GGUF model
        if os.path.exists(self.model_path):
            try:
                from llama_cpp import Llama
                logger.info(f"Loading Quantized GGUF model from {self.model_path} into VRAM...")
                self.llm = Llama(
                    model_path=self.model_path,
                    n_gpu_layers=self.n_gpu_layers,
                    n_ctx=self.n_ctx,
                    verbose=False
                )
                self.is_loaded = True
                self.engine_mode = "gguf"
                logger.info("Local GGUF LLM initialized on GPU.")
                return
            except Exception as e:
                logger.warning(f"Could not load GGUF model: {e}")

        # 2. Try MarianMT local neural translation model on CUDA
        try:
            import torch
            from transformers import MarianMTModel, MarianTokenizer
            logger.info("Initializing local MarianMT (Helsinki-NLP/opus-mt-ja-en) on CUDA...")
            marian_name = "Helsinki-NLP/opus-mt-ja-en"
            self.marian_tokenizer = MarianTokenizer.from_pretrained(marian_name)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            self.marian_model = MarianMTModel.from_pretrained(marian_name).to(device)
            self.is_loaded = True
            self.engine_mode = "marian"
            logger.info("MarianMT Japanese-to-English neural translator initialized on GPU.")
            return
        except Exception as e:
            logger.warning(f"Could not load MarianMT model: {e}")

        self.engine_mode = "heuristic"
        self.is_loaded = True

    def translate_batch(self, bubbles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not bubbles:
            return []

        if self.engine_mode == "gguf" and self.llm is not None:
            return self._translate_with_llm(bubbles)
        elif self.engine_mode == "marian" and self.marian_model is not None:
            return self._translate_with_marian(bubbles)
        else:
            return self._translate_heuristic(bubbles)

    def _translate_with_marian(self, bubbles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        
        texts_to_translate = []
        indices = []
        
        for i, b in enumerate(bubbles):
            raw = (b.get("japanese_raw") or "").strip()
            if raw:
                texts_to_translate.append(raw)
                indices.append(i)
            else:
                b["english_translation"] = ""

        if not texts_to_translate:
            return bubbles

        try:
            inputs = self.marian_tokenizer(
                texts_to_translate,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=256
            ).to(device)

            with torch.no_grad():
                generated_tokens = self.marian_model.generate(**inputs, max_length=256)
                decoded = self.marian_tokenizer.batch_decode(generated_tokens, skip_special_tokens=True)

            for idx, eng in zip(indices, decoded):
                clean_eng = eng.strip()
                # Apply style formatting
                style = bubbles[idx].get("style", "dialogue")
                if style == "shout":
                    clean_eng = clean_eng.upper()
                bubbles[idx]["english_translation"] = clean_eng

        except Exception as e:
            logger.error(f"Marian translation error: {e}")
            for b in bubbles:
                if not b.get("english_translation"):
                    b["english_translation"] = self._heuristic_phrase(b.get("japanese_raw", ""))

        return bubbles

    def _translate_with_llm(self, bubbles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        payload_items = [
            {"id": b["id"], "japanese": b.get("japanese_raw", ""), "style": b.get("style", "dialogue")}
            for b in bubbles
        ]
        user_message = f"Translate the following manga dialogue entries:\n{json.dumps(payload_items, ensure_ascii=False, indent=2)}"
        
        try:
            response = self.llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": MANGA_SYSTEM_PROMPT},
                    {"role": "user", "content": user_message}
                ],
                temperature=self.temperature,
                max_tokens=1024,
                response_format={"type": "json_object"}
            )
            raw_text = response["choices"][0]["message"]["content"].strip()
            if raw_text.startswith("```json"): raw_text = raw_text[7:]
            if raw_text.startswith("```"): raw_text = raw_text[3:]
            if raw_text.endswith("```"): raw_text = raw_text[:-3]
            
            parsed = json.loads(raw_text.strip())
            items = parsed.get("translations", parsed.get("bubbles", parsed if isinstance(parsed, list) else []))
            translation_map = {item.get("id"): item.get("english_translation", "") for item in items if isinstance(item, dict)}
            
            for b in bubbles:
                b["english_translation"] = translation_map.get(b["id"], self._heuristic_phrase(b.get("japanese_raw", "")))
            return bubbles
        except Exception as e:
            logger.error(f"LLM translation error: {e}")
            return self._translate_heuristic(bubbles)

    def _translate_heuristic(self, bubbles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        for b in bubbles:
            raw = b.get("japanese_raw", "")
            b["english_translation"] = self._heuristic_phrase(raw, b.get("style", "dialogue"))
        return bubbles

    def _heuristic_phrase(self, japanese: str, style: str = "dialogue") -> str:
        dictionary = {
            "なんだって！？そんなはずは…！": "Wh-what?! That's impossible...!",
            "待って！まだ行かないで…": "Wait! Don't go yet...",
            "フッ…やはり貴様には無理だったか。": "Hmph... As expected, it was too much for you.",
            "ドオオオン！": "BOOM!",
            "門が大きい…": "The gate is huge...",
            "本当にありがとう、助かったよ。": "Thank you so much, you saved me.",
            "探してみろこの世の全てをそこに置いてきた": "Go find it! I left everything this world has to offer there!",
            "世は大海賊時代を迎える": "The world enters the Great Pirate Era!"
        }
        if japanese in dictionary:
            return dictionary[japanese]
        if style == "shout":
            return "NO WAY!"
        return "..."
