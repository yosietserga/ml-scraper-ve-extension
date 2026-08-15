"use client";

import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";
import { ExternalLink, Search } from "lucide-react";
import type { Product, SellerStats } from "@/lib/types";
import {
  NUM,
  STR,
  fmtInt,
  fmtMoney,
  computeSellers,
  computeHHI,
  sellerLink,
  cityOf,
  pct,
} from "@/lib/types";
import { SectionHeading, EmptyState } from "@/components/Section";

const ML_COLORS = ["#2d3277", "#00a650", "#fff159", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#3b82f6"];

interface SellersTabProps {
  products: Product[];
}

export function SellersTab({ products }: SellersTabProps) {
  const [query, setQuery] = useState("");

  const sellers: SellerStats[] = useMemo(
    () => computeSellers(products),
    [products]
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return sellers;
    const q = query.trim().toLowerCase();
    return sellers.filter((s) => s.name.toLowerCase().includes(q));
  }, [sellers, query]);

  const hhi = computeHHI(sellers.map((s) => s.share));
  const top3Share = sellers.slice(0, 3).reduce((acc, s) => acc + s.share, 0);
  const hhiLevel =
    hhi > 0.25 ? "Alta Concentración" : hhi > 0.15 ? "Media Concentración" : "Fragmentado";
  const hhiBadge = hhi > 0.25 ? "red" : hhi > 0.15 ? "yellow" : "green";

  const barData = sellers.slice(0, 12).map((s) => ({
    name: s.name.length > 18 ? s.name.slice(0, 18) + "…" : s.name,
    fullName: s.name,
    ventas: s.totalSales,
    share: s.share,
  }));

  if (products.length === 0) {
    return (
      <EmptyState
        icon="🏪"
        title="No hay vendedores"
        message="Carga datos primero para ver el análisis de vendedores."
      />
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Vendedores"
        subtitle={`${fmtInt(sellers.length)} vendedores únicos · HHI: ${hhi.toFixed(3)} (${hhiLevel}) · Top-3 share: ${pct(top3Share)}`}
      />

      {/* Concentration warning */}
      <div
        className={`card flex flex-wrap items-center gap-3 border-l-4 ${
          hhiBadge === "red"
            ? "border-red-500"
            : hhiBadge === "yellow"
            ? "border-yellow-400"
            : "border-ml-green"
        }`}
      >
        <div
          className={`badge ${
            hhiBadge === "red"
              ? "badge-red"
              : hhiBadge === "yellow"
              ? "badge-yellow"
              : "badge-green"
          }`}
        >
          {hhiLevel}
        </div>
        <div className="text-sm text-gray-700">
          Índice HHI: <strong>{hhi.toFixed(3)}</strong> · Top 3 vendedores
          controlan <strong>{pct(top3Share)}</strong> de las ventas totales.
        </div>
      </div>

      {/* Market share bar chart */}
      <div className="card">
        <SectionHeading
          title="Market Share — Top 12 Vendedores"
          subtitle="Ventas estimadas y porcentaje del mercado"
        />
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer>
            <BarChart
              data={barData}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12 }} />
              <YAxis
                type="category"
                dataKey="name"
                width={130}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                formatter={(value: number, _name, props) => [
                  `${fmtInt(value)} ventas · ${pct(props.payload.share)}`,
                  props.payload.fullName,
                ]}
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  fontSize: 12,
                }}
              />
              <Bar dataKey="ventas" radius={[0, 4, 4, 0]}>
                {barData.map((_, i) => (
                  <Cell key={i} fill={ML_COLORS[i % ML_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Search */}
      <div className="card">
        <label className="mb-1 block text-xs font-medium text-gray-600">
          <Search size={12} className="mr-1 inline" /> Buscar vendedor
        </label>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Nombre del vendedor…"
          className="input"
        />
      </div>

      {/* Sellers table */}
      <div className="table-wrap scroll-area" style={{ maxHeight: "32rem" }}>
        <table>
          <thead>
            <tr>
              <th>Vendedor</th>
              <th className="text-right">Productos</th>
              <th className="text-right">Ventas</th>
              <th className="text-right">Visitas</th>
              <th className="text-right hide-mobile">Precio Prom.</th>
              <th className="text-right hide-mobile">Score</th>
              <th className="text-right">Share</th>
              <th className="hide-mobile">Estatus</th>
              <th className="hide-mobile">OSINT</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr
                key={s.name}
                title={`${s.name}\nProductos: ${s.count}  Ventas: ${fmtInt(s.totalSales)}\nCiudad: ${s.city}  Estatus: ${s.estatus}\nSeguidores: ${fmtInt(s.seguidores)}  Años ML: ${s.aniosML}\nRecomendación: ${s.recomendacion}%  Productos totales: ${fmtInt(s.productosTotal)}`}
              >
                <td>
                  {s.link ? (
                    <a
                      href={s.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium text-ml-navy hover:text-ml-green"
                    >
                      <span>{s.name}</span>
                      <ExternalLink size={12} className="flex-none" />
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-gray-800">{s.name}</span>
                  )}
                  <div className="text-xs text-gray-500">{s.city}</div>
                </td>
                <td className="text-right">{fmtInt(s.count)}</td>
                <td className="text-right font-semibold text-ml-green">
                  {fmtInt(s.totalSales)}
                </td>
                <td className="text-right text-gray-700">{fmtInt(s.totalVisits)}</td>
                <td className="text-right hide-mobile">{fmtMoney(s.avgPrice)}</td>
                <td className="text-right hide-mobile">
                  <span className="badge badge-yellow">⭐ {s.avgScore.toFixed(2)}</span>
                </td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <div className="hidden w-16 bg-gray-100 sm:block" style={{ height: 6 }}>
                      <div
                        className="bg-ml-green"
                        style={{ width: `${Math.min(100, s.share * 100)}%`, height: 6 }}
                      />
                    </div>
                    <span className="font-semibold">{pct(s.share)}</span>
                  </div>
                </td>
                <td className="hide-mobile text-xs text-gray-600">
                  {s.estatus ? (
                    <span className="badge badge-navy">{s.estatus}</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="hide-mobile">
                  <a
                    href={`https://www.google.com/search?q=${encodeURIComponent(
                      `"${s.name}" Venezuela ${s.city} (whatsapp OR instagram OR rif OR telefono OR tienda)`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-outline px-2 py-1 text-xs"
                    title={`OSINT: buscar "${s.name}" en Google (whatsapp, instagram, rif, telefono, tienda)`}
                  >
                    🔍 OSINT
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
