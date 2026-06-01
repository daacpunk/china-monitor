import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { Line } from "react-chartjs-2";
import { DATA, LAST_UPDATED } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";

export default function Outlook() {
  const f = DATA.gdpForecasts;
  const labels = ["2025", "2026", "2027"];
  const palette = [CHART_COLORS.primary, CHART_COLORS.secondary, CHART_COLORS.emerald, CHART_COLORS.amber, CHART_COLORS.orange, CHART_COLORS.muted];

  const chart = {
    labels,
    datasets: f.map((inst: any, i: number) => ({
      label: inst.institution,
      data: [inst.y2025, inst.y2026, inst.y2027],
      borderColor: palette[i % palette.length],
      backgroundColor: "transparent",
      tension: 0.3,
      borderDash: inst.institution.includes("Beijing") ? [4, 4] : undefined,
    })),
  };

  return (
    <div data-testid="page-outlook">
      <PageHeader
        title="GDP outlook"
        subtitle="Consensus vs Beijing — where the forecasts converge and where they diverge."
        meta={<><ProvenanceChip type="static" detail={`Static · ${LAST_UPDATED}`} /><ProvenanceChip type="sonar" detail="Sonar Pro: wires Phase 3" /></>}
      />

      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-3">2025-2027 real GDP growth forecasts (%)</h2>
        <div className="h-80"><Line options={baseChartOptions as any} data={chart} /></div>
        <p className="text-xs text-muted-foreground mt-3">
          IMF / World Bank see continued deceleration to 4.0% by 2027. Goldman / Morgan Stanley
          higher at 4.7%. The 15FYP sets a 4.5-5% target. The gap between bulls and bears = the
          K-shape resolution question.
        </p>
      </Card>
    </div>
  );
}
