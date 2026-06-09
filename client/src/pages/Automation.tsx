/**
 * Automation (Phase 5) — schedule recurring strategy reports.
 *
 * - Enable/disable + cadence (monthly/quarterly), day-of-month, hour (UTC).
 * - Reuses the composer controls: mode, emphasis themes, featured names, model.
 * - House-view behaviour (propose-only vs auto-update) + notification settings.
 * - Run-now (full report) and Refresh-now (data only) manual triggers.
 * - Run-history table from job_runs.
 */

import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Clock, Play, RefreshCw, Loader2, CalendarClock, Bell, CheckCircle2,
  XCircle, AlertTriangle, Settings2,
} from "lucide-react";

type Mode = "data_driven" | "thesis_driven";
type ModelId = "claude-sonnet-4" | "claude-haiku-4" | "deepseek-chat" | "deepseek-reasoner";
const THEMES = ["tech", "ev", "battery", "semi", "ai", "consumer"] as const;

interface AutomationConfig {
  enabled: boolean;
  cadence: "monthly" | "quarterly";
  dayOfMonth: number;
  hourUtc: number;
  mode: Mode;
  emphasis: string[];
  featuredNames: string[];
  model: string;
  refreshPolicyFirst: boolean;
  autoUpdateHouseView: boolean;
  notify: { inApp: boolean; email?: string };
  lastRunAt?: string;
  nextRunAt?: string;
  runningAt?: string;
}

interface JobStep { step: string; ok: boolean; ms: number; detail?: string }
interface JobRun {
  id: number; kind: string; status: string; steps: JobStep[];
  costUsd: number; noteId: number | null; startedAt: string;
  finishedAt: string | null; error: string | null;
}

interface UniverseName { symbol: string; nameEn: string }
interface UniverseTheme { names: UniverseName[] }

function toggle(list: string[], item: string, set: (v: string[]) => void) {
  set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
}

function fmtUtcHourAsHkt(h: number): string {
  const hkt = (h + 8) % 24;
  return `${String(hkt).padStart(2, "0")}:00 HKT`;
}

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

