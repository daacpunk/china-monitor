/**
 * CEIC import bridge routes (Phase 7).
 *
 * Three surfaces:
 *   1. Status/mode        — /api/ceic/status, /api/ceic/mode
 *   2. Catalog + mapping  — /api/ceic/catalog[/:seriesId/{mapping,vintages}]
 *   3. Ingestion          — POST /api/imports/ceic         (interactive, CDM export)
 *                           POST /api/imports/ceic-bridge  (token-auth, local collector)
 *
 * The two ingestion routes share ONE commit pipeline (commitCeicImport) so a
 * bridge upload and a CDM upload produce byte-identical catalog/vintage/current
 * state. The bridge route is authenticated by the CEIC_IMPORT_TOKEN header with
 * a constant-time compare and is explicitly NOT a public upload endpoint.
 *
 * Nothing here removes or shadows the existing /api/imports/factset routes.
 */

import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { storage } from "../storage";
import { listRegistry } from "../series/registry";
import { invalidateCeicCatalogCache } from "../series/fetchSeries";
import {
  parseCeicText,
  parseCeicWorkbook,
  CEIC_LONG_TEMPLATE_CSV,
  CEIC_WIDE_TEMPLATE_CSV,
  type CeicParseResult,
} from "../clients/ceicImport";
import {
  commitCeicImport,
  getCeicStatus,
  setCeicModeOverride,
  sha256,
  todayIso,
} from "../clients/ceicSource";

// ── Guard rails ────────────────────────────────────────────────────────────
/** Max observations accepted in one request (CDMNext caps exports at 3,000 series). */
const MAX_POINTS = 400_000;
const MAX_SERIES = 3_000;
/** Max decoded payload accepted by the bridge route. */
const MAX_BRIDGE_BYTES = 8 * 1024 * 1024;

const TRANSFORMS = ["raw", "yoy", "divide_1000", "divide_100", "multiply_100"] as const;

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Compare fixed-width digests so length itself is not a timing oracle.
  const ah = Buffer.from(sha256(ab), "hex");
  const bh = Buffer.from(sha256(bb), "hex");
  return ab.length === bb.length && timingSafeEqual(ah, bh);
}

function previewPayload(result: CeicParseResult, extra: Record<string, unknown> = {}) {
  if (!result.ok) {
    return { ok: false as const, error: result.error, warnings: result.warnings, ...extra };
  }
  return {
    ok: true as const,
    layout: result.layout,
    delimiter: result.delimiter,
    rowCount: result.rowCount,
    seriesCount: result.seriesCount,
    series: result.series.slice(0, 200),
    sample: result.points.slice(0, 12),
    warnings: result.warnings.slice(0, 50),
    warningCount: result.warnings.length,
    ...extra,
  };
}

