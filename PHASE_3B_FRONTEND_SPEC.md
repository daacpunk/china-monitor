# Phase 3b — Frontend Spec

Three new pages: `/trends`, `/attribution`, `/scenarios`.
Built on the existing China Monitor frontend stack (React 18 + Vite + TS + Tailwind + shadcn/ui + Chart.js + Wouter hash-routing + `useSeries`/`useAnalysis` hooks). Aesthetic consistency with `Outlook`, `KShape`, `EquityDeepDive`.

## Shared conventions (apply to all 3 pages)

- **Routing.** Add to `client/src/App.tsx` after `/outlook`:
  ```tsx
  <Route path="/trends"       component={Trends} />
  <Route path="/attribution"  component={Attribution} />
  <Route path="/scenarios"    component={Scenarios} />
  ```
- **Sidebar.** Add to `Layout.tsx` SECTIONS after `/outlook`, before `/settings`:
  ```ts
  { slug: "/trends",      label: "Trends",      icon: TrendingUp, group: "Analysis" },
  { slug: "/attribution", label: "Attribution", icon: GitCompare, group: "Analysis" },
  { slug: "/scenarios",   label: "Scenarios",   icon: Telescope,  group: "Analysis" },
  ```
  Split the existing single group into `"Dashboard"` + `"Analysis"`. The Layout already iterates groups via the `group` field; only the group-header rendering needs a tiny tweak (one-time, then reused for any future Analysis pages).
- **Page header.** Use `<PageHeader title=… subtitle=… meta={<ProvenanceChipLive …/>} />` everywhere — matches Outlook/KShape.
- **Data fetching.** Use `useQuery` + `apiRequest` from `@/lib/queryClient`. Never raw `fetch`. Hierarchical keys, e.g. `['/api/trends/detect', seriesIds.join(',')]`.
- **Empty / loading / error states.** Use `<Skeleton>` for chart areas, an empty-state card with copy + retry button on error. Match `Outlook`.
- **Colors.** Use existing `CHART_COLORS` palette only. Green = accelerating/positive surprise; red = breaking/negative; amber = transitional; muted = neutral / stable.
- **`data-testid`.** Every interactive element gets `data-testid`. Pattern: `{action}-{target}` or `{type}-{content}`.

---

# 1. `/trends` — Trends page

**Purpose.** For any selected macro/equity series, show whether the trend is *accelerating, decelerating, stable, reversing, breaking, or emerging* — across 3m/6m/12m windows simultaneously, plus regime-shift markers and a turning-point annotation. Wraps the `POST /api/trends/detect` endpoint.

## Layout (top → bottom)

### A. Header strip
- Title: **"Trend Detection — multi-timescale slope analysis"**
- Subtitle: "Detects regime shifts and classifies persistence across 3m, 6m, and 12m windows."
- Meta: a single `ProvenanceChipLive` derived from the first selected series.

### B. Series picker (sticky filter card)
- Multi-select chip group, 2 rows max, scrolls horizontally if overflow.
- Default selection (on first load): the 7 drivers used in attribution + 3 equity indices →
  `["ppi_yoy", "cpi_yoy", "m2_yoy", "iva_yoy", "exports_yoy", "usdcny_monthly", "oecd_cli_china", "csi300_monthly", "hangseng_monthly", "chinext_monthly"]`.
- Group chips by category: **Macro Drivers** | **Equities** | **Property** | **Energy** etc. (categories pulled from `REGISTRY[id].category`).
- A "Select All in group" link per category.
- Hidden state: an "Add custom series…" command-palette popover (shadcn `Command`) — searches the full `REGISTRY` keys by label, lets user paste in any logicalId.
- A small **"Run detection"** button — triggers the query (debounced 400ms after selection change). Shows a 12px `Loader2` spinner while in flight.

### C. Summary strip (`StatCard` row, 4 cards)
- **Total series analysed** (number)
- **# Breaking** (red) — count of series with `classification === "broken"` on 12m slope
- **# Accelerating** (emerald)
- **# Reversing** (amber)
- Each card clickable: filters the table below to only that classification.

### D. Trend table (primary view, default mode)
A dense `<Table>` of one row per selected series. Columns:

