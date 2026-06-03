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

function defaultDailyStart(): string {
  // ~13 months back so 1y comparisons are always satisfiable
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 13);
  return d.toISOString().slice(0, 10);
}

export interface FredDataPoint {
  date: string;   // YYYY-MM-DD when frequency="d", else YYYY-MM
  value: number | null;
}

/**
 * Fetch observations for a FRED series.
 * Returns sorted ascending array of { date, value }.
 *
 * Date format depends on `frequency`:
 *   - "m" (default) → YYYY-MM (legacy behavior; safe for monthly series)
 *   - "d"           → YYYY-MM-DD (preserves daily resolution for DGS10/DXY/VIX etc.)
 */
export async function getFredSeries(
  seriesId: string,
  opts?: {
    limit?: number;                 // default 120 (10y monthly) or 365 (1y daily)
    sortOrder?: "asc" | "desc";
    units?: string;                 // e.g. "pc1" for YoY % change
    frequency?: "d" | "m";          // date granularity in output (default "m")
    observationStart?: string;      // override default 2015-01-01 (e.g. "2024-01-01" for daily)
  },
): Promise<FredDataPoint[]> {
  // Resolve API key
  const apiKey = process.env.FRED_API_KEY ?? null;
  if (!apiKey) {
    throw new Error("FRED_API_KEY not configured");
  }

  const frequency = opts?.frequency ?? "m";
  const defaultLimit = frequency === "d" ? 365 : 120;
  const limit = opts?.limit ?? defaultLimit;
  const cacheKey = `fred:${seriesId}:${opts?.units ?? "lin"}:${limit}:${frequency}`;

  // Cache check
  const cached = await storage.getCache(cacheKey);
  if (cached) return cached.payloadJson as FredDataPoint[];

  // For daily series default to ~1y window unless caller overrides; for monthly use 2015.
  const obsStart = opts?.observationStart ?? (frequency === "d" ? defaultDailyStart() : "2015-01-01");

  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: "json",
    limit: String(limit),
    sort_order: opts?.sortOrder ?? "asc",
    observation_start: obsStart,
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
      // FRED dates are YYYY-MM-DD; preserve for daily, strip to YYYY-MM for monthly
      date: frequency === "d" ? String(o.date) : String(o.date).slice(0, 7),
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
