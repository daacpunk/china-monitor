# China Monitor — Phase 1 Spec: Policy Monitor + Investor-Brain Personas + Sonar Research

Status: DRAFT FOR REVIEW (no code written yet)
Author: build session 2026-06-09
Ultimate objective this serves: produce specific, comprehensive equity + macro
**strategy/outlook papers** and **45-minute investor presentations** on the HK/China
market, with a user-input section for themes/companies that Claude's strongest model
fills around.

---

## 0. Where this fits

Phase 1 was originally "Sonar research layer + investor-brain personas." The user has
now added a third pillar — **augmented China policy/regulatory monitoring** with a
dedicated Policy Tracker section that links policy → equity moves. So Phase 1 becomes
three coupled modules feeding one synthesis engine:

```
  ┌─────────────────────┐   ┌──────────────────────┐   ┌────────────────────┐
  │ A. Policy Monitor    │   │ B. Sonar Research     │   │ C. Investor-Brain  │
  │  (official channels) │   │  (news/catalysts)     │   │  Persona library   │
  └──────────┬──────────┘   └──────────┬───────────┘   └─────────┬──────────┘
             │                          │                          │
             └──────────────┬───────────┴──────────────┬──────────┘
                            ▼                            ▼
                   ┌─────────────────────────────────────────────┐
                   │  Synthesis engine (Brief / Scenarios / Note) │
                   │  → Strategy paper + 45-min deck generator    │
                   └─────────────────────────────────────────────┘
```

All three respect the existing principles: provenance chip on every datum, cost
ceiling on every paid call, audit trail, 24h cache where applicable.

---

## A. AUGMENTED POLICY MONITORING

### A.1 Official source channels (the spine)

Tiered by authority. Each source = a registered "policy channel" with id, name,
fetch method (direct HTML/RSS where available, else Sonar query scoped to the domain),
and — critically — the **specific signal-bearing sub-page** plus an **analyst tip**
describing what to watch there. The user supplied these precise targets and tips; they
are encoded verbatim so the build sources from signal pages, not generic homepages.
The alpha is in the sub-pages (Exec Meeting readouts, OMO data, Policy Q&A,
press-conference tone), not the front door.

**Tier 1 — Top-Level State Directives & Macro Planning**
(Highest-level signals: GDP targets, fiscal deficit ratios, major strategic shifts.)

| id | Body | Signal page (encode this URL) | Analyst tip (drives extraction/scoring) |
|---|---|---|---|
| state_council | 国务院 State Council | Policy Library: gov.cn/zhengce/ ; Exec Meetings: gov.cn/yaowen/liebiao/{year}/gwyhy/index.html (year rolls; also detect by tag 国务院常务会议) | Read State Council Executive Meeting readouts (~every Wednesday) — the most immediate, actionable translation of Politburo directives into administrative tasks. |
| xinhua_politics | 新华社 Xinhua (Politics) | news.cn/politics/ | CCP mouthpiece; Politburo (中共中央政治局会议) and CEWC (中央经济工作会议) readouts publish here FIRST. Filter on those two tags. |

Apex calendar events tracked as special cases: Politburo (quarterly tone), CEWC
(annual Dec, next-year priorities), Two Sessions / NPC-CPPCC (annual Mar: GDP target,
fiscal deficit, budget).

**Tier 2 — Monetary, Credit & Foreign Exchange Policy**
(Cost & availability of capital — the primary liquidity driver for CN equities/bonds.)

| id | Body | Signal page | Analyst tip |
|---|---|---|---|
| pboc | 人民银行 PBoC | News: pbc.gov.cn/goutongjiaoliu/113456/113469/index.html ; Monetary Policy Dept: pbc.gov.cn/zhengcehuobisi/125207/125213/index.html | Don't just read news — pull the Data (数据统计) section's daily open market operations (公开市场业务交易公告) to read daily liquidity management (MLF, reverse repos, LPR/RRR). |
| safe | 国家外汇管理局 SAFE | safe.gov.cn/safe/xwdt/index.html | Watch the Policy Q-and-A (政策问答) section — SAFE uses it to subtly signal loosening/tightening of capital controls before formal regulation. |

**Tier 3 — Fiscal Policy, Industrial Planning & Pricing**
(Government spending, taxation, infra approvals, key commodity pricing.)

