/**
 * Strategy Note engine (Phase 3) — section-by-section synthesis, two modes.
 *
 *  Mode A (data_driven):  AI leads from the evidence; builds narrative + strategy +
 *                         a model portfolio of stock picks (from the Phase 2 universe).
 *  Mode B (thesis_driven): user supplies a thesis; AI substantiates with evidence +
 *                         harder Sonar pulls, but is a CRITIC not a yes-man — emits a
 *                         ThesisVerdict (supported/.../insufficient) with contradicting
 *                         evidence, gaps, corrections, alternatives.
 *
 * Each section is its own LLM call (quality + token control). All calls route through
 * generateCommentary() so cost ceilings + audit + 24h cache apply. Every section is
 * regenerable; featured names are guaranteed coverage.
 */

import { generateCommentary, type LlmModel } from "../analysis/llm";
import { buildRedTeamPrompt } from "../analysis/personas";
import { assembleContext, contextToPrompt, type ReportContext } from "./context";
import { SECTOR_UNIVERSE, type CoverageTheme } from "../equity/universe";

export type ComposerMode = "data_driven" | "thesis_driven";

/** Structured scenario (bull/base/bear) for the scenarios section + deck. */
export interface NoteScenario {
  label: "bull" | "base" | "bear";
  narrative: string;
  triggers: string[];
  probability: number | null;
  keyDrivers: string[];
}

/** Structured payload carried by the scenarios section (Gap E). */
export interface ScenarioSet {
  scope: string;            // "portfolio" or a theme id
  scenarios: NoteScenario[];
  falsification: string[];  // what would prove the thesis wrong
}

export interface StrategyNoteSection {
  key: string;
  heading: string;
  body: string;
  sources?: { name: string; url: string }[];
  /** Machine-readable payload (e.g. the scenarios section's bull/base/bear). */
  data?: { scenarioSets?: ScenarioSet[] };
}

export interface PortfolioPick {
  symbol: string;
  nameEn: string;
  theme: string;
  stance: "long" | "avoid" | "watch";
  weight?: number;
  conviction: "low" | "medium" | "high";
  entryRationale: string;
  keyRisk: string;
}

export interface ThesisVerdict {
  verdict: "supported" | "partially_supported" | "not_supported" | "insufficient_evidence";
  confidence: "low" | "medium" | "high";
  supportingEvidence: { point: string; source?: { name: string; url: string } }[];
  contradictingEvidence: { point: string; source?: { name: string; url: string } }[];
  evidenceGaps: string[];
  corrections: string[];
  alternatives: string[];
}

export interface GenerateOpts {
  mode: ComposerMode;
  userThesis?: string;
  featuredNames: string[];
  mustInclude: string[];
  emphasis: CoverageTheme[];
  model?: LlmModel;
  redTeamPanel?: string[];
}

