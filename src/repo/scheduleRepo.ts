// Staff Schedule repository (v1.2.0). All shift CRUD + weekly publish record
// keeping. Data-Contract compliant (UUID PKs, ISO UTC timestamps, soft
// delete, optimistic concurrency, per-entity event log).
import { db, execRetry, serializeWrite } from "../lib/db";
import { uuidv4, nowIso, StaleWriteError } from "./ids";

export type ShiftStatus =
  | "planned"
  | "confirmed"
  | "cancelled"
  | "swapped"
  // v2.6.3 absence statuses. Times default to 09:00–17:00 as placeholders
  // but `shiftHours` returns 0 for these so they never inflate weekly /
  // monthly totals. Rendered in the grid as a coloured "Vacation" /
  // "Sick" / "Day off" chip instead of start–end times.
  | "vacation"
  | "sick"
  | "day_off";

/** True iff this status contributes worked hours to totals. */
export function isWorkedStatus(status: ShiftStatus): boolean {
  return status === "planned" || status === "confirmed" || status === "swapped";
}

/** Short human label for absence statuses; null for worked statuses. */
export function absenceLabel(status: ShiftStatus): string | null {
  switch (status) {
    case "vacation": return "Vacation";
    case "sick": return "Sick";
    case "day_off": return "Day off";
    default: return null;
  }
}

export type StaffShift = {
  id: string;
  staffId: string;
  shiftDate: string;   // YYYY-MM-DD
  startTime: string;   // HH:MM
  endTime: string;     // HH:MM
  room: string | null;
  breakMinutes: number;
  notes: string | null;
  status: ShiftStatus;
  revisionOf: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  deletedAt: string | null;
};

export type NewShift = {
  staffId: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  room?: string | null;
  breakMinutes?: number;
  notes?: string | null;
  status?: ShiftStatus;
};

type ShiftRow = {
  id: string; staff_id: string; shift_date: string;
  start_time: string; end_time: string;
  room: string | null; break_minutes: number; notes: string | null;
  status: string; revision_of: string | null;
  created_at: string; updated_at: string; updated_by: string;
  version: number; deleted_at: string | null;
};

function rowToShift(r: ShiftRow): StaffShift {
  return {
    id: r.id, staffId: r.staff_id, shiftDate: r.shift_date,
    startTime: r.start_time, endTime: r.end_time, room: r.room,
    breakMinutes: r.break_minutes, notes: r.notes,
    status: r.status as ShiftStatus, revisionOf: r.revision_of,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
    version: r.version, deletedAt: r.deleted_at,
  };
}

async function writeEvent(entityId: string, eventType: string, payload?: unknown, channel?: string, messageRef?: string) {
  await execRetry(
    "INSERT INTO staff_shift_events (id, entity_id, event_type, payload_json, actor, channel, message_ref, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)",
    [uuidv4(), entityId, eventType, payload === undefined ? null : JSON.stringify(payload), channel ?? null, messageRef ?? null, nowIso()],
  );
}

