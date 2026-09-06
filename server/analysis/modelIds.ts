/**
 * Canonical seed list of selectable LLM model ids.
 *
 * The real source of truth is `modelCatalog.ts` (seed entries + a settings-backed
 * dynamic registry). This module stays as the compile-time view of the seed ids
 * so existing imports keep working and TypeScript still gets a useful union.
 *
 * IMPORTANT: route validation must NOT use `z.enum(LLM_MODEL_IDS)` any more —
 * dynamically registered models (e.g. a newly released Sonnet) would be rejected
 * until the next redeploy. Use `llmModelSchema` / `isKnownLlmModel()` instead.
 *
 * Direct providers (own key): Anthropic, DeepSeek.
 * OpenRouter (`or-*`): only models we have NO direct key for — deliberately
 * excludes Anthropic and DeepSeek models to avoid paying the router markup.
 */

import { SEED_MODELS } from "./modelCatalog";

export const OPENROUTER_MODEL_IDS = [
  "or-gpt-5.6",
  "or-gpt-5.6-mini",
  "or-gemini-2.5-pro",
  "or-gemini-2.5-flash",
  "or-grok-4.5",
  "or-glm-5.2",
  "or-kimi-k3",
  "or-qwen-3.8-max",
  "or-minimax-m3",
  "or-llama-4-maverick",
] as const;

export const LLM_MODEL_IDS = [
  "claude-sonnet-5",
  "claude-sonnet-4", // legacy id, kept forever for stored notes/configs
  "claude-opus-5",
  "claude-haiku-4",
  "deepseek-chat",
  "deepseek-reasoner",
  ...OPENROUTER_MODEL_IDS,
] as const;

/** Seed ids as a compile-time union, plus `string` for dynamically registered extras. */
export type SeedLlmModelId = (typeof LLM_MODEL_IDS)[number];
export type LlmModelId = SeedLlmModelId | (string & {});
export type OpenRouterModelId = (typeof OPENROUTER_MODEL_IDS)[number];

// Guard: the hand-written seed id list must stay in sync with the catalog.
const catalogIds = new Set(SEED_MODELS.map((m) => m.id));
for (const id of LLM_MODEL_IDS) {
  if (!catalogIds.has(id)) {
    throw new Error(`[modelIds] ${id} listed in LLM_MODEL_IDS but missing from SEED_MODELS`);
  }
}
