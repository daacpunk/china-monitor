/**
 * Automation scheduler (Phase 5).
 *
 * - AutomationConfig stored in `settings` under "automation.schedule".
 * - runScheduledReport(): refresh data -> propose/apply house view -> generate
 *   strategy note -> notify. Audited in `job_runs`.
 * - runDueJobs(): the shared core called by the in-process tick loop, the protected
 *   /api/jobs/tick endpoint, and "Run now". Idempotent via a runningAt lock +
 *   nextRunAt that only advances after a run.
 *
 * Decisions (SPEC_PHASE5_AUTOMATION.md §H): configurable cadence (default monthly,
 * 1st, 09:00 HKT = 01:00 UTC); Data-Driven auto-runs; house-view propose-only by
 * default (autoUpdateHouseView opt-in); in-app + optional email; lazy exports.
 */

import { storage } from "../storage";
import { generateStrategyNote } from "../report/strategyNote";
import { proposeHouseView } from "../report/houseView";
import { refreshReportSeries } from "./refresh";
import { notify } from "./notify";
import type { CoverageTheme } from "../equity/universe";

const SETTINGS_KEY = "automation.schedule";

export interface AutomationConfig {
  enabled: boolean;
  cadence: "monthly" | "quarterly";
  dayOfMonth: number;      // 1..28
  hourUtc: number;         // 0..23 (default 1 = 09:00 HKT)
  mode: "data_driven" | "thesis_driven";
  emphasis: CoverageTheme[];
  featuredNames: string[];
  model: string;
  refreshPolicyFirst: boolean;
  autoUpdateHouseView: boolean;
  notify: { inApp: boolean; email?: string };
  lastRunAt?: string;
  nextRunAt?: string;
  runningAt?: string;
}

const DEFAULT_CONFIG: AutomationConfig = {
  enabled: false,
  cadence: "monthly",
  dayOfMonth: 1,
  hourUtc: 1, // 09:00 HKT
  mode: "data_driven",
  emphasis: [],
  featuredNames: [],
  model: "claude-sonnet-4",
  refreshPolicyFirst: true,
  autoUpdateHouseView: false, // propose-only by default
  notify: { inApp: true },
};

export async function getConfig(): Promise<AutomationConfig> {
  try {
    const row = await storage.getSetting(SETTINGS_KEY);
    if (row?.valueJson) return { ...DEFAULT_CONFIG, ...(row.valueJson as any) };
  } catch { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

export async function saveConfig(patch: Partial<AutomationConfig>): Promise<AutomationConfig> {
  const current = await getConfig();
  const next: AutomationConfig = { ...current, ...patch };
  // Recompute nextRunAt whenever schedule-affecting fields change or on enable.
  next.nextRunAt = computeNextRun(next, new Date()).toISOString();
  await storage.setSetting({ key: SETTINGS_KEY, valueJson: next as any });
  return next;
}

/** Next fire time strictly after `from`, honoring cadence/day/hour (UTC). */
export function computeNextRun(cfg: AutomationConfig, from: Date): Date {
  const day = Math.min(Math.max(cfg.dayOfMonth, 1), 28);
  const quarterMonths = [0, 3, 6, 9]; // Jan/Apr/Jul/Oct
  const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day, cfg.hourUtc, 0, 0));

  const isValidMonth = (d: Date) => cfg.cadence === "monthly" || quarterMonths.includes(d.getUTCMonth());

  // advance month-by-month until we find a future, cadence-valid slot
  let d = candidate;
  for (let i = 0; i < 24; i++) {
    if (d > from && isValidMonth(d)) return d;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, day, cfg.hourUtc, 0, 0));
  }
  return d;
}

interface Step { step: string; ok: boolean; ms: number; detail?: string }

/**
 * Run the full report pipeline once. Used by scheduled + manual ("Run now").
 * Records a job_runs row throughout.
 */
