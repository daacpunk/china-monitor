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
  scenarios,
  briefs,
  policyUpdates,
  houseView,
  strategyNotes,
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
} from "@shared/schema";
import { eq, desc, gte, and, sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Dual driver setup:
//   - If DATABASE_URL is set (Railway prod): use node-postgres
//   - Otherwise (sandbox dev): use PGlite embedded Postgres (file: ./data.pgdata)
// Both expose the same Drizzle query builder.
// ─────────────────────────────────────────────────────────────────────────────

type AnyDb = ReturnType<typeof makePgDb> | ReturnType<typeof makePgliteDb>;

function makePgDb(url: string) {
  // Lazy import so PGlite-only paths don't pull pg.
  const { Pool } = require("pg") as typeof import("pg");
  const { drizzle } = require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
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
  const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  const { drizzle } = require("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");
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
