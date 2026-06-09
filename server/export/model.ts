/**
 * Shared export content model (Phase 4).
 *
 * Converts a Phase 3 strategy_note (+ a live macro snapshot for charts) into ONE
 * normalized model that the PDF, DOCX, and PPTX renderers all consume — so the
 * three formats stay consistent. Also builds the chart PNGs.
 */

import type { StrategyNote } from "@shared/schema";
import { buildBriefInputs } from "../analysis/brief";
import { renderLineChart, renderBarChart, renderDonut, type ChartSeries } from "./charts";

export interface DocFigure {
  id: string;
  title: string;
  png: Buffer;
  caption: string;
}

export interface DocModel {
  title: string;
  asOfDate: string;
  mode: "data_driven" | "thesis_driven";
  modeLabel: string;
  userThesis: string;
  // house view
  houseView?: {
    headline: string; stance: string; conviction: string; horizon: string;
    pillars: string[]; keyRisks: string[];
    sectorStance: { theme: string; stance: string; rationale: string }[];
  } | null;
  // mode-specific
  portfolio?: {
    symbol: string; nameEn: string; theme: string; stance: string;
    weight?: number; conviction: string; entryRationale: string; keyRisk: string;
  }[];
  thesisVerdict?: {
    verdict: string; confidence: string;
    supportingEvidence: { point: string; source?: { name: string; url: string } }[];
    contradictingEvidence: { point: string; source?: { name: string; url: string } }[];
    evidenceGaps: string[]; corrections: string[]; alternatives: string[];
  };
  sections: { key: string; heading: string; body: string }[];
  citations: { name: string; url: string }[];
  figures: DocFigure[];
  model: string;
}

function fnum(n: any, d = 1): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

/** Build chart figures from a live macro snapshot + the note's portfolio. */
async function buildFigures(note: StrategyNote): Promise<DocFigure[]> {
  const figures: DocFigure[] = [];
  try {
    const inputs: any = await buildBriefInputs();

    // 1) Equity indices bar (latest % change) — provenance-aware.
    const eq = (inputs.equities ?? []).filter((e: any) => typeof e.chgPct === "number");
    if (eq.length) {
      figures.push({
        id: "equities",
        title: "Equity Indices — latest % change",
        png: renderBarChart(
          eq.map((e: any) => e.label ?? e.id),
          eq.map((e: any) => e.chgPct),
          { title: "Equity Indices — latest % change", caption: "Source: China Monitor data cascade (CEIC/HKEX/Yahoo/Stooq)", yLabel: "%" },
        ),
        caption: "Equity index moves as of " + inputs.asOfDate,
      });
    }

    // 2) Macro drivers bar (MoM) where available.
    const dr = (inputs.drivers ?? []).filter((d: any) => typeof d.mom === "number").slice(0, 8);
    if (dr.length) {
      figures.push({
        id: "macro",
        title: "Macro Drivers — MoM change",
        png: renderBarChart(
          dr.map((d: any) => d.label ?? d.id),
          dr.map((d: any) => d.mom),
          { title: "Macro Drivers — MoM change", caption: "Source: CEIC / FRED / OECD (provenance-tagged)", yLabel: "MoM" },
        ),
        caption: "Macro drivers month-over-month, as of " + inputs.asOfDate,
      });
    }

    // 3) Cross-asset line (normalized latest levels) — illustrative levels.
    const ca = (inputs.crossAsset ?? []).filter((c: any) => typeof c.latest === "number").slice(0, 5);
    if (ca.length) {
      const series: ChartSeries[] = ca.map((c: any) => ({
        label: c.label ?? c.id,
        points: [{ x: "prev", y: c.prev ?? c.latest }, { x: "now", y: c.latest }],
      }));
      figures.push({
        id: "crossasset",
        title: "Cross-Asset Levels",
        png: renderLineChart(series, { title: "Cross-Asset — recent levels", caption: "Source: market data cascade", }),
        caption: "Cross-asset snapshot, as of " + inputs.asOfDate,
      });
    }
  } catch {
    /* charts are best-effort; a note without figures still exports */
  }

  // 4) Portfolio allocation donut (Mode A).
  const pf = (note.portfolio as any[]) ?? [];
  const longs = pf.filter((p) => p.stance === "long" && typeof p.weight === "number" && p.weight > 0);
  if (longs.length) {
    figures.push({
      id: "portfolio",
      title: "Model Portfolio — long allocation",
      png: renderDonut(
        longs.map((p) => p.nameEn),
        longs.map((p) => p.weight),
        { title: "Model Portfolio — long allocation", caption: "China Monitor model portfolio (illustrative weights)" },
      ),
      caption: "Suggested long allocation by name",
    });
  }

  return figures;
}

const MODE_LABEL: Record<string, string> = {
  data_driven: "Data-Driven",
  thesis_driven: "Thesis-Driven",
};

export async function buildDocModel(note: StrategyNote): Promise<DocModel> {
  const hv = (note.houseViewSnapshot as any) ?? null;
  const figures = await buildFigures(note);
  return {
    title: note.title,
    asOfDate: note.asOfDate,
    mode: note.mode as any,
    modeLabel: MODE_LABEL[note.mode] ?? note.mode,
    userThesis: note.userThesis ?? "",
    houseView: hv
      ? {
          headline: hv.headline ?? "",
          stance: hv.stance ?? "",
          conviction: hv.conviction ?? "",
          horizon: hv.horizon ?? "",
          pillars: hv.pillars ?? [],
          keyRisks: hv.keyRisks ?? [],
          sectorStance: hv.sectorStance ?? [],
        }
      : null,
    portfolio: (note.portfolio as any[]) ?? undefined,
    thesisVerdict: (note.thesisVerdict as any) ?? undefined,
    sections: (note.sections as any[]) ?? [],
    citations: (note.citations as any[]) ?? [],
    figures,
    model: note.model,
  };
}

/** Match a figure to the section it belongs under (for inline placement). */
export function figureForSection(model: DocModel, key: string): DocFigure | undefined {
  if (key === "macro_backdrop") return model.figures.find((f) => f.id === "macro");
  if (key === "cross_asset_flows") return model.figures.find((f) => f.id === "crossasset");
  if (key === "sector_allocation") return model.figures.find((f) => f.id === "portfolio") ?? model.figures.find((f) => f.id === "equities");
  if (key === "executive_summary") return model.figures.find((f) => f.id === "equities");
  return undefined;
}
