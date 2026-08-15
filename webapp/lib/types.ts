/**
 * Product shape returned by the Google Apps Script web app.
 * Fields are strings unless noted (Apps Script flattens everything via Sheets).
 */
export interface Product {
  MLV_ID: string;
  Nombre: string;
  Precio_Numerico: number;
  Score: number;
  Opiniones: number;
  Ventas_Estimadas: number;
  Visitas_10dias: number;
  EnvioGratis: string;
  Vendedor_Nombre: string;
  Vendedor_Estatus: string;
  Vendedor_Seguidores: string;
  Vendedor_Productos: string;
  Vendedor_Ventas: string;
  Vendedor_Recomendacion: string;
  Vendedor_AniosML: string;
  Vendedor_Link: string;
  Ubicacion_Tienda: string;
  Categoria: string;
  Subcategorias: string;
  Categorias: string;
  Marca: string;
  Modelo: string;
  Especificaciones: string;
  Category_Id: string;
  Seller_Id: string;
  Nordic_Attributes: string;
  All_Pictures: string;
  Imagen: string;
  Link_Producto: string;
  Google_Breakout_Vendedor: string;
  DeepExtracted: string;
  Synced_At: string;
}

export interface DataResponse {
  success: boolean;
  products: Product[];
  count: number;
  error?: string;
}

export const NUM = (v: unknown, fallback = 0): number => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
};

export const STR = (v: unknown, fallback = ""): string =>
  v === null || v === undefined ? fallback : String(v);

export const cityOf = (p: Product): string => {
  const u = STR(p.Ubicacion_Tienda).trim();
  if (!u) return "Desconocida";
  return u.split(",")[0].trim() || "Desconocida";
};

export const categoryPath = (p: Product): string => {
  if (p.Categorias) return String(p.Categorias).trim();
  const parts = [p.Categoria, p.Subcategorias].filter(Boolean);
  return parts.join(" > ").trim() || "Sin categoría";
};

export const topCategory = (p: Product): string => {
  const c = STR(p.Categoria).trim();
  if (c) return c;
  const full = categoryPath(p);
  return full.split(">")[0].trim() || "Sin categoría";
};

export const sellerLink = (p: Product): string => {
  const link = STR(p.Vendedor_Link).trim();
  if (link) return link;
  const name = STR(p.Vendedor_Nombre).trim();
  if (name) {
    return `https://www.google.com/search?q=${encodeURIComponent(
      `"${name}" vendedor MercadoLibre`
    )}`;
  }
  return "";
};

export const osintUrl = (p: Product): string => {
  const breakout = STR(p.Google_Breakout_Vendedor).trim();
  if (breakout) return breakout;
  const name = STR(p.Vendedor_Nombre).trim();
  const city = cityOf(p);
  const q = `"${name}" Venezuela ${city} (whatsapp OR instagram OR rif OR telefono OR tienda)`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
};

export interface SellerStats {
  name: string;
  count: number;
  totalSales: number;
  totalVisits: number;
  avgPrice: number;
  avgScore: number;
  estatus: string;
  seguidores: number;
  productosTotal: number;
  ventasTotal: number;
  recomendacion: number;
  aniosML: number;
  link: string;
  city: string;
  share: number; // market share of total sales
}

export const computeSellers = (products: Product[]): SellerStats[] => {
  const map = new Map<string, SellerStats>();
  let totalSales = 0;
  for (const p of products) {
    const name = STR(p.Vendedor_Nombre).trim() || "(sin vendedor)";
    totalSales += NUM(p.Ventas_Estimadas);
    if (!map.has(name)) {
      map.set(name, {
        name,
        count: 0,
        totalSales: 0,
        totalVisits: 0,
        avgPrice: 0,
        avgScore: 0,
        estatus: STR(p.Vendedor_Estatus),
        seguidores: NUM(p.Vendedor_Seguidores),
        productosTotal: NUM(p.Vendedor_Productos),
        ventasTotal: NUM(p.Vendedor_Ventas),
        recomendacion: NUM(p.Vendedor_Recomendacion),
        aniosML: NUM(p.Vendedor_AniosML),
        link: STR(p.Vendedor_Link),
        city: cityOf(p),
        share: 0,
      });
    }
    const s = map.get(name)!;
    s.count += 1;
    s.totalSales += NUM(p.Ventas_Estimadas);
    s.totalVisits += NUM(p.Visitas_10dias);
    s.avgPrice += NUM(p.Precio_Numerico);
    s.avgScore += NUM(p.Score);
  }
  const out: SellerStats[] = [];
  for (const s of map.values()) {
    s.avgPrice = s.count ? s.avgPrice / s.count : 0;
    s.avgScore = s.count ? s.avgScore / s.count : 0;
    s.share = totalSales > 0 ? s.totalSales / totalSales : 0;
    out.push(s);
  }
  return out.sort((a, b) => b.totalSales - a.totalSales);
};

