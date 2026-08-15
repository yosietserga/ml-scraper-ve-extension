"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { Package, Search, Star, Eye, ShoppingCart, DollarSign, Store } from "lucide-react";
import type { Product } from "@/lib/types";
import {
  NUM,
  STR,
  fmtInt,
  fmtMoney,
  fmtNum,
  sellerLink,
  computeSellers,
  computeCategories,
  cityOf,
  priceStats,
} from "@/lib/types";
import { StatCard } from "@/components/StatCard";
import { SectionHeading, EmptyState } from "@/components/Section";

const ML_COLORS = ["#2d3277", "#00a650", "#fff159", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6"];

interface OverviewTabProps {
  products: Product[];
}

export function OverviewTab({ products }: OverviewTabProps) {
  if (products.length === 0) {
    return (
      <EmptyState
        icon="📊"
        title="No hay productos para mostrar"
        message="Configura la URL del Apps Script y carga datos para ver el resumen."
      />
    );
  }

  const totalProducts = products.length;
  const deepExtracted = products.filter(
    (p) => STR(p.DeepExtracted).toLowerCase() === "sí"
  ).length;
  const avgScore =
    products.reduce((acc, p) => acc + NUM(p.Score), 0) / totalProducts;
  const totalVisits = products.reduce(
    (acc, p) => acc + NUM(p.Visitas_10dias),
    0
  );
  const totalSales = products.reduce(
    (acc, p) => acc + NUM(p.Ventas_Estimadas),
    0
  );
  const avgPrice =
    products.reduce((acc, p) => acc + NUM(p.Precio_Numerico), 0) /
    totalProducts;
  const uniqueSellers = new Set(
    products.map((p) => STR(p.Vendedor_Nombre)).filter(Boolean)
  ).size;

  const topBySales = [...products]
    .sort((a, b) => NUM(b.Ventas_Estimadas) - NUM(a.Ventas_Estimadas))
    .slice(0, 10);
  const topByVisits = [...products]
    .sort((a, b) => NUM(b.Visitas_10dias) - NUM(a.Visitas_10dias))
    .slice(0, 10);

  const sellers = computeSellers(products);
  const topSellers = sellers.slice(0, 10).map((s) => ({
    name: s.name.length > 22 ? s.name.slice(0, 22) + "…" : s.name,
    fullName: s.name,
    ventas: s.totalSales,
    share: s.share,
  }));

  // City distribution
  const cityMap = new Map<string, number>();
  for (const p of products) {
    const c = cityOf(p);
    cityMap.set(c, (cityMap.get(c) || 0) + 1);
  }
  const cityData = [...cityMap.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // Price distribution (buckets of $5)
  const allPrices = products.map((p) => NUM(p.Precio_Numerico)).filter((v) => v > 0);
  const ps = priceStats(allPrices);
  const buckets = new Map<string, number>();
  for (const price of allPrices) {
    const b = Math.floor(price / 5) * 5;
    const key = `$${b}-${b + 5}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const priceData = [...buckets.entries()]
    .sort(([a], [b]) => {
      const av = parseInt(a.replace(/\D/g, ""), 10);
      const bv = parseInt(b.replace(/\D/g, ""), 10);
      return av - bv;
    })
    .slice(0, 15)
    .map(([range, count]) => ({ range, count }));

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <StatCard
          label="Productos"
          value={fmtInt(totalProducts)}
          hint={`${deepExtracted} con deep extract`}
          icon={Package}
          accent="navy"
        />
        <StatCard
          label="Deep Extracted"
          value={fmtInt(deepExtracted)}
          hint={`${((deepExtracted / totalProducts) * 100).toFixed(0)}% del total`}
          icon={Search}
          accent="yellow"
        />
        <StatCard
          label="Score Prom."
          value={avgScore.toFixed(2)}
          hint="0-5 estrellas"
          icon={Star}
          accent="green"
        />
        <StatCard
          label="Visitas (10d)"
          value={fmtNum(totalVisits)}
          hint={`${fmtInt(totalVisits / 10)} / día`}
          icon={Eye}
          accent="navy"
        />
        <StatCard
          label="Ventas Est."
          value={fmtNum(totalSales)}
          hint={`${fmtInt(totalSales / 10)} / día`}
          icon={ShoppingCart}
          accent="green"
        />
        <StatCard
          label="Precio Prom."
          value={fmtMoney(avgPrice)}
          hint={`mediana ${fmtMoney(ps.median)}`}
          icon={DollarSign}
          accent="yellow"
        />
        <StatCard
          label="Vendedores"
          value={fmtInt(uniqueSellers)}
          hint={`${(totalProducts / uniqueSellers).toFixed(1)} prod/vend`}
          icon={Store}
          accent="navy"
        />
      </div>

      {/* Top 10 lists */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <SectionHeading
            title="Top 10 por Ventas"
            subtitle="Productos con más ventas estimadas"
          />
          <ul className="space-y-1.5">
            {topBySales.map((p, i) => (
              <li
                key={p.MLV_ID + i}
                title={`${p.Nombre}\nVentas: ${fmtInt(NUM(p.Ventas_Estimadas))}  Visitas: ${fmtInt(NUM(p.Visitas_10dias))}\nVendedor: ${p.Vendedor_Nombre}\nUbicación: ${p.Ubicacion_Tienda}`}
                className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-50"
              >
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-ml-navy text-xs font-bold text-white">
                  {i + 1}
                </span>
                <a
                  href={STR(p.Link_Producto)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate text-sm font-medium text-gray-800 hover:text-ml-green"
                >
                  {STR(p.Nombre)}
                </a>
                <span className="flex-none text-sm font-bold text-ml-green">
                  {fmtInt(NUM(p.Ventas_Estimadas))}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <SectionHeading
            title="Top 10 por Visitas"
            subtitle="Productos con más visitas en 10 días"
          />
          <ul className="space-y-1.5">
            {topByVisits.map((p, i) => (
              <li
                key={p.MLV_ID + i}
                title={`${p.Nombre}\nVisitas: ${fmtInt(NUM(p.Visitas_10dias))}  Ventas: ${fmtInt(NUM(p.Ventas_Estimadas))}\nConversión: ${(NUM(p.Ventas_Estimadas) / Math.max(1, NUM(p.Visitas_10dias)) * 100).toFixed(2)}%\nVendedor: ${p.Vendedor_Nombre}`}
                className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-50"
              >
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-ml-green text-xs font-bold text-white">
                  {i + 1}
                </span>
                <a
                  href={STR(p.Link_Producto)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate text-sm font-medium text-gray-800 hover:text-ml-navy"
                >
                  {STR(p.Nombre)}
                </a>
                <span className="flex-none text-sm font-bold text-ml-navy">
                  {fmtInt(NUM(p.Visitas_10dias))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Top sellers bar */}
      <div className="card">
        <SectionHeading
          title="Top 10 Vendedores por Ventas"
          subtitle="Click en el nombre del vendedor para abrir su tienda ML"
        />
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer>
            <BarChart
              data={topSellers}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12 }} />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                formatter={(value: number, _name, props) => [
                  `${fmtInt(value)} ventas (${(props.payload.share * 100).toFixed(1)}% share)`,
                  props.payload.fullName,
                ]}
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  fontSize: 12,
                }}
              />
              <Bar dataKey="ventas" radius={[0, 4, 4, 0]}>
                {topSellers.map((_, i) => (
                  <Cell key={i} fill={ML_COLORS[i % ML_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* City + Price distribution */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <SectionHeading
            title="Distribución por Ciudad"
            subtitle="Top 8 ciudades por cantidad de productos"
          />
          {cityData.length === 0 ? (
            <EmptyState
              icon="📍"
              title="Sin datos de ubicación"
              message="Los productos no tienen Ubicacion_Tienda cargada."
            />
          ) : (
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={cityData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={40}
                    label={(entry) => `${entry.name} (${entry.value})`}
                    labelLine={false}
                  >
                    {cityData.map((_, i) => (
                      <Cell key={i} fill={ML_COLORS[i % ML_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      `${fmtInt(value)} productos`,
                      name,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card">
          <SectionHeading
            title="Distribución de Precios"
            subtitle={`Rangos de $5 (min ${fmtMoney(ps.min)} · max ${fmtMoney(ps.max)} · mediana ${fmtMoney(ps.median)})`}
          />
          {priceData.length === 0 ? (
            <EmptyState icon="💵" title="Sin precios para graficar" />
          ) : (
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <BarChart
                  data={priceData}
                  margin={{ top: 5, right: 20, left: 0, bottom: 30 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="range"
                    tick={{ fontSize: 10 }}
                    angle={-45}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip
                    formatter={(v: number) => [`${v} productos`, "Cantidad"]}
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid #e5e7eb",
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" fill="#2d3277" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OverviewCardsPreview({
  products,
}: {
  products: Product[];
}) {
  // Lightweight stats for topbar
  const totalProducts = products.length;
  const uniqueSellers = new Set(
    products.map((p) => STR(p.Vendedor_Nombre)).filter(Boolean)
  ).size;
  return (
    <div className="flex gap-3 text-xs text-gray-500">
      <span>{fmtInt(totalProducts)} productos</span>
      <span>·</span>
      <span>{fmtInt(uniqueSellers)} vendedores</span>
    </div>
  );
}

export function computeOverviewQuickStats(products: Product[]) {
  return {
    products: products.length,
    sellers: new Set(products.map((p) => STR(p.Vendedor_Nombre)).filter(Boolean))
      .size,
    categories: computeCategories(products).length,
    sales: products.reduce((a, p) => a + NUM(p.Ventas_Estimadas), 0),
  };
}
