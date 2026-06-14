/**
 * Relative & Global Context panel (Gap F) — the top-down call on China assets.
 *
 * Renders /api/equity/relative-context: an LLM stance badge + whyChina, the AH
 * premium gauge, China index returns (YTD / 12m), and the cross-asset backdrop
 * (USD/CNY + US-China 10Y differential). Deterministic numeric skeleton always
 * renders; stance + whyChina appear when the server LLM call succeeds. Degrades
 * gracefully (sidecar /relative/* 404 pre-deploy → notes). Mirrors
 * PolicyTransmissionPanel styling.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe, Loader2, AlertTriangle } from "lucide-react";

type Stance = "constructive" | "neutral" | "cautious";

interface IndexReturn {
  index: string;
  symbol: string;
  lastClose: number | null;
  lastDate: string | null;
  ytdPct: number | null;
  ret12mPct: number | null;
}
interface AhPremiumSignal {
  aggregatePremiumPct: number | null;
  pairCount: number | null;
  level: "elevated" | "moderate" | "compressed" | null;
  note: string | null;
}
interface CrossAssetSignal {
  usdCny: number | null;
  usdCnyDate: string | null;
  usCn10yDiff: number | null;
  cn10y: number | null;
  us10y: number | null;
  yieldsDate: string | null;
}
interface RelativeContext {
  generatedAt: string;
  stance: Stance | null;
  whyChina: string;
  drivers: string[];
  ahPremium: AhPremiumSignal | null;
  indexReturns: IndexReturn[];
  crossAsset: CrossAssetSignal | null;
  notes: string[];
  model: string;
  costUsd: number;
}

const STANCE_TONE: Record<string, string> = {
  constructive: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  neutral: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  cautious: "bg-red-500/10 text-red-700 dark:text-red-300",
};

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function toneCls(v: number | null | undefined): string {
  if (v == null) return "text-muted-foreground";
  return v >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
}

export function RelativeContextPanel() {
  const q = useQuery<RelativeContext, Error>({
    queryKey: ["/api/equity/relative-context"],
    queryFn: async () => (await apiRequest("GET", "/api/equity/relative-context")).json(),
    staleTime: 6 * 60 * 60 * 1000,
  });
  const r = q.data;
  const haveAny = !!(r && (r.ahPremium || r.indexReturns.length || r.crossAsset));

  return (
    <Card className="p-5" data-testid="card-relative-context">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Globe className="h-4 w-4 text-primary" /> Relative &amp; global context
        {r?.stance && (
          <Badge variant="outline" className={`text-[9px] capitalize ${STANCE_TONE[r.stance] ?? ""}`}>
            {r.stance}
          </Badge>
        )}
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Assembling AH premium, China returns, and the rate/FX backdrop…
        </div>
      ) : q.error ? (
        <div className="text-xs text-red-600 dark:text-red-400">Unavailable: {q.error.message}</div>
      ) : haveAny ? (
        <div className="space-y-3">
          {r!.whyChina && (
            <p className="text-sm text-muted-foreground leading-relaxed">{r!.whyChina}</p>
          )}

          {r!.indexReturns.length > 0 && (
            <div>
              <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1 grid grid-cols-3 gap-2 font-medium">
                <span>Index</span>
                <span className="text-right">YTD</span>
                <span className="text-right">12m</span>
              </div>
              {r!.indexReturns.map((ir) => (
                <div key={ir.symbol} className="grid grid-cols-3 gap-2 py-1.5 border-b last:border-0 text-sm tabular-nums">
                  <span className="font-medium">{ir.index}</span>
                  <span className={`text-right ${toneCls(ir.ytdPct)}`}>{pct(ir.ytdPct)}</span>
                  <span className={`text-right ${toneCls(ir.ret12mPct)}`}>{pct(ir.ret12mPct)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {r!.ahPremium?.aggregatePremiumPct != null && (
              <div className="rounded-md border p-2.5">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">AH premium (median)</div>
                <div className="text-lg font-semibold tabular-nums">
                  {r!.ahPremium.aggregatePremiumPct!.toFixed(1)}%
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {r!.ahPremium.level ?? "—"} · {r!.ahPremium.pairCount ?? "?"} pairs
                </div>
              </div>
            )}
            {r!.crossAsset && (
              <div className="rounded-md border p-2.5">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Cross-asset</div>
                {r!.crossAsset.usdCny != null && (
                  <div className="text-sm tabular-nums">USD/CNY {r!.crossAsset.usdCny.toFixed(3)}</div>
                )}
                {r!.crossAsset.usCn10yDiff != null && (
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    US-CN 10Y {r!.crossAsset.usCn10yDiff > 0 ? "+" : ""}{r!.crossAsset.usCn10yDiff.toFixed(2)}pp
                    {" "}(US {r!.crossAsset.us10y != null ? r!.crossAsset.us10y.toFixed(2) : "—"} / CN {r!.crossAsset.cn10y != null ? r!.crossAsset.cn10y.toFixed(2) : "—"})
                  </div>
                )}
              </div>
            )}
          </div>

          {r!.drivers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {r!.drivers.slice(0, 4).map((d, i) => (
                <Badge key={i} variant="secondary" className="font-normal text-[10px]">{d}</Badge>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500" />
          {r?.notes?.length ? r.notes.join(" ") : "Relative-context signals unavailable this refresh."}
        </div>
      )}
    </Card>
  );
}
