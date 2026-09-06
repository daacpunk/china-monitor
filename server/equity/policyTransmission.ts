/**
 * Policy → Sector → Name transmission (Gap D) — a SYNTHESIS/STRUCTURING layer.
 *
 * No new data sources. For the most recent, significant policy items it stitches
 * together signals that ALREADY exist into an explicit transmission chain:
 *
 *   policy item  →  affected coverage theme(s)  →  live evidence per theme
 *     (trade signal from THEME_TRADE, valuation summary from Gap A,
 *      earnings/momentum summary from Gap B)
 *     →  ranked named A-share beneficiaries / at-risk names (Gap B quadrant)
 *
 * The DETERMINISTIC skeleton (policy, themes, evidence legs, ranked names) is
 * assembled in code. The LLM adds ONLY two grounded fields per chain:
 * `transmissionStrength` (strong|moderate|weak) and a 1-2 sentence `readThrough`
 * narrative. One batched LLM call covers all chains. Never throws — if earnings/
 * valuation/LLM are unavailable, the chain still emits the policy→theme→trade
 * skeleton with a note.
 *
 * Used by the report (sectorDigest), the /api/equity/policy-transmission route
 * (Policy + Sectors UI), and the PPTX deck. 6h cache + forceRefresh. Mirrors the
 * riskDashboard.ts (Gap E) architecture.
 */

import { generateCommentary, type LlmModel } from "../analysis/llm";
import { SECTOR_UNIVERSE, THEMES_BY_ID, type CoverageTheme } from "./universe";
import { buildValuationContext, type NameValuationContext } from "./valuationContext";
import { buildEarningsContext, type NameEarningsContext, type Quadrant } from "./earningsContext";
import { fetchSeries } from "../series/fetchSeries";
import { CHANNELS_BY_ID } from "../policy/channels";
import { storage } from "../storage";
import type { PolicyUpdate } from "@shared/schema";
import { getDefaultReportModel } from "../analysis/modelCatalog";

// Themes that have a featured single-name universe we can rank beneficiaries in.
type UniverseTheme = CoverageTheme;

export type TransmissionStrength = "strong" | "moderate" | "weak";

export interface ThemeEvidence {
  theme: UniverseTheme;
  label: string;
  tradeSignal: string | null;     // live customs/trade line (THEME_TRADE)
  valuationNote: string | null;   // Gap A featured-name PE percentile summary
  earningsNote: string | null;    // Gap B momentum/quadrant summary
}

export interface TransmissionName {
  symbol: string;
  nameEn: string;
  theme: UniverseTheme;
  quadrant: Quadrant | null;
  why: string;
}

export interface PolicyTransmissionChain {
  policy: {
    id: number;
    title: string;
    date: string | null;          // publishedAt
    source: string;               // channel display name
    body: string;                 // channel id
    url: string;
    significance: string;
  };
  affectedThemes: string[];       // coverage themes (may include "macro" → market-wide)
  marketWide: boolean;            // true when only macro themes apply
  evidence: ThemeEvidence[];
  beneficiaries: TransmissionName[];
  atRisk: TransmissionName[];
  transmissionStrength: TransmissionStrength | null; // LLM-assigned, grounded
  readThrough: string | null;                         // LLM narrative
  notes: string[];
}

export interface PolicyTransmission {
  generatedAt: string;
  chains: PolicyTransmissionChain[];
  model: string;
  costUsd: number;
  notes: string[];
}

export interface BuildTransmissionOpts {
  model?: LlmModel;
  maxChains?: number;
  forceRefresh?: boolean;
}

// ── cache (mirror riskDashboard.ts / valuationContext.ts) ────────────────────
const cache = new Map<string, { at: number; value: PolicyTransmission }>();
const TTL = 6 * 60 * 60 * 1000; // 6h
const CACHE_KEY = "policy-transmission";

// Universe themes that earnings/valuation context can rank names in.
const UNIVERSE_THEMES: UniverseTheme[] = SECTOR_UNIVERSE.map((t) => t.id);
const UNIVERSE_THEME_SET = new Set<string>(UNIVERSE_THEMES);

