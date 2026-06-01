# China Monitor — Dynamic Research Dashboard

A React + Express + Postgres dashboard for China macro & equity research. Built as a single Node.js service that serves both the API and the SPA from one port — ideal for one-click Railway deploys.

**Current status: Phase 1 (foundation) — UI shell, settings, audit trail, 8 dashboard sections seeded with the original static dataset.**

Live data integrations (CEIC, Sonar Pro, Anthropic, DeepSeek) ship in Phase 2/3.

---

## Stack

- **Frontend**: React 18 · Vite · TypeScript · Tailwind · shadcn/ui · Chart.js · Wouter
- **Backend**: Express 5 · Node 20 · Drizzle ORM
- **Database**: Postgres (production) / PGlite embedded (local dev fallback) — same schema, same code path
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
3. On the next deploy, `bootstrapSchema()` creates the 8 tables idempotently at boot

### Step 4 — Configure secrets

In the service **Variables** tab, add (leave blank for now if you don't have them yet — the Settings page can hold them instead):

| Variable | Purpose |
|---|---|
| `CEIC_API_KEY` | CEIC v2 API access |
| `SONAR_API_KEY` | Perplexity Sonar Pro |
| `ANTHROPIC_API_KEY` | Claude synthesis |
| `DEEPSEEK_API_KEY` | DeepSeek batch workloads |
| `NODE_ENV` | `production` (Railway sets this) |

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

### Schema (8 tables, all created by `bootstrapSchema()`)

| Table | Purpose |
|---|---|
| `api_keys` | Per-service key, masked display, test status |
| `settings` | Generic key/value JSON store (TTLs, display prefs) |
| `series_cache` | CEIC series payload cache (Phase 2) |
| `api_call_log` | Every paid call — service, endpoint, tokens, $, latency |
| `cost_ceilings` | Monthly $/call cap per service, hard-stop flag |
| `watchlists` | User-saved series watchlists (Phase 3) |
| `chart_configs` | Per-chart visualization state (Phase 3) |
| `view_state` | UI persistence (theme, last viewed page, filters) |

### Cost guardrails

Every paid API call passes through `checkCeiling(service)` before execution.

- If MTD spend ≥ cap **and** `hardStopEnabled` is true → call is blocked, logged with status `blocked_by_ceiling`
- One-click bump (`POST /api/ceilings/:service/bump`) raises the cap by $20 inline
- Linear EOM forecast: `mtdSpend / daysElapsed × daysInMonth`

### Provenance tags

Every data point on the dashboard carries a `<ProvenanceChip>` showing source:

`static` · `ceic` · `sonar` · `claude` · `deepseek` · `free` · `user`

This is non-negotiable per the project brief: **no stale training data may surface without a `static` label.**

---

## What ships in each phase

### Phase 1 ✅ (this commit)
- Full UI shell with sidebar + theme switcher
- 8 dashboard sections rendering the original static dataset
- Settings page (5 tabs)
- Audit trail page (per-service cards, per-feature attribution, EOM forecast, filterable call log, CSV export)
- Cost guardrails + audit logging
- Postgres-everywhere schema with idempotent bootstrap

### Phase 2 (next)
- CEIC live integrations: FAI, K-shape industrial production, PPI, property, A-shares, release calendar, exports
- Free-source supplements: Yahoo/Stooq (A-share indices), SMM/GFEX (lithium)
- Series cache with per-service TTL (configurable in Settings → Data Sources)

### Phase 3
- Series explorer with drill-down
- Forecast overlays
- User-defined watchlists
- AI insights feed: Sonar Pro for live web pulls, Claude for synthesis, DeepSeek for batch summarization
- Each AI call logs cost, model, tokens, latency — all in audit trail

### Future / deferred
- Cron-driven alerts on release calendar events
- Slack/email notifications on ceiling breach

---

## Troubleshooting

**`bootstrapSchema` errors on first deploy** — check `DATABASE_URL` is set and the Postgres plugin is attached. Railway sometimes needs a manual redeploy after attaching the plugin.

**Audit page shows `0 of $0 cap`** — `bootstrapSchema` failed to seed defaults. Restart the service; seed runs on every boot but only inserts if empty.

**API key "test" button shows "ok" without calling the provider** — that's intentional in Phase 1 (length check only). Phase 2 wires real ping tests per service.

**Local PGlite data file is huge / corrupted** — safe to delete `./data.pgdata`; bootstrap recreates schema + defaults on next start.

---

## License

MIT
