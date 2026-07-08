// Classification of an attendance row into a report bucket.
//
// After Migration 027, `attendance_mark` is the authoritative monthly
// override (P/H/A/S/V). Daily writers (stampIn/stampOut/upsertAttendance/
// markAbsent in src/lib/attendance.ts) MUST clear attendance_mark=NULL
// on every write — this is the ownership contract enforced by Blocker 1
// of the v2.1.0 review.
//
// For daily-flow rows (attendance_mark=NULL), we derive the bucket from
// `status` alone. We deliberately do NOT infer half-day from hours=0:
// a stamped-in-but-not-yet-out child has status='present' and
// hours_decimal=0 and is a full-day in progress, not a half-day. The
// only source of half-day is now the explicit attendance_mark='H'.
//
// See: src/lib/db.ts Migration 027 and commit 42f4c64.

export type AttendanceBucket = "p" | "h" | "a" | "s" | "v" | null;

export function statusToBucket(status: string | null): AttendanceBucket {
  const s = (status || "").toLowerCase();
  if (s === "present") return "p";
  if (s === "absent") return "a";
  if (s === "sick") return "s";
  if (s === "holiday") return "v";
  return null;
}

export interface AttendanceRow {
  status: string | null;
  hours_decimal: number;
  attendance_mark: string | null;
}

export function rowToBucket(r: AttendanceRow): AttendanceBucket {
  const m = (r.attendance_mark || "").toUpperCase();
  if (m === "P") return "p";
  if (m === "H") return "h";
  if (m === "A") return "a";
  if (m === "S") return "s";
  if (m === "V") return "v";
  return statusToBucket(r.status);
}
