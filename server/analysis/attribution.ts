/**
 * Macro → equity attribution (Phase 3b).
 *
 * Per user decision: equity universe is A-share + HK (no ADRs).
 *
 * Capabilities:
 *   - Aligned monthly returns (or level changes for already-rate series)
 *   - Rolling correlations + betas over 6/12/24 obs windows
 *   - Lead/lag scan: best lag in [-6, +6] obs by |corr|
 *   - Sector mapping (predefined drivers → sector indices)
 *   - "Not yet priced": macro moved beyond historical band but equity hasn't
 *     reacted in the implied direction.
 */

import type { TimePoint } from "../series/fetchSeries";
import { cleanSeries, pearson, alignSeries } from "./stats";

// ─── Equity universe (A-share + HK, per user) ────────────────────────────

export const EQUITY_UNIVERSE: Array<{ id: string; label: string; market: "A" | "HK" }> = [
  { id: "csi300_monthly", label: "CSI 300",      market: "A"  },
  { id: "shc_close",      label: "Shanghai Comp", market: "A" },
  { id: "szi_close",      label: "Shenzhen Comp", market: "A" },
  { id: "chinext_monthly", label: "ChiNext",      market: "A" },
  { id: "star50_close",   label: "STAR 50",       market: "A" },
  { id: "hangseng_monthly", label: "Hang Seng",   market: "HK" },
];

// Curated mapping from macro drivers to expected sector beta direction.
// 'sign' = +1 means a rise in driver tends to support; -1 means it hurts.
export interface SectorMappingEntry {
  driver: string;             // logicalId of macro series
  driverLabel: string;
  equityTarget: string;       // logicalId of equity index
  equityLabel: string;
  expectedSign: 1 | -1;
  thesis: string;
}

export const SECTOR_MAPPING: SectorMappingEntry[] = [
  // Reflation / PPI → cyclicals & broad index
  { driver: "ppi_yoy",        driverLabel: "PPI YoY",     equityTarget: "csi300_monthly", equityLabel: "CSI 300",  expectedSign:  1, thesis: "Reflation: PPI rising signals pricing power for industrials & materials." },
  { driver: "ppi_yoy",        driverLabel: "PPI YoY",     equityTarget: "chinext_monthly", equityLabel: "ChiNext",  expectedSign: -1, thesis: "Rising input prices typically compress growth-stock multiples." },
  // CPI: mild positive for staples; demand signal
  { driver: "cpi_yoy",        driverLabel: "CPI YoY",     equityTarget: "csi300_monthly", equityLabel: "CSI 300",  expectedSign:  1, thesis: "Demand-pull CPI supports cyclical earnings." },
  // M2 liquidity → broad market positive, ChiNext extra positive
  { driver: "m2_yoy",         driverLabel: "M2 YoY",      equityTarget: "csi300_monthly", equityLabel: "CSI 300",  expectedSign:  1, thesis: "Liquidity expansion supports valuations." },
  { driver: "m2_yoy",         driverLabel: "M2 YoY",      equityTarget: "chinext_monthly", equityLabel: "ChiNext",  expectedSign:  1, thesis: "Growth stocks most sensitive to liquidity." },
  { driver: "m2_yoy",         driverLabel: "M2 YoY",      equityTarget: "hangseng_monthly", equityLabel: "Hang Seng", expectedSign: 1, thesis: "HK benefits from mainland liquidity via Southbound." },
  // Industrial value-added → cyclicals
  { driver: "iva_yoy",        driverLabel: "IVA YoY",     equityTarget: "csi300_monthly", equityLabel: "CSI 300",  expectedSign:  1, thesis: "Real activity proxy; broad cyclical signal." },
  // Exports → HK + offshore exposure
  { driver: "exports_yoy",    driverLabel: "Exports YoY", equityTarget: "hangseng_monthly", equityLabel: "Hang Seng", expectedSign: 1, thesis: "HK earnings disproportionately exposed to global trade." },
  { driver: "exports_yoy",    driverLabel: "Exports YoY", equityTarget: "csi300_monthly", equityLabel: "CSI 300",  expectedSign:  1, thesis: "Exports drive industrial earnings cycle." },
  // FX: stronger CNY (lower USDCNY) typically positive for A-share & HK
  { driver: "usdcny_monthly", driverLabel: "USD/CNY",     equityTarget: "csi300_monthly", equityLabel: "CSI 300",  expectedSign: -1, thesis: "CNY strength signals capital-flow tailwind / policy confidence." },
  { driver: "usdcny_monthly", driverLabel: "USD/CNY",     equityTarget: "hangseng_monthly", equityLabel: "Hang Seng", expectedSign: -1, thesis: "HK most sensitive to CNY moves through Southbound flows." },
  // Real estate
  { driver: "new_home_prices_70city", driverLabel: "70-city home prices", equityTarget: "csi300_monthly", equityLabel: "CSI 300", expectedSign: 1, thesis: "Property recovery supports financials & broader risk appetite." },
  // Retail sales → consumer
  { driver: "retail_sales_yoy", driverLabel: "Retail sales", equityTarget: "csi300_monthly", equityLabel: "CSI 300", expectedSign: 1, thesis: "Consumer demand drives consumer-discretionary earnings." },
  // OECD leading indicator
  { driver: "oecd_cli_china", driverLabel: "OECD CLI",    equityTarget: "csi300_monthly", equityLabel: "CSI 300",  expectedSign:  1, thesis: "Leading indicator for industrial cycle (typically leads 6-9m)." },
  { driver: "oecd_cli_china", driverLabel: "OECD CLI",    equityTarget: "hangseng_monthly", equityLabel: "Hang Seng", expectedSign: 1, thesis: "HK levered to global cycle reading." },
];

