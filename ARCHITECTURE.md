# ARCHITECTURE — ML Scraper VE v6.18.0

Multi-sheet bidirectional database for the MercadoLibre Venezuela scraper.

This document specifies:

1. The 6-sheet schema and data flow.
2. The full REST API exposed by the Google Apps Script web app.
3. Data format conventions external integrators must follow.
4. 10 concrete use-cases enabled by the multi-sheet model.

---

## 1. High-level architecture

```
┌─────────────────┐     sync      ┌─────────────────────┐
│ Chrome Extension │──────────────│ meli_crawled_data   │
│ (crawler + deep  │              └─────────────────────┘
│  extraction)    │                         │
│                  │     publish   ┌─────────────────────┐
│  Vender button   │──────────────│ meli_published      │
│                  │              └─────────────────────┘
│                  │                         │
│  Auto-publish    │   reads     ┌─────────────────────┐
│  from Sheet      │←────────────│ meli_opportunities  │
│                  │             └─────────────────────┘
│                  │                    ↑
│                  │   writes   ┌─────────────────────┐
│                  │            │ opportunities.html  │
│                  │            │ (mobile capture)    │
│                  │            └─────────────────────┘
└─────────────────┘
         │
         │ webhook (future)
         ↓
┌─────────────────┐  read/write  ┌─────────────────────┐
│ Next.js Webapp  │←────────────│ meli_sales           │
│ (Vercel)        │             └─────────────────────┘
│                 │  read/write  ┌─────────────────────┐
│  Dashboard      │←────────────│ meli_price_history   │
│  Analytics      │             └─────────────────────┘
│  Trends         │  read/write  ┌─────────────────────┐
│  Profit Calc    │←────────────│ meli_suppliers       │
└─────────────────┘             └─────────────────────┘
```

### Component responsibilities

| Component | Role |
|---|---|
| `content.js` | Injected into every ML VE page. Owns the crawler, deep extraction, and the Vender button. Posts published products to `meli_published`. Auto-publishes pending opportunities from `meli_opportunities` when the corresponding config checkbox is on. |
| `background.js` | MV3 service worker. Handles `SYNC_TO_SHEETS` (bypasses CORS by routing through SW) and ML API calls (`POST /items`, `FETCH_VISITS`, etc). |
| `opportunities.html` / `opportunities.js` | Standalone mobile-friendly page. Lets the user capture a product (photo + cost + suggested price + notes) and POSTs it to `meli_opportunities`. Works offline; queues submissions to localStorage and syncs when connectivity returns. |
| `dashboard.html` / `dashboard.js` | Full-page management dashboard. 9 original tabs + 3 new tabs (`Opp. Sheet`, `Pub. Sheet`, `Ventas`) that read directly from the Apps Script. |
| `google-apps-script.js` | Backend. Single Apps Script web app deployed with `Execute as: Me`, `Access: Anyone`. Owns the 6-sheet schema, all read endpoints, all write endpoints, dedup, header formatting, and the `Hoja 1 → meli_crawled_data` rename migration. |
| `webapp/` (Next.js) | Optional Vercel-deployed analytics dashboard. Reads `meli_crawled_data` via `/api/data` proxy. Could be extended to read the other 5 sheets. |

---

## 2. Sheets & schemas

