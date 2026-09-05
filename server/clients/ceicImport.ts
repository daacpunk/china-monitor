/**
 * CEIC CDMNext import parser (Phase 7).
 *
 * WHY THIS EXISTS
 * ───────────────
 * The production CEIC API key has NO data entitlement — `/series/{id}/data`
 * answers with an explicit 403 deny. The account the user actually holds is a
 * *website / CDMNext* subscription. CDMNext can export up to 3,000 series at a
 * time to Excel/CSV, and (separately) CEIC ship a Python SDK that authenticates
 * with website credentials. Both of those routes produce tabular data, not JSON
 * from api.ceicdata.com — so this module is the single normaliser that turns
 * any of those tabular shapes into canonical China Monitor observations.
 *
 * This module is PURE: no DB, no network, never throws. It returns
 * `{ ok:false, error }` for envelope failures and collects per-row problems in
 * `warnings`. That keeps it trivially unit-testable (see
 * scripts/test-ceic-import.ts).
 *
 * SUPPORTED LAYOUTS
 * ─────────────────
 *  A. `long`  — one row per (series, date):
 *
 *       series_id,series_label,date,value,unit,frequency,source
 *       123456,China CPI YoY,2026-01,1.2,%,Monthly,NBS
 *
 *  B. `wide`  — first column = date, every other column = one CEIC series.
 *     CDMNext stacks several metadata header rows above the data block, and
 *     the label of each header row lives in column 0:
 *
 *       Series ID,123456,123457
 *       Name,China CPI YoY,China PPI YoY
 *       Country,China,China
 *       Frequency,Monthly,Monthly
 *       Unit,%,%
 *       Source,NBS,NBS
 *       Date,,
 *       2026-01,1.2,-0.5
 *       2026-02,,-0.4          ← blank preserved as NULL, not dropped
 *
 *     Unlabelled header rows are tolerated: the first unrecognised text row is
 *     treated as the series name, and an all-numeric text row as series IDs.
 *
 *  C. `two_column` — a bare `date,value` export. CEIC does not put the series
 *     identity in the file at all, so the caller MUST supply
 *     `defaults.seriesId` (the Imports UI collects it).
 *
 * DATE NORMALISATION
 * ──────────────────
 * Everything is normalised to an ISO `YYYY-MM-DD` *period end*: `2026-01`
 * → `2026-01-31`, `2026Q1` → `2026-03-31`, `2026` → `2026-12-31`. Period-end
 * anchoring matches what the rest of the registry (NBS/FRED/AKShare) already
 * uses, so mapped CEIC series line up with their fallbacks on the same axis.
 */

export type CeicLayout = "long" | "wide" | "two_column";

/** One normalised observation. `value` is deliberately nullable. */
export interface CeicPoint {
  seriesId: string;
  observationDate: string; // ISO YYYY-MM-DD (period end)
  value: number | null;
}

/** Per-series metadata harvested from the export. */
export interface CeicSeriesMeta {
  seriesId: string;
  mnemonic: string | null;
  label: string;
  labelZh: string | null;
  geo: string | null;
  frequency: string | null;
  unit: string | null;
  originalSource: string | null;
  firstDate: string | null;
  lastDate: string | null;
  pointCount: number;
  /** Non-null observations only — a series of pure blanks is a red flag. */
  valueCount: number;
}

export interface CeicParseSuccess {
  ok: true;
  layout: CeicLayout;
  delimiter: "," | "\t" | ";" | null; // null for xlsx
  points: CeicPoint[];
  series: CeicSeriesMeta[];
  rowCount: number;
  seriesCount: number;
  warnings: string[];
}
export interface CeicParseFailure {
  ok: false;
  error: string;
  warnings: string[];
}
export type CeicParseResult = CeicParseSuccess | CeicParseFailure;

export interface CeicParseOptions {
  /**
   * Used for `two_column` exports (and as a fallback when a wide column has no
   * discoverable identity). Mirrors the CDMNext "one series per sheet" export.
   */
  defaults?: {
    seriesId?: string;
    label?: string;
    unit?: string;
    frequency?: string;
    geo?: string;
    originalSource?: string;
  };
  /** Disambiguate slash dates. `auto` inspects the data first. */
  dateFormat?: "auto" | "mdy" | "dmy";
  /** Force a layout instead of auto-detecting (mostly for tests). */
  forceLayout?: CeicLayout;
}

