/**
 * Google Apps Script — ML Scraper VE → Google Sheets Multi-Sheet DB (v6.18.0)
 * =========================================================================
 *
 * TRANSFORMS THE SHEET FROM A SINGLE-TAB DUMP INTO A 6-SHEET BIDIRECTIONAL
 * DATABASE. ENABLES NEW APPS: OPPORTUNITY SCANNER, SALES TRACKER, PRICE
 * MONITOR, SUPPLIER CRM, PUBLISHED MANAGER.
 *
 * SHEETS (auto-created if missing):
 *
 *   1. meli_crawled_data   — products from the crawler (renamed from "Hoja 1")
 *   2. meli_published      — products published via the Vender button
 *   3. meli_opportunities  — products to publish (street scanning, OSINT, ...)
 *   4. meli_sales          — sales tracking (orders from ML)
 *   5. meli_price_history  — price monitoring over time
 *   6. meli_suppliers      — supplier CRM (contacts found via OSINT)
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
 *    - Descripción: "ML Scraper Multi-Sheet v6.18"
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
 * 8. Listo! Las 6 hojas se crean automáticamente al primer request.
 *    Si tienes una hoja llamada "Hoja 1" con datos previos, se renombra a
 *    "meli_crawled_data" automáticamente.
 * =========================================================================
 */

// Your sheet ID (already known)
var SHEET_ID = '1DesPY4WR1mbgRGTG_xRbrW4UZJq84KVnMnn-qNgzVjg';

// Legacy single-sheet name (for the rename migration)
var LEGACY_SHEET_NAME = 'Hoja 1';

/* =========================================================================
 * Sheet schemas — column definitions for each of the 6 sheets
 * ========================================================================= */

// Keep the existing HEADERS array for meli_crawled_data — MUST NOT change
// (the extension's CSV export, content.js productToRow, etc. all expect this).
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

// Map of all sheets → their column schemas.
// crawled_data uses HEADERS verbatim (back-compat with existing extension).
// Other sheets have their own column sets defined per the v6.18.0 spec.
var SHEET_SCHEMAS = {
  meli_crawled_data: HEADERS,
  meli_published: [
    'Published_ID', 'Original_ID', 'Title', 'Price', 'Markup_Percent',
    'Currency', 'Category_Id', 'Permalink', 'Published_At', 'Status',
    'Views_30d', 'Sales_30d', 'Last_Updated'
  ],
  meli_opportunities: [
    'Opp_ID', 'Product_Name', 'Photo_URL', 'Estimated_Cost', 'Suggested_Price',
    'Markup_Percent', 'Category', 'Brand', 'Model', 'Notes', 'Location_Found',
    'Source', 'Created_At', 'Status', 'Published_ID', 'Error_Message'
  ],
  meli_sales: [
    'Order_ID', 'Item_ID', 'Title', 'Sale_Price', 'ML_Fee', 'Net_Profit',
    'Buyer_Nickname', 'Sale_Date', 'Status', 'Shipping_Cost', 'Shipping_Type'
  ],
  meli_price_history: [
    'MLV_ID', 'Check_Date', 'Price', 'Score', 'Sales_Count', 'Visits', 'Seller_Name'
  ],
  meli_suppliers: [
    'Supplier_ID', 'Name', 'Phone', 'WhatsApp', 'Instagram', 'RIF',
    'City', 'Products_Offered', 'Rating', 'Notes', 'Last_Contacted',
    'ML_Seller_Name', 'Google_Search_URL'
  ]
};

// Ordered list — used to ensure sheets appear in the right tab order.
var SHEET_ORDER = [
  'meli_crawled_data',
  'meli_published',
  'meli_opportunities',
  'meli_sales',
  'meli_price_history',
  'meli_suppliers'
];