// Monday of the ISO week that contains `date`. Returns YYYY-MM-DD (local).
export function mondayOf(date: Date): string {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/**
 * Paid hours for a scheduled shift, mirroring the Hours-tab `paidHours`
 * rule (`src/lib/staff.ts`): raw duration minus the shift's explicit
 * `breakMinutes` when non-zero; otherwise minus a 30-minute unpaid
 * lunch when the raw shift is 5 hours or more. Under 5 hours: no
 * deduction. Never negative.
 *
 * The auto-30-min-if-≥5h path was added in v2.6.3 so the Schedule
 * tab's Total column reads the same numbers payroll sees on the
 * Hours tab. Explicit `breakMinutes` in the shift drawer still wins,
 * so managers can override the auto rule per shift (e.g. a 6-hour
 * shift the worker will take at their desk).
 */
export function shiftHours(s: Pick<StaffShift, "startTime" | "endTime" | "breakMinutes"> & { status?: ShiftStatus }): number {
  // v2.6.3: absence rows are placeholders with no paid hours. They may
  // carry non-zero start/end times (drawer defaults to 09:00–17:00) so
  // the row renders sensibly, but we never let those minutes contribute
  // to weekly/monthly totals.
  if (s.status && !isWorkedStatus(s.status)) return 0;
  const [sh, sm] = s.startTime.split(":").map(Number);
  const [eh, em] = s.endTime.split(":").map(Number);
  const rawMinutes = (eh * 60 + em) - (sh * 60 + sm);
  if (rawMinutes <= 0) return 0;
  const explicit = s.breakMinutes || 0;
  const deduct = explicit > 0
    ? explicit
    : (rawMinutes >= 5 * 60 ? 30 : 0);
  return Math.max(0, (rawMinutes - deduct) / 60);
}

export async function listShiftsForWeek(mondayISO: string): Promise<StaffShift[]> {
  const sunday = addDays(mondayISO, 6);
  const d = await db();
  const rows = await d.select<ShiftRow[]>(
    "SELECT * FROM staff_shifts WHERE deleted_at IS NULL AND shift_date >= ? AND shift_date <= ? ORDER BY shift_date, start_time",
    [mondayISO, sunday],
  );
  return rows.map(rowToShift);
}

export async function listShiftsForStaffWeek(staffId: string, mondayISO: string): Promise<StaffShift[]> {
  const sunday = addDays(mondayISO, 6);
  const d = await db();
  const rows = await d.select<ShiftRow[]>(
    "SELECT * FROM staff_shifts WHERE deleted_at IS NULL AND staff_id = ? AND shift_date >= ? AND shift_date <= ? ORDER BY shift_date, start_time",
    [staffId, mondayISO, sunday],
  );
  return rows.map(rowToShift);
}

/**
 * v2.6.3: list every non-deleted shift in the given calendar month
 * (year is 4-digit, month is 1-12). Used by the Schedule tab's
 * "Month total" column so the owner can see accumulated hours across
 * the whole month while still working week-by-week.
 */
export async function listShiftsForMonth(year: number, month: number): Promise<StaffShift[]> {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  // Last-of-month via day-0-of-next-month trick.
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const d = await db();
  const rows = await d.select<ShiftRow[]>(
    "SELECT * FROM staff_shifts WHERE deleted_at IS NULL AND shift_date >= ? AND shift_date <= ? ORDER BY shift_date, start_time",
    [start, end],
  );
  return rows.map(rowToShift);
}

/**
 * v2.6.3: live (not soft-deleted, not cancelled) shifts scheduled on any
 * of the given ISO dates. Used by the closure-impact modal to warn (and
 * offer to cancel) when the owner marks a previously-open day closed —
 * either from Centre Calendar or by toggling a stat holiday in Settings.
 *
 * By default only shifts on or after today are returned — historical
 * shifts on the affected days are payroll history and shouldn't be
 * touched by a calendar edit. Pass `{ includePast: true }` to override
 * (unused today; kept for future audit tooling).
 */
export async function listLiveShiftsOnDates(
  isoDates: string[],
  opts: { includePast?: boolean } = {},
): Promise<StaffShift[]> {
  if (isoDates.length === 0) return [];
  const d = await db();
  // De-dupe + build the parameter list. SQLite has a 999-parameter
  // ceiling by default; a stat-holiday sweep across ~12 months of the
  // year hits ~12 dates so we're nowhere near it, but chunk defensively.
  const uniq = Array.from(new Set(isoDates));
  const today = new Date();
  const todayIso =
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-` +
    `${String(today.getDate()).padStart(2, "0")}`;
  const chunkSize = 500;
  const rows: ShiftRow[] = [];
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const sql = opts.includePast
      ? `SELECT * FROM staff_shifts
          WHERE deleted_at IS NULL
            AND status != 'cancelled'
            AND shift_date IN (${placeholders})
          ORDER BY shift_date, start_time`
      : `SELECT * FROM staff_shifts
          WHERE deleted_at IS NULL
            AND status != 'cancelled'
            AND shift_date >= ?
            AND shift_date IN (${placeholders})
          ORDER BY shift_date, start_time`;
    const params = opts.includePast ? chunk : [todayIso, ...chunk];
    const part = await d.select<ShiftRow[]>(sql, params);
    rows.push(...part);
  }
  return rows.map(rowToShift);
}

export async function getShift(id: string): Promise<StaffShift | null> {
  const d = await db();
  const rows = await d.select<ShiftRow[]>("SELECT * FROM staff_shifts WHERE id = ?", [id]);
  return rows.length ? rowToShift(rows[0]) : null;
}

/**
 * True if a live (not cancelled, not soft-deleted) shift already exists
 * for this staff member on this date. Optionally exclude a specific shift
 * id — used by updateShift when a date change would otherwise collide
 * with the row being edited itself.
 */
export async function hasExistingShift(staffId: string, shiftDate: string, exceptId?: string): Promise<boolean> {
  const d = await db();
  const rows = await d.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM staff_shifts
     WHERE staff_id = ? AND shift_date = ?
       AND deleted_at IS NULL AND status != 'cancelled'
       ${exceptId ? "AND id != ?" : ""}`,
    exceptId ? [staffId, shiftDate, exceptId] : [staffId, shiftDate],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function createShift(shift: NewShift): Promise<StaffShift> {
  if (shift.endTime <= shift.startTime) throw new Error("End time must be after start time.");
  // One-shift-per-person-per-day rule. A cancelled or soft-deleted row does
  // not count — those are historical and shouldn't block a new plan.
  const dupe = await hasExistingShift(shift.staffId, shift.shiftDate);
  if (dupe) throw new Error("This staff member already has a shift on this day. Edit the existing shift instead of adding another.");
  const id = uuidv4();
  const now = nowIso();
  await execRetry(
    `INSERT INTO staff_shifts (
      id, staff_id, shift_date, start_time, end_time, room, break_minutes,
      notes, status, revision_of, created_at, updated_at, updated_by, version, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'owner', 1, NULL)`,
    [
      id, shift.staffId, shift.shiftDate, shift.startTime, shift.endTime,
      shift.room ?? null, shift.breakMinutes ?? 0, shift.notes ?? null,
      shift.status ?? "planned", now, now,
    ],
  );
  await writeEvent(id, "created", { staffId: shift.staffId, shiftDate: shift.shiftDate, startTime: shift.startTime, endTime: shift.endTime });
  const created = await getShift(id);
  if (!created) throw new Error("Shift disappeared after insert");
  return created;
}

export type ShiftPatch = Partial<Omit<NewShift, "staffId">>;

export async function updateShift(id: string, patch: ShiftPatch, expectedVersion: number): Promise<StaffShift> {
  const cur = await getShift(id);
  if (!cur) throw new Error("Shift not found");
  const next: StaffShift = {
    ...cur,
    shiftDate: patch.shiftDate ?? cur.shiftDate,
    startTime: patch.startTime ?? cur.startTime,
    endTime: patch.endTime ?? cur.endTime,
    room: patch.room !== undefined ? patch.room ?? null : cur.room,
    breakMinutes: patch.breakMinutes ?? cur.breakMinutes,
    notes: patch.notes !== undefined ? patch.notes ?? null : cur.notes,
    status: patch.status ?? cur.status,
  };
  if (next.endTime <= next.startTime) throw new Error("End time must be after start time.");
  // Reinstating a cancelled shift, or moving a shift to a new date, must
  // not collide with another live shift for the same staff+date.
  if (next.status !== "cancelled" && (next.shiftDate !== cur.shiftDate || cur.status === "cancelled")) {
    const dupe = await hasExistingShift(cur.staffId, next.shiftDate, id);
    if (dupe) throw new Error("This staff member already has another shift on that day.");
  }
  const now = nowIso();
  const res = await execRetry(
    `UPDATE staff_shifts
        SET shift_date = ?, start_time = ?, end_time = ?, room = ?,
            break_minutes = ?, notes = ?, status = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?`,
    [next.shiftDate, next.startTime, next.endTime, next.room, next.breakMinutes, next.notes, next.status, now, id, expectedVersion],
  );
  if (res.rowsAffected === 0) throw new StaleWriteError("Shift");
  await writeEvent(id, "updated", { before: cur, after: next });
  const after = await getShift(id);
  return after!;
}

export async function cancelShift(id: string, expectedVersion: number, reason?: string): Promise<void> {
  const cur = await getShift(id);
  if (!cur) return;
  const now = nowIso();
  const res = await execRetry(
    "UPDATE staff_shifts SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
    [now, id, expectedVersion],
  );
  if (res.rowsAffected === 0) throw new StaleWriteError("Shift");
  // v2.6.3: record the previous status so a later `restoreShift` can put
  // the shift back exactly where it was (planned / confirmed / swapped /
  // absence) rather than blindly downgrading to planned.
  await writeEvent(id, "cancelled", {
    reason: reason ?? null,
    prev_status: cur.status,
    was: { start: cur.startTime, end: cur.endTime, room: cur.room },
  });
}

/** v2.6.3: undo a cancel. Restores the shift to its previous status (as
 *  recorded in the `cancelled` audit event) or "planned" as a safe fallback.
 *
 *  Guards against the one-shift-per-day partial unique index by checking
 *  `hasExistingShift` first — surfaces a friendly domain error instead of
 *  a raw SQLite constraint exception if the owner already re-scheduled
 *  the same (staff, date) after the cancel. */
export async function restoreShift(id: string, expectedVersion: number): Promise<StaffShift> {
  const cur = await getShift(id);
  if (!cur) throw new Error("Shift not found");
  if (cur.status !== "cancelled") throw new Error("Only cancelled shifts can be restored");
  // Fast check for the one-shift-per-day rule so we return a clean error
  // instead of a raw SQLite constraint from the partial unique index.
  const conflict = await hasExistingShift(cur.staffId, cur.shiftDate, id);
  if (conflict) {
    throw new Error("Cannot restore — this staff member already has another shift on this day.");
  }
  // Recover the prior status from the most recent `cancelled` event.
  // Falls back to "planned" for legacy rows that predate the prev_status
  // audit-payload change (v2.6.3 and earlier).
  const events = await listEventsForShift(id);
  let prevStatus: ShiftStatus = "planned";
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.eventType === "cancelled") {
      const raw = (ev.payload as { prev_status?: unknown } | null)?.prev_status;
      if (raw === "planned" || raw === "confirmed" || raw === "swapped" || raw === "vacation" || raw === "sick" || raw === "day_off") {
        prevStatus = raw;
      }
      break;
    }
  }
  const now = nowIso();
  const res = await execRetry(
    "UPDATE staff_shifts SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
    [prevStatus, now, id, expectedVersion],
  );
  if (res.rowsAffected === 0) throw new StaleWriteError("Shift");
  await writeEvent(id, "restored", { restored_to: prevStatus });
  const restored = await getShift(id);
  if (!restored) throw new Error("Shift disappeared after restore");
  return restored;
}

