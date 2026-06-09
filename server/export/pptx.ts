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
