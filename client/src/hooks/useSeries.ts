/**
 * React Query hooks for live series data.
 *
 * NEVER uses raw fetch() — always uses apiRequest from queryClient.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { SeriesResponse, RegistryEntry, MacroRelease } from "@shared/series";

// ─── Series data hook ─────────────────────────────────────────────────────────

export function useSeries(logicalId: string, opts?: { enabled?: boolean }) {
  return useQuery<SeriesResponse>({
    queryKey: ["/api/series", logicalId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/series/${logicalId}`);
      return res.json();
    },
    enabled: opts?.enabled !== false && !!logicalId,
    staleTime: 6 * 60 * 60 * 1000, // 6h — matches cache TTL for market data
    retry: 1,
  });
}

// ─── Registry list hook ───────────────────────────────────────────────────────

export function useSeriesRegistry() {
  return useQuery<RegistryEntry[]>({
    queryKey: ["/api/series"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/series");
      return res.json();
    },
    staleTime: Infinity,
    retry: 1,
  });
}

// ─── Calendar hook ────────────────────────────────────────────────────────────

export interface CalendarResponse {
  days: number;
  count: number;
  releases: MacroRelease[];
}

export function useCalendar(days = 30) {
  return useQuery<CalendarResponse>({
    queryKey: ["/api/calendar/upcoming", days],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/calendar/upcoming?days=${days}`);
      return res.json();
    },
    staleTime: 60 * 60 * 1000, // 1h — calendar is static-ish
    retry: 1,
  });
}

// ─── CEIC health hook ─────────────────────────────────────────────────────────

export interface CeicHealthResponse {
  keyConfigured: boolean;
  lastTestStatus: string | null;
  subscribedSeriesCount: number;
  message: string;
}

export function useCeicHealth() {
  return useQuery<CeicHealthResponse>({
    queryKey: ["/api/ceic/health"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/ceic/health");
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // 5m
    retry: 1,
  });
}

// ─── CEIC search hook ─────────────────────────────────────────────────────────

export function useCeicSearch(q: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["/api/ceic/search", q],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/ceic/search?q=${encodeURIComponent(q)}&country=CN&limit=10`);
      return res.json();
    },
    enabled: opts?.enabled !== false && q.length >= 2,
    staleTime: 60 * 60 * 1000, // 1h
    retry: 1,
  });
}

// ─── Helper: extract latest value from series data ───────────────────────────

export function getLatestValue(data: SeriesResponse | undefined): {
  value: number | null;
  date: string | null;
} {
  if (!data?.data?.length) return { value: null, date: null };
  const last = data.data[data.data.length - 1];
  return { value: last.value, date: last.date };
}

// ─── Force-refresh helper ─────────────────────────────────────────────────────

/**
 * Returns a stable callback that force-refreshes a single series by calling
 * the endpoint with ?force=true, then invalidating the React Query cache.
 */
export function useRefreshSeries(): (logicalId: string) => Promise<void> {
  return async (logicalId: string) => {
    await apiRequest("GET", `/api/series/${logicalId}?force=true`);
    await queryClient.invalidateQueries({ queryKey: ["/api/series", logicalId] });
  };
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (unit === "%" || unit === "index") {
    return value.toFixed(1);
  }
  return value.toLocaleString();
}
