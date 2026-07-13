import { useEffect, useState } from "react";
import { db, execRetry, getSettings } from "../../lib/db";
import { showAlert, showConfirm } from "../../lib/dialogs";
import type { SettingsMap } from "../../types";
import { printCurrentWindow } from "../../lib/print";

interface Drill {
  id: number;
  drill_date: string;
  drill_type: string;
  duration_min: number | null;
  children_present: number | null;
  notes: string | null;
  created_at: string;
}

const DRILL_TYPES = ["Fire", "Earthquake", "Lockdown", "Evacuation", "Shelter-in-place", "Other"];

function monthKey(iso: string): string { return iso.slice(0, 7); }
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString(undefined, { year: "numeric", month: "long" });
}

export default function DrillLog() {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [drills, setDrills] = useState<Drill[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [year, setYear] = useState<number | "all">(new Date().getFullYear());

  // Add form state
  const [drillDate, setDrillDate] = useState(new Date().toISOString().slice(0, 10));
  const [drillType, setDrillType] = useState("Fire");
  const [duration, setDuration] = useState("");
  const [childrenPresent, setChildrenPresent] = useState("");
  const [notes, setNotes] = useState("");

  async function refresh() {
    const rows = await (await db()).select<Drill[]>("SELECT * FROM staff_drills ORDER BY drill_date DESC, id DESC");
    setDrills(rows);
  }

  useEffect(() => { getSettings().then(setSettings); refresh(); }, []);

  const filtered = year === "all" ? drills : drills.filter((d) => d.drill_date.startsWith(String(year)));

  // Months that had a Fire drill (BC CCLR requires monthly fire drills)
  const fireMonths = new Set(filtered.filter((d) => d.drill_type === "Fire").map((d) => monthKey(d.drill_date)));
  const currentYear = year === "all" ? new Date().getFullYear() : year;
  const missingFireMonths: string[] = [];
  if (year !== "all") {
    const now = new Date();
    for (let m = 1; m <= 12; m++) {
      const ym = `${currentYear}-${String(m).padStart(2, "0")}`;
      // Only flag months that have already ended (or the current month if it's ending soon).
      const monthEnd = new Date(currentYear as number, m, 0);
      if (monthEnd < now && !fireMonths.has(ym)) missingFireMonths.push(ym);
    }
  }

  async function addDrill() {
    if (!drillDate || !drillType) { await showAlert("Date and type are required.", { kind: "warning" }); return; }
    await execRetry(
      "INSERT INTO staff_drills (drill_date, drill_type, duration_min, children_present, notes) VALUES (?, ?, ?, ?, ?)",
      [drillDate, drillType, duration ? Number(duration) : null, childrenPresent ? Number(childrenPresent) : null, notes || null]
    );
    setShowAdd(false);
    setDuration(""); setChildrenPresent(""); setNotes("");
    await refresh();
  }

  async function del(id: number) {
    if (!(await showConfirm("Delete this drill record?", { kind: "warning" }))) return;
    await execRetry("DELETE FROM staff_drills WHERE id=?", [id]);
    await refresh();
  }

  function exportCsv() {
    const lines = ["Date,Type,Duration (min),Children Present,Notes"];
    filtered.forEach((d) => {
      lines.push([d.drill_date, d.drill_type, d.duration_min ?? "", d.children_present ?? "", d.notes || ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `drill-log-${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const yearsInData = Array.from(new Set(drills.map((d) => d.drill_date.slice(0, 4)))).sort((a, b) => b.localeCompare(a));
  const daycareName = settings.daycare_name || "Echelon Daycare";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>Emergency Drill Log</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Fire, earthquake, lockdown and evacuation drills. BC Child Care Licensing Regulation §56 requires <strong>fire drills at least once per month</strong>.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label>Year:
            <select value={year} onChange={(e) => setYear(e.target.value === "all" ? "all" : Number(e.target.value))} style={{ marginLeft: 6 }}>
              <option value="all">All</option>
              {[String(new Date().getFullYear()), ...yearsInData].filter((v, i, a) => a.indexOf(v) === i).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <button className="btn secondary" onClick={() => { void printCurrentWindow(); }}>Print</button>
          <button className="btn" onClick={() => setShowAdd(true)}>+ Log drill</button>
        </div>
      </div>

      {year !== "all" && missingFireMonths.length > 0 && (
        <div className="no-print" style={{ background: "#fee2e2", color: "#991b1b", padding: 12, borderRadius: 6, marginBottom: 12 }}>
          <strong>⚠️ Fire drill missing for {missingFireMonths.length} month{missingFireMonths.length === 1 ? "" : "s"} in {year}:</strong>{" "}
          {missingFireMonths.map(monthLabel).join(", ")}.
          BC CCLR §56 requires at least one fire drill each calendar month.
        </div>
      )}

      <div className="report-sheet" style={{ background: "#fff", padding: 24, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{daycareName}</div>
          <div style={{ color: "var(--muted)" }}>Emergency Drill Log — {year === "all" ? "All Years" : year}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Printed: {today}</div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Date</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Type</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Duration (min)</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Children Present</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Notes</th>
              <th style={{ padding: 6, border: "1px solid var(--border)", width: 60 }} className="no-print"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.id}>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{d.drill_date}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", fontWeight: 600 }}>{d.drill_type}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{d.duration_min ?? "—"}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{d.children_present ?? "—"}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{d.notes || ""}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)" }} className="no-print">
                  <button className="btn link danger" onClick={() => del(d.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No drills logged for {year === "all" ? "any year" : year}.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ marginTop: 16, fontSize: 11, color: "var(--muted)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          Regulation: BC Child Care Licensing Regulation §56 (Emergency Preparedness). Fire drills required monthly; earthquake drills recommended quarterly.
        </div>
      </div>

      {showAdd && (
        <div onClick={() => setShowAdd(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", padding: 24, borderRadius: 8, width: "90%", maxWidth: 500 }}>
            <h2 style={{ marginTop: 0 }}>Log a drill</h2>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Date</label>
            <input type="date" value={drillDate} onChange={(e) => setDrillDate(e.target.value)} style={{ marginBottom: 12 }} />
            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Type</label>
            <select value={drillType} onChange={(e) => setDrillType(e.target.value)} style={{ marginBottom: 12 }}>
              {DRILL_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Duration (minutes)</label>
            <input type="number" min="0" value={duration} onChange={(e) => setDuration(e.target.value)} style={{ marginBottom: 12, width: "100%", padding: 6 }} />
            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Children Present</label>
            <input type="number" min="0" value={childrenPresent} onChange={(e) => setChildrenPresent(e.target.value)} style={{ marginBottom: 12, width: "100%", padding: 6 }} />
            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ width: "100%", padding: 6, fontFamily: "inherit" }} placeholder="Weather, issues, staff on duty…" />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn" onClick={addDrill}>Save</button>
            </div>
          </div>
        </div>
      )}

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
