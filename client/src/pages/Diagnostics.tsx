/**
 * Diagnostics — single-glance health view.
 *
 * Status strip (app + sidecar + sources), sidecar card, series-freshness table
 * (centerpiece, stale/empty sorted to top), cost mini-panel, automation card,
 * and known limitations. Read-only. Backed by GET /api/diagnostics.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RefreshCw, CheckCircle2, AlertTriangle, XCircle, Server, Database,
  Clock, DollarSign, Loader2,
} from "lucide-react";

type Status = "ok" | "degraded" | "down" | "fresh" | "stale" | "empty";

interface Source { id: string; label: string; status: Status; detail: string }
interface SeriesRow {
  id: string; label: string; category: string; source: string;
  lastDate: string | null; ageDays: number | null; status: "fresh" | "stale" | "empty"; error: string | null;
}
interface Diag {
  generatedAt: string;
  app: { ok: boolean; env?: string; error?: string };
  sidecar?: { url: string; reachable: boolean; authConfigured: boolean; akshareVersion: string | null; cacheSize: number | null };
  sources: Source[];
  series: SeriesRow[];
  costs?: { yearMonth: string; totalUsd: number; byService: { service: string; total: number; calls: number }[] } | null;
  automation?: { enabled: boolean; cadence?: string; nextRunAt?: string | null; lastRunAt?: string | null; recentJobs: { status: string; kind: string; startedAt: string; noteId: number | null }[] };
  limitations: string[];
}

function statusTone(s: Status): string {
  if (s === "ok" || s === "fresh") return "bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/20";
  if (s === "degraded" || s === "stale") return "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20";
  return "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20";
}
function StatusIcon({ s }: { s: Status }) {
  if (s === "ok" || s === "fresh") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (s === "degraded" || s === "stale") return <AlertTriangle className="h-3.5 w-3.5" />;
  return <XCircle className="h-3.5 w-3.5" />;
}

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  try { return new Date(s.length === 7 ? `${s}-01` : s).toLocaleDateString(); } catch { return s; }
}

export default function Diagnostics() {
  const { data, isLoading, isFetching, refetch } = useQuery<Diag, Error>({
    queryKey: ["/api/diagnostics"],
    queryFn: async () => (await apiRequest("GET", "/api/diagnostics")).json(),
    refetchInterval: 60_000,
  });

  return (
    <div>
      <PageHeader
        title="Diagnostics"
        subtitle="Live health of the app, the Hong Kong data sidecar, every data source, and the freshness of each key series."
        meta={data ? <Badge variant="outline">As of {new Date(data.generatedAt).toLocaleTimeString()}</Badge> : undefined}
        actions={
          <Button variant="outline" className="gap-2" onClick={() => { queryClient.invalidateQueries({ queryKey: ["/api/diagnostics"] }); refetch(); }} disabled={isFetching} data-testid="diag-refresh">
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        }
      />

      {isLoading || !data ? (
        <div className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── Status strip ── */}
          <Card className="p-4" data-testid="diag-status-strip">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={`gap-1 ${statusTone(data.app.ok ? "ok" : "down")}`}>
                <StatusIcon s={data.app.ok ? "ok" : "down"} /> App{data.app.env ? ` · ${data.app.env}` : ""}
              </Badge>
              {data.sidecar && (
                <Badge variant="outline" className={`gap-1 ${statusTone(data.sidecar.reachable ? "ok" : "down")}`} title={data.sidecar.url}>
                  <StatusIcon s={data.sidecar.reachable ? "ok" : "down"} /> Sidecar
                </Badge>
              )}
              {data.sources.map((s) => (
                <Badge key={s.id} variant="outline" className={`gap-1 ${statusTone(s.status)}`} title={s.detail} data-testid={`diag-src-${s.id}`}>
                  <StatusIcon s={s.status} /> {s.label}
                </Badge>
              ))}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            {/* ── Sidecar card ── */}
            <Card className="p-4" data-testid="diag-sidecar">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Server className="h-4 w-4" /> Data sidecar</div>
              {data.sidecar ? (
                <dl className="space-y-1.5 text-sm">
                  <Row k="Host" v={data.sidecar.url} mono />
                  <Row k="Reachable" v={data.sidecar.reachable ? "yes" : "no"} tone={data.sidecar.reachable ? "ok" : "down"} />
                  <Row k="Auth configured" v={data.sidecar.authConfigured ? "yes" : "no"} tone={data.sidecar.authConfigured ? "ok" : "down"} />
                  <Row k="AKShare version" v={data.sidecar.akshareVersion ?? "—"} mono />
                  <Row k="Cache entries" v={String(data.sidecar.cacheSize ?? "—")} />
                </dl>
              ) : <div className="text-sm text-muted-foreground">No sidecar info.</div>}
            </Card>

            {/* ── Cost mini-panel ── */}
            <Card className="p-4" data-testid="diag-costs">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold"><DollarSign className="h-4 w-4" /> Spend ({data.costs?.yearMonth ?? "—"})</div>
                <Link href="/costs" className="text-xs text-primary hover:underline">Details →</Link>
              </div>
              {data.costs ? (
                <>
                  <div className="mb-2 text-2xl font-semibold">${data.costs.totalUsd.toFixed(2)}</div>
                  <div className="space-y-1 text-sm">
                    {data.costs.byService.map((s) => (
                      <div key={s.service} className="flex justify-between">
                        <span className="capitalize text-muted-foreground">{s.service}</span>
                        <span>${(s.total ?? 0).toFixed(3)} · {s.calls}</span>
                      </div>
                    ))}
                    {data.costs.byService.length === 0 && <div className="text-muted-foreground">No spend recorded.</div>}
                  </div>
                </>
              ) : <div className="text-sm text-muted-foreground">No cost data.</div>}
            </Card>

            {/* ── Automation card ── */}
            <Card className="p-4" data-testid="diag-automation">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold"><Clock className="h-4 w-4" /> Automation</div>
                <Link href="/automation" className="text-xs text-primary hover:underline">Manage →</Link>
              </div>
              {data.automation ? (
                <dl className="space-y-1.5 text-sm">
                  <Row k="Enabled" v={data.automation.enabled ? "yes" : "no"} tone={data.automation.enabled ? "ok" : "degraded"} />
                  {data.automation.cadence && <Row k="Cadence" v={data.automation.cadence} />}
                  <Row k="Next run" v={fmtDate(data.automation.nextRunAt)} />
                  <Row k="Last run" v={fmtDate(data.automation.lastRunAt)} />
                  <div className="pt-1">
                    <div className="mb-1 text-[10px] uppercase text-muted-foreground">Recent jobs</div>
                    <div className="flex flex-wrap gap-1">
                      {data.automation.recentJobs.length === 0 ? <span className="text-xs text-muted-foreground">none</span> :
                        data.automation.recentJobs.map((j, i) => (
                          <Badge key={i} variant="outline" className={`text-[10px] ${statusTone(j.status === "success" ? "ok" : j.status === "running" ? "degraded" : "down")}`} title={`${j.kind} · ${fmtDate(j.startedAt)}`}>
                            {j.status}
                          </Badge>
                        ))}
                    </div>
                  </div>
                </dl>
              ) : <div className="text-sm text-muted-foreground">No automation config.</div>}
            </Card>
          </div>

          {/* ── Series freshness table (centerpiece) ── */}
          <Card className="p-4" data-testid="diag-series-table">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Database className="h-4 w-4" /> Series freshness</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Series</th>
                    <th className="py-2 pr-4">Category</th>
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4">Last data</th>
                    <th className="py-2">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {data.series.map((s) => (
                    <tr key={s.id} className="border-b align-top" data-testid={`diag-series-${s.id}`}>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className={`gap-1 ${statusTone(s.status)}`}><StatusIcon s={s.status} /> {s.status}</Badge>
                      </td>
                      <td className="py-2 pr-4"><span className="font-medium">{s.label}</span><div className="text-[11px] text-muted-foreground">{s.id}</div></td>
                      <td className="py-2 pr-4 capitalize text-muted-foreground">{s.category}</td>
                      <td className="py-2 pr-4"><Badge variant="outline" className="text-[10px] uppercase">{s.source}</Badge></td>
                      <td className="py-2 pr-4">{fmtDate(s.lastDate)}</td>
                      <td className="py-2">{s.ageDays != null ? `${s.ageDays}d` : "—"}{s.error ? <div className="text-[11px] text-red-600 max-w-[260px] truncate" title={s.error}>{s.error}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── Known limitations ── */}
          {data.limitations.length > 0 && (
            <Card className="p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-500" /> Known limitations</div>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {data.limitations.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, mono, tone }: { k: string; v: string; mono?: boolean; tone?: Status }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={`${mono ? "font-mono text-xs" : ""} ${tone ? statusTone(tone).split(" ").filter((c) => c.startsWith("text-")).join(" ") : ""}`}>{v}</span>
    </div>
  );
}
