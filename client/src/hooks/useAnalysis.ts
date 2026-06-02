/**
 * React Query hooks for /api/analysis/* endpoints.
 * Uses apiRequest from queryClient — never raw fetch.
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnomalyResult {
  date: string;
  value: number;
  windowMean: number;
  windowStd: number;
  zScore: number;
  severity: "normal" | "watch" | "anomaly";
  windowSize: number;
}

export interface AnomalyRow {
  id: string;
  anomaly: AnomalyResult | null;
  momLagPct: number | null;
  yoyLagPct: number | null;
  provenance?: { source: string; lastUpdated: string; cacheHit?: boolean };
  error?: string;
}

export interface AnomaliesResponse {
  results: AnomalyRow[];
}

export interface CompareResponse {
  ids: string[];
  dates: string[];
  values: Record<string, number[]>;
  correlationMatrix: number[][];
  provenance: Record<string, { source: string; lastUpdated: string; cacheHit?: boolean }>;
  commonPoints: number;
}

export interface CommentaryResponse {
  logicalId: string;
  label: string;
  commentary: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cacheHit: boolean;
  fetchedAt: string;
  latestObservation: { date: string; value: number };
  mom: number | null;
  yoy: number | null;
  anomaly?: AnomalyResult | null;
}

// ─── Anomalies (bulk, used on Overview) ───────────────────────────────────────

export function useAnomalies(ids: string[], windowSize = 24, enabled = true) {
  return useQuery<AnomaliesResponse>({
    queryKey: ["/api/analysis/anomalies", ids, windowSize],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/analysis/anomalies", { ids, windowSize });
      return res.json();
    },
    enabled: enabled && ids.length > 0,
    staleTime: 6 * 60 * 60 * 1000, // 6h
    retry: 1,
  });
}

// ─── Compare (on-demand mutation, used by modal) ──────────────────────────────

export function useCompareMutation() {
  return useMutation<CompareResponse, Error, { ids: string[]; startDate?: string }>({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/analysis/compare", body);
      return res.json();
    },
  });
}

// ─── Commentary (on-demand mutation, used by AI panel) ────────────────────────

export function useCommentaryMutation() {
  return useMutation<
    CommentaryResponse,
    Error,
    { logicalId: string; model?: string; question?: string; contextIds?: string[] }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/analysis/commentary", body);
      return res.json();
    },
  });
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

export function severityClasses(severity?: "normal" | "watch" | "anomaly" | null) {
  if (severity === "anomaly")
    return "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30";
  if (severity === "watch")
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30";
  return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
}

export function severityLabel(severity?: "normal" | "watch" | "anomaly" | null) {
  if (severity === "anomaly") return "anomaly";
  if (severity === "watch") return "watch";
  if (severity === "normal") return "normal";
  return "—";
}
