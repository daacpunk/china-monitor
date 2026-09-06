/**
 * Scenario & Risk framing (Gap E) — turns the evidence base into a scored,
 * machine-readable risk dashboard + structured bull/base/bear scenarios.
 *
 * Portfolio-level block + one block per coverage theme. Each block carries:
 *   - 5-7 scored risks (likelihood × impact), each grounded in a LIVE series
 *     (macro drivers, valuation-context percentiles, sector flows) that we
 *     assemble into the prompt and cite by name/value.
 *   - bull/base/bear scenarios with triggers + key drivers + (optional) probability.
 *   - a thesis `falsification` list — concrete observations that would prove the
 *     thesis wrong.
 *
 * Scores + narrative are LLM-generated each refresh (grounded, not rule-based).
 * The bear case / downside reasoning incorporates the red-team personas
 * (buildRedTeamPrompt; default panel marks/pettis/collier/druckenmiller).
 *
 * Used by the report (sectorDigest), the /api/equity/risk-dashboard route
 * (Sectors UI), and the PPTX/deck "Scenarios & Risk" section. Best-effort +
 * cached ~6h: never throws to the caller — missing data returns a partial block
 * with notes. Mirrors valuationContext.ts (Gap A).
 */

import { generateCommentary, type LlmModel } from "../analysis/llm";
import { buildRedTeamPrompt } from "../analysis/personas";
import { SECTOR_UNIVERSE, THEMES_BY_ID, type CoverageTheme } from "./universe";
import { buildValuationContext, valuationContextLine, type NameValuationContext } from "./valuationContext";
import { fetchSeries } from "../series/fetchSeries";
import { getAkshareSectorFlows } from "../clients/akshare";
import { getDefaultReportModel } from "../analysis/modelCatalog";

export type RiskCategory =
  | "macro" | "structural" | "policy" | "valuation" | "flow" | "geopolitical";

export interface Risk {
  id: string;
  title: string;
  category: RiskCategory;
  likelihood: number;        // 1-5 int
  impact: number;            // 1-5 int
  score: number;             // likelihood * impact
  trigger: string;           // what would make it fire
  evidence: string;          // grounded in a live series; cites name/value
  mitigants: string;
}

export interface Scenario {
  label: "bull" | "base" | "bear";
  narrative: string;
  triggers: string[];
  probability: number | null; // 0-100, optional
  keyDrivers: string[];
}

export interface RiskBlock {
  scope: "portfolio" | CoverageTheme;
  theme: CoverageTheme | null; // machine-readable theme id; null for the portfolio block
  label: string;
  risks: Risk[];
  scenarios: Scenario[];
  falsification: string[];    // observations that would prove the thesis wrong
  notes: string[];            // degradation notes (series/sidecar unavailable, parse fail…)
}

export interface RiskDashboard {
  generatedAt: string;
  themes: CoverageTheme[];
  portfolio: RiskBlock;
  blocks: RiskBlock[];        // one per requested theme
  model: string;
  costUsd: number;
}

export interface BuildRiskOpts {
  model?: LlmModel;
  redTeamPanel?: string[];    // defaults to DEFAULT_REDTEAM_PANEL via buildRedTeamPrompt
}

const VALID_CATEGORIES: RiskCategory[] = ["macro", "structural", "policy", "valuation", "flow", "geopolitical"];

// ── cache (mirror valuationContext.ts) ───────────────────────────────────────
const cache = new Map<string, { at: number; block: RiskBlock }>();
const TTL = 6 * 60 * 60 * 1000; // 6h

function clamp15(n: any): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(5, v));
}

function clampProb(n: any): number | null {
  if (n == null) return null;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

function strArr(a: any, max = 6): string[] {
  if (!Array.isArray(a)) return [];
  return a.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max);
}

// ── evidence assembly (live series, grounded) ────────────────────────────────

