/**
 * Content Script (content.js)
 * Non-destructive manga reader observer and overlay manager.
 * Intercepts reader images/canvases, handles cross-origin conversion via background worker,
 * synchronizes with ResizeObserver, and hosts the floating control dock.
 */

(function () {
  "use strict";

  // Prevent multiple injections
  if (window.__MANGA_TRANSLATOR_INJECTED__) return;
  window.__MANGA_TRANSLATOR_INJECTED__ = true;

  const renderer = new window.MangaRenderer();
  let settings = {
    backendUrl: "http://localhost:8000",
    autoTranslate: false,
    overlayOpacity: 1.0,
    renderMode: "clean_and_text",
    fontFamily: "Anime Ace",
    fontScale: 1.0
  };

  // State cache of translated targets: targetElement -> { overlayWrapper, canvas, data }
  const activeOverlays = new Map();
  const processedImages = new WeakSet();

  // Load persistent settings
  chrome.storage.local.get("settings", (res) => {
    if (res.settings) {
      settings = { ...settings, ...res.settings };
      renderer.fontScale = settings.fontScale;
      renderer.fontFamily = settings.fontFamily;
      updateToolbarUI();
    }
  });

  // Listen for storage changes from popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
      renderer.fontScale = settings.fontScale;
      renderer.fontFamily = settings.fontFamily;
      updateToolbarUI();
      reapplyAllOverlays();
    }
  });

  /**
   * Initializes page observer and floating dock UI.
   */
  function init() {
    createFloatingDock();
    setupReaderObserver();
    checkBackendStatus();
  }

  // ==========================================
  // DOM Observer & Target Detection
  // ==========================================

  function setupReaderObserver() {
    const observer = new MutationObserver(() => {
      findAndProcessMangaElements();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Initial pass
    findAndProcessMangaElements();

    // Reposition overlays on window scroll or resize
    window.addEventListener("scroll", updateAllOverlayPositions, { passive: true });
    window.addEventListener("resize", updateAllOverlayPositions, { passive: true });
  }

  /**
   * Identifies candidate manga reader images or canvases on the page.
   * Matches MangaDex, generic comic viewers, or images with typical page dimensions.
   */
  function findAndProcessMangaElements() {
    // Selectors targeting common manga reader frameworks (MangaDex, MangaReader, Canvas viewers)
    const selectors = [
      ".md-reader img",
      ".reader--page img",
      ".page-image img",
      "img[src*='mangadex']",
      "img[src*='chapter']",
      "img[src*='manga']",
      ".comic-page img",
      "canvas.reader-canvas"
    ];

    let candidates = Array.from(document.querySelectorAll(selectors.join(",")));

    // Fallback: search for large vertical images typical of manga pages (aspect ratio > 1.2, height > 600px)
    if (candidates.length === 0) {
      const allImages = Array.from(document.querySelectorAll("img"));
      candidates = allImages.filter((img) => {
        const rect = img.getBoundingClientRect();
        return rect.height >= 500 && (rect.height / Math.max(rect.width, 1)) >= 1.1;
      });
    }

    candidates.forEach((el) => {
      if (!processedImages.has(el)) {
        processedImages.add(el);
        attachResizeObserver(el);
        if (settings.autoTranslate) {
          translateElement(el);
        }
      }
    });
  }

  /**
   * Attaches a ResizeObserver to synchronize overlay canvas geometry
   * with the host image without disturbing parent DOM flow.
   */
  function attachResizeObserver(targetEl) {
    const ro = new ResizeObserver(() => {
      const overlayData = activeOverlays.get(targetEl);
      if (overlayData) {
        positionOverlay(targetEl, overlayData.wrapper, overlayData.canvas);
      }
    });
    ro.observe(targetEl);
  }

  // ==========================================
  // Overlay Management
  // ==========================================

  function getOrCreateOverlay(targetEl) {
    if (activeOverlays.has(targetEl)) {
      return activeOverlays.get(targetEl);
    }

    const wrapper = document.createElement("div");
    wrapper.className = "manga-translator-overlay-wrapper";
    wrapper.style.opacity = settings.overlayOpacity;

    const canvas = document.createElement("canvas");
    canvas.className = "manga-translator-overlay-canvas";
    wrapper.appendChild(canvas);

    document.body.appendChild(wrapper);

    const overlayData = { wrapper, canvas, targetEl, translationData: null };
    activeOverlays.set(targetEl, overlayData);

    positionOverlay(targetEl, wrapper, canvas);
    return overlayData;
  }

  function positionOverlay(targetEl, wrapper, canvas) {
    const rect = targetEl.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    wrapper.style.top = `${rect.top + scrollY}px`;
    wrapper.style.left = `${rect.left + scrollX}px`;
    wrapper.style.width = `${rect.width}px`;
    wrapper.style.height = `${rect.height}px`;

    const dpr = window.devicePixelRatio || 1;
    // Set internal canvas resolution
    if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
    }
  }

  function updateAllOverlayPositions() {
    activeOverlays.forEach(({ wrapper, canvas, targetEl }) => {
      if (document.body.contains(targetEl)) {
        positionOverlay(targetEl, wrapper, canvas);
      } else {
        // Target element was removed; clean up overlay
        wrapper.remove();
        activeOverlays.delete(targetEl);
      }
    });
  }

  function reapplyAllOverlays() {
    activeOverlays.forEach(async ({ canvas, translationData, wrapper }) => {
      if (wrapper) {
        wrapper.style.opacity = settings.overlayOpacity;
      }
      if (translationData) {
        await renderer.renderPage(
          canvas,
          translationData.clean_image_base64,
          translationData.bubbles,
          { renderMode: settings.renderMode }
        );
      }
    });
  }

  // ==========================================
  // Image Extraction & Translation Pipeline
  // ==========================================

  async function getImagePayload(targetEl) {
    // 1. If element is a canvas
    if (targetEl.tagName.toLowerCase() === "canvas") {
      return targetEl.toDataURL("image/png");
    }

    // 2. If element is an <img>
    const src = targetEl.currentSrc || targetEl.src;
    if (!src) throw new Error("Image element has no valid src.");

    if (src.startsWith("data:")) {
      return src;
    }

    // Attempt direct canvas draw if same-origin
    try {
      const c = document.createElement("canvas");
      c.width = targetEl.naturalWidth || targetEl.width;
      c.height = targetEl.naturalHeight || targetEl.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(targetEl, 0, 0);
      return c.toDataURL("image/png");
    } catch (e) {
      // CORS tainted canvas; delegate fetch to background worker
      console.log("[Content] Canvas tainted by CORS. Fetching via background service worker...");
      const res = await chrome.runtime.sendMessage({
        type: "FETCH_IMAGE_AS_BASE64",
        url: src
      });
      if (res && res.success) {
        return res.base64;
      }
      throw new Error(res?.error || "Failed to fetch image via background worker.");
    }
  }

  async function translateElement(targetEl) {
    const overlay = getOrCreateOverlay(targetEl);
    setToolbarStatus("busy");

    try {
      const base64Image = await getImagePayload(targetEl);

      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_PAGE_API",
        backendUrl: settings.backendUrl,
        payload: { image: base64Image }
      });

      if (!response || !response.success) {
        throw new Error(response?.error || "Translation request failed.");
      }

      const data = response.data;
      overlay.translationData = data;

      // Scale detected bubble coordinates from original image space to display canvas space
      const naturalW = targetEl.naturalWidth || targetEl.width;
      const naturalH = targetEl.naturalHeight || targetEl.height;
      const rect = targetEl.getBoundingClientRect();
      const scaleX = rect.width / Math.max(naturalW, 1);
      const scaleY = rect.height / Math.max(naturalH, 1);

      const scaledBubbles = data.bubbles.map((b) => {
        const [bx, by, bw, bh] = b.bbox;
        return {
          ...b,
          bbox: [bx * scaleX, by * scaleY, bw * scaleX, bh * scaleY]
        };
      });

      await renderer.renderPage(
        overlay.canvas,
        data.clean_image_base64,
        scaledBubbles,
        { renderMode: settings.renderMode }
      );

      setToolbarStatus("online");
    } catch (error) {
      console.error("[Content] Translation error:", error);
      setToolbarStatus("error");
    }
  }

  async function translateAllVisiblePages() {
    const images = Array.from(document.querySelectorAll("img, canvas")).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height >= 400 && rect.top < window.innerHeight && rect.bottom > 0;
    });

    if (images.length === 0) {
      alert("No active manga page detected in current viewport.");
      return;
    }

    for (const el of images) {
      await translateElement(el);
    }
  }

  // ==========================================
  // Floating Toolbar UI
  // ==========================================

  function createFloatingDock() {
    if (document.getElementById("manga-translator-floating-dock")) return;

    const dock = document.createElement("div");
    dock.id = "manga-translator-floating-dock";
    dock.innerHTML = `
      <div class="mt-dock-card">
        <div class="mt-dock-header">
          <div class="mt-brand">
            <span class="mt-status-dot" id="mt-status-indicator"></span>
            <span>Manga Local GPU</span>
          </div>
        </div>
        <div class="mt-dock-body">
          <button class="mt-btn-primary" id="mt-translate-btn">
            <span id="mt-btn-icon">⚡</span>
            <span id="mt-btn-text">Translate View</span>
          </button>
          <div class="mt-controls-row">
            <label class="mt-switch-label">
              <input type="checkbox" id="mt-auto-toggle" ${settings.autoTranslate ? "checked" : ""}>
              <span>Auto-translate</span>
            </label>
            <select class="mt-select" id="mt-render-mode">
              <option value="clean_and_text" ${settings.renderMode === "clean_and_text" ? "selected" : ""}>Clean + Text</option>
              <option value="text_only" ${settings.renderMode === "text_only" ? "selected" : ""}>Text Only</option>
              <option value="clean_only" ${settings.renderMode === "clean_only" ? "selected" : ""}>Clean Only</option>
            </select>
          </div>
          <div class="mt-slider-wrapper">
            <span style="font-size: 11px; color: #94a3b8;">Opacity</span>
            <input type="range" id="mt-opacity-slider" min="0" max="1" step="0.05" value="${settings.overlayOpacity}">
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(dock);

    // Event Listeners
    const translateBtn = dock.querySelector("#mt-translate-btn");
    translateBtn.addEventListener("click", () => {
      translateAllVisiblePages();
    });

    const autoToggle = dock.querySelector("#mt-auto-toggle");
    autoToggle.addEventListener("change", (e) => {
      settings.autoTranslate = e.target.checked;
      chrome.storage.local.set({ settings });
    });

    const renderModeSelect = dock.querySelector("#mt-render-mode");
    renderModeSelect.addEventListener("change", (e) => {
      settings.renderMode = e.target.value;
      chrome.storage.local.set({ settings });
      reapplyAllOverlays();
    });

    const opacitySlider = dock.querySelector("#mt-opacity-slider");
    opacitySlider.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      settings.overlayOpacity = val;
      activeOverlays.forEach(({ wrapper }) => {
        if (wrapper) wrapper.style.opacity = val;
      });
    });
    opacitySlider.addEventListener("change", (e) => {
      chrome.storage.local.set({ settings });
    });

    makeDraggable(dock, dock.querySelector(".mt-dock-header"));
  }

  function setToolbarStatus(status) {
    const indicator = document.getElementById("mt-status-indicator");
    const btnText = document.getElementById("mt-btn-text");
    const btnIcon = document.getElementById("mt-btn-icon");

    if (!indicator) return;

    indicator.className = `mt-status-dot ${status}`;

    if (status === "busy") {
      btnIcon.innerHTML = `<span class="mt-spinner"></span>`;
      btnText.textContent = "Translating...";
    } else {
      btnIcon.textContent = "⚡";
      btnText.textContent = "Translate View";
    }
  }

  function updateToolbarUI() {
    const autoToggle = document.getElementById("mt-auto-toggle");
    if (autoToggle) autoToggle.checked = settings.autoTranslate;

    const renderModeSelect = document.getElementById("mt-render-mode");
    if (renderModeSelect) renderModeSelect.value = settings.renderMode;

    const opacitySlider = document.getElementById("mt-opacity-slider");
    if (opacitySlider) opacitySlider.value = settings.overlayOpacity;
  }

  function checkBackendStatus() {
    chrome.runtime.sendMessage(
      { type: "CHECK_HEALTH", backendUrl: settings.backendUrl },
      (res) => {
        if (res && res.success && res.data.status === "healthy") {
          setToolbarStatus("online");
        } else {
          setToolbarStatus("offline");
        }
      }
    );
  }

  function makeDraggable(el, handle) {
    let isDragging = false;
    let startX, startY, initialX, initialY;

    handle.addEventListener("mousedown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = `${initialX + dx}px`;
      el.style.top = `${initialY + dy}px`;
      el.style.bottom = "auto";
      el.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });
  }

  // Run on start
  init();
})();