// ────────────────────────────────────────────────────────────────────────────
// Tokenisation
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

function detectDelimiter(sample: string[]): "," | "\t" | ";" {
  const joined = sample.join("\n");
  const tabs = (joined.match(/\t/g) ?? []).length;
  const semis = (joined.match(/;/g) ?? []).length;
  const commas = (joined.match(/,/g) ?? []).length;
  if (tabs > 0 && tabs >= commas && tabs >= semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

/**
 * CSV/TSV text → grid. Unlike the FactSet parser we KEEP fully-blank interior
 * rows out but keep blank *cells*, because a blank cell in a CDM export is a
 * real "no observation" signal that must survive as NULL.
 */
export function textToGrid(text: string): { grid: string[][]; delimiter: "," | "\t" | ";" } {
  const clean = text.replace(/^\uFEFF/, "");
  const rawLines = clean.split(/\r?\n/);
  const sample = rawLines.filter((l) => l.trim().length > 0).slice(0, 12);
  const delimiter = detectDelimiter(sample);
  const grid = rawLines
    .map((l) => splitCsvLine(l, delimiter))
    .filter((cells) => cells.some((c) => c && c.length > 0));
  return { grid, delimiter };
}

// ────────────────────────────────────────────────────────────────────────────
// Date + number normalisation
// ────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function eom(y: number, m: number): string {
  return iso(y, m, lastDayOfMonth(y, m));
}

/**
 * Normalise any CEIC/CDM period token to an ISO period-end date.
 * Returns null when the token is not a date (callers use that to find the
 * boundary between the metadata header block and the data block).
 */
export function normaliseCeicDate(raw: unknown, fmt: "auto" | "mdy" | "dmy" = "auto"): string | null {
  if (raw == null) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return iso(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  }
  const s = String(raw).trim();
  if (!s) return null;

  // ISO YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return iso(y, mo, d);
  }
  // YYYY-MM or YYYY/MM → period end
  m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return eom(y, mo);
  }
  // YYYY/M/D
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return iso(+m[1], mo, +m[3]);
  }
  // Quarters: 2026Q1 / 2026-Q1 / Q1 2026 / Q1-2026 / 2026 Q1
  m = s.match(/^(\d{4})[\s-]?Q([1-4])$/i);
  if (m) return eom(+m[1], +m[2] * 3);
  m = s.match(/^Q([1-4])[\s-/]?(\d{4})$/i);
  if (m) return eom(+m[2], +m[1] * 3);
  // CEIC month code: 2026M01 ; quarter code handled above
  m = s.match(/^(\d{4})M(\d{1,2})$/i);
  if (m) {
    const mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return eom(+m[1], mo);
  }
  // Half-years: 2026H1 / 2026S2
  m = s.match(/^(\d{4})[HS]([12])$/i);
  if (m) return eom(+m[1], +m[2] * 6);
  // "Mar-2026", "March 2026", "Mar 26"
  m = s.match(/^([A-Za-z]{3,9})[\s-]+(\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) {
      let y = +m[2];
      if (y < 100) y += y < 70 ? 2000 : 1900;
      return eom(y, mo);
    }
  }
  // "2026 Mar" / "2026-Mar"
  m = s.match(/^(\d{4})[\s-]+([A-Za-z]{3,9})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return eom(+m[1], mo);
  }
  // Slash dates: DD/MM/YYYY vs MM/DD/YYYY
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    let mo: number, d: number;
    if (fmt === "dmy") { d = a; mo = b; }
    else if (fmt === "mdy") { mo = a; d = b; }
    else if (a > 12 && b <= 12) { d = a; mo = b; }
    else if (b > 12 && a <= 12) { mo = a; d = b; }
    else { mo = a; d = b; } // genuinely ambiguous → US default, same as FactSet path
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return iso(y, mo, d);
  }
  // "31-01-2026" / "31.01.2026"
  m = s.match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    const d = a > 12 ? a : (fmt === "mdy" ? b : a);
    const mo = a > 12 ? b : (fmt === "mdy" ? a : b);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return iso(y, mo, d);
  }
  // Bare year (annual series) → 31 Dec
  m = s.match(/^(\d{4})$/);
  if (m) {
    const y = +m[1];
    if (y >= 1900 && y <= 2100) return `${y}-12-31`;
  }
  // Excel serial (5-digit). Epoch 1899-12-30 accounts for the 1900 leap bug.
  m = s.match(/^(\d{5})(?:\.0+)?$/);
  if (m) {
    const dt = new Date(Date.UTC(1899, 11, 30) + +m[1] * 86_400_000);
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return null;
}

