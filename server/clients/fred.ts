/**
 * FRED (St. Louis Federal Reserve) client.
 * Fetches China macro data series via api.stlouisfed.org/fred
 *
 * Why FRED? The NBS (data.stats.gov.cn) blocks non-Chinese IP addresses with
 * a WAF ACL, making it unreachable from Railway (US-hosted). FRED republishes
 * OECD MEI and Caixin data for China, covering CPI, PPI, IP, PMI, and GDP.
 *
 * Auth: free API key from https://fred.stlouisfed.org/docs/api/api_key.html
 *       Set FRED_API_KEY env var or add via Settings page.
 * Cache: 24h TTL (same as NBS).
 * Cost: $0 (free public API, no ceiling check needed).
 *
 * FRED China series used:
 *   CHNCPIALLMINMEI  – CPI total MoM %ch (monthly, OECD)
 *   CHNPPIINDUSTRY   – PPI industry YoY % (monthly, OECD)
 *   CHNPROINDMISMEI  – Industrial Production YoY % (monthly, OECD)
 *   CHNMFGPMI        – Caixin Manufacturing PMI (monthly)
 *   CHNNFCPMI        – Caixin Non-farm Composite PMI (monthly)
 *   CHNCPIALLMINMEI  – CPI YoY (use pct_change transform)
 *
 * NOTE: FRED lags NBS by ~1-2 months for most series. This is acceptable;
 * the primary source order is NBS → FRED → static.
 */

import { storage } from "../storage";

const FRED_BASE = "https://api.stlouisfed.org/fred";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface FredDataPoint {
  date: string;   // YYYY-MM-DD → we normalize to YYYY-MM
  value: number | null;
}

/**
 * Fetch observations for a FRED series.
 * Returns sorted ascending array of { date: "YYYY-MM", value }.
 */
export async function getFredSeries(
  seriesId: string,
  opts?: {
    limit?: number;       // default 120 (10 years monthly)
    sortOrder?: "asc" | "desc";
    units?: string;       // e.g. "pc1" for YoY % change
  },
): Promise<FredDataPoint[]> {
  // Resolve API key
  const apiKey = process.env.FRED_API_KEY ?? null;
  if (!apiKey) {
    throw new Error("FRED_API_KEY not configured");
  }

  const cacheKey = `fred:${seriesId}:${opts?.units ?? "lin"}:${opts?.limit ?? 120}`;

  // Cache check
  const cached = await storage.getCache(cacheKey);
  if (cached) return cached.payloadJson as FredDataPoint[];

  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: "json",
    limit: String(opts?.limit ?? 120),
    sort_order: opts?.sortOrder ?? "asc",
    observation_start: "2015-01-01",
  });
  if (opts?.units) params.set("units", opts.units);

  const url = `${FRED_BASE}/series/observations?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "china-monitor/2.0 (research dashboard)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`FRED HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json: any = await res.json();

  if (json.error_code) {
    throw new Error(`FRED error ${json.error_code}: ${json.error_message}`);
  }

  const observations: any[] = json.observations ?? [];

  const points: FredDataPoint[] = observations
    .filter((o) => o.value !== "." && o.value !== undefined)
    .map((o) => ({
      // FRED dates are YYYY-MM-DD → convert to YYYY-MM
      date: String(o.date).slice(0, 7),
      value: parseFloat(o.value),
    }))
    .filter((p) => !isNaN(p.value as number));

  // Sort ascending
  points.sort((a, b) => a.date.localeCompare(b.date));

  // Cache result (24h)
  await storage.setCache(cacheKey, points, new Date(Date.now() + TTL_MS), "fred");

  return points;
}

/**
 * Check if the FRED API key is configured and working.
 * Returns { ok, seriesId, message }.
 */
export async function checkFredHealth(): Promise<{
  ok: boolean;
  keyConfigured: boolean;
  message: string;
}> {
  const apiKey = process.env.FRED_API_KEY ?? null;
  if (!apiKey) {
    return {
      ok: false,
      keyConfigured: false,
      message: "FRED_API_KEY not set. Get a free key at fred.stlouisfed.org/docs/api/api_key.html",
    };
  }

  try {
    // Minimal test: fetch the series metadata (not observations — cheaper call)
    const params = new URLSearchParams({
      series_id: "CHNCPIALLMINMEI",
      api_key: apiKey,
      file_type: "json",
    });
    const res = await fetch(`${FRED_BASE}/series?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json();
    if (json.error_code) {
      return {
        ok: false,
        keyConfigured: true,
        message: `FRED key invalid: ${json.error_message}`,
      };
    }
    const seriesTitle = json.seriess?.[0]?.title ?? "unknown";
    return {
      ok: true,
      keyConfigured: true,
      message: `FRED key valid. Test series: ${seriesTitle}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      keyConfigured: true,
      message: `FRED health check failed: ${err.message}`,
    };
  }
}
