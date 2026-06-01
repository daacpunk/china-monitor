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
  // CEIC proxy — stub for Phase 1.
  // In Phase 2 this will hit developer.isimarkets.com with the saved API key,
  // honor the cost ceiling, cache to series_cache, and log to audit trail.
  // Stub structure here so settings page can wire to it without live calls.
  // ───────────────────────────────────────────────────────────────────────────
  const ceicQuerySchema = z.object({
    seriesId: z.string().optional(),
    seriesName: z.string().optional(),
    actionContext: z.string().optional(),
  });

  app.post("/api/ceic/series", async (req, res) => {
    try {
      const params = ceicQuerySchema.parse(req.body);
      // 1. Check ceiling first
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
      // 2. Phase 1 stub: return placeholder payload, do NOT increment spend.
      res.json({
        stub: true,
        message: "CEIC live integration ships in Phase 2",
        request: params,
        watchlistAvailable: true,
      });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Watchlists (P3 — schema only, list/create/delete enabled)
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/watchlists", async (_req, res) => {
    res.json(await storage.listWatchlists());
  });

  return httpServer;
}