export function registerCeicRoutes(app: Express): void {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Status + mode
  // ─────────────────────────────────────────────────────────────────────────

  /** GET /api/ceic/status — source mode + catalog/vintage/freshness snapshot. */
  app.get("/api/ceic/status", async (_req: Request, res: Response) => {
    try {
      res.json(await getCeicStatus());
    } catch (err: any) {
      res.status(200).json({
        mode: "unavailable",
        overrideMode: "auto",
        apiKeyConfigured: false,
        apiUsable: false,
        catalogCount: 0,
        mappedCount: 0,
        lastError: err.message,
        summary: `CEIC status unavailable: ${err.message}`,
      });
    }
  });

  /** POST /api/ceic/mode — operator override. No credentials are accepted here. */
  app.post("/api/ceic/mode", async (req: Request, res: Response) => {
    try {
      const Body = z.object({
        mode: z.enum(["auto", "api", "python_bridge", "cdm_import", "unavailable"]),
      });
      const { mode } = Body.parse(req.body);
      await setCeicModeOverride(mode);
      res.json({ ok: true, ...(await getCeicStatus()) });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Catalog + mapping
  // ─────────────────────────────────────────────────────────────────────────

  /** GET /api/ceic/catalog — every imported CEIC series + its mapping. */
  app.get("/api/ceic/catalog", async (_req: Request, res: Response) => {
    try {
      const rows = await storage.listCeicCatalog();
      res.json({
        ok: true,
        count: rows.length,
        mapped: rows.filter((r) => r.logicalId).length,
        catalog: rows,
        // Handed to the mapping dropdown so the UI never invents a logical ID.
        logicalIds: listRegistry().map((r) => ({ id: r.id, label: r.label, unit: r.unit, category: r.category })),
        transforms: TRANSFORMS,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** POST /api/ceic/catalog/:seriesId/mapping — bind a CEIC series to a logical ID. */
  app.post("/api/ceic/catalog/:seriesId/mapping", async (req: Request, res: Response) => {
    try {
      const Body = z.object({
        logicalId: z.string().min(1).max(120).nullable().optional(),
        transform: z.enum(TRANSFORMS).nullable().optional(),
      });
      const body = Body.parse(req.body);
      const seriesId = String(req.params.seriesId);
      const entry = await storage.getCeicCatalogEntry(seriesId);
      if (!entry) return res.status(404).json({ ok: false, error: `Unknown CEIC series ${seriesId}` });

      const logicalId = body.logicalId?.trim() || null;
      if (logicalId) {
        const known = new Set(listRegistry().map((r) => r.id));
        if (!known.has(logicalId) && !logicalId.startsWith("imported:")) {
          return res.status(400).json({
            ok: false,
            error: `"${logicalId}" is not a China Monitor registry logical ID. Pick one from /api/series.`,
          });
        }
      }
      const updated = await storage.setCeicMapping(seriesId, logicalId, body.transform ?? null);
      // fetchSeries caches the mapping table for 60s — drop it so the new
      // mapping takes effect on the very next chart/report render.
      invalidateCeicCatalogCache();
      res.json({ ok: true, entry: updated });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /** GET /api/ceic/catalog/:seriesId/vintages[?observationDate=YYYY-MM-DD] */
  app.get("/api/ceic/catalog/:seriesId/vintages", async (req: Request, res: Response) => {
    try {
      const seriesId = String(req.params.seriesId);
      const obsDate = req.query.observationDate ? String(req.query.observationDate) : undefined;
      const [entry, vintages, latest] = await Promise.all([
        storage.getCeicCatalogEntry(seriesId),
        storage.listCeicVintages(seriesId, obsDate),
        storage.getLatestCeicObservations(seriesId),
      ]);
      if (!entry && vintages.length === 0) {
        return res.status(404).json({ ok: false, error: `No CEIC data for ${seriesId}` });
      }
      // Group by observation date so the UI can render the revision trail.
      const byDate = new Map<string, { vintageDate: string; value: number | null; status: string; sourceMode: string }[]>();
      for (const v of vintages) {
        const arr = byDate.get(v.observationDate) ?? [];
        arr.push({
          vintageDate: v.vintageDate,
          value: v.value != null ? Number(v.value) : null,
          status: v.status,
          sourceMode: v.sourceMode,
        });
        byDate.set(v.observationDate, arr);
      }
      res.json({
        ok: true,
        seriesId,
        entry: entry ?? null,
        revisedObservations: Array.from(byDate.entries()).filter(([, v]) => v.length > 1).length,
        observations: Array.from(byDate.entries())
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([observationDate, v]) => ({ observationDate, vintages: v })),
        latest,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3a. Interactive CDMNext import (paste / CSV / TSV / XLSX)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /api/imports/ceic
   * Body: {
   *   text?: string,               // pasted CSV/TSV
   *   fileBase64?: string,         // .xlsx / .xls (or any of the above) as base64
   *   filename?: string,
   *   dryRun?: boolean,            // true = preview only, nothing written
   *   vintageDate?: "YYYY-MM-DD",  // defaults to today
   *   defaults?: { seriesId, label, unit, frequency, geo, originalSource },
   *   dateFormat?: "auto" | "mdy" | "dmy",
   *   forceLayout?: "long" | "wide" | "two_column",
   * }
   */
  app.post("/api/imports/ceic", async (req: Request, res: Response) => {
    try {
      const Body = z.object({
        text: z.string().optional(),
        fileBase64: z.string().optional(),
        filename: z.string().max(300).optional(),
        dryRun: z.boolean().default(false),
        vintageDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        defaults: z
          .object({
            seriesId: z.string().max(120).optional(),
            label: z.string().max(300).optional(),
            unit: z.string().max(80).optional(),
            frequency: z.string().max(40).optional(),
            geo: z.string().max(80).optional(),
            originalSource: z.string().max(160).optional(),
          })
          .optional(),
        dateFormat: z.enum(["auto", "mdy", "dmy"]).default("auto"),
        forceLayout: z.enum(["long", "wide", "two_column"]).optional(),
      });
      const parsedBody = Body.safeParse(req.body);
      if (!parsedBody.success) {
        return res.status(400).json({ ok: false, error: parsedBody.error.message });
      }
      const b = parsedBody.data;
      if (!b.text?.trim() && !b.fileBase64) {
        return res.status(400).json({ ok: false, error: "Provide either `text` or `fileBase64`." });
      }

      const parseOpts = {
        defaults: b.defaults,
        dateFormat: b.dateFormat,
        forceLayout: b.forceLayout,
      };

      let result: CeicParseResult & { sheetName?: string };
      let fileHash: string;
      if (b.fileBase64) {
        const buf = Buffer.from(b.fileBase64, "base64");
        if (buf.length > MAX_BRIDGE_BYTES) {
          return res.status(413).json({ ok: false, error: `File too large (${buf.length} bytes, max ${MAX_BRIDGE_BYTES}).` });
        }
        fileHash = sha256(buf);
        // XLSX magic is "PK"; anything else is treated as delimited text so a
        // user who picks a .csv through the file dialog still succeeds.
        const isZip = buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b;
        result = isZip
          ? await parseCeicWorkbook(buf, parseOpts)
          : parseCeicText(buf.toString("utf8"), parseOpts);
      } else {
        fileHash = sha256(b.text!);
        result = parseCeicText(b.text!, parseOpts);
      }

      if (!result.ok) {
        return res.status(400).json(previewPayload(result, { fileHash }));
      }
      if (result.points.length > MAX_POINTS) {
        return res.status(413).json({ ok: false, error: `Too many observations (${result.points.length}; max ${MAX_POINTS}).` });
      }
      if (result.seriesCount > MAX_SERIES) {
        return res.status(413).json({ ok: false, error: `Too many series (${result.seriesCount}; max ${MAX_SERIES} — CDMNext exports up to 3,000 at a time).` });
      }

      const already = await storage.getCeicImportFile(fileHash).catch(() => undefined);

      if (b.dryRun) {
        return res.json(
          previewPayload(result, {
            dryRun: true,
            fileHash,
            sheetName: (result as any).sheetName ?? null,
            duplicate: !!already,
            duplicateOf: already
              ? { importedAt: already.importedAt, vintageDate: already.vintageDate, rowCount: already.rowCount }
              : null,
            vintageDate: b.vintageDate ?? todayIso(),
          }),
        );
      }

      const commit = await commitCeicImport({
        points: result.points,
        series: result.series,
        sourceMode: "cdm_import",
        fileHash,
        filename: b.filename ?? (result as any).sheetName ?? null,
        vintageDate: b.vintageDate,
        layout: result.layout,
        warnings: result.warnings,
      });
      invalidateCeicCatalogCache();

      res.json({ ...previewPayload(result, { fileHash }), commit });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** GET /api/imports/ceic-template.csv?layout=wide|long */
  app.get("/api/imports/ceic-template.csv", (req: Request, res: Response) => {
    const wide = String(req.query.layout ?? "long") === "wide";
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ceic_cdm_${wide ? "wide" : "long"}_template.csv"`,
    );
    res.send(wide ? CEIC_WIDE_TEMPLATE_CSV : CEIC_LONG_TEMPLATE_CSV);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3b. Authenticated Python-bridge ingestion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /api/imports/ceic-bridge
   * Header: `x-ceic-import-token: <CEIC_IMPORT_TOKEN>`
   *
   * Body: {
   *   runId?: string,
   *   vintageDate?: "YYYY-MM-DD",
   *   series: [{ seriesId, label?, mnemonic?, unit?, frequency?, geo?, source?,
   *              logicalId?, transform?,
   *              points: [{ date, value }] }]
   * }
   *
   * The collector NEVER sends credentials — it authenticates with the shared
   * import token only, and CEIC login stays entirely on the user's machine.
   */
  app.post("/api/imports/ceic-bridge", async (req: Request, res: Response) => {
    const configured = process.env.CEIC_IMPORT_TOKEN ?? "";
    if (!configured) {
      return res.status(503).json({
        ok: false,
        error: "bridge_disabled",
        message: "CEIC_IMPORT_TOKEN is not configured on this deployment; the bridge endpoint is disabled.",
      });
    }
    const supplied =
      (req.header("x-ceic-import-token") ??
        (req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "")).trim();
    if (!supplied || !constantTimeEquals(supplied, configured)) {
      // Deliberately terse: no hint about token length or which half matched.
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    try {
      const Point = z.object({
        date: z.string().min(4).max(32),
        value: z.number().finite().nullable().optional(),
      });
      const Series = z.object({
        seriesId: z.string().min(1).max(120),
        label: z.string().max(300).optional(),
        labelZh: z.string().max(300).nullable().optional(),
        mnemonic: z.string().max(120).nullable().optional(),
        unit: z.string().max(80).nullable().optional(),
        frequency: z.string().max(40).nullable().optional(),
        geo: z.string().max(80).nullable().optional(),
        source: z.string().max(160).nullable().optional(),
        logicalId: z.string().max(120).nullable().optional(),
        transform: z.enum(TRANSFORMS).nullable().optional(),
        points: z.array(Point).max(20_000),
      });
      const Body = z.object({
        runId: z.string().max(120).optional(),
        vintageDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        series: z.array(Series).min(1).max(MAX_SERIES),
      });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: "schema_invalid", detail: parsed.error.message.slice(0, 1200) });
      }
      const body = parsed.data;

      const totalPoints = body.series.reduce((a, s) => a + s.points.length, 0);
      if (totalPoints > MAX_POINTS) {
        return res.status(413).json({ ok: false, error: `Too many observations (${totalPoints}; max ${MAX_POINTS}).` });
      }

      const { normaliseCeicDate } = await import("../clients/ceicImport");
      const warnings: string[] = [];
      const points: { seriesId: string; observationDate: string; value: number | null }[] = [];
      const seriesMeta = body.series.map((s) => {
        let first: string | null = null;
        let last: string | null = null;
        let valueCount = 0;
        let pointCount = 0;
        for (const p of s.points) {
          const d = normaliseCeicDate(p.date);
          if (!d) {
            warnings.push(`${s.seriesId}: unparseable date "${p.date}" — skipped`);
            continue;
          }
          const value = p.value ?? null;
          points.push({ seriesId: s.seriesId, observationDate: d, value });
          pointCount += 1;
          if (value != null) valueCount += 1;
          if (!first || d < first) first = d;
          if (!last || d > last) last = d;
        }
        return {
          seriesId: s.seriesId,
          mnemonic: s.mnemonic ?? null,
          label: s.label ?? s.seriesId,
          labelZh: s.labelZh ?? null,
          geo: s.geo ?? null,
          frequency: s.frequency ?? null,
          unit: s.unit ?? null,
          originalSource: s.source ?? null,
          firstDate: first,
          lastDate: last,
          pointCount,
          valueCount,
        };
      });

      if (!points.length) {
        return res.status(400).json({ ok: false, error: "No parseable observations in payload", warnings });
      }

      // Idempotency: hash the *normalised* payload, so a re-run that produced
      // identical data is a no-op even if key ordering changed.
      const canonical = JSON.stringify({
        vintageDate: body.vintageDate ?? todayIso(),
        points: [...points].sort(
          (a, b) => a.seriesId.localeCompare(b.seriesId) || a.observationDate.localeCompare(b.observationDate),
        ),
      });
      if (Buffer.byteLength(canonical) > MAX_BRIDGE_BYTES) {
        return res.status(413).json({ ok: false, error: "Payload too large after normalisation." });
      }
      const fileHash = sha256(canonical);

      const commit = await commitCeicImport({
        points,
        series: seriesMeta,
        sourceMode: "python_bridge",
        fileHash,
        filename: body.runId ? `bridge:${body.runId}` : "bridge",
        vintageDate: body.vintageDate,
        layout: "bridge",
        warnings,
      });

      // Apply any mapping the manifest carried, but never overwrite one the
      // user already set in the UI.
      for (const s of body.series) {
        if (!s.logicalId) continue;
        const entry = await storage.getCeicCatalogEntry(s.seriesId).catch(() => undefined);
        if (entry && !entry.logicalId) {
          await storage.setCeicMapping(s.seriesId, s.logicalId, s.transform ?? null);
        }
      }
      invalidateCeicCatalogCache();

      res.json({ ok: true, commit, warnings: warnings.slice(0, 50), warningCount: warnings.length });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