export interface GeneratedNote {
  title: string;
  asOfDate: string;
  sections: StrategyNoteSection[];
  portfolio?: PortfolioPick[];
  thesisVerdict?: ThesisVerdict;
  citations: { name: string; url: string }[];
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

// Section skeleton (institutional long-form). headings are mode-aware below.
const SECTION_DEFS: { key: string; heading: string; target: number }[] = [
  { key: "executive_summary", heading: "Executive Summary", target: 450 },
  { key: "macro_backdrop", heading: "Macro Backdrop", target: 500 },
  { key: "policy_landscape", heading: "Policy & Regulatory Landscape", target: 500 },
  { key: "cross_asset_flows", heading: "Cross-Asset & Flows", target: 350 },
  { key: "sector_allocation", heading: "Sector Allocation", target: 450 },
  { key: "single_names", heading: "Single-Name Highlights", target: 500 },
  { key: "scenarios", heading: "Scenarios (Base / Bull / Bear)", target: 400 },
  { key: "catalysts_calendar", heading: "Catalysts & Forward Calendar", target: 300 },
];

function baseSystem(mode: ComposerMode, model: LlmModel): string {
  const common =
    "You are a senior China/HK equity & macro strategist writing an institutional-grade " +
    "research note. Write in a precise, evidence-led voice. Reason ONLY from the supplied " +
    "EVIDENCE BASE plus general framework knowledge; never invent data points, headlines, " +
    "or prices. When you state a fact from the evidence, keep it faithful. Use clear prose " +
    "(markdown allowed: short paragraphs, occasional bullets). Do not fabricate citations.";
  if (mode === "thesis_driven") {
    return (
      common +
      " IMPORTANT POSTURE: You are testing the user's thesis as a rigorous CRITIC, not a " +
      "cheerleader. Actively look for disconfirming evidence. If the evidence does not " +
      "support the thesis, say so plainly and explain where and why the user is wrong, and " +
      "point them to better-supported alternatives. Do NOT agree by default."
    );
  }
  return (
    common +
    " You are forming your OWN independent view from the evidence — the user has not given " +
    "a thesis. Build a coherent investment strategy and be willing to take clear, " +
    "falsifiable positions backed by the data."
  );
}

async function genSection(
  def: { key: string; heading: string; target: number },
  ctx: ReportContext,
  opts: GenerateOpts,
  contextBlock: string,
): Promise<{ section: StrategyNoteSection; cost: number; tin: number; tout: number }> {
  const model = opts.model ?? "claude-sonnet-4";
  const featured = opts.featuredNames.join(", ") || "(none specified)";
  const emphasis = opts.emphasis.join(", ") || "all themes";
  const must = opts.mustInclude.length ? `Must address: ${opts.mustInclude.join("; ")}.` : "";

  let task = "";
  switch (def.key) {
    case "executive_summary":
      task =
        opts.mode === "thesis_driven"
          ? `Open by stating, up front, your verdict on the user's thesis ("${opts.userThesis}") — is it supported by the evidence? Then summarize the key reasoning in ~${def.target} words.`
          : `State your top-down call and the 3-4 highest-conviction conclusions from the evidence, in ~${def.target} words.`;
      break;
    case "sector_allocation":
      task = `Give an overweight/neutral/underweight call for each emphasized theme (${emphasis}), each tied to specific evidence (policy, valuation, momentum). ~${def.target} words.`;
      break;
    case "single_names":
      task = `Discuss the most relevant single names, GUARANTEEING coverage of these featured names: ${featured}. For each, tie to thesis/valuation/catalyst from the evidence. ~${def.target} words.`;
      break;
    case "scenarios":
      task = `Lay out base / bull / bear scenarios with rough probabilities and the key swing factors, grounded in the evidence. ~${def.target} words.`;
      break;
    default:
      task = `Write the "${def.heading}" section in ~${def.target} words, grounded in the evidence base.`;
  }

  const system = baseSystem(opts.mode, model);
  const user =
    `${contextBlock}\n\n` +
    `Write ONLY the "${def.heading}" section of the strategy note. ${task} ${must}\n` +
    `Output clean markdown for this section only (no section number, no document title). ` +
    `Where you rely on a specific policy item or web-research fact, you may reference the source inline by name.`;

  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: `report_section:${opts.mode}:${def.key}`,
    maxOutputTokens: Math.min(1600, Math.round(def.target * 2.2)),
  });
  return {
    section: { key: def.key, heading: def.heading, body: res.text.trim() },
    cost: res.costUsd,
    tin: res.tokensIn,
    tout: res.tokensOut,
  };
}

