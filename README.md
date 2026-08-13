# MercadoLibre VE Scraper — Chrome Extension (v6.1.0)

Advanced scraper for **MercadoLibre Venezuela** (`mercadolibre.com.ve`) packaged as a Manifest V3 Chrome extension. Crawl thousands of products, extract seller data, and generate **strategic business intelligence** — Porter's Five Forces, FODA/SWOT, and an A1 opportunity list of top products to import/resell.

> **New in v6.1.0:** Strategic Analysis dashboard, scale fixes (debounced render, virtualized results, background cache, `unlimitedStorage`, HTTP 429 backoff, max-pages/products limits). See [Changelog](#changelog).
>
> v6.0.0 was the cleaned-up successor to the v4.0.5 userscript and the (buggy, incomplete) v5.0.0 proposed by Gemini. **21 issues were found and fixed** in v5.0.0.

---

## ✨ Features

### Crawling & Extraction
- **Crawler** with paginated offset navigation, queue of search phrases, pause/resume, reset.
- **Max-pages / max-products limits** — stop crawling after N pages or N products (configurable, 0 = unlimited).
- **HTTP 429 backoff** — exponential retry on rate-limiting (5 attempts, max 30s wait).
- **Deep extraction** of article pages (title, price, currency, score, sales, location, seller, breadcrumbs, brand/model, full specs table).
- **Seller OSINT** — every exported product gets a `Google_Breakout_Vendedor` column with a one-click Google search URL targeting the seller's WhatsApp / Instagram / RIF / phone / storefront in Venezuela.

### Strategic Analysis Dashboard 📊 (NEW in v6.1.0)
- **Top-N Rankings** — top 20 products by sales, by score, or by estimated revenue (price × sales).
- **Seller Concentration** — HHI, market share, seller classification (Dominant / Supplier / Mid / Niche). Identifies your potential **suppliers** (high-volume, multi-product sellers) and **competitors** (dominant market-share players).
- **Category / Niche Analysis** — top categories by total sales, with seller counts. Flags **blue oceans** (high demand, few sellers).
- **Porter's Five Forces** — computed from the data, not vibes:
  - ⚔️ Rivalry (HHI, seller count, products-per-seller)
  - 🚪 Threat of new entrants (score barriers, seller saturation)
  - 🛒 Bargaining power of buyers (price/score variance, product count)
  - 🏭 Bargaining power of suppliers (seller concentration, top-3 share)
  - 🔄 Threat of substitutes (products-per-category, price range)
- **FODA / SWOT Matrix** — auto-generated Strengths, Weaknesses, Opportunities, Threats based on the computed metrics.
- **A1 Opportunity List** — top 20 products scored on a 0-100 scale:
  - Demand percentile (35%) — proven sales
  - Quality percentile (15%) — review scores
  - Market openness (25%) — 1 minus seller dominance
  - Price reasonableness (15%) — proximity to median
  - Category hotness (10%) — in a high-demand category
- **Export** — CSV rankings, CSV A1 list, and a full Markdown strategic report.

### Architecture
- **Cross-tab sync** — products and the deep-extraction queue live in `chrome.storage.local` with an in-memory background cache + debounced flush. Open 5 ML tabs, crawl in any, see results everywhere via `chrome.storage.onChanged`.
- **Virtualized results** — only renders 50 cards at a time with "load more", preventing browser freeze at 5000+ products.
- **Debounced rendering** — storage changes coalesce within 250ms to avoid render storms during active crawling.
- **`unlimitedStorage`** permission — no 10MB storage quota limit for large crawls.
- **Toolbar popup** — stats + show/hide panel + export CSV + clear data + open analysis.
- **XSS-safe** — all user-controlled strings HTML-escaped.
- **Blob-based CSV** — handles large datasets without `data:` URI breakage.
- **Swipe gestures** (touch + mouse) on every result card — swipe left to delete, swipe right to mark for deep extraction.
- **Preview card** on image hover with full product details.
- **Notification sound** (Web Audio synth) when crawl or deep extraction finishes.
- **XSS-safe** — all user-controlled strings (product names, seller names, etc.) are HTML-escaped before insertion.
- **Blob-based CSV export** — handles large datasets and special characters without `data:` URI breakage.
- **Idempotent product merging** — keyed by MLV id, so concurrent tabs and re-crawls never duplicate or clobber.
- **SPA navigation aware** — `MutationObserver` recomputes `isArticlePage` and rebuilds the modal tabs when ML does client-side routing.
- **Custom icons** (16/32/48/128) with ML-inspired branding.

---

## 📦 Project structure

```
ml-scraper-extension/
├── manifest.json              MV3 manifest, permissions, action popup, unlimitedStorage
├── background.js              Service worker — in-memory cache + debounced flush
├── content.js                 In-page UI + crawler + swipe + deep extraction + virtualized results
├── analysis.html              Strategic analysis dashboard page
├── analysis.css               Analysis dashboard styles
├── analysis.js                Porter's 5F + FODA + A1 scoring engine
├── popup.html                 Toolbar popup markup
├── popup.css                  Toolbar popup styles
├── popup.js                   Toolbar popup logic
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── legacy/
│   └── userscript-v4.0.5.js   Original 925-line single-file userscript (reference)
├── LICENSE
└── README.md
```

---

## 🚀 Installation (Load Unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions/` in Chrome (or any Chromium browser: Edge, Brave, etc.).
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the `ml-scraper-extension/` folder (the one containing `manifest.json`).
6. The ML icon will appear in your toolbar. Pin it for easy access.
7. Navigate to any `mercadolibre.com.ve` page (search results or article). The scraper panel auto-appears in the top-right corner.

> Click the ML toolbar icon to open the popup with stats and quick actions.

---

## 🧭 Usage

### Crawl search results
1. Go to `https://listado.mercadolibre.com.ve/` or any ML VE search page.
2. The panel's **Buscador** tab is active by default on search pages.
3. Type one or more search phrases (comma- or newline-separated) in the textarea.
4. Press **Enter** (or click **Iniciar Crawling**). Each phrase is enqueued and processed sequentially, paginating through `_Desde_49_NoIndex_True`, `_Desde_97_NoIndex_True`, … until a page returns 0 items or a non-paginated redirect.
5. Use **⏸ Pausar** to pause/resume, **⟲ Reset** to clear everything.
6. Adjust filters in the **Filtros & Config** tab: min sales, min score, free-shipping-only, fetch delay.

### Deep extraction
1. In the **Resultados** tab, click **+ Deep** on any product (or swipe it right) to enqueue it.
2. Click **Extraer Artículos Seleccionados**. The background service worker fetches each article page (bypassing CORS), and the parser fills in `Vendedor_Nombre`, `Ubicacion`, `Marca`, `Modelo`, `Especificaciones`, etc.
3. A notification chime plays when done.

### Seller OSINT
- Click any product's info row to open the **Filtros & Config** tab with the seller inspection card.
- The green **🚀 Búsqueda Profunda Vendedor** button opens a pre-built Google query that targets the seller's WhatsApp / Instagram / RIF / phone / storefront in Venezuela.

### Export
- **Descargar CSV** in either the **Buscador** tab, the **Resultados** tab, or the toolbar popup.
- CSV columns: `Nombre, Precio_Numerico, Moneda, Precio_Detallado, Score, Ventas_Estimadas, EnvioGratis, Vendedor_Nombre, Vendedor_Estatus, Ubicacion_Tienda, Categorias, Marca, Modelo, Especificaciones, Imagen, Link_Producto, Google_Breakout_Vendedor`.
- UTF-8 BOM included for Excel compatibility. Uses `\r\n` line endings.

---

## 🔧 How it works (architecture)

### Storage
| Key | Type | Description |
|---|---|---|
| `ml_products` | `Array<Product>` | All crawled + deep-extracted products, merged by MLV id. |
| `ml_deep_queue` | `Array<{id, Link, Nombre}>` | Pending deep-extraction queue (deduped). |
| `ml_config` | `Object` | Reserved for persisted filter config (defaults in code). |
| `ml_panel_visible` | `boolean` | Whether the in-page panel is shown. |

### Message protocol (content ↔ background)
| Action | Direction | Payload | Response |
|---|---|---|---|
| `FETCH_ARTICLE` | content → bg | `{url}` | `{success, html, finalUrl}` |
| `SAVE_PRODUCTS` | content → bg | `{products[]}` | `{success}` (merges idempotently) |
| `SAVE_DEEP_QUEUE` | content → bg | `{deepQueue[]}` | `{success}` (deduped) |
| `GET_ALL_DATA` | content → bg | — | `{products, deepQueue, config, panelVisible}` |
| `CLEAR_ALL` | popup → bg | — | `{success}` |
| `SET_PANEL_VISIBLE` | popup → bg | `{visible}` | `{success}` |
| `EXPORT_CSV` | popup → bg | — | `{success, products}` |
| `SHOW_PANEL` / `HIDE_PANEL` / `TOGGLE_PANEL` | popup → content | — | `{success}` |

### Cross-tab sync
`chrome.storage.onChanged` is the single sync mechanism. The background performs idempotent merges keyed by MLV id, so two tabs crawling different queries simultaneously cannot overwrite each other. Every content script instance listens for changes and re-renders its UI live.

### Deep extraction flow
The content script can't `fetch()` article pages directly because ML's CORS policy blocks cross-origin reads from a `listado.mercadolibre.com.ve` origin to `articulo.mercadolibre.com.ve`. The background service worker (which has `host_permissions` for the whole `*.mercadolibre.com.ve` domain) performs the fetch and returns the HTML, which the content script parses with `DOMParser`.

---

## 🛡️ Privacy & permissions

| Permission | Why |
|---|---|
| `storage` | Persist products, queue, panel-visibility, config across tabs and sessions. |
| `activeTab` | Send `SHOW_PANEL` / `HIDE_PANEL` messages to the active ML tab from the popup. |
| `scripting` | Reserved for future programmatic injection (not currently used). |
| `tabs` | Query the active tab to send it messages from the popup. |
| `notifications` | Reserved for future native notifications (currently uses in-page banner + sound). |
| `host_permissions: *.mercadolibre.com.ve` | Crawl search pages and fetch article pages for deep extraction. |

**No analytics. No telemetry. No remote code. Everything stays local.**

---

## 🐛 Changelog

### v6.1.0 — Strategic Analysis + Scale Fixes

**New features:**
- ✅ **Strategic Analysis Dashboard** (`analysis.html`) — full-page dashboard opened from the popup or the content panel. Computes from crawled data:
  - Top-N rankings (by sales / score / revenue)
  - Seller concentration (HHI, market share, supplier/competitor classification)
  - Category/niche analysis (blue ocean detection)
  - Porter's Five Forces (computed from HHI, variance, seller counts)
  - FODA/SWOT matrix (auto-generated bullet points)
  - A1 Opportunity List (top 20 products, scored 0-100)
- ✅ **Export** — CSV rankings, CSV A1 list, Markdown strategic report.
- ✅ **Max-pages / max-products limits** — configurable in the Filtros & Config tab (default: 20 pages, 0 products = unlimited). Prevents over-crawling when you just want top-N.
- ✅ **HTTP 429 backoff** — exponential retry (2s → 4s → 8s → 16s → 30s, max 5 attempts) with status display. Previously the crawler just broke on rate-limiting.

**Scale fixes (cold-run audit findings):**
- ✅ **Virtualized results** — only renders 50 cards at a time with "load more" button. At 5000+ products, the old full-render froze the browser for seconds; now it's instant.
- ✅ **Debounced `renderResults`** — storage `onChanged` events coalesce within 250ms. A crawl that saves 100 pages no longer triggers 100 full re-renders.
- ✅ **Background in-memory cache** — the service worker keeps a `Map<id, product>` cache + debounced 400ms flush. Previously every `SAVE_PRODUCTS` message re-read ALL products from storage (O(n) per save × 100 saves = O(n²) I/O).
- ✅ **`unlimitedStorage` permission** — removes the default 10MB `chrome.storage.local` quota. At ~1KB/product, 10MB = ~10K product limit; now unlimited.
- ✅ **Fixed O(n²) A1 percentile bug** — the cold-run found the opportunity scoring took 6 seconds for 5000 products (linear scan per product). Fixed with pre-sorted arrays + binary search → 14ms for 5000 products (420x speedup), 23ms for 10000.
- ✅ **Scoped SPA navigation observer** — replaced the `MutationObserver` on `document.documentElement` (which fired on every DOM mutation, thousands/sec on ML's SPA) with a lightweight `setInterval` poll + `pushState`/`replaceState` hooks.
- ✅ **Reset `visibleCount` on filter/sort change** — prevents stale pagination state.

### v6.0.0 — Fixed & complete

**Critical functional regressions fixed (vs v4.0.5 userscript, lost in Gemini's v5.0.0):**
1. ✅ **Crawler restored** — `btn-start` handler, `addPhrasesToQueue`, `processNextInQueue`, `runCrawler`, `buildOffsetUrl`, `parsePage`, `renderQueueUI` all present.
2. ✅ **Swipe gestures restored** — touch + mouse drag, left=delete / right=+Deep.
3. ✅ **Pause button wired up.**
4. ✅ **CSV columns restored** — `Marca`, `Modelo`, `Especificaciones` back; `Moneda` added.
5. ✅ **Notification sound** on crawler completion AND deep-extraction completion.

**Architectural fixes:**
6. ✅ **Cross-tab live sync** via `chrome.storage.onChanged`.
7. ✅ **Idempotent product merges** by MLV id (no more concurrent-tab data loss).
8. ✅ **Background is the single source of truth** for both `ml_products` and `ml_deep_queue`.
9. ✅ **Every product has a stable `id`** (MLV id when available), so removal works for deep-extracted products too.
10. ✅ **Panel hides instead of removing**; toolbar icon reopens it.
11. ✅ **Toolbar popup** with stats + actions.
12. ✅ **Icons** (16/32/48/128).
13. ✅ **`web_accessible_resources`** for the popup logo.

**Robustness fixes:**
14. ✅ **XSS-safe** — `escapeHtml` / `escapeAttr` on every interpolation.
15. ✅ **Service-worker-asleep handling** — `chrome.runtime.lastError` + retry.
16. ✅ **Blob-based CSV** — no `data:` URI breakage on large payloads.
17. ✅ **`run_at: document_idle`** + SPA navigation observer.
18. ✅ **SPA route change handling** — `isArticlePage` recomputed, modal rebuilt.
19. ✅ **Deep fetch URL** preserves the full permalink when known.
20. ✅ **`parsePrice` stronger** — falls back to `.andes-money-amount__fraction` text + currency symbol.
21. ✅ **Currency distinction** — `Moneda` column derived from aria-label or currency symbol (`US$` → USD, `Bs.` → VES).

### v5.0.0 — Gemini-proposed (DO NOT USE)
Incomplete: crawler dropped, swipe gestures dropped, CSV columns lost, no cross-tab sync, race conditions, XSS risk, no icons, no popup. See `worklog.md` in the source conversation for the full audit.

### v4.0.5 — Original userscript
Single-file IIFE injected manually via DevTools or a userscript manager. No persistence across tabs, lost context on reload, URL-length limits on the `deep_ids` queue parameter. Kept in `legacy/userscript-v4.0.5.js` for reference.

---

## ⚠️ Known limitations / future work

- Selectors (`.ui-search-layout__item`, `.poly-price__amount`, `.ui-pdp-title`, etc.) are ML's current 2024–2025 markup. If ML ships a redesign, the parsers will need updates.
- No automatic retry on HTTP 429 / 503. If you hit rate limits, increase the **Delay Async Fetch** in the config tab.
- No export to XLSX — CSV opens fine in Excel/Sheets but isn't a native `.xlsx`.
- The crawler does not respect `robots.txt` for the offset pages themselves (ML's `robots.txt` allows crawling public search result pages at the time of writing; verify before deploying at scale).

---

## 📜 License

MIT — see `LICENSE` (or use freely; attribution appreciated).

---

## 👤 Author

Built for **[yosietserga](https://github.com/yosietserga)**. Issue reports welcome at the repo's Issues tab.