const BLANK_TOKENS = new Set(["", "-", "—", "–", "n/a", "na", "nan", "null", "#n/a", ".", "..", "…"]);

/**
 * Parse a numeric cell. Returns `undefined` when the cell is genuinely
 * non-numeric junk and `null` when it is a legitimate blank/missing marker —
 * the caller keeps nulls as observations and warns about junk.
 */
export function parseCeicNumber(raw: unknown): number | null | undefined {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (BLANK_TOKENS.has(s.toLowerCase())) return null;
  // Parenthesised negatives: (1.2) → -1.2
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/,/g, "").replace(/\s/g, "").replace(/%$/, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return neg ? -n : n;
}

// ────────────────────────────────────────────────────────────────────────────
// Header vocabulary
// ────────────────────────────────────────────────────────────────────────────

type MetaKind =
  | "seriesId" | "mnemonic" | "label" | "labelZh" | "geo"
  | "frequency" | "unit" | "originalSource" | "status" | "lastUpdate";

const META_KEYS: Record<string, MetaKind> = {
  "series id": "seriesId", "series_id": "seriesId", "seriesid": "seriesId",
  "id": "seriesId", "series code": "seriesId", "series_code": "seriesId",
  "code": "seriesId", "ceic id": "seriesId", "ceic_id": "seriesId",
  "sr code": "seriesId", "srcode": "seriesId",
  "mnemonic": "mnemonic", "series mnemonic": "mnemonic", "short name": "mnemonic",
  "ticker": "mnemonic",
  "name": "label", "series name": "label", "series": "label", "label": "label",
  "series_label": "label", "series label": "label", "description": "label",
  "indicator": "label", "title": "label",
  "name (chinese)": "labelZh", "chinese name": "labelZh", "name_zh": "labelZh",
  "label_zh": "labelZh", "名称": "labelZh",
  "country": "geo", "country/region": "geo", "region": "geo", "geo": "geo",
  "area": "geo", "economy": "geo",
  "frequency": "frequency", "freq": "frequency", "periodicity": "frequency",
  "unit": "unit", "units": "unit", "unit of measure": "unit", "uom": "unit",
  "source": "originalSource", "source_name": "originalSource",
  "original source": "originalSource", "data source": "originalSource",
  "provider": "originalSource",
  "status": "status", "series status": "status",
  "last update": "lastUpdate", "last updated": "lastUpdate",
  "last update time": "lastUpdate", "updated": "lastUpdate",
};

// Labels CDM puts in column A of the row that heads the DATA block. An empty
// string is deliberately NOT here: CDM also emits header rows with a blank
// column A and real series names to the right, and those must be salvaged.
const DATE_COL_HEADERS = new Set([
  "date", "dates", "period", "periods", "time", "timeperiod", "time period",
  "observation date", "obs date", "date/series", "series/date",
]);

/** Placeholder cells CDM writes under a date header ("Date,Value,Value"). */
const VALUE_PLACEHOLDERS = new Set(["", "value", "values", "val", "data"]);

