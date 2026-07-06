// Waitlist archived — /waitlist/archived
// Shows withdrawn + archived entries, with a Restore action.

import { useEffect, useMemo, useState } from "react";
import { listWaitlist, syncOnScreenOpen, updateWaitlistStatus, waitDays, type WaitlistEntry } from "../../lib/waitlist";
import DetailDrawer from "./DetailDrawer";

type ArchFilter = "all" | "aged" | "sheet" | "withdrawn";

export default function WaitlistArchived() {
  const [rows, setRows] = useState<WaitlistEntry[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [filter, setFilter] = useState<ArchFilter>("all");

  const refresh = async () => {
    const r = await listWaitlist({ statuses: ["archived", "withdrawn"] });
    setRows(r);
  };

  useEffect(() => { (async () => { await syncOnScreenOpen(); await refresh(); })(); }, []);

  const restore = async (id: number) => {
    await updateWaitlistStatus(id, "new", null);
    await refresh();
  };

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "withdrawn") return rows.filter((r) => r.status === "withdrawn");
    return rows.filter((r) => {
      if (r.status !== "archived") return false;
      const aged = (r.status_note || "").toLowerCase().includes("aged out");
      return filter === "aged" ? aged : !aged;
    });
  }, [rows, filter]);

  const counts = useMemo(() => {
    let aged = 0, sheet = 0, withdrawn = 0;
    for (const r of rows) {
      if (r.status === "withdrawn") withdrawn++;
      else if ((r.status_note || "").toLowerCase().includes("aged out")) aged++;
      else sheet++;
    }
    return { aged, sheet, withdrawn };
  }, [rows]);

  return (
    <div>
      <h1>Waitlist — Archived</h1>
      <p className="subtitle">
        Withdrawn, auto-archived (removed from the source sheet), or aged out (child is over 5 years).
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <Chip on={filter === "all"} onClick={() => setFilter("all")}>All ({rows.length})</Chip>
        <Chip on={filter === "aged"} onClick={() => setFilter("aged")}>Aged out ({counts.aged})</Chip>
        <Chip on={filter === "sheet"} onClick={() => setFilter("sheet")}>Removed from sheet ({counts.sheet})</Chip>
        <Chip on={filter === "withdrawn"} onClick={() => setFilter("withdrawn")}>Withdrawn ({counts.withdrawn})</Chip>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={th}>Child</th>
              <th style={th}>Parent</th>
              <th style={th}>Submitted</th>
              <th style={th}>Reason</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={td}>
                  <button className="btn link" onClick={() => setOpenId(e.id)}><strong>{e.child_name}</strong></button>
                </td>
                <td style={td}>{e.parent_name || "—"}</td>
                <td style={td}>{waitDays(e.submitted_at)}d ago</td>
                <td style={{ ...td, color: "var(--muted)", fontSize: 13 }}>
                  {e.status === "withdrawn" ? "Withdrawn" : (e.status_note || "Removed from sheet")}
                </td>
                <td style={td}>
                  <button className="btn" onClick={() => restore(e.id)}>Restore</button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>Nothing in this bucket.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {openId !== null && <DetailDrawer id={openId} onClose={() => { setOpenId(null); void refresh(); }} />}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="btn"
      onClick={onClick}
      style={{
        borderRadius: 999,
        padding: "4px 12px",
        fontSize: 13,
        background: on ? "#7c3aed" : "transparent",
        color: on ? "#fff" : "var(--text)",
        borderColor: on ? "#7c3aed" : "var(--border)",
      }}
    >
      {children}
    </button>
  );
}

const th: React.CSSProperties = { padding: "10px 12px", textAlign: "left", fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" };
const td: React.CSSProperties = { padding: "10px 12px", fontSize: 14 };
