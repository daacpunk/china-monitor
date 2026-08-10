/**
 * Track Record / Thesis Scorecard.
 *
 * Every house view + thesis the tool produces is logged as a falsifiable
 * prediction (see `predictions` table). This module owns:
 *
 *   - capture:  capturePredictionsForHouseView() / capturePredictionForNote()
 *               — best-effort hooks called after a save; never block the save.
 *   - resolve:  resolveDuePredictions() — called from the 15-min scheduler tick.
 *               Scores due predictions against the REALIZED return of the
 *               target over [createdAt -> resolveAt], read from the reliable
 *               registry price series (csi300_monthly / hsi_close). No new
 *               external data source, no sidecar dependency.
 *   - digest:   trackRecordDigest() — one compact block for the strategy note /
 *               deck so the report references its own credibility.
 *
 * Scoring (deliberately simple + auditable):
 *   house_view    up   -> correct if return > +2%; down -> correct if < -2%;
 *                 flat -> correct if within ±2%. Else wrong.
 *   sector_stance overweight  -> correct if sector return > benchmark return;
 *                 underweight -> correct if below. If no clean sector price
 *                 series exists we resolve 'partial' with a note — we never
 *                 fabricate a sector return.
 *   thesis        soft: if the verdict implies a direction, score like a house
 *                 view; otherwise 'partial'.
 */

import { storage } from "../storage";
import { fetchSeries, type TimePoint } from "../series/fetchSeries";
import { THEMES_BY_ID } from "../equity/universe";
import type { HouseView, Prediction, StrategyNote } from "@shared/schema";

// ─── Config ──────────────────────────────────────────────────────────────────

export const HORIZON_DAYS: Record<string, number> = { "1Q": 90, "2Q": 180, "1Y": 365 };
/** Flat band: |return| <= 2% counts as "flat". */
const FLAT_BAND = 0.02;

/**
 * Resolution series, in preference order. `csi300_monthly` (CEIC month-end) is
 * the primary CSI 300 record; `csi300_close` is the daily fallback for when the
 * monthly series is short/unavailable. We never fall back to the flaky sidecar.
 */
const TARGET_SERIES: Record<string, string[]> = {
  CSI300: ["csi300_monthly", "csi300_close"],
  HSI: ["hsi_close", "hangseng_monthly"],
};

function targetSeries(target: string): string[] {
  return TARGET_SERIES[target] ?? [target];
}

export type Direction = "up" | "down" | "flat";

export function stanceToDirection(stance: string): Direction {
  const s = (stance ?? "").toLowerCase();
  if (s.includes("bull") || s.includes("constructive") || s.includes("overweight") || s.includes("positive")) return "up";
  if (s.includes("bear") || s.includes("cautious") || s.includes("underweight") || s.includes("negative")) return "down";
  return "flat";
}

export function horizonDays(horizon: string | null | undefined): number {
  return HORIZON_DAYS[(horizon ?? "2Q").toUpperCase()] ?? 180;
}

export function resolveAtFor(createdAt: Date, horizon: string | null | undefined): Date {
  return new Date(createdAt.getTime() + horizonDays(horizon) * 24 * 60 * 60 * 1000);
}

// ─── Series helpers ──────────────────────────────────────────────────────────

interface DatedPoint { date: string; value: number }

