/**
 * CEIC import parser tests — pure, no DB, no network.
 *
 * Run: npx tsx scripts/test-ceic-import.ts
 *
 * Covers every layout the CDMNext exporter is known to emit (long, wide,
 * quarterly, two-column), plus the parsing behaviours the commit pipeline
 * depends on: blank preservation, date normalisation to period end, revision
 * detection inputs, and honest failure on junk.
 *
 * The DB-backed behaviours (idempotency, vintage history, mapping, stale
 * fallback, bridge auth) are covered by scripts/test-ceic-integration.ts,
 * which boots the real storage layer.
 */

import {
  parseCeicText,
  parseCeicWorkbook,
  normaliseCeicDate,
  parseCeicNumber,
  type CeicParseResult,
} from "../server/clients/ceicImport";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function ok(r: CeicParseResult): Extract<CeicParseResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected parse success, got: ${r.error}`);
  return r;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A. Long CDM export, with a genuinely blank observation. */
export const FIXTURE_LONG = `series_id,series_label,date,value,unit,frequency,source,country
123456,Total Social Financing: Stock,2026-05,428900,RMB bn,Monthly,PBoC,China
123456,Total Social Financing: Stock,2026-06,431500,RMB bn,Monthly,PBoC,China
123456,Total Social Financing: Stock,2026-07,,RMB bn,Monthly,PBoC,China
789012,DR007,2026-07-30,1.71,% pa,Daily,CFETS,China
789012,DR007,2026-07-31,1.72,% pa,Daily,CFETS,China
`;

/** B. Wide CDM export with a full metadata header block. */
export const FIXTURE_WIDE = `Series ID,123456,789012
Name,Total Social Financing: Stock,SHIBOR: 3 Month
Country,China,China
Frequency,Monthly,Monthly
Unit,RMB bn,% pa
Source,PBoC,National Interbank Funding Center
Date,,
2026-05,428900,1.95
2026-06,431500,1.92
2026-07,,1.88
`;

/** B2. Wide export with quarterly periods and a trailing CDM footer line. */
export const FIXTURE_WIDE_QUARTERLY = `Series ID,555001,555002
Name,GDP: Real YoY,Industrial Profit: YTD YoY
Frequency,Quarterly,Quarterly
Unit,%,%
2025Q3,4.8,1.2
2025Q4,5.1,0.9
2026Q1,5.0,-0.4
Source: CEIC Data,,
`;

/** B3. Wide export with NO row labels in column A (CDM sometimes omits them). */
export const FIXTURE_WIDE_UNLABELLED = `,Total Social Financing: Stock,DR007
2026-06,431500,1.68
2026-07,433100,1.72
`;

/** C. Bare two-column export — identity must come from the caller. */
export const FIXTURE_TWO_COLUMN = `Date,Value
31/05/2026,428900
30/06/2026,431500
31/07/2026,
`;

/** D. Mixed period formats that CEIC/CDM emit in the wild. */
export const FIXTURE_MIXED_DATES = `series_id,series_label,date,value
A1,Annual series,2024,101.2
A1,Annual series,2025,103.4
A1,Annual series,Mar-2026,105.1
A1,Annual series,2026M04,106.0
A1,Annual series,2026-Q2,107.5
`;

/** E. Second vintage of FIXTURE_LONG with a restated June value. */
export const FIXTURE_LONG_REVISED = `series_id,series_label,date,value,unit,frequency,source,country
123456,Total Social Financing: Stock,2026-05,428900,RMB bn,Monthly,PBoC,China
123456,Total Social Financing: Stock,2026-06,432200,RMB bn,Monthly,PBoC,China
123456,Total Social Financing: Stock,2026-07,435800,RMB bn,Monthly,PBoC,China
`;

export const FIXTURE_JUNK = `this is not
a spreadsheet at all
`;

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("\n── date normalisation ──");
eq("YYYY-MM → period end", normaliseCeicDate("2026-02"), "2026-02-28");
eq("leap February", normaliseCeicDate("2024-02"), "2024-02-29");
eq("ISO passthrough", normaliseCeicDate("2026-07-15"), "2026-07-15");
eq("2026Q1", normaliseCeicDate("2026Q1"), "2026-03-31");
eq("Q4 2025", normaliseCeicDate("Q4 2025"), "2025-12-31");
eq("2026-Q2", normaliseCeicDate("2026-Q2"), "2026-06-30");
eq("bare year → 31 Dec", normaliseCeicDate("2025"), "2025-12-31");
eq("CEIC month code 2026M04", normaliseCeicDate("2026M04"), "2026-04-30");
eq("half year 2026H1", normaliseCeicDate("2026H1"), "2026-06-30");
eq("Mar-2026", normaliseCeicDate("Mar-2026"), "2026-03-31");
eq("September 2025", normaliseCeicDate("September 2025"), "2025-09-30");
eq("DD/MM disambiguated by day>12", normaliseCeicDate("31/05/2026"), "2026-05-31");
eq("forced dmy", normaliseCeicDate("05/06/2026", "dmy"), "2026-06-05");
eq("forced mdy", normaliseCeicDate("05/06/2026", "mdy"), "2026-05-06");
eq("non-date returns null", normaliseCeicDate("Series ID"), null);
eq("empty returns null", normaliseCeicDate(""), null);

console.log("\n── number parsing ──");
eq("plain", parseCeicNumber("1.25"), 1.25);
eq("thousands separators", parseCeicNumber("428,900"), 428900);
eq("percent suffix", parseCeicNumber("5.1%"), 5.1);
eq("parenthesised negative", parseCeicNumber("(1.2)"), -1.2);
eq("blank → null", parseCeicNumber(""), null);
eq("n/a → null", parseCeicNumber("N/A"), null);
eq("dash → null", parseCeicNumber("—"), null);
eq("junk → undefined", parseCeicNumber("pending"), undefined);

console.log("\n── layout A: long ──");
{
  const r = ok(parseCeicText(FIXTURE_LONG));
  eq("layout", r.layout, "long");
  eq("series count", r.seriesCount, 2);
  eq("observation count (blank kept)", r.rowCount, 5);
  const tsf = r.series.find((s) => s.seriesId === "123456")!;
  eq("label", tsf.label, "Total Social Financing: Stock");
  eq("unit", tsf.unit, "RMB bn");
  eq("frequency", tsf.frequency, "Monthly");
  eq("source", tsf.originalSource, "PBoC");
  eq("geo", tsf.geo, "China");
  eq("first date", tsf.firstDate, "2026-05-31");
  eq("last date", tsf.lastDate, "2026-07-31");
  eq("points vs non-null values", [tsf.pointCount, tsf.valueCount], [3, 2]);
  const july = r.points.find((p) => p.seriesId === "123456" && p.observationDate === "2026-07-31")!;
  eq("blank preserved as null (NOT dropped)", july.value, null);
  const dr = r.series.find((s) => s.seriesId === "789012")!;
  eq("daily series dates untouched", [dr.firstDate, dr.lastDate], ["2026-07-30", "2026-07-31"]);
}

console.log("\n── layout B: wide ──");
{
  const r = ok(parseCeicText(FIXTURE_WIDE));
  eq("layout", r.layout, "wide");
  eq("series count", r.seriesCount, 2);
  eq("observation count", r.rowCount, 6);
  const shibor = r.series.find((s) => s.seriesId === "789012")!;
  eq("name from header row", shibor.label, "SHIBOR: 3 Month");
  eq("unit from header row", shibor.unit, "% pa");
  eq("source from header row", shibor.originalSource, "National Interbank Funding Center");
  const tsfJul = r.points.find((p) => p.seriesId === "123456" && p.observationDate === "2026-07-31")!;
  eq("blank cell → null", tsfJul.value, null);
  const shiborJul = r.points.find((p) => p.seriesId === "789012" && p.observationDate === "2026-07-31")!;
  eq("adjacent column unaffected by the blank", shiborJul.value, 1.88);
}

console.log("\n── layout B2: wide quarterly + footer ──");
{
  const r = ok(parseCeicText(FIXTURE_WIDE_QUARTERLY));
  eq("layout", r.layout, "wide");
  eq("series count", r.seriesCount, 2);
  const gdp = r.series.find((s) => s.seriesId === "555001")!;
  eq("quarter → period end", [gdp.firstDate, gdp.lastDate], ["2025-09-30", "2026-03-31"]);
  eq("quarterly observations", gdp.pointCount, 3);
  check(
    "CDM footer row ignored, not parsed as data",
    !r.points.some((p) => p.observationDate.startsWith("Source")),
  );
}

console.log("\n── layout B3: wide with unlabelled header ──");
{
  const r = ok(parseCeicText(FIXTURE_WIDE_UNLABELLED));
  eq("layout", r.layout, "wide");
  eq("series count", r.seriesCount, 2);
  check(
    "identity derived from the name row",
    r.series.some((s) => s.label === "DR007"),
    r.series.map((s) => s.label),
  );
}

console.log("\n── layout C: two column ──");
{
  const noId = parseCeicText(FIXTURE_TWO_COLUMN);
  check("rejected without a caller-supplied series id", !noId.ok);
  check(
    "error explains the fix",
    !noId.ok && /two-column/i.test(noId.error),
    !noId.ok ? noId.error : "",
  );

  const r = ok(
    parseCeicText(FIXTURE_TWO_COLUMN, {
      defaults: { seriesId: "123456", label: "TSF Stock", unit: "RMB bn", frequency: "Monthly" },
    }),
  );
  eq("layout", r.layout, "two_column");
  eq("series count", r.seriesCount, 1);
  eq("observation count (blank kept)", r.rowCount, 3);
  eq("caller metadata applied", r.series[0].unit, "RMB bn");
  eq("DD/MM/YYYY parsed correctly", r.points[0].observationDate, "2026-05-31");
  eq("trailing blank preserved", r.points[2].value, null);
}

console.log("\n── mixed period formats in one series ──");
{
  const r = ok(parseCeicText(FIXTURE_MIXED_DATES));
  eq("all five periods normalised", r.rowCount, 5);
  eq(
    "period ends",
    r.points.map((p) => p.observationDate),
    ["2024-12-31", "2025-12-31", "2026-03-31", "2026-04-30", "2026-06-30"],
  );
}

console.log("\n── tab + semicolon delimiters ──");
{
  const tsv = FIXTURE_LONG.replace(/,/g, "\t");
  const r = ok(parseCeicText(tsv));
  eq("tab delimiter detected", r.delimiter, "\t");
  eq("same series count as CSV", r.seriesCount, 2);

  const ssv = "series_id;series_label;date;value\nX1;Test;2026-01;1.5\nX1;Test;2026-02;1.6\n";
  const r2 = ok(parseCeicText(ssv));
  eq("semicolon delimiter detected", r2.delimiter, ";");
  eq("rows", r2.rowCount, 2);
}

console.log("\n── revision fixture shape (feeds vintage tests) ──");
{
  const v1 = ok(parseCeicText(FIXTURE_LONG));
  const v2 = ok(parseCeicText(FIXTURE_LONG_REVISED));
  const jun1 = v1.points.find((p) => p.observationDate === "2026-06-30")!;
  const jun2 = v2.points.find((p) => p.observationDate === "2026-06-30")!;
  check("June restated between vintages", jun1.value !== jun2.value, [jun1.value, jun2.value]);
  const jul2 = v2.points.find((p) => p.observationDate === "2026-07-31")!;
  eq("July filled in the second vintage", jul2.value, 435800);
}

console.log("\n── failure modes ──");
{
  const junk = parseCeicText(FIXTURE_JUNK);
  check("junk rejected", !junk.ok);
  const empty = parseCeicText("");
  check("empty rejected", !empty.ok);
  check("never throws on binary-ish input", (() => {
    const r = parseCeicText("\u0000\u0001\u0002binary\u0000");
    return typeof r.ok === "boolean";
  })());
}

// ── XLSX round-trip (the CDMNext default export format) ────────────────────
// Build a workbook in memory with the same `xlsx` package the server uses,
// including a cover sheet the parser must skip and a real Date cell.
async function xlsxTests() {
  console.log("\n── layout B via .xlsx workbook ──");
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  const cover = XLSX.utils.aoa_to_sheet([["CEIC Data"], ["Generated for demo"]]);
  XLSX.utils.book_append_sheet(wb, cover, "Cover");

  const data = XLSX.utils.aoa_to_sheet([
    ["Series ID", "123456", "789012"],
    ["Name", "Total Social Financing: Stock", "SHIBOR: 3 Month"],
    ["Frequency", "Monthly", "Monthly"],
    ["Unit", "RMB bn", "% pa"],
    ["Source", "PBoC", "NIFC"],
    ["Date", "", ""],
    [new Date(Date.UTC(2026, 4, 31)), 428900, 1.95],
    [new Date(Date.UTC(2026, 5, 30)), 431500, 1.92],
    [new Date(Date.UTC(2026, 6, 31)), "", 1.88],
  ]);
  XLSX.utils.book_append_sheet(wb, data, "Time Series");

  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const r = await parseCeicWorkbook(buf);
  check("workbook parsed", r.ok, r.ok ? "" : r.error);
  if (r.ok) {
    eq("cover sheet skipped, data sheet used", r.sheetName, "Time Series");
    eq("layout", r.layout, "wide");
    eq("series count", r.seriesCount, 2);
    eq("observation count", r.rowCount, 6);
    eq("native Date cells normalised", r.points[0].observationDate, "2026-05-31");
    const jul = r.points.find((p) => p.seriesId === "123456" && p.observationDate === "2026-07-31")!;
    eq("empty spreadsheet cell → null", jul.value, null);
    eq("metadata harvested from header rows", r.series[0].unit, "RMB bn");
  }

  console.log("\n── non-workbook bytes ──");
  const bad = await parseCeicWorkbook(Buffer.from("not a workbook at all"));
  check("garbage buffer fails cleanly, no throw", !bad.ok);
}

xlsxTests()
  .catch((e) => {
    failed += 1;
    console.error("  ✗ xlsx suite crashed —", e?.message ?? e);
  })
  .finally(() => {
    console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