const MACRO_EVIDENCE = [
  { id: "ppi_yoy", label: "PPI YoY" },
  { id: "cpi_yoy", label: "CPI YoY" },
  { id: "retail_sales_yoy", label: "Retail sales YoY" },
  { id: "m2_yoy", label: "M2 YoY" },
  { id: "usdcny_monthly", label: "USD/CNY" },
  { id: "exports_yoy", label: "Exports YoY" },
  { id: "imports_yoy", label: "Imports YoY" },
];

const THEME_TRADE_EVIDENCE: Record<string, { id: string; label: string }[]> = {
  semi: [{ id: "chips_exports_yoy", label: "Electronics exports YoY" }, { id: "chips_imports_yoy", label: "Electronics imports YoY" }],
  ai: [{ id: "chips_imports_yoy", label: "Electronics imports YoY" }],
  tech: [{ id: "chips_exports_yoy", label: "Electronics exports YoY" }, { id: "machinery_exports_yoy", label: "Machinery exports YoY" }],
  ev: [{ id: "autos_exports_yoy", label: "Vehicle exports YoY" }],
  battery: [{ id: "autos_exports_yoy", label: "Vehicle exports YoY" }],
  consumer: [{ id: "machinery_exports_yoy", label: "Machinery exports YoY" }],
};

async function seriesLine(id: string, label: string): Promise<string | null> {
  try {
    const r = await fetchSeries(id);
    const last = r.data.length ? r.data[r.data.length - 1] : null;
    if (!last || last.value == null) return null;
    const src = (r.provenance as any)?.source ?? "?";
    return `${label}: ${last.value > 0 ? "+" : ""}${last.value} (${last.date}) [${src}]`;
  } catch {
    return null;
  }
}

interface AssembledEvidence {
  macroLines: string[];
  valByTheme: Map<string, NameValuationContext[]>;
  flowLines: string[];
  notes: string[];
}

/** Pull the live series once, shared across all blocks for this refresh. */
async function assembleEvidence(themes: CoverageTheme[]): Promise<AssembledEvidence> {
  const notes: string[] = [];

  const [macroLines, vctx, flows] = await Promise.all([
    Promise.all(MACRO_EVIDENCE.map((m) => seriesLine(m.id, m.label))).then((xs) => xs.filter((x): x is string => !!x)),
    buildValuationContext(themes.length ? themes : undefined, 8).catch(() => [] as NameValuationContext[]),
    getAkshareSectorFlows("今日").catch(() => ({ source: "akshare" as const, data: [], fetchedAt: "", error: "unavailable" })),
  ]);

  if (!macroLines.length) notes.push("Macro series unavailable for this refresh.");

  const valByTheme = new Map<string, NameValuationContext[]>();
  for (const c of vctx) {
    if (c.peTtm == null && c.pb == null) continue;
    const arr = valByTheme.get(c.theme) ?? [];
    arr.push(c);
    valByTheme.set(c.theme, arr);
  }
  if (!vctx.length) notes.push("Valuation context unavailable (sidecar may be down).");

  // Top sector inflows/outflows from the live flows snapshot (intermittent upstream).
  const flowLines: string[] = [];
  const rows = (flows as any).data as { sector: string; main_net_inflow?: number; change_pct_today?: number }[];
  if (rows && rows.length) {
    const sorted = [...rows].filter((r) => typeof r.main_net_inflow === "number").sort((a, b) => (b.main_net_inflow ?? 0) - (a.main_net_inflow ?? 0));
    const top = sorted.slice(0, 3).map((r) => `${r.sector} +${((r.main_net_inflow ?? 0) / 1e8).toFixed(1)}亿`);
    const bot = sorted.slice(-3).reverse().map((r) => `${r.sector} ${((r.main_net_inflow ?? 0) / 1e8).toFixed(1)}亿`);
    if (top.length) flowLines.push(`Top sector inflows (today, EastMoney): ${top.join("; ")}`);
    if (bot.length) flowLines.push(`Top sector outflows (today): ${bot.join("; ")}`);
  } else {
    notes.push("Sector fund flows unavailable (EastMoney intermittent).");
  }

  return { macroLines, valByTheme, flowLines, notes };
}

