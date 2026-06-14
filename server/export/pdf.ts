/**
 * PDF strategy-paper renderer (Phase 4) using pdfmake (pure-JS, no native deps).
 * Renders the DocModel into a long-form institutional paper: cover, house view,
 * mode-specific block (portfolio table / thesis verdict), section body with
 * embedded chart figures, and footnoted sources.
 */

import PdfPrinter from "pdfmake";
import { BRAND, stanceColor } from "@shared/brand";
import { pngToDataUri } from "./charts";
import { buildDocModel, figureForSection, type DocModel } from "./model";
import type { StrategyNote } from "@shared/schema";

// pdfmake requires #-prefixed hex; BRAND stores raw hex (for pptx/docx). Prefix here.
const H = (hex: string) => (hex.startsWith("#") ? hex : "#" + hex);
const C = Object.fromEntries(Object.entries(BRAND.colors).map(([k, v]) => [k, H(v as string)])) as Record<keyof typeof BRAND.colors, string>;
const WHITE = "#FFFFFF";

// pdfmake needs font files; it ships Roboto vfs via the standard data module.
// We use the built-in Roboto by loading the vfs fonts shipped with pdfmake.
function makePrinter(): PdfPrinter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vfsFonts = require("pdfmake/build/vfs_fonts.js");
  // vfs shape varies by pdfmake version: it may be the flat map itself, or nested
  // under .pdfMake.vfs / .vfs / .default. Pick whichever actually has the fonts.
  const candidates = [vfsFonts?.pdfMake?.vfs, vfsFonts?.vfs, vfsFonts?.default, vfsFonts];
  const vfs = candidates.find((c) => c && c["Roboto-Regular.ttf"]);
  if (!vfs) throw new Error("pdfmake vfs_fonts: Roboto fonts not found in module export");
  const printer = new PdfPrinter({
    Roboto: {
      normal: Buffer.from(vfs["Roboto-Regular.ttf"], "base64"),
      bold: Buffer.from(vfs["Roboto-Medium.ttf"], "base64"),
      italics: Buffer.from(vfs["Roboto-Italic.ttf"], "base64"),
      bolditalics: Buffer.from(vfs["Roboto-MediumItalic.ttf"], "base64"),
    },
  });
  return printer;
}

// True when a body is predominantly a raw JSON blob (leaked structured payload).
function looksLikeJsonBody(body: string): boolean {
  const s = (body || "").trim().replace(/^```(?:json)?\s*/i, "");
  return /^[\[{]/.test(s) && /"(scenarioSets|scenarios|label|narrative|triggers|keyDrivers|falsification)"/.test(s);
}

// Strip light markdown into pdfmake text runs (bold + bullets + paragraphs).
function mdBlocks(md: string): any[] {
  // Never paginate a leaked raw-JSON body; drop any fenced ```json block first.
  let src = (md || "").replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
  if (looksLikeJsonBody(src)) return [];
  const out: any[] = [];
  const paras = src.split(/\n{2,}/);
  for (const para of paras) {
    // Drop standalone horizontal rules (---, ***, ___).
    if (/^\s*([-*_])\1{2,}\s*$/.test(para)) continue;
    const lines = para.split(/\n/);
    const isBullets = lines.every((l) => /^\s*[-•]\s+/.test(l));
    if (isBullets) {
      out.push({ ul: lines.map((l) => inline(l.replace(/^\s*[-•]\s+/, ""))), margin: [0, 2, 0, 8] });
    } else {
      const h = para.match(/^#{2,4}\s+(.*)$/);
      if (h) out.push({ text: h[1], style: "subhead", margin: [0, 6, 0, 4] });
      else out.push({ text: inline(para), style: "body", margin: [0, 0, 0, 8] });
    }
  }
  return out;
}

// Returns a text array honoring **bold**; strips stray single * / _ emphasis
// markers so they don't render as literal characters.
function inline(s: string): any {
  const parts = (s || "").split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) =>
    p.startsWith("**") && p.endsWith("**")
      ? { text: stripEmphasis(p.slice(2, -2)), bold: true }
      : stripEmphasis(p),
  );
}

