/**
 * Scenario engine (Phase 3b).
 *
 * Per user decision: single base case + bull/bear alternates, 1Q forward.
 *
 * Workflow:
 *   1. Gather snapshot: trends (multi-timescale) for driver series + anomalies
 *      + latest equity levels.
 *   2. Build a structured input JSON.
 *   3. Ask an LLM to emit a strict JSON with base/bull/bear narratives,
 *      driver-by-driver projections, equity calls, and probability weights.
 *   4. Validate, persist, return.
 *
 * Reuses generateCommentary() from llm.ts (so cost tracking + ceilings work).
 */

import { fetchSeries, type TimePoint } from "../series/fetchSeries";
import { generateCommentary, type LlmModel } from "./llm";
import { detectTrend, type TrendResult } from "./trends";
import { detectAnomaly, pctChange, cleanSeries } from "./stats";
import { getDefaultReportModel } from "./modelCatalog";

// Default drivers tracked in the scenario engine — chosen to span the
// macro themes that move Chinese equities (reflation, growth, policy,
// FX, exports, real estate, sentiment).
export const DEFAULT_DRIVERS = [
  "ppi_yoy",
  "cpi_yoy",
  "iva_yoy",
  "retail_sales_yoy",
  "m2_yoy",
  "usdcny_monthly",
  "exports_yoy",
  "new_home_prices_70city",
  "oecd_cli_china",
];

// Equity universe is A-share + HK (user decision).
export const DEFAULT_EQUITY_TARGETS = [
  "csi300_monthly",
  "chinext_monthly",
  "hangseng_monthly",
];

// ─── Quarter helpers ─────────────────────────────────────────────────────

export function currentQuarter(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0..11
  const q = Math.floor(m / 3) + 1;
  return `${y}-Q${q}`;
}

export function nextQuarter(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const q = Math.floor(m / 3) + 1;
  if (q === 4) return `${y + 1}-Q1`;
  return `${y}-Q${q + 1}`;
}

// ─── Snapshot ────────────────────────────────────────────────────────────

export interface DriverSnapshot {
  id: string;
  latestDate: string | null;
  latestValue: number | null;
  mom: number | null;
  yoy: number | null;
  zScore: number | null;
  severity: "normal" | "watch" | "anomaly" | null;
  trendClass: TrendResult["classification"];
  multiscaleConfirmed: boolean;
  trendStart: string | null;
}

export interface EquitySnapshot {
  id: string;
  latestDate: string | null;
  latestLevel: number | null;
  mom: number | null;
  ytdPct: number | null;
}

export interface ScenarioInputs {
  asOf: string;                  // ISO timestamp
  targetQuarter: string;
  drivers: DriverSnapshot[];
  equities: EquitySnapshot[];
  crossSourceConfirmation: { up: number; down: number; flat: number; confirmation: string };
}

async function snapshotDriver(id: string): Promise<DriverSnapshot> {
  const r = await fetchSeries(id);
  const trend = detectTrend(id, r.data);
  const anomaly = detectAnomaly(r.data);
  return {
    id,
    latestDate: trend.latestDate,
    latestValue: trend.latestValue,
    mom: pctChange(r.data, 1),
    yoy: pctChange(r.data, 12),
    zScore: anomaly?.zScore ?? null,
    severity: anomaly?.severity ?? null,
    trendClass: trend.classification,
    multiscaleConfirmed: trend.multiscaleConfirmed,
    trendStart: trend.trendStart,
  };
}

async function snapshotEquity(id: string): Promise<EquitySnapshot> {
  const r = await fetchSeries(id);
  const cleaned = cleanSeries(r.data);
  const mom = pctChange(r.data, 1);
  // YTD: find first observation of current year
  const yearStart = String(new Date().getUTCFullYear());
  const firstThisYear = cleaned.find((p) => p.date.startsWith(yearStart));
  const ytd = firstThisYear && cleaned.length > 0 && firstThisYear.value !== 0
    ? ((cleaned[cleaned.length - 1].value - firstThisYear.value) / firstThisYear.value) * 100
    : null;
  return {
    id,
    latestDate: cleaned[cleaned.length - 1]?.date ?? null,
    latestLevel: cleaned[cleaned.length - 1]?.value ?? null,
    mom,
    ytdPct: ytd,
  };
}

