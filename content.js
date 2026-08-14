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

  const EXT_VERSION = '6.3.0';
  const STORAGE_KEY_PRODUCTS = 'ml_products';
  const STORAGE_KEY_QUEUE = 'ml_deep_queue';
  const STORAGE_KEY_QUEUE_WORK = 'ml_queue_work';        // v6.3.0: persisted crawl phrase/URL queue
  const STORAGE_KEY_ACCESS_TOKEN = 'ml_access_token';    // v6.3.0: ML API token for visits
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
        <div class="ml-header-title">
          ${logoIconUrl() ? `<img src="${escapeAttr(logoIconUrl())}" class="ml-header-logo" alt="ML">` : ''}
          <span>ML Scraper VE v${EXT_VERSION}</span>
        </div>
        <span class="ml-close-btn" id="ml-close" title="Ocultar panel (usa el ícono de la extensión para mostrarlo de nuevo)">${ICONS.close}</span>
      </div>
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
          <div class="ml-btn-group">
            <button class="ml-btn ml-btn-primary" id="btn-start">Iniciar Crawling</button>
            <button class="ml-btn ml-btn-secondary ml-btn-icon" id="btn-toggle-pause" title="Pausar / Resumir" disabled>${ICONS.pause}</button>
            <button class="ml-btn ml-btn-danger ml-btn-icon" id="btn-reset" title="Reset / Limpiar">${ICONS.reset}</button>
          </div>
          <div class="ml-progress-bar"><div class="ml-progress-fill" id="ml-progress"></div></div>
          <div class="ml-stats">
            <span id="ml-status">Estado: En espera</span>
            <span id="ml-count">Productos: ${products.length}</span>
          </div>
          <div class="ml-btn-group" style="margin-top: 8px;">
            <button class="ml-btn ml-btn-success" id="btn-download" ${products.length === 0 ? 'disabled' : ''}>Descargar CSV/Excel</button>
          </div>
          <div class="ml-btn-group" style="margin-top: 4px;">
            <button class="ml-btn ml-btn-secondary" id="btn-use-current-url" title="Usa la URL completa de esta pestaña como punto de inicio (ideal para categorías y listados personalizados)" style="flex:1; font-size:10px;">🔗 Usar URL de esta pestaña</button>
          </div>
          <div class="ml-queue-box">
            <div class="ml-queue-title">Cola de Trabajo (Frases / URLs)</div>
            <div id="queue-container"><span style="color:#888; font-size:10px;">Sin frases pendientes...</span></div>
          </div>
        </div>
        ` : ''}

        <div id="tab-results" class="ml-tab-body ${isArticlePage ? 'active' : ''}">
          <div class="ml-btn-group" style="margin-bottom: 8px;">
            <button class="ml-btn ml-btn-purple" id="btn-deep-extract" ${deepQueue.length === 0 ? 'disabled' : ''}>Extraer Artículos Seleccionados (<span id="deep-count">${deepQueue.length}</span>)</button>
            <button class="ml-btn ml-btn-success" id="btn-download" ${products.length === 0 ? 'disabled' : ''}>Descargar CSV</button>
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
            <input type="number" id="cfg-sales" value="0">
          </div>
          <div class="ml-input-group">
            <label>Score Mínimo (ej: 4.8):</label>
            <input type="number" id="cfg-score" step="0.1" value="0">
          </div>
          <div class="ml-input-group">
            <label>Solo Envío Gratis:</label>
            <select id="cfg-shipping">
              <option value="false" selected>No (Todos)</option>
              <option value="true">Sí</option>
            </select>
          </div>
          <div class="ml-input-group">
            <label>Delay Async Fetch (ms):</label>
            <input type="number" id="cfg-delay" value="1200">
          </div>
          <div class="ml-input-group">
            <label>Máx. Páginas por Búsqueda (0 = ilimitado):</label>
            <input type="number" id="cfg-max-pages" value="20">
          </div>
          <div class="ml-input-group">
            <label>Máx. Productos Total (0 = ilimitado):</label>
            <input type="number" id="cfg-max-products" value="0">
          </div>
          <div class="ml-input-group">
            <label>ML API Access Token (opcional, para visitas):</label>
            <input type="password" id="cfg-access-token" placeholder="APP_USR-...-...-..." style="font-size:10px;">
            <div style="font-size:9px; color:#888; margin-top:3px;">Pega tu token de ML para obtener visitas reales. Sin token, la API pública funciona pero con límites más bajos.</div>
          </div>
          <div class="ml-btn-group" style="margin-top: 8px;">
            <button class="ml-btn ml-btn-purple" id="btn-open-analysis" style="flex:1;">📊 Abrir Análisis Estratégico</button>
          </div>
          <hr style="border:0; border-top:1px solid #eee; margin:10px 0;">
          <div style="font-size: 11px; font-weight: bold; margin-bottom: 6px; color: #2d3277;">Información Extraída del Vendedor</div>
          <div id="seller-inspection-container">
            <p style="font-size: 10px; color: #777;">Haz clic en un producto para inspeccionar tienda y datos en Venezuela.</p>
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
    return m ? m[0].replace('_', '-').toUpperCase() : null;
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
  /* Search-results page parser                                       */
  /* ------------------------------------------------------------------ */

  function parsePage(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const items = doc.querySelectorAll('.ui-search-results li.ui-search-layout__item');
    const minScore = parseFloat(safeValue('cfg-score', 0)) || 0;
    const minSales = parseInt(safeValue('cfg-sales', 0), 10) || 0;
    const requireFreeShipping = safeValue('cfg-shipping', 'false') === 'true';

    let countOnPage = 0;
    const incoming = [];

    items.forEach((item) => {
      countOnPage++;
      const nameEl = item.querySelector('h3');
      const imgEl = item.querySelector('img[data-id]');
      const priceEl = item.querySelector('.poly-price__amount');
      const reviewsEl = item.querySelector('.poly-component__review-compacted + .andes-visually-hidden');
      const shippingEl = item.querySelector('.poly-component__shipping-v2 .andes-visually-hidden');
      const linkEl = item.querySelector('a.poly-component__title') || item.querySelector('a');

      const name = nameEl ? (nameEl.innerText || nameEl.textContent || '').trim() : 'N/A';
      const image = imgEl ? (imgEl.getAttribute('data-src') || imgEl.src || '') : '';
      const priceAttr = priceEl ? priceEl.getAttribute('aria-label') : '';
      const priceFractionEl = priceEl ? priceEl.querySelector('.andes-money-amount__fraction') : null;
      const priceFraction = priceFractionEl ? (priceFractionEl.innerText || '').trim() : '';
      const currencyEl = priceEl ? priceEl.querySelector('.andes-money-amount__currency-symbol') : null;
      const currencySymbol = currencyEl ? (currencyEl.innerText || '').trim() : '';
      const reviewsText = reviewsEl ? (reviewsEl.innerText || reviewsEl.textContent || '').trim() : '';
      const shippingText = shippingEl ? (shippingEl.innerText || shippingEl.textContent || '').trim() : '';
      const permalink = linkEl ? linkEl.href : '';

      const parsedPrice = parsePrice(priceAttr, priceFraction, currencySymbol);
      const scoreMatch = reviewsText.match(/Calificación\s+([0-9.,]+)\s+de\s+5/i);
      const score = scoreMatch ? parseFloat(scoreMatch[1].replace(',', '.')) : 0;
      const isFreeShipping = shippingText.toLowerCase().indexOf('envío gratis') !== -1 ||
                            shippingText.toLowerCase().indexOf('envio gratis') !== -1;

      const salesMatch = reviewsText.match(/([0-9.,]+)\s*ventas/i) ||
                         (item.innerText || '').match(/\+?([0-9.,]+)\s*vendidos/i);
      const salesCount = salesMatch ? parseInt(salesMatch[1].replace(/\./g, '').replace(',', ''), 10) : 0;

      if (score >= minScore && salesCount >= minSales && (!requireFreeShipping || isFreeShipping)) {
        const mlvId = extractMlvId(permalink);
        const id = mlvId || ('slug_' + Math.random().toString(36).substr(2, 9));
        incoming.push({
          id,
          Nombre: name,
          Precio_Numerico: parsedPrice.num,
          Precio_Detallado: parsedPrice.text,
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
          Visitas: 0,                    // v6.3.0: populated by ML visits API during deep extraction
          DeepExtracted: false
        });
      }
    });

    if (incoming.length) {
      const merged = mergeIntoLocal(incoming);
      persistProducts();
      if (merged > 0) {
        setDebugger(`[Página analizada]: ${countOnPage} items, ${merged} nuevos agregados.`);
      }
    }
    return countOnPage;
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

    phrases.forEach((phrase) => {
      // v6.2.0: detect whether this entry is a URL or a plain phrase.
      const isUrl = /^https?:\/\//i.test(phrase);
      // Dedup key: normalized lowercase (URLs) or as-is (phrases)
      const dedupKey = isUrl ? phrase.toLowerCase().replace(/\/+$/, '') : phrase.toLowerCase();
      if (!queueWork.some((q) => {
        const qKey = /^https?:\/\//i.test(q.phrase) ? q.phrase.toLowerCase().replace(/\/+$/, '') : q.phrase.toLowerCase();
        return qKey === dedupKey;
      })) {
        queueWork.push({
          id: 'q_' + Math.random().toString(36).substr(2, 7),
          phrase,
          isUrl,
          status: 'waiting'
        });
      }
    });

    searchInput.value = '';
    // v6.3.0: persist the queue so other tabs see it too
    persistQueueWork();
    renderQueueUI();
    if (!isCrawling) processNextInQueue();
  }

  function renderQueueUI() {
    const container = document.getElementById('queue-container');
    if (!container) return;
    if (queueWork.length === 0) {
      container.innerHTML = '<span style="color:#888; font-size:10px;">Sin frases pendientes...</span>';
      return;
    }
    container.innerHTML = '';
    queueWork.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'ml-queue-item ' + item.status;
      const statusText = item.status === 'processing' ? 'En proceso...'
        : item.status === 'done' ? 'Completado' : 'En espera';
      // v6.2.0: URLs get a 🔗 icon and are truncated; phrases show as-is
      const displayText = item.isUrl
        ? '🔗 ' + escapeHtml(truncateUrl(item.phrase, 50))
        : escapeHtml(item.phrase);
      const st = escapeHtml(statusText);
      el.innerHTML = `
        <span><b>${displayText}</b> <i style="font-size:9px; color:#666;">(${st})</i></span>
        ${item.status !== 'done' ? '<span style="cursor:pointer; color:#ff5252; font-weight:bold;" class="cancel-q">✕</span>' : ''}
      `;
      // Add full-URL tooltip for truncated URLs
      if (item.isUrl) {
        el.title = item.phrase;
      }
      if (item.status !== 'done') {
        const cancelEl = el.querySelector('.cancel-q');
        if (cancelEl) cancelEl.onclick = () => {
          queueWork = queueWork.filter((q) => q.id !== item.id);
          persistQueueWork();   // v6.3.0: sync across tabs
          renderQueueUI();
        };
      }
      container.appendChild(el);
      if (item.status === 'done') {
        setTimeout(() => {
          queueWork = queueWork.filter((q) => q.id !== item.id);
          persistQueueWork();   // v6.3.0: sync across tabs
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
      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = 'Estado: Finalizado';
      if (modal) modal.classList.remove('crawling-active');
      playNotificationSound();
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
    persistQueueWork();   // v6.3.0: sync status change across tabs
    renderQueueUI();
    processNextInQueue();
  }

  async function runCrawler() {
    const delay = parseInt(safeValue('cfg-delay', '1200'), 10) || 1500;
    const maxPages = parseInt(safeValue('cfg-max-pages', '20'), 10);
    const maxProducts = parseInt(safeValue('cfg-max-products', '0'), 10);
    if (modal) modal.classList.add('crawling-active');

    let safetyCounter = 0;
    let consecutive429 = 0;
    while (isCrawling && safetyCounter < 5000) {
      safetyCounter++;

      // Max-products limit (0 = unlimited)
      if (maxProducts > 0 && products.length >= maxProducts) {
        setDebugger(`[Límite alcanzado]: ${products.length} productos ≥ máximo ${maxProducts}. Deteniendo.`);
        const statusEl = document.getElementById('ml-status');
        if (statusEl) statusEl.innerText = `Estado: Límite de ${maxProducts} productos alcanzado`;
        break;
      }

      // Max-pages limit (0 = unlimited)
      if (maxPages > 0 && processedPagesCount >= maxPages) {
        setDebugger(`[Límite alcanzado]: ${processedPagesCount} páginas ≥ máximo ${maxPages}. Deteniendo.`);
        const statusEl = document.getElementById('ml-status');
        if (statusEl) statusEl.innerText = `Estado: Límite de ${maxPages} páginas alcanzado`;
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

      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = `Procesando: ${currentSearchProcess.phrase} (Pág. ${processedPagesCount}/${maxPages > 0 ? maxPages : '∞'})`;
      setDebugger(`[Crawling]: ${currentUrl}`);

      try {
        const response = await fetch(currentUrl, { credentials: 'include' });

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
          setDebugger(`[HTTP ${response.status}]: deteniendo crawl para "${currentSearchProcess.phrase}".`);
          break;
        }
        if (response.redirected && currentOffset > 1 && response.url.indexOf('_Desde_') === -1) {
          setDebugger('[Redirección sin paginación]: fin de resultados.');
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

  /* ------------------------------------------------------------------ */
  /* Article parser (deep extraction)                                 */
  /* ------------------------------------------------------------------ */

  function parseArticleDocument(doc, targetUrl) {
    // 1. Title
    const titleEl = doc.querySelector('.ui-pdp-title');
    const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : (doc.title || 'N/A');

    // 2. Main image
    const imgEl = doc.querySelector('img.ui-pdp-gallery__figure__image') || doc.querySelector('.ui-pdp-gallery__figure img');
    let imageSrc = '';
    if (imgEl) {
      imageSrc = imgEl.getAttribute('data-zoom') || imgEl.src || '';
      if (!imageSrc && imgEl.getAttribute('srcset')) {
        imageSrc = imgEl.getAttribute('srcset').split(',')[0].trim().split(' ')[0];
      }
    }

    // 3. Price (numeric + detailed) + currency
    const priceFractionEl = doc.querySelector('.ui-pdp-price__second-line .andes-money-amount__fraction');
    const priceAriaEl = doc.querySelector('.ui-pdp-price__second-line .andes-money-amount');
    const currencyEl = priceAriaEl ? priceAriaEl.querySelector('.andes-money-amount__currency-symbol') : null;
    const priceFraction = priceFractionEl ? (priceFractionEl.innerText || '').trim() : '';
    const priceAria = priceAriaEl ? priceAriaEl.getAttribute('aria-label') : '';
    const currencySymbol = currencyEl ? (currencyEl.innerText || '').trim() : '';
    const parsedPrice = parsePrice(priceAria, priceFraction, currencySymbol);

    // 4. Score
    const scoreEl = doc.querySelector('.ui-pdp-review__rating');
    const scoreVal = scoreEl ? parseFloat((scoreEl.innerText || scoreEl.textContent || '').trim().replace(',', '.')) : 0;

    // 5. Sales
    const subtitleEl = doc.querySelector('.ui-pdp-subtitle');
    let salesCount = 0;
    if (subtitleEl) {
      const txt = subtitleEl.innerText || subtitleEl.textContent || '';
      const salesMatch = txt.match(/\+?([0-9.,]+)\s*vendidos/i);
      if (salesMatch) salesCount = parseInt(salesMatch[1].replace(/\./g, '').replace(',', ''), 10);
    }

    // 6. Location
    const locEl = doc.querySelector('#subtitle_ .andes-typography--color-secondary') || doc.querySelector('.xprod-lib-shipping-promises__item .andes-typography--color-secondary');
    const locationText = locEl ? (locEl.innerText || locEl.textContent || '').trim() : 'No especificada';

    // 7. Seller
    const sellerEl = doc.querySelector('.ui-seller-data-header__title span') ||
                     doc.querySelector('.ui-seller-data-header__title') ||
                     doc.querySelector('#seller_data h2');
    const sellerName = sellerEl ? (sellerEl.innerText || sellerEl.textContent || '').trim() : 'No especificado';

    // 8. Seller status + breadcrumbs
    const statusEl = doc.querySelector('.ui-seller-data-status__title');
    const breadcrumbs = doc.querySelectorAll('.andes-breadcrumb a.andes-breadcrumb__link');

    // 9. Technical specifications — brand & model
    const specsTables = doc.querySelectorAll('.ui-pdp-container__row--technical-specifications table, .ui-pdp-specifications table');
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

    // 10. Google breakout URL for seller OSINT
    const googleQuery = encodeURIComponent(`"${sellerName}" Venezuela (whatsapp OR instagram OR rif OR telefono OR tienda)`);
    const googleBreakoutUrl = `https://www.google.com/search?q=${googleQuery}`;

    const mlvId = extractMlvId(targetUrl);
    return {
      id: mlvId || ('art_' + Math.random().toString(36).substr(2, 9)),
      Nombre: title,
      Precio_Numerico: parsedPrice.num,
      Precio_Detallado: parsedPrice.text,
      Moneda: parsedPrice.currency,
      Score: isNaN(scoreVal) ? 0 : scoreVal,
      Ventas: salesCount,
      Ubicacion: locationText,
      Vendedor_Nombre: sellerName,
      Vendedor_Estatus: statusEl ? (statusEl.innerText || statusEl.textContent || '').trim() : 'N/A',
      Categorias: Array.from(breadcrumbs).map((b) => (b.innerText || b.textContent || '').trim()).join(' > '),
      Marca: brand,
      Modelo: model,
      Especificaciones: specList.join(' | '),
      Imagen: imageSrc,
      Link: (targetUrl || '').split('?')[0],
      Google_Breakout_Vendedor: googleBreakoutUrl,
      Visitas: 0,                    // v6.3.0: populated by ML visits API (separate fetch)
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

    while (deepQueue.length > 0 && isDeepCrawling) {
      const current = deepQueue[0];
      const rawLink = typeof current === 'string' ? current : current.Link;
      const mlvId = extractMlvId(rawLink) || rawLink;
      // Prefer the stored permalink when available, fall back to the canonical ML redirect URL.
      const fetchTargetUrl = rawLink && /^https?:\/\//i.test(rawLink)
        ? rawLink
        : `https://articulo.mercadolibre.com.ve/${mlvId}`;

      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = `Background Fetch: ${mlvId}... (${deepQueue.length} restantes)`;
      setDebugger(`[Deep fetch]: ${fetchTargetUrl}`);

      try {
        const response = await sendMessage({ action: 'FETCH_ARTICLE', url: fetchTargetUrl });
        if (response && response.success && response.html) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(response.html, 'text/html');
          const extracted = parseArticleDocument(doc, response.finalUrl || fetchTargetUrl);

          const existingIdx = products.findIndex((p) => extractMlvId(p.Link) === mlvId || p.id === mlvId);
          if (existingIdx >= 0) {
            products[existingIdx] = { ...products[existingIdx], ...extracted, id: products[existingIdx].id };
          } else {
            products.push(extracted);
          }
          await persistProducts();

          // v6.3.0: fetch real visit count from the ML API for this article.
          // This is a separate network call to api.mercadolibre.com (proxied
          // through the background SW to bypass CORS). The visit count is
          // stored on the product as `Visitas` and used in A1 scoring.
          try {
            const visitResponse = await sendMessage({ action: 'FETCH_VISITS', itemId: mlvId });
            if (visitResponse && visitResponse.success) {
              const idx = products.findIndex((p) => extractMlvId(p.Link) === mlvId || p.id === mlvId);
              if (idx >= 0) {
                products[idx].Visitas = visitResponse.visits || 0;
                await persistProducts();
              }
              setDebugger(`[Visitas ${mlvId}]: ${visitResponse.visits || 0} visitas en 10 días`);
            } else if (visitResponse && visitResponse.error) {
              setDebugger(`[Visitas ${mlvId} error]: ${visitResponse.error}`);
            }
          } catch (visitErr) {
            setDebugger(`[Visitas ${mlvId} exception]: ${visitErr.message}`);
          }
        } else {
          setDebugger('[Deep fetch error]: ' + (response && response.error ? response.error : 'sin respuesta'));
        }
      } catch (err) {
        setDebugger('[Deep fetch exception]: ' + (err && err.message ? err.message : String(err)));
      }

      deepQueue.shift();
      await persistDeepQueue();
      renderResults();
      await new Promise((r) => setTimeout(r, delay));
    }

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

    const headers = [
      'Nombre', 'Precio_Numerico', 'Moneda', 'Precio_Detallado', 'Score', 'Ventas_Estimadas',
      'Visitas_10dias',   // v6.3.0: real visit count from ML API (0 = not yet fetched)
      'EnvioGratis', 'Vendedor_Nombre', 'Vendedor_Estatus', 'Ubicacion_Tienda',
      'Categorias', 'Marca', 'Modelo', 'Especificaciones', 'Imagen', 'Link_Producto', 'Google_Breakout_Vendedor'
    ];

    const rows = products.map((p) => [
      csvCell(p.Nombre),
      csvCell(p.Precio_Numerico || 0),
      csvCell(p.Moneda || 'N/A'),
      csvCell(p.Precio_Detallado || ''),
      csvCell(p.Score || 0),
      csvCell(p.Ventas || 0),
      csvCell(p.Visitas || 0),
      csvCell(p.EnvioGratis || 'No'),
      csvCell(p.Vendedor_Nombre || 'N/A'),
      csvCell(p.Vendedor_Estatus || 'N/A'),
      csvCell(p.Ubicacion || 'N/A'),
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
    buildModal();
    renderResults();
    renderQueueUI();
    watchSpaNavigation();

    // Sync panel visibility with shared storage
    applyPanelVisibility();

    setDebugger(`[V${EXT_VERSION}] Conectado. ${products.length} productos en almacenamiento compartido.`);
  }

  // Wait for body to exist (content script runs at document_idle, but be safe).
  if (document.body) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
