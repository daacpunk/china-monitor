/**
 * Report context assembly (Phase 3).
 *
 * Gathers the live, cited evidence base BEFORE any synthesis — shared by both
 * composer modes (data-driven + thesis-driven). No hallucination: every block is
 * real data/policy/valuation/Sonar output with provenance.
 *
 *   - macro + cross-asset snapshot (reuses buildBriefInputs)
 *   - recent policy items + market linkage (Phase 1)
 *   - sector universe + valuations + catalysts for emphasized themes / featured names (Phase 2)
 *   - current house view
 *   - fresh Sonar pulls (thesis / theme catalysts)
 *
 * Returns a compact, token-aware text digest the LLM can reason over, plus a
 * structured citations list.
 */

import { buildBriefInputs, type BriefInputs } from "../analysis/brief";
import { storage } from "../storage";
import { SECTOR_UNIVERSE, THEMES_BY_ID, type CoverageTheme } from "../equity/universe";
import { getAkshareValuation } from "../clients/akshare";
import { fetchSeries } from "../series/fetchSeries";
import { buildValuationContext, valuationContextLine } from "../equity/valuationContext";
import { buildRiskDashboard, riskDashboardDigest } from "../equity/riskDashboard";
import { querySonar } from "../clients/sonar";
import type { HouseView, PolicyUpdate } from "@shared/schema";

export interface ReportContext {
  asOfDate: string;
  macroDigest: string;
  policyDigest: string;
  sectorDigest: string;
  houseView: HouseView | null;
  sonarDigest: string;
  citations: { name: string; url: string }[];
}

function fmt(n: number | null | undefined, d = 1): string {
  return n == null || typeof n !== "number" ? "n/a" : n.toFixed(d);
}

async function macroDigest(): Promise<{ text: string; inputs: BriefInputs }> {
  const inputs = await buildBriefInputs();
  const drivers = inputs.drivers
    .map((d: any) => `  - ${d.label ?? d.id}: latest ${fmt(d.latest)} (${d.unit ?? ""}), MoM ${fmt(d.mom)}, trend ${d.trendClass ?? "n/a"} [${d.provenance ?? "?"}]`)
    .join("\n");
  const cross = inputs.crossAsset
    .map((c: any) => `  - ${c.label ?? c.id}: ${fmt(c.latest, 2)} (${c.chgPct != null ? fmt(c.chgPct) + "%" : "n/a"}) [${c.provenance ?? "?"}]`)
    .join("\n");
  const eq = inputs.equities
    .map((e: any) => `  - ${e.label ?? e.id}: ${fmt(e.latest, 0)} (${e.chgPct != null ? fmt(e.chgPct) + "%" : "n/a"}) [${e.provenance ?? "?"}]`)
    .join("\n");
  const text =
    `As of ${inputs.asOfDate}. Breadth: ${inputs.breadth.up} up / ${inputs.breadth.down} down / ${inputs.breadth.flat} flat (${inputs.breadth.tilt}).\n` +
    `MACRO DRIVERS:\n${drivers || "  (none)"}\n` +
    `CROSS-ASSET:\n${cross || "  (none)"}\n` +
    `EQUITY INDICES:\n${eq || "  (none)"}`;
  return { text, inputs };
}

async function policyDigest(emphasis: CoverageTheme[]): Promise<{ text: string; citations: { name: string; url: string }[] }> {
  let updates: PolicyUpdate[] = [];
  try {
    updates = await storage.listPolicyUpdates({ limit: 40 });
  } catch {
    updates = [];
  }
  // Prefer items touching emphasized themes; keep most significant.
  const sigRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const ranked = updates
    .filter((u) => (emphasis.length ? (u.themes as string[]).some((t) => emphasis.includes(t as CoverageTheme) || t === "macro") : true))
    .sort((a, b) => (sigRank[a.significance] ?? 3) - (sigRank[b.significance] ?? 3))
    .slice(0, 14);
  const citations: { name: string; url: string }[] = [];
  const lines = ranked.map((u) => {
    citations.push({ name: `${u.body.toUpperCase()}: ${u.title}`.slice(0, 120), url: u.url });
    const link = (u.marketLinkage as any[])
      .map((l) => `${l.target}:${l.expectedDirection}`)
      .join(", ");
    return `  - [${u.body}|${u.significance}] ${u.title} — ${u.summary} (linkage: ${link || "n/a"}) <${u.url}>`;
  });
  return {
    text: ranked.length ? `RECENT POLICY (official channels via Sonar):\n${lines.join("\n")}` : "RECENT POLICY: (no items scanned yet — run Policy Tracker)",
    citations,
  };
}