function metaKindOf(cell: string): MetaKind | undefined {
  return META_KEYS[cell.trim().toLowerCase().replace(/[:*]+$/, "")];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

// ────────────────────────────────────────────────────────────────────────────
// Layout A — long
// ────────────────────────────────────────────────────────────────────────────

function findCol(header: string[], kinds: MetaKind[]): number {
  for (let i = 0; i < header.length; i++) {
    const k = metaKindOf(header[i]);
    if (k && kinds.includes(k)) return i;
  }
  return -1;
}

function parseLong(
  grid: string[][],
  opts: Required<Pick<CeicParseOptions, "dateFormat">> & CeicParseOptions,
  warnings: string[],
): { points: CeicPoint[]; series: Map<string, CeicSeriesMeta> } | null {
  if (grid.length < 2) return null;
  const header = grid[0].map((c) => c.trim().toLowerCase());
  const idIdx = findCol(grid[0], ["seriesId"]);
  const dateIdx = header.findIndex((c) =>
    ["date", "period", "observation date", "obs date", "time"].includes(c),
  );
  const valueIdx = header.findIndex((c) => ["value", "val", "observation", "data"].includes(c));
  if (idIdx < 0 || dateIdx < 0 || valueIdx < 0) return null;

  const labelIdx = findCol(grid[0], ["label"]);
  const zhIdx = findCol(grid[0], ["labelZh"]);
  const mnIdx = findCol(grid[0], ["mnemonic"]);
  const unitIdx = findCol(grid[0], ["unit"]);
  const freqIdx = findCol(grid[0], ["frequency"]);
  const srcIdx = findCol(grid[0], ["originalSource"]);
  const geoIdx = findCol(grid[0], ["geo"]);

  const points: CeicPoint[] = [];
  const series = new Map<string, CeicSeriesMeta>();
  const at = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() || null : null);

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    const seriesId = (row[idIdx] ?? "").trim();
    const date = normaliseCeicDate(row[dateIdx] ?? "", opts.dateFormat);
    if (!seriesId) { warnings.push(`Row ${i + 1}: missing series id — skipped`); continue; }
    if (!date) { warnings.push(`Row ${i + 1}: unparseable date "${row[dateIdx] ?? ""}" — skipped`); continue; }
    const num = parseCeicNumber(row[valueIdx]);
    if (num === undefined) {
      warnings.push(`Row ${i + 1}: non-numeric value "${row[valueIdx]}" for ${seriesId} — stored as blank`);
    }
    const value = num === undefined ? null : num;
    points.push({ seriesId, observationDate: date, value });

    let meta = series.get(seriesId);
    if (!meta) {
      meta = {
        seriesId,
        mnemonic: at(row, mnIdx),
        label: at(row, labelIdx) ?? opts.defaults?.label ?? seriesId,
        labelZh: at(row, zhIdx),
        geo: at(row, geoIdx) ?? opts.defaults?.geo ?? null,
        frequency: at(row, freqIdx) ?? opts.defaults?.frequency ?? null,
        unit: at(row, unitIdx) ?? opts.defaults?.unit ?? null,
        originalSource: at(row, srcIdx) ?? opts.defaults?.originalSource ?? null,
        firstDate: date, lastDate: date, pointCount: 0, valueCount: 0,
      };
      series.set(seriesId, meta);
    }
    meta.pointCount += 1;
    if (value != null) meta.valueCount += 1;
    if (!meta.firstDate || date < meta.firstDate) meta.firstDate = date;
    if (!meta.lastDate || date > meta.lastDate) meta.lastDate = date;
  }
  if (!points.length) return null;
  return { points, series };
}

// ────────────────────────────────────────────────────────────────────────────
// Layout B — wide (the normal CDMNext "Time Series" export)
// ────────────────────────────────────────────────────────────────────────────

interface ColMeta {
  seriesId?: string;
  mnemonic?: string;
  label?: string;
  labelZh?: string;
  geo?: string;
  frequency?: string;
  unit?: string;
  originalSource?: string;
  status?: string;
}

