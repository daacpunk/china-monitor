/**
 * DOCX strategy-paper renderer (Phase 4) using the `docx` package (pure-JS).
 * Mirrors the PDF content from the same DocModel so the two stay consistent.
 */

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, ExternalHyperlink,
} from "docx";
import { BRAND } from "@shared/brand";
import { buildDocModel, figureForSection, type DocModel } from "./model";
import type { StrategyNote } from "@shared/schema";

const C = BRAND.colors;

function runs(md: string): TextRun[] {
  // honor **bold**
  return (md || "").split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((p) =>
    p.startsWith("**") && p.endsWith("**")
      ? new TextRun({ text: p.slice(2, -2), bold: true })
      : new TextRun(p),
  );
}

function bodyParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = [];
  for (const para of (md || "").trim().split(/\n{2,}/)) {
    const lines = para.split(/\n/);
    const bullets = lines.every((l) => /^\s*[-•]\s+/.test(l));
    if (bullets) {
      for (const l of lines) out.push(new Paragraph({ text: l.replace(/^\s*[-•]\s+/, ""), bullet: { level: 0 }, spacing: { after: 80 } }));
    } else {
      const h = para.match(/^#{2,4}\s+(.*)$/);
      if (h) out.push(new Paragraph({ children: [new TextRun({ text: h[1], bold: true })], spacing: { before: 120, after: 60 } }));
      else out.push(new Paragraph({ children: runs(para), spacing: { after: 140 } }));
    }
  }
  return out;
}

function h2(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } });
}

function cell(text: string, opts: { bold?: boolean; color?: string; fill?: string; size?: number } = {}): TableCell {
  return new TableCell({
    shading: opts.fill ? { fill: opts.fill } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold, color: opts.color, size: (opts.size ?? 20) })] })],
  });
}

function simpleTable(header: string[], rows: string[][][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: C.line },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: C.line },
      left: { style: BorderStyle.SINGLE, size: 2, color: C.line },
      right: { style: BorderStyle.SINGLE, size: 2, color: C.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: C.line },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: C.line },
    },
    rows: [
      new TableRow({ children: header.map((h) => cell(h, { bold: true, color: "FFFFFF", fill: C.accent })) }),
      ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c.map((x) => x).join(""), { size: 18 })) })),
    ],
  });
}

