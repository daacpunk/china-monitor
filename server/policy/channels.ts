/**
 * Official Chinese policy/regulatory source channels.
 *
 * The user supplied precise signal-bearing sub-pages + analyst tips. The alpha is
 * in the sub-pages (Exec Meeting readouts, OMO data, Policy Q&A, press-conference
 * tone) — NOT the homepages. Each channel stores:
 *   - listUrl   : the specific signal page to source from
 *   - signalHint: the analyst tip, injected into the LLM scoring prompt so
 *                 significance reflects the RIGHT signal
 *   - domain    : for Sonar search_domain_filter
 *
 * Full rationale: SPEC_PHASE1_POLICY_PERSONA_SONAR.md §A.1.
 */

export type PolicyCategory =
  | "monetary" | "fiscal" | "industrial" | "trade" | "tech" | "ai"
  | "data_security" | "antitrust" | "capital_markets" | "property"
  | "energy" | "ev" | "semiconductor" | "consumer" | "employment" | "fx";

export type CoverageTheme = "tech" | "ev" | "battery" | "semi" | "ai" | "consumer" | "macro";

export interface PolicyChannel {
  id: string;
  name: string;
  nameZh: string;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  domain: string;            // for Sonar search_domain_filter
  listUrl: string;           // SPECIFIC signal sub-page (not homepage)
  altUrls?: string[];
  signalHint: string;        // analyst tip → injected into scoring prompt
  watchTags?: string[];      // zh tags to filter on
  defaultCategories: PolicyCategory[];
  defaultThemes: CoverageTheme[];
}

