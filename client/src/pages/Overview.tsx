import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { ProvenanceChip, ProvenanceChipLive } from "@/components/ProvenanceChip";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { DATA } from "@/data/staticData";
import { useSeries, getLatestValue } from "@/hooks/useSeries";
import { useAnomalies, type AnomalyRow } from "@/hooks/useAnalysis";
import { AnomalyBadge } from "@/components/AnomalyBadge";
import { CompareButton } from "@/components/CompareModal";

function LiveStatCard({
  label,
  logicalId,
  unit,
  hint,
  tone,
  suffix = "%",
  invertTone = false,
  anomalyRow,
}: {
  label: string;
  logicalId: string;
  unit?: string;
  hint?: string;
  tone?: "good" | "bad" | "neutral";
  suffix?: string;
  invertTone?: boolean;
  anomalyRow?: AnomalyRow;
}) {
  const { data, provenance, isLoading, isError } = useSeries(logicalId) as any;

  if (isLoading) {
    return (
      <div className="border rounded-lg p-4 bg-card">
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">{label}</div>
        <Skeleton className="h-8 w-24 mb-1" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  const latest = getLatestValue(data);
  const v = latest.value;
  const hasData = v !== null;

  const computedTone = tone ?? (
    hasData
      ? invertTone
        ? v! < 0 ? "good" : v! > 0 ? "bad" : "neutral"
        : v! > 0 ? "good" : v! < 0 ? "bad" : "neutral"
      : "neutral"
  );

  const displayVal = hasData ? `${v! > 0 ? "+" : ""}${v!.toFixed(1)}${suffix}` : "—";
  const deltaText = latest.date ? `${latest.date}` : isError ? "couldn't load — using static" : "";

  return (
    <StatCard
      label={label}
      value={displayVal}
      delta={deltaText}
      hint={hint}
      tone={hasData ? computedTone : "neutral"}
    >
      {anomalyRow?.anomaly && (
        <div className="mt-2">
          <AnomalyBadge
            anomaly={anomalyRow.anomaly}
            momPct={anomalyRow.momLagPct}
            yoyPct={anomalyRow.yoyLagPct}
          />
        </div>
      )}
    </StatCard>
  );
}

// CEIC series IDs to monitor for anomalies on Overview
const OVERVIEW_ANOMALY_IDS = [
  "gdp_yoy",
  "cpi_yoy",
  "ppi_yoy",
  "iva_yoy",
  "exports_yoy",
  "imports_yoy",
  "new_home_prices_70city",
  "usdcny_monthly",
  "m2_yoy",
  "unemployment_rate",
  "hangseng_monthly",
  "csi300_monthly",
  "fai_total_ytd",
  "fai_real_estate_ytd",
  "fai_hitech_ytd",
];

export default function Overview() {
  const faiFull = useSeries("fai_total_ytd") as any;
  const ppi = useSeries("ppi_yoy") as any;
  const faiRE = useSeries("fai_real_estate_ytd") as any;
  const faiHT = useSeries("fai_hitech_ytd") as any;

  const prov = ppi.data?.provenance;

  // Bulk-fetch anomalies for all overview KPIs in one call
  const anomalies = useAnomalies(OVERVIEW_ANOMALY_IDS);
  const anomalyById: Record<string, AnomalyRow> = {};
  (anomalies.data?.results ?? []).forEach((r) => {
    anomalyById[r.id] = r;
  });

  // Surface most-severe anomalies for the banner
  const severityRank = { anomaly: 3, watch: 2, normal: 1, undefined: 0 } as Record<string, number>;
  const topAnomalies = (anomalies.data?.results ?? [])
    .filter((r) => r.anomaly && r.anomaly.severity !== "normal")
    .sort(
      (a, b) =>
        (severityRank[b.anomaly?.severity ?? "normal"] ?? 0) -
          (severityRank[a.anomaly?.severity ?? "normal"] ?? 0) ||
        Math.abs(b.anomaly!.zScore) - Math.abs(a.anomaly!.zScore),
    )
    .slice(0, 6);

  return (
    <div data-testid="page-overview">
      <PageHeader
        title="China Dynamic Research Dashboard"
        subtitle="Old-economy vs new-economy K-shape monitor — built for institutional investment research."
        meta={
          <>
            {prov ? (
              <ProvenanceChipLive
                source={prov.source}
                lastUpdated={prov.lastUpdated}
                cacheHit={prov.cacheHit}
              />
            ) : (
              <ProvenanceChip type="static" detail="Static fallback" />
            )}
            <Badge variant="outline" className="font-normal">Phase 2 · live data</Badge>
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <LiveStatCard
          label="FAI Total YTD"
          logicalId="fai_total_ytd"
          tone="good"
          hint="Year-to-date FAI growth"
          anomalyRow={anomalyById["fai_total_ytd"]}
        />
        <LiveStatCard
          label="PPI YoY"
          logicalId="ppi_yoy"
          tone="good"
          hint="Producer price index"
          anomalyRow={anomalyById["ppi_yoy"]}
        />
        <LiveStatCard
          label="Property FAI YTD"
          logicalId="fai_real_estate_ytd"
          invertTone={true}
          hint="Real estate investment"
          anomalyRow={anomalyById["fai_real_estate_ytd"]}
        />
        <LiveStatCard
          label="High-tech FAI YTD"
          logicalId="fai_hitech_ytd"
          tone="good"
          hint="High-tech manufacturing capex"
          anomalyRow={anomalyById["fai_hitech_ytd"]}
        />
      </div>

      {topAnomalies.length > 0 && (
        <Card className="p-4 mb-6 border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              Regime watch
              <Badge variant="outline" className="font-normal text-[10px]">
                z-score &gt; 2 across {OVERVIEW_ANOMALY_IDS.length} series
              </Badge>
            </h2>
            <CompareButton
              ids={topAnomalies.slice(0, 4).map((r) => r.id)}
              label="Compare top movers"
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {topAnomalies.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2"
                data-testid={`anomaly-row-${r.id}`}
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{r.id}</div>
                  <div className="text-[10px] text-muted-foreground tabular-nums">
                    {r.anomaly!.value.toFixed(2)} · vs μ{r.anomaly!.windowMean.toFixed(2)}
                  </div>
                </div>
                <AnomalyBadge
                  anomaly={r.anomaly}
                  momPct={r.momLagPct}
                  yoyPct={r.yoyLagPct}
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">K-shape divergence — the core thesis</h2>
            <Link href="/kshape" className="text-xs text-primary hover:underline">View →</Link>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            China's economy has bifurcated. New-economy sectors (AI, EVs, batteries, semis, advanced
            manufacturing) compound double-digit capex growth; old-economy sectors (real estate,
            traditional infra, heavy industry) are in multi-year contraction. The investment thesis
            depends on knowing which side each datum sits on.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {DATA.subsectorFAI?.slice(0, 6).map((s: any) => (
              <Badge
                key={s.name}
                variant="outline"
                className={
                  s.group === "new"
                    ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                    : s.group === "old"
                      ? "border-red-500/40 text-red-700 dark:text-red-300"
                      : ""
                }
              >
                {s.name} {s.pct > 0 ? "+" : ""}
                {s.pct}%
              </Badge>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Quick navigation</h2>
            <Badge variant="outline" className="font-normal">8 sections</Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Link href="/investment" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-investment">FAI & Sub-sectors</Link>
            <Link href="/gdp" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-gdp">GDP & Energy</Link>
            <Link href="/fiscal" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-fiscal">Fiscal / Policy</Link>
            <Link href="/equity" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-equity">Equities</Link>
            <Link href="/kshape" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-kshape">K-shape Monitor</Link>
            <Link href="/margins" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-margins">PPI & Margins</Link>
            <Link href="/property" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-property">Property</Link>
            <Link href="/outlook" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-outlook">Outlook</Link>
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-3">What ships in each phase</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="font-medium mb-1.5">
              <Badge variant="secondary" className="font-normal">Phase 1 — done</Badge>
            </div>
            <ul className="text-muted-foreground space-y-1 list-disc list-inside text-[13px]">
              <li>8 dashboard sections (static)</li>
              <li>Settings (4 API keys, TTLs, cost ceilings, display)</li>
              <li>Audit trail (call log + per-feature attribution + forecast)</li>
              <li>Postgres persistence</li>
              <li>Theme persists across sessions</li>
            </ul>
          </div>
          <div>
            <div className="font-medium mb-1.5">
              <Badge variant="outline" className="font-normal border-emerald-500/40 text-emerald-700 dark:text-emerald-300">Phase 2 — live ✓</Badge>
            </div>
            <ul className="text-muted-foreground space-y-1 list-disc list-inside text-[13px]">
              <li>NBS live: FAI, PPI, property, PMI</li>
              <li>A-share indices via Yahoo Finance</li>
              <li>Release calendar (30-day rolling)</li>
              <li>Per-chart provenance chips</li>
              <li>CEIC search + health endpoint</li>
            </ul>
          </div>
          <div>
            <div className="font-medium mb-1.5">
              <Badge variant="outline" className="font-normal">Phase 3 — intelligence</Badge>
            </div>
            <ul className="text-muted-foreground space-y-1 list-disc list-inside text-[13px]">
              <li>Series explorer + drill-down</li>
              <li>Custom watchlists</li>
              <li>Sonar Pro "what's happening" queries</li>
              <li>Claude weekly K-shape synthesis</li>
              <li>DeepSeek batch enrichment</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}
