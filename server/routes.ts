import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage } from "./storage";
import {
  insertApiKeySchema,
  insertSettingSchema,
  insertCostCeilingSchema,
  insertViewStateSchema,
} from "@shared/schema";
import { checkCeiling, recordCall, currentYearMonth, SERVICES, type Service } from "./costTracker";
import { z } from "zod";
import { fetchSeries } from "./series/fetchSeries";
import { listRegistry } from "./series/registry";
import { searchSeries } from "./clients/ceic";
import { getUpcomingReleases, getAllReleases } from "./clients/calendar";
import { resolveApiKey } from "./keyResolver";
import { POLICY_CHANNELS, COVERAGE_THEMES, TECH_CHANNEL_IDS } from "./policy/channels";
import { scanChannels, EQUITY_TARGETS } from "./policy/service";
import { PERSONAS, PERSONAS_BY_ID, DEFAULT_REDTEAM_PANEL } from "@shared/personas";
import { buildLensPrompt, buildRedTeamPrompt } from "./analysis/personas";
import { SECTOR_UNIVERSE, THEMES_BY_ID } from "./equity/universe";
import { getAkshareValuation } from "./clients/akshare";
import { querySonar, parseJsonArray } from "./clients/sonar";
import { registerReportRoutes } from "./report/routes";

/**
 * Mask an API key for display: show last 4 chars, mask the rest.
 */
