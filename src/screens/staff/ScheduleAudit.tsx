// Chronological audit trail for a week of shifts.
// v2.2.1: replaced raw-JSON payload column with plain-English descriptions
// (from lib/shiftEventPhrase). Full JSON is still one click away for the
// rare technical-debug case.
import { useEffect, useMemo, useState } from "react";
import { addDays, listAuditForWeek, mondayOf, type ShiftEvent } from "../../repo/scheduleRepo";
import { db } from "../../lib/db";
import { describeShiftEvent } from "../../lib/shiftEventPhrase";
import ScheduleSubNav from "./ScheduleSubNav";

export default function ScheduleAudit() {
  const [weekStart, setWeekStart] = useState<string>(() => mondayOf(new Date()));
  const [events, setEvents] = useState<ShiftEvent[]>([]);
  const [staffNames, setStaffNames] = useState<Map<string, string>>(new Map());
  const [showJson, setShowJson] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setEvents(await listAuditForWeek(weekStart));
        const d = await db();
        const rows = await d.select<{ id: number; name: string }[]>("SELECT id, name FROM staff");
        setStaffNames(new Map(rows.map((r) => [String(r.id), r.name])));
      } catch (e: any) { setErr(String(e?.message ?? e)); }
    })();
  }, [weekStart]);

  const range = useMemo(() => {
    const end = addDays(weekStart, 6);
    return `${weekStart} – ${end}`;
  }, [weekStart]);

  const staffName = (id: number | string | null | undefined): string => {
    if (id == null) return "";
    return staffNames.get(String(id)) ?? "";
  };

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <ScheduleSubNav />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button className="btn" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</button>
        <h1 style={{ margin: 0 }}>Schedule audit · {range}</h1>
        <button className="btn" onClick={() => setWeekStart(addDays(weekStart, 7))}>›</button>
        <button className="btn" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</button>
      </div>
      <div style={{ marginBottom: 14, color: "var(--muted)", fontSize: 12 }}>
        Every change to shifts in this week — newest first.{" "}
        <button
          type="button"
          onClick={() => setShowJson((v) => !v)}
          style={{ background: "transparent", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, fontSize: 12 }}
        >
          {showJson ? "Hide" : "Show"} technical details
        </button>
      </div>

      {err && <div style={{ padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5", border: "1px solid rgba(220,38,38,.35)", marginBottom: 12 }}>{err}</div>}

      {events.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>No shift events in this week yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {events.map((e) => {
            const when = new Date(e.createdAt);
            return (
              <div key={e.id} style={{
                padding: "10px 12px",
                border: "1px solid var(--border, #e5e7eb)",
                borderRadius: 8,
                background: "#fff",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                  <div style={{ fontSize: 14 }}>{describeShiftEvent(e, staffName)}</div>
                  <div style={{ color: "var(--muted)", fontSize: 11, whiteSpace: "nowrap" }}>
                    {when.toLocaleString()}
                    {e.channel ? ` · ${e.channel}` : ""}
                  </div>
                </div>
                {showJson && e.payload != null && (
                  <pre style={{
                    margin: "8px 0 0", padding: 8, borderRadius: 6,
                    background: "#f8fafc", color: "#334155",
                    fontFamily: "ui-monospace, monospace", fontSize: 11,
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}>{JSON.stringify(e.payload, null, 2)}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
