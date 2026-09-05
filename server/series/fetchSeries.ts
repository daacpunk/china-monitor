/**
 * Unified series fetch (Phase 2.5, extended Phase 7).
 *
 * Priority: imported:<id> → CEIC import (CDM/bridge, if mapped AND fresh) →
 *           AKShare macro → chinadata → CEIC REST (only when entitled) →
 *           HKEX → OECD → AKShare → EastMoney → NBS → FRED → Yahoo → Stooq →
 *           stale CEIC import (last resort, flagged)
 *
 * Falls back to the next source on empty or error. Two Phase 7 rules:
 *   1. A mapped CEIC import wins over free fallbacks ONLY while it is fresh;
 *      a stale import is held back and used only if everything else is empty,
 *      and is then labelled with a data-quality note.
 *   2. The CEIC REST client is skipped entirely unless the source mode is
 *      `api`, so an unentitled key is not re-hit (403) on every page load.
 */

import { REGISTRY, getEntry, type CeicConfig } from "./registry";
import { getMonthlySeries, getQuarterlySeries } from "../clients/nbs";
import { getDailyClose } from "../clients/stooq";
import { getChart } from "../clients/yahoo";
import { getFredSeries } from "../clients/fred";
import { getSeriesData as getCeicData } from "../clients/ceic";
import {
  getStockConnectFlow,
  getMarginBalance,
  getSectorPerformance,
  getEastMoneyKline,
} from "../clients/eastmoney";
import {
  getAkshareIndexHistorical,
  getAshareHistorical,
  getHkHistorical,
  getAkshareMacro,
} from "../clients/akshare";
import { getProductTrade } from "../clients/chinadata";
import { getStockConnectMonthlyAdt } from "../clients/hkex";
import { getOecdSeries } from "../clients/oecd";

export interface TimePoint {
  date: string;
  value: number | null;
}

export interface Provenance {
  source:
    | "ceic"
    /** CEIC via CDMNext export upload or the local Python bridge (not the REST API). */
    | "ceic_import"
    | "nbs"
    | "fred"
    | "oecd"
    | "hkex"
    | "eastmoney"
    | "akshare"
    | "chinadata"
    | "stooq"
    | "yahoo"
    | "pending"
    | "static"
    | "imported";
  lastUpdated: string; // ISO timestamp
  subscribed: boolean;
  cacheHit: boolean;
  error?: string;
  /** CEIC only: which route the data arrived through. */
  mode?: "api" | "python_bridge" | "cdm_import";
  /** CEIC only: the upstream CEIC series ID / mnemonic behind this value. */
  ceicSeriesId?: string;
  /** CEIC import only: the vintage (file/run date) of the newest observation. */
  vintageDate?: string;
  /** True when the values are older than the freshness budget for the frequency. */
  stale?: boolean;
  /** Short human note surfaced in report evidence / deck footnotes. */
  qualityNote?: string;
}

export interface SeriesResult {
  data: TimePoint[];
  provenance: Provenance;
}

function applyCeicTransform(points: TimePoint[], transform: CeicConfig["transform"]): TimePoint[] {
  if (!transform || transform === "raw") return points;
  if (transform === "divide_1000") {
    return points.map((p) => ({ date: p.date, value: p.value != null ? p.value / 1000 : null }));
  }
  if (transform === "yoy") {
    const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
    const byDate = new Map(sorted.map((p) => [p.date, p.value] as const));
    return sorted.map((p) => {
      if (p.value == null) return { date: p.date, value: null };
      const d = new Date(p.date);
      const prev = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
      const prevKey = prev.toISOString().slice(0, 10);
      const prevVal = byDate.get(prevKey);
      if (prevVal == null || prevVal === 0) return { date: p.date, value: null };
      return { date: p.date, value: ((p.value - prevVal) / prevVal) * 100 };
    });
  }
  return points;
}