// ─── Math helpers ────────────────────────────────────────────────────────

/** Log returns for level series; raw differences for YoY/rate series (already changes). */
export function toReturns(values: number[], kind: "level" | "delta"): number[] {
  if (kind === "delta") {
    // Already a change/rate. Use first-difference to remove autocorrelation.
    const out: number[] = [];
    for (let i = 1; i < values.length; i++) out.push(values[i] - values[i - 1]);
    return out;
  }
  // Level series → log returns
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
    else out.push(0);
  }
  return out;
}

/** OLS beta of y on x. */
export function ols(y: number[], x: number[]): { beta: number; alpha: number } {
  const n = Math.min(y.length, x.length);
  if (n < 2) return { beta: NaN, alpha: NaN };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i];
    sxx += x[i] * x[i]; sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { beta: 0, alpha: sy / n };
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  return { beta, alpha };
}

/** Pearson correlation between two arrays at a given lag.
 *  Positive lag = driver leads equity (use driver_t-lag, equity_t).
 *  Negative lag = equity leads driver.
 */
export function corrAtLag(driver: number[], equity: number[], lag: number): number {
  const n = Math.min(driver.length, equity.length);
  if (n - Math.abs(lag) < 3) return NaN;
  if (lag >= 0) {
    const d = driver.slice(0, n - lag);
    const e = equity.slice(lag);
    return pearson(d, e);
  } else {
    const k = -lag;
    const d = driver.slice(k);
    const e = equity.slice(0, n - k);
    return pearson(d, e);
  }
}

// ─── Public types ────────────────────────────────────────────────────────

export interface RollingStats {
  windowSize: number;
  correlation: number;
  beta: number;
  alpha: number;
  rangeStart: string | null;
  rangeEnd: string | null;
}

export interface LeadLagResult {
  bestLag: number;          // observations; positive = driver leads
  bestCorr: number;         // signed
  scan: Array<{ lag: number; corr: number }>;
}

export interface PairAttribution {
  driver: string;
  driverLabel: string;
  equityTarget: string;
  equityLabel: string;
  expectedSign: 1 | -1;
  thesis: string;
  alignedDates: string[];
  rolling: {
    r6:  RollingStats | null;
    r12: RollingStats | null;
    r24: RollingStats | null;
  };
  fullSample: RollingStats | null;
  leadLag: LeadLagResult | null;
  notPriced: {
    triggered: boolean;
    reason: string | null;
    driverZ: number;
    equityZ: number;
    driverDir: 1 | -1 | 0;
    equityDir: 1 | -1 | 0;
    expectedEquityDir: 1 | -1;
  };
}

// ─── Computation ─────────────────────────────────────────────────────────

function lastWindow(values: number[], dates: string[], size: number): { values: number[]; dates: string[] } | null {
  if (values.length < size) return null;
  return {
    values: values.slice(values.length - size),
    dates: dates.slice(dates.length - size),
  };
}

function rollingStats(driver: number[], equity: number[], dates: string[], size: number): RollingStats | null {
  const dw = lastWindow(driver, dates, size);
  const ew = lastWindow(equity, dates, size);
  if (!dw || !ew) return null;
  const corr = pearson(dw.values, ew.values);
  const { beta, alpha } = ols(ew.values, dw.values);
  return {
    windowSize: size,
    correlation: corr,
    beta,
    alpha,
    rangeStart: dw.dates[0] ?? null,
    rangeEnd: dw.dates[dw.dates.length - 1] ?? null,
  };
}

