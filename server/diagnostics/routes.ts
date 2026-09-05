/**
 * Diagnostics aggregator — GET /api/diagnostics
 *
 * Server-side fan-out producing a single health snapshot: app + sidecar status,
 * a data-source matrix, a series-freshness table (the centerpiece), cost
 * summary, automation status, and known limitations. Tolerant: each section is
 * wrapped so one failing probe never 500s the whole endpoint. Cached ~60s.
 */

import type { Express } from "express";
import { fetchSeries } from "../series/fetchSeries";
import { getAkshareHealth } from "../clients/akshare";
import { storage } from "../storage";
import { getConfig } from "../automation/scheduler";
import { resolveApiKey } from "../keyResolver";

function currentYearMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Curated key series for the freshness matrix (keep small so the endpoint is fast).
const KEY_SERIES: { id: string; label: string; category: string; cadenceDays: number }[] = [
  // Macro
  { id: "cpi_yoy", label: "CPI YoY", category: "macro", cadenceDays: 45 },
  { id: "ppi_yoy", label: "PPI YoY", category: "macro", cadenceDays: 45 },
  { id: "pmi_mfg", label: "Mfg PMI", category: "macro", cadenceDays: 45 },
  { id: "m2_yoy", label: "M2 YoY", category: "macro", cadenceDays: 50 },
  { id: "retail_sales_yoy", label: "Retail YoY", category: "macro", cadenceDays: 60 },
  { id: "iva_yoy", label: "Industrial VA YoY", category: "macro", cadenceDays: 60 },
  { id: "unemployment_rate", label: "Urban Unemployment", category: "macro", cadenceDays: 60 },
  { id: "new_home_prices_70city", label: "70-City Home Prices", category: "macro", cadenceDays: 60 },
  // Trade
  { id: "exports_yoy", label: "Exports YoY", category: "trade", cadenceDays: 45 },
  { id: "imports_yoy", label: "Imports YoY", category: "trade", cadenceDays: 45 },
  { id: "trade_balance_usd", label: "Trade Balance", category: "trade", cadenceDays: 45 },
  // HS-chapter trade via chinadata lags the headline print ~1-2 months; allow 75d.
  { id: "chips_exports_yoy", label: "Electronics Exports (HS85)", category: "trade", cadenceDays: 75 },
  { id: "autos_exports_yoy", label: "Vehicle Exports (HS87)", category: "trade", cadenceDays: 75 },
  { id: "energy_imports_yoy", label: "Energy Imports (HS27)", category: "trade", cadenceDays: 75 },
  // Cross-asset / FX
  { id: "usdcny_monthly", label: "USD/CNY", category: "fx", cadenceDays: 40 },
  { id: "oecd_cli_china", label: "OECD CLI China", category: "macro", cadenceDays: 60 },
  // Equity indices (monthly close)
  { id: "csi300_monthly", label: "CSI 300 (mo)", category: "equity", cadenceDays: 40 },
  { id: "chinext_monthly", label: "ChiNext (mo)", category: "equity", cadenceDays: 40 },
  { id: "hangseng_monthly", label: "Hang Seng (mo)", category: "equity", cadenceDays: 40 },
];