function parseWide(
  grid: string[][],
  opts: Required<Pick<CeicParseOptions, "dateFormat">> & CeicParseOptions,
  warnings: string[],
): { points: CeicPoint[]; series: Map<string, CeicSeriesMeta> } | null {
  const maxCols = Math.max(...grid.map((l) => l.length));
  if (maxCols < 2) return null;

  // Locate the first data row: col 0 parses as a date.
  let dataStart = -1;
  for (let i = 0; i < grid.length; i++) {
    if (normaliseCeicDate(grid[i][0] ?? "", opts.dateFormat)) { dataStart = i; break; }
  }
  if (dataStart < 0) return null;

  const cols: ColMeta[] = Array.from({ length: maxCols }, () => ({}));
  const unlabelled: string[][] = [];

  for (let i = 0; i < dataStart; i++) {
    const row = grid[i];
    const first = (row[0] ?? "").trim();
    const kind = metaKindOf(first);
    if (kind) {
      if (kind === "status" || kind === "lastUpdate") {
        for (let c = 1; c < row.length; c++) {
          const v = (row[c] ?? "").trim();
          if (v && kind === "status") cols[c].status = v;
        }
        continue;
      }
      for (let c = 1; c < row.length; c++) {
        const v = (row[c] ?? "").trim();
        if (v) (cols[c] as any)[kind] = v;
      }
      continue;
    }
    // A header row whose col-0 label CDMNext omitted. Remember it; we assign
    // meaning below once we know what is still missing. "Date,Value,Value"
    // separator rows carry no identity and are dropped here.
    const rest = row.slice(1).map((c) => (c ?? "").trim());
    const carriesIdentity = rest.some((c) => c.length > 0 && !VALUE_PLACEHOLDERS.has(c.toLowerCase()));
    if (carriesIdentity && !DATE_COL_HEADERS.has(first.toLowerCase())) {
      unlabelled.push(row);
    }
  }

  // Assign unlabelled header rows: an all-numeric row is series IDs, the first
  // remaining text row is the series name.
  // Only the first unlabelled header row is salvaged; anything further is
  // ambiguous enough that guessing would do more harm than good.
  const salvage = unlabelled[0];
  if (salvage) {
    const vals = salvage.slice(1).filter((c) => (c ?? "").trim());
    const allNumeric = vals.length > 0 && vals.every((v) => /^\d{3,}$/.test(v.trim()));
    const target: keyof ColMeta = allNumeric
      ? "seriesId"
      : cols.some((c) => c.label)
        ? "mnemonic"
        : "label";
    for (let c = 1; c < salvage.length; c++) {
      const v = (salvage[c] ?? "").trim();
      if (v && !(cols[c] as any)[target]) (cols[c] as any)[target] = v;
    }
    if (unlabelled.length > 1) {
      warnings.push(
        `${unlabelled.length - 1} unlabelled header row(s) ignored — add a label in column A (e.g. "Unit", "Frequency") to capture them`,
      );
    }
  }

  // Resolve a stable identity per column.
  const identity: (string | null)[] = cols.map((m, c) => {
    if (c === 0) return null;
    if (m.seriesId) return m.seriesId;
    if (m.mnemonic) return m.mnemonic;
    if (m.label) return slugify(m.label) || null;
    return null;
  });
  const activeCols = identity.map((id, c) => (c > 0 && id ? c : -1)).filter((c) => c > 0);
  if (!activeCols.length) return null;

  const points: CeicPoint[] = [];
  const series = new Map<string, CeicSeriesMeta>();
  for (const c of activeCols) {
    const id = identity[c]!;
    const m = cols[c];
    if (!series.has(id)) {
      series.set(id, {
        seriesId: id,
        mnemonic: m.mnemonic ?? null,
        label: m.label ?? opts.defaults?.label ?? id,
        labelZh: m.labelZh ?? null,
        geo: m.geo ?? opts.defaults?.geo ?? null,
        frequency: m.frequency ?? opts.defaults?.frequency ?? null,
        unit: m.unit ?? opts.defaults?.unit ?? null,
        originalSource: m.originalSource ?? opts.defaults?.originalSource ?? null,
        firstDate: null, lastDate: null, pointCount: 0, valueCount: 0,
      });
    }
  }

  for (let i = dataStart; i < grid.length; i++) {
    const row = grid[i];
    const date = normaliseCeicDate(row[0] ?? "", opts.dateFormat);
    if (!date) {
      // CDM footers ("Source: CEIC", "Generated on …") land here — ignore quietly
      // unless the row actually carries numbers.
      if (row.slice(1).some((c) => parseCeicNumber(c) != null)) {
        warnings.push(`Row ${i + 1}: first cell "${row[0]}" is not a date — row skipped`);
      }
      continue;
    }
    for (const c of activeCols) {
      const id = identity[c]!;
      const num = parseCeicNumber(row[c]);
      if (num === undefined) {
        warnings.push(`Row ${i + 1}, column ${c + 1}: non-numeric "${row[c]}" — stored as blank`);
      }
      const value = num === undefined ? null : num;
      points.push({ seriesId: id, observationDate: date, value });
      const meta = series.get(id)!;
      meta.pointCount += 1;
      if (value != null) meta.valueCount += 1;
      if (!meta.firstDate || date < meta.firstDate) meta.firstDate = date;
      if (!meta.lastDate || date > meta.lastDate) meta.lastDate = date;
    }
  }

  if (!points.length) return null;
  return { points, series };
}

