import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { Line } from "react-chartjs-2";
import { DATA, LAST_UPDATED } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function Equity() {
  const r = DATA.aShareReturns;
  const lineData = {
    labels: r.years,
    datasets: [
      { label: "CSI 300",       data: r.series.csi300,       borderColor: CHART_COLORS.primary, backgroundColor: "transparent", tension: 0.3 },
      { label: "ChiNext",       data: r.series.chiNext,      borderColor: CHART_COLORS.secondary, backgroundColor: "transparent", tension: 0.3 },
      { label: "STAR 50",       data: r.series.star50,       borderColor: CHART_COLORS.emerald, backgroundColor: "transparent", tension: 0.3, borderWidth: 2.5 },
      { label: "SSE Composite", data: r.series.sseComposite, borderColor: CHART_COLORS.muted,    backgroundColor: "transparent", tension: 0.3 },
    ],
  };

  return (
    <div data-testid="page-equity">
      <PageHeader
        title="A-share equities"
        subtitle="Returns, valuation, and Stock Connect flows. Phase 2 will wire live index prices via free sources."
        meta={<><ProvenanceChip type="static" detail={`Static · ${LAST_UPDATED}`} /><ProvenanceChip type="free" detail="Yahoo/Stooq: wires Phase 2" /></>}
      />

      <Card className="p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">Annual returns (%)</h2>
        <div className="h-72"><Line options={baseChartOptions as any} data={lineData} /></div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">A-share valuation</h2>
          <Table>
            <TableHeader><TableRow><TableHead>Metric</TableHead><TableHead className="text-right">Value</TableHead><TableHead className="text-right">As of</TableHead></TableRow></TableHeader>
            <TableBody>
              {DATA.aShareValuation.map((v: any) => (
                <TableRow key={v.metric}>
                  <TableCell className="text-sm">{v.metric}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{v.value}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{v.date}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">Stock Connect flows</h2>
          <Table>
            <TableHeader><TableRow><TableHead>Metric</TableHead><TableHead className="text-right">2024</TableHead><TableHead className="text-right">2025</TableHead><TableHead className="text-right">Δ</TableHead></TableRow></TableHeader>
            <TableBody>
              {DATA.stockConnect.metrics.map((m: any) => (
                <TableRow key={m.metric}>
                  <TableCell className="text-sm">{m.metric}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{m.y2024}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{m.y2025}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs font-medium text-emerald-600 dark:text-emerald-400">{m.delta}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground mt-3">{DATA.stockConnect.sectorFocus}</p>
        </Card>
      </div>
    </div>
  );
}