function ageDaysFrom(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr.length === 7 ? `${dateStr}-01` : dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}`;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url;
  }
}

/**
 * Honest, mode-aware CEIC limitation text.
 *
 * Replaces the old hardcoded "current subscription denies the search API"
 * line, which was wrong whenever the user is on the CDM-import or
 * Python-bridge path.
 */
function ceicLimitation(ceic: any): string {
  const mode = ceic?.mode ?? "unavailable";
  if (mode === "api") {
    return "CEIC: REST API entitled and in use as the primary source for mapped series.";
  }
  if (mode === "cdm_import" || mode === "python_bridge") {
    const via = mode === "cdm_import" ? "CDMNext Excel/CSV export" : "local Python bridge";
    const stale = ceic?.staleSeries?.length ?? 0;
    return (
      `CEIC: no REST data entitlement on the current key, so CEIC arrives via ${via} ` +
      `(${ceic?.mappedCount ?? 0} of ${ceic?.catalogCount ?? 0} catalog series mapped to logical IDs` +
      (stale ? `, ${stale} stale and currently deferring to free fallbacks` : "") +
      "). AKShare/FRED/NBS/OECD still cover every unmapped series."
    );
  }
  return (
    "CEIC: not yet connected. The API key (if any) has no data entitlement — " +
    "upload a CDMNext Excel/CSV export on the Imports page or run the local " +
    "Python bridge (ceic-python-bridge/) to start populating the catalog. " +
    "AKShare/FRED/NBS/OECD cover the gaps meanwhile."
  );
}

interface CacheEntry { at: number; payload: any }
let cache: CacheEntry | null = null;
const TTL_MS = 60_000;

export function registerDiagnosticsRoutes(app: Express): void {
  app.get("/api/diagnostics", async (_req, res) => {
    try {
      if (cache && Date.now() - cache.at < TTL_MS) {
        return res.json(cache.payload);
      }

      const sidecarUrl = process.env.AKSHARE_SIDECAR_URL || "http://localhost:18765";

      // ── Parallel probes ────────────────────────────────────────────────
      const [
        sidecarRes,
        ceicKey,
        fredHealthRes,
        sonarKey,
        anthropicKey,
        deepseekKey,
        automationCfg,
        jobs,
        seriesResults,
        auditSummary,
        ceicStatus,
      ] = await Promise.all([
        getAkshareHealth().catch((e) => ({ ok: false, detail: { error: e.message } })),
        resolveApiKey("ceic").catch(() => null),
        import("../clients/fred")
          .then((m) => m.checkFredHealth())
          .catch((e) => ({ ok: false, keyConfigured: false, message: e.message })),
        resolveApiKey("sonar").catch(() => null),
        resolveApiKey("anthropic").catch(() => null),
        resolveApiKey("deepseek").catch(() => null),
        getConfig().catch(() => null),
        storage.listJobRuns(8).catch(() => []),
        Promise.allSettled(
          KEY_SERIES.map(async (s) => {
            const r = await fetchSeries(s.id);
            const last = r.data.length ? r.data[r.data.length - 1] : null;
            const lastDate = last?.date ?? null;
            const age = ageDaysFrom(lastDate);
            const empty = r.data.length === 0;
            let status: "fresh" | "stale" | "empty" = "fresh";
            if (empty) status = "empty";
            else if (age != null && age > s.cadenceDays) status = "stale";
            return {
              id: s.id,
              label: s.label,
              category: s.category,
              source: (r.provenance as any)?.source ?? "unknown",
              // Phase 7: distinguish CEIC REST from CDM import vs Python bridge.
              sourceMode: (r.provenance as any)?.mode ?? null,
              ceicSeriesId: (r.provenance as any)?.ceicSeriesId ?? null,
              vintageDate: (r.provenance as any)?.vintageDate ?? null,
              qualityNote: (r.provenance as any)?.qualityNote ?? null,
              lastDate,
              ageDays: age,
              status,
              error: (r.provenance as any)?.error ?? null,
            };
          }),
        ),
        storage
          .getMonthlyCostByService(currentYearMonth())
          .catch(() => [] as any[]),
        import("../clients/ceicSource")
          .then((m) => m.getCeicStatus())
          .catch((e) => ({ mode: "unavailable", summary: `CEIC status probe failed: ${e.message}`, lastError: e.message } as any)),
      ]);

      const sidecar = sidecarRes as any;
      const sidecarDetail = sidecar?.detail ?? {};
      const sidecarReachable = !!sidecar?.ok;

      const series = (seriesResults as PromiseSettledResult<any>[]).map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : {
              id: KEY_SERIES[i].id,
              label: KEY_SERIES[i].label,
              category: KEY_SERIES[i].category,
              source: "unknown",
              lastDate: null,
              ageDays: null,
              status: "empty" as const,
              error: (r as PromiseRejectedResult).reason?.message ?? "fetch failed",
            },
      );
      // Stale/empty first.
      const rank = (s: string) => (s === "empty" ? 0 : s === "stale" ? 1 : 2);
      series.sort((a, b) => rank(a.status) - rank(b.status));

      const fred = fredHealthRes as any;
      const ceic = ceicStatus as any;

      const sources = [
        {
          id: "akshare",
          label: "AKShare sidecar",
          status: sidecarReachable ? "ok" : "down",
          detail: sidecarReachable
            ? `v${sidecarDetail.akshare_version ?? "?"} · cache ${sidecarDetail.cache_size ?? 0}`
            : sidecarDetail.error ?? "unreachable",
        },
        {
          id: "ceic",
          label: "CEIC",
          // Phase 7: report the ACTUAL source mode rather than assuming REST.
          // `api` = entitled key; `cdm_import`/`python_bridge` = data is
          // flowing via CDMNext export or the local collector; `unavailable`
          // = nothing configured yet.
          status:
            ceic.mode === "api" || ceic.mode === "python_bridge" || ceic.mode === "cdm_import"
              ? ceic.staleSeries?.length
                ? "degraded"
                : "ok"
              : "down",
          detail: ceic.summary ?? "",
          mode: ceic.mode,
          apiKeyConfigured: !!ceic.apiKeyConfigured || !!ceicKey,
          apiUsable: !!ceic.apiUsable,
          bridgeTokenConfigured: !!ceic.bridgeTokenConfigured,
          catalogCount: ceic.catalogCount ?? 0,
          mappedCount: ceic.mappedCount ?? 0,
          observationCount: ceic.observationCount ?? 0,
          vintageCount: ceic.vintageCount ?? 0,
          staleCount: ceic.staleSeries?.length ?? 0,
          freshCount: ceic.freshSeriesCount ?? 0,
          latestObservationDate: ceic.latestObservationDate ?? null,
          latestImportAt: ceic.latestImportAt ?? null,
          recentImports: ceic.recentFiles ?? [],
          lastError: ceic.lastError ?? null,
        },
        {
          id: "fred",
          label: "FRED",
          status: fred?.keyConfigured ? (fred.ok ? "ok" : "degraded") : "down",
          detail: fred?.message ?? "",
        },
        { id: "eastmoney", label: "EastMoney", status: "ok", detail: "public endpoints" },
        {
          id: "sonar",
          label: "Perplexity Agent API",
          status: sonarKey ? "ok" : "down",
          detail: sonarKey ? "key configured" : "no key",
        },
        {
          id: "anthropic",
          label: "Anthropic",
          status: anthropicKey ? "ok" : "down",
          detail: anthropicKey ? "key configured" : "no key",
        },
        {
          id: "deepseek",
          label: "DeepSeek",
          status: deepseekKey ? "ok" : "down",
          detail: deepseekKey ? "key configured" : "no key",
        },
      ];

      const cfg = automationCfg as any;
      const automation = cfg
        ? {
            enabled: !!cfg.enabled,
            cadence: cfg.cadence,
            nextRunAt: cfg.nextRunAt ?? null,
            lastRunAt: cfg.lastRunAt ?? null,
            recentJobs: (jobs as any[]).map((j) => ({
              status: j.status,
              kind: j.kind,
              startedAt: j.startedAt,
              noteId: j.noteId ?? null,
            })),
          }
        : { enabled: false, recentJobs: [] };

      const byService = (auditSummary as any[]) ?? [];
      const costs = {
        yearMonth: currentYearMonth(),
        totalUsd: byService.reduce((s: number, r: any) => s + (r.total ?? 0), 0),
        byService,
      };

      const payload = {
        generatedAt: new Date().toISOString(),
        app: { ok: true, env: process.env.NODE_ENV ?? "unknown" },
        sidecar: {
          url: maskUrl(sidecarUrl),
          reachable: sidecarReachable,
          authConfigured: !!sidecarDetail.auth_configured,
          akshareVersion: sidecarDetail.akshare_version ?? null,
          cacheSize: sidecarDetail.cache_size ?? null,
        },
        sources,
        series,
        costs,
        automation,
        // Phase 7: full CEIC picture (mode, catalog, mappings, vintages,
        // freshness) so the Diagnostics page can render the import bridge.
        ceic: {
          mode: ceic.mode ?? "unavailable",
          overrideMode: ceic.overrideMode ?? "auto",
          apiKeyConfigured: !!ceic.apiKeyConfigured,
          apiKeyTestStatus: ceic.apiKeyTestStatus ?? null,
          apiUsable: !!ceic.apiUsable,
          bridgeTokenConfigured: !!ceic.bridgeTokenConfigured,
          catalogCount: ceic.catalogCount ?? 0,
          mappedCount: ceic.mappedCount ?? 0,
          observationCount: ceic.observationCount ?? 0,
          vintageCount: ceic.vintageCount ?? 0,
          seriesWithVintages: ceic.seriesWithVintages ?? 0,
          freshSeriesCount: ceic.freshSeriesCount ?? 0,
          staleSeries: ceic.staleSeries ?? [],
          latestObservationDate: ceic.latestObservationDate ?? null,
          latestVintageDate: ceic.latestVintageDate ?? null,
          latestImportAt: ceic.latestImportAt ?? null,
          recentImports: ceic.recentFiles ?? [],
          lastError: ceic.lastError ?? null,
          summary: ceic.summary ?? "",
        },
        limitations: [
          "Urban unemployment: source is NBS (data.stats.gov.cn), which blocks the host IP even from Hong Kong — shows blank and falls back.",
          "Sector fund flows: EastMoney upstream is intermittently flaky (occasional empty/502); retried but may show no data.",
          ceicLimitation(ceic),
        ],
      };

      cache = { at: Date.now(), payload };
      res.json(payload);
    } catch (err: any) {
      res.status(200).json({
        generatedAt: new Date().toISOString(),
        app: { ok: false, error: err.message },
        sources: [],
        series: [],
        limitations: [],
      });
    }
  });
}
