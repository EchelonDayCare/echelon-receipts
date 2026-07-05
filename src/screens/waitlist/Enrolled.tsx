// Waitlist enrolled — /waitlist/enrolled
// Shows only status=enrolled with the converted student name (if linked).

import { useEffect, useState } from "react";
import { listWaitlist, syncOnScreenOpen, type WaitlistEntry } from "../../lib/waitlist";
import { db } from "../../lib/db";
import DetailDrawer from "./DetailDrawer";

export default function WaitlistEnrolled() {
  const [rows, setRows] = useState<WaitlistEntry[]>([]);
  const [studentNames, setStudentNames] = useState<Record<number, string>>({});
  const [openId, setOpenId] = useState<number | null>(null);

  const refresh = async () => {
    const r = await listWaitlist({ statuses: ["enrolled"] });
    setRows(r);
    const ids = Array.from(new Set(r.map((e) => e.converted_student_id).filter((x): x is number => typeof x === "number")));
    if (ids.length) {
      const d = await db();
      const placeholders = ids.map(() => "?").join(",");
      const students = await d.select<{ id: number; name: string }[]>(
        `SELECT id, name FROM students WHERE id IN (${placeholders})`,
        ids,
      );
      const map: Record<number, string> = {};
      for (const s of students) map[s.id] = s.name;
      setStudentNames(map);
    }
  };

  useEffect(() => { (async () => { await syncOnScreenOpen(); await refresh(); })(); }, []);

  return (
    <div>
      <h1>Waitlist — Enrolled</h1>
      <p className="subtitle">Applications converted to enrolled students.</p>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={th}>Child</th>
              <th style={th}>Parent</th>
              <th style={th}>Enrolled on</th>
              <th style={th}>Linked student</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} style={{ cursor: "pointer", borderTop: "1px solid var(--border)" }} onClick={() => setOpenId(e.id)}>
                <td style={td}><strong>{e.child_name}</strong></td>
                <td style={td}>{e.parent_name || "—"}</td>
                <td style={td}>{e.status_changed_at ? new Date(e.status_changed_at).toLocaleDateString() : "—"}</td>
                <td style={td}>{e.converted_student_id != null ? (studentNames[e.converted_student_id] || `#${e.converted_student_id}`) : <span style={{ color: "var(--muted)" }}>not linked</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No enrolled applications yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {openId !== null && <DetailDrawer id={openId} onClose={() => { setOpenId(null); void refresh(); }} />}
    </div>
  );
}

const th: React.CSSProperties = { padding: "10px 12px", textAlign: "left", fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" };
const td: React.CSSProperties = { padding: "10px 12px", fontSize: 14 };