export async function runScheduledReport(kind: "scheduled" | "manual"): Promise<{ jobId: number; noteId?: number; status: string }> {
  const cfg = await getConfig();
  const steps: Step[] = [];
  const job = await storage.insertJobRun({ kind, status: "running", steps: [], costUsd: 0, noteId: null, finishedAt: null, error: null });

  const t = (label: string, start: number, ok: boolean, detail?: string) => steps.push({ step: label, ok, ms: Date.now() - start, detail });
  let totalCost = 0;
  let noteId: number | undefined;

  try {
    // 1. Refresh data
    let s = Date.now();
    const refreshed = await refreshReportSeries({ emphasis: cfg.emphasis, featuredNames: cfg.featuredNames, refreshPolicy: cfg.refreshPolicyFirst });
    totalCost += refreshed.costUsd;
    t("refresh", s, true, `${refreshed.seriesRefreshed} series${cfg.refreshPolicyFirst ? ` + policy scan (${refreshed.policyInserted} new)` : ""}`);

    // 2. House view (propose; apply only if opted in)
    s = Date.now();
    try {
      const proposal = await proposeHouseView(cfg.model as any);
      if (cfg.autoUpdateHouseView) {
        const existing = await storage.getHouseView();
        const changeLog: any[] = existing ? ((existing.changeLog as any[]) ?? []) : [];
        changeLog.unshift({ date: new Date().toISOString().slice(0, 10), change: proposal.changeSummary, trigger: `auto-update (${kind})` });
        await storage.upsertHouseView({
          headline: proposal.headline, stance: proposal.stance, conviction: proposal.conviction,
          horizon: proposal.horizon, pillars: proposal.pillars, keyRisks: proposal.keyRisks,
          sectorStance: proposal.sectorStance, changeLog,
        });
        t("house_view", s, true, "auto-applied");
      } else {
        // Propose-only: stash the proposal as a notification for review.
        await notify({ title: "House-view update proposed", body: proposal.headline, kind: "info", link: "/#/report" });
        t("house_view", s, true, "proposed (review)");
      }
    } catch (err: any) {
      t("house_view", s, false, err.message);
    }

    // 3. Generate the strategy note (Data-Driven for auto-runs by default)
    s = Date.now();
    const gen = await generateStrategyNote({
      mode: cfg.mode,
      userThesis: undefined,
      featuredNames: cfg.featuredNames,
      mustInclude: [],
      emphasis: cfg.emphasis,
      model: cfg.model as any,
    });
    totalCost += gen.costUsd;
    const hv = await storage.getHouseView();
    const saved = await storage.insertStrategyNote({
      title: gen.title, asOfDate: gen.asOfDate, mode: cfg.mode, userThesis: "",
      featuredNames: cfg.featuredNames, mustInclude: [], emphasis: cfg.emphasis,
      sections: gen.sections, portfolio: gen.portfolio ?? null, thesisVerdict: gen.thesisVerdict ?? null,
      houseViewSnapshot: hv ?? null, citations: gen.citations, model: gen.model,
      costUsd: gen.costUsd, tokensIn: gen.tokensIn, tokensOut: gen.tokensOut, status: "draft",
    });
    noteId = saved.id;
    t("generate", s, true, `note #${saved.id}, ${gen.sections.length} sections`);

    // 4. Notify (lazy exports — user downloads on demand from the vault)
    s = Date.now();
    const summary = (gen.sections[0]?.body ?? "").replace(/[#*]/g, "").split(/\n/).find((l) => l.trim())?.slice(0, 180) ?? "";
    await notify({
      title: `${cfg.cadence === "monthly" ? "Monthly" : "Quarterly"} strategy note ready`,
      body: `${gen.title}\n\n${summary}`,
      link: `/#/report`,
      kind: "report_ready",
      email: cfg.notify.email,
    });
    t("notify", s, true);

    await storage.updateJobRun(job.id, { status: "success", finishedAt: new Date(), noteId, costUsd: totalCost, steps });
    return { jobId: job.id, noteId, status: "success" };
  } catch (err: any) {
    steps.push({ step: "error", ok: false, ms: 0, detail: err.message });
    await storage.updateJobRun(job.id, { status: "failed", finishedAt: new Date(), error: err.message, costUsd: totalCost, steps });
    await notify({ title: "Scheduled report failed", body: err.message, kind: "job_failed" });
    return { jobId: job.id, noteId, status: "failed" };
  }
}

/**
 * Shared scheduler core: run a scheduled report if one is due. Idempotent.
 * Called by the tick loop, /api/jobs/tick, and indirectly by saveConfig (no).
 */
export async function runDueJobs(now = new Date()): Promise<{ ran: boolean; reason?: string }> {
  const cfg = await getConfig();
  if (!cfg.enabled) return { ran: false, reason: "disabled" };

  // Initialize nextRunAt if missing.
  if (!cfg.nextRunAt) {
    await saveConfig({}); // recomputes nextRunAt
    return { ran: false, reason: "initialized nextRunAt" };
  }
  const due = new Date(cfg.nextRunAt) <= now;
  if (!due) return { ran: false, reason: "not due" };

  // Lock: skip if a run started in the last 30 min (stale-lock guard).
  if (cfg.runningAt && now.getTime() - new Date(cfg.runningAt).getTime() < 30 * 60 * 1000) {
    return { ran: false, reason: "locked (run in progress)" };
  }

  // Acquire lock and advance nextRunAt BEFORE running so a crash doesn't re-loop.
  const fresh = await getConfig();
  await storage.setSetting({
    key: SETTINGS_KEY,
    valueJson: { ...fresh, runningAt: now.toISOString(), nextRunAt: computeNextRun(fresh, now).toISOString() } as any,
  });

  try {
    await runScheduledReport("scheduled");
  } finally {
    const after = await getConfig();
    await storage.setSetting({ key: SETTINGS_KEY, valueJson: { ...after, runningAt: undefined, lastRunAt: now.toISOString() } as any });
  }
  return { ran: true };
}

/** In-process tick loop, started at server boot. Cheap; re-reads state each tick. */
let timer: NodeJS.Timeout | null = null;
export function startScheduler(): void {
  if (timer) return;
  const TICK_MS = 15 * 60 * 1000; // 15 min
  const tick = async () => {
    try { await runDueJobs(); } catch (err) { console.error("[scheduler] tick error", err); }
  };
  // first tick shortly after boot, then every 15 min
  setTimeout(tick, 30_000);
  timer = setInterval(tick, TICK_MS);
  console.log("[scheduler] started (15-min tick)");
}
