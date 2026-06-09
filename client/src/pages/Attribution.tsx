/**
 * Attribution — macro driver → equity index sign and beta analysis.
 *
 * Phase 3b Session 2 (part 2).
 *
 * Surfaces the output of POST /api/attribution/macro-to-equity:
 *  - Beta heatmap (rows = drivers, cols = equities) using the 12m rolling beta.
 *  - Sign-break alert: pairs whose full-sample beta has the opposite sign
 *    of the thesis (expectedSign) with non-trivial correlation. These are
 *    the cases where the historical relationship "broke" relative to the
 *    intuitive view.
 *  - Not-yet-priced alert: driver had a >2σ move recently but the equity
 *    hasn't moved in the expected direction (delivered by the server).
 *  - Detail panel (4 tabs): Rolling | Lead-Lag | Aligned series | Thesis +
 *    a per-pair AI commentary card.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Line, Bar } from "react-chartjs-2";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ArrowLeft, AlertTriangle, AlertCircle, Zap } from "lucide-react";
import { AICommentaryPanel } from "@/components/AICommentaryPanel";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";

// ─── Wire types (must mirror server/analysis/attribution.ts) ─────────────────

interface RollingStats {
  windowSize: number;
  correlation: number;
  beta: number;
  alpha: number;
  rangeStart: string | null;
  rangeEnd: string | null;
}

interface LeadLagResult {
  bestLag: number;
  bestCorr: number;
  scan: Array<{ lag: number; corr: number }>;
}

interface PairAttribution {
  driver: string;
  driverLabel: string;
  equityTarget: string;
  equityLabel: string;
  expectedSign: 1 | -1;
  thesis: string;
  alignedDates: string[];
  rolling: {
    r6: RollingStats | null;
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

interface UniverseEntry {
  id: string;
  label: string;
  market: "A" | "HK";
}

interface AttributionResponse {
  pairs: PairAttribution[];
  notPriced: PairAttribution[];
  skipped: Array<{ driver: string; equity: string; reason: string }>;
  universe: UniverseEntry[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number | undefined | null, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtSigned(n: number | undefined | null, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n >= 0 ? "+" : "";
  return s + n.toFixed(digits);
}

/** Sign-break test: full-sample beta has opposite sign from expectedSign,
 *  AND correlation is non-trivial. */
function isSignBreak(p: PairAttribution): boolean {
  const full = p.fullSample;
  if (!full || !Number.isFinite(full.beta) || !Number.isFinite(full.correlation)) return false;
  const broken = Math.sign(full.beta) === -p.expectedSign;
  const meaningful = Math.abs(full.correlation) > 0.1;
  return broken && meaningful;
}

/** Heatmap cell color: green if beta aligned with expectedSign and meaningful,
 *  red if opposite, muted if weak. */
