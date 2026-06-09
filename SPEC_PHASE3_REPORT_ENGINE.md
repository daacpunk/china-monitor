# China Monitor — Phase 3 Spec: Report Engine

Status: DRAFT FOR REVIEW (no code written yet)
Serves the ultimate objective directly: produce specific, comprehensive equity/macro
**strategy & outlook papers** on the HK/China market. This phase builds the long-form
note + the persistent house view + the user theme/company gap-fill engine. Phase 4
then exports it to PDF/DOCX and the 45-minute PPTX deck.

---

## 0. How this differs from the existing Brief

The **Brief** (Phase 3b) is a 6-section market write-up of "what just happened"
(what_happened, regime_shifts, cross_asset, priced_vs_not, forward_watch,
trade_implications). It's a snapshot commentary.

The **Strategy Note** is a level up: a long-form, multi-section institutional paper
that assembles EVERYTHING — macro read (can reuse the Brief), policy landscape
(Phase 1), sector allocation + single names (Phase 2), scenarios, investor-lens views
+ red-team (Phase 1), and a persistent **house view** — into one structured, editable
document built around the user's own thesis and chosen companies.

The Brief feeds the Note; it does not replace it.

---

## A. HOUSE VIEW (persistent thesis object)

Institutional research is cumulative. The house view is a standing call that each note
references and updates — so the tool can say "what changed since last month and were we
right," not just produce one-offs.

### Data model — `house_view`
```ts
interface HouseView {
  id: string;
  updatedAt: string;
  headline: string;            // the standing call, one line
  stance: "bullish" | "neutral" | "bearish" | "constructive" | "cautious";
  conviction: "low" | "medium" | "high";
  horizon: "1Q" | "2Q" | "1Y";
  pillars: string[];           // 3-6 supporting arguments
  keyRisks: string[];          // what would break the thesis
  sectorStance: {              // per coverage theme
    theme: CoverageTheme;
    stance: "overweight" | "neutral" | "underweight";
    rationale: string;
  }[];
  changeLog: {                 // append-only history
    date: string;
    change: string;            // what changed vs prior
    trigger: string;           // the data/policy/event that drove it
  }[];
}
```
- Stored as a single evolving row (plus changeLog history). One active house view.
- Editable by the user; the report engine can also **propose** an updated house view
  from the latest data (user approves/edits — never silently overwritten).
- Surfaced on a small `/house-view` panel (or section of the report page).

---

## B. STRATEGY NOTE (the long-form paper)

### Data model — `strategy_note`
```ts
interface StrategyNote {
  id: string;
  createdAt: string;
  title: string;
  asOfDate: string;
  // user inputs (the gap-fill brief):
  userThesis: string;          // free-text thesis/theme
  featuredNames: string[];     // tickers the user wants included
  mustInclude: string[];       // points the user insists on
  emphasis: CoverageTheme[];   // which themes to weight
  // generated content:
  sections: StrategyNoteSection[];
  houseViewSnapshot: HouseView;// the house view as of generation
  model: string;               // synthesis model used
  costUsd: number; tokensIn: number; tokensOut: number;
  citations: { name: string; url: string }[]; // all sources used
  status: "draft" | "final";
  userEdits: Record<string, string>; // section overrides (user-edited text)
}

interface StrategyNoteSection {
  key: string;                 // see skeleton below
  heading: string;
  body: string;                // markdown
  charts?: string[];           // series ids / chart refs to embed (Phase 4)
  sources?: { name: string; url: string }[];
}
```

### Section skeleton (institutional long-form)
1. `house_view` — the standing call, conviction, sector stances, what changed
2. `executive_summary` — the thesis in 3-5 crisp paragraphs
3. `macro_backdrop` — growth, inflation/PPI, K-shape, liquidity (reuses Brief + data)
4. `policy_landscape` — Phase 1 policy items, tech-skewed + macro, with market linkage
5. `cross_asset_flows` — Connect flows, margin, FX, rates, commodities
6. `sector_allocation` — top-down OW/N/UW across the 6 themes (Phase 2 universe)
7. `sector_deep_dives` — one per emphasized theme: drivers + policy + valuation
8. `single_names` — featured names (user + system): thesis, valuation, catalysts
9. `scenarios` — base/bull/bear with probabilities (reuses Scenarios engine)
10. `investor_lenses` — selected persona lenses (Phase 1)
11. `risks_redteam` — devil's-advocate panel (Phase 1)
12. `catalysts_calendar` — forward calendar + watch items
13. `appendix` — data provenance, methodology, full source list

