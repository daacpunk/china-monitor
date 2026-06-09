# China Monitor — Phase 4 Spec: Export Engine

Status: DRAFT FOR REVIEW (no code written yet)
Serves the ultimate objective's last mile: turn the on-screen strategy note (Phase 3)
into shippable deliverables — a written **strategy paper (PDF + DOCX)** and a
comprehensive **45-minute investor presentation (PPTX)** — plus lightweight CSV/PDF
exports for the data/analysis pages.

---

## 0. What exists to build on
- `ExportMenu.tsx` — a finished dropdown shell (CSV/PDF/DOCX/PPTX) already wired to the
  contract `/api/{resource}/export?format=...`. Currently shows a "coming soon" toast;
  Phase 4 removes that branch and points it at real routes.
- Phase 3 `strategy_notes` — the structured, cited source of truth (sections, portfolio,
  thesisVerdict, citations, houseViewSnapshot). The paper/deck render FROM this.
- Chart.js + react-chartjs-2 on the client; Node 20 server; no doc/export libs yet.

The defining principle carries through: **provenance on every figure**; every data point
and claim in the exported doc is footnoted/cited with its real source URL.

---

## A. CHART-TO-IMAGE RENDERING (prerequisite for embeds)

Documents/decks need charts as images. Decision point (see Open Questions):

**Option 1 — Server-side render with a headless Chart.js (RECOMMENDED).**
Use `@napi-rs/canvas` (prebuilt native canvas, no system deps — works on Railway
Nixpacks) + `chartjs-node-canvas` (or Chart.js directly on the canvas). The server
re-renders the same series data into PNGs at export time. Pros: deterministic, no
browser dependency, reuses the existing series-fetch + chart config. Cons: a second
chart config path to keep in sync with the client.

**Option 2 — Client captures `chart.toBase64Image()` and POSTs PNGs to the export route.**
Pros: pixel-identical to what the user sees; reuses the exact client chart. Cons: export
must happen with the page open; bigger payloads; awkward for headless/cron (Phase 5).

Recommendation: **Option 1** — it's the only one that works for scheduled/automated
generation in Phase 5, and keeps export server-driven. A small shared chart-spec helper
(`shared/chartSpec.ts`) defines colors/fonts so server PNGs match the on-screen look.

`server/export/charts.ts`:
- `renderLineChart(series[], opts) -> PNG buffer`
- `renderBarChart(...)`, `renderDonut(...)` for allocation/portfolio weights
- Consistent palette + China Monitor branding; provenance caption baked into each image.

---

## B. THE STRATEGY PAPER (PDF + DOCX)

Source: a `strategy_notes` row. Long-form institutional paper.

### DOCX — `docx` npm package (pure JS, no native deps)
- Cover page: title, "China Monitor — Strategy & Outlook", as-of date, mode badge
  (Data-Driven / Thesis-Driven), house-view headline + stance/conviction.
- House view box (stance, conviction, horizon, pillars, per-theme OW/N/UW table).
- Mode A: model-portfolio table (name, stance, weight, conviction, rationale, key risk).
- Mode B: thesis-verdict callout (verdict, confidence, supporting vs contradicting
  evidence, gaps, corrections, alternatives) up front.
- Section-by-section body (the 8-9 generated sections), with embedded chart figures
  where relevant (macro, sector allocation, single names).
- Footnotes / endnotes: every citation rendered with source name + full URL.
- Methodology + provenance appendix.
- Styling: clean serif/sans pairing, section headers, page numbers, header/footer.

### PDF — two viable paths (see Open Questions)
- **Path A:** generate DOCX, convert to PDF. Needs LibreOffice headless on Railway
  (heavy) OR a conversion service. Highest fidelity to the DOCX.
- **Path B (RECOMMENDED):** render PDF directly with `pdfmake` (pure JS, declarative
  doc definition, supports images/tables/footnotes). One layout definition drives PDF;
  DOCX uses the `docx` package from the same content model. Both read the same
  `NoteDocModel` so they stay consistent.

`server/export/paper.ts`:
- `buildNoteDocModel(note) -> NoteDocModel` (shared content model: blocks, tables,
  figures, citations).
- `renderDocx(model) -> .docx buffer`
- `renderPdf(model) -> .pdf buffer`

