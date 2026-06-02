/**
 * HKEX (Hong Kong Exchanges and Clearing) Stock Connect monthly statistics client.
 *
 * Replaces EastMoney's deprecated push2his/kamt.kline endpoint for Stock Connect
 * northbound flow data. HKEX/CSRC stopped real-time net buy/sell dissemination
 * on 13 May 2024 — monthly Average Daily Turnover (ADT) is the current standard.
 *
 * Data source: HKEX Historical Monthly page loads static JS files via jQuery
 *   loadScript() into a global `tabData` variable. We strip the wrapper and
 *   parse the embedded JSON. No auth, no special headers, public endpoint.
 *
 *   URL pattern: https://www.hkex.com.hk/eng/csm/MonthlyStat/data_tab_monthly_{YYYY}{MM}e.js
 *   Coverage:    13 rolling months (older files return 404)
 *
 * Each monthly file contains 4 market tabs (SSE/SZSE × NB/SB), each with:
 *   - "tradingTable" — summary stats with columns:
 *     Total Turnover (RMB mn), Total Trade Count, Avg Daily Turnover (RMB mn),
 *     Avg Daily Total Trade Count, ETF Turnover (RMB mn)
 *     Rows show [Current Month, Previous Month, % Change]
 *   - "top10Table" — top 10 most actively traded stocks
 */

export interface HkexMonthlyAdt {
  /** Month-end date as YYYY-MM-01 (first-of-month convention for series) */
  date: string;
  /** SSE Northbound: Avg Daily Turnover, RMB millions */
  sseNorthboundAdt: number;
  /** SZSE Northbound: Avg Daily Turnover, RMB millions */
  szseNorthboundAdt: number;
  /** Combined northbound ADT, RMB millions */
  totalNorthboundAdt: number;
  /** SSE Southbound: Avg Daily Turnover, HKD millions */
  sseSouthboundAdt: number;
  /** SZSE Southbound: Avg Daily Turnover, HKD millions */
  szseSouthboundAdt: number;
  /** Combined southbound ADT, HKD millions */
  totalSouthboundAdt: number;
}

type HkexResponse =
  | { source: "hkex"; series: HkexMonthlyAdt[]; fetchedAt: string }
  | { source: "hkex"; series: HkexMonthlyAdt[]; fetchedAt: string; error: string };

const FETCHED_AT = () => new Date().toISOString();

