import { NextRequest, NextResponse } from "next/server";
import type { DataResponse } from "@/lib/types";

/**
 * GET /api/data
 *
 * Proxies to the Google Apps Script web app to avoid CORS issues.
 *
 * The Apps Script URL is resolved in this order:
 *   1. ?url= query param (allows UI to override)
 *   2. SHEETS_API_URL environment variable (must include `?action=data` or be the exec base)
 *   3. ?action=data is appended to the URL if missing
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
    // If it's not a parseable URL, just append action if missing.
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
      // Apps Script endpoints are public reads; no auth header needed.
      headers: { Accept: "application/json" },
      signal: controller.signal,
      // Always fetch fresh.
      cache: "no-store",
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
      // Apps Script sometimes returns JSON wrapped in a Content-Type mismatch.
      // Try to extract a JSON object from the text.
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        json = JSON.parse(match[0]);
      } else {
        return NextResponse.json<DataResponse>(
          {
            success: false,
            products: [],
            count: 0,
            error: "Upstream returned non-JSON response.",
          },
          { status: 200 }
        );
      }
    }

    const data = json as Partial<DataResponse>;
    if (!data || Array.isArray(data.products) === false) {
      return NextResponse.json<DataResponse>(
        {
          success: false,
          products: [],
          count: 0,
          error: "Upstream response missing `products` array.",
        },
        { status: 200 }
      );
    }

    return NextResponse.json<DataResponse>({
      success: true,
      products: data.products as DataResponse["products"],
      count: data.count ?? (data.products as unknown[]).length,
    });
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
