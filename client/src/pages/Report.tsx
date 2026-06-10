/**
 * Strategy Report — Phase 3 report engine (the flagship deliverable).
 *
 * Two-mode composer:
 *   - Data-Driven: AI leads from the evidence; builds narrative + strategy +
 *     a model portfolio of stock picks.
 *   - Thesis-Driven: user supplies a thesis; AI substantiates with data + Sonar,
 *     but as a CRITIC — renders a thesis verdict (supported/.../insufficient) with
 *     contradicting evidence, gaps, corrections, alternatives.
 *
 * Long-form note rendered section-by-section, each editable + regenerable.
 * House-view panel with change-log + "propose update". Export is Phase 4.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { ReportVault } from "@/components/ReportVault";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  FileText, Database, Target, Loader2, RefreshCw, Sparkles, Check,
  AlertTriangle, ExternalLink, Pencil, Save, X, Compass,
} from "lucide-react";

type Mode = "data_driven" | "thesis_driven";
type ModelId = "claude-sonnet-4" | "claude-haiku-4" | "deepseek-chat" | "deepseek-reasoner";
const THEMES = ["tech", "ev", "battery", "semi", "ai", "consumer"] as const;

interface NoteSection { key: string; heading: string; body: string; }
interface PortfolioPick {
  symbol: string; nameEn: string; theme: string; stance: string;
  weight?: number; conviction: string; entryRationale: string; keyRisk: string;
}
interface ThesisVerdict {
  verdict: string; confidence: string;
  supportingEvidence: { point: string; source?: { name: string; url: string } }[];
  contradictingEvidence: { point: string; source?: { name: string; url: string } }[];
  evidenceGaps: string[]; corrections: string[]; alternatives: string[];
}
interface StrategyNote {
  id: number; title: string; asOfDate: string; mode: Mode; userThesis: string;
  sections: NoteSection[]; portfolio?: PortfolioPick[]; thesisVerdict?: ThesisVerdict;
  citations: { name: string; url: string }[]; model: string; costUsd: number; status: string;
}
interface UniverseName { symbol: string; nameEn: string; nameZh: string; }
interface UniverseTheme { id: string; label: string; names: UniverseName[]; }

const VERDICT_STYLE: Record<string, string> = {
  supported: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  partially_supported: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
  not_supported: "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30",
  insufficient_evidence: "bg-muted text-muted-foreground border-border",
};

function mdToHtml(md: string): string {
  // Lightweight markdown: bold, headings, bullets, paragraphs.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(md)
    .replace(/^###\s+(.*)$/gm, '<h4 class="font-semibold mt-3 mb-1">$1</h4>')
    .replace(/^##\s+(.*)$/gm, '<h3 class="font-semibold mt-3 mb-1">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^\s*[-•]\s+(.*)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .split(/\n{2,}/).map((p) => (p.includes("<li") || p.includes("<h") ? p : `<p class="mb-2">${p.replace(/\n/g, "<br/>")}</p>`)).join("");
}

function SectionBlock({ note, section }: { note: StrategyNote; section: NoteSection }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.body);

  const saveMutation = useMutation<any, Error, void>({
    mutationFn: async () => {
      const sections = note.sections.map((s) => (s.key === section.key ? { ...s, body: draft } : s));
      return (await apiRequest("PUT", `/api/report/${note.id}`, { sections })).json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: [`/api/report/${note.id}`] }); setEditing(false); toast({ title: "Section saved" }); },
    onError: (e) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const regenMutation = useMutation<any, Error, void>({
    mutationFn: async () => (await apiRequest("POST", `/api/report/${note.id}/section/${section.key}/regenerate`, {})).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: [`/api/report/${note.id}`] }); toast({ title: "Section regenerated" }); },
    onError: (e) => toast({ title: "Regenerate failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="border-t py-4 first:border-t-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{section.heading}</h3>
        <div className="flex gap-1">
          {editing ? (
            <>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => { setDraft(section.body); setEditing(false); }}>
                <X className="h-3 w-3" /> Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setEditing(true)}>
                <Pencil className="h-3 w-3" /> Edit
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => regenMutation.mutate()} disabled={regenMutation.isPending}>
                {regenMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Regenerate
              </Button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-[160px] font-mono text-xs" />
      ) : (
        <div className="prose-sm max-w-none text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: mdToHtml(section.body) }} />
      )}
    </div>
  );
}

function PortfolioTable({ picks }: { picks: PortfolioPick[] }) {
  const longs = picks.filter((p) => p.stance === "long");
  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Target className="h-4 w-4 text-primary" /> Model Portfolio
        <Badge variant="outline" className="text-[10px]">{longs.length} longs</Badge>
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase text-muted-foreground">
              <th className="py-1.5 pr-3">Name</th><th className="pr-3">Stance</th><th className="pr-3">Wt</th>
              <th className="pr-3">Conv</th><th className="pr-3">Rationale</th><th>Key risk</th>
            </tr>
          </thead>
          <tbody>
            {picks.map((p, i) => (
              <tr key={i} className="border-b align-top">
                <td className="py-2 pr-3 font-medium">{p.nameEn} <span className="text-[10px] text-muted-foreground">{p.symbol}</span></td>
                <td className="pr-3"><Badge variant="outline" className={`text-[10px] ${p.stance === "long" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : p.stance === "avoid" ? "bg-red-500/10 text-red-700 dark:text-red-300" : ""}`}>{p.stance}</Badge></td>
                <td className="pr-3">{p.weight != null ? `${p.weight}%` : "—"}</td>
                <td className="pr-3 capitalize">{p.conviction}</td>
                <td className="max-w-[260px] pr-3 text-xs text-muted-foreground">{p.entryRationale}</td>
                <td className="max-w-[180px] text-xs text-muted-foreground">{p.keyRisk}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function VerdictBlock({ v }: { v: ThesisVerdict }) {
  return (
    <Card className={`border p-4 ${VERDICT_STYLE[v.verdict] ?? ""}`}>
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" />
        <h3 className="text-base font-semibold capitalize">Thesis verdict: {v.verdict.replace(/_/g, " ")}</h3>
        <Badge variant="outline" className="text-[10px] capitalize">{v.confidence} confidence</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-[11px] font-semibold uppercase text-emerald-700 dark:text-emerald-300">Supporting</div>
          <ul className="mt-1 space-y-1 text-sm">
            {v.supportingEvidence.length ? v.supportingEvidence.map((e, i) => (
              <li key={i}>• {e.point} {e.source?.url && <a href={e.source.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:underline">[src]</a>}</li>
            )) : <li className="text-muted-foreground">—</li>}
          </ul>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase text-red-700 dark:text-red-300">Contradicting</div>
          <ul className="mt-1 space-y-1 text-sm">
            {v.contradictingEvidence.length ? v.contradictingEvidence.map((e, i) => (
              <li key={i}>• {e.point} {e.source?.url && <a href={e.source.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:underline">[src]</a>}</li>
            )) : <li className="text-muted-foreground">—</li>}
          </ul>
        </div>
      </div>
      {v.evidenceGaps.length > 0 && (
        <div className="mt-3"><div className="text-[11px] font-semibold uppercase text-muted-foreground">Evidence gaps</div>
          <ul className="mt-1 space-y-0.5 text-sm">{v.evidenceGaps.map((g, i) => <li key={i}>• {g}</li>)}</ul></div>
      )}
      {v.corrections.length > 0 && (
        <div className="mt-3"><div className="text-[11px] font-semibold uppercase text-amber-700 dark:text-amber-300">Where the thesis is wrong</div>
          <ul className="mt-1 space-y-0.5 text-sm">{v.corrections.map((c, i) => <li key={i}>• {c}</li>)}</ul></div>
      )}
      {v.alternatives.length > 0 && (
        <div className="mt-3"><div className="text-[11px] font-semibold uppercase text-blue-700 dark:text-blue-300">Better-supported alternatives</div>
          <ul className="mt-1 space-y-0.5 text-sm">{v.alternatives.map((a, i) => <li key={i}>• {a}</li>)}</ul></div>
      )}
    </Card>
  );
}

export default function Report() {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("data_driven");
  const [thesis, setThesis] = useState("");
  const [emphasis, setEmphasis] = useState<string[]>([]);
  const [featured, setFeatured] = useState<string[]>([]);
  const [model, setModel] = useState<ModelId>("claude-sonnet-4");
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);

  const universeQuery = useQuery<{ themes: UniverseTheme[] }, Error>({
    queryKey: ["/api/equity/universe"],
    queryFn: async () => (await apiRequest("GET", "/api/equity/universe")).json(),
  });
  const allNames = useMemo(() => {
    const seen = new Set<string>(); const out: UniverseName[] = [];
    for (const t of universeQuery.data?.themes ?? []) for (const n of t.names) if (!seen.has(n.symbol)) { seen.add(n.symbol); out.push(n); }
    return out;
  }, [universeQuery.data]);

  const noteQuery = useQuery<{ note: StrategyNote }, Error>({
    queryKey: [`/api/report/${activeNoteId}`],
    queryFn: async () => (await apiRequest("GET", `/api/report/${activeNoteId}`)).json(),
    enabled: activeNoteId != null,
  });
  const note = noteQuery.data?.note;

  const genMutation = useMutation<{ note: StrategyNote }, Error, void>({
    mutationFn: async () => {
      const body = { mode, userThesis: mode === "thesis_driven" ? thesis : undefined, emphasis, featuredNames: featured, model };
      return (await apiRequest("POST", "/api/report/generate", body)).json();
    },
    onSuccess: (data) => { setActiveNoteId(data.note.id); queryClient.invalidateQueries({ queryKey: ["/api/report"] }); toast({ title: "Report generated", description: `${data.note.sections.length} sections.` }); },
    onError: (e) => toast({ title: "Generation failed", description: e.message, variant: "destructive" }),
  });

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const canGenerate = mode === "data_driven" || thesis.trim().length > 10;

  return (
    <div data-testid="page-report">
      <PageHeader
        title="Strategy Report"
        subtitle="Generate an institutional strategy paper. Data-Driven: the AI builds a strategy + model portfolio from the evidence. Thesis-Driven: it stress-tests your thesis as a critic, backed by data + Sonar Pro."
      />

      {/* Composer */}
      <Card className="mb-5 p-5">
        <div className="mb-4 flex gap-2">
          <button onClick={() => setMode("data_driven")} data-testid="mode-data" className={`flex-1 rounded-md border p-3 text-left ${mode === "data_driven" ? "border-primary bg-primary/5" : ""}`}>
            <div className="flex items-center gap-2 font-medium"><Database className="h-4 w-4" /> Data-Driven</div>
            <div className="mt-1 text-xs text-muted-foreground">AI leads from the data — narrative, strategy, and a model portfolio of stock picks.</div>
          </button>
          <button onClick={() => setMode("thesis_driven")} data-testid="mode-thesis" className={`flex-1 rounded-md border p-3 text-left ${mode === "thesis_driven" ? "border-primary bg-primary/5" : ""}`}>
            <div className="flex items-center gap-2 font-medium"><Compass className="h-4 w-4" /> Thesis-Driven</div>
            <div className="mt-1 text-xs text-muted-foreground">Test your thesis. The AI backs it with evidence — or tells you plainly where you're wrong.</div>
          </button>
        </div>

        {mode === "thesis_driven" && (
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Your thesis</label>
            <Textarea value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="e.g. China's AI-chip localization will re-rate SMIC and Cambricon over the next two quarters as Big Fund III deploys and export controls tighten." className="min-h-[80px]" />
          </div>
        )}

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Emphasis themes</label>
          <div className="flex flex-wrap gap-1.5">
            {THEMES.map((t) => (
              <button key={t} onClick={() => toggle(emphasis, t, setEmphasis)}>
                <Badge variant={emphasis.includes(t) ? "default" : "outline"} className="cursor-pointer capitalize">{t}</Badge>
              </button>
            ))}
          </div>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Featured names (from universe)</label>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {allNames.map((n) => (
              <button key={n.symbol} onClick={() => toggle(featured, n.symbol, setFeatured)}>
                <Badge variant={featured.includes(n.symbol) ? "default" : "outline"} className="cursor-pointer text-[11px]">{n.nameEn}</Badge>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Synthesis model</label>
            <select value={model} onChange={(e) => setModel(e.target.value as ModelId)} className="rounded-md border bg-background px-2 py-1 text-sm">
              <option value="claude-sonnet-4">Claude Sonnet 4.6 (default)</option>
              <option value="claude-haiku-4">Claude Haiku 4.5 (cheaper)</option>
              <option value="deepseek-reasoner">DeepSeek Reasoner</option>
              <option value="deepseek-chat">DeepSeek Chat</option>
            </select>
          </div>
          <Button className="ml-auto gap-2 self-end" onClick={() => genMutation.mutate()} disabled={!canGenerate || genMutation.isPending} data-testid="button-generate-report">
            {genMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {genMutation.isPending ? "Generating (section-by-section)…" : "Generate report"}
          </Button>
        </div>
        {genMutation.isPending && (
          <div className="mt-2 text-xs text-muted-foreground">Assembling evidence (macro, policy, sectors, Sonar) and writing each section — this takes ~1-2 minutes.</div>
        )}
      </Card>

      {/* Generated note */}
      {noteQuery.isLoading && activeNoteId != null ? (
        <Skeleton className="h-64 w-full" />
      ) : note ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-bold">{note.title}</h2>
              <div className="text-xs text-muted-foreground">
                {note.mode === "data_driven" ? "Data-Driven" : "Thesis-Driven"} · as of {note.asOfDate} · {note.model}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <ExportMenu resource="report" path={`/api/report/${note.id}/export`} />
              <span className="text-[10px] text-muted-foreground">PowerPoint deck · PDF · Word</span>
            </div>
          </div>

          {note.mode === "thesis_driven" && note.thesisVerdict && <VerdictBlock v={note.thesisVerdict} />}
          {note.mode === "data_driven" && note.portfolio && note.portfolio.length > 0 && <PortfolioTable picks={note.portfolio} />}

          <Card className="p-5">
            {note.sections.map((s) => <SectionBlock key={s.key} note={note} section={s} />)}
          </Card>

          {note.citations.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold">Sources ({note.citations.length})</h3>
              <ul className="space-y-1 text-xs">
                {note.citations.map((c, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                    <a href={c.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:underline">{c.name}</a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : (
        <Card className="p-10 text-center">
          <FileText className="mx-auto h-9 w-9 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">No report open</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Generate a new report above, or open a past one from the vault below.
          </p>
        </Card>
      )}

      {/* Report Vault — browsable archive of all past works */}
      <div className="mt-6">
        <ReportVault activeId={activeNoteId} onOpen={(id) => { setActiveNoteId(id); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
      </div>
    </div>
  );
}