// ─── CEIC import lookup (Phase 7) ──────────────────────────────────────
// A short in-process cache keeps the extra catalog lookup off the hot path:
// fetchSeries is called dozens of times per report/dashboard render, and the
// mapping table changes only when the user edits a mapping or runs an import.

let catalogCache: { at: number; byLogicalId: Map<string, any> } | null = null;
const CATALOG_TTL_MS = 60_000;

/** Invalidate the mapping cache (called after an import or a mapping edit). */
export function invalidateCeicCatalogCache(): void {
  catalogCache = null;
  ceicApiFlag = null;
}

async function ceicCatalogFor(logicalId: string): Promise<any | null> {
  try {
    if (!catalogCache || Date.now() - catalogCache.at > CATALOG_TTL_MS) {
      const { storage } = await import("../storage");
      const rows = await storage.listCeicCatalog();
      const byLogicalId = new Map<string, any>();
      for (const r of rows) {
        if (!r.logicalId) continue;
        const prev = byLogicalId.get(r.logicalId);
        // Most recently imported mapping wins if two CEIC series claim one ID.
        if (!prev || (r.lastDate ?? "") > (prev.lastDate ?? "")) byLogicalId.set(r.logicalId, r);
      }
      catalogCache = { at: Date.now(), byLogicalId };
    }
    return catalogCache.byLogicalId.get(logicalId) ?? null;
  } catch {
    // A cold DB (tables not yet created) must never break the fallback chain.
    return null;
  }
}

/**
 * Is the CEIC REST client allowed to run at all?
 *
 * Cached for 60s: fetchSeries is called dozens of times per render and this
 * guard must not add a status query to every one of them.
 */
let ceicApiFlag: { at: number; value: boolean } | null = null;
async function ceicApiEnabled(): Promise<boolean> {
  if (ceicApiFlag && Date.now() - ceicApiFlag.at < CATALOG_TTL_MS) return ceicApiFlag.value;
  let value = false;
  try {
    const { shouldUseCeicApi } = await import("../clients/ceicSource");
    value = await shouldUseCeicApi();
  } catch {
    value = false;
  }
  ceicApiFlag = { at: Date.now(), value };
  return value;
}

/** Freshness budget in days, by CEIC frequency label. */
function staleBudgetDays(frequency: string | null | undefined): number {
  const f = (frequency ?? "").toLowerCase();
  if (f.startsWith("d")) return 10;
  if (f.startsWith("w")) return 24;
  if (f.startsWith("q")) return 190;
  if (f.startsWith("a") || f.startsWith("y")) return 500;
  return 75; // monthly + unknown
}

/**
 * Fetch a series by logical ID.
 * Tries sources in priority order, returns first successful result.
 */
