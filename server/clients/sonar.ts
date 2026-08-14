/**
 * Perplexity web-research client.
 *
 * Primary: Agent API  POST https://api.perplexity.ai/v1/agent
 *   preset "low"  (= former sonar-pro) + explicit web_search (search is OFF
 *   unless the tool is offered). Citations come from output[] search_results.
 *
 * Fallback (until 2026-09-27): the legacy Sonar Chat Completions endpoint
 *   POST https://api.perplexity.ai/chat/completions  model sonar-pro.
 *   Sonar is shut down on that date. After it, only the Agent path remains.
 *   Fallback fires on transport/HTTP/empty-text/failed-status so policy scan,
 *   report digest, and name-news keep working through the migration window.
 *
 * Public API (querySonar / SonarResult / parseJsonArray) is UNCHANGED — call
 * sites do not need to move.
 *
 * Key: resolveApiKey("sonar") = SONAR_API_KEY / Settings (same Perplexity key).
 */

import crypto from "node:crypto";
import { resolveApiKey } from "../keyResolver";
import { checkCeiling, recordCall, estimateCost } from "../costTracker";
import { storage } from "../storage";

const AGENT_URL = "https://api.perplexity.ai/v1/agent";
const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const SONAR_MODEL = "sonar-pro";
const AGENT_PRESET = "low";
const AGENT_MODEL_LABEL = "agent-low"; // recorded in audit_log / cost
/** Sonar Chat Completions is supported until this UTC date (inclusive). */
const SONAR_SUNSET = new Date("2026-09-27T23:59:59Z");

export interface SonarCitation {
  title?: string;
  url: string;
  date?: string;
  snippet?: string;
}

export interface SonarRequest {
  systemPrompt: string;
  userPrompt: string;
  actionContext?: string;          // e.g. "policy_scan:pboc"
  /** Restrict search to these domains (e.g. ["pbc.gov.cn"]). */
  domains?: string[];
  /** "day" | "week" | "month" | "year" — freshness window. */
  recency?: "day" | "week" | "month" | "year";
  maxOutputTokens?: number;
  cacheTtlSeconds?: number;         // default 86_400 (24h)
}

export interface SonarResult {
  text: string;
  citations: SonarCitation[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cacheHit: boolean;
  fetchedAt: string;
}

function sonarFallbackAllowed(): boolean {
  return Date.now() <= SONAR_SUNSET.getTime();
}

function promptHash(system: string, user: string, domains: string[], recency: string): string {
  return crypto
    .createHash("sha256")
    .update(`sonar|${system}|${user}|${domains.join(",")}|${recency}`)
    .digest("hex");
}

async function getCached(key: string): Promise<SonarResult | null> {
  try {
    const row = await storage.getCache(key);
    if (!row) return null;
    const payload: any = (row as any).payloadJson ?? (row as any).payload ?? row;
    const data = typeof payload === "string" ? (JSON.parse(payload) as SonarResult) : (payload as SonarResult);
    return { ...data, cacheHit: true };
  } catch {
    return null;
  }
}

async function setCached(key: string, value: SonarResult, ttlSeconds: number): Promise<void> {
  try {
    const expires = new Date(Date.now() + ttlSeconds * 1000);
    await storage.setCache(key, value, expires, "sonar");
  } catch {
    /* cache failures are non-fatal */
  }
}

/** Normalize Sonar (top-level) and Agent API (output[] search_results) citation shapes. */
function extractCitations(json: any): SonarCitation[] {
  const out: SonarCitation[] = [];
  const push = (r: any) => {
    const url = typeof r === "string" ? r : r?.url;
    if (!url || out.some((e) => e.url === url)) return;
    out.push({
      title: typeof r === "string" ? undefined : r.title,
      url,
      date: typeof r === "string" ? undefined : r.date,
      snippet: typeof r === "string" ? undefined : r.snippet,
    });
  };

  // Agent API: typed output items
  const output = json?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (item?.type === "search_results" && Array.isArray(item.results)) {
        for (const r of item.results) push(r);
      }
      if (item?.type === "fetch_url_results" && Array.isArray(item.contents)) {
        for (const r of item.contents) push(r);
      }
    }
  }

  // Legacy Sonar: top-level search_results / citations
  if (Array.isArray(json?.search_results)) {
    for (const r of json.search_results) push(r);
  }
  if (Array.isArray(json?.citations)) {
    for (const c of json.citations) push(c);
  }
  return out;
}

/** Agent: output_text, else walk output[] message content[].text. Sonar: choices[0]. */
function extractText(json: any): string {
  if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text;
  const output = json?.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (item?.type !== "message") continue;
      const content = item.content;
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return json?.choices?.[0]?.message?.content ?? "";
}

function extractUsage(json: any): { tokensIn: number; tokensOut: number; billedCost: number | null } {
  const u = json?.usage || {};
  const tokensIn = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
  const tokensOut = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
  const billed = u?.cost?.total_cost;
  return {
    tokensIn,
    tokensOut,
    billedCost: typeof billed === "number" && Number.isFinite(billed) ? billed : null,
  };
}

