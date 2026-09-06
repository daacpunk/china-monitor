/**
 * Brief — deep-dive market writeup synthesised from platform data.
 *
 * Phase 3b Session 4.
 *
 *  - Exec summary hero card + 6 section cards (what happened / regime shifts /
 *    cross-asset / priced vs not / forward watch / trade implications).
 *  - Header controls: model toggle (Sonnet 4.6 default | Haiku 4.5),
 *    Generate button (soft cap 10/24h), ExportMenu.
 *  - User-notes textarea below sections, debounced PATCH /api/brief/:id.
 *  - History table — click a row to load that brief.
 *  - AICommentaryPanel footer with logicalId="brief:<asOfDate>".
 *
 * Voice spec (in backend SYSTEM_PROMPT): sell-side institutional research
 * blended with PM journal — neutral, balanced, first-person reflection.
 * No hedge-fund swagger.
 *
 * All numbers come from the live API. No mocked / training-data values.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { AICommentaryPanel } from "@/components/AICommentaryPanel";
import { LensPanel } from "@/components/LensPanel";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Newspaper,
  RefreshCw,
  AlertCircle,
  Activity,
  Globe,
  Compass,
  Eye,
  Telescope,
  Target,
  StickyNote,
  Check,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useLlmCatalog, CHEAP_MODEL } from "@/hooks/useLlmCatalog";

// ─── Wire types (mirror server/analysis/brief.ts) ────────────────────────────

interface DriverBriefSnapshot {
  id: string;
  label: string;
  unit: string;
  latestDate: string | null;
  latestValue: number | null;
  mom: number | null;
  yoy: number | null;
  zScore: number | null;
  severity: "normal" | "watch" | "anomaly" | null;
  trendClass: string;
  multiscaleConfirmed: boolean;
  trendStart: string | null;
}

interface CrossAssetSnapshot {
  id: string;
  label: string;
  unit: string;
  latestDate: string | null;
  latestValue: number | null;
  change5d: number | null;
  change1m: number | null;
  ytd: number | null;
}

interface EquityBriefSnapshot {
  id: string;
  label: string;
  latestDate: string | null;
  latestLevel: number | null;
  mom: number | null;
  ytd: number | null;
}

interface AttributionLite {
  driver: string;
  driverLabel: string;
  equity: string;
  equityLabel: string;
  expectedSign: 1 | -1;
  beta: number | null;
  rollingShortBeta: number | null;
  rollingLongBeta: number | null;
  bestLag: number | null;
  bestCorrAtLag: number | null;
  driverZ: number | null;
  equityZ: number | null;
  notPriced: boolean;
  notPricedReason: string | null;
}

interface BriefInputs {
  asOf: string;
  asOfDate: string;
  drivers: DriverBriefSnapshot[];
  crossAsset: CrossAssetSnapshot[];
  equities: EquityBriefSnapshot[];
  attribution: AttributionLite[];
  upcomingReleases: Array<{
    date: string;
    agency: string;
    indicator: string;
    frequency: string;
  }>;
  breadth: { up: number; down: number; flat: number; total: number; tilt: string };
}

interface BriefSections {
  what_happened: string;
  regime_shifts: string;
  cross_asset: string;
  priced_vs_not: string;
  forward_watch: string;
  trade_implications: string;
}

interface BriefRow {
  id: number;
  generatedAt: string;
  asOfDate: string;
  execSummary: string;
  sections: BriefSections;
  inputsJson: BriefInputs;
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  userNotes: string;
}

interface BriefSlim {
  id: number;
  generatedAt: string;
  asOfDate: string;
  execSummary: string;
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  userNotes: string;
}

interface GenerateResponse {
  brief: BriefRow;
  costUsd: number;
  cacheHit: boolean;
  tokensIn: number;
  tokensOut: number;
}

// ─── Section meta ────────────────────────────────────────────────────────────

type SectionKey = keyof BriefSections;

interface SectionMeta {
  key: SectionKey;
  label: string;
  icon: typeof Activity;
  tint: string;
  border: string;
}

const SECTION_META: SectionMeta[] = [
  {
    key: "what_happened",
    label: "What happened",
    icon: Activity,
    tint: "bg-muted/30",
    border: "border-border",
  },
  {
    key: "regime_shifts",
    label: "Regime shifts",
    icon: Compass,
    tint: "bg-primary/5",
    border: "border-primary/20",
  },
  {
    key: "cross_asset",
    label: "Cross-asset backdrop",
    icon: Globe,
    tint: "bg-muted/30",
    border: "border-border",
  },
  {
    key: "priced_vs_not",
    label: "Priced vs not priced",
    icon: Eye,
    tint: "bg-amber-500/5 dark:bg-amber-500/10",
    border: "border-amber-500/20",
  },
  {
    key: "forward_watch",
    label: "Forward watch",
    icon: Telescope,
    tint: "bg-muted/30",
    border: "border-border",
  },
  {
    key: "trade_implications",
    label: "Trade implications",
    icon: Target,
    tint: "bg-emerald-500/5 dark:bg-emerald-500/10",
    border: "border-emerald-500/20",
  },
];

// ─── Formatters ──────────────────────────────────────────────────────────────

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

function modelLabel(m: string): string {
  // Fallbacks only — the live labels come from the model catalog (useLlmCatalog).
  if (m === "claude-sonnet-5") return "Sonnet 5";
  if (m === "claude-sonnet-4") return "Sonnet 4.6";
  if (m === "claude-haiku-4") return "Haiku 4.5";
  return m;
}

// Render prose with paragraph breaks at double-newlines.
function Prose({ text }: { text: string }) {
  const paras = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length === 0) {
    return <p className="text-sm text-muted-foreground italic">No content.</p>;
  }
  return (
    <div className="space-y-3">
      {paras.map((p, i) => (
        <p
          key={i}
          className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap"
        >
          {p}
        </p>
      ))}
    </div>
  );
}

// ─── Inputs hover preview (subtle, hidden by default) ────────────────────────

function BreadthChip({ inputs }: { inputs: BriefInputs }) {
  const b = inputs.breadth;
  return (
    <div
      className="inline-flex items-center gap-2 text-[11px] text-muted-foreground"
      data-testid="chip-breadth"
    >
      <span>
        Breadth <span className="text-emerald-600 dark:text-emerald-400 font-medium">↑{b.up}</span>
        {" / "}
        <span className="text-red-600 dark:text-red-400 font-medium">↓{b.down}</span>
        {" / "}
        <span className="font-medium">·{b.flat}</span>
      </span>
      <span aria-hidden>·</span>
      <span className="italic">{b.tilt}</span>
    </div>
  );
}

// ─── User notes textarea ─────────────────────────────────────────────────────

function UserNotes({
  brief,
}: {
  brief: BriefRow;
}) {
  const [draft, setDraft] = useState<string>(brief.userNotes ?? "");
  const [saved, setSaved] = useState<boolean>(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();

  // Reset draft when switching briefs.
  useEffect(() => {
    setDraft(brief.userNotes ?? "");
    setSaved(true);
  }, [brief.id, brief.userNotes]);

  const saveMutation = useMutation<{ brief: BriefRow }, Error, string>({
    mutationFn: async (notes: string) => {
      const res = await apiRequest("PATCH", `/api/brief/${brief.id}`, {
        userNotes: notes,
      });
      return res.json();
    },
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["/api/brief/latest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brief"] });
    },
    onError: (err) => {
      toast({
        title: "Save failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function handleChange(v: string) {
    setDraft(v);
    setSaved(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      saveMutation.mutate(v);
    }, 800);
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">PM journal — my own notes</h3>
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums" data-testid="text-notes-status">
          {saveMutation.isPending
            ? "Saving…"
            : saved
              ? (
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3 w-3" /> Saved
                </span>
              )
              : "Unsaved"}
        </div>
      </div>
      <Textarea
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="What's your read? What would change your mind? What are you watching for next week?"
        className="min-h-[120px] text-sm font-mono"
        data-testid="textarea-user-notes"
      />
    </Card>
  );
}

// ─── Section card ────────────────────────────────────────────────────────────

function SectionCard({
  meta,
  body,
}: {
  meta: SectionMeta;
  body: string;
}) {
  const Icon = meta.icon;
  return (
    <Card
      className={`p-5 ${meta.tint} ${meta.border} border-2 flex flex-col gap-3`}
      data-testid={`card-section-${meta.key}`}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold tracking-tight">{meta.label}</h3>
      </div>
      <Prose text={body} />
    </Card>
  );
}

// ─── History row (click loads that brief) ────────────────────────────────────

function HistoryRow({
  brief,
  active,
  onSelect,
}: {
  brief: BriefSlim;
  active: boolean;
  onSelect: (id: number) => void;
}) {
  return (
    <tr
      className={`border-b last:border-0 cursor-pointer hover:bg-muted/40 transition-colors ${
        active ? "bg-primary/10" : ""
      }`}
      onClick={() => onSelect(brief.id)}
      data-testid={`row-brief-${brief.id}`}
    >
      <td className="py-2 px-3 font-medium tabular-nums">{brief.asOfDate}</td>
      <td className="py-2 px-3 text-xs text-muted-foreground">
        {formatDistanceToNow(new Date(brief.generatedAt), { addSuffix: true })}
      </td>
      <td className="py-2 px-3 text-xs">
        <span className="font-mono text-muted-foreground">{modelLabel(brief.model)}</span>
      </td>
      <td className="py-2 px-3 text-xs tabular-nums">{fmtCost(brief.costUsd)}</td>
      <td className="py-2 px-3 text-xs tabular-nums text-muted-foreground">
        {brief.tokensIn}/{brief.tokensOut}
      </td>
      <td className="py-2 px-3 text-xs text-muted-foreground max-w-md">
        <div className="line-clamp-1">{brief.execSummary}</div>
      </td>
    </tr>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

// Catalog-driven: the "best" slot is the shared report default (Sonnet 5 today),
// the cheap slot stays Haiku.
type Model = string;

export default function Brief() {
  const { toast } = useToast();
  const llmCatalog = useLlmCatalog();
  const bestModel = llmCatalog.defaultModel;
  const [model, setModel] = useState<Model>("");
  const [modelTouched, setModelTouched] = useState(false);
  useEffect(() => {
    if (!modelTouched && bestModel && model !== bestModel && model !== CHEAP_MODEL) setModel(bestModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bestModel, modelTouched]);
  const label = (id: string) => llmCatalog.labelFor(id) || modelLabel(id);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Latest brief — used when no explicit selection.
  const latestQuery = useQuery<{ brief: BriefRow }, Error>({
    queryKey: ["/api/brief/latest"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/brief/latest");
      if (res.status === 404) return { brief: null as any };
      return res.json();
    },
    retry: 0,
  });

  // Explicit selection — only fires when selectedId is set.
  const selectedQuery = useQuery<{ brief: BriefRow }, Error>({
    queryKey: ["/api/brief", selectedId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/brief/${selectedId}`);
      return res.json();
    },
    enabled: selectedId != null,
    retry: 0,
  });

  // History list.
  const historyQuery = useQuery<{ briefs: BriefSlim[] }, Error>({
    queryKey: ["/api/brief"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/brief?limit=20");
      return res.json();
    },
    retry: 0,
  });

  const brief: BriefRow | null = useMemo(() => {
    if (selectedId != null) return selectedQuery.data?.brief ?? null;
    return latestQuery.data?.brief ?? null;
  }, [selectedId, selectedQuery.data, latestQuery.data]);

  const isNoBriefYet =
    !brief &&
    !latestQuery.isLoading &&
    (latestQuery.error == null ||
      /no briefs/i.test((latestQuery.error as Error)?.message ?? ""));

  // Generate brief mutation.
  const generateMutation = useMutation<GenerateResponse, Error>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/brief/generate", { model: model || undefined });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onMutate: () => {
      toast({
        title: "Generating market brief…",
        description: `${modelLabel(model)} · ~30-45s`,
      });
    },
    onSuccess: (data) => {
      toast({
        title: data.cacheHit ? "Cached brief served" : "Brief generated",
        description: `${fmtCost(data.costUsd)} · ${data.tokensIn}/${data.tokensOut} tokens`,
      });
      setSelectedId(null); // jump back to latest
      queryClient.invalidateQueries({ queryKey: ["/api/brief/latest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brief"] });
    },
    onError: (err) => {
      toast({
        title: "Generation failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // ─── Header actions ────────────────────────────────────────────────────────
  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-md border border-border p-0.5 bg-card">
        <button
          type="button"
          onClick={() => { setModelTouched(true); setModel(bestModel); }}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            model === bestModel
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="button-model-sonnet"
        >
          {label(bestModel)}
        </button>
        <button
          type="button"
          onClick={() => { setModelTouched(true); setModel(CHEAP_MODEL); }}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            model === CHEAP_MODEL
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="button-model-haiku"
        >
          {label(CHEAP_MODEL)}
        </button>
      </div>

      <Button
        size="sm"
        onClick={() => generateMutation.mutate()}
        disabled={generateMutation.isPending}
        data-testid="button-generate"
      >
        {generateMutation.isPending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Generating…
          </>
        ) : (
          <>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            {brief ? "Generate new" : "Generate"}
          </>
        )}
      </Button>

      <ExportMenu
        resource="brief"
        query={brief ? `id=${brief.id}` : undefined}
        disabled={!brief}
      />
    </div>
  );

  const subtitle =
    "LLM-synthesised deep-dive market writeup — China-first with cross-asset color. " +
    "Sonnet ≈ $0.05/run · Haiku ≈ $0.015/run. Soft cap 10 / 24h.";

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Market Brief — China deep-dive"
        subtitle={subtitle}
        actions={headerActions}
      />

      {/* Initial loading skeleton */}
      {latestQuery.isLoading && (
        <div className="space-y-4">
          <Card className="p-6 space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-4/6" />
          </Card>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Card key={i} className="p-5 space-y-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!latestQuery.isLoading && !brief && isNoBriefYet && (
        <Card className="p-10 text-center">
          <Newspaper className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-base font-semibold mb-1">No brief yet</h3>
          <p className="text-sm text-muted-foreground mb-5 max-w-md mx-auto">
            Generate your first deep-dive market writeup. The brief synthesises
            China macro drivers, cross-asset signals, and attribution into a
            7-section institutional research note with a PM-journal voice.
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
                <Newspaper className="h-4 w-4 mr-1.5" />
                Generate first brief
              </>
            )}
          </Button>
          <div className="text-[11px] text-muted-foreground mt-4">
            Using {label(model)} · ~30-45s · costs ~
            {model === CHEAP_MODEL ? "$0.015" : "$0.05"}
          </div>
        </Card>
      )}

      {/* Non-empty error */}
      {!latestQuery.isLoading && !brief && !isNoBriefYet && latestQuery.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load brief</AlertTitle>
          <AlertDescription>{(latestQuery.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {/* Loaded brief */}
      {brief && (
        <>
          {/* Meta strip */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="text-asof">
              As of{" "}
              <span className="font-medium text-foreground/80 tabular-nums">
                {brief.asOfDate}
              </span>
            </span>
            <span aria-hidden>·</span>
            <span>
              Generated{" "}
              <span className="font-medium text-foreground/80">
                {formatDistanceToNow(new Date(brief.generatedAt), { addSuffix: true })}
              </span>
            </span>
            <span aria-hidden>·</span>
            <span className="font-mono">{brief.model}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{fmtCost(brief.costUsd)}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {brief.tokensIn}/{brief.tokensOut} tok
            </span>
            <Badge
              variant="outline"
              className="bg-muted/40 text-[10px]"
              data-testid="badge-brief-id"
            >
              #{brief.id}
            </Badge>
            {selectedId != null && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedId(null)}
                className="h-6 text-[11px]"
                data-testid="button-jump-latest"
              >
                ← jump to latest
              </Button>
            )}
            <span className="ml-auto">
              <BreadthChip inputs={brief.inputsJson} />
            </span>
          </div>

          {/* Exec summary hero card */}
          <Card className="p-6 bg-primary/5 border-primary/30 border-2" data-testid="card-exec-summary">
            <div className="flex items-center gap-2 mb-3">
              <Badge
                variant="outline"
                className="bg-primary/15 text-primary border-primary/40 text-[10px] uppercase tracking-wider font-semibold"
              >
                Executive summary
              </Badge>
            </div>
            <p className="text-base leading-relaxed text-foreground/95 whitespace-pre-wrap">
              {brief.execSummary}
            </p>
          </Card>

          {/* 6 section cards — 2-col on desktop, 1-col on mobile */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {SECTION_META.map((meta) => (
              <SectionCard
                key={meta.key}
                meta={meta}
                body={brief.sections?.[meta.key] ?? ""}
              />
            ))}
          </div>

          {/* User notes */}
          <UserNotes brief={brief} />

          {/* Investor lenses & devil's-advocate red-team (Phase 1) */}
          <LensPanel
            context={[
              brief.execSummary,
              ...SECTION_META.map((m) => `${m.label}: ${brief.sections?.[m.key] ?? ""}`),
            ].join("\n\n")}
            focusHint={`China/HK equity strategy, as of ${brief.asOfDate}`}
          />
        </>
      )}

      {/* History */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">Brief history</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Click a row to load that brief. Latest 20 shown. Soft cap is 10 generates per 24h.
            </p>
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {historyQuery.data?.briefs?.length ?? 0} brief
            {(historyQuery.data?.briefs?.length ?? 0) === 1 ? "" : "s"}
          </div>
        </div>
        {historyQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : !historyQuery.data?.briefs?.length ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No past briefs yet. Generate one above to begin building a journal.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="border-b">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-2 px-3 font-medium">As of</th>
                  <th className="py-2 px-3 font-medium">Generated</th>
                  <th className="py-2 px-3 font-medium">Model</th>
                  <th className="py-2 px-3 font-medium">Cost</th>
                  <th className="py-2 px-3 font-medium">Tokens (in/out)</th>
                  <th className="py-2 px-3 font-medium">Exec summary</th>
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.briefs.map((b) => (
                  <HistoryRow
                    key={b.id}
                    brief={b}
                    active={brief?.id === b.id}
                    onSelect={setSelectedId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* AI commentary footer */}
      {brief && (
        <AICommentaryPanel
          logicalId={`brief:${brief.asOfDate}`}
          contextIds={(brief.inputsJson?.drivers ?? []).slice(0, 5).map((d) => d.id)}
        />
      )}
    </div>
  );
}

// Silence unused-var warnings for snapshot types we re-export indirectly.
// These types are part of the BriefInputs surface and used by future export logic.
export type {
  DriverBriefSnapshot,
  CrossAssetSnapshot,
  EquityBriefSnapshot,
  AttributionLite,
  BriefSections,
  BriefRow,
};

// Reference fmtPct / fmtNum to avoid TS unused-warning if a future patch
// adds inline numeric badges; cheap no-op at runtime.
void fmtPct;
void fmtNum;
