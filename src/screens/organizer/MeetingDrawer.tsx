// Meeting create/edit drawer with a mini action-items table.
import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  createMeeting, updateMeeting, softDeleteMeeting,
  listActions, createAction, toggleActionDone, softDeleteAction,
  type Meeting, type MeetingAction, type MeetingKind,
} from "../../repo/meetingsRepo";

const KINDS: MeetingKind[] = ["board", "parent", "staff", "vendor", "inspection", "other"];

export type MeetingDrawerState =
  | { mode: "closed" }
  | { mode: "new" }
  | { mode: "edit"; meeting: Meeting };

export default function MeetingDrawer({ state, onClose, onSaved }: {
  state: MeetingDrawerState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [meetingDate, setMeetingDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [meetingTime, setMeetingTime] = useState<string>("");
  const [kind, setKind] = useState<MeetingKind>("staff");
  const [subject, setSubject] = useState("");
  const [attendees, setAttendees] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [current, setCurrent] = useState<Meeting | null>(null);
  const [actions, setActions] = useState<MeetingAction[]>([]);
  const [newAction, setNewAction] = useState({ description: "", owner: "", due: "" });
  const [previewNotes, setPreviewNotes] = useState(false);

  useEffect(() => {
    if (state.mode === "closed") return;
    setErr(null); setPreviewNotes(false); setNewAction({ description: "", owner: "", due: "" });
    if (state.mode === "new") {
      setMeetingDate(new Date().toISOString().slice(0, 10));
      setMeetingTime(""); setKind("staff"); setSubject(""); setAttendees("");
      setNotes(""); setCurrent(null); setActions([]);
    } else {
      const m = state.meeting;
      setMeetingDate(m.meetingDate); setMeetingTime(m.meetingTime ?? "");
      setKind(m.kind); setSubject(m.subject);
      setAttendees(m.attendeesText ?? ""); setNotes(m.notesMd ?? "");
      setCurrent(m);
      void listActions(m.id).then(setActions).catch(() => setActions([]));
    }
  }, [state]);

  async function save() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      if (!subject.trim()) throw new Error("Subject is required");
      if (state.mode === "new" || !current) {
        const m = await createMeeting({
          meetingDate, meetingTime: meetingTime || null,
          kind, subject: subject.trim(),
          attendeesText: attendees.trim() || null,
          notesMd: notes || null,
          linkedKind: null, linkedId: null,
        });
        setCurrent(m);
        onSaved();
      } else {
        const m = await updateMeeting(current.id, {
          meetingDate, meetingTime: meetingTime || null, kind,
          subject: subject.trim(), attendeesText: attendees.trim() || null,
          notesMd: notes || null,
        }, current.version);
        setCurrent(m);
        onSaved();
      }
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function addAction() {
    if (!current) { alert("Save the meeting first."); return; }
    if (!newAction.description.trim()) return;
    try {
      await createAction(current.id, newAction.description.trim(), newAction.owner || undefined, newAction.due || null);
      setNewAction({ description: "", owner: "", due: "" });
      setActions(await listActions(current.id));
      onSaved();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  async function toggleAct(id: string) {
    await toggleActionDone(id);
    if (current) setActions(await listActions(current.id));
    onSaved();
  }
  async function delAct(id: string) {
    if (!confirm("Delete this action item?")) return;
    await softDeleteAction(id);
    if (current) setActions(await listActions(current.id));
    onSaved();
  }
  async function deleteThis() {
    if (!current) return;
    if (!confirm("Delete this meeting? Action items are also removed from view.")) return;
    await softDeleteMeeting(current.id);
    onSaved();
    onClose();
  }

  if (state.mode === "closed") return null;

  const notesHtml = previewNotes
    ? DOMPurify.sanitize(marked.parse(notes || "", { async: false }) as string, { USE_PROFILES: { html: true } })
    : "";

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{state.mode === "new" && !current ? "New meeting" : "Edit meeting"}</h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        {err && <div style={errBox}>{err}</div>}
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <label style={label}>Date
              <input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} />
            </label>
            <label style={label}>Time
              <input type="time" value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} />
            </label>
            <label style={label}>Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as MeetingKind)}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          </div>
          <label style={label}>Subject
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Parent conference — Riya Sharma" />
          </label>
          <label style={label}>Attendees
            <input value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="Comma-separated names" />
          </label>
          <label style={label}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Notes (Markdown)</span>
              <button type="button" className="btn" onClick={() => setPreviewNotes((v) => !v)} style={{ fontSize: 11 }}>
                {previewNotes ? "Edit" : "Preview"}
              </button>
            </div>
            {previewNotes ? (
              <div style={{ padding: 10, borderRadius: 6, border: "1px solid var(--border, #1e293b)", minHeight: 100, background: "rgba(15,23,42,.35)" }}
                   dangerouslySetInnerHTML={{ __html: notesHtml }} />
            ) : (
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={7} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
            )}
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {current && (
              <button className="btn" onClick={deleteThis} disabled={busy} style={{ color: "#fca5a5" }}>Delete</button>
            )}
            <button className="btn" onClick={onClose} disabled={busy}>Close</button>
            <button className="btn primary" onClick={save} disabled={busy || !subject.trim()}>{busy ? "Saving…" : "Save"}</button>
          </div>

          <div style={{ marginTop: 16, borderTop: "1px solid var(--border, #1e293b)", paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Action items</h3>
            {!current && <div style={{ fontSize: 12, color: "var(--muted)" }}>Save the meeting to add action items.</div>}
            {current && (
              <>
                {actions.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--muted)", padding: 8 }}>None yet.</div>
                ) : (
                  <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                    <tbody>
                      {actions.map((a) => (
                        <tr key={a.id} style={{ borderTop: "1px solid var(--border, #1e293b)" }}>
                          <td style={{ padding: 4, width: 24 }}>
                            <input type="checkbox" checked={!!a.doneAt} onChange={() => toggleAct(a.id)} />
                          </td>
                          <td style={{ padding: 4, textDecoration: a.doneAt ? "line-through" : "none" }}>{a.description}</td>
                          <td style={{ padding: 4, color: "var(--muted)" }}>{a.ownerText ?? "—"}</td>
                          <td style={{ padding: 4, color: "var(--muted)" }}>{a.dueDate ?? "—"}</td>
                          <td style={{ padding: 4, width: 24 }}>
                            <button className="btn" onClick={() => delAct(a.id)} style={{ fontSize: 10, padding: "2px 6px" }}>✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 6, marginTop: 8 }}>
                  <input placeholder="Action description" value={newAction.description} onChange={(e) => setNewAction((v) => ({ ...v, description: e.target.value }))} />
                  <input placeholder="Owner" value={newAction.owner} onChange={(e) => setNewAction((v) => ({ ...v, owner: e.target.value }))} />
                  <input type="date" value={newAction.due} onChange={(e) => setNewAction((v) => ({ ...v, due: e.target.value }))} />
                  <button className="btn" onClick={addAction} disabled={!newAction.description.trim()}>+</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.5)",
  display: "flex", alignItems: "center", justifyContent: "flex-end", zIndex: 100,
};
const panel: React.CSSProperties = {
  background: "var(--panel, #0b1220)", padding: 20, height: "100vh",
  overflowY: "auto", width: "min(620px, 96vw)", borderLeft: "1px solid var(--border, #1e293b)",
};
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)" };
const errBox: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5",
  border: "1px solid rgba(220,38,38,.35)", marginBottom: 12,
};