async function postJson(url: string, apiKey: string, body: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 400)}`);
  let json: any;
  try { json = JSON.parse(txt); } catch {
    throw new Error(`non-JSON response: ${txt.slice(0, 200)}`);
  }
  // Agent API returns HTTP 200 for failed/cancelled runs — branch on status.
  if (json?.status === "failed" || json?.status === "cancelled") {
    const err = json?.error?.message || json?.error || json.status;
    throw new Error(`agent status=${json.status}: ${err}`);
  }
  return json;
}

function agentBody(req: SonarRequest, domains: string[], recency: string, maxOut: number): Record<string, unknown> {
  const filters: Record<string, unknown> = { search_recency_filter: recency };
  if (domains.length > 0) filters.search_domain_filter = domains;
  return {
    preset: AGENT_PRESET,
    instructions: req.systemPrompt,
    input: req.userPrompt,
    max_output_tokens: maxOut,
    // Search is OFF unless web_search is offered. Force it — every call site
    // (policy scan, report digest, name-news) is citation-critical.
    tools: [{ type: "web_search", filters }],
    tool_choice: { type: "web_search" },
  };
}

function sonarBody(req: SonarRequest, domains: string[], recency: string, maxOut: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: SONAR_MODEL,
    max_tokens: maxOut,
    messages: [
      { role: "system", content: req.systemPrompt },
      { role: "user", content: req.userPrompt },
    ],
    return_citations: true,
    search_recency_filter: recency,
  };
  if (domains.length > 0) body.search_domain_filter = domains;
  return body;
}

export async function querySonar(req: SonarRequest): Promise<SonarResult> {
  const domains = req.domains ?? [];
  const recency = req.recency ?? "week";
  // Agent "low" can spend tokens on the tool loop; don't starve the answer.
  const maxOut = req.maxOutputTokens ?? 2400;
  const cacheKey = `sonar:${promptHash(req.systemPrompt, req.userPrompt, domains, recency)}`;
  const ttl = req.cacheTtlSeconds ?? 86_400;

  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const ceiling = await checkCeiling("sonar");
  if (!ceiling.allowed) {
    await recordCall({
      service: "sonar",
      endpoint: "sonar/query",
      actionContext: req.actionContext ?? null,
      model: AGENT_MODEL_LABEL,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      status: "blocked_by_ceiling",
      errorMessage: ceiling.reason,
    });
    throw new Error(`Blocked by cost ceiling: ${ceiling.reason}`);
  }

  const apiKey = await resolveApiKey("sonar");
  if (!apiKey) {
    throw new Error(
      "No API key configured for sonar. Set SONAR_API_KEY on Railway (same as your Perplexity API key), or save it on the Settings page.",
    );
  }

  const t0 = Date.now();
  let json: any;
  let used: "agent" | "sonar" = "agent";
  let lastErr: Error | null = null;

  try {
    json = await postJson(AGENT_URL, apiKey, agentBody(req, domains, recency, maxOut), 90_000);
    if (!extractText(json).trim()) {
      throw new Error("agent returned empty text");
    }
  } catch (err: any) {
    lastErr = err instanceof Error ? err : new Error(String(err));
    if (!sonarFallbackAllowed()) {
      await recordCall({
        service: "sonar",
        endpoint: "agent/query",
        actionContext: req.actionContext ?? null,
        model: AGENT_MODEL_LABEL,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        status: "error",
        latencyMs: Date.now() - t0,
        errorMessage: lastErr.message,
      });
      throw lastErr;
    }
    console.warn(`[sonar] Agent API failed (${lastErr.message.slice(0, 160)}); falling back to Sonar Chat Completions until ${SONAR_SUNSET.toISOString().slice(0, 10)}`);
    try {
      used = "sonar";
      json = await postJson(SONAR_URL, apiKey, sonarBody(req, domains, recency, req.maxOutputTokens ?? 1200), 45_000);
    } catch (fb: any) {
      const msg = `agent: ${lastErr.message} | sonar-fallback: ${fb?.message ?? fb}`;
      await recordCall({
        service: "sonar",
        endpoint: "sonar/query",
        actionContext: req.actionContext ?? null,
        model: AGENT_MODEL_LABEL,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        status: "error",
        latencyMs: Date.now() - t0,
        errorMessage: msg,
      });
      throw new Error(msg);
    }
  }

  const text = extractText(json);
  const { tokensIn, tokensOut, billedCost } = extractUsage(json);
  const citations = extractCitations(json);
  const cost = billedCost ?? estimateCost("sonar-pro", tokensIn, tokensOut);

  await recordCall({
    service: "sonar",
    endpoint: used === "agent" ? "agent/query" : "sonar/query",
    actionContext: req.actionContext ?? null,
    model: used === "agent" ? AGENT_MODEL_LABEL : SONAR_MODEL,
    tokensIn,
    tokensOut,
    costUsd: cost,
    status: "ok",
    latencyMs: Date.now() - t0,
  });

  const out: SonarResult = {
    text,
    citations,
    tokensIn,
    tokensOut,
    costUsd: cost,
    cacheHit: false,
    fetchedAt: new Date().toISOString(),
  };

  void setCached(cacheKey, out, ttl);
  return out;
}

/**
 * Parse a JSON array out of an LLM/Sonar text response that may be wrapped in
 * prose or fenced code blocks. Returns [] on failure (never throws).
 */
export function parseJsonArray<T = any>(text: string): T[] {
  if (!text) return [];
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    return JSON.parse(s.slice(start, end + 1)) as T[];
  } catch {
    return [];
  }
}
