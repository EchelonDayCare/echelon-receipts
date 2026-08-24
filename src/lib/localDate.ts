// Local-date helpers.
//
// `new Date().toISOString().slice(0, 10)` returns a UTC calendar date.
// For a user in Vancouver (UTC-7/8), after ~4-5pm local time this returns
// *tomorrow* — a receipt entered at 5pm on Dec 31 would land on Jan 1 of
// the next tax year. Aging buckets computed against UTC midnight also drift
// by one day around midnight local.
//
// These helpers format the *local* calendar date (or an ISO Y-M-D input)
// safely, and compute calendar-day differences using UTC-anchored midpoints
// so DST transitions don't collapse a 31-day interval into 30 (which would
// misbucket aging around the spring-forward day).

export function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Whole-calendar-day difference between two YYYY-MM-DD strings.
 * Uses Date.UTC on the parsed components so DST springs/falls don't
 * subtract or add an hour that gets Math.floored into the wrong bucket.
 */
export function daysBetweenLocalIso(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const a = Date.UTC(fy, (fm || 1) - 1, fd || 1);
  const b = Date.UTC(ty, (tm || 1) - 1, td || 1);
  return Math.round((b - a) / 86_400_000);
}