// ────────────────────────────────────────────────────────────────────────────
// Layout C — two column, identity supplied by the caller
// ────────────────────────────────────────────────────────────────────────────

function parseTwoColumn(
  grid: string[][],
  opts: Required<Pick<CeicParseOptions, "dateFormat">> & CeicParseOptions,
  warnings: string[],
): { points: CeicPoint[]; series: Map<string, CeicSeriesMeta> } | null {
  const seriesId = opts.defaults?.seriesId?.trim();
  if (!seriesId) return null;
  const points: CeicPoint[] = [];
  const meta: CeicSeriesMeta = {
    seriesId,
    mnemonic: null,
    label: opts.defaults?.label?.trim() || seriesId,
    labelZh: null,
    geo: opts.defaults?.geo ?? null,
    frequency: opts.defaults?.frequency ?? null,
    unit: opts.defaults?.unit ?? null,
    originalSource: opts.defaults?.originalSource ?? null,
    firstDate: null, lastDate: null, pointCount: 0, valueCount: 0,
  };
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    const date = normaliseCeicDate(row[0] ?? "", opts.dateFormat);
    if (!date) continue; // header/footer lines
    const num = parseCeicNumber(row[1]);
    if (num === undefined) {
      warnings.push(`Row ${i + 1}: non-numeric value "${row[1]}" — stored as blank`);
    }
    const value = num === undefined ? null : num;
    points.push({ seriesId, observationDate: date, value });
    meta.pointCount += 1;
    if (value != null) meta.valueCount += 1;
    if (!meta.firstDate || date < meta.firstDate) meta.firstDate = date;
    if (!meta.lastDate || date > meta.lastDate) meta.lastDate = date;
  }
  if (!points.length) return null;
  return { points, series: new Map([[seriesId, meta]]) };
}

// ────────────────────────────────────────────────────────────────────────────
// Public entrypoints
// ────────────────────────────────────────────────────────────────────────────

/** Parse an already-tokenised grid (used by both the text and xlsx paths). */
export function parseCeicGrid(
  grid: string[][],
  options: CeicParseOptions = {},
  delimiter: "," | "\t" | ";" | null = null,
): CeicParseResult {
  const warnings: string[] = [];
  const opts = { dateFormat: options.dateFormat ?? "auto", ...options } as Required<
    Pick<CeicParseOptions, "dateFormat">
  > &
    CeicParseOptions;
  try {
    if (!grid.length) return { ok: false, error: "No non-empty rows", warnings };

    const attempts: { layout: CeicLayout; fn: () => ReturnType<typeof parseLong> }[] = options.forceLayout
      ? [
          {
            layout: options.forceLayout,
            fn: () =>
              options.forceLayout === "long"
                ? parseLong(grid, opts, warnings)
                : options.forceLayout === "wide"
                  ? parseWide(grid, opts, warnings)
                  : parseTwoColumn(grid, opts, warnings),
          },
        ]
      : [
          { layout: "long", fn: () => parseLong(grid, opts, warnings) },
          { layout: "wide", fn: () => parseWide(grid, opts, warnings) },
          { layout: "two_column", fn: () => parseTwoColumn(grid, opts, warnings) },
        ];

    for (const a of attempts) {
      const before = warnings.length;
      const res = a.fn();
      if (res) {
        const series = Array.from(res.series.values()).sort((x, y) =>
          x.seriesId.localeCompare(y.seriesId),
        );
        for (const s of series) {
          if (s.valueCount === 0) {
            warnings.push(`Series ${s.seriesId} has ${s.pointCount} periods but no numeric values`);
          }
        }
        return {
          ok: true,
          layout: a.layout,
          delimiter,
          points: res.points,
          series,
          rowCount: res.points.length,
          seriesCount: series.length,
          warnings,
        };
      }
      warnings.length = before; // discard warnings from a layout that did not match
    }

    const twoColHint =
      grid[0] && grid.length > 1 && Math.max(...grid.map((r) => r.length)) === 2
        ? " This looks like a two-column date/value export — supply a series ID in the mapping fields to import it."
        : "";
    return {
      ok: false,
      error:
        "Could not detect a CEIC layout. Expected either a long export " +
        "(series_id/date/value header), a wide CDMNext export (date column plus " +
        "one column per series with Series ID / Name / Frequency / Unit header rows), " +
        "or a two-column date/value export." + twoColHint,
      warnings,
    };
  } catch (e: any) {
    return { ok: false, error: `Parse failed: ${e?.message ?? String(e)}`, warnings };
  }
}

