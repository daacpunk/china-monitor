/**
 * Costs — API spend dashboard.
 *
 * Shows this month's total spend, a per-service breakdown vs. budget ceilings,
 * a spend-by-context table, and a recent-calls log.
 *
 * Data:
 *   GET /api/audit/summary → { yearMonth, byService, byContext, ceilings, forecast }
 *   GET /api/audit/log?limit=30  → ApiCallLog[]
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DollarSign, Activity, List, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ─── API shapes ──────────────────────────────────────────────────────────────

interface ServiceRow {
  service: string;
  total: number;
  calls: number;
}

interface ContextRow {
  actionContext: string | null;
  service: string;
  total: number;
  calls: number;
}

interface CeilingRow {
  service: string;
  monthlyLimitUsd: number;
  currentMonthUsd: number;
  hardStopEnabled: boolean;
  monthlyCallCap: number | null;
  currentMonthCalls: number;
  monthAnchor: string;
}

interface ForecastRow {
  service: string;
  mtdSpend: number;
  mtdCalls: number;
  projectedSpend: number;
}

interface AuditSummary {
  yearMonth: string;
  byService: ServiceRow[];
  byContext: ContextRow[];
  ceilings: CeilingRow[];
  forecast?: ForecastRow[];
}

interface ApiCallLog {
  id: number;
  ts: string;
  service: string;
  endpoint: string;
  actionContext: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  status: string;
  latencyMs: number | null;
  errorMessage: string | null;
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtUsd(v: number, dp = 4): string {
  return `$${v.toFixed(dp)}`;
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

function pctOfLimit(spend: number, limit: number): number | null {
  if (!limit || limit <= 0) return null;
  return (spend / limit) * 100;
}

function pctColor(pct: number): string {
  if (pct >= 90) return "text-red-600 dark:text-red-400";
  if (pct >= 70) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

function statusBadgeVariant(status: string): "outline" | "destructive" | "secondary" {
  if (status === "ok") return "outline";
  if (status === "error" || status === "blocked_by_ceiling") return "destructive";
  return "secondary";
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  testId?: string;
}) {
  return (
    <Card className="p-5 flex flex-col gap-1" data-testid={testId}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider font-medium">
        <DollarSign className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function Costs() {
  const summaryQuery = useQuery<AuditSummary, Error>({
    queryKey: ["/api/audit/summary"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/audit/summary");
      return res.json();
    },
    retry: 1,
  });

  const logQuery = useQuery<ApiCallLog[], Error>({
    queryKey: ["/api/audit/log", 30],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/audit/log?limit=30");
      return res.json();
    },
    retry: 1,
  });

  const summary = summaryQuery.data;
  const logs = logQuery.data ?? [];

  // Build a ceiling lookup by service.
  const ceilingMap = new Map<string, CeilingRow>(
    (summary?.ceilings ?? []).map((c) => [c.service, c]),
  );

  // Total spend this month.
  const totalSpend = (summary?.byService ?? []).reduce((acc, r) => acc + r.total, 0);
  const totalBudget = (summary?.ceilings ?? []).reduce(
    (acc, c) => acc + (c.monthlyLimitUsd ?? 0),
    0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Costs"
        subtitle={`API spend tracking · ${summary?.yearMonth ?? "…"}`}
        meta={
          summaryQuery.data ? (
            <Badge variant="outline" className="tabular-nums text-[11px]">
              {summary!.yearMonth}
            </Badge>
          ) : undefined
        }
      />

      {/* ── Loading skeleton ── */}
      {summaryQuery.isLoading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="p-5 space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-7 w-16" />
              </Card>
            ))}
          </div>
          <Card className="p-5 space-y-3">
            <Skeleton className="h-4 w-32" />
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </Card>
        </div>
      )}

      {/* ── Error state ── */}
      {summaryQuery.isError && (
        <Card className="p-6 text-center">
          <AlertTriangle className="h-6 w-6 text-amber-500 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            Failed to load cost summary: {summaryQuery.error?.message}
          </p>
        </Card>
      )}

      {/* ── Loaded ── */}
      {summary && (
        <>
          {/* Headline stat row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard
              label="Total this month"
              value={fmtUsd(totalSpend, 4)}
              sub={totalBudget > 0 ? `of ${fmtUsd(totalBudget, 0)} budget` : undefined}
              testId="stat-total-spend"
            />
            <StatCard
              label="Services active"
              value={String(summary.byService.length)}
              sub={summary.yearMonth}
              testId="stat-services-active"
            />
            <StatCard
              label="Total calls"
              value={String(
                summary.byService.reduce((a, r) => a + r.calls, 0).toLocaleString(),
              )}
              testId="stat-total-calls"
            />
            {totalBudget > 0 && (
              <StatCard
                label="Budget used"
                value={fmtPct((totalSpend / totalBudget) * 100)}
                sub={`${fmtUsd(totalBudget - totalSpend, 4)} remaining`}
                testId="stat-budget-used"
              />
            )}
          </div>

          {/* ── Spend by service ── */}
          <Card className="p-5" data-testid="table-by-service">
            <div className="flex items-center gap-2 mb-4">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Spend by service</h2>
            </div>
            {summary.byService.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No spend recorded this month.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead className="border-b">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 px-3 font-medium">Service</th>
                      <th className="py-2 px-3 font-medium text-right">Calls</th>
                      <th className="py-2 px-3 font-medium text-right">Spend (USD)</th>
                      <th className="py-2 px-3 font-medium text-right">Budget cap</th>
                      <th className="py-2 px-3 font-medium text-right">% of budget</th>
                      <th className="py-2 px-3 font-medium text-right">Projected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byService.map((row) => {
                      const ceiling = ceilingMap.get(row.service);
                      const pct = ceiling
                        ? pctOfLimit(row.total, ceiling.monthlyLimitUsd)
                        : null;
                      const forecast = summary.forecast?.find(
                        (f) => f.service === row.service,
                      );
                      return (
                        <tr
                          key={row.service}
                          className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                          data-testid={`row-service-${row.service}`}
                        >
                          <td className="py-2 px-3 font-medium capitalize">{row.service}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                            {row.calls.toLocaleString()}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums font-mono">
                            {fmtUsd(row.total, 4)}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                            {ceiling ? fmtUsd(ceiling.monthlyLimitUsd, 0) : "—"}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {pct != null ? (
                              <span className={pctColor(pct)}>{fmtPct(pct)}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                            {forecast ? fmtUsd(forecast.projectedSpend, 4) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ── Spend by context ── */}
          <Card className="p-5" data-testid="table-by-context">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Spend by context</h2>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {summary.byContext.length} contexts
              </span>
            </div>
            {summary.byContext.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No context data this month.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead className="border-b">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 px-3 font-medium">Context</th>
                      <th className="py-2 px-3 font-medium">Service</th>
                      <th className="py-2 px-3 font-medium text-right">Calls</th>
                      <th className="py-2 px-3 font-medium text-right">Spend (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byContext.map((row, i) => (
                      <tr
                        key={i}
                        className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                        data-testid={`row-context-${i}`}
                      >
                        <td className="py-2 px-3 font-mono text-xs text-foreground/80">
                          {row.actionContext ?? <span className="text-muted-foreground italic">untagged</span>}
                        </td>
                        <td className="py-2 px-3 capitalize text-muted-foreground">
                          {row.service}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                          {row.calls.toLocaleString()}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums font-mono">
                          {fmtUsd(row.total, 4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ── Budget ceilings overview ── */}
          {summary.ceilings.length > 0 && (
            <Card className="p-5" data-testid="table-ceilings">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Budget ceilings</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead className="border-b">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 px-3 font-medium">Service</th>
                      <th className="py-2 px-3 font-medium text-right">Monthly limit</th>
                      <th className="py-2 px-3 font-medium text-right">MTD spend</th>
                      <th className="py-2 px-3 font-medium text-right">Call cap</th>
                      <th className="py-2 px-3 font-medium text-right">MTD calls</th>
                      <th className="py-2 px-3 font-medium">Hard stop</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.ceilings.map((c) => {
                      const pct = pctOfLimit(c.currentMonthUsd, c.monthlyLimitUsd);
                      return (
                        <tr
                          key={c.service}
                          className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                          data-testid={`row-ceiling-${c.service}`}
                        >
                          <td className="py-2 px-3 font-medium capitalize">{c.service}</td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {fmtUsd(c.monthlyLimitUsd, 0)}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {pct != null ? (
                              <span className={pctColor(pct)}>
                                {fmtUsd(c.currentMonthUsd, 4)} ({fmtPct(pct)})
                              </span>
                            ) : (
                              fmtUsd(c.currentMonthUsd, 4)
                            )}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                            {c.monthlyCallCap != null
                              ? c.monthlyCallCap.toLocaleString()
                              : "—"}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                            {c.currentMonthCalls.toLocaleString()}
                          </td>
                          <td className="py-2 px-3">
                            <Badge
                              variant={c.hardStopEnabled ? "default" : "outline"}
                              className="text-[10px]"
                            >
                              {c.hardStopEnabled ? "on" : "off"}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {/* ── Recent calls log ── */}
      <Card className="p-5" data-testid="table-recent-calls">
        <div className="flex items-center gap-2 mb-4">
          <List className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Recent calls</h2>
          <span className="ml-auto text-xs text-muted-foreground">Last 30</span>
        </div>
        {logQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No calls logged yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="border-b">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-2 px-3 font-medium">Time</th>
                  <th className="py-2 px-3 font-medium">Service</th>
                  <th className="py-2 px-3 font-medium">Endpoint</th>
                  <th className="py-2 px-3 font-medium">Context</th>
                  <th className="py-2 px-3 font-medium">Model</th>
                  <th className="py-2 px-3 font-medium text-right">Cost</th>
                  <th className="py-2 px-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                    data-testid={`row-log-${row.id}`}
                  >
                    <td className="py-2 px-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDistanceToNow(new Date(row.ts), { addSuffix: true })}
                    </td>
                    <td className="py-2 px-3 capitalize">{row.service}</td>
                    <td className="py-2 px-3 font-mono text-xs text-muted-foreground max-w-[140px] truncate">
                      {row.endpoint}
                    </td>
                    <td className="py-2 px-3 font-mono text-xs text-muted-foreground max-w-[120px] truncate">
                      {row.actionContext ?? <span className="italic">—</span>}
                    </td>
                    <td className="py-2 px-3 text-xs text-muted-foreground">
                      {row.model ?? "—"}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums font-mono text-xs">
                      {row.costUsd > 0 ? fmtUsd(row.costUsd, 4) : "—"}
                    </td>
                    <td className="py-2 px-3">
                      <Badge
                        variant={statusBadgeVariant(row.status)}
                        className="text-[10px]"
                      >
                        {row.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
