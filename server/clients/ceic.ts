/**
 * CEIC API client — search, metadata, and DATA (Phase 2.5 unblocked).
 *
 * Phase 2.5 discovery (2026-06-02): the key has 9,895 subscribed series including
 * 71 China, 86 HK, 98 Taiwan headline macro series (CEIC "Global Economic Monitor").
 * /series/{id}/data WORKS for these. Use `subscribed_only=true` on search to scope.
 *
 * Response shape note: /series/{id}/data returns { data: [ { entityId, subscribed,
 * timePoints: [{date, value, lastUpdateTime}] } ] }, NOT { data: { time_points } }.
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
  subscribedOnly?: boolean;
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

  const cacheKey = `ceic:search:${query.country ?? ""}:${query.keyword ?? ""}:${query.limit ?? 20}:${query.subscribedOnly ? "sub" : "all"}`;

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
    if (query.subscribedOnly) params.subscribed_only = "true";

    const json = await ceicFetch("/series/search", params);
    const items = json?.data?.items ?? [];

    const results: CeicSearchResult[] = items.map((item: any) => {
      const meta = item?.metadata ?? {};
      return {
        id: meta.id ?? item?.id,
        name: meta.name ?? "",
        frequency: meta?.frequency?.name ?? meta?.frequency?.id ?? "",
        source: meta?.source?.name ?? "",
        country: meta?.country?.id ?? meta?.country?.name ?? "",
        indicator: Array.isArray(meta?.indicators) && meta.indicators[0]?.[0]?.name ? meta.indicators[0][0].name : "",
        unit: meta?.unit?.name ?? "",
        subscribed: item?.subscribed === true,
      };
    });

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

    // Response shape: { data: [ { entityId, subscribed, metadata: {...} } ] }
    const entry = Array.isArray(json?.data) ? json.data[0] : json?.data;
    const meta = entry?.metadata ?? entry ?? {};
    const result: CeicMetadata = {
      id: meta.id ?? id,
      name: meta.name ?? "",
      frequency: meta?.frequency?.name ?? meta?.frequency?.id ?? "",
      source: meta?.source?.name ?? "",
      country: meta?.country?.id ?? meta?.country?.name ?? "",
      indicator: Array.isArray(meta?.indicators) && meta.indicators[0]?.[0]?.name ? meta.indicators[0][0].name : "",
      unit: meta?.unit?.name ?? "",
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

    // CRITICAL: response shape is { data: [ { entityId, subscribed, timePoints: [...] } ] }
    // NOT { data: { time_points: [...] } }. Phase 2.5 fix.
    const dataArr = Array.isArray(json?.data) ? json.data : [];
    const firstEntity = dataArr[0] ?? {};
    const rawPoints = firstEntity.timePoints ?? firstEntity.time_points ?? [];
    const timePoints: CeicTimePoint[] = rawPoints.map((tp: any) => ({
      date: tp.date,
      value: tp.value != null ? Number(tp.value) : null,
    }));

    // If entity says subscribed=false explicitly, surface as unsubscribed error
    if (firstEntity.subscribed === false && timePoints.length === 0) {
      return { error: "unsubscribed", message: `Series ${id} not in subscription` };
    }

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
