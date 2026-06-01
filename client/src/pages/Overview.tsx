import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { DATA, LAST_UPDATED } from "@/data/staticData";

export default function Overview() {
  return (
    <div data-testid="page-overview">
      <PageHeader
        title="China Dynamic Research Dashboard"
        subtitle="Old-economy vs new-economy K-shape monitor — built for institutional investment research."
        meta={
          <>
            <ProvenanceChip type="static" detail={`Last static refresh: ${LAST_UPDATED}`} />
            <Badge variant="outline" className="font-normal">Phase 1 · static data</Badge>
            <Badge variant="outline" className="font-normal">Live data wires in Phase 2</Badge>
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="FAI 2026Q1"
          value="+1.7%"
          delta="vs -3.8% FY2025"
          hint="New economy +9-10%, old economy −5%"
          tone="good"
        />
        <StatCard
          label="PPI YoY"
          value="+0.4%"
          delta="Apr 2026 — first positive in 41 months"
          tone="good"
        />
        <StatCard
          label="Property FAI"
          value="−11.2%"
          delta="2026Q1, improved from −17.2%"
          tone="bad"
        />
        <StatCard
          label="High-tech FAI"
          value="+6.1%"
          delta="2026Q1, outpacing total"
          tone="good"
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
              <Badge variant="secondary" className="font-normal">Phase 1 — now</Badge>
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
              <Badge variant="outline" className="font-normal">Phase 2 — live data</Badge>
            </div>
            <ul className="text-muted-foreground space-y-1 list-disc list-inside text-[13px]">
              <li>CEIC live: FAI, K-shape, PPI, property</li>
              <li>A-share indices via free sources</li>
              <li>Release calendar</li>
              <li>CSV/XLSX export</li>
              <li>Per-chart "Last updated" timestamps</li>
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
