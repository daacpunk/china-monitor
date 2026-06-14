/**
 * Policy Tracker — Phase 1.
 *
 * Tech-skewed + macro feed of policy/regulatory updates from official Chinese
 * channels (State Council, PBoC, CSRC, MOF, NDRC, MIIT, CAC, MOST, SAMR, MOFCOM,
 * NEA, NFRA). Each item carries provenance, significance, categories/themes, and
 * market-linkage (policy -> index/sector/name with expected direction).
 *
 * Scans run ON-DEMAND (no background scan) via Sonar Pro. Lens toggle:
 *   tech (default) | macro | all. Significance filter. Theme chips.
 *
 * All data comes from the live API. No mocked values.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { PolicyTransmissionPanel } from "@/components/PolicyTransmissionPanel";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import {
  Landmark,
  RefreshCw,
  Loader2,
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";

type Lens = "tech" | "macro" | "all";

interface MarketLinkage {
  scope: "index" | "sector" | "name";
  target: string;
  expectedDirection: "positive" | "negative" | "mixed" | "neutral";
  rationale: string;
  priced: "not_yet" | "partially" | "fully";
}

interface PolicyUpdate {
  id: number;
  fetchedAt: string;
  publishedAt: string | null;
  body: string;
  tier: number;
  title: string;
  titleZh: string | null;
  url: string;
  summary: string;
  categories: string[];
  themes: string[];
  significance: "high" | "medium" | "low";
  significanceRationale: string;
  marketLinkage: MarketLinkage[];
  sources: { name: string; url: string }[];
  provenance: string;
}

interface Channel {
  id: string;
  name: string;
  nameZh: string;
  tier: number;
  domain: string;
}

const THEME_LABELS: Record<string, string> = {
  tech: "Tech",
  ev: "EV",
  battery: "Battery",
  semi: "Semis",
  ai: "AI",
  consumer: "Consumer",
  macro: "Macro",
};

const SIG_STYLE: Record<string, string> = {
  high: "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20",
  medium: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
  low: "bg-muted text-muted-foreground",
};

function DirectionIcon({ dir }: { dir: MarketLinkage["expectedDirection"] }) {
  if (dir === "positive") return <ArrowUpRight className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
  if (dir === "negative") return <ArrowDownRight className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  if (dir === "mixed") return <TrendingUp className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

export default function Policy() {
  const { toast } = useToast();
  const [lens, setLens] = useState<Lens>("tech");
  const [sigFilter, setSigFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [themeFilter, setThemeFilter] = useState<string | null>(null);

  const channelsQuery = useQuery<{ channels: Channel[]; themes: string[]; techChannelIds: string[] }, Error>({
    queryKey: ["/api/policy/channels"],
    queryFn: async () => (await apiRequest("GET", "/api/policy/channels")).json(),
  });

  const feedQuery = useQuery<{ updates: PolicyUpdate[] }, Error>({
    queryKey: ["/api/policy/feed"],
    queryFn: async () => (await apiRequest("GET", "/api/policy/feed?limit=300")).json(),
  });

  const channelName = (id: string) =>
    channelsQuery.data?.channels.find((c) => c.id === id)?.name ?? id;

  const refreshMutation = useMutation<{ reports: any[] }, Error, Lens>({
    mutationFn: async (l) => {
      const res = await apiRequest("POST", "/api/policy/refresh", { lens: l, sinceDays: 30 });
      return res.json();
    },
    onSuccess: (data) => {
      const inserted = (data.reports || []).reduce((s, r) => s + (r.inserted || 0), 0);
      const errors = (data.reports || []).filter((r) => r.error);
      queryClient.invalidateQueries({ queryKey: ["/api/policy/feed"] });
      toast({
        title: `Scan complete — ${inserted} new ${inserted === 1 ? "item" : "items"}`,
        description: errors.length
          ? `${errors.length} channel(s) returned errors (check API keys / cost ceiling).`
          : "Feed updated from official channels via Sonar Pro.",
        variant: errors.length ? "destructive" : undefined,
      });
    },
    onError: (err) => {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    },
  });

  const techIds = channelsQuery.data?.techChannelIds ?? [];

  const filtered = useMemo(() => {
    let rows = feedQuery.data?.updates ?? [];
    if (lens === "tech") {
      rows = rows.filter(
        (r) => techIds.includes(r.body) || r.themes.some((t) => t !== "macro"),
      );
    } else if (lens === "macro") {
      rows = rows.filter((r) => r.tier <= 4 || r.themes.includes("macro"));
    }
    if (sigFilter !== "all") rows = rows.filter((r) => r.significance === sigFilter);
    if (themeFilter) rows = rows.filter((r) => r.themes.includes(themeFilter));
    return rows;
  }, [feedQuery.data, lens, sigFilter, themeFilter, techIds]);

  const isRefreshing = refreshMutation.isPending;

  return (
    <div data-testid="page-policy">
      <PageHeader
        title="Policy Tracker"
        subtitle="Tech-skewed + macro policy & regulatory updates from official Chinese channels, linked to equity-market impact. Sourced on-demand via Sonar Pro."
        actions={
          <div className="flex items-center gap-2">
            <ExportMenu resource="policy" formats={["csv"]} disabled={filtered.length === 0} />
            <Button
              onClick={() => refreshMutation.mutate(lens)}
              disabled={isRefreshing}
              data-testid="button-refresh-policy"
              className="gap-2"
            >
              {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {isRefreshing ? "Scanning…" : `Scan ${lens === "all" ? "all" : lens} channels`}
            </Button>
          </div>
        }
      />

      {/* Lens + filters */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border p-0.5">
          {(["tech", "macro", "all"] as Lens[]).map((l) => (
            <button
              key={l}
              onClick={() => setLens(l)}
              data-testid={`lens-${l}`}
              className={`px-3 py-1 text-sm rounded capitalize ${
                lens === l ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {l === "tech" ? "Tech lens" : l === "macro" ? "Macro lens" : "All"}
            </button>
          ))}
        </div>

        <div className="flex rounded-md border p-0.5">
          {(["all", "high", "medium", "low"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSigFilter(s)}
              className={`px-2.5 py-1 text-xs rounded capitalize ${
                sigFilter === s ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s === "all" ? "All signal" : s}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          {(channelsQuery.data?.themes ?? []).map((t) => (
            <button key={t} onClick={() => setThemeFilter(themeFilter === t ? null : t)}>
              <Badge
                variant={themeFilter === t ? "default" : "outline"}
                className="cursor-pointer"
              >
                {THEME_LABELS[t] ?? t}
              </Badge>
            </button>
          ))}
        </div>

        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "update" : "updates"}
        </div>
      </div>

      {/* Policy → sector → name transmission (Gap D) */}
      <PolicyTransmissionPanel />

      {/* Feed */}
      {feedQuery.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : feedQuery.error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn't load the policy feed</AlertTitle>
          <AlertDescription>{feedQuery.error.message}</AlertDescription>
        </Alert>
      ) : filtered.length === 0 ? (
        <Card className="p-10 text-center">
          <Landmark className="mx-auto h-9 w-9 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">No policy updates yet</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Run a scan to pull the latest policy & regulatory announcements from official
            Chinese channels. The {lens === "tech" ? "tech" : lens} lens covers{" "}
            {lens === "tech"
              ? "MIIT, CAC, MOST, SAMR, MOFCOM, NEA and sector-relevant items"
              : lens === "macro"
              ? "State Council, PBoC, CSRC, MOF, NDRC and apex macro policy"
              : "all official channels"}
            .
          </p>
          <Button
            className="mt-4 gap-2"
            onClick={() => refreshMutation.mutate(lens)}
            disabled={isRefreshing}
          >
            {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Scan now
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((p) => (
            <Card key={p.id} className="p-4" data-testid={`policy-card-${p.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[11px]">
                      {channelName(p.body)}
                    </Badge>
                    <Badge className={`text-[11px] border ${SIG_STYLE[p.significance]}`} variant="outline">
                      {p.significance} signal
                    </Badge>
                    <Badge variant="outline" className="text-[11px] bg-violet-500/10 text-violet-700 dark:text-violet-300">
                      Sonar Pro
                    </Badge>
                    {p.publishedAt && (
                      <span className="text-[11px] text-muted-foreground">{p.publishedAt}</span>
                    )}
                  </div>
                  <h3 className="mt-2 font-semibold leading-snug">{p.title}</h3>
                  {p.titleZh && p.titleZh !== p.title && (
                    <div className="text-xs text-muted-foreground">{p.titleZh}</div>
                  )}
                </div>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  title="Open official source"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>

              {p.summary && <p className="mt-2 text-sm text-muted-foreground">{p.summary}</p>}

              <div className="mt-2 flex flex-wrap gap-1">
                {p.themes.map((t) => (
                  <Badge key={t} variant="secondary" className="text-[10px]">
                    {THEME_LABELS[t] ?? t}
                  </Badge>
                ))}
                {p.categories.slice(0, 4).map((c) => (
                  <Badge key={c} variant="outline" className="text-[10px]">
                    {c}
                  </Badge>
                ))}
              </div>

              {/* Market linkage */}
              {p.marketLinkage && p.marketLinkage.length > 0 && (
                <div className="mt-3 rounded-md border bg-muted/30 p-2.5">
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Equity-market linkage
                  </div>
                  <div className="space-y-1.5">
                    {p.marketLinkage.map((l, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <DirectionIcon dir={l.expectedDirection} />
                        <div className="min-w-0">
                          <span className="font-medium">{l.target}</span>
                          <span className="text-muted-foreground"> — {l.rationale}</span>
                          {l.priced === "not_yet" && (
                            <Badge variant="outline" className="ml-1.5 text-[9px] bg-blue-500/10 text-blue-700 dark:text-blue-300">
                              not yet priced
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {p.significanceRationale && (
                <div className="mt-2 text-xs italic text-muted-foreground">
                  Why it matters: {p.significanceRationale}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