async function sectorDigest(
  emphasis: CoverageTheme[],
  featuredNames: string[],
): Promise<string> {
  const themes = emphasis.length ? emphasis.map((id) => THEMES_BY_ID[id]).filter(Boolean) : SECTOR_UNIVERSE;
  const featured = new Set(featuredNames);

  // Map each coverage theme to the HS-chapter product-trade series most
  // relevant to it, so the theme narrative cites live customs data.
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

  const tradeCache = new Map<string, string>();
  async function tradeLine(id: string, label: string): Promise<string | null> {
    if (!tradeCache.has(id)) {
      try {
        const r = await fetchSeries(id);
        const last = r.data.length ? r.data[r.data.length - 1] : null;
        const v = last?.value;
        tradeCache.set(id, last && v != null ? `${label}: ${v > 0 ? "+" : ""}${v}% (${last.date})` : "");
      } catch {
        tradeCache.set(id, "");
      }
    }
    return tradeCache.get(id) || null;
  }

  const blocks: string[] = [];
  for (const t of themes) {
    const names = t.names.map((n) => `${n.nameEn} [${n.symbol}/${n.market}, ${n.role}]: ${n.thesis}`).join("; ");
    const tradeRefs = THEME_TRADE[t.id] ?? [];
    const tradeVals = (await Promise.all(tradeRefs.map((x) => tradeLine(x.id, x.label)))).filter(Boolean);
    const tradeStr = tradeVals.length ? `\n  Customs trade (GACC via chinadata): ${tradeVals.join("; ")}` : "";
    blocks.push(`THEME ${t.label} (proxies: ${t.indexProxies.join(", ")})\n  Drivers: ${t.drivers.join("; ")}${tradeStr}\n  Names: ${names}`);
  }
  // Valuation CONTEXT (Gap A): PE/PB percentile vs own history + peer rank in
  // theme, for the emphasized themes' A-share names. Featured names listed first.
  let valBlock = "";
  try {
    const ctxThemes = (emphasis.length ? emphasis : undefined) as CoverageTheme[] | undefined;
    const vctx = await buildValuationContext(ctxThemes, 8);
    const withData = vctx.filter((c) => c.peTtm != null || c.pb != null);
    // Featured first, then by most-expensive percentile (most notable).
    withData.sort((a, b) => {
      const fa = featured.has(a.symbol) ? 0 : 1, fb = featured.has(b.symbol) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return (b.pePercentile ?? -1) - (a.pePercentile ?? -1);
    });
    const lines = withData.slice(0, 14).map((c) => `  - ${valuationContextLine(c)}${featured.has(c.symbol) ? " ★" : ""}`);
    if (lines.length) {
      valBlock = `\nVALUATION CONTEXT (PE/PB vs own history percentile + peer rank in theme; ★ = featured):\n${lines.join("\n")}`;
    }
  } catch {
    /* skip valuation context on failure */
  }
  // SCENARIOS & RISK (Gap E): scored risks + bull/base/bear + falsification per
  // theme + portfolio, grounded in the live series. Mirrors the VALUATION CONTEXT
  // block above; degrades gracefully (never throws to the report).
  let riskBlock = "";
  try {
    const riskThemes = (emphasis.length ? emphasis : undefined) as CoverageTheme[] | undefined;
    const dash = await buildRiskDashboard(riskThemes);
    const digest = riskDashboardDigest(dash);
    if (digest.trim()) {
      riskBlock = `\nSCENARIOS & RISK (scored L×I risks + bull/base/bear + falsification; portfolio + per theme):\n${digest}`;
    }
  } catch {
    /* skip scenarios & risk on failure */
  }
  return `SECTOR UNIVERSE (emphasized):\n${blocks.join("\n")}` + valBlock + riskBlock;
}

