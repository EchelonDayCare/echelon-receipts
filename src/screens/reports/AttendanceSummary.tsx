import { useEffect, useState } from "react";
import { db, getSettings, listStudents, listYears } from "../../lib/db";
import type { Student, SettingsMap } from "../../types";

interface AttRow {
  student_id: number;
  present_days: number;
  absent_days: number;
  total_hours: number;
}

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function AttendanceSummary() {
  const now = new Date();
  const [settings, setSettings] = useState<SettingsMap>({});
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number>(now.getFullYear());
  const [month, setMonth] = useState<number>(now.getMonth() + 1);
  const [students, setStudents] = useState<Student[]>([]);
  const [rows, setRows] = useState<Map<number, AttRow>>(new Map());

  useEffect(() => {
    (async () => {
      const [s, ys] = await Promise.all([getSettings(), listYears()]);
      setSettings(s); setYears(ys); if (ys[0]) setYear(ys[0]);
    })();
  }, []);

  async function refresh() {
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    const [st, agg] = await Promise.all([
      listStudents(year, false),
      (await db()).select<{ student_id: number; present_days: number; absent_days: number; total_hours: number }[]>(
        `SELECT student_id,
                SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present_days,
                SUM(CASE WHEN status='absent'  THEN 1 ELSE 0 END) AS absent_days,
                COALESCE(SUM(hours_decimal),0) AS total_hours
           FROM child_attendance
          WHERE substr(work_date,1,7)=?
          GROUP BY student_id`,
        [ym]
      ),
    ]);
    setStudents(st);
    const map = new Map<number, AttRow>();
    agg.forEach((r) => map.set(r.student_id, r));
    setRows(map);
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year, month]);

  const totals = students.reduce(
    (acc, s) => {
      const r = rows.get(s.id);
      if (r) { acc.present += r.present_days; acc.absent += r.absent_days; acc.hours += r.total_hours; }
      return acc;
    },
    { present: 0, absent: 0, hours: 0 }
  );

  function exportCsv() {
    const lines = ["Student,Present Days,Absent Days,Total Hours"];
    students.forEach((s) => {
      const r = rows.get(s.id) || { present_days: 0, absent_days: 0, total_hours: 0 };
      lines.push([s.name, r.present_days, r.absent_days, r.total_hours.toFixed(2)]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `attendance-${year}-${String(month).padStart(2, "0")}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const daycareName = settings.daycare_name || "Echelon Daycare";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>Attendance Summary</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Days present, absences and total hours per student per month. Attendance records are required daily under BC CCLR §57.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{MONTH_NAMES[m]}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="report-sheet" style={{ background: "#fff", padding: 24, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{daycareName}</div>
          <div style={{ color: "var(--muted)" }}>Attendance — {MONTH_NAMES[month]} {year}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Printed: {today}</div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Student</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Days Present</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Days Absent</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Total Hours</th>
            </tr>
          </thead>
          <tbody>
            {students.map((s) => {
              const r = rows.get(s.id);
              return (
                <tr key={s.id}>
                  <td style={{ padding: 6, border: "1px solid var(--border)" }}>{s.name}</td>
                  <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{r?.present_days ?? 0}</td>
                  <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{r?.absent_days ?? 0}</td>
                  <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{(r?.total_hours ?? 0).toFixed(2)}</td>
                </tr>
              );
            })}
            {students.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No students for this year.</td></tr>
            )}
          </tbody>
          {students.length > 0 && (
            <tfoot>
              <tr style={{ background: "#f8fafc", fontWeight: 700 }}>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>Totals</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{totals.present}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{totals.absent}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{totals.hours.toFixed(2)}</td>
              </tr>
            </tfoot>
          )}
        </table>

        <div style={{ marginTop: 16, fontSize: 11, color: "var(--muted)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          Data source: <em>Attendance</em> screen daily sign-in/out. Zeros indicate no attendance records were logged for the month.
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
