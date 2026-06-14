/**
 * Earnings context (Gap B) — turns raw quarterly fundamentals into decisions.
 *
 * For a set of A-share names: latest revenue YoY, net-profit YoY and EPS, an
 * earnings-momentum tag derived from the net-profit YoY trend, and a rule-based
 * "cheap + improving" quadrant that crosses the name's VALUATION percentile
 * (reused from Gap A's buildValuationContext) with earnings momentum. Used by
 * the report (sectorDigest) and the /api/equity/earnings-context route (Sectors
 * UI / deck). Best-effort + cached: never throws, missing data -> nulls.
 *
 * Consensus/forward estimates are intentionally out of scope: there is no
 * reliable free HK/A-share source, so we do not fabricate them.
 */

import { getEarnings } from "../clients/akshare";
import { buildValuationContext, type NameValuationContext } from "./valuationContext";
import { SECTOR_UNIVERSE, type CoverageTheme } from "./universe";

export type EarningsMomentum = "accelerating" | "decelerating" | "inflecting" | "flat";
export type Quadrant =
  | "cheap-improving"
  | "cheap-deteriorating"
  | "expensive-improving"
  | "expensive-deteriorating";

export interface NameEarningsContext {
  symbol: string;
  nameEn: string;
  theme: CoverageTheme;
  revenueYoy: number | null; // latest quarter, %
  netProfitYoy: number | null; // latest quarter, %
  eps: number | null; // latest quarter, basic EPS
  reportPeriod: string | null; // latest report period (YYYY-MM-DD)
  momentum: EarningsMomentum | null;
  valuationPercentile: number | null; // PE percentile from Gap A, 0-100
  quadrant: Quadrant | null;
  note: string | null;
}

/**
 * Earnings-momentum tag from the net-profit YoY trend over the last 3-4
 * quarters (revenue YoY as a tiebreak). accelerating = YoY rising; decelerating
 * = YoY falling; inflecting = crossed zero (turned positive/negative); flat =
 * little change.
 */
function momentumTag(
  npYoy: (number | null)[],
  revYoy: (number | null)[],
): EarningsMomentum | null {
  const np = npYoy.filter((x): x is number => x != null).slice(-4);
  if (np.length < 2) return null;
  const last = np[np.length - 1];
  const prev = np[np.length - 2];
  const first = np[0];
  // Sign flip across the window -> inflecting.
  if ((first < 0 && last > 0) || (first > 0 && last < 0)) return "inflecting";
  const delta = last - prev;
  const spanDelta = last - first;
  const FLAT = 1.0; // within ±1pp QoQ is "flat"
  if (Math.abs(delta) <= FLAT && Math.abs(spanDelta) <= 2 * FLAT) {
    // Net-profit flat: use revenue YoY as a tiebreak.
    const rev = revYoy.filter((x): x is number => x != null).slice(-3);
    if (rev.length >= 2) {
      const rd = rev[rev.length - 1] - rev[0];
      if (rd > FLAT) return "accelerating";
      if (rd < -FLAT) return "decelerating";
    }
    return "flat";
  }
  return spanDelta >= 0 ? "accelerating" : "decelerating";
}

function quadrantOf(
  valuationPercentile: number | null,
  momentum: EarningsMomentum | null,
  latestNpYoy: number | null,
  rising: boolean,
): Quadrant | null {
  if (valuationPercentile == null) return null;
  const cheap = valuationPercentile < 40;
  // improving = net-profit YoY accelerating, OR positive & rising.
  const improving =
    momentum === "accelerating" ||
    momentum === "inflecting" ||
    (latestNpYoy != null && latestNpYoy > 0 && rising);
  if (cheap && improving) return "cheap-improving";
  if (cheap && !improving) return "cheap-deteriorating";
  if (!cheap && improving) return "expensive-improving";
  return "expensive-deteriorating";
}

const cache = new Map<string, { at: number; ctx: NameEarningsContext }>();
const TTL = 6 * 60 * 60 * 1000; // 6h (mirrors valuationContext cache)

