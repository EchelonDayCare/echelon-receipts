// Waitlist detail drawer — slides from the right, shows full record,
// lets the user change status, and offers conversion / email actions.
//
// Convert-to-Student integration: the least invasive path — we pass
// pre-fill query params to /students/new AND write `converted_student_id`
// via a manual "Mark as Enrolled" button in the drawer. Reason: the existing
// NewReceipt screen doesn't read query params today, and refactoring it is
// out of scope for v0.8.0. See `markConverted` in ../../lib/waitlist.ts.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getWaitlistEntry, updateWaitlistStatus, markConverted,
  ageBand, waitDays, WAITLIST_STATUSES, type WaitlistEntry, type WaitlistStatus,
} from "../../lib/waitlist";
import { db } from "../../lib/db";

type Student = { id: number; name: string; year: number; father_name: string | null; mother_name: string | null };

export default function DetailDrawer({
  id, onClose,
}: { id: number | null; onClose: () => void }) {
  const nav = useNavigate();
  const [entry, setEntry] = useState<WaitlistEntry | null>(null);
  const [status, setStatus] = useState<WaitlistStatus>("new");
  const [note, setNote] = useState("");
  const [studentPickerOpen, setStudentPickerOpen] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [studentSearch, setStudentSearch] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id == null) { setEntry(null); return; }
    (async () => {
      const e = await getWaitlistEntry(id);
      setEntry(e);
      setStatus((e?.status ?? "new") as WaitlistStatus);
      setNote(e?.status_note ?? "");
    })();
  }, [id]);

  useEffect(() => {
    if (!studentPickerOpen) return;
    (async () => {
      const d = await db();
      const rows = await d.select<Student[]>(
        "SELECT id, name, year, father_name, mother_name FROM students WHERE active = 1 ORDER BY year DESC, name",
      );
      setStudents(rows);
    })();
  }, [studentPickerOpen]);

  const filteredStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    const src = q
      ? students.filter((s) =>
          [s.name, s.father_name, s.mother_name].filter(Boolean).join(" ").toLowerCase().includes(q))
      : students;
    return src.slice(0, 50);
  }, [students, studentSearch]);

  if (id == null || !entry) return null;

  const saveStatus = async () => {
    setBusy(true);
    try {
      await updateWaitlistStatus(entry.id, status, note.trim() || null);
      const fresh = await getWaitlistEntry(entry.id);
      setEntry(fresh);
    } finally {
      setBusy(false);
    }
  };

  const linkToStudent = async (studentId: number) => {
    setBusy(true);
    try {
      await markConverted(entry.id, studentId);
      const fresh = await getWaitlistEntry(entry.id);
      setEntry(fresh);
      setStatus("enrolled");
      setStudentPickerOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const convertToStudent = () => {
    // Waitlist parent_name is one field; map to father_name by default so it
    // shows up in the guardian column. The user can move it to mother_name on
    // the pre-filled form if needed. See Students.tsx useEffect for the reader.
    const params = new URLSearchParams({
      fromWaitlist: String(entry.id),
      name: entry.child_name.trim(),
      father_name: entry.parent_name || "",
      mother_name: "",
      email: entry.parent_email || "",
    });
    nav(`/students/roster?${params.toString()}`);
  };

  const sendEmail = () => {
    if (!entry.parent_email) return;
    // Use the OS mail handler — the app's group Compose screen expects a
    // Student roster selection, not a one-off parent email. mailto opens the
    // owner's default mail client (Apple Mail / Outlook / etc.) pre-filled.
    const subject = encodeURIComponent(`Regarding ${entry.child_name}'s waitlist application`);
    window.location.href = `mailto:${entry.parent_email}?subject=${subject}`;
  };

  const band = ageBand(entry.birthday);
  const waited = waitDays(entry.submitted_at);

  const timelineOrder: WaitlistStatus[] = ["new", "contacted", "offered", "enrolled"];
  const currentIdx = timelineOrder.indexOf(entry.status);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={drawerStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>{entry.child_name}</h2>
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
              {band} · Waited {waited} day{waited === 1 ? "" : "s"} · Submitted{" "}
              {new Date(entry.submitted_at).toLocaleDateString()}
            </div>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {/* Timeline */}
        <div style={{ display: "flex", gap: 8, margin: "18px 0", alignItems: "center" }}>
          {timelineOrder.map((s, i) => {
            const done = currentIdx >= i && (entry.status === s || (entry.status !== "withdrawn" && entry.status !== "archived" && currentIdx > i));
            const current = entry.status === s;
            return (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: 12, height: 12, borderRadius: "50%",
                    background: current ? "var(--accent)" : done ? "#94a3b8" : "#e2e8f0",
                    outline: current ? "3px solid rgba(37,99,235,.2)" : "none",
                  }}
                />
                <span style={{ fontSize: 12, color: current ? "var(--text)" : "var(--muted)", textTransform: "capitalize" }}>{s}</span>
                {i < timelineOrder.length - 1 && (
                  <div style={{ width: 20, height: 1, background: "#e2e8f0" }} />
                )}
              </div>
            );
          })}
          {(entry.status === "withdrawn" || entry.status === "archived") && (
            <span style={{ marginLeft: 12, fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>
              ({entry.status})
            </span>
          )}
        </div>

        {/* Full record */}
        <div className="card" style={{ marginBottom: 16 }}>
          <table style={{ width: "100%", borderSpacing: 0 }}>
            <tbody>
              {rowKV("Parent", entry.parent_name)}
              {rowKV("Email", entry.parent_email)}
              {rowKV("Phone", entry.phone)}
              {rowKV("Birthday", entry.birthday)}
              {rowKV("Gender", entry.gender)}
              {rowKV("Target start", entry.target_start)}
              {rowKV("Toilet trained", entry.toilet_trained == null ? null : entry.toilet_trained ? "Yes" : "No")}
              {rowKV("In building", entry.in_building == null ? null : entry.in_building ? "Yes" : "No")}
              {rowKV("Notes", entry.notes)}
              {entry.converted_student_id != null && rowKV("Converted to student ID", String(entry.converted_student_id))}
            </tbody>
          </table>
        </div>

        {/* Status editor */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Update status</h3>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as WaitlistStatus)}>
              {WAITLIST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Note</label>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <button className="btn primary" disabled={busy} onClick={saveStatus}>
            Save status
          </button>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={convertToStudent}>
            Convert to Student →
          </button>
          <button className="btn" onClick={() => setStudentPickerOpen((v) => !v)}>
            {studentPickerOpen ? "Cancel link" : "Link to existing Student"}
          </button>
          <button className="btn" onClick={sendEmail} disabled={!entry.parent_email}>
            Send Email →
          </button>
        </div>

        {studentPickerOpen && (
          <div className="card" style={{ marginTop: 12 }}>
            <input
              placeholder="Search students…"
              value={studentSearch}
              onChange={(e) => setStudentSearch(e.target.value)}
              style={{ width: "100%", marginBottom: 8 }}
            />
            <div style={{ maxHeight: 240, overflowY: "auto" }}>
              {filteredStudents.map((s) => {
                const parents = [s.father_name, s.mother_name].filter(Boolean).join(" / ");
                return (
                  <button
                    key={s.id}
                    className="btn link"
                    style={{ display: "block", textAlign: "left", padding: "6px 4px" }}
                    onClick={() => linkToStudent(s.id)}
                  >
                    {s.name} <span style={{ color: "var(--muted)" }}>· {s.year}{parents ? ` · ${parents}` : ""}</span>
                  </button>
                );
              })}
              {filteredStudents.length === 0 && (
                <div style={{ color: "var(--muted)", fontSize: 13, padding: 6 }}>No matches.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function rowKV(label: string, value: string | null | undefined) {
  return (
    <tr>
      <td style={{ padding: "6px 12px 6px 0", color: "var(--muted)", fontSize: 13, verticalAlign: "top", width: 160 }}>{label}</td>
      <td style={{ padding: "6px 0", fontSize: 14, wordBreak: "break-word" }}>{value || <span style={{ color: "#cbd5e1" }}>—</span>}</td>
    </tr>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(15,23,42,.35)", zIndex: 40,
  display: "flex", justifyContent: "flex-end",
};

const drawerStyle: React.CSSProperties = {
  width: "min(560px, 96vw)", height: "100%", background: "var(--panel)",
  padding: 22, overflowY: "auto", boxShadow: "-8px 0 24px rgba(15,23,42,.15)",
};

const headerStyle: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12,
};
