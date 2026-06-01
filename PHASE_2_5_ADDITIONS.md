# Phase 2.5 — Additional Data Sources

User locked the following additions on top of Phase 2 (NBS / Stooq / Yahoo + CEIC search/metadata):

## 1. AKShare Python sidecar (separate Railway service)

**Why**: AKShare is the single richest free China data source — 1,000+ interfaces wrapping EastMoney, Sina, Tencent, NBS, PBOC, Customs, China Index Academy.

**Approach**:
- Stand up a tiny FastAPI service `akshare-sidecar/` in the same repo (or a separate Railway service).
- Expose ~12 priority endpoints behind simple REST:
  - `/macro/cpi`, `/macro/ppi`, `/macro/m2`, `/macro/tsf`, `/macro/lpr`
  - `/macro/customs/exports`, `/macro/customs/imports`, `/macro/customs/balance`
  - `/property/index/70city`, `/property/sales/value`, `/property/sales/area`
  - `/equity/board_industry`, `/equity/board_concept` (sector rotation)
  - `/equity/north_money` (northbound Stock Connect flow)
  - `/equity/margin_balance` (margin balance SH+SZ)
  - `/equity/fund_flow` (sector fund flow)
- Cache 1h server-side (in-memory). Add a shared secret header for auth between the main app and the sidecar.
- Deploy as second Railway service. The main app calls it via internal Railway DNS or a public URL with the shared secret.

**Registry**:
- Add `akshare:` source option to `server/series/registry.ts`. Source priority becomes: `akshare > nbs > yahoo > stooq > ceic-search`.
- AKShare is a hard dependency for Stock Connect flows + sector rotation + property index — no other free source has these.

## 2. OECD SDMX + UN Comtrade (direct from Node)

**Why**: OECD SDMX is the cleanest free macro source for cross-country comparability. UN Comtrade fills the 23-series trade matrix with HS-2 × partner detail that AKShare doesn't have at the same granularity.

**OECD SDMX**:
- Base: `https://sdmx.oecd.org/public/rest/data/`
- Endpoints: GDP, CPI, IP, leading indicators for CN
- Format: JSON (`?format=jsondata`)
- No auth, free.
- Add as `server/clients/oecd.ts`.

**UN Comtrade**:
- Base: `https://comtradeapi.un.org/data/v1/get/`
- Free tier: 100 calls/day with no key, 250/hour with free API key.
- Returns HS-2 trade flow by reporter (CN) × partner × direction.
- Add as `server/clients/comtrade.ts`. Add `UN_COMTRADE_API_KEY` to Settings.

## 3. FactSet — XLSX/CSV import flow (NO API)

**User constraint**: FactSet subscription on workstation only, NO API access. Must support manual export → upload path.

**Approach**:
- Add `client/src/pages/Imports.tsx` — new sidebar item "Data Imports".
- User exports an FQL formula sheet from FactSet Workstation as XLSX, drops it on the import page.
- Backend parses with `xlsx` library, validates against expected column shape, stores time points in `series_cache` with `source: "factset"` and `subscribed: true`.
- Provide a template XLSX (`/templates/factset_macro.xlsx`) the user can use as starting point — pre-formatted with: `series_id, series_label, date, value, source_mnemonic, unit, frequency`.
- Imported series get registered under `factset:` source in registry. Source priority bumps to `factset > akshare > nbs > yahoo > stooq > ceic-search` because user-imported data is highest fidelity.
- Settings: "Last FactSet import: <timestamp>" + button "View imported series" (count by category).

**Implementation files**:
- `server/clients/factsetImport.ts` — XLSX parser + storage write
- `server/routes.ts` — `POST /api/imports/factset` (multipart upload), `GET /api/imports/factset/history`
- `client/src/pages/Imports.tsx` — drag-drop UI + history table + template download
- `client/src/components/Sidebar.tsx` — add "Imports" entry

## 4. EastMoney direct endpoints (no AKShare dependency)

**Why**: EastMoney's public JSON endpoints are fast (no scrape latency) and don't need a Python sidecar for the few highest-value indicators.

**Endpoints to wire**:
- `http://push2.eastmoney.com/api/qt/stock/get?secid=...` — real-time A-share quote
- `http://push2his.eastmoney.com/api/qt/stock/kline/get?secid=...` — A-share historical OHLC
- `http://push2.eastmoney.com/api/qt/clist/get?fs=m:1+t:2,m:1+t:23&fields=...` — Stock Connect flows
- `http://datacenter.eastmoney.com/api/data/v1/get?reportName=RPT_MARGIN_TOTALLEND&...` — margin balance
- `http://push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:2&fields=...` — sector rotation top movers

**Implementation**:
- `server/clients/eastmoney.ts` — small client, browser User-Agent, no auth.
- Cache 5m intraday (markets move fast).
- Add to registry as fallback for AKShare-only series (if sidecar is unreachable).
- Free, audit-log only (no cost ceiling).

## Build order (after Phase 2 lands)

1. **EastMoney direct** first (fastest, no sidecar required). 1 hour.
2. **OECD SDMX + UN Comtrade** next (pure Node, no sidecar). 1.5 hours.
3. **FactSet import flow** (UI + parser + template). 2 hours.
4. **AKShare sidecar** last (requires Railway second-service setup). 2 hours.

Total estimated time: ~6.5 hours of subagent work.

## Cost ceiling additions

- AKShare: free, audit-only, no ceiling.
- OECD: free, audit-only, no ceiling.
- UN Comtrade: free with key, audit-only, optional 250-calls/hour rate limit guard.
- FactSet imports: free at our end, audit-only.
- EastMoney: free, audit-only, no ceiling.

Existing ceilings ($50 CEIC + 5000 calls, $20 Sonar, $30 Anthropic, $10 DeepSeek) remain unchanged.

## Settings page additions for Phase 2.5

- "AKShare sidecar URL" field + connection test button
- "UN Comtrade API key" field (optional)
- "FactSet imports" section with last-import timestamp + series count
- "EastMoney" toggle (on/off, default on)
