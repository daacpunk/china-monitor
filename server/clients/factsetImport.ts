/**
 * FactSet / Bloomberg / manual CSV import parser.
 *
 * The user has FactSet workstation access but NO API access, so they save
 * series as CSV (or paste raw text). This module accepts a permissive
 * spreadsheet-style text blob and produces canonical {seriesId, date, value, …}
 * rows ready for upsert into `imported_series`.
 *
 * Supported input shapes:
 *
 *   1. "Long" format — one row per (series, date) point:
 *
 *      series_id,series_label,date,value,source_mnemonic,unit,frequency
 *      cn_gdp_yoy,China GDP YoY,2025-12-31,5.1,GDP_CHN_YOY,%,Q
 *      cn_gdp_yoy,China GDP YoY,2026-03-31,5.0,GDP_CHN_YOY,%,Q
 *
 *   2. "Wide" format — date column + one column per series, with header rows
 *      for label / unit / frequency / mnemonic. This is what FactSet's
 *      "Save as CSV" of a multi-series time-series chart looks like:
 *
 *      Series ID,, cn_gdp_yoy , cn_cpi_yoy
 *      Label   ,, China GDP YoY , China CPI YoY
 *      Mnemonic,, GDP_CHN_YOY  , CPI_CHN_YOY
 *      Unit    ,, %            , %
 *      Frequency,, Q           , M
 *      Date,,Value,Value
 *      2025-12-31,, 5.1, 1.2
 *      2026-03-31,, 5.0, 1.3
 *
 * Detection is best-effort and forgiving — we look for known header tokens
 * to identify the metadata rows, then any remaining numeric-keyed rows are
 * treated as date,value pairs.
 *
 * Delimiter is auto-detected from the first non-blank line: comma, tab, or
 * semicolon. Quoted fields (FactSet sometimes wraps labels with commas in
 * double quotes) are handled.
 *
 * All envelope errors are returned as `{ ok: false, error }`; never throws.
 */

export interface FactsetRow {
  seriesId: string;
  seriesLabel: string;
  date: string; // ISO YYYY-MM-DD
  value: number;
  sourceMnemonic?: string | null;
  unit?: string | null;
  frequency?: string | null;
  sourceName?: string;
}

export interface ParseSuccess {
  ok: true;
  rows: FactsetRow[];
  /** Distinct series ids discovered. */
  seriesIds: string[];
  /** Format detected. */
  format: "long" | "wide";
  /** Delimiter detected. */
  delimiter: "," | "\t" | ";";
  /** Optional warnings (skipped rows, ambiguous columns). */
  warnings: string[];
}
export interface ParseFailure {
  ok: false;
  error: string;
  warnings: string[];
}
export type ParseResult = ParseSuccess | ParseFailure;

// ────────────────────────────────────────────────────────────────────────────
// CSV line tokenizer — handles quoted fields with embedded delimiters.
// ────────────────────────────────────────────────────────────────────────────
function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delim && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectDelimiter(firstLine: string): "," | "\t" | ";" {
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  if (tabs >= commas && tabs >= semis && tabs > 0) return "\t";
  if (semis > commas) return ";";
  return ",";
}