function cellColor(beta: number | null | undefined, expected: 1 | -1, corr: number | null | undefined): string {
  if (beta == null || !Number.isFinite(beta) || corr == null || !Number.isFinite(corr)) {
    return "bg-muted/40 text-muted-foreground";
  }
  const aligned = Math.sign(beta) === expected;
  const mag = Math.min(1, Math.abs(corr)); // intensity from correlation magnitude
  if (Math.abs(corr) < 0.05) return "bg-muted/40 text-muted-foreground";
  if (aligned) {
    if (mag > 0.5) return "bg-emerald-500/30 text-emerald-900 dark:text-emerald-100";
    if (mag > 0.2) return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    return "bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
  } else {
    if (mag > 0.5) return "bg-red-500/30 text-red-900 dark:text-red-100";
    if (mag > 0.2) return "bg-red-500/15 text-red-800 dark:text-red-200";
    return "bg-red-500/8 text-red-700 dark:text-red-300";
  }
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function BetaHeatmap({
  pairs,
  drivers,
  equities,
  selectedKey,
  onSelect,
}: {
  pairs: PairAttribution[];
  drivers: Array<{ id: string; label: string }>;
  equities: UniverseEntry[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  // Map of "driver|equity" → pair
  const byKey = useMemo(() => {
    const m = new Map<string, PairAttribution>();
    for (const p of pairs) m.set(`${p.driver}|${p.equityTarget}`, p);
    return m;
  }, [pairs]);

  // Equities we'll actually show as columns: those that have at least one
  // pair in the dataset. (Universe contains some equities the curated map
  // doesn't cover; suppress empty columns for visual clarity.)
  const equityCols = equities.filter((eq) => pairs.some((p) => p.equityTarget === eq.id));

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">Beta heatmap — 12m rolling</h2>
          <p className="text-[11px] text-muted-foreground">
            Cells colored by correlation magnitude; green = aligned with thesis sign, red = opposite. Click a cell for details.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-3 rounded-sm bg-emerald-500/30" /> aligned
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-3 rounded-sm bg-red-500/30" /> sign break
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-3 rounded-sm bg-muted/40" /> weak / NA
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-separate border-spacing-1" data-testid="attribution-heatmap">
          <thead>
            <tr>
              <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground font-medium pl-2">
                Driver
              </th>
              {equityCols.map((eq) => (
                <th
                  key={eq.id}
                  className="text-center text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-2 py-1"
                >
                  {eq.label}
                  <div className="text-[9px] text-muted-foreground/70 font-normal">
                    {eq.market === "A" ? "A-share" : "HK"}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {drivers.map((dr) => (
              <tr key={dr.id}>
                <td className="pr-2 py-1 text-left text-[12px] font-medium text-foreground/90 align-middle">
                  {dr.label}
                </td>
                {equityCols.map((eq) => {
                  const key = `${dr.id}|${eq.id}`;
                  const pair = byKey.get(key);
                  const r12 = pair?.rolling.r12;
                  const tone = pair
                    ? cellColor(r12?.beta, pair.expectedSign, r12?.correlation)
                    : "bg-transparent text-muted-foreground/50";
                  const signBreak = pair ? isSignBreak(pair) : false;
                  const notPriced = pair?.notPriced.triggered;
                  const isActive = key === selectedKey;
                  return (
                    <td key={key} className="p-0">
                      <button
                        disabled={!pair}
                        onClick={() => onSelect(isActive ? null : key)}
                        className={`w-full h-14 rounded-md px-2 transition-all border text-[11px] tabular-nums
                          ${tone}
                          ${pair ? "hover:ring-1 hover:ring-foreground/30 cursor-pointer" : "cursor-not-allowed border-dashed border-muted/40"}
                          ${isActive ? "ring-2 ring-primary" : "border-transparent"}
                        `}
                        data-testid={`heatmap-cell-${dr.id}-${eq.id}`}
                      >
                        {pair && r12 ? (
                          <div className="flex flex-col items-center justify-center">
                            <span className="font-semibold">β {fmtSigned(r12.beta)}</span>
                            <span className="text-[10px] opacity-80">ρ {fmt(r12.correlation, 2)}</span>
                            {(signBreak || notPriced) && (
                              <span className="text-[9px] mt-0.5 flex items-center gap-0.5">
                                {signBreak && (
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                )}
                                {notPriced && (
                                  <Zap className="h-2.5 w-2.5" />
                                )}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-[10px]">—</span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PairDetail({
  pair,
  onClose,
}: {
  pair: PairAttribution;
  onClose: () => void;
}) {
  const signBreak = isSignBreak(pair);
  const notPriced = pair.notPriced.triggered;

  // Lead-lag chart data
  const llData = useMemo(() => {
    const scan = pair.leadLag?.scan ?? [];
    return {
      labels: scan.map((p) => p.lag.toString()),
      datasets: [
        {
          label: "Correlation",
          data: scan.map((p) => p.corr),
          backgroundColor: scan.map((p) =>
            p.lag === pair.leadLag?.bestLag ? CHART_COLORS.primary : CHART_COLORS.muted,
          ),
          borderWidth: 0,
          borderRadius: 4,
        },
      ],
    };
  }, [pair]);

  const llOptions = useMemo(
    () => ({
      ...baseChartOptions,
      plugins: {
        ...baseChartOptions.plugins,
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (ctx: any) => `lag ${ctx[0].label}`,
            label: (ctx: any) => `ρ = ${(ctx.parsed?.y ?? 0).toFixed(3)}`,
          },
        },
      },
      scales: {
        ...baseChartOptions.scales,
        x: {
          ...baseChartOptions.scales.x,
          title: { display: true, text: "Lag (months) — positive = driver leads", color: "#888", font: { size: 10 } },
        },
        y: {
          ...baseChartOptions.scales.y,
          title: { display: true, text: "Correlation", color: "#888", font: { size: 10 } },
        },
      },
    }),
    [],
  );

  // Rolling betas chart (compare r6 / r12 / r24 horizontally)
  const rollData = useMemo(() => {
    const labels = ["6m", "12m", "24m"];
    const betas = [pair.rolling.r6?.beta, pair.rolling.r12?.beta, pair.rolling.r24?.beta];
    const corrs = [pair.rolling.r6?.correlation, pair.rolling.r12?.correlation, pair.rolling.r24?.correlation];
    return {
      labels,
      datasets: [
        {
          label: "Beta",
          data: betas.map((v) => (v == null || !Number.isFinite(v) ? null : v)),
          backgroundColor: betas.map((b) => {
            if (b == null || !Number.isFinite(b)) return CHART_COLORS.muted;
            return Math.sign(b) === pair.expectedSign
              ? CHART_COLORS.emerald
              : CHART_COLORS.red;
          }),
          borderRadius: 4,
          yAxisID: "y",
        },
        {
          label: "Correlation (right)",
          data: corrs.map((v) => (v == null || !Number.isFinite(v) ? null : v)),
          backgroundColor: CHART_COLORS.muted,
          borderRadius: 4,
          yAxisID: "y1",
        },
      ],
    };
  }, [pair]);

  const rollOptions = useMemo(
    () => ({
      ...baseChartOptions,
      scales: {
        ...baseChartOptions.scales,
        y: {
          ...baseChartOptions.scales.y,
          position: "left" as const,
          title: { display: true, text: "Beta", color: "#888", font: { size: 10 } },
        },
        y1: {
          beginAtZero: true,
          position: "right" as const,
          grid: { drawOnChartArea: false },
          ticks: { color: "#888", font: { size: 10 } },
          title: { display: true, text: "Correlation", color: "#888", font: { size: 10 } },
        },
      },
    }),
    [],
  );

  return (
    <div className="space-y-4" data-testid={`pair-detail-${pair.driver}-${pair.equityTarget}`}>
      {/* Back */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        className="h-7 text-xs gap-1"
        data-testid="button-back-to-heatmap"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to heatmap
      </Button>

      {/* Pair header */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Driver → Equity
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <h2 className="text-base font-semibold">
                {pair.driverLabel} → {pair.equityLabel}
              </h2>
              <Badge variant="outline" className="text-[10px]">
                expected sign {pair.expectedSign > 0 ? "+" : "−"}
              </Badge>
              {signBreak && (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300"
                >
                  <AlertTriangle className="h-3 w-3" />
                  Sign break vs. thesis
                </Badge>
              )}
              {notPriced && (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300"
                >
                  <Zap className="h-3 w-3" />
                  Not yet priced
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-2">{pair.thesis}</p>
          </div>
          <div className="text-[11px] text-muted-foreground font-mono shrink-0">
            {pair.alignedDates.length} aligned obs
            {pair.alignedDates[0] && (
              <>
                {" "}· {pair.alignedDates[0]} → {pair.alignedDates[pair.alignedDates.length - 1]}
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="rolling" className="space-y-3">
        <TabsList>
          <TabsTrigger value="rolling" data-testid="tab-rolling">
            Rolling betas
          </TabsTrigger>
          <TabsTrigger value="leadlag" data-testid="tab-leadlag">
            Lead-lag
          </TabsTrigger>
          <TabsTrigger value="thesis" data-testid="tab-thesis">
            Thesis & flags
          </TabsTrigger>
          <TabsTrigger value="ai" data-testid="tab-ai">
            AI commentary
          </TabsTrigger>
        </TabsList>

        {/* Rolling */}
        <TabsContent value="rolling">
          <Card className="p-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                  Beta and correlation across windows
                </div>
                <div className="h-[260px]">
                  <Bar data={rollData} options={rollOptions as any} />
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                  Detail
                </div>
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="font-medium py-1">Window</th>
                      <th className="font-medium py-1">Beta</th>
                      <th className="font-medium py-1">Corr</th>
                      <th className="font-medium py-1">Alpha</th>
                      <th className="font-medium py-1">Range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["r6", "r12", "r24"] as const).map((k) => {
                      const r = pair.rolling[k];
                      const label = k === "r6" ? "6m" : k === "r12" ? "12m" : "24m";
                      return (
                        <tr key={k} className="border-t border-border/40">
                          <td className="py-1.5">{label}</td>
                          <td className={`py-1.5 ${r && Math.sign(r.beta) === pair.expectedSign ? "text-emerald-600 dark:text-emerald-400" : r ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                            {fmtSigned(r?.beta)}
                          </td>
                          <td className="py-1.5">{fmt(r?.correlation, 2)}</td>
                          <td className="py-1.5 text-muted-foreground">{fmtSigned(r?.alpha)}</td>
                          <td className="py-1.5 text-muted-foreground text-[10px] font-mono">
                            {r?.rangeStart ?? "—"} → {r?.rangeEnd ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                    {pair.fullSample && (
                      <tr className="border-t border-border/60 font-medium">
                        <td className="py-1.5">Full</td>
                        <td className={`py-1.5 ${Math.sign(pair.fullSample.beta) === pair.expectedSign ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                          {fmtSigned(pair.fullSample.beta)}
                        </td>
                        <td className="py-1.5">{fmt(pair.fullSample.correlation, 2)}</td>
                        <td className="py-1.5 text-muted-foreground">{fmtSigned(pair.fullSample.alpha)}</td>
                        <td className="py-1.5 text-muted-foreground text-[10px] font-mono">
                          {pair.fullSample.rangeStart} → {pair.fullSample.rangeEnd}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </TabsContent>

        {/* Lead-lag */}
        <TabsContent value="leadlag">
          <Card className="p-4">
            <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
              <div>
                <div className="text-sm font-semibold">Lead-lag correlation scan</div>
                <div className="text-[11px] text-muted-foreground">
                  Positive lag = driver leads equity. Best lag shown in primary color.
                </div>
              </div>
              {pair.leadLag && (
                <div className="text-xs">
                  Best lag <span className="font-semibold tabular-nums">{pair.leadLag.bestLag}</span>{" "}
                  · ρ {fmt(pair.leadLag.bestCorr, 3)}
                </div>
              )}
            </div>
            <div className="h-[280px]">
              {pair.leadLag && pair.leadLag.scan.length > 0 ? (
                <Bar data={llData} options={llOptions as any} />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Insufficient data for lead-lag scan.
                </div>
              )}
            </div>
          </Card>
        </TabsContent>

        {/* Thesis */}
        <TabsContent value="thesis">
          <Card className="p-4 space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Thesis
              </div>
              <p className="text-sm mt-1">{pair.thesis}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-md border p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  Driver state
                </div>
                <div className="space-y-0.5">
                  <div>
                    z-score: <span className="tabular-nums">{fmtSigned(pair.notPriced.driverZ, 2)}σ</span>
                  </div>
                  <div>
                    direction:{" "}
                    {pair.notPriced.driverDir === 1 ? "up" : pair.notPriced.driverDir === -1 ? "down" : "flat"}
                  </div>
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  Equity state
                </div>
                <div className="space-y-0.5">
                  <div>
                    z-score: <span className="tabular-nums">{fmtSigned(pair.notPriced.equityZ, 2)}σ</span>
                  </div>
                  <div>
                    direction:{" "}
                    {pair.notPriced.equityDir === 1 ? "up" : pair.notPriced.equityDir === -1 ? "down" : "flat"}
                    {" "}· expected{" "}
                    {pair.notPriced.expectedEquityDir === 1 ? "up" : pair.notPriced.expectedEquityDir === -1 ? "down" : "—"}
                  </div>
                </div>
              </div>
            </div>
            {notPriced && pair.notPriced.reason && (
              <Alert variant="default" className="border-amber-500/40 bg-amber-500/5">
                <Zap className="h-4 w-4 text-amber-600" />
                <AlertTitle className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                  Not yet priced
                </AlertTitle>
                <AlertDescription className="text-xs text-amber-700/90 dark:text-amber-200/90">
                  {pair.notPriced.reason}
                </AlertDescription>
              </Alert>
            )}
            {signBreak && (
              <Alert variant="default" className="border-red-500/40 bg-red-500/5">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <AlertTitle className="text-xs font-semibold text-red-700 dark:text-red-300">
                  Sign break vs. thesis
                </AlertTitle>
                <AlertDescription className="text-xs text-red-700/90 dark:text-red-200/90">
                  Full-sample beta is <strong>{fmtSigned(pair.fullSample?.beta)}</strong> but the
                  thesis expects sign <strong>{pair.expectedSign > 0 ? "+" : "−"}</strong>. The
                  historical relationship is not consistent with the curated thesis — re-examine
                  whether the driver still applies, or whether regime change has flipped the sign.
                </AlertDescription>
              </Alert>
            )}
          </Card>
        </TabsContent>

        {/* AI */}
        <TabsContent value="ai">
          <AICommentaryPanel
            logicalId={`attribution:${pair.driver}->${pair.equityTarget}`}
            contextIds={[pair.driver, pair.equityTarget]}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Attribution() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<AttributionResponse>({
    queryKey: ["/api/attribution/macro-to-equity"],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/attribution/macro-to-equity", {});
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const pairs = data?.pairs ?? [];
  const universe = data?.universe ?? [];

  // Unique drivers preserving SECTOR_MAPPING insertion order
  const drivers = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ id: string; label: string }> = [];
    for (const p of pairs) {
      if (!seen.has(p.driver)) {
        seen.add(p.driver);
        out.push({ id: p.driver, label: p.driverLabel });
      }
    }
    return out;
  }, [pairs]);

  const signBreaks = pairs.filter(isSignBreak);
  const notPricedPairs = data?.notPriced ?? [];

  const selectedPair = useMemo(() => {
    if (!selectedKey) return null;
    const [driver, equity] = selectedKey.split("|");
    return pairs.find((p) => p.driver === driver && p.equityTarget === equity) ?? null;
  }, [selectedKey, pairs]);

  return (
    <div data-testid="page-attribution">
      <PageHeader
        title="Attribution — macro driver → equity beta"
        subtitle="Rolling betas, sign breaks, lead-lag scans, and 'not-yet-priced' alerts across the curated driver→equity universe."
        actions={
          <ExportMenu
            resource="attribution"
          />
        }
        meta={
          <span className="text-[11px] text-muted-foreground font-mono">
            Powered by /api/attribution/macro-to-equity — non-LLM, cached 5m.
          </span>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load attribution</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      ) : isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      ) : selectedPair ? (
        <PairDetail pair={selectedPair} onClose={() => setSelectedKey(null)} />
      ) : (
        <div className="space-y-4">
          {/* Alerts */}
          {(signBreaks.length > 0 || notPricedPairs.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {signBreaks.length > 0 && (
                <Alert
                  variant="default"
                  className="border-red-500/40 bg-red-500/5"
                  data-testid="alert-signbreaks"
                >
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  <AlertTitle className="text-xs font-semibold text-red-700 dark:text-red-300">
                    Sign breaks ({signBreaks.length})
                  </AlertTitle>
                  <AlertDescription className="text-xs text-red-700/90 dark:text-red-200/90">
                    Full-sample beta has the <strong>opposite sign</strong> of the curated thesis
                    for these pairs:{" "}
                    {signBreaks
                      .slice(0, 5)
                      .map((p) => `${p.driverLabel}→${p.equityLabel}`)
                      .join(", ")}
                    {signBreaks.length > 5 && ` +${signBreaks.length - 5} more`}.
                  </AlertDescription>
                </Alert>
              )}
              {notPricedPairs.length > 0 && (
                <Alert
                  variant="default"
                  className="border-amber-500/40 bg-amber-500/5"
                  data-testid="alert-notpriced"
                >
                  <Zap className="h-4 w-4 text-amber-600" />
                  <AlertTitle className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                    Not yet priced ({notPricedPairs.length})
                  </AlertTitle>
                  <AlertDescription className="text-xs text-amber-700/90 dark:text-amber-200/90">
                    Driver moved &gt;2σ but equity hasn't moved in the expected direction:{" "}
                    {notPricedPairs
                      .slice(0, 5)
                      .map((p) => `${p.driverLabel}→${p.equityLabel}`)
                      .join(", ")}
                    {notPricedPairs.length > 5 && ` +${notPricedPairs.length - 5} more`}.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <BetaHeatmap
            pairs={pairs}
            drivers={drivers}
            equities={universe}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />

          {/* Footer meta */}
          <div className="text-[11px] text-muted-foreground">
            {pairs.length} pairs computed
            {data?.skipped && data.skipped.length > 0 && (
              <> · {data.skipped.length} skipped (insufficient aligned data)</>
            )}
            . Cells show 12m rolling β and ρ. Click a cell to drill into rolling betas,
            lead-lag scan, thesis flags, and AI commentary.
          </div>
        </div>
      )}
    </div>
  );
}
