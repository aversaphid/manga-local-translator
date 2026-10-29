document.addEventListener("DOMContentLoaded", async () => {
  const backendUrlInput = document.getElementById("backend-url");
  const testBtn = document.getElementById("test-connection-btn");
  const connectionBadge = document.getElementById("connection-badge");
  const gpuDeviceName = document.getElementById("gpu-device-name");
  const vramFillBar = document.getElementById("vram-fill-bar");
  const vramAllocatedLabel = document.getElementById("vram-allocated-label");
  const statusDetector = document.getElementById("status-detector");
  const statusOcr = document.getElementById("status-ocr");
  const statusInpaint = document.getElementById("status-inpaint");
  const statusLlm = document.getElementById("status-llm");

  const popupTranslateBtn = document.getElementById("popup-translate-btn");
  const autoTranslateToggle = document.getElementById("auto-translate-toggle");
  const fontFamilySelect = document.getElementById("font-family-select");
  const fontScaleSlider = document.getElementById("font-scale-slider");
  const fontScaleVal = document.getElementById("font-scale-val");
  const renderModeSelect = document.getElementById("render-mode-select");
  const saveBtn = document.getElementById("save-btn");

  // Load existing settings
  const { settings } = await chrome.storage.local.get("settings");
  if (settings) {
    backendUrlInput.value = settings.backendUrl || "http://127.0.0.1:8000";
    autoTranslateToggle.checked = Boolean(settings.autoTranslate);
    fontFamilySelect.value = settings.fontFamily || "Anime Ace";
    fontScaleSlider.value = settings.fontScale || 1.0;
    fontScaleVal.textContent = `${parseFloat(settings.fontScale || 1.0).toFixed(2)}x`;
    renderModeSelect.value = settings.renderMode || "clean_and_text";
  }

  // Update slider label on input
  fontScaleSlider.addEventListener("input", (e) => {
    fontScaleVal.textContent = `${parseFloat(e.target.value).toFixed(2)}x`;
  });

  // Query Backend Health & VRAM
  async function queryHealth(url) {
    connectionBadge.textContent = "Checking...";
    connectionBadge.className = "badge";

    chrome.runtime.sendMessage(
      { type: "CHECK_HEALTH", backendUrl: url },
      (response) => {
        if (response && response.success && response.data) {
          const health = response.data;
          connectionBadge.textContent = "Online";
          connectionBadge.className = "badge badge-online";

          if (health.vram) {
            gpuDeviceName.textContent = health.vram.device_name || "NVIDIA CUDA GPU";
            const allocated = health.vram.reserved_mb || health.vram.allocated_mb || 0;
            const maxBudget = health.vram.budget_ceiling_mb || 10240;
            const percent = Math.min(100, Math.round((allocated / maxBudget) * 100));

            vramFillBar.style.width = `${percent}%`;
            vramAllocatedLabel.textContent = `${allocated} MB (${percent}%)`;
          }

          if (health.models) {
            statusDetector.textContent = health.models.detector || "ready";
            statusOcr.textContent = health.models.ocr || "ready";
            statusInpaint.textContent = health.models.inpainter || "ready";
            statusLlm.textContent = health.models.translator || "ready";
          }
        } else {
          connectionBadge.textContent = "Offline";
          connectionBadge.className = "badge badge-offline";
          gpuDeviceName.textContent = "Server Not Responding";
          vramFillBar.style.width = "0%";
          vramAllocatedLabel.textContent = "0.0 MB";
          statusDetector.textContent = "offline";
          statusOcr.textContent = "offline";
          statusInpaint.textContent = "offline";
          statusLlm.textContent = "offline";
        }
      }
    );
  }

  queryHealth(backendUrlInput.value);

  testBtn.addEventListener("click", () => {
    queryHealth(backendUrlInput.value);
  });

  // Direct activeTab Screenshot Translation from Popup
  // When clicked here, Chrome gives 100% guaranteed activeTab permission!
  if (popupTranslateBtn) {
    popupTranslateBtn.addEventListener("click", async () => {
      popupTranslateBtn.textContent = "📸 Capturing tab...";
      popupTranslateBtn.disabled = true;

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
          throw new Error("No active manga tab found.");
        }

        chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            const err = chrome.runtime.lastError?.message || "Failed to capture.";
            alert("Capture error: " + err);
            popupTranslateBtn.textContent = "⚡ Translate Active Tab";
            popupTranslateBtn.disabled = false;
            return;
          }

          popupTranslateBtn.textContent = "⚡ Sending to GPU...";

          chrome.tabs.sendMessage(
            tab.id,
            { type: "TRANSLATE_FROM_SCREENSHOT", screenshotUrl: dataUrl },
            (res) => {
              popupTranslateBtn.textContent = "Translated ✓";
              setTimeout(() => {
                popupTranslateBtn.textContent = "⚡ Translate Active Tab";
                popupTranslateBtn.disabled = false;
                window.close();
              }, 1200);
            }
          );
        });
      } catch (err) {
        alert(err.message);
        popupTranslateBtn.textContent = "⚡ Translate Active Tab";
        popupTranslateBtn.disabled = false;
      }
    });
  }

  // Save Settings
  saveBtn.addEventListener("click", async () => {
    const updatedSettings = {
      backendUrl: backendUrlInput.value.trim(),
      autoTranslate: autoTranslateToggle.checked,
      fontFamily: fontFamilySelect.value,
      fontScale: parseFloat(fontScaleSlider.value),
      renderMode: renderModeSelect.value
    };

    await chrome.storage.local.set({ settings: updatedSettings });
    saveBtn.textContent = "Saved ✓";
    saveBtn.style.background = "#22c55e";

    setTimeout(() => {
      saveBtn.textContent = "Save Settings";
      saveBtn.style.background = "";
    }, 1200);
  });
});
