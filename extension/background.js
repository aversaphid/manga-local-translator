/**
 * Background Service Worker (Manifest V3)
 * Handles cross-origin image fetching, tab screenshot capture (via "tabs" permission),
 * local server communication with IPv4/localhost fallback, and persistent user settings.
 */

const DEFAULT_SETTINGS = {
  backendUrl: "http://127.0.0.1:8000",
  autoTranslate: false,
  overlayOpacity: 1.0,
  renderMode: "clean_and_text",
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
    const targetWindowId = sender.tab ? sender.tab.windowId : null;
    chrome.tabs.captureVisibleTab(targetWindowId, { format: "png" }, (dataUrl) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr || !dataUrl) {
        console.error("[Background] Capture tab error:", lastErr);
        sendResponse({
          success: false,
          error: lastErr?.message || "Failed to capture visible tab."
        });
      } else {
        console.log("[Background] Tab captured successfully. Length:", dataUrl.length);
        sendResponse({ success: true, dataUrl });
      }
    });
    return true;
  }

  if (message.type === "TRANSLATE_PAGE_API") {
    translatePagePayload(message.backendUrl || "http://127.0.0.1:8000", message.payload)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "CHECK_HEALTH") {
    checkBackendHealth(message.backendUrl || "http://127.0.0.1:8000")
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * Fetches an image URL in the background worker and converts to Base64.
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
 * Sends image payload to local FastAPI GPU backend with automatic localhost/127.0.0.1 fallback.
 */
async function translatePagePayload(backendUrl, payload) {
  const urlsToTry = [backendUrl];
  if (backendUrl.includes("localhost")) {
    urlsToTry.push(backendUrl.replace("localhost", "127.0.0.1"));
  } else if (backendUrl.includes("127.0.0.1")) {
    urlsToTry.push(backendUrl.replace("127.0.0.1", "localhost"));
  }

  let lastError = null;
  for (const baseUrl of urlsToTry) {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/translate-page`;
    try {
      console.log("[Background] Sending translation request to:", endpoint);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server returned HTTP ${response.status}: ${errorText}`);
      }

      return await response.json();
    } catch (e) {
      console.warn(`[Background] Failed request to ${baseUrl}:`, e);
      lastError = e;
    }
  }

  throw lastError || new Error("Failed to connect to backend translation server.");
}

/**
 * Checks GPU health and VRAM status.
 */
async function checkBackendHealth(backendUrl) {
  const urlsToTry = [backendUrl];
  if (backendUrl.includes("localhost")) {
    urlsToTry.push(backendUrl.replace("localhost", "127.0.0.1"));
  } else if (backendUrl.includes("127.0.0.1")) {
    urlsToTry.push(backendUrl.replace("127.0.0.1", "localhost"));
  }

  for (const baseUrl of urlsToTry) {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/health`;
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return await response.json();
      }
    } catch (e) {
      // Continue to next fallback
    }
  }

  throw new Error("Cannot connect to translation server on localhost or 127.0.0.1:8000.");
}
