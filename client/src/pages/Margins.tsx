import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { Bar, Line } from "react-chartjs-2";
import { DATA, LAST_UPDATED } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";

export default function Margins() {
  const ppi = DATA.ppi;
  const sorted = [...ppi.sectors].sort((a: any, b: any) => b.y2025 - a.y2025);
  const ppiData = {
    labels: sorted.map((s: any) => s.name),
    datasets: [
      { label: "2024", data: sorted.map((s: any) => s.y2024), backgroundColor: CHART_COLORS.muted },
      { label: "2025", data: sorted.map((s: any) => s.y2025), backgroundColor: sorted.map((s: any) =>
        s.group === "new" ? CHART_COLORS.emerald : s.group === "old" ? CHART_COLORS.red : CHART_COLORS.primary,
      ) },
    ],
  };

  const ev = DATA.evMargin;
  const evData = {
    labels: ev.years,
    datasets: [
      { label: "Auto industry profit margin (%)", data: ev.margin, borderColor: CHART_COLORS.red, backgroundColor: "hsla(0, 72%, 51%, 0.1)", fill: true, tension: 0.3 },
    ],
  };

  return (
    <div data-testid="page-margins">
      <PageHeader
        title="PPI & margin pressure"
        subtitle="Deflation by sector, plus the auto industry's margin collapse — anti-involution context."
        meta={<><ProvenanceChip type="static" detail={`Static · ${LAST_UPDATED}`} /><ProvenanceChip type="ceic" detail="CEIC: wires Phase 2" /></>}
      />

      <Card className="p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">PPI by sector (YoY %, 2024 vs 2025)</h2>
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
            data={ppiData}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Battery-metal mining (+17.2%) and non-ferrous smelting (+6.3%) are the only sectors with
          sustained pricing power. Every old-economy sector is in PPI contraction. PPI turned
          positive overall in Apr 2026 (+0.4%) — first in 41 months.
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-3">Auto industry profit margin (%)</h2>
        <div className="h-64"><Line options={baseChartOptions as any} data={evData} /></div>
        <p className="text-xs text-muted-foreground mt-3">{ev.note}</p>
      </Card>
    </div>
  );
}
