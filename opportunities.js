/* =========================================================================
 * opportunities.js — Mobile-friendly opportunity capture page (v6.18.0)
 * =========================================================================
 *
 * Lets the user capture product opportunities (street scanning, WhatsApp,
 * Instagram, etc.) and pushes them to the meli_opportunities sheet via the
 * Google Apps Script web app.
 *
 * Features:
 *   - Mobile-first form with camera capture (capture="environment")
 *   - Auto-suggest markup → suggested price (cost * (1 + markup/100))
 *   - Offline queue: submissions are stored in localStorage when offline,
 *     and synced automatically when connectivity is restored.
 *   - Photo upload: read as data URL, sent to the script as Photo_URL.
 *     (Apps Script can't accept multipart file uploads from a public web
 *      app, so we base64 the image into the JSON payload. For large photos
 *      we resize client-side to keep the request under 5 MB.)
 *   - Pending opportunities list with filters, "Publicar" buttons that
 *     trigger the Vender flow via window.opener (if launched from the
 *     extension panel) or open the article page on ML.
 *   - Works standalone (just open opportunities.html in any browser).
 * ========================================================================= */
(function () {
  'use strict';

  /* ======================================================================
   * Constants & state
   * ====================================================================== */
  var LS_URL_KEY = 'ml_scraper_opp_gsheets_url';
  var LS_QUEUE_KEY = 'ml_scraper_opp_queue';
  var LS_CATEGORIES_KEY = 'ml_scraper_opp_categories';

  var cfgUrl = '';
  var pendingOpportunities = [];
  var queue = [];        // offline submissions waiting to sync
  var isOnline = navigator.onLine !== false;

  var $ = function (id) { return document.getElementById(id); };

  /* ======================================================================
   * Utility helpers
   * ====================================================================== */
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

  function fmt(n) {
    var x = parseFloat(n);
    if (isNaN(x)) return '0';
    return x.toLocaleString('es-VE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function uuid() {
    return 'opp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  }

  function nowISO() { return new Date().toISOString(); }

  function showToast(msg, kind) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2800);
  }

  /* ======================================================================
   * Config / URL storage
   * ====================================================================== */
  function loadUrl() {
    try { cfgUrl = localStorage.getItem(LS_URL_KEY) || ''; } catch (e) { cfgUrl = ''; }
    var input = $('cfg-url');
    if (input && cfgUrl) input.value = cfgUrl;
    updateConnBadge();
  }

  function saveUrl() {
    var v = ($('cfg-url').value || '').trim();
    cfgUrl = v;
    try { localStorage.setItem(LS_URL_KEY, v); } catch (e) {}
    setFeedback('cfg-feedback', '✅ URL guardada.', 'success');
    showToast('URL guardada', 'success');
    updateConnBadge();
    fetchOpportunities();
  }

  function updateConnBadge() {
    var el = $('opp-connection');
    if (!el) return;
    if (!cfgUrl) {
      el.textContent = '● Sin configurar';
      el.className = 'conn-badge inactive';
      el.title = 'Pega la URL del Apps Script en Configuración';
      return;
    }
    if (!isOnline) {
      el.textContent = '● Sin internet';
      el.className = 'conn-badge inactive';
      el.title = 'Sin conexión a internet';
      return;
    }
    el.textContent = '● Listo';
    el.className = 'conn-badge active';
    el.title = 'Conectado a Google Sheets';
  }

  function setFeedback(id, msg, kind) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'form-feedback' + (kind ? ' ' + kind : '');
  }

  /* ======================================================================
   * Network — POST helper (text/plain body to avoid CORS preflight on Apps Script)
   * ====================================================================== */
  function postJSON(payload) {
    if (!cfgUrl) {
      return Promise.reject(new Error('Falta la URL del Apps Script. Configúrala arriba.'));
    }
    return fetch(cfgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text().then(function (text) {
        var trimmed = (text || '').trim();
        // Detect HTML response (consent / login page)
        if (trimmed.charAt(0) === '<' || trimmed.indexOf('<html') !== -1 || trimmed.indexOf('<!DOCTYPE') !== -1) {
          throw new Error('Google devolvió HTML (sesión caducada o implementación inválida). Re-autoriza el Apps Script.');
        }
        try { return JSON.parse(trimmed); }
        catch (e) { throw new Error('Respuesta no es JSON: ' + trimmed.substring(0, 100)); }
      });
    });
  }

  function getJSON(params) {
    if (!cfgUrl) {
      return Promise.reject(new Error('Falta la URL del Apps Script.'));
    }
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    });
    var url = cfgUrl + (cfgUrl.indexOf('?') === -1 ? '?' : '&') + qs.join('&');
    return fetch(url, { method: 'GET' })
      .then(function (res) { return res.text(); })
      .then(function (text) {
        var trimmed = (text || '').trim();
        if (trimmed.charAt(0) === '<' || trimmed.indexOf('<html') !== -1) {
          throw new Error('Google devolvió HTML (sesión caducada). Re-autoriza el Apps Script.');
        }
        try { return JSON.parse(trimmed); }
        catch (e) { throw new Error('Respuesta no es JSON: ' + trimmed.substring(0, 100)); }
      });
  }

  /* ======================================================================
   * Photo capture — read as resized JPEG data URL (~640px max edge)
   * ====================================================================== */
  function readPhotoResized(file, maxEdge, quality, cb) {
    if (!file) { cb(''); return; }
    if (typeof FileReader === 'undefined') { cb(''); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      // Try to resize via canvas
      try {
        var img = new Image();
        img.onload = function () {
          var w = img.width || 1, h = img.height || 1;
          var scale = Math.min(1, maxEdge / Math.max(w, h));
          var cw = Math.round(w * scale), ch = Math.round(h * scale);
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, cw, ch);
          var out = canvas.toDataURL('image/jpeg', quality);
          cb(out);
        };
        img.onerror = function () { cb(dataUrl); };
        img.src = dataUrl;
      } catch (e) {
        cb(dataUrl);
      }
    };
    reader.onerror = function () { cb(''); };
    reader.readAsDataURL(file);
  }

  /* ======================================================================
   * Form — submit / reset
   * ====================================================================== */
  function wireForm() {
    var photoInput = $('opp-photo');
    var photoPick = $('opp-photo-pick');
    var photoPreview = $('opp-photo-preview');
    var photoImg = $('opp-photo-img');
    var photoClear = $('btn-clear-photo');
    var currentPhotoData = '';

    if (photoPick && photoInput) {
      photoPick.addEventListener('click', function () { photoInput.click(); });
    }
    if (photoInput) {
      photoInput.addEventListener('change', function () {
        var f = photoInput.files && photoInput.files[0];
        if (!f) return;
        readPhotoResized(f, 640, 0.78, function (data) {
          currentPhotoData = data;
          if (data) {
            photoImg.src = data;
            photoPreview.hidden = false;
            photoPick.style.display = 'none';
          } else {
            photoPreview.hidden = true;
            photoPick.style.display = '';
          }
        });
      });
    }
    if (photoClear) {
      photoClear.addEventListener('click', function () {
        currentPhotoData = '';
        photoInput.value = '';
        photoImg.src = '';
        photoPreview.hidden = true;
        photoPick.style.display = '';
      });
    }

    // Auto-suggest price from cost + markup
    var costEl = $('opp-cost');
    var markupEl = $('opp-markup');
    var priceEl = $('opp-price');
    function recomputeSuggested() {
      var c = parseFloat(costEl.value);
      var m = parseFloat(markupEl.value);
      if (!isNaN(c) && !isNaN(m)) {
        priceEl.placeholder = (c * (1 + m / 100)).toFixed(2);
      }
    }
    [costEl, markupEl].forEach(function (el) {
      if (el) el.addEventListener('input', recomputeSuggested);
    });

    var form = $('opp-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        submitOpportunity(currentPhotoData);
      });
    }
    var resetBtn = $('btn-reset-opp');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        setTimeout(function () {
          currentPhotoData = '';
          if (photoPreview) photoPreview.hidden = true;
          if (photoPick) photoPick.style.display = '';
        }, 0);
      });
    }

    // Collapsible form / config
    wireCollapsible('btn-toggle-form', 'opp-form', true);
    wireCollapsible('btn-toggle-config', 'config-body', false);
  }

  function wireCollapsible(btnId, bodyId, startOpen) {
    var btn = $(btnId);
    var body = $(bodyId);
    if (!btn || !body) return;
    btn.addEventListener('click', function () {
      var isOpen = !body.hidden;
      body.hidden = isOpen;
      btn.setAttribute('aria-expanded', String(!isOpen));
      btn.textContent = isOpen ? '▸' : '▾';
    });
    if (startOpen) {
      body.hidden = false;
      btn.textContent = '▾';
      btn.setAttribute('aria-expanded', 'true');
    } else {
      body.hidden = true;
      btn.textContent = '▸';
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function buildOpportunityPayload(photoData) {
    var cost = parseFloat($('opp-cost').value);
    var suggested = parseFloat($('opp-price').value);
    var markup = parseFloat($('opp-markup').value);
    if (isNaN(markup)) markup = 20;
    if (isNaN(suggested) && !isNaN(cost) && !isNaN(markup)) {
      suggested = Math.round(cost * (1 + markup / 100) * 100) / 100;
    }
    return {
      Opp_ID: uuid(),
      Product_Name: ($('opp-name').value || '').trim(),
      Photo_URL: photoData || '',
      Estimated_Cost: isNaN(cost) ? 0 : cost,
      Suggested_Price: isNaN(suggested) ? 0 : suggested,
      Markup_Percent: isNaN(markup) ? 20 : markup,
      Category: ($('opp-category').value || '').trim(),
      Brand: ($('opp-brand').value || '').trim(),
      Model: ($('opp-model').value || '').trim(),
      Notes: ($('opp-notes').value || '').trim(),
      Location_Found: ($('opp-location').value || '').trim(),
      Source: $('opp-source').value || 'street',
      Created_At: nowISO(),
      Status: 'pending',
      Published_ID: '',
      Error_Message: ''
    };
  }

  function submitOpportunity(photoData) {
    var name = ($('opp-name').value || '').trim();
    var cost = parseFloat($('opp-cost').value);
    if (!name) {
      setFeedback('opp-form-feedback', '❌ Falta el nombre del producto.', 'error');
      return;
    }
    if (isNaN(cost) || cost < 0) {
      setFeedback('opp-form-feedback', '❌ Falta o es inválido el costo.', 'error');
      return;
    }

    var opp = buildOpportunityPayload(photoData);

    // Add to local list immediately for instant feedback
    pendingOpportunities.unshift(opp);
    renderList();

    var btn = $('btn-submit-opp');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando...'; }

    setFeedback('opp-form-feedback', '⏳ Enviando...', '');

    if (!cfgUrl || !isOnline) {
      // Queue offline
      enqueue(opp);
      setFeedback('opp-form-feedback',
        '💾 Sin conexión — guardado en cola offline. Se sincronizará al volver internet.',
        'error');
      showToast('Guardado offline', 'error');
      resetForm();
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="ic">💾</span> Guardar oportunidad'; }
      return;
    }

    postJSON({ action: 'add_opportunity', opportunity: opp })
      .then(function (res) {
        if (res && res.success) {
          setFeedback('opp-form-feedback', '✅ ¡Oportunidad guardada en el Sheet!', 'success');
          showToast('¡Guardada!', 'success');
          // Update Opp_ID if the server generated a different one
          if (res.opp_id && res.opp_id !== opp.Opp_ID) {
            var idx = pendingOpportunities.indexOf(opp);
            if (idx >= 0) {
              pendingOpportunities[idx].Opp_ID = res.opp_id;
            }
          }
          // Remember category for future datalist suggestions
          rememberCategory(opp.Category);
          resetForm();
          // Refresh list from server to get canonical state
          setTimeout(fetchOpportunities, 300);
        } else {
          throw new Error(res && res.error ? res.error : 'Error desconocido');
        }
      })
      .catch(function (err) {
        // Queue for later retry
        enqueue(opp);
        setFeedback('opp-form-feedback',
          '❌ ' + err.message + ' — guardado en cola offline para reintento.',
          'error');
        showToast('Error — guardado offline', 'error');
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = '<span class="ic">💾</span> Guardar oportunidad'; }
      });
  }

  function resetForm() {
    var form = $('opp-form');
    if (form) form.reset();
    var photoPreview = $('opp-photo-preview');
    var photoPick = $('opp-photo-pick');
    if (photoPreview) photoPreview.hidden = true;
    if (photoPick) photoPick.style.display = '';
    var photoImg = $('opp-photo-img');
    if (photoImg) photoImg.src = '';
  }

  /* ======================================================================
   * Categories — auto-suggest from previously submitted values
   * ====================================================================== */
  function rememberCategory(cat) {
    if (!cat) return;
    try {
      var arr = JSON.parse(localStorage.getItem(LS_CATEGORIES_KEY) || '[]');
      if (arr.indexOf(cat) === -1) {
        arr.push(cat);
        if (arr.length > 100) arr = arr.slice(arr.length - 100);
        localStorage.setItem(LS_CATEGORIES_KEY, JSON.stringify(arr));
      }
      populateCategoryDatalist();
    } catch (e) {}
  }

  function populateCategoryDatalist() {
    var dl = $('opp-categories');
    if (!dl) return;
    var arr;
    try { arr = JSON.parse(localStorage.getItem(LS_CATEGORIES_KEY) || '[]'); }
    catch (e) { arr = []; }
    // Also include categories from already-loaded opportunities
    pendingOpportunities.forEach(function (o) {
      if (o.Category && arr.indexOf(o.Category) === -1) arr.push(o.Category);
    });
    dl.innerHTML = arr.map(function (c) {
      return '<option value="' + escapeAttr(c) + '"></option>';
    }).join('');
  }

  /* ======================================================================
   * Opportunities list — fetch & render
   * ====================================================================== */
  function fetchOpportunities() {
    if (!cfgUrl || !isOnline) {
      renderList();
      return;
    }
    var statusFilter = $('opp-status-filter') ? $('opp-status-filter').value : 'pending';
    var params = { action: 'opportunities' };
    if (statusFilter === 'all') params.all = 'true';

    getJSON(params)
      .then(function (res) {
        if (res && res.success && Array.isArray(res.rows)) {
          pendingOpportunities = res.rows;
        } else {
          pendingOpportunities = [];
        }
        populateCategoryDatalist();
        renderList();
      })
      .catch(function (err) {
        setFeedback('opp-form-feedback', '⚠️ No se pudo cargar la lista: ' + err.message, 'error');
        renderList();
      });
  }

  function getFilteredOpportunities() {
    var q = ($('opp-filter') ? $('opp-filter').value : '').toLowerCase().trim();
    var statusFilter = $('opp-status-filter') ? $('opp-status-filter').value : 'pending';
    return pendingOpportunities.filter(function (o) {
      if (statusFilter !== 'all') {
        var st = String(o.Status || 'pending').toLowerCase();
        if (statusFilter === 'pending' && st !== 'pending' && st !== '') return false;
        if (statusFilter === 'published' && st !== 'published') return false;
        if (statusFilter === 'failed' && st !== 'failed') return false;
      }
      if (!q) return true;
      var hay = [o.Product_Name, o.Brand, o.Model, o.Category, o.Location_Found, o.Notes].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function renderList() {
    var container = $('opp-list');
    if (!container) return;
    var filtered = getFilteredOpportunities();
    var badge = $('opp-count-badge');
    if (badge) badge.textContent = String(filtered.length);

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">' +
        '<div class="empty-ic">📭</div>' +
        '<p>' + (pendingOpportunities.length === 0
          ? 'Sin oportunidades todavía. Captura tu primera arriba.'
          : 'Ninguna oportunidad coincide con el filtro.') +
        '</p></div>';
      return;
    }

    container.innerHTML = filtered.map(function (o, idx) {
      var st = String(o.Status || 'pending').toLowerCase();
      var stBadge = '<span class="status-badge status-' + (st || 'pending') + '">' +
        (st === 'published' ? '✓ Publicada' :
          st === 'failed' ? '✕ Fallida' :
            st === 'publishing' ? '⏳ Publicando' :
              '⏳ Pendiente') + '</span>';
      var photo = o.Photo_URL
        ? '<img class="opp-thumb" src="' + escapeAttr(o.Photo_URL) + '" alt="" />'
        : '<div class="opp-thumb-placeholder">📦</div>';
      var meta = [];
      if (o.Brand) meta.push('<span>🏷 ' + escapeHtml(o.Brand) + (o.Model ? ' ' + escapeHtml(o.Model) : '') + '</span>');
      if (o.Category) meta.push('<span>🗂 ' + escapeHtml(o.Category) + '</span>');
      if (o.Location_Found) meta.push('<span>📍 ' + escapeHtml(o.Location_Found) + '</span>');
      if (o.Source) meta.push('<span class="sep">·</span><span>' + escapeHtml(o.Source) + '</span>');
      var prices = [];
      if (o.Estimated_Cost) prices.push('<span class="cost">Costo $' + fmt(o.Estimated_Cost) + '</span>');
      if (o.Suggested_Price) prices.push('<span class="price">Venta $' + fmt(o.Suggested_Price) + '</span>');
      if (o.Markup_Percent) prices.push('<span class="sep">·</span><span>+' + escapeHtml(o.Markup_Percent) + '%</span>');

      var actions = [];
      if (st === 'pending' || st === '') {
        actions.push('<button class="btn btn-success btn-sm" data-pub="' + escapeAttr(idx) + '">💰 Publicar</button>');
      }
      if (o.Published_ID) {
        actions.push('<button class="btn btn-navy btn-sm" data-view-pub="' + escapeAttr(o.Published_ID) + '">🔗 Ver</button>');
      }
      actions.push('<button class="btn btn-danger btn-sm" data-del="' + escapeAttr(idx) + '" title="Eliminar">🗑</button>');

      return '<div class="opp-item">' +
        photo +
        '<div class="opp-item-body">' +
          '<h3 class="opp-item-title">' + escapeHtml(o.Product_Name || '(sin nombre)') + '</h3>' +
          '<div class="opp-item-meta">' + meta.join('') + '</div>' +
          (prices.length ? '<div class="opp-item-meta">' + prices.join('') + '</div>' : '') +
          '<div class="opp-item-meta">' + stBadge +
            (o.Created_At ? ' <span class="sep">·</span> <span>' + escapeHtml(new Date(o.Created_At).toLocaleString('es-VE')) + '</span>' : '') +
          '</div>' +
          (o.Notes ? '<div class="opp-item-notes">' + escapeHtml(o.Notes) + '</div>' : '') +
          (o.Error_Message && st === 'failed' ? '<div class="opp-item-notes" style="color:var(--ml-red);">⚠ ' + escapeHtml(o.Error_Message) + '</div>' : '') +
          '<div class="opp-item-actions">' + actions.join('') + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    // Wire action buttons
    container.querySelectorAll('[data-pub]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-pub'), 10);
        publishOpportunity(filtered[idx]);
      });
    });
    container.querySelectorAll('[data-view-pub]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-view-pub');
        if (id) window.open('https://articulo.mercadolibre.com.ve/' + id.replace(/^MLV-?/i, 'MLV-'), '_blank', 'noopener');
      });
    });
    container.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-del'), 10);
        deleteOpportunity(filtered[idx]);
      });
    });
  }

  /* ======================================================================
   * Publish / delete actions
   * ====================================================================== */
  function publishOpportunity(opp) {
    if (!opp) return;
    // If we have an opener (launched from extension panel), use it
    if (window.opener && window.opener.publishOpportunityFromSheet) {
      try {
        window.opener.publishOpportunityFromSheet(opp);
        showToast('Abriendo en la extensión...', 'success');
        return;
      } catch (e) {}
    }
    // Otherwise open ML search for the product name so the user can pick
    // the closest match and trigger Vender from the panel.
    var q = encodeURIComponent(opp.Product_Name || '');
    if (q) {
      window.open('https://listado.mercadolibre.com.ve/' + q, '_blank', 'noopener');
      showToast('Busca el producto en ML y usa el botón 💰 Vender.', 'success');
    } else {
      showToast('Falta el nombre del producto.', 'error');
    }
  }

  function deleteOpportunity(opp) {
    if (!opp || !confirm('¿Eliminar esta oportunidad del Sheet?')) return;
    if (!cfgUrl || !isOnline) {
      showToast('Sin conexión — intenta más tarde.', 'error');
      return;
    }
    // Mark as deleted locally while we wait for server response
    postJSON({
      action: 'update_opportunity',
      id: opp.Opp_ID,
      status: 'deleted',
      error: 'Deleted by user'
    }).then(function (res) {
      if (res && res.success) {
        pendingOpportunities = pendingOpportunities.filter(function (o) { return o.Opp_ID !== opp.Opp_ID; });
        renderList();
        showToast('Eliminada', 'success');
      } else {
        throw new Error(res && res.error ? res.error : 'Error al eliminar');
      }
    }).catch(function (err) {
      showToast('❌ ' + err.message, 'error');
    });
  }

  /* ======================================================================
   * Offline queue (localStorage)
   * ====================================================================== */
  function enqueue(opp) {
    try {
      queue.push(opp);
      localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {}
    renderQueue();
  }

  function loadQueue() {
    try {
      var raw = localStorage.getItem(LS_QUEUE_KEY);
      queue = raw ? JSON.parse(raw) : [];
    } catch (e) { queue = []; }
    renderQueue();
  }

  function renderQueue() {
    var card = $('queue-card');
    if (!card) return;
    if (queue.length === 0) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    var cnt = $('queue-count');
    if (cnt) cnt.textContent = String(queue.length);
    var list = $('queue-list');
    if (list) {
      list.innerHTML = queue.map(function (o, i) {
        return '<div class="opp-item">' +
          '<div class="opp-thumb-placeholder">📦</div>' +
          '<div class="opp-item-body">' +
            '<h3 class="opp-item-title">' + escapeHtml(o.Product_Name || '(sin nombre)') + '</h3>' +
            '<div class="opp-item-meta"><span>$' + fmt(o.Estimated_Cost) + '</span>' +
              (o.Location_Found ? ' <span class="sep">·</span> <span>' + escapeHtml(o.Location_Found) + '</span>' : '') +
            '</div>' +
            '<div class="opp-item-actions">' +
              '<button class="btn btn-danger btn-sm" data-qdel="' + i + '">Quitar</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
      list.querySelectorAll('[data-qdel]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = parseInt(btn.getAttribute('data-qdel'), 10);
          queue.splice(idx, 1);
          try { localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(queue)); } catch (e) {}
          renderQueue();
        });
      });
    }
  }

  function syncQueue() {
    if (queue.length === 0) return;
    if (!cfgUrl || !isOnline) {
      showToast('Sin conexión.', 'error');
      return;
    }
    var total = queue.length;
    var ok = 0, fail = 0;
    var remaining = queue.slice();
    var next = function () {
      if (remaining.length === 0) {
        if (fail === 0) {
          showToast('✅ ' + ok + '/' + total + ' sincronizadas', 'success');
        } else {
          showToast(ok + ' OK, ' + fail + ' fallidas', 'error');
        }
        renderQueue();
        fetchOpportunities();
        return;
      }
      var opp = remaining.shift();
      postJSON({ action: 'add_opportunity', opportunity: opp })
        .then(function () { ok++; queue = queue.filter(function (q) { return q.Opp_ID !== opp.Opp_ID; }); })
        .catch(function () { fail++; })
        .then(next);
    };
    next();
  }

  function clearQueue() {
    if (!confirm('¿Borrar TODAS las oportunidades de la cola offline?')) return;
    queue = [];
    try { localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(queue)); } catch (e) {}
    renderQueue();
    showToast('Cola borrada', 'success');
  }

  /* ======================================================================
   * Online/offline listeners
   * ====================================================================== */
  function wireConnectivity() {
    window.addEventListener('online', function () {
      isOnline = true;
      updateConnBadge();
      showToast('🔌 En línea — sincronizando...', 'success');
      syncQueue();
      fetchOpportunities();
    });
    window.addEventListener('offline', function () {
      isOnline = false;
      updateConnBadge();
      showToast('📴 Sin internet — guardando en cola.', 'error');
    });
  }

  /* ======================================================================
   * Wire-up + boot
   * ====================================================================== */
  function wireAll() {
    wireForm();
    wireConnectivity();

    var saveBtn = $('btn-save-url');
    if (saveBtn) saveBtn.addEventListener('click', saveUrl);

    var testBtn = $('btn-test-url');
    if (testBtn) testBtn.addEventListener('click', function () {
      var v = ($('cfg-url').value || '').trim();
      if (!v) { setFeedback('cfg-feedback', '❌ Pega una URL primero.', 'error'); return; }
      cfgUrl = v;
      setFeedback('cfg-feedback', '⏳ Probando...', '');
      getJSON({ action: 'data' })
        .then(function (res) {
          if (res && res.success !== undefined) {
            setFeedback('cfg-feedback', '✅ Conexión OK — hoja responde.', 'success');
            try { localStorage.setItem(LS_URL_KEY, v); } catch (e) {}
            updateConnBadge();
          } else {
            throw new Error('Respuesta inesperada');
          }
        })
        .catch(function (err) {
          setFeedback('cfg-feedback', '❌ ' + err.message, 'error');
        });
    });

    var refreshBtn = $('btn-refresh-opps');
    if (refreshBtn) refreshBtn.addEventListener('click', fetchOpportunities);

    var filterInput = $('opp-filter');
    if (filterInput) filterInput.addEventListener('input', renderList);

    var statusFilter = $('opp-status-filter');
    if (statusFilter) statusFilter.addEventListener('change', fetchOpportunities);

    var syncQueueBtn = $('btn-sync-queue');
    if (syncQueueBtn) syncQueueBtn.addEventListener('click', syncQueue);

    var clearQueueBtn = $('btn-clear-queue');
    if (clearQueueBtn) clearQueueBtn.addEventListener('click', clearQueue);

    // Auto-trigger initial fetch (silently)
    setTimeout(function () {
      if (cfgUrl && isOnline) fetchOpportunities();
      else renderList();
    }, 100);
  }

  function boot() {
    loadUrl();
    loadQueue();
    populateCategoryDatalist();
    wireAll();
    // Try to fetch on boot if online & configured
    if (cfgUrl && isOnline) fetchOpportunities();
    // Expose hook for the extension panel to call us
    window.mlOpportunities = {
      refresh: fetchOpportunities,
      publish: publishOpportunity
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
