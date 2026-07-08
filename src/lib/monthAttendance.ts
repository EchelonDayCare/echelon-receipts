// Monthly attendance grid helpers — matches the paper sign-in sheet Luxmi
// actually uses (name × day-of-month, marks P / A / H / S / V per cell). No
// in/out time here on purpose — the paper doesn't capture it either.
import { db, execRetry } from "./db";

// One-character mark codes. Kept short so cells are compact in the grid.
export type MonthMark = "P" | "A" | "H" | "S" | "V";
// P = present         (full day)
// A = absent          (no reason given)
// H = half-day        (partial attendance)
// S = sick            (absent, sick note)
// V = vacation        (planned family absence)

export const MARK_LABEL: Record<MonthMark, string> = {
  P: "Present",
  A: "Absent",
  H: "Half-day",
  S: "Sick",
  V: "Vacation",
};

export const MARK_COLOR: Record<MonthMark, string> = {
  P: "#166534", // green
  A: "#991b1b", // red
  H: "#a16207", // amber
  S: "#7c3aed", // purple
  V: "#075985", // blue
};

// Map to the legacy `child_attendance.status` column so the monthly grid
// and the (still-supported) daily view stay in sync. Half-day has no direct
// analogue; stored as 'present' with hours_decimal=0 by convention.
export function markToLegacyStatus(m: MonthMark): string {
  switch (m) {
    case "P": return "present";
    case "A": return "absent";
    case "H": return "present";
    case "S": return "sick";
    case "V": return "holiday";
  }
}
export function legacyStatusToMark(s: string | null | undefined): MonthMark | null {
  switch ((s || "").toLowerCase()) {
    case "present": return "P";
    case "absent":  return "A";
    case "sick":    return "S";
    case "holiday": return "V";
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

// Seed BC statutory holidays for a given month as closed days. Idempotent
// via INSERT OR IGNORE — a user-set open/close override for that iso day
// is preserved (INSERT is a no-op when the row exists).
export async function seedBcHolidays(year: number, month: number): Promise<number> {
  const { bcStatHolidays } = await import("./bcHolidays");
  const mmPrefix = `${year}-${String(month).padStart(2, "0")}-`;
  let added = 0;
  for (const h of bcStatHolidays(year)) {
    if (!h.iso.startsWith(mmPrefix)) continue;
    const r = await execRetry(
      `INSERT OR IGNORE INTO centre_calendar(day, is_open, reason) VALUES(?, 0, ?)`,
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
