/**
 * CEIC API client — search and metadata only.
 * Data fetch (getSeriesData) is wired but MUST NOT be called from registry fetch
 * until a subscription is attached. The current key returns UNSUBSCRIBED_SERIES
 * for all data endpoints.
 *
 * Auth: ?token=<KEY> query param (NOT Bearer header).
 * Base: https://api.ceicdata.com/v2
 */

import { storage } from "../storage";
import { checkCeiling, recordCall } from "../costTracker";
import { resolveApiKey } from "../keyResolver";

const BASE = "https://api.ceicdata.com/v2";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CeicSearchResult {
  id: string | number;
  name: string;
  frequency: string;
  source: string;
  country: string;
  indicator: string;
  unit: string;
  subscribed: boolean;
}

export interface CeicMetadata {
  id: string | number;
  name: string;
  frequency: string;
  source: string;
  country: string;
  indicator: string;
  unit: string;
  startDate?: string;
  endDate?: string;
}

export interface CeicTimePoint {
  date: string;
  value: number | null;
}

type CeicDataResult = CeicTimePoint[] | { error: "unsubscribed" | "not_found" | "other" | "ceiling_blocked"; message: string };
type CeicMetaResult = CeicMetadata | { error: "unsubscribed" | "not_found" };

// ─── Internal helper ──────────────────────────────────────────────────────────

async function getKey(): Promise<string | null> {
  return resolveApiKey("ceic");
}

