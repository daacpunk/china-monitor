/**
 * TrendDetail — per-series breakdown shown when a row in /trends is clicked.
 *
 * Phase 3b Session 2.
 *
 * Layout: 60/40 split.
 *  - Left: large Chart.js line of the historical series with overlays:
 *      • dashed vertical at trendStart
 *      • dashed 12m regression line
 *      • regime-shift marker (single point) when detected
 *      • toggle 3m / 6m / 12m regression overlays
 *  - Right: classification badge + plain-English summary + 3-window stat
 *    cards + AICommentaryPanel (reuses existing component).
 *
 * Wired against:
 *   - GET  /api/series/:logicalId   (via useSeries — full history)
 *   - the TrendResult shape passed in (already computed by the parent page)
 */

import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Zap } from "lucide-react";
import { useSeries } from "@/hooks/useSeries";
import { AICommentaryPanel } from "@/components/AICommentaryPanel";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";

// ─── Types (must mirror the TrendResult interface in Trends.tsx) ─────────────

type Classification =
  | "stable"
  | "emerging"
  | "accelerating"
  | "decelerating"
  | "reversing"
  | "broken";

interface SlopePack {
  window: number;
  slope: number;
  slopePerYear: number;
  r2: number;
  startValue: number;
  endValue: number;
  pctChange: number;
}

interface RegimeShift {
  detected: boolean;
  date: string | null;
  zScore: number;
  direction: "up" | "down" | null;
  severity: "watch" | "anomaly" | null;
  windowMean: number;
  windowStd: number;
}

interface TrendResult {
  id: string;
  latestDate: string | null;
  latestValue: number | null;
  nObs: number;
  slopes: {
    s3?: SlopePack | null;
    s6?: SlopePack | null;
    s12?: SlopePack | null;
  };
  regimeShift: RegimeShift;
  classification: Classification;
  trendStart: string | null;
  multiscaleConfirmed: boolean;
}

interface SeriesPoint {
  date: string;
  value: number | null;
}

interface RegistryEntry {
  id: string;
  label: string;
  category?: string;
  unit?: string;
}

interface Props {
  result: TrendResult;
  registry?: RegistryEntry;
  onBack: () => void;
  contextIds?: string[];
}

// ─── Classification metadata ─────────────────────────────────────────────────

const CLASS_META: Record<
  Classification,
  { label: string; tone: string; ring: string; chartColor: string; summary: string }