function evidenceBlockFor(scope: "portfolio" | CoverageTheme, ev: AssembledEvidence): string {
  const parts: string[] = [];
  parts.push(`MACRO DRIVERS (live):\n${ev.macroLines.length ? ev.macroLines.map((l) => `  - ${l}`).join("\n") : "  (unavailable)"}`);
  if (ev.flowLines.length) parts.push(`FLOWS:\n${ev.flowLines.map((l) => `  - ${l}`).join("\n")}`);

  if (scope === "portfolio") {
    const valLines: string[] = [];
    for (const t of SECTOR_UNIVERSE) {
      const cs = ev.valByTheme.get(t.id) ?? [];
      const top = cs.filter((c) => c.pePercentile != null).sort((a, b) => (b.pePercentile ?? -1) - (a.pePercentile ?? -1)).slice(0, 2);
      for (const c of top) valLines.push(`[${t.id}] ${valuationContextLine(c)}`);
    }
    if (valLines.length) parts.push(`VALUATION CONTEXT (most-stretched names per theme):\n${valLines.slice(0, 12).map((l) => `  - ${l}`).join("\n")}`);
    parts.push(`COVERAGE THEMES: ${SECTOR_UNIVERSE.map((t) => t.label).join(", ")}.`);
  } else {
    const theme = THEMES_BY_ID[scope];
    if (theme) {
      parts.push(`THEME: ${theme.label}. Structural/policy drivers: ${theme.drivers.join("; ")}.`);
      const cs = (ev.valByTheme.get(scope) ?? []).filter((c) => c.peTtm != null || c.pb != null);
      if (cs.length) parts.push(`VALUATION CONTEXT (theme names):\n${cs.slice(0, 8).map((c) => `  - ${valuationContextLine(c)}`).join("\n")}`);
      const names = theme.names.map((n) => `${n.nameEn} [${n.symbol}, ${n.role}]: ${n.thesis}`).join("; ");
      parts.push(`NAMES: ${names}`);
    }
  }
  return parts.join("\n\n");
}

// ── LLM generation (per block) ───────────────────────────────────────────────

function baseThesisFor(scope: "portfolio" | CoverageTheme): string {
  if (scope === "portfolio")
    return "China/HK equities are a constructive multi-theme allocation: policy support, AI/localization capex, and selective valuation re-rating outweigh macro and geopolitical drags over the next 6-12 months.";
  const theme = THEMES_BY_ID[scope];
  return `The ${theme?.label ?? scope} theme is an attractive China/HK exposure over the next 6-12 months, driven by ${(theme?.drivers ?? []).slice(0, 2).join(" and ")}.`;
}

