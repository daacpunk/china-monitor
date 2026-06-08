/**
 * Policy service — capture, classify, score, and market-link policy updates.
 *
 * Flow (on-demand or pre-report, NO background scan per user decision):
 *   1. scanChannel(): Sonar domain-scoped pull of latest items from a channel's
 *      signal sub-page. Returns raw {title, date, url, summary} items + citations.
 *   2. classifyAndScore(): a cheap LLM pass tags categories/themes, scores
 *      significance (using the channel's signalHint), and proposes market linkage.
 *   3. upsert into policy_updates (idempotent by dedupeKey = hash(url)).
 *
 * Market linkage maps each policy to affected index/sector/name + expected
 * direction + rationale. Observed-move join to price series is computed lazily
 * by the route layer (see attachObservedMoves) so we don't refetch prices here.
 */

import crypto from "node:crypto";
import { querySonar, parseJsonArray } from "../clients/sonar";
import { generateCommentary } from "../analysis/llm";
import { storage } from "../storage";
import {
  CHANNELS_BY_ID,
  POLICY_CHANNELS,
  type PolicyChannel,
  type CoverageTheme,
  type PolicyCategory,
} from "./channels";
import type { InsertPolicyUpdate } from "@shared/schema";

// Equity targets available for linkage (real series ids from the registry).
export const EQUITY_TARGETS = [
  { id: "csi300_close", label: "CSI 300", scope: "index" as const },
  { id: "shc_close", label: "Shanghai Composite", scope: "index" as const },
  { id: "szi_close", label: "Shenzhen Composite", scope: "index" as const },
  { id: "chinext_close", label: "ChiNext", scope: "index" as const },
  { id: "star50_close", label: "STAR 50", scope: "index" as const },
  { id: "hsi_close", label: "Hang Seng", scope: "index" as const },
];

export interface MarketLinkage {
  scope: "index" | "sector" | "name";
  target: string;            // series id (for index) or free label (sector/name)
  expectedDirection: "positive" | "negative" | "mixed" | "neutral";
  rationale: string;
  priced: "not_yet" | "partially" | "fully";
}

export interface RawPolicyItem {
  title: string;
  titleZh?: string;
  date?: string;
  url: string;
  summary: string;
}

function dedupeKey(url: string): string {
  return crypto.createHash("sha256").update(url.trim().toLowerCase()).digest("hex").slice(0, 32);
}

// ── Step 1: Sonar scan of one channel ──────────────────────────────────────────

export async function scanChannel(channel: PolicyChannel, sinceDays = 30): Promise<RawPolicyItem[]> {
  const recency = sinceDays <= 1 ? "day" : sinceDays <= 7 ? "week" : "month";
  const system =
    "You are a research assistant for an institutional China/HK equity strategist. " +
    "Return ONLY factual, sourced policy/regulatory announcements from official Chinese government channels. " +
    "Never invent items. If nothing material, return an empty array. " +
    'Output STRICT JSON: an array of {"title","titleZh","date","url","summary"} objects. No prose, no commentary.';
  const themes = channel.defaultThemes.join(", ");
  const user =
    `List the most recent policy/regulatory announcements from ${channel.name} (${channel.nameZh}, ${channel.domain}) ` +
    `in roughly the last ${sinceDays} days that are relevant to: ${themes}, or to China/HK equity markets. ` +
    `Prefer primary official pages. Analyst focus: ${channel.signalHint} ` +
    `For each item give title (English), titleZh (original if available), date (ISO if known), url (official source), ` +
    `and a neutral 1-2 sentence summary. Return [] if nothing material.`;

  const result = await querySonar({
    systemPrompt: system,
    userPrompt: user,
    actionContext: `policy_scan:${channel.id}`,
    domains: [channel.domain],
    recency: recency as "day" | "week" | "month",
    maxOutputTokens: 1500,
  });

  const items = parseJsonArray<RawPolicyItem>(result.text);
  // Fall back to citations if the model returned prose but cited sources.
  if (items.length === 0 && result.citations.length > 0) {
    return result.citations.slice(0, 8).map((c) => ({
      title: c.title || "(untitled policy item)",
      date: c.date,
      url: c.url,
      summary: c.snippet || "",
    }));
  }
  return items.filter((i) => i && i.url && i.title);
}

// ── Step 2: classify + score + propose linkage (cheap LLM) ──────────────────────

interface Enrichment {
  categories: PolicyCategory[];
  themes: CoverageTheme[];
  significance: "high" | "medium" | "low";
  significanceRationale: string;
  marketLinkage: MarketLinkage[];
}

