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
/* ML Items API proxy (v6.7.0)                                        */
/*                                                                    */
/* Article pages on articulo.mercadolibre.com.ve are SPAs — fetch()   */
/* returns a 24KB HTML shell without product data. The ML API         */
/* /items/{id} returns structured JSON with everything we need.       */
/*                                                                    */
/* Endpoints:                                                         */
/*   GET /items/{id}            → title, price, seller, specs, pics   */
/*   GET /items/{id}/reviews    → rating_average, total reviews        */
/*   GET /users/{seller_id}     → seller nickname, reputation, sales  */
/* ------------------------------------------------------------------ */

async function fetchItem(itemId, accessToken) {
  if (!itemId) return { success: false, error: 'No item id' };
  const url = `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`;
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
    return { success: true, item: data };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

async function fetchItemReviews(itemId, accessToken) {
  if (!itemId) return { success: false, error: 'No item id' };
  const url = `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/reviews`;
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
    return { success: true, reviews: data };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

async function fetchSeller(sellerId, accessToken) {
  if (!sellerId) return { success: false, error: 'No seller id' };
  const url = `https://api.mercadolibre.com/users/${encodeURIComponent(sellerId)}`;
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
    return { success: true, seller: data };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* ML Sell API (v6.12.0)                                              */
/*                                                                    */
/* Fetches the full item data (with attributes + description), then  */
/* creates a copy under the user's account via POST /items.            */
/*                                                                    */
/* Based on the user's original Node.js code that:                    */
/*   1. GET /items/{id}?include_attributes=all → full product JSON    */
/*   2. GET /items/{id}/description → description text                 */
/*   3. POST /items → create new listing (price * 1.2 markup)         */
/*   4. POST /items/{newId}/description → add description with ref    */
/* ------------------------------------------------------------------ */

async function fetchFullItem(itemId, accessToken) {
  if (!itemId) return { success: false, error: 'No item id' };
  const headers = {};
  if (accessToken && typeof accessToken === 'string' && accessToken.trim()) {
    headers['Authorization'] = 'Bearer ' + accessToken.trim();
  }
  try {
    // Get full item data
    const itemUrl = `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}?include_attributes=all`;
    const itemRes = await fetch(itemUrl, { headers, credentials: 'omit' });
    if (!itemRes.ok) {
      const text = await itemRes.text().catch(() => '');
      return { success: false, error: 'HTTP ' + itemRes.status, body: text };
    }
    const item = await itemRes.json();

    // Get description (separate endpoint)
    let description = '';
    try {
      const descRes = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/description`, { headers, credentials: 'omit' });
      if (descRes.ok) {
        const descData = await descRes.json();
        description = descData.plain_text || descData.text || '';
      }
    } catch (e) { /* description is optional */ }

    return { success: true, item, description };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

async function postItem(itemData, accessToken) {
  if (!accessToken || !accessToken.trim()) {
    return { success: false, error: 'No access token. Pega tu token en Filtros & Config.' };
  }
  try {
    const res = await fetch('https://api.mercadolibre.com/items', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken.trim(),
        'Content-Type': 'application/json'
      },
      credentials: 'omit',
      body: JSON.stringify(itemData)
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    if (!res.ok) {
      const errMsg = data.message || data.error || ('HTTP ' + res.status);
      const cause = data.cause ? JSON.stringify(data.cause).substring(0, 300) : '';
      return { success: false, error: errMsg + (cause ? ' — ' + cause : ''), status: res.status, body: text.substring(0, 500) };
    }
    return { success: true, item: data };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

async function postItemDescription(itemId, descriptionText, accessToken) {
  if (!accessToken || !accessToken.trim()) return { success: false, error: 'No token' };
  try {
    const res = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/description`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken.trim(),
        'Content-Type': 'application/json'
      },
      credentials: 'omit',
      body: JSON.stringify({ plain_text: descriptionText })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, error: 'HTTP ' + res.status, body: text.substring(0, 200) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* Message router                                                     */
/* ------------------------------------------------------------------ */

// v6.8.0: pending article extraction requests — keyed by tab id.
// When a tab finishes loading an article, the content script sends
// ARTICLE_EXTRACTED with the data, and we resolve the waiting promise.
const pendingArticleExtractions = new Map(); // tabId -> { resolve, reject, timer }

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request !== 'object') return;

  switch (request.action) {
    // v6.8.0: open article in a real browser tab (with cookies/session),
    // wait for the content script to scrape the rendered DOM, return data.
    // This replaces the broken fetch()-based approach (ML serves SPAs).
    case 'FETCH_ARTICLE_IN_TAB': {
      const url = request.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        sendResponse({ success: false, error: 'Invalid url' });
        return true;
      }
      (async () => {
        try {
          // Open a new tab in the background (active=false)
          const tab = await chrome.tabs.create({ url, active: false });
          if (!tab || !tab.id) {
            sendResponse({ success: false, error: 'Failed to create tab' });
            return;
          }
          // Wait for the content script on that tab to send ARTICLE_EXTRACTED
          const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingArticleExtractions.delete(tab.id);
              reject(new Error('Tab extraction timeout (30s)'));
            }, 30000);
            pendingArticleExtractions.set(tab.id, { resolve, reject, timer: timeout });
          });
          // Close the tab after extraction
          chrome.tabs.remove(tab.id).catch(() => {});
          sendResponse(result);
        } catch (err) {
          sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
        }
      })();
      return true;
    }

    // v6.8.0: content script sends this after scraping an article page
    case 'ARTICLE_EXTRACTED': {
      const tabId = sender.tab && sender.tab.id;
      const pending = pendingArticleExtractions.get(tabId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingArticleExtractions.delete(tabId);
        pending.resolve(request.data || { success: false, error: 'No data from content script' });
      }
      sendResponse({ success: true });
      return true;
    }

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

    // v6.7.0: ML Items API — replaces HTML scraping for article data
    case 'FETCH_ITEM': {
      (async () => {
        const tokenData = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
        const token = tokenData[STORAGE_KEYS.ACCESS_TOKEN] || '';
        const result = await fetchItem(request.itemId, token);
        sendResponse(result);
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'FETCH_ITEM_REVIEWS': {
      (async () => {
        const tokenData = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
        const token = tokenData[STORAGE_KEYS.ACCESS_TOKEN] || '';
        const result = await fetchItemReviews(request.itemId, token);
        sendResponse(result);
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'FETCH_SELLER': {
      (async () => {
        const tokenData = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
        const token = tokenData[STORAGE_KEYS.ACCESS_TOKEN] || '';
        const result = await fetchSeller(request.sellerId, token);
        sendResponse(result);
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    // v6.12.0: Sell feature — fetch full item + POST new listing + description
    case 'FETCH_FULL_ITEM': {
      (async () => {
        const tokenData = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
        const token = tokenData[STORAGE_KEYS.ACCESS_TOKEN] || '';
        const result = await fetchFullItem(request.itemId, token);
        sendResponse(result);
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'POST_ITEM': {
      (async () => {
        const tokenData = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
        const token = tokenData[STORAGE_KEYS.ACCESS_TOKEN] || '';
        const result = await postItem(request.itemData, token);
        sendResponse(result);
      })().catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'POST_ITEM_DESC': {
      (async () => {
        const tokenData = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
        const token = tokenData[STORAGE_KEYS.ACCESS_TOKEN] || '';
        const result = await postItemDescription(request.itemId, request.description, token);
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

    // v6.10.0: Sync to Google Sheets — routed through background SW
    // because content scripts hit CORS errors when POSTing to script.google.com.
    // The background SW has host_permissions and is not subject to CORS.
    // v6.11.1: detect HTML response (Google login/error page) + retry.
    case 'SYNC_TO_SHEETS': {
      (async () => {
        try {
          const urlData = await chrome.storage.local.get('ml_gsheets_url');
          const url = urlData.ml_gsheets_url;
          if (!url || typeof url !== 'string') {
            sendResponse({ success: false, error: 'No Sheets URL configured. Pégala en Filtros & Config.' });
            return;
          }
          const productsData = await chrome.storage.local.get(STORAGE_KEYS.PRODUCTS);
          const products = Array.isArray(productsData[STORAGE_KEYS.PRODUCTS]) ? productsData[STORAGE_KEYS.PRODUCTS] : [];
          if (products.length === 0) {
            sendResponse({ success: false, error: 'No hay productos para sincronizar.' });
            return;
          }

          // Helper: do the POST, return {ok, json, text, status}
          async function doSync(attempt) {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({ action: 'sync', products: products })
            });
            const text = await response.text();
            // v6.11.1: detect HTML response (Google login/consent/error page)
            const trimmed = text.trim();
            const isHTML = trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE') ||
                           trimmed.indexOf('<html') !== -1 || trimmed.indexOf('<HTML') !== -1;
            if (isHTML) {
              return {
                ok: false,
                error: 'Google devolvió HTML en vez de JSON. Esto pasa cuando:\n' +
                       '• La implementación del Apps Script expiró\n' +
                       '• Necesitas re-autorizar el script\n' +
                       '• La sesión de Google caducó\n\n' +
                       'Solución:\n' +
                       '1. Abre tu Google Sheet\n' +
                       '2. Extensiones → Apps Script\n' +
                       '3. Implementar → Gestionar implementaciones\n' +
                       '4. Edita la implementación → nueva versión\n' +
                       '5. Vuelve a autorizar los permisos\n' +
                       '6. Copia la nueva URL si cambió',
                status: response.status,
                isHTML: true
              };
            }
            // Try to parse as JSON
            let json;
            try {
              json = JSON.parse(trimmed);
            } catch (parseErr) {
              return {
                ok: false,
                error: 'Respuesta no es JSON válido: ' + trimmed.substring(0, 100),
                status: response.status
              };
            }
            return { ok: response.ok, json, status: response.status };
          }

          // First attempt
          let result = await doSync(1);
          // v6.11.1: retry once after 2s if HTML or 5xx
          if (!result.ok && (result.isHTML || (result.status && result.status >= 500))) {
            await new Promise(r => setTimeout(r, 2000));
            result = await doSync(2);
          }

          if (!result.ok) {
            sendResponse({ success: false, error: result.error || ('HTTP ' + result.status) });
            return;
          }
          sendResponse(result.json);
        } catch (err) {
          sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
        }
      })();
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
