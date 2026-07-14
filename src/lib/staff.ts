// Staff hours helpers.
import { db, execRetry } from "./db";
import type { Staff, StaffHour } from "../types";

function hoursBetween(inT: string | null, outT: string | null): number {
  if (!inT || !outT) return 0;
  const [ih, im] = inT.split(":").map(Number);
  const [oh, om] = outT.split(":").map(Number);
  if ([ih, im, oh, om].some((n) => Number.isNaN(n))) return 0;
  const inMins = ih * 60 + im;
  const outMins = oh * 60 + om;
  // Daycare shifts never cross midnight. Previous behaviour of adding 24h
  // produced 20-hour phantom shifts (e.g. handwritten "7 40" PM in an OUT
  // cell was read as 07:40 AM). Rust temporal_validator is the primary
  // enforcement point; this is defence-in-depth.
  if (outMins <= inMins) return 0;
  const mins = outMins - inMins;
  if (mins > 16 * 60) return 0; // >16h is corruption regardless of context
  return Math.round((mins / 60) * 100) / 100;
}

/**
 * Paid hours = raw shift hours, minus 30-min unpaid lunch when the shift is
 * 5 hours or more. Shifts under 5 hours get no deduction because the worker
 * doesn't take an unpaid lunch. `noLunch=true` (staff worked through their
 * lunch) also skips the deduction. Never returns negative.
 */
export function paidHours(inT: string | null, outT: string | null, noLunch: boolean): number {
  const raw = hoursBetween(inT, outT);
  if (raw <= 0) return 0;
  const deductLunch = !noLunch && raw >= 5;
  const paid = deductLunch ? raw - 0.5 : raw;
  return Math.max(0, Math.round(paid * 100) / 100);
}

export async function listStaff(includeArchived = false): Promise<Staff[]> {
  const d = await db();
  return d.select<Staff[]>(
    `SELECT * FROM staff ${includeArchived ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`
  );
}

export async function createStaff(
  name: string,
  role: string | null,
  hourlyRate: number | null,
  whatsappPhoneE164: string | null = null,
): Promise<number> {
  const r = await execRetry(
    "INSERT INTO staff(name, role, hourly_rate, whatsapp_phone_e164, active) VALUES(?, ?, ?, ?, 1)",
    [name.trim(), role?.trim() || null, hourlyRate, whatsappPhoneE164?.trim() || null]
  );
  return Number(r.lastInsertId);
}

export async function updateStaff(
  id: number,
  fields: Partial<Pick<Staff, "name" | "role" | "hourly_rate" | "active" | "whatsapp_phone_e164">>,
): Promise<void> {
  const d = await db();
  const cur = (await d.select<Staff[]>("SELECT * FROM staff WHERE id=?", [id]))[0];
  if (!cur) return;
  const next: Staff = {
    ...cur,
    name: fields.name?.trim() ?? cur.name,
    role: fields.role !== undefined ? (fields.role?.trim() || null) : cur.role,
    hourly_rate: fields.hourly_rate !== undefined ? fields.hourly_rate : cur.hourly_rate,
    active: fields.active !== undefined ? fields.active : cur.active,
    whatsapp_phone_e164: fields.whatsapp_phone_e164 !== undefined
      ? (fields.whatsapp_phone_e164?.trim() || null)
      : cur.whatsapp_phone_e164,
  };
  await execRetry(
    "UPDATE staff SET name=?, role=?, hourly_rate=?, whatsapp_phone_e164=?, active=?, archived_at=? WHERE id=?",
    [next.name, next.role, next.hourly_rate, next.whatsapp_phone_e164,
     next.active, next.active ? null : new Date().toISOString(), id]
  );
}

export async function archiveStaff(id: number): Promise<void> {
  await updateStaff(id, { active: 0 });
}

/**
 * Permanently deletes a staff row. Cascades to staff_hours via ON DELETE
 * CASCADE. Fails if the staff owns any staff_meetings or other non-cascading
 * references. Prefer archiveStaff() unless the row is a genuine mistake
 * (typo, test entry) with no history worth keeping.
 */
