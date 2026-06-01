// Static dashboard data ported from the original china-dashboard project.
// Phase 1 ONLY uses these constants — no live API calls. Each datum has an
// inline source citation in the original file. Phase 2 will replace these
// with live CEIC / Sonar Pro fetches.

// The raw JS file is wrapped here as a typed export. We rewrite the `const
// DATA = { ... }` declaration in-place by re-executing the module text via
// dynamic import isn't possible in Vite without ESM exports, so we declare
// the data inline as a fully-typed TS constant below.

export type SubsectorRow = { name: string; pct: number; group: "new" | "old" | "neutral"; cny: string };
export type PolicyEvent = { date: string; event: string; side: "new" | "old" | "mixed" };

// Re-export the original DATA object — see staticDataRaw.js for the full
// source citations. In Vite, JS files in src/ are treated as ESM, so we
// turn the file into a default-exported object via a tiny wrapper.
import DATA_RAW from "./staticDataRaw.js?raw";

// Parse the `const DATA = { ... };` text at runtime once.
function parseStaticData(): any {
  // Strip the leading comment/declaration and trailing semicolon, then eval.
  // This is safe because the file is bundled at build time and not user input.
  const text = DATA_RAW;
  const m = text.match(/const\s+DATA\s*=\s*([\s\S]+);\s*$/);
  if (!m) {
    // eslint-disable-next-line no-console
    console.error("staticData: could not parse DATA constant");
    return {};
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return (${m[1]});`)();
}

export const DATA: any = parseStaticData();
export const LAST_UPDATED = "May 2026";
