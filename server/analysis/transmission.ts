/**
 * Credit, liquidity, property transmission, and a weekly activity nowcast.
 *
 * Deterministic. No LLM, no fabricated consensus. Every number comes from a
 * registry series or an already-imported CEIC observation. Missing inputs are
 * omitted and named in `gaps`, never filled in.
 *
 * TSF here is an incomplete flow: RMB loans + FX loans + entrusted loans +
 * trust loans. It is not official Aggregate Financing. Official TSF also
 * includes bankers' acceptances, corporate bonds, and equity financing.
 */

import { fetchSeries, type TimePoint } from "../series/fetchSeries";
import { storage } from "../storage";
import { getUpcomingReleases, type MacroRelease } from "../clients/calendar";

export interface Obs {
  id: string;
  label: string;
  date: string;
  value: number;
  unit: string;
  source: string | null;
  stale: boolean;
}

export interface TransmissionRead {
  asOf: string;
  credit: {
    incompleteTsfFlow: Obs | null;
    components: Obs[];
    coverage: string;
    loansVsYearAgo: number | null;
  };
  liquidity: {
    dr007: Obs | null;
    policyRate7d: Obs | null;
    spreadDr007VsPolicy: number | null;
    m1Yoy: Obs | null;
    m2Yoy: Obs | null;
    m1MinusM2: number | null;
    regime: "easy" | "tight" | "mixed" | "insufficient";
    why: string;
  };
  property: {
    startsYoy: Obs | null;
    pricesYoy: Obs | null;
    faiRealEstateYoy: Obs | null;
    profitsYoy: Obs | null;
    salesValueYoy: number | null;
    regime: "contraction" | "stabilisation" | "recovery" | "insufficient";
    why: string;
  };
  nowcast: {
    label: "expanding" | "slowing" | "contracting" | "insufficient";
    score: number | null;
    inputs: { label: string; value: number; unit: string; date: string; signal: "up" | "down" | "neutral" }[];
    why: string;
    cadence: "weekly";
    horizonNote: string;
  };
  calendar: MacroRelease[];
  gaps: string[];
  digest: string;
}

const CEIC_FLOW = [
  { id: "322664201", label: "New RMB loans", unit: "RMB bn" },
  { id: "322664301", label: "New FX loans", unit: "RMB bn" },
  { id: "322664401", label: "Entrusted loans", unit: "RMB bn" },
  { id: "322664501", label: "Trust loans", unit: "RMB bn" },
] as const;

function n(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function fmt(v: number | null | undefined, d = 1): string {
  return n(v) ? v.toFixed(d) : "n/a";
}

function lastPoint(points: TimePoint[]): { date: string; value: number } | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (n(p.value)) return { date: p.date, value: p.value };
  }
  return null;
}

