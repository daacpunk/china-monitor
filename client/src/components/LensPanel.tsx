/**
 * LensPanel — investor-brain lenses + devil's-advocate red-team for a brief.
 *
 * Phase 1. Two modes:
 *   - Selectable lens: re-reason the brief through one strategist's framework.
 *   - Red-team panel: bear-leaning personas attack the brief's base case
 *     (default panel: Marks, Pettis, Collier, Druckenmiller — configurable).
 *
 * Takes the current brief text as `context`. Calls /api/personas/lens and
 * /api/personas/redteam. Output carries a Claude-synthesis provenance chip.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Glasses, Swords, Sparkles } from "lucide-react";

interface Persona {
  id: string;
  name: string;
  firm: string;
  category: string;
  china: boolean;
}

export function LensPanel({ context, focusHint }: { context: string; focusHint?: string }) {
  const [selectedLens, setSelectedLens] = useState<string>("");
  const [lensText, setLensText] = useState<string>("");
  const [redTeamText, setRedTeamText] = useState<string>("");
  const [panel, setPanel] = useState<string[]>([]);

  const personasQuery = useQuery<{ personas: Persona[]; defaultRedTeam: string[] }, Error>({
    queryKey: ["/api/personas"],
    queryFn: async () => {
      const data = await (await apiRequest("GET", "/api/personas")).json();
      if (panel.length === 0 && data.defaultRedTeam) setPanel(data.defaultRedTeam);
      return data;
    },
  });

  const personas = personasQuery.data?.personas ?? [];
  const chinaPersonas = personas.filter((p) => p.china);
  const globalPersonas = personas.filter((p) => !p.china);

  const lensMutation = useMutation<{ text: string }, Error, string>({
    mutationFn: async (personaId) => {
      const res = await apiRequest("POST", "/api/personas/lens", { personaId, context, focusHint });
      return res.json();
    },
    onSuccess: (data) => setLensText(data.text),
  });

  const redTeamMutation = useMutation<{ text: string }, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/personas/redteam", {
        baseThesis: context,
        panel,
        focusHint,
      });
      return res.json();
    },
    onSuccess: (data) => setRedTeamText(data.text),
  });

  const runLens = (id: string) => {
    setSelectedLens(id);
    setLensText("");
    lensMutation.mutate(id);
  };

  return (
    <Card className="p-5" data-testid="lens-panel">
      <div className="mb-3 flex items-center gap-2">
        <Glasses className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Investor lenses & red-team</h3>
        <Badge variant="outline" className="text-[10px] bg-orange-500/10 text-orange-700 dark:text-orange-300">
          <Sparkles className="mr-1 h-3 w-3" />
          Claude synthesis
        </Badge>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Re-reason this brief through a strategist's framework, or run the devil's-advocate
        panel to stress-test the base case. Methodology-modeled — applies each thinker's lens,
        not invented quotes.
      </p>

      {/* Lens selector */}
      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Apply a lens
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chinaPersonas.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={selectedLens === p.id ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => runLens(p.id)}
              disabled={lensMutation.isPending}
              title={`${p.firm} — China specialist`}
            >
              {p.name}
            </Button>
          ))}
        </div>
        <details className="group">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
            + Global strategists ({globalPersonas.length})
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {globalPersonas.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={selectedLens === p.id ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => runLens(p.id)}
                disabled={lensMutation.isPending}
                title={p.firm}
              >
                {p.name}
              </Button>
            ))}
          </div>
        </details>
      </div>

      {lensMutation.isPending && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Applying lens…
        </div>
      )}
      {lensMutation.error && (
        <div className="mt-3 text-sm text-red-600 dark:text-red-400">{lensMutation.error.message}</div>
      )}
      {lensText && (
        <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm leading-relaxed whitespace-pre-wrap">
          {lensText}
        </div>
      )}

      {/* Red-team */}
      <div className="mt-5 border-t pt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Swords className="h-4 w-4 text-red-600 dark:text-red-400" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Devil's-advocate panel
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={() => redTeamMutation.mutate()}
            disabled={redTeamMutation.isPending}
          >
            {redTeamMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Swords className="h-3.5 w-3.5" />
            )}
            Run red-team
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {personas.map((p) => {
            const on = panel.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={() => setPanel(on ? panel.filter((x) => x !== p.id) : [...panel, p.id])}
              >
                <Badge variant={on ? "default" : "outline"} className="cursor-pointer text-[10px]">
                  {p.name}
                </Badge>
              </button>
            );
          })}
        </div>
        {redTeamMutation.error && (
          <div className="mt-3 text-sm text-red-600 dark:text-red-400">{redTeamMutation.error.message}</div>
        )}
        {redTeamText && (
          <div className="mt-3 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm leading-relaxed whitespace-pre-wrap">
            {redTeamText}
          </div>
        )}
      </div>
    </Card>
  );
}
