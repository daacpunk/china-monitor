/**
 * Sonar Pro client — live web/news/policy research with citations.
 *
 * Uses the Perplexity Sonar API (chat/completions, model `sonar-pro`). The API
 * key is resolved via keyResolver("sonar") — confirmed by the user to be the SAME
 * key as their Perplexity API key (SONAR_API_KEY on Railway, or saved on Settings).
 *
 * Mirrors server/analysis/llm.ts exactly:
 *   cache check → ceiling check → key check → execute → record → cache.
 * Every call lands in the audit_log and counts against the `sonar` monthly ceiling.
 *
 * Returns parsed text PLUS citations (search_results / citations), so anything that
 * flows into a brief/note/deck can be footnoted with a real source URL.
 */

import crypto from "node:crypto";
import { resolveApiKey } from "../keyResolver";
import { checkCeiling, recordCall, estimateCost } from "../costTracker";
import { storage } from "../storage";

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const SONAR_MODEL = "sonar-pro";

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

/** Normalize the various citation shapes Sonar can return into one list. */
function extractCitations(json: any): SonarCitation[] {
  const out: SonarCitation[] = [];
  // Newer API: search_results[] with {title, url, date, snippet}
  const sr = json?.search_results;
  if (Array.isArray(sr)) {
    for (const r of sr) {
      if (r?.url) out.push({ title: r.title, url: r.url, date: r.date, snippet: r.snippet });
    }
  }
  // Older API: citations[] = array of plain URL strings
  const cites = json?.citations;
  if (Array.isArray(cites)) {
    for (const c of cites) {
      const url = typeof c === "string" ? c : c?.url;
      if (url && !out.some((e) => e.url === url)) out.push({ url });
    }
  }
  return out;
}

export async function querySonar(req: SonarRequest): Promise<SonarResult> {
  const domains = req.domains ?? [];
  const recency = req.recency ?? "week";
  const maxOut = req.maxOutputTokens ?? 1200;
  const cacheKey = `sonar:${promptHash(req.systemPrompt, req.userPrompt, domains, recency)}`;
  const ttl = req.cacheTtlSeconds ?? 86_400;

  // 1. Cache check
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  // 2. Ceiling check
  const ceiling = await checkCeiling("sonar");
  if (!ceiling.allowed) {
    await recordCall({
      service: "sonar",
      endpoint: "sonar/query",
      actionContext: req.actionContext ?? null,
      model: SONAR_MODEL,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      status: "blocked_by_ceiling",
      errorMessage: ceiling.reason,
    });
    throw new Error(`Blocked by cost ceiling: ${ceiling.reason}`);
  }

  // 3. Key check
  const apiKey = await resolveApiKey("sonar");
  if (!apiKey) {
    throw new Error(
      "No API key configured for sonar. Set SONAR_API_KEY on Railway (same as your Perplexity API key), or save it on the Settings page.",
    );
  }

  // 4. Execute
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

  const t0 = Date.now();
  let json: any;
  try {
    const res = await fetch(SONAR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Sonar HTTP ${res.status}: ${txt.slice(0, 400)}`);
    }
    json = await res.json();
  } catch (err: any) {
    await recordCall({
      service: "sonar",
      endpoint: "sonar/query",
      actionContext: req.actionContext ?? null,
      model: SONAR_MODEL,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      status: "error",
      latencyMs: Date.now() - t0,
      errorMessage: err.message,
    });
    throw err;
  }

  const text = json.choices?.[0]?.message?.content ?? "";
  const usage = json.usage || {};
  const tokensIn = usage.prompt_tokens || 0;
  const tokensOut = usage.completion_tokens || 0;
  const citations = extractCitations(json);

  const cost = estimateCost("sonar-pro", tokensIn, tokensOut);
  await recordCall({
    service: "sonar",
    endpoint: "sonar/query",
    actionContext: req.actionContext ?? null,
    model: SONAR_MODEL,
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
  // Strip code fences
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Find first [ ... last ]
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    return JSON.parse(s.slice(start, end + 1)) as T[];
  } catch {
    return [];
  }
}
