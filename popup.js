/* =========================================================================
 * ML Scraper VE — Popup script (v6.0.0)
 * =========================================================================
 * Talks to the background service worker via chrome.runtime.sendMessage
 * and to the active ML tab via chrome.tabs.sendMessage.
 * =========================================================================
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function sendMessage(request) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(request, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { success: false });
        });
      } catch (e) {
        resolve({ success: false, error: String(e) });
      }
    });
  }

  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1800);
  }

  async function refreshStats() {
    const r = await sendMessage({ action: 'GET_ALL_DATA' });
    if (r && r.success !== false) {
      $('stat-products').textContent = (r.products || []).length;
      $('stat-queue').textContent = (r.deepQueue || []).length;
    } else {
      $('stat-products').textContent = '—';
      $('stat-queue').textContent = '—';
    }
  }

  async function getActiveMlTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs.length) return null;
    const t = tabs[0];
    if (!t.url || !/mercadolibre\.com\.ve/i.test(t.url)) return null;
    return t;
  }

  async function sendToActiveTab(action) {
    const tab = await getActiveMlTab();
    if (!tab) {
      toast('Abre una página de MercadoLibre VE primero');
      return false;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { action });
      return true;
    } catch (e) {
      toast('Esta pestaña no tiene el scraper activo');
      return false;
    }
  }

  $('btn-analysis').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('analysis.html') });
  });

  $('btn-show').addEventListener('click', async () => {
    const ok = await sendToActiveTab('SHOW_PANEL');
    if (ok) {
      // Persist visible state too so other tabs converge.
      await sendMessage({ action: 'SET_PANEL_VISIBLE', visible: true });
      toast('Panel mostrado');
    }
  });

  $('btn-hide').addEventListener('click', async () => {
    const ok = await sendToActiveTab('HIDE_PANEL');
    if (ok) {
      await sendMessage({ action: 'SET_PANEL_VISIBLE', visible: false });
      toast('Panel oculto');
    }
  });

  $('btn-export').addEventListener('click', async () => {
    const r = await sendMessage({ action: 'EXPORT_CSV' });
    if (!r || !r.success || !r.products || r.products.length === 0) {
      toast('No hay productos para exportar');
      return;
    }
    // Generate CSV here in the popup context (has DOM access).
    const headers = [
      'Nombre', 'Precio_Numerico', 'Moneda', 'Precio_Detallado', 'Score', 'Ventas_Estimadas',
      'EnvioGratis', 'Vendedor_Nombre', 'Vendedor_Estatus', 'Ubicacion_Tienda',
      'Categorias', 'Marca', 'Modelo', 'Especificaciones', 'Imagen', 'Link_Producto', 'Google_Breakout_Vendedor'
    ];
    const cell = (v) => '"' + (v === null || v === undefined ? '' : String(v)).replace(/"/g, '""') + '"';
    const rows = r.products.map((p) => [
      cell(p.Nombre), cell(p.Precio_Numerico || 0), cell(p.Moneda || 'N/A'),
      cell(p.Precio_Detallado || ''), cell(p.Score || 0), cell(p.Ventas || 0),
      cell(p.EnvioGratis || 'No'), cell(p.Vendedor_Nombre || 'N/A'),
      cell(p.Vendedor_Estatus || 'N/A'), cell(p.Ubicacion || 'N/A'),
      cell(p.Categorias || 'N/A'), cell(p.Marca || 'N/A'), cell(p.Modelo || 'N/A'),
      cell(p.Especificaciones || 'N/A'), cell(p.Imagen || ''), cell(p.Link || ''),
      cell(p.Google_Breakout_Vendedor || '')
    ].join(','));
    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ML_VE_ExtensionExport_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Exportados ${r.products.length} productos`);
  });

  $('btn-clear').addEventListener('click', async () => {
    if (!confirm('¿Borrar TODOS los productos y la cola de extracción? Esta acción no se puede deshacer.')) return;
    const r = await sendMessage({ action: 'CLEAR_ALL' });
    toast(r && r.success ? 'Datos borrados' : 'Error al borrar');
    refreshStats();
  });

  // Live refresh while popup is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    refreshStats();
  });

  refreshStats();
})();
