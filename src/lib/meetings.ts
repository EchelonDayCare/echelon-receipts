// Staff Meeting Notes — CRUD + action-item helpers.
//
// Meetings are never hard-deleted; voiding is a status flip so historical
// notes remain auditable. Action items live in their own table so we can
// later add "my open action items" style dashboards without JSON parsing.
import { db, execRetry } from "./db";
import type { StaffMeeting, StaffMeetingAction } from "../types";

export interface MeetingWithActions {
  meeting: StaffMeeting;
  actions: StaffMeetingAction[];
}

export async function listMeetings(includeVoided = false): Promise<StaffMeeting[]> {
  const where = includeVoided ? "" : "WHERE voided = 0";
  return await (await db()).select<StaffMeeting[]>(
    `SELECT * FROM staff_meetings ${where} ORDER BY meeting_date DESC, id DESC`
  );
}

export async function getMeeting(id: number): Promise<MeetingWithActions | null> {
  const d = await db();
  const m = await d.select<StaffMeeting[]>("SELECT * FROM staff_meetings WHERE id=?", [id]);
  if (m.length === 0) return null;
  const a = await d.select<StaffMeetingAction[]>(
    "SELECT * FROM staff_meeting_actions WHERE meeting_id=? ORDER BY done ASC, id ASC",
    [id]
  );
  return { meeting: m[0], actions: a };
}

export async function createMeeting(fields: {
  meeting_date: string;
  title: string;
  agenda?: string | null;
  notes?: string | null;
  attendee_ids?: number[];
}): Promise<number> {
  if (!fields.title?.trim()) throw new Error("Title is required.");
  if (!fields.meeting_date) throw new Error("Meeting date is required.");
  const attendees = JSON.stringify(fields.attendee_ids ?? []);
  const r = await execRetry(
    `INSERT INTO staff_meetings(meeting_date, title, agenda, notes, attendees_json)
     VALUES(?, ?, ?, ?, ?)`,
    [fields.meeting_date, fields.title.trim(), fields.agenda ?? null, fields.notes ?? null, attendees]
  );
  return Number(r.lastInsertId);
}

export async function updateMeeting(id: number, fields: {
  meeting_date?: string;
  title?: string;
  agenda?: string | null;
  notes?: string | null;
  attendee_ids?: number[];
}): Promise<void> {
  const d = await db();
  const cur = (await d.select<StaffMeeting[]>("SELECT * FROM staff_meetings WHERE id=?", [id]))[0];
  if (!cur) throw new Error("Meeting not found.");
  const next = {
    meeting_date: fields.meeting_date ?? cur.meeting_date,
    title: (fields.title ?? cur.title).trim(),
    agenda: fields.agenda !== undefined ? fields.agenda : cur.agenda,
    notes: fields.notes !== undefined ? fields.notes : cur.notes,
    attendees_json: fields.attendee_ids !== undefined
      ? JSON.stringify(fields.attendee_ids)
      : cur.attendees_json,
  };
  await execRetry(
    `UPDATE staff_meetings SET
       meeting_date=?, title=?, agenda=?, notes=?, attendees_json=?,
       updated_at=datetime('now')
     WHERE id=?`,
    [next.meeting_date, next.title, next.agenda, next.notes, next.attendees_json, id]
  );
}

export async function voidMeeting(id: number, reason?: string): Promise<void> {
  await execRetry(
    "UPDATE staff_meetings SET voided=1, voided_at=datetime('now'), void_reason=? WHERE id=?",
    [reason ?? null, id]
  );
}

// ---------- Action items ----------
export async function addAction(meetingId: number, fields: {
  text: string; owner_staff_id?: number | null; due_date?: string | null;
}): Promise<number> {
  if (!fields.text?.trim()) throw new Error("Action text is required.");
  const r = await execRetry(
    `INSERT INTO staff_meeting_actions(meeting_id, text, owner_staff_id, due_date)
     VALUES(?, ?, ?, ?)`,
    [meetingId, fields.text.trim(), fields.owner_staff_id ?? null, fields.due_date ?? null]
  );
  return Number(r.lastInsertId);
}

export async function updateAction(id: number, fields: {
  text?: string; owner_staff_id?: number | null; due_date?: string | null;
}): Promise<void> {
  const d = await db();
  const cur = (await d.select<StaffMeetingAction[]>("SELECT * FROM staff_meeting_actions WHERE id=?", [id]))[0];
  if (!cur) return;
  const next = {
    text: (fields.text ?? cur.text).trim(),
    owner_staff_id: fields.owner_staff_id !== undefined ? fields.owner_staff_id : cur.owner_staff_id,
    due_date: fields.due_date !== undefined ? fields.due_date : cur.due_date,
  };
  await execRetry(
    "UPDATE staff_meeting_actions SET text=?, owner_staff_id=?, due_date=? WHERE id=?",
    [next.text, next.owner_staff_id, next.due_date, id]
  );
}

export async function toggleAction(id: number, done: boolean): Promise<void> {
  await execRetry(
    "UPDATE staff_meeting_actions SET done=?, done_at=? WHERE id=?",
    [done ? 1 : 0, done ? new Date().toISOString() : null, id]
  );
}

export async function deleteAction(id: number): Promise<void> {
  // Actions can be removed outright — they're workflow items, not audit
  // records like the parent meeting is.
  await execRetry("DELETE FROM staff_meeting_actions WHERE id=?", [id]);
}
