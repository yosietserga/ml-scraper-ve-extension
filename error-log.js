/* =========================================================================
 * ML Scraper VE — Error Log Page (v6.5.0)
 * =========================================================================
 * Reads the persisted error log from chrome.storage.local and displays it
 * in a full-page format with filtering and export.
 * =========================================================================
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'ml_error_log';
  let allEntries = [];

  const $ = (id) => document.getElementById(id);

  function classifyType(type) {
    if (!type) return 'other';
    const t = type.toUpperCase();
    if (t.indexOf('HTTP 4') !== -1 || t.indexOf('HTTP 5') !== -1) return 'http-4xx';
    if (t.indexOf('HTTP 5') !== -1) return 'http-5xx';
    if (t.indexOf('PARSE') !== -1) return 'parse';
    if (t.indexOf('VISIT') !== -1) return 'visit';
    if (t.indexOf('DEEP') !== -1) return 'deep';
    if (t.indexOf('CSV') !== -1) return 'csv';
    if (t.indexOf('REDIRECT') !== -1) return 'redirect';
    return 'other';
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTs(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return d.toLocaleString('es-VE');
    } catch (e) { return ts; }
  }

  async function loadLog() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      allEntries = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
    } catch (e) {
      allEntries = [];
    }
    render();
  }

  function render() {
    const container = $('log-container');
    const filterText = ($('filter-text').value || '').toLowerCase();
    const filterType = $('filter-type').value;
    const showInfo = $('show-info').checked;

    let entries = allEntries.slice().reverse(); // newest first

    // v6.6.0: filter by info/warn/error level
    if (!showInfo) {
      entries = entries.filter((e) => (e.level || 'info') !== 'info');
    }

    if (filterText) {
      entries = entries.filter((e) =>
        (e.message || '').toLowerCase().indexOf(filterText) !== -1 ||
        (e.type || '').toLowerCase().indexOf(filterText) !== -1
      );
    }

    if (filterType) {
      entries = entries.filter((e) => {
        const cls = classifyType(e.type);
        const level = e.level || 'info';
        if (filterType === 'INFO') return level === 'info';
        if (filterType === 'WARN') return level === 'warn';
        if (filterType === 'ERROR') return level === 'error';
        if (filterType === 'CRAWL') return e.type && e.type.toUpperCase().indexOf('CRAWL') !== -1;
        if (filterType === 'DEEP') return e.type && e.type.toUpperCase().indexOf('DEEP') !== -1;
        if (filterType === 'PARSE') return cls === 'parse' || (e.type && e.type.toUpperCase().indexOf('PARSE') !== -1);
        if (filterType === 'VISIT') return cls === 'visit';
        if (filterType === 'HTTP') return cls === 'http-4xx' || cls === 'http-5xx';
        if (filterType === 'MERGE') return e.type && e.type.toUpperCase().indexOf('MERGE') !== -1;
        return true;
      });
    }

    // Update stats
    const stats = $('log-stats');
    if (allEntries.length === 0) {
      stats.innerHTML = '<span style="color:#4caf50;">✓ Sin errores registrados</span>';
    } else {
      const counts = {};
      for (const e of allEntries) {
        const c = classifyType(e.type);
        counts[c] = (counts[c] || 0) + 1;
      }
      const parts = [];
      if (counts['http-4xx'] || counts['http-5xx']) parts.push(`HTTP: ${(counts['http-4xx']||0)+(counts['http-5xx']||0)}`);
      if (counts['parse']) parts.push(`PARSE: ${counts['parse']}`);
      if (counts['visit']) parts.push(`VISIT: ${counts['visit']}`);
      if (counts['deep']) parts.push(`DEEP: ${counts['deep']}`);
      if (counts['csv']) parts.push(`CSV: ${counts['csv']}`);
      if (counts['redirect']) parts.push(`REDIR: ${counts['redirect']}`);
      if (counts['other']) parts.push(`OTHER: ${counts['other']}`);
      stats.innerHTML = `${allEntries.length} entradas total — ${parts.join(' · ')}`;
    }

    if (entries.length === 0) {
      container.innerHTML = allEntries.length === 0
        ? '<div class="empty"><h2>✓ Sin errores registrados</h2><p>El scraper está funcionando sin fallos.<br>Cuando ocurran errores HTTP 4xx/5xx, fallos de selectores, o problemas de extracción, aparecerán aquí.</p></div>'
        : '<div class="empty"><p>No hay entradas que coincidan con el filtro.</p></div>';
      return;
    }

    container.innerHTML = entries.map((e) => {
      const cls = classifyType(e.type);
      const level = e.level || 'info';
      const ts = formatTs(e.ts);
      const type = escapeHtml(e.type || 'UNKNOWN');
      const msg = escapeHtml(e.message || '');
      return `<div class="log-entry ${cls} level-${level}">
        <span class="log-ts">${escapeHtml(ts)}</span>
        <span class="log-type ${cls} level-${level}">[${type}]</span>
        ${msg}
      </div>`;
    }).join('');
  }

  function clearLog() {
    if (!confirm('¿Borrar todas las entradas del log de errores?')) return;
    allEntries = [];
    chrome.storage.local.set({ [STORAGE_KEY]: [] }, () => {
      render();
    });
  }

  function exportTxt() {
    if (allEntries.length === 0) { alert('No hay entradas para exportar.'); return; }
    const lines = allEntries.map((e) => {
      const ts = formatTs(e.ts);
      return `[${ts}] [${e.type || 'UNKNOWN'}] ${e.message || ''}`;
    });
    const text = lines.join('\n') + '\n';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ML_VE_ErrorLog_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Live update: listen for storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      allEntries = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
      render();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    $('btn-refresh').addEventListener('click', loadLog);
    $('btn-clear').addEventListener('click', clearLog);
    $('btn-export').addEventListener('click', exportTxt);
    $('filter-text').addEventListener('input', render);
    $('filter-type').addEventListener('change', render);
    $('show-info').addEventListener('change', render);  // v6.6.0
    loadLog();
  });
})();
