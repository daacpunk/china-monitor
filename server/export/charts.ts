/**
 * Server-side chart-to-image renderer (Phase 4).
 *
 * Draws charts directly on @napi-rs/canvas (no Chart.js dependency / peer conflict,
 * prebuilt native binary, works on Railway + headless for Phase 5 automation).
 * Returns PNG buffers for embedding in PDF / DOCX / PPTX. Every chart carries a
 * provenance caption to honor the "provenance on every figure" principle.
 */

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { BRAND } from "@shared/brand";

const C = BRAND.colors;

export interface SeriesPoint { x: string | number; y: number; }
export interface ChartSeries { label: string; points: SeriesPoint[]; color?: string; }

export interface ChartOpts {
  title?: string;
  caption?: string;     // provenance line, drawn bottom-left
  width?: number;
  height?: number;
  yLabel?: string;
}

const DEFAULT_W = 900;
const DEFAULT_H = 480;
const PAD = { top: 56, right: 28, bottom: 64, left: 64 };

function setup(opts: ChartOpts): { canvas: any; ctx: SKRSContext2D; w: number; h: number } {
  const w = opts.width ?? DEFAULT_W;
  const h = opts.height ?? DEFAULT_H;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // Background
  ctx.fillStyle = "#" + C.white;
  ctx.fillRect(0, 0, w, h);
  // Title
  if (opts.title) {
    ctx.fillStyle = "#" + C.ink;
    ctx.font = "bold 20px sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(opts.title, PAD.left, 16);
  }
  return { canvas, ctx, w, h };
}

function finish(canvas: any, ctx: SKRSContext2D, opts: ChartOpts, w: number, h: number): Buffer {
  if (opts.caption) {
    ctx.fillStyle = "#" + C.muted;
    ctx.font = "12px sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillText(opts.caption, PAD.left, h - 8);
  }
  return canvas.toBuffer("image/png");
}

function niceBounds(min: number, max: number): { lo: number; hi: number } {
  if (min === max) { return { lo: min - 1, hi: max + 1 }; }
  const span = max - min;
  const pad = span * 0.08;
  return { lo: min - pad, hi: max + pad };
}

function drawAxes(ctx: SKRSContext2D, w: number, h: number, lo: number, hi: number, yLabel?: string) {
  const plotL = PAD.left, plotR = w - PAD.right, plotT = PAD.top, plotB = h - PAD.bottom;
  ctx.strokeStyle = "#" + C.line;
  ctx.lineWidth = 1;
  // y gridlines + labels (5 ticks)
  ctx.fillStyle = "#" + C.muted;
  ctx.font = "12px sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const val = lo + ((hi - lo) * i) / 5;
    const y = plotB - ((plotB - plotT) * i) / 5;
    ctx.beginPath();
    ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke();
    ctx.fillText(formatNum(val), plotL - 8, y);
  }
  ctx.textAlign = "left";
  if (yLabel) {
    ctx.save();
    ctx.translate(16, (plotT + plotB) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }
  return { plotL, plotR, plotT, plotB };
}

function formatNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(1) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "k";
  if (a >= 10) return v.toFixed(0);
  return v.toFixed(2);
}

