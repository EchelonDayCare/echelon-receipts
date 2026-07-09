// Organizer Notes repo (v2.2.6) — simple, searchable notes that don't need
// reminders (e.g. "Signed up on XYZ for courses"). Soft-delete + optimistic
// versioning to match the followups pattern.
import { db, execRetry } from "../lib/db";
import { uuidv4, nowIso, StaleWriteError } from "./ids";

export type Note = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type Row = {
  id: string; body: string;
  created_at: string; updated_at: string;
  version: number; deleted_at: string | null;
};
function rowToObj(r: Row): Note {
  return {
    id: r.id, body: r.body,
    createdAt: r.created_at, updatedAt: r.updated_at,
    version: r.version,
  };
}

export async function listNotes(query?: string, limit = 200): Promise<Note[]> {
  const d = await db();
  const q = (query ?? "").trim();
  if (!q) {
    const rows = await d.select<Row[]>(
      "SELECT * FROM organizer_notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?",
      [limit],
    );
    return rows.map(rowToObj);
  }
  const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const rows = await d.select<Row[]>(
    `SELECT * FROM organizer_notes
       WHERE deleted_at IS NULL AND body LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ?`,
    [like, limit],
  );
  return rows.map(rowToObj);
}

export async function createNote(body: string): Promise<Note> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Note body is empty");
  const id = uuidv4();
  const now = nowIso();
  await execRetry(
    `INSERT INTO organizer_notes (id, body, created_at, updated_at, version, deleted_at)
       VALUES (?, ?, ?, ?, 1, NULL)`,
    [id, trimmed, now, now],
  );
  return { id, body: trimmed, createdAt: now, updatedAt: now, version: 1 };
}

export async function updateNote(id: string, body: string, expectedVersion: number): Promise<Note> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Note body is empty");
  const now = nowIso();
  const res = await execRetry(
    `UPDATE organizer_notes
       SET body = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    [trimmed, now, id, expectedVersion],
  );
  if (res.rowsAffected === 0) throw new StaleWriteError("Note was updated elsewhere. Refresh and try again.");
  const d = await db();
  const rows = await d.select<Row[]>("SELECT * FROM organizer_notes WHERE id = ?", [id]);
  return rowToObj(rows[0]);
}

export async function softDeleteNote(id: string, expectedVersion: number): Promise<void> {
  const now = nowIso();
  const res = await execRetry(
    `UPDATE organizer_notes
       SET deleted_at = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    [now, now, id, expectedVersion],
  );
  if (res.rowsAffected === 0) throw new StaleWriteError("Note was updated elsewhere. Refresh and try again.");
}
