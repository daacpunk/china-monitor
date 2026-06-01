/**
 * Stooq CSV downloader.
 * Free, no auth. Cache 6h (markets refresh intraday).
 *
 * URL: https://stooq.com/q/d/l/?s=<symbol>&i=d
 * CSV format: Date,Open,High,Low,Close,Volume
 */

import { storage } from "../storage";

const BASE = "https://stooq.com/q/d/l/";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

export interface StooqClosePoint {
  date: string; // YYYY-MM-DD
  close: number;
}

export async function getDailyClose(
  symbol: string,
  opts?: { rangeDays?: number },
): Promise<StooqClosePoint[]> {
  const rangeDays = opts?.rangeDays ?? 730; // ~2 years default
  const cacheKey = `stooq:daily:${symbol}:${rangeDays}`;

  // Cache check
  const cached = await storage.getCache(cacheKey);
  if (cached) return cached.payloadJson as StooqClosePoint[];

  const url = `${BASE}?s=${encodeURIComponent(symbol)}&i=d`;
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: "https://stooq.com/",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`Stooq HTTP ${res.status}`);
    }

    const text = await res.text();

    // Parse CSV
    const lines = text.trim().split("\n");
    if (lines.length < 2) {
      throw new Error(`Stooq returned empty CSV for ${symbol}`);
    }

    // Skip header line
    const cutoff = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

    const points: StooqClosePoint[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 5) continue;
      const date = parts[0].trim();
      const close = parseFloat(parts[4].trim());
      if (!date || isNaN(close)) continue;

      const d = new Date(date);
      if (d < cutoff) continue;

      points.push({ date, close });
    }

    // Sort ascending
    points.sort((a, b) => a.date.localeCompare(b.date));

    await storage.setCache(cacheKey, points, new Date(Date.now() + TTL_MS), "stooq");

    console.log(`[Stooq] ${symbol}: fetched ${points.length} points in ${Date.now() - start}ms`);
    return points;
  } catch (err: any) {
    console.error(`[Stooq] Failed to fetch ${symbol}:`, err.message);
    return [];
  }
}
