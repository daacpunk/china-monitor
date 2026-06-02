/**
 * Standalone smoke test for parseFactsetCsv — does not touch storage.
 * Run: npx tsx scripts/test-factset-parser.ts
 */
import { parseFactsetCsv } from "../server/clients/factsetImport";

const LONG = `series_id,series_label,date,value,source_mnemonic,unit,frequency
cn_gdp_yoy,China GDP YoY,2025-12-31,5.1,GDP_CHN_YOY,%,Q
cn_gdp_yoy,China GDP YoY,2026-03-31,5.0,GDP_CHN_YOY,%,Q
cn_cpi_yoy,China CPI YoY,2026-04-30,1.2,CPI_CHN_YOY,%,M
`;

const WIDE = `Series ID,,cn_gdp_yoy,cn_cpi_yoy
Label,,"China GDP YoY","China CPI YoY"
Mnemonic,,GDP_CHN_YOY,CPI_CHN_YOY
Unit,,%,%
Frequency,,Q,M
Date,,Value,Value
2025-12-31,,5.1,1.0
2026-03-31,,5.0,1.2
2026-04-30,,,1.3
`;

const QUARTERS = `series_id,series_label,date,value
cn_gdp,China GDP YoY,Q4 2025,5.1
cn_gdp,China GDP YoY,2026Q1,5.0
cn_cpi,China CPI YoY,Mar-2026,1.0
cn_cpi,China CPI YoY,April 2026,1.2
`;

const TAB = `series_id\tseries_label\tdate\tvalue\nfoo\tFoo Series\t2026-01-31\t10.5\nfoo\tFoo Series\t2026-02-28\t11.0\n`;

const BAD = `something\nnonsense\nrows`;

function show(label: string, r: ReturnType<typeof parseFactsetCsv>) {
  console.log(`\n── ${label} ──`);
  if (!r.ok) {
    console.log("FAIL:", r.error);
    if (r.warnings.length) console.log("warnings:", r.warnings);
    return;
  }
  console.log(
    `OK  format=${r.format} delim=${JSON.stringify(r.delimiter)} ` +
      `rows=${r.rows.length} series=[${r.seriesIds.join(", ")}]`,
  );
  if (r.warnings.length) console.log("warnings:", r.warnings);
  console.log("first 3:", r.rows.slice(0, 3));
}

show("long", parseFactsetCsv(LONG));
show("wide", parseFactsetCsv(WIDE));
show("quarters/months", parseFactsetCsv(QUARTERS));
show("tab-separated", parseFactsetCsv(TAB));
show("garbage", parseFactsetCsv(BAD));
