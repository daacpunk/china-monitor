import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Line } from "react-chartjs-2";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { useCompareMutation } from "@/hooks/useAnalysis";
import { useSeriesRegistry } from "@/hooks/useSeries";
import { Plus, X } from "lucide-react";

const PALETTE = [
  CHART_COLORS.primary,
  CHART_COLORS.emerald,
  CHART_COLORS.amber,
  CHART_COLORS.red,
  CHART_COLORS.muted,
  CHART_COLORS.secondary,
];

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialIds?: string[];
  /** Optional registry-like list for picker; if absent, uses useSeriesRegistry */
  availableIds?: string[];
}

export function CompareModal({ open, onOpenChange, initialIds, availableIds }: Props) {
  const [ids, setIds] = useState<string[]>(initialIds ?? []);
  const { data: registry } = useSeriesRegistry();
  const compare = useCompareMutation();

  useEffect(() => {
    if (open && initialIds && initialIds.length > 0) {
      setIds(initialIds);
    }
  }, [open, initialIds]);

  useEffect(() => {
    if (open && ids.length >= 2) {
      compare.mutate({ ids });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ids.join("|")]);

  const allIds = availableIds ?? (registry ?? []).map((r) => r.id);
  const remaining = allIds.filter((id) => !ids.includes(id));

  const chartData = compare.data
    ? {
        datasets: ids.map((id, i) => ({
          label: id,
          data: compare.data!.dates.map((d, j) => ({ x: d, y: compare.data!.values[id][j] })),
          borderColor: PALETTE[i % PALETTE.length],
          backgroundColor: "transparent",
          tension: 0.3,
          pointRadius: 0,
          parsing: { xAxisKey: "x", yAxisKey: "y" },
        })),
      }
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl" data-testid="dialog-compare">
        <DialogHeader>
          <DialogTitle>Compare series</DialogTitle>
          <DialogDescription>
            Pick 2–8 series. Cross-source correlation on the date intersection.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {ids.map((id, i) => (
            <Badge
              key={id}
              variant="outline"
              className="gap-1.5 pl-2.5"
              style={{ borderColor: PALETTE[i % PALETTE.length] + "60" }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: PALETTE[i % PALETTE.length] }}
              />
              {id}
              <button
                onClick={() => setIds((p) => p.filter((x) => x !== id))}
                className="ml-0.5 rounded hover:bg-muted p-0.5"
                data-testid={`button-remove-${id}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {ids.length < 8 && remaining.length > 0 && (
            <select
              className="text-xs border rounded-md px-2 py-1 bg-background"
              value=""
              onChange={(e) => {
                if (e.target.value) setIds((p) => [...p, e.target.value]);
              }}
              data-testid="select-add-series"
            >
              <option value="">+ add series…</option>
              {remaining.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="h-64 mt-2">
          {compare.isPending && <Skeleton className="h-full w-full" />}
          {compare.isError && (
            <div className="text-sm text-red-600 dark:text-red-400 p-4">
              {(compare.error as Error)?.message ?? "Failed to load"}
            </div>
          )}
          {!compare.isPending && chartData && (
            <Line
              data={chartData as any}
              options={{
                ...(baseChartOptions as any),
                scales: {
                  ...((baseChartOptions as any).scales ?? {}),
                  x: { type: "time", time: { unit: "month" } },
                },
              }}
            />
          )}
          {ids.length < 2 && !compare.isPending && (
            <div className="text-sm text-muted-foreground p-4 italic">
              Add at least 2 series to compare.
            </div>
          )}
        </div>

        {compare.data && (
          <div className="mt-2">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
              Correlation matrix · {compare.data.commonPoints} common points
            </div>
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse w-full">
                <thead>
                  <tr>
                    <th className="border p-1.5 bg-muted/50"></th>
                    {compare.data.ids.map((id) => (
                      <th key={id} className="border p-1.5 bg-muted/50 font-medium">
                        {id}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {compare.data.correlationMatrix.map((row, i) => (
                    <tr key={i}>
                      <td className="border p-1.5 bg-muted/50 font-medium">
                        {compare.data!.ids[i]}
                      </td>
                      {row.map((c, j) => {
                        const v = Number(c);
                        const intensity = Math.min(1, Math.abs(v));
                        const color =
                          v > 0
                            ? `rgba(16,185,129,${0.1 + intensity * 0.35})`
                            : `rgba(239,68,68,${0.1 + intensity * 0.35})`;
                        return (
                          <td
                            key={j}
                            className="border p-1.5 text-center tabular-nums"
                            style={{ background: i === j ? "transparent" : color }}
                            data-testid={`corr-${i}-${j}`}
                          >
                            {Number.isFinite(v) ? v.toFixed(2) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CompareButton({
  ids,
  label = "Compare",
}: {
  ids: string[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="button-open-compare"
        className="gap-1.5"
      >
        <Plus className="h-3.5 w-3.5" />
        {label}
      </Button>
      <CompareModal open={open} onOpenChange={setOpen} initialIds={ids} />
    </>
  );
}
