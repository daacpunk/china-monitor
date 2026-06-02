/**
 * LLM commentary engine.
 *
 * Generates analyst-style commentary on a series given its latest values and
 * (optionally) related series for context. Supports Claude and DeepSeek;
 * routes through the existing keyResolver + costTracker so calls land in the
 * audit_log and the per-service monthly ceilings are honored.
 *
 * Caching: response is cached in the api_cache table keyed by (model, prompt
 * hash) for 24h to avoid re-billing for identical analyses.
 */

import crypto from "node:crypto";
import { resolveApiKey } from "../keyResolver";
import { checkCeiling, recordCall, estimateCost, type Service } from "../costTracker";
import { storage } from "../storage";

export type LlmModel =
  | "claude-sonnet-4"
  | "claude-haiku-4"
  | "deepseek-chat"
  | "deepseek-reasoner";

const MODEL_META: Record<
  LlmModel,
  { service: Service; provider: "anthropic" | "deepseek"; apiModel: string }
> = {
  "claude-sonnet-4":    { service: "anthropic", provider: "anthropic", apiModel: "claude-sonnet-4-6" },
  "claude-haiku-4":     { service: "anthropic", provider: "anthropic", apiModel: "claude-haiku-4-5" },
  "deepseek-chat":      { service: "deepseek",  provider: "deepseek",  apiModel: "deepseek-chat" },
  "deepseek-reasoner":  { service: "deepseek",  provider: "deepseek",  apiModel: "deepseek-reasoner" },
};

export interface CommentaryRequest {
  model: LlmModel;
  systemPrompt: string;
  userPrompt: string;
  actionContext?: string;     // e.g. "commentary:cpi_yoy"
  maxOutputTokens?: number;
  cacheTtlSeconds?: number;   // default 86_400 (24h)
}

export interface CommentaryResult {
  text: string;
  model: LlmModel;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cacheHit: boolean;
  fetchedAt: string;
}

function promptHash(model: string, system: string, user: string): string {
  return crypto.createHash("sha256").update(`${model}|${system}|${user}`).digest("hex");
}

async function getCached(key: string): Promise<CommentaryResult | null> {
  try {
    const row = await storage.getCache(key);
    if (!row) return null;
    // payload is stored as jsonb — may come back as object or string depending on driver
    const payload: any = (row as any).payloadJson ?? (row as any).payload ?? row;
    const data = typeof payload === "string" ? JSON.parse(payload) as CommentaryResult : payload as CommentaryResult;
    return { ...data, cacheHit: true };
  } catch {
    return null;
  }
}

async function setCached(key: string, value: CommentaryResult, ttlSeconds: number): Promise<void> {
  try {
    const expires = new Date(Date.now() + ttlSeconds * 1000);
    await storage.setCache(key, value, expires, "llm");
  } catch {
    /* cache failures are non-fatal */
  }
}

// ─── Provider implementations ─────────────────────────────────────────

async function callAnthropic(
  apiKey: string,
  apiModel: string,
  system: string,
  user: string,
  maxOutputTokens: number,
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: apiModel,
      max_tokens: maxOutputTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const json: any = await res.json();
  const text = (json.content || []).map((b: any) => b.text || "").join("");
  const usage = json.usage || {};
  return {
    text,
    tokensIn: usage.input_tokens || 0,
    tokensOut: usage.output_tokens || 0,
  };
}

async function callDeepseek(
  apiKey: string,
  apiModel: string,
  system: string,
  user: string,
  maxOutputTokens: number,
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: apiModel,
      max_tokens: maxOutputTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const json: any = await res.json();
  const text = json.choices?.[0]?.message?.content ?? "";
  const usage = json.usage || {};
  return {
    text,
    tokensIn: usage.prompt_tokens || 0,
    tokensOut: usage.completion_tokens || 0,
  };
}

// ─── Public entry ─────────────────────────────────────────────────────

export async function generateCommentary(req: CommentaryRequest): Promise<CommentaryResult> {
  const meta = MODEL_META[req.model];
  if (!meta) throw new Error(`Unknown model: ${req.model}`);

  const maxOut = req.maxOutputTokens ?? 800;
  const cacheKey = `llm:${promptHash(req.model, req.systemPrompt, req.userPrompt)}`;
  const ttl = req.cacheTtlSeconds ?? 86_400;

  // 1. Cache check
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  // 2. Ceiling check
  const ceiling = await checkCeiling(meta.service);
  if (!ceiling.allowed) {
    await recordCall({
      service: meta.service,
      endpoint: `commentary/${req.model}`,
      actionContext: req.actionContext ?? null,
      model: req.model,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      status: "blocked_by_ceiling",
      errorMessage: ceiling.reason,
    });
    throw new Error(`Blocked by cost ceiling: ${ceiling.reason}`);
  }

  // 3. Key check
  const apiKey = await resolveApiKey(meta.service);
  if (!apiKey) {
    throw new Error(
      `No API key configured for ${meta.service}. Set ${meta.service === "anthropic" ? "ANTHROPIC_API_KEY" : "DEEPSEEK_API_KEY"} on Railway, or save it on the Settings page.`,
    );
  }

  // 4. Execute
  const t0 = Date.now();
  let result: { text: string; tokensIn: number; tokensOut: number };
  try {
    if (meta.provider === "anthropic") {
      result = await callAnthropic(apiKey, meta.apiModel, req.systemPrompt, req.userPrompt, maxOut);
    } else {
      result = await callDeepseek(apiKey, meta.apiModel, req.systemPrompt, req.userPrompt, maxOut);
    }
  } catch (err: any) {
    await recordCall({
      service: meta.service,
      endpoint: `commentary/${req.model}`,
      actionContext: req.actionContext ?? null,
      model: req.model,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      status: "error",
      latencyMs: Date.now() - t0,
      errorMessage: err.message,
    });
    throw err;
  }

  const cost = estimateCost(req.model, result.tokensIn, result.tokensOut);
  await recordCall({
    service: meta.service,
    endpoint: `commentary/${req.model}`,
    actionContext: req.actionContext ?? null,
    model: req.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: cost,
    status: "ok",
    latencyMs: Date.now() - t0,
  });

  const out: CommentaryResult = {
    text: result.text,
    model: req.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: cost,
    cacheHit: false,
    fetchedAt: new Date().toISOString(),
  };

  // 5. Cache (don't await — fire and forget)
  void setCached(cacheKey, out, ttl);
  return out;
}
