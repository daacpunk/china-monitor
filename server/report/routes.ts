/**
 * Phase 3 report-engine routes: house view + strategy notes.
 * Registered from server/routes.ts via registerReportRoutes(app).
 */

import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { generateStrategyNote, regenerateSection, type GenerateOpts } from "./strategyNote";
import { proposeHouseView } from "./houseView";
import { LLM_MODEL_IDS } from "../analysis/modelIds";
import {
  capturePredictionsForHouseView,
  capturePredictionForNote,
  resolveDuePredictions,
} from "../analysis/trackRecord";

const MODEL_ENUM = z.enum(LLM_MODEL_IDS);

export function registerReportRoutes(app: Express): void {
  // ── House view ──────────────────────────────────────────────────────────────
  app.get("/api/house-view", async (_req, res) => {
    try {
      const hv = await storage.getHouseView();
      res.json({ houseView: hv ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/house-view", async (req, res) => {
    try {
      const Body = z.object({
        headline: z.string().default(""),
        stance: z.string().default("neutral"),
        conviction: z.string().default("medium"),
        horizon: z.string().default("2Q"),
        pillars: z.array(z.string()).default([]),
        keyRisks: z.array(z.string()).default([]),
        sectorStance: z.array(z.object({ theme: z.string(), stance: z.string(), rationale: z.string() })).default([]),
        changeLogEntry: z.object({ change: z.string(), trigger: z.string() }).optional(),
      });
      const b = Body.parse(req.body);
      const existing = await storage.getHouseView();
      const changeLog: any[] = existing ? ((existing.changeLog as any[]) ?? []) : [];
      if (b.changeLogEntry) {
        changeLog.unshift({
          date: new Date().toISOString().slice(0, 10),
          change: b.changeLogEntry.change,
          trigger: b.changeLogEntry.trigger,
        });
      }
      const hv = await storage.upsertHouseView({
        headline: b.headline,
        stance: b.stance,
        conviction: b.conviction,
        horizon: b.horizon,
        pillars: b.pillars,
        keyRisks: b.keyRisks,
        sectorStance: b.sectorStance,
        changeLog,
      });
      // Track record: log this view as falsifiable predictions (index call +
      // one relative call per sector stance). Best-effort — never block the save.
      try {
        await capturePredictionsForHouseView(hv, (req.body as any)?.model ?? "manual");
      } catch (e) {
        console.error("[house-view] prediction capture failed (non-fatal)", e);
      }
      res.json({ houseView: hv });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/house-view/propose", async (req, res) => {
    try {
      const { model } = z.object({ model: MODEL_ENUM.optional() }).parse(req.body ?? {});
      const proposal = await proposeHouseView(model ?? "claude-sonnet-4");
      res.json({ proposal });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Strategy notes ────────────────────────────────────────────────────────────
  app.get("/api/report", async (_req, res) => {
    try {
      const notes = await storage.listStrategyNotes(200);
      res.json({
        notes: notes.map((n) => ({
          id: n.id, title: n.title, asOfDate: n.asOfDate, mode: n.mode,
          createdAt: n.createdAt, status: n.status, costUsd: n.costUsd,
          userThesis: n.userThesis ?? "",
          emphasis: (n.emphasis as string[]) ?? [],
          featuredCount: ((n.featuredNames as string[]) ?? []).length,
          // a short preview = first sentence of the exec summary
          preview: (() => {
            const secs = (n.sections as any[]) ?? [];
            const exec = secs.find((s) => s.key === "executive_summary") ?? secs[0];
            const body = (exec?.body ?? "").replace(/[#*]/g, "").trim();
            return body.slice(0, 220);
          })(),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** DELETE /api/report/:id - remove a saved note from the vault. */
  app.delete("/api/report/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const ok = await storage.deleteStrategyNote(id);
      if (!ok) return res.status(404).json({ error: "Not found" });
      res.json({ deleted: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/report/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const note = await storage.getStrategyNote(id);
      if (!note) return res.status(404).json({ error: "Not found" });
      res.json({ note });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/report/generate", async (req, res) => {
    try {
      const Body = z.object({
        mode: z.enum(["data_driven", "thesis_driven"]),
        userThesis: z.string().max(4000).optional(),
        featuredNames: z.array(z.string()).default([]),
        mustInclude: z.array(z.string()).default([]),
        emphasis: z.array(z.string()).default([]),
        model: MODEL_ENUM.optional(),
        redTeamPanel: z.array(z.string()).optional(),
      });
      const b = Body.parse(req.body);
      if (b.mode === "thesis_driven" && !b.userThesis?.trim()) {
        return res.status(400).json({ error: "Thesis-driven mode requires a thesis." });
      }
      const opts: GenerateOpts = {
        mode: b.mode,
        userThesis: b.userThesis,
        featuredNames: b.featuredNames,
        mustInclude: b.mustInclude,
        emphasis: b.emphasis as any,
        model: b.model,
        redTeamPanel: b.redTeamPanel,
      };

      // Generation runs MANY LLM calls and can exceed the platform's HTTP
      // gateway timeout (~300s) for thesis-driven notes. Create a job row,
      // return 202 immediately, and do the work in the background — the client
      // polls GET /api/report/job/:id for completion.
      const job = await storage.insertJobRun({
        kind: "manual", status: "running", steps: [], costUsd: 0, noteId: null, finishedAt: null, error: null,
      });
      res.status(202).json({ jobId: job.id });

      void (async () => {
        try {
          const gen = await generateStrategyNote(opts);
          const hv = await storage.getHouseView();
          const saved = await storage.insertStrategyNote({
            title: gen.title,
            asOfDate: gen.asOfDate,
            mode: b.mode,
            userThesis: b.userThesis ?? "",
            featuredNames: b.featuredNames,
            mustInclude: b.mustInclude,
            emphasis: b.emphasis,
            sections: gen.sections,
            portfolio: gen.portfolio ?? null,
            thesisVerdict: gen.thesisVerdict ?? null,
            houseViewSnapshot: hv ?? null,
            citations: gen.citations,
            model: gen.model,
            costUsd: gen.costUsd,
            tokensIn: gen.tokensIn,
            tokensOut: gen.tokensOut,
            status: "draft",
          });
          // Track record: a thesis verdict is a prediction. Best-effort.
          try {
            if (saved.thesisVerdict) await capturePredictionForNote(saved, { horizon: "2Q" });
          } catch (e) {
            console.error("[report] thesis prediction capture failed (non-fatal)", e);
          }
          await storage.updateJobRun(job.id, {
            status: "success", finishedAt: new Date(), noteId: saved.id, costUsd: gen.costUsd ?? 0,
            steps: [{ step: "generate", ok: true, detail: `note #${saved.id}` }],
          });
        } catch (err: any) {
          console.error("[report] background generation failed:", err);
          await storage.updateJobRun(job.id, {
            status: "failed", finishedAt: new Date(), error: err?.message ?? String(err),
          }).catch((e) => console.error("[report] failed to mark job failed:", e));
        }
      })().catch((e) => console.error("[report] background task crashed:", e));
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /api/report/job/:id — poll status of a background generation job. */
  app.get("/api/report/job/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const job = await storage.getJobRun(id);
      if (!job) return res.status(404).json({ error: "Not found" });
      res.json({ id: job.id, status: job.status, noteId: job.noteId ?? null, error: job.error ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Track record / thesis scorecard ───────────────────────────────────
  app.get("/api/track-record", async (_req, res) => {
    try {
      const [summary, predictions] = await Promise.all([
        storage.trackRecordSummary(),
        storage.listPredictions({ limit: 200 }),
      ]);
      res.json({ summary, predictions });
    } catch (err: any) {
      // Never throw on an empty/absent scorecard — return an empty shape.
      console.error("[track-record] summary failed", err);
      res.json({
        summary: {
          total: 0, open: 0, resolved: 0, correct: 0, wrong: 0, partial: 0,
          hitRate: null, brier: null, brierN: 0, byKind: [], byModel: [],
        },
        predictions: [],
        error: err?.message ?? String(err),
      });
    }
  });

  /** Force a resolution pass (the scheduler tick does this every 15 min). */
  app.post("/api/track-record/resolve", async (_req, res) => {
    try {
      const result = await resolveDuePredictions();
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/report/:id/section/:key/regenerate", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const key = String(req.params.key);
      const note = await storage.getStrategyNote(id);
      if (!note) return res.status(404).json({ error: "Not found" });
      const { model } = z.object({ model: MODEL_ENUM.optional() }).parse(req.body ?? {});
      const opts: GenerateOpts = {
        mode: note.mode as any,
        userThesis: note.userThesis,
        featuredNames: (note.featuredNames as string[]) ?? [],
        mustInclude: (note.mustInclude as string[]) ?? [],
        emphasis: (note.emphasis as any) ?? [],
        model,
      };
      const { section, costUsd } = await regenerateSection(key, opts);
      const sections = ((note.sections as any[]) ?? []).map((s) => (s.key === key ? section : s));
      const updated = await storage.updateStrategyNote(id, { sections, costUsd: note.costUsd + costUsd });
      res.json({ note: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/report/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const Body = z.object({
        sections: z.array(z.object({ key: z.string(), heading: z.string(), body: z.string() })).optional(),
        status: z.enum(["draft", "final"]).optional(),
        title: z.string().optional(),
      });
      const b = Body.parse(req.body);
      const patch: any = {};
      if (b.sections) patch.sections = b.sections;
      if (b.status) patch.status = b.status;
      if (b.title) patch.title = b.title;
      const updated = await storage.updateStrategyNote(id, patch);
      if (!updated) return res.status(404).json({ error: "Not found" });
      res.json({ note: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
}