function yoyAt(points: TimePoint[], date: string, value: number): number | null {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const key = `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prev = points.find((p) => p.date.slice(0, 7) === key && n(p.value));
  if (!prev || !n(prev.value) || prev.value === 0) return null;
  return ((value - prev.value) / Math.abs(prev.value)) * 100;
}

async function fromRegistry(id: string, label: string, unit: string): Promise<{ obs: Obs | null; points: TimePoint[] }> {
  try {
    const r = await fetchSeries(id);
    const points = r.data ?? [];
    const last = lastPoint(points);
    if (!last) return { obs: null, points };
    return {
      points,
      obs: {
        id,
        label,
        date: last.date.slice(0, 10),
        value: last.value,
        unit,
        source: r.provenance?.source ?? null,
        stale: Boolean((r.provenance as { stale?: boolean } | undefined)?.stale),
      },
    };
  } catch {
    return { obs: null, points: [] };
  }
}

async function fromCeic(seriesId: string, label: string, unit: string): Promise<{ obs: Obs | null; points: TimePoint[] }> {
  try {
    const rows = await storage.getLatestCeicObservations(seriesId);
    const points: TimePoint[] = rows
      .filter((r) => n(r.value))
      .map((r) => ({ date: r.date, value: Number(r.value) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const last = lastPoint(points);
    if (!last) return { obs: null, points };
    return {
      points,
      obs: {
        id: seriesId,
        label,
        date: last.date.slice(0, 10),
        value: last.value,
        unit,
        source: "ceic_import",
        stale: false,
      },
    };
  } catch {
    return { obs: null, points: [] };
  }
}

function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

export async function buildTransmission(): Promise<TransmissionRead> {
  const gaps: string[] = [];
  const [rmb, fx, entrusted, trust, dr, policy, m1, m2, starts, prices, faiRe, profits, sales, pmi, retail, exports, iva, power] =
    await Promise.all([
      fromCeic(CEIC_FLOW[0].id, CEIC_FLOW[0].label, CEIC_FLOW[0].unit),
      fromCeic(CEIC_FLOW[1].id, CEIC_FLOW[1].label, CEIC_FLOW[1].unit),
      fromCeic(CEIC_FLOW[2].id, CEIC_FLOW[2].label, CEIC_FLOW[2].unit),
      fromCeic(CEIC_FLOW[3].id, CEIC_FLOW[3].label, CEIC_FLOW[3].unit),
      fromRegistry("dr007", "DR007", "%"),
      fromRegistry("policy_rate_7d", "PBoC 7-day reverse repo", "%"),
      fromRegistry("m1_yoy", "M1 YoY", "%"),
      fromRegistry("m2_yoy", "M2 YoY", "%"),
      fromRegistry("property_starts_ytd", "Property starts YTD YoY", "%"),
      fromRegistry("new_home_prices_70city", "New-home prices YoY", "%"),
      fromRegistry("fai_real_estate_ytd", "Real-estate FAI YTD YoY", "%"),
      fromRegistry("industrial_profits_ytd_yoy", "Industrial profits YTD YoY", "%"),
      fromRegistry("property_sales_value_ytd", "Commodity building sales YTD", "RMB mn"),
      fromRegistry("pmi_mfg", "NBS manufacturing PMI", "index"),
      fromRegistry("retail_sales_yoy", "Retail sales YoY", "%"),
      fromRegistry("exports_yoy", "Exports YoY", "%"),
      fromRegistry("iva_yoy", "Industrial value-added YoY", "%"),
      fromRegistry("electricity_generation", "Electricity generation", "GWh"),
    ]);

  const components = [rmb, fx, entrusted, trust].map((x) => x.obs).filter((x): x is Obs => !!x);
  const month = components.map((c) => c.date.slice(0, 7)).sort().pop() ?? null;
  const aligned = month ? components.filter((c) => c.date.slice(0, 7) === month) : [];
  const incompleteTsfFlow: Obs | null = aligned.length
    ? {
        id: "tsf_incomplete_flow",
        label: "Incomplete TSF flow (4 components)",
        date: `${month}-01`,
        value: aligned.reduce((s, c) => s + c.value, 0),
        unit: "RMB bn",
        source: "ceic_import",
        stale: aligned.some((c) => c.stale),
      }
    : null;
  if (aligned.length < 4) gaps.push("Incomplete TSF is missing one or more of RMB, FX, entrusted, and trust loans.");
  gaps.push("Official TSF still needs bankers' acceptances, corporate bonds, and equity financing. Do not call the 4-component sum TSF.");

  const loansVsYearAgo = rmb.obs ? yoyAt(rmb.points, rmb.obs.date, rmb.obs.value) : null;

  const spread = dr.obs && policy.obs ? dr.obs.value - policy.obs.value : null;
  const m1MinusM2 = m1.obs && m2.obs ? m1.obs.value - m2.obs.value : null;
  let liqRegime: TransmissionRead["liquidity"]["regime"] = "insufficient";
  let liqWhy = "Not enough rates or money-supply prints.";
  if (n(spread) || n(m1MinusM2)) {
    const tight = (n(spread) && spread > 0.15) || (n(m1MinusM2) && m1MinusM2 < -2);
    const easy = (n(spread) && spread < 0) && (n(m1MinusM2) ? m1MinusM2 > -1 : true);
    if (easy && !tight) {
      liqRegime = "easy";
      liqWhy = "DR007 is at or through the 7-day reverse repo, and the M1–M2 gap is not deeply negative.";
    } else if (tight && !(n(spread) && spread < 0 && n(m1MinusM2) && m1MinusM2 > 0)) {
      liqRegime = n(spread) && n(m1MinusM2) ? "tight" : "mixed";
      liqWhy = n(spread) && spread > 0.15
        ? "DR007 is above the policy rate, so interbank liquidity is tighter than the corridor."
        : "M1 is growing well below M2, so transaction money is lagging broad money.";
      if (liqRegime === "mixed") liqWhy = "Rates and the M1–M2 gap do not agree. Treat liquidity as mixed.";
    } else {
      liqRegime = "mixed";
      liqWhy = "The policy-rate spread and the M1–M2 gap are not pointing the same way.";
    }
  }
  if (!dr.obs) gaps.push("DR007 missing.");
  if (!policy.obs) gaps.push("PBoC 7-day reverse repo missing.");

  const propSignals: { name: string; v: number | null }[] = [
    { name: "starts", v: starts.obs?.value ?? null },
    { name: "prices", v: prices.obs?.value ?? null },
    { name: "fai", v: faiRe.obs?.value ?? null },
    { name: "profits", v: profits.obs?.value ?? null },
  ];
  const known = propSignals.filter((s) => n(s.v));
  const neg = known.filter((s) => s.v! < 0).length;
  const pos = known.filter((s) => s.v! > 0).length;
  let propRegime: TransmissionRead["property"]["regime"] = "insufficient";
  let propWhy = "Not enough property prints.";
  if (known.length >= 3) {
    if (neg >= 3) {
      propRegime = "contraction";
      propWhy = `${neg} of ${known.length} property and profit gauges are negative.`;
    } else if (pos >= 3) {
      propRegime = "recovery";
      propWhy = `${pos} of ${known.length} property and profit gauges are positive.`;
    } else {
      propRegime = "stabilisation";
      propWhy = "Property gauges are split. Do not call a turn from one series.";
    }
  }
  const salesYoy = sales.obs ? yoyAt(sales.points, sales.obs.date, sales.obs.value) : null;

  const nowInputs: TransmissionRead["nowcast"]["inputs"] = [];
  const pushSig = (obs: Obs | null, upIf: (v: number) => boolean, downIf: (v: number) => boolean) => {
    if (!obs) return;
    const signal = upIf(obs.value) ? "up" : downIf(obs.value) ? "down" : "neutral";
    nowInputs.push({ label: obs.label, value: obs.value, unit: obs.unit, date: obs.date, signal });
  };
  pushSig(pmi.obs, (v) => v >= 50, (v) => v < 50);
  pushSig(retail.obs, (v) => v > 0, (v) => v < 0);
  pushSig(exports.obs, (v) => v > 0, (v) => v < 0);
  pushSig(iva.obs, (v) => v >= 5, (v) => v < 4);
  const powerYoy = power.obs ? yoyAt(power.points, power.obs.date, power.obs.value) : null;
  if (power.obs && n(powerYoy)) {
    nowInputs.push({
      label: "Electricity generation YoY",
      value: powerYoy,
      unit: "%",
      date: power.obs.date,
      signal: powerYoy > 0 ? "up" : "down",
    });
  }
  const ups = nowInputs.filter((i) => i.signal === "up").length;
  const downs = nowInputs.filter((i) => i.signal === "down").length;
  const denom = nowInputs.length;
  let nowLabel: TransmissionRead["nowcast"]["label"] = "insufficient";
  let nowWhy = "Fewer than three activity prints.";
  let score: number | null = null;
  if (denom >= 3) {
    score = Math.round((ups / denom) * 100);
    if (ups >= downs + 2) {
      nowLabel = "expanding";
      nowWhy = `${ups} of ${denom} activity gauges are above their expansion threshold.`;
    } else if (downs >= ups + 2) {
      nowLabel = "contracting";
      nowWhy = `${downs} of ${denom} activity gauges are below their expansion threshold.`;
    } else {
      nowLabel = "slowing";
      nowWhy = "Activity gauges are split. Exports can be strong while domestic demand is not.";
    }
  }

  const calendar = getUpcomingReleases(45).slice(0, 8);
  const asOf = new Date().toISOString().slice(0, 10);
  const digest = [
    `CREDIT / LIQUIDITY / PROPERTY (deterministic, as of ${asOf}):`,
    incompleteTsfFlow
      ? `  - Incomplete TSF flow ${fmt(incompleteTsfFlow.value, 0)} ${incompleteTsfFlow.unit} (${incompleteTsfFlow.date.slice(0, 7)}, ${aligned.length}/4 components). Not official TSF.`
      : "  - Incomplete TSF flow: n/a",
    `  - New RMB loans vs a year earlier: ${fmt(loansVsYearAgo)}%.`,
    `  - Liquidity ${liqRegime}: DR007 ${fmt(dr.obs?.value, 2)} (${dr.obs?.date ?? "n/a"}) vs 7-day reverse repo ${fmt(policy.obs?.value, 2)} (${policy.obs?.date ?? "n/a"}), spread ${fmt(spread, 2)} pp. M1−M2 ${fmt(m1MinusM2)} pp. ${liqWhy}`,
    `  - Property ${propRegime}: starts ${fmt(starts.obs?.value)}%, prices ${fmt(prices.obs?.value)}%, real-estate FAI ${fmt(faiRe.obs?.value)}%, industrial profits ${fmt(profits.obs?.value)}%, sales value YoY ${fmt(salesYoy)}%. ${propWhy}`,
    `NOWCAST (weekly tape, not the 12-month view): ${nowLabel}${score != null ? ` (score ${score})` : ""}. ${nowWhy}`,
    ...nowInputs.map((i) => `  - ${i.label}: ${fmt(i.value, i.unit === "index" ? 1 : 1)} ${i.unit} (${i.date}) ${i.signal}`),
    calendar.length
      ? `FORWARD CALENDAR (estimated official windows, next 45 days):\n${calendar.map((c) => `  - ${c.date} ${c.agency} ${c.indicator}${c.expectedRelease ? "" : " (estimated)"}`).join("\n")}`
      : "FORWARD CALENDAR: no releases in the next 45 days.",
    "Default scenario horizon is one quarter. Twelve-month is the second horizon, not the default.",
  ].join("\n");

  return {
    asOf,
    credit: {
      incompleteTsfFlow,
      components,
      coverage: `${aligned.length}/4 flow components in ${month ?? "n/a"}; official TSF not complete`,
      loansVsYearAgo,
    },
    liquidity: {
      dr007: dr.obs,
      policyRate7d: policy.obs,
      spreadDr007VsPolicy: spread,
      m1Yoy: m1.obs,
      m2Yoy: m2.obs,
      m1MinusM2,
      regime: liqRegime,
      why: liqWhy,
    },
    property: {
      startsYoy: starts.obs,
      pricesYoy: prices.obs,
      faiRealEstateYoy: faiRe.obs,
      profitsYoy: profits.obs,
      salesValueYoy: salesYoy,
      regime: propRegime,
      why: propWhy,
    },
    nowcast: {
      label: nowLabel,
      score,
      inputs: nowInputs,
      why: nowWhy,
      cadence: "weekly",
      horizonNote: "Weekly activity tape. One-quarter is the default strategy horizon. Twelve months is the second horizon.",
    },
    calendar,
    gaps,
    digest,
  };
}

export function transmissionDigest(read: TransmissionRead): string {
  return read.digest;
}
