# China Monitor — Dynamic Research Dashboard

An institutional-grade China & Hong Kong macro + equity research platform. A single
Node.js service serves both the API and the SPA from one port — ideal for one-click
Railway deploys. Purpose: produce specific, comprehensive equity/macro strategy papers
and investor presentations on the HK/China outlook, grounded in live data with full
provenance.

**Current status: live multi-source data, AI analysis suite, on-demand policy
monitoring, an investor-brain persona layer, a bottom-up sector/single-name equity
layer, a two-mode report engine (data-driven portfolio + thesis-driven critic), and a
full export engine (PDF + DOCX strategy paper + PPTX investor deck). Monthly/quarterly
automation is the remaining build phase.**

The defining principle: **every data point carries a provenance chip** — no stale
training data ever surfaces unlabeled.

### What's live
- **Data aggregation** across CEIC (primary, ~9.9k subscribed CN/HK/TW series), FRED,
  OECD, HKEX, EastMoney, AKShare (Python sidecar), Yahoo, Stooq, NBS, plus FactSet/
  Bloomberg CSV imports. A prioritized fallback cascade with a 24h cache.
- **Dashboard sections**: Overview, Investment/FAI, GDP & Energy, Fiscal, Equities,
  Equity Deep-Dive, K-Shape, PPI & Margins, Property, Outlook.