// When a policy is macro/market-wide, surface this representative cross-section
// of themes for the evidence + name ranking (kept small so the deck/UI stay tidy).
const MACRO_PROXY_THEMES: UniverseTheme[] = ["semi", "ai", "ev"];

// Theme → live customs/trade series (mirrors context.ts THEME_TRADE).
const THEME_TRADE: Record<string, { id: string; label: string }[]> = {
  semi: [
    { id: "chips_exports_yoy", label: "Electronics exports YoY" },
    { id: "chips_imports_yoy", label: "Electronics imports YoY" },
  ],
  ai: [{ id: "chips_imports_yoy", label: "Electronics imports YoY" }],
  tech: [
    { id: "chips_exports_yoy", label: "Electronics exports YoY" },
    { id: "machinery_exports_yoy", label: "Machinery exports YoY" },
  ],
  ev: [{ id: "autos_exports_yoy", label: "Vehicle exports YoY" }],
  battery: [{ id: "autos_exports_yoy", label: "Vehicle exports YoY" }],
  consumer: [{ id: "machinery_exports_yoy", label: "Machinery exports YoY" }],
};

// Quadrant ranking for beneficiaries (strongest first).
const QUADRANT_RANK: Record<string, number> = {
  "cheap-improving": 0,
  "cheap-deteriorating": 1,
  "expensive-improving": 1,
  "expensive-deteriorating": 2,
};

const tradeCache = new Map<string, string | null>();
async function tradeLine(id: string, label: string): Promise<string | null> {
  if (tradeCache.has(id)) return tradeCache.get(id) ?? null;
  let out: string | null = null;
  try {
    const r = await fetchSeries(id);
    const last = r.data.length ? r.data[r.data.length - 1] : null;
    if (last && last.value != null) out = `${label}: ${last.value > 0 ? "+" : ""}${last.value}% (${last.date})`;
  } catch {
    out = null;
  }
  tradeCache.set(id, out);
  return out;
}

/** Map a policy item's tags (themes + channel defaults) to coverage themes. */
function affectedThemesFor(u: PolicyUpdate): { themes: UniverseTheme[]; marketWide: boolean } {
  const tags = new Set<string>();
  for (const t of (u.themes as string[]) ?? []) tags.add(t);
  const chan = CHANNELS_BY_ID[u.body];
  if (chan) for (const t of chan.defaultThemes) tags.add(t);

  const universe = UNIVERSE_THEMES.filter((t) => tags.has(t));
  if (universe.length) return { themes: universe, marketWide: false };
  // Only macro / non-universe tags → market-wide; use the proxy cross-section.
  return { themes: [...MACRO_PROXY_THEMES], marketWide: true };
}

function valuationNoteFor(theme: UniverseTheme, vals: NameValuationContext[]): string | null {
  const withPct = vals.filter((c) => c.theme === theme && c.pePercentile != null);
  if (!withPct.length) return null;
  withPct.sort((a, b) => (b.pePercentile ?? -1) - (a.pePercentile ?? -1));
  const top = withPct.slice(0, 2).map((c) => `${c.nameEn} PE ${Math.round(c.pePercentile as number)}th pct`);
  return top.join(", ");
}

function earningsNoteFor(theme: UniverseTheme, earns: NameEarningsContext[]): string | null {
  const withData = earns.filter((c) => c.theme === theme && (c.netProfitYoy != null || c.momentum));
  if (!withData.length) return null;
  withData.sort((a, b) => (b.netProfitYoy ?? -1e9) - (a.netProfitYoy ?? -1e9));
  const top = withData.slice(0, 2).map((c) => {
    const np = c.netProfitYoy != null ? `net-profit YoY ${c.netProfitYoy > 0 ? "+" : ""}${c.netProfitYoy.toFixed(0)}%` : "earnings n/a";
    return `${c.nameEn} ${np}${c.momentum ? ` (${c.momentum})` : ""}`;
  });
  return top.join(", ");
}

