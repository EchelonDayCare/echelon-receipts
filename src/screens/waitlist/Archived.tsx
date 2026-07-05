// Waitlist archived — /waitlist/archived
// Shows withdrawn + archived entries, with a Restore action.

import { useEffect, useState } from "react";
import { listWaitlist, syncOnScreenOpen, updateWaitlistStatus, waitDays, type WaitlistEntry } from "../../lib/waitlist";
import DetailDrawer from "./DetailDrawer";

export default function WaitlistArchived() {
  const [rows, setRows] = useState<WaitlistEntry[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);

  const refresh = async () => {
    const r = await listWaitlist({ statuses: ["archived", "withdrawn"] });
    setRows(r);
  };

  useEffect(() => { (async () => { await syncOnScreenOpen(); await refresh(); })(); }, []);

  const restore = async (id: number) => {
    await updateWaitlistStatus(id, "new", null);
    await refresh();
  };

  return (
    <div>
      <h1>Waitlist — Archived</h1>
      <p className="subtitle">Withdrawn or auto-archived (removed from the source sheet).</p>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={th}>Child</th>
              <th style={th}>Parent</th>
              <th style={th}>Submitted</th>
              <th style={th}>Status</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={td}>
                  <button className="btn link" onClick={() => setOpenId(e.id)}><strong>{e.child_name}</strong></button>
                </td>
                <td style={td}>{e.parent_name || "—"}</td>
                <td style={td}>{waitDays(e.submitted_at)}d ago</td>
                <td style={td}>{e.status}</td>
                <td style={td}>
                  <button className="btn" onClick={() => restore(e.id)}>Restore</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>Nothing archived.</td></tr>
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
