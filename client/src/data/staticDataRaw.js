// =================================================================
// CHINA OLD vs NEW ECONOMY DASHBOARD — DATA LAYER
// All figures sourced from NBS China, PBOC, IMF, Goldman Sachs,
// Morgan Stanley, Carbon Brief/CREA, HKEX, SSE, Caixin, Reuters,
// and broker research. Inline source URLs preserved for each datum.
// Last update: May 2026
// =================================================================

const DATA = {
  // ───────────────────────── FAI Growth (Top-line YoY %) ─────────────────────────
  fai: {
    years: ['2020', '2021', '2022', '2023', '2024', '2025', '2026Q1'],
    series: {
      total:          [2.9,  4.9,  5.1,  3.0,  3.2,  -3.8, 1.7],
      realEstate:     [7.0,  4.4, -10.0, -9.6, -10.6, -17.2, -11.2],
      infrastructure: [3.8,  0.4,  9.4,  5.9,  4.4,  -2.2, 8.9],
      manufacturing: [7.3, 13.5,  9.1,  6.5,  9.2,   0.6, 4.1],
      highTech:      [null, null, 22.2, null, 10.2,  9.4, 6.1]
    },
    sources: {
      total:          'NBS / Xinhua Jan 2026 — http://english.scio.gov.cn/pressroom/2026-01/19/content_118287513.htm',
      realEstate:     'NBS press releases 2020-2025',
      infrastructure: 'NBS / State Council Apr 2026',
      manufacturing: 'NBS FAI 2024-2025 press releases',
      highTech:      'Xinhua Mar 2026 / Global Times May 2026'
    }
  },

  // ────────────────────── Subsector FAI growth 2025 ──────────────────────
  subsectorFAI: [
    { name: 'Offshore wind',             pct:  98, group: 'new', cny: 'RMB 96 bn' },
    { name: 'EV charging infra',         pct:  58, group: 'new', cny: 'RMB 192 bn' },
    { name: 'Grid battery storage',      pct:  50, group: 'new', cny: 'RMB 232 bn' },
    { name: 'Onshore wind',              pct:  47, group: 'new', cny: 'RMB 612 bn' },
    { name: 'Battery manufacturing',     pct:  35, group: 'new', cny: 'RMB 277 bn' },
    { name: 'Information services',      pct:  28.4, group: 'new', cny: '—' },
    { name: 'Computer & office mfg (Q1)', pct: 28.5, group: 'new', cny: '—' },
    { name: 'Semiconductors (capex)',    pct:  19, group: 'new', cny: '~$30 bn WFE' },
    { name: 'EV manufacturing',          pct:  18, group: 'new', cny: 'RMB 1.6 tn' },
    { name: 'Aerospace mfg',             pct:  17, group: 'new', cny: '—' },
    { name: 'Solar PV (generation)',     pct:  15, group: 'new', cny: 'RMB 1.18 tn' },
    { name: 'High-tech mfg (overall)',   pct:   9.4, group: 'new', cny: '—' },
    { name: 'Total FAI',                 pct:  -3.8, group: 'neutral', cny: 'RMB 48.5 tn' },
    { name: 'Infrastructure',            pct:  -2.2, group: 'old', cny: '—' },
    { name: 'Solar PV (mfg capacity)',   pct: -23, group: 'new', cny: 'RMB 506 bn (anti-involution)' },
    { name: 'Real estate',               pct: -17.2, group: 'old', cny: 'RMB 8.28 tn' }
  ],

  // ────────────────────── GDP shares (% of GDP) ──────────────────────
  gdpShares: {
    years: ['2020', '2021', '2022', '2023', '2024', '2025'],
    series: {
      realEstateNarrow:  [8.0, 7.7, 7.0, 6.8, 6.27, 5.5],
      realEstateBroad:   [24.0, 23.5, 21.0, 20.0, 19.0, 17.0],
      cleanEnergy:       [null, null, 7.3, 9.5, 10.0, 11.4],
      digitalEconomy:    [7.8, 8.0, 8.5, 9.5, 10.5, 11.5],
      construction:      [7.0, 7.0, 7.0, 6.8, 6.5, 6.0]
    }
  },

  // Clean energy contribution to GDP growth
  cleanEnergyContrib: {
    years: ['2023', '2024', '2025'],
    value: [11.58, 13.01, 15.41], // RMB tn
    growthShare: [40, 25, 37] // % of total GDP growth contributed
  },

  // ────────────────────── Fiscal & monetary support ──────────────────────
  fiscalSupport: {
    items: [
      { label: 'Local govt SPBs',                bucket: 'mixed', y2024: 3900, y2025: 4400, y2026: 4400, unit: 'RMB bn' },
      { label: 'Ultra-long STBs',                bucket: 'new',   y2024: 1000, y2025: 1300, y2026: 800,  unit: 'RMB bn' },
      { label: 'Policy bank infra lending',      bucket: 'old',   y2024:  500, y2025:  500, y2026: 800,  unit: 'RMB bn' },
      { label: 'PBOC tech re-lending',           bucket: 'new',   y2024:  500, y2025:  800, y2026: 800,  unit: 'RMB bn' },
      { label: 'PBOC green/carbon re-lending',   bucket: 'new',   y2024:    0, y2025:    0, y2026: 800,  unit: 'RMB bn/yr' },
      { label: 'National VC guidance fund',      bucket: 'new',   y2024:    0, y2025: 1000, y2026: 1000, unit: 'RMB bn (target)' },
      { label: 'Property whitelist (cumul.)',    bucket: 'old',   y2024: 2230, y2025: 5600, y2026: 5600, unit: 'RMB bn approved' },
      { label: 'Affordable housing re-lending',  bucket: 'old',   y2024:  300, y2025:  300, y2026: 300,  unit: 'RMB bn (5% utilized)' },
      { label: 'Semi Big Fund III',              bucket: 'new',   y2024:  344, y2025:  344, y2026: 344,  unit: 'RMB bn' },
      { label: 'Consumer trade-in subsidy',      bucket: 'mixed', y2024:  150, y2025:  300, y2026: 300,  unit: 'RMB bn' }
    ]
  },

  // ────────────────────── A-share index performance ──────────────────────
  aShareReturns: {
    years: ['2020', '2021', '2022', '2023', '2024', '2025'],
    series: {
      csi300:       [29.0,  -4.1, -21.6, -11.4, 14.7, 17.7],
      chiNext:      [64.96, 12.0, -29.4, -19.4, -2.9, 18.0],
      star50:       [null, null, -31.4, -23.8, 22.3, 35.0], // 2025 approx; STAR 50 outperformed
      sseComposite: [13.9,  4.8, -15.1, -3.7, 12.7, 14.6]
    }
  },

  aShareValuation: [
    { metric: 'CSI 300 trailing P/E',       value: '12.9×',  date: 'Jun 2025' },
    { metric: 'CSI 300 forward P/E',        value: '13.9×',  date: 'End-2025' },
    { metric: 'CSI 300 current P/E',        value: '14.7×',  date: 'May 2026' },
    { metric: 'SSE Composite trailing P/E', value: '9.52×',  date: 'May 2026' },
    { metric: 'SSE 5-yr avg P/E',           value: '10.10×', date: 'Historical' },
    { metric: 'S&P 500 forward P/E (ref)',  value: '~22×',   date: 'End-2025' }
  ],

  stockConnect: {
    metrics: [
      { metric: 'Northbound ADT',          y2024: 'RMB 150.1 bn', y2025: 'RMB 212.4 bn',  delta: '+42%' },
      { metric: 'Southbound ADT',          y2024: 'HK$48.2 bn',   y2025: 'HK$121.1 bn',    delta: '+151%' },
      { metric: 'Southbound share of HK',  y2024: '20.9%',         y2025: '23.0%',          delta: '+2.1 pp' },
      { metric: 'Northbound ETF ADT',      y2024: '—',             y2025: 'RMB 3.4 bn',     delta: '+72%' },
      { metric: 'Southbound ETF ADT',      y2024: '—',             y2025: 'HK$3.9 bn',      delta: '+62%' }
    ],
    sectorFocus: 'Northbound: new energy, tech, semis, healthcare. Southbound: tech, internet, semis, biotech, new consumption.'
  },

  // ────────────────────── GDP forecasts 2026-2027 ──────────────────────
  gdpForecasts: [
    { institution: 'IMF (Apr 2026 WEO)',    y2025: 5.0, y2026: 4.4, y2027: 4.0 },
    { institution: 'World Bank',            y2025: 5.0, y2026: 4.5, y2027: 4.0 },
    { institution: 'Goldman Sachs',         y2025: 5.0, y2026: 4.8, y2027: 4.7 },
    { institution: 'Morgan Stanley',        y2025: 5.0, y2026: 4.8, y2027: 4.7 },
    { institution: 'Beijing official',      y2025: 5.0, y2026: 4.75, y2027: null },
    { institution: 'Bloomberg consensus',   y2025: 5.0, y2026: 4.55, y2027: null }
  ],

  // ────────────────────── K-SHAPED DIVERGENCE ──────────────────────
  industrialProduction: {
    new: [
      { name: 'Power gen equipment',     y2024: 16.0, y2025: 37.6 },
      { name: '3D printing',             y2024: 11.3, y2025: 52.5 },
      { name: 'Industrial robots',       y2024: 14.2, y2025: 28.0 },
      { name: 'New energy vehicles',     y2024: 38.7, y2025: 25.1 },
      { name: 'Integrated circuits',     y2024: 22.2, y2025: 10.9 },
      { name: 'Solar cells (PV)',        y2024: 15.7, y2025:  7.6 },
      { name: 'High-tech mfg (aggr.)',   y2024:  8.9, y2025:  9.4 },
      { name: 'Equipment mfg (aggr.)',   y2024:  7.7, y2025:  9.2 },
      { name: 'Rail/ship/aerospace',     y2024: null, y2025: 14.0 }
    ],
    old: [
      { name: 'Mfg sector (total)',      y2024:  6.1, y2025:  6.4 },
      { name: 'Total industrial VA',     y2024:  5.8, y2025:  5.9 },
      { name: 'Rolled steel',            y2024:  1.1, y2025:  3.1 },
      { name: 'Motor vehicles (all)',    y2024:  4.8, y2025:  9.8 },
      { name: 'Crude steel',             y2024: -1.7, y2025: -4.4 },
      { name: 'Cement',                  y2024: -9.5, y2025: -6.9 }
    ]
  },

  // Corporate earnings — named companies
  companies: {
    new: [
      { name: 'CATL',         ticker: '300750',  rev: 'RMB 362bn',  np: 'RMB 50.7bn',  npGr: '+15%',   gm: '24.4%', note: 'Q3 2024 record 31.17% GM; FY25 NP +42%' },
      { name: 'CATL FY2025',  ticker: '300750',  rev: 'RMB 423.7bn', np: 'RMB 72.2bn', npGr: '+42%',   gm: '26.27%', note: 'Beat despite cooling EV demand' },
      { name: 'BYD',          ticker: '002594',  rev: 'RMB 777bn',  np: 'RMB 40.3bn',  npGr: '+34%',   gm: 'n/a',   note: 'NEV volume leader; FY24 results' },
      { name: 'SMIC',         ticker: '688981',  rev: 'USD 8.03bn', np: 'USD 493M',    npGr: '-45.4%', gm: '18.0%', note: 'Record rev but GM down from 38% (2022); capex USD 7.33bn' },
      { name: 'Cambricon',    ticker: '688256',  rev: 'RMB 1.2bn',  np: 'RMB -452M',   npGr: 'L→P',    gm: 'n/a',   note: 'FY25: NP RMB 2.1bn (first-ever profit, AI chip demand)' },
      { name: 'CXMT (DRAM)',  ticker: 'unlisted', rev: 'USD 8bn',   np: 'n/a',         npGr: '+130%',  gm: 'n/a',   note: 'Benefits from US curbs on Samsung HBM' },
      { name: 'Hua Hong Semi', ticker: '688347', rev: 'USD 2bn',    np: 'USD 58M',     npGr: '-79.2%', gm: 'n/a',   note: 'Mature node foundry; price war' }
    ],
    old: [
      { name: 'Vanke',          ticker: '000002', rev: 'RMB 233bn (-32%)', np: 'RMB -49.5bn', npGr: 'First loss since IPO', gm: '~0%',  note: 'FY25 projected loss RMB 82bn' },
      { name: 'Country Garden', ticker: '2007.HK', rev: 'n/a',              np: 'RMB -32.8bn', npGr: 'Loss',                  gm: '~0%',  note: 'Default 2023; ongoing restructuring' },
      { name: 'Anhui Conch',    ticker: '914.HK', rev: 'RMB 91bn (-35.5%)', np: 'RMB 7.70bn',  npGr: '-26.2%',                gm: '24.5%', note: 'China most efficient cement; ROE 4.14%' },
      { name: 'Baoshan Steel',  ticker: '600019', rev: '-7% YoY',            np: 'n/a',         npGr: '-38.4%',                gm: 'n/a',  note: 'Q3 2024 NP -65% YoY' },
      { name: 'Ansteel',        ticker: '000898', rev: 'n/a',                np: 'USD -1bn',    npGr: 'Loss',                  gm: 'n/a',  note: 'Lossmaker; SOE consolidation candidate' },
      { name: 'A-share property (74 cos)', ticker: '—', rev: 'n/a',          np: 'RMB -240bn',  npGr: 'Aggregate loss',        gm: '~1%', note: 'Top 10 = >80% of losses' }
    ]
  },

  roeMargin: [
    { entity: 'CATL (FY25 GM)',                value: 26.3, type: 'gross', group: 'new' },
    { entity: 'Anhui Conch (FY24 GM)',         value: 24.5, type: 'gross', group: 'old' },
    { entity: 'SMIC (FY24 GM)',                value: 18.0, type: 'gross', group: 'new' },
    { entity: 'SMIC (FY22 GM ref)',            value: 38.0, type: 'gross', group: 'reference' },
    { entity: 'Conch ROE',                     value:  4.14, type: 'roe',   group: 'old' },
    { entity: 'Auto industry (FY24 margin)',   value:  4.3, type: 'roe',   group: 'old' },
    { entity: 'Auto industry (Dec-25 margin)', value:  1.8, type: 'roe',   group: 'old' },
    { entity: 'Top 100 property (net margin)', value:  1.1, type: 'roe',   group: 'old' },
    { entity: 'Top 100 property (ROE)',        value:  0.3, type: 'roe',   group: 'old' }
  ],

  // PPI by sector
  ppi: {
    years: ['2024', '2025'],
    sectors: [
      { name: 'Ferrous metals (steel)',          y2024: -6.4, y2025: -7.7, group: 'old' },
      { name: 'Non-metallic (cement/glass)',     y2024: -7.2, y2025: -4.4, group: 'old' },
      { name: 'Raw chemicals',                   y2024: -3.8, y2025: -4.9, group: 'old' },
      { name: 'Chemical fibers',                 y2024:  0.2, y2025: -6.9, group: 'old' },
      { name: 'Automobiles',                     y2024: -1.9, y2025: -2.8, group: 'mixed' },
      { name: 'Textiles',                        y2024: -0.9, y2025: -2.3, group: 'old' },
      { name: 'Computers/comms/electronics',     y2024: -2.4, y2025: -2.2, group: 'new' },
      { name: 'Non-ferrous smelting',            y2024:  5.4, y2025:  6.3, group: 'new' },
      { name: 'Non-ferrous mining (battery met.)',y2024: 11.6, y2025: 17.2, group: 'new' },
      { name: 'Overall PPI',                     y2024: -2.2, y2025: -2.6, group: 'neutral' }
    ]
  },

  // Property indicators
  property: {
    metrics: [
      { metric: 'Real estate investment',    y2024: '-10.6%',  y2025: '-17.2%' },
      { metric: 'New starts (floor area)',   y2024: '-23.0%',  y2025: '-20.4%' },
      { metric: 'Completions (floor area)',  y2024: '-27.7%',  y2025: '-18.1%' },
      { metric: 'Sold area',                 y2024: '-12.9%',  y2025: '-8.7%' },
      { metric: 'Sold value',                y2024: '-17.1%',  y2025: '-12.6%' },
      { metric: 'Inventory (unsold)',        y2024: '+18.0%',  y2025: '+6.6%' }
    ],
    homePricesFromPeak: -50,
    zombieShareRE: 40,    // % of RE bank loans to "zombie firms"
    zombieShareOverall: 16
  },

  // EV margin collapse timeline
  evMargin: {
    years: ['FY2014', 'FY2024', 'Q1-25', 'FY2025', 'Dec-25', 'Q1-26'],
    margin: [9.0, 4.3, 3.9, 4.1, 1.8, 3.2],
    note: 'Dec 2025 = record single-month low. CATL maintained ~26% GM throughout.'
  },

  // 15FYP / Policy
  policyTimeline: [
    { date: 'May 2024',  event: 'PBOC affordable housing re-lending RMB 300bn launched',                   side: 'old' },
    { date: 'Oct 2024',  event: 'Property whitelist credit line doubled to RMB 4.0tn',                     side: 'old' },
    { date: 'Mar 2025',  event: 'Two Sessions: deficit ratio raised to 4%, SPBs RMB 4.4tn, STBs RMB 1.3tn', side: 'mixed' },
    { date: 'May 2025',  event: 'PBOC tech re-lending expanded to RMB 800bn',                              side: 'new' },
    { date: 'Jul 2025',  event: 'Politburo: "anti-involution" crackdown on EV/battery/solar overcapacity', side: 'new' },
    { date: 'Oct 2025',  event: 'Anti-involution 2-year plans for 10 industries published',                side: 'mixed' },
    { date: 'Jan 2026',  event: 'PBOC green/carbon re-lending up to RMB 800bn/yr launched',                side: 'new' },
    { date: 'Mar 2026',  event: '15th Five-Year Plan: AI, telecom, space-net, green as core pillars',      side: 'new' },
    { date: 'Mar 2026',  event: 'GDP target lowered to 4.5–5%; real estate downgraded to secondary',       side: 'mixed' },
    { date: 'Apr 2026',  event: 'PPI turns positive — first in 41 months',                                 side: 'mixed' }
  ]
};