// ── Mode A: model portfolio (structured JSON) ───────────────────────────────────
async function genPortfolio(
  ctx: ReportContext,
  opts: GenerateOpts,
  contextBlock: string,
): Promise<{ portfolio: PortfolioPick[]; cost: number; tin: number; tout: number }> {
  const model = opts.model ?? "claude-sonnet-4";
  const universe = SECTOR_UNIVERSE.flatMap((t) => t.names.map((n) => `${n.symbol} ${n.nameEn} (${t.id})`)).join(", ");
  const system =
    baseSystem("data_driven", model) +
    " Now produce a concrete model portfolio. Output STRICT JSON only.";
  const user =
    `${contextBlock}\n\n` +
    `From the universe [${universe}], build a model portfolio of 8-15 picks grounded in the evidence. ` +
    `Output STRICT JSON: an array of {"symbol","nameEn","theme","stance":"long"|"avoid"|"watch","weight":number,"conviction":"low"|"medium"|"high","entryRationale","keyRisk"}. ` +
    `Long weights should sum to roughly 100. Only use symbols from the universe.`;
  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: "report_portfolio",
    maxOutputTokens: 3200,
  });
  let portfolio: PortfolioPick[] = [];
  try {
    const arr = extractJsonArray(res.text);
    portfolio = arr
      .filter((p: any) => p && p.symbol && p.nameEn)
      .map((p: any) => ({
        symbol: String(p.symbol),
        nameEn: String(p.nameEn),
        theme: String(p.theme ?? ""),
        stance: ["long", "avoid", "watch"].includes(p.stance) ? p.stance : "watch",
        weight: typeof p.weight === "number" ? p.weight : undefined,
        conviction: ["low", "medium", "high"].includes(p.conviction) ? p.conviction : "medium",
        entryRationale: String(p.entryRationale ?? ""),
        keyRisk: String(p.keyRisk ?? ""),
      }));
  } catch {
    /* leave empty */
  }
  return { portfolio, cost: res.costUsd, tin: res.tokensIn, tout: res.tokensOut };
}

// ── Mode B: thesis verdict (structured JSON) ────────────────────────────────────
async function genVerdict(
  ctx: ReportContext,
  opts: GenerateOpts,
  contextBlock: string,
): Promise<{ verdict: ThesisVerdict; cost: number; tin: number; tout: number }> {
  const model = opts.model ?? "claude-sonnet-4";
  const system =
    baseSystem("thesis_driven", model) +
    " Now render a structured verdict on the thesis. Be honest and critical. Output STRICT JSON only.";
  const user =
    `${contextBlock}\n\n` +
    `Thesis under test: "${opts.userThesis}"\n` +
    `Render a STRICT JSON verdict: {"verdict":"supported"|"partially_supported"|"not_supported"|"insufficient_evidence","confidence":"low"|"medium"|"high","supportingEvidence":[{"point","source":{"name","url"}}],"contradictingEvidence":[{"point","source":{"name","url"}}],"evidenceGaps":[string],"corrections":[string],"alternatives":[string]}. ` +
    `You MUST populate contradictingEvidence and evidenceGaps even if the verdict is "supported". ` +
    `If you cannot find sufficient evidence, return "insufficient_evidence" and give the user concrete next steps in alternatives. Only use source URLs that appear in the evidence base.`;
  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: "report_thesis_verdict",
    maxOutputTokens: 3000,
  });
  let verdict: ThesisVerdict = {
    verdict: "insufficient_evidence",
    confidence: "low",
    supportingEvidence: [],
    contradictingEvidence: [],
    evidenceGaps: ["Verdict could not be parsed from the model output."],
    corrections: [],
    alternatives: [],
  };
  try {
    const obj = extractJsonObject(res.text);
    if (obj) {
      verdict = {
        verdict: ["supported", "partially_supported", "not_supported", "insufficient_evidence"].includes(obj.verdict) ? obj.verdict : "insufficient_evidence",
        confidence: ["low", "medium", "high"].includes(obj.confidence) ? obj.confidence : "low",
        supportingEvidence: Array.isArray(obj.supportingEvidence) ? obj.supportingEvidence : [],
        contradictingEvidence: Array.isArray(obj.contradictingEvidence) ? obj.contradictingEvidence : [],
        evidenceGaps: Array.isArray(obj.evidenceGaps) ? obj.evidenceGaps : [],
        corrections: Array.isArray(obj.corrections) ? obj.corrections : [],
        alternatives: Array.isArray(obj.alternatives) ? obj.alternatives : [],
      };
    }
  } catch {
    /* keep fallback */
  }
  return { verdict, cost: res.costUsd, tin: res.tokensIn, tout: res.tokensOut };
}