/** Rank named A-share beneficiaries / at-risk for the affected themes (Gap B quadrant). */
function rankNames(
  themes: UniverseTheme[],
  earns: NameEarningsContext[],
): { beneficiaries: TransmissionName[]; atRisk: TransmissionName[] } {
  const inThemes = earns.filter((c) => themes.includes(c.theme));

  const scored = inThemes
    .map((c) => ({ c, rank: c.quadrant ? QUADRANT_RANK[c.quadrant] ?? 3 : 3 }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return (b.c.netProfitYoy ?? -1e9) - (a.c.netProfitYoy ?? -1e9);
    });

  const toName = (c: NameEarningsContext, why: string): TransmissionName => ({
    symbol: c.symbol, nameEn: c.nameEn, theme: c.theme, quadrant: c.quadrant, why,
  });

  const whyBenef = (c: NameEarningsContext): string => {
    if (c.quadrant === "cheap-improving") return "cheap valuation + improving earnings momentum";
    if (c.quadrant === "cheap-deteriorating") return "cheap valuation (earnings momentum soft)";
    if (c.quadrant === "expensive-improving") return "improving earnings momentum (valuation full)";
    if (c.momentum === "accelerating" || c.momentum === "inflecting") return `earnings ${c.momentum}`;
    return "featured name in an affected theme";
  };
  const whyRisk = (c: NameEarningsContext): string => {
    if (c.quadrant === "expensive-deteriorating") return "expensive valuation + deteriorating earnings";
    if (c.netProfitYoy != null && c.netProfitYoy < 0) return `net-profit YoY ${c.netProfitYoy.toFixed(0)}%`;
    if (c.momentum === "decelerating") return "earnings decelerating";
    return "stretched / softening in an affected theme";
  };

  const beneficiaries = scored
    .filter(({ c, rank }) => rank <= 1 || c.momentum === "accelerating" || c.momentum === "inflecting")
    .slice(0, 4)
    .map(({ c }) => toName(c, whyBenef(c)));

  const benefKeys = new Set(beneficiaries.map((b) => `${b.symbol}|${b.theme}`));
  const atRisk = inThemes
    .filter((c) => c.quadrant === "expensive-deteriorating" || (c.netProfitYoy != null && c.netProfitYoy < 0) || c.momentum === "decelerating")
    .filter((c) => !benefKeys.has(`${c.symbol}|${c.theme}`)) // don't list a beneficiary as at-risk too
    .sort((a, b) => (a.netProfitYoy ?? 1e9) - (b.netProfitYoy ?? 1e9))
    .slice(0, 3)
    .map((c) => toName(c, whyRisk(c)));

  // When earnings data is absent (quadrants null), fall back to a couple of
  // featured leaders per theme so the chain still names beneficiaries.
  if (!beneficiaries.length) {
    const fallback: TransmissionName[] = [];
    for (const th of themes) {
      const theme = THEMES_BY_ID[th];
      if (!theme) continue;
      const lead = theme.names.find((n) => n.market === "ashare");
      if (lead) fallback.push({ symbol: lead.symbol, nameEn: lead.nameEn, theme: th, quadrant: null, why: `featured ${theme.label} name (earnings context unavailable)` });
      if (fallback.length >= 3) break;
    }
    return { beneficiaries: fallback, atRisk };
  }

  return { beneficiaries, atRisk };
}

// ── policy selection ─────────────────────────────────────────────────────────

const sigRank: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Pick the top recent policy items, preferring non-macro (theme-tagged) ones. */
function pickPolicies(updates: PolicyUpdate[], maxChains: number): PolicyUpdate[] {
  const hasUniverseTheme = (u: PolicyUpdate) =>
    ((u.themes as string[]) ?? []).some((t) => UNIVERSE_THEME_SET.has(t)) ||
    (CHANNELS_BY_ID[u.body]?.defaultThemes ?? []).some((t) => UNIVERSE_THEME_SET.has(t));

  const bySig = (a: PolicyUpdate, b: PolicyUpdate) => {
    const s = (sigRank[a.significance] ?? 3) - (sigRank[b.significance] ?? 3);
    if (s !== 0) return s;
    return String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""));
  };

  const themed = updates.filter(hasUniverseTheme).sort(bySig);
  const macro = updates.filter((u) => !hasUniverseTheme(u)).sort(bySig);
  // Prefer themed (clearer transmission), fall back to macro to fill the quota.
  return [...themed, ...macro].slice(0, maxChains);
}