/** Parse CSV / TSV / semicolon text (paste or uploaded .csv/.tsv/.txt). */
export function parseCeicText(text: string, options: CeicParseOptions = {}): CeicParseResult {
  if (!text || !text.trim()) return { ok: false, error: "Empty input", warnings: [] };
  const { grid, delimiter } = textToGrid(text);
  return parseCeicGrid(grid, options, delimiter);
}

/**
 * Parse a CDMNext .xlsx/.xls workbook. Uses the `xlsx` package, imported
 * lazily so the CSV path stays dependency-free. The first worksheet that
 * yields a usable layout wins (CDM sometimes puts a cover sheet first).
 */
export async function parseCeicWorkbook(
  buf: Buffer,
  options: CeicParseOptions = {},
): Promise<CeicParseResult & { sheetName?: string }> {
  let XLSX: any;
  try {
    XLSX = await import("xlsx");
  } catch (e: any) {
    return { ok: false, error: `xlsx package unavailable: ${e?.message ?? e}`, warnings: [] };
  }
  try {
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    const names: string[] = wb.SheetNames ?? [];
    if (!names.length) return { ok: false, error: "Workbook has no sheets", warnings: [] };
    let lastFailure: CeicParseResult | null = null;
    for (const name of names) {
      const sheet = wb.Sheets[name];
      const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
      const grid: string[][] = aoa
        .map((row) =>
          (row ?? []).map((cell) => {
            if (cell == null) return "";
            if (cell instanceof Date) {
              return iso(cell.getUTCFullYear(), cell.getUTCMonth() + 1, cell.getUTCDate());
            }
            return String(cell).trim();
          }),
        )
        .filter((cells) => cells.some((c) => c.length > 0));
      if (!grid.length) continue;
      const res = parseCeicGrid(grid, options, null);
      if (res.ok) return { ...res, sheetName: name };
      lastFailure = res;
    }
    return lastFailure ?? { ok: false, error: "No parseable worksheet found", warnings: [] };
  } catch (e: any) {
    return { ok: false, error: `Workbook read failed: ${e?.message ?? String(e)}`, warnings: [] };
  }
}

/** Template offered as a download from the Imports page. */
export const CEIC_LONG_TEMPLATE_CSV = `series_id,series_label,date,value,unit,frequency,source,country
<CEIC_SERIES_ID>,Total Social Financing: Stock,2026-06,431500,RMB bn,Monthly,PBoC,China
<CEIC_SERIES_ID>,Total Social Financing: Stock,2026-07,433100,RMB bn,Monthly,PBoC,China
<CEIC_SERIES_ID_2>,DR007,2026-07-31,1.72,% pa,Daily,CFETS,China
`;

export const CEIC_WIDE_TEMPLATE_CSV = `Series ID,<CEIC_SERIES_ID>,<CEIC_SERIES_ID_2>
Name,Total Social Financing: Stock,DR007
Country,China,China
Frequency,Monthly,Daily
Unit,RMB bn,% pa
Source,PBoC,CFETS
Date,,
2026-06,431500,1.68
2026-07,433100,1.72
`;
