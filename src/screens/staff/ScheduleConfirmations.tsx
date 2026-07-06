// Per-week per-staff publish tracker — owner ticks off acks manually.
import { useEffect, useState } from "react";
import { listRecentPublishes, markPublishAcknowledged, type PublishRow } from "../../repo/scheduleRepo";
import { db } from "../../lib/db";

export default function ScheduleConfirmations() {
  const [rows, setRows] = useState<(PublishRow & { staffName: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await listRecentPublishes(60);
      const d = await db();
      const names = await d.select<{ id: number; name: string }[]>("SELECT id, name FROM staff");
      const byId = new Map(names.map((r) => [String(r.id), r.name]));
      setRows(list.map((r) => ({ ...r, staffName: byId.get(r.staffId) ?? `Staff #${r.staffId}` })));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  };
  useEffect(() => { void refresh(); }, []);

  async function ack(id: string, version: number) {
    setBusy(true);
    try {
      const notes = prompt("Ack notes (optional):", "") ?? "";
      await markPublishAcknowledged(id, version, notes);
      await refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Schedule confirmations</h1>
      {err && <div style={{ padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5", border: "1px solid rgba(220,38,38,.35)", marginBottom: 12 }}>{err}</div>}
      {rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>No published weeks yet.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th style={{ padding: 8 }}>Staff</th>
              <th style={{ padding: 8 }}>Week starting</th>
              <th style={{ padding: 8 }}>Published</th>
              <th style={{ padding: 8 }}>Acknowledged</th>
              <th style={{ padding: 8 }}>Notes</th>
              <th style={{ padding: 8, width: 120 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border, #1e293b)" }}>
                <td style={{ padding: 8 }}>{r.staffName}</td>
                <td style={{ padding: 8 }}>{r.weekStartDate}</td>
                <td style={{ padding: 8 }}>{new Date(r.publishedAt).toLocaleString()}</td>
                <td style={{ padding: 8, color: r.acknowledgedAt ? "#22c55e" : "#d97706" }}>
                  {r.acknowledgedAt ? new Date(r.acknowledgedAt).toLocaleString() : "—"}
                </td>
                <td style={{ padding: 8 }}>{r.ackNotes ?? "—"}</td>
                <td style={{ padding: 8 }}>
                  {!r.acknowledgedAt && (
                    <button className="btn" onClick={() => ack(r.id, r.version)} disabled={busy}>Mark ack</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
