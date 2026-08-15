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
import {
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  Waves,
  ShieldAlert,
} from "lucide-react";
import type { Product, SellerStats } from "@/lib/types";
import {
  NUM,
  STR,
  fmtInt,
  fmtMoney,
  computeSellers,
  computeCategories,
  computeHHI,
  priceStats,
  topCategory,
  sellerLink,
} from "@/lib/types";
import { SectionHeading, EmptyState } from "@/components/Section";

const ML_COLORS = ["#2d3277", "#00a650", "#fff159", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#3b82f6"];

interface TrendsTabProps {
  products: Product[];
}

export function TrendsTab({ products }: TrendsTabProps) {
  const sellers: SellerStats[] = useMemo(() => computeSellers(products), [products]);
  const categories = useMemo(() => computeCategories(products), [products]);

  if (products.length === 0) {
    return (
      <EmptyState
        icon="🔮"
        title="No hay datos suficientes"
        message="Carga datos para ver el análisis de tendencias."
      />
    );
  }

  // Demand projection (visits/day, sales/day across the dataset — assuming the 10-day window)
  const totalVisits = products.reduce((acc, p) => acc + NUM(p.Visitas_10dias), 0);
  const totalSales = products.reduce((acc, p) => acc + NUM(p.Ventas_Estimadas), 0);
  const visitsDay = totalVisits / 10;
  const salesDay = totalSales / 10;
  const avgConversion = totalVisits > 0 ? totalSales / totalVisits : 0;

  // Latent demand: high visits but low conversion (< 2%)
  const latent = products
    .map((p) => {
      const v = NUM(p.Visitas_10dias);
      const s = NUM(p.Ventas_Estimadas);
      const conv = v > 0 ? s / v : 0;
      return { p, visits: v, sales: s, conv };
    })
    .filter((x) => x.visits >= 100 && x.conv < 0.02)
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 8);

  // HHI
  const hhi = computeHHI(sellers.map((s) => s.share));
  const hhiLevel =
    hhi > 0.25 ? "Alta Concentración" : hhi > 0.15 ? "Media" : "Fragmentado";
  const hhiBadge = hhi > 0.25 ? "red" : hhi > 0.15 ? "yellow" : "green";

  // Price volatility (CV overall)
  const allPrices = products.map((p) => NUM(p.Precio_Numerico)).filter((v) => v > 0);
  const ps = priceStats(allPrices);
  const cvPct = ps.cv * 100;
  const cvLevel = cvPct > 60 ? "Muy Alta" : cvPct > 30 ? "Alta" : cvPct > 15 ? "Media" : "Baja";
  const cvBadge = cvPct > 60 ? "red" : cvPct > 30 ? "yellow" : "green";

  // Opportunities: high demand + good score
  const opportunities = products
    .map((p) => {
      const sales = NUM(p.Ventas_Estimadas);
      const visits = NUM(p.Visitas_10dias);
      const score = NUM(p.Score);
      const demandPctile = sales; // raw value used for ranking
      const sellerProducts = NUM(p.Vendedor_Productos);
      const openness = Math.max(0, 1 - sellerProducts / 50); // smaller seller = more open
      const oppScore =
        Math.min(1, demandPctile / 500) * 0.4 +
        (score / 5) * 0.3 +
        openness * 0.3;
      return { p, oppScore, sales, visits, score, sellerName: STR(p.Vendedor_Nombre) };
    })
    .sort((a, b) => b.oppScore - a.oppScore)
    .slice(0, 8);

  // Blue ocean: high demand, few sellers
  const blueOceans = categories
    .map((c) => {
      const sellers = c.sellers.size;
      const demand = c.totalSales;
      const oceanScore = sellers > 0 ? demand / sellers : 0;
      return { ...c, oceanScore };
    })
    .filter((c) => c.count >= 3 && c.sellers.size <= 5 && c.totalSales > 0)
    .sort((a, b) => b.oceanScore - a.oceanScore)
    .slice(0, 6);

  // Risks
  const risks: string[] = [];
  if (hhi > 0.25)
    risks.push(
      "Mercado altamente concentrado — dominancia de pocos vendedores puede dificultar entrada."
    );
  if (cvPct > 60)
    risks.push(
      `Alta volatilidad de precios (CV ${cvPct.toFixed(0)}%) — guerras de precios activas.`
    );
  if (sellers.length > 0 && sellers[0].share > 0.3)
    risks.push(
      `Vendedor dominante "${sellers[0].name}" controla ${(sellers[0].share * 100).toFixed(1)}% del mercado.`
    );
  if (avgConversion < 0.02)
    risks.push(
      `Conversión global muy baja (${(avgConversion * 100).toFixed(2)}%) — demanda fría o problemas de UX.`
    );
  if (products.length < 50)
    risks.push(
      `Muestra pequeña (${products.length} productos) — conclusiones tentativas.`
    );
  if (risks.length === 0) risks.push("No se detectaron riesgos críticos.");

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Tendencias"
        subtitle="Análisis algorítmico de demanda, concentración y oportunidades"
      />

      {/* Demand projection */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card card-hover">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
            <TrendingUp size={12} className="mr-1 inline" /> Visitas / día
          </div>
          <div className="text-2xl font-bold text-ml-navy">{fmtInt(visitsDay)}</div>
          <div className="text-xs text-gray-500">{fmtInt(totalVisits)} en 10 días</div>
        </div>
        <div className="card card-hover">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
            <TrendingUp size={12} className="mr-1 inline" /> Ventas / día
          </div>
          <div className="text-2xl font-bold text-ml-green">{fmtInt(salesDay)}</div>
          <div className="text-xs text-gray-500">{fmtInt(totalSales)} en 10 días</div>
        </div>
        <div className="card card-hover">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Conversión Global
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {(avgConversion * 100).toFixed(2)}%
          </div>
          <div className="text-xs text-gray-500">ventas / visitas</div>
        </div>
        <div className="card card-hover">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Volatilidad Precio (CV)
          </div>
          <div className="text-2xl font-bold text-gray-900">{cvPct.toFixed(0)}%</div>
          <div className={`badge badge-${cvBadge}`}>{cvLevel}</div>
        </div>
      </div>

      {/* Latent demand */}
      <div className="card">
        <SectionHeading
          title="Demanda Latente"
          subtitle="Productos con muchas visitas pero baja conversión (< 2%). Oportunidad de optimizar listings."
        />
        {latent.length === 0 ? (
          <EmptyState
            icon="💤"
            title="Sin demanda latente detectada"
            message="Todos los productos con visitas tienen conversión aceptable."
          />
        ) : (
          <ul className="space-y-1.5">
            {latent.map(({ p, visits, sales, conv }) => (
              <li
                key={p.MLV_ID}
                className="flex items-center gap-2 rounded border border-yellow-200 bg-yellow-50/50 px-2 py-1.5"
                title={`${p.Nombre}\nVisitas: ${fmtInt(visits)}  Ventas: ${fmtInt(sales)}  Conversión: ${(conv * 100).toFixed(2)}%\nVendedor: ${p.Vendedor_Nombre}`}
              >
                <span className="text-lg">💤</span>
                <a
                  href={STR(p.Link_Producto)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate text-sm font-medium text-gray-800 hover:text-ml-green"
                >
                  {STR(p.Nombre)}
                </a>
                <span className="flex-none text-xs text-gray-600">
                  {fmtInt(visits)} visitas
                </span>
                <span className="flex-none badge badge-yellow">
                  {(conv * 100).toFixed(2)}% conv
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Market concentration */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <SectionHeading
            title="Concentración de Mercado"
            subtitle={`HHI: ${hhi.toFixed(3)} — ${hhiLevel}`}
          />
          <div className="flex items-center gap-3">
            <span className={`badge badge-${hhiBadge}`}>{hhiLevel}</span>
            <div className="flex-1">
              <div className="h-3 w-full rounded-full bg-gray-100">
                <div
                  className={`h-3 rounded-full ${
                    hhiBadge === "red"
                      ? "bg-red-500"
                      : hhiBadge === "yellow"
                      ? "bg-yellow-400"
                      : "bg-ml-green"
                  }`}
                  style={{ width: `${Math.min(100, hhi * 200)}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-gray-500">
                0 = perfectamente fragmentado · 1 = monopolio
              </div>
            </div>
          </div>
          <div className="mt-3 space-y-1 text-sm">
            {sellers.slice(0, 5).map((s, i) => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="w-5 text-gray-400">{i + 1}.</span>
                <a
                  href={sellerLink({ Vendedor_Link: s.link, Vendedor_Nombre: s.name } as Product)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate text-ml-navy hover:text-ml-green"
                >
                  {s.name}
                </a>
                <span className="font-semibold text-ml-green">
                  {(s.share * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Opportunities */}
        <div className="card">
          <SectionHeading
            title="Oportunidades"
            subtitle="Alta demanda + buen score + vendedor no dominante"
          />
          {opportunities.length === 0 ? (
            <EmptyState icon="🎯" title="Sin oportunidades detectadas" />
          ) : (
            <ul className="space-y-1.5">
              {opportunities.map(({ p, oppScore, sales, visits, score, sellerName }) => (
                <li
                  key={p.MLV_ID}
                  className="flex items-center gap-2 rounded border border-green-200 bg-green-50/40 px-2 py-1.5"
                  title={`${p.Nombre}\nOpportunity score: ${(oppScore * 100).toFixed(0)}/100\nVentas: ${fmtInt(sales)}  Visitas: ${fmtInt(visits)}  Score: ${score}\nVendedor: ${sellerName}`}
                >
                  <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-ml-green text-xs font-bold text-white">
                    {Math.round(oppScore * 100)}
                  </span>
                  <a
                    href={STR(p.Link_Producto)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 truncate text-sm font-medium text-gray-800 hover:text-ml-green"
                  >
                    {STR(p.Nombre)}
                  </a>
                  <span className="flex-none text-xs text-gray-600">{fmtInt(sales)} v</span>
                  <span className="flex-none badge badge-yellow">⭐ {score.toFixed(1)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Blue ocean */}
      <div className="card">
        <SectionHeading
          title="Blue Ocean"
          subtitle="Categorías con alta demanda y pocos vendedores — espacios poco competidos"
        />
        {blueOceans.length === 0 ? (
          <EmptyState
            icon="🌊"
            title="No se detectaron blue oceans"
            message="Categorías con productos suficientes y pocos vendedores."
          />
        ) : (
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart
                data={blueOceans.map((c) => ({
                  name: c.category.length > 18 ? c.category.slice(0, 18) + "…" : c.category,
                  fullName: c.category,
                  demand: c.totalSales,
                  sellers: c.sellers.size,
                  oceanScore: c.oceanScore,
                }))}
                margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(value: number, _name, props) => [
                    `${fmtInt(value)} ventas · ${props.payload.sellers} vendedores · ocean score ${props.payload.oceanScore.toFixed(1)}`,
                    props.payload.fullName,
                  ]}
                  contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }}
                />
                <Bar dataKey="demand" radius={[4, 4, 0, 0]}>
                  {blueOceans.map((_, i) => (
                    <Cell key={i} fill={ML_COLORS[i % ML_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Risks */}
      <div className="card border-l-4 border-red-500">
        <SectionHeading
          title="Riesgos Detectados"
          subtitle="Condiciones adversas del mercado que afectan entrada o rentabilidad"
        />
        <ul className="space-y-2">
          {risks.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
              <ShieldAlert size={16} className="mt-0.5 flex-none text-red-500" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
