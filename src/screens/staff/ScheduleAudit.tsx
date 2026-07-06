// Chronological audit trail for a week of shifts.
import { useEffect, useMemo, useState } from "react";
import { addDays, listAuditForWeek, mondayOf, type ShiftEvent } from "../../repo/scheduleRepo";

export default function ScheduleAudit() {
  const [weekStart, setWeekStart] = useState<string>(() => mondayOf(new Date()));
  const [events, setEvents] = useState<ShiftEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try { setEvents(await listAuditForWeek(weekStart)); }
      catch (e: any) { setErr(String(e?.message ?? e)); }
    })();
  }, [weekStart]);
  const range = useMemo(() => {
    const end = addDays(weekStart, 6);
    return `${weekStart} – ${end}`;
  }, [weekStart]);
  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <button className="btn" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</button>
        <h1 style={{ margin: 0 }}>Schedule audit · {range}</h1>
        <button className="btn" onClick={() => setWeekStart(addDays(weekStart, 7))}>›</button>
        <button className="btn" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</button>
      </div>
      {err && <div style={{ padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5", border: "1px solid rgba(220,38,38,.35)", marginBottom: 12 }}>{err}</div>}
      {events.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>No shift events in this week yet.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th style={{ padding: 8 }}>When</th>
              <th style={{ padding: 8 }}>Event</th>
              <th style={{ padding: 8 }}>Detail</th>
              <th style={{ padding: 8 }}>Channel</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} style={{ borderTop: "1px solid var(--border, #1e293b)" }}>
                <td style={{ padding: 8, whiteSpace: "nowrap" }}>{new Date(e.createdAt).toLocaleString()}</td>
                <td style={{ padding: 8 }}><b>{e.eventType}</b></td>
                <td style={{ padding: 8, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                  {e.payload ? JSON.stringify(e.payload) : "—"}
                </td>
                <td style={{ padding: 8 }}>{e.channel ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