/** Ascending, null-free point list for a registry series. Empty on any failure. */
async function loadSeries(seriesId: string): Promise<DatedPoint[]> {
  try {
    const r = await fetchSeries(seriesId);
    const pts = (r.data ?? []) as TimePoint[];
    return pts
      .filter((p): p is { date: string; value: number } => p != null && p.value != null && !!p.date)
      .map((p) => ({ date: String(p.date).slice(0, 10), value: Number(p.value) }))
      .filter((p) => Number.isFinite(p.value))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/** Latest observation at/just before `on` (ISO date). Falls back to the first point after. */
function valueAsOf(points: DatedPoint[], on: string): DatedPoint | null {
  if (!points.length) return null;
  let last: DatedPoint | null = null;
  for (const p of points) {
    if (p.date <= on) last = p;
    else break;
  }
  return last ?? points[0] ?? null;
}

/** Latest available observation. */
function latest(points: DatedPoint[]): DatedPoint | null {
  return points.length ? points[points.length - 1] : null;
}

/**
 * Realized fractional return between two dates, trying each candidate series in
 * order and returning the first that carries usable history spanning the window.
 * Returns null when nothing usable exists — callers then score 'partial' rather
 * than fabricate a number.
 */
async function realizedReturn(
  seriesIds: string | string[],
  fromIso: string,
  toIso: string,
): Promise<{ ret: number; from: DatedPoint; to: DatedPoint; series: string } | null> {
  const ids = Array.isArray(seriesIds) ? seriesIds : [seriesIds];
  for (const seriesId of ids) {
    if (!seriesId) continue;
    const pts = await loadSeries(seriesId);
    if (pts.length < 2) continue;
    const a = valueAsOf(pts, fromIso);
    const b = valueAsOf(pts, toIso) ?? latest(pts);
    if (!a || !b || !a.value || a.date === b.date) continue;
    return { ret: (b.value - a.value) / a.value, from: a, to: b, series: seriesId };
  }
  return null;
}

/** Representative price series for a coverage theme, benchmark proxies last. */
export function sectorSeriesFor(theme: string): string[] {
  const t = (THEMES_BY_ID as any)?.[theme];
  const proxies: string[] = t?.indexProxies ?? [];
  const isBench = (p: string) => p === "csi300_close" || p === "csi300_monthly";
  return [...proxies.filter((p) => !isBench(p)), ...proxies.filter(isBench)];
}

/** Current level of a target ("CSI300" | "HSI" | a series id), for the anchor. */
export async function currentLevel(target: string | string[]): Promise<{ level: number; asOf: string } | null> {
  const ids = Array.isArray(target) ? target : targetSeries(target);
  for (const sid of ids) {
    const l = latest(await loadSeries(sid));
    if (l) return { level: l.value, asOf: l.date };
  }
  return null;
}

// ─── Capture hooks ───────────────────────────────────────────────────────────

/**
 * Log the saved house view as predictions: one index call (CSI300) plus one
 * relative call per sector stance. Best-effort — callers wrap in try/catch and
 * a failure here must never block the house-view save.
 */
export async function capturePredictionsForHouseView(
  hv: HouseView,
  model?: string | null,
): Promise<number> {
  const now = new Date();
  const horizon = (hv.horizon ?? "2Q").toUpperCase();
  const resolveAt = resolveAtFor(now, horizon);
  const anchorIdx = await currentLevel("CSI300").catch(() => null);
  let created = 0;

  try {
    await storage.createPrediction({
      kind: "house_view",
      sourceId: hv.id ?? null,
      model: model ?? "manual",
      horizon,
      resolveAt,
      claim: {
        target: "CSI300",
        stance: hv.stance,
        direction: stanceToDirection(hv.stance),
        headline: hv.headline ?? "",
      },
      probability: null,
      anchor: anchorIdx ? { csi300: anchorIdx.level, asOf: anchorIdx.asOf } : null,
      status: "open",
      outcome: null,
      realized: null,
      scoredAt: null,
    } as any);
    created++;
  } catch (err) {
    console.error("[trackRecord] house_view capture failed", err);
  }

  const stances = (hv.sectorStance as any[]) ?? [];
  for (const ss of stances) {
    if (!ss?.theme || !ss?.stance) continue;
    try {
      const sids = sectorSeriesFor(String(ss.theme));
      const sectorAnchor = sids.length ? await currentLevel(sids).catch(() => null) : null;
      await storage.createPrediction({
        kind: "sector_stance",
        sourceId: hv.id ?? null,
        model: model ?? "manual",
        horizon,
        resolveAt,
        claim: {
          theme: String(ss.theme),
          stance: String(ss.stance),
          benchmark: "CSI300",
          series: sids,
          rationale: String(ss.rationale ?? "").slice(0, 400),
        },
        probability: null,
        anchor: {
          csi300: anchorIdx?.level ?? null,
          sector: sectorAnchor?.level ?? null,
          asOf: anchorIdx?.asOf ?? new Date().toISOString().slice(0, 10),
        },
        status: "open",
        outcome: null,
        realized: null,
        scoredAt: null,
      } as any);
      created++;
    } catch (err) {
      console.error("[trackRecord] sector_stance capture failed", err);
    }
  }
  return created;
}

const VERDICT_DIRECTION: Record<string, Direction | null> = {
  supported: "up",
  partially_supported: null,
  not_supported: "down",
  insufficient_evidence: null,
};

/**
 * Log a thesis-driven note's verdict as a (soft) prediction. Direction is taken
 * from the house view the note was generated against, when available.
 */
export async function capturePredictionForNote(
  note: StrategyNote,
  opts?: { horizon?: string },
): Promise<number> {
  const verdict: any = note.thesisVerdict;
  if (!verdict) return 0;
  const now = new Date();
  const horizon = (opts?.horizon ?? "2Q").toUpperCase();
  const hvSnap: any = note.houseViewSnapshot ?? null;
  const impliedFromHv = hvSnap?.stance ? stanceToDirection(String(hvSnap.stance)) : null;
  const impliedFromVerdict = VERDICT_DIRECTION[String(verdict.verdict ?? "")] ?? null;
  // Only claim a direction when the verdict actually backs the house view.
  const direction =
    impliedFromVerdict === "up" ? impliedFromHv
    : impliedFromVerdict === "down" && impliedFromHv
      ? (impliedFromHv === "up" ? "down" : impliedFromHv === "down" ? "up" : "flat")
      : null;

  // Probability: prefer a scenario probability carried on the note, else map confidence.
  let probability: number | null = null;
  try {
    const secs = ((note.sections as any[]) ?? []).find((s) => s?.key === "scenarios");
    const sets = secs?.data?.scenarioSets ?? [];
    const base = sets?.[0]?.base ?? sets?.[0];
    if (typeof base?.probability === "number") probability = base.probability > 1 ? base.probability / 100 : base.probability;
  } catch { /* optional */ }
  if (probability == null) {
    const conf = String(verdict.confidence ?? "").toLowerCase();
    probability = conf === "high" ? 0.75 : conf === "medium" ? 0.6 : conf === "low" ? 0.45 : null;
  }

  try {
    await storage.createPrediction({
      kind: "thesis",
      sourceId: note.id ?? null,
      model: note.model ?? null,
      horizon,
      resolveAt: resolveAtFor(now, horizon),
      claim: {
        verdict: String(verdict.verdict ?? "insufficient_evidence"),
        confidence: String(verdict.confidence ?? "low"),
        summary: String(note.userThesis ?? note.title ?? "").slice(0, 500),
        target: "CSI300",
        direction,
      },
      probability,
      anchor: await currentLevel("CSI300").then((l) => (l ? { csi300: l.level, asOf: l.asOf } : null)).catch(() => null),
      status: "open",
      outcome: null,
      realized: null,
      scoredAt: null,
    } as any);
    return 1;
  } catch (err) {
    console.error("[trackRecord] thesis capture failed", err);
    return 0;
  }
}

// ─── Resolution engine ───────────────────────────────────────────────────────

function scoreDirection(direction: Direction, ret: number): "correct" | "wrong" {
  if (direction === "up") return ret > FLAT_BAND ? "correct" : "wrong";
  if (direction === "down") return ret < -FLAT_BAND ? "correct" : "wrong";
  return Math.abs(ret) <= FLAT_BAND ? "correct" : "wrong";
}

async function resolveOne(p: Prediction): Promise<{ outcome: string; realized: any }> {
  const fromIso = new Date(p.createdAt as any).toISOString().slice(0, 10);
  const toIso = new Date(p.resolveAt as any).toISOString().slice(0, 10);
  const claim: any = p.claim ?? {};
  const window = { from: fromIso, to: toIso, horizon: p.horizon };

  if (p.kind === "house_view" || p.kind === "thesis") {
    const direction: Direction | null = claim.direction ?? null;
    const target = claim.target ?? "CSI300";
    const sids = targetSeries(target);
    if (!direction) {
      return { outcome: "partial", realized: { window, note: "No directional claim implied by this call; not scoreable as hit/miss." } };
    }
    const r = await realizedReturn(sids, fromIso, toIso);
    if (!r) {
      return { outcome: "partial", realized: { window, note: `No usable price history for ${sids.join("/")}; scored as partial rather than fabricated.` } };
    }
    const outcome = p.kind === "thesis" && claim.confidence === "low"
      // A low-confidence thesis that goes the wrong way is a soft miss, not a hard one.
      ? (scoreDirection(direction, r.ret) === "correct" ? "correct" : "partial")
      : scoreDirection(direction, r.ret);
    return {
      outcome,
      realized: { ret: r.ret, series: r.series, fromLevel: r.from.value, toLevel: r.to.value, fromDate: r.from.date, toDate: r.to.date, window },
    };
  }

  if (p.kind === "sector_stance") {
    const rawSeries = claim.series ?? sectorSeriesFor(String(claim.theme ?? ""));
    const sids: string[] = Array.isArray(rawSeries) ? rawSeries : rawSeries ? [rawSeries] : [];
    const bench = await realizedReturn(targetSeries("CSI300"), fromIso, toIso);
    const sect = sids.length ? await realizedReturn(sids, fromIso, toIso) : null;
    if (!sect || !bench) {
      return {
        outcome: "partial",
        realized: { window, benchmarkRet: bench?.ret ?? null, note: `No clean price series for theme "${claim.theme}"${sids.length ? ` (proxies ${sids.join("/")})` : ""}; relative call not scoreable.` },
      };
    }
    const stance = String(claim.stance ?? "neutral").toLowerCase();
    const excess = sect.ret - bench.ret;
    let outcome: string;
    if (stance === "overweight") outcome = excess > 0 ? "correct" : "wrong";
    else if (stance === "underweight") outcome = excess < 0 ? "correct" : "wrong";
    else outcome = Math.abs(excess) <= FLAT_BAND ? "correct" : "wrong";
    return { outcome, realized: { ret: sect.ret, benchmarkRet: bench.ret, excess, series: sect.series, benchmarkSeries: bench.series, window } };
  }

  return { outcome: "partial", realized: { window, note: `Unknown prediction kind "${p.kind}".` } };
}

export interface ResolveResult {
  checked: number;
  resolved: number;
  correct: number;
  wrong: number;
  partial: number;
}

/**
 * Score every open prediction whose resolve_at has passed. Each is wrapped in
 * try/catch so one bad row can't halt the loop. Called from the scheduler tick.
 */
export async function resolveDuePredictions(now: Date = new Date()): Promise<ResolveResult> {
  const out: ResolveResult = { checked: 0, resolved: 0, correct: 0, wrong: 0, partial: 0 };
  let due: Prediction[] = [];
  try {
    due = await storage.getDuePredictions(now);
  } catch (err) {
    console.error("[trackRecord] getDuePredictions failed", err);
    return out;
  }
  for (const p of due) {
    out.checked++;
    try {
      const { outcome, realized } = await resolveOne(p);
      await storage.resolvePrediction(p.id, { outcome, realized, scoredAt: new Date() });
      out.resolved++;
      if (outcome === "correct") out.correct++;
      else if (outcome === "wrong") out.wrong++;
      else out.partial++;
    } catch (err) {
      console.error(`[trackRecord] failed to resolve prediction #${p.id}`, err);
    }
  }
  return out;
}

// ─── Report / deck digest ────────────────────────────────────────────────────

export function pct(n: number | null | undefined, d = 1): string {
  return n == null || !Number.isFinite(n) ? "n/a" : `${(n * 100).toFixed(d)}%`;
}

function claimLabel(p: Prediction): string {
  const c: any = p.claim ?? {};
  if (p.kind === "house_view") return `${c.target ?? "CSI300"} ${c.stance ?? ""} (${c.direction ?? "?"})`;
  if (p.kind === "sector_stance") return `${c.theme ?? "?"} ${c.stance ?? ""} vs ${c.benchmark ?? "CSI300"}`;
  return `thesis: ${String(c.summary ?? "").slice(0, 90)}`;
}

/**
 * Compact TRACK RECORD block for the strategy-note evidence base and the deck.
 * Always safe: returns a short "no resolved calls yet" line rather than throwing.
 */
export async function trackRecordDigest(): Promise<string> {
  try {
    const [summary, resolved] = await Promise.all([
      storage.trackRecordSummary(),
      storage.listPredictions({ status: "resolved", limit: 5 }),
    ]);
    if (summary.total === 0) {
      return "TRACK RECORD: no predictions logged yet (the scorecard starts recording from the next house-view or thesis save).";
    }
    const byKind = summary.byKind
      .map((b) => `${b.key} ${b.hitRate != null ? pct(b.hitRate, 0) : "n/a"} (${b.correct}/${b.correct + b.wrong})`)
      .join(", ");
    const notable = resolved[0];
    const notableLine = notable
      ? `Most recently resolved: ${claimLabel(notable)} -> ${notable.outcome}` +
        (typeof (notable.realized as any)?.ret === "number" ? ` (realized ${pct((notable.realized as any).ret)})` : "")
      : "No calls have reached their resolution date yet.";
    return [
      "TRACK RECORD (self-scored, auto-resolved against realized index returns):",
      `  Overall hit rate: ${summary.hitRate != null ? pct(summary.hitRate, 0) : "n/a"} on ${summary.correct + summary.wrong} scored calls ` +
        `(${summary.resolved} resolved, ${summary.open} still open${summary.brier != null ? `, Brier ${summary.brier.toFixed(3)} over ${summary.brierN}` : ""}).`,
      byKind ? `  By kind: ${byKind}.` : "",
      `  ${notableLine}`,
      "  Treat this as the credibility weight on the calls below — a low hit rate should widen the error bars, not be hidden.",
    ].filter(Boolean).join("\n");
  } catch (err) {
    console.error("[trackRecord] digest failed", err);
    return "";
  }
}
