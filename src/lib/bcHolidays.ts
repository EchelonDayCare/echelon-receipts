// British Columbia statutory holidays (+ Boxing Day, commonly observed by
// daycares although not statutory in BC).
//
// Pure computed dates for any year — no network, no keychain, no DB. All
// arithmetic is done at UTC noon to avoid local-tz day-of-week drift, then
// serialized as YYYY-MM-DD.
//
// Consumers:
//   * Centre Calendar side panel (MonthlyAttendance) — pre-seeds these as
//     closed days when the "Include BC statutory holidays" toggle is on.
//   * daysOpenInRange (via mergeHolidayOverrides) — reports do the same
//     merge before calling.
//   * Staff schedule grid — greys out holiday days.

export type BcHoliday = {
  /** Stable id (unchanged between years). */
  id: string;
  name: string;
  /** YYYY-MM-DD in the given year. */
  iso: string;
};

/** Sunday-in-month → date object (UTC noon). n=1 first, 2 second, etc. */
function nthWeekday(year: number, monthZeroBased: number, weekday: number, n: number): Date {
  // weekday: 0=Sun ... 6=Sat
  const first = new Date(Date.UTC(year, monthZeroBased, 1, 12));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthZeroBased, 1 + shift + (n - 1) * 7, 12));
}

/** Monday on-or-before May 24 (Victoria Day). */
function mondayOnOrBeforeMay24(year: number): Date {
  const may24 = new Date(Date.UTC(year, 4, 24, 12));
  const dow = may24.getUTCDay(); // 0=Sun...6=Sat
  const backTo = dow === 0 ? 6 : dow - 1; // days back to Monday
  return new Date(Date.UTC(year, 4, 24 - backTo, 12));
}

/** Gauss's algorithm — returns Easter Sunday for the given Gregorian year. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function toIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Ordered catalog of BC statutory holiday IDs and display labels — used by
 * the Settings → Stat Holidays tab to render the year-on-year opt-out
 * checkboxes. Order matches bcStatHolidays() output order (Jan..Dec).
 */
export const BC_HOLIDAY_CATALOG: { id: string; label: string }[] = [
  { id: "new_years",       label: "New Year's Day (Jan 1)" },
  { id: "family_day",      label: "Family Day (3rd Mon Feb)" },
  { id: "good_friday",     label: "Good Friday (Fri before Easter)" },
  { id: "victoria_day",    label: "Victoria Day (Mon on/before May 24)" },
  { id: "canada_day",      label: "Canada Day (Jul 1)" },
  { id: "bc_day",          label: "BC Day (1st Mon Aug)" },
  { id: "labour_day",      label: "Labour Day (1st Mon Sep)" },
  { id: "truth_recon",     label: "National Day for Truth & Reconciliation (Sep 30)" },
  { id: "thanksgiving",    label: "Thanksgiving (2nd Mon Oct)" },
  { id: "remembrance_day", label: "Remembrance Day (Nov 11)" },
  { id: "christmas",       label: "Christmas Day (Dec 25)" },
  { id: "boxing_day",      label: "Boxing Day (Dec 26)" },
];

/** All BC-observed closures for the given calendar year, in date order. */
export function bcStatHolidays(year: number): BcHoliday[] {
  const easter = easterSunday(year);
  const goodFriday = new Date(easter);
  goodFriday.setUTCDate(easter.getUTCDate() - 2);

  const list: BcHoliday[] = [
    { id: "new_years",        name: "New Year's Day",                          iso: toIso(new Date(Date.UTC(year, 0, 1, 12))) },
    { id: "family_day",       name: "Family Day",                              iso: toIso(nthWeekday(year, 1, 1, 3)) },  // 3rd Mon Feb
    { id: "good_friday",      name: "Good Friday",                             iso: toIso(goodFriday) },
    { id: "victoria_day",     name: "Victoria Day",                            iso: toIso(mondayOnOrBeforeMay24(year)) },
    { id: "canada_day",       name: "Canada Day",                              iso: toIso(new Date(Date.UTC(year, 6, 1, 12))) },
    { id: "bc_day",           name: "BC Day",                                  iso: toIso(nthWeekday(year, 7, 1, 1)) },   // 1st Mon Aug
    { id: "labour_day",       name: "Labour Day",                              iso: toIso(nthWeekday(year, 8, 1, 1)) },   // 1st Mon Sep
    { id: "truth_recon",      name: "National Day for Truth & Reconciliation", iso: toIso(new Date(Date.UTC(year, 8, 30, 12))) },
    { id: "thanksgiving",     name: "Thanksgiving",                            iso: toIso(nthWeekday(year, 9, 1, 2)) },   // 2nd Mon Oct
    { id: "remembrance_day",  name: "Remembrance Day",                         iso: toIso(new Date(Date.UTC(year, 10, 11, 12))) },
    { id: "christmas",        name: "Christmas Day",                           iso: toIso(new Date(Date.UTC(year, 11, 25, 12))) },
    { id: "boxing_day",       name: "Boxing Day",                              iso: toIso(new Date(Date.UTC(year, 11, 26, 12))) },
  ];
  return list.sort((a, b) => a.iso.localeCompare(b.iso));
}

/**
 * Build a lookup {iso → reason} for all BC holidays that fall in the
 * inclusive [fromIso, toIso] range. Pure function.
 */
/**
 * Build a lookup {iso → reason} for all BC holidays that fall in the
 * inclusive [fromIso, toIso] range. Pure function.
 *
 * If `excludedIds` is provided, holidays whose id is in that set are
 * omitted from the result — used to honour the Settings → Stat Holidays
 * per-holiday opt-out.
 */
export function bcHolidayLookup(
  fromIso: string,
  toIso: string,
  excludedIds?: ReadonlySet<string>,
): Map<string, string> {
  const fromYear = Number(fromIso.slice(0, 4));
  const toYear   = Number(toIso.slice(0, 4));
  const out = new Map<string, string>();
  for (let y = fromYear; y <= toYear; y++) {
    for (const h of bcStatHolidays(y)) {
      if (excludedIds?.has(h.id)) continue;
      if (h.iso >= fromIso && h.iso <= toIso) out.set(h.iso, h.name);
    }
  }
  return out;
}
