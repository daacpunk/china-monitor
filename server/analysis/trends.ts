/**
 * Trend detection (Phase 3b).
 *
 * Pure functions operating on TimePoint[] from fetchSeries. No external deps.
 *
 * Capabilities:
 *   - Multi-timescale OLS slopes (3/6/12 obs)
 *   - Regime-shift detection (z-score break on rolling window)
 *   - Turning-point detection (slope sign change between 6m and 3m)
 *   - Trend classification: stable, emerging, accelerating, decelerating,
 *     reversing, broken
 *   - Trend-start estimation (date the current sign of the 6m slope began)
 */

import type { TimePoint } from "../series/fetchSeries";
import { cleanSeries, meanStd, detectAnomaly, type AnomalyResult } from "./stats";

// ─── Slopes ──────────────────────────────────────────────────────────────

/** OLS slope of y vs index (i.e. trend per observation). */
export function olsSlope(y: number[]): { slope: number; intercept: number; r2: number } {
  const n = y.length;
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += y[i];
    sxx += i * i;
    sxy += i * y[i];
    syy += y[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // R^2 vs mean
  const ymean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (y[i] - ymean) ** 2;
    const yhat = intercept + slope * i;
    ssRes += (y[i] - yhat) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

export interface SlopePack {
  windowSize: number;          // actual # obs used
  requestedWindow: number;     // requested window
  slope: number;               // per-observation
  slopePerYear: number | null; // annualized when frequency known
  r2: number;
  startValue: number;
  endValue: number;
  pctChange: number | null;    // (end - start) / |start| * 100
}

function packSlope(values: number[], requested: number, perYearFactor: number | null): SlopePack {
  const ols = olsSlope(values);
  const start = values[0];
  const end = values[values.length - 1];
  const pct = start !== 0 ? ((end - start) / Math.abs(start)) * 100 : null;
  return {
    windowSize: values.length,
    requestedWindow: requested,
    slope: ols.slope,
    slopePerYear: perYearFactor != null ? ols.slope * perYearFactor : null,
    r2: ols.r2,
    startValue: start,
    endValue: end,
    pctChange: pct,
  };
}

// ─── Frequency inference (rough) ────────────────────────────────────────

/** Infer median gap between observations in days. */
function medianGapDays(dates: string[]): number | null {
  if (dates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const a = new Date(dates[i - 1] + "T00:00:00Z").getTime();
    const b = new Date(dates[i] + "T00:00:00Z").getTime();
    if (Number.isFinite(a) && Number.isFinite(b)) gaps.push((b - a) / 86_400_000);
  }
  if (gaps.length === 0) return null;
  gaps.sort((x, y) => x - y);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/** Periods-per-year factor for annualizing per-observation slope. */
function periodsPerYearFactor(medianDays: number | null): number | null {
  if (medianDays == null) return null;
  if (medianDays >= 350 && medianDays <= 380) return 1;     // annual
  if (medianDays >= 80 && medianDays <= 100) return 4;      // quarterly
  if (medianDays >= 27 && medianDays <= 32) return 12;      // monthly
  if (medianDays >= 6 && medianDays <= 8) return 52;        // weekly
  if (medianDays >= 0.9 && medianDays <= 1.1) return 252;   // daily (trading)
  if (medianDays > 1 && medianDays < 5) return 252;         // ~daily
  return null;
}

// ─── Regime shift ────────────────────────────────────────────────────────

export interface RegimeShift {
  detected: boolean;
  date: string | null;
  zScore: number;
  direction: "up" | "down" | null;
  severity: "watch" | "anomaly" | null;
  windowMean: number;
  windowStd: number;
}

function regimeShiftFromAnomaly(a: AnomalyResult | null): RegimeShift {
  if (!a) {
    return { detected: false, date: null, zScore: 0, direction: null, severity: null, windowMean: NaN, windowStd: NaN };
  }
  const detected = a.severity !== "normal";
  return {
    detected,
    date: detected ? a.date : null,
    zScore: a.zScore,
    direction: a.zScore > 0 ? "up" : a.zScore < 0 ? "down" : null,
    severity: detected ? (a.severity as "watch" | "anomaly") : null,
    windowMean: a.windowMean,
    windowStd: a.windowStd,
  };
}

// ─── Trend-start estimation ─────────────────────────────────────────────

/** Walk backwards from the latest point while the sign of the rolling
 *  3-observation slope matches the sign of the 6m slope. Returns the
 *  earliest date where the sign still held — i.e. when the current trend
 *  segment started. */
function findTrendStart(
  points: { date: string; value: number }[],
  refSign: 1 | -1 | 0,
): string | null {
  if (refSign === 0 || points.length < 4) return null;
  const win = 3;
  let earliest: string | null = null;
  for (let end = points.length; end >= win; end--) {
    const segment = points.slice(end - win, end).map((p) => p.value);
    const { slope } = olsSlope(segment);
    const sign = slope > 0 ? 1 : slope < 0 ? -1 : 0;
    if (sign !== refSign) break;
    earliest = points[end - win].date;
  }
  return earliest;
}

// ─── Classification ─────────────────────────────────────────────────────

export type TrendClassification =
  | "stable"          // all slopes ~ 0
  | "emerging"        // 3m slope nonzero, 12m roughly flat
  | "accelerating"    // |3m| > |6m| > |12m|, same sign
  | "decelerating"    // |3m| < |6m|, same sign
  | "reversing"       // 3m and 12m opposite sign
  | "broken";         // regime shift detected this print

export interface TrendResult {
  id: string;
  latestDate: string | null;
  latestValue: number | null;
  nObs: number;
  frequency: {
    medianGapDays: number | null;
    periodsPerYear: number | null;
  };
  slopes: {
    s3: SlopePack | null;
    s6: SlopePack | null;
    s12: SlopePack | null;
  };
  regimeShift: RegimeShift;
  classification: TrendClassification;
  trendStart: string | null;
  // Confidence-style flag: do 6m and 12m agree on direction?
  multiscaleConfirmed: boolean;
}

const STABLE_RATIO = 0.001; // |slope / mean| under this is "flat"

function sign(x: number): 1 | -1 | 0 {
  if (!Number.isFinite(x)) return 0;
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

function classify(
  s3: SlopePack | null,
  s6: SlopePack | null,
  s12: SlopePack | null,
  regimeShift: RegimeShift,
  mean: number,
): TrendClassification {
  if (regimeShift.detected && regimeShift.severity === "anomaly") return "broken";

  const ref = Math.max(Math.abs(mean), 1e-9);
  const flat = (s: SlopePack | null) => !s || Math.abs(s.slope) / ref < STABLE_RATIO;
  if (flat(s3) && flat(s6) && flat(s12)) return "stable";

  const sign3 = sign(s3?.slope ?? 0);
  const sign6 = sign(s6?.slope ?? 0);
  const sign12 = sign(s12?.slope ?? 0);
  const abs3 = Math.abs(s3?.slope ?? 0);
  const abs6 = Math.abs(s6?.slope ?? 0);
  const abs12 = Math.abs(s12?.slope ?? 0);

  // Reversing: short-term opposite to long-term
  if (sign3 !== 0 && sign12 !== 0 && sign3 !== sign12) return "reversing";

  // Emerging: 3m has direction, 12m essentially flat
  if (sign3 !== 0 && flat(s12)) return "emerging";

  // Acceleration / deceleration within same sign
  if (sign3 === sign6 && sign6 === sign12 && sign3 !== 0) {
    if (abs3 > abs6 && abs6 > abs12) return "accelerating";
    if (abs3 < abs6) return "decelerating";
  }

  return sign3 !== 0 ? "emerging" : "stable";
}

// ─── Public entry ───────────────────────────────────────────────────────

export interface TrendOptions {
  /** Window sizes in observations. Defaults [3, 6, 12]. */
  windows?: [number, number, number];
  /** Window for z-score regime-shift detection (default 24). */
  regimeWindow?: number;
}

export function detectTrend(id: string, points: TimePoint[], opts: TrendOptions = {}): TrendResult {
  const cleaned = cleanSeries(points);
  const n = cleaned.length;
  const [w3, w6, w12] = opts.windows ?? [3, 6, 12];

  const dates = cleaned.map((p) => p.date);
  const values = cleaned.map((p) => p.value);
  const medianDays = medianGapDays(dates);
  const ppy = periodsPerYearFactor(medianDays);

  const tailSlope = (size: number): SlopePack | null => {
    if (n < 2) return null;
    const take = Math.min(size, n);
    if (take < 2) return null;
    return packSlope(values.slice(n - take), size, ppy);
  };

  const s3 = tailSlope(w3);
  const s6 = tailSlope(w6);
  const s12 = tailSlope(w12);

  const anomaly = detectAnomaly(points, opts.regimeWindow ?? 24);
  const regimeShift = regimeShiftFromAnomaly(anomaly);

  const { mean } = meanStd(values.slice(-Math.max(w12, 12)));
  const klass = classify(s3, s6, s12, regimeShift, mean);

  const sign6 = sign(s6?.slope ?? 0);
  const trendStart = sign6 !== 0 ? findTrendStart(cleaned, sign6) : null;

  // Multiscale confirmation: 6m and 12m have same nonzero sign
  const sign12 = sign(s12?.slope ?? 0);
  const multiscaleConfirmed = sign6 !== 0 && sign6 === sign12;

  return {
    id,
    latestDate: cleaned[n - 1]?.date ?? null,
    latestValue: cleaned[n - 1]?.value ?? null,
    nObs: n,
    frequency: { medianGapDays: medianDays, periodsPerYear: ppy },
    slopes: { s3, s6, s12 },
    regimeShift,
    classification: klass,
    trendStart,
    multiscaleConfirmed,
  };
}

/** Count how many series in a list moved in the same direction (6m slope sign). */
export function crossSourceConfirmation(results: TrendResult[]): {
  up: number;
  down: number;
  flat: number;
  confirmation: "broad-up" | "broad-down" | "mixed" | "flat";
} {
  let up = 0, down = 0, flat = 0;
  for (const r of results) {
    const s = sign(r.slopes.s6?.slope ?? 0);
    if (s === 1) up++;
    else if (s === -1) down++;
    else flat++;
  }
  const total = results.length || 1;
  const upShare = up / total;
  const downShare = down / total;
  let confirmation: "broad-up" | "broad-down" | "mixed" | "flat";
  if (upShare >= 0.7) confirmation = "broad-up";
  else if (downShare >= 0.7) confirmation = "broad-down";
  else if (flat / total >= 0.7) confirmation = "flat";
  else confirmation = "mixed";
  return { up, down, flat, confirmation };
}
