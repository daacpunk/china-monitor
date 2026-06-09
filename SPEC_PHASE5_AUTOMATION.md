# China Monitor — Phase 5 Spec: Automation & Cadence

Status: DRAFT FOR REVIEW (no code written yet)
Turns the on-demand tool into a recurring institutional product: on a monthly /
quarterly cadence, refresh the data, regenerate the house view + strategy note (and
deck), and notify the analyst — so a fresh, dated paper is waiting without a click.

---

## 0. What exists to build on
- `series_cache` table with `expires_at` + `clearExpiredCache()` (24h TTL today).
- Generic `settings` key/value store (`getSetting`/`setSetting`) — ideal for schedule
  config + last-run state.
- `fetchSeries(logicalId, opts)` — 24h-cached; **no force-refresh option yet** (add one).
- Phase 3 report engine (`generateStrategyNote`) + Phase 4 export (PDF/DOCX/PPTX).
- Server boots via an async IIFE in `server/index.ts` (where a scheduler hooks in).
- NO scheduler, NO notifications today — both are net-new.

---

## A. SCHEDULING — how it actually fires (the key design choice)

Railway runs a single long-lived Node process, so an in-process timer works, BUT it
must survive restarts/redeploys and not double-fire. Design:

**Tick loop + persisted state (RECOMMENDED).**
- A lightweight in-process interval (e.g. every 15 min) calls `runDueJobs()`.
- `runDueJobs()` reads the schedule + `lastRunAt` / `nextRunAt` from `settings`
  (persisted in Postgres), computes whether a job is due, and if so runs it and
  advances `nextRunAt`. Idempotent: a restart re-reads state and never double-runs
  because `nextRunAt` only advances after a successful run (guarded by a runningAt lock).
- Survives redeploys (state is in the DB, not memory). No external cron service needed.
- Manual "Run now" button triggers the same path immediately.

(Alternative considered: external Railway cron / GitHub Action hitting a protected
`/api/jobs/tick` endpoint. More robust to process sleeps but adds infra. The tick-loop
is simpler and Railway keeps the web process alive; we can add the external trigger
later if needed — the `runDueJobs()` core is reused either way.)

### Schedule config (stored in `settings` under key `automation.schedule`)
```ts
interface AutomationConfig {
  enabled: boolean;
  cadence: "monthly" | "quarterly";
  dayOfMonth: number;        // e.g. 1 (1st) — for quarterly, 1st of Jan/Apr/Jul/Oct
  hourUtc: number;           // e.g. 1 (09:00 HKT = 01:00 UTC)
  mode: "data_driven" | "thesis_driven";  // default data_driven for auto-runs
  emphasis: CoverageTheme[]; // themes to weight
  featuredNames: string[];   // universe tickers to always feature
  model: string;             // synthesis model (mid-tier default)
  refreshPolicyFirst: boolean; // run a Policy Tracker scan before generating
  autoUpdateHouseView: boolean; // propose+apply, or just propose for review
  notify: { inApp: boolean; email?: string };
  lastRunAt?: string;
  nextRunAt?: string;
  runningAt?: string;        // lock; cleared on completion/failure
}
```

---

## B. PRE-REPORT REFRESH (freshness guarantee)

Auto-runs (and a manual "Refresh data" action) must build on current data, not 24h-old
cache. Add a force-refresh path:

1. `fetchSeries(id, { force: true })` — bypasses the cache read, refetches from the
   source cascade, rewrites `series_cache`. (Add the `force` option; default false so
   normal browsing stays cached/cheap.)
2. `refreshReportSeries()` — force-refreshes the specific series the report depends on
   (macro drivers, cross-asset, equities, sector proxies, featured-name valuations).
   Aligns to release-calendar dates where possible (CEIC macro is monthly/quarterly, so
   daily polling adds nothing — refresh when the cadence fires).
3. If `refreshPolicyFirst`, run a Policy Tracker scan (Sonar) for the emphasized themes
   so the policy section is current.

Cost note: a refresh pass is bounded (a defined set of series + one policy scan), all
ceiling-checked + audit-logged. Surfaced on the `/costs` page.

---

## C. THE AUTO-RUN PIPELINE (`runScheduledReport()`)

On a due job:
1. **Refresh** — `refreshReportSeries()` (+ optional policy scan). (Section B)
2. **House view** — `proposeHouseView()`. If `autoUpdateHouseView`, apply it with a
   change-log entry ("auto-update <date>"); else save the proposal for review.
3. **Generate** — `generateStrategyNote()` with the configured mode/emphasis/names/model;
   persist as a `strategy_note` (status `draft`, tagged `auto: true`).
