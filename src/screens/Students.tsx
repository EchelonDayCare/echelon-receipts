import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { listStudents, listYears, upsertStudent, deleteStudent } from "../lib/db";
import { parseRosterFile } from "../lib/excelImport";
import type { Student } from "../types";

export default function Students() {
  const now = new Date().getFullYear();
  const [years, setYears] = useState<number[]>([now]);
  const [year, setYear] = useState<number>(now);
  const [students, setStudents] = useState<Student[]>([]);
  const [editing, setEditing] = useState<Partial<Student> | null>(null);
  const [pendingImport, setPendingImport] = useState<{ path: string; year: number } | null>(null);

  async function refresh() {
    const ys = await listYears();
    const all = ys.length ? ys : [now];
    setYears(all);
    if (!all.includes(year)) setYear(all[0]);
    setStudents(await listStudents(year, false));
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year]);

  async function onImport() {
    const path = await open({
      multiple: false,
      filters: [{ name: "Excel/CSV", extensions: ["xlsx", "xls", "csv"] }],
    });
    if (!path || Array.isArray(path)) return;
    // Try to auto-detect year from filename (e.g. "Echelon_Roster_2026.xlsx")
    const m = (path as string).match(/(20\d{2})/);
    const guessedYear = m ? parseInt(m[1], 10) : now;
    setPendingImport({ path: path as string, year: guessedYear });
  }

  async function runImport() {
    if (!pendingImport) return;
    const { path, year: targetYear } = pendingImport;
    setPendingImport(null);
    try {
      const bytes = await readFile(path);
      const imported = await parseRosterFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      if (!imported.length) {
        alert("No rows found. Expected columns: Student Name, Father's Name, Mother's Name, Email ID");
        return;
      }
      const existing = new Set((await listStudents(targetYear, false)).map((s) => s.name.toLowerCase().trim()));
      let added = 0, skipped = 0;
      for (const s of imported) {
        if (existing.has(s.name.toLowerCase().trim())) { skipped++; continue; }
        await upsertStudent({ ...s, year: targetYear });
        added++;
      }
      alert(`Imported: ${added} added, ${skipped} skipped (duplicates).`);
      setYear(targetYear);
      refresh();
    } catch (err) {
      alert("Import failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return (
    <div>
      <h1>Students</h1>
      <p className="subtitle">Per-year roster. Receipts always snapshot the parent names at time of issue, so editing here won't change past receipts.</p>

      <div className="toolbar">
        <label style={{ fontSize: 13, color: "var(--muted)" }}>Year:</label>
        <select value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="grow" />
        <button className="btn secondary" onClick={() => setEditing({ year, active: 1 })}>+ Add Student</button>
        <button className="btn" onClick={onImport}>Import from Excel</button>
      </div>

      {students.length === 0 ? (
        <div className="empty">No students for {year}. Click <b>Import from Excel</b> to load a yearly roster.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Student</th><th>Father</th><th>Mother</th><th>Email</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.father_name || "—"}</td>
                <td>{s.mother_name || "—"}</td>
                <td>{s.email || "—"}</td>
                <td>{s.active ? <span className="badge ok">Active</span> : <span className="badge warn">Inactive</span>}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost" onClick={() => setEditing(s)}>Edit</button>
                  {s.active === 1 && (
                    <button className="btn ghost" style={{ color: "var(--danger)" }}
                      onClick={async () => { if (confirm(`Mark ${s.name} inactive?`)) { await deleteStudent(s.id); refresh(); } }}>
                      Inactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            paddingTop: 80, zIndex: 1000,
          }}
        >
          <div className="card" style={{ width: "min(640px, 92vw)", maxHeight: "85vh", overflow: "auto", margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? "Edit Student" : "Add Student"}</h3>
          <div className="row">
            <div className="field">
              <label>Student Name</label>
              <input value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Year</label>
              <input type="number" value={editing.year ?? year} onChange={(e) => setEditing({ ...editing, year: parseInt(e.target.value, 10) })} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>Father's Name</label>
              <input value={editing.father_name || ""} onChange={(e) => setEditing({ ...editing, father_name: e.target.value })} />
            </div>
            <div className="field">
              <label>Mother's Name</label>
              <input value={editing.mother_name || ""} onChange={(e) => setEditing({ ...editing, mother_name: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Email</label>
            <input value={editing.email || ""} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" onClick={async () => {
              if (!editing.name?.trim()) { alert("Name required."); return; }
              await upsertStudent({
                id: editing.id, name: editing.name.trim(),
                father_name: editing.father_name || null,
                mother_name: editing.mother_name || null,
                email: editing.email || null,
                year: editing.year || year, active: editing.active ?? 1,
              });
              setEditing(null); refresh();
            }}>Save</button>
            <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
          </div>
        </div>
      )}
      {pendingImport && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setPendingImport(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            paddingTop: 120, zIndex: 1000,
          }}
        >
          <div className="card" style={{ width: "min(420px, 92vw)", margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>Import Roster</h3>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: -4 }}>
              File: <code>{pendingImport.path.split(/[/\\]/).pop()}</code>
            </p>
            <div className="field">
              <label>Roster Year</label>
              <input
                type="number"
                value={pendingImport.year}
                onChange={(e) => setPendingImport({ ...pendingImport, year: parseInt(e.target.value, 10) || now })}
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="btn" onClick={runImport}>Import</button>
              <button className="btn secondary" onClick={() => setPendingImport(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
