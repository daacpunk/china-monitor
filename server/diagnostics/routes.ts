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
  { id: "chips_exports_yoy", label: "Electronics Exports (HS85)", category: "trade", cadenceDays: 50 },
  { id: "autos_exports_yoy", label: "Vehicle Exports (HS87)", category: "trade", cadenceDays: 50 },
  { id: "energy_imports_yoy", label: "Energy Imports (HS27)", category: "trade", cadenceDays: 50 },
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
          status: ceicKey ? "degraded" : "down",
          detail: ceicKey ? "key configured; search API denied on tier" : "no key",
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
          label: "Sonar (Perplexity)",
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
        limitations: [
          "Urban unemployment: source is NBS (data.stats.gov.cn), which blocks the host IP even from Hong Kong — shows blank and falls back.",
          "Sector fund flows: EastMoney upstream is intermittently flaky (occasional empty/502); retried but may show no data.",
          "CEIC: current subscription denies the search API, so CEIC series are not directly fetchable (AKShare/FRED cover the gaps).",
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
