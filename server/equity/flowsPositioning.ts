/**
 * Flow & positioning (Gap C) — "what is the money doing" signal for the
 * portfolio. Assembles the live northbound (Stock Connect) flow series, the
 * market-wide margin/leverage trend, and (best-effort) the top sector
 * inflows/outflows, then has the LLM interpret the combined picture into a
 * structured regime signal.
 *
 * The raw numeric series are kept ALONGSIDE the LLM call: the dashboard/report
 * always shows the hard numbers (5d/20d net, cumulative direction, margin trend,
 * sector leaders) even when the model output is unavailable.
 *
 * LLM output (grounded, not rule-based):
 *   { regime, confidence, narrative, drivers[], positioningExtremes[] }
 *
 * Used by the report (sectorDigest "FLOWS & POSITIONING" block), the
 * /api/equity/flows-positioning route (Sectors UI), and the PPTX/deck FLOWS
 * slide. Best-effort + cached ~6h: never throws to the caller — missing data
 * (sidecar 404 before deploy, EastMoney intermittent, LLM failure) returns a
 * partial block with notes. Mirrors riskDashboard.ts (Gap E) / valuationContext.ts (Gap A).
 */

import { generateCommentary, type LlmModel } from "../analysis/llm";
import {
  getNorthboundFlows,
  getNorthboundSummary,
  getMarginBalances,
  getAkshareSectorFlows,
  type NorthboundPoint,
  type NorthboundSummaryRow,
  type MarginPoint,
} from "../clients/akshare";

export type FlowRegime = "risk-on" | "risk-off" | "neutral" | "extreme";

const VALID_REGIMES: FlowRegime[] = ["risk-on", "risk-off", "neutral", "extreme"];

/**
 * Northbound (Stock Connect 北向资金) daily net-flow disclosure was DISCONTINUED
 * by HKEX/the exchanges in Aug 2024 — the last session with a real daily net-buy
 * value is ~2024-08-16; every row after is null and holdings_mktval reads 0.
 * We treat a latest-real-data date before this cutoff as "discontinued" and stop
 * feeding the dead series to the LLM as if it were a live signal.
 */
const NORTHBOUND_DISCONTINUED_BEFORE = "2024-09-01";

/** Northbound (Stock Connect) summary derived from the raw daily series. */
export interface NorthboundSignal {
  status: "live" | "discontinued";
  latestDate: string | null;     // latest row date in the series (may be null-valued)
  lastDataDate: string | null;   // last session with a real (non-null) daily net buy
  net5d: number | null;          // sum of daily net buy, last 5 sessions (CNY)
  net20d: number | null;         // sum of daily net buy, last 20 sessions (CNY)
  cumulativeDirection: "rising" | "falling" | "flat" | null;
  cumulativeNetBuy: number | null;
  holdingsMktval: number | null;
  note: string | null;
  series: { date: string; dailyNetBuy: number | null; cumulativeNetBuy: number | null }[];
}

/** Southbound (港股通, 南向资金) flow derived from the today summary. PRIMARY connect signal now. */
export interface SouthboundSignal {
  tradeDate: string | null;
  netBuy: number | null;         // today's net buy (CNY; summary 亿 values normalized ×1e8)
  direction: "inflow" | "outflow" | "flat" | null;
}

/** Margin / leverage trend derived from the raw daily series. */
export interface MarginSignal {
  latestDate: string | null;
  financingBalance: number | null;
  trend: "rising" | "falling" | "flat" | null;
  pctChange20d: number | null;   // % change in financing balance vs ~20 sessions ago
  level: "elevated" | "moderate" | "low" | null;
  series: { date: string; financingBalance: number | null }[];
}

export interface SectorFlowLeader {
  sector: string;
  netInflow: number | null;      // CNY
}

