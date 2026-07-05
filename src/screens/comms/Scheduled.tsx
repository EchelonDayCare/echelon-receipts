import { useEffect, useState } from "react";
import { getSettings, listStudents, listYears } from "../../lib/db";
import type { Student, SettingsMap } from "../../types";
import {
  listScheduled, upsertScheduled, cancelScheduled, deleteScheduled,
  runDueScheduled, type ScheduledMessage, type RecipientFilter,
} from "../../lib/comms";
import { parseRecipients } from "../../lib/email";

type Mode = "all_active" | "year" | "students";

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(local: string): string {
  return new Date(local).toISOString();
}
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function Scheduled() {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const [editing, setEditing] = useState<Partial<ScheduledMessage> | null>(null);
  const [running, setRunning] = useState(false);

  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [mode, setMode] = useState<Mode>("all_active");
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const refresh = () => listScheduled().then(setItems);
  useEffect(() => {
    (async () => {
      const [s, ys] = await Promise.all([getSettings(), listYears()]);
      setSettings(s); setYears(ys); if (ys[0]) setYear(ys[0]);
      refresh();
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const list = mode === "all_active" ? await listStudents(undefined, true) : await listStudents(year, false);
      setStudents(list);
    })();
  }, [mode, year]);

  function newDraft() {
    const in1h = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setEditing({
      scheduled_for: in1h,
      subject: "",
      body: "",
      recipient_filter: JSON.stringify({ mode: "all_active" } satisfies RecipientFilter),
      status: "pending",
    });
    setMode("all_active");
    setSelectedIds(new Set());
  }

  async function onSave() {
    if (!editing) return;
    if (!editing.subject?.trim() || !editing.body?.trim() || !editing.scheduled_for) {
      alert("Fill in subject, body, and scheduled date/time."); return;
    }
    const filter: RecipientFilter = mode === "all_active"
      ? { mode: "all_active" }
      : mode === "year" ? { mode: "year", year }
      : { mode: "students", studentIds: Array.from(selectedIds) };
    if (filter.mode === "students" && filter.studentIds.length === 0) {
      alert("Select at least one student."); return;
    }
    await upsertScheduled({
      id: editing.id,
      scheduled_for: editing.scheduled_for,
      subject: editing.subject,
      body: editing.body,
      recipient_filter: JSON.stringify(filter),
      attachments: null,
      status: editing.status || "pending",
    });
    setEditing(null);
    refresh();
  }

  async function onRunNow() {
    if (!confirm("Send all messages due now?")) return;
    setRunning(true);
    try {
      const res = await runDueScheduled(settings);
      alert(`Processed ${res.attempted}. Sent: ${res.sent}. Failed: ${res.failed}.`);
      refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ marginTop: 0 }}>Scheduled Messages</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn secondary" onClick={onRunNow} disabled={running}>
            {running ? "Running…" : "Run due now"}
          </button>
          <button className="btn" onClick={newDraft}>+ Schedule message</button>
        </div>
      </div>
      <div style={{ background: "#fef3c7", color: "#92400e", padding: 12, borderRadius: 6, margin: "12px 0" }}>
        <strong>Heads-up:</strong> scheduled messages fire the next time you open this app after their scheduled time. They do <em>not</em> run in the background when the app is closed. For guaranteed background delivery, ask to set up OS-level Task Scheduler / launchd (needs a one-time install step).
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
        <thead>
          <tr style={{ background: "#f8fafc", textAlign: "left" }}>
            <th style={{ padding: 8 }}>When</th>
            <th style={{ padding: 8 }}>Subject</th>
            <th style={{ padding: 8 }}>Recipients</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => {
            let rf: RecipientFilter;
            try { rf = JSON.parse(m.recipient_filter); } catch { rf = { mode: "all_active" }; }
            const rfLabel = rf.mode === "all_active" ? "All active"
              : rf.mode === "year" ? `Year ${rf.year}`
              : `${rf.studentIds.length} students`;
            return (
              <tr key={m.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: 8, whiteSpace: "nowrap" }}>{fmtWhen(m.scheduled_for)}</td>
                <td style={{ padding: 8 }}>{m.subject}</td>
                <td style={{ padding: 8, color: "var(--muted)" }}>{rfLabel}</td>
                <td style={{ padding: 8 }}>{m.status}</td>
                <td style={{ padding: 8 }}>
                  {m.status === "pending" && (
                    <>
                      <button className="btn link" onClick={() => {
                        setEditing(m);
                        setMode(rf.mode as Mode);
                        if (rf.mode === "year") setYear(rf.year);
                        if (rf.mode === "students") setSelectedIds(new Set(rf.studentIds));
                      }}>Edit</button>
                      <button className="btn link" onClick={async () => { if (confirm("Cancel this scheduled message?")) { await cancelScheduled(m.id); refresh(); } }}>Cancel</button>
                    </>
                  )}
                  <button className="btn link danger" onClick={async () => { if (confirm("Delete this record?")) { await deleteScheduled(m.id); refresh(); } }}>Delete</button>
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No scheduled messages.</td></tr>
          )}
        </tbody>
      </table>

      {editing && (
        <div onClick={() => setEditing(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", padding: 24, borderRadius: 8, width: "90%", maxWidth: 700, maxHeight: "90vh", overflow: "auto" }}>
            <h2 style={{ marginTop: 0 }}>{editing.id ? "Edit" : "New"} scheduled message</h2>

            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Send at</label>
            <input type="datetime-local"
              value={editing.scheduled_for ? toLocalInput(editing.scheduled_for) : ""}
              onChange={(e) => setEditing({ ...editing, scheduled_for: fromLocalInput(e.target.value) })}
              style={{ marginBottom: 12 }}
            />

            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Recipients</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                <option value="all_active">All active</option>
                <option value="year">By year</option>
                <option value="students">Selected students</option>
              </select>
              {mode === "year" && (
                <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              )}
              {mode === "students" && (
                <span style={{ color: "var(--muted)" }}>{selectedIds.size} selected</span>
              )}
            </div>
            {mode === "students" && (
              <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--border)", padding: 8, marginBottom: 12, borderRadius: 6 }}>
                {students.map((s) => {
                  const hasEmail = parseRecipients(s.email).length > 0;
                  return (
                    <label key={s.id} style={{ display: "flex", gap: 8, padding: 4, opacity: hasEmail ? 1 : 0.5 }}>
                      <input type="checkbox" disabled={!hasEmail} checked={selectedIds.has(s.id)}
                        onChange={() => setSelectedIds((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                      <span style={{ flex: 1 }}>{s.name}</span>
                      <span style={{ color: "var(--muted)", fontSize: 12 }}>{hasEmail ? s.email : "no email"}</span>
                    </label>
                  );
                })}
              </div>
            )}

            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Subject</label>
            <input value={editing.subject || ""} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} style={{ width: "100%", padding: 8, marginBottom: 12 }} />

            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Body</label>
            <textarea value={editing.body || ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={10} style={{ width: "100%", padding: 8, fontFamily: "inherit" }} />

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn" onClick={onSave}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
