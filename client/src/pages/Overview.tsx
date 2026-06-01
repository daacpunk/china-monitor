import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { ProvenanceChip, ProvenanceChipLive } from "@/components/ProvenanceChip";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { DATA } from "@/data/staticData";
import { useSeries, getLatestValue } from "@/hooks/useSeries";

function LiveStatCard({
  label,
  logicalId,
  unit,
  hint,
  tone,
  suffix = "%",
  invertTone = false,
}: {
  label: string;
  logicalId: string;
  unit?: string;
  hint?: string;
  tone?: "good" | "bad" | "neutral";
  suffix?: string;
  invertTone?: boolean;
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
    />
  );
}

export default function Overview() {
  const faiFull = useSeries("fai_total_ytd") as any;
  const ppi = useSeries("ppi_yoy") as any;
  const faiRE = useSeries("fai_real_estate_ytd") as any;
  const faiHT = useSeries("fai_hitech_ytd") as any;

  const prov = ppi.data?.provenance;

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
        />
        <LiveStatCard
          label="PPI YoY"
          logicalId="ppi_yoy"
          tone="good"
          hint="Producer price index"
        />
        <LiveStatCard
          label="Property FAI YTD"
          logicalId="fai_real_estate_ytd"
          invertTone={true}
          hint="Real estate investment"
        />
        <LiveStatCard
          label="High-tech FAI YTD"
          logicalId="fai_hitech_ytd"
          tone="good"
          hint="High-tech manufacturing capex"
        />
      </div>

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