function scanLeadLag(driver: number[], equity: number[], maxLag: number): LeadLagResult | null {
  if (driver.length < 6) return null;
  const scan: Array<{ lag: number; corr: number }> = [];
  let bestLag = 0;
  let bestCorr = 0;
  let bestAbs = -1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const c = corrAtLag(driver, equity, lag);
    if (Number.isFinite(c)) {
      scan.push({ lag, corr: c });
      if (Math.abs(c) > bestAbs) {
        bestAbs = Math.abs(c);
        bestCorr = c;
        bestLag = lag;
      }
    }
  }
  return { bestLag, bestCorr, scan };
}

function zScoreLatest(values: number[]): number {
  if (values.length < 4) return 0;
  const tail = values.slice(0, values.length - 1);
  const m = tail.reduce((a, b) => a + b, 0) / tail.length;
  const v = tail.reduce((a, b) => a + (b - m) ** 2, 0) / (tail.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (values[values.length - 1] - m) / sd;
}

function direction(values: number[], k = 2): 1 | -1 | 0 {
  if (values.length < k + 1) return 0;
  const start = values[values.length - 1 - k];
  const end = values[values.length - 1];
  if (end > start) return 1;
  if (end < start) return -1;
  return 0;
}

/** Compute attribution for one driver→equity pair given fetched series.
 *  Returns null if either side has fewer than 6 aligned observations — betas
 *  on tiny samples are noise. */
export function computePair(
  entry: SectorMappingEntry,
  driverSeries: TimePoint[],
  driverKind: "level" | "delta",
  equitySeries: TimePoint[],
): PairAttribution | null {
  const aligned = alignSeries([
    { id: "driver", points: driverSeries },
    { id: "equity", points: equitySeries },
  ]);

  if (aligned.dates.length < 6) return null;

  const dDriver = toReturns(aligned.values.driver ?? [], driverKind);
  const dEquity = toReturns(aligned.values.equity ?? [], "level");
  const retDates = aligned.dates.slice(1);

  const rolling = {
    r6:  rollingStats(dDriver, dEquity, retDates, 6),
    r12: rollingStats(dDriver, dEquity, retDates, 12),
    r24: rollingStats(dDriver, dEquity, retDates, 24),
  };
  const fullSample = rollingStats(dDriver, dEquity, retDates, dDriver.length);
  const leadLag = scanLeadLag(dDriver, dEquity, 6);

  // "Not yet priced": driver had a big move (|z|>2) recently, but equity hasn't
  // moved in the expected direction.
  const driverZ = zScoreLatest(dDriver);
  const equityZ = zScoreLatest(dEquity);
  const driverDir = direction(dDriver);
  const equityDir = direction(dEquity);
  const expectedEquityDir = (entry.expectedSign * driverDir) as 1 | -1 | 0;

  let triggered = false;
  let reason: string | null = null;
  if (Math.abs(driverZ) > 2 && expectedEquityDir !== 0 && equityDir !== expectedEquityDir) {
    triggered = true;
    reason = `Driver moved ${driverZ > 0 ? "up" : "down"} (z=${driverZ.toFixed(2)}) but ${entry.equityLabel} ${equityDir === 0 ? "flat" : equityDir > 0 ? "up" : "down"} — expected ${expectedEquityDir > 0 ? "up" : "down"}`;
  }

  return {
    driver: entry.driver,
    driverLabel: entry.driverLabel,
    equityTarget: entry.equityTarget,
    equityLabel: entry.equityLabel,
    expectedSign: entry.expectedSign,
    thesis: entry.thesis,
    alignedDates: aligned.dates,
    rolling,
    fullSample,
    leadLag,
    notPriced: { triggered, reason, driverZ, equityZ, driverDir, equityDir, expectedEquityDir: entry.expectedSign },
  };
}

/** Classify whether a registry series is a "level" or "delta/rate" for return calc. */
export function inferDriverKind(id: string): "level" | "delta" {
  // YoY, MoM, ratio, rate → already a change → first-difference
  if (/_yoy$|_mom$|_ytd$|_rate$|_yield$/.test(id)) return "delta";
  if (/^pmi_|^rrr_|^policy_rate_|^cn_1y_bond_yield/.test(id)) return "delta";
  // FX, indices, levels
  return "level";
}
