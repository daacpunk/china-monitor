/**
 * OECD SDMX REST API client.
 *
 * Free, no auth. Base: https://sdmx.oecd.org/public/rest/data
 *
 * URL format:
 *   {base}/{agency},{dataset}@{table},{version}/{key}?format=csv&startPeriod=YYYY-MM
 *
 * Reference: https://www.oecd.org/en/data/insights/data-explainers/2024/09/api.html
 *
 * Generic CSV columns: DATAFLOW, REF_AREA, FREQ, ..., TIME_PERIOD, OBS_VALUE, ...
 * We parse TIME_PERIOD + OBS_VALUE into TimePoint[].
 */

export interface OecdPoint {
  /** Period (YYYY-MM, YYYY-Qn, or YYYY) as returned by SDMX; normalised to YYYY-MM-01 */
  date: string;
  value: number;
}

type OecdResponse =
  | { source: "oecd"; series: OecdPoint[]; fetchedAt: string }
  | { source: "oecd"; series: OecdPoint[]; fetchedAt: string; error: string };

const FETCHED_AT = () => new Date().toISOString();

/** Normalise SDMX time period to YYYY-MM-01 (or YYYY-01-01 if annual). */
function normaliseTimePeriod(raw: string): string | null {
  if (!raw) return null;
  // Monthly: 2024-03
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  // Quarterly: 2024-Q1 -> 2024-01-01 (Q1=Jan, Q2=Apr, Q3=Jul, Q4=Oct)
  const qm = raw.match(/^(\d{4})-Q([1-4])$/);
  if (qm) {
    const month = String((parseInt(qm[2], 10) - 1) * 3 + 1).padStart(2, "0");
    return `${qm[1]}-${month}-01`;
  }
  // Annual: 2024
  if (/^\d{4}$/.test(raw)) return `${raw}-01-01`;
  return null;
}

/**
 * Minimal CSV parser sufficient for OECD's output (no embedded commas/quotes
 * in numeric data fields). Returns array of row objects keyed by header name.
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < headers.length) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => (row[h] = (cells[idx] ?? "").trim()));
    rows.push(row);
  }
  return rows;
}

/**
 * Fetch a single OECD series via its full SDMX URL.
 *
 * Examples:
 *   - China CLI (amplitude-adjusted, monthly):
 *     OECD.SDD.STES,DSD_STES@DF_CLI,4.1/CHN.M.LI...AA.IX..H
 *   - China BCI (business confidence, monthly):
 *     OECD.SDD.STES,DSD_STES@DF_CLI,4.1/CHN.M.BCICP...AA.IX..H
 *   - China CCI (consumer confidence, monthly):
 *     OECD.SDD.STES,DSD_STES@DF_CLI,4.1/CHN.M.CCICP...AA.IX..H
 */
export async function getOecdSeries(
  dataflowAndKey: string,
  opts: { startPeriod?: string } = {},
): Promise<OecdResponse> {
  const startPeriod = opts.startPeriod ?? "2020-01";
  const url =
    `https://sdmx.oecd.org/public/rest/data/${dataflowAndKey}` +
    `?format=csv&startPeriod=${startPeriod}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/csv" },
    });
    if (!res.ok) {
      return {
        source: "oecd",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `HTTP ${res.status} from OECD SDMX for ${dataflowAndKey}`,
      };
    }
    const text = await res.text();
    const rows = parseCsv(text);
    const points: OecdPoint[] = [];
    for (const r of rows) {
      const date = normaliseTimePeriod(r.TIME_PERIOD ?? "");
      const value = parseFloat(r.OBS_VALUE ?? "");
      if (date && Number.isFinite(value)) points.push({ date, value });
    }
    // OECD CSV returns unordered rows — sort ascending
    points.sort((a, b) => a.date.localeCompare(b.date));
    return { source: "oecd", series: points, fetchedAt: FETCHED_AT() };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return {
        source: "oecd",
        series: [],
        fetchedAt: FETCHED_AT(),
        error: `OECD timeout for ${dataflowAndKey}`,
      };
    }
    return {
      source: "oecd",
      series: [],
      fetchedAt: FETCHED_AT(),
      error: `OECD fetch failed: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: pre-configured pulls for the China dashboard. */
export const OECD_CHINA_PULLS = {
  cli: "OECD.SDD.STES,DSD_STES@DF_CLI,4.1/CHN.M.LI...AA.IX..H",
  bci: "OECD.SDD.STES,DSD_STES@DF_CLI,4.1/CHN.M.BCICP...AA.IX..H",
  cci: "OECD.SDD.STES,DSD_STES@DF_CLI,4.1/CHN.M.CCICP...AA.IX..H",
} as const;