async function genBlock(
  scope: "portfolio" | CoverageTheme,
  ev: AssembledEvidence,
  opts: BuildRiskOpts,
): Promise<{ block: RiskBlock; cost: number }> {
  const cacheKey = `risk:${scope}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL) return { block: cached.block, cost: 0 };

  const label = scope === "portfolio" ? "Portfolio" : (THEMES_BY_ID[scope]?.label ?? scope);
  const theme: CoverageTheme | null = scope === "portfolio" ? null : (scope as CoverageTheme);
  const block: RiskBlock = { scope, theme, label, risks: [], scenarios: [], falsification: [], notes: [...ev.notes] };

  const evidence = evidenceBlockFor(scope, ev);
  const baseThesis = baseThesisFor(scope);

  // Two independent LLM calls so neither half can starve the other on the token
  // budget (the earlier single-call version truncated before scenarios/
  // falsification). Both share the same red-team-seeded grounding.
  const [risksRes, scenRes] = await Promise.all([
    genRisks(scope, label, evidence, baseThesis, opts).catch((e: any) => ({ risks: [] as Risk[], cost: 0, note: `Risks generation failed: ${e?.message ?? "unknown"}.` })),
    genScenariosBlock(scope, label, evidence, baseThesis, opts).catch((e: any) => ({ scenarios: [] as Scenario[], falsification: [] as string[], cost: 0, note: `Scenarios generation failed: ${e?.message ?? "unknown"}.` })),
  ]);

  block.risks = risksRes.risks;
  block.scenarios = scenRes.scenarios;
  block.falsification = scenRes.falsification;
  if ((risksRes as any).note) block.notes.push((risksRes as any).note);
  if ((scenRes as any).note) block.notes.push((scenRes as any).note);
  if (!block.risks.length && !block.scenarios.length && !block.notes.some((n) => n.includes("failed"))) {
    block.notes.push("Model output could not be parsed; block is empty.");
  }

  // Only cache a block that actually populated something (so a transient empty
  // refresh doesn't get pinned for 6h).
  if (block.risks.length || block.scenarios.length) cache.set(cacheKey, { at: Date.now(), block });

  return { block, cost: risksRes.cost + scenRes.cost };
}

/** Call 1: scored risks only (grounded + red-team seeded). */
async function genRisks(
  scope: "portfolio" | CoverageTheme,
  label: string,
  evidence: string,
  baseThesis: string,
  opts: BuildRiskOpts,
): Promise<{ risks: Risk[]; cost: number; note?: string }> {
  const model = opts.model ?? (await getDefaultReportModel());
  const { system: rtSystem, user: rtUser, panel } = buildRedTeamPrompt({
    baseThesis,
    context: evidence.slice(0, 8000),
    panel: opts.redTeamPanel,
    focusHint: `China/HK equity ${scope === "portfolio" ? "portfolio" : label} risk scoring`,
  });
  const panelNames = panel.map((p) => p.name).join(", ");

  const system =
    rtSystem +
    "\n\nNOW ACT AS the risk officer who, after hearing this devil's-advocate panel, produces a STRUCTURED, " +
    "SCORED risk register for an institutional China/HK equity strategist. " +
    "Ground EVERY risk's evidence in a SPECIFIC live series value from the EVIDENCE BASE (cite the series name and value); " +
    "do not invent data. The higher-scored risks must reflect the panel's strongest objections. " +
    "Output STRICT JSON ONLY, no prose, no markdown fences.";
  const user =
    `${rtUser}\n\n` +
    `=== EVIDENCE BASE (${scope}) ===\n${evidence}\n=== END EVIDENCE BASE ===\n\n` +
    `Produce STRICT JSON for the ${scope === "portfolio" ? "overall portfolio" : `"${label}" theme`}:\n` +
    `{ "risks": [ {"title","category":"macro|structural|policy|valuation|flow|geopolitical","likelihood":1-5,"impact":1-5,"trigger":"what would make it fire","evidence":"cite a specific live series name+value from the EVIDENCE BASE","mitigants":"what offsets it"} ] }  // 5-7 risks\n` +
    `Rules: likelihood/impact are integers 1-5. The bear/high-score risks must channel the panel (${panelNames}). Evidence MUST reference a real series value above.`;

  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: `risk_dashboard_risks:${scope}`,
    maxOutputTokens: 2400,
  });
  const obj = extractJsonObject(res.text);
  return { risks: obj ? parseRisks(obj.risks, scope) : [], cost: res.costUsd };
}

