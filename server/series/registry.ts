/**
 * Series registry — maps logical IDs to data sources.
 *
 * Priority order (Phase 2.5, post-discovery):
 * 1. CEIC (paid, key has 246 subscribed China/HK/TW series — highest accuracy)
 * 2. NBS direct (free, BLOCKED from Railway US IPs — keep for self-hosted later)
 * 3. FRED (free, OECD/Caixin republications — fallback for major macro)
 * 4. EastMoney (free, China retail finance — equity flows/sectors)
 * 5. Yahoo Finance (free, equity indices)
 * 6. Stooq (free, A-share alternative)
 *
 * Phase 2.5 change: CEIC promoted from search-only to PRIMARY for series with
 * direct seriesId mapping (`ceic.seriesId`). Falls back to FRED/Yahoo if CEIC fails.
 */

export type DataSourceName = "ceic" | "nbs" | "fred" | "eastmoney" | "yahoo" | "stooq" | "pending";
export type SeriesCategory =
  | "fai"
  | "margins"
  | "kshape"
  | "property"
  | "equity"
  | "gdp"
  | "fiscal"
  | "trade"
  | "macro";

export interface CeicConfig {
  /** Direct CEIC series ID — set if confirmed subscribed (preferred). */
  seriesId?: number;
  /** Fallback keyword search if seriesId not set. */
  searchKeyword: string;
  country?: string;
  /**
   * Optional value transform applied to CEIC raw values before storage.
   *   "raw" (default) — use value as-is
   *   "yoy"           — compute YoY % from monthly levels (if CEIC returns levels)
   *   "divide_1000"   — divide by 1000 (e.g. USD mn → USD bn)
   */
  transform?: "raw" | "yoy" | "divide_1000";
}

export interface NbsConfig {
  dbcode: "hgyd" | "hgjd" | "hgnd";
  code: string;
}

export interface YahooConfig {
  ticker: string;
  interval?: "1d" | "1wk" | "1mo";
  range?: string;
}

export interface StooqConfig {
  symbol: string;
  rangeDays?: number;
}

/**
 * FRED (St. Louis Fed) series config.
 * Free API key required: fred.stlouisfed.org/docs/api/api_key.html
 * Set FRED_API_KEY env var on Railway.
 */
export interface FredConfig {
  seriesId: string;
  /**
   * Optional FRED units transform:
   *   "lin"  = raw levels (default)
   *   "pc1"  = percent change from year ago (YoY)
   *   "pch"  = percent change (MoM)
   * See: https://fred.stlouisfed.org/docs/api/fred/series_observations.html
   */
  units?: "lin" | "pc1" | "pch" | "chg";
}

/**
 * EastMoney (东方财富) free-API config — direct A-share/HK flow data.
 * Each client function returns a richer payload than a single TimePoint stream,
 * so the registry picks ONE field as the canonical TimePoint value, and the
 * route layer continues to expose the full payload for richer UI.
 */
export interface EastMoneyConfig {
  clientFn:
    | "getStockConnectFlow"
    | "getMarginBalance"
    | "getSectorPerformance";
  /**
   * Which field of the row to map into TimePoint.value.
   *   - getStockConnectFlow: "totalInflow" | "shanghaiInflow" | "shenzhenInflow"
   *   - getMarginBalance:    "rzrqye" | "rzye" | "rqye"
   *   - getSectorPerformance: not time-series (snapshot only) — leave undefined
   */
  valueField?: string;
  /** Optional value scale (e.g. CNY → CNY billions). */
  divideBy?: number;
}

export interface SeriesEntry {
  label: string;
  unit: string;
  category: SeriesCategory;
  fallback: DataSourceName;
  ceic?: CeicConfig;
  nbs?: NbsConfig;
  fred?: FredConfig;   // FRED fallback when NBS is unreachable (overseas IP)
  eastmoney?: EastMoneyConfig;
  yahoo?: YahooConfig;
  stooq?: StooqConfig;
  notes?: string;
}

