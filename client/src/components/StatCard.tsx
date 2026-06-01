import { Card } from "@/components/ui/card";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  delta,
  hint,
  tone = "neutral",
  children,
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  hint?: string;
  tone?: "neutral" | "good" | "bad" | "warn";
  children?: ReactNode;
}) {
  const toneCls = {
    neutral: "text-foreground",
    good: "text-emerald-600 dark:text-emerald-400",
    bad: "text-red-600 dark:text-red-400",
    warn: "text-amber-600 dark:text-amber-400",
  }[tone];
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums", toneCls)}>{value}</div>
      {delta && <div className="text-xs text-muted-foreground mt-1">{delta}</div>}
      {hint && <div className="text-[11px] text-muted-foreground mt-2 leading-snug">{hint}</div>}
      {children}
    </Card>
  );
}
