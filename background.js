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
  QUEUE_WORK: 'ml_queue_work',       // v6.3.0: persisted crawl phrase/URL queue (multi-tab sync)
  ACCESS_TOKEN: 'ml_access_token',   // v6.3.0: ML API token for visits endpoint
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
  if (!Array.isArray(cur[STORAGE_KEYS.QUEUE_WORK])) patch[STORAGE_KEYS.QUEUE_WORK] = [];
  if (typeof cur[STORAGE_KEYS.ACCESS_TOKEN] !== 'string') patch[STORAGE_KEYS.ACCESS_TOKEN] = '';
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
  // v6.5.0: strip hyphens/underscores → MLV702250939 (no separators)
  return m ? m[0].replace(/[-_]/g, '').toUpperCase() : null;
}

/* ------------------------------------------------------------------ */
/* In-memory cache + debounced persistence                            */
/*                                                                    */
/* At scale (thousands of products), reading+writing ALL products to  */
/* chrome.storage.local on every SAVE_PRODUCTS message is the         */
/* bottleneck. We keep an in-memory Map keyed by product id, merge     */
/* deltas into it in O(1) per product, and flush to storage on a      */
/* debounce so a crawl that saves every 3 pages only writes once.    */
/* ------------------------------------------------------------------ */

let productsCache = null;      // Map<id, product> or null (not yet loaded)
let deepQueueCache = null;    // Array
let flushTimer = null;
const FLUSH_DELAY_MS = 400;   // debounce window

async function ensureCacheLoaded() {
  if (productsCache !== null) return;
  const data = await chrome.storage.local.get([STORAGE_KEYS.PRODUCTS, STORAGE_KEYS.DEEP_QUEUE]);
  const prods = Array.isArray(data[STORAGE_KEYS.PRODUCTS]) ? data[STORAGE_KEYS.PRODUCTS] : [];
  productsCache = new Map();
  for (const p of prods) {
    const id = p.id || extractMlvId(p.Link) || p.Nombre;
    if (id) productsCache.set(id, p);
  }
  deepQueueCache = Array.isArray(data[STORAGE_KEYS.DEEP_QUEUE]) ? data[STORAGE_KEYS.DEEP_QUEUE] : [];
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (productsCache !== null) {
      await chrome.storage.local.set({ [STORAGE_KEYS.PRODUCTS]: Array.from(productsCache.values()) });
    }
    if (deepQueueCache !== null) {
      await chrome.storage.local.set({ [STORAGE_KEYS.DEEP_QUEUE]: deepQueueCache });
    }
  }, FLUSH_DELAY_MS);
}

/** Idempotent merge into in-memory cache; schedules debounced flush. */
async function mergeProducts(incoming) {
  if (!Array.isArray(incoming)) return;
  await ensureCacheLoaded();
  for (const p of incoming) {
    if (!p || typeof p !== 'object') continue;
    const id = p.id || extractMlvId(p.Link) || p.Nombre;
    if (!id) continue;
    const existing = productsCache.get(id);
    if (existing) productsCache.set(id, { ...existing, ...p, id });
    else productsCache.set(id, { ...p, id });
  }
  scheduleFlush();
}

/** Force an immediate flush (used by CLEAR_ALL, EXPORT_CSV, GET_ALL_DATA). */
async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (productsCache !== null) {
    await chrome.storage.local.set({ [STORAGE_KEYS.PRODUCTS]: Array.from(productsCache.values()) });
  }
  if (deepQueueCache !== null) {
    await chrome.storage.local.set({ [STORAGE_KEYS.DEEP_QUEUE]: deepQueueCache });
  }
}

async function setDeepQueue(queue) {
  // Dedup by MLV id (or Link), preserve order of first occurrence.
  await ensureCacheLoaded();
  const seen = new Set();
  const out = [];
  for (const item of queue) {
    if (!item) continue;
    const id = typeof item === 'string' ? extractMlvId(item) || item : (item.id || extractMlvId(item.Link) || item.Link);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  deepQueueCache = out;
  scheduleFlush();
}

/** REPLACE (not merge) the entire products array. Used by the reset button. */
async function replaceProducts(products) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const arr = Array.isArray(products) ? products : [];
  productsCache = new Map();
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const id = p.id || extractMlvId(p.Link) || p.Nombre;
    if (id) productsCache.set(id, { ...p, id });
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.PRODUCTS]: Array.from(productsCache.values()) });
}

