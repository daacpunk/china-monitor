/**
 * EastMoney (东方财富) direct client.
 * EastMoney is China's largest retail finance portal. All endpoints below are
 * public JSON APIs — no authentication required.
 *
 * Headers required:
 *   User-Agent : standard browser UA (WAF rejects missing UA on some endpoints)
 *   Referer    : https://www.eastmoney.com/ (WAF blocks missing referer on
 *                push2.eastmoney.com endpoints)
 *
 * Cache: 15 min TTL — equity data refreshes intraday on trading days.
 *
 * Endpoints:
 *  1. Stock Connect northbound flow (HK→A-share daily cumulative)
 *     push2his.eastmoney.com/api/qt/kamt.kline/get
 *     NOTE: push2 (without "his") only returns TODAY's value. The historical
 *     endpoint push2his is required for multi-day series.
 *
 *  2. Margin balance 融资融券余额 (Shanghai + Shenzhen combined daily)
 *     datacenter-web.eastmoney.com/api/data/v1/get
 *     Report: RPTA_WEB_RZRQ_GGMX (per-stock; aggregated server-side by date)
 *     NOTE: The report RPTA_WEB_RZRQ_GGMX_NEW (as referenced in some docs)
 *     returns "报表配置不存在" (report not found) — it no longer exists.
 *     RPTA_WEB_RZRQ_GGMX is the working equivalent, but is per-stock.
 *     We aggregate across all pages (9 pages × ~500 stocks/page per date)
 *     in parallel to derive the daily market total.
 *
 *  3. Shenwan L1 industry sector rotation (28 sectors, daily change %)
 *     push2.eastmoney.com/api/qt/clist/get
 *     NOTE: The `diff` field in the response is a keyed object ({"0":…,"1":…}),
 *     not an array. Use Object.values() to iterate.
 *
 *  4. Index kline history (CSI 300, Shanghai Composite, etc.)
 *     push2his.eastmoney.com/api/qt/stock/kline/get
 *
 * Geo-blocking notes (tested from Railway US region):
 *  - push2.eastmoney.com returns HTTP 302 without Referer header; the client
 *    automatically follows redirects.
 *  - push2his.eastmoney.com is accessible from US egress (tested ✓).
 *  - datacenter-web.eastmoney.com is accessible from US egress (tested ✓).
 *  - If any endpoint returns 403, an additional Origin header is tried.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────────────────────────────────────

const EM_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const EM_REFERER = "https://www.eastmoney.com/";
const EM_DATA_REFERER = "https://data.eastmoney.com/";
const EM_ORIGIN = "https://quote.eastmoney.com";

const FETCH_TIMEOUT_MS = 20_000;

/** Build standard headers for EastMoney push2 endpoints. */
function emHeaders(
  referer = EM_REFERER,
  includeOrigin = false,
): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": EM_UA,
    Referer: referer,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  if (includeOrigin) h["Origin"] = EM_ORIGIN;
  return h;
}

/** Fetch with timeout and optional origin header retry on 403. */
async function emFetch(url: string, referer = EM_REFERER): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: emHeaders(referer, false),
      signal: controller.signal,
    });
    if (res.status === 403) {
      // Retry with Origin header (some WAF rules require it)
      clearTimeout(timer);
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), FETCH_TIMEOUT_MS);
      try {
        return await fetch(url, {
          headers: emHeaders(referer, true),
          signal: ctrl2.signal,
        });
      } finally {
        clearTimeout(timer2);
      }
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip JSONP callback wrapper if present, returning raw JSON string. */
function stripJsonp(text: string): string {
  const m = text.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\(([\s\S]*)\)\s*;?\s*$/);
  return m ? m[1] : text;
}

const FETCHED_AT = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** One day of Stock Connect northbound (HK→A-share) flow data. */
export interface StockConnectFlow {
  date: string;            // YYYY-MM-DD
  /** Cumulative net northbound inflow into Shanghai market, CNY millions */
  shanghaiInflow: number;
  /** Cumulative net northbound inflow into Shenzhen market, CNY millions */
  shenzhenInflow: number;
  /** Combined Shanghai + Shenzhen northbound inflow, CNY millions */
  totalInflow: number;
}

/** One day of A-share margin financing/lending balance (margin balance). */
export interface MarginBalance {
  date: string;            // YYYY-MM-DD
  /** Financing balance 融资余额, CNY yuan */
  rzye: number;
  /** Securities lending balance 融券余额, CNY yuan */
  rqye: number;
  /** Total margin balance 融资融券余额, CNY yuan */
  rzrqye: number;
}