Sections are individually regenerable and user-editable. Every factual claim carries a
citation (data provenance chip or Sonar/policy source URL) so Phase 4 can footnote it.

---

## C. USER THEME / COMPANY GAP-FILL ENGINE (the key new capability)

A composer where the user supplies the seed and Claude's strongest model fills the gaps.

### Flow
1. **Compose**: user enters `userThesis` (free text), `featuredNames` (tickers),
   `mustInclude` points, `emphasis` themes, target length, and picks the synthesis model
   (default mid-tier, bump to Opus-class per the Phase-1 decision).
2. **Assemble context** (server-side, no hallucination): the engine gathers
   - latest macro/cross-asset data snapshot (existing series fetch)
   - recent policy items + linkage (Phase 1 `/api/policy/feed`)
   - sector universe + valuations + catalysts for emphasized themes & featured names (Phase 2)
   - current house view
   - optionally a fresh Sonar pull for the user's specific thesis (`event_explain`)
3. **Generate**: a structured multi-call synthesis (section by section, so each stays
   high-quality and within token limits) using the chosen model. Featured names are
   guaranteed a slot; the model fills surrounding analysis, scenarios, lenses, risks.
4. **Review & edit**: user edits any section inline; can regenerate a single section;
   can propose/accept a house-view update.
5. **Persist**: saved as a `strategy_note` (draft → final), versioned.

### Backend
- `server/report/houseView.ts` — get/update/propose house view.
- `server/report/strategyNote.ts` — context assembly + section-by-section synthesis.
- `house_view`, `strategy_notes` tables (Drizzle + bootstrap).
- Routes:
  - GET/PUT `/api/house-view`, POST `/api/house-view/propose`
  - POST `/api/report/generate` (compose → assemble → synthesize)
  - POST `/api/report/:id/section/:key/regenerate`
  - PUT `/api/report/:id` (save user edits / status)
  - GET `/api/report`, GET `/api/report/:id`

### Frontend
- `/report` page under a new **REPORT** nav group (or under Analysis):
  - Composer panel (thesis, featured names w/ autocomplete from Phase 2 universe,
    emphasis chips, model selector, length).
  - Generated note rendered section-by-section, each editable + regenerable.
  - House-view panel with change-log; "propose update" button.
  - "Export" affordance (wired in Phase 4: PDF/DOCX/PPTX).

### Cost posture
- Section-by-section synthesis = several LLM calls per note; all ceiling-checked +
  audit-logged. Model selectable (mid-tier default, Opus-class bump). Sonar pulls cached.
- The `/costs` page surfaces per-note spend.

---

## D. WHAT PHASE 3 DOES *NOT* DO (deferred to Phase 4)
- PDF / DOCX / PPTX export and chart-image rendering. Phase 3 produces the structured,
  cited, editable note + house view *on screen*; Phase 4 turns it into the deliverables.

---

## E. DECISIONS (RESOLVED 2026-06-09)
1. **House view: ONE master house view + per-theme sector stances** inside it. Single
   source of truth, evolving, with append-only change-log.
2. **Note generation: SECTION-BY-SECTION** multi-call synthesis (higher quality/depth;
   each call ceiling-checked + audit-logged).
3. **Featured names: RESTRICT to the Phase 2 universe** (~42 curated A-share+HK names),
   with autocomplete from `/api/equity/universe`. (Can widen later if needed.)
4. **Nav: new dedicated "REPORT" group** (flagship output). Route `/report`.
5. **Default length: long institutional paper, ~3,000-5,000 words.** Section targets
   sized to hit this; user can adjust emphasis/length in the composer.

(Nav note: user selected both "new Report group" and "under Analysis"; resolved to a
new dedicated REPORT group since it fits the flagship long-paper choice. Trivially
movable under Analysis if preferred.)