| id | Body | Signal page | Analyst tip |
|---|---|---|---|
| mof | 财政部 MOF | mof.gov.cn/zhengwuxinxi/caizhengxinwen/ | Track monthly revenue/expenditure press conferences (财政收支情况新闻发布会) — critical for gauging the actual impact of fiscal stimulus (local-govt special-purpose bonds, tax rebates, subsidies). |
| ndrc | 发改委 NDRC ("mini-State Council") | Policy: ndrc.gov.cn/xxgk/zcfb/ ; Press: ndrc.gov.cn/xwdt/xwfb/ | Monthly press conferences signal whether they'll accelerate approval of fixed-asset investment (固定资产投资) projects to underpin (托底) growth. Also sets oil/gas/electricity pricing. |

**Tier 4 — Capital Markets & Securities Regulation**
(Direct A-share regulator: IPO pacing, institutional behavior, market stabilization.)

| id | Body | Signal page | Analyst tip |
|---|---|---|---|
| csrc | 证监会 CSRC | csrc.gov.cn/csrc/c100028/common_list.shtml | Watch Media Briefings (证监会新闻发布会): spokesperson tone signals regime — warning of "blind speculation" (overheating) vs encouraging "long-term capital" to enter (panic/support). Covers IPO registration, short-selling rules, dividend mandates, "National Team" interventions. |

**Tier 5 — Sector / Technology Regulators (coverage focus, tech-skewed)**
(Essential for the tech/EV/battery/semi/AI/consumer mandate. Sourced primarily via
Sonar domain-scoped scans; signal sub-pages added as discovered.)

| id | Body | Coverage relevance | Domain |
|---|---|---|---|
| miit | 工信部 MIIT | Tech, telecom, semis, EV/auto industrial policy, AI infra | miit.gov.cn |
| cac | 网信办 CAC | Data/cybersecurity, platform/internet, AI governance | cac.gov.cn |
| most | 科技部 MOST | Sci-tech innovation, R&D priorities, "new productive forces" | most.gov.cn |
| samr | 市场监管总局 SAMR | Antitrust, platform regulation, M&A review | samr.gov.cn |
| mofcom | 商务部 MOFCOM | Trade, export controls, FDI, outbound investment | mofcom.gov.cn |
| nea | 能源局 NEA | Energy, power, battery/renewables policy | nea.gov.cn |
| nfra | 金融监管总局 NFRA | Banking/insurance regulation, financial risk | nfra.gov.cn |
| exchanges | SSE/SZSE/HKEX | Listing, connect flows, rule changes | sse.com.cn / szse.cn / hkex.com.hk |

**Tier 6 — Interpretation / corroboration (secondary, always cited as such)**
Xinhua/People's Daily/CGTN (official press) + think-tank reads (CSIS Interpret,
DigiChina, NPC Observer, Asia Society Policy Institute) for English context. These
NEVER override Tiers 1–5; they annotate only.

**Why sub-page targeting matters for the build:** each channel record stores both a
`listUrl` (the signal sub-page) and a `signalHint` (the analyst tip). The fetcher hits
`listUrl` directly, and `signalHint` is injected into the LLM classification prompt so
significance-scoring reflects the right signal — e.g. for CSRC, detect "blind
speculation" vs "long-term capital" tone; for PBoC, parse OMO net injection/drain; for
NDRC, detect FAI-approval acceleration language.

### A.2 How policy is captured

- Direct fetch where a stable English/Chinese feed exists (many bodies publish HTML
  lists; some have RSS). Stored with provenance `policy:<body>`.
- Sonar-targeted pulls (Module B) scoped to each body's domain via `search_domain_filter`
  for the latest items — this is the reliable catch-all since many .gov.cn pages are
  JS-light HTML but inconsistent. Sonar returns title + date + url + summary, cited.
- Dedup + classify into a normalized `policy_update` record (schema below).
- Frequency: policy is event-driven, not a fixed series. Default poll cadence
  configurable (e.g. daily scan of Tier 1–3 latest pages); heavy interpretation only
  runs on-demand or in the pre-report refresh (cost control).

### A.3 Data model — `policy_update`