export async function buildScenarioInputs(opts?: { drivers?: string[]; equities?: string[]; targetQuarter?: string }): Promise<ScenarioInputs> {
  const drivers = opts?.drivers ?? DEFAULT_DRIVERS;
  const equities = opts?.equities ?? DEFAULT_EQUITY_TARGETS;

  const [driverSnaps, equitySnaps] = await Promise.all([
    Promise.all(drivers.map(snapshotDriver)),
    Promise.all(equities.map(snapshotEquity)),
  ]);

  // Cross-source confirmation across drivers
  let up = 0, down = 0, flat = 0;
  for (const d of driverSnaps) {
    if (d.trendClass === "stable") flat++;
    else if (d.mom != null && d.mom > 0) up++;
    else if (d.mom != null && d.mom < 0) down++;
    else flat++;
  }
  const total = Math.max(driverSnaps.length, 1);
  let confirmation: "broad-up" | "broad-down" | "mixed" | "flat";
  if (up / total >= 0.6) confirmation = "broad-up";
  else if (down / total >= 0.6) confirmation = "broad-down";
  else if (flat / total >= 0.6) confirmation = "flat";
  else confirmation = "mixed";

  return {
    asOf: new Date().toISOString(),
    targetQuarter: opts?.targetQuarter ?? nextQuarter(),
    drivers: driverSnaps,
    equities: equitySnaps,
    crossSourceConfirmation: { up, down, flat, confirmation },
  };
}

// ─── LLM synthesis ───────────────────────────────────────────────────────

export interface CaseProjection {
  narrative: string;
  drivers: Record<string, { direction: "up" | "down" | "flat"; reasoning: string }>;
  equityCalls: Record<string, { direction: "up" | "down" | "flat"; reasoning: string }>;
}

export interface ScenarioOutput {
  targetQuarter: string;
  base: CaseProjection;
  bull: CaseProjection;
  bear: CaseProjection;
  baseProb: number;   // 0..1, sum to 1 with bull+bear
  bullProb: number;
  bearProb: number;
}

const SYSTEM_PROMPT =
  "You are a senior China macro strategist running a buy-side scenario book. " +
  "You synthesise CURRENT macro data into a single base case plus bull/bear alternates for the NEXT quarter. " +
  "You NEVER invent numbers \u2014 only refer to figures shown in the inputs. " +
  "Calls must be data-grounded: cite which drivers are accelerating, decelerating, or have broken regime. " +
  "Probabilities must sum to 1.0. Direction labels must be 'up', 'down', or 'flat'. " +
  "Be concise; one paragraph per scenario narrative, one short sentence per driver/equity call. " +
  "Output STRICT JSON only, no markdown fences. Schema is described in the user prompt.";

function buildUserPrompt(inputs: ScenarioInputs): string {
  const driverLines = inputs.drivers.map((d) => {
    const parts = [
      `- ${d.id}: latest=${d.latestValue ?? "n/a"} on ${d.latestDate ?? "?"}`,
      `MoM=${d.mom != null ? d.mom.toFixed(2) + "%" : "n/a"}`,
      `YoY=${d.yoy != null ? d.yoy.toFixed(2) + "%" : "n/a"}`,
      `z=${d.zScore != null ? d.zScore.toFixed(2) : "n/a"} (${d.severity ?? "n/a"})`,
      `trend=${d.trendClass}${d.multiscaleConfirmed ? " confirmed" : ""}`,
      d.trendStart ? `since ${d.trendStart}` : "",
    ];
    return parts.filter(Boolean).join("; ");
  }).join("\n");

  const equityLines = inputs.equities.map((e) => {
    return `- ${e.id}: ${e.latestLevel ?? "n/a"} on ${e.latestDate ?? "?"}; MoM=${e.mom != null ? e.mom.toFixed(2) + "%" : "n/a"}; YTD=${e.ytdPct != null ? e.ytdPct.toFixed(2) + "%" : "n/a"}`;
  }).join("\n");

  const driverIds = inputs.drivers.map((d) => d.id);
  const equityIds = inputs.equities.map((e) => e.id);

  const schema = {
    targetQuarter: inputs.targetQuarter,
    base: { narrative: "string", drivers: Object.fromEntries(driverIds.map((id) => [id, { direction: "up|down|flat", reasoning: "string" }])), equityCalls: Object.fromEntries(equityIds.map((id) => [id, { direction: "up|down|flat", reasoning: "string" }])) },
    bull: "(same shape as base)",
    bear: "(same shape as base)",
    baseProb: "number 0..1",
    bullProb: "number 0..1",
    bearProb: "number 0..1 (sum to 1.0)",
  };

  return [
    `# As-of: ${inputs.asOf}`,
    `# Target quarter: ${inputs.targetQuarter}`,
    `# Cross-source confirmation: ${inputs.crossSourceConfirmation.confirmation} (up=${inputs.crossSourceConfirmation.up} down=${inputs.crossSourceConfirmation.down} flat=${inputs.crossSourceConfirmation.flat})`,
    ``,
    `## Macro drivers (latest)`,
    driverLines,
    ``,
    `## Equity universe (A-share + HK)`,
    equityLines,
    ``,
    `## Task`,
    `Produce a base case, a bull case, and a bear case for ${inputs.targetQuarter}.`,
    `Probabilities must sum to 1.0 and reflect your conviction given the data.`,
    `Output STRICT JSON matching this schema:`,
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    `Return ONLY the JSON object. No prose, no markdown fences.`,
  ].join("\n");
}

