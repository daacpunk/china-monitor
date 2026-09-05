/**
 * CEIC import bridge — end-to-end integration test.
 *
 * Run: npx tsx scripts/test-ceic-integration.ts
 *
 * Boots the real Express app in-process against the local PGlite database
 * (./data.pgdata), then exercises the whole Phase 7 path over HTTP:
 *
 *   1. empty-state catalog
 *   2. preview (dry run) — nothing written
 *   3. commit — catalog + vintage rows + imported_series current view
 *   4. duplicate upload — idempotent no-op on the file hash
 *   5. second vintage — revisions detected, earlier vintage retained
 *   6. mapping a CEIC series onto a registry logical ID (and rejecting junk)
 *   7. fetchSeries returns the FRESH mapped CEIC import with ceic_import provenance
 *   8. fetchSeries DEFERS a STALE mapped CEIC import to the free fallback chain
 *   9. bridge endpoint: missing token / bad token rejected, good token accepted
 *  10. status endpoint reports the real mode
 *
 * All fixtures use the `ZZTEST_` series-ID prefix and every row is removed in
 * the finally block, so running this never pollutes real imported data.
 */

import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Enable the bridge for the duration of this test. This is a throwaway value
// that exists only in this process; nothing is persisted.
const TEST_TOKEN = "test-token-" + Math.random().toString(36).slice(2, 18);
process.env.CEIC_IMPORT_TOKEN = TEST_TOKEN;

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const SID_A = "ZZTEST_TSF";
const SID_B = "ZZTEST_SHIBOR";
const SID_STALE = "ZZTEST_STALE";
const ALL_TEST_IDS = [SID_A, SID_B, SID_STALE, "ZZTEST_BRIDGE"];

