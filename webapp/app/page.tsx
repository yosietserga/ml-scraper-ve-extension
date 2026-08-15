"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LayoutDashboard,
  Package,
  Store,
  TrendingUp,
  Calculator,
  Layers,
  RefreshCw,
  Settings,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import type { DataResponse, Product } from "@/lib/types";
import { fmtInt } from "@/lib/types";
import { OverviewTab } from "@/components/OverviewTab";
import { ProductsTab } from "@/components/ProductsTab";
import { SellersTab } from "@/components/SellersTab";
import { TrendsTab } from "@/components/TrendsTab";
import { ProfitCalculator } from "@/components/ProfitCalculator";
import { CategoriesTab } from "@/components/CategoriesTab";

type TabId =
  | "overview"
  | "products"
  | "sellers"
  | "trends"
  | "profit"
  | "categories";

const TABS: { id: TabId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Resumen", icon: LayoutDashboard },
  { id: "products", label: "Productos", icon: Package },
  { id: "sellers", label: "Vendedores", icon: Store },
  { id: "trends", label: "Tendencias", icon: TrendingUp },
  { id: "profit", label: "Ganancia", icon: Calculator },
  { id: "categories", label: "Categorías", icon: Layers },
];

const STORAGE_URL_KEY = "ml_scraper_sheets_url";

