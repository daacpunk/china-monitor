import { AlertTriangle, Activity, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AnomalyResult } from "@/hooks/useAnalysis";

interface Props {
  anomaly?: AnomalyResult | null;
  momPct?: number | null;
  yoyPct?: number | null;
  compact?: boolean;
}

export function AnomalyBadge({ anomaly, momPct, yoyPct, compact }: Props) {
  if (!anomaly) return null;

  const sev = anomaly.severity;
  const cls =
    sev === "anomaly"
      ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40"
      : sev === "watch"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
        : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40";

  const Icon = sev === "anomaly" ? AlertTriangle : sev === "watch" ? Activity : Check;
  const label = sev === "anomaly" ? "anomaly" : sev === "watch" ? "watch" : "normal";

  const z = anomaly.zScore;
  const zText = Number.isFinite(z) ? `${z >= 0 ? "+" : ""}${z.toFixed(1)}σ` : "—";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`anomaly-badge-${sev}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
              cls,
              compact && "text-[9px] px-1 py-px gap-0.5",
            )}
          >
            <Icon className={cn("h-3 w-3", compact && "h-2.5 w-2.5")} />
            <span>{compact ? zText : `${label} · ${zText}`}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-xs">
          <div className="space-y-1">
            <div>
              <span className="font-medium">{label}</span> · z-score {zText}
            </div>
            <div className="text-muted-foreground">
              Latest {anomaly.value.toFixed(2)} vs {anomaly.windowSize}-mo window mean{" "}
              {anomaly.windowMean.toFixed(2)} (σ {anomaly.windowStd.toFixed(2)})
            </div>
            {momPct != null && Number.isFinite(momPct) && (
              <div className="text-muted-foreground">
                MoM: {momPct >= 0 ? "+" : ""}
                {momPct.toFixed(1)}%
              </div>
            )}
            {yoyPct != null && Number.isFinite(yoyPct) && (
              <div className="text-muted-foreground">
                YoY: {yoyPct >= 0 ? "+" : ""}
                {yoyPct.toFixed(1)}%
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
