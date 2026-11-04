/**
 * Paper book — the latest model portfolio, marked to market.
 *
 * This is a discussion book, not a live order blotter. Weights come from the
 * last data-driven strategy note. P&L is price change since that note's as-of
 * date, times the stated weight. Missing prices stay blank. Liquidity is a
 * 20-session average of close x volume when the sidecar returns volume; it is
 * not official ADV. Stock Connect eligibility is not inferred.
 */

import { storage } from "../storage";
import { allNames } from "./universe";
import { getAshareHistorical, getHkHistorical, type AkshareOhlcvPoint } from "../clients/akshare";

export interface PaperLine {
  symbol: string;
  nameEn: string;
  theme: string;
  market: "ashare" | "hk" | "unknown";
  stance: string;
  weight: number | null;
  conviction: string;
  entryDate: string | null;
  entryPrice: number | null;
  latestDate: string | null;
  latestPrice: number | null;
  returnPct: number | null;
  contributionPct: number | null;
  avgValueTraded20d: number | null;
  liquidity: "adequate" | "thin" | "unknown";
  connect: "not_verified";
  note: string | null;
}

export interface PaperBook {
  asOf: string;
  noteId: number | null;
  noteTitle: string | null;
  noteDate: string | null;
  lines: PaperLine[];
  longWeight: number;
  bookReturnPct: number | null;
  pricedCount: number;
  gaps: string[];
  digest: string;
}

function n(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function padHk(symbol: string): string {
  const s = symbol.replace(/\D/g, "");
  return s.length <= 5 ? s.padStart(5, "0") : s;
}

async function history(market: "ashare" | "hk", symbol: string, start: string): Promise<AkshareOhlcvPoint[]> {
  const r = market === "hk"
    ? await getHkHistorical({ symbol: padHk(symbol), start, adjust: "qfq" })
    : await getAshareHistorical({ symbol, start, adjust: "qfq" });
  return (r.data ?? []).filter((p) => n(p.close)).sort((a, b) => a.date.localeCompare(b.date));
}

export async function buildPaperBook(): Promise<PaperBook> {
  const notes = await storage.listStrategyNotes(30);
  const note = notes.find((x) => x.mode === "data_driven" && Array.isArray(x.portfolio) && (x.portfolio as unknown[]).length > 0);
  const gaps: string[] = [
    "Stock Connect eligibility is not verified in this book.",
    "20-day value traded is a sidecar proxy, not official ADV.",
  ];
  if (!note) {
    const empty = "PAPER BOOK: no data-driven model portfolio has been saved yet.";
    return {
      asOf: new Date().toISOString().slice(0, 10),
      noteId: null,
      noteTitle: null,
      noteDate: null,
      lines: [],
      longWeight: 0,
      bookReturnPct: null,
      pricedCount: 0,
      gaps,
      digest: empty,
    };
  }

  const bySymbol = new Map(allNames().map((nm) => [nm.symbol, nm]));
  const picks = (note.portfolio as any[]).slice(0, 15);
  const start = note.asOfDate.slice(0, 10);
  const lines: PaperLine[] = [];

  for (const p of picks) {
    const symbol = String(p.symbol ?? "");
    const known = bySymbol.get(symbol) ?? bySymbol.get(padHk(symbol));
    const market = known?.market ?? (symbol.replace(/\D/g, "").length <= 5 && symbol.replace(/\D/g, "").length > 0 && !/^[036]\d{5}$/.test(symbol) ? "hk" : symbol ? "ashare" : "unknown");
    const weight = n(p.weight) ? p.weight : null;
    const stance = String(p.stance ?? "watch");
    let entry: AkshareOhlcvPoint | null = null;
    let latest: AkshareOhlcvPoint | null = null;
    let avgValue: number | null = null;
    let err: string | null = null;
    if (market === "ashare" || market === "hk") {
      try {
        const bars = await history(market, symbol, start);
        entry = bars.find((b) => b.date >= start) ?? null;
        latest = bars.length ? bars[bars.length - 1] : null;
        const tail = bars.slice(-20).filter((b) => n(b.close) && n(b.volume));
        if (tail.length >= 5) {
          avgValue = tail.reduce((s, b) => s + b.close * (b.volume as number), 0) / tail.length;
        }
      } catch (e: any) {
        err = e?.message ?? "price lookup failed";
      }
    }
    const returnPct = entry && latest && entry.close ? ((latest.close - entry.close) / entry.close) * 100 : null;
    const contributionPct = stance === "long" && n(weight) && n(returnPct) ? (weight / 100) * returnPct : null;
    lines.push({
      symbol,
      nameEn: String(p.nameEn ?? known?.nameEn ?? symbol),
      theme: String(p.theme ?? ""),
      market: market === "unknown" ? "unknown" : market,
      stance,
      weight,
      conviction: String(p.conviction ?? ""),
      entryDate: entry?.date ?? null,
      entryPrice: entry?.close ?? null,
      latestDate: latest?.date ?? null,
      latestPrice: latest?.close ?? null,
      returnPct,
      contributionPct,
      avgValueTraded20d: avgValue,
      liquidity: avgValue == null ? "unknown" : avgValue < 50_000_000 ? "thin" : "adequate",
      connect: "not_verified",
      note: err,
    });
  }

  const longs = lines.filter((l) => l.stance === "long");
  const longWeight = longs.reduce((s, l) => s + (l.weight ?? 0), 0);
  const priced = lines.filter((l) => n(l.contributionPct));
  const bookReturnPct = priced.length ? priced.reduce((s, l) => s + (l.contributionPct as number), 0) : null;
  if (Math.abs(longWeight - 100) > 5 && longs.length) gaps.push(`Long weights sum to ${longWeight.toFixed(1)}, not 100.`);
  if (priced.length < longs.length) gaps.push("Some names have no price since the note date, so the book return is partial.");

  const digest = [
    `PAPER BOOK (discussion book from note #${note.id}, ${start}; not a live order book):`,
    bookReturnPct == null
      ? "  - Mark-to-market unavailable."
      : `  - Weighted long contribution since recommendation: ${bookReturnPct.toFixed(2)} pp on ${longWeight.toFixed(0)} stated long weight.`,
    ...lines.slice(0, 12).map((l) => `  - ${l.nameEn} [${l.symbol}] ${l.stance} wt ${l.weight ?? "n/a"}: ${l.returnPct == null ? "price n/a" : l.returnPct.toFixed(1) + "%"} since ${l.entryDate ?? start}; liquidity ${l.liquidity}; Connect not verified.`),
    ...gaps.map((g) => `  - Gap: ${g}`),
  ].join("\n");

  return {
    asOf: new Date().toISOString().slice(0, 10),
    noteId: note.id,
    noteTitle: note.title,
    noteDate: start,
    lines,
    longWeight,
    bookReturnPct,
    pricedCount: priced.length,
    gaps,
    digest,
  };
}
