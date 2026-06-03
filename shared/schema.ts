import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  jsonb,
  boolean,
  doublePrecision,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// API Keys — masked storage of CEIC / Sonar Pro / Anthropic / DeepSeek keys
// Keys are stored raw (Railway env or DB). User can re-paste anytime.
// ─────────────────────────────────────────────────────────────────────────────
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  service: text("service").notNull().unique(), // 'ceic' | 'sonar' | 'anthropic' | 'deepseek'
  apiKey: text("api_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastTestedAt: timestamp("last_tested_at"),
  testStatus: text("test_status"), // 'ok' | 'fail' | null
  testMessage: text("test_message"),
});

export const insertApiKeySchema = createInsertSchema(apiKeys).pick({
  service: true,
  apiKey: true,
});
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeys.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Settings — global key/value store (TTLs, default landing, theme)
// ─────────────────────────────────────────────────────────────────────────────
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  valueJson: jsonb("value_json").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSettingSchema = createInsertSchema(settings).pick({
  key: true,
  valueJson: true,
});
export type InsertSetting = z.infer<typeof insertSettingSchema>;
export type Setting = typeof settings.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Series cache — payloads from CEIC / Sonar with TTL
// ─────────────────────────────────────────────────────────────────────────────
export const seriesCache = pgTable(
  "series_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    payloadJson: jsonb("payload_json").notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    source: text("source").notNull(), // 'ceic' | 'sonar' | 'yahoo' | 'stooq' | 'free'
  },
  (t) => ({
    expiresIdx: index("series_cache_expires_idx").on(t.expiresAt),
  }),
);
export type SeriesCache = typeof seriesCache.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// API call log — every paid call gets a row. Drives audit trail.
// ─────────────────────────────────────────────────────────────────────────────
export const apiCallLog = pgTable(
  "api_call_log",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts").notNull().defaultNow(),
    service: text("service").notNull(), // 'ceic' | 'sonar' | 'anthropic' | 'deepseek'
    endpoint: text("endpoint").notNull(), // e.g. '/series', 'messages', 'chat/completions'
    actionContext: text("action_context"), // e.g. 'kshape_chart', 'fai_section', 'series_explorer'
    model: text("model"), // e.g. 'claude-sonnet-4', 'sonar-pro'
    tokensIn: integer("tokens_in").default(0),
    tokensOut: integer("tokens_out").default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    status: text("status").notNull(), // 'ok' | 'error' | 'blocked_by_ceiling'
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
  },
  (t) => ({
    tsIdx: index("api_call_log_ts_idx").on(t.ts),
    serviceIdx: index("api_call_log_service_idx").on(t.service),
    contextIdx: index("api_call_log_context_idx").on(t.actionContext),
  }),
);

export const insertApiCallLogSchema = createInsertSchema(apiCallLog).omit({
  id: true,
  ts: true,
});
export type InsertApiCallLog = z.infer<typeof insertApiCallLogSchema>;
export type ApiCallLog = typeof apiCallLog.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Cost ceilings — per-service monthly $ caps + CEIC call cap
// ─────────────────────────────────────────────────────────────────────────────
export const costCeilings = pgTable("cost_ceilings", {
  service: text("service").primaryKey(), // 'ceic' | 'sonar' | 'anthropic' | 'deepseek'
  monthlyLimitUsd: doublePrecision("monthly_limit_usd").notNull().default(20),
  currentMonthUsd: doublePrecision("current_month_usd").notNull().default(0),
  hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
  // CEIC-specific: monthly API call cap (raw call count, not $)
  monthlyCallCap: integer("monthly_call_cap"),
  currentMonthCalls: integer("current_month_calls").notNull().default(0),
  monthAnchor: text("month_anchor").notNull().default(""), // 'YYYY-MM' for rollover detection
});