/* =========================================================================
 * GET — read from any sheet
 *
 * Endpoints:
 *   ?action=data                       → meli_crawled_data (back-compat)
 *   ?action=published                  → meli_published
 *   ?action=opportunities             → meli_opportunities (status=pending only)
 *   ?action=opportunities&all=true    → all opportunities regardless of status
 *   ?action=sales                      → meli_sales
 *   ?action=suppliers                  → meli_suppliers
 *   ?action=sheet&name=XXX             → any sheet by name
 *   (no params)                        → connection status + sheet inventory
 * ========================================================================= */
function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action ? e.parameter.action : '';
    var params = (e && e.parameter) || {};

    if (action === 'data') {
      return jsonOut(readSheet('meli_crawled_data', { keyField: 'MLV_ID' }));
    }
    if (action === 'published') {
      return jsonOut(readSheet('meli_published', { keyField: 'Published_ID' }));
    }
    if (action === 'opportunities') {
      var allFlag = params.all && String(params.all).toLowerCase() === 'true';
      var result = readSheet('meli_opportunities', { keyField: 'Opp_ID' });
      if (!allFlag && result.success && Array.isArray(result.rows)) {
        result.rows = result.rows.filter(function (r) {
          var st = String(r.Status || '').toLowerCase();
          return st === '' || st === 'pending' || st === 'pendiente';
        });
        result.count = result.rows.length;
        result.filtered = 'pending';
      }
      return jsonOut(result);
    }
    if (action === 'sales') {
      return jsonOut(readSheet('meli_sales', { keyField: 'Order_ID' }));
    }
    if (action === 'suppliers') {
      return jsonOut(readSheet('meli_suppliers', { keyField: 'Supplier_ID' }));
    }
    if (action === 'sheet') {
      var name = params.name || '';
      if (!name) {
        return jsonOut({ success: false, error: 'Missing ?name= parameter' });
      }
      var keyField = guessKeyField(name);
      return jsonOut(readSheet(name, { keyField: keyField }));
    }

    // Default: connection status + sheet inventory
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheets = ss.getSheets().map(function (s) {
      return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() };
    });
    return jsonOut({
      success: true,
      message: 'Connected (multi-sheet v6.18)',
      sheets: sheets,
      schema: SHEET_SCHEMAS
    });
  } catch (err) {
    return jsonOut({ success: false, error: err.toString() });
  }
}

/* =========================================================================
 * POST — dispatch by action
 *
 * Body shape: { action: 'XXX', ...payload }
 *
 * Dispatch table:
 *   sync                 → bulk upsert crawled_data (existing, unchanged)
 *   add_opportunity      → append row to meli_opportunities
 *   update_opportunity   → patch an opportunity (status, publishedId, error)
 *   add_published        → append row to meli_published
 *   add_sale             → append row to meli_sales
 *   add_supplier         → append row to meli_suppliers (auto-gen ID)
 *   add_price_history    → append row to meli_price_history
 *   write                → generic write: { sheet:'XXX', data:{...} }
 * ========================================================================= */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (!data || !data.action) {
      return jsonOut({ success: false, error: 'Missing action in POST body' });
    }

    switch (data.action) {
      case 'sync':
        return jsonOut(handleSync(data));

      case 'add_opportunity':
        return jsonOut(handleAddOpportunity(data));

      case 'update_opportunity':
        return jsonOut(handleUpdateOpportunity(data));

      case 'add_published':
        return jsonOut(handleAddPublished(data));

      case 'add_sale':
        return jsonOut(handleAddSale(data));

      case 'add_supplier':
        return jsonOut(handleAddSupplier(data));

      case 'add_price_history':
        return jsonOut(handleAddPriceHistory(data));

      case 'write':
        return jsonOut(handleGenericWrite(data));

      default:
        return jsonOut({ success: false, error: 'Unknown action: ' + data.action });
    }
  } catch (err) {
    return jsonOut({ success: false, error: err.toString() });
  }
}

/* =========================================================================
 * Action handlers
 * ========================================================================= */

