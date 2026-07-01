import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "../lib/db";
import {
  rosterForDate, upsertAttendance, stampIn, stampOut, markAbsent, deleteAttendance,
  matchStudentByName,
  type DayRosterRow, type AttendanceStatus,
} from "../lib/attendance";
import { extractAttendance, fileToMime, type ExtractedAttendanceRow } from "../lib/gemini";
import type { SettingsMap } from "../types";
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
  const [settings, setSettings] = useState<SettingsMap>({});
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);

  // OCR state
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrResult, setOcrResult] = useState<{ rows: ExtractedAttendanceRow[]; unmatched: string[]; rawText?: string } | null>(null);

  async function refresh() {
    setRows(await rosterForDate(year, date));
    const s = await getSettings();
    setSettings(s);
    setDaycareName(s.daycare_name || "");
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year, date]);

  function show(msg: string, tone: "ok" | "err" = "ok") {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2500);
  }

  // ---- OCR: read attendance sheet via Gemini ----
  async function runAttendanceOcr(picked: string) {
    if (settings.gemini_api_key_set !== "1") {
      show("Add your Gemini API key in Settings first.", "err"); return;
    }
    setOcrBusy(true);
    setOcrResult(null);
    let apiKey: string | null = null;
    try {
      apiKey = await invoke<string | null>("keychain_get", { key: "gemini_api_key" });
      if (!apiKey) throw new Error("Gemini API key not found in keychain — re-save it in Settings.");
      const bytes = await readFile(picked);
      const mime = fileToMime(picked);
      const studentList = rows.map((r) => ({ id: r.student_id, name: r.student_name }));
      const result = await extractAttendance({
        apiKey, imageBytes: bytes, mimeType: mime,
        targetDate: date,
        knownStudentNames: studentList.map((s) => s.name),
      });
      const unmatched = new Set<string>();
      for (const r of result.rows) {
        if (!matchStudentByName(r.child_name, studentList)) unmatched.add(r.child_name);
      }
      setOcrResult({ rows: result.rows, unmatched: Array.from(unmatched).sort(), rawText: result.raw_text });
      if (result.rows.length === 0) {
        show("AI returned 0 rows — see 'What the AI saw' below to debug.", "err");
      } else {
        show(`Read ${result.rows.length} entries. Review and import below.`);
      }
    } catch (e: any) {
      const raw = String(e?.message || e);
      const safe = apiKey ? raw.split(apiKey).join("***") : raw;
      show("OCR failed: " + safe, "err");
    } finally { setOcrBusy(false); }
  }

  async function pickFile() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Sign-in sheet (image)", extensions: ["jpg", "jpeg", "png", "webp", "heic", "pdf"] }],
    });
    if (!picked || typeof picked !== "string") return;
    await runAttendanceOcr(picked);
  }

  async function importLatestFromDownloads() {
    if (settings.gemini_api_key_set !== "1") {
      show("Add your Gemini API key in Settings first.", "err"); return;
    }
    if (ocrBusy) return;
    try {
      const items = await invoke<Array<{ path: string; name: string; modified_secs_ago: number; size: number }>>(
        "inbox_list_recent", { withinMinutes: 10, limit: 5 }
      );
      if (!items.length) {
        show("No images in Downloads from the last 10 min. AirDrop from iPad and retry.", "err");
        return;
      }
      let picked = items[0];
      const fmtMin = (s: number) => Math.max(1, Math.round(s / 60));
      const fmtMb = (b: number) => (b / (1024 * 1024)).toFixed(1);
      if (items.length === 1) {
        const ok = window.confirm(
          `Import "${picked.name}" (${fmtMin(picked.modified_secs_ago)} min ago, ${fmtMb(picked.size)} MB) for OCR?`
        );
        if (!ok) return;
      } else {
        const list = items.map((it, i) =>
          `${i + 1}. ${it.name}  (${fmtMin(it.modified_secs_ago)} min ago, ${fmtMb(it.size)} MB)`
        ).join("\n");
        const ans = window.prompt(`Multiple recent images in Downloads:\n\n${list}\n\nWhich number to import?`, "1");
        if (ans === null) return;
        const n = Number(ans.trim());
        if (!Number.isInteger(n) || n < 1 || n > items.length) {
          show(`Enter a number from 1 to ${items.length}.`, "err"); return;
        }
        picked = items[n - 1];
      }
      show(`Reading ${picked.name}…`);
      await runAttendanceOcr(picked.path);
    } catch (e: any) {
      show("Couldn't read Downloads: " + (e?.message || e), "err");
    }
  }

  // Bulk import matched rows. Rows for the same student on the same date
  // upsert via the existing UNIQUE(student_id, work_date) constraint.
  async function importOcrRows() {
    if (!ocrResult) return;
    const studentList = rows.map((r) => ({ id: r.student_id, name: r.student_name }));
    let saved = 0, unmatched = 0, dbErrors = 0;
    let lastError: unknown = null;
    for (const r of ocrResult.rows) {
      const match = matchStudentByName(r.child_name, studentList);
      if (!match) { unmatched++; continue; }
      try {
        const validStatus = (s: string | null): AttendanceStatus => {
          if (!s) return r.in_time || r.out_time ? "present" : "absent";
          const lower = s.toLowerCase();
          if (STATUS_OPTIONS.includes(lower as AttendanceStatus)) return lower as AttendanceStatus;
          return r.in_time || r.out_time ? "present" : "absent";
        };
        await upsertAttendance({
          studentId: match.id,
          workDate: r.work_date || date,
          inTime: r.in_time, outTime: r.out_time,
          signedInBy: r.signed_in_by, signedOutBy: r.signed_out_by,
          status: validStatus(r.status),
        });
        saved++;
      } catch (e) {
        dbErrors++;
        lastError = e;
        console.error(`[importOcrRows] upsertAttendance failed for ${r.child_name} @ ${r.work_date || date}:`, e);
      }
    }
    setOcrResult(null);
    await refresh();
    const bits: string[] = [`Imported ${saved} entries`];
    if (unmatched) bits.push(`${unmatched} unmatched`);
    if (dbErrors) bits.push(`${dbErrors} DB errors (see console)`);
    show(bits.join(" · ") + ".", dbErrors ? "err" : "ok");
    if (dbErrors && lastError) {
      show(`First DB error: ${String((lastError as Error)?.message ?? lastError).slice(0, 240)}`, "err");
    }
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

      {/* OCR upload CTA — primary path for daily sheets */}
      <section className="card" style={{ marginBottom: 16, background: "linear-gradient(180deg, #ecfdf5 0%, #ffffff 65%)", borderColor: "#a7f3d0" }}>
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ width: 56, height: 56, borderRadius: 12, background: "#d1fae5", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0 }}>👶</div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ margin: "0 0 4px" }}>Upload {date} attendance sheet</h3>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
              Snap the daily sign-in sheet. Gemini reads each child's drop-off / pick-up times and signatures; you review and import.
            </p>
            {rows.length === 0 && (
              <p style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: 13 }}>Add at least one student to the {year} roster before uploading.</p>
            )}
            {settings.gemini_api_key_set !== "1" && rows.length > 0 && (
              <p style={{ margin: "6px 0 0", color: "#b45309", fontSize: 13 }}>⚠ Add your Gemini API key in <strong>Settings → Optional features</strong> first.</p>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}>
            <button
              onClick={importLatestFromDownloads}
              disabled={ocrBusy || rows.length === 0 || settings.gemini_api_key_set !== "1"}
              title="Picks the newest image AirDropped or saved to ~/Downloads in the last 10 min"
              style={{
                position: "relative",
                padding: "16px 22px", fontSize: 16, fontWeight: 700,
                background: "linear-gradient(180deg, #16a34a 0%, #15803d 100%)",
                color: "white", border: "none", borderRadius: 12,
                cursor: ocrBusy ? "not-allowed" : "pointer",
                boxShadow: "0 4px 14px rgba(22, 163, 74, 0.35)",
                opacity: (ocrBusy || rows.length === 0 || settings.gemini_api_key_set !== "1") ? 0.55 : 1,
                minWidth: 260,
              }}
            >
              <span style={{
                position: "absolute", top: -8, right: -8,
                background: "#f59e0b", color: "white", fontSize: 10,
                padding: "2px 7px", borderRadius: 10, fontWeight: 800, letterSpacing: 0.5,
              }}>NEW</span>
              <div style={{ fontSize: 22, marginBottom: 2 }}>📥 Import from Downloads</div>
              <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.9 }}>AirDrop from iPad → click here</div>
            </button>
            <button
              className="btn secondary"
              onClick={pickFile}
              disabled={ocrBusy || rows.length === 0 || settings.gemini_api_key_set !== "1"}
              style={{ fontSize: 13 }}
            >
              {ocrBusy ? "Reading sheet…" : "…or choose file manually"}
            </button>
          </div>
        </div>

        {ocrResult && (
          <div style={{ background: "#fff", border: "1px solid var(--border)", padding: 14, borderRadius: 10, marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
              <strong>AI read {ocrResult.rows.length} attendance entries</strong>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn secondary" onClick={() => setOcrResult(null)}>Discard</button>
                <button className="btn" onClick={importOcrRows}>Import all matched</button>
              </div>
            </div>
            {ocrResult.unmatched.length > 0 && (
              <p style={{ margin: "0 0 8px", color: "#b45309", fontSize: 13 }}>
                ⚠ {ocrResult.unmatched.length} name{ocrResult.unmatched.length === 1 ? "" : "s"} couldn't be matched: <strong>{ocrResult.unmatched.join(", ")}</strong>.
                Correct the spelling on the roster (or sheet) and re-upload. Only matched rows will import.
              </p>
            )}
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--muted)" }}>Preview rows</summary>
              <table className="data" style={{ marginTop: 8, fontSize: 12 }}>
                <thead><tr>
                  <th>Child (OCR)</th><th>Date</th><th>In</th><th>Out</th><th>Status</th><th>Signed in</th><th>Signed out</th><th>Match</th>
                </tr></thead>
                <tbody>
                  {ocrResult.rows.map((r, i) => {
                    const studentList = rows.map((x) => ({ id: x.student_id, name: x.student_name }));
                    const m = matchStudentByName(r.child_name, studentList);
                    return (
                      <tr key={i}>
                        <td>{r.child_name}</td>
                        <td>{r.work_date}</td>
                        <td>{r.in_time || ""}</td>
                        <td>{r.out_time || ""}</td>
                        <td>{r.status || ""}</td>
                        <td>{r.signed_in_by || ""}</td>
                        <td>{r.signed_out_by || ""}</td>
                        <td>{m ? <span style={{ color: "#15803d" }}>✓ {m.name}</span> : <span style={{ color: "#b91c1c" }}>—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
            {ocrResult.rawText && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 13 }}>
                  {ocrResult.rows.length === 0 ? "🔍 What the AI saw (debug)" : "Raw AI response"}
                </summary>
                <pre style={{ marginTop: 8, padding: 10, background: "#f5f5f5", borderRadius: 6, fontSize: 11, maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap" }}>
                  {ocrResult.rawText}
                </pre>
                {ocrResult.rows.length === 0 && (
                  <p style={{ marginTop: 6, fontSize: 12, color: "var(--muted)" }}>
                    If the AI returned an empty array, the photo may be too blurry, cropped, or the names may not be clearly readable.
                    Try retaking with better lighting / closer framing, or use the manual table below.
                  </p>
                )}
              </details>
            )}
          </div>
        )}
      </section>

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
