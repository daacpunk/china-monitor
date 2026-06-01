/**
 * Unified series fetch.
 *
 * Priority: NBS → Yahoo → Stooq → CEIC (metadata only in Phase 2)
 * If primary source fails or returns unsubscribed, falls back to next source.
 *
 * Returns standardized TimePoint array + provenance metadata.
 */

import { REGISTRY, getEntry } from "./registry";
import { getMonthlySeries, getQuarterlySeries } from "../clients/nbs";
import { getDailyClose } from "../clients/stooq";
import { getChart } from "../clients/yahoo";
import { getFredSeries } from "../clients/fred";

export interface TimePoint {
  date: string;
  value: number | null;
}

export interface Provenance {
  source: "ceic" | "nbs" | "fred" | "stooq" | "yahoo" | "pending" | "static";
  lastUpdated: string; // ISO timestamp
  subscribed: boolean;
  cacheHit: boolean;
  error?: string;
}

export interface SeriesResult {
  data: TimePoint[];
  provenance: Provenance;
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