/**
 * sync — bulk upsert into meli_crawled_data.
 * Existing behaviour preserved verbatim (dedup by MLV_ID, update-or-append).
 * Body: { action:'sync', products:[...] }
 */
function handleSync(data) {
  if (!data.products || !Array.isArray(data.products)) {
    return { success: false, error: 'No products array in request' };
  }
  var sheet = getSheet('meli_crawled_data');
  ensureHeaders(sheet, 'meli_crawled_data');

  var existingIds = getExistingIds(sheet);
  var appended = 0, updated = 0, skipped = 0;

  for (var i = 0; i < data.products.length; i++) {
    var p = data.products[i];
    var mlvId = p.id || p.MLV_ID || extractMlvId(p.Link || p.Link_Producto) || '';
    if (!mlvId) { skipped++; continue; }

    var row = productToRow(p, mlvId);

    if (existingIds.indexOf(mlvId) !== -1) {
      var rowNum = findRowById(sheet, mlvId);
      if (rowNum > 0) {
        sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
        updated++;
      } else {
        skipped++;
      }
    } else {
      sheet.appendRow(row);
      existingIds.push(mlvId);
      appended++;
    }
  }

  return {
    success: true,
    appended: appended,
    updated: updated,
    skipped: skipped,
    total: data.products.length
  };
}

/**
 * add_opportunity — append one row to meli_opportunities.
 * Body: { action:'add_opportunity', opportunity:{...} }
 * Auto-generates Opp_ID = opp_<timestamp>, Created_At = ISO now, Status='pending'.
 */
function handleAddOpportunity(data) {
  if (!data.opportunity || typeof data.opportunity !== 'object') {
    return { success: false, error: 'Missing opportunity object' };
  }
  var sheet = getSheet('meli_opportunities');
  ensureHeaders(sheet, 'meli_opportunities');

  var o = data.opportunity;
  var now = new Date();
  var oppId = o.Opp_ID || o.id || ('opp_' + now.getTime());
  var row = [
    oppId,
    o.Product_Name || o.name || '',
    o.Photo_URL || o.photo || '',
    num(o.Estimated_Cost, o.cost),
    num(o.Suggested_Price, o.suggestedPrice),
    num(o.Markup_Percent, o.markup),
    o.Category || o.category || '',
    o.Brand || o.brand || '',
    o.Model || o.model || '',
    o.Notes || o.notes || '',
    o.Location_Found || o.location || '',
    o.Source || o.source || 'opportunities.html',
    o.Created_At || now.toISOString(),
    o.Status || 'pending',
    o.Published_ID || '',
    o.Error_Message || ''
  ];
  sheet.appendRow(row);
  return { success: true, opp_id: oppId, row_count: sheet.getLastRow() };
}

/**
 * update_opportunity — patch an opportunity row.
 * Body: { action:'update_opportunity', id:'opp_...', status:'published',
 *         publishedId:'MLV...', error:'...' }
 */
function handleUpdateOpportunity(data) {
  if (!data.id) return { success: false, error: 'Missing id' };
  var sheet = getSheet('meli_opportunities');
  ensureHeaders(sheet, 'meli_opportunities');
  var rowNum = findRowById(sheet, data.id);
  if (rowNum < 0) return { success: false, error: 'Opportunity not found: ' + data.id };

  // Patch Status (col 14), Published_ID (col 15), Error_Message (col 16)
  // Schema: Opp_ID(1) Product_Name(2) Photo_URL(3) Estimated_Cost(4)
  //         Suggested_Price(5) Markup_Percent(6) Category(7) Brand(8)
  //         Model(9) Notes(10) Location_Found(11) Source(12) Created_At(13)
  //         Status(14) Published_ID(15) Error_Message(16)
  if (data.status) {
    sheet.getRange(rowNum, 14).setValue(data.status);
  }
  if (data.publishedId) {
    sheet.getRange(rowNum, 15).setValue(data.publishedId);
  }
  if (data.error !== undefined) {
    sheet.getRange(rowNum, 16).setValue(data.error || '');
  }
  return { success: true, id: data.id, row: rowNum };
}

