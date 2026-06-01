import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip, ProvenanceChipLive } from "@/components/ProvenanceChip";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, Line } from "react-chartjs-2";
import { DATA } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { useSeries, useCalendar, getLatestValue } from "@/hooks/useSeries";

export default function Fiscal() {
  const fiscalRev = useSeries("fiscal_revenue_yoy") as any;
  const { data: cal } = useCalendar(7) as any;

  const prov = fiscalRev.data?.provenance;
  const fiscalPts: { date: string; value: number | null }[] = fiscalRev.data?.data ?? [];
  const hasLive = fiscalPts.length > 0;
  const latestFiscal = getLatestValue(fiscalRev.data);

  const liveLineData = hasLive
    ? {
        datasets: [
          {
            label: "Fiscal Revenue YoY %",
            data: fiscalPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.primary,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
        ],
      }
    : null;

  // Static fiscal support bar chart
  const items = DATA.fiscalSupport?.items ?? [];
  const labels = items.map((i: any) => i.label);
  const staticData = {
    labels,
    datasets: [
      { label: "2024", data: items.map((i: any) => i.y2024), backgroundColor: CHART_COLORS.muted    },
      { label: "2025", data: items.map((i: any) => i.y2025), backgroundColor: CHART_COLORS.primary  },
      { label: "2026", data: items.map((i: any) => i.y2026), backgroundColor: CHART_COLORS.emerald  },
    ],
  };

  // Upcoming releases in 7d
  const upcoming7d = cal?.releases ?? [];

  return (
    <div data-testid="page-fiscal">
      <PageHeader
        title="Fiscal & policy support"
        subtitle="Where the state is putting credit, by bucket — and the 15FYP policy timeline."
        meta={
          <>
            {prov ? (
              <ProvenanceChipLive source={prov.source} lastUpdated={prov.lastUpdated} cacheHit={prov.cacheHit} />
            ) : (
              <ProvenanceChip type="static" detail="Static fallback" />
            )}
          </>
        }
      />

      {/* Live fiscal revenue */}
      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Fiscal Revenue YoY % — NBS</h2>
          <Badge variant="outline" className="font-normal">
            {hasLive
              ? `Latest: ${latestFiscal.value != null ? `${latestFiscal.value >= 0 ? "+" : ""}${latestFiscal.value.toFixed(1)}%` : "—"} (${latestFiscal.date})`
              : fiscalRev.isLoading ? "Loading…" : "couldn't load"}
          </Badge>
        </div>
        <div className="h-56">
          {fiscalRev.isLoading ? (
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
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Fiscal revenue data unavailable from NBS
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        {/* Static fiscal chart */}
        <div className="lg:col-span-2">
          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Fiscal & monetary instruments (RMB bn)</h2>
              <Badge variant="outline" className="font-normal">2024 vs 2025 vs 2026</Badge>
            </div>
            <div className="h-[420px]">
              <Bar
                options={{
                  ...baseChartOptions,
                  indexAxis: "y" as const,
                  scales: {
                    x: { ...baseChartOptions.scales.y, title: { display: true, text: "RMB bn" } },
                    y: { ...baseChartOptions.scales.x, ticks: { font: { size: 10 } } },
                  } as any,
                } as any}
                data={staticData}
              />
            </div>
          </Card>
        </div>

        {/* Release calendar sidebar */}
        <div>
          <Card className="p-4 h-full">
            <h2 className="text-sm font-semibold mb-3">Upcoming releases (7d)</h2>
            {upcoming7d.length === 0 ? (
              <p className="text-xs text-muted-foreground">No releases in next 7 days</p>
            ) : (
              <div className="space-y-2">
                {upcoming7d.slice(0, 8).map((r: any, i: number) => (
                  <div key={i} className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                    <div className="text-[10px] text-muted-foreground font-mono">{r.date} {r.time}</div>
                    <div className="text-xs font-medium leading-tight">{r.indicator}</div>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline" className="h-3.5 px-1 text-[9px]">{r.agency}</Badge>
                      <span className="text-[9px] text-muted-foreground">{r.frequency}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Policy timeline */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-3">Policy timeline — Q2 2024 to Q2 2026</h2>
        <div className="space-y-2">
          {DATA.policyTimeline?.map((p: any, i: number) => (
            <div
              key={i}
              className="flex items-start gap-3 p-2.5 rounded-md border bg-card text-sm"
              data-testid={`policy-event-${i}`}
            >
              <Badge
                variant="outline"
                className={
                  p.side === "new"
                    ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300 shrink-0"
                    : p.side === "old"
                      ? "border-red-500/40 text-red-700 dark:text-red-300 shrink-0"
                      : "shrink-0"
                }
              >
                {p.side}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">{p.date}</div>
                <div>{p.event}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