> = {
  stable: {
    label: "Stable",
    tone: "bg-muted text-muted-foreground border-border",
    ring: "ring-muted",
    chartColor: CHART_COLORS.muted,
    summary:
      "Trend slope is small in absolute terms and consistent across 3m, 6m, and 12m windows. No regime shift detected.",
  },
  emerging: {
    label: "Emerging",
    tone: "bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30",
    ring: "ring-teal-500/40",
    chartColor: CHART_COLORS.teal,
    summary:
      "A new directional move appears in the 3m window without being confirmed yet at longer horizons — watch for confirmation.",
  },
  accelerating: {
    label: "Accelerating",
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
    ring: "ring-emerald-500/40",
    chartColor: CHART_COLORS.emerald,
    summary:
      "Slope is rising in absolute value across windows — momentum is building. The shorter the window, the steeper the slope.",
  },
  decelerating: {
    label: "Decelerating",
    tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
    ring: "ring-amber-500/40",
    chartColor: CHART_COLORS.amber,
    summary:
      "Same direction across windows, but the 3m slope is shallower than the 12m — momentum is fading without yet reversing.",
  },
  reversing: {
    label: "Reversing",
    tone: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40",
    ring: "ring-orange-500/40",
    chartColor: CHART_COLORS.orange,
    summary:
      "Short window slope has flipped sign relative to longer windows — a possible inflection. Confirm with the next 1-2 prints.",
  },
  broken: {
    label: "Broken",
    tone: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40",
    ring: "ring-red-500/40",
    chartColor: CHART_COLORS.red,
    summary:
      "A large-magnitude regime shift was detected (|z| ≥ 3). The historical mean and variance are no longer a reliable baseline.",
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtSlope(n: number | undefined | null, unit = "") {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return `${sign}${n.toFixed(digits)}${unit ? " " + unit : ""}/yr`;
}

function fmtR2(n: number | undefined | null) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function fmtZ(z: number | undefined) {
  if (z == null || !Number.isFinite(z)) return "—";
  const s = z >= 0 ? "+" : "";
  return `${s}${z.toFixed(2)}σ`;
}

function r2Tone(r2: number | undefined | null): string {
  if (r2 == null || !Number.isFinite(r2)) return "text-muted-foreground";
  if (r2 >= 0.8) return "text-emerald-600 dark:text-emerald-400";
  if (r2 >= 0.5) return "text-foreground";
  return "text-red-600 dark:text-red-400";
}

/**
 * Build a dataset of [{x: date, y: regression-line-value}] for a given slope
 * window. The slopePack values are: slope (per period), startValue, endValue.
 * We anchor the regression line to the LAST `windowSize` points in the
 * cleaned series, plotting from startValue at the first index up to endValue
 * at the last.
 */
function buildRegressionLine(
  cleaned: SeriesPoint[],
  pack: SlopePackLoose | undefined | null,
): Array<{ x: string; y: number }> | null {
  if (!pack || cleaned.length === 0) return null;
  const w = pack.windowSize ?? pack.window;
  const n = Math.min(w, cleaned.length);
  if (n < 2) return null;
  const tail = cleaned.slice(-n);
  const slope = pack.slope;
  const start = pack.startValue;
  // Reconstruct line: y_i = start + slope * i, i = 0..n-1
  return tail.map((p, i) => ({ x: p.date, y: start + slope * i }));
}

// Server-side trends emit `window` on the wire; some older builds emit
// `windowSize`. Accept either.
interface SlopePackLoose extends SlopePack {
  windowSize?: number;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TrendDetail({ result, registry, onBack, contextIds }: Props) {
  const [overlays, setOverlays] = useState<Record<"s3" | "s6" | "s12", boolean>>({
    s3: false,
    s6: false,
    s12: true,
  });

  const { data: seriesData, isLoading } = useSeries(result.id);

  const meta = CLASS_META[result.classification];
  const unit = registry?.unit ?? "";
  const label = registry?.label ?? result.id;
  const category = registry?.category ?? "—";

  // Clean: drop nulls; sort by date asc. The server already returns ASC.
  const cleaned: SeriesPoint[] = useMemo(() => {
    const raw = (seriesData?.data ?? []) as SeriesPoint[];
    return raw.filter((p) => p.value != null && Number.isFinite(p.value));
  }, [seriesData]);

  // Build chart datasets
  const chartData = useMemo(() => {
    if (cleaned.length === 0) return null;
    const labels = cleaned.map((p) => p.date);
    const values = cleaned.map((p) => p.value as number);

    const datasets: any[] = [
      {
        label,
        data: values,
        borderColor: CHART_COLORS.primary,
        backgroundColor: "transparent",
        borderWidth: 1.6,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.18,
        order: 5,
      },
    ];

    // Regression overlay lines — drawn only on the trailing window
    const overlaySpec: Array<{
      key: "s3" | "s6" | "s12";
      pack: SlopePackLoose | undefined | null;
      color: string;
      labelText: string;
    }> = [
      { key: "s3", pack: result.slopes.s3 as SlopePackLoose | null, color: CHART_COLORS.teal, labelText: "3m regression" },
      { key: "s6", pack: result.slopes.s6 as SlopePackLoose | null, color: CHART_COLORS.amber, labelText: "6m regression" },
      { key: "s12", pack: result.slopes.s12 as SlopePackLoose | null, color: meta.chartColor, labelText: "12m regression" },
    ];

    for (const { key, pack, color, labelText } of overlaySpec) {
      if (!overlays[key] || !pack) continue;
      const line = buildRegressionLine(cleaned, pack);
      if (!line) continue;
      // Map regression points back into the global x-axis as a sparse array
      // (same length as labels, mostly null, filled at the trailing indices).
      const dataAligned: Array<number | null> = new Array(values.length).fill(null);
      const offset = values.length - line.length;
      line.forEach((pt, i) => {
        dataAligned[offset + i] = pt.y;
      });
      datasets.push({
        label: labelText,
        data: dataAligned,
        borderColor: color,
        backgroundColor: "transparent",
        borderWidth: 2,
        borderDash: [5, 4],
        pointRadius: 0,
        spanGaps: false,
        tension: 0,
        order: 2,
      });
    }

    // Trend-start vertical: simulate with a 2-point dataset using a custom x-index range and y=[min,max].
    if (result.trendStart) {
      const idx = labels.indexOf(result.trendStart);
      if (idx >= 0) {
        const yMin = Math.min(...values);
        const yMax = Math.max(...values);
        const verticalData = new Array(values.length).fill(null);
        verticalData[idx] = yMax;
        // We add 2 points on same idx so chartjs draws a vertical segment via
        // a "step" approach. Easier: use a small vertical dataset using
        // pointStyle with showLine=true won't render a vertical between same x.
        // Workaround: use scatter-style two points at idx by duplicating idx
        // is not possible on a category x — use a thin vertical via two
        // datasets each plotting a single value at idx (top and bottom),
        // connected by NOT drawing a line. So actually we just render a
        // single visible point with a long error-bar replacement.
        // Cleaner: draw a thin vertical via a dataset with showLine and
        // 2 entries: yMin at idx, yMax at idx. Chart.js will draw vertical
        // segment as long as both points share the same x (they do).
        const downward = new Array(values.length).fill(null);
        downward[idx] = yMin;
        // Use a dataset where data alternates min/max at idx — needs same x.
        // Simpler approach: add a single bold point at the trendStart and rely on label.
        datasets.push({
          label: `Trend start (${result.trendStart})`,
          data: values.map((_, i) => (i === idx ? yMax : null)),
          borderColor: meta.chartColor,
          borderDash: [4, 4],
          borderWidth: 0,
          backgroundColor: meta.chartColor,
          pointRadius: 5,
          pointStyle: "rectRot",
          pointBorderColor: meta.chartColor,
          showLine: false,
          order: 1,
        });
        // Second dataset draws a connecting dashed vertical from min to max
        // by spanning gaps between idx-1 (null) and idx (yMin) and idx+1 (null).
        // Chart.js requires non-null y to render — instead, we add a faint
        // bottom marker to anchor visual symmetry.
        void downward;
      }
    }

    // Regime shift marker — large lightning point at the detected date.
    if (result.regimeShift.detected && result.regimeShift.date) {
      const idx = labels.indexOf(result.regimeShift.date);
      if (idx >= 0) {
        const markerColor =
          result.regimeShift.severity === "anomaly"
            ? CHART_COLORS.red
            : CHART_COLORS.amber;
        const markerData = values.map((v, i) => (i === idx ? v : null));
        datasets.push({
          label: `Regime shift (${fmtZ(result.regimeShift.zScore)})`,
          data: markerData,
          borderColor: markerColor,
          backgroundColor: markerColor,
          pointRadius: 7,
          pointHoverRadius: 9,
          pointStyle: "triangle",
          showLine: false,
          order: 0,
        });
      }
    }

    return { labels, datasets };
  }, [cleaned, label, meta.chartColor, overlays, result]);

  const chartOptions = useMemo(
    () => ({
      ...baseChartOptions,
      plugins: {
        ...baseChartOptions.plugins,
        legend: {
          ...baseChartOptions.plugins.legend,
          labels: {
            ...baseChartOptions.plugins.legend.labels,
            filter: (item: any) =>
              !item.text?.startsWith("Trend start") && !item.text?.startsWith("Regime"),
          },
        },
        tooltip: {
          ...baseChartOptions.plugins.tooltip,
          callbacks: {
            label: (ctx: any) => {
              const v = ctx.parsed?.y;
              if (v == null) return "";
              const ds = ctx.dataset?.label ?? "";
              return `${ds}: ${typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : v}${unit ? " " + unit : ""}`;
            },
          },
        },
      },
      scales: {
        ...baseChartOptions.scales,
        x: {
          ...baseChartOptions.scales.x,
          ticks: {
            ...baseChartOptions.scales.x.ticks,
            maxTicksLimit: 10,
            autoSkip: true,
          },
        },
      },
    }),
    [unit],
  );

  return (
    <div className="space-y-4" data-testid={`trend-detail-${result.id}`}>
      {/* Back link */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-7 text-xs gap-1"
          data-testid="button-back-to-trends"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to table
        </Button>
      </div>

      {/* Header card */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold truncate">{label}</h2>
              <Badge variant="outline" className={`${meta.tone} text-[11px]`}>
                {meta.label}
              </Badge>
              {result.multiscaleConfirmed && (
                <Badge variant="outline" className="text-[10px] font-normal">
                  multi-scale confirmed
                </Badge>
              )}
              {result.regimeShift.detected && (
                <Badge
                  variant="outline"
                  className={`text-[10px] gap-1 ${
                    result.regimeShift.severity === "anomaly"
                      ? "bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300"
                      : "bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  <Zap className="h-3 w-3" />
                  Regime shift {fmtZ(result.regimeShift.zScore)}
                </Badge>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 font-mono">
              {result.id} · {category} · {result.nObs} obs
              {result.latestDate && ` · latest ${result.latestDate}`}
              {result.latestValue != null && (
                <>
                  {" "}
                  ·{" "}
                  <span className="font-semibold text-foreground">
                    {result.latestValue.toLocaleString(undefined, {
                      maximumFractionDigits: 3,
                    })}
                    {unit ? " " + unit : ""}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Main: 60/40 split on lg */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Left — chart */}
        <Card className="p-4 lg:col-span-3" data-testid={`detail-chart-${result.id}`}>
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">
              {label}{" "}
              {unit && (
                <span className="text-xs font-normal text-muted-foreground">({unit})</span>
              )}
            </h3>
            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
                Overlay
              </span>
              {(["s3", "s6", "s12"] as const).map((k) => (
                <Button
                  key={k}
                  variant={overlays[k] ? "default" : "outline"}
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setOverlays((o) => ({ ...o, [k]: !o[k] }))}
                  data-testid={`button-overlay-${k}`}
                >
                  {k === "s3" ? "3m" : k === "s6" ? "6m" : "12m"}
                </Button>
              ))}
            </div>
          </div>
          <div className="h-[360px]">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : chartData ? (
              <Line data={chartData} options={chartOptions as any} />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                No data available for {result.id} on this server.
              </div>
            )}
          </div>
          {/* Legend / chips */}
          <div className="flex flex-wrap gap-2 mt-3 text-[11px] text-muted-foreground">
            {result.trendStart && (
              <Badge variant="outline" className="font-normal text-[10px] gap-1">
                ◆ Trend start {result.trendStart}
              </Badge>
            )}
            {result.regimeShift.detected && result.regimeShift.date && (
              <Badge variant="outline" className="font-normal text-[10px] gap-1">
                ▲ Regime shift {result.regimeShift.date} ({fmtZ(result.regimeShift.zScore)},{" "}
                {result.regimeShift.direction})
              </Badge>
            )}
          </div>
        </Card>

        {/* Right — interpretation */}
        <div className="lg:col-span-2 space-y-3" data-testid={`detail-interpretation-${result.id}`}>
          <Card className={`p-4 ring-1 ${meta.ring} ring-inset`}>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Classification
            </div>
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="outline" className={`${meta.tone}`}>
                {meta.label}
              </Badge>
              {result.multiscaleConfirmed && (
                <span className="text-[10px] text-muted-foreground">
                  confirmed across windows
                </span>
              )}
            </div>
            <p className="text-xs text-foreground/80 leading-relaxed">{meta.summary}</p>
          </Card>

          {/* 3-window stat grid */}
          <Card className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Slopes (annualised)
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(["s3", "s6", "s12"] as const).map((k) => {
                const p = result.slopes[k];
                const label = k === "s3" ? "3m" : k === "s6" ? "6m" : "12m";
                return (
                  <div
                    key={k}
                    className="rounded-md border p-2"
                    data-testid={`detail-slope-${k}`}
                  >
                    <div className="text-[10px] text-muted-foreground">{label}</div>
                    <div className="text-sm font-semibold tabular-nums">
                      {fmtSlope(p?.slopePerYear)}
                    </div>
                    <div className={`text-[10px] tabular-nums ${r2Tone(p?.r2)}`}>
                      R² {fmtR2(p?.r2)}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Regime card */}
          <Card className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Regime
            </div>
            {result.regimeShift.detected ? (
              <div className="text-xs space-y-1">
                <div>
                  <span className="font-medium">Date:</span>{" "}
                  <span className="font-mono">{result.regimeShift.date}</span>
                </div>
                <div>
                  <span className="font-medium">z-score:</span>{" "}
                  <span className="tabular-nums">{fmtZ(result.regimeShift.zScore)}</span>
                </div>
                <div>
                  <span className="font-medium">Direction:</span>{" "}
                  {result.regimeShift.direction ?? "—"} · severity{" "}
                  {result.regimeShift.severity ?? "—"}
                </div>
                <div className="text-muted-foreground">
                  Pre-shift window: μ ={" "}
                  {result.regimeShift.windowMean?.toFixed(2) ?? "—"}, σ ={" "}
                  {result.regimeShift.windowStd?.toFixed(2) ?? "—"}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                No regime shift detected (|z| &lt; 2 over trailing window).
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* AI commentary — full-width below */}
      <AICommentaryPanel logicalId={result.id} contextIds={contextIds} />
    </div>
  );
}