export default function Automation() {
  const { toast } = useToast();

  const configQuery = useQuery<{ config: AutomationConfig; jobs: JobRun[] }, Error>({
    queryKey: ["/api/automation"],
    queryFn: async () => (await apiRequest("GET", "/api/automation")).json(),
    refetchInterval: 30_000,
  });

  const universeQuery = useQuery<{ themes: UniverseTheme[] }, Error>({
    queryKey: ["/api/equity/universe"],
    queryFn: async () => (await apiRequest("GET", "/api/equity/universe")).json(),
  });
  const allNames = useMemo(() => {
    const seen = new Set<string>(); const out: UniverseName[] = [];
    for (const t of universeQuery.data?.themes ?? []) for (const n of t.names) if (!seen.has(n.symbol)) { seen.add(n.symbol); out.push(n); }
    return out;
  }, [universeQuery.data]);

  // Local editable mirror of config.
  const [cfg, setCfg] = useState<AutomationConfig | null>(null);
  useEffect(() => {
    if (configQuery.data?.config && cfg === null) setCfg(configQuery.data.config);
  }, [configQuery.data, cfg]);

  const saveMutation = useMutation({
    mutationFn: async (patch: Partial<AutomationConfig>) =>
      (await apiRequest("PUT", "/api/automation", patch)).json(),
    onSuccess: (data) => {
      setCfg(data.config);
      queryClient.invalidateQueries({ queryKey: ["/api/automation"] });
      toast({ title: "Schedule saved", description: data.config.enabled ? `Next run: ${fmtDate(data.config.nextRunAt)}` : "Automation disabled" });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const runNowMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/automation/run-now", {})).json(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation"] });
      queryClient.invalidateQueries({ queryKey: ["/api/report"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      toast({ title: "Report generated", description: data.noteId ? `Note #${data.noteId}` : data.status });
    },
    onError: (e: Error) => toast({ title: "Run failed", description: e.message, variant: "destructive" }),
  });

  const refreshNowMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/automation/refresh", {
      emphasis: cfg?.emphasis, featuredNames: cfg?.featuredNames, refreshPolicy: cfg?.refreshPolicyFirst,
    })).json(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation"] });
      toast({ title: "Data refreshed", description: `${data.seriesRefreshed ?? 0} series refreshed` });
    },
    onError: (e: Error) => toast({ title: "Refresh failed", description: e.message, variant: "destructive" }),
  });

  if (configQuery.isLoading || cfg === null) {
    return (
      <div>
        <PageHeader title="Automation" subtitle="Schedule recurring strategy reports and data refreshes." />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const jobs = configQuery.data?.jobs ?? [];
  const update = (patch: Partial<AutomationConfig>) => setCfg({ ...cfg, ...patch });

  return (
    <div>
      <PageHeader
        title="Automation"
        subtitle="Schedule recurring strategy reports. The pipeline refreshes data, proposes a house view, writes a full strategy note, and notifies you."
        meta={
          <>
            <Badge variant={cfg.enabled ? "default" : "outline"} className="gap-1">
              <CalendarClock className="h-3 w-3" />
              {cfg.enabled ? "Enabled" : "Disabled"}
            </Badge>
            {cfg.enabled && (
              <Badge variant="outline" data-testid="badge-next-run">Next: {fmtDate(cfg.nextRunAt)}</Badge>
            )}
            {cfg.lastRunAt && <Badge variant="outline">Last: {fmtDate(cfg.lastRunAt)}</Badge>}
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => refreshNowMutation.mutate()}
              disabled={refreshNowMutation.isPending}
              data-testid="button-refresh-now"
            >
              {refreshNowMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh data
            </Button>
            <Button
              className="gap-2"
              onClick={() => runNowMutation.mutate()}
              disabled={runNowMutation.isPending}
              data-testid="button-run-now"
            >
              {runNowMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {runNowMutation.isPending ? "Running…" : "Run now"}
            </Button>
          </>
        }
      />

      {runNowMutation.isPending && (
        <div className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Running the full pipeline (refresh → house view → strategy note). This takes ~1-3 minutes.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Schedule ── */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold"><Clock className="h-4 w-4" /> Schedule</div>
            <Switch
              checked={cfg.enabled}
              onCheckedChange={(v) => update({ enabled: v })}
              data-testid="switch-enabled"
            />
          </div>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Cadence</label>
              <div className="flex gap-2">
                {(["monthly", "quarterly"] as const).map((c) => (
                  <button key={c} onClick={() => update({ cadence: c })} data-testid={`cadence-${c}`}>
                    <Badge variant={cfg.cadence === c ? "default" : "outline"} className="cursor-pointer capitalize">{c}</Badge>
                  </button>
                ))}
              </div>
              {cfg.cadence === "quarterly" && (
                <p className="mt-1 text-[11px] text-muted-foreground">Fires in Jan / Apr / Jul / Oct.</p>
              )}
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Day of month (1-28)</label>
                <Input
                  type="number" min={1} max={28} value={cfg.dayOfMonth}
                  onChange={(e) => update({ dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
                  data-testid="input-day"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Hour (UTC)</label>
                <Input
                  type="number" min={0} max={23} value={cfg.hourUtc}
                  onChange={(e) => update({ hourUtc: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })}
                  data-testid="input-hour"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">= {fmtUtcHourAsHkt(cfg.hourUtc)}</p>
              </div>
            </div>
          </div>
        </Card>

        {/* ── Notifications + house view ── */}
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold"><Bell className="h-4 w-4" /> Delivery & house view</div>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">In-app notifications</div>
                <div className="text-[11px] text-muted-foreground">Shows in the header bell when a run finishes.</div>
              </div>
              <Switch
                checked={cfg.notify.inApp}
                onCheckedChange={(v) => update({ notify: { ...cfg.notify, inApp: v } })}
                data-testid="switch-inapp"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Email (optional)</label>
              <Input
                type="email" placeholder="you@example.com — requires SMTP env"
                value={cfg.notify.email ?? ""}
                onChange={(e) => update({ notify: { ...cfg.notify, email: e.target.value } })}
                data-testid="input-email"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">Email delivery is off until SMTP is configured on the server.</p>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Auto-update house view</div>
                <div className="text-[11px] text-muted-foreground">If off, the run only proposes changes (recommended).</div>
              </div>
              <Switch
                checked={cfg.autoUpdateHouseView}
                onCheckedChange={(v) => update({ autoUpdateHouseView: v })}
                data-testid="switch-houseview"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Refresh policy first</div>
                <div className="text-[11px] text-muted-foreground">Run a Sonar policy scan before writing.</div>
              </div>
              <Switch
                checked={cfg.refreshPolicyFirst}
                onCheckedChange={(v) => update({ refreshPolicyFirst: v })}
                data-testid="switch-policy"
              />
            </div>
          </div>
        </Card>
      </div>

      {/* ── Composer defaults ── */}
      <Card className="mt-4 p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold"><Settings2 className="h-4 w-4" /> Report composer defaults</div>

        <div className="mb-3 flex gap-2">
          <button onClick={() => update({ mode: "data_driven" })} data-testid="auto-mode-data" className={`flex-1 rounded-md border p-3 text-left ${cfg.mode === "data_driven" ? "border-primary bg-primary/5" : ""}`}>
            <div className="text-sm font-medium">Data-Driven</div>
            <div className="mt-1 text-xs text-muted-foreground">AI leads from the data — narrative, strategy, and a model portfolio.</div>
          </button>
          <button onClick={() => update({ mode: "thesis_driven" })} data-testid="auto-mode-thesis" className={`flex-1 rounded-md border p-3 text-left ${cfg.mode === "thesis_driven" ? "border-primary bg-primary/5" : ""}`}>
            <div className="text-sm font-medium">Thesis-Driven</div>
            <div className="mt-1 text-xs text-muted-foreground">Stress-tests a stored thesis as a critic. (Scheduled runs default to Data-Driven.)</div>
          </button>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Emphasis themes</label>
          <div className="flex flex-wrap gap-1.5">
            {THEMES.map((t) => (
              <button key={t} onClick={() => toggle(cfg.emphasis, t, (v) => update({ emphasis: v }))}>
                <Badge variant={cfg.emphasis.includes(t) ? "default" : "outline"} className="cursor-pointer capitalize">{t}</Badge>
              </button>
            ))}
          </div>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Featured names (from universe)</label>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {allNames.map((n) => (
              <button key={n.symbol} onClick={() => toggle(cfg.featuredNames, n.symbol, (v) => update({ featuredNames: v }))}>
                <Badge variant={cfg.featuredNames.includes(n.symbol) ? "default" : "outline"} className="cursor-pointer text-[11px]">{n.nameEn}</Badge>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Synthesis model</label>
            <select value={cfg.model} onChange={(e) => update({ model: e.target.value as ModelId })} className="rounded-md border bg-background px-2 py-1 text-sm" data-testid="select-model">
              <option value="claude-sonnet-4">Claude Sonnet 4.6 (default)</option>
              <option value="claude-haiku-4">Claude Haiku 4.5 (cheaper)</option>
              <option value="deepseek-reasoner">DeepSeek Reasoner</option>
              <option value="deepseek-chat">DeepSeek Chat</option>
            </select>
          </div>
          <Button
            className="ml-auto gap-2 self-end"
            onClick={() => saveMutation.mutate(cfg)}
            disabled={saveMutation.isPending}
            data-testid="button-save-schedule"
          >
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Save schedule
          </Button>
        </div>
      </Card>

      {/* ── Run history ── */}
      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><CalendarClock className="h-4 w-4" /> Run history</div>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet. Use “Run now” to generate a report immediately.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Kind</th>
                  <th className="py-2 pr-4">Started</th>
                  <th className="py-2 pr-4">Finished</th>
                  <th className="py-2 pr-4">Note</th>
                  <th className="py-2 pr-4">Cost</th>
                  <th className="py-2">Steps</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b align-top" data-testid={`job-${j.id}`}>
                    <td className="py-2 pr-4">
                      {j.status === "success" ? (
                        <span className="inline-flex items-center gap-1 text-green-600"><CheckCircle2 className="h-3.5 w-3.5" /> success</span>
                      ) : j.status === "running" ? (
                        <span className="inline-flex items-center gap-1 text-blue-600"><Loader2 className="h-3.5 w-3.5 animate-spin" /> running</span>
                      ) : j.status === "failed" ? (
                        <span className="inline-flex items-center gap-1 text-red-600"><XCircle className="h-3.5 w-3.5" /> failed</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3.5 w-3.5" /> {j.status}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 capitalize">{j.kind}</td>
                    <td className="py-2 pr-4 text-xs">{fmtDate(j.startedAt)}</td>
                    <td className="py-2 pr-4 text-xs">{fmtDate(j.finishedAt)}</td>
                    <td className="py-2 pr-4">{j.noteId ? `#${j.noteId}` : "—"}</td>
                    <td className="py-2 pr-4 text-xs">${(j.costUsd ?? 0).toFixed(3)}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {(j.steps ?? []).map((s, i) => (
                          <Badge key={i} variant={s.ok ? "outline" : "destructive"} className="text-[10px]" title={s.detail}>
                            {s.step} {Math.round(s.ms / 100) / 10}s
                          </Badge>
                        ))}
                      </div>
                      {j.error && <div className="mt-1 text-[11px] text-red-600">{j.error}</div>}
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