/**
 * add_published — append one row to meli_published.
 * Body: { action:'add_published', product:{...} }
 */
function handleAddPublished(data) {
  if (!data.product || typeof data.product !== 'object') {
    return { success: false, error: 'Missing product object' };
  }
  var sheet = getSheet('meli_published');
  ensureHeaders(sheet, 'meli_published');

  var p = data.product;
  var now = new Date().toISOString();
  var pubId = p.Published_ID || p.newId || p.id || ('pub_' + Date.now());
  // Dedup: if Published_ID already exists, update instead of append.
  var rowNum = findRowById(sheet, pubId);
  var row = [
    pubId,
    p.Original_ID || p.originalId || '',
    p.Title || p.title || '',
    num(p.Price, p.price),
    num(p.Markup_Percent, p.markup),
    p.Currency || p.currency || 'USD',
    p.Category_Id || p.categoryId || '',
    p.Permalink || p.permalink || '',
    p.Published_At || p.publishedAt || now,
    p.Status || p.status || 'active',
    num(p.Views_30d, p.views30d),
    num(p.Sales_30d, p.sales30d),
    p.Last_Updated || now
  ];
  if (rowNum > 0) {
    sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
    return { success: true, published_id: pubId, updated: true };
  }
  sheet.appendRow(row);
  return { success: true, published_id: pubId, updated: false };
}

/**
 * add_sale — append one row to meli_sales.
 * Body: { action:'add_sale', sale:{...} }
 */
function handleAddSale(data) {
  if (!data.sale || typeof data.sale !== 'object') {
    return { success: false, error: 'Missing sale object' };
  }
  var sheet = getSheet('meli_sales');
  ensureHeaders(sheet, 'meli_sales');

  var s = data.sale;
  var orderId = s.Order_ID || s.orderId || ('ord_' + Date.now());
  var row = [
    orderId,
    s.Item_ID || s.itemId || '',
    s.Title || s.title || '',
    num(s.Sale_Price, s.salePrice),
    num(s.ML_Fee, s.mlFee),
    num(s.Net_Profit, s.netProfit),
    s.Buyer_Nickname || s.buyer || '',
    s.Sale_Date || s.saleDate || new Date().toISOString(),
    s.Status || s.status || 'paid',
    num(s.Shipping_Cost, s.shippingCost),
    s.Shipping_Type || s.shippingType || ''
  ];

  // Dedup by Order_ID
  var existing = findRowById(sheet, orderId);
  if (existing > 0) {
    sheet.getRange(existing, 1, 1, row.length).setValues([row]);
    return { success: true, order_id: orderId, updated: true };
  }
  sheet.appendRow(row);
  return { success: true, order_id: orderId, updated: false };
}

/**
 * add_supplier — append one row to meli_suppliers.
 * Body: { action:'add_supplier', supplier:{...} }
 * Auto-generates Supplier_ID = sup_<timestamp>.
 */
function handleAddSupplier(data) {
  if (!data.supplier || typeof data.supplier !== 'object') {
    return { success: false, error: 'Missing supplier object' };
  }
  var sheet = getSheet('meli_suppliers');
  ensureHeaders(sheet, 'meli_suppliers');

  var s = data.supplier;
  var supId = s.Supplier_ID || s.id || ('sup_' + Date.now());
  var row = [
    supId,
    s.Name || s.name || '',
    s.Phone || s.phone || '',
    s.WhatsApp || s.whatsapp || '',
    s.Instagram || s.instagram || '',
    s.RIF || s.rif || '',
    s.City || s.city || '',
    s.Products_Offered || s.products || '',
    num(s.Rating, s.rating),
    s.Notes || s.notes || '',
    s.Last_Contacted || s.lastContacted || '',
    s.ML_Seller_Name || s.mlSeller || '',
    s.Google_Search_URL || s.googleUrl || ''
  ];

  // Dedup by Supplier_ID; if RIF matches an existing row, update.
  var existing = findRowById(sheet, supId);
  if (existing < 0 && s.RIF) {
    existing = findRowByValue(sheet, 5, s.RIF); // RIF is column 5
  }
  if (existing > 0) {
    sheet.getRange(existing, 1, 1, row.length).setValues([row]);
    return { success: true, supplier_id: supId, updated: true };
  }
  sheet.appendRow(row);
  return { success: true, supplier_id: supId, updated: false };
}