export async function classifyAndScore(
  channel: PolicyChannel,
  item: RawPolicyItem,
  model: "claude-haiku-4" | "deepseek-chat" = "claude-haiku-4",
): Promise<Enrichment> {
  const targetList = EQUITY_TARGETS.map((t) => `${t.id} (${t.label})`).join(", ");
  const system =
    "You are an institutional China/HK equity strategist classifying a policy item. " +
    "Be precise and conservative. Output STRICT JSON only, no prose.";
  const user =
    `Channel: ${channel.name} (${channel.nameZh}), tier ${channel.tier}.\n` +
    `Analyst focus for this channel: ${channel.signalHint}\n\n` +
    `Policy item:\nTitle: ${item.title}\nDate: ${item.date ?? "unknown"}\nSummary: ${item.summary}\nURL: ${item.url}\n\n` +
    `Classify and return STRICT JSON:\n` +
    `{\n` +
    `  "categories": [subset of: monetary,fiscal,industrial,trade,tech,ai,data_security,antitrust,capital_markets,property,energy,ev,semiconductor,consumer,employment,fx],\n` +
    `  "themes": [subset of: tech,ev,battery,semi,ai,consumer,macro],\n` +
    `  "significance": "high"|"medium"|"low",\n` +
    `  "significanceRationale": "1 sentence, reflect the analyst focus above",\n` +
    `  "marketLinkage": [ {"scope":"index"|"sector"|"name","target":"<for index use one of: ${targetList}; for sector/name use a short label>","expectedDirection":"positive"|"negative"|"mixed"|"neutral","rationale":"why this policy moves this target"} ]\n` +
    `}\n` +
    `Link to specific indices where the impact is clear (e.g. tech policy -> chinext_close/star50_close, HK tech -> hsi_close). Use sector/name linkage for ${channel.defaultThemes.join("/")} when relevant. Keep linkage to the 1-3 most defensible targets.`;

  let enrich: Enrichment = {
    categories: channel.defaultCategories,
    themes: channel.defaultThemes,
    significance: "medium",
    significanceRationale: "",
    marketLinkage: [],
  };

  try {
    const res = await generateCommentary({
      model,
      systemPrompt: system,
      userPrompt: user,
      actionContext: `policy_classify:${channel.id}`,
      maxOutputTokens: 600,
    });
    const parsed = parseJsonObject(res.text);
    if (parsed) {
      enrich = {
        categories: arr(parsed.categories, channel.defaultCategories) as PolicyCategory[],
        themes: arr(parsed.themes, channel.defaultThemes) as CoverageTheme[],
        significance: ["high", "medium", "low"].includes(parsed.significance) ? parsed.significance : "medium",
        significanceRationale: String(parsed.significanceRationale ?? ""),
        marketLinkage: Array.isArray(parsed.marketLinkage)
          ? parsed.marketLinkage
              .filter((l: any) => l && l.target && l.expectedDirection)
              .map((l: any) => ({
                scope: ["index", "sector", "name"].includes(l.scope) ? l.scope : "sector",
                target: String(l.target),
                expectedDirection: ["positive", "negative", "mixed", "neutral"].includes(l.expectedDirection)
                  ? l.expectedDirection
                  : "neutral",
                rationale: String(l.rationale ?? ""),
                priced: "not_yet" as const,
              }))
          : [],
      };
    }
  } catch {
    /* classification failure is non-fatal — keep channel defaults */
  }
  return enrich;
}

// ── Step 3: full scan → enrich → persist ────────────────────────────────────────

export interface ScanReport {
  channelId: string;
  found: number;
  inserted: number;
  skipped: number;
  error?: string;
}

export async function scanAndStore(
  channelId: string,
  sinceDays = 30,
  classifyModel: "claude-haiku-4" | "deepseek-chat" = "claude-haiku-4",
): Promise<ScanReport> {
  const channel = CHANNELS_BY_ID[channelId];
  if (!channel) return { channelId, found: 0, inserted: 0, skipped: 0, error: "unknown channel" };

  let items: RawPolicyItem[];
  try {
    items = await scanChannel(channel, sinceDays);
  } catch (err: any) {
    return { channelId, found: 0, inserted: 0, skipped: 0, error: err.message };
  }

  let inserted = 0;
  let skipped = 0;
  for (const item of items) {
    const key = dedupeKey(item.url);
    const exists = await storage.policyExists(key);
    if (exists) {
      skipped++;
      continue;
    }
    const enrich = await classifyAndScore(channel, item, classifyModel);
    const record: InsertPolicyUpdate = {
      publishedAt: item.date ?? null,
      body: channel.id,
      tier: channel.tier,
      title: item.title,
      titleZh: item.titleZh ?? null,
      url: item.url,
      summary: item.summary,
      categories: enrich.categories,
      themes: enrich.themes,
      significance: enrich.significance,
      significanceRationale: enrich.significanceRationale,
      marketLinkage: enrich.marketLinkage,
      sources: [{ name: channel.name, url: item.url }],
      provenance: "sonar",
      dedupeKey: key,
    };
    await storage.insertPolicyUpdate(record);
    inserted++;
  }
  return { channelId, found: items.length, inserted, skipped };
}

/** Scan multiple channels (sequential to respect rate/cost). */
export async function scanChannels(
  channelIds: string[],
  sinceDays = 30,
  classifyModel: "claude-haiku-4" | "deepseek-chat" = "claude-haiku-4",
): Promise<ScanReport[]> {
  const reports: ScanReport[] = [];
  for (const id of channelIds) {
    reports.push(await scanAndStore(id, sinceDays, classifyModel));
  }
  return reports;
}

// ── helpers ─────────────────────────────────────────────────────────────────────

function parseJsonObject(text: string): any | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function arr<T>(v: any, fallback: T[]): T[] {
  return Array.isArray(v) && v.length > 0 ? v : fallback;
}

export { POLICY_CHANNELS };
