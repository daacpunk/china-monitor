/**
 * Relative & global context (Gap F) — frames the top-down call on China assets.
 *
 * Recombines series we already pull into a single top-down snapshot:
 *   - AH premium  — A-share vs H-share premium for dual-listed names (median),
 *     a gauge of onshore-vs-offshore positioning / sentiment.
 *   - China equity returns — CSI 300 + Hang Seng YTD and ~12m total return,
 *     from the AKShare index-history client (already deployed via /index/historical).
 *   - Cross-asset backdrop — latest USD/CNY (from the CEIC usdcny_monthly series)
 *     and the US-China 10Y yield differential (a CNY-pressure gauge).
 *
 * EM/DM honesty: we do NOT fabricate an MSCI EM/DM benchmark series. China index
 * returns are framed against the US-rate + USD/CNY backdrop, with a note that a
 * clean EM/DM benchmark is unavailable in this data set.
 *
 * The LLM adds ONLY a thin read-through on top of the code-assembled numbers:
 *   { stance: "constructive"|"neutral"|"cautious", whyChina: "1-2 sentences", drivers: ["..."] }
 *
 * Used by the report (sectorDigest "RELATIVE CONTEXT" block), the
 * /api/equity/relative-context route (Overview UI), and the PPTX/deck RELATIVE
 * CONTEXT slide. Best-effort + cached ~6h: never throws — missing legs (sidecar
 * /relative/* 404 before deploy, LLM failure) degrade to the numeric skeleton +
 * notes. Mirrors flowsPositioning.ts (Gap C) / riskDashboard.ts (Gap E).
 */

import { generateCommentary, type LlmModel } from "../analysis/llm";
import {
  getAhPremium,
  getCrossAssetYields,
  getAkshareIndexHistorical,
  type AhPremiumSnapshot,
  type CrossAssetYieldPoint,
  type AkshareOhlcvPoint,
} from "../clients/akshare";
import { fetchSeries } from "../series/fetchSeries";

export type Stance = "constructive" | "neutral" | "cautious";

const VALID_STANCES: Stance[] = ["constructive", "neutral", "cautious"];

/** Index return summary (YTD + trailing ~12m). */
export interface IndexReturn {
  index: string;          // display label
  symbol: string;         // AKShare index symbol
  lastClose: number | null;
  lastDate: string | null;
  ytdPct: number | null;
  ret12mPct: number | null;
}

/** AH premium leg of the snapshot. */
export interface AhPremiumSignal {
  aggregatePremiumPct: number | null;
  pairCount: number | null;
  topPremium: { name: string | null; code: string | null; premiumPct: number | null }[];
  bottomPremium: { name: string | null; code: string | null; premiumPct: number | null }[];
  level: "elevated" | "moderate" | "compressed" | null;
  note: string | null;
}

/** Cross-asset backdrop leg (FX + rate differential). */
export interface CrossAssetSignal {
  usdCny: number | null;
  usdCnyDate: string | null;
  usCn10yDiff: number | null;   // us_10y - cn_10y (pct points)
  cn10y: number | null;
  us10y: number | null;
  yieldsDate: string | null;
}

export interface RelativeContext {
  generatedAt: string;
  stance: Stance | null;
  whyChina: string;
  drivers: string[];
  ahPremium: AhPremiumSignal | null;
  indexReturns: IndexReturn[];
  crossAsset: CrossAssetSignal | null;
  notes: string[];              // degradation notes (sidecar 404 / LLM unavailable / EM-DM caveat)
  model: string;
  costUsd: number;
}

export interface BuildRelativeContextOpts {
  model?: LlmModel;
  forceRefresh?: boolean;       // bypass the 6h cache read (still writes the cache)
}

// ── cache (mirror flowsPositioning.ts) ───────────────────────────────────────
const cache = new Map<string, { at: number; result: RelativeContext }>();
const TTL = 6 * 60 * 60 * 1000; // 6h
const CACHE_KEY = "relative:china";

// CSI 300 (sh000300) + Shanghai Composite (sh000001) are the onshore indices the
// AKShare index client serves; Hang Seng daily is fetched via the registry
// (Yahoo) in buildHsiReturn for an offshore China gauge.

function strArr(a: any, max = 6): string[] {
  if (!Array.isArray(a)) return [];
  return a.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max);
}

