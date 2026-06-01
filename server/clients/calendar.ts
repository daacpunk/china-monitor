/**
 * Macro release calendar — hard-coded schedule for Chinese macro indicators.
 *
 * Release timing based on official NBS/PBOC/Customs practices:
 * - NBS PMI: last day of reference month (usually 30th/31st)
 * - NBS CPI/PPI: ~9th of following month
 * - NBS IP/FAI/Retail: ~15th of following month
 * - NBS GDP: ~18th of month following quarter end
 * - Customs (GACC) trade: ~7th of following month
 * - PBOC LPR: 20th of each month
 * - PBOC FX reserves: 7th of following month
 * - PBOC M2/TSF: ~10th-15th of following month
 */

export interface MacroRelease {
  date: string;       // YYYY-MM-DD (confirmed or estimated)
  time: string;       // Beijing time HH:MM
  agency: "NBS" | "PBOC" | "Customs" | "NDRC" | "MoF";
  indicator: string;
  frequency: "monthly" | "quarterly" | "annual";
  expectedRelease: boolean; // true = confirmed date; false = estimated
  notes?: string;
}

/**
 * Generate the next N months of macro releases.
 * We generate a rolling calendar relative to the current date.
 */
function generateCalendar(): MacroRelease[] {
  const now = new Date();
  const releases: MacroRelease[] = [];

  // Generate for current month + 3 months ahead
  for (let monthOffset = -1; monthOffset <= 3; monthOffset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1; // 1-12
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const mm = String(month).padStart(2, "0");
    const prevMm = String(prevMonth).padStart(2, "0");

    // PMI Manufacturing — 31st/30th/last day of reference month (released day before or on last day)
    const pmiDate = new Date(year, month - 1 + 1, 0); // last day of month
    releases.push({
      date: `${year}-${mm}-${String(pmiDate.getDate()).padStart(2, "0")}`,
      time: "09:00",
      agency: "NBS",
      indicator: "PMI Manufacturing",
      frequency: "monthly",
      expectedRelease: true,
      notes: `Reference month: ${year}-${mm}. NBS official PMI.`,
    });

    // PMI Services (Non-Manufacturing) — same day as PMI Mfg
    releases.push({
      date: `${year}-${mm}-${String(pmiDate.getDate()).padStart(2, "0")}`,
      time: "09:00",
      agency: "NBS",
      indicator: "PMI Services (Non-Manufacturing)",
      frequency: "monthly",
      expectedRelease: true,
      notes: `Reference month: ${year}-${mm}.`,
    });

    // CPI & PPI — ~9th of following month (reporting previous month's data)
    releases.push({
      date: `${year}-${mm}-09`,
      time: "09:30",
      agency: "NBS",
      indicator: `CPI YoY — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "Typically released between 9th–12th. Estimated date.",
    });

    releases.push({
      date: `${year}-${mm}-09`,
      time: "09:30",
      agency: "NBS",
      indicator: `PPI YoY — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "Released with CPI. Estimated date.",
    });

    // Industrial Production / FAI / Retail Sales — ~15th of following month
    releases.push({
      date: `${year}-${mm}-15`,
      time: "10:00",
      agency: "NBS",
      indicator: `Industrial Production YoY — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "Typically 15th–17th. Estimated date.",
    });

    releases.push({
      date: `${year}-${mm}-15`,
      time: "10:00",
      agency: "NBS",
      indicator: `Fixed Asset Investment YTD YoY — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "Released with IP bundle.",
    });

    releases.push({
      date: `${year}-${mm}-15`,
      time: "10:00",
      agency: "NBS",
      indicator: `Retail Sales YoY — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "Released with IP/FAI bundle.",
    });

    // New Home Prices 70-city — ~18th of following month
    releases.push({
      date: `${year}-${mm}-18`,
      time: "09:30",
      agency: "NBS",
      indicator: `New Home Prices 70-city — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "Typically 15th–20th.",
    });

    // Trade data (Customs GACC) — ~7th of following month
    releases.push({
      date: `${year}-${mm}-07`,
      time: "10:00",
      agency: "Customs",
      indicator: `Trade Balance (Exports/Imports) — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "GACC release. Typically 7th–14th.",
    });

    // PBOC FX Reserves — ~7th of following month
    releases.push({
      date: `${year}-${mm}-07`,
      time: "09:00",
      agency: "PBOC",
      indicator: `FX Reserves USD bn — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "Released by PBOC around 7th.",
    });

    // PBOC LPR — 20th of each month
    releases.push({
      date: `${year}-${mm}-20`,
      time: "09:30",
      agency: "PBOC",
      indicator: `LPR (1Y & 5Y) — ${year}-${mm}`,
      frequency: "monthly",
      expectedRelease: true,
      notes: "PBOC announces LPR on 20th (or next business day).",
    });

    // M2 / Total Social Financing (TSF) — ~10th–15th
    releases.push({
      date: `${year}-${mm}-12`,
      time: "09:30",
      agency: "PBOC",
      indicator: `M2 Money Supply & TSF — ${prevYear}-${prevMm}`,
      frequency: "monthly",
      expectedRelease: false,
      notes: "Typically released 10th–15th of following month.",
    });

    // GDP — quarterly, released ~18th of month following quarter end
    // Q1 → April, Q2 → July, Q3 → October, Q4 → January
    if ([4, 7, 10, 1].includes(month)) {
      const qtr = month === 4 ? "Q1" : month === 7 ? "Q2" : month === 10 ? "Q3" : "Q4";
      const refYear = month === 1 ? year - 1 : year;
      releases.push({
        date: `${year}-${mm}-18`,
        time: "10:00",
        agency: "NBS",
        indicator: `GDP YoY — ${refYear} ${qtr}`,
        frequency: "quarterly",
        expectedRelease: false,
        notes: `Quarterly GDP flash. Released with monthly industrial data bundle. ${refYear} ${qtr}.`,
      });
    }
  }

  // Deduplicate and sort
  const seen = new Set<string>();
  const deduped = releases.filter((r) => {
    const key = `${r.date}:${r.indicator}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => a.date.localeCompare(b.date));
  return deduped;
}

// Cache the generated calendar (regenerate each process restart — it's cheap)
let _calendar: MacroRelease[] | null = null;

function getCalendar(): MacroRelease[] {
  if (!_calendar) {
    _calendar = generateCalendar();
  }
  return _calendar;
}

/**
 * Returns upcoming macro releases within `daysAhead` days from today.
 */
export function getUpcomingReleases(daysAhead = 30): MacroRelease[] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  return getCalendar().filter((r) => {
    const d = new Date(r.date);
    return d >= now && d <= cutoff;
  });
}

/**
 * Returns ALL calendar entries (for full calendar view).
 */
export function getAllReleases(): MacroRelease[] {
  return getCalendar();
}
