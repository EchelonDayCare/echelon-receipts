import { useEffect, useState } from "react";
import { DRILL_TYPES, listDrills, upsertDrill, deleteDrill } from "../lib/credentials";
import type { StaffDrill } from "../types";

const today = () => new Date().toISOString().slice(0, 10);

export default function StaffDrills() {
  const [rows, setRows] = useState<StaffDrill[]>([]);
  const [editing, setEditing] = useState<Partial<StaffDrill> | null>(null);
  const [year, setYear] = useState<number | "all">(new Date().getFullYear());

  async function refresh() {
    setRows(await listDrills(year === "all" ? undefined : year));
  }
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [year]);

  async function save() {
    if (!editing?.drill_date || !editing.drill_type) {
      alert("Date and type are required.");
      return;
    }
    await upsertDrill({
      id: editing.id,
      drill_date: editing.drill_date,
      drill_type: editing.drill_type,
      duration_min: editing.duration_min ?? null,
      children_present: editing.children_present ?? null,
      notes: editing.notes || null,
    });
    setEditing(null);
    await refresh();
  }

  async function remove(id: number) {
    if (!confirm("Delete this drill record?")) return;
    await deleteDrill(id);
    await refresh();
  }

  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Drill Log</h1>
          <p className="subtitle" style={{ margin: "4px 0 0" }}>
            Fire, lockdown and other emergency drills. Required to be on file for licensing inspections.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={String(year)} onChange={(e) => setYear(e.target.value === "all" ? "all" : Number(e.target.value))}>
            <option value="all">All years</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn" onClick={() => setEditing({ drill_date: today(), drill_type: "Fire" })}>+ Log a drill</button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <p style={{ padding: 24, margin: 0, color: "var(--muted)" }}>
            No drills logged {year === "all" ? "yet" : `for ${year}`}. Click <strong>Log a drill</strong> after each drill.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Duration (min)</th>
                <th>Children present</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.drill_date}</td>
                  <td><span className="pill">{r.drill_type}</span></td>
                  <td>{r.duration_min ?? "—"}</td>
                  <td>{r.children_present ?? "—"}</td>
                  <td style={{ color: "var(--muted)", fontSize: 13 }}>{r.notes || ""}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn link" onClick={() => setEditing(r)}>Edit</button>
                    <button className="btn link" style={{ color: "var(--danger)" }} onClick={() => remove(r.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "92vw" }}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? "Edit drill" : "Log a drill"}</h3>
            <div className="row">
              <div className="field">
                <label>Date</label>
                <input type="date" value={editing.drill_date || ""} onChange={(e) => setEditing({ ...editing, drill_date: e.target.value })} />
              </div>
              <div className="field">
                <label>Type</label>
                <select value={editing.drill_type || ""} onChange={(e) => setEditing({ ...editing, drill_type: e.target.value })}>
                  {DRILL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>Duration (minutes)</label>
                <input
                  type="number"
                  min={0}
                  value={editing.duration_min ?? ""}
                  onChange={(e) => setEditing({ ...editing, duration_min: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Children present</label>
                <input
                  type="number"
                  min={0}
                  value={editing.children_present ?? ""}
                  onChange={(e) => setEditing({ ...editing, children_present: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="field">
              <label>Notes</label>
              <textarea
                rows={3}
                value={editing.notes || ""}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                placeholder="What went well / what to improve, who led the drill, evacuation route used, etc."
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
