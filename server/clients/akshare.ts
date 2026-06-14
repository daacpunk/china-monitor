/**
 * AKShare sidecar client.
 *
 * Thin TypeScript wrapper around the Python FastAPI sidecar that proxies
 * AKShare endpoints. Talks via internal Railway URL + shared-secret header.
 *
 * Sidecar source: /akshare-sidecar (separate Railway service)
 *
 * Env vars:
 *   AKSHARE_SIDECAR_URL  — base URL (e.g. https://akshare-sidecar.railway.internal:8000)
 *                          Falls back to http://localhost:18765 for local dev.
 *   AKSHARE_TOKEN        — shared secret. Required.
 *
 * Returns the same shape as other clients so fetchSeries can route uniformly.
 */

export interface AkshareOhlcvPoint {
  date: string;            // YYYY-MM-DD
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  turnover?: number;
  change_pct?: number;
  turnover_rate_pct?: number;
}

export interface AkshareSectorRow {
  sector: string;
  change_pct_today?: number;
  change_pct_5d?: number;
  change_pct_10d?: number;
  main_net_inflow?: number;
  main_net_inflow_pct?: number;
  main_net_inflow_5d?: number;
  main_net_inflow_10d?: number;
  top_stock_today?: string;
}

type AkshareResponse<T> =
  | { source: "akshare"; data: T[]; fetchedAt: string }
  | { source: "akshare"; data: T[]; fetchedAt: string; error: string };

const SIDECAR_URL = process.env.AKSHARE_SIDECAR_URL || "http://localhost:18765";
const TOKEN = process.env.AKSHARE_TOKEN || "";
const FETCHED_AT = () => new Date().toISOString();
const DEFAULT_TIMEOUT_MS = 30_000;

function authHeaders(): Record<string, string> {
  return TOKEN ? { "X-AKShare-Token": TOKEN } : {};
}