// Remove leftover single-* / single-_ italic markers around words.
function stripEmphasis(s: string): string {
  return (s || "")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+?)_/g, "$1$2");
}

export function renderPdfFromModel(model: DocModel): Promise<Buffer> {
  const printer = makePrinter();

  const content: any[] = [];

  // ── Cover ──
  content.push(
    { text: BRAND.wordmark.toUpperCase(), color: C.accent, bold: true, fontSize: 14, characterSpacing: 2, margin: [0, 60, 0, 0] },
    { text: model.title, fontSize: 28, bold: true, color: C.ink, margin: [0, 16, 0, 8] },
    { text: `${BRAND.tagline}  ·  ${model.modeLabel}  ·  As of ${model.asOfDate}`, color: C.muted, fontSize: 12, margin: [0, 0, 0, 24] },
  );
  if (model.houseView?.headline) {
    content.push({
      table: { widths: ["*"], body: [[{ text: `House view: ${model.houseView.headline}`, italics: true, color: C.ink, margin: [10, 10, 10, 10] }]] },
      layout: { fillColor: () => C.panel, hLineColor: () => C.line, vLineColor: () => C.line },
      margin: [0, 0, 0, 16],
    });
  }
  if (model.mode === "thesis_driven" && model.userThesis) {
    content.push({ text: `Thesis under review: ${model.userThesis}`, fontSize: 11, color: C.muted, italics: true, margin: [0, 0, 0, 8] });
  }
  content.push({ text: "", pageBreak: "after" });

  // ── House view detail ──
  if (model.houseView) {
    const hv = model.houseView;
    content.push({ text: "House View", style: "h2" });
    content.push({ text: `${hv.stance.toUpperCase()} · ${hv.conviction} conviction · ${hv.horizon}`, color: C.accent, bold: true, margin: [0, 0, 0, 8] });
    if (hv.pillars?.length) {
      content.push({ text: "Pillars", style: "subhead" });
      content.push({ ul: hv.pillars, style: "body", margin: [0, 0, 0, 8] });
    }
    if (hv.keyRisks?.length) {
      content.push({ text: "Key risks", style: "subhead" });
      content.push({ ul: hv.keyRisks, style: "body", margin: [0, 0, 0, 8] });
    }
    if (hv.sectorStance?.length) {
      content.push({ text: "Sector stances", style: "subhead" });
      content.push({
        table: {
          headerRows: 1,
          widths: [80, 80, "*"],
          body: [
            [hdr("Theme"), hdr("Stance"), hdr("Rationale")],
            ...hv.sectorStance.map((s) => [
              { text: s.theme, bold: true, fontSize: 10 },
              { text: s.stance, color: stanceColor(s.stance), bold: true, fontSize: 10 },
              { text: s.rationale, fontSize: 10, color: C.body },
            ]),
          ],
        },
        layout: tableLayout(),
        margin: [0, 0, 0, 12],
      });
    }
  }

  // ── Mode-specific lead ──
  if (model.mode === "thesis_driven" && model.thesisVerdict) {
    const v = model.thesisVerdict;
    content.push({ text: "Thesis Verdict", style: "h2" });
    content.push({
      table: { widths: ["*"], body: [[{ text: `${v.verdict.replace(/_/g, " ").toUpperCase()}  ·  ${v.confidence} confidence`, bold: true, color: stanceColor(v.verdict), margin: [8, 8, 8, 8] }]] },
      layout: { fillColor: () => C.panel, hLineColor: () => C.line, vLineColor: () => C.line },
      margin: [0, 0, 0, 10],
    });
    pushEvidence(content, "Supporting evidence", v.supportingEvidence, C.positive);
    pushEvidence(content, "Contradicting evidence", v.contradictingEvidence, C.negative);
    if (v.evidenceGaps?.length) { content.push({ text: "Evidence gaps", style: "subhead" }); content.push({ ul: v.evidenceGaps, style: "body" }); }
    if (v.corrections?.length) { content.push({ text: "Where the thesis is wrong", style: "subhead", color: C.warn }); content.push({ ul: v.corrections, style: "body" }); }
    if (v.alternatives?.length) { content.push({ text: "Better-supported alternatives", style: "subhead", color: C.accent }); content.push({ ul: v.alternatives, style: "body", margin: [0, 0, 0, 12] }); }
  }
  if (model.mode === "data_driven" && model.portfolio?.length) {
    content.push({ text: "Model Portfolio", style: "h2" });
    content.push({
      table: {
        headerRows: 1,
        widths: ["*", 44, 32, 42, "*"],
        body: [
          [hdr("Name"), hdr("Stance"), hdr("Wt"), hdr("Conv"), hdr("Rationale / key risk")],
          ...model.portfolio.map((p) => [
            { text: `${p.nameEn}\n${p.symbol}`, fontSize: 9, bold: true },
            { text: p.stance, fontSize: 9, color: stanceColor(p.stance), bold: true },
            { text: p.weight != null ? `${p.weight}%` : "—", fontSize: 9 },
            { text: p.conviction, fontSize: 9 },
            { text: `${p.entryRationale}\nRisk: ${p.keyRisk}`, fontSize: 8, color: C.muted },
          ]),
        ],
      },
      layout: tableLayout(),
      margin: [0, 0, 0, 12],
    });
  }

  // ── Sections (with figures) ──
  for (const sec of model.sections) {
    content.push({ text: sec.heading, style: "h2" });
    const fig = figureForSection(model, sec.key);
    if (fig) content.push({ image: pngToDataUri(fig.png), width: 470, margin: [0, 0, 0, 4] }, { text: fig.caption, fontSize: 8, color: C.muted, margin: [0, 0, 0, 8] });
    content.push(...mdBlocks(sec.body));
  }

  // ── Sources ──
  if (model.citations.length) {
    content.push({ text: "Sources & Provenance", style: "h2", pageBreak: "before" });
    content.push({ ol: model.citations.map((c) => ({ text: [{ text: c.name + " — ", color: C.body }, { text: c.url, color: C.accent, link: c.url }], fontSize: 9 })), margin: [0, 0, 0, 10] });
  }
  content.push({ text: `Generated by ${BRAND.wordmark} · ${model.modeLabel} · model ${model.model}. Research only; not investment advice. Verify figures against primary sources.`, fontSize: 8, italics: true, color: C.muted, margin: [0, 12, 0, 0] });

  const docDef: any = {
    pageSize: "A4",
    pageMargins: [54, 54, 54, 60],
    content,
    defaultStyle: { font: "Roboto", fontSize: 11, color: C.body, lineHeight: 1.25 },
    styles: {
      h2: { fontSize: 17, bold: true, color: C.ink, margin: [0, 14, 0, 8] },
      subhead: { fontSize: 12, bold: true, color: C.ink, margin: [0, 6, 0, 3] },
      body: { fontSize: 11, color: C.body },
    },
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: `${BRAND.wordmark} — ${BRAND.tagline}`, fontSize: 8, color: C.muted, margin: [54, 0, 0, 0] },
        { text: `${currentPage} / ${pageCount}`, alignment: "right", fontSize: 8, color: C.muted, margin: [0, 0, 54, 0] },
      ],
      margin: [0, 20, 0, 0],
    }),
  };

  return new Promise((resolve, reject) => {
    try {
      const doc = printer.createPdfKitDocument(docDef);
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function hdr(t: string): any {
  return { text: t, bold: true, color: WHITE, fillColor: C.accent, fontSize: 10, margin: [3, 4, 3, 4] };
}
function tableLayout(): any {
  return { hLineColor: () => C.line, vLineColor: () => C.line, hLineWidth: () => 0.5, vLineWidth: () => 0.5, paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: () => 5, paddingRight: () => 5 };
}
function pushEvidence(content: any[], label: string, items: { point: string; source?: { name: string; url: string } }[], color: string) {
  if (!items?.length) return;
  content.push({ text: label, style: "subhead", color });
  content.push({ ul: items.map((e) => (e.source?.url ? { text: [e.point + " ", { text: "[source]", color: C.accent, link: e.source.url, fontSize: 9 }] } : e.point)), style: "body", margin: [0, 0, 0, 8] });
}

export async function renderPdf(note: StrategyNote): Promise<Buffer> {
  const model = await buildDocModel(note);
  return renderPdfFromModel(model);
}
