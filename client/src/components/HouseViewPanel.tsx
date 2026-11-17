/**
 * House view panel — the standing master call that every strategy note reads.
 * Shows its age, lets you draft a refreshed version from the live evidence,
 * edit it, and approve it. A draft is never saved until you press Approve.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Loader2, Sparkles, Pencil, Check, X } from "lucide-react";

interface SectorStance { theme: string; stance: string; rationale: string }
interface HouseViewData {
  headline: string; stance: string; conviction: string; horizon: string;
  pillars: string[]; keyRisks: string[]; sectorStance: SectorStance[];
  changeLog?: { date: string; change: string; trigger: string }[];
  updatedAt?: string;
}
interface Proposal extends HouseViewData { changeSummary?: string }
interface Payload {
  houseView: HouseViewData | null;
  pending: { proposal: Proposal; createdAt: string; source: string } | null;
  proposing?: { running: boolean; startedAt: number; finishedAt?: number; error?: string };
}

const STANCES = ["bullish", "constructive", "neutral", "cautious", "bearish"];
const LEVELS = ["low", "medium", "high"];
const HORIZONS = ["1Q", "2Q", "1Y"];
const SECTOR_STANCES = ["overweight", "neutral", "underweight"];
const STALE_DAYS = 45;

function ageDays(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
}

const sel = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function HouseViewPanel() {
  const { toast } = useToast();
  const q = useQuery<Payload>({
    queryKey: ["/api/house-view"],
    queryFn: async () => (await apiRequest("GET", "/api/house-view")).json(),
    // Poll while a draft is being written in the background.
    refetchInterval: (query) => ((query.state.data as Payload | undefined)?.proposing?.running ? 4000 : false),
  });
  const drafting = !!q.data?.proposing?.running;
  const draftError = !drafting ? q.data?.proposing?.error : undefined;
  const current = q.data?.houseView ?? null;
  const pending = q.data?.pending ?? null;

  // Editing state: the form works on whichever draft is open.
  const [draft, setDraft] = useState<Proposal | null>(null);
  const [trigger, setTrigger] = useState("manual edit");
  const open = draft ?? pending?.proposal ?? null;
  const editing = open != null;
  const form = open;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/house-view"] });

  const propose = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/house-view/propose", {})).json(),
    onSuccess: () => { setDraft(null); setTrigger("approved proposal"); refresh(); },
    onError: (e: any) => toast({ title: "Could not draft a view", description: e.message, variant: "destructive" }),
  });
  const save = useMutation({
    mutationFn: async (f: Proposal) =>
      (await apiRequest("PUT", "/api/house-view", {
        headline: f.headline, stance: f.stance, conviction: f.conviction, horizon: f.horizon,
        pillars: f.pillars, keyRisks: f.keyRisks, sectorStance: f.sectorStance,
        changeLogEntry: { change: f.changeSummary || "Manual update", trigger },
      })).json(),
    onSuccess: () => { setDraft(null); refresh(); toast({ title: "House view saved" }); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const discard = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", "/api/house-view/pending")).json(),
    onSuccess: () => { setDraft(null); refresh(); },
  });

  const age = ageDays(current?.updatedAt);
  const stale = age != null && age > STALE_DAYS;
  const set = (patch: Partial<Proposal>) => setDraft({ ...(form as Proposal), ...patch });

  return (
    <Card className="mb-5 p-5" data-testid="house-view-panel">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">House view</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The standing call every strategy note reads. Drafts are never saved until you approve them.
          </p>
        </div>
        <div className="flex gap-2">
          {!editing && current && (
            <Button size="sm" variant="outline" className="gap-1.5"
              onClick={() => { setTrigger("manual edit"); setDraft({ ...current, changeSummary: "" }); }}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
          <Button size="sm" className="gap-1.5" onClick={() => propose.mutate()} disabled={propose.isPending || drafting}>
            {propose.isPending || drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Propose update
          </Button>
        </div>
      </div>

      {(propose.isPending || drafting) && (
        <div className="mb-3 text-xs text-muted-foreground">Drafting from the latest evidence. This takes a few minutes, and you can leave this page open.</div>
      )}
      {draftError && (
        <div className="mb-3 text-xs text-destructive">The last draft failed: {draftError}</div>
      )}

      {current && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="font-normal">{current.stance}</Badge>
          <Badge variant="outline" className="font-normal">{current.conviction} conviction</Badge>
          <Badge variant="outline" className="font-normal">{current.horizon}</Badge>
          <span className={stale ? "flex items-center gap-1 text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
            {stale && <AlertTriangle className="h-3.5 w-3.5" />}
            Updated {current.updatedAt?.slice(0, 10) ?? "unknown"}{age != null ? ` (${age} days ago)` : ""}
            {stale ? ". Stale: notes treat it as out of date." : ""}
          </span>
        </div>
      )}
      {!current && !editing && <p className="mb-3 text-sm text-muted-foreground">No house view saved yet. Propose one to start.</p>}

      {!editing && current && (
        <div className="space-y-2 text-sm">
          <div className="font-medium">{current.headline}</div>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">{current.pillars.map((p) => <li key={p}>{p}</li>)}</ul>
          <div className="text-xs text-muted-foreground">
            Sector stances: {current.sectorStance.map((s) => `${s.theme} ${s.stance}`).join(", ") || "none"}
          </div>
          {!!current.changeLog?.length && (
            <div className="text-xs text-muted-foreground">
              Last change: {current.changeLog[0].date} · {current.changeLog[0].change}
            </div>
          )}
        </div>
      )}

      {editing && form && (
        <div className="space-y-3 rounded-md border p-3" data-testid="house-view-form">
          {pending && !draft && (
            <div className="text-xs text-muted-foreground">
              Draft from {pending.source}, {pending.createdAt.slice(0, 10)}.
              {form.changeSummary ? ` What changed: ${form.changeSummary}` : ""}
            </div>
          )}
          {draft?.changeSummary && <div className="text-xs text-muted-foreground">What changed: {draft.changeSummary}</div>}
          <div>
            <label className="mb-1 block text-xs uppercase text-muted-foreground">Headline</label>
            <Input value={form.headline} onChange={(e) => set({ headline: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs uppercase text-muted-foreground">Stance</label>
              <select className={sel} value={form.stance} onChange={(e) => set({ stance: e.target.value })}>
                {STANCES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase text-muted-foreground">Conviction</label>
              <select className={sel} value={form.conviction} onChange={(e) => set({ conviction: e.target.value })}>
                {LEVELS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase text-muted-foreground">Horizon</label>
              <select className={sel} value={form.horizon} onChange={(e) => set({ horizon: e.target.value })}>
                {HORIZONS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs uppercase text-muted-foreground">Pillars (one per line)</label>
              <Textarea className="min-h-[90px]" value={form.pillars.join("\n")} onChange={(e) => set({ pillars: lines(e.target.value) })} />
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase text-muted-foreground">Key risks (one per line)</label>
              <Textarea className="min-h-[90px]" value={form.keyRisks.join("\n")} onChange={(e) => set({ keyRisks: lines(e.target.value) })} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase text-muted-foreground">Sector stances</label>
            <div className="space-y-1.5">
              {form.sectorStance.map((s, i) => (
                <div key={s.theme} className="grid grid-cols-[110px_130px_1fr] items-center gap-2">
                  <div className="text-xs font-medium">{s.theme}</div>
                  <select className={sel} value={s.stance}
                    onChange={(e) => set({ sectorStance: form.sectorStance.map((x, j) => (j === i ? { ...x, stance: e.target.value } : x)) })}>
                    {SECTOR_STANCES.map((x) => <option key={x}>{x}</option>)}
                  </select>
                  <Input value={s.rationale}
                    onChange={(e) => set({ sectorStance: form.sectorStance.map((x, j) => (j === i ? { ...x, rationale: e.target.value } : x)) })} />
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" variant="ghost" className="gap-1.5"
              onClick={() => { if (pending && !draft) discard.mutate(); else setDraft(null); }}>
              <X className="h-3.5 w-3.5" /> Discard
            </Button>
            <Button size="sm" className="gap-1.5" disabled={save.isPending || !form.headline.trim()} onClick={() => save.mutate(form)}>
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Approve and save
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