/** v2.6.3: list shifts cancelled within the past `days` days (default 7),
 *  most-recent first. Powers the "Recently cancelled" panel on Schedule. */
export async function listRecentlyCancelled(days = 7): Promise<StaffShift[]> {
  const d = await db();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();
  const rows = await d.select<ShiftRow[]>(
    `SELECT * FROM staff_shifts
     WHERE status = 'cancelled' AND deleted_at IS NULL AND updated_at >= ?
     ORDER BY updated_at DESC
     LIMIT 200`,
    [cutoffIso],
  );
  return rows.map(rowToShift);
}

export async function softDeleteShift(id: string, expectedVersion: number): Promise<void> {
  const now = nowIso();
  // Serialize with concurrent publish writes so we can't race a publish add
  // vs our removal. All writes inside the block must use the raw connection
  // (`d.execute`) — `execRetry` internally calls `serializeWrite`, so using it
  // here would self-deadlock the whole app-wide write queue.
  let unlinkedPublishes = 0;
  await serializeWrite(async () => {
    const d = await db();
    // 1. Soft-delete the shift row itself.
    const res = await d.execute(
      "UPDATE staff_shifts SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL AND version = ?",
      [now, now, id, expectedVersion],
    );
    if (res.rowsAffected === 0) throw new StaleWriteError("Shift");

    // 2. Clean up any staff_weekly_publish rows that reference this shift so a
    //    published week no longer points at a ghost id. Without this, viewing
    //    a past publish would show a soft-deleted shift as still-scheduled
    //    (data-integrity bug in the schedule audit + WhatsApp re-send flows).
    const referencing = await d.select<Array<{ id: string; shift_ids_json: string }>>(
      "SELECT id, shift_ids_json FROM staff_weekly_publish WHERE deleted_at IS NULL AND shift_ids_json LIKE ?",
      [`%${id}%`],
    );
    for (const row of referencing) {
      let ids: string[] = [];
      try { ids = JSON.parse(row.shift_ids_json || "[]"); } catch { continue; }
      if (!ids.includes(id)) continue; // false-positive LIKE hit (id fragment)
      const filtered = ids.filter((x) => x !== id);
      await d.execute(
        "UPDATE staff_weekly_publish SET shift_ids_json = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        [JSON.stringify(filtered), now, row.id],
      );
      unlinkedPublishes++;
    }
  });

  // writeEvent takes serializeWrite itself, so it MUST run after the guarded
  // block above has released the write queue.
  await writeEvent(id, "deleted", { unlinked_publishes: unlinkedPublishes });
}

