/**
 * Market Brief synthesis (Phase 3b Session 4).
 *
 * Builds a deep-dive China-focused market write-up that blends:
 *   - latest macro driver readings (PPI, CPI, IVA, retail, M2, FX, exports, property, CLI)
 *   - cross-asset color (DXY, US 10Y, Brent, Copper, VIX)
 *   - trend classifications + multiscale confirmation per driver
 *   - macro→equity attribution lead/lag + not-priced pairs
 *   - upcoming macro releases (next 14 days)
 *
 * Output is STRICT JSON with 7 fields:
 *   - execSummary (one paragraph)
 *   - sections.what_happened
 *   - sections.regime_shifts
 *   - sections.cross_asset
 *   - sections.priced_vs_not
 *   - sections.forward_watch
 *   - sections.trade_implications
 *
 * Voice: sell-side institutional research blended with PM journal.
 * Neutral & balanced — must cite "risks include", "however", contrast bull/bear.
 * First-person investor reasoning — "what I'm watching", "I'd lean toward", "my read is".
 * NOT hedge-fund swagger — avoid "we like", "we'd fade", "the desk thinks".
 * Cite z-scores, classifications, sign-breaks — never invent numbers.
 *
 * Reuses generateCommentary() so cost tracking + ceilings + 24h cache work.
 */

import { fetchSeries } from "../series/fetchSeries";
import { generateCommentary, type LlmModel } from "./llm";
import { detectTrend, type TrendResult } from "./trends";
import { detectAnomaly, pctChange, cleanSeries } from "./stats";
import { getUpcomingReleases, type MacroRelease } from "../clients/calendar";
import { getEntry } from "../series/registry";
import {
  EQUITY_UNIVERSE,
  SECTOR_MAPPING,
  computePair,
  inferDriverKind,
  type PairAttribution,
  type SectorMappingEntry,
} from "./attribution";
import { getDefaultReportModel } from "./modelCatalog";

// ─── Default universe ────────────────────────────────────────────────────

/** China macro drivers fed into the brief (and thus the report/deck macroDigest). */
export const DEFAULT_BRIEF_DRIVERS = [
  "ppi_yoy",
  "cpi_yoy",
  "iva_yoy",
  "retail_sales_yoy",
  "m2_yoy",
  "usdcny_monthly",
  // Full trade picture (customs, USD): exports + imports + the balance.
  "exports_yoy",
  "imports_yoy",
  "trade_balance_usd",
  // Product/HS-chapter trade (GACC via chinadata) — thematic trade signals.
  "chips_exports_yoy",
  "chips_imports_yoy",
  "autos_exports_yoy",
  "machinery_exports_yoy",
  "energy_imports_yoy",
  "new_home_prices_70city",
  "oecd_cli_china",
  "pmi_mfg",
  "unemployment_rate",
];

/** Cross-asset color series. */
export const DEFAULT_CROSS_ASSET = [
  "dxy_index",
  "us10y_yield",
  "brent_crude",
  "copper_lme",
  "vix_index",
];

/** China equity universe to contextualize price action. */
export const DEFAULT_BRIEF_EQUITIES = [
  "csi300_monthly",
  "chinext_monthly",
  "hangseng_monthly",
];

/** Default attribution pairs (driver → equity) probed for sign-breaks.
 *  Resolved against SECTOR_MAPPING so each pair has expectedSign/thesis metadata. */
export const DEFAULT_ATTRIBUTION_PAIRS: Array<{ driver: string; equity: string }> = [
  { driver: "ppi_yoy",        equity: "csi300_monthly" },
  { driver: "ppi_yoy",        equity: "chinext_monthly" },
  { driver: "iva_yoy",        equity: "csi300_monthly" },
  { driver: "exports_yoy",    equity: "csi300_monthly" },
  { driver: "exports_yoy",    equity: "hangseng_monthly" },
  { driver: "usdcny_monthly", equity: "hangseng_monthly" },
  { driver: "m2_yoy",         equity: "csi300_monthly" },
  { driver: "oecd_cli_china", equity: "hangseng_monthly" },
];

// ─── Snapshot types ──────────────────────────────────────────────────────