// ── LLM synthesis (strength + read-through only) ──────────────────────────────

function chainSkeletonForPrompt(chain: PolicyTransmissionChain, i: number): string {
  const ev = chain.evidence.map((e) => {
    const legs = [e.tradeSignal, e.valuationNote && `valuation: ${e.valuationNote}`, e.earningsNote && `earnings: ${e.earningsNote}`].filter(Boolean);
    return `      ${e.label}: ${legs.length ? legs.join(" | ") : "no live evidence legs available"}`;
  }).join("\n");
  const ben = chain.beneficiaries.map((b) => `${b.nameEn} [${b.symbol}, ${b.theme}${b.quadrant ? `, ${b.quadrant}` : ""}]`).join("; ") || "none ranked";
  const risk = chain.atRisk.map((b) => `${b.nameEn} [${b.symbol}, ${b.theme}${b.quadrant ? `, ${b.quadrant}` : ""}]`).join("; ") || "none";
  return (
    `CHAIN ${i}:\n` +
    `  Policy: [${chain.policy.source}|${chain.policy.significance}] ${chain.policy.title} (${chain.policy.date ?? "date n/a"})\n` +
    `  Affected themes: ${chain.affectedThemes.join(", ")}${chain.marketWide ? " (market-wide / macro)" : ""}\n` +
    `  Evidence per theme:\n${ev || "      (none)"}\n` +
    `  Ranked beneficiaries: ${ben}\n` +
    `  At-risk: ${risk}`
  );
}

async function synthesize(
  chains: PolicyTransmissionChain[],
  model: LlmModel,
): Promise<{ cost: number; note?: string }> {
  if (!chains.length) return { cost: 0 };
  const skeleton = chains.map((c, i) => chainSkeletonForPrompt(c, i)).join("\n\n");
  const system =
    "You are an institutional China/HK equity strategist mapping policy transmission. " +
    "For EACH numbered chain you are given a deterministic skeleton (the policy, the affected themes, the live evidence legs, and the code-ranked beneficiaries/at-risk names). " +
    "Do NOT invent names, numbers, or themes — use ONLY what is in the skeleton. " +
    "Assign a transmissionStrength reflecting how DIRECT and well-supported the policy→theme→name link is: " +
    "'strong' = directly targets the theme with corroborating live evidence; 'moderate' = plausible but indirect or mixed evidence; 'weak' = market-wide/macro or thin evidence. " +
    "Write a 1-2 sentence readThrough connecting policy → theme → evidence → the named beneficiary(ies). " +
    "Output STRICT JSON ONLY, no prose, no markdown fences.";
  const user =
    `=== TRANSMISSION SKELETONS ===\n${skeleton}\n=== END ===\n\n` +
    `Produce STRICT JSON:\n` +
    `{ "chains": [ {"index":<int matching CHAIN n>, "transmissionStrength":"strong|moderate|weak", "readThrough":"1-2 sentences grounded in the skeleton"} ] }\n` +
    `Return one object per chain (indices 0..${chains.length - 1}).`;

  try {
    const res = await generateCommentary({
      model,
      systemPrompt: system,
      userPrompt: user,
      actionContext: "policy_transmission",
      maxOutputTokens: 1800,
    });
    const obj = extractJsonObject(res.text);
    const arr = obj && Array.isArray(obj.chains) ? obj.chains : [];
    for (const item of arr) {
      const idx = Math.round(Number(item?.index));
      if (!Number.isFinite(idx) || idx < 0 || idx >= chains.length) continue;
      const strength = String(item?.transmissionStrength ?? "").toLowerCase();
      if (strength === "strong" || strength === "moderate" || strength === "weak") {
        chains[idx].transmissionStrength = strength as TransmissionStrength;
      }
      const rt = String(item?.readThrough ?? "").trim();
      if (rt) chains[idx].readThrough = rt.slice(0, 400);
    }
    if (!arr.length) return { cost: res.costUsd, note: "LLM synthesis returned no parseable chains; skeleton-only." };
    return { cost: res.costUsd };
  } catch (e: any) {
    return { cost: 0, note: `LLM synthesis unavailable (${e?.message ?? "unknown"}); skeleton-only.` };
  }
}

