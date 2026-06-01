import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { ProvenanceChip, ProvenanceChipLive } from "@/components/ProvenanceChip";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, Line } from "react-chartjs-2";
import { DATA } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { useSeries } from "@/hooks/useSeries";

export default function Margins() {
  const ppi = useSeries("ppi_yoy") as any;
  const cpi = useSeries("cpi_yoy") as any;

  const ppiProv = ppi.data?.provenance;

  // Live PPI time series chart
  const ppiPts: { date: string; value: number | null }[] = ppi.data?.data ?? [];
  const cpiPts: { date: string; value: number | null }[] = cpi.data?.data ?? [];

  const hasLive = ppiPts.length > 0;

  // Live line chart (PPI + CPI together)
  const liveLineData = hasLive
    ? {
        datasets: [
          {
            label: "PPI YoY %",
            data: ppiPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.red,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
          {
            label: "CPI YoY %",
            data: cpiPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.primary,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
        ],
      }
    : null;

  // Static fallback chart (sector breakdown)
  const ppiStatic = DATA.ppi;
  const sorted = ppiStatic ? [...ppiStatic.sectors].sort((a: any, b: any) => b.y2025 - a.y2025) : [];
  const staticPpiData = {
    labels: sorted.map((s: any) => s.name),
    datasets: [
      { label: "2024", data: sorted.map((s: any) => s.y2024), backgroundColor: CHART_COLORS.muted },
      {
        label: "2025",
        data: sorted.map((s: any) => s.y2025),
        backgroundColor: sorted.map((s: any) =>
          s.group === "new" ? CHART_COLORS.emerald : s.group === "old" ? CHART_COLORS.red : CHART_COLORS.primary,
        ),
      },
    ],
  };

  const ev = DATA.evMargin;
  const evData = ev
    ? {
        labels: ev.years,
        datasets: [
          {
            label: "Auto industry profit margin (%)",
            data: ev.margin,
            borderColor: CHART_COLORS.red,
            backgroundColor: "hsla(0, 72%, 51%, 0.1)",
            fill: true,
            tension: 0.3,
          },
        ],
      }
    : null;

  // Latest values
  const latestPpi = ppiPts.length ? ppiPts[ppiPts.length - 1] : null;
  const latestCpi = cpiPts.length ? cpiPts[cpiPts.length - 1] : null;

  return (
    <div data-testid="page-margins">
      <PageHeader
        title="PPI & margin pressure"
        subtitle="Deflation by sector, plus the auto industry's margin collapse — anti-involution context."
        meta={
          <>
            {ppiProv ? (
              <ProvenanceChipLive source={ppiProv.source} lastUpdated={ppiProv.lastUpdated} cacheHit={ppiProv.cacheHit} />
            ) : (
              <ProvenanceChip type="static" detail="Static fallback" />
            )}
          </>
        }
      />

      {/* Live PPI + CPI line chart */}
      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">
            PPI &amp; CPI YoY % — live NBS data
          </h2>
          <div className="flex items-center gap-2">
            {latestPpi && (
              <span className="text-xs text-muted-foreground">
                Latest PPI: <span className={latestPpi.value != null && latestPpi.value >= 0 ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-red-600 dark:text-red-400 font-medium"}>
                  {latestPpi.value != null ? `${latestPpi.value >= 0 ? "+" : ""}${latestPpi.value.toFixed(1)}%` : "—"}
                </span> ({latestPpi.date})
              </span>
            )}
          </div>
        </div>
        <div className="h-72">
          {ppi.isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : liveLineData ? (
            <Line
              options={{
                ...baseChartOptions,
                scales: {
                  ...baseChartOptions.scales,
                  x: { type: "time" as const, time: { unit: "month" as const } },
                  y: { ...baseChartOptions.scales.y, title: { display: true, text: "YoY %" } },
                },
              } as any}
              data={liveLineData}
            />
          ) : (
            <div className="text-sm text-muted-foreground flex items-center justify-center h-full">
              NBS data unavailable — showing static sector breakdown below
            </div>
          )}
        </div>
        {latestCpi && (
          <p className="text-xs text-muted-foreground mt-2">
            Latest CPI: {latestCpi.value != null ? `${latestCpi.value >= 0 ? "+" : ""}${latestCpi.value.toFixed(1)}%` : "—"} ({latestCpi.date})
          </p>
        )}
      </Card>

      {/* Static sector breakdown */}
      <Card className="p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">PPI by sector (YoY %, 2024 vs 2025) — static reference</h2>
        <div className="h-[420px]">
          <Bar
            options={{
              ...baseChartOptions,
              indexAxis: "y" as const,
              scales: {
                x: { ...baseChartOptions.scales.y, title: { display: true, text: "YoY %" } },
                y: { ...baseChartOptions.scales.x, ticks: { font: { size: 10 } } },
              } as any,
            } as any}
            data={staticPpiData}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Battery-metal mining (+17.2%) and non-ferrous smelting (+6.3%) are the only sectors with
          sustained pricing power. Every old-economy sector is in PPI contraction.
        </p>
      </Card>

      {evData && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">Auto industry profit margin (%)</h2>
          <div className="h-64"><Line options={baseChartOptions as any} data={evData} /></div>
          <p className="text-xs text-muted-foreground mt-3">{ev.note}</p>
        </Card>
      )}
    </div>
  );
}
