/* =========================================================================
 * ML Dashboard — Logic (v6.15.0)
 * =========================================================================
 * Full-page management dashboard for the ML Scraper VE extension.
 * Reads from chrome.storage.local (same data as the in-page panel).
 * Does NOT modify the existing modal — purely additive.
 * =========================================================================
 */

(function () {
  'use strict';

  let products = [];
  let publishedProducts = [];
  let config = {};

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(n, dec) {
    if (dec === undefined) dec = 2;
    if (typeof n !== 'number' || isNaN(n)) return '—';
    return n.toLocaleString('es-VE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
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

  // ---- Data loading ----
  async function loadData() {
    const data = await chrome.storage.local.get(['ml_products', 'ml_published_products', 'ml_access_token', 'ml_gsheets_url', 'ml_sell_markup', 'ml_webhooks']);
    products = Array.isArray(data.ml_products) ? data.ml_products : [];
    publishedProducts = Array.isArray(data.ml_published_products) ? data.ml_published_products : [];
    config = {
      accessToken: data.ml_access_token || '',
      gsheetsUrl: data.ml_gsheets_url || '',
      sellMarkup: data.ml_sell_markup || '20',
      webhooks: Array.isArray(data.ml_webhooks) ? data.ml_webhooks : []
    };
  }

  // ---- Tab switching ----
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

  // ---- Overview Tab ----
  function renderOverview() {
    const totalProducts = products.length;
    const extracted = products.filter(p => p.DeepExtracted && p.Vendedor_Nombre && p.Vendedor_Nombre !== 'Pendiente' && p.Vendedor_Nombre !== 'N/A');
    const totalVisits = products.reduce((s, p) => s + (p.Visitas || 0), 0);
    const totalSales = products.reduce((s, p) => s + (p.Ventas || 0), 0);
    const avgScore = extracted.length > 0 ? extracted.reduce((s, p) => s + (p.Score || 0), 0) / extracted.length : 0;
    const avgPrice = products.length > 0 ? products.reduce((s, p) => s + (p.Precio_Numerico || 0), 0) / products.length : 0;
    const uniqueSellers = new Set(extracted.map(p => p.Vendedor_Nombre)).size;
    const totalPublished = publishedProducts.length;

    $('overview-stats').innerHTML = `
      <div class="stat-card blue"><div class="stat-val">${totalProducts}</div><div class="stat-lbl">Productos Crawleados</div></div>
      <div class="stat-card green"><div class="stat-val">${extracted.length}</div><div class="stat-lbl">Deep Extracted</div></div>
      <div class="stat-card"><div class="stat-val">${totalPublished}</div><div class="stat-lbl">Publicados (Vender)</div></div>
      <div class="stat-card orange"><div class="stat-val">${fmt(totalVisits, 0)}</div><div class="stat-lbl">Visitas Totales</div></div>
      <div class="stat-card green"><div class="stat-val">${fmt(totalSales, 0)}</div><div class="stat-lbl">Ventas Estimadas</div></div>
      <div class="stat-card"><div class="stat-val">${fmt(avgScore, 1)}</div><div class="stat-lbl">Score Promedio</div></div>
      <div class="stat-card"><div class="stat-val">$${fmt(avgPrice)}</div><div class="stat-lbl">Precio Promedio</div></div>
      <div class="stat-card blue"><div class="stat-val">${uniqueSellers}</div><div class="stat-lbl">Vendedores Únicos</div></div>
    `;

    // Top by sales
    const topSales = [...products].sort((a, b) => (b.Ventas || 0) - (a.Ventas || 0)).slice(0, 10);
    $('overview-top-sales').innerHTML = topSales.map((p, i) => `
      <div class="list-item">
        <span class="list-rank ${i < 3 ? ['gold','silver','bronze'][i] : 'normal'}">${i + 1}</span>
        <div class="list-info"><div class="list-title">${escapeHtml((p.Nombre || '').substring(0, 50))}</div>
        <div class="list-meta">$${fmt(p.Precio_Numerico)} · ★ ${fmt(p.Score, 1)} · ${escapeHtml(p.Vendedor_Nombre || 'N/A')}</div></div>
        <span class="list-val">${fmt(p.Ventas, 0)} vendidos</span>
      </div>`).join('');

    // Top by visits
    const topVisits = [...products].filter(p => p.Visitas > 0).sort((a, b) => (b.Visitas || 0) - (a.Visitas || 0)).slice(0, 10);
    $('overview-top-visits').innerHTML = topVisits.length > 0 ? topVisits.map((p, i) => `
      <div class="list-item">
        <span class="list-rank ${i < 3 ? ['gold','silver','bronze'][i] : 'normal'}">${i + 1}</span>
        <div class="list-info"><div class="list-title">${escapeHtml((p.Nombre || '').substring(0, 50))}</div>
        <div class="list-meta">$${fmt(p.Precio_Numerico)} · ${escapeHtml(p.Vendedor_Nombre || 'N/A')}</div></div>
        <span class="list-val">👁 ${fmt(p.Visitas, 0)}</span>
      </div>`).join('') : '<p style="color:#888;font-size:12px;">Sin datos de visitas. Ejecuta deep extraction.</p>';

    // Top sellers
    const sellerMap = new Map();
    extracted.forEach(p => {
      const name = p.Vendedor_Nombre;
      if (name && name !== 'N/A') sellerMap.set(name, (sellerMap.get(name) || 0) + 1);
    });
    const topSellers = [...sellerMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const maxSeller = topSellers.length > 0 ? topSellers[0][1] : 1;
    $('overview-top-sellers').innerHTML = topSellers.map(([name, count]) => `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(name.substring(0, 18))}</span>
        <div class="bar-track"><div class="bar-fill blue" style="width:${(count / maxSeller * 100).toFixed(1)}%"></div></div>
        <span class="bar-value">${count}</span>
      </div>`).join('');

    // Cities
    const cityMap = new Map();
    extracted.forEach(p => {
      const city = (p.Ubicacion || '').split(',')[0].trim();
      if (city && city !== 'N/A' && city !== 'No especificada') cityMap.set(city, (cityMap.get(city) || 0) + 1);
    });
    const topCities = [...cityMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const maxCity = topCities.length > 0 ? topCities[0][1] : 1;
    $('overview-cities').innerHTML = topCities.map(([name, count]) => `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(name.substring(0, 18))}</span>
        <div class="bar-track"><div class="bar-fill green" style="width:${(count / maxCity * 100).toFixed(1)}%"></div></div>
        <span class="bar-value">${count}</span>
      </div>`).join('');

    // Price distribution
    const ranges = [
      { label: '$0-10', min: 0, max: 10 },
      { label: '$10-25', min: 10, max: 25 },
      { label: '$25-50', min: 25, max: 50 },
      { label: '$50-100', min: 50, max: 100 },
      { label: '$100-250', min: 100, max: 250 },
      { label: '$250+', min: 250, max: Infinity }
    ];
    const priceDist = ranges.map(r => ({ ...r, count: products.filter(p => (p.Precio_Numerico || 0) >= r.min && (p.Precio_Numerico || 0) < r.max).length }));
    const maxPrice = Math.max(...priceDist.map(r => r.count), 1);
    $('overview-price-dist').innerHTML = priceDist.map(r => `
      <div class="bar-row">
        <span class="bar-label">${r.label}</span>
        <div class="bar-track"><div class="bar-fill orange" style="width:${(r.count / maxPrice * 100).toFixed(1)}%"></div></div>
        <span class="bar-value">${r.count}</span>
      </div>`).join('');
  }

  // ---- Publications Tab ----
  function renderPublications() {
    // Published products (from Vender)
    if (publishedProducts.length === 0) {
      $('publications-list').innerHTML = '<p style="color:#888;font-size:12px;">No has publicado productos todavía. Usa el botón 💰 Vender en cualquier producto.</p>';
    } else {
      $('publications-list').innerHTML = publishedProducts.map(p => `
        <div class="list-item">
          <div class="list-info">
            <div class="list-title">${escapeHtml(p.title || '')}</div>
            <div class="list-meta">Original: ${p.originalId || 'N/A'} → Nuevo: ${p.newId || 'N/A'} · $${fmt(p.price || 0)} · ${new Date(p.publishedAt || Date.now()).toLocaleDateString('es-VE')}</div>
          </div>
          ${p.permalink ? `<a href="${escapeHtml(p.permalink)}" target="_blank" class="btn btn-secondary" style="padding:4px 8px;font-size:10px;">🔗 Ver</a>` : ''}
        </div>`).join('');
    }

    // All products
    const filterText = ($('pub-filter')?.value || '').toLowerCase();
    const sortVal = $('pub-sort')?.value || 'sales_desc';
    let filtered = products.filter(p => (p.Nombre || '').toLowerCase().indexOf(filterText) !== -1);
    if (sortVal === 'sales_desc') filtered.sort((a, b) => (b.Ventas || 0) - (a.Ventas || 0));
    else if (sortVal === 'visits_desc') filtered.sort((a, b) => (b.Visitas || 0) - (a.Visitas || 0));
    else if (sortVal === 'price_desc') filtered.sort((a, b) => (b.Precio_Numerico || 0) - (a.Precio_Numerico || 0));
    else if (sortVal === 'price_asc') filtered.sort((a, b) => (a.Precio_Numerico || 0) - (b.Precio_Numerico || 0));
    else if (sortVal === 'score_desc') filtered.sort((a, b) => (b.Score || 0) - (a.Score || 0));

    const visible = filtered.slice(0, 100);
    $('all-products-list').innerHTML = `
      <p style="font-size:11px;color:#888;">Mostrando ${visible.length} de ${filtered.length} productos</p>
      ${visible.map(p => {
        const isExtracted = p.DeepExtracted && p.Vendedor_Nombre && p.Vendedor_Nombre !== 'Pendiente' && p.Vendedor_Nombre !== 'N/A';
        return `<div class="list-item">
          <div class="list-info">
            <div class="list-title">${escapeHtml((p.Nombre || '').substring(0, 60))} ${isExtracted ? '✅' : ''}</div>
            <div class="list-meta">$${fmt(p.Precio_Numerico)} · ★ ${fmt(p.Score, 1)} · +${p.Ventas || 0} vendidos · ${escapeHtml(p.Vendedor_Nombre || 'N/A')} · ${escapeHtml(p.Ubicacion || 'N/A')}</div>
          </div>
          ${p.Visitas > 0 ? `<span style="font-size:11px;color:#ad1457;font-weight:700;">👁 ${fmt(p.Visitas, 0)}</span>` : ''}
        </div>`;
      }).join('')}
    `;
  }

  // ---- Metrics Tab ----
  function renderMetrics() {
    const extracted = products.filter(p => p.DeepExtracted);
    const totalVisits = products.reduce((s, p) => s + (p.Visitas || 0), 0);
    const totalSales = products.reduce((s, p) => s + (p.Ventas || 0), 0);
    const totalReviews = products.reduce((s, p) => s + (p.Opiniones || 0), 0);
    const avgConversion = totalVisits > 0 ? (totalSales / totalVisits * 100) : 0;
    const avgScore = extracted.length > 0 ? extracted.reduce((s, p) => s + (p.Score || 0), 0) / extracted.length : 0;

    $('metrics-stats').innerHTML = `
      <div class="stat-card orange"><div class="stat-val">${fmt(totalVisits, 0)}</div><div class="stat-lbl">Visitas Totales</div></div>
      <div class="stat-card green"><div class="stat-val">${fmt(totalSales, 0)}</div><div class="stat-lbl">Ventas Estimadas</div></div>
      <div class="stat-card"><div class="stat-val">${fmt(totalReviews, 0)}</div><div class="stat-lbl">Opiniones Totales</div></div>
      <div class="stat-card blue"><div class="stat-val">${fmt(avgConversion, 2)}%</div><div class="stat-lbl">Conversión (Visitas→Ventas)</div></div>
      <div class="stat-card"><div class="stat-val">${fmt(avgScore, 2)}</div><div class="stat-lbl">Score Promedio</div></div>
    `;

    // Demand metrics
    const byCategory = new Map();
    extracted.forEach(p => {
      const cat = p.Categoria || 'N/A';
      const data = byCategory.get(cat) || { products: 0, sales: 0, visits: 0 };
      data.products++; data.sales += (p.Ventas || 0); data.visits += (p.Visitas || 0);
      byCategory.set(cat, data);
    });
    const sortedCats = [...byCategory.entries()].sort((a, b) => b[1].sales - a[1].sales);
    $('metrics-demand').innerHTML = sortedCats.slice(0, 15).map(([cat, data]) => {
      const conv = data.visits > 0 ? (data.sales / data.visits * 100).toFixed(1) : '0';
      return `<div class="bar-row">
        <span class="bar-label">${escapeHtml(cat.substring(0, 15))}</span>
        <div class="bar-track"><div class="bar-fill blue" style="width:${Math.min(100, data.sales / (sortedCats[0][1].sales || 1) * 100).toFixed(1)}%"></div></div>
        <span class="bar-value">${data.products}p · ${data.sales}v · ${conv}%</span>
      </div>`;
    }).join('');

    // Score distribution
    const scoreBuckets = { '5.0': 0, '4.8-4.9': 0, '4.5-4.7': 0, '4.0-4.4': 0, '<4.0': 0 };
    extracted.forEach(p => {
      const s = p.Score || 0;
      if (s >= 5.0) scoreBuckets['5.0']++;
      else if (s >= 4.8) scoreBuckets['4.8-4.9']++;
      else if (s >= 4.5) scoreBuckets['4.5-4.7']++;
      else if (s >= 4.0) scoreBuckets['4.0-4.4']++;
      else scoreBuckets['<4.0']++;
    });
    const maxScore = Math.max(...Object.values(scoreBuckets), 1);
    $('metrics-scores').innerHTML = Object.entries(scoreBuckets).map(([label, count]) => `
      <div class="bar-row">
        <span class="bar-label">${label}</span>
        <div class="bar-track"><div class="bar-fill green" style="width:${(count / maxScore * 100).toFixed(1)}%"></div></div>
        <span class="bar-value">${count}</span>
      </div>`).join('');

    // Categories
    $('metrics-categories').innerHTML = sortedCats.slice(0, 10).map(([cat, data]) => `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(cat.substring(0, 15))}</span>
        <div class="bar-track"><div class="bar-fill blue" style="width:${(data.products / (sortedCats[0][1].products || 1) * 100).toFixed(1)}%"></div></div>
        <span class="bar-value">${data.products}</span>
      </div>`).join('');

    // Sellers
    const sellerStats = new Map();
    extracted.forEach(p => {
      const name = p.Vendedor_Nombre;
      if (!name || name === 'N/A') return;
      const s = sellerStats.get(name) || { products: 0, sales: 0, score: 0 };
      s.products++; s.sales += (p.Ventas || 0); s.score += (p.Score || 0);
      sellerStats.set(name, s);
    });
    const topSellerStats = [...sellerStats.entries()].sort((a, b) => b[1].sales - a[1].sales).slice(0, 10);
    $('metrics-sellers').innerHTML = topSellerStats.map(([name, s]) => `
      <div class="list-item">
        <div class="list-info"><div class="list-title">${escapeHtml(name)}</div>
        <div class="list-meta">${s.products} productos · ★ ${fmt(s.score / s.products, 1)} · ${escapeHtml(s.sales + ' ventas')}</div></div>
        <span class="list-val">${s.sales}</span>
      </div>`).join('');
  }

  // ---- Trends Tab ----
  function renderTrends() {
    const extracted = products.filter(p => p.DeepExtracted);
    const totalVisits = products.reduce((s, p) => s + (p.Visitas || 0), 0);
    const totalSales = products.reduce((s, p) => s + (p.Ventas || 0), 0);
    const avgConversion = totalVisits > 0 ? (totalSales / totalVisits * 100) : 0;

    // Latent demand: high visits, low sales
    const latentDemand = extracted.filter(p => (p.Visitas || 0) > 0).filter(p => {
      const visits = p.Visitas || 0;
      const sales = p.Ventas || 0;
      const conv = visits > 0 ? sales / visits : 0;
      return conv < 0.05 && visits > 100;
    }).sort((a, b) => (b.Visitas || 0) - (a.Visitas || 0));

    // Price trends
    const avgPrice = products.length > 0 ? products.reduce((s, p) => s + (p.Precio_Numerico || 0), 0) / products.length : 0;
    const priceStd = Math.sqrt(products.reduce((s, p) => s + Math.pow((p.Precio_Numerico || 0) - avgPrice, 2), 0) / (products.length || 1));
    const priceCV = avgPrice > 0 ? priceStd / avgPrice : 0;

    // Seller concentration (HHI)
    const sellerMap = new Map();
    extracted.forEach(p => {
      const name = p.Vendedor_Nombre;
      if (name && name !== 'N/A') sellerMap.set(name, (sellerMap.get(name) || 0) + 1);
    });
    const totalSellers = sellerMap.size;
    const sellerShares = [...sellerMap.values()].map(c => c / extracted.length);
    const hhi = sellerShares.reduce((s, sh) => s + sh * sh, 0);

    let trends = [];
    trends.push({
      type: 'success', title: '📈 Proyección de Demanda',
      body: `Con ${fmt(totalVisits, 0)} visitas totales en los últimos 10 días y una tasa de conversión del ${fmt(avgConversion, 2)}%, el mercado proyecta <b>${Math.round(totalVisits * 0.1)} visitas/día</b> y <b>${Math.round(totalSales / 10)} ventas/día</b> en esta categoría.`
    });

    if (latentDemand.length > 0) {
      trends.push({
        type: 'warning', title: `💡 Demanda Latente (${latentDemand.length} productos)`,
        body: `Productos con muchas visitas pero pocas ventas (conversión < 5%). Estos representan oportunidades de mejora: copiar el producto, mejorar el listing (fotos, descripción, precio) y capturar la demanda existente.<br><br>Top 3:<br>${latentDemand.slice(0, 3).map(p => `• ${escapeHtml((p.Nombre || '').substring(0, 40))} — ${fmt(p.Visitas, 0)} visitas, ${p.Ventas || 0} ventas`).join('<br>')}`
      });
    }

    trends.push({
      type: hhi < 0.15 ? 'success' : hhi < 0.25 ? 'warning' : 'danger',
      title: `🏪 Concentración de Mercado (HHI: ${fmt(hhi, 4)})`,
      body: `${hhi < 0.15 ? 'Mercado fragmentado — baja barrera de entrada, múltiples competidores.' : hhi < 0.25 ? 'Concentración media — algunos vendedores dominantes.' : 'Alta concentración — pocos vendedores controlan el mercado.'} ${totalSellers} vendedores únicos detectados.`
    });

    trends.push({
      type: priceCV > 0.6 ? 'warning' : 'success',
      title: `💰 Análisis de Precios (CV: ${fmt(priceCV, 2)})`,
      body: `Precio promedio: <b>$${fmt(avgPrice)}</b>. ${priceCV > 0.6 ? 'Alta variación de precios — opportunity para posicionar productos en rangos específicos.' : 'Precios estables — mercado maduro con poca variación.'}`
    });

    $('trends-content').innerHTML = trends.map(t => `
      <div class="trend-card ${t.type}">
        <div class="trend-title">${t.title}</div>
        <div class="trend-body">${t.body}</div>
      </div>`).join('');

    // Opportunities
    const opportunities = [];
    // Opportunity 1: High sales + good score + not dominant seller
    const goodProducts = extracted.filter(p => (p.Ventas || 0) > 200 && (p.Score || 0) >= 4.5)
      .sort((a, b) => (b.Ventas || 0) - (a.Ventas || 0)).slice(0, 10);
    if (goodProducts.length > 0) {
      opportunities.push({
        title: `🎯 Productos de Alta Demanda (${goodProducts.length})`,
        body: `Productos con +200 ventas y score ≥ 4.5. Son los mejores candidatos para copiar y revender:<br><br>${goodProducts.slice(0, 5).map((p, i) => `${i + 1}. ${escapeHtml((p.Nombre || '').substring(0, 40))} — $${fmt(p.Precio_Numerico)}, ${p.Ventas || 0} ventas`).join('<br>')}`
      });
    }
    // Opportunity 2: Blue ocean categories
    const catMap = new Map();
    extracted.forEach(p => {
      const cat = p.Categoria || 'N/A';
      const s = catMap.get(cat) || { products: 0, sellers: new Set() };
      s.products++; if (p.Vendedor_Nombre) s.sellers.add(p.Vendedor_Nombre);
      catMap.set(cat, s);
    });
    const blueOceans = [...catMap.entries()].filter(([cat, s]) => s.products > 5 && s.sellers.size <= 3)
      .sort((a, b) => b[1].products - a[1].products);
    if (blueOceans.length > 0) {
      opportunities.push({
        title: `🌊 Océanos Azul (${blueOceans.length})`,
        body: `Categorías con alta demanda pero pocos vendedores (≤3). Oportunidad de entrada sin competencia:<br><br>${blueOceans.slice(0, 5).map(([cat, s]) => `• ${escapeHtml(cat)}: ${s.products} productos, ${s.sellers.size} vendedores`).join('<br>')}`
      });
    }
    $('trends-opportunities').innerHTML = opportunities.length > 0 ? opportunities.map(o => `
      <div class="trend-card success"><div class="trend-title">${o.title}</div><div class="trend-body">${o.body}</div></div>`).join('') : '<p style="color:#888;">Analiza más productos para detectar oportunidades.</p>';

    // Risks
    const risks = [];
    if (hhi > 0.25) risks.push({ title: '⚠️ Mercado Concentrado', body: 'Pocos vendedores dominan. Difícil ganar cuota de mercado sin diferenciación.' });
    if (avgConversion < 0.02) risks.push({ title: '⚠️ Baja Conversión', body: `Tasa de conversión del ${fmt(avgConversion, 2)}% — la gente mira pero no compra. Revisar precios, calidad del listing, o competencia.` });
    if (priceCV > 0.8) risks.push({ title: '⚠️ Precios Volátiles', body: 'Alta variación de precios indica guerra de precios o productos heterogéneos.' });
    $('trends-risks').innerHTML = risks.length > 0 ? risks.map(r => `
      <div class="trend-card danger"><div class="trend-title">${r.title}</div><div class="trend-body">${r.body}</div></div>`).join('') : '<p style="color:#00a650;">✅ No se detectaron riesgos significativos.</p>';
  }

  // ---- Config Tab ----
  function renderConfig() {
    $('config-general').innerHTML = `
      <div class="config-item">
        <label>ML API Access Token</label>
        <input type="password" id="cfg-token" value="${escapeHtml(config.accessToken)}" placeholder="APP_USR-...">
        <div class="hint-small">Requerido para Vender + Visitas API</div>
      </div>
      <div class="config-item">
        <label>Google Sheets Web App URL</label>
        <input type="text" id="cfg-gsheets" value="${escapeHtml(config.gsheetsUrl)}" placeholder="https://script.google.com/macros/s/...">
        <div class="hint-small">URL del Apps Script desplegado</div>
      </div>
      <div class="config-actions">
        <button class="btn btn-primary" id="btn-save-config">💾 Guardar</button>
      </div>
    `;
    $('config-sell').innerHTML = `
      <div class="config-item">
        <label>Markup de Venta (%)</label>
        <input type="number" id="cfg-markup" value="${escapeHtml(config.sellMarkup)}" step="5">
        <div class="hint-small">Porcentaje añadido al precio original al Vender</div>
      </div>
      <div class="config-actions">
        <button class="btn btn-primary" id="btn-save-sell">💾 Guardar</button>
      </div>
    `;
    $('config-automation').innerHTML = `
      <div class="config-item">
        <label>Auto Deep Extract al terminar crawl</label>
        <select id="cfg-auto-deep"><option value="false">No</option><option value="true" selected>Sí</option></select>
      </div>
      <div class="config-item">
        <label>Auto Sync Sheets al terminar</label>
        <select id="cfg-auto-sync"><option value="false">No</option><option value="true" selected>Sí</option></select>
      </div>
      <div class="config-actions">
        <button class="btn btn-primary" id="btn-save-automation">💾 Guardar</button>
      </div>
    `;
    // Wire save buttons
    $('btn-save-config').onclick = async () => {
      await chrome.storage.local.set({ ml_access_token: $('cfg-token').value, ml_gsheets_url: $('cfg-gsheets').value });
      showToast('Configuración guardada');
    };
    $('btn-save-sell').onclick = async () => {
      await chrome.storage.local.set({ ml_sell_markup: $('cfg-markup').value });
      showToast('Configuración de venta guardada');
    };
    $('btn-save-automation').onclick = async () => {
      await chrome.storage.local.set({ ml_auto_deep: $('cfg-auto-deep').value === 'true', ml_auto_sync: $('cfg-auto-sync').value === 'true' });
      showToast('Automatización guardada');
    };
  }

  // ---- Integrations Tab ----
  function renderIntegrations() {
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
    $('integration-api').innerHTML = `
      <div class="config-item">
        <label>Token de ML API</label>
        <div class="webhook-status ${config.accessToken ? 'active' : 'inactive'}">${config.accessToken ? '✅ Configurado' : '❌ No configurado'}</div>
      </div>
      <div class="config-item">
        <label>Verificar Token</label>
        <button class="btn btn-secondary" id="btn-verify-token" style="font-size:11px;">Verificar /users/me</button>
        <div id="token-verify-result" style="font-size:10px;margin-top:4px;"></div>
      </div>
    `;
    $('btn-verify-token').onclick = async () => {
      $('token-verify-result').textContent = 'Verificando…';
      const r = await sendMessage({ action: 'FETCH_SELLER', sellerId: 'me' });
      // Actually we need /users/me — let's do it directly
      try {
        const token = config.accessToken;
        const res = await fetch('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json();
        if (data.nickname) {
          $('token-verify-result').innerHTML = `✅ ${data.nickname} (ID: ${data.id}, Site: ${data.site_id})`;
        } else {
          $('token-verify-result').innerHTML = `❌ ${data.message || data.error || 'Token inválido'}`;
        }
      } catch (e) {
        $('token-verify-result').innerHTML = `❌ ${e.message}`;
      }
    };

    // Webhooks
    renderWebhooks();
    $('btn-add-webhook').onclick = () => {
      config.webhooks.push({ url: '', name: '', events: ['sell'], active: true });
      chrome.storage.local.set({ ml_webhooks: config.webhooks });
      renderWebhooks();
    };
  }

  function renderWebhooks() {
    if (config.webhooks.length === 0) {
      $('webhooks-list').innerHTML = '<p style="color:#888;font-size:12px;">No hay webhooks configurados.</p>';
      return;
    }
    $('webhooks-list').innerHTML = config.webhooks.map((wh, i) => `
      <div class="webhook-item">
        <input type="text" placeholder="Nombre (ej: Slack #ventas)" value="${escapeHtml(wh.name || '')}" data-wh-idx="${i}" data-wh-field="name">
        <input type="text" placeholder="URL (https://hooks.slack.com/...)" value="${escapeHtml(wh.url || '')}" data-wh-idx="${i}" data-wh-field="url">
        <div class="webhook-row">
          <span class="webhook-status ${wh.active ? 'active' : 'inactive'}">${wh.active ? 'Activo' : 'Inactivo'}</span>
          <button class="btn btn-secondary" data-wh-toggle="${i}" style="font-size:10px;padding:4px 8px;">${wh.active ? 'Desactivar' : 'Activar'}</button>
          <button class="btn btn-danger" data-wh-del="${i}" style="font-size:10px;padding:4px 8px;">Eliminar</button>
        </div>
      </div>`).join('');
    // Wire inputs
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
  }

  // ---- Tab router ----
  function renderTab(tab) {
    switch (tab) {
      case 'overview': renderOverview(); break;
      case 'publications': renderPublications(); break;
      case 'metrics': renderMetrics(); break;
      case 'trends': renderTrends(); break;
      case 'config': renderConfig(); break;
      case 'integrations': renderIntegrations(); break;
    }
  }

  // ---- Toast ----
  function showToast(msg) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2000);
  }

  // ---- Buttons ----
  $('btn-refresh').addEventListener('click', async () => {
    $('loading').style.display = 'block';
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    await loadData();
    $('loading').style.display = 'none';
    $('tab-overview').style.display = 'block';
    renderOverview();
  });

  $('btn-sync-sheets').addEventListener('click', async () => {
    showToast('Sincronizando…');
    const r = await sendMessage({ action: 'SYNC_TO_SHEETS' });
    if (r && r.success) showToast(`✅ ${r.appended} nuevos, ${r.updated} actualizados`);
    else showToast('❌ ' + (r?.error || 'Error'));
  });

  $('btn-open-scraper').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://listado.mercadolibre.com.ve/' });
  });

  $('pub-filter')?.addEventListener('input', renderPublications);
  $('pub-sort')?.addEventListener('change', renderPublications);

  // ---- Listen for storage changes (live updates) ----
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ml_products) {
      products = Array.isArray(changes.ml_products.newValue) ? changes.ml_products.newValue : [];
      const activeTab = document.querySelector('.nav-item.active');
      if (activeTab) renderTab(activeTab.dataset.tab);
    }
  });

  // ---- Boot ----
  async function boot() {
    await loadData();
    $('loading').style.display = 'none';
    $('tab-overview').style.display = 'block';
    renderOverview();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
