// Daily child attendance log. Required by BC Community Care Licensing.
// Mirrors the shape of staff_hours so the UI and helpers can reuse patterns.
import { db, execRetry } from "./db";

export type AttendanceStatus = "present" | "absent" | "sick" | "late" | "holiday";

export interface ChildAttendance {
  id: number;
  student_id: number;
  work_date: string;        // yyyy-mm-dd
  in_time: string | null;   // HH:MM
  out_time: string | null;
  hours_decimal: number;
  signed_in_by: string | null;
  signed_out_by: string | null;
  status: AttendanceStatus;
  notes: string | null;
  created_at: string;
}

export interface DayRosterRow {
  student_id: number;
  student_name: string;
  father_name: string | null;
  mother_name: string | null;
  attendance: ChildAttendance | null;
}

function hoursBetween(inT: string | null, outT: string | null): number {
  if (!inT || !outT) return 0;
  const [ih, im] = inT.split(":").map(Number);
  const [oh, om] = outT.split(":").map(Number);
  if ([ih, im, oh, om].some((n) => Number.isNaN(n))) return 0;
  let mins = (oh * 60 + om) - (ih * 60 + im);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

// Returns one row per active student for the selected year/date — with
// attendance row joined in if it exists. This is the main view that drives
// the daily roster screen.
export async function rosterForDate(year: number, workDate: string): Promise<DayRosterRow[]> {
  const d = await db();
  const rows = await d.select<any[]>(
    `SELECT s.id AS student_id, s.name AS student_name,
            s.father_name, s.mother_name,
            a.id AS aid, a.work_date, a.in_time, a.out_time, a.hours_decimal,
            a.signed_in_by, a.signed_out_by, a.status, a.notes, a.created_at
       FROM students s
       LEFT JOIN child_attendance a
              ON a.student_id = s.id AND a.work_date = ?
      WHERE s.year = ? AND s.active = 1
      ORDER BY s.name COLLATE NOCASE`,
    [workDate, year]
  );
  return rows.map((r) => ({
    student_id: r.student_id,
    student_name: r.student_name,
    father_name: r.father_name,
    mother_name: r.mother_name,
    attendance: r.aid
      ? {
          id: r.aid,
          student_id: r.student_id,
          work_date: r.work_date,
          in_time: r.in_time,
          out_time: r.out_time,
          hours_decimal: r.hours_decimal,
          signed_in_by: r.signed_in_by,
          signed_out_by: r.signed_out_by,
          status: r.status,
          notes: r.notes,
          created_at: r.created_at,
        }
      : null,
  }));
}

export async function upsertAttendance(args: {
  studentId: number;
  workDate: string;
  inTime: string | null;
  outTime: string | null;
  signedInBy?: string | null;
  signedOutBy?: string | null;
  status?: AttendanceStatus;
  notes?: string | null;
}): Promise<void> {
  const hours = hoursBetween(args.inTime, args.outTime);
  const status = args.status || (args.inTime || args.outTime ? "present" : "absent");
  await execRetry(
    `INSERT INTO child_attendance(student_id, work_date, in_time, out_time, hours_decimal, signed_in_by, signed_out_by, status, notes)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id, work_date) DO UPDATE SET
       in_time=excluded.in_time,
       out_time=excluded.out_time,
       hours_decimal=excluded.hours_decimal,
       signed_in_by=COALESCE(excluded.signed_in_by, child_attendance.signed_in_by),
       signed_out_by=COALESCE(excluded.signed_out_by, child_attendance.signed_out_by),
       status=excluded.status,
       notes=COALESCE(excluded.notes, child_attendance.notes)`,
    [args.studentId, args.workDate, args.inTime, args.outTime, hours,
     args.signedInBy ?? null, args.signedOutBy ?? null, status, args.notes ?? null]
  );
}

// Quick "stamp in now" — sets in_time to current local HH:MM if blank,
// leaves out_time alone; status becomes 'present'.
export async function stampIn(studentId: number, workDate: string, who?: string): Promise<void> {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  await execRetry(
    `INSERT INTO child_attendance(student_id, work_date, in_time, hours_decimal, signed_in_by, status)
     VALUES(?, ?, ?, 0, ?, 'present')
     ON CONFLICT(student_id, work_date) DO UPDATE SET
       in_time=COALESCE(child_attendance.in_time, excluded.in_time),
       signed_in_by=COALESCE(child_attendance.signed_in_by, excluded.signed_in_by),
       status='present'`,
    [studentId, workDate, hhmm, who ?? null]
  );
}

/**
 * Stamp a child out. Returns `false` if there was no matching sign-in row for
 * this student/date (the UI should surface a warning — the row is still
 * created so the operator can correct it, but hours will be 0 until an
 * in-time is entered).
 */
export async function stampOut(studentId: number, workDate: string, who?: string): Promise<boolean> {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const d = await db();
  const cur = await d.select<ChildAttendance[]>(
    "SELECT * FROM child_attendance WHERE student_id=? AND work_date=?",
    [studentId, workDate]
  );
  if (!cur.length) {
    // No in_time yet — record out_time only, but signal the anomaly to caller.
    await upsertAttendance({ studentId, workDate, inTime: null, outTime: hhmm, signedOutBy: who ?? null });
    return false;
  }
  const row = cur[0];
  const newHours = hoursBetween(row.in_time, hhmm);
  await execRetry(
    `UPDATE child_attendance SET out_time=?, hours_decimal=?, signed_out_by=COALESCE(signed_out_by, ?), status='present'
       WHERE student_id=? AND work_date=?`,
    [hhmm, newHours, who ?? null, studentId, workDate]
  );
  return true;
}

export async function markAbsent(studentId: number, workDate: string, status: AttendanceStatus = "absent", notes: string | null = null): Promise<void> {
  await execRetry(
    `INSERT INTO child_attendance(student_id, work_date, hours_decimal, status, notes)
     VALUES(?, ?, 0, ?, ?)
     ON CONFLICT(student_id, work_date) DO UPDATE SET
       in_time=NULL, out_time=NULL, hours_decimal=0,
       status=excluded.status,
       notes=COALESCE(excluded.notes, child_attendance.notes)`,
    [studentId, workDate, status, notes]
  );
}

export async function deleteAttendance(id: number): Promise<void> {
  await execRetry("DELETE FROM child_attendance WHERE id=?", [id]);
}

// Monthly attendance for one student — used by reports / parent statements.
export async function studentMonthAttendance(studentId: number, year: number, month: number): Promise<ChildAttendance[]> {
  const d = await db();
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  return d.select<ChildAttendance[]>(
    "SELECT * FROM child_attendance WHERE student_id=? AND work_date LIKE ? ORDER BY work_date",
    [studentId, `${ym}-%`]
  );
}

// All attendance rows in a date range (inclusive) — used for licensing export.
export async function attendanceInRange(fromDate: string, toDate: string): Promise<Array<ChildAttendance & { student_name: string }>> {
  const d = await db();
  return d.select<any[]>(
    `SELECT a.*, s.name AS student_name
       FROM child_attendance a
       JOIN students s ON s.id = a.student_id
      WHERE a.work_date BETWEEN ? AND ?
      ORDER BY a.work_date, s.name COLLATE NOCASE`,
    [fromDate, toDate]
  );
}

// Fuzzy match an OCR'd child name back to a known student. Mirrors
// matchStaffByName: case-insensitive exact, then prefix, then last-name token.
export function matchStudentByName<T extends { id: number; name: string }>(name: string, students: T[]): T | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  let m = students.find((s) => s.name.toLowerCase() === n);
  if (m) return m;
  m = students.find((s) => s.name.toLowerCase().startsWith(n) || n.startsWith(s.name.toLowerCase()));
  if (m) return m;
  m = students.find((s) => {
    const parts = s.name.toLowerCase().split(/\s+/);
    const lastFromOcr = n.split(/\s+/).pop()!;
    const firstFromOcr = n.split(/\s+/)[0];
    return parts.some((p) => p === n || p === lastFromOcr || p === firstFromOcr);
  });
  return m || null;
}
