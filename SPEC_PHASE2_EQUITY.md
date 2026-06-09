# China Monitor — Phase 2 Spec: Bottom-Up Equity Layer

Status: DRAFT FOR REVIEW
Serves: top-down sector allocation (tech/EV/battery/semi/AI/consumer) → single names,
feeding the eventual strategy paper + 45-min deck.

## What already exists (build on, don't duplicate)
- Equity Deep-Dive page: single-name OHLCV + annual income statement (AKShare sidecar),
  with A-share + HK presets (Moutai, CATL, BYD, SMIC, Tencent, Alibaba, etc.).
- Sidecar endpoints: ashare/hk/index historical, sector flows, financials/income.
- Equity index series: csi300_close, shc_close, szi_close, chinext_close, star50_close,
  hsi_close. Stock Connect flows, margin balance, sector rotation (existing pages).

## The gap (what Phase 2 adds)
1. **Sector universe** — a curated, version-controlled map of the 6 coverage themes →
   constituent single names (A-share + HK), each tagged with role (leader/challenger/
   supplier) and a one-line thesis hook. This is the top-down → bottom-up bridge.
2. **Valuation snapshot** — spot P/E, P/B, market cap, dividend yield per name. New
   sidecar endpoint via AKShare (e.g. stock_a_indicator / stock_individual_info), with
   graceful fallback (income-only if valuation unavailable).
3. **Sector Allocation page** (`/sectors`) — top-down theme cards (index proxy, momentum,
   policy linkage from Phase 1 Policy Tracker) → drill into constituent names → per-name
   price + valuation + financials + Sonar catalyst pull. "Send to report" selection.
4. **Name catalyst pull** — reuse Sonar (name_news template) for per-name recent
   catalysts/earnings, cited.

## Data model

```ts
type CoverageTheme = "tech" | "ev" | "battery" | "semi" | "ai" | "consumer";

interface SectorName {
  symbol: string;          // A-share 6-digit or HK 5-digit
  market: "ashare" | "hk";
  nameEn: string;
  nameZh: string;
  role: "leader" | "challenger" | "supplier" | "platform";
  thesis: string;          // one-line hook
  indexProxy?: string;     // series id the name belongs under
}

interface SectorTheme {
  id: CoverageTheme;
  label: string;
  indexProxies: string[];  // e.g. semi -> [star50_close, chinext_close]
  drivers: string[];       // structural + policy drivers
  names: SectorName[];
}
```

## Backend
- `server/equity/universe.ts` — the SectorTheme[] dataset (curated; see below).
- Sidecar `/financials/valuation?symbol=` — spot valuation metrics.
- `server/clients/akshare.ts` — getAkshareValuation().
- Routes: GET /api/equity/universe, GET /api/equity/valuation/:symbol,
  POST /api/equity/name-catalysts (Sonar name_news).

## Frontend
- `/sectors` Sector Allocation page under DASHBOARD (near Equities).
- Theme cards → name table (price chg, P/E, P/B, mkt cap) → name drawer
  (chart + financials + catalysts). Provenance chips throughout.

## Proposed sector universe (FOR YOUR REVIEW — edit freely)
Tech/Internet/AI overlap intentionally; names can appear under multiple themes.

- **semi**: SMIC (688981), Hua Hong (688347/01347), NAURA (002371), AMEC (688012),
  Cambricon (688256), Will Semi (603501), Montage (688008); HK/ADR: SMIC (00981).
- **ai**: iFlytek (002230), Cambricon (688256), Baidu (09888/BIDU), Alibaba (09988),
  Tencent (00700), SenseTime (00020), Kingsoft (03888), Beijing Fourth Paradigm (06682).
- **ev**: BYD (002594/01211), Li Auto (02015/LI), XPeng (09868), NIO (09866),
  Geely (00175), Great Wall (601633), Seres (601127).
- **battery**: CATL (300750), EVE Energy (300014), Gotion (002074), Sunwoda (300207),
  BYD (battery arm), CALB (03931); materials: Ganfeng (002460), Tianqi (002466).
- **tech (platform/hardware)**: Tencent (00700), Alibaba (09988), Meituan (03690),
  Xiaomi (01810), Lenovo (00992), Luxshare (002475), Foxconn Industrial (601138).
- **consumer**: Kweichow Moutai (600519), Wuliangye (000858), Midea (000333),
  Haier (06690), Anta (02020), Li Ning (02331), Nongfu Spring (09633), Mengniu (02319).

## Open questions
1. Universe: keep this list, add/remove names, or want it broader (e.g. 10-15 per theme)?
2. Markets: A-share + HK as above, or include US ADRs explicitly as a third market?
3. Valuation source: AKShare spot metrics OK, or do you want CEIC/FactSet valuations
   to take priority when available (consistent with the data cascade)?
```
