/**
 * LLM catalog hook — the selectable model list and the current report default
 * come from the server (`GET /api/llm/models`), not from a hardcoded optgroup,
 * so newly released models (auto-registered by the catalog refresher) show up
 * without a frontend redeploy.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface CatalogModel {
  id: string;
  label: string;
  provider: "anthropic" | "deepseek" | "openrouter";
  apiModel: string;
  family: string;
  tier: "default" | "cheap" | "frontier" | "legacy";
  inputPerMTok: number;
  outputPerMTok: number;
  source: "seed" | "registered";
  isDefault: boolean;
}

export interface DetectedModel {
  provider: string;
  id: string;
  family?: string;
  reason: string;
}

export interface LlmCatalog {
  defaultModel: string;
  seedDefaultModel: string;
  models: CatalogModel[];
  detected: DetectedModel[];
  lastRefresh: string | null;
  lastPromotion: { from: string; to: string; at: string } | null;
  lastError: string | null;
  notes: string[];
}

/** Fallback used only until the first successful fetch. */
export const FALLBACK_DEFAULT_MODEL = "claude-sonnet-5";
export const CHEAP_MODEL = "claude-haiku-4";

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

export function useLlmCatalog() {
  const query = useQuery<LlmCatalog, Error>({
    queryKey: ["/api/llm/models"],
    queryFn: async () => (await apiRequest("GET", "/api/llm/models")).json(),
    staleTime: 5 * 60 * 1000,
  });

  const defaultModel = query.data?.defaultModel ?? FALLBACK_DEFAULT_MODEL;
  const models = query.data?.models ?? [];

  /** Models grouped by provider, in a stable display order. */
  const groups = useMemo(() => {
    const order = ["anthropic", "deepseek", "openrouter"];
    const byProvider = new Map<string, CatalogModel[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return order
      .filter((p) => byProvider.has(p))
      .map((p) => ({ provider: p, label: PROVIDER_LABEL[p] ?? p, models: byProvider.get(p)! }));
  }, [models]);

  /** Dropdown text: "Claude Sonnet 5 (default)" / "… (legacy)" / "… (cheaper)". */
  const optionLabel = (m: CatalogModel): string => {
    const suffix =
      m.id === defaultModel
        ? " (default)"
        : m.tier === "legacy"
          ? " (legacy)"
          : m.tier === "cheap"
            ? " (cheaper)"
            : m.source === "registered"
              ? " (new)"
              : "";
    return `${m.label}${suffix}`;
  };

  const labelFor = (id: string): string => models.find((m) => m.id === id)?.label ?? id;

  return { ...query, defaultModel, models, groups, optionLabel, labelFor };
}
