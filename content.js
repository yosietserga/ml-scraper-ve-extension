/* =========================================================================
 * MercadoLibre VE Scraper — Content Script (v6.0.0)
 * =========================================================================
 *
 * Full-feature migration of the v4.0.5 userscript into the Chrome MV3
 * extension architecture, with every issue from the Gemini-proposed
 * v5.0.0 fixed:
 *
 *   - Crawler restored (queue, pagination, pause, reset)
 *   - Swipe gestures restored (left=delete, right=+Deep)
 *   - Notification sound on completion
 *   - Preview card on hover
 *   - Deep extraction via background service worker (bypasses CORS)
 *   - Cross-tab live sync via chrome.storage.onChanged
 *   - XSS-safe DOM construction (escapeHtml everywhere)
 *   - Blob-based CSV download (no data: URI breakage)
 *   - URL observer for SPA navigation (isArticlePage recomputed)
 *   - Panel hide (not remove) on close; toolbar icon toggles it back
 *   - Service-worker-asleep / invalidated-context handling
 *   - Marca / Modelo / Especificaciones restored
 *   - Currency column added (USD vs Bs)
 *   - Idempotent product objects (stable id = MLV id)
 * =========================================================================
 */

(function () {
  'use strict';

  /* Prevent double-injection (SPA navigations can re-run content scripts
     in some Chrome versions; guard with a window flag). */
  if (window.__ML_SCRAPER_V6_LOADED__) return;
  window.__ML_SCRAPER_V6_LOADED__ = true;

  const EXT_VERSION = '6.12.0';
  const STORAGE_KEY_PRODUCTS = 'ml_products';
  const STORAGE_KEY_QUEUE = 'ml_deep_queue';
  const STORAGE_KEY_QUEUE_WORK = 'ml_queue_work';        // v6.3.0: persisted crawl phrase/URL queue
  const STORAGE_KEY_ACCESS_TOKEN = 'ml_access_token';    // v6.3.0: ML API token for visits
  const STORAGE_KEY_GSHEETS_URL = 'ml_gsheets_url';      // v6.9.0: Google Sheets web app URL
  const STORAGE_KEY_PANEL = 'ml_panel_visible';

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */

  let isArticlePage = computeIsArticlePage();
  let products = [];
  let deepQueue = [];
  let queueWork = [];           // v6.3.0: now persisted (was local-only in v6.2.0)
  let panelVisible = true;

  // Crawler state (queueWork is declared above — persisted across tabs in v6.3.0)
  let currentSearchProcess = null;
  let isCrawling = false;
  let isPaused = false;
  let isDeepCrawling = false;
  let visitedUrls = new Set();
  let processedPagesCount = 0;
  let currentBaseSlug = '';
  let currentOffset = 1;

  // Virtualization: only render visible products to avoid DOM death at 5000+
  let visibleCount = 50;
  const VISIBLE_INCREMENT = 50;

  function computeIsArticlePage() {
    return location.hostname.indexOf('articulo.mercadolibre.com') !== -1;
  }

  /* ------------------------------------------------------------------ */
  /* Safe messaging                                                     */
  /* ------------------------------------------------------------------ */

  function sendMessage(request) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(request, (response) => {
          if (chrome.runtime.lastError) {
            // Service worker may be asleep or context invalidated.
            // Retry once after a short delay.
            setTimeout(() => {
              try {
                chrome.runtime.sendMessage(request, (r) => {
                  resolve(chrome.runtime.lastError ? null : r);
                });
              } catch (e) {
                resolve(null);
              }
            }, 300);
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* XSS-safe DOM helpers                                              */
  /* ------------------------------------------------------------------ */

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(s) { return escapeHtml(s); }

  /* ------------------------------------------------------------------ */
  /* Storage sync                                                     */
  /* ------------------------------------------------------------------ */

  function persistProducts() { return sendMessage({ action: 'SAVE_PRODUCTS', products }); }
  function persistDeepQueue() { return sendMessage({ action: 'SAVE_DEEP_QUEUE', deepQueue }); }
  function persistQueueWork() { return sendMessage({ action: 'SAVE_QUEUE_WORK', queueWork }); }
  function setAccessToken(token) { return sendMessage({ action: 'SET_ACCESS_TOKEN', token }); }

  async function loadAll() {
    const r = await sendMessage({ action: 'GET_ALL_DATA' });
    if (r && r.success !== false) {
      products = Array.isArray(r.products) ? r.products : [];
      deepQueue = Array.isArray(r.deepQueue) ? r.deepQueue : [];
      queueWork = Array.isArray(r.queueWork) ? r.queueWork : [];
      panelVisible = r.panelVisible !== false;
      // Populate the access token field if present
      const tokenInput = document.getElementById('cfg-access-token');
      if (tokenInput && typeof r.accessToken === 'string') tokenInput.value = r.accessToken;
    }
  }

  // Cross-tab live sync: when another tab (or the popup) modifies storage,
  // reflect it here. DEBOUNCED so a crawl that saves 100 pages doesn't
  // trigger 100 full re-renders (each O(n) at thousands of products).
  let renderDebounceTimer = null;
  let queueRenderDebounceTimer = null;
  function debouncedRenderResults() {
    if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => {
      renderDebounceTimer = null;
      renderResults();
    }, 250);
  }
  function debouncedRenderQueue() {
    if (queueRenderDebounceTimer) clearTimeout(queueRenderDebounceTimer);
    queueRenderDebounceTimer = setTimeout(() => {
      queueRenderDebounceTimer = null;
      renderQueueUI();
    }, 150);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let touched = false;
    if (changes[STORAGE_KEY_PRODUCTS]) {
      products = Array.isArray(changes[STORAGE_KEY_PRODUCTS].newValue) ? changes[STORAGE_KEY_PRODUCTS].newValue : [];
      touched = true;
    }
    if (changes[STORAGE_KEY_QUEUE]) {
      deepQueue = Array.isArray(changes[STORAGE_KEY_QUEUE].newValue) ? changes[STORAGE_KEY_QUEUE].newValue : [];
      touched = true;
    }
    // v6.3.0: sync the crawl phrase/URL queue across tabs
    if (changes[STORAGE_KEY_QUEUE_WORK]) {
      queueWork = Array.isArray(changes[STORAGE_KEY_QUEUE_WORK].newValue) ? changes[STORAGE_KEY_QUEUE_WORK].newValue : [];
      // Only re-render the queue UI; don't restart crawling in this tab
      // (the tab that owns the active crawl continues it).
      debouncedRenderQueue();
    }
    if (changes[STORAGE_KEY_PANEL]) {
      panelVisible = changes[STORAGE_KEY_PANEL].newValue !== false;
      applyPanelVisibility();
    }
    if (touched) debouncedRenderResults();
  });

  // Toolbar icon "toggle panel" fallback
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'TOGGLE_PANEL') {
      panelVisible = !panelVisible;
      sendMessage({ action: 'SET_PANEL_VISIBLE', visible: panelVisible });
      applyPanelVisibility();
      sendResponse({ success: true, visible: panelVisible });
    }
    if (request && request.action === 'SHOW_PANEL') {
      panelVisible = true;
      applyPanelVisibility();
      sendResponse({ success: true });
    }
    if (request && request.action === 'HIDE_PANEL') {
      panelVisible = false;
      applyPanelVisibility();
      sendResponse({ success: true });
    }
  });

  /* ------------------------------------------------------------------ */
  /* SPA navigation observer                                           */
  /* ------------------------------------------------------------------ */

  let lastPath = location.pathname;
  let navObserver = null;
  function watchSpaNavigation() {
    // Scope to <title> + <body> childList only — watching documentElement
    // with subtree:true fires on every DOM mutation (thousands/sec on ML's
    // SPA), causing the observer callback to run constantly even when the
    // path hasn't changed. We also poll location.pathname every 500ms as a
    // fallback for SPAs that don't mutate <title> on route change.
    const checkNav = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        const wasArticle = isArticlePage;
        isArticlePage = computeIsArticlePage();
        if (wasArticle !== isArticlePage) {
          rebuildModal();
        }
      }
    };
    // Lightweight poll — cheaper than a full-subtree MutationObserver
    setInterval(checkNav, 800);
    // Also hook into popstate + pushState for immediate response
    window.addEventListener('popstate', checkNav);
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function () { const r = origPushState.apply(this, arguments); setTimeout(checkNav, 50); return r; };
    history.replaceState = function () { const r = origReplaceState.apply(this, arguments); setTimeout(checkNav, 50); return r; };
  }

  /* ------------------------------------------------------------------ */
  /* Sound                                                              */
  /* ------------------------------------------------------------------ */

  function playNotificationSound() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.5);
    } catch (e) { /* no-op */ }
  }

  /* ------------------------------------------------------------------ */
  /* Icons                                                            */
  /* ------------------------------------------------------------------ */

  const ICONS = {
    pause: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
    play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    reset: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    close: '&#10005;'
  };

  /* ------------------------------------------------------------------ */
  /* CSS                                                            */
  /* ------------------------------------------------------------------ */

  const STYLE_TEXT = `
    @keyframes gradientGlow {
      0% { box-shadow: 0 0 8px rgba(52, 131, 250, 0.4); border-color: #3483fa; }
      50% { box-shadow: 0 0 18px rgba(255, 241, 89, 0.9), 0 0 25px rgba(52, 131, 250, 0.7); border-color: #fff159; }
      100% { box-shadow: 0 0 8px rgba(52, 131, 250, 0.4); border-color: #3483fa; }
    }
    @keyframes pulseBtn {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes swipeFadeOut {
      0% { opacity: 1; transform: translateX(0); }
      100% { opacity: 0; transform: translateX(-100%); height: 0; margin: 0; padding: 0; }
    }
    #ml-crawler-modal {
      position: fixed; top: 15px; right: 15px; width: 490px; z-index: 2147483647;
      background: #ffffff; color: #333333; border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.3); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden; border: 2px solid #e0e0e0; transition: all 0.3s ease;
    }
    #ml-crawler-modal.ml-hidden { display: none; }
    #ml-crawler-modal.crawling-active { animation: gradientGlow 2.5s infinite ease-in-out; }
    .ml-header { background: #fff159; padding: 10px 14px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e5d84f; }
    .ml-header-title { display: flex; align-items: center; gap: 8px; }
    .ml-header-logo { width: 20px; height: 20px; border-radius: 4px; }
    .ml-tabs { display: flex; background: #f5f5f5; border-bottom: 1px solid #ddd; }
    .ml-tab { flex: 1; padding: 10px 4px; text-align: center; cursor: pointer; font-size: 12px; font-weight: 600; color: #666; transition: 0.2s; }
    .ml-tab.active { background: #fff; color: #333; border-bottom: 3px solid #2d3277; }
    .ml-content { padding: 14px; max-height: 520px; overflow-y: auto; }
    .ml-content::-webkit-scrollbar { width: 8px; }
    .ml-content::-webkit-scrollbar-thumb { background: #c8c8c8; border-radius: 4px; }
    .ml-tab-body { display: none; }
    .ml-tab-body.active { display: block; }
    .ml-input-group { margin-bottom: 10px; }
    .ml-input-group label { display: block; font-size: 11px; font-weight: 600; margin-bottom: 4px; color: #555; }
    .ml-input-group input, .ml-input-group select, .ml-input-group textarea { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 12px; }
    .ml-btn-group { display: flex; gap: 6px; margin-top: 10px; align-items: center; }
    .ml-btn { padding: 7px 10px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 11px; transition: 0.2s; display: inline-flex; align-items: center; justify-content: center; }
    .ml-btn-icon { width: 32px; height: 32px; padding: 0; border-radius: 50%; }
    .ml-btn-primary { background: #3483fa; color: #fff; flex: 1; }
    .ml-btn-primary.animating { background: linear-gradient(270deg, #3483fa, #00a650, #fff159, #3483fa); background-size: 400% 400%; animation: pulseBtn 3s infinite ease; color: #111; }
    .ml-btn-secondary { background: #e6e6e6; color: #333; }
    .ml-btn-danger { background: #ff5252; color: #fff; }
    .ml-btn-success { background: #00a650; color: #fff; flex: 1; }
    .ml-btn-purple { background: #2d3277; color: #fff; flex: 1; }
    .ml-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .ml-progress-bar { width: 100%; background: #eee; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 10px; }
    .ml-progress-fill { width: 0%; height: 100%; background: #00a650; transition: width 0.3s; }
    .ml-stats { font-size: 11px; margin-top: 6px; color: #666; display: flex; justify-content: space-between; }
    .ml-queue-box { margin-top: 12px; border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px; background: #fafafa; }
    .ml-queue-title { font-size: 11px; font-weight: bold; color: #444; margin-bottom: 6px; }
    .ml-queue-item { display: flex; align-items: center; justify-content: space-between; background: #fff; border: 1px solid #ddd; padding: 4px 8px; border-radius: 4px; margin-bottom: 4px; font-size: 11px; }
    .ml-item-card { background: #fdfdfd; border: 1px solid #e8e8e8; border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; position: relative; user-select: none; touch-action: pan-y; transition: transform 0.15s ease-out, opacity 0.3s; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .ml-item-card.selected-for-deep { border-left: 4px solid #2d3277; background: #f0f4ff; }
    .ml-item-card.removing { animation: swipeFadeOut 0.4s forwards; }
    .ml-item-img { width: 42px; height: 42px; border-radius: 4px; object-fit: cover; border: 1px solid #ddd; cursor: pointer; flex-shrink: 0; }
    .ml-item-info { flex: 1; overflow: hidden; cursor: pointer; }
    .ml-item-title { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #2d3277; }
    .ml-item-details { font-size: 10px; color: #666; display: flex; gap: 6px; margin-top: 2px; flex-wrap: wrap; }
    .ml-item-price { font-weight: bold; color: #00a650; }
    .ml-badge-sales { background: #e3f2fd; color: #0d47a1; padding: 1px 4px; border-radius: 3px; font-weight: bold; font-size: 9px; }
    .ml-badge-visits { background: #fce4ec; color: #ad1457; padding: 1px 4px; border-radius: 3px; font-weight: bold; font-size: 9px; }
    #ml-preview-card { position: fixed; width: 230px; background: #fff; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,0.25); padding: 10px; z-index: 2147483647; pointer-events: none; display: none; font-size: 11px; }
    #ml-preview-card img { width: 100%; height: 140px; object-fit: contain; border-radius: 4px; margin-bottom: 6px; }
    #ml-notification-banner { display: none; background: #00a650; color: #fff; padding: 10px; border-radius: 6px; font-size: 12px; text-align: center; font-weight: bold; margin-bottom: 10px; }
    .ml-detail-box { background: #f8f9fa; border: 1px solid #ddd; border-radius: 6px; padding: 8px; margin-top: 8px; font-size: 11px; }
    .ml-detail-row { display: flex; justify-content: space-between; border-bottom: 1px solid #eee; padding: 3px 0; }
    .ml-debug-box { background: #1e1e1e; color: #00ff66; font-family: monospace; font-size: 10px; padding: 8px; border-radius: 6px; word-break: break-all; margin-bottom: 10px; max-height: 60px; overflow-y: auto; }
  `;

  /* ------------------------------------------------------------------ */
  /* DOM root                                                          */
  /* ------------------------------------------------------------------ */

  let styleEl = null;
  let previewCard = null;
  let modal = null;

  function ensureStyles() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-ml-scraper', 'v6');
    styleEl.textContent = STYLE_TEXT;
    document.head.appendChild(styleEl);
  }

  function ensurePreviewCard() {
    if (previewCard) return;
    previewCard = document.createElement('div');
    previewCard.id = 'ml-preview-card';
    document.body.appendChild(previewCard);
  }

  function logoIconUrl() {
    try {
      return chrome.runtime.getURL('icons/icon48.png');
    } catch (e) {
      return '';
    }
  }

  function buildModalHtml() {
    return `
      <div class="ml-header">
        <div class="ml-header-title" id="ml-header-title" style="cursor:pointer; flex:1;" title="Doble clic para colapsar/expandir">
          ${logoIconUrl() ? `<img src="${escapeAttr(logoIconUrl())}" class="ml-header-logo" alt="ML">` : ''}
          <span>ML Scraper VE v${EXT_VERSION}</span>
        </div>
        <span class="ml-close-btn" id="ml-collapse" title="Colapsar / Expandir panel" style="margin-right:8px; cursor:pointer; font-size:14px;">▼</span>
        <span class="ml-close-btn" id="ml-close" title="Ocultar panel (usa el ícono de la extensión para mostrarlo de nuevo)">${ICONS.close}</span>
      </div>
      <div class="ml-body-wrapper" id="ml-body-wrapper">
      <div class="ml-tabs">
        ${!isArticlePage ? '<div class="ml-tab active" data-target="tab-search">Buscador</div>' : ''}
        <div class="ml-tab ${isArticlePage ? 'active' : ''}" data-target="tab-results">Resultados (<span id="tab-count">${products.length}</span>)</div>
        <div class="ml-tab" data-target="tab-config">Filtros & Config</div>
      </div>
      <div class="ml-content">
        <div id="ml-notification-banner">&#10004; ¡Extracción Profunda Completada!</div>

        <div class="ml-debug-box" id="url-debugger">
          [Extension V6 ServiceWorker]: Conectado y listo. Sincronización entre pestañas activa.
        </div>

        ${!isArticlePage ? `
        <div id="tab-search" class="ml-tab-body active">
          <div class="ml-input-group">
            <label>Término(s) de Búsqueda o URL de MercadoLibre (Enter para agregar, coma o salto de línea para múltiples):</label>
            <textarea id="ml-search-input" rows="3" placeholder="Frases: licuadora, cafetera, tostadora&#10;O pega una URL: https://listado.mercadolibre.com.ve/electrodomesticos/cocina/licuadoras/"></textarea>
          </div>
          <div class="ml-input-group">
            <label>Máx. Páginas por frase/URL (0 = ilimitado):</label>
            <input type="number" id="cfg-queue-max-pages" value="20" style="width:80px; font-size:11px;">
          </div>
          <div class="ml-btn-group">
            <button class="ml-btn ml-btn-primary" id="btn-start">Iniciar Crawling</button>
            <button class="ml-btn ml-btn-secondary ml-btn-icon" id="btn-toggle-pause" title="Pausar / Resumir" disabled>${ICONS.pause}</button>
            <button class="ml-btn ml-btn-danger ml-btn-icon" id="btn-reset" title="Reset / Limpiar">${ICONS.reset}</button>
          </div>
          <div class="ml-btn-group" style="margin-top: 4px;">
            <button class="ml-btn ml-btn-secondary" id="btn-skip-page" title="Saltar a la siguiente página" style="flex:1; font-size:10px;" disabled>⏭ Saltar Página</button>
            <button class="ml-btn ml-btn-secondary" id="btn-skip-phrase" title="Saltar a la siguiente frase/URL de la cola" style="flex:1; font-size:10px;" disabled>⏭ Saltar Frase</button>
            <button class="ml-btn ml-btn-secondary" id="btn-stop-crawl" title="Detener crawling completamente" style="flex:1; font-size:10px;" disabled>⏹ Detener</button>
          </div>
          <div class="ml-progress-bar"><div class="ml-progress-fill" id="ml-progress"></div></div>
          <div class="ml-stats">
            <span id="ml-status">Estado: En espera</span>
            <span id="ml-count">Productos: ${products.length}</span>
          </div>
          <div class="ml-stats" id="ml-eta" style="display:none; font-size:10px; color:#3483fa;">
            <span>⏱ ETA: calculando...</span>
            <span>📊 Página <span id="ml-current-page">0</span> / <span id="ml-total-pages">?</span></span>
          </div>
          <div class="ml-btn-group" style="margin-top: 8px;">
            <button class="ml-btn ml-btn-success" id="btn-download" ${products.length === 0 ? 'disabled' : ''}>Descargar CSV/Excel</button>
          </div>
          <div class="ml-btn-group" style="margin-top: 4px;">
            <button class="ml-btn ml-btn-secondary" id="btn-use-current-url" title="Usa la URL completa de esta pestaña como punto de inicio (ideal para categorías y listados personalizados)" style="flex:1; font-size:10px;">🔗 Usar URL de esta pestaña</button>
          </div>
          <!-- v6.11.0: Killer features -->
          <div class="ml-btn-group" style="margin-top: 4px;">
            <label style="font-size:10px; display:flex; align-items:center; gap:4px; cursor:pointer;">
              <input type="checkbox" id="cfg-auto-deep" style="margin:0;"> 🚀 Auto Deep Extract al terminar
            </label>
            <label style="font-size:10px; display:flex; align-items:center; gap:4px; cursor:pointer;">
              <input type="checkbox" id="cfg-auto-sync" style="margin:0;"> 📤 Auto Sync Sheets al terminar
            </label>
          </div>
          <div class="ml-queue-box">
            <div class="ml-queue-title" style="display:flex; justify-content:space-between; align-items:center;">
              <span>Cola de Trabajo (Frases / URLs)</span>
              <span style="font-size:9px; color:#888;" id="queue-summary">${queueWork.length} items</span>
            </div>
            <div id="queue-container"><span style="color:#888; font-size:10px;">Sin frases pendientes...</span></div>
          </div>
        </div>
        ` : ''}

        <div id="tab-results" class="ml-tab-body ${isArticlePage ? 'active' : ''}">
          <div class="ml-btn-group" style="margin-bottom: 8px;">
            <button class="ml-btn ml-btn-purple" id="btn-deep-extract" ${deepQueue.length === 0 ? 'disabled' : ''}>Extraer Artículos Seleccionados (<span id="deep-count">${deepQueue.length}</span>)</button>
            <button class="ml-btn ml-btn-success" id="btn-download" ${products.length === 0 ? 'disabled' : ''}>Descargar CSV</button>
          </div>
          <div class="ml-btn-group" style="margin-bottom: 6px;">
            <button class="ml-btn ml-btn-secondary" id="btn-toggle-selection" style="flex:1; font-size:10px;">☑ Toggle Selección</button>
          </div>
          <div style="display:flex; gap:6px; margin-bottom:8px;">
            <input type="text" id="filter-name" placeholder="Filtrar por nombre..." style="flex:2; padding:5px; font-size:11px; border:1px solid #ccc; border-radius:4px;">
            <select id="sort-results" style="flex:1; padding:5px; font-size:11px; border:1px solid #ccc; border-radius:4px;">
              <option value="price_asc">Precio: Menor</option>
              <option value="price_desc">Precio: Mayor</option>
              <option value="sales_desc" selected>Más Vendidos</option>
              <option value="score_desc">Mejor Score</option>
            </select>
          </div>
          <div id="items-container"></div>
        </div>

        <div id="tab-config" class="ml-tab-body">
          <div style="font-size: 11px; font-weight: bold; margin-bottom: 6px; color: #2d3277;">Filtros Generales</div>
          <div class="ml-input-group">
            <label>Ventas Mínimas Requeridas (ej: 500):</label>
            <input type="number" id="cfg-sales" value="500">
          </div>
          <div class="ml-input-group">
            <label>Score Mínimo (ej: 4.8):</label>
            <input type="number" id="cfg-score" step="0.1" value="4.8">
          </div>
          <div class="ml-input-group">
            <label>Solo Envío Gratis:</label>
            <select id="cfg-shipping">
              <option value="false">No (Todos)</option>
              <option value="true" selected>Sí</option>
            </select>
          </div>
          <div class="ml-input-group">
            <label>Delay Async Fetch (ms):</label>
            <input type="number" id="cfg-delay" value="1200">
          </div>
          <div class="ml-input-group">
            <label>Máx. Páginas por Búsqueda (0 = ilimitado):</label>
            <input type="number" id="cfg-max-pages" value="0">
          </div>
          <div class="ml-input-group">
            <label>Máx. Productos Total (0 = ilimitado):</label>
            <input type="number" id="cfg-max-products" value="0">
          </div>
          <div class="ml-input-group">
            <label>ML API Access Token (para visitas + vender):</label>
            <div style="display:flex; gap:4px;">
              <input type="password" id="cfg-access-token" placeholder="APP_USR-...-...-..." style="flex:1; font-size:10px;">
              <button class="ml-btn ml-btn-secondary" id="btn-toggle-token" title="Mostrar / Ocultar token" style="padding:4px 8px; font-size:11px;">👁</button>
            </div>
            <div style="font-size:9px; color:#888; margin-top:3px;">Requerido para el botón 💰 Vender. Consíguelo en: https://developers.mercadolibre.com.ve/</div>
          </div>
          <div class="ml-input-group">
            <label>Precio Markup para Vender (%):</label>
            <input type="number" id="cfg-sell-markup" value="20" step="5" style="width:80px; font-size:11px;">
            <div style="font-size:9px; color:#888; margin-top:3px;">Markup aplicado al precio original al copiar productos (20% = +20%). Ej: $10 → $12.</div>
          </div>
          <div class="ml-input-group">
            <label>Google Sheets Web App URL (para sync automático):</label>
            <input type="text" id="cfg-gsheets-url" placeholder="https://script.google.com/macros/s/AKfyc.../exec" style="font-size:10px;">
            <div style="font-size:9px; color:#888; margin-top:3px;">Despliega el Apps Script (ver google-apps-script.js) y pega aquí la URL. Permite sync con deduplicación por MLV id.</div>
          </div>
          <div class="ml-btn-group" style="margin-top: 8px;">
            <button class="ml-btn ml-btn-purple" id="btn-open-analysis" style="flex:1;">📊 Abrir Análisis Estratégico</button>
            <button class="ml-btn ml-btn-secondary" id="btn-open-error-log" style="flex:1;" title="Abrir log de errores en pestaña nueva">📋 Log de Errores</button>
          </div>
          <div class="ml-btn-group" style="margin-top: 4px;">
            <button class="ml-btn ml-btn-success" id="btn-sync-sheets" style="flex:1;">📤 Sync to Google Sheets</button>
          </div>
          <hr style="border:0; border-top:1px solid #eee; margin:10px 0;">
          <div style="font-size: 11px; font-weight: bold; margin-bottom: 6px; color: #2d3277;">Información Extraída del Vendedor</div>
          <div id="seller-inspection-container">
            <p style="font-size: 10px; color: #777;">Haz clic en un producto para inspeccionar tienda y datos en Venezuela.</p>
          </div>
        </div>
      </div>
      </div>
    `;
  }

  function buildModal() {
    ensureStyles();
    ensurePreviewCard();
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'ml-crawler-modal';
    modal.innerHTML = buildModalHtml();
    document.body.appendChild(modal);
    wireModalEvents();
    applyPanelVisibility();
  }

  function rebuildModal() {
    // Preserve scroll / tab focus as best we can
    buildModal();
    renderResults();
    renderQueueUI();
  }

  function applyPanelVisibility() {
    if (!modal) return;
    if (panelVisible) modal.classList.remove('ml-hidden');
    else modal.classList.add('ml-hidden');
  }

  /* ------------------------------------------------------------------ */
  /* Modal events                                                      */
  /* ------------------------------------------------------------------ */

  function wireModalEvents() {
    if (!modal) return;

    modal.querySelectorAll('.ml-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.ml-tab').forEach((t) => t.classList.remove('active'));
        modal.querySelectorAll('.ml-tab-body').forEach((b) => b.classList.remove('active'));
        tab.classList.add('active');
        const target = modal.querySelector('#' + tab.dataset.target);
        if (target) target.classList.add('active');
      });
    });

    const closeBtn = document.getElementById('ml-close');
    if (closeBtn) {
      // Hide instead of remove so it can be re-opened from the toolbar icon.
      closeBtn.onclick = () => {
        panelVisible = false;
        sendMessage({ action: 'SET_PANEL_VISIBLE', visible: false });
        applyPanelVisibility();
      };
    }

    // v6.5.0: modal collapse/expand toggle
    const btnCollapse = document.getElementById('ml-collapse');
    const bodyWrapper = document.getElementById('ml-body-wrapper');
    const headerTitle = document.getElementById('ml-header-title');
    const toggleCollapse = () => {
      if (!bodyWrapper) return;
      const isCollapsed = bodyWrapper.style.display === 'none';
      bodyWrapper.style.display = isCollapsed ? '' : 'none';
      if (btnCollapse) btnCollapse.textContent = isCollapsed ? '▼' : '▲';
    };
    if (btnCollapse) btnCollapse.onclick = toggleCollapse;
    if (headerTitle) headerTitle.ondblclick = toggleCollapse;

    // Filter / sort
    const filterInput = document.getElementById('filter-name');
    if (filterInput) filterInput.addEventListener('input', () => { visibleCount = 50; renderResults(); });
    const sortSel = document.getElementById('sort-results');
    if (sortSel) sortSel.addEventListener('change', () => { visibleCount = 50; renderResults(); });

    // Download buttons (may exist in both tabs)
    document.querySelectorAll('#btn-download').forEach((btn) => {
      btn.onclick = downloadCSV;
    });

    // Search input: Enter to add (without shift)
    if (!isArticlePage) {
      const searchInput = document.getElementById('ml-search-input');
      if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            addPhrasesToQueue();
          }
        });
      }
    }

    const btnStart = document.getElementById('btn-start');
    if (btnStart) btnStart.onclick = () => { addPhrasesToQueue(); };

    // v6.2.0: "Use current tab URL" button — injects the current page's URL
    // into the search input so the user can crawl a category/listing page
    // they're already browsing without copy/pasting.
    const btnUseCurrentUrl = document.getElementById('btn-use-current-url');
    if (btnUseCurrentUrl) {
      btnUseCurrentUrl.onclick = () => {
        const searchInput = document.getElementById('ml-search-input');
        if (!searchInput) return;
        const currentUrl = window.location.href;
        // Append to existing input (preserve any phrases already typed)
        const existing = (searchInput.value || '').trim();
        searchInput.value = existing
          ? existing + ',\n' + currentUrl
          : currentUrl;
        searchInput.focus();
        // Visual feedback: briefly highlight the input
        searchInput.style.transition = 'background 0.3s';
        searchInput.style.background = '#e3f2fd';
        setTimeout(() => { searchInput.style.background = ''; }, 600);
      };
    }

    const btnPause = document.getElementById('btn-toggle-pause');
    if (btnPause) {
      btnPause.onclick = function () {
        if (!isCrawling) return;
        isPaused = !isPaused;
        this.innerHTML = isPaused ? ICONS.play : ICONS.pause;
      };
    }

    // v6.11.0: skip current page, skip current phrase, stop crawl
    const btnSkipPage = document.getElementById('btn-skip-page');
    if (btnSkipPage) {
      btnSkipPage.onclick = () => {
        if (!isCrawling) return;
        currentOffset += 48;  // skip to next page
        logActivity('CRAWL_CONTROL', `Skipped page ${processedPagesCount}, jumping to offset ${currentOffset}`, 'info');
        setDebugger(`[Skip]: Saltando a página ${processedPagesCount + 1}`);
      };
    }

    const btnSkipPhrase = document.getElementById('btn-skip-phrase');
    if (btnSkipPhrase) {
      btnSkipPhrase.onclick = () => {
        if (!isCrawling || !currentSearchProcess) return;
        logActivity('CRAWL_CONTROL', `Skipping phrase "${currentSearchProcess.phrase}"`, 'info');
        currentSearchProcess.status = 'done';  // mark as done so processNextInQueue moves on
        isCrawling = false;  // break the while loop
        setDebugger(`[Skip]: Saltando frase "${currentSearchProcess.phrase}"`);
        setTimeout(() => processNextInQueue(), 200);
      };
    }

    const btnStopCrawl = document.getElementById('btn-stop-crawl');
    if (btnStopCrawl) {
      btnStopCrawl.onclick = () => {
        if (!isCrawling) return;
        isCrawling = false;
        isPaused = false;
        logActivity('CRAWL_CONTROL', 'Crawl STOPPED by user', 'warn');
        setDebugger('[Stop]: Crawling detenido por el usuario');
        const btnS = document.getElementById('btn-start');
        if (btnS) { btnS.disabled = false; btnS.classList.remove('animating'); }
        const btnP = document.getElementById('btn-toggle-pause');
        if (btnP) { btnP.disabled = true; btnP.innerHTML = ICONS.pause; }
        if (btnSkipPage) btnSkipPage.disabled = true;
        if (btnSkipPhrase) btnSkipPhrase.disabled = true;
        if (btnStopCrawl) btnStopCrawl.disabled = true;
        const etaEl = document.getElementById('ml-eta');
        if (etaEl) etaEl.style.display = 'none';
        if (modal) modal.classList.remove('crawling-active');
      };
    }

    const btnReset = document.getElementById('btn-reset');
    if (btnReset) {
      btnReset.onclick = () => {
        // v6.3.0: use CLEAR_ALL which actually replaces (not merges) the
        // products + deep queue + queueWork in storage. The old code used
        // SAVE_PRODUCTS with [] which is a no-op because mergeProducts is
        // additive — that's why the data "came back" when crawling restarted.
        isCrawling = false;
        isPaused = false;
        queueWork = [];
        visitedUrls.clear();
        products = [];
        deepQueue = [];

        // Update local UI immediately for responsiveness...
        const statusEl = document.getElementById('ml-status');
        if (statusEl) statusEl.innerText = 'Estado: Reseteado';
        const countEl = document.getElementById('ml-count');
        if (countEl) countEl.innerText = 'Productos: 0';
        const progressEl = document.getElementById('ml-progress');
        if (progressEl) progressEl.style.width = '0%';
        const btnS = document.getElementById('btn-start');
        if (btnS) btnS.disabled = false;
        const btnP = document.getElementById('btn-toggle-pause');
        if (btnP) { btnP.disabled = true; btnP.innerHTML = ICONS.pause; }
        renderQueueUI();
        renderResults();

        // ...then broadcast CLEAR_ALL to the background, which replaces
        // (not merges) the storage. The storage.onChanged event will fire
        // in ALL open tabs, so they all reset too.
        sendMessage({ action: 'CLEAR_ALL' }).then((r) => {
          if (!r || !r.success) {
            setDebugger('[Reset falló]: ' + (r && r.error ? r.error : 'sin respuesta'));
          }
        });
      };
    }

    const btnDeepExtract = document.getElementById('btn-deep-extract');
    if (btnDeepExtract) {
      btnDeepExtract.onclick = () => {
        if (deepQueue.length === 0) { alert("Selecciona productos con '+ Deep' primero."); return; }
        runAsyncFetchQueue();
      };
    }

    // v6.11.0: Toggle Selection — if all visible are selected, deselect all; else select all
    const btnToggleSelection = document.getElementById('btn-toggle-selection');
    if (btnToggleSelection) {
      btnToggleSelection.onclick = () => {
        const filterInput = document.getElementById('filter-name');
        const filterText = (filterInput ? filterInput.value : '').toLowerCase();
        const visible = products.filter((p) => (p.Nombre || '').toLowerCase().indexOf(filterText) !== -1);
        
        // Check if ALL visible products are already in the deep queue
        const allSelected = visible.every((p) => deepQueue.some((dq) => {
          if (typeof dq === 'string') return dq === p.Link || dq === extractMlvId(p.Link) || dq === p.id;
          return dq.id === p.id || dq.Link === p.Link;
        }));

        if (allSelected) {
          // Deselect only the visible ones
          const visibleIds = new Set(visible.map(p => p.id));
          const visibleLinks = new Set(visible.map(p => p.Link));
          const visibleMlvs = new Set(visible.map(p => extractMlvId(p.Link)));
          const removed = deepQueue.length;
          deepQueue = deepQueue.filter((dq) => {
            if (typeof dq === 'string') return !visibleMlvs.has(dq) && !visibleLinks.has(dq);
            return !visibleIds.has(dq.id) && !visibleLinks.has(dq.Link);
          });
          logActivity('TOGGLE_SEL', `Deselected ${removed - deepQueue.length} visible products (all were selected)`, 'info');
        } else {
          // Select all visible
          let added = 0;
          for (const p of visible) {
            const exists = deepQueue.some((dq) => {
              if (typeof dq === 'string') return dq === p.Link || dq === extractMlvId(p.Link) || dq === p.id;
              return dq.id === p.id || dq.Link === p.Link;
            });
            if (!exists) {
              deepQueue.push({ id: p.id, Link: p.Link, Nombre: p.Nombre });
              added++;
            }
          }
          logActivity('TOGGLE_SEL', `Selected ${added} new products (total deep queue: ${deepQueue.length})`, 'info');
        }
        persistDeepQueue().then(() => renderResults());
      };
    }

    const btnOpenAnalysis = document.getElementById('btn-open-analysis');
    if (btnOpenAnalysis) {
      btnOpenAnalysis.onclick = () => {
        try {
          window.open(chrome.runtime.getURL('analysis.html'), '_blank');
        } catch (e) {
          alert('No se pudo abrir el análisis: ' + e.message);
        }
      };
    }

    // v6.3.0: access token input — save on blur (debounced)
    const tokenInput = document.getElementById('cfg-access-token');
    if (tokenInput) {
      let tokenSaveTimer = null;
      const saveToken = () => {
        setAccessToken(tokenInput.value || '');
      };
      tokenInput.addEventListener('input', () => {
        if (tokenSaveTimer) clearTimeout(tokenSaveTimer);
        tokenSaveTimer = setTimeout(saveToken, 800);
      });
      tokenInput.addEventListener('blur', saveToken);
    }

    // v6.5.0: toggle show/hide for access token
    const btnToggleToken = document.getElementById('btn-toggle-token');
    if (btnToggleToken) {
      btnToggleToken.onclick = () => {
        const inp = document.getElementById('cfg-access-token');
        if (!inp) return;
        if (inp.type === 'password') {
          inp.type = 'text';
          btnToggleToken.textContent = '🙈';
        } else {
          inp.type = 'password';
          btnToggleToken.textContent = '👁';
        }
      };
    }

    // v6.5.0: open error log in new tab
    const btnOpenErrorLog = document.getElementById('btn-open-error-log');
    if (btnOpenErrorLog) {
      btnOpenErrorLog.onclick = () => {
        try {
          window.open(chrome.runtime.getURL('error-log.html'), '_blank');
        } catch (e) {
          alert('No se pudo abrir el log de errores: ' + e.message);
        }
      };
    }

    // v6.9.0: Google Sheets URL input — save on change
    const gsheetsInput = document.getElementById('cfg-gsheets-url');
    if (gsheetsInput) {
      // Load saved value
      chrome.storage.local.get(STORAGE_KEY_GSHEETS_URL, (data) => {
        if (data[STORAGE_KEY_GSHEETS_URL]) gsheetsInput.value = data[STORAGE_KEY_GSHEETS_URL];
      });
      let gsheetsSaveTimer = null;
      const saveGSheetsUrl = () => {
        chrome.storage.local.set({ [STORAGE_KEY_GSHEETS_URL]: gsheetsInput.value || '' });
      };
      gsheetsInput.addEventListener('input', () => {
        if (gsheetsSaveTimer) clearTimeout(gsheetsSaveTimer);
        gsheetsSaveTimer = setTimeout(saveGSheetsUrl, 800);
      });
      gsheetsInput.addEventListener('blur', saveGSheetsUrl);
    }

    // v6.9.0: sync to Google Sheets
    const btnSyncSheets = document.getElementById('btn-sync-sheets');
    if (btnSyncSheets) {
      btnSyncSheets.onclick = () => syncToGoogleSheets();
    }
  }

  /** v6.9.0: Sync all products to Google Sheets via the Apps Script web app.
   *  Reads the web app URL from storage, POSTs all products, the script
   *  handles deduplication by MLV id.
   */
  async function syncToGoogleSheets() {
    const data = await chrome.storage.local.get(STORAGE_KEY_GSHEETS_URL);
    const url = data[STORAGE_KEY_GSHEETS_URL];
    if (!url) {
      alert('Pega primero la Google Sheets Web App URL en el campo de configuración.\n\nInstrucciones:\n1. Abre tu Google Sheet\n2. Extensiones → Apps Script\n3. Pega el código de google-apps-script.js\n4. Implementar → Nueva implementación → Aplicación web\n5. Copia la URL y pégala aquí');
      return;
    }

    if (products.length === 0) {
      alert('No hay productos para sincronizar.');
      return;
    }

    const btn = document.getElementById('btn-sync-sheets');
    if (btn) { btn.disabled = true; btn.innerText = '📤 Sincronizando...'; }

    logActivity('SHEETS_SYNC', `Syncing ${products.length} products to Google Sheets via background SW...`, 'info');

    try {
      // v6.10.0: route through background SW to avoid CORS
      const result = await sendMessage({ action: 'SYNC_TO_SHEETS' });
      if (result && result.success) {
        logActivity('SHEETS_SYNC', `Sync OK: ${result.appended} new, ${result.updated} updated, ${result.skipped} skipped (of ${result.total})`, 'info');
        alert(`✅ Sync completado!\n\nNuevos: ${result.appended}\nActualizados: ${result.updated}\nOmitidos: ${result.skipped}\nTotal: ${result.total}`);
      } else {
        throw new Error(result && result.error ? result.error : 'Unknown error');
      }
    } catch (err) {
      logActivity('SHEETS_SYNC', `Sync FAILED: ${err.message}`, 'error');
      alert('❌ Error al sincronizar con Google Sheets:\n' + err.message + '\n\nVerifica que la URL del Apps Script sea correcta y esté desplegada como "Cualquiera" (acceso público).');
    } finally {
      if (btn) { btn.disabled = false; btn.innerText = '📤 Sync to Google Sheets'; }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Price / currency parsing                                          */
  /* ------------------------------------------------------------------ */

  function parsePrice(ariaLabel, fractionText, currencySymbol) {
    // Determine currency
    let currency = 'N/A';
    const lower = (ariaLabel || '').toLowerCase();
    if (lower.indexOf('dólar') !== -1 || lower.indexOf('dolar') !== -1) currency = 'USD';
    else if (lower.indexOf('bolívar') !== -1 || lower.indexOf('bolivar') !== -1) currency = 'VES';
    else if (currencySymbol) {
      const s = currencySymbol.trim();
      if (s.indexOf('US$') !== -1 || s === '$' || s.indexOf('USD') !== -1) currency = 'USD';
      else if (s.indexOf('Bs') !== -1) currency = 'VES';
    }

    // Numeric value
    let num = 0;
    let cents = 0;
    if (ariaLabel) {
      const dollarsMatch = ariaLabel.match(/([0-9][0-9.,]*)\s*(?:dólares|bolívares)/i);
      const centsMatch = ariaLabel.match(/con\s*([0-9]+)\s*centavos/i);
      if (dollarsMatch) num = parseFloat(dollarsMatch[1].replace(/\./g, '').replace(',', '.'));
      if (centsMatch) cents = parseInt(centsMatch[1], 10) / 100;
    }
    if (!num && fractionText) {
      num = parseFloat(fractionText.replace(/\./g, '').replace(',', '.'));
    }
    if (isNaN(num)) num = 0;
    const total = num + cents;
    return {
      num: parseFloat(total.toFixed(2)),
      text: ariaLabel || (fractionText ? (currencySymbol ? currencySymbol + ' ' : '') + fractionText : '0'),
      currency
    };
  }

  /* ------------------------------------------------------------------ */
  /* URL / ID helpers                                                 */
  /* ------------------------------------------------------------------ */

  function extractMlvId(value) {
    if (!value) return null;
    const s = String(value);
    const m = s.match(/MLV[-_]?\d+/i);
    // v6.5.0: ML item IDs are always MLV + digits with NO hyphens/underscores.
    // The visits API expects "MLV702250939" not "MLV-702250939".
    return m ? m[0].replace(/[-_]/g, '').toUpperCase() : null;
  }

  /** v6.6.1: Clean a MercadoLibre permalink URL.
   *  - Strips URL fragment (#tracking_junk...) and query params
   *  - PRESERVES the original MLV-XXXX format in the path (ML serves URLs
   *    with the hyphen: https://articulo.mercadolibre.com.ve/MLV-838797492-...-_JM)
   *  - The API call (extractMlvId) strips the hyphen separately — that's
   *    correct for the visits endpoint which wants MLV838797492 without hyphen
   *  - Returns the canonical article URL without tracking:
   *    https://articulo.mercadolibre.com.ve/MLV-838797492-kz-edx-pro-x-...-_JM
   */
  function cleanPermalink(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      // Strip fragment and query — ML articles don't need them.
      // Do NOT normalize the MLV id — keep MLV-XXXX as ML serves it.
      return u.origin + u.pathname;
    } catch (e) {
      // Fallback: strip # and ? manually
      return String(url).split('#')[0].split('?')[0];
    }
  }

  function buildOffsetUrl(base, offset) {
    // `base` can be either:
    //   (a) a slug like '/licuadora' or '/electrodomesticos/cocina/licuadoras'
    //       → resolved against the current tab origin (legacy phrase mode)
    //   (b) a full URL like 'https://listado.mercadolibre.com.ve/electrodomesticos/cocina/licuadoras'
    //       → used as-is for page 1, with '_Desde_N_NoIndex_True' appended to the
    //         path for subsequent pages (ML's pagination convention)
    if (/^https?:\/\//i.test(base)) {
      // Full URL mode (v6.2.0): supports any ML VE subdomain
      // (listado, hogar, vehiculos, etc.) and any path depth.
      try {
        const u = new URL(base);
        // Strip trailing slash from pathname so the pagination suffix attaches cleanly
        const cleanPath = u.pathname.replace(/\/+$/, '') || '/';
        if (offset === 1) {
          // Page 1: original URL as-is (preserve nothing else — fragments/queries
          // are dropped because ML's pagination uses path-based _Desde_ markers)
          return u.origin + cleanPath;
        }
        // Page N+: append _Desde_N_NoIndex_True to the last path segment.
        // ML's convention: /licuadora → /licuadora_Desde_49_NoIndex_True
        return u.origin + cleanPath + '_Desde_' + offset + '_NoIndex_True';
      } catch (e) {
        // Malformed URL — fall back to raw string
        setDebugger('[URL malformada]: ' + base + ' — ' + e.message);
        return base;
      }
    }
    // Slug mode (legacy): resolve against current tab origin
    const origin = window.location.origin;
    const cleanSlug = base.replace(/^\/+|\/+$/g, '');
    return offset === 1
      ? `${origin}/${cleanSlug}`
      : `${origin}/${cleanSlug}_Desde_${offset}_NoIndex_True`;
  }

  /** Truncate a URL for compact display in the queue UI. */
  function truncateUrl(url, maxLen) {
    if (!url) return '';
    if (maxLen === undefined) maxLen = 48;
    if (url.length <= maxLen) return url;
    // Show scheme + host + first/last path segments
    try {
      const u = new URL(url);
      const path = u.pathname;
      if (path.length <= maxLen - u.host.length - 10) {
        return u.host + path;
      }
      return url.substring(0, maxLen - 1) + '…';
    } catch (e) {
      return url.substring(0, maxLen - 1) + '…';
    }
  }

  function setDebugger(text) {
    const el = document.getElementById('url-debugger');
    if (el) el.innerText = text;
  }

  /* ------------------------------------------------------------------ */
  /* Error log (v6.4.0)                                                 */
  /*                                                                    */
  /* Visible log of HTTP 4xx/5xx errors, selector misses, fetch         */
  /* failures, etc. Shown in a collapsible panel at the bottom of the   */
  /* modal so the user can debug issues.                                */
  /* ------------------------------------------------------------------ */

  const errorLog = [];          // {ts, type, message, level}
  const MAX_LOG_ENTRIES = 1000;
  const STORAGE_KEY_ERROR_LOG = 'ml_error_log';

  // v6.6.0: unified logging — captures EVERYTHING (info, warn, error)
  // so the user can see exactly what the scraper is doing at each step.
  // Levels: 'info' (requests, parses, extractions), 'warn' (4xx, redirects),
  // 'error' (5xx, exceptions, parse failures).
  function logActivity(type, message, level) {
    if (!level) level = type.indexOf('HTTP 4') !== -1 || type.indexOf('HTTP 5') !== -1 ? 'warn' : 'info';
    if (type.toUpperCase().indexOf('EXCEPTION') !== -1 || type.toUpperCase().indexOf('FAIL') !== -1) level = 'error';
    const entry = { ts: new Date().toISOString(), type, message: String(message).substring(0, 800), level };
    errorLog.push(entry);
    if (errorLog.length > MAX_LOG_ENTRIES) errorLog.shift();
    const prefix = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    prefix.call(console, '[ML Scraper][' + type + ']', message);
    // Persist (debounced — multiple logs in same tick coalesce)
    scheduleLogPersist();
    // Update badge count in the modal header (if visible)
    const badge = document.getElementById('ml-error-count');
    if (badge) badge.textContent = errorLog.length;
  }

  // Keep logError as alias for backwards compat (calls logActivity with error level)
  function logError(type, message) {
    logActivity(type, message, 'error');
  }

  let logPersistTimer = null;
  function scheduleLogPersist() {
    if (logPersistTimer) return;
    logPersistTimer = setTimeout(() => {
      logPersistTimer = null;
      try { chrome.storage.local.set({ [STORAGE_KEY_ERROR_LOG]: errorLog }); } catch (e) {}
    }, 300);
  }

  function persistErrorLog() {
    if (logPersistTimer) { clearTimeout(logPersistTimer); logPersistTimer = null; }
    try { chrome.storage.local.set({ [STORAGE_KEY_ERROR_LOG]: errorLog }); } catch (e) {}
  }

  async function loadErrorLog() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY_ERROR_LOG);
      const stored = data[STORAGE_KEY_ERROR_LOG];
      if (Array.isArray(stored)) {
        errorLog.length = 0;
        for (const e of stored) errorLog.push(e);
      }
    } catch (e) { /* ignore */ }
  }

  // v6.6.0: visits API consecutive 4xx counter.
  // If the ML visits API returns HTTP 4xx 3+ times in a row, we stop calling
  // it for the rest of the session (the token is probably invalid/expired).
  let visitsConsecutive4xx = 0;
  let visitsDisabled = false;
  const VISITS_4XX_THRESHOLD = 3;

  /* ------------------------------------------------------------------ */
  /* Search-results page parser                                       */
  /* ------------------------------------------------------------------ */

  function parsePage(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // v6.4.0: try multiple selector variants for each field. ML frequently
    // changes their DOM structure, so we try the old selectors first, then
    // fall back to common alternatives.
    const items = doc.querySelectorAll(
      '.ui-search-results li.ui-search-layout__item, ' +
      'li.ui-search-layout__item, ' +
      '.ui-search-layout__item, ' +
      '.ui-search-result__wrapper, ' +
      '[data-testid="results-item"]'
    );
    const minScore = parseFloat(safeValue('cfg-score', 0)) || 0;
    const minSales = parseInt(safeValue('cfg-sales', 0), 10) || 0;
    const requireFreeShipping = safeValue('cfg-shipping', 'false') === 'true';

    let countOnPage = 0;
    let garbageFiltered = 0;
    let filteredByScore = 0;
    let filteredBySales = 0;
    let filteredByShipping = 0;
    const incoming = [];

    // v6.6.0: log page parse start with diagnostic info
    const pageTitle = (doc.title || '').substring(0, 80);
    const htmlLength = html ? html.length : 0;
    logActivity('PARSE_PAGE', `Parsing page: ${items.length} items found, HTML=${htmlLength} chars, title="${pageTitle}"`, 'info');

    if (items.length === 0) {
      // v6.4.0: log when selectors find nothing — helps debug ML DOM changes
      // v6.6.0: also save first 300 chars of HTML to diagnose anti-bot/login redirects
      const htmlPreview = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 200);
      logError('PARSE_PAGE', `0 items found. Possible anti-bot/login redirect.\n  Title: "${pageTitle}"\n  HTML preview: ${htmlPreview}`);
    }

    items.forEach((item) => {
      countOnPage++;
      // v6.4.0: try multiple selectors for each field
      const nameEl = queryFirst(item, [
        'h2.ui-search-item__title',
        'h3.ui-search-item__title',
        'h2.poly-component__title',
        'h3.poly-component__title',
        '.poly-component__title',
        'h3',
        'h2'
      ]);
      const imgEl = queryFirst(item, [
        'img[data-id]',
        'img.ui-search-result-image__picture',
        'img.poly-component__picture',
        'img'
      ]);
      const priceEl = queryFirst(item, [
        '.poly-price__amount',
        '.andes-money-amount',
        '.ui-search-price__part .andes-money-amount',
        '.ui-search-price__second-line__price .andes-money-amount',
        '[data-testid="price"] .andes-money-amount',
        '.ui-search-item__group__price .andes-money-amount'
      ]);
      const reviewsEl = queryFirst(item, [
        '.poly-component__review-compacted + .andes-visually-hidden',
        '.ui-search-reviews',
        '.poly-component__rating',
        '.ui-search-item__reviews-rating',
        '.andes-visually-hidden'
      ]);
      const shippingEl = queryFirst(item, [
        '.poly-component__shipping-v2 .andes-visually-hidden',
        '.ui-search-item__shipping',
        '.poly-component__shipping',
        '[data-testid="shipping"]'
      ]);
      const linkEl = queryFirst(item, [
        'a.poly-component__title',
        'a.ui-search-item__group__title',
        'a.ui-search-link',
        'a.ui-search-item__link',
        'a'
      ]);

      const name = nameEl ? (nameEl.innerText || nameEl.textContent || '').trim() : '';
      const image = imgEl ? (imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || '') : '';
      const priceAttr = priceEl ? priceEl.getAttribute('aria-label') : '';
      const priceFractionEl = priceEl ? priceEl.querySelector('.andes-money-amount__fraction') : null;
      const priceFraction = priceFractionEl ? (priceFractionEl.innerText || '').trim() : '';
      const currencyEl = priceEl ? priceEl.querySelector('.andes-money-amount__currency-symbol') : null;
      const currencySymbol = currencyEl ? (currencyEl.innerText || '').trim() : '';
      const reviewsText = reviewsEl ? (reviewsEl.innerText || reviewsEl.textContent || '').trim() : '';
      const shippingText = shippingEl ? (shippingEl.innerText || shippingEl.textContent || '').trim() : '';
      const permalink = linkEl ? cleanPermalink(linkEl.href) : '';

      const parsedPrice = parsePrice(priceAttr, priceFraction, currencySymbol);
      const scoreMatch = reviewsText.match(/Calificación\s+([0-9.,]+)\s+de\s+5/i);
      const score = scoreMatch ? parseFloat(scoreMatch[1].replace(',', '.')) : 0;
      const isFreeShipping = shippingText.toLowerCase().indexOf('envío gratis') !== -1 ||
                            shippingText.toLowerCase().indexOf('envio gratis') !== -1;

      const salesMatch = reviewsText.match(/([0-9.,]+)\s*ventas/i) ||
                         (item.innerText || '').match(/\+?([0-9.,]+)\s*vendidos/i);
      const salesCount = salesMatch ? parseInt(salesMatch[1].replace(/\./g, '').replace(',', ''), 10) : 0;

      // v6.4.0: filter garbage rows — skip if name is empty, "MercadoLibre",
      // "Mercado Libre", or price is 0 (indicates selector miss or anti-bot page)
      const lowerName = name.toLowerCase();
      const isGarbage = !name ||
        lowerName === 'mercadolibre' ||
        lowerName === 'mercado libre' ||
        lowerName === 'mercado libre - donde comprar y vender de todo' ||
        lowerName.indexOf('hubo un error') !== -1 ||
        lowerName.indexOf('ingresa a tu cuenta') !== -1 ||
        parsedPrice.num === 0;

      if (isGarbage) {
        garbageFiltered++;
        // v6.6.0: log each garbage item for debugging
        logActivity('PARSE_FILTER', `Garbage filtered #${countOnPage}: name="${name.substring(0,40)}" price=${parsedPrice.num}`, 'warn');
        return;
      }

      // v6.6.0: track filter reasons
      if (score < minScore) filteredByScore++;
      if (salesCount < minSales) filteredBySales++;
      if (requireFreeShipping && !isFreeShipping) filteredByShipping++;

      if (score >= minScore && salesCount >= minSales && (!requireFreeShipping || isFreeShipping)) {
        const mlvId = extractMlvId(permalink);
        const id = mlvId || ('slug_' + Math.random().toString(36).substr(2, 9));
        incoming.push({
          id,
          Nombre: name,
          Precio_Numerico: parsedPrice.num,
          Moneda: parsedPrice.currency,
          Score: score,
          Ventas: salesCount,
          EnvioGratis: isFreeShipping ? 'Sí' : 'No',
          Imagen: image,
          Link: permalink,
          Categorias: 'N/A',
          Ubicacion: 'Pendiente',
          Marca: 'N/A',
          Modelo: 'N/A',
          Especificaciones: '',
          Vendedor_Nombre: 'Pendiente',
          Vendedor_Estatus: 'Pendiente',
          Google_Breakout_Vendedor: '',
          Visitas: 0,
          DeepExtracted: false
        });
      }
    });

    // v6.6.0: log parse summary
    const passedFilters = countOnPage - garbageFiltered - filteredByScore - filteredBySales - filteredByShipping;
    logActivity('PARSE_SUMMARY',
      `Page done: ${countOnPage} total, ${incoming.length} added, ${garbageFiltered} garbage, ` +
      `${filteredByScore} low-score(<${minScore}), ${filteredBySales} low-sales(<${minSales}), ` +
      `${filteredByShipping} no-free-shipping`,
      'info');

    if (incoming.length) {
      const merged = mergeIntoLocal(incoming);
      persistProducts();
      if (merged > 0) {
        setDebugger(`[Página analizada]: ${countOnPage} items, ${merged} nuevos, ${garbageFiltered} filtrados (basura).`);
        logActivity('MERGE', `Merged ${incoming.length} products, ${merged} new added to storage (total now ${products.length})`, 'info');
      }
    } else if (countOnPage > 0 && garbageFiltered > 0) {
      setDebugger(`[Página analizada]: ${countOnPage} items, TODOS filtrados como basura (${garbageFiltered}). Revisa el log de errores.`);
    }
    return countOnPage;
  }

  /** Try multiple CSS selectors, return the first match. */
  function queryFirst(root, selectors) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) {
        // Invalid selector — skip
      }
    }
    return null;
  }

  function safeValue(id, fallback) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    return el.value !== undefined ? el.value : fallback;
  }

  function mergeIntoLocal(incoming) {
    let added = 0;
    const byId = new Map();
    for (const p of products) byId.set(p.id, p);
    for (const p of incoming) {
      const ex = byId.get(p.id);
      if (ex) {
        byId.set(p.id, { ...ex, ...p, id: p.id });
      } else {
        byId.set(p.id, p);
        added++;
      }
    }
    products = Array.from(byId.values());
    return added;
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                            */
  /* ------------------------------------------------------------------ */

  function renderResults() {
    if (!modal) return;
    const container = document.getElementById('items-container');
    if (!container) return;
    const filterInput = document.getElementById('filter-name');
    const sortSel = document.getElementById('sort-results');
    const filterText = (filterInput ? filterInput.value : '').toLowerCase();
    const sortVal = sortSel ? sortSel.value : 'sales_desc';

    const tabCount = document.getElementById('tab-count');
    if (tabCount) tabCount.innerText = products.length;
    const deepCount = document.getElementById('deep-count');
    if (deepCount) deepCount.innerText = deepQueue.length;
    const btnDeep = document.getElementById('btn-deep-extract');
    if (btnDeep) btnDeep.disabled = deepQueue.length === 0;
    const countEl = document.getElementById('ml-count');
    if (countEl) countEl.innerText = 'Productos: ' + products.length;
    document.querySelectorAll('#btn-download').forEach((btn) => {
      btn.disabled = products.length === 0;
    });

    let filtered = products.filter((p) => (p.Nombre || '').toLowerCase().indexOf(filterText) !== -1);

    if (sortVal === 'price_asc') filtered.sort((a, b) => (a.Precio_Numerico || 0) - (b.Precio_Numerico || 0));
    else if (sortVal === 'price_desc') filtered.sort((a, b) => (b.Precio_Numerico || 0) - (a.Precio_Numerico || 0));
    else if (sortVal === 'sales_desc') filtered.sort((a, b) => (b.Ventas || 0) - (a.Ventas || 0));
    else if (sortVal === 'score_desc') filtered.sort((a, b) => (b.Score || 0) - (a.Score || 0));

    // Virtualization: only render the first `visibleCount` items.
    // At 5000+ products, rendering all cards freezes the browser for seconds.
    const visible = filtered.slice(0, visibleCount);
    const remaining = filtered.length - visible.length;

    container.innerHTML = '';

    const frag = document.createDocumentFragment();
    visible.forEach((p) => {
      const isSelected = deepQueue.some((dq) => {
        if (typeof dq === 'string') return dq === p.Link || dq === extractMlvId(p.Link) || dq === p.id;
        return dq.id === p.id || dq.Link === p.Link;
      });

      const card = document.createElement('div');
      card.className = 'ml-item-card' + (isSelected ? ' selected-for-deep' : '');

      // XSS-safe: build innerHTML with escaped values
      const imgSrc = escapeAttr(p.Imagen || '');
      const title = escapeHtml(p.Nombre || '');
      const link = escapeAttr(p.Link || '#');
      const priceNum = (p.Precio_Numerico ? p.Precio_Numerico.toFixed(2) : '0.00');
      const scoreStr = escapeHtml(String(p.Score || 0));
      const salesStr = escapeHtml(p.Ventas > 0 ? ('+' + p.Ventas + ' vendidos') : 'Destacado');
      const currency = escapeHtml(p.Moneda || '');
      // v6.3.0: show visit count if we have it (only populated after deep extraction + visits fetch)
      const visitsStr = p.Visitas > 0
        ? '<span class="ml-badge-visits" title="Visitas reales (10 días, ML API)">👁 ' + escapeHtml(String(p.Visitas)) + '</span>'
        : '';

      card.innerHTML = `
        <img src="${imgSrc}" class="ml-item-img" alt="Product" onerror="this.style.opacity='0.3'">
        <div class="ml-item-info">
          <div class="ml-item-title" title="${title}">${title}</div>
          <div class="ml-item-details">
            <span class="ml-item-price">${escapeHtml(currency ? currency + ' ' : '')}${escapeHtml(priceNum)}</span>
            <span>★ ${scoreStr}</span>
            <span class="ml-badge-sales">${salesStr}</span>
            ${visitsStr}
          </div>
        </div>
        <div style="display:flex; gap:4px; align-items:center;">
          <button class="ml-btn select-deep-btn" style="padding:4px 6px; font-size:10px; background:${isSelected ? '#2d3277' : '#e0e0e0'}; color:${isSelected ? '#fff' : '#333'};">+ Deep</button>
          <button class="ml-btn sell-btn" style="padding:4px 6px; font-size:10px; background:#00a650; color:#fff;" title="Vender: copiar y publicar bajo tu cuenta">💰 Vender</button>
          <a href="${link}" target="_blank" rel="noopener" class="ml-btn ml-btn-secondary" style="padding:4px 6px;" title="Ver Producto">🔗</a>
          <button class="ml-btn ml-btn-danger remove-btn" style="padding:4px 6px;" title="Eliminar">${ICONS.trash}</button>
        </div>
      `;

      const imgEl = card.querySelector('.ml-item-img');
      const infoEl = card.querySelector('.ml-item-info');

      const showPreview = (e) => {
        if (!previewCard) return;
        previewCard.style.display = 'block';
        const pImg = escapeAttr(p.Imagen || '');
        const pName = escapeHtml(p.Nombre || '');
        const pPrice = escapeHtml(String(p.Precio_Numerico || 0));
        const pCur = escapeHtml(p.Moneda || '');
        const pVentas = escapeHtml(String(p.Ventas || 0));
        const pScore = escapeHtml(String(p.Score || 0));
        const pEnv = escapeHtml(p.EnvioGratis || 'No');
        const pCat = escapeHtml(p.Categorias || '');
        const pVend = escapeHtml(p.Vendedor_Nombre || '');
        const pVisitas = escapeHtml(String(p.Visitas || 0));
        const visitsLine = p.Visitas > 0
          ? `<span style="color:#ad1457; font-weight:bold;">👁 Visitas: ${pVisitas} (10 días)</span><br>`
          : '';
        const deepInfo = p.DeepExtracted
          ? `<div style="color:#2d3277; font-size:9px; margin-top:4px;"><b>Cat:</b> ${pCat}<br><b>Vendedor:</b> ${pVend}</div>`
          : '';
        previewCard.innerHTML = `
          <img src="${pImg}" alt="Preview" onerror="this.style.display='none'">
          <b>${pName}</b><br>
          <span style="color:#00a650; font-weight:bold;">Precio: ${escapeHtml(pCur ? pCur + ' ' : '')}${pPrice}</span><br>
          <span style="color:#0d47a1; font-weight:bold;">Ventas: +${pVentas} unidades</span><br>
          ${visitsLine}
          <span>Score: ★ ${pScore} | Envío Gratis: ${pEnv}</span><br>
          ${deepInfo}
        `;
        updatePreviewPos(e);
      };

      const updatePreviewPos = (e) => {
        if (!previewCard) return;
        previewCard.style.top = Math.min(e.clientY + 15, window.innerHeight - 220) + 'px';
        previewCard.style.left = Math.max(e.clientX - 240, 10) + 'px';
      };

      const hidePreview = () => { if (previewCard) previewCard.style.display = 'none'; };

      imgEl.addEventListener('mouseenter', showPreview);
      imgEl.addEventListener('mousemove', updatePreviewPos);
      imgEl.addEventListener('mouseleave', hidePreview);

      infoEl.onclick = () => showSellerInTab3(p);

      card.querySelector('.select-deep-btn').onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSelectForDeep(p);
      };

      card.querySelector('.sell-btn').onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        sellProduct(p);
      };

      card.querySelector('.remove-btn').onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeProductAnimated(card, p.id);
      };

      // Swipe gestures (restored from v4.0.5)
      let startX = 0, currentX = 0, isDragging = false;
      const onStart = (e) => {
        isDragging = true;
        startX = e.type.indexOf('touch') !== -1 ? e.touches[0].clientX : e.clientX;
      };
      const onMove = (e) => {
        if (!isDragging) return;
        currentX = e.type.indexOf('touch') !== -1 ? e.touches[0].clientX : e.clientX;
        const diffX = currentX - startX;
        if (Math.abs(diffX) < 120) card.style.transform = `translateX(${diffX}px)`;
      };
      const onEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        const diffX = currentX - startX;
        card.style.transform = 'translateX(0px)';
        if (diffX < -60) {
          removeProductAnimated(card, p.id);
        } else if (diffX > 60) {
          toggleSelectForDeep(p);
        }
        startX = 0; currentX = 0;
      };

      card.addEventListener('touchstart', onStart, { passive: true });
      card.addEventListener('touchmove', onMove, { passive: true });
      card.addEventListener('touchend', onEnd);
      // Mouse drag (desktop) — only when not clicking a button
      card.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, a')) return;
        onStart(e);
        const move = (ev) => onMove(ev);
        const up = () => {
          onEnd();
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });

      frag.appendChild(card);
    });
    container.appendChild(frag);

    // Virtualization: "load more" button when there are hidden results
    if (remaining > 0) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'ml-btn ml-btn-secondary';
      moreBtn.style.cssText = 'width:100%; margin-top:8px; padding:8px; font-size:11px;';
      moreBtn.innerText = `Cargar más ${VISIBLE_INCREMENT} (${remaining} restantes de ${filtered.length})`;
      moreBtn.onclick = () => {
        visibleCount += VISIBLE_INCREMENT;
        renderResults();
      };
      container.appendChild(moreBtn);
    }
  }

  function removeProductAnimated(cardEl, id) {
    if (!cardEl) return;
    cardEl.classList.add('removing');
    setTimeout(() => {
      products = products.filter((p) => p.id !== id);
      deepQueue = deepQueue.filter((p) => {
        if (typeof p === 'string') return p !== id;
        return p.id !== id && p.Link !== id;
      });
      Promise.all([persistProducts(), persistDeepQueue()]).then(() => {
        renderResults();
      });
    }, 350);
  }

  /** v6.12.0: Sell — copies a product and publishes it under the user's ML account.
   *  Based on the user's original Node.js code:
   *    1. FETCH_FULL_ITEM (GET /items/{id}?include_attributes=all + description)
   *    2. Build POST payload (title, price * markup, pictures, variations, etc.)
   *    3. POST_ITEM (POST /items → create new listing)
   *    4. POST_ITEM_DESC (add description with original seller reference)
   *  Requires a valid ML access token in Filtros & Config.
   */
  async function sellProduct(product) {
    const mlvId = extractMlvId(product.Link) || product.id;
    const title = product.Nombre || '(sin título)';
    const price = product.Precio_Numerico || 0;

    // Check token first
    const tokenData = await chrome.storage.local.get(STORAGE_KEY_ACCESS_TOKEN);
    const token = tokenData[STORAGE_KEY_ACCESS_TOKEN] || '';
    if (!token) {
      alert('💰 Para vender necesitas un ML API Access Token válido.\n\nPégalo en Filtros & Config → "ML API Access Token".\n\nConsíguelo en: https://developers.mercadolibre.com.ve/');
      return;
    }

    // Get markup % (default 20%)
    const markupInput = document.getElementById('cfg-sell-markup');
    const markup = markupInput ? parseFloat(markupInput.value) || 20 : 20;
    const newPrice = Math.ceil(price * (1 + markup / 100));

    // Confirm
    if (!confirm(`💰 VENDER: Copiar y publicar este producto\n\nProducto: ${title.substring(0, 60)}\nPrecio original: $${price}\nNuevo precio (+${markup}%): $${newPrice}\n\nSe copiarán título, imágenes, categoría, variaciones y descripción.\n¿Continuar?`)) {
      return;
    }

    logActivity('SELL', `Starting sell flow for ${mlvId}: "${title.substring(0, 40)}" → $${newPrice} (+${markup}%)`, 'info');

    // Step 1: Fetch full item data via ML API
    setDebugger(`[Vender ${mlvId}]: Obteniendo datos completos vía API...`);
    const fullResponse = await sendMessage({ action: 'FETCH_FULL_ITEM', itemId: mlvId });

    if (!fullResponse || !fullResponse.success) {
      const errMsg = fullResponse && fullResponse.error ? fullResponse.error : 'sin respuesta';
      logActivity('SELL', `${mlvId}: FETCH_FULL_ITEM FAILED — ${errMsg}`, 'error');
      alert(`❌ No se pudo obtener el producto de la API de ML.\n\nError: ${errMsg}\n\nPosibles causas:\n• Tu token expiró o no tiene permisos\n• ML bloqueó la API pública\n• El producto no existe o fue eliminado`);
      return;
    }

    const item = fullResponse.item;
    const description = fullResponse.description || '';
    logActivity('SELL', `${mlvId}: Full item obtained — title="${(item.title || '').substring(0, 30)}", ${item.pictures ? item.pictures.length : 0} pictures, ${item.variations ? item.variations.length : 0} variations`, 'info');

    // Step 2: Build POST payload (based on user's original code)
    const postData = {
      title: item.title,
      price: newPrice,
      currency_id: item.currency_id,
      category_id: item.category_id,
      available_quantity: item.available_quantity || 1,
      buying_mode: item.buying_mode || 'buy_it_now',
      listing_type_id: item.listing_type_id || 'gold_special',
      condition: item.condition || 'new',
      pictures: (item.pictures || []).map((pic) => ({
        source: pic.secure_url || pic.url
      }))
    };

    // Copy variations (if any) — remove original IDs
    if (Array.isArray(item.variations) && item.variations.length > 0) {
      postData.variations = item.variations.map((v) => {
        const copy = { ...v };
        delete copy.id;
        delete copy.item_id;
        copy.price = Math.ceil((v.price || price) * (1 + markup / 100));
        return copy;
      });
    }

    // Copy attributes if available
    if (Array.isArray(item.attributes) && item.attributes.length > 0) {
      postData.attributes = item.attributes.map((attr) => ({
        id: attr.id,
        value_id: attr.value_id,
        value_name: attr.value_name
      }));
    }

    // Step 3: POST /items to create the listing
    setDebugger(`[Vender ${mlvId}]: Publicando nuevo anuncio ($${newPrice})...`);
    logActivity('SELL', `${mlvId}: POSTing new listing...`, 'info');
    const postResponse = await sendMessage({ action: 'POST_ITEM', itemData: postData });

    if (!postResponse || !postResponse.success) {
      const errMsg = postResponse && postResponse.error ? postResponse.error : 'sin respuesta';
      logActivity('SELL', `${mlvId}: POST_ITEM FAILED — ${errMsg}`, 'error');
      alert(`❌ Error al publicar el producto.\n\nError: ${errMsg}\n\nPosibles causas:\n• Categoría requiere atributos obligatorios\n• Precio fuera del rango permitido\n• Token sin permisos de escritura\n• Límite de publicaciones alcanzado`);
      return;
    }

    const newItem = postResponse.item;
    const newId = newItem.id;
    const newPermalink = newItem.permalink || `https://articulo.mercadolibre.com.ve/${newId}`;
    logActivity('SELL', `${mlvId}: POST OK! New listing: ${newId} — ${newPermalink}`, 'info');

    // Step 4: Add description with original seller reference
    const descText = `SIEMPRE PREGUNTAR DISPONIBILIDAD ANTES DE COMPRAR!!!\n\nOriginal: ${item.seller_id}:${item.id}\n\n${description}`;
    setDebugger(`[Vender ${mlvId}]: Agregando descripción...`);
    const descResponse = await sendMessage({ action: 'POST_ITEM_DESC', itemId: newId, description: descText });

    if (descResponse && descResponse.success) {
      logActivity('SELL', `${mlvId} → ${newId}: Description added`, 'info');
    } else {
      logActivity('SELL', `${newId}: Description failed (non-critical) — ${descResponse ? descResponse.error : 'no response'}`, 'warn');
    }

    setDebugger(`[Vender]: ¡Listo! ${newPermalink}`);
    logActivity('SELL', `✅ Sell complete: ${mlvId} → ${newId} (${newPermalink})`, 'info');

    alert(`✅ ¡Producto publicado!\n\nNuevo ID: ${newId}\nPrecio: $${newPrice}\n\nURL: ${newPermalink}\n\nLa descripción se agregó con referencia al vendedor original.`);
  }

  function toggleSelectForDeep(product) {
    const existsIndex = deepQueue.findIndex((dq) => {
      if (typeof dq === 'string') return dq === product.Link || dq === extractMlvId(product.Link) || dq === product.id;
      return dq.id === product.id || dq.Link === product.Link;
    });
    if (existsIndex >= 0) deepQueue.splice(existsIndex, 1);
    else deepQueue.push({ id: product.id, Link: product.Link, Nombre: product.Nombre });
    persistDeepQueue().then(() => renderResults());
  }

  /* ------------------------------------------------------------------ */
  /* Crawler (restored from v4.0.5)                                   */
  /* ------------------------------------------------------------------ */

  function addPhrasesToQueue() {
    const searchInput = document.getElementById('ml-search-input');
    if (!searchInput) return;
    const rawVal = (searchInput.value || '').trim();
    const phrases = rawVal
      ? rawVal.split(/[\n,]+/).map((s) => s.trim()).filter((s) => s.length > 0)
      : [window.location.pathname];

    // v6.11.0: per-phrase maxPages (read from the config field)
    const maxPagesInput = document.getElementById('cfg-queue-max-pages');
    const perPhraseMaxPages = maxPagesInput ? parseInt(maxPagesInput.value, 10) || 0 : 0;

    phrases.forEach((phrase) => {
      const isUrl = /^https?:\/\//i.test(phrase);
      const dedupKey = isUrl ? phrase.toLowerCase().replace(/\/+$/, '') : phrase.toLowerCase();
      if (!queueWork.some((q) => {
        const qKey = /^https?:\/\//i.test(q.phrase) ? q.phrase.toLowerCase().replace(/\/+$/, '') : q.phrase.toLowerCase();
        return qKey === dedupKey;
      })) {
        queueWork.push({
          id: 'q_' + Math.random().toString(36).substr(2, 7),
          phrase,
          isUrl,
          status: 'waiting',
          maxPages: perPhraseMaxPages   // v6.11.0: per-phrase limit (0 = unlimited)
        });
      }
    });

    searchInput.value = '';
    persistQueueWork();
    renderQueueUI();
    if (!isCrawling) processNextInQueue();
  }

  function renderQueueUI() {
    const container = document.getElementById('queue-container');
    if (!container) return;
    const summaryEl = document.getElementById('queue-summary');
    if (summaryEl) summaryEl.textContent = queueWork.length + ' items';

    if (queueWork.length === 0) {
      container.innerHTML = '<span style="color:#888; font-size:10px;">Sin frases pendientes...</span>';
      return;
    }
    container.innerHTML = '';
    queueWork.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'ml-queue-item ' + item.status;
      const statusText = item.status === 'processing' ? 'En proceso...'
        : item.status === 'done' ? 'Completado' : 'En espera';
      const displayText = item.isUrl
        ? '🔗 ' + escapeHtml(truncateUrl(item.phrase, 45))
        : escapeHtml(item.phrase);
      const st = escapeHtml(statusText);
      // v6.11.0: show maxPages per phrase + queue position
      const maxPagesLabel = item.maxPages > 0 ? ` · max ${item.maxPages}p` : ' · ∞';
      const posLabel = `<span style="font-size:8px; color:#aaa; margin-right:4px;">#${idx + 1}</span>`;
      el.innerHTML = `
        <div style="flex:1; overflow:hidden;">
          <span>${posLabel}<b>${displayText}</b></span>
          <div style="font-size:9px; color:#666; margin-top:1px;"><i>(${st}${maxPagesLabel})</i></div>
        </div>
        <div style="display:flex; gap:2px; flex-shrink:0;">
          ${idx > 0 && item.status === 'waiting' ? '<span style="cursor:pointer; color:#3483fa; font-size:10px;" class="up-q" title="Subir">▲</span>' : ''}
          ${idx < queueWork.length - 1 && item.status === 'waiting' ? '<span style="cursor:pointer; color:#3483fa; font-size:10px;" class="down-q" title="Bajar">▼</span>' : ''}
          ${item.status !== 'done' ? '<span style="cursor:pointer; color:#ff5252; font-weight:bold; font-size:10px;" class="cancel-q" title="Eliminar">✕</span>' : ''}
        </div>
      `;
      if (item.isUrl) el.title = item.phrase;

      // v6.11.0: move up/down handlers
      const upEl = el.querySelector('.up-q');
      if (upEl) upEl.onclick = () => {
        const tmp = queueWork[idx - 1];
        queueWork[idx - 1] = queueWork[idx];
        queueWork[idx] = tmp;
        persistQueueWork();
        renderQueueUI();
      };
      const downEl = el.querySelector('.down-q');
      if (downEl) downEl.onclick = () => {
        const tmp = queueWork[idx + 1];
        queueWork[idx + 1] = queueWork[idx];
        queueWork[idx] = tmp;
        persistQueueWork();
        renderQueueUI();
      };

      if (item.status !== 'done') {
        const cancelEl = el.querySelector('.cancel-q');
        if (cancelEl) cancelEl.onclick = () => {
          queueWork = queueWork.filter((q) => q.id !== item.id);
          persistQueueWork();
          renderQueueUI();
        };
      }
      container.appendChild(el);
      if (item.status === 'done') {
        setTimeout(() => {
          queueWork = queueWork.filter((q) => q.id !== item.id);
          persistQueueWork();
          renderQueueUI();
        }, 2200);
      }
    });
  }

  async function processNextInQueue() {
    const nextItem = queueWork.find((q) => q.status === 'waiting');
    if (!nextItem) {
      isCrawling = false;
      const btnStart = document.getElementById('btn-start');
      if (btnStart) { btnStart.disabled = false; btnStart.classList.remove('animating'); }
      const btnPause = document.getElementById('btn-toggle-pause');
      if (btnPause) { btnPause.disabled = true; btnPause.innerHTML = ICONS.pause; }
      // v6.11.0: disable crawl control buttons
      ['btn-skip-page', 'btn-skip-phrase', 'btn-stop-crawl'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = true;
      });
      const etaEl = document.getElementById('ml-eta');
      if (etaEl) etaEl.style.display = 'none';
      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = 'Estado: Finalizado';
      if (modal) modal.classList.remove('crawling-active');
      playNotificationSound();
      // v6.11.0: killer features — auto deep extract + auto sync
      await runPostCrawlAutomation();
      return;
    }

    currentSearchProcess = nextItem;
    nextItem.status = 'processing';
    persistQueueWork();   // v6.3.0: sync status change across tabs
    renderQueueUI();

    // v6.2.0: support pasted raw URLs in addition to phrases.
    //   - Full URL (https://...): use as-is (buildOffsetUrl handles origin + path)
    //   - Path starting with '/': use as slug against current tab origin (legacy)
    //   - Plain text phrase: URL-encode and treat as slug (legacy)
    const phrase = nextItem.phrase;
    if (/^https?:\/\//i.test(phrase)) {
      // Normalize: strip query/hash, strip trailing slash — pagination is path-based
      try {
        const u = new URL(phrase);
        currentBaseSlug = u.origin + (u.pathname.replace(/\/+$/, '') || '/');
      } catch (e) {
        // Malformed — treat as raw string (will likely 404, but let it try)
        currentBaseSlug = phrase;
      }
    } else if (phrase.indexOf('/') === 0) {
      currentBaseSlug = phrase;
    } else {
      currentBaseSlug = '/' + encodeURIComponent(phrase.toLowerCase());
    }
    currentOffset = 1;
    visitedUrls.clear();

    isCrawling = true;
    isPaused = false;

    const btnStart = document.getElementById('btn-start');
    if (btnStart) { btnStart.disabled = true; btnStart.classList.add('animating'); }
    const btnPause = document.getElementById('btn-toggle-pause');
    if (btnPause) { btnPause.disabled = false; btnPause.innerHTML = ICONS.pause; }

    await runCrawler();

    nextItem.status = 'done';
    persistQueueWork();
    renderQueueUI();
    processNextInQueue();
  }

  /** v6.11.0: Post-crawl automation — auto deep extract + auto sync sheets.
   *  Runs after ALL phrases in the queue are done.
   *  Only triggers if the user checked the corresponding checkboxes.
   */
  async function runPostCrawlAutomation() {
    const autoDeepCheckbox = document.getElementById('cfg-auto-deep');
    const autoSyncCheckbox = document.getElementById('cfg-auto-sync');
    const autoDeep = autoDeepCheckbox ? autoDeepCheckbox.checked : false;
    const autoSync = autoSyncCheckbox ? autoSyncCheckbox.checked : false;

    if (!autoDeep && !autoSync) return;

    logActivity('AUTO', `Post-crawl automation starting (deep=${autoDeep}, sync=${autoSync})`, 'info');

    if (autoDeep && products.length > 0) {
      // Select ALL products and deep extract them
      logActivity('AUTO', `Auto-selecting all ${products.length} products for deep extraction...`, 'info');
      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = `Estado: Auto-selecting ${products.length} products for deep extraction...`;

      // Add all products to deep queue
      let added = 0;
      for (const p of products) {
        const exists = deepQueue.some((dq) => {
          if (typeof dq === 'string') return dq === p.Link || dq === extractMlvId(p.Link) || dq === p.id;
          return dq.id === p.id || dq.Link === p.Link;
        });
        if (!exists) {
          deepQueue.push({ id: p.id, Link: p.Link, Nombre: p.Nombre });
          added++;
        }
      }
      await persistDeepQueue();
      renderResults();
      logActivity('AUTO', `Added ${added} products to deep queue. Starting extraction...`, 'info');

      if (deepQueue.length > 0) {
        await runAsyncFetchQueue();
      }
    }

    if (autoSync && products.length > 0) {
      logActivity('AUTO', `Auto-syncing to Google Sheets...`, 'info');
      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = 'Estado: Auto-syncing to Google Sheets...';
      await syncToGoogleSheets();
    }

    logActivity('AUTO', `Post-crawl automation complete!`, 'info');
    const statusEl = document.getElementById('ml-status');
    if (statusEl) statusEl.innerText = '✔ ¡Automatización completada! Todo listo.';
  }

  async function runCrawler() {
    const delay = parseInt(safeValue('cfg-delay', '1200'), 10) || 1500;
    // v6.11.0: use per-phrase maxPages if available, fall back to global config
    const phraseMaxPages = currentSearchProcess && currentSearchProcess.maxPages !== undefined
      ? currentSearchProcess.maxPages
      : parseInt(safeValue('cfg-max-pages', '0'), 10);
    const maxProducts = parseInt(safeValue('cfg-max-products', '0'), 10);
    if (modal) modal.classList.add('crawling-active');

    // v6.11.0: show ETA + progress
    const etaEl = document.getElementById('ml-eta');
    if (etaEl && phraseMaxPages > 0) {
      etaEl.style.display = 'flex';
      const totalEl = document.getElementById('ml-total-pages');
      if (totalEl) totalEl.textContent = phraseMaxPages;
    } else if (etaEl) {
      etaEl.style.display = 'none';
    }

    // v6.11.0: enable crawl control buttons
    const btnSkipPage = document.getElementById('btn-skip-page');
    const btnSkipPhrase = document.getElementById('btn-skip-phrase');
    const btnStopCrawl = document.getElementById('btn-stop-crawl');
    if (btnSkipPage) btnSkipPage.disabled = false;
    if (btnSkipPhrase) btnSkipPhrase.disabled = false;
    if (btnStopCrawl) btnStopCrawl.disabled = false;

    let safetyCounter = 0;
    let consecutive429 = 0;
    const crawlStartTime = Date.now();

    while (isCrawling && safetyCounter < 5000) {
      safetyCounter++;

      // v6.11.0: per-phrase maxPages limit (0 = unlimited)
      if (phraseMaxPages > 0 && processedPagesCount >= phraseMaxPages) {
        setDebugger(`[Límite por frase]: ${processedPagesCount} páginas ≥ máximo ${phraseMaxPages}.`);
        const statusEl = document.getElementById('ml-status');
        if (statusEl) statusEl.innerText = `Estado: Frase "${currentSearchProcess.phrase}" completada (${phraseMaxPages} páginas)`;
        break;
      }

      // Max-products limit (0 = unlimited)
      if (maxProducts > 0 && products.length >= maxProducts) {
        setDebugger(`[Límite alcanzado]: ${products.length} productos ≥ máximo ${maxProducts}. Deteniendo.`);
        const statusEl = document.getElementById('ml-status');
        if (statusEl) statusEl.innerText = `Estado: Límite de ${maxProducts} productos alcanzado`;
        break;
      }

      if (isPaused) {
        const statusEl = document.getElementById('ml-status');
        if (statusEl) statusEl.innerText = 'Estado: Pausado';
        if (modal) modal.classList.remove('crawling-active');
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      if (modal) modal.classList.add('crawling-active');
      const currentUrl = buildOffsetUrl(currentBaseSlug, currentOffset);

      if (visitedUrls.has(currentUrl)) {
        currentOffset += 48;
        continue;
      }
      visitedUrls.add(currentUrl);
      processedPagesCount++;

      // v6.11.0: update status + ETA
      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = `Procesando: ${currentSearchProcess.phrase} (Pág. ${processedPagesCount}/${phraseMaxPages > 0 ? phraseMaxPages : '∞'})`;
      const curPageEl = document.getElementById('ml-current-page');
      if (curPageEl) curPageEl.textContent = processedPagesCount;
      // Progress bar
      const progressEl = document.getElementById('ml-progress');
      if (progressEl && phraseMaxPages > 0) {
        progressEl.style.width = Math.min(100, (processedPagesCount / phraseMaxPages) * 100) + '%';
      }
      // ETA calculation
      const etaSpan = document.querySelector('#ml-eta span');
      if (etaSpan && phraseMaxPages > 0 && processedPagesCount > 1) {
        const elapsed = (Date.now() - crawlStartTime) / 1000;
        const perPage = elapsed / processedPagesCount;
        const remaining = (phraseMaxPages - processedPagesCount) * perPage;
        etaSpan.textContent = `⏱ ETA: ${Math.ceil(remaining)}s (${perPage.toFixed(1)}s/pág)`;
      }

      setDebugger(`[Crawling]: ${currentUrl}`);
      logActivity('CRAWL_FETCH', `Pág ${processedPagesCount}: GET ${currentUrl}`, 'info');

      try {
        const response = await fetch(currentUrl, { credentials: 'include' });
        // v6.6.0: log response status
        logActivity('CRAWL_RESPONSE', `Pág ${processedPagesCount}: HTTP ${response.status} ${response.statusText || ''} (redirected=${response.redirected})`, response.ok ? 'info' : 'warn');

        // HTTP 429 = rate limited — back off and retry
        if (response.status === 429) {
          consecutive429++;
          const backoff = Math.min(30000, 2000 * Math.pow(2, consecutive429));
          setDebugger(`[HTTP 429]: rate-limited. Backoff ${backoff}ms (intento ${consecutive429}).`);
          const sEl = document.getElementById('ml-status');
          if (sEl) sEl.innerText = `Estado: Rate-limited (429), esperando ${(backoff / 1000).toFixed(0)}s...`;
          // Roll back the page counter so we retry this page
          processedPagesCount--;
          visitedUrls.delete(currentUrl);
          await new Promise((r) => setTimeout(r, backoff));
          if (consecutive429 >= 5) {
            setDebugger('[HTTP 429]: 5 intentos fallidos. Deteniendo crawl.');
            break;
          }
          continue;
        }
        consecutive429 = 0;

        if (!response.ok) {
          const errMsg = `HTTP ${response.status} ${response.statusText || ''} — crawl detenido para "${currentSearchProcess.phrase}" en ${currentUrl}`;
          setDebugger(`[HTTP ${response.status}]: deteniendo crawl para "${currentSearchProcess.phrase}".`);
          logError('HTTP ' + response.status, errMsg);
          break;
        }
        if (response.redirected && currentOffset > 1 && response.url.indexOf('_Desde_') === -1) {
          setDebugger('[Redirección sin paginación]: fin de resultados.');
          logError('REDIRECT', `Redirección sin paginación en ${currentUrl} → ${response.url.substring(0, 80)}. Fin de resultados.`);
          break;
        }
        const html = await response.text();
        const itemsParsed = parsePage(html);

        if (itemsParsed === 0 && currentOffset > 1) break;

        const countEl = document.getElementById('ml-count');
        if (countEl) countEl.innerText = 'Productos: ' + products.length;
        renderResults();
        currentOffset += 48;
      } catch (err) {
        setDebugger('[Error fetch]: ' + (err && err.message ? err.message : String(err)));
        break;
      }

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /** v6.9.0: Parse ML Spanish-format numbers to actual integers.
   *  Handles: "+4.600 Seguidores" → "4600", "+4,6 mil" → "4600",
   *           "+10 mil" → "10000", "+1.100" → "1100", "+500" → "500",
   *           "100%" → "100", "21 años" → "21"
   *  Returns a string for CSV compatibility.
   */
  function parseMLNumber(text) {
    if (!text) return 'N/A';
    const s = String(text).trim();
    // Look for "mil" (thousand) suffix: "+4,6 mil", "+10 mil", "+4.6 mil"
    const milMatch = s.match(/\+?\s*([0-9.,]+)\s*mil/i);
    if (milMatch) {
      let numStr = milMatch[1];
      // Comma as decimal separator (4,6) → convert to 4.6
      if (numStr.indexOf(',') !== -1) {
        numStr = numStr.replace(/\./g, '').replace(',', '.');
      } else if (numStr.indexOf('.') !== -1) {
        // Dot: check if thousands (4.600 → 3 digits after dot) or decimal (4.6)
        const parts = numStr.split('.');
        if (parts[1] && parts[1].length === 3) {
          numStr = numStr.replace(/\./g, '');  // thousands separator
        }
      }
      const num = parseFloat(numStr);
      return isNaN(num) ? s : String(Math.round(num * 1000));
    }
    // No "mil" — extract plain number with possible thousands separator
    const numMatch = s.match(/\+?\s*([0-9.,]+)/);
    if (numMatch) {
      let numStr = numMatch[1];
      // Dot as thousands separator: 4.600 → 4600, 1.100 → 1100
      if (numStr.indexOf('.') !== -1 && numStr.indexOf(',') === -1) {
        const parts = numStr.split('.');
        if (parts[1] && parts[1].length === 3) {
          numStr = numStr.replace(/\./g, '');
        }
      }
      return numStr;
    }
    // Percentage: "100%" → "100"
    const pctMatch = s.match(/(\d+)%/);
    if (pctMatch) return pctMatch[1];
    // Years: "21 años" → "21"
    const yearMatch = s.match(/(\d+)\s*a/);
    if (yearMatch) return yearMatch[1];
    return s.replace(/[^\d.,]/g, '');
  }

  /* ------------------------------------------------------------------ */
  /* Article parser (deep extraction)                                 */
  /* ------------------------------------------------------------------ */

  function parseArticleDocument(doc, targetUrl) {
    // v6.4.0: use queryFirst for resilient selectors on article pages too.
    // 1. Title
    const titleEl = queryFirst(doc, [
      '.ui-pdp-title',
      'h1.ui-pdp-title',
      'h1[data-testid="ui-pdp-title"]',
      'h1'
    ]);
    const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '';

    // 2. Main image
    const imgEl = queryFirst(doc, [
      'img.ui-pdp-gallery__figure__image',
      '.ui-pdp-gallery__figure img',
      'figure.ui-pdp-gallery img',
      '[data-testid="ui-pdp-gallery"] img'
    ]);
    let imageSrc = '';
    if (imgEl) {
      imageSrc = imgEl.getAttribute('data-zoom') || imgEl.getAttribute('src') || '';
      if (!imageSrc && imgEl.getAttribute('srcset')) {
        imageSrc = imgEl.getAttribute('srcset').split(',')[0].trim().split(' ')[0];
      }
    }

    // 3. Price (numeric + detailed) + currency
    const priceFractionEl = queryFirst(doc, [
      '.ui-pdp-price__second-line .andes-money-amount__fraction',
      '.ui-pdp-price .andes-money-amount__fraction',
      '.andes-money-amount__fraction'
    ]);
    const priceAriaEl = queryFirst(doc, [
      '.ui-pdp-price__second-line .andes-money-amount',
      '.ui-pdp-price .andes-money-amount',
      '.andes-money-amount'
    ]);
    const currencyEl = priceAriaEl ? priceAriaEl.querySelector('.andes-money-amount__currency-symbol') : null;
    const priceFraction = priceFractionEl ? (priceFractionEl.innerText || '').trim() : '';
    const priceAria = priceAriaEl ? priceAriaEl.getAttribute('aria-label') : '';
    const currencySymbol = currencyEl ? (currencyEl.innerText || '').trim() : '';
    const parsedPrice = parsePrice(priceAria, priceFraction, currencySymbol);

    // 4. Score + review count (v6.5.0: also extract number of reviews)
    const scoreEl = queryFirst(doc, [
      '.ui-pdp-review__rating',
      '.ui-pdp-review .andes-rating__label',
      '.andes-rating__label'
    ]);
    const scoreVal = scoreEl ? parseFloat((scoreEl.innerText || scoreEl.textContent || '').trim().replace(',', '.')) : 0;

    // v6.5.0: extract review count from "(416)" or "416 opiniones"
    const reviewAmountEl = queryFirst(doc, ['.ui-pdp-review__amount', '.ui-pdp-review__label .ui-pdp-review__amount']);
    const reviewsHiddenEl = queryFirst(doc, ['.ui-pdp-review__label .andes-visually-hidden', '.andes-visually-hidden']);
    let reviewCount = 0;
    if (reviewAmountEl) {
      const amtText = (reviewAmountEl.innerText || reviewAmountEl.textContent || '').trim();
      const m = amtText.match(/\((\d+)\)/);
      if (m) reviewCount = parseInt(m[1], 10);
    }
    if (!reviewCount && reviewsHiddenEl) {
      const hiddenText = (reviewsHiddenEl.innerText || reviewsHiddenEl.textContent || '').trim();
      const m = hiddenText.match(/(\d+)\s+opiniones/i);
      if (m) reviewCount = parseInt(m[1], 10);
    }

    // 5. Sales
    const subtitleEl = queryFirst(doc, [
      '.ui-pdp-subtitle',
      '.ui-pdp-header__subtitle .ui-pdp-subtitle'
    ]);
    let salesCount = 0;
    if (subtitleEl) {
      const txt = subtitleEl.innerText || subtitleEl.textContent || '';
      const salesMatch = txt.match(/\+?([0-9.,]+)\s*vendidos/i);
      if (salesMatch) salesCount = parseInt(salesMatch[1].replace(/\./g, '').replace(',', ''), 10);
      // Also try "Más de N vendidos" format
      if (!salesCount) {
        const masMatch = txt.match(/m[aá]s\s+de\s+([0-9.,]+)/i);
        if (masMatch) salesCount = parseInt(masMatch[1].replace(/\./g, '').replace(',', ''), 10);
      }
    }

    // 6. Location
    const locEl = queryFirst(doc, [
      '#subtitle_ .andes-typography--color-secondary',
      '.xprod-lib-shipping-promises__item .andes-typography--color-secondary',
      '.xprod-lib-shipping-promises__part--subtitle'
    ]);
    const locationText = locEl ? (locEl.innerText || locEl.textContent || '').trim() : 'No especificada';

    // 7. Seller name
    const sellerEl = queryFirst(doc, [
      '.ui-seller-data-header__title span',
      '.ui-seller-data-header__title',
      '#seller_data h2',
      '.ui-pdp-seller__name',
      '.ui-pdp-seller .ui-pdp-seller__link'
    ]);
    const sellerName = sellerEl ? (sellerEl.innerText || sellerEl.textContent || '').trim() : 'No especificado';

    // v6.5.0: extract seller followers, products, sales from #seller_data block
    // v6.9.0: use parseMLNumber to convert "+4.600" → "4600", "+4,6 mil" → "4600"
    let sellerFollowers = 'N/A';
    let sellerProducts = 'N/A';
    let sellerSales = 'N/A';
    let sellerRecommendPct = 'N/A';
    let sellerYearsML = 'N/A';
    let sellerPageLink = '';   // v6.9.0: link to seller's ML store page

    const followersEl = queryFirst(doc, ['.ui-seller-data-header__followers', '.ui-seller-data-header__followers span span']);
    if (followersEl) {
      const fText = (followersEl.innerText || followersEl.textContent || '').trim();
      sellerFollowers = parseMLNumber(fText);
    }

    const sellerProductsEl = queryFirst(doc, ['.ui-seller-data-header__products', '.ui-seller-data-header__products span span']);
    if (sellerProductsEl) {
      const pText = (sellerProductsEl.innerText || sellerProductsEl.textContent || '').trim();
      sellerProducts = parseMLNumber(pText);
    }

    // Seller sales/recommendation/years: these are in .ui-seller-data-status__info blocks
    const sellerInfoBlocks = doc.querySelectorAll('.ui-seller-data-status__info');
    sellerInfoBlocks.forEach((block) => {
      const titleEl = block.querySelector('.ui-seller-data-status__info-title');
      const subtitleInfoEl = block.querySelector('.ui-seller-data-status__info-subtitle');
      if (!titleEl || !subtitleInfoEl) return;
      const val = (titleEl.innerText || titleEl.textContent || '').trim();
      const label = (subtitleInfoEl.innerText || subtitleInfoEl.textContent || '').trim().toLowerCase();
      if (label.indexOf('ventas') !== -1) sellerSales = parseMLNumber(val);
      else if (label.indexOf('recomiendan') !== -1) sellerRecommendPct = parseMLNumber(val);
      else if (label.indexOf('mercado libre') !== -1) sellerYearsML = val.replace(/[^\d]/g, '');
    });

    // v6.9.0: extract seller page link from footer button
    const sellerFooterLinkEl = queryFirst(doc, [
      '.ui-seller-data-footer__container a',
      '.ui-seller-data-footer a[href]',
      'a[href*="/pagina/"]'
    ]);
    if (sellerFooterLinkEl) {
      sellerPageLink = cleanPermalink(sellerFooterLinkEl.href || sellerFooterLinkEl.getAttribute('href') || '');
    }

    // 8. Seller status + breadcrumbs
    const statusEl = queryFirst(doc, [
      '.ui-seller-data-status__title',
      '.ui-pdp-seller-status__title'
    ]);
    const breadcrumbs = doc.querySelectorAll('.andes-breadcrumb a.andes-breadcrumb__link, nav.andes-breadcrumb a');

    // 9. Technical specifications — brand & model
    // v6.5.0: added .ui-vpp-striped-specs__table selectors for current ML layout
    const specsTables = doc.querySelectorAll(
      '.ui-vpp-striped-specs__table table, ' +
      '.ui-vpp-striped-specs table, ' +
      '.ui-pdp-container__row--technical-specifications table, ' +
      '.ui-pdp-specifications table, ' +
      '.ui-pdp-specs table, ' +
      'table.ui-pdp-specifications__table'
    );
    const specList = [];
    let brand = 'N/A';
    let model = 'N/A';
    specsTables.forEach((table) => {
      table.querySelectorAll('tr').forEach((r) => {
        const th = r.querySelector('th');
        const td = r.querySelector('td');
        if (th && td) {
          const key = (th.innerText || th.textContent || '').trim();
          const val = (td.innerText || td.textContent || '').trim();
          const keyL = key.toLowerCase();
          if (keyL === 'marca') brand = val;
          if (keyL === 'modelo') model = val;
          specList.push(`${key}: ${val}`);
        }
      });
    });

    // v6.5.0: also extract highlighted specs (the icon-based ones at the top)
    const highlightedSpecs = doc.querySelectorAll('.ui-vpp-highlighted-specs__key-value__labels__key-value');
    highlightedSpecs.forEach((hs) => {
      const txt = (hs.innerText || hs.textContent || '').trim();
      if (txt) specList.push(txt);
    });

    // 10. Google breakout URL for seller OSINT
    const googleQuery = encodeURIComponent(`"${sellerName}" Venezuela (whatsapp OR instagram OR rif OR telefono OR tienda)`);
    const googleBreakoutUrl = `https://www.google.com/search?q=${googleQuery}`;

    const mlvId = extractMlvId(targetUrl);
    // v6.6.0: log extraction details for debugging
    logActivity('ARTICLE_PARSE',
      `${mlvId || '?'}: title="${title.substring(0, 40)}" price=${parsedPrice.num} score=${scoreVal} reviews=${reviewCount} sales=${salesCount} seller="${sellerName.substring(0, 25)}" brand=${brand} model=${model} specs=${specList.length}`,
      'info');
    return {
      id: mlvId || ('art_' + Math.random().toString(36).substr(2, 9)),
      Nombre: title,
      Precio_Numerico: parsedPrice.num,
      Moneda: parsedPrice.currency,
      Score: isNaN(scoreVal) ? 0 : scoreVal,
      Opiniones: reviewCount,           // v6.5.0: number of reviews (416)
      Ventas: salesCount,
      Ubicacion: locationText,
      Vendedor_Nombre: sellerName,
      Vendedor_Estatus: statusEl ? (statusEl.innerText || statusEl.textContent || '').trim() : 'N/A',
      Vendedor_Seguidores: sellerFollowers,    // v6.9.0: parsed number (4600 not 4.6)
      Vendedor_Productos: sellerProducts,      // v6.9.0: parsed number
      Vendedor_Ventas: sellerSales,            // v6.9.0: parsed number
      Vendedor_Recomendacion: sellerRecommendPct,  // v6.9.0: parsed number
      Vendedor_AniosML: sellerYearsML,         // v6.9.0: just the number (21)
      Vendedor_Link: sellerPageLink,           // v6.9.0: link to seller's ML store page
      Categorias: Array.from(breadcrumbs).map((b) => (b.innerText || b.textContent || '').trim()).join(' > '),
      Categoria: Array.from(breadcrumbs).length > 0 ? (Array.from(breadcrumbs)[0].innerText || Array.from(breadcrumbs)[0].textContent || '').trim() : 'N/A',  // v6.9.0: level 0
      Subcategorias: Array.from(breadcrumbs).length > 1 ? Array.from(breadcrumbs).slice(1).map((b) => (b.innerText || b.textContent || '').trim()).join(' > ') : 'N/A',  // v6.9.0: rest
      Marca: brand,
      Modelo: model,
      Especificaciones: specList.join(' | '),
      Imagen: imageSrc,
      Link: cleanPermalink(targetUrl),
      Google_Breakout_Vendedor: googleBreakoutUrl,
      Visitas: 0,
      DeepExtracted: true
    };
  }

  /* ------------------------------------------------------------------ */
  /* Async deep-fetch queue (uses background SW → bypasses CORS)      */
  /* ------------------------------------------------------------------ */

  async function runAsyncFetchQueue() {
    if (deepQueue.length === 0) return;
    isDeepCrawling = true;
    if (modal) modal.classList.add('crawling-active');
    const delay = parseInt(safeValue('cfg-delay', '1200'), 10) || 1200;

    // v6.6.0: reset visits 4xx counter at the start of each deep-extraction run
    visitsConsecutive4xx = 0;

    logActivity('DEEP_START', `Deep extraction started: ${deepQueue.length} products in queue (API mode)`, 'info');

    let processed = 0;
    let successCount = 0;
    let failCount = 0;

    while (deepQueue.length > 0 && isDeepCrawling) {
      const current = deepQueue[0];
      const rawLink = typeof current === 'string' ? current : current.Link;
      const mlvId = extractMlvId(rawLink) || rawLink;
      processed++;

      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = `API Fetch: ${mlvId}... (${deepQueue.length} restantes, ${successCount} ok, ${failCount} fail)`;
      logActivity('DEEP_FETCH', `[${processed}] Fetching ${mlvId} via tab (real browser render)`, 'info');

      try {
        // v6.8.0: open article in a real browser tab so the SPA renders
        // with full DOM, then scrape the rendered page.
        // Build the URL with the ?ml_extract=1 flag so the content script
        // on that tab knows to extract and send back data.
        // v6.8.1: ML article URLs use MLV-XXXX (WITH hyphen) format.
        // mlvId is stripped (MLVXXXX), so reconstruct with hyphen.
        // Prefer the original permalink if available (has full slug).
        let articleUrl;
        if (rawLink && /^https?:\/\//i.test(rawLink)) {
          articleUrl = cleanPermalink(rawLink) + '?ml_extract=1';
        } else {
          // Reconstruct: MLV712527634 → MLV-712527634
          const digits = mlvId.replace(/^MLV/i, '');
          articleUrl = `https://articulo.mercadolibre.com.ve/MLV-${digits}-_JM?ml_extract=1`;
        }
        const tabResponse = await sendMessage({ action: 'FETCH_ARTICLE_IN_TAB', url: articleUrl });

        if (!tabResponse || !tabResponse.success) {
          const errMsg = tabResponse && tabResponse.error ? tabResponse.error : 'sin respuesta del tab';
          logActivity('DEEP_FETCH', `[${processed}] ${mlvId}: TAB EXTRACTION FAILED — ${errMsg}`, 'error');
          failCount++;
        } else {
          const extracted = tabResponse.extracted;
          logActivity('DEEP_FETCH', `[${processed}] ${mlvId}: TAB OK, title="${(extracted.Nombre || '').substring(0, 40)}", price=${extracted.Precio_Numerico}`, 'info');

          if (!extracted.Nombre || extracted.Nombre === 'N/A' || extracted.Precio_Numerico === 0) {
            logActivity('DEEP_PARSE', `[${processed}] ${mlvId}: extraction yielded empty/garbage data. Selectors may be outdated.`, 'warn');
          }

          // Fetch visits (if not disabled) — visits API is separate
          if (!visitsDisabled) {
            try {
              const visitResponse = await sendMessage({ action: 'FETCH_VISITS', itemId: mlvId });
              if (visitResponse && visitResponse.success) {
                visitsConsecutive4xx = 0;
                extracted.Visitas = visitResponse.visits || 0;
                logActivity('VISIT_API', `[${processed}] ${mlvId}: ${extracted.Visitas} visitas en 10 días`, 'info');
              } else if (visitResponse && visitResponse.error) {
                const is4xx = visitResponse.error.indexOf('HTTP 4') !== -1;
                if (is4xx) {
                  visitsConsecutive4xx++;
                  logActivity('VISIT_API', `[${processed}] ${mlvId}: ${visitResponse.error} (consecutive 4xx: ${visitsConsecutive4xx}/${VISITS_4XX_THRESHOLD})`, 'warn');
                  if (visitsConsecutive4xx >= VISITS_4XX_THRESHOLD) {
                    visitsDisabled = true;
                    logActivity('VISIT_API', `Visits API DISABLED after ${visitsConsecutive4xx} consecutive 4xx errors.`, 'error');
                  }
                } else {
                  logActivity('VISIT_API', `[${processed}] ${mlvId}: ${visitResponse.error}`, 'warn');
                }
              }
            } catch (visitErr) {
              logActivity('VISIT_API', `[${processed}] ${mlvId}: exception — ${visitErr.message}`, 'error');
            }
          }

          logActivity('DEEP_PARSE', `[${processed}] ${mlvId}: FINAL — title="${(extracted.Nombre || '').substring(0, 40)}", price=${extracted.Precio_Numerico}, score=${extracted.Score}, reviews=${extracted.Opiniones || 0}, seller="${(extracted.Vendedor_Nombre || '').substring(0, 25)}"`, 'info');

          // Merge into products
          const existingIdx = products.findIndex((p) => extractMlvId(p.Link) === mlvId || p.id === mlvId);
          if (existingIdx >= 0) {
            products[existingIdx] = { ...products[existingIdx], ...extracted, id: products[existingIdx].id };
            logActivity('DEEP_MERGE', `[${processed}] ${mlvId}: merged into existing product`, 'info');
          } else {
            products.push(extracted);
            logActivity('DEEP_MERGE', `[${processed}] ${mlvId}: added as new product`, 'info');
          }
          await persistProducts();
          successCount++;
        }
      } catch (err) {
        const errMsg = err && err.message ? err.message : String(err);
        logActivity('DEEP_FETCH', `[${processed}] ${mlvId}: EXCEPTION — ${errMsg}`, 'error');
        failCount++;
      }

      deepQueue.shift();
      await persistDeepQueue();
      renderResults();
      await new Promise((r) => setTimeout(r, delay));
    }

    logActivity('DEEP_DONE', `Deep extraction finished: ${processed} processed, ${successCount} success, ${failCount} fail, visits=${visitsDisabled ? 'DISABLED' : 'enabled'}`, 'info');

    isDeepCrawling = false;
    if (modal) modal.classList.remove('crawling-active');
    const statusEl = document.getElementById('ml-status');
    if (statusEl) statusEl.innerText = '✔ ¡Búsqueda Profunda Completada!';
    const banner = document.getElementById('ml-notification-banner');
    if (banner) {
      banner.style.display = 'block';
      setTimeout(() => { if (banner) banner.style.display = 'none'; }, 4000);
    }
    playNotificationSound();
  }

  /** v6.7.0: Build a product object from the ML Items API JSON response.
   *  Maps API fields to our internal product schema.
   */
  function buildProductFromAPI(item, mlvId) {
    // Price + currency
    const price = item.price || 0;
    const currencyId = item.currency_id || '';
    const currency = currencyId === 'USD' ? 'USD' : currencyId === 'VES' ? 'VES' : currencyId;

    // Image — first picture, or fall back to thumbnail
    let image = '';
    if (Array.isArray(item.pictures) && item.pictures.length > 0) {
      image = item.pictures[0].url || item.pictures[0].secure_url || '';
    } else if (item.thumbnail) {
      image = item.thumbnail;
    }

    // Location
    let location = 'No especificada';
    if (item.seller_address) {
      const parts = [];
      if (item.seller_address.city && item.seller_address.city.name) parts.push(item.seller_address.city.name);
      if (item.seller_address.state && item.seller_address.state.name) parts.push(item.seller_address.state.name);
      if (parts.length) location = parts.join(', ');
    }

    // Specs — from attributes array
    const specList = [];
    let brand = 'N/A';
    let model = 'N/A';
    if (Array.isArray(item.attributes)) {
      for (const attr of item.attributes) {
        const key = attr.name || attr.id || '';
        const val = attr.value_name || '';
        if (key && val) {
          const keyL = key.toLowerCase();
          if (keyL === 'marca' || attr.id === 'BRAND') brand = val;
          if (keyL === 'modelo' || attr.id === 'MODEL') model = val;
          specList.push(`${key}: ${val}`);
        }
      }
    }

    // Free shipping
    const isFreeShipping = item.shipping && item.shipping.free_shipping ? true : false;

    // Sales — from sold_quantity
    const salesCount = item.sold_quantity || 0;

    // Categories — from category_id (can't get full breadcrumb without another API call)
    const categories = item.category_id || 'N/A';

    // Google breakout URL for seller OSINT
    const sellerName = item.seller_id ? `seller_${item.seller_id}` : 'Desconocido';
    const googleQuery = encodeURIComponent(`"${sellerName}" Venezuela (whatsapp OR instagram OR rif OR telefono OR tienda)`);
    const googleBreakoutUrl = `https://www.google.com/search?q=${googleQuery}`;

    // Permalink
    const permalink = item.permalink || cleanPermalink(`https://articulo.mercadolibre.com.ve/${mlvId}`);

    return {
      id: mlvId,
      Nombre: item.title || '',
      Precio_Numerico: price,
      Moneda: currency,
      Score: 0,                    // populated by reviews API call
      Opiniones: 0,                 // populated by reviews API call
      Ventas: salesCount,
      EnvioGratis: isFreeShipping ? 'Sí' : 'No',
      Imagen: image,
      Link: permalink,
      Categorias: categories,
      Ubicacion: location,
      Marca: brand,
      Modelo: model,
      Especificaciones: specList.join(' | '),
      Vendedor_Nombre: 'N/A',      // populated by seller API call
      Vendedor_Estatus: 'N/A',
      Vendedor_Seguidores: 'N/A',
      Vendedor_Productos: 'N/A',
      Vendedor_Ventas: 'N/A',
      Vendedor_Recomendacion: 'N/A',
      Vendedor_AniosML: 'N/A',
      Google_Breakout_Vendedor: googleBreakoutUrl,
      Visitas: 0,                  // populated by visits API call
      DeepExtracted: true
    };
  }

  /* ------------------------------------------------------------------ */
  /* Seller inspector (tab 3)                                         */
  /* ------------------------------------------------------------------ */

  function showSellerInTab3(product) {
    const container = document.getElementById('seller-inspection-container');
    if (!container) return;
    const sellerName = product.Vendedor_Nombre || 'Vendedor MercadoLibre';
    const googleQuery = encodeURIComponent(`"${sellerName}" Venezuela (whatsapp OR instagram OR rif OR telefono OR tienda)`);
    const googleLink = product.Google_Breakout_Vendedor || `https://www.google.com/search?q=${googleQuery}`;

    const safeName = escapeHtml(product.Nombre || '');
    const safeSeller = escapeHtml(sellerName);
    const safeUbic = escapeHtml(product.Ubicacion || 'N/A');
    const safeCat = escapeHtml(product.Categorias || 'N/A');
    const safeBrand = escapeHtml(product.Marca || 'N/A');
    const safeModel = escapeHtml(product.Modelo || 'N/A');
    const safeSpecs = escapeHtml(product.Especificaciones || 'No extraídas');
    const safeStatus = escapeHtml(product.Vendedor_Estatus || 'N/A');
    const safeLink = escapeAttr(googleLink);

    container.innerHTML = `
      <div class="ml-detail-box">
        <div style="font-weight:bold; font-size:12px; color:#2d3277; margin-bottom:4px;">${safeName}</div>
        <div class="ml-detail-row"><span>Vendedor Extraído:</span> <b style="color:#00a650; font-size:12px;">${safeSeller}</b></div>
        <div class="ml-detail-row"><span>Estatus:</span> <b>${safeStatus}</b></div>
        <div class="ml-detail-row"><span>Ubicación:</span> <b>${safeUbic}</b></div>
        <div class="ml-detail-row"><span>Categorías:</span> <b>${safeCat}</b></div>
        <div class="ml-detail-row"><span>Marca / Modelo:</span> <b>${safeBrand} / ${safeModel}</b></div>
        <div style="margin-top:6px; font-size:10px; color:#555;"><b>Especificaciones:</b> ${safeSpecs}</div>
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
          <a href="${safeLink}" target="_blank" rel="noopener" class="ml-btn ml-btn-success" style="font-size:11px; text-decoration:none; text-align:center;">
            🚀 Búsqueda Profunda Vendedor (Google/WA/IG)
          </a>
        </div>
      </div>
    `;

    modal.querySelectorAll('.ml-tab').forEach((t) => t.classList.remove('active'));
    modal.querySelectorAll('.ml-tab-body').forEach((b) => b.classList.remove('active'));
    const cfgTab = modal.querySelector('.ml-tab[data-target="tab-config"]');
    if (cfgTab) cfgTab.classList.add('active');
    const cfgBody = document.getElementById('tab-config');
    if (cfgBody) cfgBody.classList.add('active');
  }

  /* ------------------------------------------------------------------ */
  /* CSV export (Blob-based, XSS-safe)                                */
  /* ------------------------------------------------------------------ */

  function csvCell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function downloadCSV() {
    if (products.length === 0) return;

    // v6.4.0: removed Moneda + Precio_Detallado columns per user request.
    // Also filter garbage rows: skip products with name="MercadoLibre" or price=0.
    const validProducts = products.filter((p) => {
      const name = (p.Nombre || '').toLowerCase();
      return name &&
        name !== 'mercadolibre' &&
        name !== 'mercado libre' &&
        name.indexOf('hubo un error') === -1 &&
        name.indexOf('ingresa a tu cuenta') === -1 &&
        (p.Precio_Numerico || 0) > 0;
    });

    if (validProducts.length === 0) {
      logError('CSV_EXPORT', 'No hay productos válidos para exportar (todos fueron filtrados como basura).');
      alert('No hay productos válidos para exportar.\nTodos fueron filtrados (nombre vacío o precio 0).\nRevisa el log de errores para más detalles.');
      return;
    }

    const skipped = products.length - validProducts.length;
    if (skipped > 0) {
      logError('CSV_EXPORT', `Exportados ${validProducts.length} productos, ${skipped} filtrados (basura: nombre vacío/MercadoLibre o precio 0).`);
    }

    const headers = [
      'Nombre', 'Precio_Numerico', 'Score', 'Opiniones', 'Ventas_Estimadas',
      'Visitas_10dias',
      'EnvioGratis', 'Vendedor_Nombre', 'Vendedor_Estatus', 'Vendedor_Seguidores', 'Vendedor_Productos', 'Vendedor_Ventas', 'Vendedor_Recomendacion', 'Vendedor_AniosML', 'Vendedor_Link',
      'Ubicacion_Tienda', 'Categoria', 'Subcategorias', 'Categorias', 'Marca', 'Modelo', 'Especificaciones', 'Imagen', 'Link_Producto', 'Google_Breakout_Vendedor'
    ];

    const rows = validProducts.map((p) => [
      csvCell(p.Nombre),
      csvCell(p.Precio_Numerico || 0),
      csvCell(p.Score || 0),
      csvCell(p.Opiniones || 0),
      csvCell(p.Ventas || 0),
      csvCell(p.Visitas || 0),
      csvCell(p.EnvioGratis || 'No'),
      csvCell(p.Vendedor_Nombre || 'N/A'),
      csvCell(p.Vendedor_Estatus || 'N/A'),
      csvCell(p.Vendedor_Seguidores || 'N/A'),
      csvCell(p.Vendedor_Productos || 'N/A'),
      csvCell(p.Vendedor_Ventas || 'N/A'),
      csvCell(p.Vendedor_Recomendacion || 'N/A'),
      csvCell(p.Vendedor_AniosML || 'N/A'),
      csvCell(p.Vendedor_Link || ''),
      csvCell(p.Ubicacion || 'N/A'),
      csvCell(p.Categoria || 'N/A'),
      csvCell(p.Subcategorias || 'N/A'),
      csvCell(p.Categorias || 'N/A'),
      csvCell(p.Marca || 'N/A'),
      csvCell(p.Modelo || 'N/A'),
      csvCell(p.Especificaciones || 'N/A'),
      csvCell(p.Imagen || ''),
      csvCell(p.Link || ''),
      csvCell(p.Google_Breakout_Vendedor || '')
    ].join(','));

    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ML_VE_ExtensionExport_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                              */
  /* ------------------------------------------------------------------ */

  async function boot() {
    await loadAll();
    await loadErrorLog();   // v6.5.0: load persisted error log

    // v6.8.0: if this is an article page opened in a background tab for
    // extraction (detected via URL param ?ml_extract=1), wait for the DOM
    // to fully render (SPA hydration), then extract and send back.
    if (isArticlePage && location.search.indexOf('ml_extract=1') !== -1) {
      runTabExtraction();
      return;  // don't show the panel UI on extraction tabs
    }

    buildModal();
    renderResults();
    renderQueueUI();
    watchSpaNavigation();

    // Sync panel visibility with shared storage
    applyPanelVisibility();

    // v6.5.0: update error count badge on load
    const badge = document.getElementById('ml-error-count');
    if (badge) badge.textContent = errorLog.length;

    setDebugger(`[V${EXT_VERSION}] Conectado. ${products.length} productos en almacenamiento compartido.`);
  }

  /** v6.8.0: Wait for ML article SPA to fully render, then extract data.
   *  Uses MutationObserver + poll for key elements (title, price) to appear.
   */
  async function runTabExtraction() {
    console.log('[ML Scraper] Tab extraction mode — waiting for SPA render...');

    // Wait for the title element to appear (indicates SPA hydrated)
    const maxWait = 20000;  // 20s max
    const startTime = Date.now();
    let titleEl = null;

    while (Date.now() - startTime < maxWait) {
      titleEl = document.querySelector('.ui-pdp-title');
      if (titleEl && titleEl.textContent.trim().length > 3) break;
      await new Promise(r => setTimeout(r, 300));
    }

    // Extra delay to let price/seller data load
    await new Promise(r => setTimeout(r, 1000));

    console.log('[ML Scraper] SPA rendered, extracting...');

    try {
      const extracted = parseArticleDocument(document, location.href);
      console.log('[ML Scraper] Extraction result:', {
        title: extracted.Nombre,
        price: extracted.Precio_Numerico,
        score: extracted.Score,
        reviews: extracted.Opiniones,
        seller: extracted.Vendedor_Nombre
      });

      // Send the extracted data back to the background
      chrome.runtime.sendMessage({
        action: 'ARTICLE_EXTRACTED',
        data: { success: true, extracted }
      }, (response) => {
        // After sending, the background will close this tab
        if (chrome.runtime.lastError) {
          console.error('[ML Scraper] Error sending extraction:', chrome.runtime.lastError.message);
        }
      });
    } catch (err) {
      console.error('[ML Scraper] Extraction failed:', err);
      chrome.runtime.sendMessage({
        action: 'ARTICLE_EXTRACTED',
        data: { success: false, error: err.message }
      });
    }
  }

  // Wait for body to exist (content script runs at document_idle, but be safe).
  if (document.body) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
