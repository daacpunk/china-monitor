/**
 * House view helpers (Phase 3).
 *
 * The house view is a single evolving master call (one active row) with per-theme
 * sector stances and an append-only change-log. The engine can PROPOSE an updated
 * house view from the latest evidence, but the user approves/edits — never silently
 * overwritten (the route returns a proposal; saving is a separate explicit call).
 */

import { generateCommentary, type LlmModel } from "../analysis/llm";
import { getDefaultReportModel } from "../analysis/modelCatalog";
import { assembleContext, contextToPrompt } from "./context";
import { SECTOR_UNIVERSE } from "../equity/universe";

export interface ProposedHouseView {
  headline: string;
  stance: string;
  conviction: string;
  horizon: string;
  pillars: string[];
  keyRisks: string[];
  sectorStance: { theme: string; stance: string; rationale: string }[];
  changeSummary: string; // what changed vs the current view (for the change-log)
}

export async function proposeHouseView(modelArg?: LlmModel): Promise<ProposedHouseView> {
  const model: LlmModel = modelArg ?? (await getDefaultReportModel());
  const ctx = await assembleContext({
    mode: "data_driven",
    emphasis: [],
    featuredNames: [],
  });
  const block = contextToPrompt(ctx);
  const themes = SECTOR_UNIVERSE.map((t) => t.id).join(", ");

  const system =
    "You are a senior China/HK strategist maintaining a standing house view. From the " +
    "evidence base, propose an updated master house view. Be decisive but evidence-led. " +
    "Output STRICT JSON only.";
  const user =
    `${block}\n\n` +
    `Propose the house view as STRICT JSON: {"headline":string,"stance":"bullish"|"neutral"|"bearish"|"constructive"|"cautious","conviction":"low"|"medium"|"high","horizon":"1Q"|"2Q"|"1Y","pillars":[string],"keyRisks":[string],"sectorStance":[{"theme":one of ${themes},"stance":"overweight"|"neutral"|"underweight","rationale":string}],"changeSummary":string}. ` +
    `Cover all themes in sectorStance. changeSummary = what changed vs the prior view (or "initial view").`;

  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: "house_view_propose",
    maxOutputTokens: 1200,
  });

  const obj = extractJsonObject(res.text) ?? {};
  return {
    headline: String(obj.headline ?? ""),
    stance: ["bullish", "neutral", "bearish", "constructive", "cautious"].includes(obj.stance) ? obj.stance : "neutral",
    conviction: ["low", "medium", "high"].includes(obj.conviction) ? obj.conviction : "medium",
    horizon: ["1Q", "2Q", "1Y"].includes(obj.horizon) ? obj.horizon : "2Q",
    pillars: Array.isArray(obj.pillars) ? obj.pillars.map(String) : [],
    keyRisks: Array.isArray(obj.keyRisks) ? obj.keyRisks.map(String) : [],
    sectorStance: Array.isArray(obj.sectorStance)
      ? obj.sectorStance
          .filter((s: any) => s && s.theme)
          .map((s: any) => ({
            theme: String(s.theme),
            stance: ["overweight", "neutral", "underweight"].includes(s.stance) ? s.stance : "neutral",
            rationale: String(s.rationale ?? ""),
          }))
      : [],
    changeSummary: String(obj.changeSummary ?? "initial view"),
  };
}

function extractJsonObject(text: string): any | null {
  let s = (text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
