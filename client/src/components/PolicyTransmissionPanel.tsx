/**
 * Policy Transmission panel (Gap D) — shared by the Policy Tracker (full) and the
 * Sectors page (compact). Renders policy → affected theme(s) → live evidence →
 * ranked named beneficiaries / at-risk chains from /api/equity/policy-transmission,
 * with an LLM-assigned strength badge and a read-through narrative.
 *
 * Deterministic skeleton always renders; strength + read-through appear when the
 * server LLM call succeeds. Mirrors FlowsPositioningPanel styling.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitBranch, Loader2, ExternalLink, ArrowRight, AlertTriangle } from "lucide-react";

type Strength = "strong" | "moderate" | "weak";

interface ThemeEvidence {
  theme: string;
  label: string;
  tradeSignal: string | null;
  valuationNote: string | null;
  earningsNote: string | null;
}
interface TransmissionName {
  symbol: string;
  nameEn: string;
  theme: string;
  quadrant: string | null;
  why: string;
}
interface Chain {
  policy: { id: number; title: string; date: string | null; source: string; body: string; url: string; significance: string };
  affectedThemes: string[];
  marketWide: boolean;
  evidence: ThemeEvidence[];
  beneficiaries: TransmissionName[];
  atRisk: TransmissionName[];
  transmissionStrength: Strength | null;
  readThrough: string | null;
  notes: string[];
}
interface PolicyTransmission {
  generatedAt: string;
  chains: Chain[];
  model: string;
  costUsd: number;
  notes: string[];
}

const STRENGTH_TONE: Record<string, string> = {
  strong: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  moderate: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  weak: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};
const QUADRANT_TONE: Record<string, string> = {
  "cheap-improving": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "expensive-deteriorating": "bg-red-500/10 text-red-700 dark:text-red-300",
};

function NameBadge({ n, kind }: { n: TransmissionName; kind: "benef" | "risk" }) {
  const tone = n.quadrant && QUADRANT_TONE[n.quadrant]
    ? QUADRANT_TONE[n.quadrant]
    : kind === "benef"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : "bg-red-500/10 text-red-700 dark:text-red-300";
  return (
    <Badge variant="outline" className={`text-[10px] ${tone}`} title={n.why}>
      {n.nameEn}{n.quadrant ? ` · ${n.quadrant}` : ""}
    </Badge>
  );
}

function ChainCard({ c, compact }: { c: Chain; compact: boolean }) {
  const evLines = c.evidence
    .map((e) => {
      const legs = [e.tradeSignal, e.valuationNote, e.earningsNote].filter(Boolean).join(" · ");
      return legs ? `${e.label}: ${legs}` : null;
    })
    .filter(Boolean) as string[];

  return (
    <div className="rounded-md border p-3" data-testid={`transmission-chain-${c.policy.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[9px]">{c.policy.source}</Badge>
            {c.transmissionStrength && (
              <Badge variant="outline" className={`text-[9px] ${STRENGTH_TONE[c.transmissionStrength] ?? ""}`}>
                {c.transmissionStrength}
              </Badge>
            )}
            {c.policy.date && <span className="text-[10px] text-muted-foreground">{c.policy.date}</span>}
          </div>
          <a
            href={c.policy.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 flex items-start gap-1 text-sm font-medium hover:underline"
          >
            <span className="min-w-0">{c.policy.title}</span>
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          </a>
        </div>
      </div>

      {/* Policy → themes → beneficiaries */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-medium text-muted-foreground">Themes</span>
        {c.affectedThemes.map((t) => (
          <Badge key={t} variant="secondary" className="text-[9px] capitalize">{t}</Badge>
        ))}
        {c.marketWide && <span className="text-[10px] italic text-muted-foreground">(market-wide)</span>}
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium text-emerald-700 dark:text-emerald-400">Beneficiaries</span>
        {c.beneficiaries.length
          ? c.beneficiaries.map((n) => <NameBadge key={`b-${n.symbol}-${n.theme}`} n={n} kind="benef" />)
          : <span className="text-[10px] text-muted-foreground">n/a</span>}
      </div>

      {c.atRisk.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-medium text-red-700 dark:text-red-400">At-risk</span>
          {c.atRisk.map((n) => <NameBadge key={`r-${n.symbol}-${n.theme}`} n={n} kind="risk" />)}
        </div>
      )}

      {c.readThrough && (
        <div className="mt-2 text-[12px] leading-snug text-foreground/90">{c.readThrough}</div>
      )}

      {!compact && evLines.length > 0 && (
        <div className="mt-2 rounded bg-muted/40 p-2 text-[10px] text-muted-foreground">
          {evLines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

export function PolicyTransmissionPanel({ compact = false }: { compact?: boolean }) {
  const q = useQuery<PolicyTransmission, Error>({
    queryKey: ["/api/equity/policy-transmission"],
    queryFn: async () => (await apiRequest("GET", "/api/equity/policy-transmission")).json(),
    staleTime: 6 * 60 * 60 * 1000,
  });
  const pt = q.data;
  const chains = pt?.chains ?? [];
  const shown = compact ? chains.slice(0, 3) : chains;

  return (
    <Card className="mb-4 p-4" data-testid="card-policy-transmission">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <GitBranch className="h-4 w-4 text-primary" /> Policy transmission
        <Badge variant="outline" className="text-[9px] bg-violet-500/10 text-violet-700 dark:text-violet-300">
          policy → sector → name
        </Badge>
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Mapping recent policy items to themes, evidence, and named beneficiaries…
        </div>
      ) : q.error ? (
        <div className="text-xs text-red-600 dark:text-red-400">Unavailable: {q.error.message}</div>
      ) : shown.length ? (
        <div className="space-y-3">
          {shown.map((c) => <ChainCard key={c.policy.id} c={c} compact={compact} />)}
          {compact && chains.length > shown.length && (
            <div className="text-[11px] text-muted-foreground">+{chains.length - shown.length} more on the Policy Tracker page.</div>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500" />
          {pt?.notes?.length ? pt.notes.join(" ") : "No policy items scanned yet — run the Policy Tracker."}
        </div>
      )}
    </Card>
  );
}
