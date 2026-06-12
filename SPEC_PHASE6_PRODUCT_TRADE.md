# SPEC — Phase 6: HS-code / commodity-level product trade

Status: DRAFT for review. No build until approved.

## Goal
Add monthly, current, commodity-level China trade (export + import, value + YoY)
for the categories that drive the coverage themes, and **interlink** them into
the theme context so they surface in the strategy note and the 45-minute deck —
not just the dashboard.

Priority categories (from user): integrated circuits (chips), automobiles
(incl. EVs), machinery / electronics (mech-electrical), crude oil / energy.

## Why this is a separate build (recap)
- AKShare exposes **no** clean `macro_china_*` function for HS/commodity-level
  monthly trade (verified). Only aggregate totals (`macro_china_hgjck`).
- CEIC search API is denied on the current subscription (verified 403), so we
  can't discover HS-level series there either.
- The authoritative, free, current source is **GACC (China Customs)**:
  - English: english.customs.gov.cn/statics/report/monthly.html
    tables (13) "Major Export Commodities in Quantity and Value" and
    (14) "Major Import Commodities in Quantity and Value".
  - Chinese: customs.gov.cn statistical monthly ("重点商品量值表").
  - Mirrored/structured: cnopendata.com "China Customs Statistics" (by SITC,
    monthly: export value of month, import value of month, cumulative YoY %).
- GACC/EastMoney commodity data is reachable from the **HK sidecar** (China-
  friendly IP), not from Railway's US IP — so this lives on the sidecar.

## Data source decision (recommended)
Primary: a small set of AKShare/EastMoney commodity endpoints IF any return the
target rows from HK; otherwise a **GACC monthly-table parser** on the sidecar.
Before building, do a 1-deploy verification pass (debug probe, like we did for
macro) to confirm which of these actually return current data from HK:
  - ak.macro_china_hgjck companions, ak commodity functions (probe names)
  - GACC monthly HTML/Excel tables (13)/(14) — parse 集成电路 / 汽车 /
    机电产品 / 原油 rows.
  - Fallback: cnopendata structured customs dataset.

Decision rule: prefer a structured AKShare/EastMoney function if it returns the
target commodities current-to-latest-month; else parse GACC tables directly
(more robust to source longevity, but needs a parser per table layout).

## Sidecar endpoints (new)
`GET /trade/product?category=chips|autos|mech_electrical|energy&flow=export|import`
Returns: `{ category, flow, unit, data:[{date:'YYYY-MM', value, yoy}] }`
where `value` = monthly value (normalize to USD bn), `yoy` = monthly YoY %.
- NaN-safe, never-cache-empty (reuse the helpers already added).
- 24h cache per (category, flow).

Also a roll-up: `GET /trade/product/summary` → latest month for all 4 categories
both flows, for a compact dashboard panel.

## Registry + series (Node)
Add logical series (akshareMacro-style passthrough OR a new `productTrade`
source type). Proposed ids (YoY % unless noted):
  - chips_exports_yoy, chips_imports_yoy
  - autos_exports_yoy (EV split if GACC separates 电动载人汽车)
  - mech_electrical_exports_yoy
  - energy_imports_yoy (crude oil import value YoY) + crude_oil_import_volume
Optionally also *_value_usd_bn levels for charts.

## INTERLINK (the point of the build)
1. **Report theme context**: in server/report/context.ts (or wherever theme
   context is assembled), attach the relevant product-trade series to each theme:
     - semis theme  -> chips_exports_yoy + chips_imports_yoy
     - ev/auto theme -> autos_exports_yoy
     - tech/hardware -> mech_electrical_exports_yoy
     - energy/macro  -> energy_imports_yoy
   So the strategy note's sector sections cite live customs data ("IC exports
   +X% YoY, imports +Y%, signalling Z for the localization thesis").
2. **DEFAULT_BRIEF_DRIVERS / theme inputs**: add the headline product series so
   the macro/thematic digest and the deck pick them up. Confirm the automation
   refresh job force-refreshes them (it refreshes DEFAULT_BRIEF_DRIVERS).
3. **Deck**: ensure the export/pptx theme slides render a product-trade mini-table
   or chart per theme (semis slide shows IC trade, EV slide shows auto exports).

## Dashboard
- A "Product trade" panel on /sectors (or Overview Trade row): 4 categories ×
  (export/import) latest YoY, with sparklines. Each links to its theme.

## Verification (must do, like macro/trade)
Validate live values against the latest GACC release, e.g.:
  - IC exports YoY, auto exports YoY, mech-electrical exports YoY, crude import.
  (Recent reference: Jan-Nov 2025 IC exports +25.6%, autos +17.6%, mech-electrical
   +8.8% — confirm against the newest month at build time.)

## Risks / notes
- GACC table layouts change occasionally; the parser must be defensive and the
  endpoint must degrade gracefully (empty -> dashboard shows "—", report omits).
- Volume vs value: GACC gives both; we standardize on **value YoY** for cross-
  category comparability, with crude oil also carrying volume.
- Effort: medium. ~1 sidecar parser module + registry wiring + theme-context
  interlink + 1 dashboard panel + deck touch. Verification pass first.
