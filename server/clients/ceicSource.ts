/**
 * CEIC source mode + shared commit pipeline (Phase 7).
 *
 * China Monitor can obtain CEIC data through four mutually-exclusive modes.
 * Everything in the app (fetchSeries provenance, diagnostics, Settings, the
 * report evidence block) reads the mode from here rather than assuming the
 * old REST client is the only option:
 *
 *   `api`           — CEIC v2 REST with an entitled API key. The current
 *                     production key is NOT entitled (explicit 403 deny on
 *                     /series/{id}/data), so this mode only activates when a
 *                     key is present AND the last recorded key test passed.
 *                     The client (clients/ceic.ts) is retained untouched for
 *                     the day the user buys API access.
 *   `python_bridge` — the local collector in ceic-python-bridge/ logs in with
 *                     the user's CEIC website credentials and POSTs rows to
 *                     /api/imports/ceic-bridge. Credentials never touch this
 *                     server or the database.
 *   `cdm_import`    — CDMNext Excel/CSV export uploaded via the Imports page.
 *   `unavailable`   — nothing configured yet.
 *
 * IMPORTANT: when the effective mode is `cdm_import` / `python_bridge` /
 * `unavailable`, fetchSeries must NOT keep hammering the denied REST endpoint.
 * `shouldUseCeicApi()` is the single guard for that.
 */

import { createHash } from "node:crypto";
import { storage } from "../storage";
import { resolveApiKey } from "../keyResolver";
import type { CeicPoint, CeicSeriesMeta } from "./ceicImport";

export type CeicSourceMode = "api" | "python_bridge" | "cdm_import" | "unavailable";

/** Optional operator override, stored in `settings` under this key. */
export const CEIC_MODE_SETTING_KEY = "ceic_source_mode";
/** Freshness budget before a mapped CEIC import is called stale (days). */
export const CEIC_DEFAULT_STALE_DAYS = 75;

export interface CeicStatus {
  /** Effective mode after applying the override and observed evidence. */
  mode: CeicSourceMode;
  /** What the operator forced in Settings, if anything. */
  overrideMode: CeicSourceMode | "auto";
  apiKeyConfigured: boolean;
  /** Last recorded result of the API-key test — `fail` implies the 403 deny. */
  apiKeyTestStatus: string | null;
  apiKeyTestMessage: string | null;
  /** True when the REST client may be called at all. */
  apiUsable: boolean;
  bridgeTokenConfigured: boolean;
  catalogCount: number;
  mappedCount: number;
  observationCount: number;
  vintageCount: number;
  seriesWithVintages: number;
  latestObservationDate: string | null;
  latestVintageDate: string | null;
  latestImportAt: string | null;
  lastRunByMode: { sourceMode: string; series: number; rows: number }[];
  recentFiles: {
    fileHash: string;
    filename: string | null;
    sourceMode: string;
    vintageDate: string;
    layout: string | null;
    seriesCount: number;
    rowCount: number;
    importedAt: string | null;
  }[];
  /** Mapped series whose latest observation is older than the stale budget. */
  staleSeries: { seriesId: string; logicalId: string; lastDate: string | null; ageDays: number | null }[];
  freshSeriesCount: number;
  lastError: string | null;
  /** One-line human summary used by diagnostics + the report evidence block. */
  summary: string;
}

