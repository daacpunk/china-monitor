# Fix session — diagnosis ground truth (2026-06-11)

Live URL: https://china-monitor-production.up.railway.app
Repo: daacpunk/china-monitor (main). Railway auto-deploys on push.
Git author: China Monitor Build <build@china-monitor.dev>

## Confirmed findings

### #5 Costs page DOWN — ROOT CAUSE
- Nav has `/costs` (Layout.tsx line 52) but **App.tsx has NO `/costs` route and there is NO Costs.tsx page**.
- Cost data IS live: `GET /api/audit/summary` returns:
  `{ yearMonth, byService:[{service,total,calls}], byContext:[{actionContext,service,total,calls}] }`
  e.g. anthropic $0.99/90 calls, ceic $0.83/805, sonar $0.23/21 (month 2026-06).
- Also available: `GET /api/audit/log` (raw rows), `GET /api/audit/log.csv`, `GET /api/ceilings` (budget caps), `POST /api/ceilings/:service/bump`.
- FIX: build `client/src/pages/Costs.tsx` + register `/costs` in App.tsx.

### #4 Trends: PPI empty, CPI stale — ROOT CAUSE
- `/api/series/ppi_yoy` → empty. `/api/series/cpi_yoy` → last point 2024-12 (stale).
- registry.ts: both have ceic + nbs + fred fallbacks.
  - ppi_yoy fred id = `CHNPPIINDUSTRY` → **INVALID (FRED 400)**. The real China PPI YoY series `CHNPIEATI01GYM` is **discontinued at Dec 2022**. So FRED is NOT a usable PPI source.
  - cpi_yoy fred id = `CHNCPIALLMINMEI` → VALID, current to 2025-04 (index, units pc1 = YoY%).
- fetchSeries.ts cascade returns on FIRST non-empty source. CEIC returns stale CPI (2024-12) so it never falls through to FRED.
- FIX (two parts):
  1. Staleness-aware fallback: if a source's latest point is older than N months (e.g. 4), keep trying lower-priority sources and pick the FRESHEST non-empty result.
  2. PPI needs a live source. FRED dead. Best bet = AKShare sidecar macro endpoint (ak.macro_china_ppi / ak.macro_china_cpi_monthly) which pulls from NBS/Eastmoney and runs from the sidecar host (not US-IP-blocked). Add `/macro/ppi` + `/macro/cpi` to the sidecar and wire as a source. (Handled by main agent.)

### #3 AKShare valuation/sectors 502 — ROOT CAUSE
- Sidecar healthy (`/api/akshare/health` ok, akshare 1.18.64, auth ok).
- `/financials/valuation` (ak.stock_individual_info_em) → 502 "Expecting value: line 1 column 1 (char 0)" = EastMoney returned empty/HTML. AKShare-version upstream breakage.
- `/sector/flows` (ak.stock_sector_fund_flow_rank) → same 502.
- Sidecar source: `akshare-sidecar/main.py` (separate Railway service, deploys from this repo).
- FIX (main agent): pin/upgrade akshare, add retries/user-agent, or swap to working ak functions. Needs live iteration.

### #2 Overview page thin + dev footer — ROOT CAUSE
- `client/src/pages/Overview.tsx` renders dev roadmap badges "Phase 1 — done / Phase 2 — live / Phase 3" (lines ~272-296) and "Phase 2 · live data" (line 143). Remove these.
- Rebuild into investor glance-view: macro pulse (cpi/ppi/pmi_mfg/m2_yoy with latest value+delta+sparkline), equity snapshot (csi300_close/chinext_close/hsi_close latest + %chg), house view + conviction (GET /api/house-view), top policy headlines (GET /api/policy/feed), sector tilts (GET /api/equity/universe or /api/akshare/sectors), latest strategy note (GET /api/report?limit=1), upcoming data calendar (GET /api/calendar/upcoming), data-freshness strip.

### #1 Refresh UX + provenance
- No global refresh button on data pages. Series responses include `provenance:{source,lastUpdated,subscribed,cacheHit,error}`.
- Add: a reusable refresh button (calls endpoints with force/refetch) + a provenance/freshness chip component that shows source + "NBS unavailable from this host" when source falls back or errors.
- NBS returns 403 from Railway US IPs — expected. Surface this clearly instead of blank.

### #6/#7 Automation output + presentations
- Run-now (`POST /api/automation/run-now`) returns `{noteId, status}`. Output = strategy note shown on /report (+ Report Vault). NOT shown on /automation.
- FIX #6: after Run-now success, link/navigate to `/report` for that noteId (toast already shows Note #N — add a "View report" action).
- Deck/PPTX is generated on /report via ExportMenu → `/api/report/:id/export?format=pptx`. Not produced by Run-now, no gallery.
- FIX #7: optionally auto-generate deck after scheduled run; add a "Presentations/Exports" awareness on the report (or vault) so user knows where decks come from.

## Useful series ids
macro: cpi_yoy, ppi_yoy, pmi_mfg, m2_yoy, iva_yoy, retail_sales_yoy, exports_yoy, usdcny_monthly, new_home_prices_70city, oecd_cli_china
equity: csi300_close, shc_close, szi_close, chinext_close, star50_close, hsi_close (monthly: csi300_monthly, chinext_monthly, hangseng_monthly)
cross-asset: dxy_index, us10y_yield, brent_crude, copper_lme, vix_index

## Test/build conventions
- tsc: `npx tsc --noEmit`. Build: `npm run build`.
- Local run: `rm -rf ./data.pgdata` (schema change), then start with bash background=true:
  `PORT=505X NODE_ENV=production node dist/index.cjs` (DO NOT use the `(cmd &)` subshell form — process dies).
- Verify via Playwright in js_repl (use FRESH var names each call; ctx persists).
- Kill: `ps aux | grep "dist/index.cjs" | grep -v grep | awk '{print $2}' | xargs -r kill` (NOT pkill).
- Deploy detect: live bundle `curl -s URL | grep -o 'index-[A-Za-z0-9]*\.js'` vs `ls dist/public/assets/index-*.js`. Server-only changes don't change bundle hash. Railway ~3-5 min.
- UI primitives in client/src/components/ui/: card, badge, button, switch, input, popover, scroll-area, skeleton. PageHeader supports title/subtitle/meta/actions. apiRequest(method,path,body) + queryClient in @/lib/queryClient. useToast in @/hooks/use-toast.
