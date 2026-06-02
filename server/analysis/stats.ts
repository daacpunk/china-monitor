/**
 * Lightweight statistics for the analysis layer.
 *
 * All functions are pure and operate on TimePoint[] (the shape returned by
 * fetchSeries). No external deps — kept simple and bundlable.
 */

import type { TimePoint } from "../series/fetchSeries";

/** Drop nulls and sort ascending by date. */
export function cleanSeries(points: TimePoint[]): { date: string; value: number }[] {
  return points
    .filter((p): p is { date: string; value: number } => p.value != null && Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Align multiple series on a common date axis (inner join on dates). */
export function alignSeries(
  named: Array<{ id: string; points: TimePoint[] }>,
): { dates: string[]; values: Record<string, number[]> } {
  if (named.length === 0) return { dates: [], values: {} };

  const maps = named.map((s) => {
    const m = new Map<string, number>();
    for (const p of cleanSeries(s.points)) m.set(p.date, p.value);
    return { id: s.id, map: m };
  });

  // Find dates present in ALL series
  const [first, ...rest] = maps;
  const common: string[] = [];
  first.map.forEach((_v, d) => {
    if (rest.every((m) => m.map.has(d))) common.push(d);
  });
  common.sort();

  const values: Record<string, number[]> = {};
  for (const { id, map } of maps) {
    values[id] = common.map((d) => map.get(d)!);
  }
  return { dates: common, values };
}

/** Pearson correlation coefficient. Returns NaN if input invalid. */
export function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i];
    sxx += x[i] * x[i]; syy += y[i] * y[i];
    sxy += x[i] * y[i];
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (den === 0) return NaN;
  return num / den;
}

/** Pairwise correlation matrix for K aligned series. */
export function correlationMatrix(
  ids: string[],
  values: Record<string, number[]>,
): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < ids.length; i++) {
    m.push([]);
    for (let j = 0; j < ids.length; j++) {
      m[i].push(i === j ? 1 : pearson(values[ids[i]], values[ids[j]]));
    }
  }
  return m;
}

/** Simple mean + sample stdev. */
export function meanStd(arr: number[]): { mean: number; std: number } {
  const n = arr.length;
  if (n === 0) return { mean: NaN, std: NaN };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, std: 0 };
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, std: Math.sqrt(variance) };
}

/** Compute z-score for the latest value vs a trailing window. */
export interface AnomalyResult {
  date: string;
  value: number;
  windowMean: number;
  windowStd: number;
  zScore: number;
  severity: "normal" | "watch" | "anomaly";   // |z| < 1.5, 1.5-2.5, >2.5
  windowSize: number;
}

export function detectAnomaly(points: TimePoint[], windowSize = 24): AnomalyResult | null {
  const cleaned = cleanSeries(points);
  if (cleaned.length < 3) return null;

  const latest = cleaned[cleaned.length - 1];
  // Use the prior window (exclude the latest point itself)
  const start = Math.max(0, cleaned.length - 1 - windowSize);
  const window = cleaned.slice(start, cleaned.length - 1).map((p) => p.value);
  if (window.length < 3) return null;

  const { mean, std } = meanStd(window);
  if (!Number.isFinite(std) || std === 0) {
    return {
      date: latest.date,
      value: latest.value,
      windowMean: mean,
      windowStd: 0,
      zScore: 0,
      severity: "normal",
      windowSize: window.length,
    };
  }
  const z = (latest.value - mean) / std;
  const absZ = Math.abs(z);
  const severity = absZ > 2.5 ? "anomaly" : absZ > 1.5 ? "watch" : "normal";
  return {
    date: latest.date,
    value: latest.value,
    windowMean: mean,
    windowStd: std,
    zScore: z,
    severity,
    windowSize: window.length,
  };
}

/** Percentage change between latest and N periods ago. */
export function pctChange(points: TimePoint[], lag: number): number | null {
  const cleaned = cleanSeries(points);
  if (cleaned.length <= lag) return null;
  const latest = cleaned[cleaned.length - 1].value;
  const prior = cleaned[cleaned.length - 1 - lag].value;
  if (prior === 0) return null;
  return ((latest - prior) / prior) * 100;
}
