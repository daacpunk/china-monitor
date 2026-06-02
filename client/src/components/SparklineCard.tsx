import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Line } from "react-chartjs-2";
import { useSeries, getLatestValue } from "@/hooks/useSeries";
import { ProvenanceChipLive } from "@/components/ProvenanceChip";
import { AnomalyBadge } from "@/components/AnomalyBadge";
import { useAnomalies } from "@/hooks/useAnalysis";
import { CHART_COLORS } from "@/lib/charts";

interface Props {
  logicalId: string;
  label: string;
  /** Numeric pivot — line is colored above/below this value */
  pivot?: number;
  hint?: string;
  /** Tail length in months */
  months?: number;
  /** Show z-score badge inline */
  showAnomaly?: boolean;
}

export function SparklineCard({
  logicalId,
  label,
  pivot = 100,
  hint,
  months = 36,
  showAnomaly = true,
}: Props) {
  const series = useSeries(logicalId) as any;
  const anom = useAnomalies(showAnomaly ? [logicalId] : [], 24, showAnomaly);
  const anomalyRow = anom.data?.results?.[0];

  if (series.isLoading) {
    return (
      <Card className="p-4">
        <Skeleton className="h-4 w-24 mb-2" />
        <Skeleton className="h-8 w-32 mb-1" />
        <Skeleton className="h-16 w-full" />
      </Card>
    );
  }

  const pts: { date: string; value: number | null }[] = series.data?.data ?? [];
  const tail = pts.slice(-months);
  const latest = getLatestValue(series.data);
  const prov = series.data?.provenance;
  const hasData = latest.value !== null;

  const aboveCount = tail.filter((p) => (p.value ?? 0) >= pivot).length;
  const aboveMajor = aboveCount > tail.length / 2;
  const color = !hasData
    ? CHART_COLORS.muted
    : latest.value! >= pivot
      ? CHART_COLORS.emerald
      : CHART_COLORS.red;

  const sparkData = {
    datasets: [
      {
        data: tail.map((p) => ({ x: p.date, y: p.value })),
        borderColor: color,
        backgroundColor: color + "20",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 1.5,
        parsing: { xAxisKey: "x", yAxisKey: "y" },
      },
    ],
  };

  return (
    <Card className="p-4" data-testid={`sparkline-${logicalId}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="text-xs text-muted-foreground uppercase tracking-wider">{label}</div>
        {anomalyRow?.anomaly && showAnomaly && (
          <AnomalyBadge
            anomaly={anomalyRow.anomaly}
            momPct={anomalyRow.momLagPct}
            yoyPct={anomalyRow.yoyLagPct}
            compact
          />
        )}
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <div
          className="text-2xl font-semibold tabular-nums"
          style={{ color: hasData ? color : undefined }}
        >
          {hasData ? latest.value!.toFixed(2) : "—"}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {latest.date ?? ""} {pivot != null && hasData && (
            <span className="ml-1">
              {latest.value! >= pivot ? "above" : "below"} {pivot}
            </span>
          )}
        </div>
      </div>
      <div className="h-16 mt-2 -mx-1">
        <Line
          data={sparkData as any}
          options={
            {
              responsive: true,
              maintainAspectRatio: false,
              animation: false,
              plugins: { legend: { display: false }, tooltip: { enabled: false } },
              scales: {
                x: { type: "time" as const, display: false, time: { unit: "month" as const } },
                y: { display: false },
              },
              elements: { line: { borderJoinStyle: "round" } },
            } as any
          }
        />
      </div>
      <div className="flex items-center justify-between mt-2">
        {hint && <div className="text-[10px] text-muted-foreground leading-tight">{hint}</div>}
        {prov && (
          <ProvenanceChipLive
            source={prov.source}
            lastUpdated={prov.lastUpdated}
            cacheHit={prov.cacheHit}
          />
        )}
      </div>
    </Card>
  );
}
