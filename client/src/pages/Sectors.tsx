/**
 * Sector Allocation — Phase 2 bottom-up equity layer.
 *
 * Top-down theme cards (index proxies + structural/policy drivers) -> drill into
 * constituent single names -> per-name valuation snapshot (P/E, P/B, mkt cap, via
 * AKShare) + Sonar catalyst pull. The top-down -> bottom-up bridge that feeds the
 * eventual strategy paper / deck.
 *
 * Coverage: tech, EV, battery, semis, AI, consumer (A-share + HK). All data live;
 * valuation is A-share only (AKShare spot); HK names show name/thesis + catalysts.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Cpu, Car, BatteryCharging, Microchip, Bot, ShoppingBag,
  ChevronDown, ChevronRight, ExternalLink, Loader2, TrendingUp,
  TrendingDown, Minus, Newspaper,
} from "lucide-react";

type ThemeId = "tech" | "ev" | "battery" | "semi" | "ai" | "consumer";

interface SectorName {
  symbol: string;
  market: "ashare" | "hk";
  nameEn: string;
  nameZh: string;
  role: string;
  thesis: string;
}
interface SectorTheme {
  id: ThemeId;
  label: string;
  indexProxies: string[];
  drivers: string[];
  names: SectorName[];
}
interface Valuation {
  name?: string | null;
  industry?: string | null;
  market_cap?: number | null;
  pe_ttm?: number | null;
  pb?: number | null;
  price?: number | null;
}
interface Catalyst {
  date: string;
  headline: string;
  detail: string;
  url: string;
  impact: "positive" | "negative" | "neutral";
}

const THEME_ICON: Record<ThemeId, any> = {
  tech: Cpu, ev: Car, battery: BatteryCharging, semi: Microchip, ai: Bot, consumer: ShoppingBag,
};

const ROLE_STYLE: Record<string, string> = {
  leader: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  challenger: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  supplier: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  platform: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
};

function fmtCap(v?: number | null): string {
  if (v == null) return "—";
  // AKShare 总市值 is in CNY. Convert to 亿 (100M) for readability.
  const yi = v / 1e8;
  if (yi >= 10000) return `¥${(yi / 10000).toFixed(2)}万亿`;
  return `¥${yi.toFixed(0)}亿`;
}
function fmtNum(v?: number | null, d = 1): string {
  return v == null || typeof v !== "number" ? "—" : v.toFixed(d);
}

function ImpactIcon({ impact }: { impact: Catalyst["impact"] }) {
  if (impact === "positive") return <TrendingUp className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
  if (impact === "negative") return <TrendingDown className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

function NameRow({ name, themeId }: { name: SectorName; themeId: ThemeId }) {
  const [open, setOpen] = useState(false);

  const valuationQuery = useQuery<{ data: Valuation[]; error?: string }, Error>({
    queryKey: [`/api/equity/valuation/${name.symbol}`],
    queryFn: async () => (await apiRequest("GET", `/api/equity/valuation/${name.symbol}`)).json(),
    enabled: open && name.market === "ashare",
  });
  const val = valuationQuery.data?.data?.[0];

  const catalystMutation = useMutation<{ catalysts: Catalyst[] }, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/equity/name-catalysts", {
        symbol: name.symbol,
        nameEn: name.nameEn,
        nameZh: name.nameZh,
        themeId,
        sinceDays: 45,
      });
      return res.json();
    },
  });

  return (
    <div className="border-t first:border-t-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
        data-testid={`name-${name.symbol}`}
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{name.nameEn}</span>
            <span className="text-xs text-muted-foreground">{name.nameZh}</span>
            <Badge variant="outline" className="text-[10px]">{name.symbol}</Badge>
            <Badge variant="outline" className="text-[10px] uppercase">{name.market}</Badge>
            <Badge variant="outline" className={`text-[10px] ${ROLE_STYLE[name.role] ?? ""}`}>{name.role}</Badge>
          </div>
          <div className="truncate text-xs text-muted-foreground">{name.thesis}</div>
        </div>
      </button>

      {open && (
        <div className="bg-muted/20 px-3 pb-3 pl-10">
          {/* Valuation */}
          {name.market === "ashare" ? (
            valuationQuery.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : val ? (
              <div className="flex flex-wrap gap-4 rounded-md border bg-background p-3 text-sm">
                <div><div className="text-[10px] uppercase text-muted-foreground">Price</div><div className="font-medium">{fmtNum(val.price, 2)}</div></div>
                <div><div className="text-[10px] uppercase text-muted-foreground">P/E (TTM)</div><div className="font-medium">{fmtNum(val.pe_ttm)}</div></div>
                <div><div className="text-[10px] uppercase text-muted-foreground">P/B</div><div className="font-medium">{fmtNum(val.pb, 2)}</div></div>
                <div><div className="text-[10px] uppercase text-muted-foreground">Mkt Cap</div><div className="font-medium">{fmtCap(val.market_cap)}</div></div>
                {val.industry && <div><div className="text-[10px] uppercase text-muted-foreground">Industry</div><div className="font-medium">{val.industry}</div></div>}
                <Badge variant="outline" className="self-center text-[10px] bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">AKShare</Badge>
              </div>
            ) : (
              <div className="rounded-md border bg-background p-2 text-xs text-muted-foreground">
                Valuation unavailable{valuationQuery.data?.error ? ` (${valuationQuery.data.error})` : ""}.
              </div>
            )
          ) : (
            <div className="rounded-md border bg-background p-2 text-xs text-muted-foreground">
              Spot valuation is A-share only; see catalysts below for this HK name.
            </div>
          )}

          {/* Catalysts */}
          <div className="mt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Newspaper className="h-3.5 w-3.5" /> Recent catalysts
                <Badge variant="outline" className="text-[9px] bg-violet-500/10 text-violet-700 dark:text-violet-300">Sonar Pro</Badge>
              </span>
              <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1" onClick={() => catalystMutation.mutate()} disabled={catalystMutation.isPending}>
                {catalystMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Newspaper className="h-3 w-3" />}
                Pull catalysts
              </Button>
            </div>
            {catalystMutation.error && (
              <div className="text-xs text-red-600 dark:text-red-400">{catalystMutation.error.message}</div>
            )}
            {catalystMutation.data && (
              <div className="space-y-1.5">
                {catalystMutation.data.catalysts.length === 0 && (
                  <div className="text-xs text-muted-foreground">No material catalysts found in the window.</div>
                )}
                {catalystMutation.data.catalysts.map((c, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md border bg-background p-2 text-sm">
                    <ImpactIcon impact={c.impact} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium">{c.headline}</span>
                        {c.date && <span className="text-[10px] text-muted-foreground">{c.date}</span>}
                      </div>
                      {c.detail && <div className="text-xs text-muted-foreground">{c.detail}</div>}
                    </div>
                    {c.url && (
                      <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeCard({ theme }: { theme: SectorTheme }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = THEME_ICON[theme.id];
  return (
    <Card className="overflow-hidden" data-testid={`theme-${theme.id}`}>
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-start gap-3 p-4 text-left hover:bg-muted/30">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{theme.label}</h3>
            <Badge variant="outline" className="text-[10px]">{theme.names.length} names</Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {theme.drivers.slice(0, expanded ? theme.drivers.length : 2).map((d, i) => (
              <span key={i} className="text-xs text-muted-foreground">• {d}{i < (expanded ? theme.drivers.length : 2) - 1 ? "" : ""}</span>
            ))}
          </div>
        </div>
        {expanded ? <ChevronDown className="h-5 w-5 text-muted-foreground" /> : <ChevronRight className="h-5 w-5 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="border-t">
          {theme.names.map((n) => (
            <NameRow key={`${n.market}:${n.symbol}`} name={n} themeId={theme.id} />
          ))}
        </div>
      )}
    </Card>
  );
}

export default function Sectors() {
  const { data, isLoading, error } = useQuery<{ themes: SectorTheme[] }, Error>({
    queryKey: ["/api/equity/universe"],
    queryFn: async () => (await apiRequest("GET", "/api/equity/universe")).json(),
  });

  return (
    <div data-testid="page-sectors">
      <PageHeader
        title="Sector Allocation"
        subtitle="Top-down themes → single names across tech, EV, battery, semis, AI, and consumer. Expand a theme to drill into constituents, valuation (AKShare), and live catalysts (Sonar Pro)."
      />
      {isLoading ? (
        <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : error ? (
        <Card className="p-6 text-sm text-red-600 dark:text-red-400">{error.message}</Card>
      ) : (
        <div className="space-y-3">
          {(data?.themes ?? []).map((t) => <ThemeCard key={t.id} theme={t} />)}
        </div>
      )}
    </div>
  );
}
