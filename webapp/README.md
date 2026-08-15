# ML Scraper Analytics — Web Dashboard

A production-ready Next.js 16 dashboard that reads MercadoLibre VE product data
from a Google Apps Script web app and renders a full analytics suite:
overview, products, sellers, trends, profit calculator, and categories.

Part of the [`ml-scraper-ve-extension`](https://github.com/yosietserga/ml-scraper-ve-extension)
project (Task 6.17.0).

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyosietserga%2Fml-scraper-ve-extension&project-name=ml-scraper-analytics&repository-name=ml-scraper-analytics&root-directory=webapp&env=SHEETS_API_URL&envDescription=Google%20Apps%20Script%20web%20app%20URL%20ending%20in%20%2Fexec)

1. Click the **Deploy** button above (or import the repo into Vercel).
2. Set the **root directory** to `webapp` when importing.
3. In the Vercel project settings → **Environment Variables**, add:
   - `SHEETS_API_URL` = the Google Apps Script web app URL ending in `/exec`
4. Deploy. Vercel will run `bun run build` and serve the standalone output.

## Configure the Apps Script URL

You can configure the upstream Google Apps Script endpoint in **two ways**:

### 1. Environment variable (recommended for production)

Create a `.env.local` file (for local dev) or set the env var on Vercel:

```bash
# .env.local
SHEETS_API_URL=https://script.google.com/macros/s/AKfyc.../exec
```

