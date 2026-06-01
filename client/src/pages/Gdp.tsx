import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { Line, Bar } from "react-chartjs-2";
import { DATA, LAST_UPDATED } from "@/data/staticData";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";

export default function Gdp() {
  const g = DATA.gdpShares;
  const stack = {
    labels: g.years,
    datasets: [
      { label: "Real estate (narrow)", data: g.series.realEstateNarrow, borderColor: CHART_COLORS.red,     backgroundColor: "transparent", tension: 0.3 },
      { label: "Real estate (broad)",  data: g.series.realEstateBroad,  borderColor: CHART_COLORS.orange,  backgroundColor: "transparent", tension: 0.3 },
      { label: "Clean energy",         data: g.series.cleanEnergy,      borderColor: CHART_COLORS.emerald, backgroundColor: "transparent", tension: 0.3, borderWidth: 2.5 },
      { label: "Digital economy",      data: g.series.digitalEconomy,   borderColor: CHART_COLORS.primary, backgroundColor: "transparent", tension: 0.3 },
      { label: "Construction",         data: g.series.construction,     borderColor: CHART_COLORS.muted,   backgroundColor: "transparent", tension: 0.3 },
    ],
  };

  const ce = DATA.cleanEnergyContrib;
  const ceBar = {
    labels: ce.years,
    datasets: [
      { label: "Clean energy value (RMB tn)", data: ce.value,       backgroundColor: CHART_COLORS.emerald, yAxisID: "y" },
      { label: "% of GDP growth",             data: ce.growthShare, backgroundColor: CHART_COLORS.primary,  yAxisID: "y1", type: "line" as const, borderColor: CHART_COLORS.primary, tension: 0.3 },
    ],
  };

  return (
    <div data-testid="page-gdp">
      <PageHeader
        title="GDP composition & energy"
        subtitle="The crossover: clean energy is now larger than real estate (narrow) in GDP share."
        meta={<><ProvenanceChip type="static" detail={`Static · ${LAST_UPDATED}`} /></>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">GDP share by component (%)</h2>
          <div className="h-72"><Line options={baseChartOptions as any} data={stack} /></div>
          <p className="text-xs text-muted-foreground mt-3">
            Narrow real estate (developer + brokerage VA) is now 5.5% of GDP, down from 8% in 2020 and
            below clean energy's 11.4%. Broad real estate (including construction, services) still
            ~17%, but contracting.
          </p>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">Clean energy contribution to growth</h2>
          <div className="h-72">
            <Bar
              options={{
                ...baseChartOptions,
                scales: {
                  ...baseChartOptions.scales,
                  y:  { ...baseChartOptions.scales.y,  position: "left",  title: { display: true, text: "RMB tn" } },
                  y1: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "% of growth" } },
                } as any,
              } as any}
              data={ceBar as any}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Clean energy contributed 37% of 2025 GDP growth — the single largest driver. RMB 15.4 tn
            of GDP, up from RMB 11.6 tn in 2023.
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wider">Clean energy GDP share</div>
          <div className="mt-1.5 text-2xl font-semibold text-emerald-600 dark:text-emerald-400">11.4%</div>
          <div className="text-xs text-muted-foreground">2025, up from 7.3% in 2022</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wider">Real estate (narrow) GDP share</div>
          <div className="mt-1.5 text-2xl font-semibold text-red-600 dark:text-red-400">5.5%</div>
          <div className="text-xs text-muted-foreground">2025, down from 8.0% in 2020</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wider">Digital economy share</div>
          <div className="mt-1.5 text-2xl font-semibold text-primary">11.5%</div>
          <div className="text-xs text-muted-foreground">2025, up from 7.8% in 2020</div>
        </Card>
      </div>
    </div>
  );
}
