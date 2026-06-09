/**
 * Sector universe — Phase 2 bottom-up equity layer.
 *
 * Curated map of the 6 coverage themes -> constituent single names (A-share + HK).
 * The top-down -> bottom-up bridge: each theme carries index proxies + structural/
 * policy drivers; each name carries a role and a one-line thesis hook.
 *
 * Version-controlled and easily editable. Names may appear under multiple themes
 * (e.g. BYD in both EV and battery; Tencent/Alibaba in tech and AI).
 * Markets: A-share (6-digit) + HK (5-digit). Per user decision, ~6-8 names/theme.
 *
 * Shared shape with the client via /api/equity/universe.
 */

export type CoverageTheme = "tech" | "ev" | "battery" | "semi" | "ai" | "consumer";
export type EquityMarket = "ashare" | "hk";
export type NameRole = "leader" | "challenger" | "supplier" | "platform";

export interface SectorName {
  symbol: string;          // A-share 6-digit (e.g. 688981) or HK 5-digit (e.g. 00700)
  market: EquityMarket;
  nameEn: string;
  nameZh: string;
  role: NameRole;
  thesis: string;          // one-line hook
}

export interface SectorTheme {
  id: CoverageTheme;
  label: string;
  indexProxies: string[];  // series ids this theme tracks (from the registry)
  drivers: string[];       // structural + policy drivers
  names: SectorName[];
}