function ageDays(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr.length === 7 ? `${dateStr}-01` : dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Read the operator override, tolerating a missing/garbage settings row. */
async function readOverride(): Promise<CeicSourceMode | "auto"> {
  try {
    const row = await storage.getSetting(CEIC_MODE_SETTING_KEY);
    const v = (row?.valueJson as any)?.mode ?? row?.valueJson;
    if (v === "api" || v === "python_bridge" || v === "cdm_import" || v === "unavailable" || v === "auto") {
      return v;
    }
  } catch {
    /* settings unavailable → auto */
  }
  return "auto";
}

export async function setCeicModeOverride(mode: CeicSourceMode | "auto"): Promise<void> {
  await storage.setSetting({ key: CEIC_MODE_SETTING_KEY, valueJson: { mode } });
}

/**
 * Full CEIC status. Never throws — every probe is individually guarded so a
 * cold database (no CEIC tables yet) still renders an honest "unavailable".
 */
export async function getCeicStatus(): Promise<CeicStatus> {
  let lastError: string | null = null;

  const [override, apiKey, keyRow] = await Promise.all([
    readOverride(),
    resolveApiKey("ceic").catch(() => null),
    storage.getApiKey("ceic").catch(() => undefined),
  ]);

  let stats = {
    catalogCount: 0, mappedCount: 0, observationCount: 0, vintageCount: 0,
    seriesWithVintages: 0, latestObservationDate: null as string | null,
    latestVintageDate: null as string | null, latestImportAt: null as string | null,
    byMode: [] as { sourceMode: string; series: number; rows: number }[],
  };
  try {
    stats = await storage.getCeicImportStats();
  } catch (e: any) {
    lastError = `catalog stats unavailable: ${e?.message ?? e}`;
  }

  let recentFiles: CeicStatus["recentFiles"] = [];
  try {
    recentFiles = (await storage.listCeicImportFiles(5)).map((f) => ({
      fileHash: f.fileHash.slice(0, 12),
      filename: f.filename ?? null,
      sourceMode: f.sourceMode,
      vintageDate: f.vintageDate,
      layout: f.layout ?? null,
      seriesCount: f.seriesCount,
      rowCount: f.rowCount,
      importedAt: f.importedAt ? new Date(f.importedAt).toISOString() : null,
    }));
  } catch (e: any) {
    lastError = lastError ?? `import ledger unavailable: ${e?.message ?? e}`;
  }

  // Freshness of MAPPED series only — unmapped catalog rows do not feed reports.
  const staleSeries: CeicStatus["staleSeries"] = [];
  let freshSeriesCount = 0;
  try {
    const catalog = await storage.listCeicCatalog();
    for (const c of catalog) {
      if (!c.logicalId) continue;
      const a = ageDays(c.lastDate);
      if (a != null && a <= CEIC_DEFAULT_STALE_DAYS) freshSeriesCount += 1;
      else staleSeries.push({ seriesId: c.seriesId, logicalId: c.logicalId, lastDate: c.lastDate ?? null, ageDays: a });
    }
  } catch (e: any) {
    lastError = lastError ?? `catalog read failed: ${e?.message ?? e}`;
  }

  const apiKeyConfigured = !!apiKey;
  const apiKeyTestStatus = keyRow?.testStatus ?? null;
  const apiKeyTestMessage = keyRow?.testMessage ?? null;
  // Only trust the REST path when the key exists AND has not been observed to fail.
  const apiUsable = apiKeyConfigured && apiKeyTestStatus !== "fail";

  const bridgeRows = stats.byMode.find((m) => m.sourceMode === "python_bridge");
  const bridgeTokenConfigured = !!process.env.CEIC_IMPORT_TOKEN;

  let mode: CeicSourceMode;
  if (override !== "auto") {
    mode = override;
  } else if (bridgeRows && bridgeRows.rows > 0) {
    mode = "python_bridge";
  } else if (stats.observationCount > 0) {
    mode = "cdm_import";
  } else if (apiUsable) {
    mode = "api";
  } else {
    mode = "unavailable";
  }

  const summary =
    mode === "unavailable"
      ? apiKeyConfigured
        ? "CEIC unavailable: API key present but not entitled for data; no CDM import or bridge run yet."
        : "CEIC unavailable: no API key, no CDM import, no Python bridge run yet."
      : `CEIC via ${mode.replace("_", " ")}: ${stats.catalogCount} catalog series, ${stats.mappedCount} mapped, ` +
        `${stats.observationCount} observations across ${stats.vintageCount} vintage rows` +
        (stats.latestObservationDate ? `, latest observation ${stats.latestObservationDate}` : "") +
        (staleSeries.length ? `, ${staleSeries.length} mapped series stale` : "") +
        ".";

  return {
    mode,
    overrideMode: override,
    apiKeyConfigured,
    apiKeyTestStatus,
    apiKeyTestMessage,
    apiUsable,
    bridgeTokenConfigured,
    catalogCount: stats.catalogCount,
    mappedCount: stats.mappedCount,
    observationCount: stats.observationCount,
    vintageCount: stats.vintageCount,
    seriesWithVintages: stats.seriesWithVintages,
    latestObservationDate: stats.latestObservationDate,
    latestVintageDate: stats.latestVintageDate,
    latestImportAt: stats.latestImportAt,
    lastRunByMode: stats.byMode,
    recentFiles,
    staleSeries,
    freshSeriesCount,
    lastError,
  summary,
  };
}

/**
 * Guard used by fetchSeries so the denied REST endpoint is not re-hit on every
 * page load once the user is on the import/bridge path.
 */
export async function shouldUseCeicApi(): Promise<boolean> {
  try {
    const s = await getCeicStatus();
    return s.mode === "api" && s.apiUsable;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Shared commit pipeline — used identically by the CDM upload route and the
// authenticated Python-bridge route so both paths get catalog rows, vintage
// history, and a refreshed `imported_series` current view.
// ────────────────────────────────────────────────────────────────────────────

export interface CeicCommitInput {
  points: CeicPoint[];
  series: CeicSeriesMeta[];
  sourceMode: Exclude<CeicSourceMode, "unavailable">;
  /** SHA-256 of the exact payload — drives idempotency. */
  fileHash: string;
  filename?: string | null;
  /** ISO YYYY-MM-DD. Defaults to today (the date the export was taken). */
  vintageDate?: string;
  layout?: string | null;
  warnings?: string[];
}

export interface CeicCommitResult {
  ok: true;
  duplicate: boolean;
  fileHash: string;
  vintageDate: string;
  catalogUpserted: number;
  vintageRows: number;
  currentRows: number;
  seriesCount: number;
  /** Series that already had a mapping, so the commit fed a logical ID. */
  mappedSeries: { seriesId: string; logicalId: string }[];
  revisions: { seriesId: string; observationDate: string; previous: number | null; current: number | null }[];
}

/**
 * Persist a parsed CEIC payload.
 *
 * Order matters:
 *   1. duplicate check on the file hash (idempotent re-upload is a no-op),
 *   2. catalog upsert (never clobbers an existing logical-ID mapping),
 *   3. vintage rows appended — earlier vintages are preserved,
 *   4. `imported_series` refreshed with the latest value per date so every
 *      existing consumer (fetchSeries `imported:<id>`, report, deck) works.
 */
export async function commitCeicImport(input: CeicCommitInput): Promise<CeicCommitResult> {
  const vintageDate = input.vintageDate ?? todayIso();

  const existing = await storage.getCeicImportFile(input.fileHash).catch(() => undefined);
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      fileHash: input.fileHash,
      vintageDate: existing.vintageDate,
      catalogUpserted: 0,
      vintageRows: 0,
      currentRows: 0,
      seriesCount: existing.seriesCount,
      mappedSeries: [],
      revisions: [],
    };
  }

  // ── 1. Detect revisions against the previously-known latest value ─────────
  const revisions: CeicCommitResult["revisions"] = [];
  const priorLatest = new Map<string, Map<string, number | null>>();
  for (const s of input.series) {
    try {
      const prior = await storage.getLatestCeicObservations(s.seriesId);
      priorLatest.set(s.seriesId, new Map(prior.map((p) => [p.date, p.value])));
    } catch {
      priorLatest.set(s.seriesId, new Map());
    }
  }

  // ── 2. Catalog ───────────────────────────────────────────────────────────
  const catalogUpserted = await storage.upsertCeicCatalogBatch(
    input.series.map((s) => ({
      seriesId: s.seriesId,
      mnemonic: s.mnemonic,
      label: s.label,
      labelZh: s.labelZh,
      geo: s.geo,
      frequency: s.frequency,
      unit: s.unit,
      originalSource: s.originalSource,
      firstDate: s.firstDate,
      lastDate: s.lastDate,
      lastFileVintage: vintageDate,
      vintageEnabled: true,
      status: "active",
      sourceMode: input.sourceMode,
      metadataJson: { pointCount: s.pointCount, valueCount: s.valueCount, filename: input.filename ?? null },
    })),
  );

  // ── 3. Vintage rows ──────────────────────────────────────────────────────
  const obsRows = input.points.map((p) => {
    const before = priorLatest.get(p.seriesId)?.get(p.observationDate);
    const isRevision = before !== undefined && before !== p.value;
    if (isRevision) {
      revisions.push({
        seriesId: p.seriesId,
        observationDate: p.observationDate,
        previous: before ?? null,
        current: p.value,
      });
    }
    return {
      seriesId: p.seriesId,
      observationDate: p.observationDate,
      vintageDate,
      value: p.value,
      sourceFileHash: input.fileHash,
      status: isRevision ? "revised" : p.value == null ? "missing" : "ok",
      sourceMode: input.sourceMode,
    };
  });
  const vintageRows = await storage.insertCeicObservations(obsRows);

  // ── 4. Refresh the legacy current-value table ────────────────────────────
  // `imported_series.value` is NOT NULL, so blanks stay out of the current view
  // while remaining auditable in ceic_import_observations.
  const metaById = new Map(input.series.map((s) => [s.seriesId, s]));
  const currentRowsInput = input.points
    .filter((p) => p.value != null)
    .map((p) => {
      const m = metaById.get(p.seriesId);
      return {
        seriesId: p.seriesId,
        seriesLabel: m?.label ?? p.seriesId,
        date: p.observationDate,
        value: p.value as number,
        sourceMnemonic: m?.mnemonic ?? null,
        unit: m?.unit ?? null,
        frequency: m?.frequency ?? null,
        sourceName: input.sourceMode === "python_bridge" ? "ceic_bridge" : "ceic",
      };
    });
  const current = await storage.upsertImportedSeriesBatch(currentRowsInput);

  await storage.recordCeicImportFile({
    fileHash: input.fileHash,
    filename: input.filename ?? null,
    sourceMode: input.sourceMode,
    vintageDate,
    layout: input.layout ?? null,
    seriesCount: input.series.length,
    rowCount: input.points.length,
    warnings: input.warnings ?? [],
  });

  // Which of these already carry a logical-ID mapping (so the report picks them up)?
  const mappedSeries: { seriesId: string; logicalId: string }[] = [];
  for (const s of input.series) {
    const entry = await storage.getCeicCatalogEntry(s.seriesId).catch(() => undefined);
    if (entry?.logicalId) mappedSeries.push({ seriesId: s.seriesId, logicalId: entry.logicalId });
  }

  return {
    ok: true,
    duplicate: false,
    fileHash: input.fileHash,
    vintageDate,
    catalogUpserted,
    vintageRows,
    currentRows: current.inserted,
    seriesCount: input.series.length,
    mappedSeries,
    revisions: revisions.slice(0, 50),
  };
}

/** Apply a catalog transform to a value series. Mirrors registry CeicConfig. */
export function applyCeicImportTransform(
  points: { date: string; value: number | null }[],
  transform: string | null | undefined,
): { date: string; value: number | null }[] {
  if (!transform || transform === "raw") return points;
  const scale = (f: number) =>
    points.map((p) => ({ date: p.date, value: p.value != null ? p.value * f : null }));
  if (transform === "divide_1000") return scale(1 / 1000);
  if (transform === "divide_100") return scale(1 / 100);
  if (transform === "multiply_100") return scale(100);
  if (transform === "yoy") {
    const asc = [...points].sort((a, b) => a.date.localeCompare(b.date));
    const byKey = new Map(asc.map((p) => [p.date.slice(0, 7), p.value] as const));
    return asc.map((p) => {
      if (p.value == null) return { date: p.date, value: null };
      const d = new Date(`${p.date}T00:00:00Z`);
      const prevKey = `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const prev = byKey.get(prevKey);
      if (prev == null || prev === 0) return { date: p.date, value: null };
      return { date: p.date, value: ((p.value - prev) / Math.abs(prev)) * 100 };
    });
  }
  return points;
}