// ── build ─────────────────────────────────────────────────────────────────────

/**
 * Build the policy→sector→name transmission chains. Never throws — degrades to
 * the deterministic skeleton (with notes) if earnings/valuation/LLM are down.
 */
export async function buildPolicyTransmission(
  opts: BuildTransmissionOpts = {},
): Promise<PolicyTransmission> {
  const model = opts.model ?? (await getDefaultReportModel());
  const maxChains = Math.max(1, Math.min(8, opts.maxChains ?? 5));

  const cached = cache.get(CACHE_KEY);
  if (!opts.forceRefresh && cached && Date.now() - cached.at < TTL) return cached.value;

  const notes: string[] = [];

  let updates: PolicyUpdate[] = [];
  try {
    updates = await storage.listPolicyUpdates({ limit: 40 });
  } catch (e: any) {
    notes.push(`Policy items unavailable (${e?.message ?? "unknown"}).`);
  }
  const picked = pickPolicies(updates, maxChains);

  if (!picked.length) {
    const empty: PolicyTransmission = {
      generatedAt: new Date().toISOString(),
      chains: [],
      model,
      costUsd: 0,
      notes: [...notes, "No policy items scanned yet — run the Policy Tracker to populate transmission chains."],
    };
    return empty; // not cached (transient empty)
  }

  // Which universe themes do we actually need evidence/names for?
  const neededThemes = new Set<UniverseTheme>();
  const perPolicy = picked.map((u) => {
    const { themes, marketWide } = affectedThemesFor(u);
    themes.forEach((t) => neededThemes.add(t));
    return { u, themes, marketWide };
  });
  const themeList = Array.from(neededThemes);

  // Reuse Gap A + Gap B context (do NOT recompute valuations/earnings).
  const [vals, earns] = await Promise.all([
    buildValuationContext(themeList.length ? themeList : undefined, 8).catch((e: any) => {
      notes.push(`Valuation context unavailable (${e?.message ?? "unknown"}).`);
      return [] as NameValuationContext[];
    }),
    buildEarningsContext(themeList.length ? themeList : undefined, 8, opts.forceRefresh).catch((e: any) => {
      notes.push(`Earnings context unavailable (${e?.message ?? "unknown"}).`);
      return [] as NameEarningsContext[];
    }),
  ]);

  // Assemble deterministic chains.
  const chains: PolicyTransmissionChain[] = [];
  for (const { u, themes, marketWide } of perPolicy) {
    const evidence: ThemeEvidence[] = [];
    for (const th of themes) {
      const theme = THEMES_BY_ID[th];
      const refs = THEME_TRADE[th] ?? [];
      const tradeVals = (await Promise.all(refs.map((r) => tradeLine(r.id, r.label)))).filter(Boolean) as string[];
      evidence.push({
        theme: th,
        label: theme?.label ?? th,
        tradeSignal: tradeVals.length ? tradeVals.join("; ") : null,
        valuationNote: valuationNoteFor(th, vals),
        earningsNote: earningsNoteFor(th, earns),
      });
    }
    const { beneficiaries, atRisk } = rankNames(themes, earns);
    const chan = CHANNELS_BY_ID[u.body];
    const chainNotes: string[] = [];
    if (!earns.length) chainNotes.push("Earnings context unavailable; beneficiaries fall back to featured leaders.");
    if (marketWide) chainNotes.push("Market-wide / macro policy — themes shown are a representative cross-section.");

    chains.push({
      policy: {
        id: u.id,
        title: u.title,
        date: u.publishedAt,
        source: chan?.name ?? u.body.toUpperCase(),
        body: u.body,
        url: u.url,
        significance: u.significance,
      },
      affectedThemes: themes,
      marketWide,
      evidence,
      beneficiaries,
      atRisk,
      transmissionStrength: null,
      readThrough: null,
      notes: chainNotes,
    });
  }

  // LLM adds only strength + read-through (grounded in the skeleton).
  const syn = await synthesize(chains, model);
  if (syn.note) notes.push(syn.note);

  const value: PolicyTransmission = {
    generatedAt: new Date().toISOString(),
    chains,
    model,
    costUsd: syn.cost,
    notes,
  };

  // Cache only when we actually produced chains.
  if (chains.length) cache.set(CACHE_KEY, { at: Date.now(), value });
  return value;
}