export interface FlowsPositioning {
  generatedAt: string;
  regime: FlowRegime | null;
  confidence: number | null;     // 0-100
  narrative: string;
  drivers: string[];
  positioningExtremes: string[];
  northbound: NorthboundSignal | null;
  southbound: SouthboundSignal | null;
  margin: MarginSignal | null;
  sectorInflows: SectorFlowLeader[];
  sectorOutflows: SectorFlowLeader[];
  notes: string[];               // degradation notes (sidecar/sector-flows/LLM unavailable)
  model: string;
  costUsd: number;
}

export interface BuildFlowsOpts {
  model?: LlmModel;
  forceRefresh?: boolean;        // bypass the 6h cache read (still writes the cache)
}

// ── cache (mirror riskDashboard.ts) ──────────────────────────────────────────
const cache = new Map<string, { at: number; result: FlowsPositioning }>();
const TTL = 6 * 60 * 60 * 1000; // 6h
const CACHE_KEY = "flows:portfolio";

function sumLast(series: (number | null)[], n: number): number | null {
  const vals = series.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return null;
  const tail = vals.slice(-n);
  if (!tail.length) return null;
  return tail.reduce((a, b) => a + b, 0);
}

function strArr(a: any, max = 6): string[] {
  if (!Array.isArray(a)) return [];
  return a.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max);
}

