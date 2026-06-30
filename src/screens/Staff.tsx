import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getSettings } from "../lib/db";
import {
  listStaff, createStaff, updateStaff, archiveStaff,
  listHoursForMonth, upsertHour, deleteHour, matchStaffByName, hoursBetween,
} from "../lib/staff";
import { extractTimesheet, fileToMime, ExtractedRow } from "../lib/gemini";
import { loadXLSX } from "../lib/lazy";
import type { Staff, StaffHour, SettingsMap } from "../types";

type HourRow = StaffHour & { staff_name: string };

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function monthKey(y: number, m: number) { return `${y}-${String(m).padStart(2, "0")}`; }

export default function StaffScreen() {
  const today = new Date();
  const [settings, setSettings] = useState<SettingsMap>({});
  const [staff, setStaff] = useState<Staff[]>([]);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [rows, setRows] = useState<HourRow[]>([]);
  const [editing, setEditing] = useState<Partial<Staff> | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrResult, setOcrResult] = useState<{ rows: ExtractedRow[]; unmatched: string[] } | null>(null);
  const [manualDraft, setManualDraft] = useState<{ staff_id: number | ""; work_date: string; in_time: string; out_time: string }>({
    staff_id: "", work_date: new Date().toISOString().slice(0, 10), in_time: "", out_time: "",
  });
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);

  async function refresh() {
    setStaff(await listStaff(true));
    setRows(await listHoursForMonth(year, month));
    setSettings(await getSettings());
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year, month]);

  const activeStaff = useMemo(() => staff.filter((s) => s.active === 1), [staff]);
  const totals = useMemo(() => {
    const t = new Map<number, { name: string; rate: number | null; hours: number }>();
    for (const s of staff) t.set(s.id, { name: s.name, rate: s.hourly_rate, hours: 0 });
    for (const r of rows) {
      const e = t.get(r.staff_id);
      if (e) e.hours += r.hours_decimal;
    }
    return Array.from(t.entries()).map(([id, v]) => ({ id, ...v, pay: v.rate ? Math.round(v.rate * v.hours * 100) / 100 : null }))
      .filter((x) => x.hours > 0 || activeStaff.some((s) => s.id === x.id));
  }, [staff, rows, activeStaff]);

  const grandHours = totals.reduce((a, b) => a + b.hours, 0);
  const grandPay = totals.reduce((a, b) => a + (b.pay || 0), 0);

  function notify(msg: string, tone: "ok" | "err" = "ok") {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  }

  // ---- Staff CRUD ----
  function newStaff() {
    const defaultRate = parseFloat(settings.staff_default_hourly_rate || "");
    setEditing({ name: "", role: "", hourly_rate: Number.isFinite(defaultRate) ? defaultRate : null, active: 1 });
  }
  async function saveStaff() {
    if (!editing || !editing.name?.trim()) return;
    try {
      if (editing.id) {
        await updateStaff(editing.id, {
          name: editing.name, role: editing.role ?? null,
          hourly_rate: editing.hourly_rate ?? null, active: editing.active ?? 1,
        });
      } else {
        await createStaff(editing.name, editing.role ?? null, editing.hourly_rate ?? null);
      }
      setEditing(null);
      await refresh();
      notify("Saved.");
    } catch (e: any) { notify("Save failed: " + (e?.message || e), "err"); }
  }
  async function archive(id: number) {
    if (!confirm("Archive this staff member? Their past hours are preserved.")) return;
    await archiveStaff(id);
    await refresh();
  }

  // ---- Manual hour entry ----
  async function addManualHour() {
    const { staff_id, work_date, in_time, out_time } = manualDraft;
    if (!staff_id || !work_date) { notify("Pick a staff member and date.", "err"); return; }
    try {
      await upsertHour(Number(staff_id), work_date, in_time || null, out_time || null, "manual");
      setManualDraft({ ...manualDraft, in_time: "", out_time: "" });
      await refresh();
      notify("Hours saved.");
    } catch (e: any) { notify("Save failed: " + (e?.message || e), "err"); }
  }
  async function editHourInline(r: HourRow, patch: Partial<HourRow>) {
    const inT = patch.in_time !== undefined ? patch.in_time : r.in_time;
    const outT = patch.out_time !== undefined ? patch.out_time : r.out_time;
    await upsertHour(r.staff_id, r.work_date, inT || null, outT || null, "manual");
    await refresh();
  }
  async function removeHour(id: number) {
    if (!confirm("Delete this entry?")) return;
    await deleteHour(id);
    await refresh();
  }

  // ---- OCR via Gemini ----
  // Shared core: given an absolute image path, run Gemini extraction and
  // stage the rows for review. Called from both "Choose file…" (file picker)
  // and "Import latest from Downloads" (AirDrop workflow).
  async function runOcrOnPath(picked: string) {
    if (settings.gemini_api_key_set !== "1") {
      notify("Add your Gemini API key in Settings first.", "err"); return;
    }
    setOcrBusy(true);
    setOcrResult(null);
    let apiKey: string | null = null;
    try {
      apiKey = await invoke<string | null>("keychain_get", { key: "gemini_api_key" });
      if (!apiKey) throw new Error("Gemini API key not found in keychain — re-save it in Settings.");
      const bytes = await readFile(picked);
      const mime = fileToMime(picked);
      const result = await extractTimesheet({
        apiKey, imageBytes: bytes, mimeType: mime,
        monthYear: monthKey(year, month),
        knownStaffNames: activeStaff.map((s) => s.name),
      });
      const unmatched = new Set<string>();
      for (const r of result.rows) {
        if (!matchStaffByName(r.staff_name, activeStaff)) unmatched.add(r.staff_name);
      }
      setOcrResult({ rows: result.rows, unmatched: Array.from(unmatched).sort() });
      notify(`Read ${result.rows.length} time entries. Review and import below.`);
    } catch (e: any) {
      const raw = String(e?.message || e);
      const safe = apiKey ? raw.split(apiKey).join("***") : raw;
      notify("OCR failed: " + safe, "err");
    } finally { setOcrBusy(false); }
  }

  async function uploadSheet() {
    if (settings.gemini_api_key_set !== "1") {
      notify("Add your Gemini API key in Settings first.", "err"); return;
    }
    const picked = await open({
      multiple: false,
      filters: [{ name: "Sign-in sheet (image)", extensions: ["jpg", "jpeg", "png", "webp", "heic", "pdf"] }],
    });
    if (!picked || typeof picked !== "string") return;
    await runOcrOnPath(picked);
  }

  // AirDrop / save-from-iPad workflow: pick up images dropped into ~/Downloads
  // within the last 10 minutes. We ALWAYS show a confirmation (even with 1
  // match) so an unrelated recent screenshot can never be silently uploaded.
  async function importLatestFromDownloads() {
    if (settings.gemini_api_key_set !== "1") {
      notify("Add your Gemini API key in Settings first.", "err"); return;
    }
    if (ocrBusy) return;
    try {
      const items = await invoke<Array<{ path: string; name: string; modified_secs_ago: number; size: number }>>(
        "inbox_list_recent",
        { withinMinutes: 10, limit: 5 }
      );
      if (!items.length) {
        notify("No image files found in Downloads from the last 10 minutes. AirDrop from iPad and try again.", "err");
        return;
      }

      let picked = items[0];
      const fmtMin = (secs: number) => Math.max(1, Math.round(secs / 60));
      const fmtMb = (b: number) => (b / (1024 * 1024)).toFixed(1);

      if (items.length === 1) {
        const ok = window.confirm(
          `Import "${picked.name}" (${fmtMin(picked.modified_secs_ago)} min ago, ${fmtMb(picked.size)} MB) for OCR?`
        );
        if (!ok) return;
      } else {
        const list = items
          .map((it, i) => `${i + 1}. ${it.name}  (${fmtMin(it.modified_secs_ago)} min ago, ${fmtMb(it.size)} MB)`)
          .join("\n");
        const ans = window.prompt(
          `Multiple recent images in Downloads:\n\n${list}\n\nWhich number to import?`,
          "1"
        );
        if (ans === null) return;
        const n = Number(ans.trim());
        if (!Number.isInteger(n) || n < 1 || n > items.length) {
          notify(`Enter a number from 1 to ${items.length}.`, "err");
          return;
        }
        picked = items[n - 1];
      }

      notify(`Reading ${picked.name}…`);
      await runOcrOnPath(picked.path);
    } catch (e: any) {
      notify("Couldn't read Downloads: " + (e?.message || e), "err");
    }
  }

  async function importOcr() {
    if (!ocrResult) return;
    let saved = 0, skipped = 0;
    for (const r of ocrResult.rows) {
      const match = matchStaffByName(r.staff_name, activeStaff);
      if (!match) { skipped++; continue; }
      try {
        await upsertHour(match.id, r.work_date, r.in_time, r.out_time, "ocr");
        saved++;
      } catch { skipped++; }
    }
    setOcrResult(null);
    await refresh();
    notify(`Imported ${saved} entries${skipped ? ` (${skipped} skipped — unmatched staff)` : ""}.`);
  }

  // ---- Excel export ----
  async function exportExcel() {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    // Detail sheet
    const detail = rows.map((r) => ({
      Date: r.work_date,
      Staff: r.staff_name,
      In: r.in_time || "",
      Out: r.out_time || "",
      Hours: r.hours_decimal,
      Source: r.source,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), "Detail");
    // Summary sheet
    const summary = totals.map((t) => ({
      Staff: t.name,
      "Hourly rate": t.rate ?? "",
      "Total hours": Math.round(t.hours * 100) / 100,
      "Total pay": t.pay ?? "",
    }));
    summary.push({ Staff: "TOTAL", "Hourly rate": "", "Total hours": Math.round(grandHours * 100) / 100, "Total pay": Math.round(grandPay * 100) / 100 } as any);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Summary");
    const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    const dest = await saveDialog({
      defaultPath: `staff-hours-${monthKey(year, month)}.xlsx`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!dest) return;
    await writeFile(dest, new Uint8Array(ab));
    notify("Excel saved.");
  }

  // ---- Render ----
  const rowsByStaff = useMemo(() => {
    const m = new Map<number, HourRow[]>();
    for (const r of rows) {
      const arr = m.get(r.staff_id) || [];
      arr.push(r); m.set(r.staff_id, arr);
    }
    return m;
  }, [rows]);

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>Staff Hours</h1>
          <p className="subtitle">Upload a monthly sign-in sheet or enter hours by hand. Export to Excel for payroll.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", background: "#fff", border: "1px solid var(--border)", borderRadius: 10, padding: "6px 8px" }}>
          <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", marginRight: 4 }}>Month</label>
          <select value={month} onChange={(e) => setMonth(parseInt(e.target.value))} style={{ minWidth: 120 }}>
            {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(parseInt(e.target.value))} style={{ width: 90 }}>
            {Array.from({ length: 7 }, (_, i) => today.getFullYear() - 3 + i).map((y) =>
              <option key={y} value={y}>{y}</option>
            )}
          </select>
          <button className="btn" onClick={exportExcel} disabled={rows.length === 0} style={{ marginLeft: 6 }}>⬇ Export Excel</button>
        </div>
      </div>

      {/* Upload CTA — primary action */}
      <section className="card" style={{ marginBottom: 16, background: "linear-gradient(180deg, #eff6ff 0%, #ffffff 65%)", borderColor: "#bfdbfe" }}>
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ width: 56, height: 56, borderRadius: 12, background: "#dbeafe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0 }}>📷</div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ margin: "0 0 4px" }}>Upload {MONTHS[month - 1]} sign-in sheet</h3>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
              Snap a clear photo or scan of the monthly sheet. Gemini extracts in/out times for each teacher; you review and import.
            </p>
            {activeStaff.length === 0 && (
              <p style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: 13 }}>Add at least one staff member below before uploading.</p>
            )}
            {settings.gemini_api_key_set !== "1" && activeStaff.length > 0 && (
              <p style={{ margin: "6px 0 0", color: "#b45309", fontSize: 13 }}>⚠ Add your Gemini API key in <strong>Settings → Optional features</strong> first.</p>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button className="btn big" onClick={uploadSheet} disabled={ocrBusy || activeStaff.length === 0 || settings.gemini_api_key_set !== "1"}>
              {ocrBusy ? "Reading sheet…" : "Choose file…"}
            </button>
            <button className="btn secondary" onClick={importLatestFromDownloads} disabled={ocrBusy || activeStaff.length === 0 || settings.gemini_api_key_set !== "1"} title="Picks the newest image AirDropped or saved to ~/Downloads in the last 30 min">
              📥 Import latest from Downloads
            </button>
          </div>
        </div>

        {ocrResult && (
          <div style={{ background: "#fff", border: "1px solid var(--border)", padding: 14, borderRadius: 10, marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
              <strong>AI read {ocrResult.rows.length} time entries</strong>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn secondary" onClick={() => setOcrResult(null)}>Discard</button>
                <button className="btn" onClick={importOcr}>Import all matched</button>
              </div>
            </div>
            {ocrResult.unmatched.length > 0 && (
              <p style={{ margin: "0 0 8px", color: "#b45309", fontSize: 13 }}>
                ⚠ {ocrResult.unmatched.length} name{ocrResult.unmatched.length === 1 ? "" : "s"} couldn't be matched: <strong>{ocrResult.unmatched.join(", ")}</strong>.
                Add them under <em>Staff</em> below (or correct the spelling) and re-upload. Only matched rows will import.
              </p>
            )}
            <details>
              <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 13 }}>Preview {ocrResult.rows.length} extracted rows</summary>
              <table className="table" style={{ marginTop: 10 }}>
                <thead><tr><th>From sheet</th><th>Matched to</th><th>Date</th><th>In</th><th>Out</th><th>Hours</th></tr></thead>
                <tbody>
                  {ocrResult.rows.map((r, i) => {
                    const m = matchStaffByName(r.staff_name, activeStaff);
                    return (
                      <tr key={i} style={!m ? { opacity: 0.55 } : undefined}>
                        <td>{r.staff_name}</td>
                        <td>{m ? m.name : <em>(no match)</em>}</td>
                        <td>{r.work_date}</td>
                        <td>{r.in_time || "—"}</td>
                        <td>{r.out_time || "—"}</td>
                        <td>{hoursBetween(r.in_time, r.out_time).toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </section>

      {/* Two-col: staff list + quick manual entry */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", gap: 16, marginBottom: 16 }}>
        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Staff <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>({activeStaff.length} active)</span></h3>
            <button className="btn secondary" onClick={newStaff}>+ Add staff</button>
          </div>
          {staff.length === 0 ? (
            <p style={{ color: "var(--muted)", margin: "10px 0 0" }}>No staff yet — click <strong>+ Add staff</strong> to add your first teacher.</p>
          ) : (
            <table className="table">
              <thead><tr><th>Name</th><th>Role</th><th>Rate</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 500 }}>{s.name}</td>
                    <td style={{ color: "var(--muted)" }}>{s.role || "—"}</td>
                    <td>{s.hourly_rate != null ? `$${s.hourly_rate.toFixed(2)}` : "—"}</td>
                    <td>{s.active ? <span className="pill">Active</span> : <span className="pill muted">Archived</span>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn link" onClick={() => setEditing(s)}>Edit</button>
                      {s.active === 1 && <button className="btn link danger" onClick={() => archive(s.id)}>Archive</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h3 style={{ margin: "0 0 12px" }}>Quick add hours</h3>
          <p style={{ color: "var(--muted)", margin: "0 0 14px", fontSize: 13 }}>
            For a single day — handy for new joiners or rows the AI missed.
          </p>
          <div className="field">
            <label>Staff</label>
            <select value={manualDraft.staff_id} onChange={(e) => setManualDraft({ ...manualDraft, staff_id: e.target.value ? Number(e.target.value) : "" })}>
              <option value="">— pick —</option>
              {activeStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="row">
            <div className="field">
              <label>Date</label>
              <input type="date" value={manualDraft.work_date} onChange={(e) => setManualDraft({ ...manualDraft, work_date: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Hours preview</label>
              <input value={hoursBetween(manualDraft.in_time, manualDraft.out_time).toFixed(2)} readOnly style={{ background: "#f8fafc" }} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>In</label>
              <input type="time" value={manualDraft.in_time} onChange={(e) => setManualDraft({ ...manualDraft, in_time: e.target.value })} />
            </div>
            <div className="field">
              <label>Out</label>
              <input type="time" value={manualDraft.out_time} onChange={(e) => setManualDraft({ ...manualDraft, out_time: e.target.value })} />
            </div>
          </div>
          <button className="btn" onClick={addManualHour} disabled={!manualDraft.staff_id} style={{ width: "100%" }}>Add to {MONTHS[month - 1]} {year}</button>
        </section>
      </div>

      {/* Entries */}
      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>{MONTHS[month - 1]} {year} entries</h3>
          {rows.length > 0 && (
            <div style={{ fontSize: 14 }}>
              <span style={{ color: "var(--muted)" }}>Month total: </span>
              <strong>{grandHours.toFixed(2)} hrs{grandPay ? ` · $${grandPay.toFixed(2)}` : ""}</strong>
            </div>
          )}
        </div>
        {rows.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 10px", color: "var(--muted)" }}>
            <div style={{ fontSize: 32, marginBottom: 6 }}>🗓</div>
            <p style={{ margin: 0 }}>No hours recorded for {MONTHS[month - 1]} {year} yet.</p>
            <p style={{ margin: "4px 0 0", fontSize: 13 }}>Upload a sign-in sheet above, or use <em>Quick add hours</em>.</p>
          </div>
        ) : (
          activeStaff.concat(staff.filter((s) => !s.active && rowsByStaff.has(s.id))).map((s) => {
            const list = rowsByStaff.get(s.id) || [];
            if (list.length === 0) return null;
            const total = list.reduce((a, b) => a + b.hours_decimal, 0);
            return (
              <div key={s.id} style={{ marginBottom: 20, padding: 14, background: "#fafbff", borderRadius: 10, border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                  <h4 style={{ margin: 0, fontSize: 15 }}>{s.name} <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>· {list.length} day{list.length === 1 ? "" : "s"}</span></h4>
                  <strong>{total.toFixed(2)} hrs{s.hourly_rate ? ` · $${(s.hourly_rate * total).toFixed(2)}` : ""}</strong>
                </div>
                <table className="table">
                  <thead><tr><th style={{ width: 110 }}>Date</th><th style={{ width: 110 }}>In</th><th style={{ width: 110 }}>Out</th><th>Hours</th><th>Source</th><th></th></tr></thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={r.id}>
                        <td>{r.work_date}</td>
                        <td><input type="time" defaultValue={r.in_time || ""} onBlur={(e) => editHourInline(r, { in_time: e.target.value })} /></td>
                        <td><input type="time" defaultValue={r.out_time || ""} onBlur={(e) => editHourInline(r, { out_time: e.target.value })} /></td>
                        <td><strong>{r.hours_decimal.toFixed(2)}</strong></td>
                        <td><span className="pill muted">{r.source === "ocr" ? "AI" : "manual"}</span></td>
                        <td style={{ textAlign: "right" }}><button className="btn link danger" onClick={() => removeHour(r.id)}>Delete</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })
        )}
      </section>

      {/* Edit modal */}
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0, marginBottom: 14 }}>{editing.id ? "Edit staff" : "Add staff"}</h2>
            <div className="field">
              <label>Name</label>
              <input value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
            </div>
            <div className="field">
              <label>Role (optional)</label>
              <input value={editing.role || ""} onChange={(e) => setEditing({ ...editing, role: e.target.value })} placeholder="e.g. Lead ECE, Assistant" />
            </div>
            <div className="field">
              <label>Hourly rate (optional)</label>
              <input
                type="number" step="0.01"
                value={editing.hourly_rate ?? ""}
                onChange={(e) => setEditing({ ...editing, hourly_rate: e.target.value === "" ? null : parseFloat(e.target.value) })}
                placeholder="e.g. 28.50"
              />
            </div>
            {editing.id != null && (
              <div className="field">
                <label style={{ display: "flex", alignItems: "center", gap: 6, textTransform: "none", letterSpacing: 0, fontSize: 14, color: "var(--text)", fontWeight: 400 }}>
                  <input type="checkbox" checked={(editing.active ?? 1) === 1} onChange={(e) => setEditing({ ...editing, active: e.target.checked ? 1 : 0 })} /> Active
                </label>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn" onClick={saveStaff} disabled={!editing.name?.trim()}>Save</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.tone === "err" ? "toast-err" : "toast-ok"}`}>{toast.msg}</div>}
    </div>
  );
}