export const insertCostCeilingSchema = createInsertSchema(costCeilings);
export type InsertCostCeiling = z.infer<typeof insertCostCeilingSchema>;
export type CostCeiling = typeof costCeilings.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Watchlists — Phase 3 (schema only in Phase 1)
// ─────────────────────────────────────────────────────────────────────────────
export const watchlists = pgTable("watchlists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  seriesIdsJson: jsonb("series_ids_json").notNull(), // string[]
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertWatchlistSchema = createInsertSchema(watchlists).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>;
export type Watchlist = typeof watchlists.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Chart configs — Phase 3 (schema only in Phase 1)
// ─────────────────────────────────────────────────────────────────────────────
export const chartConfigs = pgTable("chart_configs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  configJson: jsonb("config_json").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertChartConfigSchema = createInsertSchema(chartConfigs).omit({
  id: true,
  createdAt: true,
});
export type InsertChartConfig = z.infer<typeof insertChartConfigSchema>;
export type ChartConfig = typeof chartConfigs.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// View state — theme, last section, sidebar collapse, etc.
// Persisted server-side (no localStorage in sandbox)
// ─────────────────────────────────────────────────────────────────────────────
export const viewState = pgTable("view_state", {
  key: text("key").primaryKey(),
  valueJson: jsonb("value_json").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertViewStateSchema = createInsertSchema(viewState).pick({
  key: true,
  valueJson: true,
});
export type InsertViewState = z.infer<typeof insertViewStateSchema>;
export type ViewState = typeof viewState.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Imported series — user-uploaded data (FactSet workstation CSV/XLSX exports,
// Bloomberg saves, manual entries). One row per (seriesId, date) point.
// Composite primary key (series_id, date) enables idempotent upserts.
// ─────────────────────────────────────────────────────────────────────────────
export const importedSeries = pgTable(
  "imported_series",
  {
    seriesId: text("series_id").notNull(),
    seriesLabel: text("series_label").notNull(),
    date: text("date").notNull(), // ISO YYYY-MM-DD; stored as text for simplicity
    value: doublePrecision("value").notNull(),
    sourceMnemonic: text("source_mnemonic"), // e.g. FactSet identifier
    unit: text("unit"),
    frequency: text("frequency"), // 'M' | 'Q' | 'A' | 'D' | 'W'
    importedAt: timestamp("imported_at").notNull().defaultNow(),
    sourceName: text("source_name").notNull().default("factset"), // 'factset' | 'bloomberg' | 'manual'
  },
  (t) => ({
    pk: primaryKey({ columns: [t.seriesId, t.date] }),
    seriesIdx: index("imported_series_id_idx").on(t.seriesId),
  }),
);
export const insertImportedSeriesSchema = createInsertSchema(importedSeries).omit({
  importedAt: true,
});
export type InsertImportedSeries = z.infer<typeof insertImportedSeriesSchema>;
export type ImportedSeries = typeof importedSeries.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios — Phase 3b. Single base + bull + bear, 1Q forward. Each scenario
// gets one row per generation; the latest row for a target_quarter is canonical.
// hitRateJson is populated when the target quarter resolves (post-hoc scoring).
// ─────────────────────────────────────────────────────────────────────────────
export const scenarios = pgTable(
  "scenarios",
  {
    id: serial("id").primaryKey(),
    generatedAt: timestamp("generated_at").notNull().defaultNow(),
    targetQuarter: text("target_quarter").notNull(), // 'YYYY-Qn'
    baseCase: jsonb("base_case").notNull(),          // { narrative, drivers: {ppi:{value, dir}, ...}, equityCalls: {csi300:{level,reasoning}, ...} }
    bullCase: jsonb("bull_case").notNull(),
    bearCase: jsonb("bear_case").notNull(),
    baseProb: doublePrecision("base_prob").notNull().default(0.5),
    bullProb: doublePrecision("bull_prob").notNull().default(0.25),
    bearProb: doublePrecision("bear_prob").notNull().default(0.25),
    inputsJson: jsonb("inputs_json").notNull(),      // snapshot of trends/anomalies fed to LLM
    model: text("model").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    userEdited: boolean("user_edited").notNull().default(false),
    hitRateJson: jsonb("hit_rate_json"),             // null until quarter resolves
  },
  (t) => ({
    quarterIdx: index("scenarios_quarter_idx").on(t.targetQuarter),
    generatedIdx: index("scenarios_generated_idx").on(t.generatedAt),
  }),
);

export const insertScenarioSchema = createInsertSchema(scenarios).omit({
  id: true,
  generatedAt: true,
});
export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type Scenario = typeof scenarios.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────
// Briefs — Phase 3b Session 4. Deep-dive market write-up synthesizing platform data.
// One row per generation. `sections` holds 6 nested narrative blocks; `execSummary`
// is the one-paragraph hero. `userNotes` is editable post-hoc by the analyst.
// ─────────────────────────────────────────────────────────────────────────
export const briefs = pgTable(
  "briefs",
  {
    id: serial("id").primaryKey(),
    generatedAt: timestamp("generated_at").notNull().defaultNow(),
    asOfDate: text("as_of_date").notNull(),       // ISO YYYY-MM-DD snapshot date
    execSummary: text("exec_summary").notNull().default(""),
    sections: jsonb("sections").notNull(),        // { what_happened, regime_shifts, cross_asset, priced_vs_not, forward_watch, trade_implications }
    inputsJson: jsonb("inputs_json").notNull(),   // snapshot fed to LLM (drivers, cross-asset, trends, attribution, calendar)
    model: text("model").notNull(),               // 'claude-sonnet-4' | 'claude-haiku-4' | etc.
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    userNotes: text("user_notes").notNull().default(""),
  },
  (t) => ({
    generatedIdx: index("briefs_generated_idx").on(t.generatedAt),
  }),
);

export const insertBriefSchema = createInsertSchema(briefs).omit({
  id: true,
  generatedAt: true,
});
export type InsertBrief = z.infer<typeof insertBriefSchema>;
export type Brief = typeof briefs.$inferSelect;