export const priceStats = (prices: number[]) => {
  if (prices.length === 0) {
    return { min: 0, max: 0, avg: 0, median: 0, std: 0, cv: 0 };
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  const variance =
    sorted.reduce((acc, v) => acc + (v - avg) ** 2, 0) / sorted.length;
  const std = Math.sqrt(variance);
  const cv = avg > 0 ? std / avg : 0;
  return { min, max, avg, median, std, cv };
};

export const computeHHI = (shares: number[]): number => {
  // Herfindahl-Hirschman Index — sum of squared market shares (0-1 scale)
  return shares.reduce((acc, s) => acc + s * s, 0);
};

export const pct = (v: number, d = 1): string =>
  `${(v * 100).toFixed(d)}%`;

export const fmtMoney = (v: number, currency = "USD"): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(NUM(v));

export const fmtNum = (v: number): string =>
  new Intl.NumberFormat("en-US").format(NUM(v));

export const fmtInt = (v: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(NUM(v));

export interface CategoryStat {
  category: string;
  count: number;
  sellers: Set<string>;
  totalSales: number;
  totalVisits: number;
  avgPrice: number;
  avgScore: number;
  prices: number[];
}

export const computeCategories = (products: Product[]): CategoryStat[] => {
  const map = new Map<string, CategoryStat>();
  for (const p of products) {
    const cat = topCategory(p);
    if (!map.has(cat)) {
      map.set(cat, {
        category: cat,
        count: 0,
        sellers: new Set<string>(),
        totalSales: 0,
        totalVisits: 0,
        avgPrice: 0,
        avgScore: 0,
        prices: [],
      });
    }
    const c = map.get(cat)!;
    c.count += 1;
    c.sellers.add(STR(p.Vendedor_Nombre) || "(desconocido)");
    c.totalSales += NUM(p.Ventas_Estimadas);
    c.totalVisits += NUM(p.Visitas_10dias);
    c.avgPrice += NUM(p.Precio_Numerico);
    c.avgScore += NUM(p.Score);
    c.prices.push(NUM(p.Precio_Numerico));
  }
  const out: CategoryStat[] = [];
  for (const c of map.values()) {
    c.avgPrice = c.count ? c.avgPrice / c.count : 0;
    c.avgScore = c.count ? c.avgScore / c.count : 0;
    out.push(c);
  }
  return out.sort((a, b) => b.totalSales - a.totalSales);
};

export const opportunityScore = (c: CategoryStat): number => {
  // 40% demand + 25% openness (few sellers) + 15% quality + 10% price stability + 10% conversion
  const demand = Math.min(1, c.totalSales / 1000) * 40;
  const openness = Math.max(0, 1 - c.sellers.size / 20) * 25;
  const quality = Math.min(1, c.avgScore / 5) * 15;
  const ps = priceStats(c.prices);
  const stability = (1 - Math.min(1, ps.cv)) * 10;
  const conversion = c.totalVisits > 0 ? Math.min(1, c.totalSales / c.totalVisits / 0.1) * 10 : 0;
  return Math.round(demand + openness + quality + stability + conversion);
};

export const toCSV = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => escape(r[h])).join(","));
  }
  return lines.join("\n");
};

export const downloadCSV = (rows: Record<string, unknown>[], filename: string) => {
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