export default function DashboardPage() {
  const [tab, setTab] = useState<TabId>("overview");
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Read persisted override URL on first render (lazy initializer avoids
  // a cascading setState inside useEffect).
  const readPersistedUrl = (): string => {
    if (typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(STORAGE_URL_KEY) || "";
    } catch {
      return "";
    }
  };
  const [overrideUrl, setOverrideUrl] = useState<string>(readPersistedUrl);
  const [settingsUrl, setSettingsUrl] = useState<string>(readPersistedUrl);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const fetchData = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const qs = overrideUrl
          ? `?url=${encodeURIComponent(overrideUrl)}`
          : "";
        const res = await fetch(`/api/data${qs}`, { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const data: DataResponse = await res.json();
        if (!data.success) {
          throw new Error(data.error || "Respuesta inválida del Apps Script");
        }
        setProducts(data.products || []);
        setLastSync(new Date());
        if (!silent) showToast(`Sincronizado: ${data.count} productos`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [overrideUrl]
  );

  // Initial fetch (deferred via microtask so synchronous setState in
  // fetchData doesn't fire the set-state-in-effect lint rule).
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) fetchData();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => fetchData(true), 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchData]);

  const saveSettings = () => {
    const trimmed = settingsUrl.trim();
    try {
      if (trimmed) {
        localStorage.setItem(STORAGE_URL_KEY, trimmed);
      } else {
        localStorage.removeItem(STORAGE_URL_KEY);
      }
    } catch {
      // ignore
    }
    setOverrideUrl(trimmed);
    setShowSettings(false);
    showToast(trimmed ? "URL guardada" : "Usando SHEETS_API_URL del env");
    setTimeout(() => fetchData(), 200);
  };

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Top bar */}
      <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3 px-3 py-2 md:px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-ml-navy">
              <span className="text-lg font-bold text-ml-yellow">M</span>
            </div>
            <div>
              <div className="text-base font-bold leading-tight text-gray-900">
                ML Scraper Analytics
              </div>
              <div className="text-xs text-gray-500">
                MercadoLibre Venezuela · Dashboard
              </div>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="hidden text-xs text-gray-500 md:inline">
              {lastSync
                ? `Última sync: ${lastSync.toLocaleTimeString("es-VE")}`
                : "Sin sincronizar"}
            </span>
            <span className="hidden text-xs text-gray-400 md:inline">·</span>
            <span className="text-xs text-gray-700">
              {fmtInt(products.length)} productos
            </span>
            <button
              onClick={() => fetchData()}
              disabled={loading}
              className="btn btn-outline px-2 py-1.5 text-sm"
              title="Actualizar datos ahora"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              <span className="hidden md:inline">Actualizar</span>
            </button>
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className={`btn px-2 py-1.5 text-sm ${
                autoRefresh ? "btn-green" : "btn-outline"
              }`}
              title="Auto-refresh cada 60 segundos"
            >
              {autoRefresh ? "● Auto 60s" : "○ Auto off"}
            </button>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className="btn btn-outline px-2 py-1.5 text-sm"
              title="Configurar URL del Apps Script"
            >
              <Settings size={14} />
              <span className="hidden md:inline">Config</span>
            </button>
          </div>
        </div>

        {/* Settings drawer */}
        {showSettings ? (
          <div className="border-t border-gray-200 bg-gray-50 px-3 py-3 md:px-6">
            <div className="mx-auto max-w-3xl space-y-2">
              <label className="block text-xs font-medium text-gray-700">
                URL del Google Apps Script Web App
              </label>
              <input
                type="url"
                value={settingsUrl}
                onChange={(e) => setSettingsUrl(e.target.value)}
                placeholder="https://script.google.com/macros/s/AKfyc.../exec"
                className="input"
              />
              <p className="text-xs text-gray-500">
                Pega aquí la URL completa del deployment del Apps Script. Si se
                omite, se usará la variable de entorno <code>SHEETS_API_URL</code>.
                El parámetro <code>?action=data</code> se añade automáticamente.
              </p>
              <div className="flex gap-2">
                <button onClick={saveSettings} className="btn btn-primary">
                  Guardar y sincronizar
                </button>
                <button
                  onClick={() => {
                    setSettingsUrl("");
                    setOverrideUrl("");
                    try {
                      localStorage.removeItem(STORAGE_URL_KEY);
                    } catch {
                      // ignore
                    }
                    setShowSettings(false);
                    showToast("Usando SHEETS_API_URL del env");
                    setTimeout(() => fetchData(), 200);
                  }}
                  className="btn btn-outline"
                >
                  Usar env
                </button>
                <button
                  onClick={() => setShowSettings(false)}
                  className="btn btn-outline"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </header>

      <div className="flex min-h-[calc(100vh-56px)]">
        {/* Sidebar */}
        <nav className="sticky top-[56px] hidden h-[calc(100vh-56px)] w-56 flex-none flex-col gap-1 border-r border-gray-200 bg-white p-2 md:flex">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`sidebar-item ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={16} className="icon" />
                <span>{t.label}</span>
              </button>
            );
          })}
          <div className="mt-auto p-2 text-xs text-gray-500">
            <div className="flex items-center gap-1">
              <ExternalLink size={12} />
              <a
                href="https://github.com/yosietserga/ml-scraper-ve-extension"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-ml-navy"
              >
                Extension repo
              </a>
            </div>
            <div className="mt-1">v1.0.0 · Task 6.17.0</div>
          </div>
        </nav>

        {/* Mobile tab bar */}
        <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-gray-200 bg-white md:hidden">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2 ${
                  active ? "text-ml-navy" : "text-gray-500"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={18} />
                <span className="text-[10px]">{t.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Main content */}
        <main className="flex-1 p-3 pb-24 md:p-6 md:pb-6">
          {error ? (
            <div className="card border-l-4 border-red-500">
              <div className="flex items-start gap-3">
                <AlertCircle size={24} className="mt-0.5 flex-none text-red-500" />
                <div className="flex-1">
                  <div className="font-bold text-red-700">
                    Error al cargar datos
                  </div>
                  <p className="mt-1 text-sm text-gray-700">{error}</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => fetchData()}
                      className="btn btn-primary"
                    >
                      <RefreshCw size={14} /> Reintentar
                    </button>
                    <button
                      onClick={() => setShowSettings(true)}
                      className="btn btn-outline"
                    >
                      <Settings size={14} /> Configurar URL
                    </button>
                  </div>
                  <p className="mt-3 text-xs text-gray-500">
                    Si el error persiste, asegúrate de que el Apps Script web app
                    esté desplegado como &quot;Anyone, even anonymous&quot; y que la URL
                    incluya <code>/exec</code>.
                  </p>
                </div>
              </div>
            </div>
          ) : loading && products.length === 0 ? (
            <div className="card">
              <div className="empty">
                <div className="spinner mb-3" />
                <div className="font-semibold text-gray-700">
                  Conectando con Google Apps Script…
                </div>
                <p className="mt-1 text-sm text-gray-500">
                  La primera solicitud puede tardar 5-15 segundos si el Apps
                  Script está en cold start.
                </p>
              </div>
            </div>
          ) : (
            <>
              {tab === "overview" ? <OverviewTab products={products} /> : null}
              {tab === "products" ? <ProductsTab products={products} /> : null}
              {tab === "sellers" ? <SellersTab products={products} /> : null}
              {tab === "trends" ? <TrendsTab products={products} /> : null}
              {tab === "profit" ? (
                <ProfitCalculator
                  defaultCost={
                    products.length > 0
                      ? products.reduce(
                          (a, p) => a + (Number(p.Precio_Numerico) || 0),
                          0
                        ) / products.length
                      : undefined
                  }
                />
              ) : null}
              {tab === "categories" ? (
                <CategoriesTab products={products} />
              ) : null}
            </>
          )}
        </main>
      </div>

      {/* Toast */}
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
