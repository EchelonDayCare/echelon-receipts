// Monthly attendance grid helpers — matches the paper sign-in sheet Luxmi
// actually uses (name × day-of-month, marks P / A / H / S / V per cell). No
// in/out time here on purpose — the paper doesn't capture it either.
import { db, execRetry } from "./db";

// One-character mark codes. Only two states matter for this centre:
// P = present, A = absent. (v2.2.2 dropped H/S/V per user directive —
// legacy rows migrate to A on read; the setter never writes H/S/V again.)
export type MonthMark = "P" | "A";

export const MARK_LABEL: Record<MonthMark, string> = {
  P: "Present",
  A: "Absent",
};

export const MARK_COLOR: Record<MonthMark, string> = {
  P: "#166534", // green
  A: "#991b1b", // red
};

// Map to the legacy `child_attendance.status` column so the monthly grid
// and the (still-supported) daily view stay in sync.
export function markToLegacyStatus(m: MonthMark): string {
  switch (m) {
    case "P": return "present";
    case "A": return "absent";
  }
}
export function legacyStatusToMark(s: string | null | undefined): MonthMark | null {
  switch ((s || "").toLowerCase()) {
    case "present": return "P";
    case "absent":  return "A";
    // Legacy rows written before v2.2.2 that used sick/holiday/half-day
    // collapse to A so historical months still render coherently.
    case "sick":    return "A";
    case "holiday": return "A";
    case "late":    return "P";
    default:        return null;
  }
}

export interface MonthCell {
  student_id: number;
  student_name: string;
  marks: Record<string, MonthMark>; // day-of-month "1".."31" -> mark
}

export interface CalendarDay {
  day: string;        // yyyy-mm-dd
  is_open: boolean;
  reason: string | null;
}

// ---- Roster + marks ---------------------------------------------------
// Read precedence (post-Migration 027):
//   1. `attendance_mark` if set → authoritative monthly view.
//   2. Otherwise fall back to legacyStatusToMark(status).
// Daily writers clear `attendance_mark` on every write, so it's never stale.
export async function monthGrid(year: number, month: number): Promise<MonthCell[]> {
  const d = await db();
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const rows = await d.select<any[]>(
    `SELECT s.id AS student_id, s.name AS student_name,
            a.work_date, a.status, a.hours_decimal, a.attendance_mark
       FROM students s
       LEFT JOIN child_attendance a
              ON a.student_id = s.id AND a.work_date LIKE ?
      WHERE s.year = ? AND s.active = 1
      ORDER BY s.name COLLATE NOCASE, a.work_date`,
    [`${ym}-%`, year]
  );
  const map = new Map<number, MonthCell>();
  for (const r of rows) {
    if (!map.has(r.student_id)) {
      map.set(r.student_id, { student_id: r.student_id, student_name: r.student_name, marks: {} });
    }
    if (!r.work_date) continue;
    const day = String(parseInt(r.work_date.slice(8, 10), 10));
    const m: MonthMark | null = r.attendance_mark
      ? (r.attendance_mark as MonthMark)
      : legacyStatusToMark(r.status);
    if (m) map.get(r.student_id)!.marks[day] = m;
  }
  return Array.from(map.values());
}

// Monthly-grid writer. See Migration 027 in db.ts for the ownership contract:
//   - If the row has daily evidence (in_time or out_time), only update
//     attendance_mark. Do NOT touch status/hours/times.
//   - If no daily evidence, also mirror status + hours_decimal so daily
//     screens render consistently.
//   - Clearing (mark=null) removes only attendance_mark on evidence-bearing
//     rows; on monthly-only rows it deletes the row as before.
export async function setMark(studentId: number, workDate: string, mark: MonthMark | null): Promise<void> {
  const d = await db();
  // Closed-day guard: refuse to write P/A on a day the centre is closed
  // (weekends, seeded stat holidays, or any manually-closed day). Callers
  // that need to clear a mark on a closed day can still pass mark=null.
  if (mark !== null) {
    const cal = await d.select<Array<{ is_open: number }>>(
      "SELECT is_open FROM centre_calendar WHERE day=?",
      [workDate],
    );
    if (cal.length > 0 && !cal[0].is_open) {
      // Silent no-op — grid UI already visually disables closed cells; this
      // is defense-in-depth against imports or race conditions that slip
      // past the review-modal filter.
      return;
    }
  }
  const existing = await d.select<Array<{ in_time: string | null; out_time: string | null }>>(
    "SELECT in_time, out_time FROM child_attendance WHERE student_id=? AND work_date=?",
    [studentId, workDate]
  );
  const hasDailyEvidence = existing.length > 0 && !!(existing[0].in_time || existing[0].out_time);

  if (mark === null) {
    if (hasDailyEvidence) {
      await execRetry(
        "UPDATE child_attendance SET attendance_mark=NULL WHERE student_id=? AND work_date=?",
        [studentId, workDate]
      );
    } else {
      await execRetry(
        "DELETE FROM child_attendance WHERE student_id=? AND work_date=?",
        [studentId, workDate]
      );
    }
    return;
  }

  if (hasDailyEvidence) {
    // Preserve the daily row's in/out/hours; only override the monthly display.
    await execRetry(
      "UPDATE child_attendance SET attendance_mark=? WHERE student_id=? AND work_date=?",
      [mark, studentId, workDate]
    );
    return;
  }

  const status = markToLegacyStatus(mark);
  // hours_decimal: 0 for absent/sick/vacation/half-day; nominal 8 for present
  // (kept for backward-compat with reports; real time is entered on the
  // Daily view for centres that opt into time tracking).
  const hours = mark === "P" ? 8 : 0;
  await execRetry(
    `INSERT INTO child_attendance(student_id, work_date, hours_decimal, status, attendance_mark)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(student_id, work_date) DO UPDATE SET
       hours_decimal   = excluded.hours_decimal,
       status          = excluded.status,
       attendance_mark = excluded.attendance_mark`,
    [studentId, workDate, hours, status, mark]
  );
}