| Column | Width | Content |
|---|---|---|
| Series | 28% | Label + tiny `category` badge under it |
| Classification | 14% | Color-coded badge: `accelerating` (emerald), `decelerating` (amber), `stable` (muted), `reversing` (orange), `broken` (red), `emerging` (teal) |
| 3m slope/yr | 12% | `+/-N.NN%/yr`, with up/down arrow icon |
| 6m slope/yr | 12% | same |
| 12m slope/yr | 12% | same; bold + larger |
| 12m r² | 8% | 2-decimal `0.NN` — color: ≥0.7 emerald, ≥0.4 muted, <0.4 red |
| Regime z | 8% | `±N.NN`; if `|z| ≥ 2` show a small ⚡ icon |
| Trend start | 12% | `YYYY-MM` (date when the current trend began per `trendStart`); empty if none |
| Sparkline | 6% | 60-day inline sparkline (use SparklineCard's underlying chart, or a tiny Chart.js line, no axes) |

- Row hover: expands a thin gray border + cursor-pointer.
- Row click: opens detail view (E) for that series — replaces the table with a per-series breakdown; a "← Back to table" link at top.
- Sort: clickable column headers (default sort: 12m slope/yr descending).

### E. Per-series detail (expanded when a row is clicked)
Two-column layout, ~60/40 split.

**Left column — large chart card:**
- Chart.js line of the full historical series (use existing `useSeries(id)` for raw data — don't re-call `/api/series/...` if already in `queryClient`).
- Overlay annotations (use `chartjs-plugin-annotation`, already in deps if Outlook uses it; otherwise add):
  - Vertical dashed line at `trendStart` labelled "Trend start".
  - Horizontal band shading the 12m regression line (start to end) — semi-transparent, color matches classification.
  - Markers at any `regimeShifts[]` points returned by `/api/trends/detect`: small ⚡ icon + tooltip showing pre/post mean.
- Toggle buttons in the chart toolbar: **3m / 6m / 12m** — overlays each window's regression line.

**Right column — interpretation panel:**
- **Classification card** — large badge + one-line plain-English description from a local lookup map. Examples:
  - `accelerating` → "Trend strengthening — slope rising over 12m and r² ≥ 0.4."
  - `broken` → "Regime shift detected — recent 3m slope opposite sign vs. 12m slope; |z| ≥ 2."
  - `reversing` → "Trend slowing or flipping — 3m slope sign differs from 12m sign."
- **Multi-window slopes table** — 3 rows × 4 columns: window | slope/yr | r² | pct change.
- **Cross-source confirmation** (if returned by API) — "Confirmed by [nbs, fred]" or "Single source only" muted text.
- **Turning point** — date + reason ("Inflection at 2025-06-01: slope changed from +1.2 to -0.4 over a 3m window").
- **AI commentary** — `<AICommentaryPanel>` using `kind="trend"` with `seriesId` + classification as context. Sonnet/Haiku toggle inside.

### F. Cross-series regime alert banner (always visible at top)
- If ≥ 3 series are classified `broken` simultaneously: red banner — "⚡ Regime shift: N drivers broken simultaneously since YYYY-MM. Suggests synchronized turning point."
- If ≥ 3 series are `accelerating`: emerald banner — "Trend pickup: N drivers accelerating."

## API integration
- Single endpoint call: `POST /api/trends/detect` with `{ seriesIds: string[] }`.
- Response cached 60s in queryClient (this is cheap, no LLM).
- The AICommentaryPanel calls `POST /api/commentary` with `{ kind:'trend', seriesId, classification, slopes }` — needs to be added or reused from existing AICommentaryPanel API surface. Note: AICommentaryPanel already exists for KShape — check its props before reuse.

## Data flow
```
[ChipPicker] → seriesIds[]
  → useQuery(['trends/detect', sortedIds.join(',')], () => apiRequest({method:'POST', url:'/api/trends/detect', body:{seriesIds}}))
    → renders Summary cards + Table
[row click] → setSelectedId(id)
  → useSeries(id) (full history)
  + finds entry from trends/detect response
  → renders Detail view (left chart + right panel + AI commentary)
```

## Open questions
- Should chart annotation markers be clickable (e.g. open a tooltip with full regime stats)? Default: yes, on hover only — no click handler needed.
- Should the table be exportable to CSV? Suggestion: a top-right "Export" icon button — quick win, low cost.

---

# 2. `/attribution` — Attribution page

**Purpose.** Visualise macro → equity sensitivities. For each (driver, equity) pair: rolling 6/12/24-month β + ρ, lead/lag, and "not yet priced" flags. Wraps `POST /api/attribution/macro-to-equity`.

## Layout (top → bottom)

### A. Header strip
- Title: **"Macro → Equity Attribution"**
- Subtitle: "Rolling betas, correlations, and lead/lag scan across 14 curated pairs."
- Meta: `ProvenanceChipLive` showing last `computedAt` from API response.

### B. Universe filter (small toolbar)
- Two segmented controls in one row:
  - **Window:** `6m | 12m | 24m | full` (default 12m). Controls which window the heatmap reads from.
  - **Metric:** `β (beta) | ρ (correlation) | t-stat` (default β).
- Plus a dropdown: **Equity universe:** `All | A-share | HK` (default All). Filters the heatmap columns.
- "Refresh" button → invalidates query.

### C. Beta heatmap (primary viz, ~50% of viewport)
- Rows = drivers (`ppi_yoy`, `cpi_yoy`, …) — 8 rows.
- Columns = equities (`csi300_monthly`, `chinext_monthly`, `hangseng_monthly`) — 3 cols by default.
- Cells:
  - Background color: diverging palette (red ↔ white ↔ emerald) keyed to the metric:
    - β: clip to [−5, +5], 0 = white.
    - ρ: domain [−1, +1].
    - t-stat: domain [−4, +4].
  - Text: 2-dp number (white text on saturated cells, dark on muted).
  - Border: 2px **dashed red** if `expectedSign` ≠ realized sign (sign break).
  - A small ⚡ icon top-right if `notPriced === true` for that pair.
  - Greyed out if pair was skipped (`<6 aligned observations`).
- Built with CSS Grid + Tailwind (no D3 needed). Each cell is a `<button>` with `data-testid={`cell-${driver}-${equity}`}` so it can be tested + clicked.
- Click cell → opens detail view (E) for that pair.
- Hover cell → tooltip with: pair name, all-window values, lead/lag, expected vs realized sign, last computed date.

### D. Sign-break + "not-yet-priced" alert strip
Renders as a card row below the heatmap, max 4 alerts:
- **Sign breaks.** Cards red border. "PPI YoY → CSI 300: expected −, realized +0.21 (12m). Possible regime change."
- **Not yet priced.** Cards amber border. "Macro driver moved {N}σ in last 3 months; equity has not adjusted commensurately per historical β. Flag: 12m β=+2.5, last 3m equity return below predicted by 8%."
- Each card has a "View pair →" button → opens detail.

### E. Pair detail view (modal or replaces heatmap)
Replaces the heatmap+alerts when a pair is selected; sticky "← Back" button up top.

**Header (within detail):** `PPI YoY → ChiNext  ·  expected sign: negative  ·  thesis: "Rising input prices typically compress growth-stock multiples."`

**Tabs:**

1. **Co-movement** (default)
   - Two-line Chart.js: standardized driver (z-scored) vs standardized equity (z-scored).
   - Overlay shaded windows for the 6/12/24m rolling regression spans.
   - Below chart: 3 small cards — β, ρ, α for each window.

2. **Rolling β + ρ**
   - Two stacked line charts:
     - Top: rolling β (6m), with horizontal reference line at full-sample β.
     - Bottom: rolling ρ (6m).
   - Highlight in red any periods where rolling ρ crosses zero (sign break).

3. **Lead / lag scan**
   - Bar chart: x-axis = lag in months [−12, +12]; y-axis = correlation at that lag.
   - Bar at `bestLag` is highlighted (different color + label).
   - Caption: "Best lag = {N} months. {Negative=driver leads equity, Positive=equity leads driver}."

4. **Not-yet-priced detector**
   - Show the last 3 months of driver Z-scores vs predicted-by-β equity move vs realized equity move.
   - If `notPriced === true`: amber "Action required" callout with reason + magnitude.

**Right rail of detail (sticky):**
- `<AICommentaryPanel>` with `kind="attribution"` and pair context — interprets whether the relationship is healthy, broken, or transitioning. Sonnet/Haiku toggle.

### F. Drill-down beneath heatmap (always visible)
A small "All pairs (table view)" expandable section — a flat sortable `<Table>` of every pair, useful for power users. Same columns as cells but text-only. Hidden by default behind a "Show table" toggle.

## API integration
- Single endpoint: `POST /api/attribution/macro-to-equity` (no body needed — universe is server-side).
- Cached 5 min in queryClient (data is monthly; no need to refetch on every nav).

## Visual rules
- Heatmap cell min size: 80px × 56px on desktop; 60px × 44px on mobile (4 columns scroll horizontally).
- All numbers shown with consistent decimal precision per metric (β: 2dp, ρ: 2dp, t: 2dp).
- Never show "0.00" for missing data — show "—" instead.

## Open questions
- Do you want pair-thesis to be editable (override the curated `thesis` string)? Default: read-only for now.
- Should we add export (CSV) of all pairs? Suggestion: yes — small icon button.

---

# 3. `/scenarios` — Scenarios page

**Purpose.** Display the latest base/bull/bear 1Q forward scenarios; allow user to edit probabilities, regenerate, toggle model (Sonnet/Haiku), and review hit-rate history. Wraps `POST /api/scenarios/generate`, `GET /api/scenarios`, `GET /api/scenarios/latest`, `PATCH /api/scenarios/:id`, `GET /api/scenarios/:id/hit-rate`.

## Layout (top → bottom)

### A. Header strip
- Title: **"Scenarios — 1Q-forward base / bull / bear"**
- Subtitle: "LLM-synthesized macro→equity scenarios with editable probabilities and hit-rate tracking."
- Meta:
  - `ProvenanceChipLive` (sourced from the underlying drivers `lastUpdated`).
  - Right-aligned: model toggle (segmented `Sonnet (default) | Haiku`) + target quarter selector.

### B. Quarter / model controls
- **Target quarter selector** — small `Select` dropdown:
  - Default = next calendar quarter from today (e.g. as of 2026-06: default `2026-Q3`).
  - Options: previous 4 quarters + next 2.
- **Model toggle** — segmented control (`Sonnet 4.6 (default)` | `Haiku 4.5`), passed as `model` param to `/scenarios/generate`. Helper text below: "Sonnet ≈ $0.04/run · Haiku ≈ $0.01/run". Costs sourced from existing `MODEL_META` in `server/analysis/llm.ts`.
- **Regenerate** button (primary) — calls `POST /api/scenarios/generate` with current quarter+model. Disabled while pending. Confirm dialog if a scenario for that quarter already exists.

### C. Three big scenario cards (base / bull / bear) — primary view

Three equal-width cards in a 3-column grid (stacks on mobile).

**Each card:**
- Top: large badge (color-coded — base=primary blue, bull=emerald, bear=red).
- Probability — editable numeric input, 0–100% in 5% steps. Sliders synced so total = 100% (auto-balance the other two).
- One-line summary headline (LLM-generated, e.g. "Modest reflation; CSI 300 +2-4% on stable PPI base").
- Drivers grid (collapsible) — for each driver (PPI, CPI, M2, IVA, Exports, USDCNY, OECD CLI):
  - Direction arrow (↑ / ↓ / →)
  - Magnitude (e.g. "+0.5pp YoY")
  - One-line driver reasoning
- Equity implications table — for each equity (CSI 300, ChiNext, HSI):
  - Expected % return range (e.g. `+2% to +5%`)
  - Confidence (high / medium / low) — small badge
  - One-line rationale
- Footer:
  - "Edited" badge if `userEdited === true`
  - "Generated {timeago} · ${cost.toFixed(4)} · {tokensIn}/{tokensOut} tokens"
  - "Save edits" button — only enabled if probabilities changed; calls `PATCH /api/scenarios/:id` with new probs + `userEdited:true`.

### D. Inputs panel (collapsible accordion, below cards)
Shows what the LLM saw when generating:
- Driver snapshot table: each driver → latest value, 3m slope, 12m slope, classification (from trends).
- Attribution snapshot: top 3 sign-break pairs + top 3 not-priced pairs.
- Read-only — for transparency / audit.

### E. Hit-rate history panel
- Table of past scenarios with computed hit-rates (calls `GET /api/scenarios/:id/hit-rate` per row, lazy).
- Columns: target quarter | base prob | actual outcome (base/bull/bear) | brier score | model used | cost | timestamp.
- Quick stats above table: "Overall calibration: N completed scenarios · Avg Brier: 0.NN · Sonnet hit-rate: X% · Haiku hit-rate: Y%".

### F. AI commentary footer
- `<AICommentaryPanel>` with `kind="scenarios"` — explains the asymmetric setup, suggests trades, flags single-driver dominance. Sonnet/Haiku toggle inline (separate from the generate-model toggle).

## API integration
```
On mount:
  useQuery(['/api/scenarios/latest', quarter]) → fetch latest scenario for selected quarter
  useQuery(['/api/scenarios']) → list of all scenarios (for hit-rate panel)

On "Regenerate":
  useMutation: POST /api/scenarios/generate { targetQuarter, model }
    → invalidate ['/api/scenarios/latest', quarter] + ['/api/scenarios']
    → optimistic toast "Generating with {model}…" with elapsed timer

On probability edit:
  Local state. "Save edits" button → useMutation: PATCH /api/scenarios/:id { probabilities, userEdited:true }
    → invalidate ['/api/scenarios/latest', quarter]
```

## Visual rules
- Card backgrounds slightly tinted (base = primary/5, bull = emerald/5, bear = red/5).
- Probabilities always sum to 100 (auto-balance with smallest other; if user sets base=50 and bull is 30, bear becomes 20).
- Show 4-dp cost for LLM runs (e.g. `$0.0398`).
- "Generated 2 hours ago" — use `date-fns` `formatDistanceToNow`.

## Open questions
- Auto-regenerate cadence? Could add a "regenerate weekly via cron" option in Settings. Default: manual only.
- Should scenarios be exportable as PDF for sharing with team / IC? Suggestion: yes — defer to a v2.
- Hit-rate currently relies on actual outcomes appearing in the data. For 1Q-forward scenarios on 2026-Q3, hit-rates are only computable after 2026-Q3 closes. Show "Pending — outcome window 2026-09-30+" placeholder until then.

---

# Implementation order suggestion

1. **Trends first** (lowest API risk; no LLM cost). ~1-2 sessions.
2. **Attribution second** (heatmap + drill-down is the most novel UI). ~2 sessions.
3. **Scenarios last** (depends on user testing the LLM output, probabilities UX, and hit-rate logic). ~2 sessions.

Total estimate: 5-7 build sessions, with screenshot QA via Playwright between each page.

---

# Decisions confirmed (2026-06-03)

1. **Sidebar grouping** — Split into "Dashboard" + "Analysis" groups. Layout.tsx renders grouped sections.
2. **Default `/trends` series** — The proposed 10 (7 macro drivers + 3 equity indices).
3. **Heatmap orientation** — Drivers as rows × equities as columns.
4. **Scenario probability editing** — **Sliders** (3 sliders, auto-balanced to 100%). Numeric value shown beside each slider.
5. **Exports** — All 3 pages export to **CSV + PDF + DOCX + PPTX**. New shared `<ExportMenu>` dropdown component (DropdownMenu) on every page header, right-aligned. Backend: 4 new export routes per page (`/api/{trends|attribution|scenarios}/export?format={csv|pdf|docx|pptx}`). Use existing office skill helpers (xlsx for CSV, pdf/docx/pptx skills for docs).
6. **Cost tracking** — **Separate `/costs` page** under "Analysis" group. Pulls from existing `apiCalls` audit table. Shows: monthly spend per provider (Anthropic, DeepSeek, Sonar, CEIC), spend vs ceiling progress bars, cost-per-page table (which page drove the spend), trend chart (daily LLM spend last 30d), top 10 most expensive calls. Scenarios page footer shows only the current run's cost; full breakdown lives on `/costs`.
7. **Playwright QA** — Only at the end of all 3 pages, before final deploy. Screenshot every page at 1280px and 375px in one batch.