/** Call 2: bull/base/bear scenarios + falsification only (bear reflects the panel). */
async function genScenariosBlock(
  scope: "portfolio" | CoverageTheme,
  label: string,
  evidence: string,
  baseThesis: string,
  opts: BuildRiskOpts,
): Promise<{ scenarios: Scenario[]; falsification: string[]; cost: number; note?: string }> {
  const model = opts.model ?? (await getDefaultReportModel());
  const { system: rtSystem, user: rtUser, panel } = buildRedTeamPrompt({
    baseThesis,
    context: evidence.slice(0, 8000),
    panel: opts.redTeamPanel,
    focusHint: `China/HK equity ${scope === "portfolio" ? "portfolio" : label} scenario framing`,
  });
  const panelNames = panel.map((p) => p.name).join(", ");

  const system =
    rtSystem +
    "\n\nNOW ACT AS the strategist who, after hearing this devil's-advocate panel, frames STRUCTURED " +
    "bull/base/bear scenarios plus a falsification list for an institutional China/HK equity strategist. " +
    "Ground narratives in the EVIDENCE BASE; cite specific live series values where relevant; do not invent data. " +
    "The BEAR scenario MUST reflect the panel's strongest objections. " +
    "Output STRICT JSON ONLY, no prose, no markdown fences.";
  const user =
    `${rtUser}\n\n` +
    `=== EVIDENCE BASE (${scope}) ===\n${evidence}\n=== END EVIDENCE BASE ===\n\n` +
    `Produce STRICT JSON for the ${scope === "portfolio" ? "overall portfolio" : `"${label}" theme`}:\n` +
    `{\n` +
    `  "falsification": [ "concrete observation that would prove the bull/base thesis WRONG", ... ],  // 3-5 items, REQUIRED non-empty — emit FIRST\n` +
    `  "scenarios": [\n` +
    `    {"label":"bull","narrative":"...","triggers":["..."],"probability":0-100 or null,"keyDrivers":["..."]},\n` +
    `    {"label":"base","narrative":"...","triggers":["..."],"probability":0-100 or null,"keyDrivers":["..."]},\n` +
    `    {"label":"bear","narrative":"...","triggers":["..."],"probability":0-100 or null,"keyDrivers":["..."]}\n` +
    `  ]  // EXACTLY these three labels\n` +
    `}\n` +
    `Rules: include all three of bull, base, bear. The bear scenario must channel the panel (${panelNames}). ` +
    `Probabilities across bull/base/bear should sum to ~100 if given. falsification must be non-empty.`;

  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: `risk_dashboard_scenarios:${scope}`,
    maxOutputTokens: 2200,
  });
  const obj = extractJsonObject(res.text);
  return {
    scenarios: obj ? parseScenarios(obj.scenarios) : [],
    falsification: obj ? strArr(obj.falsification, 6) : [],
    cost: res.costUsd,
  };
}

