"use client";

import { useMemo, useState } from "react";
import { Download, Search, ExternalLink } from "lucide-react";
import type { Product } from "@/lib/types";
import {
  NUM,
  STR,
  cityOf,
  topCategory,
  sellerLink,
  osintUrl,
  fmtMoney,
  fmtInt,
  downloadCSV,
} from "@/lib/types";
import { SectionHeading, EmptyState } from "@/components/Section";

type SortKey =
  | "sales_desc"
  | "visits_desc"
  | "price_desc"
  | "price_asc"
  | "score_desc"
  | "opinions_desc"
  | "name_asc";

const PAGE_SIZE = 25;

interface ProductsTabProps {
  products: Product[];
}

export function ProductsTab({ products }: ProductsTabProps) {
  const [text, setText] = useState("");
  const [seller, setSeller] = useState("");
  const [city, setCity] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<SortKey>("sales_desc");
  const [page, setPage] = useState(0);

  const sellers = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      const n = STR(p.Vendedor_Nombre).trim();
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [products]);

  const cities = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      const c = cityOf(p);
      if (c && c !== "Desconocida") set.add(c);
    }
    return [...set].sort();
  }, [products]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      const c = topCategory(p);
      if (c && c !== "Sin categoría") set.add(c);
    }
    return [...set].sort();
  }, [products]);

  const filtered = useMemo(() => {
    let list = products;
    if (text.trim()) {
      const q = text.trim().toLowerCase();
      list = list.filter((p) =>
        STR(p.Nombre).toLowerCase().includes(q) ||
        STR(p.Marca).toLowerCase().includes(q) ||
        STR(p.Modelo).toLowerCase().includes(q) ||
        STR(p.MLV_ID).toLowerCase().includes(q)
      );
    }
    if (seller) list = list.filter((p) => STR(p.Vendedor_Nombre) === seller);
    if (city) list = list.filter((p) => cityOf(p) === city);
    if (category) list = list.filter((p) => topCategory(p) === category);

    const sorted = [...list];
    const numKey = (p: Product, k: keyof Product) => NUM(p[k]);
    switch (sort) {
      case "sales_desc":
        sorted.sort((a, b) => NUM(b.Ventas_Estimadas) - NUM(a.Ventas_Estimadas));
        break;
      case "visits_desc":
        sorted.sort((a, b) => NUM(b.Visitas_10dias) - NUM(a.Visitas_10dias));
        break;
      case "price_desc":
        sorted.sort((a, b) => NUM(b.Precio_Numerico) - NUM(a.Precio_Numerico));
        break;
      case "price_asc":
        sorted.sort((a, b) => NUM(a.Precio_Numerico) - NUM(b.Precio_Numerico));
        break;
      case "score_desc":
        sorted.sort((a, b) => NUM(b.Score) - NUM(a.Score));
        break;
      case "opinions_desc":
        sorted.sort((a, b) => NUM(b.Opiniones) - NUM(a.Opiniones));
        break;
      case "name_asc":
        sorted.sort((a, b) => STR(a.Nombre).localeCompare(STR(b.Nombre)));
        break;
    }
    return sorted;
  }, [products, text, seller, city, category, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const visible = filtered.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE
  );

  const clearFilters = () => {
    setText("");
    setSeller("");
    setCity("");
    setCategory("");
    setSort("sales_desc");
    setPage(0);
  };

  const handleExport = () => {
    const rows = filtered.map((p) => ({
      MLV_ID: p.MLV_ID,
      Nombre: p.Nombre,
      Precio: NUM(p.Precio_Numerico),
      Score: NUM(p.Score),
      Opiniones: NUM(p.Opiniones),
      Ventas_Estimadas: NUM(p.Ventas_Estimadas),
      Visitas_10dias: NUM(p.Visitas_10dias),
      Vendedor: p.Vendedor_Nombre,
      Ciudad: cityOf(p),
      Categoria: topCategory(p),
      Categoria_Full: STR(p.Categorias) || STR(p.Subcategorias),
      Marca: p.Marca,
      Modelo: p.Modelo,
      EnvioGratis: p.EnvioGratis,
      Estatus: p.Vendedor_Estatus,
      Link: p.Link_Producto,
    }));
    downloadCSV(rows, `ml-productos-${Date.now()}.csv`);
  };

  if (products.length === 0) {
    return (
      <EmptyState
        icon="📦"
        title="No hay productos"
        message="Carga datos primero para ver el listado de productos."
      />
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Productos"
        subtitle={`${fmtInt(filtered.length)} de ${fmtInt(products.length)} productos · ${
          filtered.length !== products.length ? "filtrado" : "sin filtro"
        }`}
        right={
          <button
            onClick={handleExport}
            className="btn btn-green"
            title="Exportar los productos filtrados actuales a CSV"
          >
            <Download size={16} /> Exportar CSV
          </button>
        }
      />

      {/* Filters */}
      <div className="card grid grid-cols-1 gap-2 md:grid-cols-5">
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-medium text-gray-600">
            <Search size={12} className="mr-1 inline" /> Buscar
          </label>
          <input
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPage(0);
            }}
            placeholder="Nombre, marca, modelo o MLV ID…"
            className="input"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Vendedor
          </label>
          <select
            value={seller}
            onChange={(e) => {
              setSeller(e.target.value);
              setPage(0);
            }}
            className="input"
          >
            <option value="">Todos</option>
            {sellers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Ciudad
          </label>
          <select
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
              setPage(0);
            }}
            className="input"
          >
            <option value="">Todas</option>
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Categoría
          </label>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(0);
            }}
            className="input"
          >
            <option value="">Todas</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-4 flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Ordenar por
            </label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="input"
            >
              <option value="sales_desc">Ventas (mayor → menor)</option>
              <option value="visits_desc">Visitas (mayor → menor)</option>
              <option value="price_desc">Precio (mayor → menor)</option>
              <option value="price_asc">Precio (menor → mayor)</option>
              <option value="score_desc">Score (mayor → menor)</option>
              <option value="opinions_desc">Opiniones (mayor → menor)</option>
              <option value="name_asc">Nombre (A → Z)</option>
            </select>
          </div>
          <button onClick={clearFilters} className="btn btn-outline">
            ✕ Limpiar
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="table-wrap scroll-area" style={{ maxHeight: "32rem" }}>
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th className="text-right">Precio</th>
              <th className="text-right">Score</th>
              <th className="text-right">Ventas</th>
              <th className="text-right hide-mobile">Visitas</th>
              <th>Vendedor</th>
              <th className="hide-mobile">Ciudad</th>
              <th className="hide-mobile">OSINT</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr
                key={p.MLV_ID}
                title={`${p.Nombre}\nMLV ID: ${p.MLV_ID}\nVendedor: ${p.Vendedor_Nombre} (${p.Vendedor_Estatus})\nUbicación: ${p.Ubicacion_Tienda}\nCategoria: ${STR(p.Categorias) || topCategory(p)}\nSincronizado: ${p.Synced_At}`}
              >
                <td className="max-w-[18rem]">
                  <div className="flex items-center gap-2">
                    {p.Imagen ? (
                      <img
                        src={p.Imagen}
                        alt={STR(p.Nombre)}
                        className="h-9 w-9 flex-none rounded border border-gray-200 object-cover"
                        loading="lazy"
                      />
                    ) : null}
                    <div className="min-w-0">
                      <a
                        href={STR(p.Link_Producto)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate text-sm font-medium text-gray-800 hover:text-ml-green"
                      >
                        {STR(p.Nombre)}
                      </a>
                      <div className="truncate text-xs text-gray-500">
                        {STR(p.Marca)} {STR(p.Modelo)}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="text-right font-semibold">{fmtMoney(NUM(p.Precio_Numerico))}</td>
                <td className="text-right">
                  <span className="badge badge-yellow">⭐ {NUM(p.Score).toFixed(1)}</span>
                </td>
                <td className="text-right font-semibold text-ml-green">
                  {fmtInt(NUM(p.Ventas_Estimadas))}
                </td>
                <td className="text-right hide-mobile text-gray-700">
                  {fmtInt(NUM(p.Visitas_10dias))}
                </td>
                <td>
                  {(() => {
                    const link = sellerLink(p);
                    const name = STR(p.Vendedor_Nombre) || "(sin vendedor)";
                    if (!link) return <span className="text-gray-400">{name}</span>;
                    return (
                      <a
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`🏪 ${name} — Click para abrir la tienda ML`}
                        className="inline-flex max-w-[10rem] items-center gap-1 truncate text-sm font-medium text-ml-navy hover:text-ml-green"
                      >
                        <span className="truncate">{name}</span>
                        <ExternalLink size={12} className="flex-none" />
                      </a>
                    );
                  })()}
                </td>
                <td className="hide-mobile text-sm text-gray-700">{cityOf(p)}</td>
                <td className="hide-mobile">
                  <a
                    href={osintUrl(p)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-outline px-2 py-1 text-xs"
                    title={`Buscar OSINT sobre "${STR(p.Vendedor_Nombre)}" en Google (whatsapp, instagram, rif, telefono, tienda)`}
                  >
                    🔍 OSINT
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="text-gray-600">
          Página {safePage + 1} de {totalPages} · {fmtInt(filtered.length)} resultados
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            className="btn btn-outline px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ← Anterior
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}
            className="btn btn-outline px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Siguiente →
          </button>
        </div>
      </div>
    </div>
  );
}
