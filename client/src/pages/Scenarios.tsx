/**
 * Scenarios — 1Q-forward base/bull/bear synthesis from /api/scenarios/*.
 *
 * Phase 3b Session 3.
 *
 *  - Three big tinted cards (base/bull/bear) with auto-balanced probability
 *    sliders + numeric input, "Save edits" → PATCH /api/scenarios/:id.
 *  - Header controls: target-quarter selector (prev 4 ... next 2),
 *    model toggle (Sonnet 4.6 default | Haiku 4.5), Regenerate button.
 *  - Inputs accordion below cards — driver/equity snapshots that the LLM
 *    saw at generation time (read-only audit panel).
 *  - Hit-rate history table — lazy GET /api/scenarios/:id/hit-rate per row.
 *  - AICommentaryPanel footer with logicalId="scenarios:<quarter>".
 *
 * All numbers come from the live API. No mocked / training-data values.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { AICommentaryPanel } from "@/components/AICommentaryPanel";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Sparkles,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  RefreshCw,
  Pencil,
  AlertCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ─── Wire types ──────────────────────────────────────────────────────────────

type Direction = "up" | "down" | "flat";

interface CaseProjection {
  narrative: string;
  drivers: Record<string, { direction: Direction; reasoning: string }>;
  equityCalls: Record<string, { direction: Direction; reasoning: string }>;
}

interface DriverSnapshot {
  id: string;
  latestDate: string | null;
  latestValue: number | null;
  mom: number | null;
  yoy: number | null;
  zScore: number | null;
  severity: "normal" | "watch" | "anomaly" | null;
  trendClass: string | null;
  multiscaleConfirmed: boolean;
  trendStart: string | null;
}

interface EquitySnapshot {
  id: string;
  latestDate: string | null;
  latestLevel: number | null;
  mom: number | null;
  ytdPct: number | null;
}

interface ScenarioInputs {
  asOf: string;
  targetQuarter: string;
  drivers: DriverSnapshot[];
  equities: EquitySnapshot[];
  crossSourceConfirmation: {
    up: number;
    down: number;
    flat: number;
    confirmation: string;
  };
}

interface Scenario {
  id: number;
  generatedAt: string;
  targetQuarter: string;
  baseCase: CaseProjection;
  bullCase: CaseProjection;
  bearCase: CaseProjection;
  baseProb: number;
  bullProb: number;
  bearProb: number;
  inputsJson: ScenarioInputs;
  model: string;
  costUsd: number;
  userEdited: boolean;
  hitRateJson: any;
}

interface HitRateResponse {
  hitRate: {
    actualWinner: "base" | "bull" | "bear" | null;
    brier: number;
    perEquity: Record<
      string,
      { realized: number | null; actualDir: Direction | null }
    >;
  };
}

// ─── Labels & display helpers ────────────────────────────────────────────────

const DRIVER_LABEL: Record<string, string> = {
  ppi_yoy: "PPI YoY",
  cpi_yoy: "CPI YoY",
  iva_yoy: "Industrial Value-Added YoY",
  retail_sales_yoy: "Retail Sales YoY",
  m2_yoy: "M2 Money Supply YoY",
  usdcny_monthly: "USD/CNY",
  exports_yoy: "Exports YoY",
  new_home_prices_70city: "70-City New Home Prices YoY",
  oecd_cli_china: "OECD CLI (China)",
};

const EQUITY_LABEL: Record<string, string> = {
  csi300_monthly: "CSI 300",
  chinext_monthly: "ChiNext",
  hangseng_monthly: "Hang Seng",
};

function fmtPct(v: number | null | undefined, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}

function fmtNum(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(dp);
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// ─── Quarter helpers ─────────────────────────────────────────────────────────

function currentQuarter(d = new Date()): string {
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

function shiftQuarter(q: string, delta: number): string {
  const m = q.match(/^(\d{4})-Q([1-4])$/);
  if (!m) return q;
  let y = Number(m[1]);
  let qn = Number(m[2]);
  qn += delta;
  while (qn > 4) {
    qn -= 4;
    y += 1;
  }
  while (qn < 1) {
    qn += 4;
    y -= 1;
  }
  return `${y}-Q${qn}`;
}

function nextQuarter(d = new Date()): string {
  return shiftQuarter(currentQuarter(d), 1);
}

function buildQuarterOptions(): string[] {
  const now = nextQuarter();
  // Show next 2 quarters first (next is the default), then current, then prev 4
  const out: string[] = [];
  for (let d = 2; d >= -4; d--) {
    out.push(shiftQuarter(now, d));
  }
  return out;
}

// ─── Direction pill ──────────────────────────────────────────────────────────

function DirPill({ dir }: { dir: Direction }) {
  if (dir === "up") {
    return (
      <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
        <ArrowUpRight className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (dir === "down") {
    return (
      <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400">
        <ArrowDownRight className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-muted-foreground">
      <Minus className="h-3.5 w-3.5" />
    </span>
  );
}

// ─── Scenario card (base / bull / bear) ──────────────────────────────────────

type CaseKind = "base" | "bull" | "bear";

interface CaseMeta {
  kind: CaseKind;
  label: string;
  tint: string;
  border: string;
  badge: string;
  ring: string;
}

const CASE_META: Record<CaseKind, CaseMeta> = {
  base: {
    kind: "base",
    label: "Base case",
    tint: "bg-primary/5 dark:bg-primary/10",
    border: "border-primary/30",
    badge: "bg-primary/15 text-primary border-primary/40",
    ring: "ring-primary/30",
  },
  bull: {
    kind: "bull",
    label: "Bull case",
    tint: "bg-emerald-500/5 dark:bg-emerald-500/10",
    border: "border-emerald-500/30",
    badge:
      "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/40",
    ring: "ring-emerald-500/30",
  },
  bear: {
    kind: "bear",
    label: "Bear case",
    tint: "bg-red-500/5 dark:bg-red-500/10",
    border: "border-red-500/30",
    badge:
      "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40",
    ring: "ring-red-500/30",
  },
};

function getCase(s: Scenario, kind: CaseKind): CaseProjection {
  return kind === "base" ? s.baseCase : kind === "bull" ? s.bullCase : s.bearCase;
}

function getProb(s: Scenario, kind: CaseKind): number {
  return kind === "base" ? s.baseProb : kind === "bull" ? s.bullProb : s.bearProb;
}

interface ProbState {
  base: number; // 0..100
  bull: number;
  bear: number;
}

function ScenarioCard({
  scenario,
  kind,
  probs,
  onProbChange,
}: {
  scenario: Scenario;
  kind: CaseKind;
  probs: ProbState;
  onProbChange: (kind: CaseKind, value: number) => void;
}) {
  const meta = CASE_META[kind];
  const c = getCase(scenario, kind);
  const prob = probs[kind];

  const driverIds = Object.keys(c.drivers);
  const equityIds = Object.keys(c.equityCalls);

  return (
    <Card
      className={`p-5 ${meta.tint} ${meta.border} border-2 flex flex-col gap-4`}
      data-testid={`card-scenario-${kind}`}
    >
      <div className="flex items-start justify-between gap-3">
        <Badge
          variant="outline"
          className={`${meta.badge} text-sm px-3 py-1 font-semibold`}
        >
          {meta.label}
        </Badge>
        <div className="text-right">
          <div className="text-3xl font-bold tabular-nums">{Math.round(prob)}%</div>
          <div className="text-xs text-muted-foreground">probability</div>
        </div>
      </div>

      <div>
        <Slider
          min={0}
          max={100}
          step={5}
          value={[prob]}
          onValueChange={(v) => onProbChange(kind, v[0] ?? prob)}
          className={`${meta.ring}`}
          data-testid={`slider-prob-${kind}`}
        />
        <div className="text-[11px] text-muted-foreground mt-1.5 text-right tabular-nums">
          sliders auto-balance to 100%
        </div>
      </div>

      <p className="text-sm leading-relaxed text-foreground/90 min-h-[6rem]">
        {c.narrative}
      </p>

      {driverIds.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            Drivers ({driverIds.length})
          </div>
          <div className="space-y-1.5">
            {driverIds.map((id) => {
              const d = c.drivers[id];
              return (
                <div
                  key={id}
                  className="flex items-start gap-2 text-xs"
                  data-testid={`row-driver-${kind}-${id}`}
                >
                  <div className="pt-0.5 shrink-0">
                    <DirPill dir={d.direction} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-foreground/90">
                      {DRIVER_LABEL[id] ?? id}
                    </span>
                    <span className="text-muted-foreground"> — {d.reasoning}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {equityIds.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            Equity calls
          </div>
          <div className="space-y-1.5">
            {equityIds.map((id) => {
              const e = c.equityCalls[id];
              return (
                <div
                  key={id}
                  className="flex items-start gap-2 text-xs"
                  data-testid={`row-equity-${kind}-${id}`}
                >
                  <div className="pt-0.5 shrink-0">
                    <DirPill dir={e.direction} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-foreground/90">
                      {EQUITY_LABEL[id] ?? id}
                    </span>
                    <span className="text-muted-foreground"> — {e.reasoning}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Hit-rate row (lazy) ─────────────────────────────────────────────────────

function HitRateRow({ scenario }: { scenario: Scenario }) {
  const { data, isLoading } = useQuery<HitRateResponse>({
    queryKey: ["/api/scenarios", scenario.id, "hit-rate"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/scenarios/${scenario.id}/hit-rate`);
      return res.json();
    },
    retry: 0,
  });

  const winner = data?.hitRate?.actualWinner ?? null;
  const brier = data?.hitRate?.brier;
  const brierStr =
    brier == null || !Number.isFinite(brier) ? "—" : brier.toFixed(3);

  const winnerProb =
    winner === "base"
      ? scenario.baseProb
      : winner === "bull"
        ? scenario.bullProb
        : winner === "bear"
          ? scenario.bearProb
          : null;

  return (
    <tr
      className="border-b last:border-0"
      data-testid={`row-hitrate-${scenario.id}`}
    >
      <td className="py-2 px-3 font-medium">{scenario.targetQuarter}</td>
      <td className="py-2 px-3 text-xs text-muted-foreground tabular-nums">
        {Math.round(scenario.baseProb * 100)}/{Math.round(scenario.bullProb * 100)}/
        {Math.round(scenario.bearProb * 100)}
      </td>
      <td className="py-2 px-3">
        {isLoading ? (
          <Skeleton className="h-4 w-16" />
        ) : winner ? (
          <Badge
            variant="outline"
            className={CASE_META[winner].badge}
          >
            {winner}
            {winnerProb != null && (
              <span className="ml-1 opacity-70 tabular-nums">
                ({Math.round(winnerProb * 100)}%)
              </span>
            )}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">pending</span>
        )}
      </td>
      <td className="py-2 px-3 tabular-nums text-xs">{brierStr}</td>
      <td className="py-2 px-3 text-xs text-muted-foreground font-mono">
        {scenario.model}
      </td>
      <td className="py-2 px-3 tabular-nums text-xs">
        {fmtCost(scenario.costUsd)}
      </td>
      <td className="py-2 px-3 text-xs text-muted-foreground">
        {formatDistanceToNow(new Date(scenario.generatedAt), { addSuffix: true })}
      </td>
    </tr>
  );
}

// ─── Inputs accordion content ────────────────────────────────────────────────

function InputsAccordion({ inputs }: { inputs: ScenarioInputs | null }) {
  if (!inputs) {
    return (
      <div className="text-sm text-muted-foreground">
        No input snapshot available for this scenario.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          Macro drivers ({inputs.drivers.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="border-b">
              <tr className="text-left text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Driver</th>
                <th className="py-1.5 pr-3 font-medium">Latest</th>
                <th className="py-1.5 pr-3 font-medium">As of</th>
                <th className="py-1.5 pr-3 font-medium">MoM</th>
                <th className="py-1.5 pr-3 font-medium">YoY</th>
                <th className="py-1.5 pr-3 font-medium">z</th>
                <th className="py-1.5 pr-3 font-medium">Severity</th>
                <th className="py-1.5 pr-3 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {inputs.drivers.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 font-medium">
                    {DRIVER_LABEL[d.id] ?? d.id}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {fmtNum(d.latestValue)}
                  </td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {d.latestDate ?? "—"}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtPct(d.mom)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtPct(d.yoy)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {fmtNum(d.zScore)}
                  </td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {d.severity ?? "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {d.trendClass ?? "—"}
                    {d.multiscaleConfirmed ? " · confirmed" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          Equity universe ({inputs.equities.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="border-b">
              <tr className="text-left text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Index</th>
                <th className="py-1.5 pr-3 font-medium">Latest</th>
                <th className="py-1.5 pr-3 font-medium">As of</th>
                <th className="py-1.5 pr-3 font-medium">MoM</th>
                <th className="py-1.5 pr-3 font-medium">YTD</th>
              </tr>
            </thead>
            <tbody>
              {inputs.equities.map((e) => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 font-medium">
                    {EQUITY_LABEL[e.id] ?? e.id}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {fmtNum(e.latestLevel, e.latestLevel != null && e.latestLevel > 100 ? 0 : 4)}
                  </td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {e.latestDate ?? "—"}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtPct(e.mom)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtPct(e.ytdPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        Cross-source confirmation —{" "}
        <span className="font-medium text-foreground/80">
          {inputs.crossSourceConfirmation.confirmation}
        </span>{" "}
        (up={inputs.crossSourceConfirmation.up}, down=
        {inputs.crossSourceConfirmation.down}, flat=
        {inputs.crossSourceConfirmation.flat}). Snapshot taken{" "}
        {inputs.asOf
          ? formatDistanceToNow(new Date(inputs.asOf), { addSuffix: true })
          : "—"}
        .
      </div>
    </div>
  );
}

// ─── Auto-balance helper ────────────────────────────────────────────────────

function rebalanceProbs(
  prev: ProbState,
  changedKind: CaseKind,
  newValue: number,
): ProbState {
  // Clamp to [0, 100]
  const v = Math.max(0, Math.min(100, newValue));
  const otherKinds = (["base", "bull", "bear"] as CaseKind[]).filter(
    (k) => k !== changedKind,
  );
  const others = otherKinds.map((k) => prev[k]);
  const otherSum = others[0] + others[1];
  const remaining = 100 - v;

  let next0: number;
  let next1: number;
  if (otherSum <= 0) {
    // Split evenly if both were zero
    next0 = remaining / 2;
    next1 = remaining / 2;
  } else {
    next0 = (others[0] / otherSum) * remaining;
    next1 = (others[1] / otherSum) * remaining;
  }

  // Round to nearest integer and fix rounding drift so total = 100
  let rounded0 = Math.round(next0);
  let rounded1 = Math.round(next1);
  const total = Math.round(v) + rounded0 + rounded1;
  const drift = 100 - total;
  if (drift !== 0) {
    // Apply drift to the larger of the two others
    if (rounded0 >= rounded1) rounded0 += drift;
    else rounded1 += drift;
  }

  const out: ProbState = { base: 0, bull: 0, bear: 0 };
  out[changedKind] = Math.round(v);
  out[otherKinds[0]] = Math.max(0, Math.min(100, rounded0));
  out[otherKinds[1]] = Math.max(0, Math.min(100, rounded1));
  return out;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Scenarios() {
  const { toast } = useToast();
  const quarterOptions = useMemo(buildQuarterOptions, []);
  const [quarter, setQuarter] = useState<string>(nextQuarter());
  const [model, setModel] = useState<"claude-sonnet-4" | "claude-haiku-4">(
    "claude-sonnet-4",
  );

  // Fetch latest scenario for the selected quarter
  const latestQuery = useQuery<{ scenario: Scenario } | { error: string }>({
    queryKey: ["/api/scenarios/latest", quarter],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/scenarios/latest?quarter=${encodeURIComponent(quarter)}`,
      );
      return res.json();
    },
    retry: 0,
  });

  // 404 surfaces as a thrown error. Detect "no scenario" vs other errors.
  const scenario: Scenario | null =
    latestQuery.data && "scenario" in latestQuery.data
      ? latestQuery.data.scenario
      : null;
  const isNoScenarioYet =
    !scenario && (latestQuery.error as any)?.message?.includes("No scenario");

  // History (all scenarios)
  const historyQuery = useQuery<{ scenarios: Scenario[] }>({
    queryKey: ["/api/scenarios"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/scenarios?limit=20");
      return res.json();
    },
    retry: 0,
  });

  // Local probability state (synced from server when scenario changes)
  const [probs, setProbs] = useState<ProbState>({ base: 50, bull: 25, bear: 25 });
  useEffect(() => {
    if (scenario) {
      setProbs({
        base: Math.round(scenario.baseProb * 100),
        bull: Math.round(scenario.bullProb * 100),
        bear: Math.round(scenario.bearProb * 100),
      });
    }
  }, [scenario?.id]);

  const baseProbRemote = scenario ? Math.round(scenario.baseProb * 100) : 50;
  const bullProbRemote = scenario ? Math.round(scenario.bullProb * 100) : 25;
  const bearProbRemote = scenario ? Math.round(scenario.bearProb * 100) : 25;

  const probsDirty =
    !!scenario &&
    (probs.base !== baseProbRemote ||
      probs.bull !== bullProbRemote ||
      probs.bear !== bearProbRemote);

  // Generate mutation
  const generateMutation = useMutation<
    { scenario: Scenario; costUsd: number; cacheHit: boolean; tokensIn: number; tokensOut: number },
    Error
  >({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/scenarios/generate", {
        model,
        targetQuarter: quarter,
      });
      return res.json();
    },
    onMutate: () => {
      toast({
        title: `Generating ${quarter} scenario…`,
        description: `${model === "claude-sonnet-4" ? "Sonnet 4.6" : "Haiku 4.5"} · ~30s`,
      });
    },
    onSuccess: (data) => {
      toast({
        title: data.cacheHit ? "Cached scenario served" : "Scenario generated",
        description: `${fmtCost(data.costUsd)} · ${data.tokensIn}/${data.tokensOut} tokens`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/scenarios/latest", quarter] });
      queryClient.invalidateQueries({ queryKey: ["/api/scenarios"] });
    },
    onError: (err) => {
      toast({
        title: "Generation failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Save edits mutation
  const saveMutation = useMutation<{ scenario: Scenario }, Error>({
    mutationFn: async () => {
      if (!scenario) throw new Error("No scenario loaded");
      const res = await apiRequest("PATCH", `/api/scenarios/${scenario.id}`, {
        baseProb: probs.base / 100,
        bullProb: probs.bull / 100,
        bearProb: probs.bear / 100,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Probabilities saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/scenarios/latest", quarter] });
      queryClient.invalidateQueries({ queryKey: ["/api/scenarios"] });
    },
    onError: (err) => {
      toast({
        title: "Save failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleProbChange = (kind: CaseKind, value: number) => {
    setProbs((p) => rebalanceProbs(p, kind, value));
  };

  // Header actions
  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Quarter</span>
        <Select value={quarter} onValueChange={setQuarter}>
          <SelectTrigger
            className="w-[120px] h-8 text-xs"
            data-testid="select-quarter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {quarterOptions.map((q) => (
              <SelectItem key={q} value={q} className="text-xs">
                {q}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-1 rounded-md border border-border p-0.5 bg-card">
        <button
          type="button"
          onClick={() => setModel("claude-sonnet-4")}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            model === "claude-sonnet-4"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="button-model-sonnet"
        >
          Sonnet 4.6
        </button>
        <button
          type="button"
          onClick={() => setModel("claude-haiku-4")}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            model === "claude-haiku-4"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="button-model-haiku"
        >
          Haiku 4.5
        </button>
      </div>

      <Button
        size="sm"
        onClick={() => generateMutation.mutate()}
        disabled={generateMutation.isPending}
        data-testid="button-regenerate"
      >
        {generateMutation.isPending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Generating…
          </>
        ) : (
          <>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            {scenario ? "Regenerate" : "Generate"}
          </>
        )}
      </Button>

      <ExportMenu
        resource="scenarios"
        query={`quarter=${encodeURIComponent(quarter)}`}
        filename={`scenarios-${quarter}`}
        disabled={!scenario}
      />
    </div>
  );

  const subtitle =
    "LLM-synthesised macro→equity scenarios with editable probabilities and hit-rate tracking. " +
    "Sonnet ≈ $0.04/run · Haiku ≈ $0.01/run.";

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scenarios — 1Q-forward base / bull / bear"
        subtitle={subtitle}
        actions={headerActions}
      />

      {/* Loading skeleton */}
      {latestQuery.isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-5 space-y-3">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-32 w-full" />
            </Card>
          ))}
        </div>
      )}

      {/* No scenario yet — show empty state */}
      {!latestQuery.isLoading && !scenario && isNoScenarioYet && (
        <Card className="p-8 text-center">
          <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-base font-semibold mb-1">
            No scenario yet for {quarter}
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            Click <span className="font-medium">Generate</span> to synthesise base /
            bull / bear cases from the latest macro snapshot using{" "}
            {model === "claude-sonnet-4" ? "Sonnet 4.6" : "Haiku 4.5"}.
          </p>
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            data-testid="button-generate-first"
          >
            {generateMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-1.5" />
                Generate scenario
              </>
            )}
          </Button>
        </Card>
      )}

      {/* Generic error */}
      {!latestQuery.isLoading && !scenario && !isNoScenarioYet && latestQuery.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load scenario</AlertTitle>
          <AlertDescription>{(latestQuery.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {/* The 3 scenario cards */}
      {scenario && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              Generated{" "}
              <span className="font-medium text-foreground/80">
                {formatDistanceToNow(new Date(scenario.generatedAt), {
                  addSuffix: true,
                })}
              </span>
            </span>
            <span aria-hidden>·</span>
            <span className="font-mono">{scenario.model}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{fmtCost(scenario.costUsd)}</span>
            {scenario.userEdited && (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[10px]"
              >
                <Pencil className="h-2.5 w-2.5 mr-1" />
                edited
              </Badge>
            )}
            <span className="ml-auto tabular-nums">
              Total: {probs.base + probs.bull + probs.bear}%
            </span>
            {probsDirty && (
              <Button
                size="sm"
                variant="default"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                data-testid="button-save-edits"
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save edits"
                )}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <ScenarioCard
              scenario={scenario}
              kind="base"
              probs={probs}
              onProbChange={handleProbChange}
            />
            <ScenarioCard
              scenario={scenario}
              kind="bull"
              probs={probs}
              onProbChange={handleProbChange}
            />
            <ScenarioCard
              scenario={scenario}
              kind="bear"
              probs={probs}
              onProbChange={handleProbChange}
            />
          </div>

          {/* Inputs accordion */}
          <Card className="p-0 overflow-hidden">
            <Accordion type="single" collapsible>
              <AccordionItem value="inputs" className="border-0">
                <AccordionTrigger className="px-5 py-3 hover:no-underline">
                  <div className="text-left">
                    <div className="text-sm font-semibold">
                      Inputs the LLM saw at generation time
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Read-only snapshot of macro drivers + equity universe used
                      to synthesise these scenarios.
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5">
                  <InputsAccordion inputs={scenario.inputsJson ?? null} />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Card>
        </>
      )}

      {/* Hit-rate history */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">Hit-rate history</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Past scenarios scored against realised quarterly moves. Brier score
              lower is better.
            </p>
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {historyQuery.data?.scenarios?.length ?? 0} scenarios
          </div>
        </div>
        {historyQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : !historyQuery.data?.scenarios?.length ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No past scenarios yet. Generate one above to begin tracking calibration.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="border-b">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-2 px-3 font-medium">Quarter</th>
                  <th className="py-2 px-3 font-medium">Probs (B/Bu/Be)</th>
                  <th className="py-2 px-3 font-medium">Actual</th>
                  <th className="py-2 px-3 font-medium">Brier</th>
                  <th className="py-2 px-3 font-medium">Model</th>
                  <th className="py-2 px-3 font-medium">Cost</th>
                  <th className="py-2 px-3 font-medium">Generated</th>
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.scenarios.map((s) => (
                  <HitRateRow key={s.id} scenario={s} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* AI commentary */}
      {scenario && (
        <AICommentaryPanel
          logicalId={`scenarios:${scenario.targetQuarter}`}
          contextIds={Object.keys(scenario.baseCase.drivers).slice(0, 5)}
        />
      )}
    </div>
  );
}
