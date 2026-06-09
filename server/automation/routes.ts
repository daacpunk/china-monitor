/**
 * Phase 5 automation routes: schedule config, run-now/refresh-now, jobs,
 * notifications, and the protected external tick endpoint.
 */

import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { getConfig, saveConfig, runScheduledReport, runDueJobs } from "./scheduler";
import { refreshReportSeries } from "./refresh";

export function registerAutomationRoutes(app: Express): void {
  // ── Schedule config ────────────────────────────────────────────────────────
  app.get("/api/automation", async (_req, res) => {
    try {
      const config = await getConfig();
      const jobs = await storage.listJobRuns(20);
      res.json({ config, jobs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/automation", async (req, res) => {
    try {
      const Body = z.object({
        enabled: z.boolean().optional(),
        cadence: z.enum(["monthly", "quarterly"]).optional(),
        dayOfMonth: z.number().int().min(1).max(28).optional(),
        hourUtc: z.number().int().min(0).max(23).optional(),
        mode: z.enum(["data_driven", "thesis_driven"]).optional(),
        emphasis: z.array(z.string()).optional(),
        featuredNames: z.array(z.string()).optional(),
        model: z.string().optional(),
        refreshPolicyFirst: z.boolean().optional(),
        autoUpdateHouseView: z.boolean().optional(),
        notify: z.object({ inApp: z.boolean(), email: z.string().email().optional().or(z.literal("")) }).optional(),
      });
      const patch = Body.parse(req.body ?? {});
      const config = await saveConfig(patch as any);
      res.json({ config });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /api/automation/run-now — generate a report immediately (manual). */
  app.post("/api/automation/run-now", async (_req, res) => {
    try {
      const result = await runScheduledReport("manual");
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/automation/refresh — force a data refresh only (no report). */
  app.post("/api/automation/refresh", async (req, res) => {
    try {
      const Body = z.object({
        emphasis: z.array(z.string()).optional(),
        featuredNames: z.array(z.string()).optional(),
        refreshPolicy: z.boolean().optional(),
      });
      const b = Body.parse(req.body ?? {});
      const result = await refreshReportSeries({ emphasis: b.emphasis as any, featuredNames: b.featuredNames, refreshPolicy: b.refreshPolicy });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /api/jobs/tick — protected external trigger (Railway cron / GitHub Action).
   *  Guarded by a shared secret in the X-Tick-Token header (env AUTOMATION_TICK_TOKEN).
   *  If no token is configured, the endpoint is disabled (the in-process loop still runs). */
  app.post("/api/jobs/tick", async (req, res) => {
    const expected = process.env.AUTOMATION_TICK_TOKEN;
    if (!expected) return res.status(404).json({ error: "External tick disabled (no token configured)" });
    if (req.headers["x-tick-token"] !== expected) return res.status(401).json({ error: "Unauthorized" });
    try {
      const result = await runDueJobs();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Notifications ───────────────────────────────────────────────────────────
  app.get("/api/notifications", async (_req, res) => {
    try {
      const items = await storage.listNotifications(30);
      res.json({ notifications: items, unread: items.filter((n) => !n.read).length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/notifications/:id/read", async (req, res) => {
    try {
      await storage.markNotificationRead(Number(req.params.id));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/notifications/read-all", async (_req, res) => {
    try {
      await storage.markAllNotificationsRead();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
