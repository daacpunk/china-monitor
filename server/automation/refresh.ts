/**
 * Pre-report data refresh (Phase 5).
 *
 * Force-refreshes exactly the series a strategy note depends on (macro drivers,
 * cross-asset, equities) so an auto-generated note builds on current data, not
 * 24h-old cache. Optionally runs a Policy Tracker scan first so the policy section
 * is current. Bounded + ceiling-checked (force only bypasses the cache READ; the
 * source fetch still respects the cost ceiling).
 */

import { fetchSeries } from "../series/fetchSeries";
import { DEFAULT_BRIEF_DRIVERS, DEFAULT_CROSS_ASSET, DEFAULT_BRIEF_EQUITIES } from "../analysis/brief";
import { scanChannels } from "../policy/service";
import { TECH_CHANNEL_IDS, POLICY_CHANNELS } from "../policy/channels";
import { getAkshareValuation } from "../clients/akshare";
import { SECTOR_UNIVERSE, type CoverageTheme } from "../equity/universe";

export interface RefreshResult {
  seriesRefreshed: number;
  policyInserted: number;
  costUsd: number;
  errors: string[];
}

export async function refreshReportSeries(opts: {
  emphasis?: CoverageTheme[];
  featuredNames?: string[];
  refreshPolicy?: boolean;
}): Promise<RefreshResult> {
  const errors: string[] = [];
  let seriesRefreshed = 0;
  let policyInserted = 0;
  let costUsd = 0;

  // 1. Force-refresh the core report series (dedup).
  const ids = Array.from(new Set([...DEFAULT_BRIEF_DRIVERS, ...DEFAULT_CROSS_ASSET, ...DEFAULT_BRIEF_EQUITIES]));
  await Promise.all(
    ids.map(async (id) => {
      try {
        await fetchSeries(id, { force: true });
        seriesRefreshed++;
      } catch (err: any) {
        errors.push(`${id}: ${err.message}`);
      }
    }),
  );

  // 2. Featured-name valuations (A-share), best-effort.
  const featured = new Set(opts.featuredNames ?? []);
  const featuredAshare = SECTOR_UNIVERSE.flatMap((t) => t.names).filter((n) => featured.has(n.symbol) && n.market === "ashare");
  await Promise.all(
    featuredAshare.slice(0, 8).map(async (n) => {
      try { await getAkshareValuation(n.symbol); } catch { /* best-effort */ }
    }),
  );

  // 3. Optional policy scan (emphasized themes -> tech channels, else macro tiers).
  if (opts.refreshPolicy) {
    try {
      const emphasized = opts.emphasis ?? [];
      // If sector themes are emphasized, scan the tech-skewed channels; otherwise
      // scan the apex macro/financial tiers (1-4).
      const channelIds = emphasized.length > 0
        ? TECH_CHANNEL_IDS
        : POLICY_CHANNELS.filter((c) => c.tier <= 4).map((c) => c.id);
      const reports = await scanChannels(channelIds, 30, "claude-haiku-4");
      policyInserted = reports.reduce((s, r) => s + (r.inserted || 0), 0);
    } catch (err: any) {
      errors.push(`policy: ${err.message}`);
    }
  }

  return { seriesRefreshed, policyInserted, costUsd, errors };
}