function clampPct(n: any): number | null {
  if (n == null) return null;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

/** CNY → 亿 (100M) string for prompt/series readability. */
function yi(v: number | null | undefined, d = 1): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${(v / 1e8).toFixed(d)}亿`;
}

// ── signal assembly (live series, grounded) ──────────────────────────────────

function buildNorthboundSignal(rows: NorthboundPoint[]): NorthboundSignal | null {
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  const dailyNets = rows.map((r) => r.daily_net_buy);
  const cumSeries = rows.map((r) => r.cumulative_net_buy).filter((v): v is number => typeof v === "number");

  // Last session with a REAL (non-null, finite) daily net-buy value.
  let lastDataDate: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i].daily_net_buy;
    if (typeof v === "number" && Number.isFinite(v)) { lastDataDate = rows[i].date ?? null; break; }
  }
  // Discontinued once the freshest real value predates the HKEX cutoff (or none at all).
  const status: NorthboundSignal["status"] =
    !lastDataDate || lastDataDate < NORTHBOUND_DISCONTINUED_BEFORE ? "discontinued" : "live";

  let cumulativeDirection: NorthboundSignal["cumulativeDirection"] = null;
  if (status === "live" && cumSeries.length >= 2) {
    const a = cumSeries[Math.max(0, cumSeries.length - 21)];
    const b = cumSeries[cumSeries.length - 1];
    const diff = b - a;
    const denom = Math.abs(a) || 1;
    cumulativeDirection = Math.abs(diff) / denom < 0.005 ? "flat" : diff > 0 ? "rising" : "falling";
  }
  return {
    status,
    latestDate: latest.date ?? null,
    lastDataDate,
    net5d: status === "live" ? sumLast(dailyNets, 5) : null,
    net20d: status === "live" ? sumLast(dailyNets, 20) : null,
    cumulativeDirection,
    cumulativeNetBuy: status === "live" ? latest.cumulative_net_buy ?? null : null,
    holdingsMktval: status === "live" ? latest.holdings_mktval ?? null : null,
    note:
      status === "discontinued"
        ? `HKEX discontinued daily Northbound net-flow disclosure (Aug 2024); Southbound + margin used instead.${lastDataDate ? ` Last data: ${lastDataDate}.` : ""}`
        : null,
    series: rows.slice(-60).map((r) => ({ date: r.date, dailyNetBuy: r.daily_net_buy, cumulativeNetBuy: r.cumulative_net_buy })),
  };
}

/** Build today's Southbound (港股通 / 南向资金) flow from the connect summary rows. */
function buildSouthboundSignal(rows: NorthboundSummaryRow[]): SouthboundSignal | null {
  if (!rows.length) return null;
  // 南向 / 港股通 rows carry Southbound (HK-bound) flow; pick the aggregate net.
  const south = rows.filter(
    (r) => /南向|港股通/.test(String(r.direction ?? "")) || /南向|港股通/.test(String(r.type ?? "")),
  );
  if (!south.length) return null;
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // net_buy in this summary endpoint is reported in 亿 (100M CNY); normalize to
  // raw CNY (×1e8) so it matches the rest of the pipeline's CNY + yi() convention.
  // (net_inflow is a quota-style figure here, not a comparable flow — ignore it.)
  const parts = south.map((r) => num(r.net_buy)).filter((v): v is number => v != null);
  const netBuyYi = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  const netBuy = netBuyYi == null ? null : netBuyYi * 1e8;
  // Threshold in 亿: under ~0.5亿 net is effectively flat.
  const direction: SouthboundSignal["direction"] =
    netBuyYi == null ? null : Math.abs(netBuyYi) < 0.5 ? "flat" : netBuyYi > 0 ? "inflow" : "outflow";
  return {
    tradeDate: south[0]?.trade_date ?? null,
    netBuy,
    direction,
  };
}

function buildMarginSignal(rows: MarginPoint[]): MarginSignal | null {
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  const fin = rows.map((r) => r.financing_balance).filter((v): v is number => typeof v === "number");
  let trend: MarginSignal["trend"] = null;
  let pctChange20d: number | null = null;
  if (fin.length >= 2) {
    const prior = fin[Math.max(0, fin.length - 21)];
    const cur = fin[fin.length - 1];
    if (prior) {
      pctChange20d = Math.round(((cur - prior) / Math.abs(prior)) * 1000) / 10;
      trend = Math.abs(pctChange20d) < 0.5 ? "flat" : pctChange20d > 0 ? "rising" : "falling";
    }
  }
  // Level vs the available history window (rough heuristic; full history is long).
  let level: MarginSignal["level"] = null;
  if (fin.length >= 30 && latest.financing_balance != null) {
    const sorted = [...fin].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.25)];
    const hi = sorted[Math.floor(sorted.length * 0.75)];
    level = latest.financing_balance >= hi ? "elevated" : latest.financing_balance <= lo ? "low" : "moderate";
  }
  // financing_balance is reported in 亿 (100M CNY) by the sidecar; normalize the
  // ABSOLUTE values to raw CNY (×1e8) so yi()/fmtYi render correctly. Trend, level
  // and pctChange20d are ratio-based and unaffected, so they stay on the raw 亿.
  const toCny = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v * 1e8 : null;
  return {
    latestDate: latest.date ?? null,
    financingBalance: toCny(latest.financing_balance),
    trend,
    pctChange20d,
    level,
    series: rows.slice(-60).map((r) => ({ date: r.date, financingBalance: toCny(r.financing_balance) })),
  };
}

interface AssembledFlows {
  northbound: NorthboundSignal | null;
  southbound: SouthboundSignal | null;
  margin: MarginSignal | null;
  sectorInflows: SectorFlowLeader[];
  sectorOutflows: SectorFlowLeader[];
  notes: string[];
}

async function assembleFlows(): Promise<AssembledFlows> {
  const notes: string[] = [];
  const [nb, summary, mg, flows] = await Promise.all([
    getNorthboundFlows(250).catch((e: any) => ({ data: [] as NorthboundPoint[], error: e?.message })),
    getNorthboundSummary().catch(() => ({ data: [] as NorthboundSummaryRow[] })),
    getMarginBalances(250).catch((e: any) => ({ data: [] as MarginPoint[], error: e?.message })),
    getAkshareSectorFlows("今日").catch(() => ({ data: [] as any[], error: "unavailable" })),
  ]);

  const northbound = buildNorthboundSignal((nb as any).data ?? []);
  if (!northbound) notes.push("Northbound flows unavailable (sidecar /flows/northbound).");
  else if (northbound.status === "discontinued" && northbound.note) notes.push(northbound.note);

  const southbound = buildSouthboundSignal(((summary as any).data ?? []) as NorthboundSummaryRow[]);
  if (!southbound) notes.push("Southbound (港股通) flow unavailable this refresh.");

  const margin = buildMarginSignal((mg as any).data ?? []);
  if (!margin) notes.push("Margin balances unavailable (sidecar /flows/margin).");

  // Top sector inflows/outflows from the live snapshot (intermittent upstream).
  const sectorInflows: SectorFlowLeader[] = [];
  const sectorOutflows: SectorFlowLeader[] = [];
  const rows = ((flows as any).data ?? []) as { sector: string; main_net_inflow?: number }[];
  const withFlow = rows.filter((r) => typeof r.main_net_inflow === "number");
  if (withFlow.length) {
    const sorted = [...withFlow].sort((a, b) => (b.main_net_inflow ?? 0) - (a.main_net_inflow ?? 0));
    for (const r of sorted.slice(0, 5)) sectorInflows.push({ sector: r.sector, netInflow: r.main_net_inflow ?? null });
    for (const r of sorted.slice(-5).reverse()) sectorOutflows.push({ sector: r.sector, netInflow: r.main_net_inflow ?? null });
  } else {
    notes.push("Sector fund flows unavailable (EastMoney intermittent).");
  }

  return { northbound, southbound, margin, sectorInflows, sectorOutflows, notes };
}

// ── prompt evidence block ────────────────────────────────────────────────────

function evidenceBlock(a: AssembledFlows): string {
  const parts: string[] = [];
  // MARGIN / LEVERAGE is the PRIMARY live signal (daily net Northbound was
  // discontinued by HKEX in Aug 2024 — see below), so lead with it.
  if (a.margin) {
    const m = a.margin;
    parts.push(
      "MARGIN / LEVERAGE — PRIMARY SIGNAL (market-wide 融资余额, live daily, CNY):\n" +
        `  - As of ${m.latestDate ?? "?"}\n` +
        `  - Financing balance: ${yi(m.financingBalance)} (level: ${m.level ?? "n/a"})\n` +
        `  - Trend over ~20d: ${m.trend ?? "n/a"}${m.pctChange20d != null ? ` (${m.pctChange20d > 0 ? "+" : ""}${m.pctChange20d}%)` : ""}\n` +
        `  - Interpretation guide: rising financing balance = leverage build / risk-on; falling = de-risking / risk-off.`,
    );
  } else {
    parts.push("MARGIN / LEVERAGE: unavailable this refresh.");
  }
  if (a.southbound) {
    const sb = a.southbound;
    parts.push(
      "SOUTHBOUND (港股通 / 南向资金, today, CNY) — live connect flow:\n" +
        `  - Trade date: ${sb.tradeDate ?? "?"}\n` +
        `  - Net buy: ${yi(sb.netBuy)} (direction ${sb.direction ?? "n/a"})`,
    );
  } else {
    parts.push("SOUTHBOUND (港股通): unavailable this refresh.");
  }
  if (a.sectorInflows.length || a.sectorOutflows.length) {
    const ins = a.sectorInflows.map((s) => `${s.sector} +${yi(s.netInflow)}`).join("; ");
    const outs = a.sectorOutflows.map((s) => `${s.sector} ${yi(s.netInflow)}`).join("; ");
    parts.push(`SECTOR FUND FLOWS (today, EastMoney):\n  - Top inflows: ${ins || "n/a"}\n  - Top outflows: ${outs || "n/a"}`);
  } else {
    parts.push("SECTOR FUND FLOWS: unavailable this refresh.");
  }
  // Northbound is a single FACT, not a numeric input — keep the model from
  // reasoning over (or warning about) the dead null series.
  if (a.northbound?.status === "discontinued") {
    parts.push(
      "NORTHBOUND (Stock Connect 北向资金): DISCONTINUED. HKEX/exchanges stopped " +
        `publishing daily Northbound net-flow in Aug 2024 (last real data ${a.northbound.lastDataDate ?? "~2024-08-16"}). ` +
        "This is a real-world disclosure change, NOT a data gap or quality issue — do NOT flag it as such. " +
        "Base the regime on the margin/leverage trend, Southbound, and sector flows above.",
    );
  } else if (a.northbound) {
    const nb = a.northbound;
    parts.push(
      "NORTHBOUND (Stock Connect 北向资金, live daily, CNY):\n" +
        `  - As of ${nb.latestDate ?? "?"}; net buy 5d ${yi(nb.net5d)}, 20d ${yi(nb.net20d)}; cumulative ${nb.cumulativeDirection ?? "n/a"}.`,
    );
  }
  return parts.join("\n\n");
}

// ── LLM interpretation ───────────────────────────────────────────────────────

async function interpret(
  evidence: string,
  opts: BuildFlowsOpts,
): Promise<{ regime: FlowRegime | null; confidence: number | null; narrative: string; drivers: string[]; positioningExtremes: string[]; cost: number; note?: string }> {
  const model = opts.model ?? "claude-sonnet-4";
  const system =
    "You are a flow & positioning strategist for an institutional China/HK equity desk. " +
    "Classify the current positioning REGIME from the live signals. The BACKBONE of the regime is the " +
    "market-wide MARGIN/LEVERAGE trend (rising financing balance = leverage build / risk-on; falling = de-risking / risk-off), " +
    "supplemented by Southbound (港股通) connect flow and sector fund flows. " +
    "Northbound (Stock Connect) daily net-flow was DISCONTINUED by HKEX in Aug 2024 — treat its absence as a known " +
    "real-world disclosure change, NOT a data gap; do NOT emit 'data quality', 'data integrity', or 'data warning' language. " +
    "Ground EVERY claim in a SPECIFIC value from the EVIDENCE BASE (cite the series name + value, e.g. 'financing balance +X% over 20d'); do not invent data. " +
    "positioningExtremes are crowded/stretched or capitulation conditions a PM should be warned about. " +
    "Output STRICT JSON ONLY, no prose, no markdown fences.";
  const user =
    `=== EVIDENCE BASE ===\n${evidence}\n=== END EVIDENCE BASE ===\n\n` +
    "Produce STRICT JSON:\n" +
    `{ "regime": "risk-on|risk-off|neutral|extreme", "confidence": 0-100, "narrative": "2-4 sentences citing specific series values", "drivers": ["..."], "positioningExtremes": ["crowded/stretched/capitulation flags, or [] if none"] }\n` +
    "Rules: regime MUST be one of the four labels and MUST be driven primarily by the margin/leverage trend (then Southbound, then sector flows). " +
    "narrative + drivers MUST cite real values from the EVIDENCE BASE. Do NOT mention Northbound's discontinuation as a weakness or caveat in confidence — margin/leverage is a complete signal on its own. " +
    "Use 'extreme' only when leverage/flows are at a stretched or capitulation extreme. positioningExtremes may be empty.";

  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: "flows_positioning",
    maxOutputTokens: 1400,
  });
  const obj = extractJsonObject(res.text);
  if (!obj) return { regime: null, confidence: null, narrative: "", drivers: [], positioningExtremes: [], cost: res.costUsd, note: "Model output could not be parsed." };
  const regime: FlowRegime | null = VALID_REGIMES.includes(obj.regime) ? obj.regime : null;
  return {
    regime,
    confidence: clampPct(obj.confidence),
    narrative: String(obj.narrative ?? "").trim(),
    drivers: strArr(obj.drivers, 6),
    positioningExtremes: strArr(obj.positioningExtremes, 6),
    cost: res.costUsd,
  };
}

/**
 * Build the portfolio flow & positioning block. Never throws — degrades to raw
 * data + notes when the sidecar (pre-deploy 404), sector flows, or LLM fail.
 */
export async function buildFlowsPositioning(opts: BuildFlowsOpts = {}): Promise<FlowsPositioning> {
  if (!opts.forceRefresh) {
    const cached = cache.get(CACHE_KEY);
    if (cached && Date.now() - cached.at < TTL) return cached.result;
  }

  const model = opts.model ?? "claude-sonnet-4";

  let a: AssembledFlows;
  try {
    a = await assembleFlows();
  } catch (err: any) {
    a = { northbound: null, southbound: null, margin: null, sectorInflows: [], sectorOutflows: [], notes: [`Flow assembly failed: ${err?.message ?? "unknown"}.`] };
  }

  const result: FlowsPositioning = {
    generatedAt: new Date().toISOString(),
    regime: null,
    confidence: null,
    narrative: "",
    drivers: [],
    positioningExtremes: [],
    northbound: a.northbound,
    southbound: a.southbound,
    margin: a.margin,
    sectorInflows: a.sectorInflows,
    sectorOutflows: a.sectorOutflows,
    notes: [...a.notes],
    model,
    costUsd: 0,
  };

  // Only call the LLM if we have at least one LIVE signal. A discontinued
  // Northbound series is NOT a live signal (its numbers are null), so it does
  // not by itself justify an LLM call.
  const liveNorthbound = a.northbound?.status === "live";
  const haveSignal = !!(liveNorthbound || a.southbound || a.margin || a.sectorInflows.length || a.sectorOutflows.length);
  if (haveSignal) {
    try {
      const llm = await interpret(evidenceBlock(a), opts);
      result.regime = llm.regime;
      result.confidence = llm.confidence;
      result.narrative = llm.narrative;
      result.drivers = llm.drivers;
      result.positioningExtremes = llm.positioningExtremes;
      result.costUsd = llm.cost;
      if (llm.note) result.notes.push(llm.note);
    } catch (err: any) {
      result.notes.push(`Regime interpretation failed: ${err?.message ?? "unknown"}.`);
    }
  } else {
    result.notes.push("No live flow signal available — regime not interpreted.");
  }

  // Cache only when we have something useful (a signal or a regime), so a
  // transient all-404 refresh doesn't get pinned for 6h.
  if (haveSignal || result.regime) cache.set(CACHE_KEY, { at: Date.now(), result });

  return result;
}

// ── serializer (mirror valuationContextLine / riskDashboardLine) ─────────────

/** One-line human summary of the flows block for the report digest. */
export function flowsPositioningLine(f: FlowsPositioning): string {
  const parts: string[] = [];
  if (f.regime) parts.push(`Regime: ${f.regime}${f.confidence != null ? ` (${f.confidence}% conf)` : ""}`);
  // Margin/leverage is the primary signal — lead with it.
  if (f.margin) {
    const m = f.margin;
    parts.push(`Margin ${yi(m.financingBalance)} (${m.trend ?? "n/a"}${m.pctChange20d != null ? ` ${m.pctChange20d > 0 ? "+" : ""}${m.pctChange20d}% 20d` : ""}, ${m.level ?? "n/a"})`);
  }
  if (f.southbound) {
    const sb = f.southbound;
    parts.push(`Southbound net ${yi(sb.netBuy)} (${sb.direction ?? "n/a"})`);
  }
  if (f.sectorInflows.length) parts.push(`Top inflows: ${f.sectorInflows.slice(0, 3).map((s) => `${s.sector} +${yi(s.netInflow)}`).join("; ")}`);
  if (f.sectorOutflows.length) parts.push(`Top outflows: ${f.sectorOutflows.slice(0, 3).map((s) => `${s.sector} ${yi(s.netInflow)}`).join("; ")}`);
  if (f.narrative) parts.push(f.narrative.slice(0, 200));
  if (f.positioningExtremes.length) parts.push(`Extremes: ${f.positioningExtremes.slice(0, 2).join("; ")}`);
  // Footnote the Northbound discontinuation (live values shown only if still live).
  if (f.northbound?.status === "discontinued") {
    parts.push(`Northbound: discontinued${f.northbound.lastDataDate ? ` (last ${f.northbound.lastDataDate})` : ""}`);
  } else if (f.northbound) {
    const nb = f.northbound;
    const dir = nb.cumulativeDirection ? `, cumulative ${nb.cumulativeDirection}` : "";
    parts.push(`Northbound 5d ${yi(nb.net5d)} / 20d ${yi(nb.net20d)}${dir}`);
  }
  if (!parts.length && f.notes.length) return f.notes.join(" ");
  return parts.join(" | ");
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