/**
 * add_price_history — append one row to meli_price_history.
 * Body: { action:'add_price_history', history:{...} }
 */
function handleAddPriceHistory(data) {
  if (!data.history || typeof data.history !== 'object') {
    return { success: false, error: 'Missing history object' };
  }
  var sheet = getSheet('meli_price_history');
  ensureHeaders(sheet, 'meli_price_history');

  var h = data.history;
  var row = [
    h.MLV_ID || h.mlvId || '',
    h.Check_Date || h.checkDate || new Date().toISOString(),
    num(h.Price, h.price),
    num(h.Score, h.score),
    num(h.Sales_Count, h.salesCount),
    num(h.Visits, h.visits),
    h.Seller_Name || h.sellerName || ''
  ];
  sheet.appendRow(row);
  return { success: true };
}

/**
 * write — generic write to any sheet.
 * Body: { action:'write', sheet:'meli_suppliers', data:{ col1:val, ... } }
 * Useful for external apps that want to push arbitrary data.
 */
function handleGenericWrite(data) {
  if (!data.sheet || !data.data) {
    return { success: false, error: 'Missing sheet name or data' };
  }
  var headers = SHEET_SCHEMAS[data.sheet];
  if (!headers) {
    // Allow writing to unknown sheets — use the keys of data as headers.
    headers = Object.keys(data.data);
  }
  var sheet = getSheet(data.sheet);
  ensureHeadersWithArray(sheet, headers);

  var row = headers.map(function (h) {
    var v = data.data[h];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });

  // Dedup by first column if its value is non-empty
  var keyVal = row[0];
  if (keyVal) {
    var existing = findRowById(sheet, String(keyVal));
    if (existing > 0) {
      sheet.getRange(existing, 1, 1, row.length).setValues([row]);
      return { success: true, sheet: data.sheet, row: existing, updated: true };
    }
  }
  sheet.appendRow(row);
  return { success: true, sheet: data.sheet, row: sheet.getLastRow(), updated: false };
}

/* =========================================================================
 * Core sheet helpers
 * ========================================================================= */

/**
 * Opens the spreadsheet and returns the named sheet, creating it if missing.
 * Also handles the "Hoja 1" → meli_crawled_data rename migration.
 */
function getSheet(name) {
  var ss = SpreadsheetApp.openById(SHEET_ID);

  // One-time migration: if "Hoja 1" exists, rename it to meli_crawled_data.
  var legacy = ss.getSheetByName(LEGACY_SHEET_NAME);
  if (legacy) {
    try { legacy.setName('meli_crawled_data'); } catch (e) {}
  }

  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    // Auto-create the sheet with the right number of columns.
    var headers = SHEET_SCHEMAS[name] || [];
    sheet = ss.insertSheet(name);
    if (headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      formatHeaderRow(sheet, headers.length);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

/**
 * Ensures the header row is present + formatted.
 * Uses the schema for `sheetName` if available, otherwise does nothing.
 */
function ensureHeaders(sheet, sheetName) {
  var headers = sheetName ? SHEET_SCHEMAS[sheetName] : null;
  if (!headers) return;
  ensureHeadersWithArray(sheet, headers);
}

/**
 * Lower-level: writes the headers array if the first row is empty,
 * applies bold + navy background + white text, freezes row 1.
 */
function ensureHeadersWithArray(sheet, headers) {
  if (!headers || headers.length === 0) return;
  var lastCol = sheet.getLastColumn();
  var firstCell = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0][0] : '';
  if (!firstCell) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    formatHeaderRow(sheet, headers.length);
    sheet.setFrozenRows(1);
  } else {
    // Make sure the headers match — patch any missing trailing columns.
    var existing = sheet.getRange(1, 1, 1, Math.max(lastCol, headers.length)).getValues()[0];
    var changed = false;
    for (var i = 0; i < headers.length; i++) {
      if (existing[i] !== headers[i]) {
        existing[i] = headers[i];
        changed = true;
      }
    }
    if (changed) {
      sheet.getRange(1, 1, 1, existing.length).setValues([existing]);
      formatHeaderRow(sheet, existing.length);
      sheet.setFrozenRows(1);
    }
  }
}

