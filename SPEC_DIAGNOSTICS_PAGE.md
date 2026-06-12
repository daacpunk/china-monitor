# SPEC — Diagnostics / Health page

Status: APPROVED to build (user greenlit). Small, self-contained.

## Goal
A single `/diagnostics` page that answers "is the data live, and if not, why?"
at a glance — so issues like host blocks, token mismatches, stale series, or a
down sidecar are obvious instantly instead of needing a curl session.

## Backend — new aggregator endpoint
`GET /api/diagnostics` (server-side fan-out; tolerant — never 500s, each section
degrades to an error object). Returns:

```
{
  generatedAt,
  app: { ok: true, env: NODE_ENV, version?: git sha if available },
  sidecar: {                       // from getAkshareHealth()
    url: maskedSidecarUrl,         // show host only, e.g. "47.76.167.164:8000" or "*.railway.internal"
    reachable, authConfigured, akshareVersion, cacheSize
  },
  sources: [                       // provider status matrix
    { id:"akshare", label:"AKShare sidecar", status:"ok|degraded|down", detail },
    { id:"ceic",    label:"CEIC",   status, detail:"key configured; search denied" },
    { id:"fred",    label:"FRED",   status, detail },
    { id:"eastmoney", label:"EastMoney", status, detail },
    { id:"sonar",   label:"Sonar (Perplexity)", status:keyConfigured },
    { id:"anthropic", label:"Anthropic", status:keyConfigured },
  ],
  series: [                        // FRESHNESS MATRIX (the centerpiece)
    { id, label, category, source, lastDate, ageDays, status:"fresh|stale|empty", error? }
    ... for a curated set of key series (the DEFAULT_BRIEF_DRIVERS + trade +
        equity indices + valuations-probe), NOT all 100+ (keep it fast).
  ],
  costs: { yearMonth, totalUsd, byService:[{service,total,calls}] }, // /api/audit/summary
  automation: { enabled, nextRunAt, lastRunAt, recentJobs:[{status,kind,startedAt}] },
  limitations: [                   // static known-issues, surfaced explicitly
    "Urban unemployment: NBS-blocked even from HK host (shows —).",
    "Sector fund flows: intermittently flaky upstream (EastMoney).",
  ]
}
```

Implementation notes:
- Series freshness: fetch each key series via fetchSeries (cached) and read
  provenance.source + last data point date; compute ageDays; status = empty if
  no data, stale if older than the series' expected cadence (monthly ~ >45d),
  else fresh. Run in parallel with Promise.allSettled; cap the set (~25 series)
  so the endpoint stays <~10s. Cache the whole payload ~60s.
- Mask secrets: never return tokens/keys; sidecar url shows host:port only.
- Reuse: getAkshareHealth, checkFredHealth, /api/ceic/health logic, audit
  summary, automation config + listJobRuns.

## Frontend — /diagnostics page
- PageHeader "Diagnostics" + subtitle + a global Refresh button (refetch).
- **Status strip** (top): App / Sidecar / each source as colored chips
  (green ok / amber degraded / red down) with tooltips.
- **Sidecar card**: URL host, reachable, auth, AKShare version, cache size.
- **Series freshness table** (centerpiece): columns Series | Source | Last data
  | Age | Status badge. Sort stale/empty to top. Source chip reuses
  ProvenanceChip styles. This is what makes problems obvious.
- **Cost mini-panel**: month-to-date total + by-service (link to /costs).
- **Automation card**: enabled, next/last run, last few job statuses (link to
  /automation).
- **Known limitations** list.
- Loading: Skeletons. Each section independent (one failing source doesn't blank
  the page). data-testids: diag-status-strip, diag-sidecar, diag-series-table,
  diag-costs, diag-automation.
- Nav: add to SYSTEM/Report group in Layout.tsx + route in App.tsx.

## Out of scope
No write actions (no cache-clear/redeploy buttons) in v1 — read-only health view.
Could add "clear cache" / "force refresh all" later.
