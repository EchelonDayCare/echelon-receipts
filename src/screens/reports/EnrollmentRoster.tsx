import { useEffect, useState } from "react";
import { getSettings, listStudents, listYears } from "../../lib/db";
import type { Student, SettingsMap } from "../../types";
import { printCurrentWindow } from "../../lib/print";

export default function EnrollmentRoster() {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [students, setStudents] = useState<Student[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);

  useEffect(() => {
    (async () => {
      const [s, ys] = await Promise.all([getSettings(), listYears()]);
      setSettings(s);
      setYears(ys); if (ys[0]) setYear(ys[0]);
    })();
  }, []);

  useEffect(() => {
    listStudents(year, activeOnly).then(setStudents);
  }, [year, activeOnly]);

  function exportCsv() {
    const lines = ["Student,Father,Mother,Email,Active,Year,Person ID"];
    for (const s of students) {
      const row = [s.name, s.father_name || "", s.mother_name || "", s.email || "",
        s.active ? "Y" : "N", String(s.year), s.person_id || ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
      lines.push(row);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `enrollment-roster-${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const daycareName = settings.daycare_name || "Echelon Daycare";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>Enrollment Roster</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Printable roster for BC Child Care Licensing inspections. Keep the current copy on-site (CCLR §57).
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label>Year:
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ marginLeft: 6 }}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only
          </label>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <button className="btn" onClick={() => { void printCurrentWindow(); }}>Print</button>
        </div>
      </div>

      <div className="report-sheet" style={{ background: "#fff", padding: 24, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{daycareName}</div>
          <div style={{ color: "var(--muted)" }}>Enrollment Roster — {year}{activeOnly ? " (active students only)" : ""}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Printed: {today}</div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>#</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Student</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Father / Guardian</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Mother / Guardian</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Contact Email</th>
              <th style={{ textAlign: "center", padding: 6, border: "1px solid var(--border)" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {students.map((s, i) => (
              <tr key={s.id}>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{i + 1}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", fontWeight: 600 }}>{s.name}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{s.father_name || "—"}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{s.mother_name || "—"}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{s.email || "—"}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "center" }}>{s.active ? "Active" : "Inactive"}</td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No students for this year.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ marginTop: 16, fontSize: 12, color: "var(--muted)" }}>
          Total: {students.length} student{students.length === 1 ? "" : "s"}
        </div>

        <div style={{ marginTop: 24, fontSize: 11, color: "var(--muted)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <strong>Data gap:</strong> BC licensing also requires date of birth, home address, emergency contact and pickup-authorization on file per child.
          Those live in your paper enrollment forms today. Ask to add these fields to the app if you want a fully self-contained inspection roster.
        </div>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          .report-sheet { border: none !important; padding: 0 !important; }
          @page { margin: 0.5in; }
        }
      `}</style>
    </div>
  );
}
