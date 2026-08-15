"use client";

import { useMemo } from "react";
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
import { Layers } from "lucide-react";
import type { Product } from "@/lib/types";
import {
  NUM,
  fmtInt,
  fmtMoney,
  computeCategories,
  priceStats,
  opportunityScore,
  pct,
} from "@/lib/types";
import { SectionHeading, EmptyState } from "@/components/Section";

const ML_COLORS = ["#2d3277", "#00a650", "#fff159", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#3b82f6"];

interface CategoriesTabProps {
  products: Product[];
}

export function CategoriesTab({ products }: CategoriesTabProps) {
  const cats = useMemo(() => computeCategories(products), [products]);

  if (products.length === 0) {
    return (
      <EmptyState
        icon="🗂️"
        title="No hay categorías"
        message="Carga datos para ver el análisis por categoría."
      />
    );
  }

  const rows = cats.map((c) => {
    const ps = priceStats(c.prices);
    const conv = c.totalVisits > 0 ? c.totalSales / c.totalVisits : 0;
    const opp = opportunityScore(c);
    return { ...c, ps, conv, opp };
  });

  const sortedByCount = [...rows].sort((a, b) => b.count - a.count).slice(0, 12);

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Categorías"
        subtitle={`${fmtInt(cats.length)} categorías únicas — productos, ventas, conversión y oportunidad`}
      />

      {/* Bar chart of products per category */}
      <div className="card">
        <SectionHeading
          title="Productos por Categoría (Top 12)"
          subtitle="Distribución del catálogo"
        />
        {sortedByCount.length === 0 ? (
          <EmptyState icon="📊" title="Sin categorías para graficar" />
        ) : (
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <BarChart
                data={sortedByCount.map((c) => ({
                  name: c.category.length > 18 ? c.category.slice(0, 18) + "…" : c.category,
                  fullName: c.category,
                  productos: c.count,
                  vendedores: c.sellers.size,
                  ventas: c.totalSales,
                }))}
                margin={{ top: 5, right: 30, left: 20, bottom: 60 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10 }}
                  angle={-45}
                  textAnchor="end"
                  height={70}
                />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip
                  formatter={(value: number, _name, props) => [
                    `${fmtInt(value)} productos · ${props.payload.vendedores} vendedores · ${fmtInt(props.payload.ventas)} ventas`,
                    props.payload.fullName,
                  ]}
                  contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }}
                />
                <Bar dataKey="productos" radius={[4, 4, 0, 0]}>
                  {sortedByCount.map((_, i) => (
                    <Cell key={i} fill={ML_COLORS[i % ML_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Categories table */}
      <div className="table-wrap scroll-area" style={{ maxHeight: "32rem" }}>
        <table>
          <thead>
            <tr>
              <th>Categoría</th>
              <th className="text-right">Productos</th>
              <th className="text-right">Vendedores</th>
              <th className="text-right">Ventas</th>
              <th className="text-right hide-mobile">Visitas</th>
              <th className="text-right hide-mobile">Precio Prom.</th>
              <th className="text-right">Conv.</th>
              <th className="text-right">Oportunidad</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const convBadge =
                c.conv > 0.05 ? "green" : c.conv > 0.02 ? "yellow" : "red";
              const oppBadge =
                c.opp >= 70 ? "green" : c.opp >= 40 ? "yellow" : "gray";
              return (
                <tr
                  key={c.category}
                  title={`${c.category}\n${c.count} productos · ${c.sellers.size} vendedores\nVentas: ${fmtInt(c.totalSales)}  Visitas: ${fmtInt(c.totalVisits)}\nPrecio min ${fmtMoney(c.ps.min)} · max ${fmtMoney(c.ps.max)} · mediana ${fmtMoney(c.ps.median)}\nVolatilidad (CV): ${(c.ps.cv * 100).toFixed(0)}%`}
                >
                  <td className="flex items-center gap-1.5">
                    <Layers size={14} className="text-gray-400" />
                    <span className="font-medium text-gray-800">{c.category}</span>
                  </td>
                  <td className="text-right">{fmtInt(c.count)}</td>
                  <td className="text-right">{c.sellers.size}</td>
                  <td className="text-right font-semibold text-ml-green">
                    {fmtInt(c.totalSales)}
                  </td>
                  <td className="text-right hide-mobile text-gray-700">
                    {fmtInt(c.totalVisits)}
                  </td>
                  <td className="text-right hide-mobile">{fmtMoney(c.avgPrice)}</td>
                  <td className="text-right">
                    <span className={`badge badge-${convBadge}`}>
                      {pct(c.conv, 2)}
                    </span>
                  </td>
                  <td className="text-right">
                    <span className={`badge badge-${oppBadge}`}>{c.opp}/100</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-500">
        <strong>Opportunity Score</strong> = 40% demanda + 25% apertura (pocos
        vendedores) + 15% calidad + 10% estabilidad de precio + 10% conversión.
      </div>
    </div>
  );
}
