/**
 * chinadata.live client — China monthly trade by HS commodity chapter.
 *
 * Source: GACC Monthly Statistics Bulletin, aggregated by chinadata.live and
 * exposed as a free, key-less JSON API. Reachable directly from Railway (public
 * English API — no China-region host needed). Values are USD thousands.
 *
 *   GET /api/v2/trade/hs/{chapter}
 *   -> { success, hs_code, latest:{year,month}, monthly:[{year,month,exports,imports,balance}] }
 *
 * We derive per-month YoY % for exports / imports / balance and monthly value
 * levels (normalised to USD bn) for the coverage themes.
 */

const BASE = process.env.CHINADATA_BASE_URL || "https://chinadata.live";

export interface TradePoint {
  date: string; // YYYY-MM
  value: number;
}

export interface ProductTradeResult {
  source: "chinadata";
  hsCode: string;
  data: TradePoint[];
  fetchedAt: string;
  error?: string;
}

interface RawMonthly {
  year: number;
  month: number;
  exports: number;
  imports: number;
  balance: number;
}

/** Which metric to extract for a given logical series. */
export type TradeMetric =
  | "exports_yoy"
  | "imports_yoy"
  | "balance_yoy"
  | "exports_value_bn"
  | "imports_value_bn"
  | "balance_value_bn";

function ym(r: RawMonthly): string {
  return `${r.year}-${String(r.month).padStart(2, "0")}`;
}

/**
 * Fetch one HS chapter and compute the requested metric as a monthly series.
 * YoY metrics need the same month a year earlier; value metrics convert the
 * raw USD-thousand figure to USD bn (÷1e6).
 */
export async function getProductTrade(
  hsChapter: string,
  metric: TradeMetric,
): Promise<ProductTradeResult> {
  const fetchedAt = new Date().toISOString();
  try {
    const res = await fetch(`${BASE}/api/v2/trade/hs/${hsChapter}`, {
      headers: { Accept: "application/json", "User-Agent": "china-monitor/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return { source: "chinadata", hsCode: hsChapter, data: [], fetchedAt, error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as { success?: boolean; monthly?: RawMonthly[] };
    const monthly = (json.monthly ?? []).filter(
      (r) => Number.isFinite(r.exports) && Number.isFinite(r.imports),
    );
    if (monthly.length === 0) {
      return { source: "chinadata", hsCode: hsChapter, data: [], fetchedAt, error: "empty" };
    }

    // Index by YYYY-MM for YoY lookups.
    const byKey = new Map<string, RawMonthly>();
    for (const r of monthly) byKey.set(ym(r), r);

    const field: "exports" | "imports" | "balance" = metric.startsWith("exports")
      ? "exports"
      : metric.startsWith("imports")
        ? "imports"
        : "balance";
    const isYoy = metric.endsWith("_yoy");

    const out: TradePoint[] = [];
    for (const r of monthly) {
      const date = ym(r);
      if (isYoy) {
        const prev = byKey.get(`${r.year - 1}-${String(r.month).padStart(2, "0")}`);
        if (!prev) continue;
        const cur = r[field];
        const base = prev[field];
        // YoY only meaningful for non-zero, same-sign base (skip balance sign flips).
        if (!Number.isFinite(base) || base === 0) continue;
        if (field === "balance" && Math.sign(base) !== Math.sign(cur)) continue;
        const yoy = (cur / base - 1) * 100;
        if (!Number.isFinite(yoy)) continue;
        out.push({ date, value: Math.round(yoy * 10) / 10 });
      } else {
        // value level: USD thousands -> USD bn
        const bn = r[field] / 1_000_000;
        if (!Number.isFinite(bn)) continue;
        out.push({ date, value: Math.round(bn * 100) / 100 });
      }
    }
    return { source: "chinadata", hsCode: hsChapter, data: out, fetchedAt };
  } catch (err: any) {
    return { source: "chinadata", hsCode: hsChapter, data: [], fetchedAt, error: err.message };
  }
}