/** Shenwan L1 industry sector performance (one sector per row). */
export interface SectorPerf {
  code: string;            // e.g. "801010"
  name: string;            // e.g. "农林牧渔"
  /** Daily % change */
  changePercent: number;
  /** Net main capital inflow, CNY — positive = inflow, negative = outflow */
  netMainInflow: number;
}

/** One candle in EastMoney kline (OHLCV) format. */
export interface EastMoneyKline {
  date: string;            // YYYY-MM-DD
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard response envelope
// ─────────────────────────────────────────────────────────────────────────────

type EastMoneyResponse<T> =
  | { source: "eastmoney"; series: T[]; fetchedAt: string }
  | { source: "eastmoney"; series: T[]; fetchedAt: string; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Stock Connect northbound flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch Stock Connect (沪深港通) northbound (HK→A-share) daily cumulative flow.
 *
 * Endpoint: https://push2his.eastmoney.com/api/qt/kamt.kline/get
 *   fields1=f1,f3,f5  → metadata
 *   fields2=f51,f52   → date, value
 *   klt=101           → daily granularity
 *   lmt=180           → last 180 trading days
 *
 * IMPORTANT: Use push2his (historical) NOT push2. The push2 endpoint returns
 * only today's cumulative value (lmt parameter is ignored). push2his returns
 * the full 180-day history.
 *
 * Response shape:
 *   { data: { hk2sh: ["YYYY-MM-DD,value", ...], hk2sz: [...], s2n: [...] }, rc: 0 }
 *
 * hk2sh = HK→Shanghai northbound cumulative flow (CNY millions).
 * hk2sz = HK→Shenzhen northbound cumulative flow (CNY millions).
 * s2n   = Combined northbound (same as hk2sh on push2his).
 * Values are 0.00 for non-trading days (EastMoney fills weekdays with 0).
 */
export async function getStockConnectFlow(): Promise<EastMoneyResponse<StockConnectFlow>> {
  const ts = Date.now();
  // Use push2his (historical) — push2 only returns today's value
  const url =
    `https://push2his.eastmoney.com/api/qt/kamt.kline/get` +
    `?fields1=f1,f3,f5&fields2=f51,f52&klt=101&lmt=180&cb=&_=${ts}`;

  try {
    const res = await emFetch(url, EM_DATA_REFERER);
    if (!res.ok) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `HTTP ${res.status} from Stock Connect endpoint`,
      };
    }

    const text = await res.text();
    const json = JSON.parse(stripJsonp(text));

    if (json.rc !== 0 || !json.data) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `EastMoney rc=${json.rc}: ${json.message ?? "unknown error"}`,
      };
    }

    const hk2sh: string[] = json.data.hk2sh ?? [];
    const hk2sz: string[] = json.data.hk2sz ?? [];

    // Build per-date maps
    const shMap = new Map<string, number>();
    const szMap = new Map<string, number>();

    for (const row of hk2sh) {
      const [date, val] = row.split(",");
      shMap.set(date.trim(), parseFloat(val) || 0);
    }
    for (const row of hk2sz) {
      const [date, val] = row.split(",");
      szMap.set(date.trim(), parseFloat(val) || 0);
    }

    // Union of all dates, sorted ascending
    const allDates = Array.from(
      new Set([...Array.from(shMap.keys()), ...Array.from(szMap.keys())]),
    ).sort();

    const series: StockConnectFlow[] = allDates.map((date) => {
      const sh = shMap.get(date) ?? 0;
      const sz = szMap.get(date) ?? 0;
      return {
        date,
        shanghaiInflow: sh,
        shenzhenInflow: sz,
        totalInflow: sh + sz,
      };
    });

    return { source: "eastmoney", series, fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return {
      source: "eastmoney",
      series: [],
      fetchedAt: FETCHED_AT(),
      error: `getStockConnectFlow failed: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Margin balance (融资融券余额)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch ONE page of the per-stock margin data for a specific date.
 * Internal helper used by getMarginBalance.
 */
async function fetchMarginPage(
  date: string,
  page: number,
): Promise<Array<{ rzye: number; rqye: number; rzrqye: number }>> {
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get` +
    `?reportName=RPTA_WEB_RZRQ_GGMX&columns=DATE,RZYE,RQYE,RZRQYE` +
    `&filter=(DATE%3D'${date}')` +
    `&pageNumber=${page}&pageSize=500&sortColumns=DATE&sortTypes=-1`;

  const res = await emFetch(url, EM_DATA_REFERER);
  if (!res.ok) return [];

  const text = await res.text();
  const json = JSON.parse(stripJsonp(text));

  if (!json.success || !json.result?.data) return [];

  return (json.result.data as Array<Record<string, any>>).map((r) => ({
    rzye: Number(r.RZYE) || 0,
    rqye: Number(r.RQYE) || 0,
    rzrqye: Number(r.RZRQYE) || 0,
  }));
}

/**
 * Fetch daily market-aggregate margin financing/lending balance.
 * Shanghai + Shenzhen combined (both markets).
 *
 * Endpoint: https://datacenter-web.eastmoney.com/api/data/v1/get
 *   reportName=RPTA_WEB_RZRQ_GGMX  (per-stock margin data; see NOTE)
 *   columns=DATE,RZYE,RQYE,RZRQYE
 *   filter=(DATE='YYYY-MM-DD')      per-date fetch
 *   pageSize=500                    (maximum allowed by this API)
 *
 * NOTE on report naming: The task spec references RPTA_WEB_RZRQ_GGMX_NEW,
 * which no longer exists in the EastMoney API (returns 9501 "报表配置不存在").
 * RPTA_WEB_RZRQ_GGMX is the working equivalent. It returns one row per
 * listed stock per trading day (~4,366 stocks). To derive market totals,
 * we fetch all pages for each date in parallel and sum RZYE/RQYE/RZRQYE.
 * Each date requires ~9 API pages × 500 rows/page.
 *
 * Date discovery strategy (verified empirically):
 *  - Unfiltered sort by DATE desc: pagesPerDay ≈ ceil(4366/500) = 9 pages/day.
 *  - Date D1 = pages 1..9, Date D2 = pages 10..18, Date Dn = pages (n-1)*9+1..n*9.
 *  - We sample page (n-1)*pagesPerDay+1 for each n to get the date at that offset.
 *  - The sample page returns 500 rows; we take the LAST unique date in those rows
 *    (which is the oldest date on that page = start of a new date's block).
 *
 * Performance: We fetch the last `days` trading days (default: 20).
 * All page fetches for all dates are issued concurrently.
 * With 15-min cache TTL, the ~5–15s first-load latency is acceptable.
 *
 * All monetary fields are in CNY yuan.
 */
export async function getMarginBalance(days = 20): Promise<EastMoneyResponse<MarginBalance>> {
  const BASE_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
  const REPORT = "RPTA_WEB_RZRQ_GGMX";

  try {
    // ── Step 1: Get page 1 (unfiltered, DATE desc) to find most recent date ──
    const page1Url =
      `${BASE_URL}?reportName=${REPORT}&columns=DATE,RZYE,RQYE,RZRQYE` +
      `&pageNumber=1&pageSize=500&sortColumns=DATE&sortTypes=-1`;

    const metaRes = await emFetch(page1Url, EM_DATA_REFERER);
    if (!metaRes.ok) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `HTTP ${metaRes.status} from Margin Balance endpoint`,
      };
    }

    const metaJson = JSON.parse(stripJsonp(await metaRes.text()));
    if (!metaJson.success || !metaJson.result?.data) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `Margin Balance API: success=${metaJson.success}, msg=${metaJson.message ?? "n/a"}`,
      };
    }

    const rawData: Array<Record<string, any>> = metaJson.result.data;
    const mostRecentDate = String(rawData[0]?.DATE ?? "").slice(0, 10);
    if (!mostRecentDate) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: "Margin Balance: could not determine most recent trading date",
      };
    }

    // ── Step 2: Find pagesPerDay by checking filtered count for mostRecentDate ──
    const filtMeta = await emFetch(
      `${BASE_URL}?reportName=${REPORT}&columns=DATE` +
      `&filter=(DATE%3D'${mostRecentDate}')` +
      `&pageNumber=1&pageSize=500&sortColumns=DATE&sortTypes=-1`,
      EM_DATA_REFERER,
    );
    const filtJson = JSON.parse(stripJsonp(await filtMeta.text()));
    const pagesPerDay = filtJson?.result?.pages ?? 9; // typically 9 for ~4366 stocks
    const totalHistoricPages = metaJson.result.pages ?? 0;

    // ── Step 3: Discover trading dates by sampling the boundary pages ──
    // Page for date n (1-indexed): pageNum = (n-1)*pagesPerDay + 1
    // The sampled page has 500 rows; we take the first date on it.
    const boundaryPageNums = Array.from({ length: days }, (_, i) => i * pagesPerDay + 1)
      .filter((p) => p <= totalHistoricPages);

    const tradingDates = await Promise.all(
      boundaryPageNums.map(async (pNum, i) => {
        if (i === 0) return mostRecentDate; // page 1 = most recent date
        try {
          const r = await emFetch(
            `${BASE_URL}?reportName=${REPORT}&columns=DATE` +
            `&pageNumber=${pNum}&pageSize=500&sortColumns=DATE&sortTypes=-1`,
            EM_DATA_REFERER,
          );
          const j = JSON.parse(stripJsonp(await r.text()));
          const rows: Array<Record<string, any>> = j?.result?.data ?? [];
          // The boundary page may straddle two dates. We want the FIRST date on
          // this page (which is the newest = the date starting at this block).
          return rows.length > 0 ? String(rows[0].DATE ?? "").slice(0, 10) : null;
        } catch {
          return null;
        }
      }),
    );

    const uniqueDates = Array.from(
      new Set(tradingDates.filter((d): d is string => !!d && d.length === 10)),
    ).sort().reverse().slice(0, days);

    if (uniqueDates.length === 0) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: "Margin Balance: could not determine trading date list",
      };
    }

    // ── Step 4: For each date, fetch all pages in parallel and sum ──
    const dateResults = await Promise.all(
      uniqueDates.map(async (date) => {
        const firstPageUrl =
          `${BASE_URL}?reportName=${REPORT}&columns=DATE,RZYE,RQYE,RZRQYE` +
          `&filter=(DATE%3D'${date}')` +
          `&pageNumber=1&pageSize=500&sortColumns=DATE&sortTypes=-1`;

        try {
          const cRes = await emFetch(firstPageUrl, EM_DATA_REFERER);
          if (!cRes.ok) return null;
          const cJson = JSON.parse(stripJsonp(await cRes.text()));
          if (!cJson.success || !cJson.result?.data) return null;

          const datePageCount: number = cJson.result.pages ?? 1;
          const firstPageRows = (cJson.result.data as Array<Record<string, any>>).map(
            (r) => ({
              rzye: Number(r.RZYE) || 0,
              rqye: Number(r.RQYE) || 0,
              rzrqye: Number(r.RZRQYE) || 0,
            }),
          );

          // Remaining pages in parallel
          const extraRows = await Promise.all(
            Array.from({ length: datePageCount - 1 }, (_, i) =>
              fetchMarginPage(date, i + 2),
            ),
          );

          const allRows = [...firstPageRows, ...extraRows.flat()];
          return {
            date,
            rzye: allRows.reduce((s, r) => s + r.rzye, 0),
            rqye: allRows.reduce((s, r) => s + r.rqye, 0),
            rzrqye: allRows.reduce((s, r) => s + r.rzrqye, 0),
          } satisfies MarginBalance;
        } catch {
          return null;
        }
      }),
    );

    const series: MarginBalance[] = dateResults
      .filter((r): r is MarginBalance => r !== null)
      .sort((a, b) => a.date.localeCompare(b.date));

    return { source: "eastmoney", series, fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return {
      source: "eastmoney",
      series: [],
      fetchedAt: FETCHED_AT(),
      error: `getMarginBalance failed: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Sector rotation — Shenwan L1 industry indices
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch Shenwan Level-1 industry sector performance snapshot.
 * Returns up to 50 sectors sorted by daily % change (descending).
 *
 * Endpoint: https://push2.eastmoney.com/api/qt/clist/get
 *   pn=1 & pz=50     → page 1, 50 rows
 *   po=1             → descending order
 *   fid=f3           → sort by daily change %
 *   fs=m:90+t:2      → filter: market=90 (Shenwan index), type=2 (L1 industry)
 *   fields=f12,f14,f3,f62
 *     f12 = code, f14 = name, f3 = daily change %, f62 = net main inflow CNY
 *
 * Response: { data: { diff: {"0":{f12,f14,f3,f62}, "1":{...},...} }, rc: 0 }
 *
 * IMPORTANT: `diff` is a keyed object (not an array). Use Object.values().
 * The endpoint returns HTTP 302 without a Referer header; we follow redirects.
 *
 * This is a point-in-time snapshot (no date field returned by the API).
 * The date is stamped as the fetch time.
 */
export async function getSectorPerformance(): Promise<EastMoneyResponse<SectorPerf>> {
  // URL-encode the fs param to avoid 302 redirect issues
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get` +
    `?pn=1&pz=50&po=1&fid=f3&fs=m%3A90%2Bt%3A2&fields=f12,f14,f3,f62`;

  try {
    const res = await emFetch(url);
    if (!res.ok) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `HTTP ${res.status} from Sector Performance endpoint`,
      };
    }

    const text = await res.text();
    const json = JSON.parse(stripJsonp(text));

    if (json.rc !== 0 || !json.data?.diff) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `Sector API rc=${json.rc}: ${json.message ?? "no diff object"}`,
      };
    }

    // diff is a keyed object {"0":{...},"1":{...},...}, NOT an array
    const diffObj: Record<string, Record<string, any>> = json.data.diff;
    const raw: Array<Record<string, any>> = Object.values(diffObj);

    const series: SectorPerf[] = raw.map((row) => ({
      code: String(row.f12 ?? ""),
      name: String(row.f14 ?? ""),
      changePercent: Number(row.f3) || 0,
      netMainInflow: Number(row.f62) || 0,
    }));

    return { source: "eastmoney", series, fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return {
      source: "eastmoney",
      series: [],
      fetchedAt: FETCHED_AT(),
      error: `getSectorPerformance failed: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Index kline (OHLCV) history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch daily OHLCV kline history for a given EastMoney secid.
 *
 * Common secids:
 *   1.000300  CSI 300 (沪深300)
 *   1.000001  Shanghai Composite (上证指数)
 *   0.399001  Shenzhen Composite (深证成指)
 *   0.399006  ChiNext (创业板指)
 *   1.000688  STAR Market 50 (科创50)
 *
 * Endpoint: https://push2his.eastmoney.com/api/qt/stock/kline/get
 *   secid=<secid>
 *   fields1=f1,f3       → basic metadata
 *   fields2=f51,...,f56 → date, open, close, high, low, volume
 *   klt=101             → daily
 *   fqt=1               → forward-adjusted
 *   beg=YYYYMMDD        → start date (default "20240101")
 *   end=YYYYMMDD        → end date (default "20991231" = all future)
 *
 * Response: { data: { klines: ["date,open,close,high,low,volume", ...] }, rc: 0 }
 *
 * Note: open/close/high/low are index points (no currency).
 *       volume is in lots (手).
 *
 * Geo-block: push2his.eastmoney.com is accessible from US egress (tested ✓).
 */
export async function getEastMoneyKline(
  secid: string,
  beg?: string,
  end?: string,
  klt: 101 | 102 | 103 = 101,
): Promise<EastMoneyResponse<EastMoneyKline>> {
  const begParam = beg ?? "20240101";
  const endParam = end ?? "20991231";

  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
    `?secid=${encodeURIComponent(secid)}` +
    `&fields1=f1,f3&fields2=f51,f52,f53,f54,f55,f56` +
    `&klt=${klt}&fqt=1` +
    `&beg=${begParam}&end=${endParam}`;

  try {
    const res = await emFetch(url, EM_DATA_REFERER);
    if (!res.ok) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `HTTP ${res.status} from Kline endpoint (secid=${secid})`,
      };
    }

    const text = await res.text();
    const json = JSON.parse(stripJsonp(text));

    if (json.rc !== 0 || !json.data?.klines) {
      return {
        source: "eastmoney",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `Kline API rc=${json.rc} for secid=${secid}: ${json.message ?? "no klines"}`,
      };
    }

    const klines: string[] = json.data.klines;

    const series: EastMoneyKline[] = klines.map((line) => {
      // Format: "YYYY-MM-DD,open,close,high,low,volume,..."
      const parts = line.split(",");
      return {
        date: parts[0] ?? "",
        open: parseFloat(parts[1]) || 0,
        close: parseFloat(parts[2]) || 0,
        high: parseFloat(parts[3]) || 0,
        low: parseFloat(parts[4]) || 0,
        volume: parseFloat(parts[5]) || 0,
      };
    });

    return { source: "eastmoney", series, fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return {
      source: "eastmoney",
      series: [],
      fetchedAt: FETCHED_AT(),
      error: `getEastMoneyKline(${secid}) failed: ${err.message}`,
    };
  }
}
