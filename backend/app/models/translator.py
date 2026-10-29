import os
import json
import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

MANGA_SYSTEM_PROMPT = """You are an elite Japanese-to-English manga localizer and professional comic dialogue adapter.
Your objective is to translate a batch of dialogue entries from a single manga page into natural, punchy, conversational English suitable for comic lettering.

LOCALIZATION GUIDELINES:
1. Maintain Narrative Continuity: The input contains all bubbles from the page in sequential order. Preserve speaker personality, continuity, and scene tone across panels.
2. Character Nuance & Honorifics: Preserve natural character relationships. Keep common manga honorifics (e.g., -san, -kun, -chan, senpai, sensei) when appropriate to the character's dynamic; localize smoothly otherwise.
3. Bubble Density & Conciseness: Comic bubbles have limited space. Prefer concise, impactful phrasing over verbose literal translations.
4. Typography Style Cues:
   - 'dialogue': Natural speech rhythm.
   - 'shout': Punchy, high-energy, capitalized exclamations (e.g., "NO WAY!", "GET DOWN!").
   - 'whisper': Soft, quiet, muttered internal thoughts or trailing ellipses.
   - 'sfx': Dynamic comic onomatopoeia (e.g., "BAM!", "WHOOSH", "RUMBLE").

OUTPUT FORMAT:
You MUST reply with ONLY a valid JSON array of objects. Do not add explanations or markdown backticks outside the JSON.
Each object must have:
- "id": The identical bubble ID from the input.
- "english_translation": The localized English text.
Example:
[
  {"id": "bubble_0", "english_translation": "Wh-what?! That's impossible...!"},
  {"id": "bubble_1", "english_translation": "Heh, did you really think you could win?"}
]
"""

class LocalLlmTranslator:
    """
    Interface for local 4-bit quantized LLMs (Qwen2.5-7B-Instruct or Gemma-2-9B-It)
    using llama-cpp-python with full GPU layer offloading (n_gpu_layers=-1).
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
        self.is_loaded = False

    def load(self):
        """
        Loads the quantized GGUF model into GPU memory via llama-cpp-python.
        """
        try:
            if os.path.exists(self.model_path):
                from llama_cpp import Llama
                logger.info(f"Loading Quantized GGUF model from {self.model_path} into VRAM...")
                self.llm = Llama(
                    model_path=self.model_path,
                    n_gpu_layers=self.n_gpu_layers,
                    n_ctx=self.n_ctx,
                    verbose=False
                )
                self.is_loaded = True
                logger.info("Local LLM initialized on GPU.")
            else:
                logger.warning(
                    f"LLM GGUF model not found at '{self.model_path}'. "
                    f"Operating in mock translation mode. "
                    f"To enable local LLM translation, download Qwen2.5-7B-Instruct-Q4_K_M.gguf to: {self.model_path}"
                )
                self.is_loaded = False
        except ImportError:
            logger.warning("llama-cpp-python not installed. Using mock translation mode.")
            self.is_loaded = False
        except Exception as e:
            logger.error(f"Failed to load LLM: {e}")
            self.is_loaded = False

    def translate_batch(self, bubbles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Translates a batch of detected dialogue bubbles from a single page in one pass.
        Maintains narrative context across panels.
        Input format:
        [
            {"id": "bubble_0", "japanese_raw": "なんだって！？", "style": "shout"},
            ...
        ]
        Returns bubbles with added 'english_translation' key.
        """
        if not bubbles:
            return []

        # Prepare payload for LLM prompt
        payload_items = [
            {
                "id": b["id"],
                "japanese": b.get("japanese_raw", ""),
                "style": b.get("style", "dialogue")
            }
            for b in bubbles
        ]

        if self.is_loaded and self.llm is not None:
            return self._translate_with_llm(bubbles, payload_items)
        else:
            return self._translate_mock(bubbles)

    def _translate_with_llm(
        self,
        original_bubbles: List[Dict[str, Any]],
        payload_items: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Generates batched translation using llama-cpp-python chat completion.
        """
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
            
            # Clean markdown formatting if present
            if raw_text.startswith("```json"):
                raw_text = raw_text[7:]
            if raw_text.startswith("```"):
                raw_text = raw_text[3:]
            if raw_text.endswith("```"):
                raw_text = raw_text[:-3]
            raw_text = raw_text.strip()
            
            parsed = json.loads(raw_text)
            if isinstance(parsed, dict) and "translations" in parsed:
                parsed = parsed["translations"]
            elif isinstance(parsed, dict) and "bubbles" in parsed:
                parsed = parsed["bubbles"]
            elif not isinstance(parsed, list):
                parsed = [parsed]
                
            translation_map = {item.get("id"): item.get("english_translation", "") for item in parsed if isinstance(item, dict)}
            
            # Assign back to original bubbles
            for b in original_bubbles:
                b_id = b["id"]
                b["english_translation"] = translation_map.get(b_id, self._fallback_phrase(b.get("japanese_raw", "")))
                
            return original_bubbles
            
        except Exception as e:
            logger.error(f"Error during LLM translation generation: {e}")
            return self._translate_mock(original_bubbles)

    def _translate_mock(self, original_bubbles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Heuristic translation fallback for local testing without GGUF loaded.
        """
        for b in original_bubbles:
            raw = b.get("japanese_raw", "")
            b["english_translation"] = self._fallback_phrase(raw, b.get("style", "dialogue"))
        return original_bubbles

    def _fallback_phrase(self, japanese: str, style: str = "dialogue") -> str:
        """
        Context-aware fallback phrases for testing.
        """
        dictionary = {
            "なんだって！？そんなはずは…！": "Wh-what?! That's impossible...!",
            "待って！まだ行かないで…": "Wait! Don't go yet...",
            "フッ…やはり貴様には無理だったか。": "Hmph... As expected, it was too much for you.",
            "ドオオオン！": "BOOM!",
            "本当にありがとう、助かったよ。": "Thank you so much, you saved me."
        }
        if japanese in dictionary:
            return dictionary[japanese]
            
        if style == "shout":
            return "GET READY!"
        elif style == "whisper":
            return "Could it really be...?"
        elif style == "sfx":
            return "BAM!"
        else:
            return f"Translated: {japanese}" if japanese else "..."

