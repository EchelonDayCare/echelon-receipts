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
const BC_HOLIDAYS_DISABLED_SETTING = "bc_stat_holidays_disabled_ids"; // JSON string[] of holiday ids that DO NOT apply

/** Are BC statutory holidays treated as closed days? Default ON. */
export async function isBcHolidaysEnabled(): Promise<boolean> {
  const s = await getSettings();
  return (s[BC_HOLIDAYS_SETTING] ?? "1") !== "0";
}

export async function setBcHolidaysEnabled(enabled: boolean): Promise<void> {
  await setSetting(BC_HOLIDAYS_SETTING, enabled ? "1" : "0");
}

/**
 * Read the per-holiday opt-out list from settings. Empty set means "all
 * 12 BC statutory holidays apply". Setting persists year-on-year.
 */
export async function getDisabledBcHolidayIds(): Promise<Set<string>> {
  const s = await getSettings();
  const raw = s[BC_HOLIDAYS_DISABLED_SETTING];
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string"));
  } catch { /* fall through */ }
  return new Set();
}

export async function setDisabledBcHolidayIds(ids: string[]): Promise<void> {
  const uniq = [...new Set(ids.filter((x) => typeof x === "string"))].sort();
  await setSetting(BC_HOLIDAYS_DISABLED_SETTING, JSON.stringify(uniq));
}

/**
 * Layer BC statutory holidays onto an overrides map as closed days, honouring
 * the per-holiday opt-out list from settings. Async variant preferred going
 * forward — the sync `mergeBcHolidayOverrides` below is kept for callers that
 * pre-computed the exclusion set.
 */
export async function mergeBcHolidayOverridesAsync(
  overrides: Map<string, boolean>,
  fromIso: string,
  toIso: string,
): Promise<Map<string, boolean>> {
  const excluded = await getDisabledBcHolidayIds();
  return mergeBcHolidayOverrides(overrides, fromIso, toIso, excluded);
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
  excludedIds?: ReadonlySet<string>,
): Map<string, boolean> {
  const merged = new Map(overrides);
  for (const iso of bcHolidayLookup(fromIso, toIso, excludedIds).keys()) {
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

/**
 * Load explicit centre_calendar override rows for a date range. Returns
 * a Map of ISO date → is_open. Empty map = no explicit rows in the
 * range (all dates fall back to the default-open-days bitmap).
 *
 * Introduced in v2.6.3 so the Staff Schedule tab can gate the "+ Add"
 * button on weekends / stat holidays / manually-closed days without
 * seeding the whole month upfront the way MonthlyAttendance does.
 */
export async function overridesForRange(
  fromIso: string,
  toIso: string,
): Promise<Map<string, boolean>> {
  const { db } = await import("./db");
  const d = await db();
  const rows = await d.select<{ day: string; is_open: number }[]>(
    "SELECT day, is_open FROM centre_calendar WHERE day >= ? AND day <= ?",
    [fromIso, toIso],
  );
  const map = new Map<string, boolean>();
  for (const r of rows) map.set(r.day, !!r.is_open);
  return map;
}

/**
 * Human-readable "why is the centre closed on this day" string, or null
 * if the centre is open. Combines the three inputs (explicit override,
 * BC stat holiday, default-open-days bitmap) into one answer so callers
 * can guard save flows with one call.
 *
 * v2.6.3. Single-date version — for hot paths that need many days at
 * once, prefer `closedDayReasonsForRange` below which makes one round
 * trip to settings + centre_calendar instead of N.
 */
export async function closedDayReason(iso: string): Promise<string | null> {
  const map = await closedDayReasonsForRange(iso, iso);
  return map.get(iso) ?? null;
}

/**
 * Batched variant of `closedDayReason` — returns a Map of ISO → reason
 * for every closed day in [fromIso .. toIso] inclusive. Days that are
 * open are absent from the map (so `map.has(iso)` is the closed test).
 *
 * v2.6.3. Used by the AI Schedule Builder to reject parsed shifts that
 * land on a closed day in one shot, and by the Schedule grid to render
 * an existing-shift-on-closed-day warning tint.
 */
export async function closedDayReasonsForRange(
  fromIso: string,
  toIso: string,
): Promise<Map<string, string>> {
  const [defaultOpenDays, rawOverrides, on] = await Promise.all([
    getDefaultOpenDays(),
    overridesForRange(fromIso, toIso),
    isBcHolidaysEnabled(),
  ]);
  const excluded = on ? await getDisabledBcHolidayIds() : new Set<string>();
  const merged = on
    ? mergeBcHolidayOverrides(rawOverrides, fromIso, toIso, excluded)
    : rawOverrides;
  const holidays = on ? bcHolidayLookup(fromIso, toIso, excluded) : new Map<string, string>();
  const out = new Map<string, string>();
  for (const iso of eachDay(fromIso, toIso)) {
    if (isOpenDay(iso, merged, defaultOpenDays)) continue;
    const name = holidays.get(iso);
    if (name) { out.set(iso, name); continue; }
    const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
    out.set(iso, (d === 0 || d === 6) ? "Weekend" : "Closed");
  }
  return out;
}
