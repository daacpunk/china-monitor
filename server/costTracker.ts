import { storage } from "./storage";

export const SERVICES = ["ceic", "sonar", "anthropic", "deepseek"] as const;
export type Service = (typeof SERVICES)[number];

export function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Check if a service is currently allowed to make a call.
 * Returns { allowed: true } if within ceilings, otherwise { allowed: false, reason }.
 * Honors hard_stop_enabled — if false, never blocks (alert-only mode).
 */
export async function checkCeiling(
  service: Service,
): Promise<{ allowed: boolean; reason?: string; ceiling?: any }> {
  const ceiling = await storage.getCeiling(service);
  if (!ceiling) return { allowed: true };
  if (!ceiling.hardStopEnabled) return { allowed: true, ceiling };

  const ym = currentYearMonth();
  const effSpend = ceiling.monthAnchor === ym ? ceiling.currentMonthUsd : 0;
  const effCalls = ceiling.monthAnchor === ym ? ceiling.currentMonthCalls : 0;

  if (effSpend >= ceiling.monthlyLimitUsd) {
    return {
      allowed: false,
      reason: `Monthly $${ceiling.monthlyLimitUsd.toFixed(2)} ceiling reached for ${service} ($${effSpend.toFixed(2)} spent)`,
      ceiling,
    };
  }
  if (ceiling.monthlyCallCap != null && effCalls >= ceiling.monthlyCallCap) {
    return {
      allowed: false,
      reason: `Monthly call cap of ${ceiling.monthlyCallCap} reached for ${service} (${effCalls} calls)`,
      ceiling,
    };
  }
  return { allowed: true, ceiling };
}

export interface RecordCallArgs {
  service: Service;
  endpoint: string;
  actionContext?: string | null;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd: number;
  status: "ok" | "error" | "blocked_by_ceiling";
  latencyMs?: number;
  errorMessage?: string | null;
}

/**
 * Log a call to audit trail and increment monthly spend.
 * Always call this for every paid API call (and for blocked attempts too).
 */
export async function recordCall(args: RecordCallArgs): Promise<void> {
  await storage.logApiCall({
    service: args.service,
    endpoint: args.endpoint,
    actionContext: args.actionContext ?? null,
    model: args.model ?? null,
    tokensIn: args.tokensIn ?? 0,
    tokensOut: args.tokensOut ?? 0,
    costUsd: args.costUsd,
    status: args.status,
    latencyMs: args.latencyMs ?? null,
    errorMessage: args.errorMessage ?? null,
  });
  if (args.status !== "blocked_by_ceiling") {
    await storage.incrementSpend(args.service, args.costUsd, 1, currentYearMonth());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing models — used to compute cost from token counts.
// Conservative defaults; user can override via settings later.
// All prices in USD.
// ─────────────────────────────────────────────────────────────────────────────
export const PRICING = {
  // Anthropic Claude (per million tokens)
  "claude-sonnet-4": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-opus-4": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "claude-haiku-4": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  // Perplexity Sonar Pro: $5 per 1k requests + token rates
  "sonar-pro": { perRequest: 0.005, inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "sonar": { perRequest: 0.001, inputPerMTok: 1.0, outputPerMTok: 1.0 },
  // DeepSeek (cache-miss pricing, V3)
  "deepseek-chat": { inputPerMTok: 0.27, outputPerMTok: 1.10 },
  "deepseek-reasoner": { inputPerMTok: 0.55, outputPerMTok: 2.19 },
  // CEIC — per call (estimate; user confirmed call-cap based)
  "ceic-default": { perRequest: 0.01 },
};

export function estimateCost(
  modelKey: keyof typeof PRICING,
  tokensIn: number,
  tokensOut: number,
): number {
  const p: any = PRICING[modelKey];
  if (!p) return 0;
  let cost = 0;
  if (p.perRequest) cost += p.perRequest;
  if (p.inputPerMTok) cost += (tokensIn / 1_000_000) * p.inputPerMTok;
  if (p.outputPerMTok) cost += (tokensOut / 1_000_000) * p.outputPerMTok;
  return cost;
}