The Apps Script must respond to `GET ?action=data` with the JSON shape
documented in [Data shape](#data-shape) below. The `?action=data` query
parameter is appended automatically by the `/api/data` proxy route.

### 2. Settings UI (for local dev / quick override)

Click the **⚙ Config** button in the top-right of the dashboard, paste the
URL, and click **Guardar y sincronizar**. The URL is stored in
`localStorage` and overrides the env var. Clear the field to fall back to
the env var.

> **Why a proxy?** Apps Script endpoints do not send CORS headers, so direct
> `fetch()` from the browser is blocked. The `/api/data` Next.js route
> fetches server-side and forwards the JSON.

## Local development

Requirements: Node 18+, Bun 1.1+ (or npm/pnpm/yarn — adapt commands).

```bash
cd webapp
cp .env.example .env.local
# Edit .env.local and paste your Apps Script URL
bun install
bun run dev
```

Open <http://localhost:3000>.

To check code quality: `bun run lint`. To build: `bun run build`.

## Data shape

The Apps Script endpoint `GET ?action=data` must return:

```json
{
  "success": true,
  "products": [
    {
      "MLV_ID": "MLV712527634",
      "Nombre": "Papel Adhesivo...",
      "Precio_Numerico": 15.99,
      "Score": 4.8,
      "Opiniones": 156,
      "Ventas_Estimadas": 500,
      "Visitas_10dias": 4500,
      "EnvioGratis": "Sí",
      "Vendedor_Nombre": "VRSTORE CA",
      "Vendedor_Estatus": "MercadoLíder Platinum",
      "Vendedor_Seguidores": "4600",
      "Vendedor_Productos": "100",
      "Vendedor_Ventas": "10000",
      "Vendedor_Recomendacion": "100",
      "Vendedor_AniosML": "21",
      "Vendedor_Link": "https://www.mercadolibre.com.ve/pagina/...",
      "Ubicacion_Tienda": "Caracas, Distrito Capital",
      "Categoria": "Computación",
      "Subcategorias": "Impresión > Impresoras",
      "Categorias": "Computación > Impresión > Impresoras",
      "Marca": "HP",
      "Modelo": "M111w",
      "Especificaciones": "Marca: HP | Modelo: M111w | ...",
      "Category_Id": "MLV1676",
      "Seller_Id": "200396125",
      "Nordic_Attributes": "{\"BRAND\":{\"name\":\"Marca\",\"value_name\":\"HP\"}}",
      "All_Pictures": "https://...jpg ; https://...jpg",
      "Imagen": "https://...jpg",
      "Link_Producto": "https://articulo.mercadolibre.com.ve/MLV-...",
      "Google_Breakout_Vendedor": "https://www.google.com/search?q=...",
      "DeepExtracted": "Sí",
      "Synced_At": "2026-08-15T..."
    }
  ],
  "count": 100
}
```

Fields are mostly strings (Apps Script flattens via Sheets); numeric parsing
happens client-side via `NUM()`.

## Dashboard sections

| Tab | Features |
|-----|----------|
| **Resumen** (Overview) | 7 stat cards (products, deep extracted, avg score, total visits, total sales, avg price, unique sellers). Top-10 by sales. Top-10 by visits. Top-10 sellers bar chart. City distribution pie. Price distribution histogram. Rich tooltips on every chart and list. |
| **Productos** (Products) | Filterable / sortable table of ALL products. Filters: text, seller dropdown, city dropdown, category dropdown, sort by sales/visits/price/score/opinions/name. Pagination 25/page. CSV export of the current filtered set. OSINT button per row. Clickable seller names + product links. |
| **Vendedores** (Sellers) | Seller concentration banner (HHI + level). Top-12 sellers market-share bar chart. Sortable table: product count, sales, visits, avg price, avg score, market share bar, estatus, OSINT button. Clickable seller names → ML store. |
| **Tendencias** (Trends) | Demand projection (visits/day, sales/day, conversion). Demand latency (high visits, low conversion). Market concentration (HHI). Price volatility (CV). Opportunities (high demand + good score). Blue ocean (high demand, few sellers). Risk list. |
| **Ganancia** (Profit Calculator) | Input cost price → see sell price, ML commission (default 15%, adjustable), net profit and margin at 5 markup levels (10%, 20%, 30%, 50%, 100%). Color-coded rentable / pérdida. |
| **Categorías** (Categories) | Top-12 categories bar chart. Table: products, sellers, sales, visits, avg price, conversion rate (color-coded), opportunity score (40% demand + 25% openness + 15% quality + 10% price stability + 10% conversion). |

## Features

- **ML brand colors**: yellow `#fff159`, green `#00a650`, navy `#2d3277`. No
  blue/indigo primary.
- **Auto-refresh every 60 seconds** (toggleable).
- **Loading states** with spinner + cold-start message.
- **Empty states** with helpful messages on every section.
- **Toast notifications** for sync / save / error events.
- **CSV export** of filtered products.
- **OSINT buttons** that open Google search with the seller name + city and a
  boolean OR query (`whatsapp OR instagram OR rif OR telefono OR tienda`).
- **Responsive mobile-first design** with bottom tab bar on mobile and a
  fixed sidebar on desktop.
- **Sticky table headers**, custom scrollbars, hover lifts on cards.
- **Server-side proxy** at `/api/data` to bypass Apps Script CORS.
- **Standalone Next.js build** for Vercel (`output: "standalone"`).

## OSINT URL format

```
https://www.google.com/search?q="SELLER_NAME" Venezuela CITY (whatsapp OR instagram OR rif OR telefono OR tienda)
```

If `Google_Breakout_Vendedor` is present on the product, that URL is used
instead.

## Screenshots

> Screenshots are captured from the live preview; descriptions below.

1. **Overview tab** — 7 KPI cards across the top; Top-10-by-sales and
   Top-10-by-visits lists; vertical bar chart of top-10 sellers by sales;
   donut chart of city distribution; histogram of price buckets.
2. **Products tab** — Filter row (search + 3 dropdowns + sort + clear);
   paginated table with thumbnail, price, score badge, sales, visits,
   clickable seller with external-link icon, OSINT button.
3. **Sellers tab** — HHI concentration banner; horizontal bar chart of
   top-12 sellers by sales; sortable table with market-share bar + share %.
4. **Trends tab** — 4 demand KPI cards; latent-demand list; HHI meter;
   opportunities list with score badges; blue-ocean bar chart; risks list.
5. **Profit calculator** — cost + commission inputs; 5 result cards showing
   sell price, commission, profit, margin, rentable/pérdida badge.
6. **Categories tab** — Top-12 categories bar chart; table with conversion
   badge (green/yellow/red) and opportunity score badge.
7. **Mobile view** — bottom tab bar with 6 icons; stacked cards; horizontally
   scrollable tables with sticky headers.
8. **Settings drawer** — URL input + save/use-env/close buttons.

## Architecture

```
webapp/
├── app/
│   ├── api/data/route.ts     Server-side proxy to Apps Script (CORS bypass)
│   ├── globals.css           Tailwind + ML brand palette + custom utilities
│   ├── layout.tsx            Root layout with metadata
│   └── page.tsx              Main dashboard (client component, tab router)
├── components/
│   ├── OverviewTab.tsx       Overview section + recharts pie/bar/histogram
│   ├── ProductsTab.tsx       Filterable/sortable table + CSV export
│   ├── SellersTab.tsx       HHI + market-share chart + sellers table
│   ├── TrendsTab.tsx         Demand projection, latent demand, blue ocean, risks
│   ├── ProfitCalculator.tsx  Cost → 5 markup scenarios
│   ├── CategoriesTab.tsx     Category breakdown + opportunity score
│   ├── StatCard.tsx          Reusable stat card
│   └── Section.tsx           SectionHeading / EmptyState / LoadingState
├── lib/
│   └── types.ts              Product type + helpers (NUM, sellerLink, osintUrl, HHI, priceStats, etc.)
├── package.json
├── next.config.ts            output: standalone
├── tsconfig.json
├── tailwind.config.ts        ML brand colors
├── postcss.config.mjs
├── vercel.json
├── .env.example
└── README.md
```

## License

Same as the parent `ml-scraper-ve-extension` repo.
