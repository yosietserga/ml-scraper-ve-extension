"use client";

import { useState } from "react";
import { Calculator, TrendingUp, TrendingDown } from "lucide-react";
import { fmtMoney, NUM } from "@/lib/types";
import { SectionHeading, EmptyState } from "@/components/Section";

interface ProfitCalculatorProps {
  // optional: pre-fill from a category's average price
  defaultCost?: number;
}

const MARKUPS = [10, 20, 30, 50, 100];

export function ProfitCalculator({ defaultCost }: ProfitCalculatorProps) {
  const [cost, setCost] = useState<number | "">(
    defaultCost && defaultCost > 0 ? defaultCost : ""
  );
  const [mlCommissionPct, setMlCommissionPct] = useState<number>(15);

  const costNum = typeof cost === "number" ? cost : 0;

  if (costNum === 0) {
    return (
      <div className="space-y-4">
        <SectionHeading
          title="Calculadora de Ganancia"
          subtitle="Ingresa el costo del producto para proyectar ganancias a distintos markups"
        />
        <div className="card">
          <label className="mb-1 block text-xs font-medium text-gray-600">
            <Calculator size={12} className="mr-1 inline" /> Costo del producto
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={cost}
            onChange={(e) =>
              setCost(e.target.value === "" ? "" : NUM(e.target.value))
            }
            placeholder="0.00"
            className="input"
          />
        </div>
        <EmptyState
          icon="🧮"
          title="Ingresa un costo para calcular"
          message="Verás el precio de venta sugerido, comisión de ML (15% por defecto) y ganancia neta para cada nivel de markup."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Calculadora de Ganancia"
        subtitle="Proyecta ganancias a 5 niveles de markup con comisión ML"
      />

      {/* Cost input + ML commission */}
      <div className="card grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            <Calculator size={12} className="mr-1 inline" /> Costo del producto
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={cost}
            onChange={(e) =>
              setCost(e.target.value === "" ? "" : NUM(e.target.value))
            }
            className="input"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Comisión ML (%)
          </label>
          <input
            type="number"
            min={0}
            max={100}
            step="0.5"
            value={mlCommissionPct}
            onChange={(e) => setMlCommissionPct(NUM(e.target.value))}
            className="input"
          />
        </div>
        <div className="flex items-end">
          <div className="text-sm text-gray-600">
            Costo: <strong>{fmtMoney(costNum)}</strong>
          </div>
        </div>
      </div>

      {/* Result cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {MARKUPS.map((m) => {
          const sellPrice = costNum * (1 + m / 100);
          const commission = sellPrice * (mlCommissionPct / 100);
          const profit = sellPrice - commission - costNum;
          const margin = sellPrice > 0 ? profit / sellPrice : 0;
          const positive = profit > 0;
          return (
            <div
              key={m}
              className={`card card-hover border-l-4 ${
                positive ? "border-ml-green" : "border-red-500"
              }`}
              title={`Markup ${m}%\nCosto: ${fmtMoney(costNum)}\nPrecio venta: ${fmtMoney(sellPrice)}\nComisión ML (${mlCommissionPct}%): ${fmtMoney(commission)}\nGanancia: ${fmtMoney(profit)}\nMargen: ${(margin * 100).toFixed(1)}%`}
            >
              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Markup {m}%
              </div>
              <div className="text-lg font-bold text-gray-900">
                {fmtMoney(sellPrice)}
              </div>
              <div className="mt-1 space-y-0.5 text-xs">
                <div className="flex justify-between text-gray-600">
                  <span>Comisión ML</span>
                  <span>-{fmtMoney(commission)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span className={positive ? "text-ml-green" : "text-red-600"}>
                    Ganancia
                  </span>
                  <span className={positive ? "text-ml-green" : "text-red-600"}>
                    {fmtMoney(profit)}
                  </span>
                </div>
                <div className="flex justify-between text-gray-600">
                  <span>Margen</span>
                  <span>{(margin * 100).toFixed(1)}%</span>
                </div>
              </div>
              {positive ? (
                <div className="mt-2 inline-flex items-center gap-1 text-xs text-ml-green">
                  <TrendingUp size={12} /> Rentable
                </div>
              ) : (
                <div className="mt-2 inline-flex items-center gap-1 text-xs text-red-600">
                  <TrendingDown size={12} /> Pérdida
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Note */}
      <div className="card text-sm text-gray-600">
        <strong>Notas:</strong> La comisión de MercadoLibre VE varía por categoría
        (típicamente 14-17%). El cálculo no incluye costos de envío, IVA ni
        comisión fija por publicación. Verifica las tarifas vigentes en ML para tu
        categoría antes de fijar precios.
      </div>
    </div>
  );
}