// Reassign: cancels the old shift + inserts a mirror on the new staff.
// Returns both rows so the UI can prompt WhatsApp for both people.
//
// H-5: the cancel + insert (+ revision_of link, folded directly into the
// INSERT below) run as one serialized unit so no other writer's statements
// land in between. We can't use a literal SQL BEGIN/COMMIT here —
// tauri-plugin-sql's sqlx pool may hand subsequent statements to a
// different physical connection (see the serializeWrite doc comment at the
// top of lib/db.ts) — so true crash-atomicity isn't available. Instead we
// do the closest practical thing: if the insert fails after the cancel
// already committed, we attempt a best-effort compensating rollback of the
// cancel before rethrowing, so a failed reassignment doesn't silently
// strand the original shift as cancelled with no replacement.
export async function reassignShift(id: string, newStaffId: string): Promise<{ cancelled: StaffShift; created: StaffShift }> {
  const cur = await getShift(id);
  if (!cur) throw new Error("Shift not found");
  const newId = uuidv4();
  const now = nowIso();
  const reason = `Reassigned to staff ${newStaffId}`;

  await serializeWrite(async () => {
    const d = await db();
    const cancelRes = await d.execute(
      "UPDATE staff_shifts SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
      [now, id, cur.version],
    );
    if (cancelRes.rowsAffected === 0) throw new StaleWriteError("Shift");
    try {
      await d.execute(
        `INSERT INTO staff_shifts (
          id, staff_id, shift_date, start_time, end_time, room, break_minutes,
          notes, status, revision_of, created_at, updated_at, updated_by, version, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, 'owner', 1, NULL)`,
        [newId, newStaffId, cur.shiftDate, cur.startTime, cur.endTime, cur.room, cur.breakMinutes, cur.notes, id, now, now],
      );
    } catch (insertErr) {
      await d.execute(
        "UPDATE staff_shifts SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        [cur.status, nowIso(), id],
      ).catch(() => { /* best-effort compensation only */ });
      throw insertErr;
    }
  });

  await writeEvent(id, "cancelled", { reason, was: { start: cur.startTime, end: cur.endTime, room: cur.room } });
  await writeEvent(newId, "reassigned", { fromShift: id, fromStaff: cur.staffId, toStaff: newStaffId });
  const cancelled = await getShift(id);
  const newShift = await getShift(newId);
  return { cancelled: cancelled!, created: newShift! };
}