export async function hardDeleteStaff(id: number): Promise<void> {
  await execRetry("DELETE FROM staff WHERE id = ?", [id]);
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

/**
 * Count how many rows currently exist for (staffId, YYYY-MM). Used by the
 * OCR importer to show a "will replace N entries" confirmation before
 * wiping the month.
 */
export async function countHoursForStaffMonth(staffId: number, ym: string): Promise<number> {
  const d = await db();
  const rows = await d.select<Array<{ n: number }>>(
    "SELECT COUNT(*) AS n FROM staff_hours WHERE staff_id=? AND substr(work_date,1,7)=?",
    [staffId, ym]
  );
  return rows[0]?.n ?? 0;
}

export async function countHoursForStaff(staffId: number): Promise<number> {
  const d = await db();
  const rows = await d.select<Array<{ n: number }>>(
    "SELECT COUNT(*) AS n FROM staff_hours WHERE staff_id=?",
    [staffId]
  );
  return rows[0]?.n ?? 0;
}

export async function listMonthsForStaff(staffId: number): Promise<Array<{ ym: string; n: number }>> {
  const d = await db();
  return d.select<Array<{ ym: string; n: number }>>(
    `SELECT substr(work_date,1,7) AS ym, COUNT(*) AS n
       FROM staff_hours WHERE staff_id=?
      GROUP BY ym ORDER BY ym DESC`,
    [staffId]
  );
}

/**
 * Count meeting-action rows owned by this staff. `staff_meeting_actions`
 * has REFERENCES staff(id) with NO cascade, so any assigned action will
 * block hardDeleteStaff with a foreign-key error. Purge UI must surface
 * this as a blocker alongside `staff_hours` rows.
 */
export async function countMeetingActionsForStaff(staffId: number): Promise<number> {
  const d = await db();
  try {
    const rows = await d.select<Array<{ n: number }>>(
      "SELECT COUNT(*) AS n FROM staff_meeting_actions WHERE owner_staff_id=?",
      [staffId]
    );
    return rows[0]?.n ?? 0;
  } catch {
    // Table may not exist on very old databases pre-meetings migration —
    // treat as no blocker in that case.
    return 0;
  }
}

/**
 * Delete every staff_hours row for (staffId, YYYY-MM). Used before a fresh
 * OCR import so a re-read sheet cleanly replaces any prior data for that
 * staff/month — including stale dates the new import doesn't cover
 * (which a plain upsert would otherwise leave behind).
 *
 * NOTE: This wipes BOTH ocr-sourced and manual entries for that scope.
 * Manual corrections on the same month WILL be lost. The caller should
 * confirm with the user before invoking.
 */
export async function deleteHoursForStaffMonth(staffId: number, ym: string): Promise<number> {
  const before = await countHoursForStaffMonth(staffId, ym);
  await execRetry(
    "DELETE FROM staff_hours WHERE staff_id=? AND substr(work_date,1,7)=?",
    [staffId, ym]
  );
  return before;
}

/**
 * Verify the staff_hours table has every column the app needs. Returns null
 * when the schema is good, otherwise a human-readable error message that
 * names the missing columns. Use this before an OCR bulk import so we fail
 * loud instead of getting 21 silent per-row INSERT failures — the classic
 * symptom is "0 imported / N unmatched" when in fact all names DID match.
 */
// Known-good ALTER statements for columns that may be missing when the plugin's
// migration tracker got out of sync with reality (e.g. plugin recorded a
// migration as applied but the ALTER silently no-op'd, or the DB was restored
// from an older snapshot). Order matters only for readability.
const STAFF_HOURS_AUTOREPAIR: Record<string, string> = {
  no_lunch: "ALTER TABLE staff_hours ADD COLUMN no_lunch INTEGER NOT NULL DEFAULT 0",
};

export async function assertStaffHoursSchema(): Promise<string | null> {
  try {
    const d = await db();
    const cols = await d.select<Array<{ name: string }>>("PRAGMA table_info(staff_hours)");
    if (!cols || cols.length === 0) {
      return "Table 'staff_hours' does not exist. Reinstall the app or run migrations.";
    }
    const have = new Set(cols.map((c) => c.name));
    const required = [
      "staff_id", "work_date", "in_time", "out_time",
      "hours_decimal", "source", "sheet_image_path", "notes", "no_lunch",
    ];
    let missing = required.filter((c) => !have.has(c));
    if (missing.length === 0) return null;

    // Try to self-heal any missing columns we know how to add.
    const repairedNames: string[] = [];
    const unrepaired: string[] = [];
    for (const col of missing) {
      const sql = STAFF_HOURS_AUTOREPAIR[col];
      if (!sql) { unrepaired.push(col); continue; }
      try {
        await execRetry(sql, []);
        repairedNames.push(col);
        console.warn(`[schema] auto-repaired staff_hours.${col}`);
      } catch (e: any) {
        // If the column already exists (race / concurrent open), treat as OK.
        const msg = String(e?.message || e).toLowerCase();
        if (msg.includes("duplicate column")) {
          repairedNames.push(col);
        } else {
          console.error(`[schema] auto-repair FAILED for ${col}:`, e);
          unrepaired.push(col);
        }
      }
    }

    if (unrepaired.length > 0) {
      return `staff_hours is missing column(s): ${unrepaired.join(", ")}. Reinstall the latest DMG.`;
    }
    // Re-verify.
    const cols2 = await d.select<Array<{ name: string }>>("PRAGMA table_info(staff_hours)");
    const have2 = new Set(cols2.map((c) => c.name));
    missing = required.filter((c) => !have2.has(c));
    if (missing.length > 0) {
      return `staff_hours still missing after repair: ${missing.join(", ")}. Reinstall the latest DMG.`;
    }
    return null;
  } catch (e: any) {
    return `Schema check failed: ${e?.message || e}`;
  }
}

// Find best matching staff_id for a name from OCR. Case-insensitive exact, then prefix,
// then last-name, then fuzzy (Levenshtein ≤ 2) to survive OCR misreads like Kirk→Kiran.
export function matchStaffByName(name: string, staffList: Staff[]): Staff | null {
  // Strip leading/trailing non-alpha noise (e.g. "Kiranhe)" → "Kiranhe",
  // "*Judy" → "Judy"). Preserves internal spaces for last-name matching.
  const n = name
    .trim()
    .toLowerCase()
    .replace(/^[^a-zà-ÿ]+/, '')
    .replace(/[^a-zà-ÿ ]+$/, '')
    .trim();
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
  if (m) return m;
  // Fuzzy fallback — first-name Levenshtein for OCR misreads (Kirk→Kiran,
  // Chloé→Chloe, Sager→Sagar, JUand→Judy). Threshold 2 by default; bumped to
  // 3 when the first character matches AND the length differs by at most 2
  // (e.g. juand↔judy). Guards against 2-letter fuzz storms.
  const nFirst = n.split(/\s+/)[0];
  if (nFirst.length < 3) return null;
  let best: { s: Staff; d: number } | null = null;
  for (const s of staffList) {
    const sFirst = s.name.toLowerCase().split(/\s+/)[0];
    if (sFirst.length < 3) continue;
    const d = levenshtein(nFirst, sFirst);
    const sameFirstChar = nFirst[0] === sFirst[0];
    const lenDiff = Math.abs(nFirst.length - sFirst.length);
    const threshold = (sameFirstChar && lenDiff <= 2) ? 3 : 2;
    if (d <= threshold && (!best || d < best.d)) best = { s, d };
  }
  return best ? best.s : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let curr = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, curr + 1, prev[j - 1] + cost);
      prev[j - 1] = curr;
      curr = next;
    }
    prev[b.length] = curr;
  }
  return prev[b.length];
}

export { hoursBetween };