4. **Export** (optional, configurable) — pre-render PDF + PPTX so they're ready to
   download instantly. (Or render lazily on first download to save CPU — see Open Q.)
5. **Notify** — send the configured notification with a deep link to the note.
6. **Advance** — set `lastRunAt = now`, compute `nextRunAt`, clear `runningAt`.

Failures: caught, logged to a `job_runs` audit table, `runningAt` cleared, a failure
notification sent; `nextRunAt` still advances so one bad run doesn't wedge the schedule.

---

## D. NOTIFICATIONS

Phase 5 introduces the first outbound notifications. Two channels:
- **In-app** (always available): a `notifications` table + a bell/badge in the header;
  "Your <month> strategy note is ready" with a link to `/report?id=…`.
- **Email** (optional): SMTP via `nodemailer` using env config
  (`SMTP_URL` / `SMTP_FROM`), or a transactional API if preferred. Off unless an
  address is configured. (See Open Questions — email infra is the one new external dep.)

Notification payload: cadence label, as-of date, mode, headline house-view line, and a
one-line summary (exec-summary first sentence), plus the deep link.

---

## E. DATA MODEL (new)
```ts
// settings key "automation.schedule" -> AutomationConfig (Section A)

// job_runs (audit of every scheduled/manual run)
interface JobRun {
  id: number; startedAt: string; finishedAt?: string;
  kind: "scheduled" | "manual";
  status: "running" | "success" | "failed";
  noteId?: number; error?: string; costUsd: number;
  steps: { step: string; ok: boolean; ms: number; detail?: string }[];
}

// notifications
interface Notification {
  id: number; createdAt: string; title: string; body: string;
  link?: string; read: boolean; kind: "report_ready" | "job_failed" | "info";
}
```

---

## F. ROUTES & UI
Routes:
```
GET  /api/automation            -> config + lastRun/nextRun + recent job_runs
PUT  /api/automation            -> save AutomationConfig
POST /api/automation/run-now    -> trigger runScheduledReport() immediately (manual)
POST /api/automation/refresh    -> force data refresh only (no report)
GET  /api/notifications         -> list (unread first)
POST /api/notifications/:id/read
GET  /api/jobs                  -> recent job_runs (status + steps + cost)
```
UI:
- **Automation page** (`/automation`, under a SYSTEM or REPORT group): enable toggle,
  cadence + day/time, mode/emphasis/featured-names (reuse the composer controls),
  notify settings, "Run now" + "Refresh data now", and a run-history table (status,
  cost, link to the note).
- **Header notification bell**: unread badge + dropdown of recent notifications.
- Report page: an "Auto" badge on notes generated by the scheduler.

---

## G. BUILD ORDER
1. `force` option on fetchSeries + `refreshReportSeries()` (Section B).
2. Scheduler core: `settings`-backed config, `runDueJobs()` tick loop in server boot,
   `job_runs` table + lock. Manual "run now" path first (easiest to verify).
3. `runScheduledReport()` pipeline (refresh -> house view -> generate -> export -> notify).
4. Notifications: table + in-app bell + (optional) email.
5. `/automation` page + routes; header bell.
6. Build, verify (manual run end-to-end), commit/push, verify live.
7. Docs.

---

## H. DECISIONS (RESOLVED 2026-06-10)
1. **Cadence: CONFIGURABLE, default monthly** (1st of month, 09:00 HKT = 01:00 UTC).
   Quarterly selectable in the UI.
2. **Auto-run mode: DATA-DRIVEN** for scheduled runs (AI builds strategy + portfolio);
   Thesis-Driven stays manual (needs a human thesis).
3. **House view on auto-run: per-config toggle `autoUpdateHouseView`, default
   PROPOSE-ONLY** (saved for the user's approval). Auto-apply (with change-log entry)
   is the opt-in. (User selected both; resolved to a toggle so both are supported.)
4. **Notifications: IN-APP + EMAIL**, email wired to SMTP env vars (`SMTP_URL`/
   `SMTP_FROM`) to be configured later — email stays off until set; in-app always on.
5. **Exports: LAZY** — render PDF/PPTX on first download, not pre-built per run.
6. **Mechanism: BOTH (complementary)** — build the DB-backed `runDueJobs()` core with
   an in-process tick loop, AND expose a protected `POST /api/jobs/tick` endpoint so an
   external Railway-cron/GitHub-Action can also drive it later for robustness. The
   `runDueJobs()` core is shared by the timer, the external trigger, and "Run now".

Build order unchanged (Section G).