// Copy every shift from one week to another, generating fresh UUIDs and
// offsetting dates by 7 days per source week jump. Skips destination days
// that already have shifts so a partial re-run doesn't duplicate.
export async function copyWeek(fromMondayISO: string, toMondayISO: string): Promise<StaffShift[]> {
  const src = await listShiftsForWeek(fromMondayISO);
  if (src.length === 0) return [];
  const dstStart = toMondayISO;
  const dstEnd = addDays(toMondayISO, 6);
  const d = await db();
  const existing = await d.select<{ staff_id: string; shift_date: string }[]>(
    "SELECT staff_id, shift_date FROM staff_shifts WHERE deleted_at IS NULL AND shift_date >= ? AND shift_date <= ?",
    [dstStart, dstEnd],
  );
  const skip = new Set(existing.map((r) => `${r.staff_id}|${r.shift_date}`));
  const offset = daysBetween(fromMondayISO, toMondayISO);
  const created: StaffShift[] = [];
  for (const s of src) {
    const newDate = addDays(s.shiftDate, offset);
    if (skip.has(`${s.staffId}|${newDate}`)) continue;
    const c = await createShift({
      staffId: s.staffId, shiftDate: newDate,
      startTime: s.startTime, endTime: s.endTime,
      room: s.room, breakMinutes: s.breakMinutes, notes: s.notes,
      status: "planned",
    });
    created.push(c);
  }
  return created;
}