export interface DriverBriefSnapshot {
  id: string;
  label: string;
  unit: string;
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

export interface CrossAssetSnapshot {
  id: string;
  label: string;
  unit: string;
  latestDate: string | null;
  latestValue: number | null;
  /** % change over last ~5 trading days (for daily series) or last point (monthly). */
  change5d: number | null;
  /** % change over last ~21 trading days / 1 month. */
  change1m: number | null;
  /** % change vs first observation in current calendar year. */
  ytd: number | null;
}

export interface EquityBriefSnapshot {
  id: string;
  label: string;
  latestDate: string | null;
  latestLevel: number | null;
  mom: number | null;
  ytd: number | null;
}

export interface AttributionLite {
  driver: string;
  driverLabel: string;
  equity: string;
  equityLabel: string;
  expectedSign: 1 | -1;
  /** Full-sample OLS beta. */
  beta: number | null;
  /** Most recent 6-month rolling beta (mirrors Attribution page's r6). */
  rollingShortBeta: number | null;
  /** Most recent 24-month rolling beta. */
  rollingLongBeta: number | null;
  bestLag: number | null;
  bestCorrAtLag: number | null;
  /** Driver z-score of latest change (per attribution.notPriced). */
  driverZ: number | null;
  /** Equity z-score of latest change. */
  equityZ: number | null;
  /** Sign-break / not-priced flag — driver moved big but equity went the wrong way. */
  notPriced: boolean;
  notPricedReason: string | null;
}

export interface BriefInputs {
  asOf: string;                // ISO timestamp
  asOfDate: string;            // YYYY-MM-DD
  drivers: DriverBriefSnapshot[];
  crossAsset: CrossAssetSnapshot[];
  equities: EquityBriefSnapshot[];
  attribution: AttributionLite[];
  upcomingReleases: Array<Pick<MacroRelease, "date" | "agency" | "indicator" | "frequency">>;
  breadth: { up: number; down: number; flat: number; total: number; tilt: string };
}

// ─── Snapshot builders ───────────────────────────────────────────────────

async function snapshotDriver(id: string): Promise<DriverBriefSnapshot> {
  const entry = getEntry(id);
  const r = await fetchSeries(id);
  const trend = detectTrend(id, r.data);
  const anomaly = detectAnomaly(r.data);
  return {
    id,
    label: entry?.label ?? id,
    unit: entry?.unit ?? "",
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

/** Compute % change between latest value and value `nPointsBack` observations earlier. */
function pctChangeNPoints(points: { date: string; value: number | null }[], nBack: number): number | null {
  const clean = cleanSeries(points);
  if (clean.length <= nBack) return null;
  const latest = clean[clean.length - 1]?.value;
  const earlier = clean[clean.length - 1 - nBack]?.value;
  if (latest == null || earlier == null || earlier === 0) return null;
  return ((latest - earlier) / Math.abs(earlier)) * 100;
}

async function snapshotCrossAsset(id: string): Promise<CrossAssetSnapshot> {
  const entry = getEntry(id);
  const r = await fetchSeries(id);
  const clean = cleanSeries(r.data);
  const latest = clean[clean.length - 1] ?? null;

  // For daily series, 5 obs ≈ 1 trading week, 21 ≈ 1 month.
  // For monthly series (copper), 1 obs ≈ 1 month, so collapse 5d/1m to MoM.
  const isMonthly = clean.length > 0 && clean[0].date.length === 7;
  const change5d = isMonthly ? null : pctChangeNPoints(r.data, 5);
  const change1m = isMonthly ? pctChangeNPoints(r.data, 1) : pctChangeNPoints(r.data, 21);

  const yearStart = String(new Date().getUTCFullYear());
  const firstThisYear = clean.find((p) => p.date.startsWith(yearStart));
  const ytd =
    firstThisYear && latest && firstThisYear.value !== 0
      ? ((latest.value - firstThisYear.value) / Math.abs(firstThisYear.value)) * 100
      : null;

  return {
    id,
    label: entry?.label ?? id,
    unit: entry?.unit ?? "",
    latestDate: latest?.date ?? null,
    latestValue: latest?.value ?? null,
    change5d,
    change1m,
    ytd,
  };
}

async function snapshotEquity(id: string): Promise<EquityBriefSnapshot> {
  const entry = getEntry(id);
  const r = await fetchSeries(id);
  const clean = cleanSeries(r.data);
  const latest = clean[clean.length - 1] ?? null;
  const mom = pctChange(r.data, 1);
  const yearStart = String(new Date().getUTCFullYear());
  const firstThisYear = clean.find((p) => p.date.startsWith(yearStart));
  const ytd =
    firstThisYear && latest && firstThisYear.value !== 0
      ? ((latest.value - firstThisYear.value) / Math.abs(firstThisYear.value)) * 100
      : null;
  return {
    id,
    label: entry?.label ?? id,
    latestDate: latest?.date ?? null,
    latestLevel: latest?.value ?? null,
    mom,
    ytd,
  };
}

async function snapshotAttribution(
  pairs: Array<{ driver: string; equity: string }>,
): Promise<AttributionLite[]> {
  const out: AttributionLite[] = [];
  for (const p of pairs) {
    try {
      const mapping: SectorMappingEntry | undefined = SECTOR_MAPPING.find(
        (m) => m.driver === p.driver && m.equityTarget === p.equity,
      );
      if (!mapping) continue; // skip unmapped — we need expectedSign + labels

      const [d, e] = await Promise.all([fetchSeries(p.driver), fetchSeries(p.equity)]);
      if (!d?.data?.length || !e?.data?.length) continue;

      const pair: PairAttribution | null = computePair(
        mapping,
        d.data,
        inferDriverKind(p.driver),
        e.data,
      );
      if (!pair) continue;

      out.push({
        driver: mapping.driver,
        driverLabel: mapping.driverLabel,
        equity: mapping.equityTarget,
        equityLabel: mapping.equityLabel,
        expectedSign: mapping.expectedSign,
        beta: pair.fullSample?.beta ?? null,
        rollingShortBeta: pair.rolling.r6?.beta ?? null,
        rollingLongBeta: pair.rolling.r24?.beta ?? null,
        bestLag: pair.leadLag?.bestLag ?? null,
        bestCorrAtLag: pair.leadLag?.bestCorr ?? null,
        driverZ: pair.notPriced?.driverZ ?? null,
        equityZ: pair.notPriced?.equityZ ?? null,
        notPriced: !!pair.notPriced?.triggered,
        notPricedReason: pair.notPriced?.reason ?? null,
      });
    } catch {
      // skip silently — brief should still compile
    }
  }
  return out;
}

export async function buildBriefInputs(opts?: {
  drivers?: string[];
  crossAsset?: string[];
  equities?: string[];
  pairs?: Array<{ driver: string; equity: string }>;
}): Promise<BriefInputs> {
  const driverIds = opts?.drivers ?? DEFAULT_BRIEF_DRIVERS;
  const crossIds = opts?.crossAsset ?? DEFAULT_CROSS_ASSET;
  const equityIds = opts?.equities ?? DEFAULT_BRIEF_EQUITIES;
  const pairList = opts?.pairs ?? DEFAULT_ATTRIBUTION_PAIRS;

  const [driverSnaps, crossSnaps, equitySnaps, attribLite] = await Promise.all([
    Promise.all(driverIds.map((id) => snapshotDriver(id).catch(() => null))),
    Promise.all(crossIds.map((id) => snapshotCrossAsset(id).catch(() => null))),
    Promise.all(equityIds.map((id) => snapshotEquity(id).catch(() => null))),
    snapshotAttribution(pairList),
  ]);

  const drivers = driverSnaps.filter((x): x is DriverBriefSnapshot => x !== null);
  const crossAsset = crossSnaps.filter((x): x is CrossAssetSnapshot => x !== null);
  const equities = equitySnaps.filter((x): x is EquityBriefSnapshot => x !== null);

  // Breadth tilt across drivers
  let up = 0, down = 0, flat = 0;
  for (const d of drivers) {
    if (d.trendClass === "stable") flat++;
    else if (d.mom != null && d.mom > 0) up++;
    else if (d.mom != null && d.mom < 0) down++;
    else flat++;
  }
  const total = Math.max(drivers.length, 1);
  let tilt: "broad-up" | "broad-down" | "mixed" | "flat";
  if (up / total >= 0.6) tilt = "broad-up";
  else if (down / total >= 0.6) tilt = "broad-down";
  else if (flat / total >= 0.6) tilt = "flat";
  else tilt = "mixed";

  const upcomingReleases = getUpcomingReleases(14).map((r) => ({
    date: r.date,
    agency: r.agency,
    indicator: r.indicator,
    frequency: r.frequency,
  }));

  const asOf = new Date().toISOString();
  const asOfDate = asOf.slice(0, 10);

  return {
    asOf,
    asOfDate,
    drivers,
    crossAsset,
    equities,
    attribution: attribLite,
    upcomingReleases,
    breadth: { up, down, flat, total: drivers.length, tilt },
  };
}

// ─── LLM synthesis ───────────────────────────────────────────────────────

export interface BriefSections {
  what_happened: string;
  regime_shifts: string;
  cross_asset: string;
  priced_vs_not: string;
  forward_watch: string;
  trade_implications: string;
}

export interface BriefOutput {
  asOfDate: string;
  execSummary: string;
  sections: BriefSections;
}

const SYSTEM_PROMPT = [
  "You are a senior China macro analyst writing a deep-dive market brief.",
  "Your voice blends two registers:",
  "  (1) sell-side institutional research — neutral, balanced, contrast bull/bear,",
  "      always include risk language (\"risks include\", \"however\", \"the counter is\").",
  "  (2) PM journal — first-person investor reasoning (\"what I'm watching\",",
  "      \"I'd lean toward\", \"my read is\", \"the question I keep coming back to is\").",
  "DO NOT write in hedge-fund swagger. AVOID: \"we like\", \"we'd fade\", \"the desk thinks\",",
  "  \"we'd add\", \"my best idea is\". Write reflectively, not promotionally.",
  "",
  "Ground every claim in the data shown in the inputs. NEVER invent numbers, headlines,",
  "or news events. If you reference a magnitude, cite the figure (z-score, MoM%, YoY%,",
  "trend classification) from the inputs. If you don't have a number, say so explicitly",
  "(\"the data doesn't tell us yet whether ...\").",
  "",
  "China-first lens. Cross-asset is for color: dollar tone, US rates, oil, copper, VIX —",
  "frame these as global backdrop, not the main subject. The center of gravity is",
  "Chinese macro data and equity attribution.",
  "",
  "Output STRICT JSON only. No markdown fences. No preamble. No trailing prose.",
  "Schema is in the user prompt.",
].join(" ");

function buildUserPrompt(inputs: BriefInputs): string {
  const driverLines = inputs.drivers.map((d) => {
    const parts = [
      `- ${d.id} (${d.label}): latest=${d.latestValue ?? "n/a"}${d.unit ? " " + d.unit : ""} on ${d.latestDate ?? "?"}`,
      `MoM=${d.mom != null ? d.mom.toFixed(2) + "%" : "n/a"}`,
      `YoY=${d.yoy != null ? d.yoy.toFixed(2) + "%" : "n/a"}`,
      `z=${d.zScore != null ? d.zScore.toFixed(2) : "n/a"} (${d.severity ?? "n/a"})`,
      `trend=${d.trendClass}${d.multiscaleConfirmed ? " confirmed" : ""}`,
      d.trendStart ? `since ${d.trendStart}` : "",
    ];
    return parts.filter(Boolean).join("; ");
  }).join("\n");

  const crossLines = inputs.crossAsset.map((c) => {
    return `- ${c.id} (${c.label}): ${c.latestValue ?? "n/a"}${c.unit ? " " + c.unit : ""} on ${c.latestDate ?? "?"}; 5d=${c.change5d != null ? c.change5d.toFixed(2) + "%" : "n/a"}; 1m=${c.change1m != null ? c.change1m.toFixed(2) + "%" : "n/a"}; YTD=${c.ytd != null ? c.ytd.toFixed(2) + "%" : "n/a"}`;
  }).join("\n");

  const equityLines = inputs.equities.map((e) => {
    return `- ${e.id} (${e.label}): ${e.latestLevel ?? "n/a"} on ${e.latestDate ?? "?"}; MoM=${e.mom != null ? e.mom.toFixed(2) + "%" : "n/a"}; YTD=${e.ytd != null ? e.ytd.toFixed(2) + "%" : "n/a"}`;
  }).join("\n");

  const attribLines = inputs.attribution.length === 0
    ? "- (no qualifying pairs)"
    : inputs.attribution.map((a) => {
        const flag = a.notPriced ? " [SIGN-BREAK / NOT-PRICED]" : "";
        const reason = a.notPriced && a.notPricedReason ? ` — ${a.notPricedReason}` : "";
        return `- ${a.driver} (${a.driverLabel}) → ${a.equity} (${a.equityLabel}, expected ${a.expectedSign > 0 ? "+" : "−"}): beta_full=${a.beta != null ? a.beta.toFixed(3) : "n/a"}; beta_r6=${a.rollingShortBeta != null ? a.rollingShortBeta.toFixed(3) : "n/a"}; beta_r24=${a.rollingLongBeta != null ? a.rollingLongBeta.toFixed(3) : "n/a"}; bestLag=${a.bestLag ?? "n/a"} (corr=${a.bestCorrAtLag != null ? a.bestCorrAtLag.toFixed(2) : "n/a"}); driverZ=${a.driverZ != null ? a.driverZ.toFixed(2) : "n/a"}; equityZ=${a.equityZ != null ? a.equityZ.toFixed(2) : "n/a"}${flag}${reason}`;
      }).join("\n");

  const calLines = inputs.upcomingReleases.length === 0
    ? "- (none within 14d)"
    : inputs.upcomingReleases.map((r) => `- ${r.date} ${r.agency} ${r.indicator} (${r.frequency})`).join("\n");

  const schema = {
    asOfDate: inputs.asOfDate,
    execSummary: "string — one cohesive paragraph (4–6 sentences). State the dominant theme, what's confirmed by breadth, the key tension, and what I'd be watching.",
    sections: {
      what_happened:       "string — recap of last ~30 days using the latest monthly prints. Cite specific drivers + magnitudes. Note multiscale confirmation where relevant.",
      regime_shifts:       "string — call out trend classifications that broke or flipped (e.g. 'PPI's bear trend is now 6 months old and rolling over'). Anchor to trendStart dates and multiscaleConfirmed flags.",
      cross_asset:         "string — DXY/UST/Brent/Copper/VIX read. Frame as global backdrop affecting China — e.g. weaker USD → easier RMB/easier liquidity. Cite the 5d/1m/YTD moves from inputs.",
      priced_vs_not:       "string — discuss attribution pairs with SIGN-BREAK or NOT-PRICED flags. Explain what those signals mean for positioning. If no flags fired, say so plainly.",
      forward_watch:       "string — the next 14d release calendar viewed through the current setup. Which prints could confirm/invalidate the dominant theme? PM-journal voice here.",
      trade_implications:  "string — neutral, balanced. State the base-case lean, then the contra. Use \"risks include\" / \"the counter is\". DO NOT prescribe specific trades. Avoid hedge-fund swagger.",
    },
  };

  return [
    `# As-of: ${inputs.asOf}`,
    `# Breadth tilt across ${inputs.breadth.total} drivers: ${inputs.breadth.tilt} (up=${inputs.breadth.up} down=${inputs.breadth.down} flat=${inputs.breadth.flat})`,
    ``,
    `## China macro drivers (latest)`,
    driverLines || "- (none available)",
    ``,
    `## Cross-asset (color)`,
    crossLines || "- (none available)",
    ``,
    `## China equities`,
    equityLines || "- (none available)",
    ``,
    `## Macro→Equity attribution (sign-breaks & not-priced flags)`,
    attribLines,
    ``,
    `## Upcoming releases (next 14d)`,
    calLines,
    ``,
    `## Task`,
    `Produce a market brief. Output STRICT JSON matching this schema:`,
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    `Return ONLY the JSON object. No prose, no markdown fences.`,
    `Each section should be 2–5 short paragraphs or a few crisp bullets folded into prose. Total brief length ~600–1100 words.`,
  ].join("\n");
}

function extractJson(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM did not return a JSON object");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function validateAndNormalize(raw: any, inputs: BriefInputs): BriefOutput {
  if (!raw || typeof raw !== "object") throw new Error("Brief output is not an object");
  const sections = raw.sections ?? {};
  const required = ["what_happened", "regime_shifts", "cross_asset", "priced_vs_not", "forward_watch", "trade_implications"];
  for (const k of required) {
    if (typeof sections[k] !== "string") {
      // Provide a fallback rather than failing the whole brief.
      sections[k] = sections[k] != null ? String(sections[k]) : "(section missing from model output)";
    }
  }
  const execSummary = typeof raw.execSummary === "string" ? raw.execSummary : "";
  return {
    asOfDate: inputs.asOfDate,
    execSummary,
    sections: {
      what_happened: sections.what_happened,
      regime_shifts: sections.regime_shifts,
      cross_asset: sections.cross_asset,
      priced_vs_not: sections.priced_vs_not,
      forward_watch: sections.forward_watch,
      trade_implications: sections.trade_implications,
    },
  };
}

export interface GenerateBriefResult {
  output: BriefOutput;
  inputs: BriefInputs;
  model: LlmModel;
  costUsd: number;
  cacheHit: boolean;
  tokensIn: number;
  tokensOut: number;
}

export async function generateBrief(opts?: {
  model?: LlmModel;
  drivers?: string[];
  crossAsset?: string[];
  equities?: string[];
  pairs?: Array<{ driver: string; equity: string }>;
}): Promise<GenerateBriefResult> {
  // Default Sonnet — brief is a longer synthesis than scenarios and benefits from
  // higher-fidelity reasoning. UI exposes a Haiku toggle for cheaper runs.
  const model = opts?.model ?? (await getDefaultReportModel());
  const inputs = await buildBriefInputs({
    drivers: opts?.drivers,
    crossAsset: opts?.crossAsset,
    equities: opts?.equities,
    pairs: opts?.pairs,
  });

  const userPrompt = buildUserPrompt(inputs);
  const commentary = await generateCommentary({
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    actionContext: `brief:${inputs.asOfDate}`,
    maxOutputTokens: 3200,
    cacheTtlSeconds: 24 * 3600, // 24h
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

// Re-export for routes (so they can reference equity universe etc.)
export { EQUITY_UNIVERSE };