// ---- Centre calendar --------------------------------------------------
export async function calendarForMonth(year: number, month: number): Promise<CalendarDay[]> {
  const d = await db();
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const rows = await d.select<any[]>(
    "SELECT day, is_open, reason FROM centre_calendar WHERE day LIKE ? ORDER BY day",
    [`${ym}-%`]
  );
  return rows.map((r) => ({ day: r.day, is_open: !!r.is_open, reason: r.reason }));
}

// Ensure weekend rows exist (is_open=0, reason='Weekend') for every Sat/Sun
// in the given month. Idempotent; safe to run repeatedly. Returns count added.
export async function seedWeekends(year: number, month: number): Promise<number> {
  const daysInMonth = new Date(year, month, 0).getDate();
  let added = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    const dow = dt.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) continue;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const r = await execRetry(
      `INSERT OR IGNORE INTO centre_calendar(day, is_open, reason) VALUES(?, 0, 'Weekend')`,
      [iso]
    );
    if ((r as any)?.rowsAffected) added++;
  }
  return added;
}

// Seed BC statutory holidays for a given month as closed days. Uses an
// UPSERT so that a pre-existing row for the same day gets FORCED to
// closed — otherwise a stale `is_open=1` row (from an older build that
// used INSERT OR IGNORE, or from an accidental manual toggle) would let
// P/A marks slip through the closed-day import filter for Canada Day
// etc. Users can still opt-out per-holiday via
// getDisabledBcHolidayIds(); disabled holidays are skipped entirely so
// their DB rows (if any) are left alone.
export async function seedBcHolidays(year: number, month: number): Promise<number> {
  const { bcStatHolidays } = await import("./bcHolidays");
  const { getDisabledBcHolidayIds } = await import("./centreCalendar");
  const excluded = await getDisabledBcHolidayIds();
  const mmPrefix = `${year}-${String(month).padStart(2, "0")}-`;
  let added = 0;
  for (const h of bcStatHolidays(year)) {
    if (excluded.has(h.id)) continue;
    if (!h.iso.startsWith(mmPrefix)) continue;
    const r = await execRetry(
      `INSERT INTO centre_calendar(day, is_open, reason) VALUES(?, 0, ?)
       ON CONFLICT(day) DO UPDATE SET is_open=0, reason=excluded.reason`,
      [h.iso, h.name],
    );
    if ((r as any)?.rowsAffected) added++;
  }
  return added;
}

export async function setCalendarDay(day: string, isOpen: boolean, reason: string | null): Promise<void> {
  await execRetry(
    `INSERT INTO centre_calendar(day, is_open, reason)
     VALUES(?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET is_open=excluded.is_open, reason=excluded.reason`,
    [day, isOpen ? 1 : 0, reason]
  );
}

// Wipe every attendance mark for a given month across all students. Rows
// carrying daily in/out evidence keep their in_time/out_time (only the
// monthly attendance_mark + status are cleared); rows that were purely
// mark-only get deleted. Used by re-import to guarantee replace-not-merge
// semantics — a fresh OCR pass fully supersedes the previous month state.
export async function clearMonthMarks(year: number, month: number): Promise<number> {
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const like = `${ym}-%`;
  // 1. Rows with daily in/out evidence: keep the row, null the mark.
  await execRetry(
    `UPDATE child_attendance
        SET attendance_mark = NULL, status = NULL
      WHERE work_date LIKE ?
        AND (in_time IS NOT NULL OR out_time IS NOT NULL)`,
    [like],
  );
  // 2. Mark-only rows: drop them entirely so the grid renders blank.
  const del = await execRetry(
    `DELETE FROM child_attendance
      WHERE work_date LIKE ?
        AND in_time IS NULL AND out_time IS NULL`,
    [like],
  );
  return (del as any)?.rowsAffected ?? 0;
}

export function daysOpenInMonth(year: number, month: number, calendar: CalendarDay[]): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  const closedSet = new Set(calendar.filter((c) => !c.is_open).map((c) => c.day));
  let n = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!closedSet.has(iso)) n++;
  }
  return n;
}