// ── Structured scenarios (Gap E): bull/base/bear + falsification ────────────────
async function genScenarios(
  ctx: ReportContext,
  opts: GenerateOpts,
  contextBlock: string,
): Promise<{ section: StrategyNoteSection; cost: number; tin: number; tout: number }> {
  const model = opts.model ?? "claude-sonnet-4";
  const emphasis = opts.emphasis.join(", ") || "all themes";
  const system =
    baseSystem(opts.mode, model) +
    " Now produce STRUCTURED bull/base/bear scenarios at the PORTFOLIO level (plus, where the evidence " +
    "supports it, the emphasized themes), each with explicit triggers, key drivers, and a rough probability. " +
    "Also produce a FALSIFICATION list: concrete, observable conditions that would prove the base/bull thesis WRONG. " +
    "The BEAR scenario must reflect the devil's-advocate / red-team risks present in the SCENARIOS & RISK evidence. " +
    "Output STRICT JSON only.";
  const user =
    `${contextBlock}\n\n` +
    `Emphasized themes: ${emphasis}.\n` +
    `Output STRICT JSON: {"scenarioSets":[{"scope":"portfolio"|<themeId>,"scenarios":[` +
    `{"label":"bull","narrative","triggers":[..],"probability":0-100 or null,"keyDrivers":[..]},` +
    `{"label":"base",...},{"label":"bear",...}],"falsification":["observation that would prove the thesis wrong",...]}]}. ` +
    `Always include a "portfolio" scenarioSet; add per-theme sets only where the evidence is rich. ` +
    `Probabilities within a set should sum to ~100 if provided. Ground narratives in the evidence base.`;
  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: "report_scenarios_structured",
    maxOutputTokens: 3000,
  });

  let scenarioSets: ScenarioSet[] = [];
  try {
    const obj = extractJsonObject(res.text);
    if (obj && Array.isArray(obj.scenarioSets)) {
      scenarioSets = obj.scenarioSets
        .filter((s: any) => s && Array.isArray(s.scenarios))
        .map((s: any) => ({
          scope: String(s.scope ?? "portfolio"),
          scenarios: parseNoteScenarios(s.scenarios),
          falsification: Array.isArray(s.falsification) ? s.falsification.map((x: any) => String(x)).filter(Boolean).slice(0, 6) : [],
        }))
        .filter((s: ScenarioSet) => s.scenarios.length);
    }
  } catch {
    /* fall through to prose */
  }

  // body MUST be clean prose — raw JSON must NEVER reach it. When we have the
  // structured sets, render prose from them; otherwise strip any ```json fence /
  // leading JSON blob from the model output so the deck/UI never paginate it.
  const body = scenarioSets.length ? scenarioSetsToProse(scenarioSets) : stripJsonBlob(res.text);
  return {
    section: { key: "scenarios", heading: "Scenarios (Base / Bull / Bear)", body, data: scenarioSets.length ? { scenarioSets } : undefined },
    cost: res.costUsd,
    tin: res.tokensIn,
    tout: res.tokensOut,
  };
}

function parseNoteScenarios(arr: any): NoteScenario[] {
  if (!Array.isArray(arr)) return [];
  const wanted: NoteScenario["label"][] = ["bull", "base", "bear"];
  const out: NoteScenario[] = [];
  for (const label of wanted) {
    const s = arr.find((x: any) => String(x?.label ?? "").toLowerCase() === label);
    if (!s) continue;
    const prob = s.probability == null ? null : Math.max(0, Math.min(100, Math.round(Number(s.probability))));
    out.push({
      label,
      narrative: String(s.narrative ?? "").trim(),
      triggers: Array.isArray(s.triggers) ? s.triggers.map((x: any) => String(x)).filter(Boolean).slice(0, 6) : [],
      probability: Number.isFinite(prob as number) ? (prob as number) : null,
      keyDrivers: Array.isArray(s.keyDrivers) ? s.keyDrivers.map((x: any) => String(x)).filter(Boolean).slice(0, 6) : [],
    });
  }
  return out;
}