/** Parse "1,234.56" → 1234.56 ; "—" or non-numeric → 0 */
function parseAmount(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const cleaned = raw.replace(/,/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch one month's data from HKEX. Returns null on 404 (file not yet published
 * or rolled off the 13-month window).
 *
 * tabData layout (each market):
 *   content[0].table  — tradingTable (summary)
 *     tr[0]            — header row ["This Month", "Prev Month", "% Change"]
 *     tr[1..]          — data rows. For Northbound markets:
 *                          [0] Total Turnover, [1] Total Trade Count,
 *                          [2] Avg Daily Turnover, [3] Avg Daily Trade Count,
 *                          [4] ETF Turnover
 *   content[1].table  — top10Table (ignored here)
 *
 * Markets: id 0=SSE NB, 1=SSE SB, 2=SZSE NB, 3=SZSE SB
 *
 * Note on units:
 *   - Northbound ADT is in RMB millions
 *   - Southbound ADT is in HKD millions
 */
async function fetchOneMonth(year: number, month: number): Promise<HkexMonthlyAdt | null> {
  const mm = String(month).padStart(2, "0");
  const url = `https://www.hkex.com.hk/eng/csm/MonthlyStat/data_tab_monthly_${year}${mm}e.js`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; china-monitor)" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    // Strip "tabData = " prefix and trailing semicolon
    const jsonStr = text.replace(/^\s*tabData\s*=\s*/, "").replace(/;\s*$/, "").trim();
    const tabs: any[] = JSON.parse(jsonStr);

    // Helper: row 3 of the summary table holds "Avg Daily Turnover" for NB markets.
    // tr[0] is column header. Rows are 0-indexed: 0=Total Turnover, 1=Total Trade Count,
    // 2=Avg Daily Turnover, etc. So tradingTable.tr[3] is the row, td[0][0] is current month.
    const extractAdt = (marketId: number): number => {
      const market = tabs.find((t) => t?.id === marketId);
      if (!market) return 0;
      const tradingTable = market.content?.find((c: any) => c.table?.classname === "tradingTable")?.table;
      if (!tradingTable?.tr) return 0;
      // tr structure: [headerRow, totalTurnoverRow, totalTradesRow, ADT_row, ...]
      // BUT for Southbound markets the row layout differs (more columns/rows).
      // We locate the ADT row by matching the schema header row 0 of the table cells.
      // Safer: each tr.td is [[currentMonth, prevMonth, %change]]. Trading table rows are:
      //   tr[0] = column-header td (skip)
      //   tr[1] = Total Turnover
      //   tr[2] = Total Trade Count
      //   tr[3] = Avg Daily Turnover   <-- NB
      //   tr[4] = Avg Daily Trade Count
      //   tr[5] = ETF Turnover
      // For SB markets layout is longer (Buy/Sell breakdown) but row 7 ("Avg Daily Turnover")
      // is still labelled. Since schema rows aren't labelled inline, we use heuristic:
      // pick the first row whose value is plausibly an ADT (<= 1/15th of total turnover).
      const rows = tradingTable.tr;
      if (rows.length >= 4) {
        // NB markets: ADT at index 3
        // SB markets: also at index 7 (skip Buy/Sell breakdown) — but content[0] index 3 is "Avg Daily Turnover" for NB only
        // Robust approach: total turnover (row 1) / ADT (row 3) ≈ 20 trading days
        const totalT = parseAmount(rows[1]?.td?.[0]?.[0]);
        const adtCandidate = parseAmount(rows[3]?.td?.[0]?.[0]);
        // If ratio (total/ADT) is between 10 and 30 → it's the NB layout
        if (totalT > 0 && adtCandidate > 0) {
          const ratio = totalT / adtCandidate;
          if (ratio >= 10 && ratio <= 30) return adtCandidate;
        }
        // Otherwise scan for an SB-layout ADT row (typically index 7 = "Avg Daily Turnover")
        for (let i = 1; i < rows.length; i++) {
          const v = parseAmount(rows[i]?.td?.[0]?.[0]);
          if (v > 0 && totalT > 0) {
            const r = totalT / v;
            if (r >= 10 && r <= 30) return v;
          }
        }
      }
      return 0;
    };

    const sseNb = extractAdt(0);
    const sseSb = extractAdt(1);
    const szseNb = extractAdt(2);
    const szseSb = extractAdt(3);

    return {
      date: `${year}-${mm}-01`,
      sseNorthboundAdt: sseNb,
      szseNorthboundAdt: szseNb,
      totalNorthboundAdt: sseNb + szseNb,
      sseSouthboundAdt: sseSb,
      szseSouthboundAdt: szseSb,
      totalSouthboundAdt: sseSb + szseSb,
    };
  } catch (err: any) {
    if (err.name === "AbortError") throw new Error(`HKEX timeout for ${year}-${mm}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch up to 13 most recent months of HKEX Stock Connect ADT data.
 * Returns oldest → newest ordering for time-series consumption.
 */
export async function getStockConnectMonthlyAdt(): Promise<HkexResponse> {
  try {
    const now = new Date();
    const months: Array<{ year: number; month: number }> = [];
    // Start from current month and walk back 13 months
    for (let i = 0; i < 13; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }

    // Fetch in parallel; tolerate 404s for not-yet-published months
    const results = await Promise.all(
      months.map(({ year, month }) =>
        fetchOneMonth(year, month).catch((err) => {
          console.warn(`[hkex] fetchOneMonth ${year}-${month} failed: ${err.message}`);
          return null;
        }),
      ),
    );

    const series = results
      .filter((r): r is HkexMonthlyAdt => r !== null)
      .sort((a, b) => a.date.localeCompare(b.date)); // ascending

    if (series.length === 0) {
      return {
        source: "hkex",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: "No HKEX monthly files retrieved",
      };
    }

    return { source: "hkex", series, fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    return {
      source: "hkex",
      series: [],
      fetchedAt: FETCHED_AT(),
      error: `getStockConnectMonthlyAdt failed: ${err.message}`,
    };
  }
}