function parseRisks(arr: any, scope: "portfolio" | CoverageTheme): Risk[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r) => r && (r.title || r.trigger))
    .slice(0, 7)
    .map((r, i) => {
      const likelihood = clamp15(r.likelihood);
      const impact = clamp15(r.impact);
      const category: RiskCategory = VALID_CATEGORIES.includes(r.category) ? r.category : "macro";
      return {
        id: `${scope}-r${i + 1}`,
        title: String(r.title ?? "Risk").trim().slice(0, 140),
        category,
        likelihood,
        impact,
        score: likelihood * impact,
        trigger: String(r.trigger ?? "").trim(),
        evidence: String(r.evidence ?? "").trim(),
        mitigants: String(r.mitigants ?? "").trim(),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function parseScenarios(arr: any): Scenario[] {
  if (!Array.isArray(arr)) return [];
  const wanted: Scenario["label"][] = ["bull", "base", "bear"];
  const out: Scenario[] = [];
  for (const label of wanted) {
    const s = arr.find((x: any) => String(x?.label ?? "").toLowerCase() === label);
    if (!s) continue;
    out.push({
      label,
      narrative: String(s.narrative ?? "").trim(),
      triggers: strArr(s.triggers, 6),
      probability: clampProb(s.probability),
      keyDrivers: strArr(s.keyDrivers, 6),
    });
  }
  return out;
}

/**
 * Build the full dashboard: portfolio block + one block per requested theme.
 * Never throws — degrades to partial blocks with notes.
 */
export async function buildRiskDashboard(
  themes?: CoverageTheme[],
  opts: BuildRiskOpts = {},
): Promise<RiskDashboard> {
  const reqThemes = (themes && themes.length ? themes : SECTOR_UNIVERSE.map((t) => t.id)).filter((t) => THEMES_BY_ID[t]);
  const model = opts.model ?? (await getDefaultReportModel());

  let ev: AssembledEvidence;
  try {
    ev = await assembleEvidence(reqThemes);
  } catch (err: any) {
    ev = { macroLines: [], valByTheme: new Map(), flowLines: [], notes: [`Evidence assembly failed: ${err?.message ?? "unknown"}.`] };
  }

  let cost = 0;
  // Portfolio first, then themes sequentially (predictable cost; respects rate limits; cache absorbs repeats).
  const portfolioRes = await genBlock("portfolio", ev, opts);
  cost += portfolioRes.cost;

  const blocks: RiskBlock[] = [];
  for (const t of reqThemes) {
    const r = await genBlock(t, ev, opts);
    blocks.push(r.block);
    cost += r.cost;
  }

  return {
    generatedAt: new Date().toISOString(),
    themes: reqThemes,
    portfolio: portfolioRes.block,
    blocks,
    model,
    costUsd: cost,
  };
}

// ── serializers (mirror valuationContextLine) ────────────────────────────────

/** One-line human summary of a risk block for the report digest. */
export function riskDashboardLine(block: RiskBlock): string {
  const topRisks = block.risks.slice(0, 3).map((r) => `${r.title} (${r.category}, L${r.likelihood}×I${r.impact}=${r.score})`).join("; ");
  const bear = block.scenarios.find((s) => s.label === "bear");
  const bull = block.scenarios.find((s) => s.label === "bull");
  const probStr = (s?: Scenario) => (s && s.probability != null ? ` ${s.probability}%` : "");
  const scen = block.scenarios.length
    ? `Scenarios: bull${probStr(bull)} / base${probStr(block.scenarios.find((s) => s.label === "base"))} / bear${probStr(bear)}`
    : "";
  const parts = [
    `${block.label}: top risks — ${topRisks || "n/a"}`,
    scen,
    bear?.narrative ? `Bear: ${bear.narrative.slice(0, 160)}` : "",
    block.falsification.length ? `Falsified if: ${block.falsification.slice(0, 2).join("; ")}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

/** Multi-line digest of an entire dashboard for embedding in sectorDigest. */
export function riskDashboardDigest(dash: RiskDashboard): string {
  const lines: string[] = [];
  lines.push(`  - ${riskDashboardLine(dash.portfolio)}`);
  for (const b of dash.blocks) lines.push(`  - ${riskDashboardLine(b)}`);
  return lines.join("\n");
}

// ── tolerant JSON parsing (mirrors strategyNote.ts helpers) ──────────────────
function stripFence(text: string): string {
  let s = (text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

/**
 * Repair a truncated JSON object so complete leading fields/elements survive a
 * mid-stream cut (the LLM running out of tokens). We scan once, recording the
 * bracket stack at every "commit point" — a position right after a *complete
 * value* (a closing `}`/`]`, the closing quote of a value string, or the end of
 * a primitive). At each commit point the prefix can be made valid by closing
 * the then-open containers. We try those candidates newest-first and return the
 * first that parses, so e.g. a complete `falsification` array plus the complete
 * leading `scenarios` elements are kept even when the last element was cut.
 */
function repairCandidates(snippet: string): string[] {
  const commits: { end: number; stack: string[] }[] = [];
  const stack: string[] = [];
  let inStr = false, esc = false, expectKey = false;
  // expectKey tracks whether the next string is an object key (after { or ,) —
  // a key's closing quote is NOT a commit point; a value string's is.
  const commit = (end: number) => commits.push({ end, stack: [...stack] });
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') {
        inStr = false;
        if (!expectKey) commit(i + 1); // closing quote of a value
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
      // inside a primitive (number/true/false/null); its end is a commit point
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