async function getJson<T = any>(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  if (!TOKEN) throw new Error("AKSHARE_TOKEN not configured on main service");
  const url = `${SIDECAR_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", ...authHeaders() },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AKShare sidecar HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** A-share daily OHLCV. Symbol: 6-digit code, e.g. "600519". */
export async function getAshareHistorical(opts: {
  symbol: string;
  start?: string;  // YYYY-MM-DD
  end?: string;
  adjust?: "" | "qfq" | "hfq";
}): Promise<AkshareResponse<AkshareOhlcvPoint>> {
  try {
    const qs = new URLSearchParams({ symbol: opts.symbol });
    if (opts.start) qs.set("start", opts.start);
    if (opts.end) qs.set("end", opts.end);
    if (opts.adjust !== undefined) qs.set("adjust", opts.adjust);
    const r = await getJson<{ data: AkshareOhlcvPoint[] }>(`/ashare/historical?${qs}`);
    return { source: "akshare", data: r.data ?? [], fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** HK Connect daily OHLCV. Symbol: 5-digit code, e.g. "00700". */
export async function getHkHistorical(opts: {
  symbol: string;
  start?: string;
  end?: string;
  adjust?: "" | "qfq" | "hfq";
}): Promise<AkshareResponse<AkshareOhlcvPoint>> {
  try {
    const qs = new URLSearchParams({ symbol: opts.symbol });
    if (opts.start) qs.set("start", opts.start);
    if (opts.end) qs.set("end", opts.end);
    if (opts.adjust !== undefined) qs.set("adjust", opts.adjust);
    const r = await getJson<{ data: AkshareOhlcvPoint[] }>(`/hk/historical?${qs}`);
    return { source: "akshare", data: r.data ?? [], fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** China index daily/weekly/monthly OHLCV via AKShare /index/historical.
 * Symbol formats:  "sz399006" (ChiNext), "sh000300" (CSI 300), "sh000001" (Shanghai Composite).
 * period: "daily" | "weekly" | "monthly" — monthly is resampled month-end. */
export async function getAkshareIndexHistorical(opts: {
  symbol: string;
  start?: string;  // YYYY-MM-DD
  end?: string;
  period?: "daily" | "weekly" | "monthly";
}): Promise<AkshareResponse<AkshareOhlcvPoint>> {
  try {
    const qs = new URLSearchParams({ symbol: opts.symbol });
    if (opts.start) qs.set("start", opts.start);
    if (opts.end) qs.set("end", opts.end);
    if (opts.period) qs.set("period", opts.period);
    const r = await getJson<{ data: AkshareOhlcvPoint[] }>(`/index/historical?${qs}`);
    return { source: "akshare", data: r.data ?? [], fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** Industry sector money-flow snapshot. */
export async function getAkshareSectorFlows(
  indicator: "今日" | "5日" | "10日" = "今日",
): Promise<AkshareResponse<AkshareSectorRow>> {
  try {
    const r = await getJson<{ data: AkshareSectorRow[] }>(
      `/sector/flows?indicator=${encodeURIComponent(indicator)}`,
    );
    return { source: "akshare", data: r.data ?? [], fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** Annual income statement (Sina). Returns raw rows with Chinese column names. */
export async function getAkshareIncome(symbol: string): Promise<AkshareResponse<Record<string, any>>> {
  try {
    const qs = new URLSearchParams({ symbol });
    const r = await getJson<{ data: Record<string, any>[] }>(`/financials/income?${qs}`);
    return { source: "akshare", data: r.data ?? [], fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

export interface AkshareValuation {
  name?: string | null;
  industry?: string | null;
  market_cap?: number | null;
  float_market_cap?: number | null;
  pe_ttm?: number | null;
  pe_static?: number | null;
  pb?: number | null;
  price?: number | null;
  total_shares?: number | null;
  float_shares?: number | null;
}

/** Spot valuation snapshot (PE/PB/market cap) for an A-share name. */
export async function getAkshareValuation(
  symbol: string,
): Promise<AkshareResponse<AkshareValuation>> {
  try {
    const qs = new URLSearchParams({ symbol });
    const r = await getJson<{ valuation: AkshareValuation }>(`/financials/valuation?${qs}`);
    return { source: "akshare", data: [r.valuation], fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** Dated valuation history point. */
export interface ValuationHistoryPoint {
  date: string;
  pe_ttm: number | null;
  pb: number | null;
}

/** Dated PE(TTM)/PB history for an A-share name (for percentile-vs-history). */
export async function getValuationHistory(
  symbol: string,
): Promise<{ data: ValuationHistoryPoint[]; error?: string }> {
  try {
    const qs = new URLSearchParams({ symbol });
    const r = await getJson<{ data: ValuationHistoryPoint[] }>(
      `/financials/valuation_history?${qs}`,
      45_000,
    );
    return { data: r.data ?? [] };
  } catch (err: any) {
    return { data: [], error: err.message };
  }
}

/** One quarterly earnings point (Gap B). revenue/net_profit in 亿 RMB. */
export interface EarningsPoint {
  report_period: string;
  revenue: number | null;
  revenue_yoy: number | null;
  net_profit: number | null;
  net_profit_yoy: number | null;
  eps: number | null;
}

/** Quarterly revenue/net-profit growth + EPS for an A-share name (Gap B). */
export async function getEarnings(
  symbol: string,
): Promise<{ data: EarningsPoint[]; error?: string }> {
  try {
    const qs = new URLSearchParams({ symbol });
    const r = await getJson<{ data: EarningsPoint[] }>(
      `/financials/earnings?${qs}`,
      45_000,
    );
    return { data: r.data ?? [] };
  } catch (err: any) {
    return { data: [], error: err.message };
  }
}

// ─── Flows & positioning (Gap C: northbound / margin / leverage) ────────────

/** One daily northbound (Stock Connect, 北向资金) history point. Values in CNY. */
export interface NorthboundPoint {
  date: string;
  daily_net_buy: number | null;
  cumulative_net_buy: number | null;
  holdings_mktval: number | null;
  daily_inflow: number | null;
  balance: number | null;
}

/** Today's Stock Connect fund-flow summary row (per board/direction). */
export interface NorthboundSummaryRow {
  trade_date: string | null;
  type: string | null;
  board: string | null;
  direction: string | null;
  net_buy: number | null;
  net_inflow: number | null;
  balance: number | null;
}

/** One daily market-wide margin/leverage point. Values in CNY. */
export interface MarginPoint {
  date: string;
  financing_balance: number | null;
  short_balance: number | null;
  financing_buy: number | null;
  short_sell: number | null;
}

/** SH-only credit-trading detail point (best-effort). */
export interface MarginSsePoint {
  date: string;
  financing_balance: number | null;
  financing_buy: number | null;
  total_margin_balance: number | null;
}

/** Northbound (Stock Connect) daily history + latest snapshot. PRIMARY flow signal. */
export async function getNorthboundFlows(
  limit = 250,
): Promise<AkshareResponse<NorthboundPoint> & { latest?: NorthboundPoint | null }> {
  try {
    const r = await getJson<{ data: NorthboundPoint[]; latest?: NorthboundPoint | null }>(
      `/flows/northbound?limit=${encodeURIComponent(String(limit))}`,
      45_000,
    );
    return { source: "akshare", data: r.data ?? [], latest: r.latest ?? null, fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], latest: null, fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** Today's Stock Connect fund-flow summary (per board/direction). */
export async function getNorthboundSummary(): Promise<AkshareResponse<NorthboundSummaryRow>> {
  try {
    const r = await getJson<{ data: NorthboundSummaryRow[] }>(`/flows/northbound_summary`);
    return { source: "akshare", data: r.data ?? [], fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** Market-wide margin/leverage daily history + latest snapshot + (best-effort) SH detail. */
export async function getMarginBalances(
  limit = 250,
): Promise<AkshareResponse<MarginPoint> & { latest?: MarginPoint | null; sseDetail?: MarginSsePoint[] }> {
  try {
    const r = await getJson<{ data: MarginPoint[]; latest?: MarginPoint | null; sse_detail?: MarginSsePoint[] }>(
      `/flows/margin?limit=${encodeURIComponent(String(limit))}`,
      45_000,
    );
    return {
      source: "akshare",
      data: r.data ?? [],
      latest: r.latest ?? null,
      sseDetail: r.sse_detail ?? [],
      fetchedAt: FETCHED_AT(),
    };
  } catch (err: any) {
    return { source: "akshare", data: [], latest: null, sseDetail: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** Macro YoY series point: { date: 'YYYY-MM', value: <pct> }. */
export interface AkshareMacroPoint {
  date: string;
  value: number;
}

/** China macro YoY series (CPI/PPI) via the sidecar /macro/* endpoints.
 *  These pull from EastMoney/NBS via AKShare on the sidecar host, which is not
 *  subject to the US-egress WAF block, so they stay current when FRED/CEIC lag. */
export type AkshareMacroSeries =
  | "cpi"
  | "ppi"
  | "pmi"
  | "m2"
  | "retail"
  | "exports"
  | "imports"
  | "trade_balance"
  | "unemployment";

export async function getAkshareMacro(
  series: AkshareMacroSeries,
): Promise<AkshareResponse<AkshareMacroPoint>> {
  try {
    // Macro datasets are large and the first (uncached) sidecar fetch can be
    // slow; allow up to 60s before giving up so we don't fall through to the
    // (often unavailable) NBS/CEIC fallbacks on a cold cache.
    const r = await getJson<{ data: AkshareMacroPoint[] }>(`/macro/${series}`, 60_000);
    return { source: "akshare", data: r.data ?? [], fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return { source: "akshare", data: [], fetchedAt: FETCHED_AT(), error: err.message };
  }
}

/** Health check — useful for debug routes / startup probe. */
export async function getAkshareHealth(): Promise<{ ok: boolean; detail: any }> {
  try {
    const r = await fetch(`${SIDECAR_URL}/health`, { headers: { Accept: "application/json" } });
    const body = await r.json();
    return { ok: r.ok, detail: body };
  } catch (err: any) {
    return { ok: false, detail: { error: err.message } };
  }
}
