/**
 * Phase 4 export routes — strategy note -> PDF / DOCX / PPTX, plus lightweight
 * page CSV exports. Registered from server/routes.ts.
 */

import type { Express } from "express";
import { storage } from "../storage";
import { buildDocModel } from "./model";
import { renderPdfFromModel } from "./pdf";
import { renderDocxFromModel } from "./docx";
import { renderPptx } from "./pptx";

function safeName(s: string): string {
  return (s || "report").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}

function csvCell(v: any): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerExportRoutes(app: Express): void {
  /** GET /api/report/:id/export?format=pdf|docx|pptx */
  app.get("/api/report/:id/export", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const format = String(req.query.format || "pdf").toLowerCase();
      const note = await storage.getStrategyNote(id);
      if (!note) return res.status(404).json({ error: "Not found" });

      const base = safeName(note.title);
      const model = await buildDocModel(note);

      if (format === "pdf") {
        const buf = await renderPdfFromModel(model);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
        return res.end(buf);
      }
      if (format === "docx") {
        const buf = await renderDocxFromModel(model);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.docx"`);
        return res.end(buf);
      }
      if (format === "pptx") {
        const buf = await renderPptx(model);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.pptx"`);
        return res.end(buf);
      }
      if (format === "csv") {
        // Sections + portfolio/verdict as a flat CSV.
        const rows: string[] = ["section,heading,body"];
        for (const s of model.sections) rows.push([s.key, csvCell(s.heading), csvCell(s.body)].join(","));
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
        return res.end(rows.join("\n"));
      }
      return res.status(400).json({ error: `Unsupported format: ${format}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/policy/export?format=csv — lightweight Policy Tracker export. */
  app.get("/api/policy/export", async (req, res) => {
    try {
      const updates = await storage.listPolicyUpdates({ limit: 500 });
      const rows = ["date,body,significance,title,themes,url,summary"];
      for (const u of updates) {
        rows.push([
          csvCell(u.publishedAt ?? ""), csvCell(u.body), csvCell(u.significance), csvCell(u.title),
          csvCell((u.themes as string[]).join("|")), csvCell(u.url), csvCell(u.summary),
        ].join(","));
      }
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="policy-tracker.csv"`);
      res.end(rows.join("\n"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