/** Total return % between the first close on/after a cutoff and the last close. */
function returnSince(points: AkshareOhlcvPoint[], cutoff: string): number | null {
  if (!points.length) return null;
  const last = points[points.length - 1];
  if (last?.close == null) return null;
  // first point with date >= cutoff
  let base: AkshareOhlcvPoint | null = null;
  for (const p of points) {
    if (p.date >= cutoff && typeof p.close === "number") { base = p; break; }
  }
  if (!base || base.close == null || base.close === 0) return null;
  // If the only point on/after the cutoff IS the latest point, there is no
  // earlier anchor to measure against — return null rather than a fake 0%.
  if (base === last || base.date === last.date) return null;
  return Math.round(((last.close - base.close) / base.close) * 1000) / 10;
}

function ytdCutoff(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

function twelveMonthCutoff(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

// ── signal assembly (live series, grounded) ──────────────────────────────────

function buildAhSignal(snap: AhPremiumSnapshot | null): AhPremiumSignal | null {
  if (!snap || snap.aggregate_premium_pct == null) return null;
  const agg = snap.aggregate_premium_pct;
  // Onshore A-shares typically trade at a PREMIUM to H-shares (Hang Seng AH
  // premium index ~130-150 historically => ~30-50%). Bucket the median level.
  let level: AhPremiumSignal["level"] = null;
  if (agg >= 40) level = "elevated";
  else if (agg >= 20) level = "moderate";
  else level = "compressed";
  const mapPair = (p: { name: string | null; code: string | null; premium_pct: number | null }) => ({
    name: p.name ?? null, code: p.code ?? null, premiumPct: p.premium_pct ?? null,
  });
  return {
    aggregatePremiumPct: agg,
    pairCount: snap.pair_count ?? null,
    topPremium: (snap.top_premium ?? []).map(mapPair),
    bottomPremium: (snap.bottom_premium ?? []).map(mapPair),
    level,
    note: snap.note ?? null,
  };
}

async function buildIndexReturn(
  label: string,
  symbol: string,
  registryId?: string,
): Promise<IndexReturn | null> {
  // Prefer a reliable registry series (Yahoo/CEIC) when one is provided — the
  // sidecar /index/historical (EastMoney push2his) is intermittently 502/empty.
  if (registryId) {
    try {
      const r = await fetchSeries(registryId);
      const pts = (r.data.filter((p) => p.value != null) as { date: string; value: number }[])
        .sort((a, b) => a.date.localeCompare(b.date));
      if (pts.length) {
        const asOhlcv: AkshareOhlcvPoint[] = pts.map((p) => ({ date: p.date, close: p.value }));
        const last = asOhlcv[asOhlcv.length - 1];
        return {
          index: label,
          symbol,
          lastClose: last?.close ?? null,
          lastDate: last?.date ?? null,
          ytdPct: returnSince(asOhlcv, ytdCutoff()),
          ret12mPct: returnSince(asOhlcv, twelveMonthCutoff()),
        };
      }
    } catch {
      /* fall through to the sidecar index endpoint */
    }
  }
  const start = twelveMonthCutoff();
  const res = await getAkshareIndexHistorical({ symbol, start, period: "daily" }).catch(
    () => ({ data: [] as AkshareOhlcvPoint[], error: "unavailable" }),
  );
  const pts = (res as any).data as AkshareOhlcvPoint[];
  if (!pts?.length) return null;
  const last = pts[pts.length - 1];
  return {
    index: label,
    symbol,
    lastClose: last?.close ?? null,
    lastDate: last?.date ?? null,
    ytdPct: returnSince(pts, ytdCutoff()),
    ret12mPct: returnSince(pts, twelveMonthCutoff()),
  };
}

/** Hang Seng via the registry (Yahoo daily) so we have an offshore China gauge. */
async function buildHsiReturn(): Promise<IndexReturn | null> {
  try {
    const r = await fetchSeries("hsi_close");
    const pts = r.data.filter((p) => p.value != null) as { date: string; value: number }[];
    if (!pts.length) return null;
    const asOhlcv: AkshareOhlcvPoint[] = pts.map((p) => ({ date: p.date, close: p.value }));
    const last = asOhlcv[asOhlcv.length - 1];
    return {
      index: "Hang Seng",
      symbol: "^HSI",
      lastClose: last?.close ?? null,
      lastDate: last?.date ?? null,
      ytdPct: returnSince(asOhlcv, ytdCutoff()),
      ret12mPct: returnSince(asOhlcv, twelveMonthCutoff()),
    };
  } catch {
    return null;
  }
}

async function buildCrossAsset(notes: string[]): Promise<CrossAssetSignal | null> {
  let usdCny: number | null = null;
  let usdCnyDate: string | null = null;
  try {
    const fx = await fetchSeries("usdcny_monthly");
    const withVal = fx.data.filter((p) => p.value != null);
    // CEIC returns newest-first; pick the latest by date to be safe.
    const latest = withVal.sort((a, b) => a.date.localeCompare(b.date))[withVal.length - 1];
    if (latest) { usdCny = latest.value!; usdCnyDate = latest.date; }
  } catch {
    notes.push("USD/CNY (usdcny_monthly) unavailable this refresh.");
  }
  if (usdCny == null) notes.push("USD/CNY unavailable (CEIC usdcny_monthly).");

  const yields = await getCrossAssetYields().catch(
    () => ({ data: [] as CrossAssetYieldPoint[], latest: null as CrossAssetYieldPoint | null, error: "unavailable" }),
  );
  const latestY = (yields as any).latest as CrossAssetYieldPoint | null;
  if (!latestY) notes.push("US-China yield curve unavailable (sidecar /relative/yields).");

  if (usdCny == null && !latestY) return null;
  return {
    usdCny,
    usdCnyDate,
    usCn10yDiff: latestY?.us_cn_10y_diff ?? null,
    cn10y: latestY?.cn_10y ?? null,
    us10y: latestY?.us_10y ?? null,
    yieldsDate: latestY?.date ?? null,
  };
}

interface AssembledRelative {
  ahPremium: AhPremiumSignal | null;
  indexReturns: IndexReturn[];
  crossAsset: CrossAssetSignal | null;
  notes: string[];
}

async function assembleRelative(): Promise<AssembledRelative> {
  const notes: string[] = [];
  const [ahRes, csi300, shComp, hsi, crossAsset] = await Promise.all([
    getAhPremium().catch((e: any) => ({ data: null as AhPremiumSnapshot | null, error: e?.message })),
    buildIndexReturn("CSI 300", "sh000300", "csi300_monthly"),
    buildIndexReturn("Shanghai Composite", "sh000001"),
    buildHsiReturn(),
    buildCrossAsset(notes),
  ]);

  const ahPremium = buildAhSignal((ahRes as any).data ?? null);
  if (!ahPremium) {
    const srcNote = (ahRes as any)?.data?.note;
    notes.push(
      srcNote
        ? `AH premium unavailable: ${srcNote}`
        : "AH premium unavailable (no reliable free AH-premium source currently; EastMoney AH endpoint is 502 upstream).",
    );
  }

  const indexReturns = [csi300, shComp, hsi].filter((x): x is IndexReturn => !!x);
  if (!indexReturns.length) notes.push("China index returns unavailable (index history).");

  // Honest EM/DM caveat — we never fabricate an MSCI EM/DM benchmark.
  notes.push(
    "No clean MSCI EM/DM benchmark in this data set; China returns are framed " +
      "against the US 10Y yield + USD/CNY backdrop as relative-value context.",
  );

  return { ahPremium, indexReturns, crossAsset, notes };
}

// ── prompt evidence block ────────────────────────────────────────────────────

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function evidenceBlock(a: AssembledRelative): string {
  const parts: string[] = [];

  if (a.ahPremium) {
    const ah = a.ahPremium;
    const top = ah.topPremium.slice(0, 4).map((p) => `${p.name ?? p.code} ${fmtPct(p.premiumPct)}`).join("; ");
    parts.push(
      "AH PREMIUM (A-share vs H-share, dual-listed names) — onshore/offshore positioning gauge:\n" +
        `  - Median premium across ${ah.pairCount ?? "?"} pairs: ${ah.aggregatePremiumPct != null ? ah.aggregatePremiumPct.toFixed(1) + "%" : "n/a"} (level: ${ah.level ?? "n/a"})\n` +
        `  - Widest premiums: ${top || "n/a"}\n` +
        "  - Interpretation: high A-over-H premium = onshore retail bid / offshore caution; compression = H-shares catching up (offshore re-rating).",
    );
  } else {
    parts.push("AH PREMIUM: unavailable this refresh.");
  }

  if (a.indexReturns.length) {
    const lines = a.indexReturns
      .map((r) => `  - ${r.index}: YTD ${fmtPct(r.ytdPct)}, 12m ${fmtPct(r.ret12mPct)} (last ${r.lastClose ?? "?"} on ${r.lastDate ?? "?"})`)
      .join("\n");
    parts.push("CHINA EQUITY RETURNS (index price return):\n" + lines);
  } else {
    parts.push("CHINA EQUITY RETURNS: unavailable this refresh.");
  }

  if (a.crossAsset) {
    const c = a.crossAsset;
    parts.push(
      "CROSS-ASSET BACKDROP:\n" +
        `  - USD/CNY: ${c.usdCny != null ? c.usdCny.toFixed(3) : "n/a"}${c.usdCnyDate ? ` (${c.usdCnyDate})` : ""} — higher = weaker CNY.\n` +
        `  - US 10Y: ${c.us10y != null ? c.us10y.toFixed(2) + "%" : "n/a"}; China 10Y: ${c.cn10y != null ? c.cn10y.toFixed(2) + "%" : "n/a"}.\n` +
        `  - US-China 10Y differential: ${c.usCn10yDiff != null ? (c.usCn10yDiff > 0 ? "+" : "") + c.usCn10yDiff.toFixed(2) + " pp" : "n/a"}${c.yieldsDate ? ` (${c.yieldsDate})` : ""} — a wide positive US-CN gap pressures the CNY and Chinese rates lower.`,
    );
  } else {
    parts.push("CROSS-ASSET BACKDROP: unavailable this refresh.");
  }

  parts.push(
    "NOTE: There is NO clean MSCI EM/DM benchmark in this data set. Do NOT cite EM " +
      "or DM index levels/returns. Frame China purely against its own returns + the " +
      "US-rate / USD/CNY backdrop above.",
  );

  return parts.join("\n\n");
}

// ── LLM interpretation ───────────────────────────────────────────────────────

async function interpret(
  evidence: string,
  opts: BuildRelativeContextOpts,
): Promise<{ stance: Stance | null; whyChina: string; drivers: string[]; cost: number; note?: string }> {
  const model = opts.model ?? "claude-sonnet-4";
  const system =
    "You are a top-down strategist for an institutional China/HK equity desk. " +
    "From the relative & global context EVIDENCE BASE, take a STANCE on China equities " +
    "(constructive / neutral / cautious) and explain WHY in 1-2 sentences grounded in the " +
    "specific numbers provided (AH premium level, China index YTD/12m returns, USD/CNY, US-China 10Y differential). " +
    "Ground EVERY claim in a SPECIFIC value from the EVIDENCE BASE; do not invent data and do NOT cite any EM/DM benchmark (none is provided). " +
    "Output STRICT JSON ONLY, no prose, no markdown fences.";
  const user =
    `=== EVIDENCE BASE ===\n${evidence}\n=== END EVIDENCE BASE ===\n\n` +
    "Produce STRICT JSON:\n" +
    `{ "stance": "constructive|neutral|cautious", "whyChina": "1-2 sentences citing specific values", "drivers": ["short bullet citing a value", "..."] }\n` +
    "Rules: stance MUST be one of the three labels. whyChina + drivers MUST cite real values from the EVIDENCE BASE " +
    "(e.g. 'AH premium 38%', 'CSI 300 +6% YTD', 'US-CN 10Y gap +2.3pp'). Do NOT mention EM/DM benchmarks.";

  const res = await generateCommentary({
    model,
    systemPrompt: system,
    userPrompt: user,
    actionContext: "relative_context",
    maxOutputTokens: 900,
  });
  const obj = extractJsonObject(res.text);
  if (!obj) return { stance: null, whyChina: "", drivers: [], cost: res.costUsd, note: "Model output could not be parsed." };
  const stance: Stance | null = VALID_STANCES.includes(obj.stance) ? obj.stance : null;
  return {
    stance,
    whyChina: String(obj.whyChina ?? "").trim(),
    drivers: strArr(obj.drivers, 6),
    cost: res.costUsd,
  };
}

/**
 * Build the relative & global context block. Never throws — degrades to the
 * numeric skeleton + notes when the sidecar (pre-deploy 404 on /relative/*),
 * registry series, or LLM fail.
 */
export async function buildRelativeContext(opts: BuildRelativeContextOpts = {}): Promise<RelativeContext> {
  if (!opts.forceRefresh) {
    const cached = cache.get(CACHE_KEY);
    if (cached && Date.now() - cached.at < TTL) return cached.result;
  }

  const model = opts.model ?? "claude-sonnet-4";

  let a: AssembledRelative;
  try {
    a = await assembleRelative();
  } catch (err: any) {
    a = { ahPremium: null, indexReturns: [], crossAsset: null, notes: [`Relative-context assembly failed: ${err?.message ?? "unknown"}.`] };
  }

  const result: RelativeContext = {
    generatedAt: new Date().toISOString(),
    stance: null,
    whyChina: "",
    drivers: [],
    ahPremium: a.ahPremium,
    indexReturns: a.indexReturns,
    crossAsset: a.crossAsset,
    notes: [...a.notes],
    model,
    costUsd: 0,
  };

  // Only call the LLM when we have at least one substantive numeric leg.
  const haveSignal = !!(a.ahPremium || a.indexReturns.length || a.crossAsset);
  if (haveSignal) {
    try {
      const llm = await interpret(evidenceBlock(a), opts);
      result.stance = llm.stance;
      result.whyChina = llm.whyChina;
      result.drivers = llm.drivers;
      result.costUsd = llm.cost;
      if (llm.note) result.notes.push(llm.note);
    } catch (err: any) {
      result.notes.push(`Stance interpretation failed: ${err?.message ?? "unknown"}.`);
    }
  } else {
    result.notes.push("No relative-context signal available — stance not interpreted.");
  }

  // Cache only when something useful resolved, so a transient all-404 refresh
  // isn't pinned for 6h.
  if (haveSignal || result.stance) cache.set(CACHE_KEY, { at: Date.now(), result });

  return result;
}

// ── serializer (mirror flowsPositioningLine / valuationContextLine) ──────────

/** One-line human summary of the relative-context block for the report digest. */
export function relativeContextLine(r: RelativeContext): string {
  const parts: string[] = [];
  if (r.stance) parts.push(`Stance: ${r.stance}`);
  if (r.ahPremium?.aggregatePremiumPct != null) {
    parts.push(`AH premium ${r.ahPremium.aggregatePremiumPct.toFixed(1)}% (${r.ahPremium.level ?? "n/a"})`);
  }
  for (const ir of r.indexReturns) {
    parts.push(`${ir.index} YTD ${fmtPct(ir.ytdPct)} / 12m ${fmtPct(ir.ret12mPct)}`);
  }
  if (r.crossAsset) {
    const c = r.crossAsset;
    if (c.usdCny != null) parts.push(`USD/CNY ${c.usdCny.toFixed(3)}`);
    if (c.usCn10yDiff != null) parts.push(`US-CN 10Y ${c.usCn10yDiff > 0 ? "+" : ""}${c.usCn10yDiff.toFixed(2)}pp`);
  }
  if (r.whyChina) parts.push(r.whyChina.slice(0, 220));
  if (!parts.length && r.notes.length) return r.notes.join(" ");
  return parts.join(" | ");
}

/** Multi-line digest block for the strategy note (sectorDigest). */
export function relativeContextDigest(r: RelativeContext): string {
  const lines: string[] = [];
  lines.push("RELATIVE & GLOBAL CONTEXT (top-down call):");
  if (r.stance) lines.push(`- Stance: ${r.stance.toUpperCase()}${r.whyChina ? ` — ${r.whyChina}` : ""}`);
  if (r.ahPremium?.aggregatePremiumPct != null) {
    const ah = r.ahPremium;
    lines.push(`- AH premium: median ${ah.aggregatePremiumPct!.toFixed(1)}% across ${ah.pairCount ?? "?"} pairs (${ah.level ?? "n/a"}).`);
  }
  for (const ir of r.indexReturns) {
    lines.push(`- ${ir.index}: YTD ${fmtPct(ir.ytdPct)}, 12m ${fmtPct(ir.ret12mPct)}.`);
  }
  if (r.crossAsset) {
    const c = r.crossAsset;
    const fxStr = c.usdCny != null ? `USD/CNY ${c.usdCny.toFixed(3)}` : "USD/CNY n/a";
    const diffStr = c.usCn10yDiff != null ? `US-CN 10Y diff ${c.usCn10yDiff > 0 ? "+" : ""}${c.usCn10yDiff.toFixed(2)}pp` : "US-CN 10Y diff n/a";
    lines.push(`- Cross-asset: ${fxStr}; ${diffStr} (US ${c.us10y != null ? c.us10y.toFixed(2) + "%" : "n/a"} vs CN ${c.cn10y != null ? c.cn10y.toFixed(2) + "%" : "n/a"}).`);
  }
  if (r.drivers.length) lines.push(`- Drivers: ${r.drivers.slice(0, 4).join("; ")}.`);
  if (r.notes.length) lines.push(`- Notes: ${r.notes.slice(0, 3).join(" ")}`);
  return lines.join("\n");
}

// ── tolerant JSON parsing (mirrors flowsPositioning.ts) ──────────────────────
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
  const commit = (end: number) => commits.push({ end, stack: Array.from(stack) });
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
