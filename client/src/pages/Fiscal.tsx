import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { Bar } from "react-chartjs-2";
import { DATA, LAST_UPDATED } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";

export default function Fiscal() {
  const items = DATA.fiscalSupport.items;
  const labels = items.map((i: any) => i.label);
  const data = {
    labels,
    datasets: [
      { label: "2024", data: items.map((i: any) => i.y2024), backgroundColor: CHART_COLORS.muted },
      { label: "2025", data: items.map((i: any) => i.y2025), backgroundColor: CHART_COLORS.primary },
      { label: "2026", data: items.map((i: any) => i.y2026), backgroundColor: CHART_COLORS.emerald },
    ],
  };

  return (
    <div data-testid="page-fiscal">
      <PageHeader
        title="Fiscal & policy support"
        subtitle="Where the state is putting credit, by bucket — and the 15FYP policy timeline."
        meta={<><ProvenanceChip type="static" detail={`Static · ${LAST_UPDATED}`} /></>}
      />

      <Card className="p-5 mb-4">
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
            data={data}
          />
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-3">Policy timeline — Q2 2024 to Q2 2026</h2>
        <div className="space-y-2">
          {DATA.policyTimeline.map((p: any, i: number) => (
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
