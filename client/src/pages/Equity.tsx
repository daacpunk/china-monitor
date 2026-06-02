import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChipLive } from "@/components/ProvenanceChip";
import { Skeleton } from "@/components/ui/skeleton";
import { Line } from "react-chartjs-2";
import { DATA } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSeries } from "@/hooks/useSeries";
import { AICommentaryPanel } from "@/components/AICommentaryPanel";
import { CompareButton } from "@/components/CompareModal";

const INDEX_IDS = [
  { id: "csi300_close",  label: "CSI 300",        color: CHART_COLORS.primary   },
  { id: "shc_close",     label: "SSE Composite",   color: CHART_COLORS.muted     },
  { id: "szi_close",     label: "Shenzhen",        color: CHART_COLORS.secondary },
  { id: "hsi_close",     label: "Hang Seng",       color: CHART_COLORS.amber     },
  { id: "chinext_close", label: "ChiNext",         color: CHART_COLORS.emerald   },
  { id: "star50_close",  label: "STAR 50",         color: CHART_COLORS.red       },
];

function useEquityData() {
  const csi300  = useSeries("csi300_close")  as any;
  const shc     = useSeries("shc_close")     as any;
  const szi     = useSeries("szi_close")     as any;
  const hsi     = useSeries("hsi_close")     as any;
  const chinext = useSeries("chinext_close") as any;
  const star50  = useSeries("star50_close")  as any;
  return [csi300, shc, szi, hsi, chinext, star50];
}

export default function Equity() {
  const seriesArr = useEquityData();

  const anyLoading = seriesArr.some((s: any) => s.isLoading);
  const prov = seriesArr[0]?.data?.provenance;

  // Build chart — align dates, use closing prices
  const hasData = seriesArr.some((s: any) => (s.data?.data?.length ?? 0) > 0);

  const liveChartData = hasData
    ? {
        datasets: seriesArr.map((s: any, i: number) => {
          const pts: { date: string; value: number | null }[] = s.data?.data ?? [];
          return {
            label: INDEX_IDS[i].label,
            data: pts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: INDEX_IDS[i].color,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
            pointRadius: 0,
          };
        }),
      }
    : null;

  // Latest values for summary table
  const latestValues = seriesArr.map((s: any, i: number) => {
    const pts: { date: string; value: number | null }[] = s.data?.data ?? [];
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const chg = last && prev && prev.value ? ((last.value! - prev.value!) / prev.value!) * 100 : null;
    return {
      label: INDEX_IDS[i].label,
      value: last?.value ?? null,
      date: last?.date ?? null,
      chg,
    };
  });

  return (
    <div data-testid="page-equity">
      <PageHeader
        title="A-share equities"
        subtitle="Live index prices from Yahoo Finance — daily close for 6 major China equity indices."
        meta={
          <>
            {prov ? (
              <ProvenanceChipLive source={prov.source} lastUpdated={prov.lastUpdated} cacheHit={prov.cacheHit} />
            ) : (
              <ProvenanceChipLive source="pending" />
            )}
          </>
        }
      />

      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Index daily close — 2-year history</h2>
          <Badge variant="outline" className="font-normal">{hasData ? "Yahoo Finance live" : "Loading…"}</Badge>
        </div>
        <div className="h-72">
          {anyLoading ? (
            <Skeleton className="h-full w-full" />
          ) : liveChartData ? (
            <Line
              options={{
                ...baseChartOptions,
                scales: {
                  ...baseChartOptions.scales,
                  x: { type: "time" as const, time: { unit: "month" as const } },
                },
              } as any}
              data={liveChartData}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Couldn't load live data — Yahoo Finance may be unreachable in this environment
            </div>
          )}
        </div>
      </Card>

      <div className="mb-4 flex items-center justify-end gap-2">
        <CompareButton
          ids={["csi300_monthly", "hangseng_monthly", "ppi_yoy", "m2_yoy"]}
          label="Compare CSI/HSI vs macro"
        />
      </div>

      <div className="mb-4">
        <AICommentaryPanel
          logicalId="csi300_monthly"
          contextIds={["hangseng_monthly", "ppi_yoy", "cpi_yoy", "m2_yoy", "policy_rate_7d"]}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">Latest closing values</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Index</TableHead>
                <TableHead className="text-right">Close</TableHead>
                <TableHead className="text-right">1d chg</TableHead>
                <TableHead className="text-right">As of</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latestValues.map((v) => (
                <TableRow key={v.label}>
                  <TableCell className="text-sm font-medium">{v.label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {v.value != null ? v.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums text-xs ${v.chg == null ? "" : v.chg >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                    {v.chg != null ? `${v.chg >= 0 ? "+" : ""}${v.chg.toFixed(2)}%` : "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{v.date ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">A-share valuation (static reference)</h2>
          <Table>
            <TableHeader><TableRow><TableHead>Metric</TableHead><TableHead className="text-right">Value</TableHead><TableHead className="text-right">As of</TableHead></TableRow></TableHeader>
            <TableBody>
              {DATA.aShareValuation?.map((v: any) => (
                <TableRow key={v.metric}>
                  <TableCell className="text-sm">{v.metric}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{v.value}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{v.date}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