```ts
interface PolicyUpdate {
  id: string;
  title: string;
  titleZh?: string;
  body: string;              // channel id, e.g. "pboc" | "csrc" | "miit" | ...
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  category: PolicyCategory[]; // ["monetary"], ["tech","ai"], ["trade"], ...
  themes: string[];          // mapped to coverage: tech, ev, battery, semi, ai, consumer
  publishedAt: string;
  url: string;               // official source (provenance)
  summary: string;           // neutral 1–3 sentence extract
  significance: "high" | "medium" | "low";  // LLM-scored, with rationale
  marketLinkage: MarketLinkage[];  // see A.4
  sources: { name: string; url: string }[]; // corroboration (Tier 4)
  fetchedAt: string;
  provenance: "policy" | "sonar";
}

// Channel registry record — encodes the user's signal-page targeting + analyst tips.
interface PolicyChannel {
  id: string;                // "state_council" | "pboc" | "csrc" | "miit" | ...
  name: string;
  nameZh: string;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  domain: string;            // for Sonar search_domain_filter
  listUrl: string;           // SPECIFIC signal-bearing sub-page (not homepage)
  altUrls?: string[];        // e.g. PBoC monetary-policy-dept + OMO data pages
  signalHint: string;        // analyst tip, injected into the scoring prompt
  watchTags?: string[];      // zh tags to filter on (e.g. 中央经济工作会议)
  defaultThemes: string[];   // coverage themes this body most affects
}

type PolicyCategory =
  | "monetary" | "fiscal" | "industrial" | "trade" | "tech" | "ai" | "data_security"
  | "antitrust" | "capital_markets" | "property" | "energy" | "ev" | "semiconductor"
  | "consumer" | "employment" | "fx";
```

### A.4 Linking policy → equity movements (the key requirement)

Each policy gets a `marketLinkage[]` connecting it to market reaction:

```ts
interface MarketLinkage {
  scope: "index" | "sector" | "name";
  target: string;            // e.g. "CSI300", "HSTECH", "semis", "BYD"
  expectedDirection: "positive" | "negative" | "mixed" | "neutral";
  rationale: string;         // why this policy should move this target
  observedMove?: {           // populated by joining to existing series data
    window: "1d" | "3d" | "5d";
    pctChange: number;
    source: string;          // provenance of the price series used
  };
  priced: "not_yet" | "partially" | "fully";  // reuses the Attribution "not yet priced" idea
}
```

How linkage is computed:
1. LLM maps the policy to affected indices/sectors/names + expected direction +
   rationale (methodology-grounded, see persona frameworks).
2. The system joins to **existing price series** (CSI300, ChiNext, HSI, HSTECH, sector
   proxies, single names from Phase 2) over 1/3/5-day windows post-publication.
3. Computes observed move and flags `priced` status — feeding the existing Attribution
   page's "not yet priced" logic.

This is the bridge: policy events become first-class drivers in the Attribution and
Brief engines, not just a news list.

### A.5 New "Policy Tracker" section (frontend)

New nav entry under DASHBOARD (or its own group). Page: `/policy`.

- **Feed view**: chronological policy_update cards, filterable by tier, category,
  theme (tech / EV / battery / semi / AI / consumer / macro), significance.
- **Tech lens (default skew)**: a toggle that pre-filters to tech + sector-tech policy,
  since the user wants the tracker mostly tech-skewed.
- **Macro lens**: monetary/fiscal/trade/property apex policy.
- **Market-linkage column/expander**: shows affected targets, expected vs observed
  move, priced status — with provenance chips on the price data.
- **Policy → Equity timeline**: an overlay chart option that plots policy event markers
  on top of an index/sector price line (e.g. HSTECH with MIIT/CAC events annotated).
- **"Send to report/deck"**: select policies to include in the next strategy paper/deck.

### A.6 Backend routes (planned)

```
GET  /api/policy/feed?tier=&category=&theme=&since=
POST /api/policy/refresh           // trigger a Sonar+direct scan of channels
GET  /api/policy/:id                // single, with full linkage
POST /api/policy/:id/linkage        // (re)compute market linkage
```

---

## B. SONAR PRO RESEARCH LAYER

### B.1 Client

`server/clients/sonar.ts`. Uses the existing `keyResolver("sonar")` — confirmed same
key as the Perplexity API key. Routed through `checkCeiling()` + `recordCall()` so
spend counts against the monthly cost ceiling like every other paid call. 24h cache
keyed by prompt-hash + domain filter (mirrors existing LLM cache).

Endpoint: `POST https://api.perplexity.ai/chat/completions`, model `sonar-pro`.
Key params used:
- `search_domain_filter` — to scope to official .gov.cn domains per policy channel,
  or to a curated finance/news allowlist for catalysts.
- `search_recency_filter` — `day` / `week` / `month` to control freshness.
- `return_citations: true` — every claim carries a source url (feeds provenance).
- `search_after_date` / structured date scoping where supported.

### B.2 Prompt structure (templated, typed)

A small set of reusable, parameterized prompt builders — NOT freeform. Each returns a
system+user pair plus the domain/recency filters.

