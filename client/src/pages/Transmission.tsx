/**
 * Credit, liquidity, property transmission, and the weekly activity nowcast.
 * Numbers come from /api/transmission. Nothing on this page is a forecast consensus.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Obs { label: string; date: string; value: number; unit: string; stale?: boolean }
interface Transmission {
  asOf: string;
  credit: { incompleteTsfFlow: Obs | null; components: Obs[]; coverage: string; loansVsYearAgo: number | null };
  liquidity: { regime: string; why: string; spreadDr007VsPolicy: number | null; m1MinusM2: number | null; dr007: Obs | null; policyRate7d: Obs | null };
  property: { regime: string; why: string; startsYoy: Obs | null; pricesYoy: Obs | null; faiRealEstateYoy: Obs | null; profitsYoy: Obs | null; salesValueYoy: number | null };
  nowcast: { label: string; score: number | null; why: string; horizonNote: string; inputs: { label: string; value: number; unit: string; date: string; signal: string }[] };
  calendar: { date: string; agency: string; indicator: string; expectedRelease: boolean }[];
  gaps: string[];
}

function n(v: number | null | undefined, d = 1): string {
  return v == null || Number.isNaN(v) ? "n/a" : v.toFixed(d);
}

export default function Transmission() {
  const q = useQuery<Transmission>({
    queryKey: ["/api/transmission"],
    queryFn: async () => (await apiRequest("GET", "/api/transmission")).json(),
  });
  const d = q.data;

  return (
    <div>
      <PageHeader
        title="Transmission"
        subtitle="Incomplete credit flow, liquidity versus the policy rate, property gauges, and a weekly activity nowcast. Official TSF is not complete."
      />
      {q.isLoading && <Skeleton className="h-64 w-full" />}
      {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
      {d && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Liquidity</div>
              <div className="mt-1 text-lg font-medium capitalize">{d.liquidity.regime}</div>
              <p className="mt-2 text-sm text-muted-foreground">{d.liquidity.why}</p>
              <p className="mt-2 text-sm">DR007 {n(d.liquidity.dr007?.value, 2)} vs policy {n(d.liquidity.policyRate7d?.value, 2)}. Spread {n(d.liquidity.spreadDr007VsPolicy, 2)} pp. M1−M2 {n(d.liquidity.m1MinusM2)} pp.</p>
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Property</div>
              <div className="mt-1 text-lg font-medium capitalize">{d.property.regime}</div>
              <p className="mt-2 text-sm text-muted-foreground">{d.property.why}</p>
              <p className="mt-2 text-sm">Starts {n(d.property.startsYoy?.value)}%. Prices {n(d.property.pricesYoy?.value)}%. RE FAI {n(d.property.faiRealEstateYoy?.value)}%. Profits {n(d.property.profitsYoy?.value)}%.</p>
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Weekly nowcast</div>
              <div className="mt-1 text-lg font-medium capitalize">{d.nowcast.label}{d.nowcast.score != null ? ` · ${d.nowcast.score}` : ""}</div>
              <p className="mt-2 text-sm text-muted-foreground">{d.nowcast.why}</p>
              <p className="mt-2 text-xs text-muted-foreground">{d.nowcast.horizonNote}</p>
            </Card>
          </div>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Incomplete TSF flow</h2>
            <p className="mt-1 text-sm text-muted-foreground">{d.credit.coverage}. New RMB loans versus a year earlier: {n(d.credit.loansVsYearAgo)}%.</p>
            <p className="mt-1 text-sm">{d.credit.incompleteTsfFlow ? `${n(d.credit.incompleteTsfFlow.value, 0)} ${d.credit.incompleteTsfFlow.unit} in ${d.credit.incompleteTsfFlow.date.slice(0, 7)}` : "No aligned month."}</p>
            <ul className="mt-2 text-sm">
              {d.credit.components.map((c) => (
                <li key={c.label}>{c.label}: {n(c.value, 0)} {c.unit} ({c.date.slice(0, 7)})</li>
              ))}
            </ul>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Activity gauges</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {d.nowcast.inputs.map((i) => (
                <li key={i.label} className="flex justify-between gap-4">
                  <span>{i.label} <span className="text-muted-foreground">{i.date}</span></span>
                  <span>{n(i.value)} {i.unit} · {i.signal}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Next estimated releases</h2>
            <p className="mt-1 text-xs text-muted-foreground">Windows follow usual NBS, PBoC, and Customs practice. They are estimates, not a confirmed official calendar.</p>
            <ul className="mt-2 text-sm">
              {d.calendar.map((c) => (
                <li key={c.date + c.indicator}>{c.date} · {c.agency} · {c.indicator}{c.expectedRelease ? "" : " (estimated)"}</li>
              ))}
            </ul>
          </Card>

          <div className="flex flex-wrap gap-2">
            {d.gaps.map((g) => <Badge key={g} variant="outline" className="font-normal">{g}</Badge>)}
          </div>
        </div>
      )}
    </div>
  );
}
