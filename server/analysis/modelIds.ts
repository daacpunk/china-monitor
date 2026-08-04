/**
 * Canonical list of selectable LLM model ids.
 *
 * Single source of truth so zod enums (routes) and the LlmModel union
 * (analysis/llm.ts) can never drift apart.
 *
 * Direct providers (own key): Anthropic, DeepSeek.
 * OpenRouter (`or-*`): only models we have NO direct key for — deliberately
 * excludes Anthropic and DeepSeek models to avoid paying the router markup.
 */

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
  "claude-sonnet-4",
  "claude-haiku-4",
  "deepseek-chat",
  "deepseek-reasoner",
  ...OPENROUTER_MODEL_IDS,
] as const;

export type LlmModelId = (typeof LLM_MODEL_IDS)[number];
export type OpenRouterModelId = (typeof OPENROUTER_MODEL_IDS)[number];
