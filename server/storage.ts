import {
  apiKeys,
  settings,
  seriesCache,
  apiCallLog,
  costCeilings,
  watchlists,
  chartConfigs,
  viewState,
  importedSeries,
  ceicImportCatalog,
  ceicImportObservations,
  ceicImportFiles,
  scenarios,
  briefs,
  policyUpdates,
  houseView,
  strategyNotes,
  jobRuns,
  notifications,
  predictions,
} from "@shared/schema";
import type {
  ApiKey,
  InsertApiKey,
  Setting,
  InsertSetting,
  SeriesCache,
  ApiCallLog,
  InsertApiCallLog,
  CostCeiling,
  InsertCostCeiling,
  Watchlist,
  InsertWatchlist,
  ChartConfig,
  InsertChartConfig,
  ViewState,
  InsertViewState,
  ImportedSeries,
  InsertImportedSeries,
  CeicCatalogEntry,
  InsertCeicCatalogEntry,
  CeicObservation,
  InsertCeicObservation,
  CeicImportFile,
  Scenario,
  InsertScenario,
  Brief,
  InsertBrief,
  PolicyUpdate,
  InsertPolicyUpdate,
  HouseView,
  InsertHouseView,
  StrategyNote,
  InsertStrategyNote,
  JobRun,
  InsertJobRun,
  Notification,
  InsertNotification,
  Prediction,
  InsertPrediction,
} from "@shared/schema";
import { eq, desc, gte, lte, and, sql } from "drizzle-orm";
import { createRequire as nodeCreateRequire } from "node:module";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Dual driver setup:
//   - If DATABASE_URL is set (Railway prod): use node-postgres
//   - Otherwise (sandbox dev): use PGlite embedded Postgres (file: ./data.pgdata)
// Both expose the same Drizzle query builder.
// ─────────────────────────────────────────────────────────────────────────────

type AnyDb = ReturnType<typeof makePgDb> | ReturnType<typeof makePgliteDb>;

// The two driver factories below load their packages lazily via require() so a
// PGlite-only run never pulls `pg` (and vice versa). That works in the shipped
// esbuild CJS bundle, but bare `require` is undefined when the same file is run
// as ESM (`tsx server/index.ts`, and any tsx test harness), which made local dev
// crash on boot. Resolve a working require for BOTH module systems.
const nodeRequire: NodeRequire =
  typeof require === "function"
    ? require
    : nodeCreateRequire(join(process.cwd(), "noop.cjs"));

function makePgDb(url: string) {
  // Lazy import so PGlite-only paths don't pull pg.
  const { Pool } = nodeRequire("pg") as typeof import("pg");
  const { drizzle } = nodeRequire("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString: url,
    // Railway internal Postgres uses TLS but with their cert chain.
    ssl: url.includes("railway") || url.includes("sslmode=require")
      ? { rejectUnauthorized: false }
      : undefined,
  });
  return drizzle(pool);
}

