/**
 * Brand tokens for exported deliverables (Phase 4) — one source of truth for the
 * PDF, DOCX, and PPTX renderers so they look consistent. Neutral "China Monitor"
 * styling per the Phase 4 decision (no specific firm name).
 */

export const BRAND = {
  wordmark: "China Monitor",
  tagline: "Strategy & Outlook",
  // Core palette (hex, no leading # where libs prefer raw).
  colors: {
    ink: "1A1A2E",        // near-black headings
    body: "2B2B3A",       // body text
    muted: "6B7280",      // captions / secondary
    accent: "2563EB",     // primary accent (blue)
    accentSoft: "DBEAFE",
    positive: "059669",   // green
    negative: "DC2626",   // red
    warn: "D97706",       // amber
    line: "E5E7EB",       // hairline / borders
    panel: "F8FAFC",      // light panel fill
    white: "FFFFFF",
  },
  // Chart series palette (with #).
  chartPalette: [
    "#2563EB", "#059669", "#D97706", "#DC2626", "#7C3AED",
    "#0891B2", "#DB2777", "#65A30D", "#475569", "#EA580C",
  ],
  fonts: {
    // pdfmake uses Roboto (built-in); docx/pptx use system fonts.
    heading: "Helvetica",
    body: "Helvetica",
  },
} as const;

/** Map a directional/stance string to a brand color (with #). */
export function stanceColor(s: string): string {
  const v = (s || "").toLowerCase();
  if (["overweight", "long", "positive", "bullish", "supported"].some((k) => v.includes(k))) return "#059669";
  if (["underweight", "avoid", "negative", "bearish", "not_supported"].some((k) => v.includes(k))) return "#DC2626";
  if (["mixed", "partially", "watch", "cautious", "neutral"].some((k) => v.includes(k))) return "#D97706";
  return "#475569";
}

export const ASOF_FMT = (d: string) => d;
