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

export interface StrategyNoteSection {
  key: string;
  heading: string;
  body: string;
  sources?: { name: string; url: string }[];
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
    maxOutputTokens: 1800,
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
    maxOutputTokens: 1600,
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
  for (const def of SECTION_DEFS) {
    const r = await genSection(def, ctx, opts, contextBlock);
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
  if (!def) throw new Error(`Unknown section: ${key}`);
  const r = await genSection(def, ctx, opts, contextBlock);
  return { section: r.section, costUsd: r.cost };
}

// ── JSON parse helpers ──────────────────────────────────────────────────────────
function extractJsonArray(text: string): any[] {
  let s = (text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a === -1 || b === -1 || b < a) return [];
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return []; }
}
function extractJsonObject(text: string): any | null {
  let s = (text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