function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const a = new Date(fy, fm - 1, fd).getTime();
  const b = new Date(ty, tm - 1, td).getTime();
  return Math.round((b - a) / 86_400_000);
}

// ─── Weekly publish records ──────────────────────────────────────────────
export type PublishRow = {
  id: string; staffId: string; weekStartDate: string;
  shiftIds: string[]; messageBody: string; waMeUrl: string;
  publishedAt: string; acknowledgedAt: string | null; ackNotes: string | null;
  version: number;
};

type PublishRawRow = {
  id: string; staff_id: string; week_start_date: string;
  shift_ids_json: string; message_body: string; wa_me_url: string;
  published_at: string; acknowledged_at: string | null; ack_notes: string | null;
  version: number;
};

function pubRowToObj(r: PublishRawRow): PublishRow {
  let ids: string[] = [];
  try { ids = JSON.parse(r.shift_ids_json || "[]"); } catch { /* leave empty */ }
  return {
    id: r.id, staffId: r.staff_id, weekStartDate: r.week_start_date,
    shiftIds: ids, messageBody: r.message_body, waMeUrl: r.wa_me_url,
    publishedAt: r.published_at, acknowledgedAt: r.acknowledged_at,
    ackNotes: r.ack_notes, version: r.version,
  };
}

export async function recordWeeklyPublish(
  staffId: string, weekStartISO: string, shiftIds: string[], messageBody: string, waMeUrl: string,
): Promise<PublishRow> {
  const id = uuidv4();
  const now = nowIso();
  await serializeWrite(async () => {
    const dd = await db();
    // ON CONFLICT emulation: try INSERT, on constraint failure delete the
    // prior row for that (staff, week) and re-insert. Preserves the "one
    // publish per staff per week" invariant while still allowing re-publish
    // after a schedule change.
    try {
      await dd.execute(
        `INSERT INTO staff_weekly_publish (
          id, staff_id, week_start_date, shift_ids_json, message_body, wa_me_url,
          published_at, acknowledged_at, ack_notes, created_at, updated_at,
          updated_by, version, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'owner', 1, NULL)`,
        [id, staffId, weekStartISO, JSON.stringify(shiftIds), messageBody, waMeUrl, now, now, now],
      );
    } catch (e: any) {
      if (!/UNIQUE/i.test(String(e?.message ?? e))) throw e;
      await dd.execute(
        `UPDATE staff_weekly_publish
            SET shift_ids_json = ?, message_body = ?, wa_me_url = ?,
                published_at = ?, updated_at = ?, version = version + 1,
                acknowledged_at = NULL, ack_notes = NULL
          WHERE staff_id = ? AND week_start_date = ?`,
        [JSON.stringify(shiftIds), messageBody, waMeUrl, now, now, staffId, weekStartISO],
      );
    }
  });
  for (const sid of shiftIds) {
    await writeEvent(sid, "week_published", { staffId, weekStartISO }, "wa.me", waMeUrl);
  }
  const rows = await (await db()).select<PublishRawRow[]>(
    "SELECT * FROM staff_weekly_publish WHERE staff_id = ? AND week_start_date = ?",
    [staffId, weekStartISO],
  );
  return pubRowToObj(rows[0]);
}

