// Timezone-safe day-of-week helpers backed by explicit overrides in the
// `centre_calendar` table. Introduced in v2.1.1 to fix the Attendance
// Analytics denominator bug: weekend closures were seeded into
// centre_calendar lazily by MonthlyAttendance's onMount, so reports run
// over months the user hadn't opened counted weekends as open days.
//
// This module makes reports independent of that seeding by treating
// centre_calendar as an *override* table:
//   * If a date has an explicit row, is_open drives the answer.
//   * Otherwise we consult the `centre_default_open_days` setting — a
//     7-char bitmap (Sun..Sat) of 1/0. Default "0111110" (M-F open).
// All date iteration is anchored at UTC noon to avoid local-timezone
// day-of-week drift.
import { getSettings, setSetting } from "./db";
import { bcHolidayLookup } from "./bcHolidays";

const DEFAULT_OPEN_DAYS = "0111110"; // Sun..Sat, 1 = open; Mon-Fri default
const BC_HOLIDAYS_SETTING = "bc_stat_holidays_enabled";

/** Are BC statutory holidays treated as closed days? Default ON. */
export async function isBcHolidaysEnabled(): Promise<boolean> {
  const s = await getSettings();
  return (s[BC_HOLIDAYS_SETTING] ?? "1") !== "0";
}

export async function setBcHolidaysEnabled(enabled: boolean): Promise<void> {
  await setSetting(BC_HOLIDAYS_SETTING, enabled ? "1" : "0");
}

/**
 * Layer BC statutory holidays onto an overrides map as closed days. An
 * explicit override in `overrides` always wins over the seeded holiday
 * (user can force a holiday open if they choose to run that day).
 */
export function mergeBcHolidayOverrides(
  overrides: Map<string, boolean>,
  fromIso: string,
  toIso: string,
): Map<string, boolean> {
  const merged = new Map(overrides);
  for (const iso of bcHolidayLookup(fromIso, toIso).keys()) {
    if (!merged.has(iso)) merged.set(iso, false);
  }
  return merged;
}

/** Read the centre-wide default-open-days bitmap, validated. */
export async function getDefaultOpenDays(): Promise<string> {
  const s = await getSettings();
  const raw = s["centre_default_open_days"];
  return /^[01]{7}$/.test(raw ?? "") ? raw! : DEFAULT_OPEN_DAYS;
}

export async function setDefaultOpenDays(bitmap: string): Promise<void> {
  if (!/^[01]{7}$/.test(bitmap)) {
    throw new Error(`centre_default_open_days must be 7 chars of 0/1, got ${JSON.stringify(bitmap)}`);
  }
  await setSetting("centre_default_open_days", bitmap);
}

/**
 * Is the centre open on this ISO date?
 * Precedence: explicit override row > default-open-days bitmap.
 */
export function isOpenDay(
  isoDate: string,
  overrides: Map<string, boolean>,
  defaultOpenDays: string,
): boolean {
  const explicit = overrides.get(isoDate);
  if (explicit !== undefined) return explicit;
  // Anchor at UTC noon so the day-of-week is stable regardless of the
  // runtime's local timezone / DST state.
  const d = new Date(`${isoDate}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sun, 6 = Sat
  return defaultOpenDays.charAt(dow) === "1";
}

/** Iterate ISO date strings from `fromIso` through `toIso` inclusive. */
export function* eachDay(fromIso: string, toIso: string): Generator<string> {
  const [fy, fm, fd] = fromIso.split("-").map((x) => parseInt(x, 10));
  const [ty, tm, td] = toIso.split("-").map((x) => parseInt(x, 10));
  let t = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (t <= end) {
    const d = new Date(t);
    const iso =
      `${d.getUTCFullYear()}-` +
      `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
      `${String(d.getUTCDate()).padStart(2, "0")}`;
    yield iso;
    t += 86_400_000;
  }
}

export function daysOpenInRange(
  fromIso: string,
  toIso: string,
  overrides: Map<string, boolean>,
  defaultOpenDays: string,
): number {
  let n = 0;
  for (const iso of eachDay(fromIso, toIso)) {
    if (isOpenDay(iso, overrides, defaultOpenDays)) n++;
  }
  return n;
}
