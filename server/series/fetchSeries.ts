/**
 * Unified series fetch (Phase 2.5).
 *
 * Priority: CEIC (if seriesId mapped) → NBS → FRED → Yahoo → Stooq
 * Falls back to next source on empty or error.
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
} from "../clients/eastmoney";

export interface TimePoint {
  date: string;
  value: number | null;
}

export interface Provenance {
  source: "ceic" | "nbs" | "fred" | "eastmoney" | "stooq" | "yahoo" | "pending" | "static";
  lastUpdated: string; // ISO timestamp
  subscribed: boolean;
  cacheHit: boolean;
  error?: string;
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

/**
 * Fetch a series by logical ID.
 * Tries sources in priority order, returns first successful result.
 */
export async function fetchSeries(logicalId: string, _opts?: { count?: number; startDate?: string }): Promise<SeriesResult> {
  const entry = getEntry(logicalId);
  const now = new Date().toISOString();

  if (!entry) {
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

  // "pending" fallback means we have no free source for this series yet
  if (entry.fallback === "pending") {
    return {
      data: [],
      provenance: {
        source: "pending",
        lastUpdated: now,
        subscribed: false,
        cacheHit: false,
        error: "data_source_pending: requires CEIC subscription",
      },
    };
  }

  // ─── Try CEIC FIRST if a direct seriesId is mapped (Phase 2.5) ───────────
  if (entry.ceic?.seriesId) {
    try {
      const result = await getCeicData(entry.ceic.seriesId, { count: 60 });
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

  // ─── Try EastMoney (Phase 2.5, before NBS) ──────────────────────────────
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
      const points = await getFredSeries(entry.fred.seriesId, {
        units: entry.fred.units,
        limit: 120,
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