/**
 * Render the structured scenario sets to clean institutional PROSE — never JSON.
 * Portfolio scope first, then any per-theme sets. Each scenario is a short
 * paragraph ("Bull (prob X%): <narrative>") followed by compact Triggers / Key
 * drivers lines, and each set closes with a falsification list.
 */
export function scenarioSetsToProse(sets: ScenarioSet[]): string {
  const ordered = [...sets].sort((a, b) => (a.scope === "portfolio" ? -1 : b.scope === "portfolio" ? 1 : 0));
  const blocks: string[] = [];
  for (const set of ordered) {
    const title = set.scope === "portfolio" ? "Portfolio" : set.scope;
    const lines: string[] = [`### ${title}`];
    for (const s of set.scenarios) {
      const cap = s.label[0].toUpperCase() + s.label.slice(1);
      const head = `**${cap}${s.probability != null ? ` (prob ${s.probability}%)` : ""}:**`;
      lines.push(`${head} ${s.narrative}`.trim());
      if (s.triggers.length) lines.push(`Triggers: ${s.triggers.join("; ")}`);
      if (s.keyDrivers.length) lines.push(`Key drivers: ${s.keyDrivers.join("; ")}`);
    }
    if (set.falsification.length) {
      lines.push("Falsification — what would prove this wrong:");
      for (const f of set.falsification) lines.push(`- ${f}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * Last-resort cleaner for when the structured parse failed: strip any ```json
 * fenced block, and if the remaining text is still predominantly a raw JSON
 * object/array, drop it so raw JSON never reaches the section body.
 */
function stripJsonBlob(text: string): string {
  let s = (text || "").trim();
  // Remove fenced ```json ... ``` blocks entirely.
  s = s.replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
  // If what's left starts as a JSON object/array, it's the leaked payload — drop it.
  const looksJson = /^[\[{]/.test(s) && /"(scenarioSets|scenarios|label|narrative|triggers|keyDrivers|falsification)"/.test(s);
  if (looksJson) {
    // Keep any prose that precedes the first brace/bracket; otherwise emit a note.
    const cut = s.search(/[\[{]/);
    const lead = cut > 0 ? s.slice(0, cut).trim() : "";
    return lead || "Scenario detail unavailable for this note (structured payload could not be rendered).";
  }
  return s;
}

// ── Red-team section (always in Mode B; available in A) ─────────────────────────
async function genRedTeam(
  baseThesis: string,
  contextBlock: string,
  opts: GenerateOpts,
): Promise<{ section: StrategyNoteSection; cost: number; tin: number; tout: number }> {
  const model = opts.model ?? "claude-sonnet-4";
  const { system, user } = buildRedTeamPrompt({
    baseThesis,
    context: contextBlock.slice(0, 12000),
    panel: opts.redTeamPanel,
    focusHint: "China/HK equity strategy note",
  });
  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: "report_redteam",
    maxOutputTokens: 1400,
  });
  return {
    section: { key: "risks_redteam", heading: "Risks — Devil's-Advocate Panel", body: res.text.trim() },
    cost: res.costUsd,
    tin: res.tokensIn,
    tout: res.tokensOut,
  };
}

export async function generateStrategyNote(opts: GenerateOpts): Promise<GeneratedNote> {
  const model = opts.model ?? "claude-sonnet-4";
  const ctx = await assembleContext({
    mode: opts.mode,
    userThesis: opts.userThesis,
    emphasis: opts.emphasis,
    featuredNames: opts.featuredNames,
  });
  const contextBlock = contextToPrompt(ctx);

  let cost = 0, tin = 0, tout = 0;
  const sections: StrategyNoteSection[] = [];

  // Generate prose sections sequentially (keeps cost predictable; respects rate limits).
  // The scenarios section is generated as STRUCTURED bull/base/bear + falsification
  // (Gap E), then rendered to prose for backward-compatible display.
  for (const def of SECTION_DEFS) {
    const r = def.key === "scenarios"
      ? await genScenarios(ctx, opts, contextBlock)
      : await genSection(def, ctx, opts, contextBlock);
    sections.push(r.section);
    cost += r.cost; tin += r.tin; tout += r.tout;
  }

  let portfolio: PortfolioPick[] | undefined;
  let thesisVerdict: ThesisVerdict | undefined;

  if (opts.mode === "data_driven") {
    const p = await genPortfolio(ctx, opts, contextBlock);
    portfolio = p.portfolio;
    cost += p.cost; tin += p.tin; tout += p.tout;
  } else {
    const v = await genVerdict(ctx, opts, contextBlock);
    thesisVerdict = v.verdict;
    cost += v.cost; tin += v.tin; tout += v.tout;
  }

  // Red-team: always in Mode B; the base thesis is the user's thesis or the exec summary.
  if (opts.mode === "thesis_driven") {
    const baseThesis = opts.userThesis || sections[0]?.body || "China/HK equity base case";
    const rt = await genRedTeam(baseThesis, contextBlock, opts);
    sections.push(rt.section);
    cost += rt.cost; tin += rt.tin; tout += rt.tout;
  }

  const title =
    opts.mode === "thesis_driven"
      ? `Thesis Review — ${truncate(opts.userThesis ?? "", 60)}`
      : `China/HK Strategy & Outlook — ${ctx.asOfDate}`;

  return {
    title,
    asOfDate: ctx.asOfDate,
    sections,
    portfolio,
    thesisVerdict,
    citations: ctx.citations,
    model,
    costUsd: cost,
    tokensIn: tin,
    tokensOut: tout,
  };
}

/** Regenerate a single section by key (for the inline "regenerate" button). */
export async function regenerateSection(
  key: string,
  opts: GenerateOpts,
): Promise<{ section: StrategyNoteSection; costUsd: number }> {
  const ctx = await assembleContext({
    mode: opts.mode,
    userThesis: opts.userThesis,
    emphasis: opts.emphasis,
    featuredNames: opts.featuredNames,
  });
  const contextBlock = contextToPrompt(ctx);
  const def = SECTION_DEFS.find((d) => d.key === key);
  if (key === "risks_redteam") {
    const rt = await genRedTeam(opts.userThesis || "China/HK equity base case", contextBlock, opts);
    return { section: rt.section, costUsd: rt.cost };
  }
  if (key === "scenarios") {
    const sc = await genScenarios(ctx, opts, contextBlock);
    return { section: sc.section, costUsd: sc.cost };
  }
  if (!def) throw new Error(`Unknown section: ${key}`);
  const r = await genSection(def, ctx, opts, contextBlock);
  return { section: r.section, costUsd: r.cost };
}

// ── JSON parse helpers (tolerant of truncation) ─────────────────────────────────
function stripFence(text: string): string {
  let s = (text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

/**
 * Best-effort JSON repair for outputs truncated by the token cap: trims to the
 * last complete top-level element and closes the open bracket/brace.
 */
function repairJson(snippet: string, open: "[" | "{"): string {
  const close = open === "[" ? "]" : "}";
  // Walk and track depth + string state; record index after each top-level element.
  let depth = 0, inStr = false, esc = false, lastComplete = -1;
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { depth--; if (depth === 1) lastComplete = i; }
  }
  if (lastComplete > 0) return snippet.slice(0, lastComplete + 1) + close;
  return snippet + close;
}

function extractJsonArray(text: string): any[] {
  const s = stripFence(text);
  const a = s.indexOf("[");
  if (a === -1) return [];
  const b = s.lastIndexOf("]");
  const candidate = b > a ? s.slice(a, b + 1) : s.slice(a);
  try { return JSON.parse(candidate); } catch { /* fall through to repair */ }
  try { return JSON.parse(repairJson(s.slice(a), "[")); } catch { return []; }
}

function extractJsonObject(text: string): any | null {
  const s = stripFence(text);
  const a = s.indexOf("{");
  if (a === -1) return null;
  const b = s.lastIndexOf("}");
  const candidate = b > a ? s.slice(a, b + 1) : s.slice(a);
  try { return JSON.parse(candidate); } catch { /* fall through to repair */ }
  try { return JSON.parse(repairJson(s.slice(a), "{")); } catch { return null; }
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
