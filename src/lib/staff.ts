// Staff hours helpers.
import { db, execRetry } from "./db";
import type { Staff, StaffHour } from "../types";

function hoursBetween(inT: string | null, outT: string | null): number {
  if (!inT || !outT) return 0;
  const [ih, im] = inT.split(":").map(Number);
  const [oh, om] = outT.split(":").map(Number);
  if ([ih, im, oh, om].some((n) => Number.isNaN(n))) return 0;
  let mins = (oh * 60 + om) - (ih * 60 + im);
  if (mins < 0) mins += 24 * 60; // crossed midnight
  return Math.round((mins / 60) * 100) / 100;
}

/**
 * Paid hours = raw shift - 30 min unpaid lunch, UNLESS noLunch is true (staff
 * worked through lunch and checked the "No Ln" box). Never negative.
 */
export function paidHours(inT: string | null, outT: string | null, noLunch: boolean): number {
  const raw = hoursBetween(inT, outT);
  if (raw <= 0) return 0;
  const paid = noLunch ? raw : raw - 0.5;
  return Math.max(0, Math.round(paid * 100) / 100);
}

export async function listStaff(includeArchived = false): Promise<Staff[]> {
  const d = await db();
  return d.select<Staff[]>(
    `SELECT * FROM staff ${includeArchived ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`
  );
}

export async function createStaff(name: string, role: string | null, hourlyRate: number | null): Promise<number> {
  const r = await execRetry(
    "INSERT INTO staff(name, role, hourly_rate, active) VALUES(?, ?, ?, 1)",
    [name.trim(), role?.trim() || null, hourlyRate]
  );
  return Number(r.lastInsertId);
}

export async function updateStaff(id: number, fields: Partial<Pick<Staff, "name" | "role" | "hourly_rate" | "active">>): Promise<void> {
  const d = await db();
  const cur = (await d.select<Staff[]>("SELECT * FROM staff WHERE id=?", [id]))[0];
  if (!cur) return;
  const next: Staff = {
    ...cur,
    name: fields.name?.trim() ?? cur.name,
    role: fields.role !== undefined ? (fields.role?.trim() || null) : cur.role,
    hourly_rate: fields.hourly_rate !== undefined ? fields.hourly_rate : cur.hourly_rate,
    active: fields.active !== undefined ? fields.active : cur.active,
  };
  await execRetry(
    "UPDATE staff SET name=?, role=?, hourly_rate=?, active=?, archived_at=? WHERE id=?",
    [next.name, next.role, next.hourly_rate, next.active, next.active ? null : new Date().toISOString(), id]
  );
}

export async function archiveStaff(id: number): Promise<void> {
  await updateStaff(id, { active: 0 });
}

export async function listHoursForMonth(year: number, month: number): Promise<(StaffHour & { staff_name: string })[]> {
  const d = await db();
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  return d.select<(StaffHour & { staff_name: string })[]>(
    `SELECT h.*, s.name AS staff_name
       FROM staff_hours h JOIN staff s ON s.id = h.staff_id
      WHERE substr(h.work_date,1,7) = ?
      ORDER BY s.name COLLATE NOCASE, h.work_date`,
    [ym]
  );
}

export async function upsertHour(
  staffId: number,
  workDate: string,
  inT: string | null,
  outT: string | null,
  source: "manual" | "ocr",
  sheetPath: string | null = null,
  notes: string | null = null,
  noLunch: boolean = false,
): Promise<void> {
  const hours = paidHours(inT, outT, noLunch);
  await execRetry(
    `INSERT INTO staff_hours(staff_id, work_date, in_time, out_time, hours_decimal, source, sheet_image_path, notes, no_lunch)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(staff_id, work_date) DO UPDATE SET
       in_time=excluded.in_time,
       out_time=excluded.out_time,
       hours_decimal=excluded.hours_decimal,
       source=excluded.source,
       sheet_image_path=COALESCE(excluded.sheet_image_path, staff_hours.sheet_image_path),
       notes=COALESCE(excluded.notes, staff_hours.notes),
       no_lunch=excluded.no_lunch`,
    [staffId, workDate, inT, outT, hours, source, sheetPath, notes, noLunch ? 1 : 0]
  );
}

export async function deleteHour(id: number): Promise<void> {
  await execRetry("DELETE FROM staff_hours WHERE id=?", [id]);
}

// Find best matching staff_id for a name from OCR. Case-insensitive exact, then prefix, then null.
export function matchStaffByName(name: string, staffList: Staff[]): Staff | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  let m = staffList.find((s) => s.name.toLowerCase() === n);
  if (m) return m;
  m = staffList.find((s) => s.name.toLowerCase().startsWith(n) || n.startsWith(s.name.toLowerCase()));
  if (m) return m;
  // last-name match
  m = staffList.find((s) => {
    const parts = s.name.toLowerCase().split(/\s+/);
    return parts.some((p) => p === n || p === n.split(/\s+/).pop());
  });
  return m || null;
}

export { hoursBetween };