export const POLICY_CHANNELS: PolicyChannel[] = [
  // ── Tier 1: Top-Level State Directives & Macro Planning ──
  {
    id: "state_council",
    name: "State Council",
    nameZh: "国务院",
    tier: 1,
    domain: "gov.cn",
    listUrl: "https://www.gov.cn/zhengce/",
    altUrls: ["https://www.gov.cn/yaowen/liebiao/gwyhy/index.htm"],
    signalHint:
      "Read State Council Executive Meeting readouts (~every Wednesday) — the most immediate, actionable translation of Politburo directives into specific administrative tasks. Flag stimulus, industrial policy, five-year-plan items.",
    watchTags: ["国务院常务会议"],
    defaultCategories: ["industrial", "fiscal"],
    defaultThemes: ["macro"],
  },
  {
    id: "xinhua_politics",
    name: "Xinhua (Politics)",
    nameZh: "新华社时政",
    tier: 1,
    domain: "news.cn",
    listUrl: "http://www.news.cn/politics/",
    signalHint:
      "CCP mouthpiece. Politburo meeting (中共中央政治局会议) and Central Economic Work Conference (中央经济工作会议) readouts publish HERE FIRST. Detect economic tone shifts, next-year priorities, growth-target language.",
    watchTags: ["中共中央政治局会议", "中央经济工作会议"],
    defaultCategories: ["industrial", "fiscal", "monetary"],
    defaultThemes: ["macro"],
  },

  // ── Tier 2: Monetary, Credit & FX ──
  {
    id: "pboc",
    name: "People's Bank of China",
    nameZh: "中国人民银行",
    tier: 2,
    domain: "pbc.gov.cn",
    listUrl: "http://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html",
    altUrls: ["http://www.pbc.gov.cn/zhengcehuobisi/125207/125213/index.html"],
    signalHint:
      "Don't just read news — the Data (数据统计) section's daily open market operations (公开市场业务交易公告) reveal daily liquidity management. Track LPR, RRR, MLF, reverse repos, net injection vs drain. This is the primary equity-liquidity driver.",
    defaultCategories: ["monetary", "fx"],
    defaultThemes: ["macro"],
  },
  {
    id: "safe",
    name: "State Administration of Foreign Exchange",
    nameZh: "国家外汇管理局",
    tier: 2,
    domain: "safe.gov.cn",
    listUrl: "https://www.safe.gov.cn/safe/xwdt/index.html",
    signalHint:
      "Watch the Policy Q&A (政策问答) section — SAFE uses it to subtly signal loosening/tightening of capital controls before formal regulation. Track FX reserves, cross-border capital flows.",
    defaultCategories: ["fx", "capital_markets"],
    defaultThemes: ["macro"],
  },

  // ── Tier 3: Fiscal, Industrial Planning & Pricing ──
  {
    id: "mof",
    name: "Ministry of Finance",
    nameZh: "财政部",
    tier: 3,
    domain: "mof.gov.cn",
    listUrl: "http://www.mof.gov.cn/zhengwuxinxi/caizhengxinwen/",
    signalHint:
      "Track monthly revenue/expenditure press conferences (财政收支情况新闻发布会) — critical for gauging the ACTUAL impact of fiscal stimulus (local-govt special-purpose bonds, tax rebates, subsidies), not just the announced intent.",
    defaultCategories: ["fiscal"],
    defaultThemes: ["macro"],
  },
  {
    id: "ndrc",
    name: "National Development and Reform Commission",
    nameZh: "国家发展和改革委员会",
    tier: 3,
    domain: "ndrc.gov.cn",
    listUrl: "https://www.ndrc.gov.cn/xxgk/zcfb/",
    altUrls: ["https://www.ndrc.gov.cn/xwdt/xwfb/"],
    signalHint:
      "The 'mini-State Council'. Monthly press conferences signal whether they'll accelerate approval of fixed-asset investment (固定资产投资) projects to underpin (托底) growth. Also sets pricing of oil/gas/electricity.",
    defaultCategories: ["industrial", "fiscal", "energy"],
    defaultThemes: ["macro", "ev", "battery"],
  },

  // ── Tier 4: Capital Markets & Securities ──
  {
    id: "csrc",
    name: "China Securities Regulatory Commission",
    nameZh: "中国证券监督管理委员会",
    tier: 4,
    domain: "csrc.gov.cn",
    listUrl: "http://www.csrc.gov.cn/csrc/c100028/common_list.shtml",
    signalHint:
      "Watch Media Briefings (证监会新闻发布会): spokesperson TONE signals the regime — warning of 'blind speculation' (盲目炒作 = worried about overheating) vs encouraging 'long-term capital' to enter (= worried about panic, supportive). Covers IPO registration pacing, short-selling rules, dividend mandates, 'National Team' interventions.",
    defaultCategories: ["capital_markets"],
    defaultThemes: ["macro"],
  },

  // ── Tier 5: Sector / Technology Regulators (tech-skewed) ──
  {
    id: "miit",
    name: "Ministry of Industry and Information Technology",
    nameZh: "工业和信息化部",
    tier: 5,
    domain: "miit.gov.cn",
    listUrl: "https://www.miit.gov.cn/jgsj/index.html",
    signalHint:
      "Core tech/industrial regulator. Watch for semiconductor, EV/auto, telecom, and AI-infrastructure industrial policy, subsidies, production targets, and standards.",
    defaultCategories: ["tech", "industrial", "semiconductor", "ev"],
    defaultThemes: ["tech", "semi", "ev", "battery", "ai"],
  },
  {
    id: "cac",
    name: "Cyberspace Administration of China",
    nameZh: "国家互联网信息办公室",
    tier: 5,
    domain: "cac.gov.cn",
    listUrl: "https://www.cac.gov.cn/xxfb.htm",
    signalHint:
      "Data/cybersecurity + platform/internet + AI governance regulator. Watch for generative-AI rules, data-security/cross-border data rules, platform-economy moves — directly impacts internet/AI equities.",
    defaultCategories: ["data_security", "tech", "ai", "antitrust"],
    defaultThemes: ["tech", "ai", "consumer"],
  },
  {
    id: "most",
    name: "Ministry of Science and Technology",
    nameZh: "科学技术部",
    tier: 5,
    domain: "most.gov.cn",
    listUrl: "https://www.most.gov.cn/xinxgk/index.html",
    signalHint:
      "Sci-tech innovation, R&D priorities, 'new quality productive forces' (新质生产力). Signals national tech-investment direction (AI, quantum, biotech, semis).",
    defaultCategories: ["tech", "industrial", "ai"],
    defaultThemes: ["tech", "ai", "semi"],
  },
  {
    id: "samr",
    name: "State Administration for Market Regulation",
    nameZh: "国家市场监督管理总局",
    tier: 5,
    domain: "samr.gov.cn",
    listUrl: "https://www.samr.gov.cn/xw/zj/index.html",
    signalHint:
      "Antitrust, platform regulation, M&A merger review. Watch for platform-economy enforcement vs relaxation — swings internet/consumer equity sentiment sharply.",
    defaultCategories: ["antitrust", "consumer", "tech"],
    defaultThemes: ["tech", "consumer"],
  },
  {
    id: "mofcom",
    name: "Ministry of Commerce",
    nameZh: "商务部",
    tier: 5,
    domain: "mofcom.gov.cn",
    listUrl: "http://www.mofcom.gov.cn/xwfb/index.html",
    signalHint:
      "Trade, export controls (incl. rare earths / semis materials), FDI, outbound investment rules. Watch US-China trade measures and retaliation — key geopolitical catalyst for semis/tech.",
    defaultCategories: ["trade", "semiconductor", "industrial"],
    defaultThemes: ["semi", "tech", "ev"],
  },
  {
    id: "nea",
    name: "National Energy Administration",
    nameZh: "国家能源局",
    tier: 5,
    domain: "nea.gov.cn",
    listUrl: "https://www.nea.gov.cn/xwzx/yaowen.htm",
    signalHint:
      "Energy/power/renewables/battery policy. Watch power pricing, grid build-out, solar/wind/storage targets — drives battery and clean-energy equities, and power-cost inputs for AI data centers.",
    defaultCategories: ["energy", "industrial"],
    defaultThemes: ["battery", "ev", "ai"],
  },
  {
    id: "nfra",
    name: "National Financial Regulatory Administration",
    nameZh: "国家金融监督管理总局",
    tier: 5,
    domain: "nfra.gov.cn",
    listUrl: "https://www.nfra.gov.cn/cn/view/pages/index/index.html",
    signalHint:
      "Banking/insurance regulator (ex-securities). Watch financial-risk, property-financing, and bank-lending guidance — bears on property and financial-sector equities.",
    defaultCategories: ["capital_markets", "property", "fiscal"],
    defaultThemes: ["macro"],
  },
];

export const CHANNELS_BY_ID: Record<string, PolicyChannel> = Object.fromEntries(
  POLICY_CHANNELS.map((c) => [c.id, c]),
);

/** All coverage themes the user tracks. */
export const COVERAGE_THEMES: CoverageTheme[] = [
  "tech", "ev", "battery", "semi", "ai", "consumer", "macro",
];

/** Channels most relevant to the tech-skewed default lens. */
export const TECH_CHANNEL_IDS = ["miit", "cac", "most", "samr", "mofcom", "nea"];