export async function fetchSeries(logicalId: string, _opts?: { count?: number; startDate?: string; force?: boolean }): Promise<SeriesResult> {
  const now = new Date().toISOString();

  // ─── Imported series (FactSet / Bloomberg / manual) ──────────────────────
  // Convention: logicalIds prefixed with `imported:` resolve from the
  // `imported_series` table (user CSV uploads). Always wins — user-imported
  // data is treated as authoritative.
  if (logicalId.startsWith("imported:")) {
    const seriesId = logicalId.slice("imported:".length);
    try {
      const { storage } = await import("../storage");
      const rows = await storage.getImportedSeries(seriesId);
      if (rows.length === 0) {
        return {
          data: [],
          provenance: {
            source: "imported",
            lastUpdated: now,
            subscribed: false,
            cacheHit: false,
            error: `No imported data for series_id: ${seriesId}`,
          },
        };
      }
      // Storage returns newest-first; preserve that for consistency with CEIC.
      const data: TimePoint[] = rows.map((r: any) => ({
        date: r.date,
        value: r.value != null ? Number(r.value) : null,
      }));
      const latestImport = rows.reduce(
        (acc: Date, r: any) => (r.importedAt > acc ? r.importedAt : acc),
        new Date(0),
      );
      return {
        data,
        provenance: {
          source: "imported",
          lastUpdated: latestImport.toISOString?.() ?? now,
          subscribed: true,
          cacheHit: false,
        },
      };
    } catch (err: any) {
      return {
        data: [],
        provenance: {
          source: "imported",
          lastUpdated: now,
          subscribed: false,
          cacheHit: false,
          error: `Imported lookup failed: ${err?.message ?? err}`,
        },
      };
    }
  }

  // ─── Mapped CEIC import (CDMNext export or Python bridge) ──────────────
  // Runs BEFORE every free fallback because the user pays for CEIC and it is
  // the most authoritative source — but only while the import is fresh. A
  // stale import is parked in `staleCeic` and used only if all other sources
  // come back empty, so a six-month-old CDM export can never mask live NBS or
  // AKShare data.
  let staleCeic: SeriesResult | null = null;
  const catEntry = await ceicCatalogFor(logicalId);
  if (catEntry) {
    try {
      const { storage } = await import("../storage");
      const { applyCeicImportTransform } = await import("../clients/ceicSource");
      const rows = await storage.getLatestCeicObservations(catEntry.seriesId);
      const withValues = rows.filter((r: any) => r.value != null);
      if (withValues.length > 0) {
        // Storage returns newest-first; the rest of the app expects ascending.
        const asc = [...rows].sort((a: any, b: any) => a.date.localeCompare(b.date));
        const transformed = applyCeicImportTransform(
          asc.map((r: any) => ({ date: r.date, value: r.value })),
          catEntry.transform,
        );
        const lastDate = asc[asc.length - 1].date;
        const vintageDate = withValues[0]?.vintageDate ?? catEntry.lastFileVintage ?? undefined;
        const budget = staleBudgetDays(catEntry.frequency);
        const ageDays = Math.floor((Date.now() - Date.parse(`${lastDate}T00:00:00Z`)) / 86_400_000);
        const stale = Number.isFinite(ageDays) && ageDays > budget;
        const mode: "python_bridge" | "cdm_import" =
          catEntry.sourceMode === "python_bridge" ? "python_bridge" : "cdm_import";
        const result: SeriesResult = {
          data: transformed,
          provenance: {
            source: "ceic_import",
            lastUpdated: catEntry.lastImportedAt
              ? new Date(catEntry.lastImportedAt).toISOString()
              : now,
            subscribed: true,
            cacheHit: false,
            mode,
            ceicSeriesId: String(catEntry.seriesId),
            vintageDate,
            stale,
            qualityNote: stale
              ? `CEIC ${mode === "python_bridge" ? "bridge" : "CDM import"} for ${logicalId} is stale: latest observation ${lastDate} (${ageDays}d old, budget ${budget}d). Refresh the CDMNext export or re-run the collector.`
              : undefined,
          },
        };
        if (!stale) return result;
        staleCeic = result;
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] CEIC import lookup failed for ${logicalId}:`, err?.message ?? err);
    }
  }

  const entry = getEntry(logicalId);

  if (!entry) {
    if (staleCeic) return staleCeic;
    return {
      data: [],
      provenance: {
        source: "pending",
        lastUpdated: now,
        subscribed: false,
        cacheHit: false,
        error: `Unknown series: ${logicalId}`,
      },
    };
  }

  // "pending" fallback means we have no free source for this series yet.
  // A stale CEIC import still beats nothing at all here.
  if (entry.fallback === "pending") {
    if (staleCeic) return staleCeic;
    return {
      data: [],
      provenance: {
        source: "pending",
        lastUpdated: now,
        subscribed: false,
        cacheHit: false,
        error:
          "data_source_pending: no free source mapped. Map a CEIC series to this " +
          "logical ID on the Imports \u2192 CEIC tab (CDMNext export or Python bridge).",
      },
    };
  }

  // ─── Try AKShare macro FIRST for CPI/PPI (NBS-current via sidecar) ───────
  // FRED China PPI is discontinued and CEIC can lag months behind; the sidecar
  // pulls EastMoney/NBS data from a China-egress host so it stays current.
  if (entry.akshareMacro) {
    try {
      const payload = await getAkshareMacro(entry.akshareMacro);
      const payloadAny = payload as { source: string; data: typeof payload.data; fetchedAt: string; error?: string };
      if (!payloadAny.error && payload.data.length > 0) {
        const points: TimePoint[] = payload.data
          .filter((r) => r.date && typeof r.value === "number")
          .map((r) => ({ date: r.date, value: r.value }));
        if (points.length > 0) {
          return {
            data: points,
            provenance: {
              source: "akshare",
              lastUpdated: now,
              subscribed: false,
              cacheHit: false,
            },
          };
        }
      }
      if (payloadAny.error) {
        console.warn(`[fetchSeries] AKShare macro ${entry.akshareMacro} for ${logicalId}: ${payloadAny.error}`);
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] AKShare macro failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Product / HS-chapter trade (chinadata.live, GACC-sourced) ───────────
  if (entry.productTrade) {
    try {
      const r = await getProductTrade(entry.productTrade.hs, entry.productTrade.metric);
      if (!r.error && r.data.length > 0) {
        return {
          data: r.data.map((p) => ({ date: p.date, value: p.value })),
          provenance: { source: "chinadata", lastUpdated: now, subscribed: false, cacheHit: false },
        };
      }
      if (r.error) {
        console.warn(`[fetchSeries] chinadata HS-${entry.productTrade.hs} for ${logicalId}: ${r.error}`);
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] chinadata failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try the CEIC REST API — only when the key is actually entitled ───
  // Phase 7: the production key returns an explicit 403 deny on /series/{id}/data.
  // shouldUseCeicApi() is false whenever the effective source mode is
  // cdm_import / python_bridge / unavailable, so we stop paying the latency and
  // log noise of a call we already know will be refused.
  if (entry.ceic?.seriesId && (await ceicApiEnabled())) {
    try {
      const result = await getCeicData(entry.ceic.seriesId, { count: 60, force: _opts?.force });
      // Success path: array of TimePoints
      if (Array.isArray(result) && result.length > 0) {
        const transformed = applyCeicTransform(result, entry.ceic.transform);
        return {
          data: transformed,
          provenance: {
            source: "ceic",
            lastUpdated: now,
            subscribed: true,
            cacheHit: false,
            mode: "api",
            ceicSeriesId: String(entry.ceic.seriesId),
          },
        };
      }
      // Error path: { error, message }
      if (!Array.isArray(result) && result.error) {
        console.warn(`[fetchSeries] CEIC ${entry.ceic.seriesId} for ${logicalId}: ${result.error} - ${result.message}`);
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] CEIC failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try HKEX (Phase 2.5) — monthly Stock Connect ADT ───────────────────
  if (entry.hkex) {
    try {
      const payload = await getStockConnectMonthlyAdt();
      if (!("error" in payload && payload.error) && payload.series.length > 0) {
        const field = entry.hkex.valueField;
        const points: TimePoint[] = payload.series
          .filter((r) => r.date && typeof (r as any)[field] === "number")
          .map((r) => ({ date: r.date, value: (r as any)[field] as number }));
        if (points.length > 0) {
          return {
            data: points,
            provenance: {
              source: "hkex",
              lastUpdated: now,
              subscribed: false,
              cacheHit: false,
            },
          };
        }
      }
      if ("error" in payload && payload.error) {
        console.warn(`[fetchSeries] HKEX for ${logicalId}: ${payload.error}`);
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] HKEX failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try OECD SDMX (Phase 2.5) ────────────────────────────────────────
  if (entry.oecd) {
    try {
      const payload = await getOecdSeries(entry.oecd.dataflowAndKey, {
        startPeriod: entry.oecd.startPeriod,
      });
      if (!("error" in payload && payload.error) && payload.series.length > 0) {
        const points: TimePoint[] = payload.series.map((p) => ({ date: p.date, value: p.value }));
        return {
          data: points,
          provenance: {
            source: "oecd",
            lastUpdated: now,
            subscribed: false,
            cacheHit: false,
          },
        };
      }
      if ("error" in payload && payload.error) {
        console.warn(`[fetchSeries] OECD for ${logicalId}: ${payload.error}`);
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] OECD failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try AKShare sidecar (Phase 3b ChiNext bypass) ──────────────────────
  // Runs through the Railway Python sidecar (China-egress path), used as primary
  // for series whose direct EastMoney endpoint is blocked from main service IP.
  if (entry.akshare) {
    try {
      const cfg = entry.akshare;
      const valueField = cfg.valueField ?? "close";
      let payload: { source: "akshare"; data: any[]; fetchedAt: string; error?: string };
      if (cfg.endpoint === "index/historical") {
        payload = await getAkshareIndexHistorical({
          symbol: cfg.symbol,
          start: cfg.start,
          period: cfg.period ?? "daily",
        });
      } else if (cfg.endpoint === "ashare/historical") {
        payload = await getAshareHistorical({
          symbol: cfg.symbol,
          start: cfg.start,
          adjust: cfg.adjust ?? "qfq",
        });
      } else if (cfg.endpoint === "hk/historical") {
        payload = await getHkHistorical({
          symbol: cfg.symbol,
          start: cfg.start,
          adjust: cfg.adjust ?? "qfq",
        });
      } else {
        throw new Error(`Unknown AKShare endpoint: ${(cfg as any).endpoint}`);
      }

      if (!payload.error && payload.data.length > 0) {
        const points: TimePoint[] = payload.data
          .filter((r: any) => r.date && typeof r[valueField] === "number")
          .map((r: any) => ({ date: r.date, value: r[valueField] as number }));
        if (points.length > 0) {
          return {
            data: points,
            provenance: {
              source: "akshare",
              lastUpdated: now,
              subscribed: false,
              cacheHit: false,
            },
          };
        }
      }
      if (payload.error) {
        console.warn(`[fetchSeries] AKShare ${cfg.endpoint} for ${logicalId}: ${payload.error}`);
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] AKShare failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try EastMoney (Phase 2.5) ──────────────────────────────────────────
  if (entry.eastmoney) {
    try {
      const cfg = entry.eastmoney;
      let payload: { source: "eastmoney"; series: any[]; fetchedAt: string; error?: string };
      if (cfg.clientFn === "getStockConnectFlow") {
        payload = await getStockConnectFlow();
      } else if (cfg.clientFn === "getMarginBalance") {
        payload = await getMarginBalance();
      } else if (cfg.clientFn === "getSectorPerformance") {
        payload = await getSectorPerformance();
      } else if (cfg.clientFn === "getEastMoneyIndexKline") {
        if (!cfg.secid) {
          throw new Error("getEastMoneyIndexKline requires secid in EastMoneyConfig");
        }
        const klt = cfg.klt ?? 101;
        // Default beg = 5 years ago (in YYYYMMDD) if not set
        const defaultBeg = (() => {
          const d = new Date();
          d.setUTCFullYear(d.getUTCFullYear() - 5);
          return d.toISOString().slice(0, 10).replace(/-/g, "");
        })();
        const beg = cfg.beg ?? defaultBeg;
        payload = await getEastMoneyKline(cfg.secid, beg, undefined, klt);
        // For monthly kline, normalize date to month-end (EastMoney returns last trading day of month already).
      } else {
        throw new Error(`Unknown EastMoney clientFn: ${cfg.clientFn}`);
      }

      if (!payload.error && payload.series.length > 0) {
        if (cfg.valueField) {
          const divisor = cfg.divideBy && cfg.divideBy !== 0 ? cfg.divideBy : 1;
          const points: TimePoint[] = payload.series
            .filter((r: any) => r.date && typeof r[cfg.valueField!] === "number")
            .map((r: any) => ({
              date: r.date,
              value: r[cfg.valueField!] / divisor,
            }));
          if (points.length > 0) {
            return {
              data: points,
              provenance: {
                source: "eastmoney",
                lastUpdated: now,
                subscribed: false,
                cacheHit: false,
              },
            };
          }
        } else {
          // Snapshot (e.g. sector_rotation) — return today's rows as single-date points.
          // UI should also consume full payload via /api/eastmoney/sectors directly.
          const today = now.slice(0, 10);
          const points: TimePoint[] = payload.series
            .filter((r: any) => typeof r.changePercent === "number")
            .map((r: any) => ({ date: today, value: r.changePercent as number }));
          if (points.length > 0) {
            return {
              data: points,
              provenance: {
                source: "eastmoney",
                lastUpdated: now,
                subscribed: false,
                cacheHit: false,
              },
            };
          }
        }
      }
      if (payload.error) {
        console.warn(`[fetchSeries] EastMoney ${cfg.clientFn} for ${logicalId}: ${payload.error}`);
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] EastMoney failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try NBS (if configured) ──────────────────────────────────────────────
  if (entry.nbs) {
    try {
      let points: TimePoint[];
      if (entry.nbs.dbcode === "hgjd") {
        points = await getQuarterlySeries(entry.nbs.code);
      } else {
        points = await getMonthlySeries(entry.nbs.code);
      }

      if (points.length > 0) {
        return {
          data: points,
          provenance: {
            source: "nbs",
            lastUpdated: now,
            subscribed: false, // free source
            cacheHit: false, // we don't know from this layer; storage.getCache handles it
          },
        };
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] NBS failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try FRED (if configured and NBS failed) ─────────────────────────────
  if (entry.fred) {
    try {
      const freq = entry.fred.frequency ?? "m";
      const points = await getFredSeries(entry.fred.seriesId, {
        units: entry.fred.units,
        limit: freq === "d" ? 365 : 120,
        frequency: freq,
      });

      if (points.length > 0) {
        return {
          data: points,
          provenance: {
            source: "fred",
            lastUpdated: now,
            subscribed: false,
            cacheHit: false,
          },
        };
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] FRED failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try Yahoo Finance (if configured) ───────────────────────────────────
  if (entry.yahoo) {
    try {
      const raw = await getChart(entry.yahoo.ticker, {
        interval: entry.yahoo.interval,
        range: entry.yahoo.range,
      });

      if (raw.length > 0) {
        const points: TimePoint[] = raw.map((p) => ({ date: p.date, value: p.close }));
        return {
          data: points,
          provenance: {
            source: "yahoo",
            lastUpdated: now,
            subscribed: false,
            cacheHit: false,
          },
        };
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] Yahoo failed for ${logicalId}:`, err.message);
    }
  }

  // ─── Try Stooq (if configured) ────────────────────────────────────────────
  if (entry.stooq) {
    try {
      const raw = await getDailyClose(entry.stooq.symbol, {
        rangeDays: entry.stooq.rangeDays,
      });

      if (raw.length > 0) {
        const points: TimePoint[] = raw.map((p) => ({ date: p.date, value: p.close }));
        return {
          data: points,
          provenance: {
            source: "stooq",
            lastUpdated: now,
            subscribed: false,
            cacheHit: false,
          },
        };
      }
    } catch (err: any) {
      console.warn(`[fetchSeries] Stooq failed for ${logicalId}:`, err.message);
    }
  }

  // ─── All sources exhausted ────────────────────────────────────────────────
  // Last resort: a stale CEIC import beats an empty chart, but it is returned
  // with stale=true and a qualityNote so report/deck can caveat it.
  if (staleCeic) return staleCeic;
  return {
    data: [],
    provenance: {
      source: "pending",
      lastUpdated: now,
      subscribed: false,
      cacheHit: false,
      error: `All sources returned empty for ${logicalId}. NBS may be unreachable in this environment.`,
    },
  };
}
