/* =========================================================================
 * MercadoLibre Scraper VE - Version: 4.0.5 (HTML Specific & Google Link CSV)
 * ========================================================================= */
(function () {
  const isArticlePage = location.hostname.includes('articulo.mercadolibre.com');

  // 1. RECOGIDA DE PARÁMETROS DE LA URL
  const urlParams = new URLSearchParams(window.location.search);
  const queueParam = urlParams.get('deep_ids');

  let deepQueue = [];
  try {
    if (queueParam) deepQueue = JSON.parse(queueParam);
  } catch (e) {
    console.error("Error al parsear deep_ids:", e);
  }

  // 2. RECUPERACIÓN Y GUARDADO DE DATOS EN LOCALSTORAGE
  let products = [];
  try {
    const savedData = localStorage.getItem('ml_products_data');
    if (savedData) products = JSON.parse(savedData);
  } catch (e) {
    console.error("Error cargando productos de localStorage:", e);
  }

  function saveProductsToStorage() {
    try {
      localStorage.setItem('ml_products_data', JSON.stringify(products));
    } catch (e) {
      console.error("Error guardando en localStorage:", e);
    }
  }

  // SINTETIZADOR DE SONIDO
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
    } catch (e) {}
  }

  // ESTADO DEL CRAWLER PRINCIPAL
  let queueWork = [];
  let currentSearchProcess = null;
  let isCrawling = false;
  let isPaused = false;
  let isDeepCrawling = false;
  let visitedUrls = new Set();
  let processedPagesCount = 0;
  let currentBaseSlug = '';
  let currentOffset = 1;

  const ICONS = {
    pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`,
    play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
    reset: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>`,
    trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
    close: `✕`
  };

  // ESTILOS CSS COMPLETOS
  const style = document.createElement('style');
  style.textContent = `
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
      position: fixed; top: 15px; right: 15px; width: 490px; z-index: 999999;
      background: #ffffff; color: #333333; border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.3); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden; border: 2px solid #e0e0e0; transition: all 0.3s ease;
    }
    #ml-crawler-modal.crawling-active { animation: gradientGlow 2.5s infinite ease-in-out; }
    .ml-header { background: #fff159; padding: 10px 14px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e5d84f; }
    .ml-tabs { display: flex; background: #f5f5f5; border-bottom: 1px solid #ddd; }
    .ml-tab { flex: 1; padding: 10px 4px; text-align: center; cursor: pointer; font-size: 12px; font-weight: 600; color: #666; transition: 0.2s; }
    .ml-tab.active { background: #fff; color: #333; border-bottom: 3px solid #2d3277; }
    .ml-content { padding: 14px; max-height: 520px; overflow-y: auto; }
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
    #ml-preview-card { position: fixed; width: 230px; background: #fff; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,0.25); padding: 10px; z-index: 1000000; pointer-events: none; display: none; font-size: 11px; }
    #ml-preview-card img { width: 100%; height: 140px; object-fit: contain; border-radius: 4px; margin-bottom: 6px; }
    #ml-notification-banner { display: none; background: #00a650; color: #fff; padding: 10px; border-radius: 6px; font-size: 12px; text-align: center; font-weight: bold; margin-bottom: 10px; }
    .ml-detail-box { background: #f8f9fa; border: 1px solid #ddd; border-radius: 6px; padding: 8px; margin-top: 8px; font-size: 11px; }
    .ml-detail-row { display: flex; justify-content: space-between; border-bottom: 1px solid #eee; padding: 3px 0; }
    .ml-debug-box { background: #1e1e1e; color: #00ff66; font-family: monospace; font-size: 10px; padding: 8px; border-radius: 6px; word-break: break-all; margin-bottom: 10px; max-height: 60px; overflow-y: auto; }
  `;
  document.head.appendChild(style);

  const previewCard = document.createElement('div');
  previewCard.id = 'ml-preview-card';
  document.body.appendChild(previewCard);

  // INTERFAZ MODAL COMPLETA
  const modal = document.createElement('div');
  modal.id = 'ml-crawler-modal';
  modal.innerHTML = `
    <div class="ml-header">
      <span>MercadoLibre Scraper VE v4.0.5</span>
      <span class="ml-close-btn" id="ml-close">${ICONS.close}</span>
    </div>
    <div class="ml-tabs">
      ${!isArticlePage ? `<div class="ml-tab active" data-target="tab-search">Buscador</div>` : ''}
      <div class="ml-tab ${isArticlePage ? 'active' : ''}" data-target="tab-results">Resultados (<span id="tab-count">${products.length}</span>)</div>
      <div class="ml-tab" data-target="tab-config">Filtros & Config</div>
    </div>
    <div class="ml-content">
      <div id="ml-notification-banner">✔ ¡Extracción Profunda Completada!</div>
      
      <div class="ml-debug-box" id="url-debugger">
        [URL Monitor]: ${queueParam ? 'Procesando cola en segundo plano...' : 'Listo en espera de acciones.'}
      </div>

      ${!isArticlePage ? `
      <!-- TAB 1: BUSCADOR -->
      <div id="tab-search" class="ml-tab-body active">
        <div class="ml-input-group">
          <label>Término(s) de Búsqueda (Enter para agregar):</label>
          <textarea id="ml-search-input" rows="2" placeholder="Ej: licuadora, cafetera, tostadora"></textarea>
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
        <div class="ml-queue-box">
          <div class="ml-queue-title">Cola de Trabajo (Frases)</div>
          <div id="queue-container"><span style="color:#888; font-size:10px;">Sin frases pendientes...</span></div>
        </div>
      </div>
      ` : ''}

      <!-- TAB 2: RESULTADOS INTERACTIVOS -->
      <div id="tab-results" class="ml-tab-body ${isArticlePage ? 'active' : ''}">
        <div class="ml-btn-group" style="margin-bottom: 8px;">
          <button class="ml-btn ml-btn-purple" id="btn-deep-extract" ${deepQueue.length === 0 ? 'disabled' : ''}>Extraer Artículos Seleccionados (<span id="deep-count">${deepQueue.length}</span>)</button>
          ${isArticlePage ? `<button class="ml-btn ml-btn-success" id="btn-download" ${products.length === 0 ? 'disabled' : ''}>Descargar CSV/Excel</button>` : ''}
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

      <!-- TAB 3: CONFIGURACIÓN E INSPECCIÓN DE VENDEDOR -->
      <div id="tab-config" class="ml-tab-body">
        <div style="font-size: 11px; font-weight: bold; margin-bottom: 6px; color: #2d3277;">Filtros Generales</div>
        <div class="ml-input-group">
          <label>Ventas Mínimas Requeridas (ej: 500):</label>
          <input type="number" id="cfg-sales" value="0">
        </div>
        <div class="ml-input-group">
          <label>Score Mínimo (ej: 4.8):</label>
          <input type="number" id="cfg-score" step="0.1" value="4.8">
        </div>
        <div class="ml-input-group">
          <label>Solo Envío Gratis:</label>
          <select id="cfg-shipping">
            <option value="true" selected>Sí</option>
            <option value="false">No (Todos)</option>
          </select>
        </div>
        <div class="ml-input-group">
          <label>Delay Async Fetch (ms):</label>
          <input type="number" id="cfg-delay" value="1200">
        </div>
        <hr style="border:0; border-top:1px solid #eee; margin:10px 0;">
        <div style="font-size: 11px; font-weight: bold; margin-bottom: 6px; color: #2d3277;">Información Extraída del Vendedor</div>
        <div id="seller-inspection-container">
          <p style="font-size: 10px; color: #777;">Haz clic en un producto para inspeccionar tienda y datos en Venezuela.</p>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll('.ml-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.querySelectorAll('.ml-tab').forEach(t => t.classList.remove('active'));
      modal.querySelectorAll('.ml-tab-body').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      modal.querySelector(`#${tab.dataset.target}`).classList.add('active');
    });
  });

  document.getElementById('ml-close').onclick = () => modal.remove();

  function parsePrice(ariaLabel) {
    if (!ariaLabel) return { num: 0, text: '' };
    let dollars = 0, cents = 0;
    const dollarsMatch = ariaLabel.match(/([0-9.,]+)\s*dólares/i) || ariaLabel.match(/([0-9.,]+)\s*bolívares/i);
    const centsMatch = ariaLabel.match(/con\s*([0-9]+)\s*centavos/i);
    if (dollarsMatch) {
      dollars = parseFloat(dollarsMatch[1].replace(/\./g, '').replace(',', '.'));
    } else {
      const genericMatch = ariaLabel.match(/[0-9.,]+/);
      if (genericMatch) dollars = parseFloat(genericMatch[0].replace(/\./g, '').replace(',', '.'));
    }
    if (centsMatch) cents = parseInt(centsMatch[1], 10) / 100;
    const total = dollars + cents;
    return { num: isNaN(total) ? 0 : parseFloat(total.toFixed(2)), text: ariaLabel };
  }

  function buildOffsetUrl(slug, offset) {
    const origin = window.location.origin;
    const cleanSlug = slug.replace(/^\/+|\/+$/g, '');
    return offset === 1 ? `${origin}/${cleanSlug}` : `${origin}/${cleanSlug}_Desde_${offset}_NoIndex_True`;
  }

  function parsePage(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const items = doc.querySelectorAll('.ui-search-results li.ui-search-layout__item');
    const minScore = parseFloat(document.getElementById('cfg-score').value) || 0;
    const minSales = parseInt(document.getElementById('cfg-sales').value, 10) || 0;
    const requireFreeShipping = document.getElementById('cfg-shipping').value === 'true';

    let countOnPage = 0;

    items.forEach(item => {
      countOnPage++;
      const nameEl = item.querySelector('h3');
      const imgEl = item.querySelector('img[data-id]');
      const priceEl = item.querySelector('.poly-price__amount');
      const reviewsEl = item.querySelector('.poly-component__review-compacted + .andes-visually-hidden');
      const shippingEl = item.querySelector('.poly-component__shipping-v2 .andes-visually-hidden');
      const linkEl = item.querySelector('a.poly-component__title') || item.querySelector('a');

      const name = nameEl ? nameEl.innerText.trim() : 'N/A';
      const image = imgEl ? (imgEl.getAttribute('data-src') || imgEl.src) : '';
      const priceAttr = priceEl ? priceEl.getAttribute('aria-label') : '';
      const reviewsText = reviewsEl ? reviewsEl.innerText.trim() : '';
      const shippingText = shippingEl ? shippingEl.innerText.trim() : '';
      const permalink = linkEl ? linkEl.href : '';

      const parsedPrice = parsePrice(priceAttr);
      const scoreMatch = reviewsText.match(/Calificación ([0-9.]+) de 5/);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
      const isFreeShipping = shippingText.toLowerCase().includes('envío gratis');

      const salesMatch = reviewsText.match(/([0-9.,]+)\s*ventas/i) || item.innerText.match(/([0-9.,]+)\s*vendidos/i);
      const salesCount = salesMatch ? parseInt(salesMatch[1].replace(/\./g, '')) : 0;

      if (score >= minScore && salesCount >= minSales && (!requireFreeShipping || isFreeShipping)) {
        if (!products.some(p => p.Link === permalink && permalink !== '')) {
          products.push({
            id: 'prod_' + Math.random().toString(36).substr(2, 9),
            Nombre: name,
            Precio_Numerico: parsedPrice.num,
            Precio_Detallado: parsedPrice.text,
            Score: score,
            Ventas: salesCount,
            EnvioGratis: isFreeShipping ? "Sí" : "No",
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
            DeepExtracted: false
          });
        }
      }
    });

    saveProductsToStorage();
    return countOnPage;
  }

  function renderResults() {
    const container = document.getElementById('items-container');
    const filterText = document.getElementById('filter-name').value.toLowerCase();
    const sortVal = document.getElementById('sort-results').value;

    document.getElementById('tab-count').innerText = products.length;
    document.getElementById('deep-count').innerText = deepQueue.length;
    document.getElementById('btn-deep-extract').disabled = deepQueue.length === 0;

    let filtered = products.filter(p => p.Nombre.toLowerCase().includes(filterText));

    if (sortVal === 'price_asc') filtered.sort((a, b) => a.Precio_Numerico - b.Precio_Numerico);
    if (sortVal === 'price_desc') filtered.sort((a, b) => b.Precio_Numerico - a.Precio_Numerico);
    if (sortVal === 'sales_desc') filtered.sort((a, b) => b.Ventas - a.Ventas);
    if (sortVal === 'score_desc') filtered.sort((a, b) => b.Score - a.Score);

    container.innerHTML = '';

    filtered.forEach(p => {
      const isSelected = deepQueue.some(dq => (typeof dq === 'string' ? dq === p.Link || dq === extractMlvId(p.Link) : dq.id === p.id));
      const card = document.createElement('div');
      card.className = `ml-item-card ${isSelected ? 'selected-for-deep' : ''}`;
      
      card.innerHTML = `
        <img src="${p.Imagen}" class="ml-item-img" alt="Product">
        <div class="ml-item-info">
          <div class="ml-item-title">${p.Nombre}</div>
          <div class="ml-item-details">
            <span class="ml-item-price">$${p.Precio_Numerico ? p.Precio_Numerico.toFixed(2) : '0.00'}</span>
            <span>★ ${p.Score}</span>
            <span class="ml-badge-sales">${p.Ventas > 0 ? '+' + p.Ventas + ' vendidos' : 'Destacado'}</span>
          </div>
        </div>
        <div style="display:flex; gap:4px; align-items:center;">
          <button class="ml-btn select-deep-btn" style="padding:4px 6px; font-size:10px; background:${isSelected ? '#2d3277' : '#e0e0e0'}; color:${isSelected ? '#fff' : '#333'};">+ Deep</button>
          <a href="${p.Link}" target="_blank" class="ml-btn ml-btn-secondary" style="padding:4px 6px;" title="Ver Producto">🔗</a>
          <button class="ml-btn ml-btn-danger remove-btn" style="padding:4px 6px;">${ICONS.trash}</button>
        </div>
      `;

      const imgEl = card.querySelector('.ml-item-img');
      const infoEl = card.querySelector('.ml-item-info');

      const showPreview = (e) => {
        previewCard.style.display = 'block';
        previewCard.innerHTML = `
          <img src="${p.Imagen}" alt="Preview">
          <b>${p.Nombre}</b><br>
          <span style="color:#00a650; font-weight:bold;">Precio: $${p.Precio_Numerico}</span><br>
          <span style="color:#0d47a1; font-weight:bold;">Ventas: +${p.Ventas} unidades</span><br>
          <span>Score: ★ ${p.Score} | Envío Gratis: ${p.EnvioGratis}</span><br>
          ${p.DeepExtracted ? `<div style="color:#2d3277; font-size:9px; margin-top:4px;"><b>Cat:</b> ${p.Categorias}<br><b>Vendedor:</b> ${p.Vendedor_Nombre}</div>` : ''}
        `;
        updatePreviewPos(e);
      };

      const updatePreviewPos = (e) => {
        previewCard.style.top = Math.min(e.clientY + 15, window.innerHeight - 220) + 'px';
        previewCard.style.left = Math.max(e.clientX - 240, 10) + 'px';
      };

      const hidePreview = () => { previewCard.style.display = 'none'; };

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

      let startX = 0, currentX = 0, isDragging = false;
      const onStart = (e) => {
        isDragging = true;
        startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
      };
      const onMove = (e) => {
        if (!isDragging) return;
        currentX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
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

      card.addEventListener('touchstart', onStart, {passive: true});
      card.addEventListener('touchmove', onMove, {passive: true});
      card.addEventListener('touchend', onEnd);

      container.appendChild(card);
    });
  }

  function removeProductAnimated(cardEl, id) {
    cardEl.classList.add('removing');
    setTimeout(() => {
      products = products.filter(p => p.id !== id);
      deepQueue = deepQueue.filter(p => (typeof p === 'string' ? p !== id : p.id !== id));
      saveProductsToStorage();
      const countEl = document.getElementById('ml-count');
      if (countEl) countEl.innerText = `Productos: ${products.length}`;
      renderResults();
    }, 350);
  }

  function toggleSelectForDeep(product) {
    const existsIndex = deepQueue.findIndex(p => (typeof p === 'string' ? p === product.Link || p === extractMlvId(product.Link) : p.id === product.id));
    if (existsIndex >= 0) {
      deepQueue.splice(existsIndex, 1);
    } else {
      deepQueue.push(product);
    }
    renderResults();
  }

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

  function addPhrasesToQueue() {
    const searchInput = document.getElementById('ml-search-input');
    if (!searchInput) return;

    const rawVal = searchInput.value.trim();
    const phrases = rawVal ? rawVal.split(/[\n,]+/).map(s => s.trim()).filter(s => s.length > 0) : [window.location.pathname];

    phrases.forEach(phrase => {
      if (!queueWork.some(q => q.phrase.toLowerCase() === phrase.toLowerCase())) {
        queueWork.push({
          id: 'q_' + Math.random().toString(36).substr(2, 7),
          phrase: phrase,
          status: 'waiting'
        });
      }
    });

    searchInput.value = '';
    renderQueueUI();

    if (!isCrawling) processNextInQueue();
  }

  function renderQueueUI() {
    const container = document.getElementById('queue-container');
    if (!container) return;

    if (queueWork.length === 0) {
      container.innerHTML = `<span style="color:#888; font-size:10px;">Sin frases pendientes...</span>`;
      return;
    }

    container.innerHTML = '';
    queueWork.forEach(item => {
      const el = document.createElement('div');
      el.className = `ml-queue-item ${item.status}`;
      let statusText = item.status === 'processing' ? 'En proceso...' : item.status === 'done' ? 'Completado' : 'En espera';
      
      el.innerHTML = `
        <span><b>${item.phrase}</b> <i style="font-size:9px; color:#666;">(${statusText})</i></span>
        ${item.status !== 'done' ? `<span style="cursor:pointer; color:#ff5252; font-weight:bold;" class="cancel-q">✕</span>` : ''}
      `;

      if (item.status !== 'done') {
        el.querySelector('.cancel-q').onclick = () => {
          queueWork = queueWork.filter(q => q.id !== item.id);
          renderQueueUI();
        };
      }

      container.appendChild(el);
      if (item.status === 'done') {
        setTimeout(() => {
          queueWork = queueWork.filter(q => q.id !== item.id);
          renderQueueUI();
        }, 2200);
      }
    });
  }

  async function processNextInQueue() {
    const nextItem = queueWork.find(q => q.status === 'waiting');
    if (!nextItem) {
      isCrawling = false;
      document.getElementById('ml-status').innerText = 'Estado: Finalizado';
      document.getElementById('btn-start').disabled = false;
      document.getElementById('btn-start').classList.remove('animating');
      modal.classList.remove('crawling-active');
      return;
    }

    currentSearchProcess = nextItem;
    nextItem.status = 'processing';
    renderQueueUI();

    currentBaseSlug = nextItem.phrase.startsWith('/') ? nextItem.phrase : `/${encodeURIComponent(nextItem.phrase.toLowerCase())}`;
    currentOffset = 1;
    visitedUrls.clear();

    isCrawling = true;
    isPaused = false;

    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-start').classList.add('animating');
    document.getElementById('btn-toggle-pause').disabled = false;

    await runCrawler();

    nextItem.status = 'done';
    renderQueueUI();

    processNextInQueue();
  }

  async function runCrawler() {
    const delay = parseInt(document.getElementById('cfg-delay').value) || 1500;
    modal.classList.add('crawling-active');

    while (isCrawling) {
      if (isPaused) {
        document.getElementById('ml-status').innerText = 'Estado: Pausado';
        modal.classList.remove('crawling-active');
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      modal.classList.add('crawling-active');
      let currentUrl = buildOffsetUrl(currentBaseSlug, currentOffset);

      if (visitedUrls.has(currentUrl)) {
        currentOffset += 48;
        continue;
      }

      visitedUrls.add(currentUrl);
      processedPagesCount++;

      document.getElementById('ml-status').innerText = `Procesando: ${currentSearchProcess.phrase} (Pág. ${processedPagesCount})`;

      try {
        const response = await fetch(currentUrl);
        if (!response.ok || (response.redirected && !response.url.includes('_Desde_') && currentOffset > 1)) break;

        const html = await response.text();
        const itemsParsed = parsePage(html, currentUrl);

        if (itemsParsed === 0 && currentOffset > 1) break;

        document.getElementById('ml-count').innerText = `Productos: ${products.length}`;
        const btnDL = document.getElementById('btn-download');
        if (btnDL) btnDL.disabled = products.length === 0;

        renderResults();
        currentOffset += 48;

      } catch (err) {
        console.error("Error cargando URL:", currentUrl, err);
        break;
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }

  function extractMlvId(urlOrString) {
    if (!urlOrString) return null;
    const match = urlOrString.match(/MLV[-_]?\d+/i);
    return match ? match[0].replace('_', '-').toUpperCase() : null;
  }

  // EXTRACCIÓN EXACTA BASADA EN EL BLOQUE HTML PROPORCIONADO
  function parseArticleDocument(doc, targetUrl) {
    // 1. Título
    const titleEl = doc.querySelector('.ui-pdp-title');
    
    // 2. Imagen Principal
    const imgEl = doc.querySelector('img.ui-pdp-gallery__figure__image') || doc.querySelector('.ui-pdp-gallery__figure img');
    let imageSrc = '';
    if (imgEl) {
      imageSrc = imgEl.getAttribute('data-zoom') || imgEl.src || (imgEl.getAttribute('srcset') ? imgEl.getAttribute('srcset').split(' ')[0] : '');
    }

    // 3. Precio Numérico y Detallado
    const priceFraction = doc.querySelector('.ui-pdp-price__second-line .andes-money-amount__fraction');
    const priceAria = doc.querySelector('.ui-pdp-price__second-line .andes-money-amount');
    const parsedPrice = priceFraction ? parseFloat(priceFraction.innerText.replace(/\./g, '').replace(',', '.')) : 0;
    const priceText = priceAria ? priceAria.getAttribute('aria-label') : (priceFraction ? priceFraction.innerText.trim() : '0');

    // 4. Score y Reseñas
    const scoreEl = doc.querySelector('.ui-pdp-review__rating');
    const scoreVal = scoreEl ? parseFloat(scoreEl.innerText.trim()) : 0;

    // 5. Ventas Estimadas desde Subtitle
    const subtitleEl = doc.querySelector('.ui-pdp-subtitle');
    let salesCount = 0;
    if (subtitleEl) {
      const salesMatch = subtitleEl.innerText.match(/\+?([0-9.,]+)\s*vendidos/i);
      if (salesMatch) salesCount = parseInt(salesMatch[1].replace(/\./g, ''), 10);
    }

    // 6. Ubicación desde Promesas de Envío (#subtitle_)
    const locEl = doc.querySelector('#subtitle_ .andes-typography--color-secondary') || doc.querySelector('.xprod-lib-shipping-promises__item');
    const locationText = locEl ? locEl.innerText.trim() : 'No especificada';

    // 7. Vendedor
    const sellerEl = doc.querySelector('.ui-seller-data-header__title span') || 
                     doc.querySelector('.ui-seller-data-header__title') || 
                     doc.querySelector('#seller_data h2');
    const sellerName = sellerEl ? sellerEl.innerText.trim() : 'No especificado';

    // 8. Estatus Vendedor & Categorías
    const statusEl = doc.querySelector('.ui-seller-data-status__title');
    const breadcrumbs = doc.querySelectorAll('.andes-breadcrumb a.andes-breadcrumb__link');

    // 9. Especificaciones Técnicas
    const specsTables = doc.querySelectorAll('.ui-pdp-container__row--technical-specifications table');
    let specList = [], brand = 'N/A', model = 'N/A';
    specsTables.forEach(table => {
      table.querySelectorAll('tr').forEach(r => {
        const th = r.querySelector('th'), td = r.querySelector('td');
        if (th && td) {
          const key = th.innerText.trim(), val = td.innerText.trim();
          if (key.toLowerCase() === 'marca') brand = val;
          if (key.toLowerCase() === 'modelo') model = val;
          specList.push(`${key}: ${val}`);
        }
      });
    });

    // 10. URL de Búsqueda de Vendedor en Google para el CSV
    const googleQuery = encodeURIComponent(`"${sellerName}" Venezuela (whatsapp OR instagram OR rif OR telefono OR tienda)`);
    const googleBreakoutUrl = `https://www.google.com/search?q=${googleQuery}`;

    return {
      Nombre: titleEl ? titleEl.innerText.trim() : doc.title,
      Precio_Numerico: parsedPrice,
      Precio_Detallado: priceText,
      Score: scoreVal,
      Ventas: salesCount,
      Ubicacion: locationText,
      Vendedor_Nombre: sellerName,
      Vendedor_Estatus: statusEl ? statusEl.innerText.trim() : 'N/A',
      Categorias: Array.from(breadcrumbs).map(b => b.innerText.trim()).join(' > '),
      Marca: brand,
      Modelo: model,
      Especificaciones: specList.join(' | '),
      Imagen: imageSrc,
      Link: targetUrl.split('?')[0],
      Google_Breakout_Vendedor: googleBreakoutUrl,
      DeepExtracted: true
    };
  }

  // MOTOR ASYNC FETCH EN SEGUNDO PLANO
  async function runAsyncFetchQueue() {
    if (deepQueue.length === 0) return;

    isDeepCrawling = true;
    modal.classList.add('crawling-active');
    const delay = parseInt(document.getElementById('cfg-delay').value) || 1200;

    while (deepQueue.length > 0 && isDeepCrawling) {
      const currentIdOrUrl = deepQueue[0];
      const mlvId = extractMlvId(typeof currentIdOrUrl === 'string' ? currentIdOrUrl : currentIdOrUrl.Link);
      const fetchTargetUrl = `https://articulo.mercadolibre.com.ve/${mlvId}`;

      const statusEl = document.getElementById('ml-status');
      if (statusEl) statusEl.innerText = `Fetch Silencioso: ${mlvId}... (${deepQueue.length} restantes)`;

      try {
        const response = await fetch(fetchTargetUrl);
        if (response.ok) {
          const htmlText = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlText, 'text/html');

          const extractedInfo = parseArticleDocument(doc, fetchTargetUrl);

          const existingIdx = products.findIndex(p => extractMlvId(p.Link) === mlvId);
          if (existingIdx >= 0) {
            products[existingIdx] = { ...products[existingIdx], ...extractedInfo };
          } else {
            products.push(extractedInfo);
          }
          saveProductsToStorage();
        }
      } catch (err) {
        console.error("Error en Fetch del producto:", fetchTargetUrl, err);
      }

      deepQueue.shift();
      renderResults();

      await new Promise(r => setTimeout(r, delay));
    }

    isDeepCrawling = false;
    modal.classList.remove('crawling-active');
    const statusEl = document.getElementById('ml-status');
    if (statusEl) statusEl.innerText = '✔ ¡Búsqueda Profunda Completada!';
    document.getElementById('ml-notification-banner').style.display = 'block';
    playNotificationSound();
  }

  function buildNextUrl(targetUrl, remainingQueue) {
    try {
      const cleanBase = targetUrl.split('?')[0].split('#')[0];
      const urlObj = new URL(cleanBase);

      const compactIds = remainingQueue.map(item => {
        const rawLink = typeof item === 'string' ? item : item.Link;
        return extractMlvId(rawLink) || rawLink;
      });

      urlObj.searchParams.set('deep_ids', JSON.stringify(compactIds));

      const finalUrl = urlObj.toString();
      const debugEl = document.getElementById('url-debugger');
      if (debugEl) debugEl.innerText = `[URL Construida]:\n${finalUrl}`;

      return finalUrl;
    } catch (err) {
      console.error("Error al construir la URL:", err);
      return targetUrl;
    }
  }

  document.getElementById('btn-deep-extract').onclick = () => {
    if (deepQueue.length === 0) return alert("Selecciona productos con '+ Deep' primero.");

    saveProductsToStorage();

    if (isArticlePage) {
      runAsyncFetchQueue();
    } else {
      const firstItem = deepQueue[0];
      const firstLink = typeof firstItem === 'string' ? firstItem : firstItem.Link;
      const firstId = extractMlvId(firstLink) || firstLink;

      const firstTargetUrl = `https://articulo.mercadolibre.com.ve/${firstId}`;
      const initialUrl = buildNextUrl(firstTargetUrl, deepQueue);

      window.open(initialUrl, '_blank');
    }
  };

  function showSellerInTab3(product) {
    const container = document.getElementById('seller-inspection-container');
    const sellerName = product.Vendedor_Nombre || 'Vendedor MercadoLibre';
    
    const googleQuery = encodeURIComponent(`"${sellerName}" Venezuela (whatsapp OR instagram OR rif OR telefono OR tienda)`);
    const googleLink = product.Google_Breakout_Vendedor || `https://www.google.com/search?q=${googleQuery}`;

    container.innerHTML = `
      <div class="ml-detail-box">
        <div style="font-weight:bold; font-size:12px; color:#2d3277; margin-bottom:4px;">${product.Nombre}</div>
        <div class="ml-detail-row"><span>Vendedor Extraído:</span> <b style="color:#00a650; font-size:12px;">${sellerName}</b></div>
        <div class="ml-detail-row"><span>Ubicación:</span> <b>${product.Ubicacion || 'N/A'}</b></div>
        <div class="ml-detail-row"><span>Categorías:</span> <b>${product.Categorias || 'N/A'}</b></div>
        <div class="ml-detail-row"><span>Marca / Modelo:</span> <b>${product.Marca || 'N/A'} / ${product.Modelo || 'N/A'}</b></div>
        <div style="margin-top:6px; font-size:10px; color:#555;"><b>Especificaciones:</b> ${product.Especificaciones || 'No extraídas'}</div>
        
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
          <a href="${googleLink}" target="_blank" class="ml-btn ml-btn-success" style="font-size:11px; text-decoration:none; text-align:center;">
            🚀 Búsqueda Profunda Vendedor (Google/WA/IG)
          </a>
        </div>
      </div>
    `;

    document.querySelectorAll('.ml-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ml-tab-body').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.ml-tab')[isArticlePage ? 1 : 2].classList.add('active');
    document.getElementById('tab-config').classList.add('active');
  }

  // DESCARGA DE CSV COMPLETO (INCLUYE LINK CLICKEABLE DE GOOGLE PARA CADA VENDEDOR)
  function downloadCSV() {
    if (products.length === 0) return;

    const headers = [
      "Nombre", "Precio_Numerico", "Precio_Detallado", "Score", "Ventas_Estimadas",
      "EnvioGratis", "Vendedor_Nombre", "Vendedor_Estatus", "Ubicacion_Tienda",
      "Categorias", "Marca", "Modelo", "Especificaciones", "Imagen", "Link_Producto", "Google_Breakout_Vendedor"
    ];

    const rows = products.map(p => [
      `"${(p.Nombre || '').replace(/"/g, '""')}"`,
      p.Precio_Numerico || 0,
      `"${(p.Precio_Detallado || '').replace(/"/g, '""')}"`,
      p.Score || 0,
      p.Ventas || 0,
      `"${p.EnvioGratis || 'No'}"`,
      `"${(p.Vendedor_Nombre || 'N/A').replace(/"/g, '""')}"`,
      `"${(p.Vendedor_Estatus || 'N/A').replace(/"/g, '""')}"`,
      `"${(p.Ubicacion || 'N/A').replace(/"/g, '""')}"`,
      `"${(p.Categorias || 'N/A').replace(/"/g, '""')}"`,
      `"${(p.Marca || 'N/A').replace(/"/g, '""')}"`,
      `"${(p.Modelo || 'N/A').replace(/"/g, '""')}"`,
      `"${(p.Especificaciones || 'N/A').replace(/"/g, '""')}"`,
      `"${p.Imagen || ''}"`,
      `"${p.Link || ''}"`,
      `"${p.Google_Breakout_Vendedor || ''}"`
    ].join(','));

    const csvContent = "data:text/csv;charset=utf-8,\uFEFF" + [headers.join(','), ...rows].join('\n');
    const link = document.createElement('a');
    link.href = encodeURI(csvContent);
    link.download = `ML_VE_FullExport_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  document.getElementById('filter-name').addEventListener('input', renderResults);
  document.getElementById('sort-results').addEventListener('change', renderResults);

  const btnStart = document.getElementById('btn-start');
  if (btnStart) btnStart.onclick = () => { addPhrasesToQueue(); };

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
      isCrawling = false;
      products = [];
      queueWork = [];
      deepQueue = [];
      visitedUrls.clear();
      localStorage.removeItem('ml_products_data');

      document.getElementById('ml-status').innerText = 'Estado: Reseteado';
      document.getElementById('ml-count').innerText = 'Productos: 0';
      document.getElementById('ml-progress').style.width = '0%';
      document.getElementById('btn-start').disabled = false;
      document.getElementById('btn-toggle-pause').disabled = true;

      renderQueueUI();
      renderResults();
    };
  }

  document.querySelectorAll('#btn-download').forEach(btn => {
    btn.onclick = downloadCSV;
  });

  if (queueParam && isArticlePage) {
    setTimeout(runAsyncFetchQueue, 1000);
  } else {
    renderResults();
  }
})();
