/**
 * Persona prompt builders — turn the static persona library into LLM instructions.
 *
 *   buildLensPrompt():   re-reason a setup through ONE strategist's framework.
 *   buildRedTeamPrompt(): a panel of bear-leaning personas attacks a base-case thesis.
 *
 * These return system+user strings to hand to generateCommentary(); they do NOT
 * call the LLM themselves (the route/brief layer does, so cost + caching are
 * centralized). Methodology-modeled only — no live Sonar pulls per persona.
 */

import { PERSONAS_BY_ID, DEFAULT_REDTEAM_PANEL, type Persona } from "@shared/personas";

function personaCard(p: Persona): string {
  return [
    `${p.name} (${p.firm}) — ${p.focus}`,
    `Framework: ${p.framework.join("; ")}`,
    `Key questions: ${p.keyQuestions.join(" / ")}`,
    `Signals watched: ${p.signalsWatched.join(", ")}`,
    `Red flags: ${p.redFlags.join(", ")}`,
    `Bias: ${p.bias}; horizon: ${p.timeHorizon}.`,
    `Voice: ${p.voice}`,
  ].join("\n");
}

export interface LensPromptArgs {
  personaId: string;
  context: string;       // the data/brief/setup to analyze
  focusHint?: string;    // e.g. "China/HK equity strategy, mid-2026"
}

export function buildLensPrompt(args: LensPromptArgs): { system: string; user: string; persona: Persona } {
  const persona = PERSONAS_BY_ID[args.personaId];
  if (!persona) throw new Error(`Unknown persona: ${args.personaId}`);

  const system =
    `You are channeling the ANALYTICAL FRAMEWORK of ${persona.name} of ${persona.firm}. ` +
    `Reason strictly through their methodology and priorities — not as impersonation or invented quotes, ` +
    `but applying their lens to the material. Be specific and falsifiable. ` +
    `This is one analytical viewpoint among several, for an institutional China/HK equity strategist.\n\n` +
    `THE LENS:\n${personaCard(persona)}`;

  const user =
    `${args.focusHint ? `Focus: ${args.focusHint}\n\n` : ""}` +
    `Apply ${persona.name}'s lens to the following. Structure your read as:\n` +
    `1. The core question(s) ${persona.name} would ask here.\n` +
    `2. What their framework concludes from this material.\n` +
    `3. The key risk/red-flag they'd flag.\n` +
    `4. The resulting positioning/allocation implication (be concrete).\n\n` +
    `MATERIAL:\n${args.context}`;

  return { system, user, persona };
}

export interface RedTeamPromptArgs {
  baseThesis: string;    // the base-case view to attack
  context?: string;      // supporting data/brief
  panel?: string[];      // persona ids; defaults to the confirmed bear panel
  focusHint?: string;
}

export function buildRedTeamPrompt(args: RedTeamPromptArgs): { system: string; user: string; panel: Persona[] } {
  const ids = (args.panel && args.panel.length > 0 ? args.panel : DEFAULT_REDTEAM_PANEL).filter(
    (id) => PERSONAS_BY_ID[id],
  );
  const panel = ids.map((id) => PERSONAS_BY_ID[id]);

  const cards = panel.map((p) => `--- ${p.name} (${p.firm}) ---\n${personaCard(p)}`).join("\n\n");

  const system =
    `You are running a DEVIL'S-ADVOCATE PANEL for an institutional China/HK equity strategist. ` +
    `Each panelist attacks the base-case thesis strictly through their own analytical framework — ` +
    `surfacing the strongest, most specific bear/risk case, not generic caveats. ` +
    `No invented quotes; apply each framework rigorously.\n\n` +
    `THE PANEL:\n${cards}`;

  const user =
    `${args.focusHint ? `Focus: ${args.focusHint}\n\n` : ""}` +
    `BASE-CASE THESIS TO ATTACK:\n${args.baseThesis}\n\n` +
    `${args.context ? `SUPPORTING CONTEXT:\n${args.context}\n\n` : ""}` +
    `For EACH panelist, produce:\n` +
    `- Panelist name\n` +
    `- Their single strongest objection to the thesis (specific, from their framework)\n` +
    `- The signal/condition that would confirm their bear case\n` +
    `Then a 2-3 sentence synthesis: the most important risks the base case must defend against, ` +
    `and what would have to be true for the bears to be wrong.`;

  return { system, user, panel };
}