- **Analysis suite**: Trends (regime detection), Attribution (macro→equity, "not yet
  priced" flags), Scenarios (base/bull/bear + hit-rate), Brief (LLM market write-up).
- **Policy Tracker** (Phase 1): tech-skewed + macro policy/regulatory feed from 14
  official Chinese channels (State Council, PBoC, SAFE, MOF, NDRC, CSRC, MIIT, CAC,
  MOST, SAMR, MOFCOM, NEA, NFRA, Xinhua), sourced on-demand via Sonar Pro, classified
  + significance-scored, and linked to equity-market impact (policy→index/sector/name).
- **Investor-brain personas** (Phase 1): 20 strategists methodology-modeled (Pettis,
  Collier, Li Lu, Zhang Lei, Robin Xing, Larry Hu + global greats). Used as selectable
  lenses and a devil's-advocate red-team panel on the Brief.
- **Strategy reports + export** (Phases 3-4): two-mode composer (Data-Driven
  portfolio / Thesis-Driven critic), section-by-section long-form notes, a Report
  Vault archive, and one-click PDF / DOCX / PPTX export.
- **Automation** (Phase 5): scheduled monthly/quarterly report runs (refresh →
  house view → note → notify), Run-now / Refresh-now triggers, run history, and an
  in-app notification bell (+ optional email).
- **Cost guardrails + audit trail** on every paid call; provenance chips everywhere.

See `SPEC_PHASE1_POLICY_PERSONA_SONAR.md` for the policy/persona/Sonar design and the
roadmap toward strategy-paper + 45-minute-deck export.

---

## Stack

- **Frontend**: React 18 · Vite · TypeScript · Tailwind · shadcn/ui · Chart.js (with
  TimeScale + date-fns adapter) · Wouter (hash routing) · TanStack Query
- **Backend**: Express 5 · Node 20 · Drizzle ORM
- **Database**: Postgres (production) / PGlite embedded (local dev fallback) — same schema, same code path
- **AI**: Anthropic Claude (sonnet/haiku) + DeepSeek (chat/reasoner) for synthesis;
  Perplexity **Sonar Pro** for live web/news/policy pulls with citations
- **Sidecar**: Python AKShare service (separate Railway service) for EastMoney-blocked endpoints
- **Hosting**: Railway (Nixpacks builder; one Postgres plugin)

---

## Local development

```bash
npm install
npm run dev          # starts on :5000, auto-creates ./data.pgdata (PGlite)
```

If `DATABASE_URL` is set, it uses real Postgres. Otherwise it falls back to embedded PGlite.

Build & smoke-test production output:

```bash
npm run build
npm run start
curl http://localhost:5000/api/health
```

---

## Deploying to Railway from GitHub

### Step 1 — Push this folder to GitHub

```bash
cd china-monitor
git init
git add .
git commit -m "Phase 1: foundation"
git branch -M main
git remote add origin git@github.com:<your-username>/china-monitor.git
git push -u origin main
```

### Step 2 — Create a Railway project

1. Open [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo**
2. Select `china-monitor`
3. Railway auto-detects Node (via `railway.json`), runs `npm ci && npm run build`, then `npm run start`

### Step 3 — Add the Postgres plugin

1. In your Railway project, click **+ New** → **Database** → **Add PostgreSQL**
2. Railway auto-injects `DATABASE_URL` into your service — no manual wiring required
3. On the next deploy, `bootstrapSchema()` creates all tables idempotently at boot (additive, safe to re-run)

### Step 4 — Configure secrets

In the service **Variables** tab, add (leave blank for now if you don't have them yet — the Settings page can hold them instead):

| Variable | Purpose |
|---|---|
| `CEIC_API_KEY` | CEIC v2 API access |
| `SONAR_API_KEY` | Perplexity Sonar Pro |
| `ANTHROPIC_API_KEY` | Claude synthesis |
| `DEEPSEEK_API_KEY` | DeepSeek batch workloads |
| `NODE_ENV` | `production` (Railway sets this) |
| `AUTOMATION_TICK_TOKEN` | _(optional)_ shared secret enabling the external `POST /api/jobs/tick` trigger (send as `X-Tick-Token`). Leave unset to rely on the in-process 15-min loop. |
| `SMTP_URL` | _(optional)_ SMTP connection string to enable automation **email** notifications (e.g. `smtp://user:pass@host:587`). |
| `SMTP_FROM` | _(optional)_ From address for automation emails; required alongside `SMTP_URL`. |

The app prefers env vars over DB-stored keys, so secrets stay out of the database on production.

### Step 5 — Generate a public domain

1. Service **Settings** → **Networking** → **Generate Domain**
2. Visit the URL; the dashboard loads, `/api/health` returns `{ok: true}`

### Step 6 — Verify

- Open **Audit Trail** → 4 service cards show $0 of cap (CEIC $50, Sonar $20, Anthropic $30, DeepSeek $10)
- Open **Settings → API Keys** → keys saved here override env vars only if env is unset
- Push a commit to `main` → Railway auto-redeploys

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Railway service (single container)                 │
│  ┌───────────────────────────────────────────────┐  │
│  │  Express  (port $PORT)                        │  │
│  │  ├─ /api/*  (routes.ts)                       │  │
│  │  └─ static  (dist/public — SPA)               │  │
│  └────────────────┬──────────────────────────────┘  │
│                   │                                 │
│         ┌─────────┴──────────┐                      │
│         │  storage.ts        │  Drizzle ORM         │
│         │  dual driver       │                      │
│         └─────────┬──────────┘                      │
└───────────────────┼─────────────────────────────────┘
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
   Railway Postgres        ./data.pgdata
   (DATABASE_URL set)      (local dev)
```

### Schema (created by `bootstrapSchema()`)

| Table | Purpose |
|---|---|
| `api_keys` | Per-service key, masked display, test status |
| `settings` | Generic key/value JSON store (TTLs, display prefs) |
| `series_cache` | Multi-source series payload cache (24h TTL) |
| `api_call_log` | Every paid call — service, endpoint, tokens, $, latency |
| `cost_ceilings` | Monthly $/call cap per service, hard-stop flag |
| `watchlists` / `chart_configs` / `view_state` | Watchlists, chart state, UI persistence |
| `imported_series` | FactSet/Bloomberg CSV imports (override everything) |
| `scenarios` / `briefs` | Scenario sets and generated market briefs |
| `policy_updates` | Policy Tracker items + market linkage (Phase 1) |
| `house_view` / `strategy_notes` | Master house view + generated strategy papers (Phase 3) |

### Cost guardrails

Every paid API call passes through `checkCeiling(service)` before execution.

- If MTD spend ≥ cap **and** `hardStopEnabled` is true → call is blocked, logged with status `blocked_by_ceiling`
- One-click bump (`POST /api/ceilings/:service/bump`) raises the cap by $20 inline
- Linear EOM forecast: `mtdSpend / daysElapsed × daysInMonth`

### Provenance tags

Every data point on the dashboard carries a `<ProvenanceChip>` showing source:

`static` · `ceic` · `nbs` · `fred` · `oecd` · `hkex` · `eastmoney` · `akshare` · `yahoo` · `stooq` · `sonar` · `claude` · `deepseek` · `imported` · `user`

This is non-negotiable per the project brief: **no stale training data may surface without a `static` label.**

---

## Roadmap

### Shipped
- **Foundation**: UI shell, Settings, Audit Trail, cost guardrails, Postgres-everywhere
  schema with idempotent bootstrap.
- **Data**: live CEIC + FRED + OECD + HKEX + EastMoney + AKShare + Yahoo + Stooq + NBS
  cascade; FactSet/Bloomberg CSV imports; 24h series cache.
- **Analysis (Phase 3b)**: Trends, Attribution, Scenarios, Brief.
- **Phase 0 stabilization**: registered Chart.js TimeScale + date adapter and added a
  per-route error boundary (fixed the time-axis SPA crash).
- **Phase 1 — synthesis layer**:
  - Sonar Pro client (cost-tracked, cited) for live web/news/policy research.
  - Policy Tracker: 14 official channels, on-demand scan, significance scoring,
    policy→equity market linkage. Under DASHBOARD → `/policy`.
  - Investor-brain personas: selectable lenses + devil's-advocate red-team on the Brief.
- **Phase 2 — bottom-up equity** (see SPEC_PHASE2_EQUITY.md):
  - Sector universe: 6 themes (tech/EV/battery/semi/AI/consumer) × ~7 names (A-share+HK).
  - Sector Allocation page (`/sectors`): top-down theme → drill to names → spot
    valuation (P/E, P/B, mkt cap via AKShare) + live per-name catalysts (Sonar Pro).
  - Requires the AKShare sidecar redeployed for the new `/financials/valuation` endpoint.
- **Phase 3 — report engine** (see SPEC_PHASE3_REPORT_ENGINE.md):
  - House view: one master standing call + per-theme stances + append-only change-log.
  - Strategy Report page (`/report`, new REPORT nav group): two-mode composer —
    **Data-Driven** (AI builds a strategy + model portfolio from the evidence) and
    **Thesis-Driven** (AI stress-tests your thesis as a critic, with a verdict +
    contradicting evidence + corrections + alternatives). Long-form note generated
    section-by-section, each editable + regenerable; sources listed. Model selectable.
- **Phase 4 — export engine** (see SPEC_PHASE4_EXPORT.md):
  - One-click export of any strategy note to **PDF** (pdfmake) + **DOCX** (docx)
    institutional paper, and a mode-aware **PPTX** investor deck (pptxgenjs).
  - Charts rendered server-side to PNG (`@napi-rs/canvas`) and embedded; provenance
    captions + full source lists throughout. Neutral branding via `shared/brand.ts`.
  - `GET /api/report/:id/export?format=pdf|docx|pptx|csv`; Policy Tracker CSV export.
  - Activated `ExportMenu` on the Report page + Policy Tracker.
- **Report Vault**: browsable archive of past strategy notes (enriched list +
  delete) embedded on the Report page.
- **Phase 5 — automation** (see SPEC_PHASE5_AUTOMATION.md):
  - Automation page (`/automation`, REPORT nav group): enable a **monthly or
    quarterly** cadence (configurable day-of-month + UTC hour, shown in HKT) that
    runs the full pipeline — force-refresh the report's CEIC series (+ optional
    Sonar policy scan) → propose a house-view update (auto-apply opt-in) →
    generate a strategy note → notify.
  - Reuses the composer controls as scheduled defaults: mode, emphasis themes,
    featured names, synthesis model.
  - **Run now** (full report) and **Refresh data** (series only) manual triggers,
    plus a run-history table audited in `job_runs`.
  - In-app **notifications** with a header bell (unread badge, mark-read /
    mark-all-read); optional **email** delivery via SMTP (off until
    `SMTP_URL` + `SMTP_FROM` are set).
  - Idempotent scheduler: in-process 15-min tick loop at boot, plus a protected
    `POST /api/jobs/tick` endpoint (guarded by `AUTOMATION_TICK_TOKEN` /
    `X-Tick-Token`) for an external Railway cron or GitHub Action trigger. A
    `runningAt` lock + `nextRunAt` advance prevent double-runs.

### Maintenance fixes (2026-06)
- **Costs page** (`/costs`) now exists (route + page were missing): API spend by
  service/context, budget ceilings, recent-calls log — all from `/api/audit/*`.
- **Macro freshness via AKShare**: FRED's China PPI series is discontinued (stops
  2022) and CEIC lagged. Six macro series now pull **AKShare macro** first
  (sidecar `/macro/{cpi,ppi,pmi,m2,retail,exports}` → EastMoney/jin10, not
  US-IP-blocked): CPI, PPI, manufacturing PMI, M2 YoY, retail-sales YoY, and
  exports YoY. Verified against the latest NBS/PBoC prints. (Sidecar caches 24h,
  never caches empty results, and skips NaN values that would otherwise corrupt
  the JSON and zero out a series.)
- **Refresh UX**: `?force=true` on `/api/series/:id`, a reusable Refresh button +
  `useRefreshSeries()`, and provenance chips that now say **"NBS unavailable from
  host — using fallback"** instead of showing blank data.
- **Overview** rebuilt into an investor glance-view (macro pulse, equity snapshot,
  house view, policy headlines, latest note, calendar); removed the dev phase
  roadmap footer.
- **Automation Run-now** now links to the generated note on `/report`. Report
  export menu clarified to show it produces **PowerPoint deck · PDF · Word**.

### Known limitations
- **A-share valuation (PE/PB/mkt cap)** via the AKShare sidecar is currently
  unreliable: EastMoney push2 quote endpoints (`stock_individual_info_em`,
  `stock_zh_a_spot_em`) and the Legulegu indicator endpoint all return empty from
  Railway's egress IP, while the `cjsj` macro and `push2his` kline paths work.
  The endpoint degrades gracefully (returns nulls, no 502) but won't populate
  until the sidecar runs from a China-region host or a paid valuation source is
  wired in. Macro CPI/PPI and index OHLCV are unaffected.
- **Exports YoY** comes from AKShare's jin10 calendar series, which can lag a few
  months behind the latest customs release; CEIC (if subscribed) is fresher.
- Other NBS-sourced series not yet on the AKShare-macro path may still show "—"
  from the host; the same `akshareMacro` pattern can be extended to them.

### Next
- **Phase 6** — TBD.

---

## Troubleshooting

**`bootstrapSchema` errors on first deploy** — check `DATABASE_URL` is set and the Postgres plugin is attached. Railway sometimes needs a manual redeploy after attaching the plugin.

**Audit page shows `0 of $0 cap`** — `bootstrapSchema` failed to seed defaults. Restart the service; seed runs on every boot but only inserts if empty.

**API key "test" button shows "ok" without calling the provider** — currently a
length-check stub; live per-service ping tests are a pending polish item.

**Policy Tracker / lenses error with "No API key configured for sonar"** — set
`SONAR_API_KEY` on Railway (same value as your Perplexity API key) or save it on the
Settings page. Persona lenses/red-team need `ANTHROPIC_API_KEY` (or DeepSeek).

**Policy feed is empty** — by design, scans run on-demand (no background polling).
Click "Scan" on `/policy` to pull the latest items.

**Local PGlite data file is huge / corrupted** — safe to delete `./data.pgdata`; bootstrap recreates schema + defaults on next start.

**Equity valuation shows blank PE/PB/mkt cap** — the AKShare EastMoney/Legulegu
quote endpoints are blocked from the sidecar's egress IP (see Known limitations).
CPI/PPI macro and index OHLCV still work. Results are cached 24h, so after a
sidecar redeploy a previously-cached empty result clears on process restart.

---

## License

MIT