function formatHeaderRow(sheet, colCount) {
  sheet.getRange(1, 1, 1, colCount)
    .setFontWeight('bold')
    .setBackground('#2d3277')   // ML navy
    .setFontColor('#ffffff');
}

/**
 * Reads an entire sheet into a list of row objects keyed by header name.
 * Options:
 *   keyField — column name used as the row id (default: first column)
 */
function readSheet(name, opts) {
  opts = opts || {};
  var keyField = opts.keyField;
  var sheet = getSheet(name);
  var headers = SHEET_SCHEMAS[name] || [];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    return { success: true, sheet: name, headers: headers, rows: [], count: 0 };
  }
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var raw = values[i];
    if (raw.length === 1 && (raw[0] === '' || raw[0] === null)) continue;
    var obj = {};
    for (var j = 0; j < headers.length && j < raw.length; j++) {
      var v = raw[j];
      // Date objects → ISO string for downstream JSON consumers.
      if (v instanceof Date) v = v.toISOString();
      obj[headers[j]] = v;
    }
    rows.push(obj);
  }
  return {
    success: true,
    sheet: name,
    headers: headers,
    rows: rows,
    count: rows.length
  };
}

/**
 * Returns the list of existing IDs in column A (used for dedup).
 */
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

function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function findRowByValue(sheet, col, value) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var colData = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < colData.length; i++) {
    if (String(colData[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

function guessKeyField(name) {
  var s = SHEET_SCHEMAS[name];
  if (s && s.length > 0) return s[0];
  return null;
}

/* =========================================================================
 * Crawled-data row builder — kept identical to v6.17.0 behaviour.
 * ========================================================================= */
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
    p.AllPictures ? (Array.isArray(p.AllPictures) ? p.AllPictures.join(' ; ') : String(p.AllPictures)) : '',
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

/**
 * Coerce a value to a number for spreadsheet cells; returns 0 if NaN.
 * Accepts either a primary field name or a fallback name from the payload.
 */
function num() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v === undefined || v === null || v === '') continue;
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isNaN(n) && isFinite(n)) return n;
  }
  return 0;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================================
 * Manual / debug helpers (callable from the Apps Script editor)
 * ========================================================================= */

/**
 * One-time setup: creates all 6 sheets with proper headers.
 * Safe to run repeatedly — only creates sheets that don't exist yet.
 */
function setupAllSheets() {
  for (var i = 0; i < SHEET_ORDER.length; i++) {
    var name = SHEET_ORDER[i];
    var sheet = getSheet(name);
    ensureHeaders(sheet, name);
  }
  // Reorder the tabs so the sheet order matches SHEET_ORDER.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  for (var j = 0; j < SHEET_ORDER.length; j++) {
    var s = ss.getSheetByName(SHEET_ORDER[j]);
    if (s) ss.setActiveSheet(s);
    if (j > 0) ss.moveActiveSheet(j + 1);
  }
}

/**
 * Clears all data (except headers) on the given sheet.
 * Callable manually for debugging.
 */
function clearSheetByName(name) {
  var sheet = getSheet(name);
  ensureHeaders(sheet, name);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, SHEET_SCHEMAS[name].length).clearContent();
  }
}