function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return "•".repeat(key.length - 4) + key.slice(-4);
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // ───────────────────────────────────────────────────────────────────────────
  // Health
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // API Keys
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/keys", async (_req, res) => {
    const rows = await storage.listApiKeys();
    res.json(
      rows.map((k) => ({
        service: k.service,
        masked: maskKey(k.apiKey),
        lastTestedAt: k.lastTestedAt,
        testStatus: k.testStatus,
        testMessage: k.testMessage,
      })),
    );
  });

  app.post("/api/keys", async (req, res) => {
    try {
      const body = insertApiKeySchema.parse(req.body);
      if (!SERVICES.includes(body.service as Service)) {
        return res.status(400).json({ message: `Unknown service: ${body.service}` });
      }
      const row = await storage.upsertApiKey(body);
      res.json({
        service: row.service,
        masked: maskKey(row.apiKey),
        lastTestedAt: row.lastTestedAt,
        testStatus: row.testStatus,
      });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  app.delete("/api/keys/:service", async (req, res) => {
    await storage.deleteApiKey(req.params.service);
    res.json({ ok: true });
  });

  app.post("/api/keys/:service/test", async (req, res) => {
    const service = req.params.service as Service;
    const row = await storage.getApiKey(service);
    if (!row) {
      await storage.updateApiKeyTestResult(service, "fail", "No key saved");
      return res.json({ status: "fail", message: "No key saved" });
    }
    // Phase 1: stubbed test — checks length only. Phase 2 will actually call
    // the upstream endpoint. We deliberately do NOT spend budget testing keys.
    if (row.apiKey.length < 10) {
      await storage.updateApiKeyTestResult(service, "fail", "Key looks too short");
      return res.json({ status: "fail", message: "Key looks too short" });
    }
    await storage.updateApiKeyTestResult(service, "ok", "Stored (live test wired in Phase 2)");
    res.json({ status: "ok", message: "Stored (live test wired in Phase 2)" });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Settings (TTLs, theme, etc.) — generic key/value
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/settings", async (_req, res) => {
    const rows = await storage.listSettings();
    res.json(rows);
  });

  app.get("/api/settings/:key", async (req, res) => {
    const row = await storage.getSetting(req.params.key);
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const body = insertSettingSchema.parse(req.body);
      const row = await storage.setSetting(body);
      res.json(row);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // View state (theme, last section, sidebar collapse)
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/view-state/:key", async (req, res) => {
    const row = await storage.getViewState(req.params.key);
    if (!row) return res.json({ key: req.params.key, valueJson: null });
    res.json(row);
  });

  app.post("/api/view-state", async (req, res) => {
    try {
      const body = insertViewStateSchema.parse(req.body);
      const row = await storage.setViewState(body);
      res.json(row);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cost ceilings
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/ceilings", async (_req, res) => {
    const rows = await storage.listCeilings();
    res.json(rows);
  });

  app.post("/api/ceilings", async (req, res) => {
    try {
      const body = insertCostCeilingSchema.parse(req.body);
      const row = await storage.upsertCeiling(body);
      res.json(row);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  app.post("/api/ceilings/:service/bump", async (req, res) => {
    const delta = Number(req.body?.deltaUsd ?? 20);
    if (!Number.isFinite(delta) || delta <= 0) {
      return res.status(400).json({ message: "deltaUsd must be a positive number" });
    }
    const row = await storage.bumpLimit(req.params.service, delta);
    res.json(row);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Audit trail
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/audit/log", async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 2000);
    const service = req.query.service ? String(req.query.service) : undefined;
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const rows = await storage.listApiCalls(limit, since, service);
    res.json(rows);
  });

  app.get("/api/audit/summary", async (req, res) => {
    const yearMonth = req.query.month ? String(req.query.month) : currentYearMonth();
    const [byService, byContext, ceilings] = await Promise.all([
      storage.getMonthlyCostByService(yearMonth),
      storage.getMonthlyCostByContext(yearMonth),
      storage.listCeilings(),
    ]);
    // Forecast: simple linear extrapolation of MTD spend → end of month.
    const now = new Date();
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
    const forecast = byService.map((s) => ({
      service: s.service,
      mtdSpend: s.total,
      mtdCalls: s.calls,
      projectedSpend: dayOfMonth > 0 ? (s.total / dayOfMonth) * daysInMonth : 0,
    }));
    res.json({ yearMonth, byService, byContext, ceilings, forecast });
  });

  app.get("/api/audit/log.csv", async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? "5000"), 10) || 5000, 50000);
    const rows = await storage.listApiCalls(limit);
    const header = [
      "ts",
      "service",
      "endpoint",
      "action_context",
      "model",
      "tokens_in",
      "tokens_out",
      "cost_usd",
      "status",
      "latency_ms",
      "error_message",
    ];
    const escape = (v: any) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes('"') || s.includes(",") || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const lines = [
      header.join(","),
      ...rows.map((r) =>
        [
          r.ts instanceof Date ? r.ts.toISOString() : r.ts,
          r.service,
          r.endpoint,
          r.actionContext,
          r.model,
          r.tokensIn,
          r.tokensOut,
          r.costUsd,
          r.status,
          r.latencyMs,
          r.errorMessage,
        ]
          .map(escape)
          .join(","),
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${currentYearMonth()}.csv"`);
    res.send(lines.join("\n"));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CEIC proxy — legacy POST stub kept for Settings page compatibility
  // ───────────────────────────────────────────────────────────────────────────
  const ceicQuerySchema = z.object({
    seriesId: z.string().optional(),
    seriesName: z.string().optional(),
    actionContext: z.string().optional(),
  });

  app.post("/api/ceic/series", async (req, res) => {
    try {
      const params = ceicQuerySchema.parse(req.body);
      const guard = await checkCeiling("ceic");
      if (!guard.allowed) {
        await recordCall({
          service: "ceic",
          endpoint: "/series",
          actionContext: params.actionContext ?? null,
          costUsd: 0,
          status: "blocked_by_ceiling",
          errorMessage: guard.reason,
        });
        return res.status(429).json({ error: "ceiling_reached", message: guard.reason });
      }
      res.json({
        stub: false,
        message: "Use GET /api/ceic/search?q=... for live CEIC search",
        request: params,
        watchlistAvailable: true,
      });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2: Series registry + unified data fetch
  // ───────────────────────────────────────────────────────────────────────────

  /** GET /api/series — list all registry entries */
  app.get("/api/series", (_req, res) => {
    try {
      const list = listRegistry();
      res.json(list);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  /** GET /api/series/:logicalId — unified fetch via fetchSeries */
  app.get("/api/series/:logicalId", async (req, res) => {
    try {
      const logicalId = req.params.logicalId;
      const count = req.query.count ? parseInt(String(req.query.count), 10) : undefined;
      const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
      const result = await fetchSeries(logicalId, { count, startDate });
      res.json({ logicalId, ...result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2: Release calendar
  // ───────────────────────────────────────────────────────────────────────────

  /** GET /api/calendar/upcoming?days=30 */
  app.get("/api/calendar/upcoming", (req, res) => {
    try {
      const days = req.query.days ? parseInt(String(req.query.days), 10) : 30;
      const releases = getUpcomingReleases(days);
      res.json({ days, count: releases.length, releases });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  /** GET /api/calendar/all */
  app.get("/api/calendar/all", (_req, res) => {
    try {
      const releases = getAllReleases();
      res.json({ count: releases.length, releases });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2: CEIC search proxy (for Settings page test + future Series Explorer)
  // ───────────────────────────────────────────────────────────────────────────

  /** GET /api/ceic/search?q=GDP&country=CN&limit=20 */
  app.get("/api/ceic/search", async (req, res) => {
    try {
      const q = String(req.query.q ?? "");
      const country = req.query.country ? String(req.query.country) : "CN";
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;

      const result = await searchSeries({ keyword: q, country, limit });

      if ("error" in result) {
        return res.status(429).json(result);
      }

      res.json({ total: result.length, items: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  /** GET /api/ceic/health — CEIC subscription status */
  app.get("/api/ceic/health", async (_req, res) => {
    try {
      const key = await resolveApiKey("ceic");
      const keyConfigured = !!key;

      // Check last test result from DB
      const keyRow = await storage.getApiKey("ceic");
      const lastTestStatus = keyRow?.testStatus ?? null;

      // Count subscribed series from search cache — quick heuristic
      res.json({
        keyConfigured,
        lastTestStatus,
        subscribedSeriesCount: 0, // Phase 2: no subscriptions on current key
        message: keyConfigured
          ? "CEIC key configured. Current key has no data subscriptions — search/metadata available."
          : "No CEIC key configured. Add key in Settings > API Keys.",
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2: Cache management
  // ───────────────────────────────────────────────────────────────────────────

  /** POST /api/cache/clear — flush all cached series */
  app.post("/api/cache/clear", async (_req, res) => {
    try {
      // We clear all expired AND we manually delete all series cache entries
      // by expiring everything (set expires_at to NOW() for all rows).
      const { sql } = await import("drizzle-orm");
      const { db } = await import("./storage");
      await (db as any).execute(sql.raw("DELETE FROM series_cache"));
      res.json({ ok: true, message: "All cached series cleared" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  /** GET /api/fred/health — FRED API key status and connectivity test */
  app.get("/api/fred/health", async (_req, res) => {
    try {
      const { checkFredHealth } = await import("./clients/fred");
      const result = await checkFredHealth();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, keyConfigured: false, message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Watchlists (P3 — schema only, list/create/delete enabled)
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/watchlists", async (_req, res) => {
    res.json(await storage.listWatchlists());
  });

  // ───────────────────────────────────────────────────────────────────────────
  // EastMoney public data endpoints (no auth required)
  // Cache-Control: public, max-age=900 (15 min — equity data refreshes intraday)
  // ───────────────────────────────────────────────────────────────────────────

  const emCache = "public, max-age=900";

  /** GET /api/eastmoney/health — connectivity check */
  app.get("/api/eastmoney/health", (_req, res) => {
    res.setHeader("Cache-Control", emCache);
    res.json({ status: "ok", endpoints: 4 });
  });

  /** GET /api/eastmoney/connect — Stock Connect northbound flow */
  app.get("/api/eastmoney/connect", async (_req, res) => {
    try {
      const { getStockConnectFlow } = await import("./clients/eastmoney");
      const result = await getStockConnectFlow();
      res.setHeader("Cache-Control", emCache);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ source: "eastmoney", series: [], error: err.message });
    }
  });

  /** GET /api/eastmoney/margin — Margin balance (融资融券余额) */
  app.get("/api/eastmoney/margin", async (_req, res) => {
    try {
      const { getMarginBalance } = await import("./clients/eastmoney");
      const result = await getMarginBalance();
      res.setHeader("Cache-Control", emCache);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ source: "eastmoney", series: [], error: err.message });
    }
  });

  /** GET /api/eastmoney/sectors — Shenwan L1 sector rotation snapshot */
  app.get("/api/eastmoney/sectors", async (_req, res) => {
    try {
      const { getSectorPerformance } = await import("./clients/eastmoney");
      const result = await getSectorPerformance();
      res.setHeader("Cache-Control", emCache);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ source: "eastmoney", series: [], error: err.message });
    }
  });

  /** GET /api/eastmoney/kline/:secid?beg=YYYYMMDD&end=YYYYMMDD — Index OHLCV kline */
  app.get("/api/eastmoney/kline/:secid", async (req, res) => {
    try {
      const { getEastMoneyKline } = await import("./clients/eastmoney");
      const secid = req.params.secid;
      const beg = req.query.beg ? String(req.query.beg) : undefined;
      const end = req.query.end ? String(req.query.end) : undefined;
      const result = await getEastMoneyKline(secid, beg, end);
      res.setHeader("Cache-Control", emCache);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ source: "eastmoney", series: [], error: err.message });
    }
  });

  // ─── HKEX (Phase 2.5) ──────────────────────────────────────────────────
  /** GET /api/hkex/stock-connect/monthly — 13 rolling months of NB/SB ADT */
  app.get("/api/hkex/stock-connect/monthly", async (_req, res) => {
    try {
      const { getStockConnectMonthlyAdt } = await import("./clients/hkex");
      const result = await getStockConnectMonthlyAdt();
      // Monthly data — 6h cache TTL is plenty
      res.setHeader("Cache-Control", "public, max-age=21600");
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ source: "hkex", series: [], error: err.message });
    }
  });

  // ─── AKShare (Phase 2.5 — Python sidecar) ──────────────────────────────
  // All AKShare calls proxy through the akshare-sidecar service over the
  // Railway internal network. Cache TTL on the sidecar side is 24h, so we
  // mirror that here for browser caching on most endpoints.
  const akCache = "public, max-age=86400"; // 24h

  /** GET /api/akshare/health — debug: confirm sidecar is reachable + auth ok */
  app.get("/api/akshare/health", async (_req, res) => {
    try {
      const { getAkshareHealth } = await import("./clients/akshare");
      const result = await getAkshareHealth();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** GET /api/akshare/ashare?symbol=600519&start=2020-01-01&adjust=qfq */
  app.get("/api/akshare/ashare", async (req, res) => {
    try {
      const Q = z.object({
        symbol: z.string().regex(/^\d{6}$/),
        start: z.string().optional(),
        end: z.string().optional(),
        adjust: z.enum(["", "qfq", "hfq"]).optional(),
      });
      const q = Q.parse(req.query);
      const { getAshareHistorical } = await import("./clients/akshare");
      const result = await getAshareHistorical(q);
      res.setHeader("Cache-Control", akCache);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ source: "akshare", data: [], error: err.message });
    }
  });

  /** GET /api/akshare/hk?symbol=00700&start=2020-01-01&adjust=qfq */
  app.get("/api/akshare/hk", async (req, res) => {
    try {
      const Q = z.object({
        symbol: z.string().regex(/^\d{5}$/),
        start: z.string().optional(),
        end: z.string().optional(),
        adjust: z.enum(["", "qfq", "hfq"]).optional(),
      });
      const q = Q.parse(req.query);
      const { getHkHistorical } = await import("./clients/akshare");
      const result = await getHkHistorical(q);
      res.setHeader("Cache-Control", akCache);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ source: "akshare", data: [], error: err.message });
    }
  });

  /** GET /api/akshare/index?symbol=sz399006&start=2021-01-01&period=monthly */
  app.get("/api/akshare/index", async (req, res) => {
    try {
      const Q = z.object({
        symbol: z.string().min(3).max(16),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        period: z.enum(["daily", "weekly", "monthly"]).optional(),
      });
      const q = Q.parse(req.query);
      const { getAkshareIndexHistorical } = await import("./clients/akshare");
      const result = await getAkshareIndexHistorical(q);
      res.setHeader("Cache-Control", akCache);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ source: "akshare", data: [], error: err.message });
    }
  });

  /** GET /api/akshare/sectors?indicator=今日 */
  app.get("/api/akshare/sectors", async (req, res) => {
    try {
      const Q = z.object({ indicator: z.enum(["今日", "5日", "10日"]).optional() });
      const q = Q.parse(req.query);
      const { getAkshareSectorFlows } = await import("./clients/akshare");
      const result = await getAkshareSectorFlows(q.indicator);
      res.setHeader("Cache-Control", "public, max-age=3600"); // 1h, intraday
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ source: "akshare", data: [], error: err.message });
    }
  });

  /** GET /api/akshare/income?symbol=600519 — annual income statement */
  app.get("/api/akshare/income", async (req, res) => {
    try {
      const Q = z.object({ symbol: z.string().regex(/^\d{6}$/) });
      const q = Q.parse(req.query);
      const { getAkshareIncome } = await import("./clients/akshare");
      const result = await getAkshareIncome(q.symbol);
      res.setHeader("Cache-Control", akCache);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ source: "akshare", data: [], error: err.message });
    }
  });

  // ─── Analysis (Phase 3a) ───────────────────────────────────────────────
  // Cross-source comparison, anomaly detection, and LLM commentary.

  /** POST /api/analysis/compare
   *  Body: { ids: string[]; startDate?: string }
   *  Returns aligned series + Pearson correlation matrix.
   */
  app.post("/api/analysis/compare", async (req, res) => {
    try {
      const Body = z.object({
        ids: z.array(z.string().min(1)).min(2).max(8),
        startDate: z.string().optional(),
      });
      const body = Body.parse(req.body);

      const { fetchSeries } = await import("./series/fetchSeries");
      const { alignSeries, correlationMatrix } = await import("./analysis/stats");

      const results = await Promise.all(
        body.ids.map(async (id) => {
          const r = await fetchSeries(id, { startDate: body.startDate });
          return { id, points: r.data, provenance: r.provenance };
        }),
      );

      const aligned = alignSeries(results.map(({ id, points }) => ({ id, points })));
      const matrix = correlationMatrix(body.ids, aligned.values);

      res.json({
        ids: body.ids,
        dates: aligned.dates,
        values: aligned.values,
        correlationMatrix: matrix,
        provenance: Object.fromEntries(results.map((r) => [r.id, r.provenance])),
        commonPoints: aligned.dates.length,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /api/analysis/anomalies
   *  Body: { ids: string[]; windowSize?: number }
   *  Returns z-score severity flags for the latest print of each series.
   */
  app.post("/api/analysis/anomalies", async (req, res) => {
    try {
      const Body = z.object({
        ids: z.array(z.string().min(1)).min(1).max(40),
        windowSize: z.number().int().positive().max(120).optional(),
      });
      const body = Body.parse(req.body);

      const { fetchSeries } = await import("./series/fetchSeries");
      const { detectAnomaly, pctChange } = await import("./analysis/stats");

      const results = await Promise.all(
        body.ids.map(async (id) => {
          const r = await fetchSeries(id);
          const anomaly = detectAnomaly(r.data, body.windowSize ?? 24);
          return {
            id,
            anomaly,
            momLagPct: pctChange(r.data, 1),
            yoyLagPct: pctChange(r.data, 12),
            provenance: r.provenance,
          };
        }),
      );

      res.json({ results });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /api/analysis/commentary
   *  Body: { logicalId: string; model?: LlmModel; question?: string }
   *  Returns analyst-style commentary. Cached + cost-tracked.
   */
  app.post("/api/analysis/commentary", async (req, res) => {
    try {
      const Body = z.object({
        logicalId: z.string().min(1),
        model: z
          .enum(["claude-sonnet-4", "claude-haiku-4", "deepseek-chat", "deepseek-reasoner"])
          .optional(),
        question: z.string().max(500).optional(),
        contextIds: z.array(z.string()).max(4).optional(),
      });
      const body = Body.parse(req.body);
      const model = body.model ?? "claude-sonnet-4";

      const { fetchSeries } = await import("./series/fetchSeries");
      const { detectAnomaly, pctChange, cleanSeries } = await import("./analysis/stats");
      const { generateCommentary } = await import("./analysis/llm");
      const { getEntry } = await import("./series/registry");

      const primary = await fetchSeries(body.logicalId);
      const entry = getEntry(body.logicalId);
      const cleaned = cleanSeries(primary.data);
      if (cleaned.length === 0) {
        return res.status(404).json({ error: `No data available for ${body.logicalId}` });
      }
      const tail = cleaned.slice(-24); // last 24 obs (2y monthly)
      const anomaly = detectAnomaly(primary.data);
      const mom = pctChange(primary.data, 1);
      const yoy = pctChange(primary.data, 12);

      // Context series (optional)
      let contextBlocks = "";
      if (body.contextIds && body.contextIds.length > 0) {
        const contexts = await Promise.all(body.contextIds.map(async (cid) => {
          const r = await fetchSeries(cid);
          const cleanedC = cleanSeries(r.data).slice(-12);
          return `### ${cid}\n${cleanedC.map((p) => `${p.date}: ${p.value}`).join("\n")}`;
        }));
        contextBlocks = `\n\n## Related series for context\n${contexts.join("\n\n")}`;
      }

      const seriesLabel = entry?.label ?? body.logicalId;
      const unit = entry?.unit ?? "";
      const category = entry?.category ?? "unknown";

      const systemPrompt =
        "You are a senior macro analyst covering China for an institutional investor. " +
        "You write concise, fact-grounded commentary in the style of a buy-side morning note. " +
        "You NEVER invent numbers \u2014 only refer to data shown in the prompt. " +
        "You highlight inflection points, surprises vs trend, and key risks. " +
        "You write in clear English with one summary sentence followed by 3-4 short bullets. " +
        "Avoid jargon when a plain word will do. Do not editorialise.";

      const userPrompt = [
        `# Series: ${seriesLabel} (id: \`${body.logicalId}\`)`,
        `Category: ${category}`,
        `Unit: ${unit || "unknown"}`,
        `Source: ${primary.provenance.source}`,
        ``,
        `## Latest 24 observations`,
        tail.map((p) => `${p.date}: ${p.value}`).join("\n"),
        ``,
        `## Computed deltas`,
        `- Latest: ${cleaned[cleaned.length - 1].value} on ${cleaned[cleaned.length - 1].date}`,
        `- 1-period change: ${mom != null ? mom.toFixed(2) + "%" : "n/a"}`,
        `- 12-period change: ${yoy != null ? yoy.toFixed(2) + "%" : "n/a"}`,
        anomaly
          ? `- Z-score vs trailing ${anomaly.windowSize}: ${anomaly.zScore.toFixed(2)} (${anomaly.severity})`
          : `- Z-score: n/a (insufficient history)`,
        contextBlocks,
        ``,
        body.question
          ? `## Specific question from analyst\n${body.question}`
          : `## Task\nProvide commentary on the latest print. What is it telling us? What should we watch next?`,
      ].join("\n");

      const result = await generateCommentary({
        model,
        systemPrompt,
        userPrompt,
        actionContext: `commentary:${body.logicalId}`,
        maxOutputTokens: 800,
      });

      res.json({
        logicalId: body.logicalId,
        label: seriesLabel,
        commentary: result.text,
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
        cacheHit: result.cacheHit,
        fetchedAt: result.fetchedAt,
        latestObservation: cleaned[cleaned.length - 1],
        mom,
        yoy,
        anomaly,
      });
    } catch (err: any) {
      const msg = err.message || String(err);
      const status =
        msg.includes("Blocked by cost ceiling") ? 429 :
        msg.includes("No API key") ? 412 :
        500;
      res.status(status).json({ error: msg });
    }
  });

  // ─── Imports / FactSet (Phase 2.5) ─────────────────────────────────────
  // The user has FactSet workstation but no API access, so we accept pasted
  // or uploaded CSV text and store the points in the `imported_series` table.
  // Once imported, series flow through the normal /api/series/:logicalId path
  // when `logicalId` begins with `imported:` (handled in fetchSeries).

  /**
   * POST /api/imports/factset
   * Body: { text: string, sourceName?: "factset" | "bloomberg" | "manual", dryRun?: boolean }
   * Returns: { ok, format, delimiter, seriesIds, rowCount, warnings, sample[] }
   *          plus { inserted } when not dryRun.
   */
  app.post("/api/imports/factset", async (req, res) => {
    try {
      const Body = z.object({
        text: z.string().min(1),
        sourceName: z.enum(["factset", "bloomberg", "manual"]).default("factset"),
        dryRun: z.boolean().default(false),
      });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: parsed.error.message });
      }
      const { parseFactsetCsv } = await import("./clients/factsetImport");
      const result = parseFactsetCsv(parsed.data.text, { sourceName: parsed.data.sourceName });
      if (!result.ok) {
        return res.status(400).json(result);
      }
      const sample = result.rows.slice(0, 5);
      if (parsed.data.dryRun) {
        return res.json({
          ok: true,
          dryRun: true,
          format: result.format,
          delimiter: result.delimiter,
          seriesIds: result.seriesIds,
          rowCount: result.rows.length,
          warnings: result.warnings,
          sample,
        });
      }
      const inserted = await storage.upsertImportedSeriesBatch(result.rows);
      res.json({
        ok: true,
        format: result.format,
        delimiter: result.delimiter,
        seriesIds: result.seriesIds,
        rowCount: result.rows.length,
        inserted,
        warnings: result.warnings,
        sample,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** GET /api/imports/series — list all imported series ids with metadata */
  app.get("/api/imports/series", async (_req, res) => {
    try {
      const list = await storage.listImportedSeriesIds();
      res.json({ ok: true, series: list });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** GET /api/imports/series/:seriesId — full point series, newest first */
  app.get("/api/imports/series/:seriesId", async (req, res) => {
    try {
      const rows = await storage.getImportedSeries(req.params.seriesId);
      if (!rows.length) return res.status(404).json({ ok: false, error: "Series not found" });
      res.json({
        ok: true,
        seriesId: req.params.seriesId,
        seriesLabel: rows[0].seriesLabel,
        unit: rows[0].unit,
        frequency: rows[0].frequency,
        sourceName: rows[0].sourceName,
        sourceMnemonic: rows[0].sourceMnemonic,
        points: rows.map((r) => ({ date: r.date, value: Number(r.value) })),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** DELETE /api/imports/series/:seriesId — remove all points for one series */
  app.delete("/api/imports/series/:seriesId", async (req, res) => {
    try {
      const n = await storage.deleteImportedSeries(req.params.seriesId);
      res.json({ ok: true, deleted: n });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** GET /api/imports/template.csv — sample CSV template download */
  app.get("/api/imports/template.csv", async (_req, res) => {
    const { FACTSET_LONG_TEMPLATE_CSV } = await import("./clients/factsetImport");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="factset_import_template.csv"',
    );
    res.send(FACTSET_LONG_TEMPLATE_CSV);
  });

  // ─── Trends (Phase 3b) ─────────────────────────────────────────
  /** POST /api/trends/detect
   *  Body: { ids: string[]; windows?: [3,6,12]; regimeWindow?: number }
   *  Returns per-series trend results + cross-source confirmation summary.
   */
  app.post("/api/trends/detect", async (req, res) => {
    try {
      const Body = z.object({
        ids: z.array(z.string().min(1)).min(1).max(40),
        windows: z.tuple([z.number().int().positive(), z.number().int().positive(), z.number().int().positive()]).optional(),
        regimeWindow: z.number().int().positive().max(120).optional(),
      });
      const body = Body.parse(req.body);
      const { fetchSeries } = await import("./series/fetchSeries");
      const { detectTrend, crossSourceConfirmation } = await import("./analysis/trends");
      const results = await Promise.all(body.ids.map(async (id) => {
        const r = await fetchSeries(id);
        return detectTrend(id, r.data, { windows: body.windows, regimeWindow: body.regimeWindow });
      }));
      const summary = crossSourceConfirmation(results);
      res.json({ results, summary });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Attribution (Phase 3b) ─────────────────────────────────────
  /** POST /api/attribution/macro-to-equity
   *  Body: { drivers?: string[]; equities?: string[]; pairs?: Array<{driver,equity}> }
   *  If pairs is omitted, uses curated SECTOR_MAPPING (filtered to A-share + HK).
   *  Returns per-pair rolling betas + lead/lag + 'not yet priced' flags.
   */
  app.post("/api/attribution/macro-to-equity", async (req, res) => {
    try {
      const Body = z.object({
        pairs: z.array(z.object({ driver: z.string(), equity: z.string() })).max(40).optional(),
      });
      const body = Body.parse(req.body);
      const { fetchSeries } = await import("./series/fetchSeries");
      const { SECTOR_MAPPING, computePair, inferDriverKind, EQUITY_UNIVERSE } = await import("./analysis/attribution");

      // Build the list of pairs to compute
      const requestedPairs = body.pairs && body.pairs.length > 0
        ? body.pairs.map((p) => {
            const found = SECTOR_MAPPING.find((m) => m.driver === p.driver && m.equityTarget === p.equity);
            return found ?? {
              driver: p.driver,
              driverLabel: p.driver,
              equityTarget: p.equity,
              equityLabel: p.equity,
              expectedSign: 1 as const,
              thesis: "User-specified pair.",
            };
          })
        : SECTOR_MAPPING;

      // Fetch unique series only once
      const uniqueIds = new Set<string>();
      for (const p of requestedPairs) {
        uniqueIds.add(p.driver);
        uniqueIds.add(p.equityTarget);
      }
      const cache = new Map<string, Awaited<ReturnType<typeof fetchSeries>>>();
      await Promise.all(Array.from(uniqueIds).map(async (id) => {
        cache.set(id, await fetchSeries(id));
      }));

      const pairs: NonNullable<ReturnType<typeof computePair>>[] = [];
      const skipped: Array<{ driver: string; equity: string; reason: string }> = [];
      for (const p of requestedPairs) {
        const d = cache.get(p.driver);
        const e = cache.get(p.equityTarget);
        if (!d || !e) {
          skipped.push({ driver: p.driver, equity: p.equityTarget, reason: "fetch returned no data" });
          continue;
        }
        const pair = computePair(p, d.data, inferDriverKind(p.driver), e.data);
        if (!pair) {
          skipped.push({ driver: p.driver, equity: p.equityTarget, reason: "<6 aligned observations" });
          continue;
        }
        pairs.push(pair);
      }

      const notPriced = pairs.filter((p) => p.notPriced.triggered);
      res.json({ pairs, notPriced, skipped, universe: EQUITY_UNIVERSE });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Scenarios (Phase 3b) ───────────────────────────────────────
  /** POST /api/scenarios/generate
   *  Body: { model?: LlmModel; drivers?: string[]; equities?: string[]; targetQuarter?: string }
   *  Generates a base/bull/bear scenario, persists it, returns the row.
   */
  app.post("/api/scenarios/generate", async (req, res) => {
    try {
      const Body = z.object({
        model: z.enum(["claude-sonnet-4", "claude-haiku-4", "deepseek-chat", "deepseek-reasoner"]).optional(),
        drivers: z.array(z.string()).optional(),
        equities: z.array(z.string()).optional(),
        targetQuarter: z.string().regex(/^\d{4}-Q[1-4]$/).optional(),
      });
      const body = Body.parse(req.body);
      const { generateScenario } = await import("./analysis/scenarios");
      const result = await generateScenario(body);
      const row = await storage.createScenario({
        targetQuarter: result.output.targetQuarter,
        baseCase: result.output.base as any,
        bullCase: result.output.bull as any,
        bearCase: result.output.bear as any,
        baseProb: result.output.baseProb,
        bullProb: result.output.bullProb,
        bearProb: result.output.bearProb,
        inputsJson: result.inputs as any,
        model: result.model,
        costUsd: result.costUsd,
        userEdited: false,
        hitRateJson: null,
      });
      res.json({ scenario: row, costUsd: result.costUsd, cacheHit: result.cacheHit, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
    } catch (err: any) {
      const msg = err.message || String(err);
      const status = msg.includes("Blocked by cost ceiling") ? 429 : msg.includes("No API key") ? 412 : 500;
      res.status(status).json({ error: msg });
    }
  });

  /** GET /api/scenarios — list recent scenarios */
  app.get("/api/scenarios", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const list = await storage.listScenarios(limit);
      res.json({ scenarios: list });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/scenarios/latest?quarter=YYYY-Qn */
  app.get("/api/scenarios/latest", async (req, res) => {
    try {
      const { nextQuarter } = await import("./analysis/scenarios");
      const q = (req.query.quarter as string) || nextQuarter();
      const s = await storage.getLatestScenarioForQuarter(q);
      if (!s) return res.status(404).json({ error: `No scenario for ${q}` });
      res.json({ scenario: s });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** PATCH /api/scenarios/:id — user edits to cases or probability weights */
  app.patch("/api/scenarios/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const Body = z.object({
        baseCase: z.any().optional(),
        bullCase: z.any().optional(),
        bearCase: z.any().optional(),
        baseProb: z.number().min(0).max(1).optional(),
        bullProb: z.number().min(0).max(1).optional(),
        bearProb: z.number().min(0).max(1).optional(),
      });
      const patch = Body.parse(req.body);
      const updated = await storage.updateScenarioEdits(id, patch);
      if (!updated) return res.status(404).json({ error: "Scenario not found" });
      res.json({ scenario: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /api/scenarios/:id/hit-rate — compute hit-rate vs realized moves */
  app.get("/api/scenarios/:id/hit-rate", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const sc = await storage.getScenario(id);
      if (!sc) return res.status(404).json({ error: "Scenario not found" });
      const { fetchSeries } = await import("./series/fetchSeries");
      const { scoreHitRate } = await import("./analysis/scenarios");
      const { cleanSeries } = await import("./analysis/stats");

      const inputs: any = sc.inputsJson;
      const driverIds: string[] = (inputs?.drivers ?? []).map((d: any) => d.id);
      const equityIds: string[] = (inputs?.equities ?? []).map((e: any) => e.id);

      const dir = (oldVal: number | null | undefined, newVal: number | null | undefined): "up" | "down" | "flat" => {
        if (oldVal == null || newVal == null) return "flat";
        if (newVal > oldVal) return "up";
        if (newVal < oldVal) return "down";
        return "flat";
      };
      const realizedDrivers: Record<string, { direction: "up" | "down" | "flat" }> = {};
      const realizedEquities: Record<string, { direction: "up" | "down" | "flat" }> = {};
      await Promise.all(driverIds.map(async (id) => {
        const r = await fetchSeries(id);
        const c = cleanSeries(r.data);
        const old = inputs.drivers.find((d: any) => d.id === id)?.latestValue;
        realizedDrivers[id] = { direction: dir(old, c[c.length - 1]?.value) };
      }));
      await Promise.all(equityIds.map(async (id) => {
        const r = await fetchSeries(id);
        const c = cleanSeries(r.data);
        const old = inputs.equities.find((e: any) => e.id === id)?.latestLevel;
        realizedEquities[id] = { direction: dir(old, c[c.length - 1]?.value) };
      }));
      const hitRate = scoreHitRate(
        { baseCase: sc.baseCase, bullCase: sc.bullCase, bearCase: sc.bearCase },
        { drivers: realizedDrivers, equities: realizedEquities },
      );
      // Persist for future reads
      await storage.setScenarioHitRate(id, hitRate as any);
      res.json({ scenario: sc, hitRate, realized: { drivers: realizedDrivers, equities: realizedEquities } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Briefs (Phase 3b Session 4) ──────────────────────────────────
  /** POST /api/brief/generate
   *  Body: { model?: LlmModel; drivers?: string[]; crossAsset?: string[]; equities?: string[]; pairs?: [{driver,equity}] }
   *  Generates a market brief, persists it, returns the row.
   *  Soft cap: 10 generates per UTC day. Cache TTL on the LLM call is 24h.
   */
  app.post("/api/brief/generate", async (req, res) => {
    try {
      const Body = z.object({
        model: z.enum(["claude-sonnet-4", "claude-haiku-4", "deepseek-chat", "deepseek-reasoner"]).optional(),
        drivers: z.array(z.string()).optional(),
        crossAsset: z.array(z.string()).optional(),
        equities: z.array(z.string()).optional(),
        pairs: z.array(z.object({ driver: z.string(), equity: z.string() })).optional(),
      });
      const body = Body.parse(req.body);

      // Soft cap: 10 generates per rolling 24h. Cache-hit calls still count
      // (the resulting DB row counts), which keeps the user honest about
      // spawning new persisted rows.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recent = await storage.countBriefsSince(since);
      if (recent >= 10) {
        return res.status(429).json({
          error: `Daily brief cap reached (${recent}/10 in last 24h). Wait or delete an older brief.`,
          code: "daily_cap",
        });
      }

      const { generateBrief } = await import("./analysis/brief");
      const result = await generateBrief(body);

      const row = await storage.createBrief({
        asOfDate: result.output.asOfDate,
        execSummary: result.output.execSummary,
        sections: result.output.sections as any,
        inputsJson: result.inputs as any,
        model: result.model,
        costUsd: result.costUsd,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        userNotes: "",
      });

      res.json({
        brief: row,
        costUsd: result.costUsd,
        cacheHit: result.cacheHit,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });
    } catch (err: any) {
      const msg = err.message || String(err);
      const status = msg.includes("Blocked by cost ceiling")
        ? 429
        : msg.includes("No API key")
        ? 412
        : 500;
      res.status(status).json({ error: msg });
    }
  });

  /** GET /api/brief?limit=20 — list recent briefs (slim payload). */
  app.get("/api/brief", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const list = await storage.listBriefs(limit);
      // Slim payload — omit heavy fields (sections still needed for hover preview, but inputs are big)
      const slim = list.map((b) => ({
        id: b.id,
        generatedAt: b.generatedAt,
        asOfDate: b.asOfDate,
        execSummary: b.execSummary,
        model: b.model,
        costUsd: b.costUsd,
        tokensIn: b.tokensIn,
        tokensOut: b.tokensOut,
        userNotes: b.userNotes,
      }));
      res.json({ briefs: slim });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/brief/latest — most recent brief, full payload. */
  app.get("/api/brief/latest", async (_req, res) => {
    try {
      const b = await storage.getLatestBrief();
      if (!b) return res.status(404).json({ error: "No briefs yet" });
      res.json({ brief: b });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/brief/:id — single brief, full payload. */
  app.get("/api/brief/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const b = await storage.getBrief(id);
      if (!b) return res.status(404).json({ error: "Brief not found" });
      res.json({ brief: b });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** PATCH /api/brief/:id — update user notes only (no LLM cost). */
  app.patch("/api/brief/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const Body = z.object({ userNotes: z.string().max(20000) });
      const { userNotes } = Body.parse(req.body);
      const updated = await storage.updateBriefNotes(id, userNotes);
      if (!updated) return res.status(404).json({ error: "Brief not found" });
      res.json({ brief: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ===========================================================================
  // Policy Tracker (Phase 1)
  // ===========================================================================

  /** GET /api/policy/channels - the official source channel registry. */
  app.get("/api/policy/channels", (_req, res) => {
    res.json({
      channels: POLICY_CHANNELS,
      themes: COVERAGE_THEMES,
      techChannelIds: TECH_CHANNEL_IDS,
      equityTargets: EQUITY_TARGETS,
    });
  });

  /** GET /api/policy/feed?theme=&category=&body=&significance=&limit= */
  app.get("/api/policy/feed", async (req, res) => {
    try {
      const updates = await storage.listPolicyUpdates({
        body: req.query.body ? String(req.query.body) : undefined,
        theme: req.query.theme ? String(req.query.theme) : undefined,
        category: req.query.category ? String(req.query.category) : undefined,
        significance: req.query.significance ? String(req.query.significance) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ updates });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/policy/item/:id - single policy update. */
  app.get("/api/policy/item/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const item = await storage.getPolicyUpdate(id);
      if (!item) return res.status(404).json({ error: "Not found" });
      res.json({ item });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/policy/refresh { channels?, sinceDays?, lens?, classifyModel? }
   *  On-demand Sonar scan (no background scan per design). */
  app.post("/api/policy/refresh", async (req, res) => {
    try {
      const Body = z.object({
        channels: z.array(z.string()).optional(),
        sinceDays: z.number().int().min(1).max(120).optional(),
        lens: z.enum(["tech", "macro", "all"]).optional(),
        classifyModel: z.enum(["claude-haiku-4", "deepseek-chat"]).optional(),
      });
      const { channels, sinceDays, lens, classifyModel } = Body.parse(req.body ?? {});
      let ids = channels;
      if (!ids || ids.length === 0) {
        if (lens === "tech") ids = TECH_CHANNEL_IDS;
        else if (lens === "macro") ids = POLICY_CHANNELS.filter((c) => c.tier <= 4).map((c) => c.id);
        else ids = POLICY_CHANNELS.map((c) => c.id);
      }
      const reports = await scanChannels(ids, sinceDays ?? 30, classifyModel ?? "claude-haiku-4");
      res.json({ reports });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ===========================================================================
  // Investor-brain personas (Phase 1)
  // ===========================================================================

  /** GET /api/personas - the persona library (for the lens selector UI). */
  app.get("/api/personas", (_req, res) => {
    res.json({ personas: PERSONAS, defaultRedTeam: DEFAULT_REDTEAM_PANEL });
  });

  /** POST /api/personas/lens { personaId, context, focusHint?, model? } */
  app.post("/api/personas/lens", async (req, res) => {
    try {
      const Body = z.object({
        personaId: z.string(),
        context: z.string().min(1).max(40000),
        focusHint: z.string().max(400).optional(),
        model: z.enum(["claude-sonnet-4", "claude-haiku-4", "deepseek-chat", "deepseek-reasoner"]).optional(),
      });
      const { personaId, context, focusHint, model } = Body.parse(req.body);
      if (!PERSONAS_BY_ID[personaId]) return res.status(404).json({ error: "Unknown persona" });
      const { generateCommentary } = await import("./analysis/llm");
      const { system, user, persona } = buildLensPrompt({ personaId, context, focusHint });
      const result = await generateCommentary({
        model: model ?? "claude-sonnet-4",
        systemPrompt: system,
        userPrompt: user,
        actionContext: `persona_lens:${personaId}`,
        maxOutputTokens: 1200,
      });
      res.json({
        persona: { id: persona.id, name: persona.name, firm: persona.firm },
        text: result.text,
        costUsd: result.costUsd,
        cacheHit: result.cacheHit,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /api/personas/redteam { baseThesis, context?, panel?, focusHint?, model? } */
  app.post("/api/personas/redteam", async (req, res) => {
    try {
      const Body = z.object({
        baseThesis: z.string().min(1).max(40000),
        context: z.string().max(40000).optional(),
        panel: z.array(z.string()).optional(),
        focusHint: z.string().max(400).optional(),
        model: z.enum(["claude-sonnet-4", "claude-haiku-4", "deepseek-chat", "deepseek-reasoner"]).optional(),
      });
      const { baseThesis, context, panel, focusHint, model } = Body.parse(req.body);
      const { generateCommentary } = await import("./analysis/llm");
      const { system, user, panel: usedPanel } = buildRedTeamPrompt({ baseThesis, context, panel, focusHint });
      const result = await generateCommentary({
        model: model ?? "claude-sonnet-4",
        systemPrompt: system,
        userPrompt: user,
        actionContext: "persona_redteam",
        maxOutputTokens: 1500,
      });
      res.json({
        panel: usedPanel.map((p) => ({ id: p.id, name: p.name, firm: p.firm })),
        text: result.text,
        costUsd: result.costUsd,
        cacheHit: result.cacheHit,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ===========================================================================
  // Bottom-up equity layer (Phase 2)
  // ===========================================================================

  /** GET /api/equity/universe - sector themes -> constituent names. */
  app.get("/api/equity/universe", (_req, res) => {
    res.json({ themes: SECTOR_UNIVERSE });
  });

  /** GET /api/equity/valuation/:symbol - spot PE/PB/market cap (A-share via AKShare). */
  app.get("/api/equity/valuation/:symbol", async (req, res) => {
    try {
      const symbol = String(req.params.symbol).trim();
      const result = await getAkshareValuation(symbol);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/equity/name-catalysts { symbol, nameEn, themeId?, sinceDays? }
   *  Recent catalysts/earnings for a single name via Sonar (cited). */
  app.post("/api/equity/name-catalysts", async (req, res) => {
    try {
      const Body = z.object({
        symbol: z.string(),
        nameEn: z.string(),
        nameZh: z.string().optional(),
        themeId: z.string().optional(),
        sinceDays: z.number().int().min(1).max(120).optional(),
      });
      const { symbol, nameEn, nameZh, themeId, sinceDays } = Body.parse(req.body);
      const days = sinceDays ?? 45;
      const recency = days <= 7 ? "week" : days <= 31 ? "month" : "year";
      const theme = themeId ? THEMES_BY_ID[themeId]?.label : undefined;
      const system =
        "You are an equity analyst tracking a single China/HK-listed company for an " +
        "institutional strategist. Report factual, sourced, recent developments only " +
        "(earnings, guidance, orders, regulation, product, M&A). Never invent. " +
        'Respond with ONLY a JSON array of {"date":string,"headline":string,"detail":string,"url":string,"impact":"positive"|"negative"|"neutral"}.';
      const user =
        `Most material developments for ${nameEn}${nameZh ? ` (${nameZh})` : ""} ` +
        `[${symbol}]${theme ? `, a ${theme} name` : ""} over the last ${days} days that matter ` +
        `for the equity. Give the 3-6 most important, each with date, headline, 1-sentence detail, ` +
        `a source URL, and impact direction.`;
      const result = await querySonar({
        systemPrompt: system,
        userPrompt: user,
        actionContext: `name_news:${symbol}`,
        recency: recency as "week" | "month" | "year",
        maxOutputTokens: 1200,
      });
      let items = parseJsonArray<any>(result.text);
      if (items.length === 0 && result.citations.length > 0) {
        items = result.citations.slice(0, 6).map((c) => ({
          date: c.date ?? "",
          headline: c.title ?? "(see source)",
          detail: c.snippet ?? "",
          url: c.url,
          impact: "neutral",
        }));
      }
      res.json({ symbol, catalysts: items, citations: result.citations, costUsd: result.costUsd, cacheHit: result.cacheHit });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  registerReportRoutes(app);

  return httpServer;
}