export async function listWeeklyPublishes(weekStartISO: string): Promise<PublishRow[]> {
  const d = await db();
  const rows = await d.select<PublishRawRow[]>(
    "SELECT * FROM staff_weekly_publish WHERE week_start_date = ? AND deleted_at IS NULL",
    [weekStartISO],
  );
  return rows.map(pubRowToObj);
}

export async function listRecentPublishes(limit = 40): Promise<PublishRow[]> {
  const d = await db();
  const rows = await d.select<PublishRawRow[]>(
    "SELECT * FROM staff_weekly_publish WHERE deleted_at IS NULL ORDER BY published_at DESC LIMIT ?",
    [limit],
  );
  return rows.map(pubRowToObj);
}

export async function markPublishAcknowledged(publishId: string, expectedVersion: number, notes?: string): Promise<void> {
  const now = nowIso();
  const res = await execRetry(
    "UPDATE staff_weekly_publish SET acknowledged_at = ?, ack_notes = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
    [now, notes ?? null, now, publishId, expectedVersion],
  );
  if (res.rowsAffected === 0) throw new StaleWriteError("Weekly publish record");
}

// ─── Events (audit) ─────────────────────────────────────────────────────
export type ShiftEvent = {
  id: string; entityId: string; eventType: string; payload: unknown;
  actor: string; channel: string | null; messageRef: string | null; createdAt: string;
};

export async function listAuditForWeek(mondayISO: string): Promise<ShiftEvent[]> {
  const sunday = addDays(mondayISO, 6);
  const d = await db();
  const rows = await d.select<{
    id: string; entity_id: string; event_type: string; payload_json: string | null;
    actor: string; channel: string | null; message_ref: string | null; created_at: string;
  }[]>(
    `SELECT e.*
       FROM staff_shift_events e
       LEFT JOIN staff_shifts s ON s.id = e.entity_id
      WHERE (s.shift_date IS NULL OR (s.shift_date >= ? AND s.shift_date <= ?))
        AND e.created_at >= ?
      ORDER BY e.created_at DESC
      LIMIT 500`,
    [mondayISO, sunday, mondayISO],
  );
  return rows.map((r) => ({
    id: r.id, entityId: r.entity_id, eventType: r.event_type,
    payload: r.payload_json ? safeJson(r.payload_json) : null,
    actor: r.actor, channel: r.channel, messageRef: r.message_ref, createdAt: r.created_at,
  }));
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return s; } }

/** v2.6.3: list all audit events for a single shift, oldest first.
 *  Used by `restoreShift` to recover the pre-cancel status. */
export async function listEventsForShift(shiftId: string): Promise<ShiftEvent[]> {
  const d = await db();
  const rows = await d.select<{
    id: string; entity_id: string; event_type: string; payload_json: string | null;
    actor: string; channel: string | null; message_ref: string | null; created_at: string;
  }[]>(
    `SELECT * FROM staff_shift_events WHERE entity_id = ? ORDER BY created_at ASC LIMIT 200`,
    [shiftId],
  );
  return rows.map((r) => ({
    id: r.id, entityId: r.entity_id, eventType: r.event_type,
    payload: r.payload_json ? safeJson(r.payload_json) : null,
    actor: r.actor, channel: r.channel, messageRef: r.message_ref, createdAt: r.created_at,
  }));
}