export async function renderDocxFromModel(model: DocModel): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  // Cover
  children.push(
    new Paragraph({ children: [new TextRun({ text: BRAND.wordmark.toUpperCase(), color: C.accent, bold: true, size: 28 })], spacing: { before: 600, after: 80 } }),
    new Paragraph({ children: [new TextRun({ text: model.title, bold: true, size: 52, color: C.ink })], spacing: { after: 120 } }),
    new Paragraph({ children: [new TextRun({ text: `${BRAND.tagline}  ·  ${model.modeLabel}  ·  As of ${model.asOfDate}`, color: C.muted, size: 22 })], spacing: { after: 240 } }),
  );
  if (model.houseView?.headline) {
    children.push(new Paragraph({ children: [new TextRun({ text: `House view: ${model.houseView.headline}`, italics: true, color: C.ink, size: 24 })], spacing: { after: 160 }, shading: { fill: C.panel } }));
  }
  if (model.mode === "thesis_driven" && model.userThesis) {
    children.push(new Paragraph({ children: [new TextRun({ text: `Thesis under review: ${model.userThesis}`, italics: true, color: C.muted, size: 20 })], spacing: { after: 120 } }));
  }

  // House view
  if (model.houseView) {
    const hv = model.houseView;
    children.push(h2("House View"));
    children.push(new Paragraph({ children: [new TextRun({ text: `${hv.stance.toUpperCase()} · ${hv.conviction} conviction · ${hv.horizon}`, bold: true, color: C.accent })], spacing: { after: 120 } }));
    if (hv.pillars?.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: "Pillars", bold: true })], spacing: { after: 60 } }));
      for (const p of hv.pillars) children.push(new Paragraph({ text: p, bullet: { level: 0 } }));
    }
    if (hv.keyRisks?.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: "Key risks", bold: true })], spacing: { before: 120, after: 60 } }));
      for (const r of hv.keyRisks) children.push(new Paragraph({ text: r, bullet: { level: 0 } }));
    }
    if (hv.sectorStance?.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: "Sector stances", bold: true })], spacing: { before: 120, after: 60 } }));
      children.push(simpleTable(["Theme", "Stance", "Rationale"], hv.sectorStance.map((s) => [[s.theme], [s.stance], [s.rationale]])));
    }
  }

  // Mode-specific
  if (model.mode === "thesis_driven" && model.thesisVerdict) {
    const v = model.thesisVerdict;
    children.push(h2("Thesis Verdict"));
    children.push(new Paragraph({ children: [new TextRun({ text: `${v.verdict.replace(/_/g, " ").toUpperCase()}  ·  ${v.confidence} confidence`, bold: true })], spacing: { after: 100 }, shading: { fill: C.panel } }));
    const ev = (label: string, items: { point: string }[]) => {
      if (!items?.length) return;
      children.push(new Paragraph({ children: [new TextRun({ text: label, bold: true })], spacing: { before: 100, after: 50 } }));
      for (const e of items) children.push(new Paragraph({ text: e.point, bullet: { level: 0 } }));
    };
    ev("Supporting evidence", v.supportingEvidence);
    ev("Contradicting evidence", v.contradictingEvidence);
    const list = (label: string, items: string[]) => {
      if (!items?.length) return;
      children.push(new Paragraph({ children: [new TextRun({ text: label, bold: true })], spacing: { before: 100, after: 50 } }));
      for (const i of items) children.push(new Paragraph({ text: i, bullet: { level: 0 } }));
    };
    list("Evidence gaps", v.evidenceGaps);
    list("Where the thesis is wrong", v.corrections);
    list("Better-supported alternatives", v.alternatives);
  }
  if (model.mode === "data_driven" && model.portfolio?.length) {
    children.push(h2("Model Portfolio"));
    children.push(simpleTable(
      ["Name", "Stance", "Wt", "Conv", "Rationale"],
      model.portfolio.map((p) => [[`${p.nameEn} (${p.symbol})`], [p.stance], [p.weight != null ? `${p.weight}%` : "—"], [p.conviction], [`${p.entryRationale} — Risk: ${p.keyRisk}`]]),
    ));
  }

  // Sections with figures
  for (const sec of model.sections) {
    children.push(h2(sec.heading));
    const fig = figureForSection(model, sec.key);
    if (fig) {
      children.push(new Paragraph({ children: [new ImageRun({ data: fig.png, transformation: { width: 560, height: 300 } })] }));
      children.push(new Paragraph({ children: [new TextRun({ text: fig.caption, italics: true, color: C.muted, size: 16 })], spacing: { after: 120 } }));
    }
    children.push(...bodyParagraphs(sec.body));
  }

  // Sources
  if (model.citations.length) {
    children.push(h2("Sources & Provenance"));
    for (const c of model.citations) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: c.name + " — ", color: C.body, size: 18 }),
          new ExternalHyperlink({ link: c.url, children: [new TextRun({ text: c.url, style: "Hyperlink", size: 18 })] }),
        ],
        bullet: { level: 0 },
      }));
    }
  }
  children.push(new Paragraph({ children: [new TextRun({ text: `Generated by ${BRAND.wordmark} · ${model.modeLabel} · model ${model.model}. Research only; not investment advice.`, italics: true, color: C.muted, size: 16 })], spacing: { before: 240 } }));

  const doc = new Document({
    creator: BRAND.wordmark,
    title: model.title,
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc) as unknown as Buffer;
}

export async function renderDocx(note: StrategyNote): Promise<Buffer> {
  const model = await buildDocModel(note);
  return renderDocxFromModel(model);
}
