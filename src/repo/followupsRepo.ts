// Follow-ups repo (v1.3.0) — simple TODO list panel on the Organizer.
import { db, execRetry } from "../lib/db";
import { uuidv4, nowIso } from "./ids";

export type Priority = "low" | "normal" | "high";
export type FollowupLinkedKind = "student" | "staff" | "waitlist" | "meeting" | "document" | null;

export type Followup = {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  priority: Priority;
  linkedKind: FollowupLinkedKind;
  linkedId: string | null;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type Row = {
  id: string; title: string; notes: string | null;
  due_date: string | null; priority: string;
  linked_kind: string | null; linked_id: string | null;
  done_at: string | null; created_at: string; updated_at: string;
  version: number; deleted_at: string | null;
};
function rowToObj(r: Row): Followup {
  return {
    id: r.id, title: r.title, notes: r.notes,
    dueDate: r.due_date, priority: r.priority as Priority,
    linkedKind: (r.linked_kind as FollowupLinkedKind) ?? null, linkedId: r.linked_id,
    doneAt: r.done_at, createdAt: r.created_at, updatedAt: r.updated_at,
    version: r.version,
  };
}

export type NewFollowup = {
  title: string; notes?: string | null; dueDate?: string | null;
  priority?: Priority; linkedKind?: FollowupLinkedKind; linkedId?: string | null;
};

export async function listOpenFollowups(): Promise<Followup[]> {
  const d = await db();
  const rows = await d.select<Row[]>(
    `SELECT * FROM followups
      WHERE deleted_at IS NULL AND done_at IS NULL
      ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
               (due_date IS NULL), due_date, created_at`,
  );
  return rows.map(rowToObj);
}

export async function listRecentDoneFollowups(limit = 20): Promise<Followup[]> {
  const d = await db();
  const rows = await d.select<Row[]>(
    "SELECT * FROM followups WHERE deleted_at IS NULL AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT ?",
    [limit],
  );
  return rows.map(rowToObj);
}

export async function createFollowup(f: NewFollowup): Promise<Followup> {
  const id = uuidv4();
  const now = nowIso();
  await execRetry(
    `INSERT INTO followups (id, title, notes, due_date, priority, linked_kind, linked_id, done_at, created_at, updated_at, updated_by, version, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'owner', 1, NULL)`,
    [id, f.title, f.notes ?? null, f.dueDate ?? null, f.priority ?? "normal", f.linkedKind ?? null, f.linkedId ?? null, now, now],
  );
  const d = await db();
  const rows = await d.select<Row[]>("SELECT * FROM followups WHERE id = ?", [id]);
  return rowToObj(rows[0]);
}

export async function toggleFollowupDone(id: string): Promise<void> {
  const d = await db();
  const rows = await d.select<Row[]>("SELECT * FROM followups WHERE id = ?", [id]);
  if (!rows.length) return;
  const now = nowIso();
  const nx = rows[0].done_at ? null : now;
  await execRetry(
    "UPDATE followups SET done_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    [nx, now, id],
  );
}

export async function softDeleteFollowup(id: string): Promise<void> {
  const now = nowIso();
  await execRetry("UPDATE followups SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
}

export async function countOpenDueWithin(days: number): Promise<number> {
  const d = await db();
  const target = new Date(); target.setDate(target.getDate() + days);
  const iso = target.toISOString().slice(0, 10);
  const rows = await d.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM followups WHERE deleted_at IS NULL AND done_at IS NULL AND due_date IS NOT NULL AND due_date <= ?",
    [iso],
  );
  return rows[0]?.n ?? 0;
}
