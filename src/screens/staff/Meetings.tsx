import { useEffect, useMemo, useState } from "react";
import {
  listMeetings, getMeeting, createMeeting, updateMeeting, voidMeeting,
  addAction, updateAction, toggleAction, deleteAction,
  type MeetingWithActions,
} from "../../lib/meetings";
import { listStaff } from "../../lib/staff";
import type { StaffMeeting, Staff } from "../../types";
import { showAlert, showConfirm, showPrompt } from "../../lib/dialogs";

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function StaffMeetings() {
  const [meetings, setMeetings] = useState<StaffMeeting[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MeetingWithActions | null>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refreshList() {
    const [m, s] = await Promise.all([listMeetings(), listStaff(false)]);
    setMeetings(m); setStaff(s);
  }
  useEffect(() => { refreshList(); }, []);

  async function loadDetail(id: number) {
    setSelectedId(id);
    setDetail(await getMeeting(id));
    setCreating(false);
  }

  useEffect(() => {
    if (!creating && selectedId == null && meetings.length > 0) loadDetail(meetings[0].id);
  }, [meetings, creating, selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return meetings;
    return meetings.filter(m =>
      m.title.toLowerCase().includes(q) ||
      (m.notes ?? "").toLowerCase().includes(q) ||
      (m.agenda ?? "").toLowerCase().includes(q)
    );
  }, [meetings, search]);

  function startNew() {
    setCreating(true);
    setSelectedId(null);
    setDetail({
      meeting: {
        id: 0, meeting_date: todayIso(), title: "", agenda: "", notes: "",
        attendees_json: "[]", voided: 0, voided_at: null, void_reason: null,
        created_at: "", updated_at: "",
      },
      actions: [],
    });
  }

  async function onSaveMeeting() {
    if (!detail) return;
    const m = detail.meeting;
    if (!m.title.trim()) { void showAlert("Title is required."); return; }
    const attendees: number[] = JSON.parse(m.attendees_json || "[]");
    setBusy(true);
    try {
      if (creating) {
        const id = await createMeeting({
          meeting_date: m.meeting_date, title: m.title,
          agenda: m.agenda, notes: m.notes, attendee_ids: attendees,
        });
        await refreshList();
        await loadDetail(id);
      } else {
        await updateMeeting(m.id, {
          meeting_date: m.meeting_date, title: m.title,
          agenda: m.agenda, notes: m.notes, attendee_ids: attendees,
        });
        await refreshList();
        await loadDetail(m.id);
      }
    } catch (e: any) {
      void showAlert("Save failed: " + (e?.message ?? e));
    } finally { setBusy(false); }
  }

  async function onVoid() {
    if (!detail?.meeting.id) return;
    if (!(await showConfirm("Void this meeting? It stays in the archive but is hidden from the list."))) return;
    const reason = await showPrompt("Reason (optional):", "");
    await voidMeeting(detail.meeting.id, reason || undefined);
    setDetail(null); setSelectedId(null);
    await refreshList();
  }

  async function onAddAction() {
    if (!detail?.meeting.id) { void showAlert("Save the meeting before adding action items."); return; }
    const text = await showPrompt("Action item:", "");
    if (!text) return;
    await addAction(detail.meeting.id, { text });
    await loadDetail(detail.meeting.id);
  }
  async function onToggleAction(actionId: number, done: boolean) {
    await toggleAction(actionId, done);
    if (detail) await loadDetail(detail.meeting.id);
  }
  async function onRemoveAction(actionId: number) {
    if (!(await showConfirm("Remove this action item?"))) return;
    await deleteAction(actionId);
    if (detail) await loadDetail(detail.meeting.id);
  }
  async function onEditAction(actionId: number, current: string) {
    const text = await showPrompt("Update action:", current);
    if (text == null) return;
    await updateAction(actionId, { text });
    if (detail) await loadDetail(detail.meeting.id);
  }
  async function onAssignAction(actionId: number, ownerId: number | null) {
    await updateAction(actionId, { owner_staff_id: ownerId });
    if (detail) await loadDetail(detail.meeting.id);
  }
  async function onDueAction(actionId: number, due: string | null) {
    await updateAction(actionId, { due_date: due });
    if (detail) await loadDetail(detail.meeting.id);
  }

  const attendees: number[] = detail ? JSON.parse(detail.meeting.attendees_json || "[]") : [];
  function toggleAttendee(id: number) {
    if (!detail) return;
    const set = new Set(attendees);
    if (set.has(id)) set.delete(id); else set.add(id);
    setDetail({ ...detail, meeting: { ...detail.meeting, attendees_json: JSON.stringify([...set]) } });
  }

  function staffName(id: number | null): string {
    if (id == null) return "Unassigned";
    return staff.find(s => s.id === id)?.name ?? `Staff #${id}`;
  }

  function onPrint() {
    if (!detail?.meeting.id) return;
    const m = detail.meeting;
    const attendeeNames = attendees.map(staffName).join(", ") || "—";
    const actionsHtml = detail.actions.length === 0
      ? "<p><em>No action items.</em></p>"
      : `<ol>${detail.actions.map(a => `
          <li${a.done ? ' style="text-decoration:line-through;color:#666"' : ""}>
            ${escapeHtml(a.text)}
            ${a.owner_staff_id ? ` — <strong>${escapeHtml(staffName(a.owner_staff_id))}</strong>` : ""}
            ${a.due_date ? ` (due ${escapeHtml(a.due_date)})` : ""}
          </li>`).join("")}</ol>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title></title>
<style>
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; color: #111; }
  .sheet { width: 7.5in; padding: 0.6in 0.5in; box-sizing: border-box; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 18px; }
  h2 { font-size: 13px; margin: 18px 0 6px; color: #444; text-transform: uppercase; letter-spacing: 0.5px; }
  .body { white-space: pre-wrap; font-size: 13px; line-height: 1.5; }
</style></head><body><div class="sheet">
  <h1>${escapeHtml(m.title)}</h1>
  <div class="meta">${escapeHtml(m.meeting_date)} · Attendees: ${escapeHtml(attendeeNames)}</div>
  ${m.agenda ? `<h2>Agenda</h2><div class="body">${escapeHtml(m.agenda)}</div>` : ""}
  ${m.notes ? `<h2>Notes</h2><div class="body">${escapeHtml(m.notes)}</div>` : ""}
  <h2>Action Items</h2>${actionsHtml}
</div></body></html>`;
    const existing = document.getElementById("__print_frame");
    if (existing) existing.remove();
    const iframe = document.createElement("iframe");
    iframe.id = "__print_frame";
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => {
      const parentTitle = document.title;
      document.title = "";
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => { document.title = parentTitle; }, 1000);
    }, 300);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, padding: "16px 20px", height: "calc(100vh - 60px)" }}>
      {/* Left: list */}
      <aside style={{ borderRight: "1px solid #e5e5e5", paddingRight: 12, overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <button onClick={startNew} type="button" style={{ flex: 1, padding: "8px 10px", fontWeight: 600 }}>+ New meeting</button>
        </div>
        <input
          type="search" placeholder="Search notes…" value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: "100%", padding: 6, marginBottom: 10, boxSizing: "border-box" }}
        />
        {filtered.length === 0 ? (
          <div style={{ color: "#666", fontSize: 13, padding: 8 }}>
            {meetings.length === 0 ? "No meetings yet." : "No matches."}
          </div>
        ) : filtered.map(m => (
          <div key={m.id}
            onClick={() => loadDetail(m.id)}
            style={{
              padding: "8px 10px", marginBottom: 4, borderRadius: 6, cursor: "pointer",
              background: m.id === selectedId ? "#eef2ff" : "transparent",
              borderLeft: m.id === selectedId ? "3px solid #6366f1" : "3px solid transparent",
            }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{m.title}</div>
            <div style={{ fontSize: 11, color: "#666" }}>{m.meeting_date}</div>
          </div>
        ))}
      </aside>

      {/* Right: editor */}
      <section style={{ overflowY: "auto", paddingRight: 8 }}>
        {!detail ? (
          <div style={{ color: "#666", padding: 40, textAlign: "center" }}>
            Select a meeting on the left, or click <strong>+ New meeting</strong>.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
              <input
                type="text" placeholder="Meeting title" value={detail.meeting.title}
                onChange={e => setDetail({ ...detail, meeting: { ...detail.meeting, title: e.target.value } })}
                style={{ flex: 1, fontSize: 18, fontWeight: 600, padding: 6, border: "1px solid #ddd", borderRadius: 4 }}
              />
              <input
                type="date" value={detail.meeting.meeting_date}
                onChange={e => setDetail({ ...detail, meeting: { ...detail.meeting, meeting_date: e.target.value } })}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Attendees</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {staff.length === 0 && <span style={{ color: "#888", fontSize: 12 }}>No active staff to attend.</span>}
                {staff.map(s => (
                  <label key={s.id} style={{
                    display: "flex", alignItems: "center", gap: 4, padding: "3px 8px",
                    borderRadius: 12, background: attendees.includes(s.id) ? "#dbeafe" : "#f3f4f6",
                    fontSize: 12, cursor: "pointer",
                  }}>
                    <input type="checkbox" checked={attendees.includes(s.id)} onChange={() => toggleAttendee(s.id)} />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Agenda</div>
              <textarea
                value={detail.meeting.agenda ?? ""}
                onChange={e => setDetail({ ...detail, meeting: { ...detail.meeting, agenda: e.target.value } })}
                rows={4}
                style={{ width: "100%", padding: 8, boxSizing: "border-box", fontFamily: "inherit" }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Notes</div>
              <textarea
                value={detail.meeting.notes ?? ""}
                onChange={e => setDetail({ ...detail, meeting: { ...detail.meeting, notes: e.target.value } })}
                rows={10}
                style={{ width: "100%", padding: 8, boxSizing: "border-box", fontFamily: "inherit" }}
              />
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
              <button type="button" disabled={busy} onClick={onSaveMeeting} style={{ padding: "8px 14px", fontWeight: 600 }}>
                {creating ? "Create meeting" : "Save changes"}
              </button>
              <button type="button" onClick={onPrint} disabled={creating}>Print</button>
              {!creating && (
                <button type="button" onClick={onVoid} style={{ marginLeft: "auto", color: "#b91c1c" }}>Void</button>
              )}
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#555" }}>
                  Action items ({detail.actions.filter(a => !a.done).length} open / {detail.actions.length})
                </div>
                <button type="button" onClick={onAddAction} disabled={creating}>+ Add</button>
              </div>
              {detail.actions.length === 0 ? (
                <div style={{ color: "#888", fontSize: 13, padding: 8 }}>No action items yet.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <tbody>
                    {detail.actions.map(a => (
                      <tr key={a.id} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ width: 24, padding: 6 }}>
                          <input type="checkbox" checked={!!a.done} onChange={e => onToggleAction(a.id, e.target.checked)} />
                        </td>
                        <td style={{ padding: 6, textDecoration: a.done ? "line-through" : "none", color: a.done ? "#888" : "#111" }}>
                          {a.text}
                        </td>
                        <td style={{ padding: 6 }}>
                          <select value={a.owner_staff_id ?? ""} onChange={e => onAssignAction(a.id, e.target.value ? Number(e.target.value) : null)}>
                            <option value="">Unassigned</option>
                            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </td>
                        <td style={{ padding: 6 }}>
                          <input type="date" value={a.due_date ?? ""} onChange={e => onDueAction(a.id, e.target.value || null)} />
                        </td>
                        <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                          <button type="button" onClick={() => onEditAction(a.id, a.text)}>Edit</button>
                          <button type="button" onClick={() => onRemoveAction(a.id)} style={{ marginLeft: 4 }}>×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
