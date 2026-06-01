import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { ProvenanceChip, ProvenanceChipLive } from "@/components/ProvenanceChip";
import { Skeleton } from "@/components/ui/skeleton";
import { Line } from "react-chartjs-2";
import { DATA } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSeries, getLatestValue } from "@/hooks/useSeries";

export default function Property() {
  const faiRE    = useSeries("fai_real_estate_ytd")  as any;
  const starts   = useSeries("property_starts_ytd")  as any;
  const complete = useSeries("completed_area_ytd")   as any;
  const prices   = useSeries("new_home_prices_70city") as any;

  const prov = faiRE.data?.provenance;
  const anyLoading = [faiRE, starts, complete, prices].some((s: any) => s.isLoading);

  const faiPts:     { date: string; value: number | null }[] = faiRE.data?.data    ?? [];
  const startPts:   { date: string; value: number | null }[] = starts.data?.data   ?? [];
  const compPts:    { date: string; value: number | null }[] = complete.data?.data ?? [];
  const pricePts:   { date: string; value: number | null }[] = prices.data?.data   ?? [];

  const hasLive = faiPts.length > 0 || pricePts.length > 0;

  const liveChartData = hasLive
    ? {
        datasets: [
          {
            label: "Property FAI YTD %",
            data: faiPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.red,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
          {
            label: "New Starts YTD %",
            data: startPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.orange,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
          {
            label: "Completed Area YTD %",
            data: compPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.amber,
            backgroundColor: "transparent",
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
        ],
      }
    : null;

  const latestFai    = getLatestValue(faiRE.data);
  const latestStart  = getLatestValue(starts.data);
  const latestComp   = getLatestValue(complete.data);
  const latestPrice  = getLatestValue(prices.data);

  // Static fallback data
  const p = DATA.property;

  return (
    <div data-testid="page-property">
      <PageHeader
        title="Property sector"
        subtitle="The old-economy anchor — investment, starts, completions, sales, inventory."
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

      {/* Live stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        {[
          { label: "Property FAI YTD", v: latestFai, loading: faiRE.isLoading },
          { label: "New Starts YTD",   v: latestStart, loading: starts.isLoading },
          { label: "Completed YTD",    v: latestComp, loading: complete.isLoading },
          { label: "Prices 70-city MoM", v: latestPrice, loading: prices.isLoading },
        ].map(({ label, v, loading }) => (
          <Card key={label} className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider">{label}</div>
            {loading ? (
              <Skeleton className="h-8 w-24 mt-1.5" />
            ) : (
              <>
                <div className={`mt-1.5 text-2xl font-semibold ${v.value != null && v.value < 0 ? "text-red-600 dark:text-red-400" : v.value != null && v.value > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
                  {v.value != null ? `${v.value >= 0 ? "+" : ""}${v.value.toFixed(1)}%` : "—"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">{v.date ?? "NBS data"}</div>
              </>
            )}
          </Card>
        ))}
      </div>

      {/* Live trend chart */}
      {hasLive && (
        <Card className="p-5 mb-4">
          <h2 className="text-sm font-semibold mb-3">Property indicators trend (YTD YoY %)</h2>
          <div className="h-72">
            {anyLoading ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <Line
                options={{
                  ...baseChartOptions,
                  scales: {
                    ...baseChartOptions.scales,
                    x: { type: "time" as const, time: { unit: "month" as const } },
                    y: { ...baseChartOptions.scales.y, title: { display: true, text: "YoY %" } },
                  },
                } as any}
                data={liveChartData!}
              />
            )}
          </div>
          {!hasLive && (
            <p className="text-xs text-muted-foreground mt-2">NBS data unavailable — check network egress</p>
          )}
        </Card>
      )}

      {/* Static reference */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-3">
          Property indicators — historical reference
          {!hasLive && " (static, couldn't load live)"}
        </h2>
        <Table>
          <TableHeader><TableRow><TableHead>Metric</TableHead><TableHead className="text-right">2024</TableHead><TableHead className="text-right">2025</TableHead></TableRow></TableHeader>
          <TableBody>
            {p?.metrics?.map((m: any) => (
              <TableRow key={m.metric}>
                <TableCell className="text-sm">{m.metric}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{m.y2024}</TableCell>
                <TableCell className="text-right tabular-nums text-sm font-medium">{m.y2025}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