async function computeOne(
  symbol: string,
  nameEn: string,
  theme: CoverageTheme,
  valuationPercentile: number | null,
): Promise<NameEarningsContext> {
  const cached = cache.get(symbol);
  // Cache only when the valuation cross is identical, so a fresh valuation
  // percentile re-evaluates the quadrant.
  if (cached && Date.now() - cached.at < TTL && cached.ctx.valuationPercentile === valuationPercentile) {
    return cached.ctx;
  }

  const ctx: NameEarningsContext = {
    symbol, nameEn, theme,
    revenueYoy: null, netProfitYoy: null, eps: null, reportPeriod: null,
    momentum: null, valuationPercentile, quadrant: null, note: null,
  };

  try {
    const res = await getEarnings(symbol);
    const rows = res.data ?? [];
    if (!rows.length) {
      ctx.note = res.error ? `earnings unavailable (${res.error})` : "earnings unavailable";
    } else {
      const latest = rows[rows.length - 1];
      ctx.revenueYoy = latest.revenue_yoy ?? null;
      ctx.netProfitYoy = latest.net_profit_yoy ?? null;
      ctx.eps = latest.eps ?? null;
      ctx.reportPeriod = latest.report_period ?? null;
      const npSeries = rows.map((r) => r.net_profit_yoy);
      const revSeries = rows.map((r) => r.revenue_yoy);
      ctx.momentum = momentumTag(npSeries, revSeries);
      const npVals = npSeries.filter((x): x is number => x != null).slice(-3);
      const rising = npVals.length >= 2 && npVals[npVals.length - 1] > npVals[0];
      ctx.quadrant = quadrantOf(valuationPercentile, ctx.momentum, ctx.netProfitYoy, rising);
      if (ctx.quadrant == null && valuationPercentile == null) {
        ctx.note = "quadrant n/a (valuation percentile unavailable)";
      }
    }
  } catch (err: any) {
    ctx.note = `earnings error (${err?.message ?? "unknown"})`;
  }

  cache.set(symbol, { at: Date.now(), ctx });
  return ctx;
}

/**
 * Compute earnings context for the names in the given themes (or all themes if
 * none). Reuses Gap A's buildValuationContext for the valuation percentile used
 * in the cheap/expensive cross (does NOT recompute valuations).
 */
export async function buildEarningsContext(
  themes?: CoverageTheme[],
  limitPerTheme = 8,
): Promise<NameEarningsContext[]> {
  const universe = themes && themes.length
    ? SECTOR_UNIVERSE.filter((t) => themes.includes(t.id))
    : SECTOR_UNIVERSE;

  // Reuse Gap A valuation context for the cheap/expensive axis.
  let valBySymbol = new Map<string, NameValuationContext>();
  try {
    const vctx = await buildValuationContext(themes, limitPerTheme);
    valBySymbol = new Map(vctx.map((c) => [c.symbol, c]));
  } catch {
    /* leave empty -> quadrants null with a note */
  }

  const out: NameEarningsContext[] = [];
  for (const theme of universe) {
    const ashare = theme.names.filter((n) => n.market === "ashare").slice(0, limitPerTheme);
    const ctxs = await Promise.all(
      ashare.map((n) =>
        computeOne(n.symbol, n.nameEn, theme.id, valBySymbol.get(n.symbol)?.pePercentile ?? null),
      ),
    );
    out.push(...ctxs);
  }
  return out;
}

/** One-line human summary for the report digest. */
export function earningsContextLine(c: NameEarningsContext): string {
  const parts: string[] = [];
  if (c.revenueYoy != null) parts.push(`rev YoY ${c.revenueYoy > 0 ? "+" : ""}${c.revenueYoy.toFixed(1)}%`);
  if (c.netProfitYoy != null) parts.push(`net-profit YoY ${c.netProfitYoy > 0 ? "+" : ""}${c.netProfitYoy.toFixed(1)}%`);
  if (c.eps != null) parts.push(`EPS ${c.eps.toFixed(2)}`);
  if (c.momentum) parts.push(`momentum: ${c.momentum}`);
  if (c.quadrant) parts.push(`quadrant: ${c.quadrant}`);
  if (!parts.length) return `${c.nameEn} [${c.symbol}]: earnings n/a${c.note ? ` (${c.note})` : ""}`;
  const period = c.reportPeriod ? ` @ ${c.reportPeriod}` : "";
  return `${c.nameEn} [${c.symbol}]: ${parts.join(", ")}${period}`;
}
