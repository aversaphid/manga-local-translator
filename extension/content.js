/**
 * Content Script (content.js)
 * Robust Manga Reader Interceptor, Picker & Overlay Engine
 * Supports:
 * - Traditional <img> readers (MangaDex, etc.)
 * - HTML5 Canvas & WebGL readers (MediaDo MDViewer, Bibi, Voyager, etc.)
 * - Embedded Iframes (bibi-frame, sandboxed viewers)
 * - Viewport screenshot capture via "tabs" permission (100% DRM-proof)
 * - Transparent backdrop picker capturing clicks over nested iframes
 * - Live UI status toasts for real-time progress feedback
 */

(function () {
  "use strict";

  if (window.__MANGA_TRANSLATOR_INJECTED__) return;
  window.__MANGA_TRANSLATOR_INJECTED__ = true;

  const isTopWindow = (window === window.top);
  const renderer = new window.MangaRenderer();

  let settings = {
    backendUrl: "http://127.0.0.1:8000",
    autoTranslate: false,
    overlayOpacity: 1.0,
    renderMode: "clean_and_text",
    fontFamily: "Anime Ace",
    fontScale: 1.0
  };

  const activeOverlays = new Map();
  const processedElements = new WeakSet();
  let isPickingElement = false;

  // Load persistent settings
  chrome.storage.local.get("settings", (res) => {
    if (res.settings) {
      settings = { ...settings, ...res.settings };
      renderer.fontScale = settings.fontScale;
      renderer.fontFamily = settings.fontFamily;
      updateToolbarUI();
    }
  });

  // Storage change listener
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
      renderer.fontScale = settings.fontScale;
      renderer.fontFamily = settings.fontFamily;
      updateToolbarUI();
      reapplyAllOverlays();
    }
  });

  function init() {
    if (isTopWindow) {
      createFloatingDock();
    }
    setupReaderObserver();
    checkBackendStatus();
  }

  // ==========================================
  // Visual Toast Notifications
  // ==========================================

  function showToast(message, type = "info", duration = 3500) {
    if (!isTopWindow) return;

    let toast = document.getElementById("mt-toast-notification");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "mt-toast-notification";
      document.body.appendChild(toast);
    }

    toast.className = `mt-toast mt-toast-${type}`;
    toast.textContent = message;
    toast.style.display = "block";
    toast.style.opacity = "1";

    if (window.__mt_toast_timer) clearTimeout(window.__mt_toast_timer);
    window.__mt_toast_timer = setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => {
        toast.style.display = "none";
      }, 300);
    }, duration);
  }

  // ==========================================
  // Manga Element Discovery
  // ==========================================

  function setupReaderObserver() {
    const observer = new MutationObserver(() => {
      findAndProcessMangaElements();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    findAndProcessMangaElements();

    window.addEventListener("scroll", updateAllOverlayPositions, { passive: true });
    window.addEventListener("resize", updateAllOverlayPositions, { passive: true });
  }

  function findMangaReaderCandidates(doc = document) {
    const candidates = [];
    const selectors = [
      "iframe.bibi-frame",
      "iframe[src*='viewer']",
      "iframe[class*='viewer']",
      "iframe",
      "canvas:not(.manga-translator-overlay-canvas)",
      ".page-image img",
      ".reader--page img",
      ".md-reader img",
      "img[src*='chapter']",
      "img[src*='manga']",
      "img[src*='page']",
      "img[src*='blob:']",
      ".comic-page img",
      "img"
    ];

    const elements = Array.from(doc.querySelectorAll(selectors.join(",")));

    elements.forEach((el) => {
      if (
        el.closest(".manga-translator-overlay-wrapper") ||
        el.closest("#manga-translator-floating-dock") ||
        el.id === "mt-picker-backdrop"
      ) {
        return;
      }

      // Check inside accessible same-origin iframes
      if (el.tagName.toLowerCase() === "iframe") {
        try {
          if (el.contentDocument && el.contentDocument.body) {
            const innerCandidates = findMangaReaderCandidates(el.contentDocument);
            if (innerCandidates.length > 0) {
              candidates.push(...innerCandidates);
              return;
            }
          }
        } catch (e) {
          // Cross-origin iframe: treat iframe itself as reader target
        }
      }

      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;

      if (
        rect.width >= 160 &&
        rect.height >= 160 &&
        area >= 35000 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        rect.right > 0 &&
        rect.left < window.innerWidth
      ) {
        candidates.push(el);
      }
    });

    return candidates;
  }

  function findAndProcessMangaElements() {
    const candidates = findMangaReaderCandidates();

    candidates.forEach((el) => {
      if (!processedElements.has(el)) {
        processedElements.add(el);
        attachResizeObserver(el);
        if (settings.autoTranslate) {
          translateElement(el);
        }
      }
    });
  }

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
    const targetW = Math.max(1, Math.floor(rect.width * dpr));
    const targetH = Math.max(1, Math.floor(rect.height * dpr));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
    }
  }

  function updateAllOverlayPositions() {
    activeOverlays.forEach(({ wrapper, canvas, targetEl }) => {
      if (document.body.contains(targetEl)) {
        positionOverlay(targetEl, wrapper, canvas);
      } else {
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
  // Image Capture via Tab Screenshot
  // ==========================================

  async function captureElementViaScreenshot(targetEl) {
    const dock = document.getElementById("manga-translator-floating-dock");
    const overlays = Array.from(document.querySelectorAll(".manga-translator-overlay-wrapper"));

    // Temporarily hide overlays and dock during screenshot capture
    overlays.forEach((o) => (o.style.visibility = "hidden"));
    if (dock) dock.style.visibility = "hidden";

    // Small frame delay to let browser flush render
    await new Promise((r) => setTimeout(r, 60));

    try {
      const response = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" });
      if (!response || !response.success || !response.dataUrl) {
        throw new Error(response?.error || "Failed to capture viewport screenshot.");
      }

      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = response.dataUrl;
      });

      const rect = targetEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      let sx = Math.max(0, Math.floor(rect.left * dpr));
      let sy = Math.max(0, Math.floor(rect.top * dpr));
      let sw = Math.min(Math.floor(rect.width * dpr), img.width - sx);
      let sh = Math.min(Math.floor(rect.height * dpr), img.height - sy);

      // If whole page/viewport target
      if (targetEl === document.body || sw <= 0 || sh <= 0) {
        sx = 0;
        sy = 0;
        sw = img.width;
        sh = img.height;
      }

      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = sw;
      cropCanvas.height = sh;
      const cropCtx = cropCanvas.getContext("2d");
      cropCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

      return cropCanvas.toDataURL("image/png");
    } finally {
      overlays.forEach((o) => (o.style.visibility = ""));
      if (dock) dock.style.visibility = "";
    }
  }

  async function getImagePayload(targetEl) {
    const tag = targetEl.tagName ? targetEl.tagName.toLowerCase() : "";

    // 1. Canvas element: direct toDataURL or screenshot fallback
    if (tag === "canvas") {
      try {
        const dataUrl = targetEl.toDataURL("image/png");
        if (dataUrl && dataUrl.length > 2500) {
          return dataUrl;
        }
      } catch (e) {
        // Tainted canvas or WebGL error
      }
      return await captureElementViaScreenshot(targetEl);
    }

    // 2. Image element
    if (tag === "img") {
      const src = targetEl.currentSrc || targetEl.src;
      if (src && src.startsWith("data:")) {
        return src;
      }
      try {
        const c = document.createElement("canvas");
        c.width = targetEl.naturalWidth || targetEl.width;
        c.height = targetEl.naturalHeight || targetEl.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(targetEl, 0, 0);
        return c.toDataURL("image/png");
      } catch (e) {
        try {
          const res = await chrome.runtime.sendMessage({
            type: "FETCH_IMAGE_AS_BASE64",
            url: src
          });
          if (res && res.success && res.base64) {
            return res.base64;
          }
        } catch (fetchErr) {}
      }
      return await captureElementViaScreenshot(targetEl);
    }

    // 3. Iframe, container div, or body
    return await captureElementViaScreenshot(targetEl);
  }

  // ==========================================
  // Translation Execution
  // ==========================================

  async function translateElement(targetEl) {
    const overlay = getOrCreateOverlay(targetEl);
    setToolbarStatus("busy");
    showToast("Capturing comic page...", "info", 2000);

    try {
      const base64Image = await getImagePayload(targetEl);
      showToast("Translating dialogue on GPU...", "info", 4000);

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

      const rect = targetEl.getBoundingClientRect();
      const tempImg = new Image();
      await new Promise((resolve) => {
        tempImg.onload = resolve;
        tempImg.src = data.clean_image_base64 || base64Image;
      });

      const scaleX = rect.width / Math.max(tempImg.width, 1);
      const scaleY = rect.height / Math.max(tempImg.height, 1);

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
      const bubbleCount = data.bubbles ? data.bubbles.length : 0;
      showToast(`✓ Translated ${bubbleCount} bubbles in ${data.processing_time_ms || 0}ms`, "success", 4000);

    } catch (error) {
      console.error("[Content] Translation error:", error);
      setToolbarStatus("error");
      showToast(`Translation error: ${error.message}`, "error", 6000);
    }
  }

  async function translateAllVisiblePages() {
    let candidates = findMangaReaderCandidates();

    if (candidates.length === 0) {
      // Look for main reader containers or iframes
      const viewerContainers = Array.from(
        document.querySelectorAll(
          "iframe.bibi-frame, iframe, #viewer, .viewer, .mdviewer, app-root, .swiper-slide-active, main, [class*='reader']"
        )
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 200 && r.height >= 200 && r.bottom > 0 && r.top < window.innerHeight;
      });

      if (viewerContainers.length > 0) {
        viewerContainers.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        candidates = [viewerContainers[0]];
      }
    }

    if (candidates.length === 0) {
      candidates = [document.body];
    }

    for (const el of candidates) {
      await translateElement(el);
    }
  }

  // ==========================================
  // Interactive Element Picker with Iframe Backdrop
  // ==========================================

  function toggleElementPicker() {
    if (isPickingElement) {
      disableElementPicker();
    } else {
      enableElementPicker();
    }
  }

  function enableElementPicker() {
    isPickingElement = true;
    showToast("Click directly on the comic page to translate it (or Esc to cancel)", "info", 5000);

    // Full-screen transparent backdrop ensures mouse clicks over iframes are caught
    const backdrop = document.createElement("div");
    backdrop.id = "mt-picker-backdrop";
    document.body.appendChild(backdrop);

    const highlightBox = document.createElement("div");
    highlightBox.id = "mt-picker-highlight";
    document.body.appendChild(highlightBox);

    const onMouseMove = (e) => {
      backdrop.style.pointerEvents = "none";
      const target = document.elementFromPoint(e.clientX, e.clientY);
      backdrop.style.pointerEvents = "auto";

      if (
        !target ||
        target.closest("#manga-translator-floating-dock") ||
        target.id === "mt-picker-highlight" ||
        target.id === "mt-picker-backdrop"
      ) {
        return;
      }

      const rect = target.getBoundingClientRect();
      highlightBox.style.display = "block";
      highlightBox.style.top = `${rect.top + window.scrollY}px`;
      highlightBox.style.left = `${rect.left + window.scrollX}px`;
      highlightBox.style.width = `${rect.width}px`;
      highlightBox.style.height = `${rect.height}px`;
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      backdrop.style.pointerEvents = "none";
      const target = document.elementFromPoint(e.clientX, e.clientY);
      disableElementPicker();

      if (
        target &&
        !target.closest("#manga-translator-floating-dock") &&
        target !== document.body
      ) {
        translateElement(target);
      } else {
        // Fallback to active viewport translation
        translateAllVisiblePages();
      }
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        disableElementPicker();
      }
    };

    backdrop.addEventListener("mousemove", onMouseMove);
    backdrop.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown, true);

    window.__mt_picker_cleanup = () => {
      backdrop.remove();
      highlightBox.remove();
      document.removeEventListener("keydown", onKeyDown, true);
      isPickingElement = false;
    };
  }

  function disableElementPicker() {
    if (window.__mt_picker_cleanup) {
      window.__mt_picker_cleanup();
      window.__mt_picker_cleanup = null;
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
          <button id="mt-pick-btn" class="mt-btn-icon" title="Select Manga Frame / Element Directly">🎯</button>
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

    dock.querySelector("#mt-translate-btn").addEventListener("click", () => {
      translateAllVisiblePages();
    });

    dock.querySelector("#mt-pick-btn").addEventListener("click", () => {
      toggleElementPicker();
    });

    dock.querySelector("#mt-auto-toggle").addEventListener("change", (e) => {
      settings.autoTranslate = e.target.checked;
      chrome.storage.local.set({ settings });
    });

    dock.querySelector("#mt-render-mode").addEventListener("change", (e) => {
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
        if (res && res.success && res.data && res.data.status === "healthy") {
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
      if (e.target.closest("button") || e.target.closest("input")) return;
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

  init();
})();