export const REGISTRY: Record<string, SeriesEntry> = {
  // ─── Fixed Asset Investment ────────────────────────────────────────────────
  fai_total_ytd: {
    label: "FAI Total YTD YoY %",
    unit: "%",
    category: "fai",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A05010101" },
    fred: { seriesId: "CHNFAIYOY", units: "lin" },
    ceic: { searchKeyword: "Fixed Asset Investment Total", country: "CN" },
    notes: "FAI not in CEIC subscribed China set; FRED/NBS only",
  },
  fai_real_estate_ytd: {
    label: "FAI Real Estate YTD YoY %",
    unit: "%",
    category: "fai",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A05010M01" },
    ceic: { searchKeyword: "Real Estate Investment", country: "CN" },
    notes: "Real estate development investment, YTD YoY",
  },
  fai_manufacturing_ytd: {
    label: "FAI Manufacturing YTD YoY %",
    unit: "%",
    category: "fai",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A05010K01" },
    ceic: { searchKeyword: "Manufacturing Fixed Asset Investment", country: "CN" },
  },
  fai_infra_ytd: {
    label: "FAI Infrastructure YTD YoY %",
    unit: "%",
    category: "fai",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A05010201" },
    ceic: { searchKeyword: "Infrastructure Investment China", country: "CN" },
    notes: "Excludes electric power & heating",
  },
  fai_hitech_ytd: {
    label: "FAI High-tech Manufacturing YTD YoY %",
    unit: "%",
    category: "fai",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A05010L01" },
    ceic: { searchKeyword: "High Tech Manufacturing Investment", country: "CN" },
  },

  // ─── Prices / Margins ─────────────────────────────────────────────────────
  ppi_yoy: {
    label: "PPI YoY %",
    unit: "%",
    category: "margins",
    fallback: "ceic",
    ceic: { seriesId: 313572201, searchKeyword: "Producer Price Index", country: "CN" },
    nbs: { dbcode: "hgyd", code: "A07010101" },
    fred: { seriesId: "CHNPPIINDUSTRY", units: "pc1" },
    notes: "CEIC: Producer Price Index: YoY: Monthly: China (id=313572201).",
  },
  cpi_yoy: {
    label: "CPI YoY %",
    unit: "%",
    category: "macro",
    fallback: "ceic",
    ceic: { seriesId: 249097301, searchKeyword: "Consumer Price Index China", country: "CN" },
    nbs: { dbcode: "hgyd", code: "A01010101" },
    fred: { seriesId: "CHNCPIALLMINMEI", units: "pc1" },
    notes: "CEIC: Consumer Price Index: YoY: Monthly: China (id=249097301).",
  },

  // ─── Industrial Value Added (K-Shape) ─────────────────────────────────────
  iva_yoy: {
    label: "Industrial Value Added YoY %",
    unit: "%",
    category: "kshape",
    fallback: "ceic",
    ceic: { seriesId: 314953101, searchKeyword: "Industrial Production Index China", country: "CN" },
    nbs: { dbcode: "hgyd", code: "A02010101" },
    fred: { seriesId: "CHNPROINDMISMEI", units: "pc1" },
    notes: "CEIC: Industrial Production Index: YoY: Monthly: China (id=314953101).",
  },

  // ─── Retail / Consumption ─────────────────────────────────────────────────
  retail_sales_yoy: {
    label: "Retail Sales YoY %",
    unit: "%",
    category: "macro",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A06010101" },
    ceic: { searchKeyword: "Total Retail Sales of Consumer Goods", country: "CN" },
  },

  // ─── PMI ──────────────────────────────────────────────────────────────────
  pmi_mfg: {
    label: "PMI Manufacturing",
    unit: "index",
    category: "macro",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A01160101" },
    // FRED: CHNMFGPMI = Caixin Manufacturing PMI for China (monthly)
    // Note: Caixin PMI (private sector) vs NBS PMI (all firms) — directionally aligned
    fred: { seriesId: "CHNMFGPMI", units: "lin" },
    ceic: { searchKeyword: "PMI Manufacturing NBS", country: "CN" },
    notes: "NBS official PMI manufacturing. FRED fallback: Caixin PMI (private sector proxy).",
  },
  pmi_services: {
    label: "PMI Services (Non-Manufacturing)",
    unit: "index",
    category: "macro",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A01160401" },
    // FRED: CHNNFCPMI = Caixin Non-farm Composite PMI for China
    fred: { seriesId: "CHNNFCPMI", units: "lin" },
    ceic: { searchKeyword: "PMI Non-Manufacturing NBS", country: "CN" },
    notes: "NBS non-manufacturing PMI. FRED fallback: Caixin composite PMI.",
  },

  // ─── Trade ────────────────────────────────────────────────────────────────
  exports_yoy: {
    label: "Exports YoY %",
    unit: "%",
    category: "trade",
    fallback: "ceic",
    ceic: { seriesId: 423075907, searchKeyword: "Total Exports YoY China", country: "CN" },
    nbs: { dbcode: "hgyd", code: "A060E0101" },
    notes: "CEIC: Total Exports: YoY: Monthly: sa: China (id=423075907).",
  },
  imports_yoy: {
    label: "Imports YoY %",
    unit: "%",
    category: "trade",
    fallback: "ceic",
    ceic: { seriesId: 423075917, searchKeyword: "Total Imports YoY China", country: "CN" },
    nbs: { dbcode: "hgyd", code: "A060E0201" },
    notes: "CEIC: Total Imports: YoY: Monthly: sa: China (id=423075917).",
  },
  trade_balance_usd: {
    label: "Trade Balance USD bn",
    unit: "USD bn",
    category: "trade",
    fallback: "ceic",
    ceic: { seriesId: 458962047, searchKeyword: "Trade Balance China", country: "CN", transform: "divide_1000" },
    nbs: { dbcode: "hgyd", code: "A060E0301" },
    notes: "CEIC: Trade Balance: USD mn: Monthly: sa: China (id=458962047). Divided by 1000 for bn.",
  },

  // ─── Equity Indices ───────────────────────────────────────────────────────
  shc_close: {
    label: "Shanghai Composite (SSE)",
    unit: "index",
    category: "equity",
    fallback: "yahoo",
    yahoo: { ticker: "000001.SS", interval: "1d", range: "2y" },
    stooq: { symbol: "shc", rangeDays: 730 },
    notes: "Shanghai Composite Index daily close",
  },
  szi_close: {
    label: "Shenzhen Composite",
    unit: "index",
    category: "equity",
    fallback: "yahoo",
    yahoo: { ticker: "399001.SZ", interval: "1d", range: "2y" },
    stooq: { symbol: "szi", rangeDays: 730 },
  },
  csi300_close: {
    label: "CSI 300",
    unit: "index",
    category: "equity",
    fallback: "yahoo",
    yahoo: { ticker: "000300.SS", interval: "1d", range: "2y" },
    stooq: { symbol: "csi300", rangeDays: 730 },
  },
  hsi_close: {
    label: "Hang Seng Index",
    unit: "index",
    category: "equity",
    fallback: "yahoo",
    yahoo: { ticker: "^HSI", interval: "1d", range: "2y" },
    stooq: { symbol: "hsi", rangeDays: 730 },
  },
  chinext_close: {
    label: "ChiNext",
    unit: "index",
    category: "equity",
    fallback: "yahoo",
    yahoo: { ticker: "399006.SZ", interval: "1d", range: "2y" },
    stooq: { symbol: "chinext", rangeDays: 730 },
  },
  star50_close: {
    label: "STAR 50",
    unit: "index",
    category: "equity",
    fallback: "yahoo",
    yahoo: { ticker: "000688.SS", interval: "1d", range: "2y" },
    notes: "STAR Market 50 index",
  },

  // ─── GDP ──────────────────────────────────────────────────────────────────
  gdp_yoy: {
    label: "GDP YoY %",
    unit: "%",
    category: "gdp",
    fallback: "ceic",
    ceic: { seriesId: 249098001, searchKeyword: "Real GDP YoY China", country: "CN" },
    nbs: { dbcode: "hgjd", code: "A010101" },
    fred: { seriesId: "CHNNGDPRNAQISMEI", units: "pc1" },
    notes: "CEIC: Real GDP: YoY: Quarterly: China (id=249098001).",
  },

  // ─── Fiscal ───────────────────────────────────────────────────────────────
  fiscal_revenue_yoy: {
    label: "Fiscal Revenue YoY %",
    unit: "%",
    category: "fiscal",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A0I0101" },
    ceic: { searchKeyword: "Government Revenue China", country: "CN" },
    notes: "General public budget revenue YoY. No FRED equivalent — requires CEIC.",
  },

  // ─── Property ─────────────────────────────────────────────────────────────
  new_home_prices_70city: {
    label: "House Prices YoY % (CEIC YTD)",
    unit: "%",
    category: "property",
    fallback: "ceic",
    ceic: { seriesId: 408940867, searchKeyword: "House Prices YoY China", country: "CN" },
    nbs: { dbcode: "hgyd", code: "A0D0101" },
    notes: "CEIC: House Prices: YoY: Quarterly: ytd: China (id=408940867). Quarterly cadence vs NBS 70-city monthly.",
  },
  property_starts_ytd: {
    label: "Property New Starts YTD YoY %",
    unit: "%",
    category: "property",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A050C0101" },
    ceic: { searchKeyword: "Floor Space Started Real Estate China", country: "CN" },
  },
  completed_area_ytd: {
    label: "Property Completed Area YTD YoY %",
    unit: "%",
    category: "property",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A050C0301" },
    ceic: { searchKeyword: "Floor Space Completed Real Estate China", country: "CN" },
  },

  // ─── Trade detail (HS-2 stubs — return empty + data_source_pending) ───────
  // These light up when CEIC data subscriptions arrive.
  hs84_exports: {
    label: "HS84 Machinery Exports USD",
    unit: "USD mn",
    category: "trade",
    fallback: "pending",
    ceic: { searchKeyword: "HS84 Machinery Exports China", country: "CN" },
    notes: "data_source_pending: requires CEIC subscription",
  },
  hs84_imports: {
    label: "HS84 Machinery Imports USD",
    unit: "USD mn",
    category: "trade",
    fallback: "pending",
    ceic: { searchKeyword: "HS84 Machinery Imports China", country: "CN" },
  },
  hs85_exports: {
    label: "HS85 Electronics Exports USD",
    unit: "USD mn",
    category: "trade",
    fallback: "pending",
    ceic: { searchKeyword: "HS85 Electronics Exports China", country: "CN" },
  },
  hs85_imports: {
    label: "HS85 Electronics Imports USD",
    unit: "USD mn",
    category: "trade",
    fallback: "pending",
    ceic: { searchKeyword: "HS85 Electronics Imports China", country: "CN" },
  },
  hs87_exports: {
    label: "HS87 Vehicles Exports USD",
    unit: "USD mn",
    category: "trade",
    fallback: "pending",
    ceic: { searchKeyword: "HS87 Vehicle Exports China", country: "CN" },
  },
  hs87_imports: {
    label: "HS87 Vehicles Imports USD",
    unit: "USD mn",
    category: "trade",
    fallback: "pending",
    ceic: { searchKeyword: "HS87 Vehicle Imports China", country: "CN" },
  },
  hs27_exports: {
    label: "HS27 Mineral Fuels Exports USD",
    unit: "USD mn",
    category: "trade",
    fallback: "pending",
    ceic: { searchKeyword: "HS27 Mineral Fuels Exports China", country: "CN" },
  },
  hs27_imports: {
    label: "HS27 Mineral Fuels Imports USD",
    unit: "USD mn",
    category: "trade",
    fallback: "pending",
    ceic: { searchKeyword: "HS27 Mineral Fuels Imports China", country: "CN" },
  },

  // ─── NEW: CEIC-unlocked series (Phase 2.5) ────────────────────────────────
  // These are confirmed subscribed via /series/search?subscribed_only=true (2026-06-02).

  // FX & rates
  usdcny_monthly: {
    label: "USD/CNY Exchange Rate (monthly avg)",
    unit: "CNY/USD",
    category: "macro",
    fallback: "ceic",
    ceic: { seriesId: 260458501, searchKeyword: "Exchange Rate against USD China", country: "CN" },
    notes: "CEIC: Exchange Rate against USD: Period Avg: Monthly: China (id=260458501).",
  },
  policy_rate_7d: {
    label: "7-Day Reverse Repo Rate (PBoC)",
    unit: "%",
    category: "macro",
    fallback: "ceic",
    ceic: { seriesId: 372754377, searchKeyword: "7 Day Reverse Repurchase Rate China", country: "CN" },
    notes: "CEIC: Policy Rate: Month End: 7 Day Reverse Repo (id=372754377).",
  },
  rrr_china: {
    label: "Reserve Requirement Ratio",
    unit: "%",
    category: "macro",
    fallback: "ceic",
    ceic: { seriesId: 455745437, searchKeyword: "Reserve Requirement Ratio China", country: "CN" },
    notes: "CEIC: RRR: Local Currency Deposits: China (id=455745437).",
  },
  shibor_3m: {
    label: "SHIBOR 3-Month",
    unit: "%",
    category: "macro",
    fallback: "ceic",
    ceic: { seriesId: 455961417, searchKeyword: "SHIBOR 3 Months China", country: "CN" },
    notes: "CEIC: Short Term Interest Rate: SHIBOR 3M (id=455961417).",
  },
  cn_1y_bond_yield: {
    label: "China 1Y Treasury Bond Yield",
    unit: "%",
    category: "macro",
    fallback: "ceic",
    ceic: { seriesId: 455745427, searchKeyword: "Treasury Bond Yield 1 Year China", country: "CN" },
    notes: "CEIC: Long Term Interest Rate: Interbank Treasury Bond Yield 1Y (id=455745427).",
  },
  fx_reserves_usd: {
    label: "Foreign Exchange Reserves",
    unit: "USD bn",
    category: "macro",
    fallback: "ceic",
    ceic: { seriesId: 249097101, searchKeyword: "Foreign Exchange Reserves China", country: "CN", transform: "divide_1000" },
    notes: "CEIC: FX Reserves: USD mn (id=249097101). Divided by 1000 for bn.",
  },

  // Money & credit
  m2_yoy: {
    label: "M2 Money Supply YoY %",
    unit: "%",
    category: "macro",
    fallback: "ceic",
    ceic: { seriesId: 414245047, searchKeyword: "M2 YoY China", country: "CN" },
    notes: "CEIC: M2: YoY: Monthly: sa: China (id=414245047).",
  },

  // Labor
  unemployment_rate: {
    label: "Urban Surveyed Unemployment Rate",
    unit: "%",
    category: "kshape",
    fallback: "ceic",
    ceic: { seriesId: 487004207, searchKeyword: "Unemployment Rate Monthly China", country: "CN" },
    notes: "CEIC: Unemployment Rate: Monthly: China (id=487004207).",
  },

  // Real-economy
  motor_vehicle_sales: {
    label: "Motor Vehicle Sales (units, sa)",
    unit: "units",
    category: "kshape",
    fallback: "ceic",
    ceic: { seriesId: 458914877, searchKeyword: "Motor Vehicle Sales Monthly China", country: "CN" },
    notes: "CEIC: Motor Vehicle Sales: Monthly: sa: China (id=458914877).",
  },
  electricity_generation: {
    label: "Electricity Generation",
    unit: "GWh",
    category: "kshape",
    fallback: "ceic",
    ceic: { seriesId: 285666104, searchKeyword: "Electricity Generation Monthly China", country: "CN" },
    notes: "CEIC: Electricity Generation: Monthly: China (id=285666104).",
  },

  // External
  fdi_quarterly: {
    label: "Foreign Direct Investment (USD mn, quarterly)",
    unit: "USD mn",
    category: "trade",
    fallback: "ceic",
    ceic: { seriesId: 372405997, searchKeyword: "FDI Quarterly China", country: "CN" },
    notes: "CEIC: FDI: USD mn: Quarterly: China (id=372405997).",
  },
  current_account_pct_gdp: {
    label: "Current Account % of GDP (quarterly, sa)",
    unit: "%",
    category: "trade",
    fallback: "ceic",
    ceic: { seriesId: 462162507, searchKeyword: "Current Account Balance China", country: "CN" },
    notes: "CEIC: Current Account Balance % GDP: Quarterly: sa (id=462162507).",
  },
  exports_to_usa: {
    label: "Exports to USA (USD mn, monthly, sa)",
    unit: "USD mn",
    category: "trade",
    fallback: "ceic",
    ceic: { seriesId: 459194477, searchKeyword: "Total Exports to USA China", country: "CN" },
    notes: "CEIC: Total Exports to USA: Monthly: sa (id=459194477). Key US-China decoupling indicator.",
  },
  imports_from_usa: {
    label: "Imports from USA (USD mn, monthly, sa)",
    unit: "USD mn",
    category: "trade",
    fallback: "ceic",
    ceic: { seriesId: 459199657, searchKeyword: "Total Imports from USA China", country: "CN" },
    notes: "CEIC: Total Imports from USA: Monthly: sa (id=459199657).",
  },

  // Hong Kong equity benchmark
  hangseng_monthly: {
    label: "Hang Seng Index (month-end, CEIC)",
    unit: "index",
    category: "equity",
    fallback: "ceic",
    ceic: { seriesId: 455656947, searchKeyword: "Hang Seng Index Monthly", country: "HK" },
    yahoo: { ticker: "^HSI", interval: "1mo", range: "5y" },
    notes: "CEIC: Hang Seng Month End (id=455656947). Use hsi_close for daily.",
  },
  csi300_monthly: {
    label: "CSI 300 (month-end, CEIC)",
    unit: "index",
    category: "equity",
    fallback: "ceic",
    ceic: { seriesId: 455745417, searchKeyword: "Equity Market Index Shanghai Shenzhen 300", country: "CN" },
    yahoo: { ticker: "000300.SS", interval: "1mo", range: "5y" },
    notes: "CEIC: Equity Market Index: Shanghai Shenzhen 300 Month End (id=455745417).",
  },

  // ─── EastMoney direct (Phase 2.5) ─────────────────────────────────────────
  stock_connect_flow: {
    label: "Stock Connect Northbound Net Inflow (cumulative, CNY mn)",
    unit: "CNY mn",
    category: "equity",
    fallback: "eastmoney",
    eastmoney: { clientFn: "getStockConnectFlow", valueField: "totalInflow" },
    notes: "EastMoney push2his/kamt.kline — 180 trading days. NOTE: HKEX/CSRC stopped real-time Northbound net buy/sell dissemination on 13 May 2024 (see hkex.com.hk/News/Market-Communications/2024/2404122news). Endpoint still returns historical data through that cutoff; current values may be 0. Will need monthly ADT replacement source (e.g. HKEX Insight ADT table) or HKEX historical-daily statistics page.",
  },
  margin_balance: {
    label: "A-share Margin Balance (融资融券余额)",
    unit: "CNY tn",
    category: "margins",
    fallback: "eastmoney",
    eastmoney: { clientFn: "getMarginBalance", valueField: "rzrqye", divideBy: 1e12 },
    notes: "EastMoney RPTA_WEB_RZRQ_GGMX — per-stock aggregated to market total. Divide CNY by 1e12 for trillions.",
  },
  sector_rotation: {
    label: "Shenwan L1 Sector Performance (snapshot)",
    unit: "%",
    category: "equity",
    fallback: "eastmoney",
    eastmoney: { clientFn: "getSectorPerformance" },
    notes: "EastMoney sector list — 50 Shenwan L1 sectors. Snapshot (not time-series); UI consumes full payload via /api/eastmoney/sectors.",
  },
};

/** List all registry entries for API response */
export function listRegistry(): Array<{ id: string; label: string; category: string; fallback: string; unit: string }> {
  return Object.entries(REGISTRY).map(([id, entry]) => ({
    id,
    label: entry.label,
    category: entry.category,
    fallback: entry.fallback,
    unit: entry.unit,
  }));
}

/** Get a single registry entry */
export function getEntry(logicalId: string): SeriesEntry | undefined {
  return REGISTRY[logicalId];
}