// ────────────────────────────────────────────────────────────────────────────
// Date normaliser — supports YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY (ambiguous,
// assume MM/DD per FactSet US default), YYYY-MM, YYYY/M, "Q1 2025", "2025Q1",
// "Mar-2025", "March 2025". Returns ISO YYYY-MM-DD or null.
// ────────────────────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // ISO YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // YYYY-MM (assume EOM)
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(lastDayOfMonth(y, mo)).padStart(2, "0")}`;
  }
  // YYYY/M/D or YYYY/M
  m = s.match(/^(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : lastDayOfMonth(+m[1], +m[2]);
    if (mo < 1 || mo > 12) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // MM/DD/YYYY (US, FactSet default)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mo = +m[1], d = +m[2], y = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // Quarter: "Q1 2025" or "2025Q1"
  m = s.match(/^Q([1-4])[\s-]?(\d{4})$/i) || s.match(/^(\d{4})[\s-]?Q([1-4])$/i);
  if (m) {
    // first capture is Q digit if pattern starts with Q
    let q: number, y: number;
    if (/^Q/i.test(s)) {
      q = +m[1]; y = +m[2];
    } else {
      y = +m[1]; q = +m[2];
    }
    const moEnd = q * 3;
    return `${y}-${String(moEnd).padStart(2, "0")}-${String(lastDayOfMonth(y, moEnd)).padStart(2, "0")}`;
  }
  // "Mar-2025", "March 2025", "Mar 2025"
  m = s.match(/^([A-Za-z]{3,})[\s-]+(\d{4})$/);
  if (m) {
    const monKey = m[1].toLowerCase();
    const mo = MONTHS[monKey];
    if (!mo) return null;
    const y = +m[2];
    return `${y}-${String(mo).padStart(2, "0")}-${String(lastDayOfMonth(y, mo)).padStart(2, "0")}`;
  }
  // Excel serial date number? Accept 5-digit ints (e.g. 45291 = 2024-01-01)
  m = s.match(/^(\d{5})$/);
  if (m) {
    const serial = +m[1];
    // Excel epoch: 1899-12-30 (accounts for the 1900 leap-year bug).
    const epoch = Date.UTC(1899, 11, 30);
    const dt = new Date(epoch + serial * 86400000);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  }
  return null;
}

function parseNumber(raw: string): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, "").replace(/%$/, "");
  if (!s || s.toLowerCase() === "n/a" || s.toLowerCase() === "na" || s === "-" || s === "—") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Header tokens that identify metadata rows in WIDE format.
const META_KEYS: Record<string, "seriesId" | "label" | "mnemonic" | "unit" | "frequency"> = {
  "series id": "seriesId",
  "series_id": "seriesId",
  "ticker": "seriesId",
  "id": "seriesId",
  "label": "label",
  "name": "label",
  "series label": "label",
  "series_label": "label",
  "description": "label",
  "mnemonic": "mnemonic",
  "source_mnemonic": "mnemonic",
  "source mnemonic": "mnemonic",
  "factset id": "mnemonic",
  "factset_id": "mnemonic",
  "fql": "mnemonic",
  "unit": "unit",
  "units": "unit",
  "frequency": "frequency",
  "freq": "frequency",
  "periodicity": "frequency",
};

// ────────────────────────────────────────────────────────────────────────────
// LONG format detection: header row contains both "series_id" (or "id") and
// "date" and "value" (case-insensitive). Returns the parsed rows.
// ────────────────────────────────────────────────────────────────────────────
function tryParseLong(
  lines: string[][],
  warnings: string[],
): FactsetRow[] | null {
  if (lines.length < 2) return null;
  const header = lines[0].map((c) => c.toLowerCase().trim());
  const idIdx = header.findIndex((c) => c === "series_id" || c === "series id" || c === "id");
  const dateIdx = header.findIndex((c) => c === "date" || c === "period");
  const valueIdx = header.findIndex((c) => c === "value" || c === "val");
  if (idIdx < 0 || dateIdx < 0 || valueIdx < 0) return null;
  const labelIdx = header.findIndex((c) => c === "series_label" || c === "series label" || c === "label" || c === "name");
  const mnIdx = header.findIndex((c) => c === "source_mnemonic" || c === "source mnemonic" || c === "mnemonic" || c === "fql");
  const unitIdx = header.findIndex((c) => c === "unit" || c === "units");
  const freqIdx = header.findIndex((c) => c === "frequency" || c === "freq" || c === "periodicity");

  const out: FactsetRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row || row.every((c) => !c)) continue;
    const seriesId = (row[idIdx] ?? "").trim();
    const date = normaliseDate(row[dateIdx] ?? "");
    const value = parseNumber(row[valueIdx] ?? "");
    if (!seriesId || !date || value == null) {
      warnings.push(`Skipped row ${i + 1}: missing series_id/date/value`);
      continue;
    }
    out.push({
      seriesId,
      seriesLabel: (labelIdx >= 0 ? row[labelIdx] : "")?.trim() || seriesId,
      date,
      value,
      sourceMnemonic: mnIdx >= 0 ? (row[mnIdx]?.trim() || null) : null,
      unit: unitIdx >= 0 ? (row[unitIdx]?.trim() || null) : null,
      frequency: freqIdx >= 0 ? (row[freqIdx]?.trim() || null) : null,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// WIDE format parser. Walks rows from top:
//   - For each row, check if the first cell matches a META_KEYS token.
//     If so, record the remaining cells as that metadata for each series column.
//   - Otherwise, treat the first cell as a date and the rest as values.
// ────────────────────────────────────────────────────────────────────────────
interface WideColMeta {
  seriesId?: string;
  label?: string;
  mnemonic?: string;
  unit?: string;
  frequency?: string;
}

function tryParseWide(
  lines: string[][],
  warnings: string[],
): FactsetRow[] | null {
  if (lines.length < 2) return null;
  // Find max column count.
  const maxCols = Math.max(...lines.map((l) => l.length));
  if (maxCols < 2) return null;

  const colMeta: WideColMeta[] = Array.from({ length: maxCols }, () => ({}));
  const out: FactsetRow[] = [];
  let dataRowsStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    if (!row || row.every((c) => !c)) continue;
    const firstCell = (row[0] ?? "").trim().toLowerCase();
    const metaKind = META_KEYS[firstCell];
    if (metaKind && !dataRowsStarted) {
      for (let c = 1; c < row.length; c++) {
        const v = (row[c] ?? "").trim();
        if (!v) continue;
        colMeta[c][metaKind] = v;
      }
      continue;
    }
    // Skip a generic "Date,Value,Value,..." header row.
    if (!dataRowsStarted && firstCell === "date") {
      continue;
    }
    // First cell might be a date now.
    const date = normaliseDate(row[0] ?? "");
    if (!date) {
      if (!dataRowsStarted) {
        // still in metadata zone but unrecognised header — skip silently
        continue;
      }
      warnings.push(`Skipped row ${i + 1}: first cell "${row[0]}" not a date`);
      continue;
    }
    dataRowsStarted = true;
    for (let c = 1; c < row.length; c++) {
      const meta = colMeta[c];
      if (!meta.seriesId) continue;
      const val = parseNumber(row[c] ?? "");
      if (val == null) continue;
      out.push({
        seriesId: meta.seriesId,
        seriesLabel: meta.label || meta.seriesId,
        date,
        value: val,
        sourceMnemonic: meta.mnemonic || null,
        unit: meta.unit || null,
        frequency: meta.frequency || null,
      });
    }
  }
  // If no meta seriesId rows were ever found, this wasn't a valid wide layout.
  if (colMeta.every((m) => !m.seriesId)) return null;
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Public entrypoint.
// ────────────────────────────────────────────────────────────────────────────
export function parseFactsetCsv(
  text: string,
  opts: { sourceName?: string } = {},
): ParseResult {
  const warnings: string[] = [];
  try {
    if (!text || !text.trim()) {
      return { ok: false, error: "Empty input", warnings };
    }
    // Strip BOM
    const clean = text.replace(/^\uFEFF/, "");
    const rawLines = clean.split(/\r?\n/);
    // First non-blank line determines delimiter.
    const firstNonBlank = rawLines.find((l) => l.trim().length > 0) || "";
    const delim = detectDelimiter(firstNonBlank);
    const tokenised = rawLines
      .map((l) => splitCsvLine(l, delim))
      .filter((cells) => cells.some((c) => c && c.length > 0));

    if (tokenised.length === 0) {
      return { ok: false, error: "No non-empty rows", warnings };
    }

    let rows: FactsetRow[] | null = tryParseLong(tokenised, warnings);
    let format: "long" | "wide" = "long";
    if (!rows || rows.length === 0) {
      warnings.length = 0; // reset warnings if long didn't match
      rows = tryParseWide(tokenised, warnings);
      format = "wide";
    }
    if (!rows || rows.length === 0) {
      return {
        ok: false,
        error:
          "Could not detect long or wide format. Expected header with series_id/date/value, or a wide layout with metadata rows (Series ID, Label, …) above date rows.",
        warnings,
      };
    }
    // Tag source name.
    const sourceName = opts.sourceName ?? "factset";
    for (const r of rows) r.sourceName = sourceName;
    const seriesIds = Array.from(new Set(rows.map((r) => r.seriesId)));
    return { ok: true, rows, seriesIds, format, delimiter: delim, warnings };
  } catch (e: any) {
    return { ok: false, error: `Parse failed: ${e?.message ?? String(e)}`, warnings };
  }
}

// CSV template the UI can offer to the user as a download.
export const FACTSET_LONG_TEMPLATE_CSV = `series_id,series_label,date,value,source_mnemonic,unit,frequency
cn_gdp_yoy,China GDP YoY,2025-12-31,5.1,GDP_CHN_YOY,%,Q
cn_gdp_yoy,China GDP YoY,2026-03-31,5.0,GDP_CHN_YOY,%,Q
cn_cpi_yoy,China CPI YoY,2026-04-30,1.2,CPI_CHN_YOY,%,M
cn_cpi_yoy,China CPI YoY,2026-05-31,1.3,CPI_CHN_YOY,%,M
`;
