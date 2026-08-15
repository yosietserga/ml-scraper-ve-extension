/**
 * Google Apps Script — ML Scraper VE → Google Sheets Sync
 * =========================================================================
 *
 * INSTRUCCIONES DE INSTALACIÓN:
 *
 * 1. Abre tu Google Sheet:
 *    https://docs.google.com/spreadsheets/d/1DesPY4WR1mbgRGTG_xRbrW4UZJq84KVnMnn-qNgzVjg/edit
 *
 * 2. Ve a: Extensiones → Apps Script
 *
 * 3. Borra todo el código que hay y pega este archivo completo.
 *
 * 4. Clic en "Implementar" → "Nueva implementación"
 *    - Tipo: "Aplicación web"
 *    - Descripción: "ML Scraper Sync"
 *    - Quién puede acceder: "Cualquiera"
 *    - Qué puede hacer la app: "Editor"
 *
 * 5. Autoriza los permisos cuando Google te lo pida.
 *
 * 6. Copia la URL de la aplicación web (algo como
 *    https://script.google.com/macros/s/AKfyc.../exec)
 *
 * 7. Pega esa URL en la extensión:
 *    Panel → Filtros & Config → "Google Sheets Web App URL"
 *
 * 8. Listo! Ahora cada vez que hagas "Sync to Sheets" en la extensión,
 *    los productos se envían a este sheet, evitando duplicados por MLV id.
 * =========================================================================
 */

// Your sheet ID (already known)
var SHEET_ID = '1DesPY4WR1mbgRGTG_xRbrW4UZJq84KVnMnn-qNgzVjg';
var SHEET_NAME = 'Hoja 1'; // Change if your sheet tab has a different name

// Column order — MUST match the CSV headers from the extension
var HEADERS = [
  'MLV_ID',
  'Nombre', 'Precio_Numerico', 'Score', 'Opiniones', 'Ventas_Estimadas',
  'Visitas_10dias',
  'EnvioGratis',
  'Vendedor_Nombre', 'Vendedor_Estatus',
  'Vendedor_Seguidores', 'Vendedor_Productos', 'Vendedor_Ventas',
  'Vendedor_Recomendacion', 'Vendedor_AniosML', 'Vendedor_Link',
  'Ubicacion_Tienda',
  'Categoria', 'Subcategorias', 'Categorias',
  'Marca', 'Modelo', 'Especificaciones',
  'Category_Id', 'Seller_Id', 'Nordic_Attributes', 'All_Pictures',
  'Imagen', 'Link_Producto', 'Google_Breakout_Vendedor',
  'DeepExtracted', 'Synced_At'
];

/**
 * Handles GET requests.
 * ?action=data → returns all rows as JSON array (for the Next.js webapp)
 * (no params) → returns connection status
 */
function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action ? e.parameter.action : '';

    if (action === 'data') {
      // Return all product data as JSON array — for the Next.js webapp
      var sheet = getSheet();
      var lastRow = sheet.getLastRow();
      var lastCol = sheet.getLastColumn();
      if (lastRow < 2) {
        return jsonOut({ success: true, products: [], count: 0 });
      }
      var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      var products = [];
      for (var i = 0; i < values.length; i++) {
        var row = values[i];
        var obj = {};
        for (var j = 0; j < HEADERS.length && j < row.length; j++) {
          obj[HEADERS[j]] = row[j];
        }
        products.push(obj);
      }
      return jsonOut({ success: true, products: products, count: products.length });
    }

    // Default: connection status
    var sheet = getSheet();
    var lastRow = sheet.getLastRow();
    return jsonOut({
      success: true,
      message: 'Connected',
      rows: lastRow > 1 ? lastRow - 1 : 0,
      headers: HEADERS
    });
  } catch (err) {
    return jsonOut({ success: false, error: err.toString() });
  }
}

/**
 * Handles POST requests — receives product data from the extension.
 * Body: { action: 'sync', products: [...], mode: 'append_new'|'update_all' }
 *
 * Deduplication: checks column A (MLV_ID) — if it exists, updates the row;
 * if not, appends a new row.
 */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (!data || !data.products || !Array.isArray(data.products)) {
      return jsonOut({ success: false, error: 'No products array in request' });
    }

    var sheet = getSheet();
    ensureHeaders(sheet);

    var existingIds = getExistingIds(sheet);
    var appended = 0;
    var updated = 0;
    var skipped = 0;

    for (var i = 0; i < data.products.length; i++) {
      var p = data.products[i];
      var mlvId = p.id || extractMlvId(p.Link) || '';
      if (!mlvId) { skipped++; continue; }

      var row = productToRow(p, mlvId);

      if (existingIds.indexOf(mlvId) !== -1) {
        // Update existing row
        var rowNum = findRowById(sheet, mlvId);
        if (rowNum > 0) {
          sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
          updated++;
        } else {
          skipped++;
        }
      } else {
        // Append new row
        sheet.appendRow(row);
        existingIds.push(mlvId);
        appended++;
      }
    }

    return jsonOut({
      success: true,
      appended: appended,
      updated: updated,
      skipped: skipped,
      total: data.products.length
    });
  } catch (err) {
    return jsonOut({ success: false, error: err.toString() });
  }
}

/**
 * Clears all data (except headers) — called when user wants a fresh sync.
 * Body: { action: 'clear' }
 */
function clearSheet() {
  var sheet = getSheet();
  ensureHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
  }
}

// --- Helpers ---

function getSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.getSheets()[0];
  }
  return sheet;
}

function ensureHeaders(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0 || !sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0][0]) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    // Format header row
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#3483fa').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
}

function getExistingIds(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var flat = [];
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0]) flat.push(String(ids[i][0]));
  }
  return flat;
}

function findRowById(sheet, mlvId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(mlvId)) return i + 2;
  }
  return -1;
}

function productToRow(p, mlvId) {
  var now = new Date().toISOString();
  return [
    mlvId,
    p.Nombre || '',
    p.Precio_Numerico || 0,
    p.Score || 0,
    p.Opiniones || 0,
    p.Ventas || 0,
    p.Visitas || 0,
    p.EnvioGratis || 'No',
    p.Vendedor_Nombre || 'N/A',
    p.Vendedor_Estatus || 'N/A',
    p.Vendedor_Seguidores || 'N/A',
    p.Vendedor_Productos || 'N/A',
    p.Vendedor_Ventas || 'N/A',
    p.Vendedor_Recomendacion || 'N/A',
    p.Vendedor_AniosML || 'N/A',
    p.Vendedor_Link || '',
    p.Ubicacion || 'N/A',
    p.Categoria || 'N/A',
    p.Subcategorias || 'N/A',
    p.Categorias || 'N/A',
    p.Marca || 'N/A',
    p.Modelo || 'N/A',
    p.Especificaciones || 'N/A',
    p.CategoryId || '',
    p.SellerId || '',
    p.NordicAttrs ? JSON.stringify(p.NordicAttrs) : '',
    p.AllPictures ? p.AllPictures.join(' ; ') : '',
    p.Imagen || '',
    p.Link || '',
    p.Google_Breakout_Vendedor || '',
    p.DeepExtracted ? 'Sí' : 'No',
    now
  ];
}

function extractMlvId(url) {
  if (!url) return '';
  var m = String(url).match(/MLV[-_]?\d+/i);
  return m ? m[0].replace(/[-_]/g, '').toUpperCase() : '';
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
