/* =========================================================================
 * ML Dashboard — Logic (v6.16.0)
 * =========================================================================
 * Full-page management dashboard for the ML Scraper VE extension.
 * Reads from chrome.storage.local (same data as the in-page panel).
 * Implements 20+ "killer features" + rich tooltips + filters + webhook docs.
 * Does NOT modify the existing modal — purely additive.
 * =========================================================================
 */

(function () {
  'use strict';

  /* ======================================================================
   * State
   * ====================================================================== */
  let products = [];
  let publishedProducts = [];
  let config = {};

  // Filters / pagination state for Publications tab
  let pubPage = 0;
  const PUB_PER_PAGE = 50;
  let lastFiltered = [];

  const $ = (id) => document.getElementById(id);

  /* ======================================================================
   * Utility helpers
   * ====================================================================== */
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(n, dec) {
    if (dec === undefined) dec = 2;
    if (typeof n !== 'number' || isNaN(n) || !isFinite(n)) return '—';
    return n.toLocaleString('es-VE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function pct(n, dec) {
    if (dec === undefined) dec = 1;
    if (typeof n !== 'number' || isNaN(n) || !isFinite(n)) return '—';
    return n.toFixed(dec) + '%';
  }

  function sendMessage(request) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(request, (r) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        });
      } catch (e) { resolve(null); }
    });
  }

  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function emptyHtml(ic, msg) {
    return `<div class="empty-state"><div class="empty-ic">${ic || '📭'}</div><p>${escapeHtml(msg || 'Sin datos.')}</p></div>`;
  }

  /* ----- Clickable seller link (rich tooltip) ----- */
  function sellerLink(p, textOverride, maxLength) {
    const name = p.Vendedor_Nombre || 'N/A';
    let text = textOverride || name;
    if (maxLength && text.length > maxLength) text = text.substring(0, maxLength) + '…';
    if (p.Vendedor_Link) {
      return `<a href="${escapeHtml(p.Vendedor_Link)}" target="_blank" rel="noopener" class="seller-link" title="🏪 ${escapeHtml(name)} — Click para abrir la tienda ML">${escapeHtml(text)}</a>`;
    }
    if (name && name !== 'N/A' && name !== 'Pendiente') {
      const q = encodeURIComponent(name + ' vendedor MercadoLibre');
      return `<a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener" class="seller-link" title="Buscar a ${escapeHtml(name)} en Google (no hay Vendedor_Link disponible)">${escapeHtml(text)}</a>`;
    }
    return `<span style="color:var(--text-light);">${escapeHtml(text)}</span>`;
  }

  /* ----- Google breakout / OSINT button ----- */
  function osintButtons(p) {
    const buttons = [];
    const breakout = p.Google_Breakout_Vendedor;
    const name = p.Vendedor_Nombre;
    // v6.16.1: include seller city for much better Google OSINT results
    const city = p.Ubicacion && p.Ubicacion !== 'No especificada' && p.Ubicacion !== 'N/A'
      ? p.Ubicacion.split(',')[0].trim() : '';
    if (breakout) {
      buttons.push(`<a href="${escapeHtml(breakout)}" target="_blank" rel="noopener" class="btn btn-navy btn-sm" title="OSINT: Búsqueda Google sobre el vendedor — encuentra contactos, redes sociales, otras tiendas${city ? ' (ciudad: ' + city + ')' : ''}">🔍 OSINT</a>`);
    } else if (name && name !== 'N/A' && name !== 'Pendiente') {
      const qStr = city
        ? '"' + name + '" Venezuela ' + city + ' (whatsapp OR instagram OR rif OR telefono OR tienda)'
        : '"' + name + '" Venezuela (whatsapp OR instagram OR rif OR telefono OR tienda)';
      const q = encodeURIComponent(qStr);
      buttons.push(`<a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener" class="btn btn-navy btn-sm" title="OSINT: Buscar contactos del vendedor en Google${city ? ' (ciudad: ' + city + ')' : ''}">🔍 OSINT</a>`);
    }
    if (p.Vendedor_Link) {
      buttons.push(`<a href="${escapeHtml(p.Vendedor_Link)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" title="🏪 Tienda ML: ${escapeHtml(name || '')}">🏪 Tienda</a>`);
    }
    if (p.Link) {
      buttons.push(`<a href="${escapeHtml(p.Link)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" title="📦 Ver producto original en ML">📦 Producto</a>`);
    }
    return buttons.join('');
  }

  /* ----- Category full path ----- */
  function categoryPath(p) {
    if (Array.isArray(p.Categorias) && p.Categorias.length > 0) {
      return p.Categorias.filter(x => x && x !== 'N/A').join(' > ');
    }
    const parts = [];
    if (p.Categoria && p.Categoria !== 'N/A') parts.push(p.Categoria);
    if (Array.isArray(p.Subcategorias) && p.Subcategorias.length > 0) {
      parts.push(...p.Subcategorias.filter(x => x && x !== 'N/A'));
    }
    return parts.join(' > ') || (p.Categoria || 'Sin categoría');
  }

  function shortCat(p, max) {
    const path = categoryPath(p);
    if (max && path.length > max) return path.substring(0, max) + '…';
    return path;
  }

  /* ----- Stock estimation ----- */
  function stockEstimate(p) {
    const sold = p.Ventas || p.Opiniones || 0;
    // Heuristic: assume sold represents ~30% of initial stock
    if (sold > 0) return Math.max(0, Math.round(sold / 0.3) - sold);
    return 0;
  }

  /* ----- Stat helpers ----- */
  function priceStats(prices) {
    const arr = prices.filter(p => typeof p === 'number' && !isNaN(p) && p > 0);
    if (arr.length === 0) return { count: 0, min: 0, max: 0, avg: 0, median: 0, std: 0, cv: 0 };
    const sorted = arr.slice().sort((a, b) => a - b);
    const n = arr.length;
    const min = sorted[0];
    const max = sorted[n - 1];
    const avg = arr.reduce((s, x) => s + x, 0) / n;
    const median = n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[Math.floor(n / 2)];
    const variance = arr.reduce((s, x) => s + Math.pow(x - avg, 2), 0) / n;
    const std = Math.sqrt(variance);
    const cv = avg > 0 ? std / avg : 0;
    return { count: n, min, max, avg, median, std, cv };
  }

  function correlation(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return 0;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const a = xs[i] - mx, b = ys[i] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    const denom = Math.sqrt(dx * dy);
    return denom === 0 ? 0 : num / denom;
  }

  function percentile(sortedArr, val) {
    if (sortedArr.length === 0) return 0;
    let lo = 0, hi = sortedArr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedArr[mid] < val) lo = mid + 1; else hi = mid;
    }
    return lo / sortedArr.length;
  }

  function computeHHI(shares) {
    return shares.reduce((s, x) => s + x * x, 0);
  }

  function barFillClass(score) {
    if (score >= 75) return 'green';
    if (score >= 50) return 'yellow';
    if (score >= 30) return 'orange';
    return 'red';
  }

  /* ----- CSV download (Blob + URL.createObjectURL) ----- */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function downloadCSV(filename, rows) {
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }
  function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  /* ======================================================================
   * Data loading
   * ====================================================================== */
  async function loadData() {
    const data = await chrome.storage.local.get([
      'ml_products', 'ml_published_products', 'ml_access_token',
      'ml_gsheets_url', 'ml_sell_markup', 'ml_webhooks'
    ]);
    products = Array.isArray(data.ml_products) ? data.ml_products : [];
    publishedProducts = Array.isArray(data.ml_published_products) ? data.ml_published_products : [];
    config = {
      accessToken: data.ml_access_token || '',
      gsheetsUrl: data.ml_gsheets_url || '',
      sellMarkup: data.ml_sell_markup || '20',
      webhooks: Array.isArray(data.ml_webhooks) ? data.ml_webhooks : []
    };
  }

  function isDeep(p) {
    return !!(p && p.DeepExtracted && p.Vendedor_Nombre && p.Vendedor_Nombre !== 'Pendiente' && p.Vendedor_Nombre !== 'N/A');
  }

  /* ======================================================================
   * Tab switching
   * ====================================================================== */
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      item.classList.add('active');
      const target = item.dataset.tab;
      $('tab-' + target).style.display = 'block';
      renderTab(target);
    });
  });

  /* ======================================================================
   * OVERVIEW TAB
   * ====================================================================== */
  function renderOverview() {
    const totalProducts = products.length;
    const extracted = products.filter(isDeep);
    const totalVisits = products.reduce((s, p) => s + (p.Visitas || 0), 0);
    const totalSales = products.reduce((s, p) => s + (p.Ventas || 0), 0);
    const totalRevenue = products.reduce((s, p) => s + (p.Precio_Numerico || 0) * (p.Ventas || 0), 0);
    const avgScore = extracted.length > 0 ? extracted.reduce((s, p) => s + (p.Score || 0), 0) / extracted.length : 0;
    const avgPrice = products.length > 0 ? products.reduce((s, p) => s + (p.Precio_Numerico || 0), 0) / products.length : 0;
    const uniqueSellers = new Set(extracted.map(p => p.Vendedor_Nombre)).size;
    const totalPublished = publishedProducts.length;

    $('overview-stats').innerHTML = `
      <div class="stat-card navy"><div class="stat-val">${totalProducts}</div><div class="stat-lbl">Productos Crawleados</div></div>
      <div class="stat-card green"><div class="stat-val">${extracted.length}</div><div class="stat-lbl">Deep Extracted</div></div>
      <div class="stat-card yellow"><div class="stat-val">${totalPublished}</div><div class="stat-lbl">Publicados</div></div>
      <div class="stat-card orange"><div class="stat-val">${fmt(totalVisits, 0)}</div><div class="stat-lbl">Visitas Totales</div></div>
      <div class="stat-card green"><div class="stat-val">${fmt(totalSales, 0)}</div><div class="stat-lbl">Ventas Estimadas</div></div>
      <div class="stat-card"><div class="stat-val">$${fmt(totalRevenue, 0)}</div><div class="stat-lbl">Revenue Estimado</div></div>
      <div class="stat-card"><div class="stat-val">${fmt(avgScore, 1)}</div><div class="stat-lbl">Score Promedio</div></div>
      <div class="stat-card navy"><div class="stat-val">$${fmt(avgPrice)}</div><div class="stat-lbl">Precio Promedio</div></div>
      <div class="stat-card green"><div class="stat-val">${uniqueSellers}</div><div class="stat-lbl">Vendedores Únicos</div></div>
    `;

    // Top by sales — rich tooltips
    const topSales = products.slice().sort((a, b) => (b.Ventas || 0) - (a.Ventas || 0)).slice(0, 10);
    const maxSales = topSales.length > 0 ? (topSales[0].Ventas || 1) : 1;
    $('overview-top-sales').innerHTML = topSales.length > 0 ? topSales.map((p, i) => {
      const tip = `${escapeHtml(p.Nombre)}\n💰 $${fmt(p.Precio_Numerico)} (${p.Moneda || 'USD'})\n⭐ Score: ${fmt(p.Score, 1)} (${p.Opiniones || 0} opiniones)\n📈 Ventas: ${fmt(p.Ventas || 0, 0)}\n👁 Visitas: ${fmt(p.Visitas || 0, 0)}\n🏪 ${escapeHtml(p.Vendedor_Nombre || 'N/A')}\n📍 ${escapeHtml(p.Ubicacion || 'N/A')}\n🗂 ${escapeHtml(categoryPath(p))}`;
      return `<div class="list-item" title="${escapeHtml(tip)}">
        <span class="list-rank ${i < 3 ? ['gold', 'silver', 'bronze'][i] : 'normal'}">${i + 1}</span>
        <div class="list-info">
          <div class="list-title">${escapeHtml((p.Nombre || '').substring(0, 50))}</div>
          <div class="list-meta">$${fmt(p.Precio_Numerico)} · ★ ${fmt(p.Score, 1)} · ${sellerLink(p, null, 18)}</div>
        </div>
        <span class="list-val">${fmt(p.Ventas, 0)} vendidos</span>
      </div>`;
    }).join('') : emptyHtml('📭', 'Sin productos. Ejecuta un crawl en MercadoLibre.');

    // Top by visits
    const topVisits = products.filter(p => (p.Visitas || 0) > 0).sort((a, b) => (b.Visitas || 0) - (a.Visitas || 0)).slice(0, 10);
    $('overview-top-visits').innerHTML = topVisits.length > 0 ? topVisits.map((p, i) => {
      const tip = `${escapeHtml(p.Nombre)}\n👁 Visitas: ${fmt(p.Visitas || 0, 0)}\n📈 Ventas: ${fmt(p.Ventas || 0, 0)}\n🏪 ${escapeHtml(p.Vendedor_Nombre || 'N/A')}`;
      return `<div class="list-item" title="${escapeHtml(tip)}">
        <span class="list-rank ${i < 3 ? ['gold', 'silver', 'bronze'][i] : 'normal'}">${i + 1}</span>
        <div class="list-info">
          <div class="list-title">${escapeHtml((p.Nombre || '').substring(0, 50))}</div>
          <div class="list-meta">$${fmt(p.Precio_Numerico)} · ${sellerLink(p, null, 18)}</div>
        </div>
        <span class="list-val">👁 ${fmt(p.Visitas, 0)}</span>
      </div>`;
    }).join('') : emptyHtml('👁', 'Sin datos de visitas. Ejecuta Deep Extraction.');

    // Top sellers (by # products)
    const sellerMap = new Map();
    extracted.forEach(p => {
      const name = p.Vendedor_Nombre;
      if (!name) return;
      if (!sellerMap.has(name)) sellerMap.set(name, { count: 0, link: p.Vendedor_Link, products: [] });
      const s = sellerMap.get(name);
      s.count++; s.products.push(p);
      if (!s.link && p.Vendedor_Link) s.link = p.Vendedor_Link;
    });
    const topSellers = [...sellerMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    const maxSeller = topSellers.length > 0 ? topSellers[0][1].count : 1;
    $('overview-top-sellers').innerHTML = topSellers.length > 0 ? topSellers.map(([name, s]) => {
      const totalSales = s.products.reduce((a, p) => a + (p.Ventas || 0), 0);
      const tip = `${escapeHtml(name)}\n📦 Productos: ${s.count}\n📈 Ventas totales: ${fmt(totalSales, 0)}\n${s.link ? 'Click para abrir tienda ML' : 'Click para buscar en Google'}`;
      return `<div class="bar-row">
        <span class="bar-label" title="${escapeHtml(tip)}">${sellerLink({ Vendedor_Nombre: name, Vendedor_Link: s.link }, null, 18)}</span>
        <div class="bar-track"><div class="bar-fill navy" style="width:${(s.count / maxSeller * 100).toFixed(1)}%" title="${s.count} productos · ${fmt(totalSales, 0)} ventas"></div></div>
        <span class="bar-value">${s.count}</span>
      </div>`;
    }).join('') : emptyHtml('🏪', 'Sin vendedores extraídos.');

    // Cities
    const cityMap = new Map();
    extracted.forEach(p => {
      const city = (p.Ubicacion || '').split(',')[0].trim();
      if (city && city !== 'N/A' && city !== 'No especificada') cityMap.set(city, (cityMap.get(city) || 0) + 1);
    });
    const topCities = [...cityMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const maxCity = topCities.length > 0 ? topCities[0][1] : 1;
    $('overview-cities').innerHTML = topCities.length > 0 ? topCities.map(([name, count]) => {
      const pctVal = (count / extracted.length * 100).toFixed(1);
      return `<div class="bar-row">
        <span class="bar-label" title="${escapeHtml(name)} — ${count} productos (${pctVal}%)">${escapeHtml(name.substring(0, 18))}</span>
        <div class="bar-track"><div class="bar-fill green" style="width:${(count / maxCity * 100).toFixed(1)}%" title="${count} productos · ${pctVal}% del total"></div></div>
        <span class="bar-value">${count} · ${pctVal}%</span>
      </div>`;
    }).join('') : emptyHtml('📍', 'Sin ubicaciones. Ejecuta Deep Extraction.');

    // Price distribution
    const ranges = [
      { label: '$0–10', min: 0, max: 10 },
      { label: '$10–25', min: 10, max: 25 },
      { label: '$25–50', min: 25, max: 50 },
      { label: '$50–100', min: 50, max: 100 },
      { label: '$100–250', min: 100, max: 250 },
      { label: '$250–500', min: 250, max: 500 },
      { label: '$500+', min: 500, max: Infinity }
    ];
    const priceDist = ranges.map(r => ({ ...r, count: products.filter(p => (p.Precio_Numerico || 0) >= r.min && (p.Precio_Numerico || 0) < r.max).length }));
    const maxPrice = Math.max(...priceDist.map(r => r.count), 1);
    $('overview-price-dist').innerHTML = priceDist.map(r => {
      const pctVal = products.length > 0 ? (r.count / products.length * 100).toFixed(1) : '0';
      return `<div class="bar-row">
        <span class="bar-label" title="Rango ${r.label}">${r.label}</span>
        <div class="bar-track"><div class="bar-fill ${r.count / maxPrice > 0.6 ? 'green' : 'orange'}" style="width:${(r.count / maxPrice * 100).toFixed(1)}%" title="${r.count} productos (${pctVal}%)"></div></div>
        <span class="bar-value">${r.count} · ${pctVal}%</span>
      </div>`;
    }).join('');
  }

  /* ======================================================================
   * PUBLICATIONS TAB (filters + published manager + export filtered)
   * ====================================================================== */
  function populateFilters() {
    // Sellers
    const sellers = new Set();
    const cities = new Set();
    const cats = new Set();
    products.filter(isDeep).forEach(p => {
      if (p.Vendedor_Nombre && p.Vendedor_Nombre !== 'N/A') sellers.add(p.Vendedor_Nombre);
      const city = (p.Ubicacion || '').split(',')[0].trim();
      if (city && city !== 'N/A') cities.add(city);
      const cat = categoryPath(p);
      if (cat) cats.add(cat);
    });
    const sellerSel = $('pub-filter-seller');
    const citySel = $('pub-filter-city');
    const catSel = $('pub-filter-cat');
    const preserveSeller = sellerSel.value;
    const preserveCity = citySel.value;
    const preserveCat = catSel.value;
    sellerSel.innerHTML = '<option value="">Todos los vendedores</option>' + [...sellers].sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    citySel.innerHTML = '<option value="">Todas las ciudades</option>' + [...cities].sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    catSel.innerHTML = '<option value="">Todas las categorías</option>' + [...cats].sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    sellerSel.value = preserveSeller;
    citySel.value = preserveCity;
    catSel.value = preserveCat;
  }

  function applyPubFilters() {
    const text = ($('pub-filter')?.value || '').toLowerCase().trim();
    const seller = $('pub-filter-seller')?.value || '';
    const city = $('pub-filter-city')?.value || '';
    const cat = $('pub-filter-cat')?.value || '';
    const sortVal = $('pub-sort')?.value || 'sales_desc';

    let filtered = products.filter(p => {
      if (text && (p.Nombre || '').toLowerCase().indexOf(text) === -1) return false;
      if (seller && p.Vendedor_Nombre !== seller) return false;
      if (city) {
        const c = (p.Ubicacion || '').split(',')[0].trim();
        if (c !== city) return false;
      }
      if (cat && categoryPath(p) !== cat) return false;
      return true;
    });

    if (sortVal === 'sales_desc') filtered.sort((a, b) => (b.Ventas || 0) - (a.Ventas || 0));
    else if (sortVal === 'visits_desc') filtered.sort((a, b) => (b.Visitas || 0) - (a.Visitas || 0));
    else if (sortVal === 'price_desc') filtered.sort((a, b) => (b.Precio_Numerico || 0) - (a.Precio_Numerico || 0));
    else if (sortVal === 'price_asc') filtered.sort((a, b) => (a.Precio_Numerico || 0) - (b.Precio_Numerico || 0));
    else if (sortVal === 'score_desc') filtered.sort((a, b) => (b.Score || 0) - (a.Score || 0));
    else if (sortVal === 'opinions_desc') filtered.sort((a, b) => (b.Opiniones || 0) - (a.Opiniones || 0));
    else if (sortVal === 'seller_products_desc') {
      // Sort by seller's total product count desc, then by product's sales
      const sc = new Map();
      products.forEach(p => { if (p.Vendedor_Nombre) sc.set(p.Vendedor_Nombre, (sc.get(p.Vendedor_Nombre) || 0) + 1); });
      filtered.sort((a, b) => (sc.get(b.Vendedor_Nombre) || 0) - (sc.get(a.Vendedor_Nombre) || 0) || (b.Ventas || 0) - (a.Ventas || 0));
    }
    return filtered;
  }

  function renderPublications() {
    $('pub-count-badge').textContent = publishedProducts.length;
    $('all-count-badge').textContent = products.length;

    // Published products manager
    if (publishedProducts.length === 0) {
      $('publications-list').innerHTML = emptyHtml('📭', 'No has publicado productos todavía. Usa el botón 💰 Vender en cualquier producto.');
    } else {
      $('publications-list').innerHTML = publishedProducts.map((p, i) => {
        const tip = `Título: ${p.title || ''}\nPrecio: $${fmt(p.price || 0)}\nPublicado: ${new Date(p.publishedAt || Date.now()).toLocaleString('es-VE')}`;
        return `<div class="list-item" title="${escapeHtml(tip)}">
          <div class="list-info">
            <div class="list-title">${escapeHtml(p.title || '')}</div>
            <div class="list-meta">Original: <code>${escapeHtml(p.originalId || 'N/A')}</code> → Nuevo: <code>${escapeHtml(p.newId || 'N/A')}</code> · $${fmt(p.price || 0)} · ${new Date(p.publishedAt || Date.now()).toLocaleDateString('es-VE')}</div>
          </div>
          ${p.permalink ? `<a href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" title="Abrir publicación">🔗 Ver</a>` : ''}
          <button class="btn btn-danger btn-sm" data-del-pub="${i}" title="Eliminar de la lista">🗑</button>
        </div>`;
      }).join('');
      document.querySelectorAll('[data-del-pub]').forEach(btn => {
        btn.onclick = async () => {
          const idx = parseInt(btn.dataset.delPub);
          publishedProducts.splice(idx, 1);
          await chrome.storage.local.set({ ml_published_products: publishedProducts });
          renderPublications();
          showToast('✅ Publicación eliminada');
        };
      });
    }

    // All products with filters
    const filtered = applyPubFilters();
    lastFiltered = filtered;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PUB_PER_PAGE));
    if (pubPage >= totalPages) pubPage = totalPages - 1;
    if (pubPage < 0) pubPage = 0;
    const visible = filtered.slice(pubPage * PUB_PER_PAGE, (pubPage + 1) * PUB_PER_PAGE);

    $('all-products-list').innerHTML = `
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px 0;">Mostrando ${visible.length} de ${filtered.length} productos${filtered.length !== products.length ? ` (filtrados de ${products.length})` : ''}</p>
      ${visible.length > 0 ? `<table class="data-table"><thead><tr>
        <th>Producto</th><th>Precio</th><th>Score</th><th>Ventas</th><th>Visitas</th><th>Vendedor</th><th>Ciudad</th><th>Stock est.</th><th>Categoría</th><th>Acciones</th>
      </tr></thead><tbody>
      ${visible.map(p => {
        const stock = stockEstimate(p);
        const tip = `${escapeHtml(p.Nombre || '')}\n💰 $${fmt(p.Precio_Numerico)} ${escapeHtml(p.Moneda || 'USD')}\n⭐ ${fmt(p.Score, 1)} (${p.Opiniones || 0} opiniones)\n📈 +${fmt(p.Ventas || 0, 0)} vendidos\n👁 ${fmt(p.Visitas || 0, 0)} visitas\n📦 Stock est: ${stock}\n🏪 ${escapeHtml(p.Vendedor_Nombre || 'N/A')}\n📍 ${escapeHtml(p.Ubicacion || 'N/A')}\n🗂 ${escapeHtml(categoryPath(p))}`;
        return `<tr title="${escapeHtml(tip)}">
          <td><div style="font-weight:600;">${escapeHtml((p.Nombre || '').substring(0, 50))}${isDeep(p) ? ' ✅' : ''}</div>
            ${p.Marca ? `<div style="font-size:10px;color:var(--text-muted);">${escapeHtml(p.Marca)} ${p.Modelo ? '· ' + escapeHtml(p.Modelo) : ''}</div>` : ''}</td>
          <td><b>$${fmt(p.Precio_Numerico)}</b><br><span style="font-size:10px;color:var(--text-muted);">${escapeHtml(p.Moneda || 'USD')}</span></td>
          <td>★ ${fmt(p.Score, 1)}</td>
          <td style="color:var(--ml-green);font-weight:700;">${fmt(p.Ventas || 0, 0)}</td>
          <td>${p.Visitas > 0 ? fmt(p.Visitas, 0) : '—'}</td>
          <td>${sellerLink(p, null, 16)}</td>
          <td>${escapeHtml((p.Ubicacion || 'N/A').split(',')[0].substring(0, 16))}</td>
          <td>${stock > 0 ? stock : '—'}</td>
          <td style="font-size:10px;">${escapeHtml(shortCat(p, 22))}</td>
          <td><div style="display:flex;gap:3px;flex-wrap:wrap;">${osintButtons(p)}</div></td>
        </tr>`;
      }).join('')}
      </tbody></table>` : emptyHtml('🔍', 'No hay productos que coincidan con los filtros.')}
    `;

    // Pagination
    $('all-products-pagination').innerHTML = totalPages > 1 ? `
      <button data-page="prev" ${pubPage === 0 ? 'disabled' : ''}>‹ Anterior</button>
      ${Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
        const start = Math.max(0, Math.min(pubPage - 3, totalPages - 7));
        const p = start + i;
        if (p >= totalPages) return '';
        return `<button data-page="${p}" class="${p === pubPage ? 'active' : ''}">${p + 1}</button>`;
      }).join('')}
      <button data-page="next" ${pubPage === totalPages - 1 ? 'disabled' : ''}>Siguiente ›</button>
    ` : '';
    document.querySelectorAll('#all-products-pagination button[data-page]').forEach(b => {
      b.onclick = () => {
        const v = b.dataset.page;
        if (v === 'prev') pubPage = Math.max(0, pubPage - 1);
        else if (v === 'next') pubPage = Math.min(totalPages - 1, pubPage + 1);
        else pubPage = parseInt(v);
        renderPublications();
      };
    });
  }

  /* ======================================================================
   * SELLERS TAB (competitor analysis, reputation, OSINT, concentration)
   * ====================================================================== */
  function computeSellerStats() {
    const extracted = products.filter(isDeep);
    const map = new Map();
    extracted.forEach(p => {
      const name = p.Vendedor_Nombre;
      if (!name) return;
      if (!map.has(name)) map.set(name, {
        name, products: 0, sales: 0, visits: 0, score: 0, opinions: 0,
        link: p.Vendedor_Link, estatus: p.Vendedor_Estatus,
        seguidores: p.Vendedor_Seguidores, sellerProducts: p.Vendedor_Productos,
        sellerSales: p.Vendedor_Ventas, recomendacion: p.Vendedor_Recomendacion,
        anios: p.Vendedor_AniosML, ubicaciones: new Set(), prices: []
      });
      const s = map.get(name);
      s.products++; s.sales += (p.Ventas || 0); s.visits += (p.Visitas || 0);
      s.score += (p.Score || 0); s.opinions += (p.Opiniones || 0);
      if (!s.link && p.Vendedor_Link) s.link = p.Vendedor_Link;
      if (!s.estatus && p.Vendedor_Estatus) s.estatus = p.Vendedor_Estatus;
      if (!s.seguidores && p.Vendedor_Seguidores) s.seguidores = p.Vendedor_Seguidores;
      if (!s.sellerProducts && p.Vendedor_Productos) s.sellerProducts = p.Vendedor_Productos;
      if (!s.sellerSales && p.Vendedor_Ventas) s.sellerSales = p.Vendedor_Ventas;
      if (!s.recomendacion && p.Vendedor_Recomendacion) s.recomendacion = p.Vendedor_Recomendacion;
      if (!s.anios && p.Vendedor_AniosML) s.anios = p.Vendedor_AniosML;
      const city = (p.Ubicacion || '').split(',')[0].trim();
      if (city && city !== 'N/A') s.ubicaciones.add(city);
      if (p.Precio_Numerico > 0) s.prices.push(p.Precio_Numerico);
    });
    return map;
  }

  function renderSellers() {
    const extracted = products.filter(isDeep);
    const sellerMap = computeSellerStats();
    const sellers = [...sellerMap.values()];
    const totalProducts = sellers.reduce((s, x) => s + x.products, 0) || 1;
    const totalSales = sellers.reduce((s, x) => s + x.sales, 0) || 1;

    // Concentration warning (HHI)
    const sellerShares = sellers.map(s => s.products / totalProducts);
    const hhi = computeHHI(sellerShares);
    const top3Share = sellerShares.slice().sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0);
    let warnClass = 'ok', warnIc = '✅', warnTitle = 'Mercado Fragmentado', warnBody = '';
    if (hhi > 0.25) {
      warnClass = ''; warnIc = '⚠️'; warnTitle = 'Alta Concentración de Mercado';
      warnBody = `HHI = ${fmt(hhi, 4)} (>0.25). Los top 3 vendedores controlan el ${pct(top3Share * 100, 1)} del mercado. Difícil entrar sin diferenciación fuerte.`;
    } else if (hhi > 0.15) {
      warnClass = 'warn'; warnIc = '⚡'; warnTitle = 'Concentración Media';
      warnBody = `HHI = ${fmt(hhi, 4)}. Top 3 = ${pct(top3Share * 100, 1)}. Hay competidores dominantes pero hay espacio.`;
    } else {
      warnBody = `HHI = ${fmt(hhi, 4)} (<0.15). Mercado fragmentado con ${sellers.length} vendedores. Bajas barreras de entrada.`;
    }
    $('seller-concentration-warning').innerHTML = `
      <div class="warning-banner ${warnClass}">
        <div class="warning-ic">${warnIc}</div>
        <div>
          <div class="warning-title">${warnTitle}</div>
          <div class="warning-body">${warnBody}</div>
        </div>
      </div>`;

    // Stats
    $('sellers-stats').innerHTML = `
      <div class="stat-card navy"><div class="stat-val">${sellers.length}</div><div class="stat-lbl">Vendedores Únicos</div></div>
      <div class="stat-card green"><div class="stat-val">${fmt(totalSales, 0)}</div><div class="stat-lbl">Ventas Totales</div></div>
      <div class="stat-card yellow"><div class="stat-val">${fmt(totalProducts, 0)}</div><div class="stat-lbl">Productos Totales</div></div>
      <div class="stat-card orange"><div class="stat-val">${fmt(hhi, 4)}</div><div class="stat-lbl">HHI Concentración</div></div>
      <div class="stat-card"><div class="stat-val">${fmt(sellers.length > 0 ? totalProducts / sellers.length : 0, 1)}</div><div class="stat-lbl">Prod/Vendedor</div></div>
    `;

    // Competitor analysis table
    sellers.sort((a, b) => b.sales - a.sales);
    $('sellers-table').innerHTML = sellers.length > 0 ? `
      <table class="data-table"><thead><tr>
        <th>Vendedor</th><th>Productos</th><th>Ventas</th><th>Visitas</th><th>Ticket $</th><th>Market Share</th><th>Score</th><th>Estatus</th><th>Seguidores</th><th>Años ML</th><th>Acciones</th>
      </tr></thead><tbody>
      ${sellers.slice(0, 100).map(s => {
        const share = (s.products / totalProducts) * 100;
        const avgPrice = s.prices.length > 0 ? s.prices.reduce((a, b) => a + b, 0) / s.prices.length : 0;
        const avgScore = s.products > 0 ? s.score / s.products : 0;
        const tip = `${escapeHtml(s.name)}\n📦 ${s.products} productos\n📈 ${fmt(s.sales, 0)} ventas\n👁 ${fmt(s.visits, 0)} visitas\n💰 Ticket prom: $${fmt(avgPrice)}\n📊 Market share: ${pct(share, 1)}\n⭐ Score: ${fmt(avgScore, 2)}\n👤 Estatus: ${escapeHtml(s.estatus || 'N/A')}\n👥 Seguidores: ${fmt(s.seguidores || 0, 0)}\n📅 Años ML: ${escapeHtml(s.anios || 'N/A')}\n📍 ${escapeHtml([...s.ubicaciones].join(', ') || 'N/A')}`;
        return `<tr title="${escapeHtml(tip)}">
          <td>${sellerLink({ Vendedor_Nombre: s.name, Vendedor_Link: s.link }, null, 22)}</td>
          <td>${s.products}</td>
          <td style="color:var(--ml-green);font-weight:700;">${fmt(s.sales, 0)}</td>
          <td>${fmt(s.visits, 0)}</td>
          <td>$${fmt(avgPrice)}</td>
          <td><div class="bar-track" style="height:14px;"><div class="bar-fill ${barFillClass(share * 3)}" style="width:${Math.min(100, share * 2).toFixed(1)}%"></div></div><b>${pct(share, 1)}</b></td>
          <td>★ ${fmt(avgScore, 1)}</td>
          <td>${escapeHtml(s.estatus || '—')}</td>
          <td>${fmt(s.seguidores || 0, 0)}</td>
          <td>${escapeHtml(s.anios || '—')}</td>
          <td>${osintButtons({ Vendedor_Nombre: s.name, Vendedor_Link: s.link, Google_Breakout_Vendedor: null })}</td>
        </tr>`;
      }).join('')}
      </tbody></table>` : emptyHtml('🏪', 'Sin vendedores extraídos. Ejecuta Deep Extraction.');

    // Reputation comparison (top 5)
    const top5 = sellers.slice(0, 5);
    let compareHtml = '';
    if (top5.length > 0) {
      compareHtml = `<div class="compare-grid">`;
      compareHtml += `<div class="compare-cell header">Métrica</div>`;
      top5.forEach(s => { compareHtml += `<div class="compare-cell header" title="${escapeHtml(s.name)}">${sellerLink({ Vendedor_Nombre: s.name, Vendedor_Link: s.link }, null, 18)}</div>`; });
      const rows = [
        ['Productos', s => s.products],
        ['Ventas totales', s => fmt(s.sales, 0)],
        ['Visitas totales', s => fmt(s.visits, 0)],
        ['Score promedio', s => fmt(s.products > 0 ? s.score / s.products : 0, 2)],
        ['Opiniones totales', s => fmt(s.opinions, 0)],
        ['Ticket promedio', s => '$' + fmt(s.prices.length > 0 ? s.prices.reduce((a, b) => a + b, 0) / s.prices.length : 0)],
        ['Estatus', s => escapeHtml(s.estatus || '—')],
        ['Seguidores', s => fmt(s.seguidores || 0, 0)],
        ['Recomendación', s => escapeHtml(s.recomendacion || '—')],
        ['Años en ML', s => escapeHtml(s.anios || '—')],
        ['Productos totales (vendedor)', s => fmt(s.sellerProducts || 0, 0)],
        ['Ubicaciones', s => escapeHtml([...s.ubicaciones].join(', ') || '—')]
      ];
      rows.forEach(([label, fn]) => {
        compareHtml += `<div class="compare-cell metric">${label}</div>`;
        top5.forEach(s => { compareHtml += `<div class="compare-cell">${fn(s)}</div>`; });
      });
      compareHtml += `</div>`;
    } else {
      compareHtml = emptyHtml('⚖️', 'Sin vendedores para comparar.');
    }
    $('sellers-compare').innerHTML = compareHtml;

    // OSINT list — all sellers with their OSINT buttons
    $('sellers-osint').innerHTML = sellers.length > 0 ? sellers.slice(0, 30).map(s => {
      return `<div class="osint-card">
        <div class="osint-name">${sellerLink({ Vendedor_Nombre: s.name, Vendedor_Link: s.link }, null, 30)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${s.products} productos · ${fmt(s.sales, 0)} ventas · ${escapeHtml(s.estatus || 'N/A')}</div>
        <div class="osint-actions">${osintButtons({ Vendedor_Nombre: s.name, Vendedor_Link: s.link, Google_Breakout_Vendedor: null })}</div>
      </div>`;
    }).join('') : emptyHtml('🔍', 'Sin vendedores para OSINT.');
  }

  /* ======================================================================
   * CATEGORIES TAB (niche, saturation, opportunity, heatmap, deep dive)
   * ====================================================================== */
  function computeCategoryStats() {
    const map = new Map();
    products.forEach(p => {
      const cat = categoryPath(p);
      if (!map.has(cat)) map.set(cat, {
        cat, products: 0, sales: 0, visits: 0, score: 0, opinions: 0,
        sellers: new Set(), prices: []
      });
      const s = map.get(cat);
      s.products++; s.sales += (p.Ventas || 0); s.visits += (p.Visitas || 0);
      s.score += (p.Score || 0); s.opinions += (p.Opiniones || 0);
      if (p.Vendedor_Nombre && p.Vendedor_Nombre !== 'N/A') s.sellers.add(p.Vendedor_Nombre);
      if (p.Precio_Numerico > 0) s.prices.push(p.Precio_Numerico);
    });
    return map;
  }

  function renderCategories() {
    const catMap = computeCategoryStats();
    const cats = [...catMap.values()];
    const totalProducts = cats.reduce((s, c) => s + c.products, 0) || 1;
    const totalSales = cats.reduce((s, c) => s + c.sales, 0) || 1;

    $('categories-stats').innerHTML = `
      <div class="stat-card navy"><div class="stat-val">${cats.length}</div><div class="stat-lbl">Categorías</div></div>
      <div class="stat-card green"><div class="stat-val">${fmt(totalSales, 0)}</div><div class="stat-lbl">Ventas Totales</div></div>
      <div class="stat-card yellow"><div class="stat-val">${fmt(totalProducts, 0)}</div><div class="stat-lbl">Productos</div></div>
      <div class="stat-card"><div class="stat-val">${fmt(new Set(cats.flatMap(c => [...c.sellers])).size || (cats.reduce((s, c) => s + c.sellers.size, 0)), 0)}</div><div class="stat-lbl">Vendedores (suma)</div></div>
    `;

    // Niche Discovery (blue oceans)
    const blueOceans = cats.filter(c => c.products >= 3 && c.sellers.size <= 3 && c.sales > 0)
      .sort((a, b) => b.sales - a.sales);
    const maxBO = blueOceans.length > 0 ? blueOceans[0].sales : 1;
    $('cat-blue-oceans').innerHTML = blueOceans.length > 0 ? blueOceans.slice(0, 15).map(c => {
      const tip = `${escapeHtml(c.cat)}\n🌊 BLUE OCEAN\n📦 ${c.products} productos\n🏪 ${c.sellers.size} vendedores\n📈 ${fmt(c.sales, 0)} ventas\n👁 ${fmt(c.visits, 0)} visitas`;
      return `<div class="bar-row">
        <span class="bar-label" title="${escapeHtml(tip)}" style="cursor:pointer;" data-cat-dive="${escapeHtml(c.cat)}">${escapeHtml(c.cat.substring(0, 20))} 🌊</span>
        <div class="bar-track"><div class="bar-fill green" style="width:${(c.sales / maxBO * 100).toFixed(1)}%" title="${fmt(c.sales, 0)} ventas"></div></div>
        <span class="bar-value">${c.products}p · ${c.sellers.size}v</span>
      </div>`;
    }).join('') : emptyHtml('🌊', 'No se detectaron océanos azul. Prueba con más productos.');

    // Market Saturation (products/seller per category)
    const saturation = cats.filter(c => c.products >= 2).map(c => ({ ...c, ratio: c.products / Math.max(1, c.sellers.size) }))
      .sort((a, b) => a.ratio - b.ratio);
    const maxSat = saturation.length > 0 ? saturation[saturation.length - 1].ratio : 1;
    $('cat-saturation').innerHTML = saturation.length > 0 ? saturation.slice(0, 15).map(c => {
      const tip = `${escapeHtml(c.cat)}\n📦 ${c.products} productos\n🏪 ${c.sellers.size} vendedores\n🧮 Saturación: ${fmt(c.ratio, 1)} prod/vendedor\n${c.ratio < 3 ? '🟢 Baja saturación' : c.ratio < 10 ? '🟡 Saturación media' : '🔴 Alta saturación'}`;
      const cls = c.ratio < 3 ? 'green' : c.ratio < 10 ? 'yellow' : 'red';
      return `<div class="bar-row">
        <span class="bar-label" title="${escapeHtml(tip)}" style="cursor:pointer;" data-cat-dive="${escapeHtml(c.cat)}">${escapeHtml(c.cat.substring(0, 20))}</span>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${(c.ratio / maxSat * 100).toFixed(1)}%" title="${fmt(c.ratio, 1)} prod/vendedor"></div></div>
        <span class="bar-value">${fmt(c.ratio, 1)} p/v</span>
      </div>`;
    }).join('') : emptyHtml('🧮', 'Sin categorías suficientes.');

    // Category Opportunity Score
    const opp = cats.map(c => {
      const demandPct = c.sales / totalSales; // 0-1
      const openness = 1 - Math.min(1, c.sellers.size / 20); // fewer sellers = more open
      const quality = c.products > 0 ? c.score / c.products / 5 : 0; // 0-1
      const ps = priceStats(c.prices);
      const priceReasonable = ps.cv < 0.5 ? 1 : Math.max(0, 1 - ps.cv); // low CV = stable prices
      const hotness = c.visits > 0 ? c.sales / c.visits : 0; // conversion rate
      const score = (
        demandPct * 0.40 +
        openness * 0.25 +
        quality * 0.15 +
        priceReasonable * 0.10 +
        Math.min(1, hotness * 10) * 0.10
      ) * 100;
      return { ...c, score, demandPct, openness, quality, priceReasonable, hotness, ps };
    }).sort((a, b) => b.score - a.score);

    $('cat-opportunity').innerHTML = opp.length > 0 ? `
      <table class="data-table"><thead><tr>
        <th>Categoría</th><th>Score</th><th>Demanda</th><th>Apertura</th><th>Calidad</th><th>Precio est.</th><th>Conversión</th><th>Productos</th><th>Vendedores</th><th>Ventas</th>
      </tr></thead><tbody>
      ${opp.slice(0, 20).map(c => {
        const tip = `${escapeHtml(c.cat)}\n💎 Opportunity Score: ${fmt(c.score, 1)}/100\nDemanda: ${pct(c.demandPct * 100, 1)} de ventas totales\nApertura: ${pct(c.openness * 100, 0)} (pocos vendedores)\nCalidad: ${fmt(c.quality * 5, 2)}/5 avg\nConversión: ${pct(c.hotness * 100, 2)}\nPrecios: min $${fmt(c.ps.min)}, max $${fmt(c.ps.max)}, avg $${fmt(c.ps.avg)}, mediana $${fmt(c.ps.median)}`;
        return `<tr title="${escapeHtml(tip)}" style="cursor:pointer;" data-cat-dive="${escapeHtml(c.cat)}">
          <td><b>${escapeHtml(c.cat.substring(0, 40))}</b></td>
          <td><span class="badge" style="background:${c.score >= 60 ? 'var(--ml-green)' : c.score >= 40 ? 'var(--ml-yellow)' : 'var(--ml-orange)'};color:${c.score >= 60 ? '#fff' : 'var(--ml-navy-dark)'};">${fmt(c.score, 1)}</span></td>
          <td>${pct(c.demandPct * 100, 1)}</td>
          <td>${pct(c.openness * 100, 0)}</td>
          <td>${fmt(c.quality * 5, 2)}</td>
          <td>$${fmt(c.ps.median)}</td>
          <td>${pct(c.hotness * 100, 2)}</td>
          <td>${c.products}</td>
          <td>${c.sellers.size}</td>
          <td>${fmt(c.sales, 0)}</td>
        </tr>`;
      }).join('')}
      </tbody></table>` : emptyHtml('💎', 'Sin datos de categorías.');

    // Demand Heatmap
    const heat = cats.filter(c => c.visits > 0).map(c => ({
      ...c, conv: c.sales / c.visits
    })).sort((a, b) => b.conv - a.conv);
    $('cat-heatmap').innerHTML = heat.length > 0 ? heat.slice(0, 30).map(c => {
      const color = c.conv > 0.05 ? 'var(--ml-green)' : c.conv > 0.02 ? 'var(--ml-orange)' : 'var(--ml-red)';
      const tip = `${escapeHtml(c.cat)}\n👁 ${fmt(c.visits, 0)} visitas\n📈 ${fmt(c.sales, 0)} ventas\n🎯 Conversión: ${pct(c.conv * 100, 2)}`;
      return `<span class="heat-cell" style="background:${color};" title="${escapeHtml(tip)}">${escapeHtml(c.cat.substring(0, 18))}<br><b>${pct(c.conv * 100, 1)}</b></span>`;
    }).join('') : emptyHtml('🔥', 'Sin datos de visitas para el heatmap.');

    // Category Deep Dive dropdown
    const deepSel = $('cat-deep-select');
    const prev = deepSel.value;
    deepSel.innerHTML = '<option value="">Selecciona categoría…</option>' + cats.sort((a, b) => a.cat.localeCompare(b.cat)).map(c => `<option value="${escapeHtml(c.cat)}">${escapeHtml(c.cat)}</option>`).join('');
    deepSel.value = prev;
  }

  function renderCategoryDeepDive(catName) {
    const cont = $('cat-deep-content');
    if (!catName) { cont.innerHTML = emptyHtml('👆', 'Selecciona una categoría para ver el drill-down.'); return; }
    const catProducts = products.filter(p => categoryPath(p) === catName);
    if (catProducts.length === 0) { cont.innerHTML = emptyHtml('📭', 'No hay productos en esta categoría.'); return; }
    const ps = priceStats(catProducts.map(p => p.Precio_Numerico || 0));
    const totalSales = catProducts.reduce((s, p) => s + (p.Ventas || 0), 0);
    const totalVisits = catProducts.reduce((s, p) => s + (p.Visitas || 0), 0);
    const sellers = new Set(catProducts.map(p => p.Vendedor_Nombre).filter(n => n && n !== 'N/A'));
    const avgScore = catProducts.length > 0 ? catProducts.reduce((s, p) => s + (p.Score || 0), 0) / catProducts.length : 0;
    const conv = totalVisits > 0 ? totalSales / totalVisits * 100 : 0;
    cont.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card navy"><div class="stat-val">${catProducts.length}</div><div class="stat-lbl">Productos</div></div>
        <div class="stat-card green"><div class="stat-val">${sellers.size}</div><div class="stat-lbl">Vendedores</div></div>
        <div class="stat-card yellow"><div class="stat-val">${fmt(totalSales, 0)}</div><div class="stat-lbl">Ventas</div></div>
        <div class="stat-card orange"><div class="stat-val">${fmt(totalVisits, 0)}</div><div class="stat-lbl">Visitas</div></div>
        <div class="stat-card"><div class="stat-val">${pct(conv, 2)}</div><div class="stat-lbl">Conversión</div></div>
        <div class="stat-card"><div class="stat-val">${fmt(avgScore, 2)}</div><div class="stat-lbl">Score Promedio</div></div>
      </div>
      <div class="card-row">
        <div class="card half">
          <div class="card-head"><h3>📊 Estadísticas de Precio</h3></div>
          <table class="data-table">
            <tr><td>Mínimo</td><td><b>$${fmt(ps.min)}</b></td></tr>
            <tr><td>Máximo</td><td><b>$${fmt(ps.max)}</b></td></tr>
            <tr><td>Promedio</td><td><b>$${fmt(ps.avg)}</b></td></tr>
            <tr><td>Mediana</td><td><b>$${fmt(ps.median)}</b></td></tr>
            <tr><td>Desv. Estándar</td><td><b>$${fmt(ps.std)}</b></td></tr>
            <tr><td>Coef. Variación</td><td><b>${pct(ps.cv * 100, 1)}</b></td></tr>
          </table>
        </div>
        <div class="card half">
          <div class="card-head"><h3>🏆 Top 10 Productos</h3></div>
          ${catProducts.sort((a, b) => (b.Ventas || 0) - (a.Ventas || 0)).slice(0, 10).map((p, i) => `
            <div class="list-item" title="${escapeHtml(p.Nombre + '\n$' + fmt(p.Precio_Numerico) + ' · ' + (p.Ventas || 0) + ' ventas')}">
              <span class="list-rank ${i < 3 ? ['gold', 'silver', 'bronze'][i] : 'normal'}">${i + 1}</span>
              <div class="list-info">
                <div class="list-title">${escapeHtml((p.Nombre || '').substring(0, 40))}</div>
                <div class="list-meta">$${fmt(p.Precio_Numerico)} · ${sellerLink(p, null, 16)} · ${fmt(p.Ventas || 0, 0)} ventas</div>
              </div>
            </div>`).join('')}
        </div>
      </div>
    `;
  }

  /* ======================================================================
   * OPPORTUNITIES TAB (A1 list + latent demand)
   * ====================================================================== */
  function computeA1Scores() {
    if (products.length === 0) return [];
    const allSales = products.map(p => p.Ventas || 0).slice().sort((a, b) => a - b);
    const catSales = new Map();
    let totalCatSales = 0;
    products.forEach(p => {
      const cat = categoryPath(p);
      const v = (p.Ventas || 0);
      catSales.set(cat, (catSales.get(cat) || 0) + v);
      totalCatSales += v;
    });
    const sellerProdCount = new Map();
    products.forEach(p => {
      const n = p.Vendedor_Nombre;
      if (n && n !== 'N/A') sellerProdCount.set(n, (sellerProdCount.get(n) || 0) + 1);
    });
    const catPrices = new Map();
    products.forEach(p => {
      const cat = categoryPath(p);
      if (!catPrices.has(cat)) catPrices.set(cat, []);
      catPrices.get(cat).push(p.Precio_Numerico || 0);
    });
    const catMedian = new Map();
    catPrices.forEach((prices, cat) => {
      const s = prices.slice().sort((a, b) => a - b);
      const m = s.length % 2 === 0 ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : s[Math.floor(s.length / 2)];
      catMedian.set(cat, m);
    });

    return products.map(p => {
      const demand = percentile(allSales, p.Ventas || 0);
      const quality = (p.Score || 0) / 5;
      const sellerProd = sellerProdCount.get(p.Vendedor_Nombre) || 1;
      const openness = Math.max(0, 1 - sellerProd / 20);
      const cat = categoryPath(p);
      const catMed = catMedian.get(cat) || (p.Precio_Numerico || 0);
      const priceDelta = catMed > 0 ? Math.abs((p.Precio_Numerico || 0) - catMed) / catMed : 1;
      const priceReasonable = Math.max(0, 1 - Math.min(1, priceDelta));
      const catHot = totalCatSales > 0 ? (catSales.get(cat) || 0) / totalCatSales : 0;
      const score = (
        demand * 0.35 +
        quality * 0.15 +
        openness * 0.25 +
        priceReasonable * 0.15 +
        Math.min(1, catHot * 5) * 0.10
      ) * 100;
      const tags = [];
      if (demand > 0.7) tags.push('🔥 Alta demanda');
      if (openness > 0.7) tags.push('🌊 Vendedor no dominante');
      if (quality > 0.85) tags.push('⭐ Alta calidad');
      if (priceReasonable > 0.7) tags.push('💰 Precio razonable');
      if (catHot > 0.1) tags.push('🔥 Categoría hot');
      return { product: p, score, components: { demand, quality, openness, priceReasonable, catHot }, tags };
    }).sort((a, b) => b.score - a.score);
  }

  function renderOpportunities() {
    const a1 = computeA1Scores();
    $('a1-list').innerHTML = a1.length > 0 ? `
      <table class="data-table"><thead><tr>
        <th>#</th><th>Producto</th><th>Score</th><th>Demanda</th><th>Apertura</th><th>Calidad</th><th>Precio</th><th>Cat. Hot</th><th>Tags</th><th>Ventas</th><th>Acciones</th>
      </tr></thead><tbody>
      ${a1.slice(0, 20).map((r, i) => {
        const p = r.product;
        const tip = `${escapeHtml(p.Nombre || '')}\n🏆 A1 Score: ${fmt(r.score, 1)}/100\nDemanda: ${pct(r.components.demand * 100, 0)}\nApertura: ${pct(r.components.openness * 100, 0)}\nCalidad: ${fmt(r.components.quality * 5, 2)}/5\nPrecio razonable: ${pct(r.components.priceReasonable * 100, 0)}\nCategoría hot: ${pct(r.components.catHot * 100, 0)}\n\n🏪 ${escapeHtml(p.Vendedor_Nombre || 'N/A')}\n💰 $${fmt(p.Precio_Numerico)} · 📈 ${fmt(p.Ventas || 0, 0)} ventas`;
        return `<tr title="${escapeHtml(tip)}">
          <td><span class="list-rank ${i < 3 ? ['gold', 'silver', 'bronze'][i] : 'normal'}">${i + 1}</span></td>
          <td><b>${escapeHtml((p.Nombre || '').substring(0, 40))}</b></td>
          <td><span class="badge" style="background:${r.score >= 60 ? 'var(--ml-green)' : r.score >= 40 ? 'var(--ml-yellow)' : 'var(--ml-orange)'};color:${r.score >= 60 ? '#fff' : 'var(--ml-navy-dark)'};">${fmt(r.score, 1)}</span></td>
          <td>${pct(r.components.demand * 100, 0)}</td>
          <td>${pct(r.components.openness * 100, 0)}</td>
          <td>${fmt(r.components.quality * 5, 2)}</td>
          <td>${pct(r.components.priceReasonable * 100, 0)}</td>
          <td>${pct(r.components.catHot * 100, 0)}</td>
          <td style="font-size:10px;">${r.tags.map(t => `<div>${t}</div>`).join('')}</td>
          <td>${fmt(p.Ventas || 0, 0)}</td>
          <td>${osintButtons(p)}</td>
        </tr>`;
      }).join('')}
      </tbody></table>` : emptyHtml('🎯', 'Sin productos para analizar. Ejecuta un crawl.');

    // Latent demand
    const latent = products.filter(p => (p.Visitas || 0) > 0)
      .map(p => ({ p, conv: p.Ventas / p.Visitas }))
      .filter(x => x.conv < 0.05 && x.p.Visitas > 100)
      .sort((a, b) => (b.p.Visitas || 0) - (a.p.Visitas || 0));
    $('latent-demand').innerHTML = latent.length > 0 ? `
      <table class="data-table"><thead><tr>
        <th>Producto</th><th>Visitas</th><th>Ventas</th><th>Conversión</th><th>Precio</th><th>Vendedor</th><th>Acciones</th>
      </tr></thead><tbody>
      ${latent.slice(0, 20).map(x => {
        const p = x.p;
        const tip = `${escapeHtml(p.Nombre)}\n👁 ${fmt(p.Visitas, 0)} visitas\n📈 ${fmt(p.Ventas || 0, 0)} ventas\n🎯 Conversión: ${pct(x.conv * 100, 2)}\n💡 Oportunidad: mejorar listing (fotos, descripción, precio)`;
        return `<tr title="${escapeHtml(tip)}">
          <td>${escapeHtml((p.Nombre || '').substring(0, 40))}</td>
          <td style="color:var(--ml-orange);font-weight:700;">${fmt(p.Visitas, 0)}</td>
          <td>${fmt(p.Ventas || 0, 0)}</td>
          <td><span class="tag">${pct(x.conv * 100, 2)}</span></td>
          <td>$${fmt(p.Precio_Numerico)}</td>
          <td>${sellerLink(p, null, 16)}</td>
          <td>${osintButtons(p)}</td>
        </tr>`;
      }).join('')}
      </tbody></table>` : emptyHtml('💡', 'Sin demanda latente detectada.');
  }

  /* ======================================================================
   * TOOLS TAB (profit calc, price comparison, dup detector)
   * ====================================================================== */
  function renderTools() {
    // Profit calculator
    renderProfitCalc();
    // Populate price comparison select
    const catMap = computeCategoryStats();
    const cats = [...catMap.values()].filter(c => c.products >= 3).sort((a, b) => b.products - a.products);
    const sel = $('price-comp-select');
    const prev = sel.value;
    sel.innerHTML = '<option value="">Selecciona categoría…</option>' + cats.map(c => `<option value="${escapeHtml(c.cat)}">${escapeHtml(c.cat)} (${c.products})</option>`).join('');
    sel.value = prev;
    if (prev) renderPriceComparison(prev);

    // Duplicate detector
    renderDuplicateDetector();
  }

  function renderProfitCalc() {
    const defaultMarkup = parseInt(config.sellMarkup, 10) || 20;
    $('profit-calc').innerHTML = `
      <div class="profit-row header">
        <div>Markup</div><div>Precio Venta</div><div>Profit</div><div>Margen</div>
      </div>
      <div class="profit-row">
        <div><label>Costo ($)</label><input type="number" id="profit-cost" class="profit-input" value="10" min="0" step="0.1"></div>
        <div id="profit-results" colspan="3" style="grid-column: 2 / 5;">
          <div id="profit-rows"></div>
        </div>
      </div>
      <p class="hint" style="margin-top:8px;">Markup por defecto de tu config: <b>${defaultMarkup}%</b>. Calcula profit a distintos markups. Recuerda considerar comisiones ML (~13-17%).</p>
    `;
    const update = () => {
      const cost = parseFloat($('profit-cost').value) || 0;
      const markups = [10, 20, 30, 50, 100, defaultMarkup].filter((v, i, arr) => arr.indexOf(v) === i).sort((a, b) => a - b);
      $('profit-rows').innerHTML = markups.map(m => {
        const sellPrice = cost * (1 + m / 100);
        const mlFee = sellPrice * 0.15; // estimated ML commission 15%
        const profit = sellPrice - cost - mlFee;
        const margin = sellPrice > 0 ? profit / sellPrice * 100 : 0;
        const cls = profit > 0 ? 'positive' : 'negative';
        const tip = `Costo: $${fmt(cost)}\nMarkup: ${m}%\nPrecio venta: $${fmt(sellPrice)}\nComisión ML (15%): -$${fmt(mlFee)}\nProfit neto: $${fmt(profit)}\nMargen: ${pct(margin, 1)}`;
        return `<div class="profit-row" title="${escapeHtml(tip)}">
          <div class="profit-cell">${m}%</div>
          <div class="profit-cell">$${fmt(sellPrice)}</div>
          <div class="profit-cell ${cls}">$${fmt(profit)}</div>
          <div class="profit-cell ${cls}">${pct(margin, 1)}</div>
        </div>`;
      }).join('');
    };
    $('profit-cost').addEventListener('input', update);
    update();
  }

  function renderPriceComparison(catName) {
    const cont = $('price-comp-content');
    const catProducts = products.filter(p => categoryPath(p) === catName && p.Precio_Numerico > 0);
    if (catProducts.length === 0) { cont.innerHTML = emptyHtml('📊', 'Sin productos en esta categoría.'); return; }
    const prices = catProducts.map(p => p.Precio_Numerico);
    const ps = priceStats(prices);
    cont.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-val">$${fmt(ps.min)}</div><div class="stat-lbl">Mínimo</div></div>
        <div class="stat-card"><div class="stat-val">$${fmt(ps.max)}</div><div class="stat-lbl">Máximo</div></div>
        <div class="stat-card yellow"><div class="stat-val">$${fmt(ps.avg)}</div><div class="stat-lbl">Promedio</div></div>
        <div class="stat-card green"><div class="stat-val">$${fmt(ps.median)}</div><div class="stat-lbl">Mediana</div></div>
        <div class="stat-card orange"><div class="stat-val">$${fmt(ps.std)}</div><div class="stat-lbl">Desv. Est.</div></div>
        <div class="stat-card red"><div class="stat-val">${pct(ps.cv * 100, 1)}</div><div class="stat-lbl">Coef. Var.</div></div>
        <div class="stat-card navy"><div class="stat-val">${catProducts.length}</div><div class="stat-lbl">Productos</div></div>
      </div>
      <p class="hint">${ps.cv > 0.6 ? '🔴 Alta variación de precios — opportunity para posicionar en rangos específicos.' : '🟢 Precios estables — mercado maduro.'}</p>
      <table class="data-table"><thead><tr><th>Producto</th><th>Precio</th><th>Δ vs Mediana</th><th>Vendedor</th><th>Ventas</th><th>Acciones</th></tr></thead><tbody>
      ${catProducts.sort((a, b) => a.Precio_Numerico - b.Precio_Numerico).slice(0, 30).map(p => {
        const delta = ps.median > 0 ? ((p.Precio_Numerico - ps.median) / ps.median * 100) : 0;
        const deltaCls = delta < -5 ? 'green' : delta > 5 ? 'red' : 'yellow';
        const tip = `${escapeHtml(p.Nombre)}\n💰 $${fmt(p.Precio_Numerico)}\n📊 Mediana: $${fmt(ps.median)}\nΔ: ${delta > 0 ? '+' : ''}${pct(delta, 1)} vs mediana\n🏪 ${escapeHtml(p.Vendedor_Nombre || 'N/A')}`;
        return `<tr title="${escapeHtml(tip)}">
          <td>${escapeHtml((p.Nombre || '').substring(0, 40))}</td>
          <td><b>$${fmt(p.Precio_Numerico)}</b></td>
          <td style="color:${deltaCls === 'green' ? 'var(--ml-green)' : deltaCls === 'red' ? 'var(--ml-red)' : 'var(--ml-orange)'};">${delta > 0 ? '+' : ''}${pct(delta, 1)}</td>
          <td>${sellerLink(p, null, 16)}</td>
          <td>${fmt(p.Ventas || 0, 0)}</td>
          <td>${osintButtons(p)}</td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  }

  function renderDuplicateDetector() {
    // Normalize title: lowercase, remove accents, drop common words, take first 25 chars
    const stop = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'y', 'o', 'con', 'sin', 'para', 'en', 'un', 'una', 'the', 'and', 'of', 'for']);
    function normalize(t) {
      return (t || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stop.has(w))
        .slice(0, 4)
        .sort()
        .join(' ');
    }
    const groups = new Map();
    products.forEach(p => {
      const key = normalize(p.Nombre);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });
    const dups = [...groups.values()].filter(g => g.length > 1 && new Set(g.map(p => p.Vendedor_Nombre)).size > 1);
    $('dup-detector').innerHTML = dups.length > 0 ? `
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">${dups.length} grupos de productos duplicados detectados.</p>
      <table class="data-table"><thead><tr><th>Grupo</th><th>Vendedor</th><th>Precio</th><th>Ventas</th><th>Acciones</th></tr></thead><tbody>
      ${dups.slice(0, 30).map((g, i) => g.map((p, j) => {
        const tip = `${escapeHtml(p.Nombre)}\n🏪 ${escapeHtml(p.Vendedor_Nombre || 'N/A')}\n💰 $${fmt(p.Precio_Numerico)}\n📈 ${fmt(p.Ventas || 0, 0)} ventas`;
        return `<tr title="${escapeHtml(tip)}">
          ${j === 0 ? `<td rowspan="${g.length}" style="vertical-align:top;font-weight:700;">Grupo #${i + 1}<br><span style="font-size:10px;color:var(--text-muted);">${g.length} productos · ${new Set(g.map(x => x.Vendedor_Nombre)).size} vendedores</span></td>` : ''}
          <td>${sellerLink(p, null, 22)}</td>
          <td>$${fmt(p.Precio_Numerico)}</td>
          <td>${fmt(p.Ventas || 0, 0)}</td>
          <td>${osintButtons(p)}</td>
        </tr>`;
      }).join('')).join('')}
      </tbody></table>` : emptyHtml('🔁', 'No se detectaron duplicados entre vendedores.');
  }

  /* ======================================================================
   * TRENDS TAB (projections, best time, elasticity, conv benchmark)
   * ====================================================================== */
  function renderTrends() {
    const extracted = products.filter(isDeep);
    const totalVisits = products.reduce((s, p) => s + (p.Visitas || 0), 0);
    const totalSales = products.reduce((s, p) => s + (p.Ventas || 0), 0);
    const avgConversion = totalVisits > 0 ? (totalSales / totalVisits * 100) : 0;

    const avgPrice = products.length > 0 ? products.reduce((s, p) => s + (p.Precio_Numerico || 0), 0) / products.length : 0;
    const priceStd = Math.sqrt(products.reduce((s, p) => s + Math.pow((p.Precio_Numerico || 0) - avgPrice, 2), 0) / (products.length || 1));
    const priceCV = avgPrice > 0 ? priceStd / avgPrice : 0;

    const sellerMap = new Map();
    extracted.forEach(p => {
      const name = p.Vendedor_Nombre;
      if (name && name !== 'N/A') sellerMap.set(name, (sellerMap.get(name) || 0) + 1);
    });
    const sellerShares = [...sellerMap.values()].map(c => c / Math.max(1, extracted.length));
    const hhi = computeHHI(sellerShares);

    const trends = [];
    trends.push({
      type: 'success', title: '📈 Proyección de Demanda',
      body: `Con <b>${fmt(totalVisits, 0)}</b> visitas totales y conversión del <b>${pct(avgConversion, 2)}</b>, el mercado proyecta <b>${Math.round(totalVisits * 0.1)} visitas/día</b> y <b>${Math.round(totalSales / 10)} ventas/día</b> en esta categoría.`
    });

    trends.push({
      type: hhi < 0.15 ? 'success' : hhi < 0.25 ? 'warning' : 'danger',
      title: `🏪 Concentración de Mercado (HHI: ${fmt(hhi, 4)})`,
      body: `${hhi < 0.15 ? 'Mercado fragmentado — bajas barreras de entrada.' : hhi < 0.25 ? 'Concentración media — algunos vendedores dominantes.' : 'Alta concentración — pocos vendedores controlan el mercado.'} <b>${sellerMap.size}</b> vendedores únicos.`
    });

    trends.push({
      type: priceCV > 0.6 ? 'warning' : 'success',
      title: `💰 Análisis de Precios (CV: ${pct(priceCV * 100, 1)})`,
      body: `Precio promedio: <b>$${fmt(avgPrice)}</b>. ${priceCV > 0.6 ? 'Alta variación — oportunidad de posicionar productos en rangos específicos.' : 'Precios estables — mercado maduro.'}`
    });

    $('trends-content').innerHTML = trends.map(t => `
      <div class="trend-card ${t.type}">
        <div class="trend-title">${t.title}</div>
        <div class="trend-body">${t.body}</div>
      </div>`).join('');

    // Best time to publish
    renderBestTime();

    // Price Elasticity
    renderPriceElasticity();

    // Conversion Benchmark
    renderConvBenchmark();
  }

  function renderBestTime() {
    // Without timestamps per product, we estimate from product listings — top sellers tend to be older (more reviews).
    // Heuristic: bucket by Opiniones ranges, suggest publishing on weekday evenings.
    const withReviews = products.filter(p => (p.Opiniones || 0) > 0);
    const totalReviews = withReviews.reduce((s, p) => s + p.Opiniones, 0);
    $('best-time').innerHTML = `
      <div class="trend-card success">
        <div class="trend-title">🕐 Mejor Momento para Publicar</div>
        <div class="trend-body">
          Basado en <b>${withReviews.length}</b> productos con opiniones (<b>${fmt(totalReviews, 0)}</b> opiniones totales):
          <ul style="margin:6px 0 0 16px;padding:0;">
            <li>📅 <b>Lunes a Jueves</b> — 6pm–9pm: pico de tráfico en ML VE</li>
            <li>📅 <b>Viernes</b> — 12pm–2pm y 7pm–10pm: pagos/quincena</li>
            <li>📅 <b>Sábado</b> — 10am–1pm: máxima conversión</li>
            <li>🚫 Evitar domingos después de las 6pm</li>
          </ul>
          <p style="margin-top:8px;font-size:11px;color:var(--text-muted);">Nota: esta recomendación se basa en patrones generales de ML VE. Con crawling periódico, podré darte datos precisos por categoría.</p>
        </div>
      </div>`;
  }

  function renderPriceElasticity() {
    const withData = products.filter(p => (p.Ventas || 0) > 0 && (p.Precio_Numerico || 0) > 0);
    const prices = withData.map(p => p.Precio_Numerico);
    const sales = withData.map(p => p.Ventas);
    const corr = correlation(prices, sales);
    let interp = '';
    let cls = 'success';
    if (corr < -0.3) { interp = '🔴 Elasticidad negativa fuerte — productos más baratos venden significativamente más. Mercado sensible al precio.'; cls = 'danger'; }
    else if (corr < -0.1) { interp = '🟡 Ligera elasticidad negativa — el precio bajo ayuda pero no es decisivo.'; cls = 'warning'; }
    else if (corr < 0.1) { interp = '🟢 Inelástico — el precio no afecta las ventas. Productos premium compiten igual.'; cls = 'success'; }
    else if (corr < 0.3) { interp = '🟡 Ligera elasticidad positiva — productos premium venden ligeramente más.'; cls = 'warning'; }
    else { interp = '🔴 Elasticidad positiva fuerte — productos premium dominan. Mercado de gama alta.'; cls = 'danger'; }
    $('price-elasticity').innerHTML = `
      <div class="trend-card ${cls}">
        <div class="trend-title">📈 Elasticidad Precio–Ventas</div>
        <div class="trend-body">
          Correlación Pearson: <b>${fmt(corr, 3)}</b> (n=${withData.length} productos con ventas).
          <p style="margin-top:6px;">${interp}</p>
        </div>
      </div>`;
  }

  function renderConvBenchmark() {
    // Compute category-average conversion, then find products that outperform
    const catMap = computeCategoryStats();
    const catConv = new Map();
    catMap.forEach((s, cat) => {
      catConv.set(cat, s.visits > 0 ? s.sales / s.visits : 0);
    });
    const withData = products.filter(p => (p.Visitas || 0) > 0 && (p.Ventas || 0) > 0).map(p => {
      const cat = categoryPath(p);
      const conv = p.Ventas / p.Visitas;
      const catAvg = catConv.get(cat) || 0;
      return { p, conv, catAvg, ratio: catAvg > 0 ? conv / catAvg : 1 };
    }).filter(x => x.catAvg > 0).sort((a, b) => b.ratio - a.ratio);
    $('conv-benchmark').innerHTML = withData.length > 0 ? `
      <table class="data-table"><thead><tr>
        <th>Producto</th><th>Conv. producto</th><th>Conv. cat. avg</th><th>Δ vs categoría</th><th>Ventas</th><th>Visitas</th><th>Vendedor</th>
      </tr></thead><tbody>
      ${withData.slice(0, 20).map(x => {
        const p = x.p;
        const delta = (x.ratio - 1) * 100;
        const cls = delta > 20 ? 'green' : delta < -20 ? 'red' : 'yellow';
        const tip = `${escapeHtml(p.Nombre)}\n🎯 Conv producto: ${pct(x.conv * 100, 2)}\n📊 Conv cat avg: ${pct(x.catAvg * 100, 2)}\nΔ: ${delta > 0 ? '+' : ''}${pct(delta, 1)} vs categoría\n\n${delta > 20 ? '✅ Benchmark — sobreperforma' : delta < -20 ? '⚠️ Bajo benchmark' : '≈ En línea con la categoría'}`;
        return `<tr title="${escapeHtml(tip)}">
          <td>${escapeHtml((p.Nombre || '').substring(0, 40))}</td>
          <td><b>${pct(x.conv * 100, 2)}</b></td>
          <td>${pct(x.catAvg * 100, 2)}</td>
          <td style="color:${cls === 'green' ? 'var(--ml-green)' : cls === 'red' ? 'var(--ml-red)' : 'var(--ml-orange)'};font-weight:700;">${delta > 0 ? '+' : ''}${pct(delta, 1)}</td>
          <td>${fmt(p.Ventas, 0)}</td>
          <td>${fmt(p.Visitas, 0)}</td>
          <td>${sellerLink(p, null, 16)}</td>
        </tr>`;
      }).join('')}
      </tbody></table>` : emptyHtml('🎯', 'Sin datos suficientes (necesita visitas y ventas).');
  }

  /* ======================================================================
   * INTEGRATIONS TAB (Sheets, Webhooks, Webhook Docs, ML API)
   * ====================================================================== */
  const WEBHOOK_EVENTS = [
    {
      name: 'sell',
      desc: 'Se dispara cuando un producto es publicado con el botón Vender.',
      payload: {
        event: 'sell',
        timestamp: '2024-06-15T14:32:00.000Z',
        data: {
          originalId: 'MLV123456789',
          newId: 'MLV987654321',
          title: 'Licuadora Oster 1500w 1.5l Vidrio + Picatodo',
          price: 48,
          currency: 'USD',
          markup: 20,
          permalink: 'https://articulo.mercadolibre.com.ve/MLV987654321-licuadora-_JM'
        }
      }
    },
    {
      name: 'crawl_complete',
      desc: 'Se dispara cuando termina un crawling (todas las páginas procesadas).',
      payload: {
        event: 'crawl_complete',
        timestamp: '2024-06-15T14:32:00.000Z',
        data: {
          phrases: ['licuadora', 'batidora'],
          totalPages: 20,
          newProducts: 480,
          totalProducts: 5234,
          durationSec: 124,
          errors: 0
        }
      }
    },
    {
      name: 'deep_extract_complete',
      desc: 'Se dispara cuando termina la extracción profunda (vendedor, ubicación, etc.).',
      payload: {
        event: 'deep_extract_complete',
        timestamp: '2024-06-15T14:35:00.000Z',
        data: {
          processed: 480,
          succeeded: 472,
          failed: 8,
          totalExtracted: 4890,
          durationSec: 89
        }
      }
    },
    {
      name: 'sheets_sync',
      desc: 'Se dispara cuando se completa una sincronización con Google Sheets.',
      payload: {
        event: 'sheets_sync',
        timestamp: '2024-06-15T14:40:00.000Z',
        data: {
          appended: 480,
          updated: 12,
          totalRows: 5234,
          sheetUrl: 'https://docs.google.com/spreadsheets/d/...',
          durationSec: 32
        }
      }
    }
  ];

  function renderIntegrations() {
    // Sheets
    $('integration-sheets').innerHTML = `
      <div class="config-item">
        <label>Estado</label>
        <div class="webhook-status ${config.gsheetsUrl ? 'active' : 'inactive'}">${config.gsheetsUrl ? '✅ Configurado' : '❌ No configurado'}</div>
      </div>
      <div class="config-item">
        <label>URL del Apps Script</label>
        <input type="text" value="${escapeHtml(config.gsheetsUrl)}" readonly style="font-size:10px;">
      </div>
    `;

    // ML API
    $('integration-api').innerHTML = `
      <div class="config-item">
        <label>Token de ML API</label>
        <div class="webhook-status ${config.accessToken ? 'active' : 'inactive'}">${config.accessToken ? '✅ Configurado' : '❌ No configurado'}</div>
      </div>
      <div class="config-item">
        <label>Verificar Token</label>
        <button class="btn btn-navy btn-sm" id="btn-verify-token">Verificar /users/me</button>
        <div id="token-verify-result" style="font-size:10px;margin-top:4px;"></div>
      </div>
    `;
    $('btn-verify-token').onclick = async () => {
      $('token-verify-result').textContent = 'Verificando…';
      try {
        const token = config.accessToken;
        const res = await fetch('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json();
        if (data.nickname) {
          $('token-verify-result').innerHTML = `✅ ${escapeHtml(data.nickname)} (ID: ${data.id}, Site: ${escapeHtml(data.site_id || '')})`;
        } else {
          $('token-verify-result').innerHTML = `❌ ${escapeHtml(data.message || data.error || 'Token inválido')}`;
        }
      } catch (e) {
        $('token-verify-result').innerHTML = `❌ ${escapeHtml(e.message)}`;
      }
    };

    // Webhooks
    renderWebhooks();
    $('btn-add-webhook').onclick = () => {
      config.webhooks.push({ url: '', name: '', events: ['sell'], active: true });
      chrome.storage.local.set({ ml_webhooks: config.webhooks });
      renderWebhooks();
    };

    // Webhook documentation
    renderWebhookDocs();
  }

  function renderWebhooks() {
    if (config.webhooks.length === 0) {
      $('webhooks-list').innerHTML = emptyHtml('🔗', 'No hay webhooks configurados. Click en "+ Agregar".');
      return;
    }
    $('webhooks-list').innerHTML = config.webhooks.map((wh, i) => `
      <div class="webhook-item">
        <input type="text" placeholder="Nombre (ej: Slack #ventas)" value="${escapeHtml(wh.name || '')}" data-wh-idx="${i}" data-wh-field="name" title="Nombre descriptivo del webhook">
        <input type="text" placeholder="URL (https://hooks.slack.com/services/...)" value="${escapeHtml(wh.url || '')}" data-wh-idx="${i}" data-wh-field="url" title="URL de destino (Zapier, Make, Slack, etc.)">
        <div class="webhook-row">
          <span class="webhook-status ${wh.active ? 'active' : 'inactive'}" title="Estado actual">${wh.active ? 'Activo' : 'Inactivo'}</span>
          <button class="btn btn-ghost btn-sm" data-wh-toggle="${i}">${wh.active ? 'Desactivar' : 'Activar'}</button>
          <button class="btn btn-danger btn-sm" data-wh-del="${i}">Eliminar</button>
        </div>
        <div class="webhook-events">
          ${WEBHOOK_EVENTS.map(ev => {
            const on = Array.isArray(wh.events) && wh.events.indexOf(ev.name) !== -1;
            return `<span class="event-chip ${on ? '' : 'off'}" data-wh-evt-toggle="${i}" data-evt="${ev.name}" title="${escapeHtml(ev.desc)}">${on ? '✓' : '✗'} ${ev.name}</span>`;
          }).join('')}
        </div>
      </div>`).join('');
    document.querySelectorAll('[data-wh-field]').forEach(el => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.whIdx);
        const field = el.dataset.whField;
        config.webhooks[idx][field] = el.value;
        chrome.storage.local.set({ ml_webhooks: config.webhooks });
      });
    });
    document.querySelectorAll('[data-wh-toggle]').forEach(el => {
      el.onclick = () => {
        const idx = parseInt(el.dataset.whToggle);
        config.webhooks[idx].active = !config.webhooks[idx].active;
        chrome.storage.local.set({ ml_webhooks: config.webhooks });
        renderWebhooks();
      };
    });
    document.querySelectorAll('[data-wh-del]').forEach(el => {
      el.onclick = () => {
        const idx = parseInt(el.dataset.whDel);
        config.webhooks.splice(idx, 1);
        chrome.storage.local.set({ ml_webhooks: config.webhooks });
        renderWebhooks();
      };
    });
    document.querySelectorAll('[data-wh-evt-toggle]').forEach(el => {
      el.onclick = () => {
        const idx = parseInt(el.dataset.whEvtToggle);
        const evt = el.dataset.evt;
        const events = Array.isArray(config.webhooks[idx].events) ? config.webhooks[idx].events : [];
        const pos = events.indexOf(evt);
        if (pos === -1) events.push(evt); else events.splice(pos, 1);
        config.webhooks[idx].events = events;
        chrome.storage.local.set({ ml_webhooks: config.webhooks });
        renderWebhooks();
      };
    });
  }

  function renderWebhookDocs() {
    const docsHtml = WEBHOOK_EVENTS.map(ev => `
      <div class="event-card">
        <span class="event-name">${ev.name}</span>
        <p class="event-desc">${escapeHtml(ev.desc)}</p>
        <p style="font-size:11px;font-weight:700;margin:6px 0 4px 0;">Payload de ejemplo:</p>
        <pre class="code-block">${escapeHtml(JSON.stringify(ev.payload, null, 2))}</pre>
      </div>
    `).join('');

    const guide = `
      <div class="event-card" style="border-left:4px solid var(--ml-yellow-dark);">
        <p style="font-size:13px;font-weight:700;color:var(--ml-navy);margin:0 0 8px 0;">🚀 Cómo configurar en servicios externos</p>
        <p style="font-size:12px;margin:0 0 10px 0;"><b>Zapier:</b></p>
        <ol style="font-size:11px;margin:0 0 12px 18px;padding:0;color:var(--text-muted);">
          <li>Crea un nuevo Zap → Trigger: <b>Webhooks by Zapier → Catch Hook</b></li>
          <li>Zapier te da una URL única. Cópiala.</li>
          <li>En esta página, click "+ Agregar Webhook", pega la URL, nombre "Zapier", activa el evento que quieras (ej. <code>sell</code>).</li>
          <li>En Zapier, haz "Test trigger" — publica un producto desde la extensión para enviar el primer evento.</li>
          <li>Configura el Action en Zapier (Slack, Gmail, Sheets, etc.).</li>
        </ol>
        <p style="font-size:12px;margin:0 0 10px 0;"><b>Make (Integromat):</b></p>
        <ol style="font-size:11px;margin:0 0 12px 18px;padding:0;color:var(--text-muted);">
          <li>Crea un Scenario → primer módulo: <b>Webhooks → Custom webhook</b></li>
          <li>Selecciona "When webhook is received" → Make te da una URL.</li>
          <li>Pégala aquí como nuevo webhook. Activa los eventos deseados.</li>
          <li>Haz "Re-determine data structure" enviando un evento de prueba.</li>
          <li>Encadena módulos (Slack, Telegram, Sheets, etc.).</li>
        </ol>
        <p style="font-size:12px;margin:0 0 10px 0;"><b>Slack (directo, sin Zapier):</b></p>
        <ol style="font-size:11px;margin:0 0 12px 18px;padding:0;color:var(--text-muted);">
          <li>En Slack: <b>Apps → Incoming Webhooks → Add Configuration</b></li>
          <li>Selecciona canal → Slack te da una URL <code>https://hooks.slack.com/services/T.../B.../...</code></li>
          <li>Pégala aquí como nuevo webhook, nombre "Slack #ventas", activa evento <code>sell</code>.</li>
          <li><b>Nota:</b> Slack espera un payload con campo <code>text</code>. Para transformar el payload ML a Slack, usa Zapier/Make como intermediario.</li>
        </ol>
        <p style="font-size:12px;margin:0 0 10px 0;"><b>Telegram (bot):</b></p>
        <ol style="font-size:11px;margin:0 0 12px 18px;padding:0;color:var(--text-muted);">
          <li>Crea un bot con <code>@BotFather</code> → obtén el token.</li>
          <li>Obtén tu <code>chat_id</code> (mensaje a <code>@userinfobot</code>).</li>
          <li>URL webhook: <code>https://api.telegram.org/bot[TOKEN]/sendMessage?chat_id=[CHAT_ID]&text=...</code></li>
          <li>Mejor vía Zapier/Make: para enviar el mensaje formateado, no directamente (Telegram no acepta POST JSON en esa URL).</li>
        </ol>
      </div>
    `;

    $('webhook-docs').innerHTML = `
      <p style="font-size:12px;margin:0 0 12px 0;">Esta extensión puede disparar los siguientes eventos a tus webhooks. Cada evento envía un POST JSON con el payload mostrado.</p>
      ${docsHtml}
      ${guide}
      <p class="hint" style="margin-top:12px;">💡 <b>Tip:</b> Puedes tener múltiples webhooks activos. Cada uno recibirá los eventos que tengas marcados. Los webhooks inactivos no reciben nada.</p>
    `;
  }

  /* ======================================================================
   * CONFIG TAB
   * ====================================================================== */
  function renderConfig() {
    $('config-general').innerHTML = `
      <div class="config-item">
        <label>ML API Access Token</label>
        <input type="password" id="cfg-token" value="${escapeHtml(config.accessToken)}" placeholder="APP_USR-...">
        <div class="hint-small">Requerido para Vender y para leer visitas vía API. Obtenlo en <code>applications.mercadolibre.com</code>.</div>
      </div>
      <div class="config-item">
        <label>Google Sheets Web App URL</label>
        <input type="text" id="cfg-gsheets" value="${escapeHtml(config.gsheetsUrl)}" placeholder="https://script.google.com/macros/s/...">
        <div class="hint-small">URL del Google Apps Script desplegado (ver <code>google-apps-script.js</code>).</div>
      </div>
      <div class="config-actions">
        <button class="btn btn-primary" id="btn-save-config">💾 Guardar</button>
      </div>
    `;
    $('config-sell').innerHTML = `
      <div class="config-item">
        <label>Markup de Venta (%)</label>
        <input type="number" id="cfg-markup" value="${escapeHtml(config.sellMarkup)}" step="5" min="0" max="500">
        <div class="hint-small">Porcentaje añadido al precio original al usar el botón Vender. Por defecto 20%.</div>
      </div>
      <div class="config-actions">
        <button class="btn btn-primary" id="btn-save-sell">💾 Guardar</button>
      </div>
    `;
    $('config-automation').innerHTML = `
      <div class="config-item">
        <label>Auto Deep Extract al terminar crawl</label>
        <select id="cfg-auto-deep"><option value="false">No</option><option value="true" selected>Sí</option></select>
        <div class="hint-small">Ejecuta automáticamente deep extraction al finalizar el crawling.</div>
      </div>
      <div class="config-item">
        <label>Auto Sync Sheets al terminar</label>
        <select id="cfg-auto-sync"><option value="false">No</option><option value="true" selected>Sí</option></select>
        <div class="hint-small">Sincroniza con Google Sheets automáticamente.</div>
      </div>
      <div class="config-actions">
        <button class="btn btn-primary" id="btn-save-automation">💾 Guardar</button>
      </div>
    `;
    $('btn-save-config').onclick = async () => {
      await chrome.storage.local.set({ ml_access_token: $('cfg-token').value, ml_gsheets_url: $('cfg-gsheets').value });
      config.accessToken = $('cfg-token').value;
      config.gsheetsUrl = $('cfg-gsheets').value;
      showToast('✅ Configuración guardada');
    };
    $('btn-save-sell').onclick = async () => {
      await chrome.storage.local.set({ ml_sell_markup: $('cfg-markup').value });
      config.sellMarkup = $('cfg-markup').value;
      showToast('✅ Configuración de venta guardada');
    };
    $('btn-save-automation').onclick = async () => {
      await chrome.storage.local.set({
        ml_auto_deep: $('cfg-auto-deep').value === 'true',
        ml_auto_sync: $('cfg-auto-sync').value === 'true'
      });
      showToast('✅ Automatización guardada');
    };
  }

  /* ======================================================================
   * SHEET TABS (v6.18.0)
   *
   *  - sheet_opps     : meli_opportunities from Apps Script (?action=opportunities&all=true)
   *  - sheet_published : meli_published from Apps Script (?action=published)
   *  - sheet_sales    : meli_sales from Apps Script (?action=sales)
   *
   *  All three share a common fetch helper + render table pattern.
   * ====================================================================== */
  let sheetOpps = [];
  let sheetPublished = [];
  let sheetSales = [];

  function sheetsGet(action, extra) {
    if (!config.gsheetsUrl) {
      return Promise.reject(new Error('Falta la URL del Apps Script en Configuración.'));
    }
    const qs = ['action=' + encodeURIComponent(action)];
    Object.keys(extra || {}).forEach(k => {
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]));
    });
    const sep = config.gsheetsUrl.indexOf('?') === -1 ? '?' : '&';
    const url = config.gsheetsUrl + sep + qs.join('&');
    return fetch(url)
      .then(r => r.text())
      .then(text => {
        const trimmed = (text || '').trim();
        if (trimmed.charAt(0) === '<' || trimmed.indexOf('<html') !== -1) {
          throw new Error('Google devolvió HTML. Re-autoriza el Apps Script.');
        }
        return JSON.parse(trimmed);
      });
  }

  function sheetsPost(payload) {
    if (!config.gsheetsUrl) {
      return Promise.reject(new Error('Falta la URL del Apps Script en Configuración.'));
    }
    return fetch(config.gsheetsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(r => r.text()).then(text => {
      const trimmed = (text || '').trim();
      if (trimmed.charAt(0) === '<' || trimmed.indexOf('<html') !== -1) {
        throw new Error('Google devolvió HTML. Re-autoriza el Apps Script.');
      }
      return JSON.parse(trimmed);
    });
  }

  function sheetNum(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback || 0;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? (fallback || 0) : n;
  }

  function sheetRowStatusBadge(st) {
    const s = String(st || 'pending').toLowerCase();
    const map = {
      pending: ['⏳ Pendiente', 'pending'],
      publishing: ['⏳ Publicando', 'publishing'],
      published: ['✓ Publicada', 'published'],
      failed: ['✕ Fallida', 'failed'],
      deleted: ['🗑 Eliminada', 'failed']
    };
    const pair = map[s] || ['⏳ Pendiente', 'pending'];
    return '<span class="status-badge status-' + pair[1] + '">' + pair[0] + '</span>';
  }

  /* ----- Sheet Opportunities ----- */
  function renderSheetOpps() {
    const el = $('sheet-opps-list');
    if (!el) return;
    if (!config.gsheetsUrl) {
      el.innerHTML = '<div class="empty-state"><div class="empty-ic">⚙️</div>' +
        '<p>Falta configurar la URL del Apps Script. Ve a la pestaña Integraciones o Configuración.</p></div>';
      $('sheet-opp-count').textContent = '0';
      return;
    }
    if (sheetOpps.__loading) {
      el.innerHTML = '<div class="empty-state"><div class="empty-ic">⏳</div><p>Cargando oportunidades...</p></div>';
      return;
    }
    const q = ($('sheet-opp-filter') ? $('sheet-opp-filter').value : '').toLowerCase().trim();
    const statusFilter = $('sheet-opp-status-filter') ? $('sheet-opp-status-filter').value : 'all';
    const sortMode = $('sheet-opp-sort') ? $('sheet-opp-sort').value : 'created_desc';

    let rows = sheetOpps.filter(o => {
      if (statusFilter !== 'all' && String(o.Status || 'pending').toLowerCase() !== statusFilter) return false;
      if (!q) return true;
      const hay = [o.Product_Name, o.Brand, o.Model, o.Category, o.Location_Found, o.Notes].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    rows.sort((a, b) => {
      switch (sortMode) {
        case 'created_asc': return String(a.Created_At || '').localeCompare(String(b.Created_At || ''));
        case 'created_desc': return String(b.Created_At || '').localeCompare(String(a.Created_At || ''));
        case 'price_asc': return sheetNum(a.Suggested_Price) - sheetNum(b.Suggested_Price);
        case 'price_desc': return sheetNum(b.Suggested_Price) - sheetNum(a.Suggested_Price);
      }
      return 0;
    });

    $('sheet-opp-count').textContent = String(rows.length);

    if (rows.length === 0) {
      el.innerHTML = emptyHtml('📭',
        sheetOpps.length === 0 ? 'Sin oportunidades capturadas. Abre opportunities.html desde la extensión para capturar la primera.'
          : 'Ninguna oportunidad coincide con los filtros.');
      return;
    }

    el.innerHTML = '<table class="data-table"><thead><tr>' +
      '<th>Producto</th><th>Costo</th><th>Venta</th><th>Markup</th>' +
      '<th>Origen</th><th>Ubicación</th><th>Estado</th><th>Creada</th><th>Acciones</th>' +
      '</tr></thead><tbody>' +
      rows.map(o => {
        const st = String(o.Status || 'pending').toLowerCase();
        const tip = [
          o.Product_Name || '(sin nombre)',
          o.Brand ? 'Marca: ' + o.Brand : '',
          o.Model ? 'Modelo: ' + o.Model : '',
          o.Notes ? 'Notas: ' + o.Notes : '',
          o.Category ? 'Categoría: ' + o.Category : '',
          o.Error_Message ? 'Error: ' + o.Error_Message : ''
        ].filter(Boolean).join('\n');
        const actions = [];
        if (st === 'pending' || st === 'failed') {
          actions.push('<button class="btn btn-success btn-sm" data-opppub="' + escapeAttr(o.Opp_ID) + '" title="Publicar vía Vender">💰 Publicar</button>');
        }
        if (o.Published_ID) {
          actions.push('<a class="btn btn-navy btn-sm" href="https://articulo.mercadolibre.com.ve/' + escapeAttr(String(o.Published_ID).replace(/^MLV-?/i, 'MLV-')) + '" target="_blank" rel="noopener" title="Abrir publicación ML">🔗 Ver</a>');
        }
        return '<tr title="' + escapeAttr(tip) + '">' +
          '<td><div style="font-weight:600;">' + escapeHtml((o.Product_Name || '').substring(0, 50)) + '</div>' +
            (o.Brand ? '<div style="font-size:10px;color:var(--text-muted);">' + escapeHtml(o.Brand) + (o.Model ? ' · ' + escapeHtml(o.Model) : '') + '</div>' : '') +
            (o.Notes ? '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">' + escapeHtml((o.Notes || '').substring(0, 60)) + (o.Notes.length > 60 ? '...' : '') + '</div>' : '') +
          '</td>' +
          '<td style="color:var(--ml-red);font-weight:700;">$' + fmt(sheetNum(o.Estimated_Cost)) + '</td>' +
          '<td style="color:var(--ml-green);font-weight:700;">$' + fmt(sheetNum(o.Suggested_Price)) + '</td>' +
          '<td>' + escapeHtml(o.Markup_Percent || '20') + '%</td>' +
          '<td style="font-size:11px;">' + escapeHtml(o.Source || '—') + '</td>' +
          '<td style="font-size:11px;">' + escapeHtml(o.Location_Found || '—') + '</td>' +
          '<td>' + sheetRowStatusBadge(o.Status) + '</td>' +
          '<td style="font-size:11px;">' + (o.Created_At ? escapeHtml(new Date(o.Created_At).toLocaleString('es-VE')) : '—') + '</td>' +
          '<td><div style="display:flex;gap:3px;flex-wrap:wrap;">' + actions.join('') + '</div></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-opppub]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-opppub');
        const opp = sheetOpps.find(o => String(o.Opp_ID) === String(id));
        if (!opp) return;
        showToast('💰 Marcando como "publishing"...');
        try {
          await sheetsPost({ action: 'update_opportunity', id: id, status: 'publishing' });
        } catch (e) {}
        try { window.open('opportunities.html', '_blank'); } catch (e) {}
        showToast('Abre opportunities.html para continuar la publicación.', 'success');
      };
    });
  }

  async function loadSheetOpps() {
    if (!config.gsheetsUrl) { sheetOpps = []; renderSheetOpps(); return; }
    sheetOpps.__loading = true;
    renderSheetOpps();
    try {
      const res = await sheetsGet('opportunities', { all: 'true' });
      sheetOpps = (res && res.success && Array.isArray(res.rows)) ? res.rows : [];
    } catch (e) {
      sheetOpps = [];
      showToast('❌ ' + e.message, 'error');
    }
    sheetOpps.__loading = false;
    renderSheetOpps();
  }

  /* ----- Sheet Published ----- */
  function renderSheetPub() {
    const el = $('sheet-pub-list');
    if (!el) return;
    if (!config.gsheetsUrl) {
      el.innerHTML = '<div class="empty-state"><div class="empty-ic">⚙️</div>' +
        '<p>Falta configurar la URL del Apps Script. Ve a Integraciones.</p></div>';
      $('sheet-pub-count').textContent = '0';
      return;
    }
    if (sheetPublished.__loading) {
      el.innerHTML = '<div class="empty-state"><div class="empty-ic">⏳</div><p>Cargando publicaciones...</p></div>';
      return;
    }
    const q = ($('sheet-pub-filter') ? $('sheet-pub-filter').value : '').toLowerCase().trim();
    const sortMode = $('sheet-pub-sort') ? $('sheet-pub-sort').value : 'pub_desc';

    let rows = sheetPublished.filter(p => {
      if (!q) return true;
      return [p.Title, p.Original_ID, p.Published_ID, p.Category_Id].join(' ').toLowerCase().indexOf(q) !== -1;
    });

    rows.sort((a, b) => {
      switch (sortMode) {
        case 'pub_asc': return String(a.Published_At || '').localeCompare(String(b.Published_At || ''));
        case 'pub_desc': return String(b.Published_At || '').localeCompare(String(a.Published_At || ''));
        case 'price_asc': return sheetNum(a.Price) - sheetNum(b.Price);
        case 'price_desc': return sheetNum(b.Price) - sheetNum(a.Price);
        case 'views_desc': return sheetNum(b.Views_30d) - sheetNum(a.Views_30d);
        case 'sales_desc': return sheetNum(b.Sales_30d) - sheetNum(a.Sales_30d);
      }
      return 0;
    });

    $('sheet-pub-count').textContent = String(rows.length);

    if (rows.length === 0) {
      el.innerHTML = emptyHtml('📭',
        sheetPublished.length === 0 ? 'Sin publicaciones en el Sheet todavía. Usa el botón 💰 Vender en cualquier producto crawleado.'
          : 'Ninguna publicación coincide con el filtro.');
      return;
    }

    el.innerHTML = '<table class="data-table"><thead><tr>' +
      '<th>Título</th><th>Original ID</th><th>Precio</th><th>Markup</th>' +
      '<th>Visitas 30d</th><th>Ventas 30d</th><th>Estado</th><th>Publicado</th><th>Acciones</th>' +
      '</tr></thead><tbody>' +
      rows.map(p => {
        const tip = [p.Title, 'Original: ' + p.Original_ID, 'Publicado: ' + p.Published_ID, 'Precio: $' + fmt(sheetNum(p.Price))].join('\n');
        return '<tr title="' + escapeAttr(tip) + '">' +
          '<td><div style="font-weight:600;">' + escapeHtml((p.Title || '').substring(0, 50)) + '</div>' +
            (p.Category_Id ? '<div style="font-size:10px;color:var(--text-muted);">' + escapeHtml(p.Category_Id) + '</div>' : '') + '</td>' +
          '<td><code>' + escapeHtml(p.Original_ID || '—') + '</code></td>' +
          '<td><b>$' + fmt(sheetNum(p.Price)) + '</b><br><span style="font-size:10px;color:var(--text-muted);">' + escapeHtml(p.Currency || 'USD') + '</span></td>' +
          '<td>' + (p.Markup_Percent ? escapeHtml(p.Markup_Percent) + '%' : '—') + '</td>' +
          '<td>' + (p.Views_30d ? fmt(sheetNum(p.Views_30d, 0)) : '—') + '</td>' +
          '<td style="color:var(--ml-green);font-weight:700;">' + (p.Sales_30d ? fmt(sheetNum(p.Sales_30d, 0)) : '—') + '</td>' +
          '<td>' + escapeHtml(p.Status || 'active') + '</td>' +
          '<td style="font-size:11px;">' + (p.Published_At ? escapeHtml(new Date(p.Published_At).toLocaleString('es-VE')) : '—') + '</td>' +
          '<td>' + (p.Permalink ? '<a class="btn btn-navy btn-sm" href="' + escapeAttr(p.Permalink) + '" target="_blank" rel="noopener">🔗 Ver</a>' : '—') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  async function loadSheetPub() {
    if (!config.gsheetsUrl) { sheetPublished = []; renderSheetPub(); return; }
    sheetPublished.__loading = true;
    renderSheetPub();
    try {
      const res = await sheetsGet('published');
      sheetPublished = (res && res.success && Array.isArray(res.rows)) ? res.rows : [];
    } catch (e) {
      sheetPublished = [];
      showToast('❌ ' + e.message, 'error');
    }
    sheetPublished.__loading = false;
    renderSheetPub();
  }

  /* ----- Sheet Sales ----- */
  function renderSheetSales() {
    const el = $('sheet-sales-list');
    if (!el) return;
    if (!config.gsheetsUrl) {
      el.innerHTML = '<div class="empty-state"><div class="empty-ic">⚙️</div>' +
        '<p>Falta configurar la URL del Apps Script. Ve a Integraciones.</p></div>';
      $('sheet-sales-count').textContent = '0';
      $('sheet-sales-stats').innerHTML = '';
      return;
    }
    if (sheetSales.__loading) {
      el.innerHTML = '<div class="empty-state"><div class="empty-ic">⏳</div><p>Cargando ventas...</p></div>';
      return;
    }
    const q = ($('sheet-sales-filter') ? $('sheet-sales-filter').value : '').toLowerCase().trim();
    const statusFilter = $('sheet-sales-status-filter') ? $('sheet-sales-status-filter').value : 'all';
    const sortMode = $('sheet-sales-sort') ? $('sheet-sales-sort').value : 'date_desc';

    let rows = sheetSales.filter(s => {
      if (statusFilter !== 'all' && String(s.Status || '').toLowerCase() !== statusFilter) return false;
      if (!q) return true;
      return [s.Order_ID, s.Item_ID, s.Title, s.Buyer_Nickname].join(' ').toLowerCase().indexOf(q) !== -1;
    });

    rows.sort((a, b) => {
      switch (sortMode) {
        case 'date_asc': return String(a.Sale_Date || '').localeCompare(String(b.Sale_Date || ''));
        case 'date_desc': return String(b.Sale_Date || '').localeCompare(String(a.Sale_Date || ''));
        case 'price_desc': return sheetNum(b.Sale_Price) - sheetNum(a.Sale_Price);
        case 'profit_desc': return sheetNum(b.Net_Profit) - sheetNum(a.Net_Profit);
        case 'profit_asc': return sheetNum(a.Net_Profit) - sheetNum(b.Net_Profit);
      }
      return 0;
    });

    $('sheet-sales-count').textContent = String(rows.length);

    const totalRevenue = rows.reduce((s, r) => s + sheetNum(r.Sale_Price), 0);
    const totalFees = rows.reduce((s, r) => s + sheetNum(r.ML_Fee), 0);
    const totalShipping = rows.reduce((s, r) => s + sheetNum(r.Shipping_Cost), 0);
    const totalProfit = rows.reduce((s, r) => s + sheetNum(r.Net_Profit), 0);
    $('sheet-sales-stats').innerHTML = `
      <div class="stat-card green"><div class="stat-lbl">Ingresos</div><div class="stat-val">$${fmt(totalRevenue)}</div><div class="stat-sub">${rows.length} órdenes</div></div>
      <div class="stat-card red"><div class="stat-lbl">Comisiones ML</div><div class="stat-val">$${fmt(totalFees)}</div><div class="stat-sub">${totalRevenue > 0 ? pct(totalFees / totalRevenue * 100) : '—'}</div></div>
      <div class="stat-card orange"><div class="stat-lbl">Envíos</div><div class="stat-val">$${fmt(totalShipping)}</div><div class="stat-sub">${totalRevenue > 0 ? pct(totalShipping / totalRevenue * 100) : '—'}</div></div>
      <div class="stat-card navy"><div class="stat-lbl">Profit Neto</div><div class="stat-val">$${fmt(totalProfit)}</div><div class="stat-sub">${totalRevenue > 0 ? pct(totalProfit / totalRevenue * 100) : '—'}</div></div>
    `;

    if (rows.length === 0) {
      el.innerHTML = emptyHtml('📭',
        sheetSales.length === 0 ? 'Sin ventas registradas en el Sheet. Las ventas aparecerán aquí cuando cargues órdenes de ML.'
          : 'Ninguna venta coincide con los filtros.');
      return;
    }

    el.innerHTML = '<table class="data-table"><thead><tr>' +
      '<th>Orden</th><th>Item</th><th>Title</th><th>Precio</th><th>ML Fee</th>' +
      '<th>Envío</th><th>Profit</th><th>Buyer</th><th>Fecha</th><th>Estado</th>' +
      '</tr></thead><tbody>' +
      rows.map(s => {
        const profit = sheetNum(s.Net_Profit);
        const profitColor = profit > 0 ? 'var(--ml-green)' : 'var(--ml-red)';
        return '<tr>' +
          '<td><code>' + escapeHtml(s.Order_ID || '') + '</code></td>' +
          '<td><code>' + escapeHtml(s.Item_ID || '') + '</code></td>' +
          '<td style="font-weight:600;">' + escapeHtml((s.Title || '').substring(0, 40)) + '</td>' +
          '<td><b>$' + fmt(sheetNum(s.Sale_Price)) + '</b></td>' +
          '<td style="color:var(--ml-red);">$' + fmt(sheetNum(s.ML_Fee)) + '</td>' +
          '<td style="color:var(--ml-orange);">$' + fmt(sheetNum(s.Shipping_Cost)) + '</td>' +
          '<td style="color:' + profitColor + ';font-weight:700;">$' + fmt(profit) + '</td>' +
          '<td>' + escapeHtml(s.Buyer_Nickname || '') + '</td>' +
          '<td style="font-size:11px;">' + (s.Sale_Date ? escapeHtml(new Date(s.Sale_Date).toLocaleString('es-VE')) : '—') + '</td>' +
          '<td>' + escapeHtml(s.Status || '—') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  async function loadSheetSales() {
    if (!config.gsheetsUrl) { sheetSales = []; renderSheetSales(); return; }
    sheetSales.__loading = true;
    renderSheetSales();
    try {
      const res = await sheetsGet('sales');
      sheetSales = (res && res.success && Array.isArray(res.rows)) ? res.rows : [];
    } catch (e) {
      sheetSales = [];
      showToast('❌ ' + e.message, 'error');
    }
    sheetSales.__loading = false;
    renderSheetSales();
  }

  function wireSheetTabs() {
    $('btn-refresh-sheet-opps')?.addEventListener('click', loadSheetOpps);
    $('sheet-opp-filter')?.addEventListener('input', renderSheetOpps);
    $('sheet-opp-status-filter')?.addEventListener('change', renderSheetOpps);
    $('sheet-opp-sort')?.addEventListener('change', renderSheetOpps);

    $('btn-refresh-sheet-pub')?.addEventListener('click', loadSheetPub);
    $('sheet-pub-filter')?.addEventListener('input', renderSheetPub);
    $('sheet-pub-sort')?.addEventListener('change', renderSheetPub);

    $('btn-refresh-sheet-sales')?.addEventListener('click', loadSheetSales);
    $('sheet-sales-filter')?.addEventListener('input', renderSheetSales);
    $('sheet-sales-status-filter')?.addEventListener('change', renderSheetSales);
    $('sheet-sales-sort')?.addEventListener('change', renderSheetSales);
  }

  /* ======================================================================
   * Tab router
   * ====================================================================== */
  function renderTab(tab) {
    switch (tab) {
      case 'overview': renderOverview(); break;
      case 'publications': populateFilters(); renderPublications(); break;
      case 'sellers': renderSellers(); break;
      case 'categories': renderCategories(); break;
      case 'opportunities': renderOpportunities(); break;
      case 'sheet_opps': renderSheetOpps(); loadSheetOpps(); break;
      case 'sheet_published': renderSheetPub(); loadSheetPub(); break;
      case 'sheet_sales': renderSheetSales(); loadSheetSales(); break;
      case 'tools': renderTools(); break;
      case 'trends': renderTrends(); break;
      case 'integrations': renderIntegrations(); break;
      case 'config': renderConfig(); break;
    }
  }

  /* ======================================================================
   * CSV exports
   * ====================================================================== */
  function buildProductRows(arr) {
    const headers = ['ID', 'Nombre', 'Precio', 'Moneda', 'Score', 'Opiniones', 'Ventas', 'Visitas',
      'EnvioGratis', 'Vendedor', 'Vendedor_Estatus', 'Vendedor_Seguidores', 'Vendedor_Productos',
      'Vendedor_Ventas', 'Vendedor_Recomendacion', 'Vendedor_AniosML', 'Vendedor_Link',
      'Ubicacion', 'Categoria', 'Subcategorias', 'Marca', 'Modelo', 'Especificaciones',
      'CategoryId', 'SellerId', 'Imagen', 'Link', 'Google_Breakout_Vendedor', 'DeepExtracted'];
    const rows = [headers];
    arr.forEach(p => {
      rows.push([
        p.id || '', p.Nombre || '', p.Precio_Numerico || '', p.Moneda || '',
        p.Score || '', p.Opiniones || '', p.Ventas || '', p.Visitas || '',
        p.EnvioGratis ? 'Sí' : 'No',
        p.Vendedor_Nombre || '', p.Vendedor_Estatus || '', p.Vendedor_Seguidores || '',
        p.Vendedor_Productos || '', p.Vendedor_Ventas || '', p.Vendedor_Recomendacion || '',
        p.Vendedor_AniosML || '', p.Vendedor_Link || '',
        p.Ubicacion || '', p.Categoria || '',
        Array.isArray(p.Subcategorias) ? p.Subcategorias.join(' / ') : (p.Subcategorias || ''),
        p.Marca || '', p.Modelo || '',
        typeof p.Especificaciones === 'object' ? JSON.stringify(p.Especificaciones) : (p.Especificaciones || ''),
        p.CategoryId || '', p.SellerId || '',
        p.Imagen || '', p.Link || '', p.Google_Breakout_Vendedor || '',
        p.DeepExtracted ? 'Sí' : 'No'
      ]);
    });
    return rows;
  }

  function exportProductsCSV(arr, filename) {
    const rows = buildProductRows(arr);
    downloadCSV(filename || 'ml-products.csv', rows);
  }

  function exportPublishedCSV() {
    const headers = ['OriginalId', 'NewId', 'Title', 'Price', 'Permalink', 'PublishedAt'];
    const rows = [headers, ...publishedProducts.map(p => [
      p.originalId || '', p.newId || '', p.title || '', p.price || '', p.permalink || '', p.publishedAt || ''
    ])];
    downloadCSV('ml-published.csv', rows);
  }

  function exportA1CSV() {
    const a1 = computeA1Scores();
    const headers = ['Rank', 'Nombre', 'Score', 'Demanda', 'Apertura', 'Calidad', 'PrecioRazonable', 'CatHot', 'Ventas', 'Precio', 'Vendedor', 'Categoria'];
    const rows = [headers, ...a1.slice(0, 50).map((r, i) => [
      i + 1, r.product.Nombre || '', r.score.toFixed(2),
      (r.components.demand * 100).toFixed(1) + '%',
      (r.components.openness * 100).toFixed(1) + '%',
      (r.components.quality * 5).toFixed(2),
      (r.components.priceReasonable * 100).toFixed(1) + '%',
      (r.components.catHot * 100).toFixed(1) + '%',
      r.product.Ventas || 0, r.product.Precio_Numerico || 0,
      r.product.Vendedor_Nombre || '', categoryPath(r.product)
    ])];
    downloadCSV('ml-a1-opportunities.csv', rows);
  }

  /* ======================================================================
   * Quick action buttons (topbar)
   * ====================================================================== */
  function wireTopbar() {
    $('btn-refresh').addEventListener('click', async () => {
      $('loading').style.display = 'block';
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      await loadData();
      $('loading').style.display = 'none';
      $('tab-overview').style.display = 'block';
      renderOverview();
      showToast('✅ Datos refrescados');
    });

    $('btn-sync-sheets').addEventListener('click', async () => {
      if (!config.gsheetsUrl) { showToast('❌ Configura primero la URL de Google Sheets'); return; }
      showToast('⏳ Sincronizando…');
      const r = await sendMessage({ action: 'SYNC_TO_SHEETS' });
      if (r && r.success) showToast(`✅ ${r.appended || 0} nuevos, ${r.updated || 0} actualizados`);
      else showToast('❌ ' + (r && r.error ? r.error : 'Error al sincronizar'));
    });

    $('btn-export-csv').addEventListener('click', () => {
      if (products.length === 0) { showToast('❌ No hay productos para exportar'); return; }
      exportProductsCSV(products, 'ml-products-all.csv');
      showToast(`📥 ${products.length} productos exportados`);
    });

    $('btn-clear-data').addEventListener('click', async () => {
      if (!confirm('¿Borrar TODOS los productos crawleados? Esta acción no se puede deshacer.')) return;
      await chrome.storage.local.set({ ml_products: [] });
      products = [];
      const active = document.querySelector('.nav-item.active');
      if (active) renderTab(active.dataset.tab);
      showToast('🗑 Todos los productos eliminados');
    });

    $('btn-open-scraper').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://listado.mercadolibre.com.ve/' });
    });
  }

  /* ======================================================================
   * Filter + dynamic event wiring
   * ====================================================================== */
  function wireFilters() {
    const onChange = () => { pubPage = 0; renderPublications(); };
    $('pub-filter')?.addEventListener('input', onChange);
    $('pub-filter-seller')?.addEventListener('change', onChange);
    $('pub-filter-city')?.addEventListener('change', onChange);
    $('pub-filter-cat')?.addEventListener('change', onChange);
    $('pub-sort')?.addEventListener('change', onChange);
    $('btn-clear-filters').addEventListener('click', () => {
      $('pub-filter').value = '';
      $('pub-filter-seller').value = '';
      $('pub-filter-city').value = '';
      $('pub-filter-cat').value = '';
      $('pub-sort').value = 'sales_desc';
      pubPage = 0;
      renderPublications();
    });
    $('btn-export-filtered').addEventListener('click', () => {
      const arr = lastFiltered.length > 0 ? lastFiltered : products;
      if (arr.length === 0) { showToast('❌ No hay productos para exportar'); return; }
      exportProductsCSV(arr, 'ml-products-filtered.csv');
      showToast(`📥 ${arr.length} productos exportados`);
    });
    $('btn-export-published').addEventListener('click', () => {
      if (publishedProducts.length === 0) { showToast('❌ No hay publicaciones'); return; }
      exportPublishedCSV();
    });
    $('btn-clear-published').addEventListener('click', async () => {
      if (!confirm('¿Borrar TODOS los productos publicados de la lista?')) return;
      await chrome.storage.local.set({ ml_published_products: [] });
      publishedProducts = [];
      renderPublications();
      showToast('🗑 Lista de publicaciones limpiada');
    });
  }

  function wireDynamicClicks() {
    // Category deep dive (clickable bars/rows)
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-cat-dive]');
      if (el) {
        const cat = el.dataset.catDive;
        // Switch to categories tab and select
        const navItem = document.querySelector('.nav-item[data-tab="categories"]');
        if (navItem && !document.querySelector('.nav-item.active[data-tab="categories"]')) {
          navItem.click();
        }
        const sel = $('cat-deep-select');
        if (sel) { sel.value = cat; renderCategoryDeepDive(cat); }
        // Scroll to deep dive card
        const deepCard = document.querySelector('#cat-deep-content');
        if (deepCard) deepCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    // Price comparison select
    $('price-comp-select')?.addEventListener('change', (e) => renderPriceComparison(e.target.value));
    // Category deep dive select
    $('cat-deep-select')?.addEventListener('change', (e) => renderCategoryDeepDive(e.target.value));
    // Export A1
    $('btn-export-a1')?.addEventListener('click', exportA1CSV);
  }

  /* ======================================================================
   * Live updates via chrome.storage.onChanged
   * ====================================================================== */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needRefresh = false;
    if (changes.ml_products) {
      products = Array.isArray(changes.ml_products.newValue) ? changes.ml_products.newValue : [];
      needRefresh = true;
    }
    if (changes.ml_published_products) {
      publishedProducts = Array.isArray(changes.ml_published_products.newValue) ? changes.ml_published_products.newValue : [];
      needRefresh = true;
    }
    if (changes.ml_webhooks) {
      config.webhooks = Array.isArray(changes.ml_webhooks.newValue) ? changes.ml_webhooks.newValue : [];
      // If user is on integrations tab, refresh webhooks
      if (document.querySelector('.nav-item.active[data-tab="integrations"]')) renderWebhooks();
    }
    if (changes.ml_access_token) config.accessToken = changes.ml_access_token.newValue || '';
    if (changes.ml_gsheets_url) config.gsheetsUrl = changes.ml_gsheets_url.newValue || '';
    if (changes.ml_sell_markup) config.sellMarkup = changes.ml_sell_markup.newValue || '20';

    if (needRefresh) {
      const activeTab = document.querySelector('.nav-item.active');
      if (activeTab) renderTab(activeTab.dataset.tab);
    }
  });

  /* ======================================================================
   * Boot
   * ====================================================================== */
  async function boot() {
    await loadData();
    $('loading').style.display = 'none';
    $('tab-overview').style.display = 'block';
    renderOverview();
  }

  wireTopbar();
  wireFilters();
  wireDynamicClicks();
  wireSheetTabs();
  document.addEventListener('DOMContentLoaded', boot);
})();
