// Organizer → Notes — searchable, no-reminder scratch pad.
// Sits as its own top-level page under the Organizer module so the
// Dashboard stays focused on time-sensitive items and Notes has room
// to breathe. Data model + repo live in src/repo/notesRepo.ts.
import { useEffect, useState } from "react";
import {
  listNotes, createNote, updateNote, softDeleteNote, type Note,
} from "../../repo/notesRepo";

export default function OrganizerNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [newBody, setNewBody] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string; version: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Debounced search: only refetch when the query text settles for 300 ms.
  useEffect(() => {
    const t = setTimeout(async () => {
      try { setNotes(await listNotes(query)); } catch (e: any) { setErr(String(e?.message ?? e)); }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  async function add() {
    const body = newBody.trim();
    if (!body) return;
    try {
      await createNote(body);
      setNewBody("");
      setNotes(await listNotes(query));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }
  async function saveEdit() {
    if (!editing) return;
    const body = editing.body.trim();
    if (!body) return;
    try {
      await updateNote(editing.id, body, editing.version);
      setEditing(null);
      setNotes(await listNotes(query));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }
  async function remove(n: Note) {
    if (!confirm("Delete this note?")) return;
    try {
      await softDeleteNote(n.id, n.version);
      if (editing?.id === n.id) setEditing(null);
      setNotes(await listNotes(query));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  return (
    <div className="org-layout">
      <div className="org-main">
        <div className="org-header">
          <div>
            <h1 className="org-title">Notes</h1>
            <div className="org-subtitle">
              <span className="org-hdr-stat calm">{notes.length} {notes.length === 1 ? "note" : "notes"}</span>
              <span className="muted" style={{ marginLeft: 8 }}>
                For quick reminders that don't need a due date. Searchable.
              </span>
            </div>
          </div>
        </div>

        {err && <div className="org-err">{err}</div>}

        <section className="card org-panel">
          <div className="org-panel-head">
            <h2>All notes</h2>
            <input
              type="search"
              placeholder="Search notes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ maxWidth: 280 }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
            <textarea
              placeholder='Jot a note… e.g. "Signed up on XYZ for courses"'
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void add(); }
              }}
              rows={3}
              style={{ flex: 1, minWidth: 0, resize: "vertical" }}
            />
            <button className="btn" onClick={add} disabled={!newBody.trim()}>＋ Add note</button>
          </div>

          {notes.length === 0 ? (
            <div className="empty">
              {query.trim()
                ? `No notes matching "${query.trim()}".`
                : "No notes yet. Jot the first one above 📝"}
            </div>
          ) : (
            <ul className="org-fu-list" style={{ gap: 10 }}>
              {notes.map((n) => {
                const isEditing = editing?.id === n.id;
                return (
                  <li key={n.id} className="org-fu" style={{ alignItems: "flex-start" }}>
                    <div className="org-fu-body" style={{ minWidth: 0, flex: 1 }}>
                      {isEditing ? (
                        <>
                          <textarea
                            value={editing!.body}
                            onChange={(e) => setEditing({ ...editing!, body: e.target.value })}
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void saveEdit(); }
                              if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                            }}
                            rows={4}
                            style={{ width: "100%", resize: "vertical" }}
                            autoFocus
                          />
                          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                            <button className="btn sm" onClick={saveEdit} disabled={!editing!.body.trim()}>Save</button>
                            <button className="btn link sm" onClick={() => setEditing(null)}>Cancel</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div
                            className="org-fu-title"
                            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: "text" }}
                            onClick={() => setEditing({ id: n.id, body: n.body, version: n.version })}
                            title="Click to edit"
                          >
                            {n.body}
                          </div>
                          <div className="org-fu-meta">
                            updated {n.updatedAt.slice(0, 16).replace("T", " ")}
                          </div>
                        </>
                      )}
                    </div>
                    {!isEditing && (
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="btn link sm" title="Edit"
                          onClick={() => setEditing({ id: n.id, body: n.body, version: n.version })}>
                          ✎
                        </button>
                        <button className="btn link danger sm" title="Delete" onClick={() => remove(n)}>
                          ✕
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
