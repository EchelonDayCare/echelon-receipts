// Meetings repo (v1.3.0) — Organizer's meeting log + action items.
import { db, execRetry } from "../lib/db";
import { uuidv4, nowIso } from "./ids";

export type MeetingKind = "board" | "parent" | "staff" | "vendor" | "inspection" | "other";
export type LinkedKind = "student" | "staff" | "waitlist" | "document" | null;

export type Meeting = {
  id: string;
  meetingDate: string;
  meetingTime: string | null;
  kind: MeetingKind;
  subject: string;
  attendeesText: string | null;
  linkedKind: LinkedKind;
  linkedId: string | null;
  notesMd: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type MeetingAction = {
  id: string;
  meetingId: string;
  description: string;
  ownerText: string | null;
  dueDate: string | null;
  doneAt: string | null;
  createdAt: string;
  version: number;
};

type MtgRow = {
  id: string; meeting_date: string; meeting_time: string | null;
  kind: string; subject: string; attendees_text: string | null;
  linked_kind: string | null; linked_id: string | null;
  notes_md: string | null; created_at: string; updated_at: string;
  version: number; deleted_at: string | null;
};
function rowToMtg(r: MtgRow): Meeting {
  return {
    id: r.id, meetingDate: r.meeting_date, meetingTime: r.meeting_time,
    kind: r.kind as MeetingKind, subject: r.subject, attendeesText: r.attendees_text,
    linkedKind: (r.linked_kind as LinkedKind) ?? null, linkedId: r.linked_id,
    notesMd: r.notes_md, createdAt: r.created_at, updatedAt: r.updated_at,
    version: r.version,
  };
}
type ActRow = {
  id: string; meeting_id: string; description: string; owner_text: string | null;
  due_date: string | null; done_at: string | null; created_at: string;
  version: number; deleted_at: string | null;
};
function rowToAct(r: ActRow): MeetingAction {
  return {
    id: r.id, meetingId: r.meeting_id, description: r.description,
    ownerText: r.owner_text, dueDate: r.due_date, doneAt: r.done_at,
    createdAt: r.created_at, version: r.version,
  };
}

async function writeEvent(entityId: string, eventType: string, payload?: unknown) {
  await execRetry(
    "INSERT INTO meeting_events (id, entity_id, event_type, payload_json, actor, created_at) VALUES (?, ?, ?, ?, 'owner', ?)",
    [uuidv4(), entityId, eventType, payload === undefined ? null : JSON.stringify(payload), nowIso()],
  );
}

export async function listRecentMeetings(limit = 5): Promise<Meeting[]> {
  const d = await db();
  const rows = await d.select<MtgRow[]>(
    "SELECT * FROM meetings WHERE deleted_at IS NULL ORDER BY meeting_date DESC, meeting_time DESC LIMIT ?",
    [limit],
  );
  return rows.map(rowToMtg);
}

export async function listAllMeetings(): Promise<Meeting[]> {
  const d = await db();
  const rows = await d.select<MtgRow[]>("SELECT * FROM meetings WHERE deleted_at IS NULL ORDER BY meeting_date DESC");
  return rows.map(rowToMtg);
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  const d = await db();
  const rows = await d.select<MtgRow[]>("SELECT * FROM meetings WHERE id = ?", [id]);
  return rows.length ? rowToMtg(rows[0]) : null;
}

export type NewMeeting = Omit<Meeting, "id" | "createdAt" | "updatedAt" | "version">;

export async function createMeeting(m: NewMeeting): Promise<Meeting> {
  const id = uuidv4();
  const now = nowIso();
  await execRetry(
    `INSERT INTO meetings (id, meeting_date, meeting_time, kind, subject, attendees_text, linked_kind, linked_id, notes_md, created_at, updated_at, updated_by, version, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', 1, NULL)`,
    [id, m.meetingDate, m.meetingTime, m.kind, m.subject, m.attendeesText, m.linkedKind, m.linkedId, m.notesMd, now, now],
  );
  await writeEvent(id, "created", { subject: m.subject, kind: m.kind });
  return (await getMeeting(id))!;
}

export async function updateMeeting(id: string, patch: Partial<NewMeeting>, expectedVersion: number): Promise<Meeting> {
  const cur = await getMeeting(id);
  if (!cur) throw new Error("Meeting not found");
  const nx = { ...cur, ...patch };
  const now = nowIso();
  const res = await execRetry(
    `UPDATE meetings
        SET meeting_date = ?, meeting_time = ?, kind = ?, subject = ?, attendees_text = ?,
            linked_kind = ?, linked_id = ?, notes_md = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?`,
    [nx.meetingDate, nx.meetingTime, nx.kind, nx.subject, nx.attendeesText, nx.linkedKind, nx.linkedId, nx.notesMd, now, id, expectedVersion],
  );
  if (res.rowsAffected === 0) throw new Error("Meeting was changed by another writer. Please reload.");
  await writeEvent(id, "updated", { subject: nx.subject });
  return (await getMeeting(id))!;
}

export async function softDeleteMeeting(id: string): Promise<void> {
  const now = nowIso();
  await execRetry("UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [now, now, id]);
  await writeEvent(id, "deleted", {});
}

export async function listActions(meetingId: string): Promise<MeetingAction[]> {
  const d = await db();
  const rows = await d.select<ActRow[]>(
    "SELECT * FROM meeting_actions WHERE deleted_at IS NULL AND meeting_id = ? ORDER BY due_date, created_at",
    [meetingId],
  );
  return rows.map(rowToAct);
}

export async function listOpenActionsGlobal(limit = 100): Promise<MeetingAction[]> {
  const d = await db();
  const rows = await d.select<ActRow[]>(
    "SELECT * FROM meeting_actions WHERE deleted_at IS NULL AND done_at IS NULL ORDER BY (due_date IS NULL), due_date, created_at LIMIT ?",
    [limit],
  );
  return rows.map(rowToAct);
}

export async function createAction(meetingId: string, description: string, ownerText?: string, dueDate?: string | null): Promise<MeetingAction> {
  const id = uuidv4();
  const now = nowIso();
  await execRetry(
    `INSERT INTO meeting_actions (id, meeting_id, description, owner_text, due_date, done_at, created_at, updated_at, updated_by, version, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'owner', 1, NULL)`,
    [id, meetingId, description, ownerText ?? null, dueDate ?? null, now, now],
  );
  await writeEvent(meetingId, "action_added", { actionId: id, description });
  const d = await db();
  const rows = await d.select<ActRow[]>("SELECT * FROM meeting_actions WHERE id = ?", [id]);
  return rowToAct(rows[0]);
}

export async function toggleActionDone(id: string): Promise<void> {
  const d = await db();
  const rows = await d.select<ActRow[]>("SELECT * FROM meeting_actions WHERE id = ?", [id]);
  if (!rows.length) return;
  const cur = rows[0];
  const now = nowIso();
  const newDone = cur.done_at ? null : now;
  await execRetry(
    "UPDATE meeting_actions SET done_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    [newDone, now, id],
  );
  await writeEvent(cur.meeting_id, newDone ? "action_completed" : "action_reopened", { actionId: id });
}

export async function softDeleteAction(id: string): Promise<void> {
  const d = await db();
  const rows = await d.select<ActRow[]>("SELECT meeting_id FROM meeting_actions WHERE id = ?", [id]);
  const now = nowIso();
  await execRetry("UPDATE meeting_actions SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  if (rows.length) await writeEvent(rows[0].meeting_id, "action_deleted", { actionId: id });
}