/** Fresh dates so the freshness test is not time-bombed. */
function monthEnd(offsetMonths: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offsetMonths + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

const V1 = [
  "series_id,series_label,date,value,unit,frequency,source,country",
  `${SID_A},Test TSF Stock,${monthEnd(-2)},428900,RMB bn,Monthly,PBoC,China`,
  `${SID_A},Test TSF Stock,${monthEnd(-1)},431500,RMB bn,Monthly,PBoC,China`,
  `${SID_A},Test TSF Stock,${monthEnd(0)},,RMB bn,Monthly,PBoC,China`,
  `${SID_B},Test SHIBOR 3M,${monthEnd(-1)},1.92,% pa,Monthly,NIFC,China`,
  "",
].join("\n");

/** Same series, later vintage: June restated and the blank period filled in. */
const V2 = [
  "series_id,series_label,date,value,unit,frequency,source,country",
  `${SID_A},Test TSF Stock,${monthEnd(-2)},428900,RMB bn,Monthly,PBoC,China`,
  `${SID_A},Test TSF Stock,${monthEnd(-1)},432200,RMB bn,Monthly,PBoC,China`,
  `${SID_A},Test TSF Stock,${monthEnd(0)},435800,RMB bn,Monthly,PBoC,China`,
  "",
].join("\n");

/** A monthly series whose latest observation is ~2 years old ⇒ stale. */
const STALE_CSV = [
  "series_id,series_label,date,value,unit,frequency,source,country",
  `${SID_STALE},Test Stale CPI,${monthEnd(-26)},1.1,%,Monthly,NBS,China`,
  `${SID_STALE},Test Stale CPI,${monthEnd(-25)},1.2,%,Monthly,NBS,China`,
  "",
].join("\n");

async function main() {
  const { bootstrapSchema, storage, db } = await import("../server/storage");
  const { sql } = await import("drizzle-orm");
  const { registerRoutes } = await import("../server/routes");
  const { fetchSeries, invalidateCeicCatalogCache } = await import("../server/series/fetchSeries");

  async function purge() {
    for (const id of ALL_TEST_IDS) {
      await (db as any).execute(sql`DELETE FROM ceic_import_observations WHERE series_id = ${id}`);
      await (db as any).execute(sql`DELETE FROM ceic_import_catalog WHERE series_id = ${id}`);
      await (db as any).execute(sql`DELETE FROM imported_series WHERE series_id = ${id}`);
    }
    await (db as any).execute(sql`DELETE FROM ceic_import_files WHERE filename LIKE '%ZZTEST%'`);
    invalidateCeicCatalogCache();
  }

  await bootstrapSchema();
  await purge();

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  const port = (httpServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json };
  }

  try {
    // ── 1. Empty state ──────────────────────────────────────────────────────
    console.log("\n── 1. catalog empty state ──");
    {
      const r = await api("GET", "/api/ceic/catalog");
      eq("catalog endpoint ok", r.status, 200);
      check("catalog is an array", Array.isArray(r.json.catalog));
      check(
        "no ZZTEST rows present at start",
        !r.json.catalog.some((c: any) => c.seriesId.startsWith("ZZTEST_")),
      );
      check("registry logical IDs offered to the mapping UI", (r.json.logicalIds ?? []).length > 20);
      check("transform vocabulary exposed", (r.json.transforms ?? []).includes("divide_1000"));
    }

    // ── 2. Preview is a dry run ─────────────────────────────────────────────
    console.log("\n── 2. preview (dry run) ──");
    let v1Hash = "";
    {
      const r = await api("POST", "/api/imports/ceic", { text: V1, dryRun: true, filename: "ZZTEST_v1.csv" });
      eq("status", r.status, 200);
      eq("ok", r.json.ok, true);
      eq("layout detected", r.json.layout, "long");
      eq("series count", r.json.seriesCount, 2);
      eq("observation count (blank kept)", r.json.rowCount, 4);
      check("file hash returned", typeof r.json.fileHash === "string" && r.json.fileHash.length === 64);
      eq("not flagged duplicate", r.json.duplicate, false);
      v1Hash = r.json.fileHash;

      const cat = await api("GET", "/api/ceic/catalog");
      check(
        "dry run wrote NOTHING to the catalog",
        !cat.json.catalog.some((c: any) => c.seriesId === SID_A),
      );
    }

    // ── 3. Commit ───────────────────────────────────────────────────────────
    console.log("\n── 3. commit ──");
    {
      const r = await api("POST", "/api/imports/ceic", { text: V1, dryRun: false, filename: "ZZTEST_v1.csv" });
      eq("status", r.status, 200);
      eq("committed, not duplicate", r.json.commit.duplicate, false);
      eq("catalog rows upserted", r.json.commit.catalogUpserted, 2);
      eq("vintage rows written (blank included)", r.json.commit.vintageRows, 4);
      eq("current rows written (blank excluded)", r.json.commit.currentRows, 3);
      eq("same file hash as preview", r.json.fileHash, v1Hash);

      const cat = await storage.getCeicCatalogEntry(SID_A);
      eq("catalog label", cat?.label, "Test TSF Stock");
      eq("catalog unit", cat?.unit, "RMB bn");
      eq("catalog frequency", cat?.frequency, "Monthly");
      eq("catalog source mode", cat?.sourceMode, "cdm_import");
      eq("catalog starts unmapped", cat?.logicalId, null);

      const legacy = await storage.getImportedSeries(SID_A);
      eq("imported_series kept in sync for fetchSeries", legacy.length, 2);
      eq("imported_series source tagged", legacy[0].sourceName, "ceic");

      const viaImported = await fetchSeries(`imported:${SID_A}`);
      eq("addressable as imported:<id> with no mapping", viaImported.provenance.source, "imported");
      check("imported:<id> returns points", viaImported.data.length === 2, viaImported.data.length);
    }

    // ── 4. Idempotency ──────────────────────────────────────────────────────
    console.log("\n── 4. duplicate upload is a no-op ──");
    {
      const before = await storage.getCeicImportStats();
      const r = await api("POST", "/api/imports/ceic", { text: V1, dryRun: false, filename: "ZZTEST_v1.csv" });
      eq("flagged duplicate", r.json.commit.duplicate, true);
      eq("no vintage rows written", r.json.commit.vintageRows, 0);
      eq("no current rows written", r.json.commit.currentRows, 0);
      const after = await storage.getCeicImportStats();
      eq("vintage row count unchanged", after.vintageCount, before.vintageCount);

      const pre = await api("POST", "/api/imports/ceic", { text: V1, dryRun: true });
      eq("preview warns about the duplicate", pre.json.duplicate, true);
    }

    // ── 5. Second vintage / revisions ───────────────────────────────────────
    console.log("\n── 5. second vintage retains history ──");
    {
      // A DIFFERENT vintage date is what makes this a new vintage rather than a
      // correction of today's file: re-uploading on the same date deliberately
      // updates that day's vintage in place.
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const r = await api("POST", "/api/imports/ceic", {
        text: V2,
        dryRun: false,
        filename: "ZZTEST_v2.csv",
        vintageDate: tomorrow,
      });
      eq("committed", r.json.commit.duplicate, false);
      check(
        "revision detected on the restated period",
        r.json.commit.revisions.length >= 1,
        r.json.commit.revisions,
      );

      const v = await api("GET", `/api/ceic/catalog/${encodeURIComponent(SID_A)}/vintages`);
      eq("vintages endpoint ok", v.status, 200);
      check(
        "earlier vintage NOT overwritten — revision trail has 2 vintages",
        v.json.observations.some((o: any) => o.vintages.length === 2),
        v.json.observations,
      );
      eq("revised observation count reported", v.json.revisedObservations, 3);
      const all = await storage.listCeicVintages(SID_A);
      // 3 periods x 2 vintages, minus nothing: the first vintage's blank row is
      // still a row, so both vintages contribute 3 each.
      eq("all vintage rows retained (3 periods x 2 vintages)", all.length, 6);

      const latest = await storage.getLatestCeicObservations(SID_A);
      const newest = latest.find((p) => p.date === monthEnd(-1));
      eq("latest vintage wins for the current value", newest?.value, 432200);
    }

    // ── 6. Mapping ──────────────────────────────────────────────────────────
    console.log("\n── 6. mapping to a logical ID ──");
    {
      const bad = await api("POST", `/api/ceic/catalog/${encodeURIComponent(SID_A)}/mapping`, {
        logicalId: "not_a_real_registry_id",
      });
      eq("junk logical ID rejected", bad.status, 400);

      const missing = await api("POST", "/api/ceic/catalog/ZZTEST_NOPE/mapping", { logicalId: "m2_yoy" });
      eq("unknown series rejected", missing.status, 404);

      const good = await api("POST", `/api/ceic/catalog/${encodeURIComponent(SID_A)}/mapping`, {
        logicalId: "m2_yoy",
        transform: "raw",
      });
      eq("valid mapping accepted", good.status, 200);
      eq("mapping persisted", good.json.entry.logicalId, "m2_yoy");
    }

    // ── 7. Fresh mapped import wins in fetchSeries ───────────────────────────
    console.log("\n── 7. fresh mapped CEIC import wins ──");
    {
      invalidateCeicCatalogCache();
      const r = await fetchSeries("m2_yoy");
      eq("provenance source", r.provenance.source, "ceic_import");
      eq("provenance mode", r.provenance.mode, "cdm_import");
      eq("provenance carries the CEIC series id", r.provenance.ceicSeriesId, SID_A);
      check("vintage date exposed", !!r.provenance.vintageDate, r.provenance.vintageDate);
      eq("not flagged stale", r.provenance.stale, false);
      check("data returned ascending", r.data.length === 3 && r.data[0].date < r.data[2].date, r.data);
      eq("revised value surfaced", r.data.find((p) => p.date === monthEnd(-1))?.value, 432200);
    }

    // ── 8. Stale mapped import defers to the fallback chain ──────────────────
    console.log("\n── 8. stale mapped CEIC import defers to fallbacks ──");
    {
      // Unmap the fresh one first so both cannot claim the same logical ID.
      await api("POST", `/api/ceic/catalog/${encodeURIComponent(SID_A)}/mapping`, { logicalId: null });
      await api("POST", "/api/imports/ceic", { text: STALE_CSV, dryRun: false, filename: "ZZTEST_stale.csv" });
      const map = await api("POST", `/api/ceic/catalog/${encodeURIComponent(SID_STALE)}/mapping`, {
        logicalId: "m2_yoy",
        transform: "raw",
      });
      eq("stale series mapped", map.status, 200);
      invalidateCeicCatalogCache();

      const r = await fetchSeries("m2_yoy");
      check(
        "stale CEIC did NOT override a live fallback (or was returned flagged stale if no fallback answered)",
        r.provenance.source !== "ceic_import" || r.provenance.stale === true,
        r.provenance,
      );
      if (r.provenance.source === "ceic_import") {
        check("stale result carries a data-quality note", !!r.provenance.qualityNote, r.provenance.qualityNote);
      } else {
        console.log(`    (a live fallback answered: source=${r.provenance.source})`);
      }

      const st = await api("GET", "/api/ceic/status");
      check(
        "status lists the stale mapped series",
        (st.json.staleSeries ?? []).some((s: any) => s.seriesId === SID_STALE),
        st.json.staleSeries,
      );
    }

    // ── 9. Bridge authentication ────────────────────────────────────────────
    console.log("\n── 9. bridge endpoint auth ──");
    const bridgeBody = {
      runId: "ZZTEST",
      series: [
        {
          seriesId: "ZZTEST_BRIDGE",
          label: "Test Bridge Series",
          unit: "%",
          frequency: "Monthly",
          geo: "China",
          source: "PBoC",
          points: [
            { date: monthEnd(-1), value: 3.3 },
            { date: monthEnd(0), value: null },
          ],
        },
      ],
    };
    {
      const noTok = await api("POST", "/api/imports/ceic-bridge", bridgeBody);
      eq("missing token → 401", noTok.status, 401);
      eq("terse error (no oracle)", noTok.json.error, "unauthorized");

      const badTok = await api("POST", "/api/imports/ceic-bridge", bridgeBody, {
        "x-ceic-import-token": "wrong-token-of-the-same-length!!",
      });
      eq("bad token → 401", badTok.status, 401);

      const badSchema = await api("POST", "/api/imports/ceic-bridge", { series: [] }, {
        "x-ceic-import-token": TEST_TOKEN,
      });
      eq("empty series → 400", badSchema.status, 400);

      const good = await api("POST", "/api/imports/ceic-bridge", bridgeBody, {
        "x-ceic-import-token": TEST_TOKEN,
      });
      eq("good token → 200", good.status, 200);
      eq("source mode recorded as python_bridge", good.json.commit.duplicate, false);
      eq("blank point retained as a vintage row", good.json.commit.vintageRows, 2);
      eq("only the non-null point hits the current view", good.json.commit.currentRows, 1);

      const dupe = await api("POST", "/api/imports/ceic-bridge", bridgeBody, {
        "x-ceic-import-token": TEST_TOKEN,
      });
      eq("identical bridge payload is idempotent", dupe.json.commit.duplicate, true);

      const cat = await storage.getCeicCatalogEntry("ZZTEST_BRIDGE");
      eq("catalog tagged python_bridge", cat?.sourceMode, "python_bridge");
      const legacy = await storage.getImportedSeries("ZZTEST_BRIDGE");
      eq("bridge rows tagged in imported_series", legacy[0]?.sourceName, "ceic_bridge");

      const alt = await api("POST", "/api/imports/ceic-bridge", bridgeBody, {
        authorization: `Bearer ${TEST_TOKEN}`,
      });
      eq("Bearer header also accepted", alt.status, 200);
    }

    // ── 10. Status endpoint ─────────────────────────────────────────────────
    console.log("\n── 10. status / mode reporting ──");
    {
      const r = await api("GET", "/api/ceic/status");
      eq("status ok", r.status, 200);
      eq("mode reflects the bridge run", r.json.mode, "python_bridge");
      eq("bridge token detected", r.json.bridgeTokenConfigured, true);
      check("catalog counted", r.json.catalogCount >= 3, r.json.catalogCount);
      check("vintage rows counted", r.json.vintageCount >= 6, r.json.vintageCount);
      check("summary has no hardcoded tier-denial wording", !/denied on tier/i.test(r.json.summary), r.json.summary);

      const health = await api("GET", "/api/ceic/health");
      eq("legacy health endpoint still 200", health.status, 200);
      check("health reports a mode", typeof health.json.mode === "string", health.json.mode);
      check(
        "health no longer claims a fixed subscription verdict",
        !/no data subscriptions/i.test(health.json.message ?? ""),
        health.json.message,
      );
    }
  } finally {
    await purge();
    httpServer.close();
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("integration test crashed:", err);
  process.exit(1);
});
