import { useEffect, useMemo, useState } from "react";
import {
  listMeetings, getMeeting, createMeeting, updateMeeting, voidMeeting,
  addAction, updateAction, toggleAction, deleteAction,
  type MeetingWithActions,
} from "../../lib/meetings";
import { listStaff } from "../../lib/staff";
import type { StaffMeeting, Staff } from "../../types";
import { showAlert, showConfirm, showPrompt } from "../../lib/dialogs";
import { showPdfPreview } from "../../lib/pdfPreview";
import { isAiTextConfigured } from "../../lib/voice";
import { getSettings } from "../../lib/db";
import MeetingNotesAiTextPanel from "./MeetingNotesAiTextPanel";

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtLongDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase() ?? "").join("");
}

export default function StaffMeetings() {
  const [meetings, setMeetings] = useState<StaffMeeting[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MeetingWithActions | null>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  useEffect(() => {
    getSettings().then((s) => setAiEnabled(isAiTextConfigured(s))).catch(() => setAiEnabled(false));
  }, []);

  async function refreshList() {
    const [m, s] = await Promise.all([listMeetings(), listStaff(false)]);
    setMeetings(m); setStaff(s);
  }
  useEffect(() => { refreshList(); }, []);

  async function loadDetail(id: number) {
    setSelectedId(id);
    setDetail(await getMeeting(id));
    setCreating(false); setDirty(false);
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

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2200); }

  function startNew() {
    setCreating(true); setSelectedId(null); setDirty(true);
    setDetail({
      meeting: {
        id: 0, meeting_date: todayIso(), title: "", agenda: "", notes: "",
        attendees_json: "[]", voided: 0, voided_at: null, void_reason: null,
        created_at: "", updated_at: "",
      },
      actions: [],
    });
  }

  function patchMeeting(patch: Partial<StaffMeeting>) {
    if (!detail) return;
    setDetail({ ...detail, meeting: { ...detail.meeting, ...patch } });
    setDirty(true);
  }

  async function onSave() {
    if (!detail) return;
    const m = detail.meeting;
    if (!m.title.trim()) { void showAlert("Give the meeting a title first."); return; }
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
        flash("Meeting created.");
      } else {
        await updateMeeting(m.id, {
          meeting_date: m.meeting_date, title: m.title,
          agenda: m.agenda, notes: m.notes, attendee_ids: attendees,
        });
        await refreshList();
        await loadDetail(m.id);
        flash("Changes saved.");
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
    flash("Meeting voided.");
  }

  async function onAddAction() {
    if (!detail?.meeting.id) { void showAlert("Save the meeting before adding action items."); return; }
    const text = await showPrompt("Action item:", "");
    if (!text) return;
    await addAction(detail.meeting.id, { text });
    await loadDetail(detail.meeting.id);
  }
  async function onToggleAction(id: number, done: boolean) {
    await toggleAction(id, done);
    if (detail) await loadDetail(detail.meeting.id);
  }
  async function onRemoveAction(id: number) {
    if (!(await showConfirm("Remove this action item?"))) return;
    await deleteAction(id);
    if (detail) await loadDetail(detail.meeting.id);
  }
  async function onEditAction(id: number, current: string) {
    const text = await showPrompt("Update action:", current);
    if (text == null) return;
    await updateAction(id, { text });
    if (detail) await loadDetail(detail.meeting.id);
  }
  async function onAssignAction(id: number, ownerId: number | null) {
    await updateAction(id, { owner_staff_id: ownerId });
    if (detail) await loadDetail(detail.meeting.id);
  }
  async function onDueAction(id: number, due: string | null) {
    await updateAction(id, { due_date: due });
    if (detail) await loadDetail(detail.meeting.id);
  }

  const attendees: number[] = detail ? JSON.parse(detail.meeting.attendees_json || "[]") : [];
  function toggleAttendee(id: number) {
    if (!detail) return;
    const set = new Set(attendees);
    if (set.has(id)) set.delete(id); else set.add(id);
    patchMeeting({ attendees_json: JSON.stringify([...set]) });
  }

  function staffName(id: number | null): string {
    if (id == null) return "Unassigned";
    return staff.find(s => s.id === id)?.name ?? `Staff #${id}`;
  }

  async function onPrint() {
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
    // NOTE: pdfPreview measures the `.sheet` element to size the PDF, so keep
    // the .sheet wrapper. Margins here are inside the sheet; the modal's
    // html2pdf uses format=letter with its own margin (matched to 0.5in below).
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(m.title)}</title>
<style>
  body { font-family: Arial, sans-serif; color: #111; margin: 0; padding: 0; }
  .sheet { width: 7.5in; padding: 0.1in 0.1in; box-sizing: border-box; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 18px; }
  h2 { font-size: 13px; margin: 18px 0 6px; color: #444; text-transform: uppercase; letter-spacing: 0.5px; }
  .body { white-space: pre-wrap; font-size: 13px; line-height: 1.5; }
</style></head><body><div class="sheet">
  <h1>${escapeHtml(m.title)}</h1>
  <div class="meta">${escapeHtml(fmtLongDate(m.meeting_date))} · Attendees: ${escapeHtml(attendeeNames)}</div>
  ${m.agenda ? `<h2>Agenda</h2><div class="body">${escapeHtml(m.agenda)}</div>` : ""}
  ${m.notes ? `<h2>Notes</h2><div class="body">${escapeHtml(m.notes)}</div>` : ""}
  <h2>Action Items</h2>${actionsHtml}
</div></body></html>`;
    const safeTitle = (m.title || "meeting").replace(/[^A-Za-z0-9._-]+/g, "_");
    await showPdfPreview({
      html,
      filename: `${m.meeting_date}_${safeTitle}.pdf`,
      title: `${m.title} — ${fmtLongDate(m.meeting_date)}`,
      format: "letter",
      margin: 0.5,
    });
  }

  const openCount = detail?.actions.filter(a => !a.done).length ?? 0;
  const totalCount = detail?.actions.length ?? 0;

  return (
    <>
    <div className="mtg-layout">
      {/* ── List ─────────────────────────────────────────── */}
      <aside className="mtg-list card">
        <div className="mtg-list-head">
          <h2>Meeting Notes</h2>
          <button className="btn" onClick={startNew} type="button">＋ New</button>
        </div>
        <input
          className="mtg-search"
          type="search" placeholder="Search title or notes…" value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="mtg-list-scroll">
          {aiEnabled && (
            <div style={{ padding: "0 8px 8px" }}>
              <MeetingNotesAiTextPanel staff={staff} onSaved={refreshList} />
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>
              {meetings.length === 0 ? "No meetings yet. Click ＋ New to start." : "No matches."}
            </div>
          ) : filtered.map(m => (
            <button
              key={m.id} type="button"
              className={`mtg-item ${m.id === selectedId ? "active" : ""}`}
              onClick={() => loadDetail(m.id)}
            >
              <div className="mtg-item-title">{m.title || "Untitled"}</div>
              <div className="mtg-item-meta">{fmtLongDate(m.meeting_date)}</div>
            </button>
          ))}
        </div>
      </aside>

      {/* ── Editor ───────────────────────────────────────── */}
      <section className="mtg-editor">
        {!detail ? (
          <div className="empty" style={{ marginTop: 60 }}>
            <div style={{ fontSize: 42, marginBottom: 10 }}>📝</div>
            <div style={{ fontSize: 15, marginBottom: 4 }}>No meeting selected</div>
            <div>Pick one from the list, or click <strong>＋ New</strong> to create one.</div>
          </div>
        ) : (
          <div className="card mtg-editor-card">
            {/* Sticky header */}
            <div className="mtg-editor-head">
              <input
                className="mtg-title"
                type="text" placeholder="Meeting title"
                value={detail.meeting.title}
                onChange={e => patchMeeting({ title: e.target.value })}
              />
              <input
                className="mtg-date"
                type="date" value={detail.meeting.meeting_date}
                onChange={e => patchMeeting({ meeting_date: e.target.value })}
              />
              <div className="mtg-actions">
                <button className="btn secondary" onClick={onPrint} disabled={creating}>Print</button>
                {!creating && (
                  <button className="btn secondary danger-text" onClick={onVoid} type="button">Void</button>
                )}
                <button className="btn" onClick={onSave} disabled={busy || !dirty && !creating}>
                  {creating ? "Create" : (dirty ? "Save" : "Saved")}
                </button>
              </div>
            </div>

            {/* Attendees */}
            <div className="mtg-section">
              <div className="mtg-label">Attendees {attendees.length > 0 && <span className="mtg-count">{attendees.length}</span>}</div>
              {staff.length === 0 ? (
                <div className="mtg-hint">No active staff yet. Add staff in the Staff → Hours page.</div>
              ) : (
                <div className="mtg-chips">
                  {staff.map(s => {
                    const on = attendees.includes(s.id);
                    return (
                      <button
                        key={s.id} type="button"
                        className={`mtg-chip ${on ? "on" : ""}`}
                        onClick={() => toggleAttendee(s.id)}
                        title={s.role ?? ""}
                      >
                        <span className="mtg-avatar">{initials(s.name)}</span>
                        <span>{s.name}</span>
                        {on && <span className="mtg-check">✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Agenda + Notes */}
            <div className="mtg-section">
              <div className="mtg-label">Agenda</div>
              <textarea
                className="mtg-textarea"
                placeholder="Topics to cover…"
                value={detail.meeting.agenda ?? ""}
                onChange={e => patchMeeting({ agenda: e.target.value })}
                rows={3}
              />
            </div>
            <div className="mtg-section">
              <div className="mtg-label">Notes</div>
              <textarea
                className="mtg-textarea"
                placeholder="What was discussed, decisions made, follow-ups…"
                value={detail.meeting.notes ?? ""}
                onChange={e => patchMeeting({ notes: e.target.value })}
                rows={8}
              />
            </div>

            {/* Action items */}
            <div className="mtg-section">
              <div className="mtg-actions-head">
                <div className="mtg-label" style={{ margin: 0 }}>
                  Action items {totalCount > 0 && (
                    <span className="mtg-count">{openCount} open · {totalCount} total</span>
                  )}
                </div>
                <button className="btn secondary" onClick={onAddAction} disabled={creating} type="button">＋ Add</button>
              </div>
              {creating ? (
                <div className="mtg-hint">Save the meeting first, then add action items.</div>
              ) : detail.actions.length === 0 ? (
                <div className="empty" style={{ padding: 18 }}>No action items yet.</div>
              ) : (
                <div className="mtg-action-list">
                  {detail.actions.map(a => (
                    <div key={a.id} className={`mtg-action ${a.done ? "done" : ""}`}>
                      <input
                        className="mtg-action-check" type="checkbox"
                        checked={!!a.done}
                        onChange={e => onToggleAction(a.id, e.target.checked)}
                      />
                      <div className="mtg-action-body">
                        <div className="mtg-action-text">{a.text}</div>
                        <div className="mtg-action-meta">
                          <select
                            className="mtg-action-select"
                            value={a.owner_staff_id ?? ""}
                            onChange={e => onAssignAction(a.id, e.target.value ? Number(e.target.value) : null)}
                          >
                            <option value="">Unassigned</option>
                            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                          <input
                            className="mtg-action-date"
                            type="date" value={a.due_date ?? ""}
                            onChange={e => onDueAction(a.id, e.target.value || null)}
                          />
                        </div>
                      </div>
                      <div className="mtg-action-btns">
                        <button className="btn link" onClick={() => onEditAction(a.id, a.text)} type="button">Edit</button>
                        <button className="btn link danger" onClick={() => onRemoveAction(a.id)} type="button">Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
    {toast && <div className="mtg-toast">{toast}</div>}
    </>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
