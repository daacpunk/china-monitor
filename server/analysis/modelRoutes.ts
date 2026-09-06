/**
 * LLM catalog routes.
 *
 *   GET  /api/llm/models           → { defaultModel, models, detected, lastRefresh, ... }
 *   POST /api/llm/default          → persist the report default
 *   POST /api/llm/catalog/refresh  → run the catalog refresh now (no throttle)
 *
 * Registered from server/routes.ts via registerLlmCatalogRoutes(app).
 */

import type { Express } from "express";
import { z } from "zod";
import {
  DEFAULT_REPORT_MODEL,
  getCatalogStateSync,
  getDefaultReportModel,
  listSelectableModels,
  loadCatalogState,
  selectableLlmModelSchema,
  setDefaultReportModel,
} from "./modelCatalog";
import { refreshModelCatalog } from "./modelCatalogRefresh";

async function catalogPayload() {
  const [defaultModel] = await Promise.all([getDefaultReportModel(), loadCatalogState()]);
  const state = getCatalogStateSync();
  return {
    defaultModel,
    seedDefaultModel: DEFAULT_REPORT_MODEL,
    models: listSelectableModels().map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      apiModel: m.apiModel,
      family: m.family,
      tier: m.tier,
      inputPerMTok: m.inputPerMTok,
      outputPerMTok: m.outputPerMTok,
      source: m.source ?? "seed",
      isDefault: m.id === defaultModel,
    })),
    detected: state.detected ?? [],
    lastRefresh: state.refreshedAt ?? null,
    lastPromotion: state.lastPromotion ?? null,
    lastError: state.lastError ?? null,
    notes: state.notes ?? [],
  };
}

export function registerLlmCatalogRoutes(app: Express): void {
  /** GET /api/llm/models — catalog for the UI dropdowns + Settings card. */
  app.get("/api/llm/models", async (_req, res) => {
    try {
      res.json(await catalogPayload());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/llm/default { model } — persist the report default. */
  app.post("/api/llm/default", async (req, res) => {
    try {
      await loadCatalogState(true); // pick up models registered since boot
      const { model } = z.object({ model: selectableLlmModelSchema }).parse(req.body ?? {});
      await setDefaultReportModel(model);
      res.json(await catalogPayload());
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /api/llm/catalog/refresh — run the refresh immediately (bypass throttle). */
  app.post("/api/llm/catalog/refresh", async (_req, res) => {
    try {
      const result = await refreshModelCatalog({ trigger: "manual" });
      res.json({
        ok: result.ok,
        registeredNew: result.registeredNew,
        promotion: result.promotion ?? null,
        skipped: result.skipped,
        ...(await catalogPayload()),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
