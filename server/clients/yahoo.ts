/**
 * Yahoo Finance v8 chart API.
 * Free, no auth. Browser UA required.
 * Cache 6h (markets refresh intraday).
 *
 * URL: https://query1.finance.yahoo.com/v8/finance/chart/<ticker>?interval=1d&range=2y
 */

import { storage } from "../storage";

const TTL_MS = 6 * 60 * 60 * 1000; // 6h

const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface YahooChartPoint {
  date: string; // YYYY-MM-DD
  close: number;
  volume: number;
}

export async function getChart(
  ticker: string,
  opts?: { interval?: "1d" | "1wk" | "1mo"; range?: string },
): Promise<YahooChartPoint[]> {
  const interval = opts?.interval ?? "1d";
  const range = opts?.range ?? "2y";
  const cacheKey = `yahoo:chart:${ticker}:${interval}:${range}`;

  // Cache check
  const cached = await storage.getCache(cacheKey);
  if (cached) return cached.payloadJson as YahooChartPoint[];

  // Try both Yahoo Finance endpoints (query1 and query2 for fallback)
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`,
  ];

  const start = Date.now();

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "User-Agent": YAHOO_UA,
            Accept: "application/json",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        console.warn(`[Yahoo] ${ticker} ${res.status} from ${url}`);
        continue;
      }

      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) {
        console.warn(`[Yahoo] ${ticker}: no chart result in response`);
        continue;
      }

      const timestamps: number[] = result.timestamp ?? [];
      const quotes = result.indicators?.quote?.[0] ?? {};
      const closes: (number | null)[] = quotes.close ?? [];
      const volumes: (number | null)[] = quotes.volume ?? [];

      const points: YahooChartPoint[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (close == null || isNaN(close)) continue;

        const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
        points.push({
          date,
          close,
          volume: volumes[i] ?? 0,
        });
      }

      // Sort ascending
      points.sort((a, b) => a.date.localeCompare(b.date));

      await storage.setCache(cacheKey, points, new Date(Date.now() + TTL_MS), "yahoo");

      console.log(`[Yahoo] ${ticker}: fetched ${points.length} points in ${Date.now() - start}ms`);
      return points;
    } catch (err: any) {
      console.warn(`[Yahoo] ${ticker} error from ${url}:`, err.message);
    }
  }

  console.error(`[Yahoo] All endpoints failed for ${ticker}`);
  return [];
}
