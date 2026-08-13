/* =========================================================================
 * MercadoLibre VE Scraper — Background Service Worker (v6.0.0)
 * =========================================================================
 *
 * Responsibilities:
 *   - Be the SINGLE source of truth for `ml_products` and `ml_deep_queue`.
 *   - MERGE products by MLV id (idempotent) so concurrent tabs cannot clobber
 *     each other's data.
 *   - Perform FETCH_ARTICLE requests on behalf of content scripts (bypasses
 *     CORS / same-origin restrictions of content scripts).
 *   - Broadcast storage changes so every open ML tab refreshes its UI live
 *     (chrome.storage.onChanged already does this, but we also expose a
 *     FETCH_ALL message for the initial bootstrap).
 *   - Toggle the panel visibility on the active ML tab when the user clicks
 *     the toolbar icon (handled in popup.js, but we expose a helper).
 * =========================================================================
 */

const STORAGE_KEYS = {
  PRODUCTS: 'ml_products',
  DEEP_QUEUE: 'ml_deep_queue',
  CONFIG: 'ml_config',
  PANEL_VISIBLE: 'ml_panel_visible'
};

const DEFAULT_CONFIG = {
  minSales: 0,
  minScore: 0,
  requireFreeShipping: true,
  fetchDelayMs: 1200
};

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  const patch = {};
  if (!Array.isArray(cur[STORAGE_KEYS.PRODUCTS])) patch[STORAGE_KEYS.PRODUCTS] = [];
  if (!Array.isArray(cur[STORAGE_KEYS.DEEP_QUEUE])) patch[STORAGE_KEYS.DEEP_QUEUE] = [];
  if (typeof cur[STORAGE_KEYS.CONFIG] !== 'object' || cur[STORAGE_KEYS.CONFIG] === null) {
    patch[STORAGE_KEYS.CONFIG] = DEFAULT_CONFIG;
  }
  if (typeof cur[STORAGE_KEYS.PANEL_VISIBLE] !== 'boolean') {
    patch[STORAGE_KEYS.PANEL_VISIBLE] = true;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function extractMlvId(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/MLV[-_]?\d+/i);
  return m ? m[0].replace('_', '-').toUpperCase() : null;
}

/** Idempotent merge: existing product is updated, new ones appended. */
async function mergeProducts(incoming) {
  if (!Array.isArray(incoming)) return;
  const data = await chrome.storage.local.get(STORAGE_KEYS.PRODUCTS);
  const current = Array.isArray(data[STORAGE_KEYS.PRODUCTS]) ? data[STORAGE_KEYS.PRODUCTS] : [];
  const byId = new Map();
  for (const p of current) {
    const id = p.id || extractMlvId(p.Link) || p.Nombre;
    if (id) byId.set(id, p);
  }
  let changed = false;
  for (const p of incoming) {
    if (!p || typeof p !== 'object') continue;
    const id = p.id || extractMlvId(p.Link) || p.Nombre;
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, { ...existing, ...p, id });
      changed = true;
    } else {
      byId.set(id, { ...p, id });
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEYS.PRODUCTS]: Array.from(byId.values()) });
  }
}

async function setDeepQueue(queue) {
  // Dedup by MLV id (or Link), preserve order of first occurrence.
  const seen = new Set();
  const out = [];
  for (const item of queue) {
    if (!item) continue;
    const id = typeof item === 'string' ? extractMlvId(item) || item : (item.id || extractMlvId(item.Link) || item.Link);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.DEEP_QUEUE]: out });
}

/* ------------------------------------------------------------------ */
/* Message router                                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request !== 'object') return;

  switch (request.action) {
    case 'FETCH_ARTICLE': {
      const url = request.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        sendResponse({ success: false, error: 'Invalid url' });
        return true;
      }
      fetch(url, { credentials: 'omit', redirect: 'follow' })
        .then(async (response) => {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const html = await response.text();
          sendResponse({ success: true, html, finalUrl: response.url });
        })
        .catch((err) => sendResponse({ success: false, error: err && err.message ? err.message : String(err) }));
      return true; // async
    }

    case 'SAVE_PRODUCTS': {
      mergeProducts(request.products)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'SAVE_DEEP_QUEUE': {
      setDeepQueue(request.deepQueue || [])
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'GET_ALL_DATA': {
      chrome.storage.local.get(Object.values(STORAGE_KEYS))
        .then((data) => {
          sendResponse({
            products: Array.isArray(data[STORAGE_KEYS.PRODUCTS]) ? data[STORAGE_KEYS.PRODUCTS] : [],
            deepQueue: Array.isArray(data[STORAGE_KEYS.DEEP_QUEUE]) ? data[STORAGE_KEYS.DEEP_QUEUE] : [],
            config: data[STORAGE_KEYS.CONFIG] || DEFAULT_CONFIG,
            panelVisible: data[STORAGE_KEYS.PANEL_VISIBLE] !== false
          });
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'CLEAR_ALL': {
      chrome.storage.local.set({
        [STORAGE_KEYS.PRODUCTS]: [],
        [STORAGE_KEYS.DEEP_QUEUE]: []
      })
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'SET_PANEL_VISIBLE': {
      chrome.storage.local.set({ [STORAGE_KEYS.PANEL_VISIBLE]: !!request.visible })
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'EXPORT_CSV': {
      // CSV is generated client-side (popup or content) so we just return
      // the products for the caller to format.
      chrome.storage.local.get(STORAGE_KEYS.PRODUCTS)
        .then((data) => {
          const products = Array.isArray(data[STORAGE_KEYS.PRODUCTS]) ? data[STORAGE_KEYS.PRODUCTS] : [];
          sendResponse({ success: true, products });
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'PING': {
      sendResponse({ success: true, ts: Date.now() });
      return true;
    }

    default:
      sendResponse({ success: false, error: 'Unknown action: ' + request.action });
      return true;
  }
});

/* ------------------------------------------------------------------ */
/* Toolbar action: click on the icon when no popup → toggle panel      */
/* (popup handles its own clicks; this is a fallback when popup is     */
/*  closed via ESC or when the user clicks outside the popup)          */
/* ------------------------------------------------------------------ */

chrome.action.onClicked.addListener(async (tab) => {
  // This only fires when there's NO popup. Since we set a popup, this
  // won't normally fire — but we keep it for safety in case the popup
  // file fails to load.
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_PANEL' });
  } catch (e) {
    // Tab may not have the content script (non-ML page). Ignore.
  }
});

console.log('[ML Scraper VE] Background service worker v6.0.0 active');
