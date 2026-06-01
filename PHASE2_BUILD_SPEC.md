# Phase 2 Build Spec — China Dynamic Research Dashboard

## Goal
Wire **all 8 dashboard pages** to **live data** from a mix of CEIC (search/metadata only) and **free public sources** (NBS direct, Stooq, Yahoo Finance, TradingEconomics calendar, China Customs). Build the architecture so CEIC data fetches **flip on automatically** when the user attaches subscriptions to their key.

## Constraints (verbatim from user)
- "no data should be based on training data/stale data, must be all based on factual / updated data or web information"
- "cost guardrails are important — set up an audit trail page to cover all of these costs, including API calls to all models, including CEIC; bake in a cost ceiling too"
- "make sure the system saves past saves and edits so that it doesn't restart completely each time the page is opened" (Postgres already persists; keep it that way)
- 24h cache TTL default

## CEIC API contract (CONFIRMED via discovery probe — DO NOT re-discover)

### Auth
- `Authorization: <RAW_KEY>` header (NO `Bearer ` prefix) **OR** `?token=<KEY>` query param. We use the query param for simplicity.

### Base URL
- `https://api.ceicdata.com/v2`

### Endpoints that work for current key (search/metadata)
- `GET /series/search?format=json&country=CN&keyword=...&token=...&limit=...` → returns `{ data: { total, items: [{ subscribed, metadata: { id, name, frequency, source, country, indicator, classification, unit, ... } }] } }`
- `GET /dictionary/countries?format=json&token=...` → list of `{ id, name }`
- `GET /dictionary/indicators?format=json&token=...` → list of `{ id, name, classificationId }`
- `GET /dictionary/sources?format=json&token=...` → list of `{ id, name, countryId }`
- `GET /dictionary/classifications?format=json&token=...`

### Endpoints that exist but return UNSUBSCRIBED_SERIES with current key
- `GET /series/{id}?format=json&token=...` → metadata for ONE series
- `GET /series/{id}/data?format=json&token=...&count=N` → time series data
- Response shape on no subscription: `{ "data": [], "errors": [{ "status": 403, "code": "UNSUBSCRIBED_SERIES", "message": "Your current subscriptions do not include the `<id>` series." }] }`

### Key insight
- Current user key has **no series subscriptions**. Search/metadata cost $0 spend per CEIC call cap accounting, but DO NOT call data endpoints in production until subscription is attached (they always fail).
- Build the data fetcher with `subscribed: false` detection in the search response → mark series as "not subscribed" in our cache + audit so the UI can show provenance correctly.
- Architecture must be ready to flip on: when a future call returns valid `time_points`, render the chart from CEIC data; otherwise fall back to the free source.

## File structure to add

```
server/
  clients/
    ceic.ts          # CEIC client — search, metadata, getSeriesData with subscription detection
    nbs.ts           # NBS data.stats.gov.cn client
    stooq.ts         # Stooq free CSV downloader (A-shares, indices)
    yahoo.ts         # Yahoo Finance v8 chart API (free, no auth)
    calendar.ts      # Macro release calendar — hard-coded NBS/PBOC/Customs schedule
  series/
    registry.ts      # Series catalog — maps logical id ("ppi_yoy") → { ceicId, nbsCode, fallback }
    fetchSeries.ts   # Unified fetch — tries CEIC, falls back to free, caches, audits
shared/
  series.ts          # Series types shared FE/BE
```

## Free-source mappings (USE THESE NOW; CEIC is fallback for future)

### NBS (data.stats.gov.cn)
- **API base**: `https://data.stats.gov.cn/easyquery.htm`
- **Method**: `GET ?m=QueryData&dbcode=hgyd&rowcode=zb&colcode=sj&wds=[]&dfwds=[{"wdcode":"zb","valuecode":"<NBS_CODE>"}]`
- **dbcode**: `hgyd` = monthly national, `hgjd` = quarterly national, `hgnd` = annual national
- **Common codes** (verify in build):
  - PPI all industry YoY: `A07010101`
  - CPI YoY: `A01010101`
  - Industrial value-added YoY: `A02010101`
  - FAI total YTD: `A05010101`
  - FAI real estate YTD: `A05010M01`
  - FAI manufacturing YTD: `A05010K01`
  - Retail sales YoY: `A07010101`
- Response is JSON but mangled — needs careful parse (returns `returndata.datanodes[]` with `code`, `data[].data`).
- **Headers required**: `User-Agent: Mozilla/5.0 ... Chrome` (NBS blocks default Node UA)
- **No auth needed**.

### Stooq (stooq.com)
- **CSV endpoint**: `https://stooq.com/q/d/l/?s=<symbol>&i=d` (daily) or `i=m` (monthly)
- Symbols for China:
  - `shc` = Shanghai Composite
  - `szi` = Shenzhen Composite
  - `csi300` = CSI 300
  - `chinaa50` = FTSE China A50
  - `hsi` = Hang Seng
- Response: CSV `Date,Open,High,Low,Close,Volume`
- **No auth needed**.

### Yahoo Finance (query1.finance.yahoo.com)
- **JSON endpoint**: `https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>?interval=1d&range=2y`
- China tickers:
  - `000001.SS` = Shanghai Composite
  - `399001.SZ` = Shenzhen Composite
  - `^HSI` = Hang Seng
  - `000300.SS` = CSI 300