/** REPLACE (not merge) the deep queue. Used by reset. */
async function replaceDeepQueue(queue) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await ensureCacheLoaded();
  const seen = new Set();
  const out = [];
  for (const item of (Array.isArray(queue) ? queue : [])) {
    if (!item) continue;
    const id = typeof item === 'string' ? extractMlvId(item) || item : (item.id || extractMlvId(item.Link) || item.Link);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  deepQueueCache = out;
  await chrome.storage.local.set({ [STORAGE_KEYS.DEEP_QUEUE]: out });
}

/** Persist the crawl phrase/URL queue (so reset syncs across tabs). */
async function setQueueWork(queue) {
  const arr = Array.isArray(queue) ? queue : [];
  await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE_WORK]: arr });
}

/* ------------------------------------------------------------------ */
/* ML Visits API proxy                                                */
/*                                                                    */
/* Calls GET /items/{item_id}/visits/time_window on api.mercadolibre  */
/* on behalf of the content script. Content scripts can't call the   */
/* API directly because of CORS — only the SW (with host_permissions) */
/* can. The endpoint is public but accepts an optional Bearer token  */
/* for higher rate limits.                                            */
/* ------------------------------------------------------------------ */

async function fetchVisits(itemId, accessToken) {
  if (!itemId) return { success: false, error: 'No item id' };
  // ML item ids in VE look like MLV752021494. The visits API accepts them
  // as-is (no country prefix needed — the id encodes the site).
  const url = `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/visits/time_window?last=10&unit=day`;
  const headers = {};
  if (accessToken && typeof accessToken === 'string' && accessToken.trim()) {
    headers['Authorization'] = 'Bearer ' + accessToken.trim();
  }
  try {
    const response = await fetch(url, { headers, credentials: 'omit' });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: 'HTTP ' + response.status, body: text };
    }
    const data = await response.json();
    // API returns: [{ date, total, visits_delayed }, ...] (10 days by default)
    // Sum total visits across the window.
    let totalVisits = 0;
    if (Array.isArray(data)) {
      for (const day of data) {
        if (day && typeof day.total === 'number') totalVisits += day.total;
      }
    }
    return { success: true, visits: totalVisits, raw: data };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
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

    case 'SAVE_QUEUE_WORK': {
      setQueueWork(request.queueWork || [])
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'SET_ACCESS_TOKEN': {
      chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: String(request.token || '') })
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'FETCH_VISITS': {
      (async () => {
        const tokenData = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
        const token = tokenData[STORAGE_KEYS.ACCESS_TOKEN] || '';
        const result = await fetchVisits(request.itemId, token);
        sendResponse(result);
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'GET_ALL_DATA': {
      (async () => {
        await flushNow();
        const data = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
        sendResponse({
          products: Array.isArray(data[STORAGE_KEYS.PRODUCTS]) ? data[STORAGE_KEYS.PRODUCTS] : [],
          deepQueue: Array.isArray(data[STORAGE_KEYS.DEEP_QUEUE]) ? data[STORAGE_KEYS.DEEP_QUEUE] : [],
          queueWork: Array.isArray(data[STORAGE_KEYS.QUEUE_WORK]) ? data[STORAGE_KEYS.QUEUE_WORK] : [],
          accessToken: typeof data[STORAGE_KEYS.ACCESS_TOKEN] === 'string' ? data[STORAGE_KEYS.ACCESS_TOKEN] : '',
          config: data[STORAGE_KEYS.CONFIG] || DEFAULT_CONFIG,
          panelVisible: data[STORAGE_KEYS.PANEL_VISIBLE] !== false
        });
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'CLEAR_ALL': {
      (async () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        productsCache = new Map();
        deepQueueCache = [];
        // v6.3.0: also clear the crawl phrase/URL queue so reset syncs across tabs
        await chrome.storage.local.set({
          [STORAGE_KEYS.PRODUCTS]: [],
          [STORAGE_KEYS.DEEP_QUEUE]: [],
          [STORAGE_KEYS.QUEUE_WORK]: []
        });
        sendResponse({ success: true });
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
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
      (async () => {
        await flushNow();
        const data = await chrome.storage.local.get(STORAGE_KEYS.PRODUCTS);
        const products = Array.isArray(data[STORAGE_KEYS.PRODUCTS]) ? data[STORAGE_KEYS.PRODUCTS] : [];
        sendResponse({ success: true, products });
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
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
