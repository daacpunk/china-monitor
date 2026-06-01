/**
 * Series registry — maps logical IDs to data sources.
 *
 * Priority order for fetching:
 * 1. NBS (free, reliable for Chinese macro)
 * 2. Yahoo Finance (free, good for equity indices)
 * 3. Stooq (free, A-share alternative)
 * 4. CEIC (paid, search/metadata only in Phase 2)
 *
 * For Phase 2: CEIC config exists but fetchSeries will NOT call CEIC data
 * endpoints by default — falls back to free sources.
 */

export type DataSourceName = "ceic" | "nbs" | "fred" | "yahoo" | "stooq" | "pending";
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
  searchKeyword: string;
  country?: string;
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

export interface SeriesEntry {
  label: string;
  unit: string;
  category: SeriesCategory;
  fallback: DataSourceName;
  ceic?: CeicConfig;
  nbs?: NbsConfig;
  fred?: FredConfig;   // FRED fallback when NBS is unreachable (overseas IP)
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
    // FRED: CHNFAIYOY — China Fixed Asset Investment YoY (monthly, OECD/NBS proxy)
    // Note: FRED does not carry FAI sub-breakdowns; main series only
    fred: { seriesId: "CHNFAIYOY", units: "lin" },
    ceic: { searchKeyword: "Fixed Asset Investment Total", country: "CN" },
    notes: "Total fixed asset investment, year-to-date YoY growth",
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
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A07010101" },
    // FRED: CHNPPIINDUSTRY = PPI: Industry for China (OECD MEI, monthly)
    fred: { seriesId: "CHNPPIINDUSTRY", units: "pc1" },
    ceic: { searchKeyword: "Producer Price Index", country: "CN" },
    notes: "All-industry PPI YoY. FRED fallback: OECD MEI series, lags NBS ~1 month.",
  },
  cpi_yoy: {
    label: "CPI YoY %",
    unit: "%",
    category: "macro",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A01010101" },
    // FRED: CHNCPIALLMINMEI = CPI: Total for China (OECD MEI, monthly index level)
    // units=pc1 gives YoY % change
    fred: { seriesId: "CHNCPIALLMINMEI", units: "pc1" },
    ceic: { searchKeyword: "Consumer Price Index China", country: "CN" },
  },

  // ─── Industrial Value Added (K-Shape) ─────────────────────────────────────
  iva_yoy: {
    label: "Industrial Value Added YoY %",
    unit: "%",
    category: "kshape",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A02010101" },
    // FRED: CHNPROINDMISMEI = Industrial Production for China (OECD MEI, monthly)
    // units=pc1 gives YoY % change
    fred: { seriesId: "CHNPROINDMISMEI", units: "pc1" },
    ceic: { searchKeyword: "Industrial Value Added China", country: "CN" },
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
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A060E0101" },
    ceic: { searchKeyword: "China Exports Growth", country: "CN" },
  },
  imports_yoy: {
    label: "Imports YoY %",
    unit: "%",
    category: "trade",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A060E0201" },
    ceic: { searchKeyword: "China Imports Growth", country: "CN" },
  },
  trade_balance_usd: {
    label: "Trade Balance USD bn",
    unit: "USD bn",
    category: "trade",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A060E0301" },
    ceic: { searchKeyword: "China Trade Balance", country: "CN" },
    notes: "Customs GACC data, USD denominated",
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
    fallback: "nbs",
    nbs: { dbcode: "hgjd", code: "A010101" },
    // FRED: CHNNGDPRNAQISMEI = GDP YoY % change for China (OECD MEI, quarterly)
    fred: { seriesId: "CHNNGDPRNAQISMEI", units: "pc1" },
    ceic: { searchKeyword: "GDP Growth Rate China Quarterly", country: "CN" },
    notes: "Quarterly GDP YoY growth rate. FRED fallback: OECD MEI quarterly index.",
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
    label: "New Home Prices 70-city MoM %",
    unit: "%",
    category: "property",
    fallback: "nbs",
    nbs: { dbcode: "hgyd", code: "A0D0101" },
    ceic: { searchKeyword: "Newly Built Commercial Residential Building Price", country: "CN" },
    notes: "70-city average new residential price MoM. No FRED equivalent — requires CEIC.",
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
