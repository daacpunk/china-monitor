/**
 * Valuation context (Gap A) — turns raw PE/PB into decisions.
 *
 * For a set of A-share names: current PE/PB, percentile vs the name's own 3-5y
 * history, and rank/quartile vs the other names in the same coverage theme.
 * Used by the report (sectorDigest) and the /api/equity/valuation-context route
 * (Sectors UI). Best-effort + cached: never throws, missing data -> nulls.
 */

import { getAkshareValuation, getValuationHistory } from "../clients/akshare";
import { SECTOR_UNIVERSE, type CoverageTheme } from "./universe";

export interface NameValuationContext {
  symbol: string;
  nameEn: string;
  theme: CoverageTheme;
  peTtm: number | null;
  pb: number | null;
  marketCap: number | null;
  pePercentile: number | null; // 0-100 vs own history
  pbPercentile: number | null;
  historyYears: number | null;
  peThemeRank: number | null; // 1 = cheapest in theme
  peThemeCount: number | null;
  peThemeQuartile: number | null; // 1=cheapest quartile .. 4=most expensive
}

function percentile(sorted: number[], v: number): number {
  // % of history at or below v.
  if (sorted.length === 0) return 50;
  let lo = 0;
  for (const x of sorted) if (x <= v) lo++;
  return Math.round((lo / sorted.length) * 1000) / 10;
}

const cache = new Map<string, { at: number; ctx: NameValuationContext }>();
const TTL = 6 * 60 * 60 * 1000; // 6h

async function computeOne(
  symbol: string,
  nameEn: string,
  theme: CoverageTheme,
): Promise<NameValuationContext> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < TTL) return cached.ctx;

  const ctx: NameValuationContext = {
    symbol, nameEn, theme,
    peTtm: null, pb: null, marketCap: null,
    pePercentile: null, pbPercentile: null, historyYears: null,
    peThemeRank: null, peThemeCount: null, peThemeQuartile: null,
  };

  try {
    const [spotRes, histRes] = await Promise.all([
      getAkshareValuation(symbol),
      getValuationHistory(symbol),
    ]);
    const spot = spotRes.data?.[0];
    if (spot) {
      ctx.peTtm = spot.pe_ttm ?? null;
      ctx.pb = spot.pb ?? null;
      ctx.marketCap = spot.market_cap ?? null;
    }
    const hist = histRes.data ?? [];
    if (hist.length >= 30) {
      const peHist = hist.map((h) => h.pe_ttm).filter((x): x is number => x != null && x > 0).sort((a, b) => a - b);
      const pbHist = hist.map((h) => h.pb).filter((x): x is number => x != null && x > 0).sort((a, b) => a - b);
      if (ctx.peTtm != null && peHist.length >= 30) ctx.pePercentile = percentile(peHist, ctx.peTtm);
      if (ctx.pb != null && pbHist.length >= 30) ctx.pbPercentile = percentile(pbHist, ctx.pb);
      // history span in years from first/last date
      const first = hist[0]?.date, last = hist[hist.length - 1]?.date;
      if (first && last) {
        const ys = (Date.parse(last) - Date.parse(first)) / (365.25 * 86400000);
        ctx.historyYears = Math.round(ys * 10) / 10;
      }
    }
  } catch {
    /* leave nulls */
  }

  cache.set(symbol, { at: Date.now(), ctx });
  return ctx;
}

/**
 * Compute valuation context for the names in the given themes (or all themes if
 * none). Adds peer-relative PE rank/quartile within each theme.
 */
export async function buildValuationContext(
  themes?: CoverageTheme[],
  limitPerTheme = 8,
): Promise<NameValuationContext[]> {
  const universe = themes && themes.length
    ? SECTOR_UNIVERSE.filter((t) => themes.includes(t.id))
    : SECTOR_UNIVERSE;

  const out: NameValuationContext[] = [];
  for (const theme of universe) {
    const ashare = theme.names.filter((n) => n.market === "ashare").slice(0, limitPerTheme);
    const ctxs = await Promise.all(ashare.map((n) => computeOne(n.symbol, n.nameEn, theme.id)));
    // Peer-relative PE rank within this theme (cheapest = 1).
    const withPe = ctxs.filter((c) => c.peTtm != null && c.peTtm > 0).sort((a, b) => (a.peTtm! - b.peTtm!));
    withPe.forEach((c, i) => {
      c.peThemeRank = i + 1;
      c.peThemeCount = withPe.length;
      c.peThemeQuartile = withPe.length > 1 ? Math.ceil(((i + 1) / withPe.length) * 4) : 1;
    });
    out.push(...ctxs);
  }
  return out;
}

/** One-line human summary for the report digest. */
export function valuationContextLine(c: NameValuationContext): string {
  if (c.peTtm == null && c.pb == null) return `${c.nameEn} [${c.symbol}]: valuation n/a`;
  const parts: string[] = [];
  if (c.peTtm != null) {
    let s = `P/E(ttm) ${c.peTtm.toFixed(1)}`;
    if (c.pePercentile != null) s += ` (${c.pePercentile.toFixed(0)}th pct${c.historyYears ? ` of ${c.historyYears}y` : ""})`;
    parts.push(s);
  }
  if (c.pb != null) {
    let s = `P/B ${c.pb.toFixed(2)}`;
    if (c.pbPercentile != null) s += ` (${c.pbPercentile.toFixed(0)}th pct)`;
    parts.push(s);
  }
  if (c.peThemeRank != null && c.peThemeCount && c.peThemeCount > 1) {
    const q = c.peThemeQuartile === 1 ? "cheapest" : c.peThemeQuartile === 4 ? "most expensive" : `Q${c.peThemeQuartile}`;
    parts.push(`#${c.peThemeRank}/${c.peThemeCount} in theme (${q})`);
  }
  if (c.marketCap != null) parts.push(`mktcap ${(c.marketCap / 1e8).toFixed(0)}亿`);
  return `${c.nameEn} [${c.symbol}]: ${parts.join(", ")}`;
}