---

## C. THE 45-MINUTE INVESTOR DECK (PPTX)

Source: same `strategy_notes` row. Must be genuinely comprehensive — 45 min ≈ ~35-55
slides with speaker-grade depth, NOT a summary.

### Library: `pptxgenjs` (pure JS, no native deps; tables, charts-as-images, speaker notes)

### Deck skeleton (maps to the note + house view + portfolio/verdict)
1. Cover — title, house view headline, as-of date, conviction
2. Executive summary / the call (1-2 slides)
3. House view & sector stances (OW/N/UW table + rationale)
4. Macro backdrop (growth/inflation/K-shape) — chart slides
5. Liquidity & monetary regime — chart
6. Policy & regulatory landscape (Phase 1 items + market linkage) — 2-3 slides
7. Cross-asset & flows (Connect, margin, FX, rates, commodities) — chart
8. Sector allocation overview — donut/bar of weights
9. Sector deep-dives — one slide per emphasized theme (drivers + policy + valuation)
10. Single-name highlights — featured names: thesis, valuation, catalyst (1 slide each)
11. Scenarios — base/bull/bear table with probabilities
12. Investor-lens views (if persona lenses attached)
13. Risks / devil's-advocate red-team
14. Catalysts & forward calendar
15. Appendix — methodology, data provenance, full source list

Mode-aware: Mode A adds a model-portfolio slide set; Mode B leads with the thesis-verdict
slides (supported/contradicting/alternatives). Every chart slide carries a provenance
caption; a closing sources slide lists all citation URLs.

`server/export/deck.ts`:
- `buildDeckModel(note) -> DeckModel` (slides[], each with layout + content + speaker notes)
- `renderPptx(model) -> .pptx buffer`
- Speaker notes auto-filled from section prose so it's presentable for the full 45 min.

---

## D. ROUTES & WIRING

```
GET /api/report/:id/export?format=pdf|docx|pptx   -> streams the file
GET /api/{resource}/export?format=csv|pdf          -> lightweight page exports
    (resources: trends, attribution, scenarios, costs, policy, sectors)
```
- Export routes stream a Buffer with correct content-type + Content-Disposition.
- `ExportMenu.tsx`: remove the coming-soon toast; trigger `window.location.href = url`.
- The Report page (`/report`) gets an ExportMenu bound to the active note id (the
  "Export → Phase 4" badge becomes the live menu).
- Cost: chart rendering + doc assembly are CPU only (no LLM), so no ceiling needed;
  exports are free after the note is generated.

---

## E. BRANDING / TEMPLATE
- Light, institutional look: neutral palette, one accent (the app's primary), clean
  type. China Monitor wordmark on cover + footer. Consistent across PDF/DOCX/PPTX.
- A single `shared/brand.ts` (colors, fonts, wordmark text) drives all three renderers.

---

## F. BUILD ORDER
1. Chart-to-image renderer (`server/export/charts.ts`) + shared chart spec/brand.
2. Shared `NoteDocModel` / `DeckModel` builders from a strategy_note.
3. PPTX deck (`pptxgenjs`) — the flagship deliverable.
4. PDF + DOCX paper (`pdfmake` + `docx`).
5. Wire export routes + activate ExportMenu on /report.
6. Lightweight CSV/PDF for data/analysis pages (reuse where trivial).
7. Build, verify (open generated files), commit/push, verify live.
8. Docs.

---

## G. DECISIONS (RESOLVED 2026-06-09)
1. **Scope: build ALL THREE (PDF + DOCX + PPTX)** this phase.
2. **PDF: pdfmake direct** (pure-JS, no heavy deps, automation-friendly).
3. **Charts: server-side headless** (`@napi-rs/canvas` + Chart.js) — works for Phase 5
   automation. Shared chart-spec keeps PNGs matching the on-screen look.
4. **Deck depth: ~40-50 slides, MODE-AWARE** (flexes with emphasized themes/names).
5. **Branding: neutral "China Monitor — Strategy & Outlook"** wordmark/styling; no
   specific firm name. Single `shared/brand.ts` drives all three renderers.

Build order unchanged (Section F): charts → shared doc/deck models → PPTX → PDF+DOCX →
wire routes + activate ExportMenu → page exports → verify → docs.
