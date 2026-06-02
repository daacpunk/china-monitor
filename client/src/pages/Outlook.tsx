import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip, ProvenanceChipLive } from "@/components/ProvenanceChip";
import { Skeleton } from "@/components/ui/skeleton";
import { Line } from "react-chartjs-2";
import { DATA } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { useSeries, useCalendar } from "@/hooks/useSeries";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SparklineCard } from "@/components/SparklineCard";
import { AICommentaryPanel } from "@/components/AICommentaryPanel";
import { CompareButton } from "@/components/CompareModal";

export default function Outlook() {
  // PMI data
  const pmiMfg      = useSeries("pmi_mfg")      as any;
  const pmiServices = useSeries("pmi_services")  as any;
  const { data: cal, isLoading: calLoading } = useCalendar(30) as any;

  const pmiProv = pmiMfg.data?.provenance;

  const mfgPts: { date: string; value: number | null }[]  = pmiMfg.data?.data      ?? [];
  const svcPts: { date: string; value: number | null }[]  = pmiServices.data?.data ?? [];
  const hasLivePmi = mfgPts.length > 0;

  const livePoiData = hasLivePmi
    ? {
        datasets: [
          {
            label: "PMI Manufacturing",
            data: mfgPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.primary,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
          {
            label: "PMI Services",
            data: svcPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.emerald,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
        ],
      }
    : null;

  // Static GDP forecasts chart
  const f = DATA.gdpForecasts;
  const fLabels = ["2025", "2026", "2027"];
  const palette = [CHART_COLORS.primary, CHART_COLORS.secondary, CHART_COLORS.emerald, CHART_COLORS.amber, CHART_COLORS.orange, CHART_COLORS.muted];
  const forecastChart = f
    ? {
        labels: fLabels,
        datasets: f.map((inst: any, i: number) => ({
          label: inst.institution,
          data: [inst.y2025, inst.y2026, inst.y2027],
          borderColor: palette[i % palette.length],
          backgroundColor: "transparent",
          tension: 0.3,
          borderDash: inst.institution.includes("Beijing") ? [4, 4] : undefined,
        })),
      }
    : null;

  // Calendar releases
  const releases = cal?.releases ?? [];

  return (
    <div data-testid="page-outlook">
      <PageHeader
        title="Outlook — PMI & release calendar"
        subtitle="PMI manufacturing vs services (NBS live) + 30-day macro release calendar."
        meta={
          <>
            {pmiProv ? (
              <ProvenanceChipLive source={pmiProv.source} lastUpdated={pmiProv.lastUpdated} cacheHit={pmiProv.cacheHit} />
            ) : (
              <ProvenanceChip type="static" detail="Static fallback" />
            )}
          </>
        }
      />

      {/* Live PMI chart */}
      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">PMI Manufacturing vs Services — NBS monthly</h2>
          <div className="flex items-center gap-2">
            {mfgPts.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Mfg: <span className={`font-medium ${mfgPts[mfgPts.length - 1].value! >= 50 ? "text-emerald-600" : "text-red-600"}`}>
                  {mfgPts[mfgPts.length - 1].value?.toFixed(1)}
                </span>
                {" · "}Svc: <span className={`font-medium ${svcPts.length && svcPts[svcPts.length - 1].value! >= 50 ? "text-emerald-600" : "text-red-600"}`}>
                  {svcPts.length ? svcPts[svcPts.length - 1].value?.toFixed(1) : "—"}
                </span>
              </span>
            )}
            <Badge variant="outline" className="font-normal">50 = neutral</Badge>
          </div>
        </div>
        <div className="h-64">
          {pmiMfg.isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : livePoiData ? (
            <Line
              options={{
                ...baseChartOptions,
                scales: {
                  ...baseChartOptions.scales,
                  x: { type: "time" as const, time: { unit: "month" as const } },
                  y: {
                    ...baseChartOptions.scales.y,
                    min: 45,
                    max: 60,
                    title: { display: true, text: "PMI index" },
                  },
                },
                plugins: {
                  ...((baseChartOptions as any).plugins ?? {}),
                  annotation: {
                    annotations: {
                      neutralLine: {
                        type: "line",
                        yMin: 50,
                        yMax: 50,
                        borderColor: "rgba(128,128,128,0.4)",
                        borderWidth: 1,
                        borderDash: [4, 4],
                      },
                    },
                  },
                },
              } as any}
              data={livePoiData}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              PMI data unavailable from NBS
            </div>
          )}
        </div>
      </Card>

      {/* OECD leading & sentiment indicators */}
      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">OECD leading & sentiment — China</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              100 = long-run average. CLI leads activity by ~6–9 months; BCI and CCI track sentiment.
            </p>
          </div>
          <CompareButton
            ids={["oecd_cli_china", "oecd_bci_china", "oecd_cci_china"]}
            label="Compare"
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <SparklineCard
            logicalId="oecd_cli_china"
            label="OECD CLI"
            pivot={100}
            hint="Composite leading indicator — ~6–9m lead on activity"
          />
          <SparklineCard
            logicalId="oecd_bci_china"
            label="OECD BCI"
            pivot={100}
            hint="Business confidence — capex & hiring intent"
          />
          <SparklineCard
            logicalId="oecd_cci_china"
            label="OECD CCI"
            pivot={100}
            hint="Consumer confidence — spending & savings"
          />
        </div>
      </Card>

      {/* AI commentary on the OECD CLI — most-watched outlook indicator */}
      <div className="mb-4">
        <AICommentaryPanel
          logicalId="oecd_cli_china"
          contextIds={["oecd_bci_china", "oecd_cci_china", "pmi_mfg"]}
        />
      </div>

      {/* Release calendar table */}
      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Upcoming macro releases — next 30 days</h2>
          <Badge variant="outline" className="font-normal">
            {calLoading ? "Loading…" : `${releases.length} releases`}
          </Badge>
        </div>
        {calLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Time (BJ)</TableHead>
                  <TableHead>Agency</TableHead>
                  <TableHead>Indicator</TableHead>
                  <TableHead>Freq</TableHead>
                  <TableHead>Confirmed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {releases.map((r: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs font-mono">{r.date}</TableCell>
                    <TableCell className="text-xs">{r.time}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="h-4 px-1 text-[10px]">{r.agency}</Badge>
                    </TableCell>
                    <TableCell className="text-xs max-w-[280px] truncate">{r.indicator}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.frequency}</TableCell>
                    <TableCell className="text-xs">
                      {r.expectedRelease ? (
                        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400">est.</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Static GDP forecast chart */}
      {forecastChart && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">2025-2027 real GDP growth forecasts (%)</h2>
          <div className="h-80"><Line options={baseChartOptions as any} data={forecastChart} /></div>
          <p className="text-xs text-muted-foreground mt-3">
            IMF / World Bank see continued deceleration to 4.0% by 2027. Goldman / Morgan Stanley
            higher at 4.7%. The 15FYP sets a 4.5-5% target. The gap between bulls and bears = the
            K-shape resolution question.
          </p>
        </Card>
      )}
    </div>
  );
}