```ts
type SonarTask =
  | { kind: "policy_scan"; body: ChannelId; sinceDays: number }
  | { kind: "catalyst_scan"; theme: CoverageTheme; sinceDays: number }
  | { kind: "name_news"; ticker: string; sinceDays: number }
  | { kind: "event_explain"; query: string };       // ad-hoc, for the note/deck
```

**Template — policy_scan** (example skeleton, final wording tunable):
- system: "You are a research assistant for an institutional China/HK equity
  strategist. Return only factual, sourced policy/regulatory items from official
  Chinese government channels. Never invent. Output strict JSON array of
  {title, date, url, summary, category[]}. No commentary."
- user: "List policy/regulatory announcements from {bodyName} ({bodyDomain}) in the
  last {sinceDays} days relevant to {themes}. Prefer primary official pages."
- filters: `search_domain_filter:[bodyDomain]`, `search_recency_filter:"week"`,
  `return_citations:true`.

**Template — catalyst_scan**: same shape, theme-scoped (tech/EV/battery/semi/AI/
consumer), allowlist of reputable finance/news + official sources, recency `day`/`week`.

**Template — name_news**: single-name catalysts/earnings/guidance for the bottom-up
equity layer (Phase 2).

**Template — event_explain**: ad-hoc, used by the report/deck engine to fetch context
for a user-supplied theme or company ("explain X with sources").

### B.3 Output contract & provenance

All Sonar outputs are parsed to typed records; raw citations preserved. Any item that
makes it into a brief/note/deck carries its source url so the document can footnote it
(satisfies the in-document citation requirement). Failures degrade gracefully (empty
list + logged), never crash a page (Phase 0 error boundary also protects).

### B.4 Cost posture

- Policy/catalyst scans are the main spend. Default: on-demand + once per
  pre-report refresh. Optional daily background scan is **off by default**, toggle in
  Settings, and always ceiling-checked. A `/costs` page (already in nav) surfaces it.

---

## C. INVESTOR-BRAIN PERSONA LIBRARY

Decisions locked: **methodology-modeled** (static, no per-persona Sonar pulls),
used as **selectable lenses** + **devil's-advocate panel**. Not a single always-on
house voice.

### C.1 Data model — `Persona`

```ts
interface Persona {
  id: string;                 // "pettis", "marks", "druckenmiller", ...
  name: string;
  firm: string;
  category: PersonaCategory;  // "global_macro" | "value" | "credit_distressed" |
                              // "quant" | "activist" | "private_equity" | "venture" |
                              // "china_value" | "china_growth" | "china_strategist" |
                              // "china_economist" | "china_macro" | "china_credit"
  focus: string;              // one-line key focus

  // The analytical engine — what makes the lens real:
  framework: string[];        // core methodology, e.g. for Pettis: BoP identities,
                              //   savings/investment imbalance, debt sustainability
  keyQuestions: string[];     // the questions this mind asks of ANY setup
  signalsWatched: string[];   // metrics/series they'd prioritize (map to our data ids)
  redFlags: string[];         // what makes them bearish / cautious
  bias: "structurally_bullish" | "structurally_bearish" | "cycle_dependent" | "neutral";
  timeHorizon: "short" | "medium" | "long";
  voice: string;              // tone/style guidance for the LLM when writing as lens
  applicability: CoverageTheme[] | "all";  // where the lens is most relevant
}
```

### C.2 Coverage (the 20 named + grouping)

China specialists get the deepest `framework`/`keyQuestions` encoding since they map
to the HK/China mandate:
- **Li Lu** (Himalaya) — china_value; owner-earnings, moats, margin of safety, BYD-style.
- **Zhang Lei** (Hillhouse) — china_growth; structural trends, digitalization, long duration.
- **Robin Xing** (Morgan Stanley) — china_strategist; regulatory cycles, equity allocation.
- **Larry Hu** (Macquarie) — china_economist; macro recovery, fiscal stimulus transmission.
- **Michael Pettis** (Carnegie/PKU) — china_macro; rebalancing, debt dynamics, BoP identities.
- **Andrew Collier** (Orient Capital) — china_credit; shadow banking, LGFVs, property credit.

Global lenses (selectable, applied to China/HK setups):
- Buffett, Mason Hawkins (value); Howard Marks, David Tepper (credit/cycle/distressed);
  Ray Dalio, Soros, Druckenmiller (global macro); Simons, D.E. Shaw, Ken Griffin
  (quant/multi-strat); Carl Icahn (activist); Schwarzman (PE); Thiel, Andreessen (VC/tech).

