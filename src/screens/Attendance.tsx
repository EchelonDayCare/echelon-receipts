import { useEffect, useMemo, useState } from "react";
import { getSettings } from "../lib/db";
import {
  rosterForDate, upsertAttendance, stampIn, stampOut, markAbsent, deleteAttendance,
  type DayRosterRow, type AttendanceStatus,
} from "../lib/attendance";
import { h } from "../lib/html";

const STATUS_OPTIONS: AttendanceStatus[] = ["present", "absent", "sick", "late", "holiday"];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function Attendance() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [date, setDate] = useState(todayIso());
  const [rows, setRows] = useState<DayRosterRow[]>([]);
  const [daycareName, setDaycareName] = useState<string>("");
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);

  async function refresh() {
    setRows(await rosterForDate(year, date));
    const s = await getSettings();
    setDaycareName(s.daycare_name || "");
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year, date]);

  function show(msg: string, tone: "ok" | "err" = "ok") {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2500);
  }

  async function patchRow(studentId: number, patch: Partial<{
    in_time: string | null; out_time: string | null;
    signed_in_by: string | null; signed_out_by: string | null;
    status: AttendanceStatus; notes: string | null;
  }>) {
    const cur = rows.find((r) => r.student_id === studentId)?.attendance;
    try {
      await upsertAttendance({
        studentId, workDate: date,
        inTime: patch.in_time !== undefined ? patch.in_time : (cur?.in_time ?? null),
        outTime: patch.out_time !== undefined ? patch.out_time : (cur?.out_time ?? null),
        signedInBy: patch.signed_in_by !== undefined ? patch.signed_in_by : (cur?.signed_in_by ?? null),
        signedOutBy: patch.signed_out_by !== undefined ? patch.signed_out_by : (cur?.signed_out_by ?? null),
        status: patch.status ?? cur?.status ?? "present",
        notes: patch.notes !== undefined ? patch.notes : (cur?.notes ?? null),
      });
      await refresh();
    } catch (e: any) {
      show("Save failed: " + (e?.message || e), "err");
    }
  }

  async function onStampIn(studentId: number) {
    try { await stampIn(studentId, date); await refresh(); show("Signed in"); }
    catch (e: any) { show("Failed: " + (e?.message || e), "err"); }
  }
  async function onStampOut(studentId: number) {
    try { await stampOut(studentId, date); await refresh(); show("Signed out"); }
    catch (e: any) { show("Failed: " + (e?.message || e), "err"); }
  }
  async function onMarkAbsent(studentId: number) {
    try { await markAbsent(studentId, date, "absent"); await refresh(); }
    catch (e: any) { show("Failed: " + (e?.message || e), "err"); }
  }
  async function onClear(rec: number) {
    try { await deleteAttendance(rec); await refresh(); }
    catch (e: any) { show("Failed: " + (e?.message || e), "err"); }
  }

  const presentCount = rows.filter((r) => r.attendance?.status === "present").length;
  const absentCount = rows.filter((r) => r.attendance && r.attendance.status !== "present").length;
  const noRecordCount = rows.filter((r) => !r.attendance).length;

  const yearOptions = useMemo(() => {
    const y = today.getFullYear();
    return [y - 1, y, y + 1];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function printRoster() {
    const dateLabel = new Date(date + "T00:00:00").toLocaleDateString(undefined, {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const tbody = rows.map((r) => {
      const a = r.attendance;
      const stat = a?.status ?? "—";
      return `<tr>
        <td>${h(r.student_name)}</td>
        <td>${h(a?.in_time || "")}</td>
        <td>${h(a?.out_time || "")}</td>
        <td>${(a?.hours_decimal ?? 0).toFixed(2)}</td>
        <td>${h(stat)}</td>
        <td>${h(a?.signed_in_by || "")}</td>
        <td>${h(a?.signed_out_by || "")}</td>
        <td>${h(a?.notes || "")}</td>
      </tr>`;
    }).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>Daily Attendance — ${h(dateLabel)}</title>
      <style>
        body { font-family: -apple-system, system-ui, sans-serif; margin: 24px; color: #111; }
        h1 { margin: 0 0 4px 0; font-size: 18px; }
        .sub { color: #555; font-size: 12px; margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
        th { background: #eee; }
        @media print { @page { size: letter landscape; margin: 0.4in; } }
      </style></head>
      <body>
        <h1>${h(daycareName)} — Daily Attendance</h1>
        <div class="sub">${h(dateLabel)} • Present ${presentCount} • Absent/other ${absentCount} • No record ${noRecordCount}</div>
        <table>
          <thead><tr>
            <th>Child</th><th>In</th><th>Out</th><th>Hrs</th><th>Status</th>
            <th>Signed in by</th><th>Signed out by</th><th>Notes</th>
          </tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </body></html>`;
    const w = window.open("", "_blank");
    if (!w) { show("Pop-up blocked", "err"); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 300);
  }

  return (
    <div>
      <h1>Daily Attendance</h1>
      <p className="subtitle">Required by BC Community Care Licensing — daily in/out for each child. Records auto-save.</p>

      <div className="toolbar">
        <label style={{ fontSize: 13, color: "var(--muted)" }}>Year:</label>
        <select value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}>
          {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <label style={{ fontSize: 13, color: "var(--muted)", marginLeft: 12 }}>Date:</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn secondary" onClick={() => setDate(todayIso())}>Today</button>
        <div className="grow" />
        <button className="btn secondary" onClick={printRoster} disabled={rows.length === 0}>Print Daily Roster</button>
      </div>

      <div className="kpi">
        <div className="card"><div className="lbl">Roster size ({year})</div><div className="val">{rows.length}</div></div>
        <div className="card"><div className="lbl">Present</div><div className="val">{presentCount}</div></div>
        <div className="card"><div className="lbl">Absent / sick / holiday</div><div className="val">{absentCount}</div></div>
        <div className="card"><div className="lbl">No record yet</div><div className="val">{noRecordCount}</div></div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">No active students for {year}. Add students in the Roster screen first.</div>
      ) : (
        <table className="data">
          <thead><tr>
            <th>Child</th>
            <th>In</th><th>Out</th><th>Hrs</th>
            <th>Status</th>
            <th>Signed in by</th><th>Signed out by</th>
            <th>Notes</th>
            <th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const a = r.attendance;
              return (
                <tr key={r.student_id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.student_name}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>
                      {r.father_name || r.mother_name || ""}
                    </div>
                  </td>
                  <td>
                    <input type="time" defaultValue={a?.in_time || ""} style={{ width: 100 }}
                      onBlur={(e) => {
                        const v = e.target.value || null;
                        if (v !== (a?.in_time ?? null)) patchRow(r.student_id, { in_time: v });
                      }} />
                    {!a?.in_time && (
                      <button className="btn ghost" style={{ marginLeft: 4, padding: "2px 6px", fontSize: 11 }}
                        onClick={() => onStampIn(r.student_id)}>Now</button>
                    )}
                  </td>
                  <td>
                    <input type="time" defaultValue={a?.out_time || ""} style={{ width: 100 }}
                      onBlur={(e) => {
                        const v = e.target.value || null;
                        if (v !== (a?.out_time ?? null)) patchRow(r.student_id, { out_time: v });
                      }} />
                    {a?.in_time && !a?.out_time && (
                      <button className="btn ghost" style={{ marginLeft: 4, padding: "2px 6px", fontSize: 11 }}
                        onClick={() => onStampOut(r.student_id)}>Now</button>
                    )}
                  </td>
                  <td>{(a?.hours_decimal ?? 0).toFixed(2)}</td>
                  <td>
                    <select value={a?.status || "present"}
                      onChange={(e) => {
                        const v = e.target.value as AttendanceStatus;
                        if (v === "absent" || v === "sick" || v === "holiday") {
                          markAbsent(r.student_id, date, v).then(refresh);
                        } else {
                          patchRow(r.student_id, { status: v });
                        }
                      }}>
                      {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="text" defaultValue={a?.signed_in_by || ""} style={{ width: 120 }}
                      placeholder="Parent name"
                      onBlur={(e) => {
                        const v = e.target.value.trim() || null;
                        if (v !== (a?.signed_in_by ?? null)) patchRow(r.student_id, { signed_in_by: v });
                      }} />
                  </td>
                  <td>
                    <input type="text" defaultValue={a?.signed_out_by || ""} style={{ width: 120 }}
                      placeholder="Parent name"
                      onBlur={(e) => {
                        const v = e.target.value.trim() || null;
                        if (v !== (a?.signed_out_by ?? null)) patchRow(r.student_id, { signed_out_by: v });
                      }} />
                  </td>
                  <td>
                    <input type="text" defaultValue={a?.notes || ""} style={{ width: 160 }}
                      onBlur={(e) => {
                        const v = e.target.value.trim() || null;
                        if (v !== (a?.notes ?? null)) patchRow(r.student_id, { notes: v });
                      }} />
                  </td>
                  <td>
                    {a ? (
                      <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 11 }}
                        onClick={() => onClear(a.id)}>Clear</button>
                    ) : (
                      <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 11 }}
                        onClick={() => onMarkAbsent(r.student_id)}>Absent</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, padding: "10px 14px", borderRadius: 6,
          background: toast.tone === "ok" ? "#15803d" : "#b91c1c", color: "white", fontSize: 13,
        }}>{toast.msg}</div>
      )}
    </div>
  );
}
