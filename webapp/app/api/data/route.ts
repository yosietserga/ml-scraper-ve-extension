import { NextRequest, NextResponse } from "next/server";
import type { DataResponse } from "@/lib/types";

/**
 * GET /api/data
 *
 * Proxies to the Google Apps Script web app to avoid CORS issues.
 *
 * The Apps Script URL is resolved in this order:
 *   1. ?url= query param (allows UI to override)
 *   2. SHEETS_API_URL environment variable
 *   3. ?action=data is appended to the URL if missing
 *
 * Handles BOTH old and new Apps Script deployments:
 *   - New (?action=data): returns { success, products: [...], count }
 *   - Old (no ?action=data support): returns { success, message, rows, headers }
 *     → we fetch the sheet data directly via the published CSV export URL
 *
 * Returns JSON: { success, products, count, error? }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const overrideUrl = searchParams.get("url");
  const action = searchParams.get("action") || "data";

  let baseUrl: string | undefined =
    overrideUrl || process.env.SHEETS_API_URL;

  if (!baseUrl) {
    return NextResponse.json<DataResponse>(
      {
        success: false,
        products: [],
        count: 0,
        error:
          "No SHEETS_API_URL configured. Set the env var or pass ?url=... on the request.",
      },
      { status: 200 }
    );
  }

  // Strip any existing query string and rebuild it.
  try {
    const u = new URL(baseUrl);
    if (!u.searchParams.get("action")) {
      u.searchParams.set("action", action);
    }
    baseUrl = u.toString();
  } catch {
    if (!/action=/.test(baseUrl)) {
      baseUrl = `${baseUrl}${
        baseUrl.includes("?") ? "&" : "?"
      }action=${action}`;
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(baseUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return NextResponse.json<DataResponse>(
        {
          success: false,
          products: [],
          count: 0,
          error: `Upstream HTTP ${res.status}: ${res.statusText}`,
        },
        { status: 200 }
      );
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        json = JSON.parse(match[0]);
      } else {
        return NextResponse.json<DataResponse>(
          {
            success: false,
            products: [],
            count: 0,
            error: "Upstream returned non-JSON response (possibly Google login page).",
          },
          { status: 200 }
        );
      }
    }

    const data = json as Record<string, unknown>;

    // NEW Apps Script: has products array
    if (Array.isArray(data.products)) {
      return NextResponse.json<DataResponse>({
        success: true,
        products: data.products as DataResponse["products"],
        count: (data.count as number) ?? (data.products as unknown[]).length,
      });
    }

    // OLD Apps Script: returns { success, message, rows, headers } without products
    // We need to fetch the sheet data via the CSV export URL instead.
    if (data.message && typeof data.rows === "number") {
      // Try to fetch the sheet data via the CSV export endpoint
      // Google Sheets CSV export: https://docs.google.com/spreadsheets/d/{ID}/export?format=csv&gid={GID}
      // We don't know the GID, but we can try the default gid=0
      const sheetId = "1DesPY4WR1mbgRGTG_xRbrW4UZJq84KVnMnn-qNgzVjg";
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;

      try {
        const csvRes = await fetch(csvUrl, { cache: "no-store" });
        if (csvRes.ok) {
          const csvText = await csvRes.text();
          const products = parseCsvToProducts(csvText, data.headers as string[]);
          return NextResponse.json({
            success: true,
            products: products as unknown as DataResponse["products"],
            count: products.length,
          });
        }
      } catch {
        // CSV fetch failed — fall through to error
      }

      return NextResponse.json<DataResponse>(
        {
          success: false,
          products: [],
          count: 0,
          error: "Tu Apps Script está desactualizado. Re-despliega el código nuevo de google-apps-script.js para que soporte ?action=data. Mientras tanto, no se pueden leer los productos desde la webapp.",
        },
        { status: 200 }
      );
    }

    return NextResponse.json<DataResponse>(
      {
        success: false,
        products: [],
        count: 0,
        error: "Respuesta del Apps Script no contiene array 'products'. Re-despliega el Apps Script con el código nuevo.",
      },
      { status: 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json<DataResponse>(
      {
        success: false,
        products: [],
        count: 0,
        error: `Proxy error: ${message}`,
      },
      { status: 200 }
    );
  }
}

/** Parse CSV text into product objects using the headers row. */
function parseCsvToProducts(csv: string, headers?: string[]): Record<string, unknown>[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Parse CSV properly (handle quoted fields with commas)
  const rows: string[][] = [];
  let current: string[] = [];
  let inQuotes = false;
  let field = "";

  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        current.push(field);
        field = "";
      } else if (c === '\n' || c === '\r') {
        if (field || current.length > 0) {
          current.push(field);
          rows.push(current);
          current = [];
          field = "";
        }
        // skip \r\n
        if (c === '\r' && csv[i + 1] === '\n') i++;
      } else {
        field += c;
      }
    }
  }
  if (field || current.length > 0) {
    current.push(field);
    rows.push(current);
  }

  if (rows.length < 2) return [];

  const headerRow = rows[0];
  const products: Record<string, unknown>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const obj: Record<string, unknown> = {};
    for (let j = 0; j < headerRow.length && j < row.length; j++) {
      obj[headerRow[j]] = row[j];
    }
    products.push(obj);
  }

  return products;
}