- Response: `chart.result[0].timestamp[]` + `chart.result[0].indicators.quote[0].close[]`
- **No auth**, but include a browser-like User-Agent.

### Macro release calendar
- Hard-code the next 90 days of releases (NBS monthly PMI on 1st, CPI/PPI ~9th, retail/IP/FAI ~15th, GDP quarterly, PBOC LPR 20th, Customs trade ~7th).
- Future enhancement: TradingEconomics calendar API (free tier with key).

## Frontend wiring

For each of the 8 pages (Overview, Investment, Gdp, Fiscal, Equity, KShape, Margins, Property, Outlook), replace static `DATA.<key>` references with React Query hooks pulling from `/api/series/<logical_id>`.

### New API surface
- `GET /api/series/:logicalId?range=24m&count=24` → unified series fetch (cache-first, CEIC then free-source fallback)
- `GET /api/series/:logicalId/provenance` → `{ source: "ceic"|"nbs"|"stooq"|"yahoo"|"static", lastUpdated, subscribed, cacheHit }`
- `GET /api/calendar/upcoming?days=30` → next macro releases
- `GET /api/ceic/search?q=...&country=CN&limit=20` → CEIC search proxy (for Phase 3 series explorer; ship behind feature flag now)

### Provenance chips
Add `<ProvenanceChip source="ceic|nbs|stooq|yahoo" lastUpdated="2026-06-01T..." cacheHit={true}>` next to every chart and stat card. Component already exists at `client/src/components/ProvenanceChip.tsx` — extend it to accept source + lastUpdated.

## Watchlists locked (117 series — see `/home/user/workspace/ceic_watchlist_proposal.md`)

Phase 2 wires the **27 hero series** mapped to the 8 page sections + 23 trade detail series. The remaining ~67 sit in the registry but render lazily.

### Hero series (Phase 2 must wire all of these)
1. **Investment / FAI** — total YTD, real estate, manufacturing, infrastructure, high-tech mfg, equipment
2. **K-shape** — IVA: hi-tech mfg vs traditional mfg vs mining (monthly)
3. **Margins** — PPI all industry, PPI mfg, PPI mining, PPI consumer goods
4. **Property** — new home prices 70-city, property FAI, new starts, completed area
5. **Equity** — SHC, SZI, CSI 300, HSI, ChiNext, STAR50 — daily close + turnover
6. **GDP** — quarterly GDP YoY, GDP by industry split (primary/secondary/tertiary)
7. **Fiscal** — fiscal revenue YoY, expenditure YoY, LGFV bond issuance (proxy via TSF)
8. **Outlook** — release calendar next 30d + PMI manufacturing + PMI services

### Trade module (23 series, all Customs / NBS sourced, fall back to free for now)
- 3 headline: total exports USD, total imports USD, trade balance USD
- 12 HS-2 × 2 directions: HS 84 (machinery), 85 (electronics), 87 (vehicles), 27 (mineral fuels), 71 (precious metals), 39 (plastics) — exports + imports for each
- 8 partners: US, EU, ASEAN, Japan, Korea, Russia, Taiwan, HK

For Phase 2: stub the trade module with the headline 3 from China Customs free API + UN Comtrade where possible; full 23-series matrix lights up when CEIC data subscriptions arrive.

## Cost behavior

- Every CEIC search call: `recordCall({ service: "ceic", endpoint: "/series/search", costUsd: 0.01, actionContext: "<page_id>" })`. Honors $50 / 5000-call ceiling.
- Free-source calls (NBS, Stooq, Yahoo): logged with `costUsd: 0` for visibility but DO NOT increment ceiling.
- All paid calls go through: `checkCeiling() → cache.get() → fetch → cache.set(24h TTL) → recordCall()`

## Settings page additions

- **Data source toggle** per series category: `[CEIC] [Free] [Auto]` — default "Auto" (CEIC primary, fall back to free on UNSUBSCRIBED).
- **CEIC subscription health** card — shows count of subscribed vs unsubscribed series in cache + a button "Test CEIC data access" that fetches one known series and reports the result.
- **Cache management** — "Clear all cached series", "Last cache sweep: X" — Phase 1 already has schema, just expose the buttons.

## Deployment

1. Build locally with `npm run build` — must succeed cleanly.
2. Commit on `main`, push via GitHub connector (`gh` CLI with `api_credentials=["github"]`).
3. Railway auto-redeploys.
4. Smoke test: `curl https://china-monitor-production.up.railway.app/api/health` and `/api/series/ppi_yoy` should return live data within ~3 minutes of push.

## Cleanup before final commit

- `/api/_probe/ceic` route — REMOVED (already done)
- `server/ceicProbe.ts` — DELETED (already done)
- `CEIC_PROBE_TOKEN` env var — instruct user to remove from Railway after deploy succeeds

## DO NOT change
- `client/src/lib/queryClient.ts` (__PORT_5000__ rewrite)
- `vite.config.ts`, `server/vite.ts`
- Schema fields for existing tables (additive only)
- Existing 8 page routes / sidebar
- Phase 1 cost ceilings ($50 CEIC + 5000 calls, $20 Sonar, $30 Anthropic, $10 DeepSeek)