export const SECTOR_UNIVERSE: SectorTheme[] = [
  {
    id: "semi",
    label: "Semiconductors",
    indexProxies: ["star50_close", "chinext_close"],
    drivers: [
      "Domestic substitution / self-sufficiency push under export controls",
      "AI-driven demand for advanced logic + HBM/memory",
      "Big Fund III capital + MIIT/MOST industrial policy",
      "US-China export-control escalation risk (MOFCOM retaliation)",
    ],
    names: [
      { symbol: "688981", market: "ashare", nameEn: "SMIC", nameZh: "中芯国际", role: "leader", thesis: "China's flagship foundry; capacity build-out + localization beneficiary" },
      { symbol: "688347", market: "ashare", nameEn: "Hua Hong Semi", nameZh: "华虹公司", role: "challenger", thesis: "Mature-node foundry; auto/industrial + localization demand" },
      { symbol: "002371", market: "ashare", nameEn: "NAURA", nameZh: "北方华创", role: "supplier", thesis: "Leading domestic semi equipment maker; localization tailwind" },
      { symbol: "688012", market: "ashare", nameEn: "AMEC", nameZh: "中微公司", role: "supplier", thesis: "Etch equipment leader; advanced-node tool localization" },
      { symbol: "688256", market: "ashare", nameEn: "Cambricon", nameZh: "寒武纪", role: "leader", thesis: "Domestic AI-chip pure play; Huawei-alternative narrative" },
      { symbol: "603501", market: "ashare", nameEn: "Will Semiconductor", nameZh: "韦尔股份", role: "supplier", thesis: "CIS leader; smartphone + auto imaging recovery" },
      { symbol: "688008", market: "ashare", nameEn: "Montage Technology", nameZh: "澜起科技", role: "supplier", thesis: "Memory interface / DDR5 + AI server content growth" },
    ],
  },
  {
    id: "ai",
    label: "AI & Software",
    indexProxies: ["chinext_close", "star50_close", "hsi_close"],
    drivers: [
      "Domestic LLM race (DeepSeek/Qwen/etc.) + inference demand",
      "AI capex cycle (data centers, compute) vs power/chip constraints",
      "CAC generative-AI governance; MOST 'new productive forces' priority",
      "Monetization timing for platform AI",
    ],
    names: [
      { symbol: "00700", market: "hk", nameEn: "Tencent", nameZh: "腾讯", role: "platform", thesis: "AI in ads/games/cloud; Hunyuan model; cash-rich platform" },
      { symbol: "09988", market: "hk", nameEn: "Alibaba", nameZh: "阿里巴巴", role: "platform", thesis: "Qwen models + cloud AI capex leader; valuation re-rating" },
      { symbol: "09888", market: "hk", nameEn: "Baidu", nameZh: "百度", role: "platform", thesis: "Ernie LLM + AI cloud; autonomous driving optionality" },
      { symbol: "002230", market: "ashare", nameEn: "iFlytek", nameZh: "科大讯飞", role: "leader", thesis: "Speech/LLM pure play; domestic-compute aligned" },
      { symbol: "688256", market: "ashare", nameEn: "Cambricon", nameZh: "寒武纪", role: "supplier", thesis: "AI accelerator silicon for the domestic stack" },
      { symbol: "00020", market: "hk", nameEn: "SenseTime", nameZh: "商汤", role: "challenger", thesis: "Computer-vision + generative AI; infra build-out" },
      { symbol: "03888", market: "hk", nameEn: "Kingsoft", nameZh: "金山软件", role: "challenger", thesis: "Office software + WPS AI features; cloud arm" },
    ],
  },
  {
    id: "ev",
    label: "Electric Vehicles",
    indexProxies: ["csi300_close", "hsi_close"],
    drivers: [
      "Price-war intensity vs margin discipline (capital-destructive competition risk)",
      "NEV penetration + trade-in/consumption-stimulus subsidies",
      "Export expansion vs EU/US tariffs (MOFCOM)",
      "Smart-driving / ADAS as the next differentiation axis",
    ],
    names: [
      { symbol: "002594", market: "ashare", nameEn: "BYD", nameZh: "比亚迪", role: "leader", thesis: "Vertically integrated NEV + battery leader; export ramp" },
      { symbol: "02015", market: "hk", nameEn: "Li Auto", nameZh: "理想汽车", role: "challenger", thesis: "EREV profitability leader among new-force OEMs" },
      { symbol: "09868", market: "hk", nameEn: "XPeng", nameZh: "小鹏汽车", role: "challenger", thesis: "ADAS/smart-driving tech focus; volume inflection" },
      { symbol: "09866", market: "hk", nameEn: "NIO", nameZh: "蔚来", role: "challenger", thesis: "Premium BEV + battery-swap; margin recovery watch" },
      { symbol: "00175", market: "hk", nameEn: "Geely", nameZh: "吉利汽车", role: "leader", thesis: "Multi-brand NEV transition; Zeekr/Lynk premiumization" },
      { symbol: "601127", market: "ashare", nameEn: "Seres", nameZh: "赛力斯", role: "challenger", thesis: "Huawei AITO partnership; premium NEV ramp" },
      { symbol: "601633", market: "ashare", nameEn: "Great Wall Motor", nameZh: "长城汽车", role: "challenger", thesis: "SUV/pickup + export; NEV catch-up" },
    ],
  },
  {
    id: "battery",
    label: "Batteries & Materials",
    indexProxies: ["chinext_close", "csi300_close"],
    drivers: [
      "Global EV + energy-storage (ESS) demand cycle",
      "Lithium price cycle (margin swing for materials)",
      "Overcapacity / utilization vs next-gen (solid-state, sodium-ion)",
      "NEA energy-storage targets; grid build-out",
    ],
    names: [
      { symbol: "300750", market: "ashare", nameEn: "CATL", nameZh: "宁德时代", role: "leader", thesis: "Global battery #1; ESS + tech leadership; HK listing optionality" },
      { symbol: "300014", market: "ashare", nameEn: "EVE Energy", nameZh: "亿纬锂能", role: "challenger", thesis: "Diversified cells; ESS + cylindrical growth" },
      { symbol: "002074", market: "ashare", nameEn: "Gotion High-Tech", nameZh: "国轩高科", role: "challenger", thesis: "VW-backed; LFP + overseas expansion" },
      { symbol: "300207", market: "ashare", nameEn: "Sunwoda", nameZh: "欣旺达", role: "supplier", thesis: "Consumer + EV cells; fast-charge tech" },
      { symbol: "002460", market: "ashare", nameEn: "Ganfeng Lithium", nameZh: "赣锋锂业", role: "supplier", thesis: "Lithium resources/refining; price-cycle leverage" },
      { symbol: "002466", market: "ashare", nameEn: "Tianqi Lithium", nameZh: "天齐锂业", role: "supplier", thesis: "Upstream lithium; SQM stake; cycle leverage" },
      { symbol: "03931", market: "hk", nameEn: "CALB", nameZh: "中创新航", role: "challenger", thesis: "#3 China battery maker; capacity scale-up" },
    ],
  },
  {
    id: "tech",
    label: "Tech Platforms & Hardware",
    indexProxies: ["hsi_close", "csi300_close"],
    drivers: [
      "Platform-economy regulation cycle (SAMR antitrust vs relaxation)",
      "Consumer-electronics / smartphone replacement + AI-device cycle",
      "Supply-chain localization + hardware content growth",
      "Shareholder returns (buybacks/dividends) re-rating HK tech",
    ],
    names: [
      { symbol: "00700", market: "hk", nameEn: "Tencent", nameZh: "腾讯", role: "platform", thesis: "Games + ads + fintech + AI; capital returns" },
      { symbol: "09988", market: "hk", nameEn: "Alibaba", nameZh: "阿里巴巴", role: "platform", thesis: "E-commerce + cloud; restructuring + buybacks" },
      { symbol: "03690", market: "hk", nameEn: "Meituan", nameZh: "美团", role: "platform", thesis: "Local-services leader; competition vs margin watch" },
      { symbol: "01810", market: "hk", nameEn: "Xiaomi", nameZh: "小米集团", role: "leader", thesis: "Smartphones + IoT + EV (SU7) optionality" },
      { symbol: "00992", market: "hk", nameEn: "Lenovo", nameZh: "联想集团", role: "leader", thesis: "PC recovery + AI-server (ISG) growth" },
      { symbol: "002475", market: "ashare", nameEn: "Luxshare Precision", nameZh: "立讯精密", role: "supplier", thesis: "Apple supply chain + AI-hardware/connectivity content" },
      { symbol: "601138", market: "ashare", nameEn: "Foxconn Industrial (FII)", nameZh: "工业富联", role: "supplier", thesis: "AI server / cloud-infra contract manufacturing leader" },
    ],
  },
  {
    id: "consumer",
    label: "Consumer",
    indexProxies: ["csi300_close", "hsi_close"],
    drivers: [
      "Consumption recovery vs weak confidence (Pettis rebalancing watch)",
      "Trade-in / consumption-stimulus policy transmission",
      "Premiumization + brand power vs trade-down",
      "Property-wealth-effect drag on big-ticket spend",
    ],
    names: [
      { symbol: "600519", market: "ashare", nameEn: "Kweichow Moutai", nameZh: "贵州茅台", role: "leader", thesis: "Premium baijiu bellwether; pricing power + dividends" },
      { symbol: "000858", market: "ashare", nameEn: "Wuliangye", nameZh: "五粮液", role: "challenger", thesis: "#2 premium baijiu; valuation + payout" },
      { symbol: "000333", market: "ashare", nameEn: "Midea Group", nameZh: "美的集团", role: "leader", thesis: "Appliance leader; export + B2B + HK listing" },
      { symbol: "06690", market: "hk", nameEn: "Haier Smart Home", nameZh: "海尔智家", role: "leader", thesis: "Global appliance brand; trade-in beneficiary" },
      { symbol: "02020", market: "hk", nameEn: "Anta Sports", nameZh: "安踏体育", role: "leader", thesis: "Multi-brand sportswear leader (Fila/Amer); premiumization" },
      { symbol: "09633", market: "hk", nameEn: "Nongfu Spring", nameZh: "农夫山泉", role: "leader", thesis: "Bottled water + beverages; brand strength" },
      { symbol: "02319", market: "hk", nameEn: "Mengniu Dairy", nameZh: "蒙牛乳业", role: "challenger", thesis: "Dairy demand recovery; margin normalization" },
    ],
  },
];

export const THEMES_BY_ID: Record<string, SectorTheme> = Object.fromEntries(
  SECTOR_UNIVERSE.map((t) => [t.id, t]),
);

/** Flat unique list of all covered names (dedup by symbol+market). */
export function allNames(): SectorName[] {
  const seen = new Set<string>();
  const out: SectorName[] = [];
  for (const t of SECTOR_UNIVERSE) {
    for (const n of t.names) {
      const key = `${n.market}:${n.symbol}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(n);
      }
    }
  }
  return out;
}