function makePgliteDb(dataDir: string) {
  const { PGlite } = nodeRequire("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  const { drizzle } = nodeRequire("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");
  const client = new PGlite(dataDir);
  return drizzle(client as any);
}

const DATABASE_URL = process.env.DATABASE_URL;
export const db: AnyDb = DATABASE_URL
  ? makePgDb(DATABASE_URL)
  : makePgliteDb("./data.pgdata");

export const isPglite = !DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Schema bootstrap — create tables on first boot.
// Drizzle-kit migrations are the "real" path on Railway, but we want zero-
// friction sandbox startup, so we run raw CREATE TABLE IF NOT EXISTS at boot.
// Idempotent. Safe in prod too (additive only).
// ─────────────────────────────────────────────────────────────────────────────
export async function bootstrapSchema(): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      service TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_tested_at TIMESTAMP,
      test_status TEXT,
      test_message TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json JSONB NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS series_cache (
      cache_key TEXT PRIMARY KEY,
      payload_json JSONB NOT NULL,
      fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      source TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS series_cache_expires_idx ON series_cache(expires_at)`,
    `CREATE TABLE IF NOT EXISTS api_call_log (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL DEFAULT NOW(),
      service TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      action_context TEXT,
      model TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      error_message TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS api_call_log_ts_idx ON api_call_log(ts)`,
    `CREATE INDEX IF NOT EXISTS api_call_log_service_idx ON api_call_log(service)`,
    `CREATE INDEX IF NOT EXISTS api_call_log_context_idx ON api_call_log(action_context)`,
    `CREATE TABLE IF NOT EXISTS cost_ceilings (
      service TEXT PRIMARY KEY,
      monthly_limit_usd DOUBLE PRECISION NOT NULL DEFAULT 20,
      current_month_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      hard_stop_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      monthly_call_cap INTEGER,
      current_month_calls INTEGER NOT NULL DEFAULT 0,
      month_anchor TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS watchlists (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      series_ids_json JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS chart_configs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      config_json JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS view_state (
      key TEXT PRIMARY KEY,
      value_json JSONB NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS imported_series (
      series_id TEXT NOT NULL,
      series_label TEXT NOT NULL,
      date TEXT NOT NULL,
      value DOUBLE PRECISION NOT NULL,
      source_mnemonic TEXT,
      unit TEXT,
      frequency TEXT,
      imported_at TIMESTAMP NOT NULL DEFAULT NOW(),
      source_name TEXT NOT NULL DEFAULT 'factset',
      PRIMARY KEY (series_id, date)
    )`,
    `CREATE INDEX IF NOT EXISTS imported_series_id_idx ON imported_series(series_id)`,
    // ─── CEIC import bridge (Phase 7) ────────────────────────────────────
    // Additive only: no existing table is altered or migrated.
    `CREATE TABLE IF NOT EXISTS ceic_import_catalog (
      series_id TEXT PRIMARY KEY,
      mnemonic TEXT,
      label TEXT NOT NULL,
      label_zh TEXT,
      geo TEXT,
      frequency TEXT,
      unit TEXT,
      original_source TEXT,
      logical_id TEXT,
      transform TEXT,
      first_date TEXT,
      last_date TEXT,
      last_imported_at TIMESTAMP,
      last_file_vintage TEXT,
      vintage_enabled BOOLEAN,
      status TEXT NOT NULL DEFAULT 'unknown',
      source_mode TEXT NOT NULL DEFAULT 'cdm_import',
      metadata_json JSONB
    )`,
    `CREATE INDEX IF NOT EXISTS ceic_catalog_logical_idx ON ceic_import_catalog(logical_id)`,
    `CREATE TABLE IF NOT EXISTS ceic_import_observations (
      series_id TEXT NOT NULL,
      observation_date TEXT NOT NULL,
      vintage_date TEXT NOT NULL,
      value DOUBLE PRECISION,
      imported_at TIMESTAMP NOT NULL DEFAULT NOW(),
      source_file_hash TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      source_mode TEXT NOT NULL DEFAULT 'cdm_import',
      PRIMARY KEY (series_id, observation_date, vintage_date)
    )`,
    `CREATE INDEX IF NOT EXISTS ceic_obs_series_idx ON ceic_import_observations(series_id)`,
    `CREATE TABLE IF NOT EXISTS ceic_import_files (
      file_hash TEXT PRIMARY KEY,
      filename TEXT,
      source_mode TEXT NOT NULL DEFAULT 'cdm_import',
      vintage_date TEXT NOT NULL,
      layout TEXT,
      series_count INTEGER NOT NULL DEFAULT 0,
      row_count INTEGER NOT NULL DEFAULT 0,
      imported_at TIMESTAMP NOT NULL DEFAULT NOW(),
      warnings_json JSONB
    )`,
    `CREATE INDEX IF NOT EXISTS ceic_files_imported_idx ON ceic_import_files(imported_at)`,
    `CREATE TABLE IF NOT EXISTS scenarios (
      id SERIAL PRIMARY KEY,
      generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      target_quarter TEXT NOT NULL,
      base_case JSONB NOT NULL,
      bull_case JSONB NOT NULL,
      bear_case JSONB NOT NULL,
      base_prob DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      bull_prob DOUBLE PRECISION NOT NULL DEFAULT 0.25,
      bear_prob DOUBLE PRECISION NOT NULL DEFAULT 0.25,
      inputs_json JSONB NOT NULL,
      model TEXT NOT NULL,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      user_edited BOOLEAN NOT NULL DEFAULT FALSE,
      hit_rate_json JSONB
    )`,
    `CREATE INDEX IF NOT EXISTS scenarios_quarter_idx ON scenarios(target_quarter)`,
    `CREATE INDEX IF NOT EXISTS scenarios_generated_idx ON scenarios(generated_at)`,
    `CREATE TABLE IF NOT EXISTS briefs (
      id SERIAL PRIMARY KEY,
      generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      as_of_date TEXT NOT NULL,
      exec_summary TEXT NOT NULL DEFAULT '',
      sections JSONB NOT NULL,
      inputs_json JSONB NOT NULL,
      model TEXT NOT NULL,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      user_notes TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS briefs_generated_idx ON briefs(generated_at)`,
    `CREATE TABLE IF NOT EXISTS policy_updates (
      id SERIAL PRIMARY KEY,
      fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
      published_at TEXT,
      body TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 6,
      title TEXT NOT NULL,
      title_zh TEXT,
      url TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      categories JSONB NOT NULL,
      themes JSONB NOT NULL,
      significance TEXT NOT NULL DEFAULT 'medium',
      significance_rationale TEXT NOT NULL DEFAULT '',
      market_linkage JSONB NOT NULL,
      sources JSONB NOT NULL,
      provenance TEXT NOT NULL DEFAULT 'sonar',
      dedupe_key TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS policy_updates_body_idx ON policy_updates(body)`,
    `CREATE INDEX IF NOT EXISTS policy_updates_published_idx ON policy_updates(published_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS policy_updates_dedupe_idx ON policy_updates(dedupe_key)`,
    `CREATE TABLE IF NOT EXISTS house_view (
      id SERIAL PRIMARY KEY,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      headline TEXT NOT NULL DEFAULT '',
      stance TEXT NOT NULL DEFAULT 'neutral',
      conviction TEXT NOT NULL DEFAULT 'medium',
      horizon TEXT NOT NULL DEFAULT '2Q',
      pillars JSONB NOT NULL,
      key_risks JSONB NOT NULL,
      sector_stance JSONB NOT NULL,
      change_log JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_notes (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      title TEXT NOT NULL DEFAULT '',
      as_of_date TEXT NOT NULL,
      mode TEXT NOT NULL,
      user_thesis TEXT NOT NULL DEFAULT '',
      featured_names JSONB NOT NULL,
      must_include JSONB NOT NULL,
      emphasis JSONB NOT NULL,
      sections JSONB NOT NULL,
      portfolio JSONB,
      thesis_verdict JSONB,
      house_view_snapshot JSONB,
      citations JSONB NOT NULL,
      model TEXT NOT NULL,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft'
    )`,
    `CREATE INDEX IF NOT EXISTS strategy_notes_created_idx ON strategy_notes(created_at)`,
    `CREATE TABLE IF NOT EXISTS job_runs (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMP,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      note_id INTEGER,
      error TEXT,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      steps JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS job_runs_started_idx ON job_runs(started_at)`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      kind TEXT NOT NULL DEFAULT 'info'
    )`,
    `CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at)`,
    `CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL,
      source_id INTEGER,
      model TEXT,
      horizon TEXT NOT NULL DEFAULT '2Q',
      resolve_at TIMESTAMP NOT NULL,
      claim JSONB NOT NULL,
      probability DOUBLE PRECISION,
      anchor JSONB,
      status TEXT NOT NULL DEFAULT 'open',
      outcome TEXT,
      realized JSONB,
      scored_at TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS predictions_status_resolve_idx ON predictions(status, resolve_at)`,
  ];
  for (const s of stmts) {
    await (db as any).execute(sql.raw(s));
  }

  // Seed default cost ceilings if missing.
  const defaultMonth = new Date().toISOString().slice(0, 7);
  const defaults: Array<{ service: string; limit: number; callCap: number | null }> = [
    { service: "ceic", limit: 50, callCap: 5000 },
    { service: "sonar", limit: 20, callCap: null },
    { service: "anthropic", limit: 30, callCap: null },
    { service: "deepseek", limit: 10, callCap: null },
  ];
  for (const d of defaults) {
    await (db as any).execute(
      sql`INSERT INTO cost_ceilings (service, monthly_limit_usd, monthly_call_cap, month_anchor)
          VALUES (${d.service}, ${d.limit}, ${d.callCap}, ${defaultMonth})
          ON CONFLICT (service) DO NOTHING`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage interface
// ─────────────────────────────────────────────────────────────────────────────
export interface IStorage {
  // API keys
  upsertApiKey(input: InsertApiKey): Promise<ApiKey>;
  getApiKey(service: string): Promise<ApiKey | undefined>;
  listApiKeys(): Promise<ApiKey[]>;
  updateApiKeyTestResult(service: string, status: string, message: string | null): Promise<void>;
  deleteApiKey(service: string): Promise<void>;

  // Settings
  setSetting(input: InsertSetting): Promise<Setting>;
  getSetting(key: string): Promise<Setting | undefined>;
  listSettings(): Promise<Setting[]>;

  // Series cache
  getCache(cacheKey: string): Promise<SeriesCache | undefined>;
  setCache(cacheKey: string, payload: unknown, expiresAt: Date, source: string): Promise<void>;
  clearExpiredCache(): Promise<number>;

  // Audit log
  logApiCall(input: InsertApiCallLog): Promise<ApiCallLog>;
  listApiCalls(limit: number, sinceTs?: Date, service?: string): Promise<ApiCallLog[]>;
  getMonthlyCostByService(yearMonth: string): Promise<Array<{ service: string; total: number; calls: number }>>;
  getMonthlyCostByContext(yearMonth: string): Promise<Array<{ actionContext: string | null; service: string; total: number; calls: number }>>;

  // Cost ceilings
  getCeiling(service: string): Promise<CostCeiling | undefined>;
  listCeilings(): Promise<CostCeiling[]>;
  upsertCeiling(input: InsertCostCeiling): Promise<CostCeiling>;
  incrementSpend(service: string, costUsd: number, callCount: number, yearMonth: string): Promise<CostCeiling>;
  bumpLimit(service: string, deltaUsd: number): Promise<CostCeiling>;

  // Watchlists / chart configs (P3 stubs)
  listWatchlists(): Promise<Watchlist[]>;
  createWatchlist(input: InsertWatchlist): Promise<Watchlist>;
  deleteWatchlist(id: number): Promise<void>;

  listChartConfigs(): Promise<ChartConfig[]>;
  createChartConfig(input: InsertChartConfig): Promise<ChartConfig>;

  // View state
  setViewState(input: InsertViewState): Promise<ViewState>;
  getViewState(key: string): Promise<ViewState | undefined>;

  // Imported series (FactSet, Bloomberg, manual)
  upsertImportedSeriesBatch(rows: InsertImportedSeries[]): Promise<{ inserted: number; updated: number }>;
  listImportedSeriesIds(): Promise<
    Array<{
      seriesId: string;
      seriesLabel: string;
      sourceName: string;
      sourceMnemonic: string | null;
      unit: string | null;
      frequency: string | null;
      pointCount: number;
      latestDate: string | null;
      latestValue: number | null;
      importedAt: Date;
    }>
  >;
  getImportedSeries(seriesId: string): Promise<ImportedSeries[]>;
  deleteImportedSeries(seriesId: string): Promise<number>;

  // CEIC import bridge (Phase 7)
  upsertCeicCatalogBatch(entries: Partial<InsertCeicCatalogEntry>[]): Promise<number>;
  listCeicCatalog(): Promise<CeicCatalogEntry[]>;
  getCeicCatalogEntry(seriesId: string): Promise<CeicCatalogEntry | undefined>;
  getCeicCatalogByLogicalId(logicalId: string): Promise<CeicCatalogEntry | undefined>;
  setCeicMapping(
    seriesId: string,
    logicalId: string | null,
    transform: string | null,
  ): Promise<CeicCatalogEntry | undefined>;
  insertCeicObservations(rows: InsertCeicObservation[]): Promise<number>;
  listCeicVintages(seriesId: string, observationDate?: string): Promise<CeicObservation[]>;
  getLatestCeicObservations(seriesId: string): Promise<{ date: string; value: number | null; vintageDate: string }[]>;
  getCeicImportFile(fileHash: string): Promise<CeicImportFile | undefined>;
  recordCeicImportFile(row: {
    fileHash: string;
    filename?: string | null;
    sourceMode: string;
    vintageDate: string;
    layout?: string | null;
    seriesCount: number;
    rowCount: number;
    warnings?: string[];
  }): Promise<void>;
  listCeicImportFiles(limit?: number): Promise<CeicImportFile[]>;
  getCeicImportStats(): Promise<{
    catalogCount: number;
    mappedCount: number;
    observationCount: number;
    vintageCount: number;
    seriesWithVintages: number;
    latestObservationDate: string | null;
    latestImportAt: string | null;
    latestVintageDate: string | null;
    byMode: { sourceMode: string; series: number; rows: number }[];
  }>;

  // Scenarios (Phase 3b)
  createScenario(input: InsertScenario): Promise<Scenario>;
  listScenarios(limit?: number): Promise<Scenario[]>;
  getScenario(id: number): Promise<Scenario | undefined>;
  getLatestScenarioForQuarter(targetQuarter: string): Promise<Scenario | undefined>;
  updateScenarioEdits(id: number, patch: { baseCase?: unknown; bullCase?: unknown; bearCase?: unknown; baseProb?: number; bullProb?: number; bearProb?: number }): Promise<Scenario | undefined>;
  setScenarioHitRate(id: number, hitRate: unknown): Promise<void>;
  // Briefs (Phase 3b Session 4)
  createBrief(input: InsertBrief): Promise<Brief>;
  listBriefs(limit?: number): Promise<Brief[]>;
  getBrief(id: number): Promise<Brief | undefined>;
  getLatestBrief(): Promise<Brief | undefined>;
  updateBriefNotes(id: number, userNotes: string): Promise<Brief | undefined>;
  countBriefsSince(sinceIso: string): Promise<number>;

  // Track record / predictions
  createPrediction(input: InsertPrediction): Promise<Prediction>;
  listPredictions(opts?: { status?: string; kind?: string; model?: string; limit?: number }): Promise<Prediction[]>;
  getDuePredictions(now?: Date): Promise<Prediction[]>;
  resolvePrediction(id: number, patch: { outcome: string; realized: unknown; scoredAt?: Date }): Promise<Prediction | undefined>;
  trackRecordSummary(): Promise<TrackRecordSummary>;
}

export interface TrackRecordBucket {
  key: string;
  correct: number;
  wrong: number;
  partial: number;
  resolved: number;
  hitRate: number | null;
}

export interface TrackRecordSummary {
  total: number;
  open: number;
  resolved: number;
  correct: number;
  wrong: number;
  partial: number;
  hitRate: number | null;      // correct / (correct + wrong)
  brier: number | null;        // over resolved predictions carrying a probability
  brierN: number;
  byKind: TrackRecordBucket[];
  byModel: TrackRecordBucket[];
}

export class DatabaseStorage implements IStorage {
  // API keys
  async upsertApiKey(input: InsertApiKey): Promise<ApiKey> {
    const existing = await this.getApiKey(input.service);
    if (existing) {
      const rows = await (db as any)
        .update(apiKeys)
        .set({ apiKey: input.apiKey, testStatus: null, testMessage: null, lastTestedAt: null })
        .where(eq(apiKeys.service, input.service))
        .returning();
      return rows[0];
    }
    const rows = await (db as any).insert(apiKeys).values(input).returning();
    return rows[0];
  }

  async getApiKey(service: string): Promise<ApiKey | undefined> {
    const rows = await (db as any).select().from(apiKeys).where(eq(apiKeys.service, service));
    return rows[0];
  }

  async listApiKeys(): Promise<ApiKey[]> {
    return (db as any).select().from(apiKeys);
  }

  async updateApiKeyTestResult(service: string, status: string, message: string | null): Promise<void> {
    await (db as any)
      .update(apiKeys)
      .set({ testStatus: status, testMessage: message, lastTestedAt: new Date() })
      .where(eq(apiKeys.service, service));
  }

  async deleteApiKey(service: string): Promise<void> {
    await (db as any).delete(apiKeys).where(eq(apiKeys.service, service));
  }

  // Settings
  async setSetting(input: InsertSetting): Promise<Setting> {
    const existing = await this.getSetting(input.key);
    if (existing) {
      const rows = await (db as any)
        .update(settings)
        .set({ valueJson: input.valueJson, updatedAt: new Date() })
        .where(eq(settings.key, input.key))
        .returning();
      return rows[0];
    }
    const rows = await (db as any).insert(settings).values(input).returning();
    return rows[0];
  }

  async getSetting(key: string): Promise<Setting | undefined> {
    const rows = await (db as any).select().from(settings).where(eq(settings.key, key));
    return rows[0];
  }

  async listSettings(): Promise<Setting[]> {
    return (db as any).select().from(settings);
  }

  // Series cache
  async getCache(cacheKey: string): Promise<SeriesCache | undefined> {
    const rows = await (db as any).select().from(seriesCache).where(eq(seriesCache.cacheKey, cacheKey));
    const row = rows[0];
    if (!row) return undefined;
    if (new Date(row.expiresAt) < new Date()) return undefined;
    return row;
  }

  async setCache(cacheKey: string, payload: unknown, expiresAt: Date, source: string): Promise<void> {
    await (db as any).execute(sql`
      INSERT INTO series_cache (cache_key, payload_json, fetched_at, expires_at, source)
      VALUES (${cacheKey}, ${JSON.stringify(payload)}::jsonb, NOW(), ${expiresAt}, ${source})
      ON CONFLICT (cache_key) DO UPDATE SET
        payload_json = EXCLUDED.payload_json,
        fetched_at = NOW(),
        expires_at = EXCLUDED.expires_at,
        source = EXCLUDED.source
    `);
  }

  async clearExpiredCache(): Promise<number> {
    const result: any = await (db as any).execute(
      sql`DELETE FROM series_cache WHERE expires_at < NOW()`,
    );
    return result?.rowCount ?? 0;
  }

  // Audit log
  async logApiCall(input: InsertApiCallLog): Promise<ApiCallLog> {
    const rows = await (db as any).insert(apiCallLog).values(input).returning();
    return rows[0];
  }

  async listApiCalls(limit: number, sinceTs?: Date, service?: string): Promise<ApiCallLog[]> {
    const conditions = [];
    if (sinceTs) conditions.push(gte(apiCallLog.ts, sinceTs));
    if (service) conditions.push(eq(apiCallLog.service, service));
    let q: any = (db as any).select().from(apiCallLog);
    if (conditions.length) q = q.where(and(...conditions));
    return q.orderBy(desc(apiCallLog.ts)).limit(limit);
  }

  async getMonthlyCostByService(
    yearMonth: string,
  ): Promise<Array<{ service: string; total: number; calls: number }>> {
    const result: any = await (db as any).execute(sql`
      SELECT service,
             COALESCE(SUM(cost_usd), 0)::float8 AS total,
             COUNT(*)::int AS calls
        FROM api_call_log
       WHERE to_char(ts, 'YYYY-MM') = ${yearMonth}
       GROUP BY service
    `);
    const rows = result.rows ?? result;
    return rows.map((r: any) => ({
      service: r.service,
      total: Number(r.total ?? 0),
      calls: Number(r.calls ?? 0),
    }));
  }

  async getMonthlyCostByContext(
    yearMonth: string,
  ): Promise<Array<{ actionContext: string | null; service: string; total: number; calls: number }>> {
    const result: any = await (db as any).execute(sql`
      SELECT action_context AS "actionContext",
             service,
             COALESCE(SUM(cost_usd), 0)::float8 AS total,
             COUNT(*)::int AS calls
        FROM api_call_log
       WHERE to_char(ts, 'YYYY-MM') = ${yearMonth}
       GROUP BY action_context, service
       ORDER BY total DESC
    `);
    const rows = result.rows ?? result;
    return rows.map((r: any) => ({
      actionContext: r.actionContext ?? null,
      service: r.service,
      total: Number(r.total ?? 0),
      calls: Number(r.calls ?? 0),
    }));
  }

  // Cost ceilings
  async getCeiling(service: string): Promise<CostCeiling | undefined> {
    const rows = await (db as any).select().from(costCeilings).where(eq(costCeilings.service, service));
    return rows[0];
  }

  async listCeilings(): Promise<CostCeiling[]> {
    return (db as any).select().from(costCeilings);
  }

  async upsertCeiling(input: InsertCostCeiling): Promise<CostCeiling> {
    const existing = await this.getCeiling(input.service);
    if (existing) {
      const rows = await (db as any)
        .update(costCeilings)
        .set(input)
        .where(eq(costCeilings.service, input.service))
        .returning();
      return rows[0];
    }
    const rows = await (db as any).insert(costCeilings).values(input).returning();
    return rows[0];
  }

  async incrementSpend(
    service: string,
    costUsd: number,
    callCount: number,
    yearMonth: string,
  ): Promise<CostCeiling> {
    // Roll month if needed: if month_anchor != yearMonth, reset counters first.
    const existing = await this.getCeiling(service);
    if (!existing) {
      await this.upsertCeiling({
        service,
        monthlyLimitUsd: 20,
        currentMonthUsd: costUsd,
        hardStopEnabled: true,
        monthlyCallCap: null,
        currentMonthCalls: callCount,
        monthAnchor: yearMonth,
      } as InsertCostCeiling);
      const fresh = await this.getCeiling(service);
      return fresh!;
    }
    if (existing.monthAnchor !== yearMonth) {
      const rows = await (db as any)
        .update(costCeilings)
        .set({
          currentMonthUsd: costUsd,
          currentMonthCalls: callCount,
          monthAnchor: yearMonth,
        })
        .where(eq(costCeilings.service, service))
        .returning();
      return rows[0];
    }
    const rows = await (db as any)
      .update(costCeilings)
      .set({
        currentMonthUsd: sql`${costCeilings.currentMonthUsd} + ${costUsd}`,
        currentMonthCalls: sql`${costCeilings.currentMonthCalls} + ${callCount}`,
      })
      .where(eq(costCeilings.service, service))
      .returning();
    return rows[0];
  }

  async bumpLimit(service: string, deltaUsd: number): Promise<CostCeiling> {
    const rows = await (db as any)
      .update(costCeilings)
      .set({ monthlyLimitUsd: sql`${costCeilings.monthlyLimitUsd} + ${deltaUsd}` })
      .where(eq(costCeilings.service, service))
      .returning();
    return rows[0];
  }

  // Watchlists
  async listWatchlists(): Promise<Watchlist[]> {
    return (db as any).select().from(watchlists).orderBy(desc(watchlists.updatedAt));
  }

  async createWatchlist(input: InsertWatchlist): Promise<Watchlist> {
    const rows = await (db as any).insert(watchlists).values(input).returning();
    return rows[0];
  }

  async deleteWatchlist(id: number): Promise<void> {
    await (db as any).delete(watchlists).where(eq(watchlists.id, id));
  }

  // Chart configs
  async listChartConfigs(): Promise<ChartConfig[]> {
    return (db as any).select().from(chartConfigs).orderBy(desc(chartConfigs.createdAt));
  }

  async createChartConfig(input: InsertChartConfig): Promise<ChartConfig> {
    const rows = await (db as any).insert(chartConfigs).values(input).returning();
    return rows[0];
  }

  // View state
  async setViewState(input: InsertViewState): Promise<ViewState> {
    const existing = await this.getViewState(input.key);
    if (existing) {
      const rows = await (db as any)
        .update(viewState)
        .set({ valueJson: input.valueJson, updatedAt: new Date() })
        .where(eq(viewState.key, input.key))
        .returning();
      return rows[0];
    }
    const rows = await (db as any).insert(viewState).values(input).returning();
    return rows[0];
  }

  async getViewState(key: string): Promise<ViewState | undefined> {
    const rows = await (db as any).select().from(viewState).where(eq(viewState.key, key));
    return rows[0];
  }

  // Imported series
  async upsertImportedSeriesBatch(
    rows: InsertImportedSeries[],
  ): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };
    // We don't get insert-vs-update distinction cheaply; report total as inserted on conflict-do-update.
    // Use ON CONFLICT DO UPDATE so re-imports refresh values.
    let affected = 0;
    for (const r of rows) {
      await (db as any).execute(sql`
        INSERT INTO imported_series
          (series_id, series_label, date, value, source_mnemonic, unit, frequency, source_name)
        VALUES (
          ${r.seriesId}, ${r.seriesLabel}, ${r.date}, ${r.value},
          ${r.sourceMnemonic ?? null}, ${r.unit ?? null}, ${r.frequency ?? null},
          ${r.sourceName ?? "factset"}
        )
        ON CONFLICT (series_id, date) DO UPDATE SET
          series_label = EXCLUDED.series_label,
          value = EXCLUDED.value,
          source_mnemonic = EXCLUDED.source_mnemonic,
          unit = EXCLUDED.unit,
          frequency = EXCLUDED.frequency,
          source_name = EXCLUDED.source_name,
          imported_at = NOW()
      `);
      affected += 1;
    }
    return { inserted: affected, updated: 0 };
  }

  async listImportedSeriesIds() {
    const result: any = await (db as any).execute(sql`
      SELECT series_id          AS "seriesId",
             MAX(series_label)   AS "seriesLabel",
             MAX(source_name)    AS "sourceName",
             MAX(source_mnemonic) AS "sourceMnemonic",
             MAX(unit)           AS "unit",
             MAX(frequency)      AS "frequency",
             COUNT(*)::int       AS "pointCount",
             MAX(date)           AS "latestDate",
             MAX(imported_at)    AS "importedAt"
        FROM imported_series
       GROUP BY series_id
       ORDER BY MAX(imported_at) DESC
    `);
    const rows = result.rows ?? result;
    // For latestValue, fetch the value at MAX(date) per series in a second pass (cheap, few rows).
    const out: any[] = [];
    for (const r of rows) {
      const v: any = await (db as any).execute(
        sql`SELECT value FROM imported_series WHERE series_id = ${r.seriesId} AND date = ${r.latestDate}`,
      );
      const vrows = v.rows ?? v;
      out.push({
        seriesId: r.seriesId,
        seriesLabel: r.seriesLabel,
        sourceName: r.sourceName,
        sourceMnemonic: r.sourceMnemonic,
        unit: r.unit,
        frequency: r.frequency,
        pointCount: Number(r.pointCount ?? 0),
        latestDate: r.latestDate,
        latestValue: vrows[0]?.value != null ? Number(vrows[0].value) : null,
        importedAt: r.importedAt,
      });
    }
    return out;
  }

  async getImportedSeries(seriesId: string): Promise<ImportedSeries[]> {
    const rows = await (db as any)
      .select()
      .from(importedSeries)
      .where(eq(importedSeries.seriesId, seriesId))
      .orderBy(desc(importedSeries.date));
    return rows;
  }

  // ─── CEIC import bridge (Phase 7) ────────────────────────────────────

  async upsertCeicCatalogBatch(entries: Partial<InsertCeicCatalogEntry>[]): Promise<number> {
    if (!entries.length) return 0;
    let n = 0;
    for (const e of entries) {
      if (!e.seriesId) continue;
      await (db as any).execute(sql`
        INSERT INTO ceic_import_catalog
          (series_id, mnemonic, label, label_zh, geo, frequency, unit, original_source,
           logical_id, transform, first_date, last_date, last_imported_at,
           last_file_vintage, vintage_enabled, status, source_mode, metadata_json)
        VALUES (
          ${e.seriesId}, ${e.mnemonic ?? null}, ${e.label ?? e.seriesId}, ${e.labelZh ?? null},
          ${e.geo ?? null}, ${e.frequency ?? null}, ${e.unit ?? null}, ${e.originalSource ?? null},
          ${e.logicalId ?? null}, ${e.transform ?? null}, ${e.firstDate ?? null}, ${e.lastDate ?? null},
          NOW(), ${e.lastFileVintage ?? null}, ${e.vintageEnabled ?? null},
          ${e.status ?? "active"}, ${e.sourceMode ?? "cdm_import"},
          ${JSON.stringify(e.metadataJson ?? {})}::jsonb
        )
        ON CONFLICT (series_id) DO UPDATE SET
          mnemonic        = COALESCE(EXCLUDED.mnemonic, ceic_import_catalog.mnemonic),
          label           = COALESCE(NULLIF(EXCLUDED.label, ''), ceic_import_catalog.label),
          label_zh        = COALESCE(EXCLUDED.label_zh, ceic_import_catalog.label_zh),
          geo             = COALESCE(EXCLUDED.geo, ceic_import_catalog.geo),
          frequency       = COALESCE(EXCLUDED.frequency, ceic_import_catalog.frequency),
          unit            = COALESCE(EXCLUDED.unit, ceic_import_catalog.unit),
          original_source = COALESCE(EXCLUDED.original_source, ceic_import_catalog.original_source),
          -- NEVER clobber a user-set mapping with a null coming from a file.
          logical_id      = COALESCE(EXCLUDED.logical_id, ceic_import_catalog.logical_id),
          transform       = COALESCE(EXCLUDED.transform, ceic_import_catalog.transform),
          first_date      = LEAST(COALESCE(EXCLUDED.first_date, ceic_import_catalog.first_date),
                                  COALESCE(ceic_import_catalog.first_date, EXCLUDED.first_date)),
          last_date       = GREATEST(COALESCE(EXCLUDED.last_date, ceic_import_catalog.last_date),
                                     COALESCE(ceic_import_catalog.last_date, EXCLUDED.last_date)),
          last_imported_at   = NOW(),
          last_file_vintage  = COALESCE(EXCLUDED.last_file_vintage, ceic_import_catalog.last_file_vintage),
          vintage_enabled    = COALESCE(EXCLUDED.vintage_enabled, ceic_import_catalog.vintage_enabled),
          status             = EXCLUDED.status,
          source_mode        = EXCLUDED.source_mode,
          metadata_json      = COALESCE(EXCLUDED.metadata_json, ceic_import_catalog.metadata_json)
      `);
      n += 1;
    }
    return n;
  }

  async listCeicCatalog(): Promise<CeicCatalogEntry[]> {
    const rows = await (db as any)
      .select()
      .from(ceicImportCatalog)
      .orderBy(desc(ceicImportCatalog.lastImportedAt));
    return rows;
  }

  async getCeicCatalogEntry(seriesId: string): Promise<CeicCatalogEntry | undefined> {
    const rows = await (db as any)
      .select()
      .from(ceicImportCatalog)
      .where(eq(ceicImportCatalog.seriesId, seriesId));
    return rows[0];
  }

  async getCeicCatalogByLogicalId(logicalId: string): Promise<CeicCatalogEntry | undefined> {
    const rows = await (db as any)
      .select()
      .from(ceicImportCatalog)
      .where(eq(ceicImportCatalog.logicalId, logicalId))
      .orderBy(desc(ceicImportCatalog.lastImportedAt));
    return rows[0];
  }

  async setCeicMapping(
    seriesId: string,
    logicalId: string | null,
    transform: string | null,
  ): Promise<CeicCatalogEntry | undefined> {
    await (db as any).execute(sql`
      UPDATE ceic_import_catalog
         SET logical_id = ${logicalId}, transform = ${transform}
       WHERE series_id = ${seriesId}
    `);
    return this.getCeicCatalogEntry(seriesId);
  }

  /**
   * Append revision-aware observations. Conflicts on
   * (series_id, observation_date, vintage_date) refresh the value in place —
   * a *new* vintage always produces a new row, so history is never lost.
   */
  async insertCeicObservations(rows: InsertCeicObservation[]): Promise<number> {
    if (!rows.length) return 0;
    let n = 0;
    for (const r of rows) {
      await (db as any).execute(sql`
        INSERT INTO ceic_import_observations
          (series_id, observation_date, vintage_date, value, imported_at,
           source_file_hash, status, source_mode)
        VALUES (
          ${r.seriesId}, ${r.observationDate}, ${r.vintageDate},
          ${r.value ?? null}, NOW(), ${r.sourceFileHash ?? null},
          ${r.status ?? "ok"}, ${r.sourceMode ?? "cdm_import"}
        )
        ON CONFLICT (series_id, observation_date, vintage_date) DO UPDATE SET
          value            = EXCLUDED.value,
          imported_at      = NOW(),
          source_file_hash = EXCLUDED.source_file_hash,
          status           = EXCLUDED.status,
          source_mode      = EXCLUDED.source_mode
      `);
      n += 1;
    }
    return n;
  }

  async listCeicVintages(seriesId: string, observationDate?: string): Promise<CeicObservation[]> {
    const where = observationDate
      ? and(
          eq(ceicImportObservations.seriesId, seriesId),
          eq(ceicImportObservations.observationDate, observationDate),
        )
      : eq(ceicImportObservations.seriesId, seriesId);
    const rows = await (db as any)
      .select()
      .from(ceicImportObservations)
      .where(where)
      .orderBy(desc(ceicImportObservations.observationDate), desc(ceicImportObservations.vintageDate));
    return rows;
  }

  /** Latest vintage per observation date, newest observation first. */
  async getLatestCeicObservations(
    seriesId: string,
  ): Promise<{ date: string; value: number | null; vintageDate: string }[]> {
    const result: any = await (db as any).execute(sql`
      SELECT DISTINCT ON (observation_date)
             observation_date AS "date",
             value            AS "value",
             vintage_date     AS "vintageDate"
        FROM ceic_import_observations
       WHERE series_id = ${seriesId}
       ORDER BY observation_date DESC, vintage_date DESC
    `);
    const rows = result.rows ?? result;
    return rows.map((r: any) => ({
      date: r.date,
      value: r.value != null ? Number(r.value) : null,
      vintageDate: r.vintageDate,
    }));
  }

  async getCeicImportFile(fileHash: string): Promise<CeicImportFile | undefined> {
    const rows = await (db as any)
      .select()
      .from(ceicImportFiles)
      .where(eq(ceicImportFiles.fileHash, fileHash));
    return rows[0];
  }

  async recordCeicImportFile(row: {
    fileHash: string;
    filename?: string | null;
    sourceMode: string;
    vintageDate: string;
    layout?: string | null;
    seriesCount: number;
    rowCount: number;
    warnings?: string[];
  }): Promise<void> {
    await (db as any).execute(sql`
      INSERT INTO ceic_import_files
        (file_hash, filename, source_mode, vintage_date, layout, series_count, row_count, imported_at, warnings_json)
      VALUES (
        ${row.fileHash}, ${row.filename ?? null}, ${row.sourceMode}, ${row.vintageDate},
        ${row.layout ?? null}, ${row.seriesCount}, ${row.rowCount}, NOW(),
        ${JSON.stringify(row.warnings ?? [])}::jsonb
      )
      ON CONFLICT (file_hash) DO NOTHING
    `);
  }

  async listCeicImportFiles(limit = 20): Promise<CeicImportFile[]> {
    const rows = await (db as any)
      .select()
      .from(ceicImportFiles)
      .orderBy(desc(ceicImportFiles.importedAt))
      .limit(limit);
    return rows;
  }

  async getCeicImportStats() {
    const one = async (q: any) => {
      const r: any = await (db as any).execute(q);
      const rows = r.rows ?? r;
      return rows[0] ?? {};
    };
    const many = async (q: any) => {
      const r: any = await (db as any).execute(q);
      return r.rows ?? r;
    };

    const cat = await one(sql`
      SELECT COUNT(*)::int AS "catalogCount",
             COUNT(logical_id)::int AS "mappedCount"
        FROM ceic_import_catalog
    `);
    const obs = await one(sql`
      SELECT COUNT(*)::int AS "vintageCount",
             COUNT(DISTINCT (series_id || '|' || observation_date))::int AS "observationCount",
             MAX(observation_date) AS "latestObservationDate",
             MAX(vintage_date)     AS "latestVintageDate",
             MAX(imported_at)      AS "latestImportAt"
        FROM ceic_import_observations
    `);
    const multi = await one(sql`
      SELECT COUNT(*)::int AS "seriesWithVintages" FROM (
        SELECT series_id FROM ceic_import_observations
         GROUP BY series_id HAVING COUNT(DISTINCT vintage_date) > 1
      ) t
    `);
    const byMode = await many(sql`
      SELECT source_mode AS "sourceMode",
             COUNT(DISTINCT series_id)::int AS "series",
             COUNT(*)::int AS "rows"
        FROM ceic_import_observations
       GROUP BY source_mode
    `);

    return {
      catalogCount: Number(cat.catalogCount ?? 0),
      mappedCount: Number(cat.mappedCount ?? 0),
      observationCount: Number(obs.observationCount ?? 0),
      vintageCount: Number(obs.vintageCount ?? 0),
      seriesWithVintages: Number(multi.seriesWithVintages ?? 0),
      latestObservationDate: obs.latestObservationDate ?? null,
      latestVintageDate: obs.latestVintageDate ?? null,
      latestImportAt: obs.latestImportAt
        ? new Date(obs.latestImportAt).toISOString()
        : null,
      byMode: (byMode as any[]).map((m) => ({
        sourceMode: m.sourceMode,
        series: Number(m.series ?? 0),
        rows: Number(m.rows ?? 0),
      })),
    };
  }

  // ─── Scenarios (Phase 3b) ────────────────────────────────────────────
  async createScenario(input: InsertScenario): Promise<Scenario> {
    const row = await (db as any)
      .insert(scenarios)
      .values(input)
      .returning();
    return row[0];
  }

  async listScenarios(limit = 20): Promise<Scenario[]> {
    const rows = await (db as any)
      .select()
      .from(scenarios)
      .orderBy(desc(scenarios.generatedAt))
      .limit(limit);
    return rows;
  }

  async getScenario(id: number): Promise<Scenario | undefined> {
    const rows = await (db as any)
      .select()
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);
    return rows[0];
  }

  async getLatestScenarioForQuarter(targetQuarter: string): Promise<Scenario | undefined> {
    const rows = await (db as any)
      .select()
      .from(scenarios)
      .where(eq(scenarios.targetQuarter, targetQuarter))
      .orderBy(desc(scenarios.generatedAt))
      .limit(1);
    return rows[0];
  }

  async updateScenarioEdits(
    id: number,
    patch: { baseCase?: unknown; bullCase?: unknown; bearCase?: unknown; baseProb?: number; bullProb?: number; bearProb?: number },
  ): Promise<Scenario | undefined> {
    const setObj: Record<string, unknown> = { userEdited: true };
    if (patch.baseCase != null) setObj.baseCase = patch.baseCase;
    if (patch.bullCase != null) setObj.bullCase = patch.bullCase;
    if (patch.bearCase != null) setObj.bearCase = patch.bearCase;
    if (patch.baseProb != null) setObj.baseProb = patch.baseProb;
    if (patch.bullProb != null) setObj.bullProb = patch.bullProb;
    if (patch.bearProb != null) setObj.bearProb = patch.bearProb;
    const rows = await (db as any)
      .update(scenarios)
      .set(setObj)
      .where(eq(scenarios.id, id))
      .returning();
    return rows[0];
  }

  async setScenarioHitRate(id: number, hitRate: unknown): Promise<void> {
    await (db as any)
      .update(scenarios)
      .set({ hitRateJson: hitRate })
      .where(eq(scenarios.id, id));
  }

  // ─── Briefs (Phase 3b Session 4) ─────────────────────────────────
  async createBrief(input: InsertBrief): Promise<Brief> {
    const row = await (db as any)
      .insert(briefs)
      .values(input)
      .returning();
    return row[0];
  }

  async listBriefs(limit = 20): Promise<Brief[]> {
    const rows = await (db as any)
      .select()
      .from(briefs)
      .orderBy(desc(briefs.generatedAt))
      .limit(limit);
    return rows;
  }

  async getBrief(id: number): Promise<Brief | undefined> {
    const rows = await (db as any)
      .select()
      .from(briefs)
      .where(eq(briefs.id, id))
      .limit(1);
    return rows[0];
  }

  async getLatestBrief(): Promise<Brief | undefined> {
    const rows = await (db as any)
      .select()
      .from(briefs)
      .orderBy(desc(briefs.generatedAt))
      .limit(1);
    return rows[0];
  }

  async updateBriefNotes(id: number, userNotes: string): Promise<Brief | undefined> {
    const rows = await (db as any)
      .update(briefs)
      .set({ userNotes })
      .where(eq(briefs.id, id))
      .returning();
    return rows[0];
  }

  async countBriefsSince(sinceIso: string): Promise<number> {
    const result: any = await (db as any).execute(
      sql`SELECT COUNT(*)::int AS c FROM briefs WHERE generated_at >= ${sinceIso}`,
    );
    const rows = result.rows ?? result;
    return Number(rows[0]?.c ?? 0);
  }

  // ─── Policy updates (Phase 1) ───────────────────────────────────────────
  async policyExists(dedupeKey: string): Promise<boolean> {
    const rows = await (db as any)
      .select({ id: policyUpdates.id })
      .from(policyUpdates)
      .where(eq(policyUpdates.dedupeKey, dedupeKey))
      .limit(1);
    return rows.length > 0;
  }

  async insertPolicyUpdate(input: InsertPolicyUpdate): Promise<PolicyUpdate> {
    const row = await (db as any).insert(policyUpdates).values(input).returning();
    return row[0];
  }

  async listPolicyUpdates(opts?: {
    body?: string;
    theme?: string;
    category?: string;
    significance?: string;
    limit?: number;
  }): Promise<PolicyUpdate[]> {
    const limit = opts?.limit ?? 200;
    let rows: any[] = await (db as any)
      .select()
      .from(policyUpdates)
      .orderBy(desc(policyUpdates.fetchedAt))
      .limit(limit);
    // JSONB array filters done in JS for driver portability (PGlite + pg).
    if (opts?.body) rows = rows.filter((r) => r.body === opts.body);
    if (opts?.significance) rows = rows.filter((r) => r.significance === opts.significance);
    if (opts?.theme) rows = rows.filter((r) => Array.isArray(r.themes) && r.themes.includes(opts.theme));
    if (opts?.category)
      rows = rows.filter((r) => Array.isArray(r.categories) && r.categories.includes(opts.category));
    return rows;
  }

  async getPolicyUpdate(id: number): Promise<PolicyUpdate | undefined> {
    const rows = await (db as any)
      .select()
      .from(policyUpdates)
      .where(eq(policyUpdates.id, id))
      .limit(1);
    return rows[0];
  }

  async updatePolicyLinkage(id: number, marketLinkage: unknown): Promise<PolicyUpdate | undefined> {
    const rows = await (db as any)
      .update(policyUpdates)
      .set({ marketLinkage })
      .where(eq(policyUpdates.id, id))
      .returning();
    return rows[0];
  }

  // ─── House view + strategy notes (Phase 3) ────────────────────────────────
  async getHouseView(): Promise<HouseView | undefined> {
    const rows = await (db as any)
      .select()
      .from(houseView)
      .orderBy(desc(houseView.updatedAt))
      .limit(1);
    return rows[0];
  }

  async upsertHouseView(input: InsertHouseView): Promise<HouseView> {
    const existing = await this.getHouseView();
    if (existing) {
      const rows = await (db as any)
        .update(houseView)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(houseView.id, existing.id))
        .returning();
      return rows[0];
    }
    const rows = await (db as any).insert(houseView).values(input).returning();
    return rows[0];
  }

  async insertStrategyNote(input: InsertStrategyNote): Promise<StrategyNote> {
    const rows = await (db as any).insert(strategyNotes).values(input).returning();
    return rows[0];
  }

  async listStrategyNotes(limit = 50): Promise<StrategyNote[]> {
    return await (db as any)
      .select()
      .from(strategyNotes)
      .orderBy(desc(strategyNotes.createdAt))
      .limit(limit);
  }

  async getStrategyNote(id: number): Promise<StrategyNote | undefined> {
    const rows = await (db as any)
      .select()
      .from(strategyNotes)
      .where(eq(strategyNotes.id, id))
      .limit(1);
    return rows[0];
  }

  async updateStrategyNote(
    id: number,
    patch: Partial<InsertStrategyNote>,
  ): Promise<StrategyNote | undefined> {
    const rows = await (db as any)
      .update(strategyNotes)
      .set(patch)
      .where(eq(strategyNotes.id, id))
      .returning();
    return rows[0];
  }

  async deleteStrategyNote(id: number): Promise<boolean> {
    const rows = await (db as any)
      .delete(strategyNotes)
      .where(eq(strategyNotes.id, id))
      .returning();
    return rows.length > 0;
  }

  // ─── Job runs + notifications (Phase 5) ──────────────────────────────────
  async insertJobRun(input: InsertJobRun): Promise<JobRun> {
    const rows = await (db as any).insert(jobRuns).values(input).returning();
    return rows[0];
  }

  async updateJobRun(id: number, patch: Partial<InsertJobRun>): Promise<JobRun | undefined> {
    const rows = await (db as any).update(jobRuns).set(patch).where(eq(jobRuns.id, id)).returning();
    return rows[0];
  }

  async listJobRuns(limit = 30): Promise<JobRun[]> {
    return await (db as any).select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(limit);
  }

  async getJobRun(id: number): Promise<JobRun | undefined> {
    const rows = await (db as any).select().from(jobRuns).where(eq(jobRuns.id, id)).limit(1);
    return rows[0];
  }

  async insertNotification(input: InsertNotification): Promise<Notification> {
    const rows = await (db as any).insert(notifications).values(input).returning();
    return rows[0];
  }

  async listNotifications(limit = 30): Promise<Notification[]> {
    return await (db as any).select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit);
  }

  async markNotificationRead(id: number): Promise<void> {
    await (db as any).update(notifications).set({ read: true }).where(eq(notifications.id, id));
  }

  async markAllNotificationsRead(): Promise<void> {
    await (db as any).update(notifications).set({ read: true }).where(eq(notifications.read, false));
  }

  // ─── Track record / predictions ──────────────────────────────────────────
  async createPrediction(input: InsertPrediction): Promise<Prediction> {
    const rows = await (db as any).insert(predictions).values(input).returning();
    return rows[0];
  }

  async listPredictions(
    opts?: { status?: string; kind?: string; model?: string; limit?: number },
  ): Promise<Prediction[]> {
    const conds: any[] = [];
    if (opts?.status) conds.push(eq(predictions.status, opts.status));
    if (opts?.kind) conds.push(eq(predictions.kind, opts.kind));
    if (opts?.model) conds.push(eq(predictions.model, opts.model));
    let q: any = (db as any).select().from(predictions);
    if (conds.length) q = q.where(and(...conds));
    return await q.orderBy(desc(predictions.createdAt)).limit(opts?.limit ?? 200);
  }

  async getDuePredictions(now: Date = new Date()): Promise<Prediction[]> {
    return await (db as any)
      .select()
      .from(predictions)
      .where(and(eq(predictions.status, "open"), lte(predictions.resolveAt, now)))
      .orderBy(predictions.resolveAt)
      .limit(200);
  }

  async resolvePrediction(
    id: number,
    patch: { outcome: string; realized: unknown; scoredAt?: Date },
  ): Promise<Prediction | undefined> {
    const rows = await (db as any)
      .update(predictions)
      .set({
        status: "resolved",
        outcome: patch.outcome,
        realized: patch.realized ?? null,
        scoredAt: patch.scoredAt ?? new Date(),
      })
      .where(eq(predictions.id, id))
      .returning();
    return rows[0];
  }

  async trackRecordSummary(): Promise<TrackRecordSummary> {
    let rows: Prediction[] = [];
    try {
      rows = await (db as any).select().from(predictions).limit(5000);
    } catch {
      rows = [];
    }
    const bucket = (key: string): TrackRecordBucket =>
      ({ key, correct: 0, wrong: 0, partial: 0, resolved: 0, hitRate: null });
    const byKind = new Map<string, TrackRecordBucket>();
    const byModel = new Map<string, TrackRecordBucket>();
    let correct = 0, wrong = 0, partial = 0, open = 0;
    let brierSum = 0, brierN = 0;

    for (const r of rows) {
      if (r.status !== "resolved") { open++; continue; }
      const kb = byKind.get(r.kind) ?? bucket(r.kind);
      const mKey = r.model ?? "manual";
      const mb = byModel.get(mKey) ?? bucket(mKey);
      kb.resolved++; mb.resolved++;
      if (r.outcome === "correct") { correct++; kb.correct++; mb.correct++; }
      else if (r.outcome === "wrong") { wrong++; kb.wrong++; mb.wrong++; }
      else { partial++; kb.partial++; mb.partial++; }
      byKind.set(r.kind, kb);
      byModel.set(mKey, mb);
      if (typeof r.probability === "number" && (r.outcome === "correct" || r.outcome === "wrong")) {
        const actual = r.outcome === "correct" ? 1 : 0;
        brierSum += (r.probability - actual) ** 2;
        brierN++;
      }
    }
    const rate = (c: number, w: number) => (c + w > 0 ? c / (c + w) : null);
    const finish = (b: TrackRecordBucket) => ({ ...b, hitRate: rate(b.correct, b.wrong) });
    return {
      total: rows.length,
      open,
      resolved: correct + wrong + partial,
      correct,
      wrong,
      partial,
      hitRate: rate(correct, wrong),
      brier: brierN > 0 ? brierSum / brierN : null,
      brierN,
      byKind: Array.from(byKind.values()).map(finish).sort((a, b) => b.resolved - a.resolved),
      byModel: Array.from(byModel.values()).map(finish).sort((a, b) => b.resolved - a.resolved),
    };
  }

  async deleteImportedSeries(seriesId: string): Promise<number> {
    // Get count first so we can return it regardless of driver-specific result shape.
    const cnt: any = await (db as any).execute(
      sql`SELECT COUNT(*)::int AS c FROM imported_series WHERE series_id = ${seriesId}`,
    );
    const rows = cnt.rows ?? cnt;
    const before = Number(rows[0]?.c ?? 0);
    await (db as any).execute(
      sql`DELETE FROM imported_series WHERE series_id = ${seriesId}`,
    );
    return before;
  }
}

export const storage = new DatabaseStorage();
