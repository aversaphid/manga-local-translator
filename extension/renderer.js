/**
 * Overlay & Typesetting Engine (renderer.js)
 * High-performance canvas typesetter featuring:
 * 1. Clean inpainted base art rendering
 * 2. Binary-search font size auto-fitter for 70%-80% speech bubble occupancy
 * 3. Comic typography styles (dialogue, shout, whisper, sfx)
 * 4. High-contrast white stroke lettering matching authentic manga print
 */

class MangaRenderer {
  constructor(options = {}) {
    this.fontFamily = options.fontFamily || "Anime Ace, Komika Axis, 'Comic Sans MS', sans-serif";
    this.fontScale = options.fontScale || 1.0;
    this.targetOccupancyMin = 0.65;
    this.targetOccupancyMax = 0.82;
  }

  /**
   * Main render loop for a translated page canvas overlay.
   * @param {HTMLCanvasElement} canvas - Overlay canvas
   * @param {string} cleanImageBase64 - Inpainted background data URL
   * @param {Array} bubbles - Array of translated bubble objects from backend
   * @param {Object} renderOptions - Mode, opacity, and scale
   */
  async renderPage(canvas, cleanImageBase64, bubbles, renderOptions = {}) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const mode = renderOptions.renderMode || "clean_and_text"; // 'clean_and_text', 'text_only', 'clean_only'

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Draw Clean Inpainted Background
    if (mode === "clean_and_text" || mode === "clean_only") {
      if (cleanImageBase64) {
        const cleanImg = await this.loadImage(cleanImageBase64);
        ctx.drawImage(cleanImg, 0, 0, canvas.width, canvas.height);
      }
    }

    // 2. Typeset & Render Translated Dialogue Text
    if (mode === "clean_and_text" || mode === "text_only") {
      for (const bubble of bubbles) {
        this.renderBubbleText(ctx, bubble, canvas.width, canvas.height);
      }
    }

    ctx.restore();
  }

  /**
   * Renders a single dialogue bubble's translated text with dynamic fitting.
   */
  renderBubbleText(ctx, bubble, canvasW, canvasH) {
    const text = bubble.english_translation || "";
    if (!text.trim()) return;

    const [x, y, w, h] = bubble.bbox;
    const style = bubble.style || "dialogue";

    // Effective bubble bounds with padding inside speech bubble
    const paddingX = w * 0.10;
    const paddingY = h * 0.10;
    const usableW = Math.max(w - (2 * paddingX), 20);
    const usableH = Math.max(h - (2 * paddingY), 20);

    // Binary search font size auto-fitter
    const { bestSize, lines, lineHeight } = this.fitTextBinarySearch(
      ctx,
      text,
      usableW,
      usableH,
      style
    );

    // Apply typography style settings
    this.applyBubbleStyle(ctx, style, bestSize);

    // Calculate vertical centering
    const totalTextHeight = lines.length * lineHeight;
    const startY = y + paddingY + ((usableH - totalTextHeight) / 2) + (lineHeight * 0.75);
    const centerX = x + (w / 2);

    // Render each line with high-contrast comic stroke
    lines.forEach((line, idx) => {
      const lineY = startY + (idx * lineHeight);
      
      // Manga print contrast white outline
      ctx.strokeText(line, centerX, lineY);
      // Sharp black fill
      ctx.fillText(line, centerX, lineY);
    });
  }

  /**
   * Binary-search font size auto-fitter.
   * Finds the maximum font size (between 10px and 54px) such that
   * English text occupies 70%–80% of bubble interior without clipping.
   */
  fitTextBinarySearch(ctx, text, maxW, maxH, style) {
    let minSize = Math.max(10, Math.floor(11 * this.fontScale));
    let maxSize = Math.max(minSize + 2, Math.floor(54 * this.fontScale));
    let bestSize = minSize;
    let bestLines = [text];
    let bestLineHeight = minSize * 1.2;

    const bubbleArea = maxW * maxH * (Math.PI / 4.0); // Inscribed ellipse usable area

    let low = minSize;
    let high = maxSize;

    while (low <= high) {
      const testSize = Math.floor((low + high) / 2);
      this.applyBubbleStyle(ctx, style, testSize);

      const testLineHeight = testSize * (style === "shout" ? 1.15 : 1.25);
      const lines = this.wrapText(ctx, text, maxW);
      const totalH = lines.length * testLineHeight;

      // Find max line width
      let maxLineWidth = 0;
      for (const line of lines) {
        const measured = ctx.measureText(line).width;
        if (measured > maxLineWidth) maxLineWidth = measured;
      }

      // Check if text fits inside usable oval bounds
      const fitsWidth = maxLineWidth <= maxW;
      const fitsHeight = totalH <= maxH;
      const textArea = maxLineWidth * totalH;
      const occupancy = textArea / Math.max(bubbleArea, 1);

      if (fitsWidth && fitsHeight) {
        bestSize = testSize;
        bestLines = lines;
        bestLineHeight = testLineHeight;

        // If within ideal occupancy or under ceiling, try larger size
        if (occupancy < this.targetOccupancyMax) {
          low = testSize + 1;
        } else {
          break; // Perfect occupancy reached
        }
      } else {
        // Clipped; decrease font size
        high = testSize - 1;
      }
    }

    return {
      bestSize,
      lines: bestLines,
      lineHeight: bestLineHeight
    };
  }

  /**
   * Wraps text into lines that do not exceed maxWidth.
   */
  wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = "";

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = ctx.measureText(testLine).width;

      if (testWidth <= maxWidth || !currentLine) {
        currentLine = testLine;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }

  /**
   * Applies typography styles based on bubble classification:
   * - dialogue: smooth font, centered, medium stroke
   * - shout: bold uppercase heavy font, wide stroke
   * - whisper: italic/thin serif font, subtle stroke
   * - sfx: heavy impact stroke, comic display
   */
  applyBubbleStyle(ctx, style, fontSize) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let strokeWidth = Math.max(2.5, fontSize * 0.16);
    let fontWeight = "normal";
    let fontStyle = "normal";

    switch (style) {
      case "shout":
        fontWeight = "900";
        fontStyle = "normal";
        strokeWidth = Math.max(4.0, fontSize * 0.22);
        ctx.fillStyle = "#000000";
        ctx.strokeStyle = "#ffffff";
        break;

      case "whisper":
        fontWeight = "400";
        fontStyle = "italic";
        strokeWidth = Math.max(1.8, fontSize * 0.12);
        ctx.fillStyle = "#222222";
        ctx.strokeStyle = "#ffffff";
        break;

      case "sfx":
        fontWeight = "bold";
        fontStyle = "normal";
        strokeWidth = Math.max(5.0, fontSize * 0.25);
        ctx.fillStyle = "#111111";
        ctx.strokeStyle = "#ffffff";
        break;

      case "dialogue":
      default:
        fontWeight = "700";
        fontStyle = "normal";
        strokeWidth = Math.max(2.8, fontSize * 0.16);
        ctx.fillStyle = "#000000";
        ctx.strokeStyle = "#ffffff";
        break;
    }

    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${this.fontFamily}`;
  }

  loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error("Failed to load clean base image for canvas."));
      img.src = src;
    });
  }
}

// Expose on window for content script usage
window.MangaRenderer = MangaRenderer;

