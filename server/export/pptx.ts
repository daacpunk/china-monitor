/**
 * PPTX investor deck renderer (Phase 4).
 *
 * Builds a comprehensive ~40-50 slide, mode-aware deck from a DocModel using
 * pptxgenjs. 16:9. Neutral China Monitor branding. Speaker notes auto-filled from
 * section prose so it presents for the full ~45 minutes. Provenance captions on
 * chart slides; closing sources slide.
 *
 * Long section prose is chunked across continuation slides so nothing overflows.
 */

import PptxGenJS from "pptxgenjs";
import { BRAND, stanceColor } from "@shared/brand";
import { pngToDataUri } from "./charts";
import type { DocModel, DocFigure } from "./model";

const C = BRAND.colors;
const ACCENT = C.accent;

// Rough chars-per-body-slide so long sections paginate instead of overflowing.
const CHARS_PER_SLIDE = 900;

function chunk(text: string, size = CHARS_PER_SLIDE): string[] {
  const clean = (text || "").trim();
  if (clean.length <= size) return [clean];
  const paras = clean.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > size && cur) { out.push(cur); cur = p; }
    else cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur) out.push(cur);
  // hard-split any oversized chunk
  return out.flatMap((c) => (c.length <= size * 1.5 ? [c] : c.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [c]));
}

// Strip light markdown to plain text for slide bullets.
function plain(md: string): string {
  return (md || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^[\s]*[-•]\s+/gm, "• ")
    .trim();
}

// Risk score → cell fill (heat). score = likelihood × impact, 1..25.
function scoreFill(score: number): string {
  if (score >= 16) return "FCA5A5"; // high — red-300
  if (score >= 9) return "FCD34D";  // medium — amber-300
  return "BBF7D0";                  // low — green-200
}

const SCEN_COLOR: Record<string, string> = { bull: "16A34A", base: "6B7280", bear: "DC2626" };

/**
 * Dedicated "Scenarios & Risk" deck section (Gap E):
 *   - one scored risk matrix table per scope (portfolio + emphasized themes)
 *   - one bull/base/bear scenario table per scope (with falsification list)
 */
function renderScenarioRiskSection(
  pptx: PptxGenJS,
  model: DocModel,
  io: {
    newSlide: (withFooter?: boolean) => PptxGenJS.Slide;
    heading: (s: PptxGenJS.Slide, title: string, sub?: string) => void;
    W: number;
    H: number;
  },
): void {
  const { newSlide, heading, W, H } = io;
  const blocks = model.riskBlocks ?? [];
  const scenSets = model.scenarioSets ?? [];
  if (!blocks.length && !scenSets.length) return;

  // ── Section divider ──
  {
    const s = newSlide();
    s.background = { color: C.ink };
    s.addText("Scenarios & Risk", { x: 0.7, y: 3.0, w: W - 1.4, h: 0.9, fontSize: 32, bold: true, color: "FFFFFF" });
    s.addText("Scored risk matrix · bull / base / bear · falsification", { x: 0.7, y: 3.95, w: W - 1.4, h: 0.5, fontSize: 15, color: "C7D2FE" });
  }

  // ── Scored risk matrices (one slide per scope, top ~7 risks) ──
  for (const b of blocks) {
    if (!b.risks.length) continue;
    const s = newSlide();
    heading(s, `Risk Matrix — ${b.label}`, "Likelihood × Impact (1–5); sorted by score");
    const header: PptxGenJS.TableRow = ["Risk", "Category", "L", "I", "Score", "Trigger / Evidence"].map((t) => ({
      text: t, options: { bold: true, color: "FFFFFF", fill: { color: ACCENT }, fontSize: 11 },
    }));
    const rows: PptxGenJS.TableRow[] = [header, ...b.risks.slice(0, 7).map((r) => [
      { text: String(r.title), options: { fontSize: 10, color: C.body } },
      { text: String(r.category), options: { fontSize: 10, color: C.muted } },
      { text: String(r.likelihood), options: { fontSize: 10, color: C.body, align: "center" as const } },
      { text: String(r.impact), options: { fontSize: 10, color: C.body, align: "center" as const } },
      { text: String(r.score), options: { fontSize: 11, bold: true, color: "111111", fill: { color: scoreFill(r.score) }, align: "center" as const } },
      { text: `${r.trigger}${r.evidence ? ` — ${r.evidence}` : ""}`, options: { fontSize: 9, color: C.muted } },
    ])];
    s.addTable(rows, { x: 0.4, y: 1.7, w: W - 0.8, colW: [3.0, 1.3, 0.5, 0.5, 0.8, 5.4], border: { type: "solid", color: C.line, pt: 1 }, valign: "middle" });
    s.addNotes(`Top risks for ${b.label}: ${b.risks.slice(0, 3).map((r) => `${r.title} (score ${r.score})`).join("; ")}.`);
  }

  // ── Bull/Base/Bear scenario tables (prefer note's structured sets; else risk blocks) ──
  const scopesFromSets = scenSets.map((ss) => ({
    label: ss.scope === "portfolio" ? "Portfolio" : ss.scope,
    scenarios: ss.scenarios,
    falsification: ss.falsification,
  }));
  const scopesFromRisk = blocks
    .filter((b) => b.scenarios.length)
    .map((b) => ({ label: b.label, scenarios: b.scenarios, falsification: b.falsification }));
  // De-dup by label, preferring the note's structured sets.
  const seen = new Set(scopesFromSets.map((s) => s.label.toLowerCase()));
  const scenScopes = [...scopesFromSets, ...scopesFromRisk.filter((s) => !seen.has(s.label.toLowerCase()))];

  for (const sc of scenScopes) {
    if (!sc.scenarios.length) continue;
    const s = newSlide();
    heading(s, `Scenarios — ${sc.label}`, "Bull / Base / Bear");
    const header: PptxGenJS.TableRow = ["Scenario", "Prob", "Narrative", "Triggers / Key drivers"].map((t) => ({
      text: t, options: { bold: true, color: "FFFFFF", fill: { color: ACCENT }, fontSize: 11 },
    }));
    const rows: PptxGenJS.TableRow[] = [header, ...sc.scenarios.map((sn) => [
      { text: sn.label.toUpperCase(), options: { fontSize: 11, bold: true, color: SCEN_COLOR[sn.label] ?? C.body } },
      { text: sn.probability != null ? `${sn.probability}%` : "—", options: { fontSize: 10, color: C.body, align: "center" as const } },
      { text: String(sn.narrative), options: { fontSize: 9, color: C.body } },
      { text: [...(sn.triggers ?? []), ...(sn.keyDrivers ?? [])].join("; "), options: { fontSize: 9, color: C.muted } },
    ])];
    s.addTable(rows, { x: 0.4, y: 1.7, w: W - 0.8, colW: [1.4, 0.9, 5.3, 4.9], border: { type: "solid", color: C.line, pt: 1 }, valign: "middle" });
    if (sc.falsification?.length) {
      s.addText("Falsification — thesis is wrong if:", { x: 0.4, y: H - 1.7, w: W - 0.8, h: 0.3, fontSize: 11, bold: true, color: C.negative });
      s.addText(sc.falsification.slice(0, 4).map((f) => ({ text: String(f), options: { bullet: true, fontSize: 10, color: C.body } })), { x: 0.4, y: H - 1.4, w: W - 0.8, h: 1.1, valign: "top", paraSpaceAfter: 2 });
    }
    s.addNotes(`Scenarios for ${sc.label}. Bear case reflects the red-team panel's strongest objections.`);
  }
}

