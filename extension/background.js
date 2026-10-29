/**
 * Background Service Worker (Manifest V3)
 * Handles cross-origin image fetching to bypass canvas tainting/CORS,
 * viewport screenshot capture for DRM/WebGL/iframe manga readers,
 * local server communication, and persistent user settings.
 */

const DEFAULT_SETTINGS = {
  backendUrl: "http://localhost:8000",
  autoTranslate: false,
  overlayOpacity: 1.0,
  renderMode: "clean_and_text", // 'clean_and_text', 'text_only', 'clean_only'
  fontFamily: "Anime Ace",
  fontScale: 1.0
};

// Initialize settings upon installation
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get("settings");
  if (!current.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    console.log("[Background] Initialized default settings.");
  }
});

// Message listener for content scripts and popup UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_IMAGE_AS_BASE64") {
    fetchImageAsBase64(message.url)
      .then((base64) => sendResponse({ success: true, base64 }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "CAPTURE_VISIBLE_TAB") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({
          success: false,
          error: chrome.runtime.lastError?.message || "Failed to capture visible tab."
        });
      } else {
        sendResponse({ success: true, dataUrl });
      }
    });
    return true;
  }

  if (message.type === "TRANSLATE_PAGE_API") {
    translatePagePayload(message.backendUrl || "http://localhost:8000", message.payload)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "CHECK_HEALTH") {
    checkBackendHealth(message.backendUrl || "http://localhost:8000")
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * Fetches an image URL in the background service worker where CORS rules
 * are permissive (via host permissions), converting it to a Base64 Data URI.
 */
async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: HTTP ${response.status}`);
    }
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("FileReader failed to convert image blob."));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error("[Background] Image fetch error:", error);
    throw error;
  }
}

/**
 * Sends image payload to local FastAPI GPU backend.
 */
async function translatePagePayload(backendUrl, payload) {
  const endpoint = `${backendUrl.replace(/\/+$/, "")}/translate-page`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Server returned ${response.status}: ${errorText}`);
  }

  return await response.json();
}

/**
 * Checks GPU health and VRAM status.
 */
async function checkBackendHealth(backendUrl) {
  const endpoint = `${backendUrl.replace(/\/+$/, "")}/health`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Health check returned ${response.status}`);
  }
  return await response.json();
}
