import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { Line } from "react-chartjs-2";
import { DATA, LAST_UPDATED } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";

export default function Investment() {
  const fai = DATA.fai;
  const labels = fai?.years ?? [];
  const lineData = {
    labels,
    datasets: [
      { label: "Total FAI",       data: fai.series.total,         borderColor: CHART_COLORS.primary,   backgroundColor: "transparent", tension: 0.3 },
      { label: "Real estate",     data: fai.series.realEstate,    borderColor: CHART_COLORS.red,       backgroundColor: "transparent", tension: 0.3 },
      { label: "Infrastructure",  data: fai.series.infrastructure,borderColor: CHART_COLORS.amber,     backgroundColor: "transparent", tension: 0.3 },
      { label: "Manufacturing",   data: fai.series.manufacturing, borderColor: CHART_COLORS.teal,      backgroundColor: "transparent", tension: 0.3 },
      { label: "High-tech",       data: fai.series.highTech,      borderColor: CHART_COLORS.emerald,   backgroundColor: "transparent", tension: 0.3, borderWidth: 2.5 },
    ],
  };

  const sorted = [...(DATA.subsectorFAI ?? [])].sort((a: any, b: any) => b.pct - a.pct);

  return (
    <div data-testid="page-investment">
      <PageHeader
        title="Fixed-Asset Investment"
        subtitle="Top-line FAI growth and sub-sector dispersion — the cleanest signal of K-shape divergence."
        meta={<><ProvenanceChip type="static" detail={`Static · ${LAST_UPDATED}`} /><ProvenanceChip type="ceic" detail="CEIC: wires Phase 2" /></>}
      />

      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">FAI growth (YoY %) — five components</h2>
          <Badge variant="outline" className="font-normal">2020-2026Q1</Badge>
        </div>
        <div className="h-72">
          <Line options={baseChartOptions as any} data={lineData} />
        </div>
        <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
          High-tech manufacturing capex held up through the property bust; total FAI dragged down by
          real estate's three-year contraction. 2026Q1 rebound (+1.7%) marks the first stabilization.
        </p>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">2025 sub-sector growth — sorted</h2>
          <Badge variant="outline" className="font-normal">{sorted.length} sub-sectors</Badge>
        </div>
        <div className="space-y-1.5">
          {sorted.map((s: any) => {
            const pct = s.pct;
            const w = Math.min(Math.abs(pct), 100);
            const positive = pct >= 0;
            const color = s.group === "new" ? "bg-emerald-500" : s.group === "old" ? "bg-red-500" : "bg-muted-foreground";
            return (
              <div key={s.name} className="grid grid-cols-[1fr_auto] gap-3 items-center text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="truncate">{s.name}</span>
                    {s.group === "new" && <Badge variant="outline" className="h-4 px-1 text-[10px] border-emerald-500/40 text-emerald-700 dark:text-emerald-300">new</Badge>}
                    {s.group === "old" && <Badge variant="outline" className="h-4 px-1 text-[10px] border-red-500/40 text-red-700 dark:text-red-300">old</Badge>}
                  </div>
                  <div className="relative h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`absolute top-0 h-full ${color} ${positive ? "left-1/2" : "right-1/2"}`}
                      style={{ width: `${w / 2}%` }}
                    />
                    <div className="absolute top-0 left-1/2 h-full w-px bg-border" />
                  </div>
                </div>
                <div className="text-right tabular-nums w-32">
                  <span className={positive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                    {positive ? "+" : ""}{pct}%
                  </span>
                  <span className="text-[11px] text-muted-foreground ml-1.5">{s.cny}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
