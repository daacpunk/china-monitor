/**
 * Track Record — the tool's self-scorecard.
 *
 * Every house view, sector stance and thesis verdict is logged as a falsifiable
 * prediction and auto-resolved on the scheduler tick against realized index
 * returns. This page shows the hit rate overall / by kind / by model, the Brier
 * score (calibration), and the full ledger of resolved + open calls.
 * Backed by GET /api/track-record.
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Target, RefreshCw, Loader2, CheckCircle2, XCircle, CircleDashed, Clock } from "lucide-react";

interface Bucket {
  key: string; correct: number; wrong: number; partial: number; resolved: number; hitRate: number | null;
}
interface Summary {
  total: number; open: number; resolved: number; correct: number; wrong: number; partial: number;
  hitRate: number | null; brier: number | null; brierN: number;
  byKind: Bucket[]; byModel: Bucket[];
}
interface Prediction {
  id: number; createdAt: string; kind: string; sourceId: number | null; model: string | null;
  horizon: string; resolveAt: string; claim: any; probability: number | null; anchor: any;
  status: string; outcome: string | null; realized: any; scoredAt: string | null;
}
interface Payload { summary: Summary; predictions: Prediction[]; error?: string }

function pct(n: number | null | undefined, d = 0): string {
  return n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(d)}%`;
}
function fmtDate(s?: string | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleDateString(); } catch { return s; }
}

function claimText(p: Prediction): string {
  const c = p.claim ?? {};
  if (p.kind === "house_view") return `${c.target ?? "CSI300"} — ${c.stance ?? "?"} (expect ${c.direction ?? "?"})`;
  if (p.kind === "sector_stance") return `${c.theme ?? "?"} ${c.stance ?? "?"} vs ${c.benchmark ?? "CSI300"}`;
  return `${(c.verdict ?? "thesis").replace(/_/g, " ")}: ${String(c.summary ?? "").slice(0, 120)}`;
}
function realizedText(p: Prediction): string {
  const r = p.realized ?? {};
  if (typeof r.excess === "number") return `${pct(r.ret, 1)} vs bench ${pct(r.benchmarkRet, 1)} (excess ${pct(r.excess, 1)})`;
  if (typeof r.ret === "number") return `${pct(r.ret, 1)} over the window`;
  return r.note ?? "—";
}

function OutcomeBadge({ outcome, status }: { outcome: string | null; status: string }) {
  if (status !== "resolved") {
    return <Badge variant="outline" className="gap-1 text-muted-foreground"><Clock className="h-3 w-3" />open</Badge>;
  }
  if (outcome === "correct") {
    return <Badge variant="outline" className="gap-1 bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/20"><CheckCircle2 className="h-3 w-3" />correct</Badge>;
  }
  if (outcome === "wrong") {
    return <Badge variant="outline" className="gap-1 bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20"><XCircle className="h-3 w-3" />wrong</Badge>;
  }
  return <Badge variant="outline" className="gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20"><CircleDashed className="h-3 w-3" />partial</Badge>;
}

function BucketTable({ title, rows, label }: { title: string; rows: Bucket[]; label: string }) {
  return (
    <Card className="p-4">
      <div className="text-sm font-semibold mb-3">{title}</div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No resolved calls yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b">
              <th className="py-1.5 font-medium">{label}</th>
              <th className="py-1.5 font-medium text-right">Hit rate</th>
              <th className="py-1.5 font-medium text-right">Correct</th>
              <th className="py-1.5 font-medium text-right">Wrong</th>
              <th className="py-1.5 font-medium text-right">Partial</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key} className="border-b last:border-0">
                <td className="py-1.5">{b.key.replace(/_/g, " ")}</td>
                <td className="py-1.5 text-right font-medium tabular-nums">{pct(b.hitRate)}</td>
                <td className="py-1.5 text-right tabular-nums text-green-600 dark:text-green-400">{b.correct}</td>
                <td className="py-1.5 text-right tabular-nums text-red-600 dark:text-red-400">{b.wrong}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{b.partial}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function TrackRecord() {
  const { data, isLoading, isFetching, refetch } = useQuery<Payload, Error>({
    queryKey: ["/api/track-record"],
    queryFn: async () => (await apiRequest("GET", "/api/track-record")).json(),
    refetchInterval: 120_000,
  });

  const resolveNow = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/track-record/resolve")).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/track-record"] }),
  });

  const s = data?.summary;
  const preds = data?.predictions ?? [];
  const resolved = preds.filter((p) => p.status === "resolved");
  const open = preds.filter((p) => p.status !== "resolved");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Track Record"
        subtitle="Self-scoring forecast ledger: every house view, sector stance and thesis is logged as a falsifiable call and auto-resolved against realized index returns."
      />

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={() => resolveNow.mutate()} disabled={resolveNow.isPending}>
          {resolveNow.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Target className="h-3.5 w-3.5 mr-1.5" />}
          Run resolution pass
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {/* Headline metrics */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Overall hit rate</div>
              <div className="text-3xl font-semibold tabular-nums">{pct(s?.hitRate ?? null)}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {(s?.correct ?? 0)} correct / {(s?.wrong ?? 0)} wrong
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Resolved</div>
              <div className="text-3xl font-semibold tabular-nums">{s?.resolved ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-1">{s?.partial ?? 0} partial</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Open calls</div>
              <div className="text-3xl font-semibold tabular-nums">{s?.open ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-1">awaiting horizon</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Brier score</div>
              <div className="text-3xl font-semibold tabular-nums">{s?.brier != null ? s.brier.toFixed(3) : "—"}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {s?.brierN ?? 0} probabilistic calls · lower is better
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Calibration</div>
              <div className="text-sm mt-2">
                {s?.brier == null
                  ? "Not enough probabilistic calls scored yet."
                  : s.brier < 0.18
                    ? "Well calibrated (Brier < 0.18)."
                    : s.brier < 0.25
                      ? "Roughly calibrated — near a coin-flip baseline (0.25)."
                      : "Poorly calibrated — worse than always saying 50%."}
              </div>
            </Card>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <BucketTable title="Hit rate by call type" rows={s?.byKind ?? []} label="Kind" />
            <BucketTable title="Hit rate by model" rows={s?.byModel ?? []} label="Model" />
          </div>

          {/* Resolved ledger */}
          <Card className="p-4">
            <div className="text-sm font-semibold mb-3">Resolved calls</div>
            {resolved.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No calls have reached their resolution date yet. Predictions are captured automatically whenever a
                house view is saved or a thesis-driven note is generated, and scored on the 15-minute scheduler tick
                once the horizon (1Q = 90d, 2Q = 180d, 1Y = 365d) has elapsed.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b">
                      <th className="py-1.5 font-medium">Made</th>
                      <th className="py-1.5 font-medium">Kind</th>
                      <th className="py-1.5 font-medium">Claim</th>
                      <th className="py-1.5 font-medium">Horizon</th>
                      <th className="py-1.5 font-medium">Outcome</th>
                      <th className="py-1.5 font-medium">Realized</th>
                      <th className="py-1.5 font-medium">Model</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolved.map((p) => (
                      <tr key={p.id} className="border-b last:border-0 align-top">
                        <td className="py-2 whitespace-nowrap text-muted-foreground">{fmtDate(p.createdAt)}</td>
                        <td className="py-2 whitespace-nowrap">{p.kind.replace(/_/g, " ")}</td>
                        <td className="py-2 max-w-[26rem]">{claimText(p)}</td>
                        <td className="py-2 whitespace-nowrap">{p.horizon}</td>
                        <td className="py-2"><OutcomeBadge outcome={p.outcome} status={p.status} /></td>
                        <td className="py-2 max-w-[20rem] text-muted-foreground">{realizedText(p)}</td>
                        <td className="py-2 whitespace-nowrap text-muted-foreground">{p.model ?? "manual"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Open ledger */}
          <Card className="p-4">
            <div className="text-sm font-semibold mb-3">Open calls ({open.length})</div>
            {open.length === 0 ? (
              <div className="text-sm text-muted-foreground">No open predictions. Save a house view to start logging.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b">
                      <th className="py-1.5 font-medium">Made</th>
                      <th className="py-1.5 font-medium">Kind</th>
                      <th className="py-1.5 font-medium">Claim</th>
                      <th className="py-1.5 font-medium">Resolves</th>
                      <th className="py-1.5 font-medium">Anchor</th>
                      <th className="py-1.5 font-medium">Prob.</th>
                      <th className="py-1.5 font-medium">Model</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.map((p) => (
                      <tr key={p.id} className="border-b last:border-0 align-top">
                        <td className="py-2 whitespace-nowrap text-muted-foreground">{fmtDate(p.createdAt)}</td>
                        <td className="py-2 whitespace-nowrap">{p.kind.replace(/_/g, " ")}</td>
                        <td className="py-2 max-w-[26rem]">{claimText(p)}</td>
                        <td className="py-2 whitespace-nowrap">{fmtDate(p.resolveAt)}</td>
                        <td className="py-2 whitespace-nowrap text-muted-foreground tabular-nums">
                          {p.anchor?.csi300 != null ? `CSI300 ${Number(p.anchor.csi300).toFixed(0)}` : "—"}
                        </td>
                        <td className="py-2 tabular-nums">{p.probability != null ? pct(p.probability) : "—"}</td>
                        <td className="py-2 whitespace-nowrap text-muted-foreground">{p.model ?? "manual"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="text-xs text-muted-foreground">
            Scoring: directional index calls use a ±2% flat band over the horizon window; sector stances are scored
            against CSI 300 (overweight must outperform); thesis calls are scored softly and fall back to “partial”
            when no clean direction or price series is available — never fabricated. The same hit rate is injected
            into the strategy note evidence base and the exported deck.
          </p>
        </>
      )}
    </div>
  );
}