const REGIME_COLOR: Record<string, string> = {
  "risk-on": "16A34A", "risk-off": "DC2626", neutral: "6B7280", extreme: "B91C1C",
};

/** CNY → 亿 (100M) string for deck readability. */
function yiStr(v: number | null | undefined, d = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v / 1e8).toFixed(d)}亿`;
}

/**
 * Dedicated "Flows & Positioning" deck slide (Gap C):
 *   - LLM regime label + confidence + narrative
 *   - Northbound (Stock Connect) 5d/20d net + cumulative direction
 *   - Margin / leverage trend + level
 *   - Top sector inflow / outflow leaders
 */
function renderFlowsSection(
  pptx: PptxGenJS,
  model: DocModel,
  io: { newSlide: (withFooter?: boolean) => PptxGenJS.Slide; heading: (s: PptxGenJS.Slide, title: string, sub?: string) => void; W: number; H: number },
): void {
  const f = model.flowsPositioning;
  if (!f) return;
  const nb = f.northbound, mg = f.margin, sb = f.southbound;
  const haveAny = !!(mg || sb || f.sectorInflows.length || f.sectorOutflows.length || f.regime);
  if (!haveAny) return;
  const { newSlide, heading, W, H } = io;

  const s = newSlide();
  heading(s, "Flows & Positioning", "Margin/leverage · Southbound · sector flows · regime");

  // Regime badge + narrative
  if (f.regime) {
    s.addText(
      [
        { text: `Regime: ${f.regime.toUpperCase()}`, options: { bold: true, fontSize: 16, color: REGIME_COLOR[f.regime] ?? C.body } },
        ...(f.confidence != null ? [{ text: `   ${f.confidence}% confidence`, options: { fontSize: 12, color: C.muted } }] : []),
      ],
      { x: 0.5, y: 1.65, w: W - 1, h: 0.4, valign: "middle" },
    );
  }
  if (f.narrative) {
    s.addText(f.narrative, { x: 0.5, y: 2.1, w: W - 1, h: 1.0, fontSize: 12, color: C.body, valign: "top", lineSpacingMultiple: 1.12 });
  }

  // Metric table: margin (primary) → southbound. Northbound numbers are dead
  // (discontinued Aug 2024) so they are footnoted, not tabled.
  const metricRows: PptxGenJS.TableRow[] = [
    ["Signal", "Reading"].map((t) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: ACCENT }, fontSize: 11 } })) as PptxGenJS.TableRow,
  ];
  if (mg) {
    metricRows.push([
      { text: "Margin / leverage (primary)", options: { fontSize: 10, color: C.body, bold: true } },
      { text: `${yiStr(mg.financingBalance)} · ${mg.trend ?? "n/a"}${mg.pctChange20d != null ? ` ${mg.pctChange20d > 0 ? "+" : ""}${mg.pctChange20d}% 20d` : ""} · level ${mg.level ?? "n/a"}`, options: { fontSize: 10, color: C.muted } },
    ]);
  }
  if (sb) {
    metricRows.push([
      { text: "Southbound (港股通, today)", options: { fontSize: 10, color: C.body } },
      { text: `net ${yiStr(sb.netBuy)} · ${sb.direction ?? "n/a"}${sb.tradeDate ? ` · ${sb.tradeDate}` : ""}`, options: { fontSize: 10, color: C.muted } },
    ]);
  }
  if (nb && nb.status === "live") {
    metricRows.push([
      { text: "Northbound (Stock Connect)", options: { fontSize: 10, color: C.body } },
      { text: `5d ${yiStr(nb.net5d)} · 20d ${yiStr(nb.net20d)} · cumulative ${nb.cumulativeDirection ?? "n/a"}`, options: { fontSize: 10, color: C.muted } },
    ]);
  }
  if (metricRows.length > 1) {
    s.addTable(metricRows, { x: 0.5, y: 3.2, w: W - 1, colW: [3.2, W - 4.2], border: { type: "solid", color: C.line, pt: 1 }, valign: "middle" });
  }
  if (nb && nb.status === "discontinued") {
    s.addText(
      `Northbound (Stock Connect 北向资金): daily net-flow disclosure discontinued by HKEX (Aug 2024; last data ${nb.lastDataDate ?? "2024-08-16"}). Regime driven by margin/leverage + Southbound.`,
      { x: 0.5, y: 4.05, w: W - 1, h: 0.35, fontSize: 9, italic: true, color: C.muted, valign: "top" },
    );
  }

  // Sector leaders (two columns)
  const yLeaders = 4.5;
  if (f.sectorInflows.length) {
    s.addText("Top sector inflows (today)", { x: 0.5, y: yLeaders, w: 6, h: 0.3, fontSize: 12, bold: true, color: C.positive });
    s.addText(f.sectorInflows.slice(0, 5).map((l) => ({ text: `${l.sector}  +${yiStr(l.netInflow)}`, options: { bullet: true, fontSize: 11, color: C.body } })), { x: 0.5, y: yLeaders + 0.35, w: 6.0, h: 1.7, valign: "top", paraSpaceAfter: 2 });
  }
  if (f.sectorOutflows.length) {
    s.addText("Top sector outflows (today)", { x: 6.9, y: yLeaders, w: 6, h: 0.3, fontSize: 12, bold: true, color: C.negative });
    s.addText(f.sectorOutflows.slice(0, 5).map((l) => ({ text: `${l.sector}  ${yiStr(l.netInflow)}`, options: { bullet: true, fontSize: 11, color: C.body } })), { x: 6.9, y: yLeaders + 0.35, w: 5.9, h: 1.7, valign: "top", paraSpaceAfter: 2 });
  }

  // Positioning extremes banner
  if (f.positioningExtremes.length) {
    s.addText("Positioning extremes:", { x: 0.5, y: H - 1.05, w: W - 1, h: 0.3, fontSize: 11, bold: true, color: C.warn });
    s.addText(f.positioningExtremes.slice(0, 3).join(" · "), { x: 0.5, y: H - 0.75, w: W - 1, h: 0.4, fontSize: 10, color: C.body, valign: "top" });
  }

  s.addNotes(
    `Flows & positioning regime: ${f.regime ?? "n/a"}${f.confidence != null ? ` (${f.confidence}%)` : ""}. ` +
    `${f.narrative}${f.positioningExtremes.length ? ` Extremes: ${f.positioningExtremes.join("; ")}.` : ""}` +
    `${f.notes.length ? ` Notes: ${f.notes.join(" ")}` : ""}`,
  );
}

// Earnings momentum / quadrant → cell color for the FUNDAMENTALS table.
const QUADRANT_COLOR: Record<string, string> = {
  "cheap-improving": C.positive,
  "expensive-deteriorating": C.negative,
};

function renderFundamentalsSection(
  pptx: PptxGenJS,
  model: DocModel,
  io: { newSlide: (withFooter?: boolean) => PptxGenJS.Slide; heading: (s: PptxGenJS.Slide, title: string, sub?: string) => void; W: number; H: number },
): void {
  const ec = (model.earningsContext ?? []).filter((c) => c.revenueYoy != null || c.netProfitYoy != null);
  if (!ec.length) return;
  const { newSlide, heading, W } = io;
  // Strongest net-profit YoY first (most notable).
  ec.sort((a, b) => (b.netProfitYoy ?? -1e9) - (a.netProfitYoy ?? -1e9));

  const pct = (v: number | null) => (v == null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const s = newSlide();
  heading(s, "Fundamentals", "Revenue / net-profit YoY · earnings momentum · cheap+improving quadrant");

  const rows: PptxGenJS.TableRow[] = [
    ["Name", "Rev YoY", "Net-profit YoY", "EPS", "Momentum", "Quadrant"].map(
      (t) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: ACCENT }, fontSize: 10 } }),
    ) as PptxGenJS.TableRow,
  ];
  for (const c of ec.slice(0, 16)) {
    rows.push([
      { text: `${c.nameEn} [${c.symbol}]`, options: { fontSize: 9, color: C.body } },
      { text: pct(c.revenueYoy), options: { fontSize: 9, color: C.muted } },
      { text: pct(c.netProfitYoy), options: { fontSize: 9, color: (c.netProfitYoy ?? 0) >= 0 ? C.positive : C.negative } },
      { text: c.eps != null ? c.eps.toFixed(2) : "n/a", options: { fontSize: 9, color: C.muted } },
      { text: c.momentum ?? "n/a", options: { fontSize: 9, color: C.body } },
      { text: c.quadrant ?? "n/a", options: { fontSize: 9, bold: !!QUADRANT_COLOR[c.quadrant ?? ""], color: QUADRANT_COLOR[c.quadrant ?? ""] ?? C.muted } },
    ] as PptxGenJS.TableRow);
  }
  s.addTable(rows, { x: 0.5, y: 1.7, w: W - 1, colW: [3.4, 1.5, 2.0, 1.2, 2.1, 2.1], border: { type: "solid", color: C.line, pt: 1 }, valign: "middle" });
  s.addText(
    "Quadrant crosses each name's P/E percentile (vs own history) with earnings momentum: cheap = <40th pct, improving = net-profit YoY accelerating. Consensus/forward estimates omitted (no reliable free source).",
    { x: 0.5, y: io.H - 0.9, w: W - 1, h: 0.5, fontSize: 9, italic: true, color: C.muted, valign: "top" },
  );
  s.addNotes(
    ec.slice(0, 16).map((c) => `${c.nameEn} [${c.symbol}]: rev YoY ${pct(c.revenueYoy)}, net-profit YoY ${pct(c.netProfitYoy)}, momentum ${c.momentum ?? "n/a"}, quadrant ${c.quadrant ?? "n/a"}.`).join(" "),
  );
}

// Transmission strength → badge color.
const STRENGTH_COLOR: Record<string, string> = {
  strong: C.positive,
  moderate: C.warn,
  weak: C.muted,
};

/**
 * Dedicated "Policy Transmission" deck section (Gap D): one slide per policy
 * chain (paginated 2/slide) showing Policy → affected theme(s) → live evidence
 * → ranked beneficiaries / at-risk, plus an LLM read-through + strength badge.
 */
function renderTransmissionSection(
  pptx: PptxGenJS,
  model: DocModel,
  io: { newSlide: (withFooter?: boolean) => PptxGenJS.Slide; heading: (s: PptxGenJS.Slide, title: string, sub?: string) => void; W: number; H: number },
): void {
  const chains = model.policyTransmission ?? [];
  if (!chains.length) return;
  const { newSlide, heading, W, H } = io;
  const perSlide = 2;

  for (let i = 0; i < chains.length; i += perSlide) {
    const s = newSlide();
    heading(s, i === 0 ? "Policy Transmission" : "Policy Transmission (cont.)", i === 0 ? "Policy → sector → name: live evidence + named beneficiaries" : undefined);
    const group = chains.slice(i, i + perSlide);
    const blockH = (H - 2.0) / perSlide;
    group.forEach((c, j) => {
      const y0 = 1.8 + j * blockH;
      const strength = c.transmissionStrength;
      // Policy headline + strength badge
      s.addText(
        [
          { text: `${c.policy.source}: `, options: { bold: true, fontSize: 12, color: ACCENT } },
          { text: c.policy.title, options: { fontSize: 12, color: C.ink } },
          ...(strength ? [{ text: `   [${strength}]`, options: { bold: true, fontSize: 11, color: STRENGTH_COLOR[strength] ?? C.muted } }] : []),
        ],
        { x: 0.5, y: y0, w: W - 1, h: 0.35, valign: "middle" },
      );
      // Themes → beneficiaries line
      const themes = c.affectedThemes.join(" / ") + (c.marketWide ? " (market-wide)" : "");
      const ben = c.beneficiaries.slice(0, 4).map((b) => `${b.nameEn}${b.quadrant ? ` (${b.quadrant})` : ""}`).join(", ") || "n/a";
      s.addText(
        [
          { text: `Themes: `, options: { bold: true, fontSize: 10, color: C.muted } },
          { text: themes, options: { fontSize: 10, color: C.body } },
          { text: `   →  Beneficiaries: `, options: { bold: true, fontSize: 10, color: C.positive } },
          { text: ben, options: { fontSize: 10, color: C.body } },
        ],
        { x: 0.5, y: y0 + 0.38, w: W - 1, h: 0.32, valign: "middle" },
      );
      // At-risk (if any)
      let yEv = y0 + 0.72;
      if (c.atRisk.length) {
        s.addText(
          [
            { text: `At-risk: `, options: { bold: true, fontSize: 10, color: C.negative } },
            { text: c.atRisk.slice(0, 3).map((b) => `${b.nameEn}${b.quadrant ? ` (${b.quadrant})` : ""}`).join(", "), options: { fontSize: 10, color: C.body } },
          ],
          { x: 0.5, y: yEv, w: W - 1, h: 0.3, valign: "middle" },
        );
        yEv += 0.32;
      }
      // Evidence legs (compact)
      const evLines = c.evidence
        .map((e) => {
          const legs = [e.tradeSignal, e.valuationNote, e.earningsNote].filter(Boolean).join(" · ");
          return legs ? `${e.label}: ${legs}` : null;
        })
        .filter(Boolean)
        .slice(0, 2) as string[];
      if (evLines.length) {
        s.addText(`Evidence — ${evLines.join("  |  ")}`, { x: 0.5, y: yEv, w: W - 1, h: 0.3, fontSize: 9, italic: true, color: C.muted, valign: "top" });
        yEv += 0.3;
      }
      // Read-through narrative
      if (c.readThrough) {
        s.addText(c.readThrough, { x: 0.5, y: yEv, w: W - 1, h: blockH - (yEv - y0) - 0.1, fontSize: 10, color: C.body, valign: "top", lineSpacingMultiple: 1.1 });
      }
    });
  }

  // Footnote: deterministic skeleton + thin LLM synthesis.
  const s2 = newSlide();
  heading(s2, "Policy Transmission — Method");
  s2.addText(
    "Each chain is assembled deterministically: a recent policy item is mapped to affected coverage theme(s) (from its tags + the issuing channel's default themes), " +
    "crossed with live evidence — customs/trade YoY, Gap A valuation percentiles, and Gap B earnings momentum — and the affected themes' featured A-share names are ranked " +
    "by the cheap+improving quadrant (cheap-improving = strongest beneficiary; expensive-deteriorating = at-risk). The model adds only the transmission-strength rating and the " +
    "read-through narrative, grounded in that skeleton; it does not introduce new data or names.",
    { x: 0.5, y: 1.8, w: W - 1, h: 2.0, fontSize: 12, color: C.body, valign: "top", lineSpacingMultiple: 1.15 },
  );
  s2.addNotes(
    chains.map((c) => `${c.policy.source}: ${c.policy.title} → ${c.affectedThemes.join("/")} → ${c.beneficiaries.map((b) => b.nameEn).join(", ") || "n/a"}${c.transmissionStrength ? ` [${c.transmissionStrength}]` : ""}. ${c.readThrough ?? ""}`).join(" "),
  );
}

// RELATIVE & GLOBAL CONTEXT (Gap F): AH premium gauge + China index returns vs
// the US-rate / USD/CNY backdrop + LLM top-down stance. Single compact slide;
// skips cleanly when there is no relative-context data.
const STANCE_COLOR: Record<string, string> = {
  constructive: C.positive,
  neutral: C.muted,
  cautious: C.negative,
};

function renderRelativeContextSection(
  pptx: PptxGenJS,
  model: DocModel,
  io: { newSlide: (withFooter?: boolean) => PptxGenJS.Slide; heading: (s: PptxGenJS.Slide, title: string, sub?: string) => void; W: number; H: number },
): void {
  const r = model.relativeContext;
  if (!r) return;
  const haveAny = !!(r.ahPremium || r.indexReturns.length || r.crossAsset);
  if (!haveAny) return;
  const { newSlide, heading, W, H } = io;
  const pct = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

  const s = newSlide();
  heading(s, "Relative & Global Context", "AH premium · China returns vs rate/FX backdrop · top-down stance");

  // Stance badge + whyChina narrative.
  if (r.stance) {
    s.addText(
      `Stance: ${r.stance.toUpperCase()}`,
      { x: 0.5, y: 1.65, w: W - 1, h: 0.4, fontSize: 16, bold: true, color: STANCE_COLOR[r.stance] ?? C.body, valign: "middle" },
    );
  }
  if (r.whyChina) {
    s.addText(r.whyChina, { x: 0.5, y: 2.1, w: W - 1, h: 0.9, fontSize: 12, color: C.body, valign: "top", lineSpacingMultiple: 1.12 });
  }

  // China index returns table (left) + cross-asset + AH premium (right).
  const yTbl = 3.15;
  if (r.indexReturns.length) {
    const rows: PptxGenJS.TableRow[] = [
      ["Index", "YTD", "12m"].map((t) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: ACCENT }, fontSize: 11 } })) as PptxGenJS.TableRow,
    ];
    for (const ir of r.indexReturns) {
      rows.push([
        { text: ir.index, options: { fontSize: 10, color: C.body } },
        { text: pct(ir.ytdPct), options: { fontSize: 10, color: (ir.ytdPct ?? 0) >= 0 ? C.positive : C.negative } },
        { text: pct(ir.ret12mPct), options: { fontSize: 10, color: (ir.ret12mPct ?? 0) >= 0 ? C.positive : C.negative } },
      ]);
    }
    s.addText("China equity returns", { x: 0.5, y: yTbl - 0.35, w: 6, h: 0.3, fontSize: 12, bold: true, color: C.body });
    s.addTable(rows, { x: 0.5, y: yTbl, w: 6.0, colW: [3.0, 1.5, 1.5], border: { type: "solid", color: C.line, pt: 1 }, valign: "middle" });
  }

  // Right column: AH premium + cross-asset backdrop.
  const xR = 7.0, wR = W - xR - 0.5;
  let yR = yTbl - 0.35;
  if (r.ahPremium?.aggregatePremiumPct != null) {
    const ah = r.ahPremium;
    s.addText("AH premium (A vs H, median)", { x: xR, y: yR, w: wR, h: 0.3, fontSize: 12, bold: true, color: C.body });
    yR += 0.35;
    s.addText(
      [
        { text: `${ah.aggregatePremiumPct!.toFixed(1)}%`, options: { bold: true, fontSize: 18, color: C.body } },
        { text: `  ${ah.level ?? "n/a"} · ${ah.pairCount ?? "?"} pairs`, options: { fontSize: 11, color: C.muted } },
      ],
      { x: xR, y: yR, w: wR, h: 0.45, valign: "middle" },
    );
    yR += 0.6;
  }
  if (r.crossAsset) {
    const c = r.crossAsset;
    s.addText("Cross-asset backdrop", { x: xR, y: yR, w: wR, h: 0.3, fontSize: 12, bold: true, color: C.body });
    yR += 0.35;
    const caRows: PptxGenJS.TableRow[] = [];
    if (c.usdCny != null) caRows.push([
      { text: "USD/CNY", options: { fontSize: 10, color: C.body } },
      { text: `${c.usdCny.toFixed(3)}${c.usdCnyDate ? ` (${c.usdCnyDate})` : ""}`, options: { fontSize: 10, color: C.muted } },
    ]);
    if (c.usCn10yDiff != null) caRows.push([
      { text: "US-CN 10Y diff", options: { fontSize: 10, color: C.body } },
      { text: `${c.usCn10yDiff > 0 ? "+" : ""}${c.usCn10yDiff.toFixed(2)}pp (US ${c.us10y != null ? c.us10y.toFixed(2) : "n/a"} / CN ${c.cn10y != null ? c.cn10y.toFixed(2) : "n/a"})`, options: { fontSize: 10, color: C.muted } },
    ]);
    if (caRows.length) {
      s.addTable(caRows, { x: xR, y: yR, w: wR, colW: [1.8, wR - 1.8], border: { type: "solid", color: C.line, pt: 1 }, valign: "middle" });
    }
  }

  // Drivers banner.
  if (r.drivers.length) {
    s.addText("Drivers:", { x: 0.5, y: H - 1.05, w: W - 1, h: 0.3, fontSize: 11, bold: true, color: C.warn });
    s.addText(r.drivers.slice(0, 3).join(" · "), { x: 0.5, y: H - 0.75, w: W - 1, h: 0.4, fontSize: 10, color: C.body, valign: "top" });
  }

  s.addNotes(
    `Relative & global context stance: ${r.stance ?? "n/a"}. ${r.whyChina}` +
    `${r.drivers.length ? ` Drivers: ${r.drivers.join("; ")}.` : ""}` +
    `${r.notes.length ? ` Notes: ${r.notes.join(" ")}` : ""}`,
  );
}

export async function renderPptx(model: DocModel): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "W", width: 13.333, height: 7.5 });
  pptx.layout = "W";
  pptx.author = BRAND.wordmark;
  pptx.company = BRAND.wordmark;

  const W = 13.333, H = 7.5;

  // ── master: footer with wordmark + page handled per slide ──
  const footer = (slide: PptxGenJS.Slide, n: number) => {
    slide.addText(`${BRAND.wordmark} — ${BRAND.tagline}`, { x: 0.4, y: H - 0.4, w: 8, h: 0.3, fontSize: 9, color: C.muted });
    slide.addText(`${n}`, { x: W - 1, y: H - 0.4, w: 0.6, h: 0.3, fontSize: 9, color: C.muted, align: "right" });
  };
  let pageNo = 0;
  const newSlide = (withFooter = true) => {
    const s = pptx.addSlide();
    s.background = { color: C.white };
    pageNo++;
    if (withFooter && pageNo > 1) footer(s, pageNo);
    return s;
  };

  const heading = (s: PptxGenJS.Slide, title: string, sub?: string) => {
    s.addText(title, { x: 0.5, y: 0.35, w: W - 1, h: 0.7, fontSize: 26, bold: true, color: C.ink });
    if (sub) s.addText(sub, { x: 0.5, y: 1.05, w: W - 1, h: 0.4, fontSize: 13, color: C.muted });
    s.addShape(pptx.ShapeType.line, { x: 0.5, y: sub ? 1.5 : 1.15, w: W - 1, h: 0, line: { color: C.line, width: 1 } });
  };

  const bodySlides = (title: string, sub: string | undefined, text: string, notes?: string) => {
    const parts = chunk(plain(text));
    parts.forEach((part, i) => {
      const s = newSlide();
      heading(s, i === 0 ? title : `${title} (cont.)`, i === 0 ? sub : undefined);
      s.addText(part, { x: 0.5, y: 1.7, w: W - 1, h: H - 2.3, fontSize: 15, color: C.body, valign: "top", lineSpacingMultiple: 1.15, paraSpaceAfter: 6 });
      if (notes && i === 0) s.addNotes(notes);
    });
  };

  const figureSlide = (fig: DocFigure | undefined, title: string, notes?: string) => {
    if (!fig) return;
    const s = newSlide();
    heading(s, title);
    s.addImage({ data: pngToDataUri(fig.png), x: 1.4, y: 1.6, w: 10.5, h: 5.0 });
    if (notes) s.addNotes(notes);
  };

  const findFig = (id: string) => model.figures.find((f) => f.id === id);

  // ════════════════ 1. COVER ════════════════
  {
    const s = newSlide(false);
    s.background = { color: C.ink };
    s.addText(BRAND.wordmark, { x: 0.7, y: 2.2, w: W - 1.4, h: 0.6, fontSize: 22, color: ACCENT, bold: true, charSpacing: 2 });
    s.addText(model.title, { x: 0.7, y: 2.9, w: W - 1.4, h: 1.6, fontSize: 34, bold: true, color: "FFFFFF", valign: "top" });
    s.addText(`${BRAND.tagline}  ·  ${model.modeLabel}  ·  As of ${model.asOfDate}`, { x: 0.7, y: 4.7, w: W - 1.4, h: 0.5, fontSize: 15, color: "C7D2FE" });
    if (model.houseView?.headline) {
      s.addText(`House view: ${model.houseView.headline}`, { x: 0.7, y: 5.4, w: W - 1.4, h: 1.0, fontSize: 14, italic: true, color: "E5E7EB", valign: "top" });
    }
  }

  // ════════════════ 2. HOUSE VIEW ════════════════
  if (model.houseView) {
    const hv = model.houseView;
    const s = newSlide();
    heading(s, "House View", `${hv.stance.toUpperCase()} · ${hv.conviction} conviction · ${hv.horizon}`);
    s.addText(hv.headline, { x: 0.5, y: 1.7, w: W - 1, h: 0.8, fontSize: 18, bold: true, color: ACCENT, valign: "top" });
    const pillarRows = hv.pillars.slice(0, 6).map((p) => [{ text: "•", options: { color: ACCENT, bold: true } }, { text: p, options: { color: C.body } }]);
    if (pillarRows.length) {
      s.addText("Pillars", { x: 0.5, y: 2.6, w: 5, h: 0.3, fontSize: 13, bold: true, color: C.ink });
      s.addText(hv.pillars.slice(0, 6).map((p) => ({ text: String(p), options: { bullet: true, color: C.body, fontSize: 13 } })), { x: 0.5, y: 2.95, w: 6.0, h: 3.6, valign: "top", paraSpaceAfter: 6 });
    }
    if (hv.keyRisks?.length) {
      s.addText("Key risks", { x: 6.9, y: 2.6, w: 5, h: 0.3, fontSize: 13, bold: true, color: C.negative });
      s.addText(hv.keyRisks.slice(0, 6).map((r) => ({ text: String(r), options: { bullet: true, color: C.body, fontSize: 13 } })), { x: 6.9, y: 2.95, w: 5.9, h: 3.6, valign: "top", paraSpaceAfter: 6 });
    }
    s.addNotes(`House view: ${hv.headline}. Stance ${hv.stance}, ${hv.conviction} conviction over ${hv.horizon}.`);

    // Sector stance table
    if (hv.sectorStance?.length) {
      const s2 = newSlide();
      heading(s2, "Sector Stances");
      const rows: PptxGenJS.TableRow[] = [
        [
          { text: "Theme", options: { bold: true, color: "FFFFFF", fill: { color: ACCENT } } },
          { text: "Stance", options: { bold: true, color: "FFFFFF", fill: { color: ACCENT } } },
          { text: "Rationale", options: { bold: true, color: "FFFFFF", fill: { color: ACCENT } } },
        ],
        ...hv.sectorStance.map((ss) => [
          { text: String(ss.theme), options: { color: C.body, bold: true } },
          { text: String(ss.stance), options: { color: stanceColor(ss.stance).replace("#", ""), bold: true } },
          { text: String(ss.rationale), options: { color: C.body, fontSize: 11 } },
        ]),
      ];
      s2.addTable(rows, { x: 0.5, y: 1.7, w: W - 1, colW: [2.2, 2.0, 8.1], fontSize: 12, border: { type: "solid", color: C.line, pt: 1 }, valign: "middle" });
    }
  }

  // ════════════════ 3. MODE-SPECIFIC LEAD ════════════════
  if (model.mode === "thesis_driven" && model.thesisVerdict) {
    const v = model.thesisVerdict;
    const s = newSlide();
    heading(s, "Thesis Verdict", `${v.verdict.replace(/_/g, " ").toUpperCase()} · ${v.confidence} confidence`);
    if (model.userThesis) s.addText(`Thesis: ${model.userThesis}`, { x: 0.5, y: 1.65, w: W - 1, h: 0.8, fontSize: 13, italic: true, color: C.muted, valign: "top" });
    s.addText("Supporting", { x: 0.5, y: 2.5, w: 6, h: 0.3, fontSize: 13, bold: true, color: C.positive });
    s.addText((v.supportingEvidence ?? []).slice(0, 5).map((e) => ({ text: String(e.point ?? ""), options: { bullet: true, fontSize: 12, color: C.body } })), { x: 0.5, y: 2.85, w: 6.0, h: 3.8, valign: "top", paraSpaceAfter: 5 });
    s.addText("Contradicting", { x: 6.9, y: 2.5, w: 6, h: 0.3, fontSize: 13, bold: true, color: C.negative });
    s.addText((v.contradictingEvidence ?? []).slice(0, 5).map((e) => ({ text: String(e.point ?? ""), options: { bullet: true, fontSize: 12, color: C.body } })), { x: 6.9, y: 2.85, w: 5.9, h: 3.8, valign: "top", paraSpaceAfter: 5 });
    s.addNotes(`Verdict: ${v.verdict}. ${(v.corrections ?? []).join(" ")}`);

    if ((v.evidenceGaps?.length ?? 0) + (v.corrections?.length ?? 0) + (v.alternatives?.length ?? 0) > 0) {
      const s2 = newSlide();
      heading(s2, "Gaps, Corrections & Alternatives");
      let y = 1.7;
      const block = (label: string, items: string[], color: string) => {
        if (!items?.length) return;
        s2.addText(label, { x: 0.5, y, w: W - 1, h: 0.3, fontSize: 13, bold: true, color });
        y += 0.35;
        s2.addText(items.slice(0, 4).map((t) => ({ text: String(t), options: { bullet: true, fontSize: 12, color: C.body } })), { x: 0.5, y, w: W - 1, h: 1.5, valign: "top", paraSpaceAfter: 4 });
        y += Math.min(items.length, 4) * 0.42 + 0.25;
      };
      block("Evidence gaps", v.evidenceGaps, C.muted);
      block("Where the thesis is wrong", v.corrections, C.warn);
      block("Better-supported alternatives", v.alternatives, ACCENT);
    }
  }

  if (model.mode === "data_driven" && model.portfolio?.length) {
    figureSlide(findFig("portfolio"), "Model Portfolio — Allocation");
    // Portfolio table (paginated at 12 rows/slide)
    const picks = model.portfolio;
    const perSlide = 12;
    for (let i = 0; i < picks.length; i += perSlide) {
      const s = newSlide();
      heading(s, i === 0 ? "Model Portfolio" : "Model Portfolio (cont.)");
      const header: PptxGenJS.TableRow = ["Name", "Stance", "Wt", "Conv", "Rationale"].map((t) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: ACCENT }, fontSize: 11 } }));
      const rows: PptxGenJS.TableRow[] = [header, ...picks.slice(i, i + perSlide).map((p) => [
        { text: String(`${p.nameEn} (${p.symbol})`), options: { fontSize: 10, color: C.body } },
        { text: String(p.stance), options: { fontSize: 10, color: stanceColor(p.stance).replace("#", ""), bold: true } },
        { text: p.weight != null ? `${p.weight}%` : "—", options: { fontSize: 10, color: C.body } },
        { text: String(p.conviction), options: { fontSize: 10, color: C.body } },
        { text: String(p.entryRationale ?? ""), options: { fontSize: 9, color: C.muted } },
      ])];
      s.addTable(rows, { x: 0.4, y: 1.6, w: W - 0.8, colW: [3.0, 1.2, 0.9, 1.2, 6.2], border: { type: "solid", color: C.line, pt: 1 }, valign: "middle" });
    }
  }

  // ════════════════ 4. CHART SLIDES ════════════════
  figureSlide(findFig("equities"), "Equity Indices", "Index moves frame the tactical backdrop.");
  figureSlide(findFig("macro"), "Macro Drivers", "Momentum in the underlying macro series.");

  // ════════════════ 5. NOTE SECTIONS ════════════════
  const SUBS: Record<string, string> = {
    executive_summary: "The call",
    macro_backdrop: "Growth, inflation, liquidity",
    policy_landscape: "Official channels + market linkage",
    cross_asset_flows: "Connect, margin, FX, rates, commodities",
    sector_allocation: "Top-down OW / N / UW",
    single_names: "Featured names",
    scenarios: "Base / Bull / Bear",
    catalysts_calendar: "Forward calendar",
    risks_redteam: "Devil's-advocate panel",
  };
  for (const sec of model.sections) {
    bodySlides(sec.heading, SUBS[sec.key], sec.body, sec.body.slice(0, 700));
    if (sec.key === "cross_asset_flows") figureSlide(findFig("crossasset"), "Cross-Asset Levels");
  }

  // ════════════════ 5b. SCENARIOS & RISK (Gap E) ════════════════
  renderScenarioRiskSection(pptx, model, { newSlide, heading, W, H });

  // ════════════════ 5c. FLOWS & POSITIONING (Gap C) ════════════════
  renderFlowsSection(pptx, model, { newSlide, heading, W, H });

  // ════════════════ 5d. FUNDAMENTALS (Gap B) ════════════════
  renderFundamentalsSection(pptx, model, { newSlide, heading, W, H });

  // ════════════════ 5e. POLICY TRANSMISSION (Gap D) ════════════════
  renderTransmissionSection(pptx, model, { newSlide, heading, W, H });

  // ════════════════ 5f. RELATIVE & GLOBAL CONTEXT (Gap F) ════════════════
  renderRelativeContextSection(pptx, model, { newSlide, heading, W, H });

  // ════════════════ 6. SOURCES ════════════════
  if (model.citations.length) {
    const perSlide = 18;
    for (let i = 0; i < model.citations.length; i += perSlide) {
      const s = newSlide();
      heading(s, i === 0 ? "Sources & Provenance" : "Sources (cont.)");
      s.addText(
        model.citations.slice(i, i + perSlide).map((c) => ({ text: String(`${c.name} — ${c.url}`), options: { bullet: true, fontSize: 10, color: C.muted } })),
        { x: 0.5, y: 1.7, w: W - 1, h: H - 2.3, valign: "top", paraSpaceAfter: 3 },
      );
    }
  }

  // ════════════════ 7. DISCLAIMER ════════════════
  {
    const s = newSlide();
    heading(s, "Methodology & Disclaimer");
    s.addText(
      `Generated by ${BRAND.wordmark} (${model.modeLabel} mode, model: ${model.model}). Every data point carries source provenance; ` +
      `figures are drawn from the live data cascade (CEIC/FRED/OECD/HKEX/EastMoney/AKShare/Yahoo/Stooq) and policy/web research via Sonar Pro. ` +
      `This document is for research purposes and is not investment advice. Verify all figures against primary sources before acting.`,
      { x: 0.5, y: 1.7, w: W - 1, h: 3, fontSize: 13, color: C.body, valign: "top", lineSpacingMultiple: 1.2 },
    );
  }

  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return buf;
}
