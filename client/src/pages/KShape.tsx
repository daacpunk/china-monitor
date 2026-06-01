import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip, ProvenanceChipLive } from "@/components/ProvenanceChip";
import { Skeleton } from "@/components/ui/skeleton";
import { Line, Bar } from "react-chartjs-2";
import { DATA } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSeries } from "@/hooks/useSeries";

export default function KShape() {
  // IVA (Industrial Value Added) — key K-shape metric
  const iva = useSeries("iva_yoy") as any;
  const prov = iva.data?.provenance;

  const ivaPts: { date: string; value: number | null }[] = iva.data?.data ?? [];
  const hasLive = ivaPts.length > 0;

  const liveIvaData = hasLive
    ? {
        datasets: [
          {
            label: "Industrial Value Added YoY %",
            data: ivaPts.map((p) => ({ x: p.date, y: p.value })),
            borderColor: CHART_COLORS.primary,
            backgroundColor: "hsla(217, 91%, 60%, 0.1)",
            fill: false,
            tension: 0.3,
            parsing: { xAxisKey: "x", yAxisKey: "y" },
          },
        ],
      }
    : null;

  // Static data for sector breakdown bars
  const ip = DATA.industrialProduction;
  const newLabels = ip?.new?.map((x: any) => x.name) ?? [];
  const oldLabels = ip?.old?.map((x: any) => x.name) ?? [];
  const newData = {
    labels: newLabels,
    datasets: [
      { label: "2024 YoY %", data: ip?.new?.map((x: any) => x.y2024) ?? [], backgroundColor: "hsla(160, 64%, 40%, 0.5)" },
      { label: "2025 YoY %", data: ip?.new?.map((x: any) => x.y2025) ?? [], backgroundColor: CHART_COLORS.emerald },
    ],
  };
  const oldData = {
    labels: oldLabels,
    datasets: [
      { label: "2024 YoY %", data: ip?.old?.map((x: any) => x.y2024) ?? [], backgroundColor: "hsla(0, 72%, 51%, 0.5)" },
      { label: "2025 YoY %", data: ip?.old?.map((x: any) => x.y2025) ?? [], backgroundColor: CHART_COLORS.red },
    ],
  };

  return (
    <div data-testid="page-kshape">
      <PageHeader
        title="K-shape monitor"
        subtitle="The thesis crystallized: which industrial categories grew, and which shrank."
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

      {/* Live IVA chart */}
      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Industrial Value Added YoY % — NBS monthly</h2>
          <Badge variant="outline" className="font-normal">
            {hasLive ? "NBS live" : iva.isLoading ? "Loading…" : "couldn't load"}
          </Badge>
        </div>
        <div className="h-64">
          {iva.isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : liveIvaData ? (
            <Line
              options={{
                ...baseChartOptions,
                scales: {
                  ...baseChartOptions.scales,
                  x: { type: "time" as const, time: { unit: "month" as const } },
                  y: { ...baseChartOptions.scales.y, title: { display: true, text: "YoY %" } },
                },
              } as any}
              data={liveIvaData}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              NBS data unavailable — see static sector breakdown below
            </div>
          )}
        </div>
      </Card>

      {/* Static sector bars */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">New economy — industrial production (YoY %)</h2>
            <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/40" variant="outline">Up arm</Badge>
          </div>
          <div className="h-96"><Bar options={{...baseChartOptions, indexAxis: "y" as const} as any} data={newData} /></div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Old economy — industrial production (YoY %)</h2>
            <Badge className="bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/40" variant="outline">Down arm</Badge>
          </div>
          <div className="h-96"><Bar options={{...baseChartOptions, indexAxis: "y" as const} as any} data={oldData} /></div>
        </Card>
      </div>

      {/* Company earnings tables */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">New-economy company earnings</h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Company</TableHead><TableHead>Revenue</TableHead><TableHead>NP</TableHead><TableHead>YoY</TableHead><TableHead>GM</TableHead></TableRow></TableHeader>
              <TableBody>
                {DATA.companies?.new?.map((c: any) => (
                  <TableRow key={c.name + (c.ticker || "")}>
                    <TableCell className="text-xs font-medium">{c.name}<div className="text-[10px] text-muted-foreground">{c.ticker}</div></TableCell>
                    <TableCell className="text-xs tabular-nums">{c.rev}</TableCell>
                    <TableCell className="text-xs tabular-nums">{c.np}</TableCell>
                    <TableCell className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400">{c.npGr}</TableCell>
                    <TableCell className="text-xs tabular-nums">{c.gm}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">Old-economy company earnings</h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Company</TableHead><TableHead>Revenue</TableHead><TableHead>NP</TableHead><TableHead>YoY</TableHead><TableHead>GM</TableHead></TableRow></TableHeader>
              <TableBody>
                {DATA.companies?.old?.map((c: any) => (
                  <TableRow key={c.name + (c.ticker || "")}>
                    <TableCell className="text-xs font-medium">{c.name}<div className="text-[10px] text-muted-foreground">{c.ticker}</div></TableCell>
                    <TableCell className="text-xs tabular-nums">{c.rev}</TableCell>
                    <TableCell className="text-xs tabular-nums">{c.np}</TableCell>
                    <TableCell className="text-xs tabular-nums text-red-600 dark:text-red-400">{c.npGr}</TableCell>
                    <TableCell className="text-xs tabular-nums">{c.gm}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    </div>
  );
}