async function sonarDigest(
  query: string,
  actionContext: string,
): Promise<{ text: string; citations: { name: string; url: string }[] }> {
  try {
    const r = await querySonar({
      systemPrompt:
        "You are a research assistant for an institutional China/HK equity strategist. " +
        "Summarize the most relevant, recent, SOURCED facts for the query. Be factual, cite sources, " +
        "and flag uncertainty. Do not speculate beyond the evidence.",
      userPrompt: query,
      actionContext,
      recency: "month",
      maxOutputTokens: 900,
    });
    const citations = r.citations.map((c) => ({ name: c.title || c.url, url: c.url }));
    return { text: r.text ? `WEB RESEARCH (Sonar Pro):\n${r.text}` : "", citations };
  } catch (err: any) {
    return { text: `WEB RESEARCH: (unavailable: ${err.message})`, citations: [] };
  }
}

export async function assembleContext(opts: {
  mode: "data_driven" | "thesis_driven";
  userThesis?: string;
  emphasis: CoverageTheme[];
  featuredNames: string[];
}): Promise<ReportContext> {
  const { mode, userThesis, emphasis, featuredNames } = opts;

  // For thesis mode, run Sonar harder: thesis support + explicit counter-evidence.
  const sonarTasks: Promise<{ text: string; citations: { name: string; url: string }[] }>[] = [];
  if (mode === "thesis_driven" && userThesis) {
    sonarTasks.push(
      sonarDigest(
        `Find recent evidence relevant to this China/HK equity thesis: "${userThesis}". Include both supporting and CONTRADICTING evidence with sources.`,
        "report_thesis_evidence",
      ),
      sonarDigest(
        `What is the strongest counter-argument or contradicting data against this thesis: "${userThesis}"? Cite sources.`,
        "report_thesis_counter",
      ),
    );
  } else {
    const themeWords = (emphasis.length ? emphasis : (["tech", "ev", "battery", "semi", "ai", "consumer"] as CoverageTheme[])).join(", ");
    sonarTasks.push(
      sonarDigest(
        `Most material recent catalysts, policy, and data for China/HK equity sectors: ${themeWords}. Cite sources.`,
        "report_data_catalysts",
      ),
    );
  }

  const [macro, policy, sector, hv, ...sonars] = await Promise.all([
    macroDigest(),
    policyDigest(emphasis),
    sectorDigest(emphasis, featuredNames),
    storage.getHouseView().catch(() => undefined),
    ...sonarTasks,
  ]);

  const citations = [
    ...policy.citations,
    ...sonars.flatMap((s) => s.citations),
  ];
  // Dedup citations by URL.
  const seen = new Set<string>();
  const dedupCitations = citations.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));

  return {
    asOfDate: macro.inputs.asOfDate,
    macroDigest: macro.text,
    policyDigest: policy.text,
    sectorDigest: sector,
    houseView: hv ?? null,
    sonarDigest: sonars.map((s) => s.text).filter(Boolean).join("\n\n"),
    citations: dedupCitations.slice(0, 60),
  };
}

/** Render the full context into one prompt block for the synthesis calls. */
export function contextToPrompt(ctx: ReportContext): string {
  const hv = ctx.houseView
    ? `CURRENT HOUSE VIEW: ${ctx.houseView.headline} (stance ${ctx.houseView.stance}, conviction ${ctx.houseView.conviction}, horizon ${ctx.houseView.horizon}).\n` +
      `Pillars: ${(ctx.houseView.pillars as string[]).join("; ")}\n` +
      `Sector stances: ${(ctx.houseView.sectorStance as any[]).map((s) => `${s.theme}:${s.stance}`).join(", ")}`
    : "CURRENT HOUSE VIEW: (none set yet)";
  return [
    `=== EVIDENCE BASE (as of ${ctx.asOfDate}) ===`,
    ctx.macroDigest,
    "",
    ctx.policyDigest,
    "",
    ctx.sectorDigest,
    "",
    ctx.sonarDigest,
    "",
    hv,
    `=== END EVIDENCE BASE ===`,
  ].join("\n");
}
