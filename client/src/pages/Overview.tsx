/**
 * Overview — China Dynamic Research Dashboard
 *
 * Investor glance-view: macro pulse · equity snapshot · house view ·
 * policy headlines · latest strategy note · data calendar · K-shape thesis
 *
 * Audience: Hong Kong institutional investor (top-down macro→equity monitor).
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { ProvenanceChip, ProvenanceChipLive } from "@/components/ProvenanceChip";
import { RefreshButton } from "@/components/RefreshButton";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DATA } from "@/data/staticData";
import { useSeries, getLatestValue, useCalendar, useRefreshSeries } from "@/hooks/useSeries";
import { useAnomalies, type AnomalyRow } from "@/hooks/useAnalysis";
import { AnomalyBadge } from "@/components/AnomalyBadge";
import { CompareButton } from "@/components/CompareModal";
import { ExternalLink, ArrowRight } from "lucide-react";

// ─── LiveStatCard ─────────────────────────────────────────────────────────────

function LiveStatCard({
  label,
  logicalId,
  hint,
  suffix = "%",
  invertTone = false,
  anomalyRow,
}: {
  label: string;
  logicalId: string;
  hint?: string;
  suffix?: string;
  invertTone?: boolean;
  anomalyRow?: AnomalyRow;
}) {
  const { data, isLoading, isError } = useSeries(logicalId) as any;

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

  const computedTone = hasData
    ? invertTone
      ? v! < 0 ? "good" : v! > 0 ? "bad" : "neutral"
      : v! > 0 ? "good" : v! < 0 ? "bad" : "neutral"
    : "neutral";

  const displayVal = hasData ? `${v! > 0 ? "+" : ""}${v!.toFixed(1)}${suffix}` : "—";
  const deltaText = latest.date ? latest.date : isError ? "load error" : "";

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

// ─── EquityRow ────────────────────────────────────────────────────────────────

function EquityRow({ label, logicalId }: { label: string; logicalId: string }) {
  const { data, isLoading } = useSeries(logicalId) as any;

  if (isLoading) {
    return (
      <div className="flex items-center justify-between py-2 border-b last:border-0">
        <Skeleton className="h-4 w-24" />
        <div className="flex gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-12" />
        </div>
      </div>
    );
  }

  const pts: { date: string; value: number }[] = data?.data ?? [];
  const last = pts[pts.length - 1] ?? null;
  const prev = pts[pts.length - 2] ?? null;

  const latestVal = last?.value ?? null;
  const momPct =
    latestVal !== null && prev?.value
      ? ((latestVal - prev.value) / Math.abs(prev.value)) * 100
      : null;

  const momTone =
    momPct === null ? "neutral" : momPct > 0 ? "good" : momPct < 0 ? "bad" : "neutral";
  const momCls = {
    good: "text-emerald-600 dark:text-emerald-400",
    bad: "text-red-600 dark:text-red-400",
    neutral: "text-muted-foreground",
  }[momTone];

  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-0 gap-2">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex items-center gap-4 tabular-nums text-sm">
        <span className="text-foreground">
          {latestVal !== null ? latestVal.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}
        </span>
        <span className={`text-xs ${momCls}`}>
          {momPct !== null ? `${momPct > 0 ? "+" : ""}${momPct.toFixed(1)}%` : "—"}
        </span>
        <span className="text-[11px] text-muted-foreground">{last?.date ?? ""}</span>
      </div>
    </div>
  );
}

// ─── Anomaly series IDs ───────────────────────────────────────────────────────

const OVERVIEW_ANOMALY_IDS = [
  "gdp_yoy",
  "cpi_yoy",
  "ppi_yoy",
  "iva_yoy",
  "exports_yoy",
  "imports_yoy",
  "trade_balance_usd",
  "retail_sales_yoy",
  "pmi_mfg",
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Overview() {
  const ppi = useSeries("ppi_yoy") as any;
  const prov = ppi.data?.provenance;

  const refreshSeries = useRefreshSeries();

  const KEY_MACRO_IDS = [
    "cpi_yoy",
    "ppi_yoy",
    "pmi_mfg",
    "m2_yoy",
    "retail_sales_yoy",
    "exports_yoy",
    "imports_yoy",
    "trade_balance_usd",
    "csi300_monthly",
    "chinext_monthly",
    "hangseng_monthly",
  ];

  async function handleGlobalRefresh() {
    await Promise.all(KEY_MACRO_IDS.map((id) => refreshSeries(id)));
  }

  // Anomalies
  const anomalies = useAnomalies(OVERVIEW_ANOMALY_IDS);
  const anomalyById: Record<string, AnomalyRow> = {};
  (anomalies.data?.results ?? []).forEach((r) => {
    anomalyById[r.id] = r;
  });

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

  // House view
  const houseViewQuery = useQuery<{ houseView: any | null }>({
    queryKey: ["/api/house-view"],
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  // Policy feed
  const policyQuery = useQuery<{ updates: any[] }>({
    queryKey: ["/api/policy/feed", 6],
    queryFn: async () => {
      const { apiRequest } = await import("@/lib/queryClient");
      const res = await apiRequest("GET", "/api/policy/feed?limit=6");
      return res.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  // Latest report
  const reportQuery = useQuery<{ notes: any[] }>({
    queryKey: ["/api/report", 1],
    queryFn: async () => {
      const { apiRequest } = await import("@/lib/queryClient");
      const res = await apiRequest("GET", "/api/report?limit=1");
      return res.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  // Calendar
  const calendarQuery = useCalendar(14);

  const houseView = houseViewQuery.data?.houseView ?? null;
  const policyUpdates = policyQuery.data?.updates ?? [];
  const latestNote = reportQuery.data?.notes?.[0] ?? null;
  const calendarReleases = calendarQuery.data?.releases?.slice(0, 6) ?? [];

  return (
    <div data-testid="page-overview">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <PageHeader
        title="China Dynamic Research Dashboard"
        subtitle="Institutional top-down macro→equity monitor — K-shape divergence, policy signals, and strategy synthesis."
        meta={
          <>
            {prov ? (
              <ProvenanceChipLive
                source={prov.source}
                lastUpdated={prov.lastUpdated}
                cacheHit={prov.cacheHit}
                error={prov.error}
              />
            ) : (
              <ProvenanceChip type="static" detail="Static fallback" />
            )}
          </>
        }
        actions={
          <RefreshButton onRefresh={handleGlobalRefresh} label="Refresh data" />
        }
      />

      {/* ── Regime watch (anomaly banner) ──────────────────────────────────── */}
      {topAnomalies.length > 0 && (
        <Card className="p-4 mb-6 border-amber-500/30 bg-amber-500/5" data-testid="card-regime-watch">
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

      {/* ── Macro pulse ───────────────────────────────────────────────────── */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Macro pulse</h2>
      </div>
      <div
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6"
        data-testid="card-macro-pulse"
      >
        <LiveStatCard
          label="CPI YoY"
          logicalId="cpi_yoy"
          hint="Consumer price index"
          anomalyRow={anomalyById["cpi_yoy"]}
        />
        <LiveStatCard
          label="PPI YoY"
          logicalId="ppi_yoy"
          hint="Producer price index"
          invertTone={false}
          anomalyRow={anomalyById["ppi_yoy"]}
        />
        <LiveStatCard
          label="Mfg PMI"
          logicalId="pmi_mfg"
          suffix=""
          hint="Official NBS manufacturing PMI"
          anomalyRow={anomalyById["pmi_mfg"]}
        />
        <LiveStatCard
          label="M2 YoY"
          logicalId="m2_yoy"
          hint="Broad money supply"
          anomalyRow={anomalyById["m2_yoy"]}
        />
        <LiveStatCard
          label="Retail YoY"
          logicalId="retail_sales_yoy"
          hint="Retail sales growth"
          anomalyRow={anomalyById["retail_sales_yoy"]}
        />
        <LiveStatCard
          label="Unemployment"
          logicalId="unemployment_rate"
          hint="Urban surveyed unemployment"
          invertTone={true}
          anomalyRow={anomalyById["unemployment_rate"]}
        />
      </div>

      {/* ── Trade ─────────────────────────────────────────────────────────── */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Trade</h2>
        <span className="text-xs text-muted-foreground">Customs (USD terms)</span>
      </div>
      <div
        className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6"
        data-testid="card-trade"
      >
        <LiveStatCard
          label="Exports YoY"
          logicalId="exports_yoy"
          hint="Merchandise exports (USD)"
          anomalyRow={anomalyById["exports_yoy"]}
        />
        <LiveStatCard
          label="Imports YoY"
          logicalId="imports_yoy"
          hint="Merchandise imports (USD)"
          anomalyRow={anomalyById["imports_yoy"]}
        />
        <LiveStatCard
          label="Trade Balance"
          logicalId="trade_balance_usd"
          suffix=" bn"
          hint="Monthly surplus (USD bn)"
          anomalyRow={anomalyById["trade_balance_usd"]}
        />
      </div>

      {/* ── Equity snapshot + House view ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">

        {/* Equity snapshot */}
        <Card className="p-5" data-testid="card-equity">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Equity markets</h2>
            <Link href="/equity" className="text-xs text-primary hover:underline flex items-center gap-0.5">
              View <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="text-[11px] text-muted-foreground mb-2 tabular-nums grid grid-cols-3 gap-2 font-medium uppercase tracking-wider">
            <span>Index</span>
            <span className="text-right">Latest</span>
            <span className="text-right">MoM %</span>
          </div>
          <EquityRow label="CSI 300" logicalId="csi300_monthly" />
          <EquityRow label="ChiNext" logicalId="chinext_monthly" />
          <EquityRow label="Hang Seng" logicalId="hangseng_monthly" />
          <EquityRow label="STAR 50" logicalId="star50_close" />
        </Card>

        {/* House view */}
        <Card className="p-5" data-testid="card-house-view">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">House view</h2>
            {houseView && (
              <Badge variant="outline" className="font-normal text-[10px]">
                {houseView.conviction ?? "—"} conviction
              </Badge>
            )}
          </div>
          {houseViewQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : houseView ? (
            <div className="space-y-2 text-sm">
              {houseView.stance && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Stance</span>
                  <Badge variant="secondary" className="font-normal">{houseView.stance}</Badge>
                </div>
              )}
              {houseView.summary && (
                <p className="text-sm text-muted-foreground leading-relaxed">{houseView.summary}</p>
              )}
              {houseView.asOfDate && (
                <div className="text-[11px] text-muted-foreground">As of {houseView.asOfDate}</div>
              )}
              {/* Render any other string fields defensively */}
              {Object.entries(houseView)
                .filter(
                  ([k, v]) =>
                    !["stance", "conviction", "summary", "asOfDate", "id"].includes(k) &&
                    typeof v === "string" &&
                    v.trim().length > 0,
                )
                .map(([k, v]) => (
                  <div key={k} className="text-sm">
                    <span className="text-muted-foreground capitalize">{k}: </span>
                    <span>{v as string}</span>
                  </div>
                ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground space-y-3">
              <p>No house view established yet.</p>
              <Link
                href="/report"
                className="inline-flex items-center gap-1 text-primary hover:underline text-sm"
              >
                Generate a strategy note to establish the house view
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </Card>
      </div>

      {/* ── Policy headlines + Latest strategy note ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">

        {/* Policy tracker */}
        <Card className="p-5" data-testid="card-policy">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Policy tracker — latest</h2>
            <Link href="/policy" className="text-xs text-primary hover:underline flex items-center gap-0.5">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {policyQuery.isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-1">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          ) : policyUpdates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No policy updates yet.</p>
          ) : (
            <ul className="space-y-3">
              {policyUpdates.map((item: any) => (
                <li key={item.id} className="border-b last:border-0 pb-2.5 last:pb-0">
                  <div className="flex items-start gap-2 justify-between">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium hover:underline leading-snug flex-1"
                    >
                      {item.title || item.titleZh || "—"}
                      <ExternalLink className="inline h-2.5 w-2.5 ml-1 opacity-50" />
                    </a>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    {item.body && (
                      <Badge variant="secondary" className="font-normal text-[10px]">
                        {item.body}
                      </Badge>
                    )}
                    {item.publishedAt && (
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(item.publishedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Latest strategy note */}
        <Card className="p-5" data-testid="card-latest-note">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Latest strategy note</h2>
            <Link href="/report" className="text-xs text-primary hover:underline flex items-center gap-0.5">
              Open <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {reportQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : latestNote ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {latestNote.mode && (
                  <Badge variant="outline" className="font-normal text-[10px]">
                    {latestNote.mode}
                  </Badge>
                )}
                {latestNote.asOfDate && (
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(latestNote.asOfDate).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="text-sm font-medium leading-snug">{latestNote.title}</div>
              {latestNote.preview && (
                <p className="text-sm text-muted-foreground leading-relaxed line-clamp-4">
                  {latestNote.preview.length > 280
                    ? latestNote.preview.slice(0, 280) + "…"
                    : latestNote.preview}
                </p>
              )}
              <Link href="/report" className="text-xs text-primary hover:underline inline-flex items-center gap-0.5 mt-1">
                Read full note <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground space-y-2">
              <p>No strategy notes generated yet.</p>
              <Link href="/report" className="text-primary hover:underline text-sm inline-flex items-center gap-0.5">
                Go to Reports <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </Card>
      </div>

      {/* ── Upcoming releases ─────────────────────────────────────────────── */}
      <Card className="p-5 mb-6" data-testid="card-calendar">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Upcoming releases</h2>
          <Badge variant="outline" className="font-normal text-[10px]">14-day window</Badge>
        </div>
        {calendarQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : calendarReleases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scheduled releases in the next 14 days.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {calendarReleases.map((r: any, i: number) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="text-[11px] text-muted-foreground tabular-nums w-[70px] shrink-0">
                  {r.date ?? "—"}
                </span>
                <span className="font-medium truncate">{r.name ?? r.indicator ?? "—"}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── K-shape thesis + Quick navigation ────────────────────────────── */}
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
            <Badge variant="outline" className="font-normal">12 sections</Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Link href="/investment" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-investment">FAI &amp; Sub-sectors</Link>
            <Link href="/gdp" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-gdp">GDP &amp; Energy</Link>
            <Link href="/fiscal" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-fiscal">Fiscal / Policy</Link>
            <Link href="/equity" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-equity">Equities</Link>
            <Link href="/kshape" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-kshape">K-shape Monitor</Link>
            <Link href="/margins" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-margins">PPI &amp; Margins</Link>
            <Link href="/property" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-property">Property</Link>
            <Link href="/report" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-report">Strategy Notes</Link>
            <Link href="/policy" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-policy">Policy Tracker</Link>
            <Link href="/sectors" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-sectors">Sectors</Link>
            <Link href="/automation" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-automation">Automation</Link>
            <Link href="/costs" className="px-3 py-2 rounded-md hover-elevate border" data-testid="link-costs">Costs</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