The Apps Script auto-creates these 6 sheets on first request. If a sheet named `"Hoja 1"` exists, it is renamed to `meli_crawled_data` (preserves existing crawled data). Header rows are bold, navy background (#2d3277), white text, frozen.

### 2.1 `meli_crawled_data` — products from the crawler

(Verbatim schema from v6.17.0 — kept for backwards compatibility.)

| # | Column | Type | Notes |
|---|---|---|---|
| 1 | `MLV_ID` | string (PK) | `MLV123456789` — no hyphens. |
| 2 | `Nombre` | string | Item title. |
| 3 | `Precio_Numerico` | number | Numeric price (USD or VES). |
| 4 | `Score` | number (0–5) | Average review score. |
| 5 | `Opiniones` | int | Review count. |
| 6 | `Ventas_Estimadas` | int | sold_quantity from ML API. |
| 7 | `Visitas_10dias` | int | visits via `/items/{id}/visits/timeWindow`. |
| 8 | `EnvioGratis` | string | "Sí" / "No". |
| 9–16 | `Vendedor_*` | string | Seller reputation + link. |
| 17 | `Ubicacion_Tienda` | string | "City, State" from seller_address. |
| 18 | `Categoria` | string | Top category. |
| 19 | `Subcategorias` | string | Pipe-separated subcats. |
| 20 | `Categorias` | string | Full breadcrumb. |
| 21–23 | `Marca`, `Modelo`, `Especificaciones` | string | From product attributes. |
| 24 | `Category_Id` | string | ML category id. |
| 25 | `Seller_Id` | string | ML seller id. |
| 26 | `Nordic_Attributes` | JSON string | Full attribute map. |
| 27 | `All_Pictures` | string | ` ; `-separated picture URLs. |
| 28 | `Imagen` | string | Thumbnail URL. |
| 29 | `Link_Producto` | string | Permalink. |
| 30 | `Google_Breakout_Vendedor` | string | Pre-built Google OSINT URL. |
| 31 | `DeepExtracted` | string | "Sí" / "No". |
| 32 | `Synced_At` | ISO 8601 | When the row was last synced. |

### 2.2 `meli_published` — products published via Vender

| # | Column | Type | Notes |
|---|---|---|---|
| 1 | `Published_ID` | string (PK) | ML item id, e.g. `MLV987654321`. |
| 2 | `Original_ID` | string | ML id of the source product. |
| 3 | `Title` | string | Final published title (≤60 chars). |
| 4 | `Price` | number | Final price with markup. |
| 5 | `Markup_Percent` | number | % added to original price. |
| 6 | `Currency` | string | `USD` / `VES`. |
| 7 | `Category_Id` | string | ML category id used. |
| 8 | `Permalink` | string | ML permalink of the new listing. |
| 9 | `Published_At` | ISO 8601 | When the listing went live. |
| 10 | `Status` | enum | `active` / `paused` / `closed` / `under_review`. |
| 11 | `Views_30d` | int | Views in last 30 days (refresh via cron). |
| 12 | `Sales_30d` | int | Sales in last 30 days. |
| 13 | `Last_Updated` | ISO 8601 | Last time this row was patched. |

### 2.3 `meli_opportunities` — products to publish (street / OSINT)

| # | Column | Type | Notes |
|---|---|---|---|
| 1 | `Opp_ID` | string (PK) | Auto-generated `opp_<timestamp>` (or user-supplied). |
| 2 | `Product_Name` | string | Required. |
| 3 | `Photo_URL` | string (data URL) | Base64 JPEG (≤640px edge, q=0.78). |
| 4 | `Estimated_Cost` | number | What you'd pay the supplier. |
| 5 | `Suggested_Price` | number | Final price you'd charge. |
| 6 | `Markup_Percent` | number | Computed = (price − cost) / cost × 100. |
| 7 | `Category` | string | Free text + datalist suggestions. |
| 8 | `Brand` | string | |
| 9 | `Model` | string | |
| 10 | `Notes` | string | Free text. |
| 11 | `Location_Found` | string | Where the opportunity was discovered. |
| 12 | `Source` | enum | `street` / `whatsapp` / `instagram` / `friend` / `supplier` / `other`. |
| 13 | `Created_At` | ISO 8601 | When the row was added. |
| 14 | `Status` | enum | `pending` / `publishing` / `published` / `failed` / `deleted`. |
| 15 | `Published_ID` | string | ML item id once published (else empty). |
| 16 | `Error_Message` | string | If `Status = failed`, why. |

### 2.4 `meli_sales` — sales tracking

| # | Column | Type | Notes |
|---|---|---|---|
| 1 | `Order_ID` | string (PK) | ML order id, e.g. `2000007654321`. |
| 2 | `Item_ID` | string | ML item id that was sold. |
| 3 | `Title` | string | |
| 4 | `Sale_Price` | number | What the buyer paid. |
| 5 | `ML_Fee` | number | Commission taken by ML. |
| 6 | `Net_Profit` | number | `Sale_Price − ML_Fee − Shipping_Cost` (precomputed for queryability). |
| 7 | `Buyer_Nickname` | string | ML nickname. |
| 8 | `Sale_Date` | ISO 8601 | |
| 9 | `Status` | enum | `pending` / `paid` / `shipped` / `delivered` / `cancelled`. |
| 10 | `Shipping_Cost` | number | |
| 11 | `Shipping_Type` | string | `fulfillment` / `me2` / `custom` / `pickup`. |

### 2.5 `meli_price_history` — price monitoring over time

Append-only log of price snapshots per MLV id. Each row is one check.

| # | Column | Type | Notes |
|---|---|---|---|
| 1 | `MLV_ID` | string | (Not unique — multiple rows per id over time.) |
| 2 | `Check_Date` | ISO 8601 | |
| 3 | `Price` | number | |
| 4 | `Score` | number | |
| 5 | `Sales_Count` | int | sold_quantity at check time. |
| 6 | `Visits` | int | |
| 7 | `Seller_Name` | string | |

### 2.6 `meli_suppliers` — supplier CRM

| # | Column | Type | Notes |
|---|---|---|---|
| 1 | `Supplier_ID` | string (PK) | Auto-generated `sup_<timestamp>`. |
| 2 | `Name` | string | |
| 3 | `Phone` | string | |
| 4 | `WhatsApp` | string | Full international format, e.g. `+584121234567`. |
| 5 | `Instagram` | string | `@handle` or URL. |
| 6 | `RIF` | string | Venezuelan tax id (`J-12345678-9` etc.). |
| 7 | `City` | string | |
| 8 | `Products_Offered` | string | Free text. |
| 9 | `Rating` | number (0–5) | Internal rating. |
| 10 | `Notes` | string | |
| 11 | `Last_Contacted` | ISO 8601 | |
| 12 | `ML_Seller_Name` | string | If the supplier is also an ML seller. |
| 13 | `Google_Search_URL` | string | OSINT query that surfaced this supplier. |

---

## 3. REST API — Google Apps Script web app

**Base URL**: `https://script.google.com/macros/s/AKfyc.../exec`

> Apps Script does not support CORS preflight for `application/json`, so all
> POST requests **MUST** use `Content-Type: text/plain;charset=utf-8` and
> send the JSON payload as the request body. This avoids the browser
> triggering a CORS preflight that Apps Script cannot answer.

### 3.1 GET endpoints

#### `?action=data` — read crawled products

Used by the Next.js webapp and any external consumer that wants the full
product catalog.

**Response 200** (JSON):
```json
{
  "success": true,
  "sheet": "meli_crawled_data",
  "headers": ["MLV_ID", "Nombre", ...],
  "rows": [{ "MLV_ID": "MLV123456789", "Nombre": "...", ... }],
  "count": 5234
}
```

#### `?action=published` — read published products

Same response shape, `sheet = "meli_published"`, `headers` = the 13 columns above.

#### `?action=opportunities` — read PENDING opportunities

By default returns only opportunities where `Status` is empty / `pending` /
`pendiente`. Pass `&all=true` to return every row regardless of status.

**Response 200**:
```json
{
  "success": true,
  "sheet": "meli_opportunities",
  "headers": ["Opp_ID", ...],
  "rows": [{ "Opp_ID": "opp_1718000000_abc123", "Status": "pending", ... }],
  "count": 3,
  "filtered": "pending"
}
```

#### `?action=sales` — read sales orders

Same response shape, `sheet = "meli_sales"`.

#### `?action=suppliers` — read suppliers

Same response shape, `sheet = "meli_suppliers"`.

#### `?action=sheet&name=XXX` — generic read from any sheet by name

Use this for ad-hoc reads of sheets not covered by the named endpoints
above. Example: `?action=sheet&name=meli_price_history`.

**Response 200**:
```json
{
  "success": true,
  "sheet": "meli_price_history",
  "headers": ["MLV_ID", "Check_Date", ...],
  "rows": [...],
  "count": 1203
}
```

#### (no params) — connection status + sheet inventory

Returns the list of sheets present in the spreadsheet with their last-row
and last-column counts, plus the full schema map.

**Response 200**:
```json
{
  "success": true,
  "message": "Connected (multi-sheet v6.18)",
  "sheets": [
    { "name": "meli_crawled_data", "rows": 5234, "cols": 32 },
    { "name": "meli_published", "rows": 47, "cols": 13 },
    ...
  ],
  "schema": {
    "meli_crawled_data": ["MLV_ID", "Nombre", ...],
    "meli_published": [...],
    ...
  }
}
```

### 3.2 POST endpoints

All POST requests carry a JSON body with an `action` field. Response is
always JSON with `{ success: boolean, ...payload }`.

#### `{ "action": "sync", "products": [...] }` — bulk upsert crawled data

Existing behaviour preserved from v6.17.0. Dedup by `MLV_ID` (column A).
Each product in `products` may use either the v6.17 field names
(`Nombre`, `Precio_Numerico`, `Ventas`, `Visitas`, `Link`, `Marca`,
`Modelo`, `Especificaciones`, `CategoryId`, `NordicAttrs`, `AllPictures`,
etc.) or the long names matching the sheet headers
(`Link_Producto`, `Category_Id`, `Nordic_Attributes`).

**Response 200**:
```json
{
  "success": true,
  "appended": 480,
  "updated": 12,
  "skipped": 0,
  "total": 492
}
```

#### `{ "action": "add_opportunity", "opportunity": {...} }`

Appends a row to `meli_opportunities`. Auto-generates `Opp_ID`,
`Created_At`, defaults `Status = "pending"` if absent.

**Request body**:
```json
{
  "action": "add_opportunity",
  "opportunity": {
    "Product_Name": "Licuadora Oster 1.5L",
    "Photo_URL": "data:image/jpeg;base64,...",
    "Estimated_Cost": 25,
    "Suggested_Price": 38,
    "Markup_Percent": 52,
    "Category": "Electrodomésticos",
    "Brand": "Oster",
    "Model": "BLSTEG",
    "Notes": "Caja abierta, funciona",
    "Location_Found": "Mercado de Coche, Caracas",
    "Source": "street",
    "Opp_ID": "opp_1718000000_abc123"
  }
}
```

**Response 200**:
```json
{ "success": true, "opp_id": "opp_1718000000_abc123", "row_count": 42 }
```

#### `{ "action": "update_opportunity", "id": "...", "status": "...", "publishedId": "...", "error": "..." }`

Patches `Status` (col 14), `Published_ID` (col 15), `Error_Message` (col 16)
on an existing opportunity row.

**Request body**:
```json
{
  "action": "update_opportunity",
  "id": "opp_1718000000_abc123",
  "status": "published",
  "publishedId": "MLV987654321",
  "error": ""
}
```

**Response 200**:
```json
{ "success": true, "id": "opp_1718000000_abc123", "row": 42 }
```

#### `{ "action": "add_published", "product": {...} }`

Appends a row to `meli_published`. Dedup by `Published_ID` — if the row
already exists, it is updated in place.

**Request body**:
```json
{
  "action": "add_published",
  "product": {
    "Published_ID": "MLV987654321",
    "Original_ID": "MLV123456789",
    "Title": "Licuadora Oster 1.5L",
    "Price": 38,
    "Markup_Percent": 20,
    "Currency": "USD",
    "Category_Id": "MLV1747",
    "Permalink": "https://articulo.mercadolibre.com.ve/MLV987654321-...-_JM",
    "Published_At": "2024-06-15T14:32:00.000Z",
    "Status": "active"
  }
}
```

**Response 200**:
```json
{ "success": true, "published_id": "MLV987654321", "updated": false }
```

#### `{ "action": "add_sale", "sale": {...} }`

Appends a row to `meli_sales`. Dedup by `Order_ID`.

**Request body**:
```json
{
  "action": "add_sale",
  "sale": {
    "Order_ID": "2000007654321",
    "Item_ID": "MLV987654321",
    "Title": "Licuadora Oster 1.5L",
    "Sale_Price": 38,
    "ML_Fee": 5.70,
    "Net_Profit": 28.30,
    "Buyer_Nickname": "JOSE123",
    "Sale_Date": "2024-06-15T18:00:00.000Z",
    "Status": "paid",
    "Shipping_Cost": 4.00,
    "Shipping_Type": "me2"
  }
}
```

**Response 200**:
```json
{ "success": true, "order_id": "2000007654321", "updated": false }
```

#### `{ "action": "add_supplier", "supplier": {...} }`

Appends a row to `meli_suppliers`. Auto-generates `Supplier_ID` if absent.
If a supplier with the same `Supplier_ID` already exists, updates in place.
If a supplier with the same `RIF` exists, updates in place.

**Request body**:
```json
{
  "action": "add_supplier",
  "supplier": {
    "Name": "Importadora La Economicón C.A.",
    "Phone": "+58 212 555 1234",
    "WhatsApp": "+584121234567",
    "Instagram": "@laeconomica_ve",
    "RIF": "J-12345678-9",
    "City": "Caracas",
    "Products_Offered": "Licuadoras, batidoras, tostadoras",
    "Rating": 4.5,
    "Notes": "Pagos en USD o Zelle. Mínimo $100.",
    "Last_Contacted": "2024-06-15T10:00:00.000Z",
    "ML_Seller_Name": "IMPORTADORA-LA-ECONOMICA",
    "Google_Search_URL": "https://www.google.com/search?q=..."
  }
}
```

**Response 200**:
```json
{ "success": true, "supplier_id": "sup_1718000000_xyz", "updated": false }
```

#### `{ "action": "add_price_history", "history": {...} }`

Appends a row to `meli_price_history`. No dedup — every check is a new row.

**Request body**:
```json
{
  "action": "add_price_history",
  "history": {
    "MLV_ID": "MLV123456789",
    "Check_Date": "2024-06-15T14:32:00.000Z",
    "Price": 38.50,
    "Score": 4.8,
    "Sales_Count": 523,
    "Visits": 12000,
    "Seller_Name": "IMPORTADORA-LA-ECONOMICA"
  }
}
```

**Response 200**:
```json
{ "success": true }
```

#### `{ "action": "write", "sheet": "XXX", "data": {...} }` — generic write

Useful for external apps that want to push arbitrary data to a sheet (e.g.
writing to `meli_price_history` with only some fields filled, or writing to
a custom sheet they created in the same spreadsheet). The `data` object's
keys are matched against the sheet's known schema; any unknown keys are
ignored (or, for unknown sheets, used to construct the headers on the fly).

**Request body**:
```json
{
  "action": "write",
  "sheet": "meli_price_history",
  "data": {
    "MLV_ID": "MLV123456789",
    "Check_Date": "2024-06-15T14:32:00.000Z",
    "Price": 38.50,
    "Visits": 12000
  }
}
```

**Response 200**:
```json
{ "success": true, "sheet": "meli_price_history", "row": 1204, "updated": false }
```

### 3.3 Error responses

All errors return HTTP 200 (Apps Script always returns 200 for `doGet` /
`doPost`) with a JSON body of shape:

```json
{ "success": false, "error": "Human-readable error message" }
```

Common errors:
- `"No products array in request"` — POST `sync` body malformed.
- `"Missing action in POST body"` — POST body has no `action` field.
- `"Unknown action: XXX"` — `action` value not in the dispatch table.
- `"Opportunity not found: opp_..."` — `update_opportunity` with unknown id.
- `"Google devolvió HTML ..."` — Apps Script deployment expired or session
  revoked; re-authorize the script.

---

## 4. Data format specification

| Field type | Format |
|---|---|
| Text | UTF-8. |
| Numbers | Plain numeric (`38.50`), no thousand separators, no currency symbols. |
| Dates | ISO 8601 (`2024-06-15T14:32:00.000Z`). Apps Script will store as a real `Date` cell — `doGet` re-serialises back to ISO 8601. |
| IDs | Prefixed: `opp_<ts>` for opportunities, `pub_<ts>` for published (but ML ids like `MLV987654321` are also accepted), `sup_<ts>` for suppliers, `ord_<ts>` for sales (but ML order ids like `2000007654321` are also accepted). |
| JSON columns | Stored as JSON string (`JSON.stringify(...)`). Read back as string; consumer must `JSON.parse()`. The only JSON column in v6.18 is `Nordic_Attributes` on `meli_crawled_data`. |
| Status enums | Opportunities: `pending` / `publishing` / `published` / `failed` / `deleted`. Published: `active` / `paused` / `closed` / `under_review`. Sales: `pending` / `paid` / `shipped` / `delivered` / `cancelled`. |
| Photos | `Photo_URL` on opportunities is a base64 `data:image/jpeg;base64,...` URL (resized client-side to ≤640px edge). Apps Script stores it as a string — when reading back, browsers render it directly. |
| Empty cells | Empty string `""`, not null. Numbers default to `0`. |

---

## 5. Use cases enabled by the multi-sheet model

### 1. Street Opportunity Scanner
User walks through Mercado de Coche, opens `opportunities.html` on their
phone, takes a photo of a product, fills cost + suggested price + location,
submits. Row lands in `meli_opportunities` with `Status = pending`. When
the user is back at their laptop with the extension open, they tick
"🚀 Auto-publicar oportunidades del Sheet", trigger any crawl, and the
extension auto-publishes each pending opportunity through the Vender flow,
patching `Status` to `published` or `failed` as it goes.

### 2. Sales Tracker
A cron job (Zapier, Make, or a small script) polls the ML `/orders/search`
endpoint every hour and POSTs each new order to `?action=add_sale`. The
Next.js dashboard (or the extension's Ventas tab) shows running totals:
revenue, ML fees, shipping, net profit.

### 3. Price Monitor
A weekly cron job reads `?action=data`, iterates over every product, and
POSTs a snapshot to `?action=add_price_history`. Over time, this builds a
history table that lets the dashboard draw price-drop arrows, detect
competitor pricing changes, and surface restock opportunities.

### 4. Supplier CRM
When the user finds a promising ML seller via OSINT (Google breakout
button), they click "Add to supplier CRM" (future feature) and the seller's
contact info is POSTed to `?action=add_supplier`. Over time this builds a
private database of suppliers with WhatsApp, Instagram, RIF, city, rating.

### 5. Competitor Monitor
The crawler is pointed at a competitor's store URL weekly. Each run appends
to `meli_crawled_data` (dedup by `MLV_ID`), and a script writes a
`meli_price_history` snapshot. The dashboard surfaces "this competitor
dropped prices on 12 products this week".

### 6. Inventory Manager
Every published product has a `Sales_30d` field on `meli_published`. A
script that runs daily reads `?action=published` and POSTs
`?action=write&sheet=meli_published&data={Published_ID: "...", Sales_30d:
N, Last_Updated: ...}`. When `Sales_30d` × markup > some threshold, the
script triggers a restock alert.

### 7. Keyword Trends
The crawler already records which search phrase produced each product (in
the queue work items). A future enhancement would write the phrase to
`meli_crawled_data` as a new column, then aggregate "which search terms
produce the most sales" — and feed that back into the crawler's next
seed list.

### 8. Profit Margin Tracker
When a sale closes, ML returns `order_items.fee_charges` and
`shipping.cost`. These are POSTed to `?action=add_sale` with
`Net_Profit = Sale_Price − ML_Fee − Shipping_Cost` precomputed. The
dashboard's Ventas tab shows aggregate profit margins, broken down by
product, category, or supplier.

### 9. Auto-reprice
A script reads `?action=published` (your listings) and `?action=data`
(competitor listings) and finds products where your price is above the
category median. It calls the ML `/items/{id}` PUT to drop your price by
1% and writes the change to `meli_price_history`.

### 10. Multi-marketplace expansion
The `meli_opportunities` schema is marketplace-agnostic. A future Zap that
reads from `?action=opportunities` could publish the same opportunity to
Shopify, Facebook Marketplace, or Instagram Shopping — all from the same
Google Sheet row.

---

## 6. File layout (this version)

```
ml-scraper-extension/
├── manifest.json            # v6.18.0 — added opportunities.html/js/css to web_accessible_resources
├── content.js               # v6.18.0 — added Opportunities button + badge, auto-publish hook, sheet mirror
├── background.js            # unchanged (still routes SYNC_TO_SHEETS + ML API calls)
├── google-apps-script.js    # REWRITTEN — 6-sheet bidirectional backend
├── dashboard.html           # added 3 new tab sections (sheet_opps / sheet_published / sheet_sales)
├── dashboard.css            # added .status-badge, .stat-sub
├── dashboard.js             # added renderSheetOpps / renderSheetPub / renderSheetSales + sheetsGet/sheetsPost helpers
├── opportunities.html       # NEW — mobile-first capture page
├── opportunities.js         # NEW — capture form + offline queue + sync
├── opportunities.css        # NEW — mobile-first styles
├── popup.{html,js,css}      # unchanged
├── analysis.{html,js,css}   # unchanged
├── error-log.{html,js}      # unchanged
├── icons/                   # unchanged
├── webapp/                  # unchanged (Next.js analytics dashboard)
└── ARCHITECTURE.md          # THIS FILE
```

---

## 7. Migration notes

If you are upgrading from v6.17.0:

1. **Re-deploy the Apps Script** — open the script editor, paste the new
   `google-apps-script.js`, then `Implementar → Nueva implementación →
   Aplicación web`. The new deployment URL is the same shape but a new
   version. The old URL stops working once you delete the old deployment.

2. **First request auto-migrates** — when the Apps Script receives the
   first request after redeploy, it will:
   - Rename `Hoja 1` → `meli_crawled_data` (preserving existing data).
   - Auto-create the 5 other sheets with their proper headers.

3. **Run `setupAllSheets()` manually** if you want to reorder the tabs so
   they appear in the SHEET_ORDER sequence. Optional — the script works
   regardless of tab order.

4. **Reload the extension** — Chrome will detect the manifest version bump
   and prompt to reload. After reload, open the panel; you'll see the new
   "📋 Oportunidades Pendientes" button + the auto-publish checkbox.

5. **No data loss** — `ml_products` and `ml_published_products` in
   `chrome.storage.local` are unchanged. The Vender button now writes to
   both `ml_published_products` (existing) AND the `meli_published` sheet
   (new, fire-and-forget — sheet failure does not block the Vender flow).