// ── serializers (mirror riskDashboardLine / riskDashboardDigest) ─────────────

/** One-line human summary of a transmission chain for the report digest. */
export function policyTransmissionLine(chain: PolicyTransmissionChain): string {
  const strength = chain.transmissionStrength ? `[${chain.transmissionStrength}] ` : "";
  const themes = chain.affectedThemes.join("/")
    + (chain.marketWide ? " (market-wide)" : "");
  const ben = chain.beneficiaries.slice(0, 3).map((b) => `${b.nameEn}${b.quadrant ? ` (${b.quadrant})` : ""}`).join(", ") || "n/a";
  const risk = chain.atRisk.length ? ` | at-risk: ${chain.atRisk.slice(0, 2).map((b) => b.nameEn).join(", ")}` : "";
  const evShort = chain.evidence
    .map((e) => e.tradeSignal || e.earningsNote || e.valuationNote)
    .filter(Boolean)
    .slice(0, 2)
    .join("; ");
  const ev = evShort ? ` | evidence: ${evShort}` : "";
  const rt = chain.readThrough ? ` — ${chain.readThrough}` : "";
  return `${strength}${chain.policy.source}: ${chain.policy.title} → ${themes} → beneficiaries: ${ben}${risk}${ev}${rt}`;
}

/** Multi-line digest of all chains for embedding in sectorDigest. */
export function policyTransmissionDigest(pt: PolicyTransmission): string {
  if (!pt.chains.length) return "";
  return pt.chains.map((c) => `  - ${policyTransmissionLine(c)}`).join("\n");
}

// ── tolerant JSON parsing (mirrors riskDashboard.ts) ─────────────────────────
function stripFence(text: string): string {
  let s = (text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

function repairCandidates(snippet: string): string[] {
  const commits: { end: number; stack: string[] }[] = [];
  const stack: string[] = [];
  let inStr = false, esc = false, expectKey = false;
  const commit = (end: number) => commits.push({ end, stack: [...stack] });
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') {
        inStr = false;
        if (!expectKey) commit(i + 1);
      }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { stack.push("{"); expectKey = true; }
    else if (ch === "[") { stack.push("["); expectKey = false; }
    else if (ch === "}" || ch === "]") { stack.pop(); commit(i + 1); expectKey = false; }
    else if (ch === ":") { expectKey = false; }
    else if (ch === ",") { expectKey = stack[stack.length - 1] === "{"; }
    else if (/[\d.eE+\-]|t|r|u|e|f|a|l|s|n/.test(ch)) {
      const next = snippet[i + 1];
      if (next === undefined || /[\s,}\]]/.test(next)) commit(i + 1);
    }
  }
  const out: string[] = [];
  for (let k = commits.length - 1; k >= 0; k--) {
    const { end, stack: st } = commits[k];
    let s = snippet.slice(0, end);
    for (let j = st.length - 1; j >= 0; j--) s += st[j] === "[" ? "]" : "}";
    out.push(s);
  }
  return out;
}

function extractJsonObject(text: string): any | null {
  const s = stripFence(text);
  const a = s.indexOf("{");
  if (a === -1) return null;
  const b = s.lastIndexOf("}");
  const candidate = b > a ? s.slice(a, b + 1) : s.slice(a);
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  for (const repaired of repairCandidates(s.slice(a))) {
    try { return JSON.parse(repaired); } catch { /* try the next-earlier commit point */ }
  }
  return null;
}