Stored as a static, version-controlled dataset (`server/analysis/personas.ts` or a
JSON the file imports). Easy to extend/tune later.

### C.3 Two modes

**Selectable lens** — on a brief/note/section, choose one (or a few) personas. The
synthesis re-reasons the setup through their `framework` + `keyQuestions` and writes in
their `voice`. Example outputs: "Through the Pettis rebalancing lens…", "Druckenmiller
liquidity read…".

**Devil's-advocate panel** — auto-selects bear-leaning / cycle-cautious personas
(e.g. Marks on cycle excess, Pettis on debt, Collier on credit plumbing, Druckenmiller
on liquidity reversal) to attack the base-case thesis → produces the Risk / Red-Team
section of any note or deck. This is the institutional devil's advocacy.

### C.4 Integration points

- Brief page: lens selector + "Add red-team panel" toggle.
- Scenarios page: personas inform bear/bull narrative construction.
- Report/deck engine (Phase 3/4): lenses become named viewpoint slides; red-team
  becomes the Risks section.

---

## D. HOW THIS FEEDS THE STRATEGY PAPER + 45-MIN DECK (objective alignment)

This spec is Phase 1, but it is explicitly built to serve the end deliverable. Preview
of how the pieces land in Phase 3/4 so the data model is right now:

### D.1 The deliverables
1. **Strategy/outlook paper** — long-form written note (→ PDF/DOCX), institutional depth.
2. **45-minute investor presentation** — comprehensive PPTX. 45 min ≈ ~35–55 slides
   with speaker-grade depth. Must be genuinely comprehensive, not a summary deck.

### D.2 User-input / theme-gap-fill engine (new requirement)
A composer where the user supplies:
- Free-text **thesis / theme** (e.g. "China AI capex cycle + power constraint").
- A list of **companies/tickers** to feature.
- Optional **must-include points** and target length/section emphasis.

Then Claude's strongest model (Opus-class — selectable, default for the final
synthesis) **fills the gaps**: pulls the relevant data series, policy updates (Module
A), catalysts (Module B), applies chosen persona lenses (Module C), builds the
narrative, scenarios, and risk red-team, and assembles the paper + deck. Everything
cited.

### D.3 Indicative 45-min deck skeleton (comprehensive)
1. Cover / house view / conviction
2. Executive summary (the call)
3. Macro backdrop (growth, inflation, K-shape) — charts
4. Policy & regulatory landscape (Module A) — tech-skewed + macro, with market linkage
5. Monetary/fiscal/liquidity regime
6. Cross-asset & flows (Connect, margin, FX, rates, commodities)
7. Equity strategy: top-down sector allocation (tech/EV/battery/semi/AI/consumer)
8. Sector deep-dives (one per coverage theme, drivers + policy + valuation)
9. Single-name highlights (user-supplied + system-surfaced)
10. Scenarios (base/bull/bear) with probabilities
11. Investor-lens views (selected personas)
12. Risks / Devil's-advocate red-team
13. Catalysts & forward calendar
14. Appendix: data provenance, methodology, sources

### D.4 Model routing
- Heavy final synthesis (paper + deck narrative): Claude strongest (Opus), user-selectable.
- Cheaper passes (classification, policy tagging, scoring): Haiku/DeepSeek.
- All under the existing cost ceiling + audit trail.

---

## E. BUILD ORDER FOR PHASE 1 (once approved)

1. Sonar client + cost wiring + key check (Module B core).
2. Policy data model + channel registry + `/api/policy/*` + Sonar policy_scan (Module A backend).
3. Persona library dataset + lens/red-team functions (Module C, pure code, testable).
4. Policy Tracker frontend `/policy` (feed, lenses, market-linkage, timeline).
5. Wire policy + personas into the existing Brief engine.
6. Incremental commits/pushes; verify each on live Railway.

(Phases 2–5 — bottom-up equity, report engine, export, automation — proceed after,
per the agreed sequence. The deliverable engine in section D is Phase 3/4 but its data
contracts are fixed here so nothing needs reworking.)

---

## F. OPEN QUESTIONS FOR USER
1. Policy poll cadence: background daily scan ON or OFF by default? (cost vs freshness)
2. Policy Tracker: own nav group, or under DASHBOARD?
3. Persona red-team: which personas in the default bear panel? (proposed: Marks,
   Pettis, Collier, Druckenmiller)
4. Confirm Opus-class as default for final paper/deck synthesis (more expensive).
```