function extractJson(text: string): any {
  // Strip ```json fences if present
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  // Find first { and last } to be tolerant of preamble
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM did not return a JSON object");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function validateAndNormalize(raw: any, inputs: ScenarioInputs): ScenarioOutput {
  if (!raw || typeof raw !== "object") throw new Error("Scenario output is not an object");
  for (const k of ["base", "bull", "bear"]) {
    if (!raw[k] || typeof raw[k] !== "object") throw new Error(`Missing case: ${k}`);
    if (typeof raw[k].narrative !== "string") throw new Error(`Missing narrative for ${k}`);
    if (!raw[k].drivers) raw[k].drivers = {};
    if (!raw[k].equityCalls) raw[k].equityCalls = {};
  }
  const sum = Number(raw.baseProb ?? 0) + Number(raw.bullProb ?? 0) + Number(raw.bearProb ?? 0);
  const norm = (x: number) => sum > 0 ? x / sum : 1 / 3;
  return {
    targetQuarter: inputs.targetQuarter,
    base: raw.base,
    bull: raw.bull,
    bear: raw.bear,
    baseProb: norm(Number(raw.baseProb ?? 0.5)),
    bullProb: norm(Number(raw.bullProb ?? 0.25)),
    bearProb: norm(Number(raw.bearProb ?? 0.25)),
  };
}

export interface GenerateScenarioResult {
  output: ScenarioOutput;
  inputs: ScenarioInputs;
  model: LlmModel;
  costUsd: number;
  cacheHit: boolean;
  tokensIn: number;
  tokensOut: number;
}

export async function generateScenario(opts?: {
  model?: LlmModel;
  drivers?: string[];
  equities?: string[];
  targetQuarter?: string;
}): Promise<GenerateScenarioResult> {
  // Default: the shared report default (Claude Sonnet 5 unless overridden in
  // Settings) — higher-quality reasoning over multi-driver synthesis.
  // Frontend exposes a toggle so users can switch to claude-haiku-4 (~$0.005/call) for cheaper runs.
  const model = opts?.model ?? (await getDefaultReportModel());
  const inputs = await buildScenarioInputs({
    drivers: opts?.drivers,
    equities: opts?.equities,
    targetQuarter: opts?.targetQuarter,
  });

  const userPrompt = buildUserPrompt(inputs);
  const commentary = await generateCommentary({
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    actionContext: `scenario:${inputs.targetQuarter}`,
    maxOutputTokens: 2400,
    cacheTtlSeconds: 6 * 3600, // 6h — scenarios refresh more often than commentary
  });

  const raw = extractJson(commentary.text);
  const output = validateAndNormalize(raw, inputs);
  return {
    output,
    inputs,
    model,
    costUsd: commentary.costUsd,
    cacheHit: commentary.cacheHit,
    tokensIn: commentary.tokensIn,
    tokensOut: commentary.tokensOut,
  };
}

// ─── Hit-rate scoring ────────────────────────────────────────────────────

/** Given a persisted scenario and the realized driver/equity changes,
 *  compute a simple hit-rate (% of called directions that matched reality). */
export function scoreHitRate(
  scenario: { baseCase: any; bullCase: any; bearCase: any },
  realized: {
    drivers: Record<string, { direction: "up" | "down" | "flat" }>;
    equities: Record<string, { direction: "up" | "down" | "flat" }>;
  },
): {
  base: { driverHits: number; equityHits: number; total: number; pct: number };
  bull: { driverHits: number; equityHits: number; total: number; pct: number };
  bear: { driverHits: number; equityHits: number; total: number; pct: number };
} {
  function scoreCase(c: any): { driverHits: number; equityHits: number; total: number; pct: number } {
    let driverHits = 0, equityHits = 0, total = 0;
    for (const [id, call] of Object.entries((c?.drivers ?? {}) as Record<string, { direction?: string }>)) {
      const realDir = realized.drivers[id]?.direction;
      if (!realDir || !call?.direction) continue;
      total++;
      if (call.direction === realDir) driverHits++;
    }
    for (const [id, call] of Object.entries((c?.equityCalls ?? {}) as Record<string, { direction?: string }>)) {
      const realDir = realized.equities[id]?.direction;
      if (!realDir || !call?.direction) continue;
      total++;
      if (call.direction === realDir) equityHits++;
    }
    const pct = total > 0 ? ((driverHits + equityHits) / total) * 100 : 0;
    return { driverHits, equityHits, total, pct };
  }
  return {
    base: scoreCase(scenario.baseCase),
    bull: scoreCase(scenario.bullCase),
    bear: scoreCase(scenario.bearCase),
  };
}