async function ceicFetch(endpoint: string, params: Record<string, string | number>): Promise<any> {
  const key = await getKey();
  if (!key) throw new Error("CEIC key not configured");

  const qs = new URLSearchParams({ format: "json", token: key });
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }

  const url = `${BASE}${endpoint}?${qs.toString()}`;
  const start = Date.now();

  const res = await fetch(url, {
    headers: { "User-Agent": "china-monitor/2.0" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CEIC ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function searchSeries(query: {
  country?: string;
  keyword?: string;
  limit?: number;
}): Promise<CeicSearchResult[] | { error: "ceiling_blocked"; message: string }> {
  // 1. Check ceiling
  const guard = await checkCeiling("ceic");
  if (!guard.allowed) {
    const msg = guard.reason ?? "CEIC ceiling blocked";
    await recordCall({
      service: "ceic",
      endpoint: "/series/search",
      actionContext: "ceic_search",
      costUsd: 0,
      status: "blocked_by_ceiling",
      errorMessage: msg,
    });
    return { error: "ceiling_blocked", message: msg };
  }

  const cacheKey = `ceic:search:${query.country ?? ""}:${query.keyword ?? ""}:${query.limit ?? 20}`;

  // 2. Cache lookup
  const cached = await storage.getCache(cacheKey);
  if (cached) {
    return cached.payloadJson as CeicSearchResult[];
  }

  // 3. Fetch
  const start = Date.now();
  try {
    const params: Record<string, string | number> = { limit: query.limit ?? 20 };
    if (query.country) params.country = query.country;
    if (query.keyword) params.keyword = query.keyword;

    const json = await ceicFetch("/series/search", params);
    const items = json?.data?.items ?? [];

    const results: CeicSearchResult[] = items.map((item: any) => ({
      id: item?.metadata?.id ?? item?.id,
      name: item?.metadata?.name ?? item?.name ?? "",
      frequency: item?.metadata?.frequency ?? "",
      source: item?.metadata?.source ?? "",
      country: item?.metadata?.country ?? "",
      indicator: item?.metadata?.indicator ?? "",
      unit: item?.metadata?.unit ?? "",
      subscribed: item?.subscribed === true,
    }));

    // 4. Cache
    const expires = new Date(Date.now() + TTL_MS);
    await storage.setCache(cacheKey, results, expires, "ceic");

    // 5. Record call
    await recordCall({
      service: "ceic",
      endpoint: "/series/search",
      actionContext: "ceic_search",
      costUsd: 0.01,
      status: "ok",
      latencyMs: Date.now() - start,
    });

    return results;
  } catch (err: any) {
    await recordCall({
      service: "ceic",
      endpoint: "/series/search",
      actionContext: "ceic_search",
      costUsd: 0,
      status: "error",
      errorMessage: err.message,
      latencyMs: Date.now() - start,
    });
    throw err;
  }
}

export async function getSeriesMetadata(id: string | number): Promise<CeicMetaResult | { error: "ceiling_blocked"; message: string }> {
  const guard = await checkCeiling("ceic");
  if (!guard.allowed) {
    const msg = guard.reason ?? "CEIC ceiling blocked";
    return { error: "ceiling_blocked", message: msg } as any;
  }

  const cacheKey = `ceic:metadata:${id}`;
  const cached = await storage.getCache(cacheKey);
  if (cached) return cached.payloadJson as CeicMetadata;

  const start = Date.now();
  try {
    const json = await ceicFetch(`/series/${id}`, {});
    if (json?.errors?.length) {
      const code = json.errors[0]?.code;
      if (code === "UNSUBSCRIBED_SERIES") return { error: "unsubscribed" };
      return { error: "not_found" };
    }

    const meta = json?.data ?? json;
    const result: CeicMetadata = {
      id: meta.id ?? id,
      name: meta.name ?? "",
      frequency: meta.frequency ?? "",
      source: meta.source ?? "",
      country: meta.country ?? "",
      indicator: meta.indicator ?? "",
      unit: meta.unit ?? "",
      startDate: meta.startDate,
      endDate: meta.endDate,
    };

    await storage.setCache(cacheKey, result, new Date(Date.now() + TTL_MS), "ceic");
    await recordCall({
      service: "ceic",
      endpoint: `/series/${id}`,
      actionContext: "ceic_metadata",
      costUsd: 0.01,
      status: "ok",
      latencyMs: Date.now() - start,
    });

    return result;
  } catch (err: any) {
    await recordCall({
      service: "ceic",
      endpoint: `/series/${id}`,
      actionContext: "ceic_metadata",
      costUsd: 0,
      status: "error",
      errorMessage: err.message,
      latencyMs: Date.now() - start,
    });
    return { error: "not_found" };
  }
}

export async function getSeriesData(
  id: string | number,
  opts?: { count?: number; startDate?: string },
): Promise<CeicDataResult> {
  const guard = await checkCeiling("ceic");
  if (!guard.allowed) {
    const msg = guard.reason ?? "CEIC ceiling blocked";
    return { error: "ceiling_blocked" as any, message: msg };
  }

  const count = opts?.count ?? 24;
  const cacheKey = `ceic:series:${id}:${count}:${opts?.startDate ?? ""}`;
  const cached = await storage.getCache(cacheKey);
  if (cached) return cached.payloadJson as CeicTimePoint[];

  const start = Date.now();
  try {
    const params: Record<string, string | number> = { count };
    if (opts?.startDate) params.startDate = opts.startDate;

    const json = await ceicFetch(`/series/${id}/data`, params);

    // Detect unsubscribed
    if (json?.errors?.length) {
      const code = json.errors[0]?.code;
      const msg = json.errors[0]?.message ?? "Unsubscribed";
      if (code === "UNSUBSCRIBED_SERIES") {
        await recordCall({
          service: "ceic",
          endpoint: `/series/${id}/data`,
          actionContext: "ceic_data",
          costUsd: 0,
          status: "error",
          errorMessage: msg,
          latencyMs: Date.now() - start,
        });
        return { error: "unsubscribed", message: msg };
      }
      return { error: "other", message: msg };
    }

    const timePoints: CeicTimePoint[] = (json?.data?.time_points ?? []).map((tp: any) => ({
      date: tp.date,
      value: tp.value != null ? Number(tp.value) : null,
    }));

    await storage.setCache(cacheKey, timePoints, new Date(Date.now() + TTL_MS), "ceic");
    await recordCall({
      service: "ceic",
      endpoint: `/series/${id}/data`,
      actionContext: "ceic_data",
      costUsd: 0.01,
      status: "ok",
      latencyMs: Date.now() - start,
    });

    return timePoints;
  } catch (err: any) {
    await recordCall({
      service: "ceic",
      endpoint: `/series/${id}/data`,
      actionContext: "ceic_data",
      costUsd: 0,
      status: "error",
      errorMessage: err.message,
      latencyMs: Date.now() - start,
    });
    return { error: "other", message: err.message };
  }
}