/** Multi-series line chart (time or category x). */
export function renderLineChart(series: ChartSeries[], opts: ChartOpts = {}): Buffer {
  const { canvas, ctx, w, h } = setup(opts);
  const all = series.flatMap((s) => s.points.map((p) => p.y)).filter((n) => Number.isFinite(n));
  if (all.length === 0) return finish(canvas, ctx, opts, w, h);
  const { lo, hi } = niceBounds(Math.min(...all), Math.max(...all));
  const { plotL, plotR, plotT, plotB } = drawAxes(ctx, w, h, lo, hi, opts.yLabel);

  const maxLen = Math.max(...series.map((s) => s.points.length));
  const xAt = (i: number) => plotL + ((plotR - plotL) * i) / Math.max(1, maxLen - 1);
  const yAt = (v: number) => plotB - ((plotB - plotT) * (v - lo)) / (hi - lo);

  series.forEach((s, si) => {
    const color = s.color ?? BRAND.chartPalette[si % BRAND.chartPalette.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = xAt(i), y = yAt(p.y);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  // x labels (first / mid / last)
  ctx.fillStyle = "#" + C.muted;
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const longest = series.reduce((a, b) => (b.points.length > a.points.length ? b : a), series[0]);
  [0, Math.floor(maxLen / 2), maxLen - 1].forEach((i) => {
    const p = longest.points[i];
    if (p) ctx.fillText(String(p.x), xAt(i), plotB + 8);
  });

  // legend
  drawLegend(ctx, series, plotL, plotT - 28);
  return finish(canvas, ctx, opts, w, h);
}

/** Vertical bar chart (single series; good for % change by name/sector). */
export function renderBarChart(labels: string[], values: number[], opts: ChartOpts = {}): Buffer {
  const { canvas, ctx, w, h } = setup(opts);
  if (values.length === 0) return finish(canvas, ctx, opts, w, h);
  const lo0 = Math.min(0, ...values), hi0 = Math.max(0, ...values);
  const { lo, hi } = niceBounds(lo0, hi0);
  const { plotL, plotR, plotT, plotB } = drawAxes(ctx, w, h, lo, hi, opts.yLabel);
  const yAt = (v: number) => plotB - ((plotB - plotT) * (v - lo)) / (hi - lo);
  const n = values.length;
  const slot = (plotR - plotL) / n;
  const bw = slot * 0.6;
  const zeroY = yAt(0);
  values.forEach((v, i) => {
    const cx = plotL + slot * i + slot / 2;
    const y = yAt(v);
    ctx.fillStyle = v >= 0 ? "#" + C.positive : "#" + C.negative;
    ctx.fillRect(cx - bw / 2, Math.min(y, zeroY), bw, Math.abs(y - zeroY));
    ctx.fillStyle = "#" + C.muted;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(truncate(labels[i] ?? "", 12), cx, plotB + 6);
  });
  return finish(canvas, ctx, opts, w, h);
}

/** Donut chart for portfolio / allocation weights. */
export function renderDonut(labels: string[], values: number[], opts: ChartOpts = {}): Buffer {
  const { canvas, ctx, w, h } = setup(opts);
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return finish(canvas, ctx, opts, w, h);
  const cx = PAD.left + (w - PAD.left - 240) / 2;
  const cy = PAD.top + (h - PAD.top - PAD.bottom) / 2;
  const rOuter = Math.min((w - PAD.left - 240) / 2, (h - PAD.top - PAD.bottom) / 2) - 4;
  const rInner = rOuter * 0.58;
  let start = -Math.PI / 2;
  values.forEach((v, i) => {
    const frac = Math.max(0, v) / total;
    const end = start + frac * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rOuter, start, end);
    ctx.closePath();
    ctx.fillStyle = BRAND.chartPalette[i % BRAND.chartPalette.length];
    ctx.fill();
    start = end;
  });
  // punch the hole
  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.fillStyle = "#" + C.white;
  ctx.fill();
  // legend on the right
  const legendX = w - 220;
  let ly = PAD.top + 6;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "13px sans-serif";
  labels.forEach((lab, i) => {
    ctx.fillStyle = BRAND.chartPalette[i % BRAND.chartPalette.length];
    ctx.fillRect(legendX, ly - 6, 12, 12);
    ctx.fillStyle = "#" + C.body;
    const pct = ((Math.max(0, values[i]) / total) * 100).toFixed(0);
    ctx.fillText(`${truncate(lab, 22)} (${pct}%)`, legendX + 18, ly);
    ly += 22;
  });
  return finish(canvas, ctx, opts, w, h);
}

function drawLegend(ctx: SKRSContext2D, series: ChartSeries[], x: number, y: number) {
  let cx = x;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "13px sans-serif";
  series.forEach((s, i) => {
    const color = s.color ?? BRAND.chartPalette[i % BRAND.chartPalette.length];
    ctx.fillStyle = color;
    ctx.fillRect(cx, y - 6, 14, 4);
    ctx.fillStyle = "#" + C.body;
    ctx.fillText(s.label, cx + 20, y);
    cx += 28 + ctx.measureText(s.label).width + 20;
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** PNG buffer -> data URI (for pdfmake / pptx that prefer base64). */
export function pngToDataUri(buf: Buffer): string {
  return "data:image/png;base64," + buf.toString("base64");
}
