import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getSettings } from "../lib/db";
import {
  listStaff, createStaff, updateStaff, archiveStaff,
  listHoursForMonth, upsertHour, deleteHour, matchStaffByName, hoursBetween, paidHours,
  assertStaffHoursSchema,
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
  const [ocrResult, setOcrResult] = useState<{
    rows: ExtractedRow[];
    unmatched: string[];
    rawText?: string;
    qrNote?: string;
    qrMonth?: string;     // "YYYY-MM" when decoded from sheet
    monthMismatch?: boolean;  // true if QR month differs from UI-selected month
    flags: Array<{ index: number; reason: string }>;  // hour-validation flags
  } | null>(null);
  const [manualDraft, setManualDraft] = useState<{ staff_id: number | ""; work_date: string; in_time: string; out_time: string }>({
    staff_id: "", work_date: new Date().toISOString().slice(0, 10), in_time: "", out_time: "",
  });
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);
  // Per-employee collapse state on the entries card. Uses staff.id. Persists
  // for the life of the screen mount; refresh() does not reset it.
  const [collapsedStaff, setCollapsedStaff] = useState<Set<number>>(new Set());
  function toggleCollapsed(staffId: number) {
    setCollapsedStaff((prev) => {
      const next = new Set(prev);
      if (next.has(staffId)) next.delete(staffId); else next.add(staffId);
      return next;
    });
  }

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
  // Bulk-delete every entry we have for one staff member in the currently-
  // viewed month. Used by the "Delete all" button per employee — handy after
  // a bad OCR import ("21 entries stamped July but sheet was June").
  async function removeAllForStaff(staffId: number, staffName: string, count: number) {
    if (count === 0) return;
    const label = `${MONTHS[month - 1]} ${year}`;
    if (!confirm(`Delete ALL ${count} entries for ${staffName} in ${label}?\n\nThis cannot be undone.`)) return;
    const ids = rows.filter((r) => r.staff_id === staffId).map((r) => r.id);
    let failed = 0;
    for (const id of ids) {
      try { await deleteHour(id); } catch { failed++; }
    }
    await refresh();
    if (failed === 0) notify(`Deleted ${ids.length} entries for ${staffName}.`);
    else notify(`Deleted ${ids.length - failed}/${ids.length}; ${failed} failed.`, "err");
  }

  // ---- OCR via Gemini ----
  // Shared core: given an absolute image path, run Gemini extraction and
  // stage the rows for review. Called from both "Choose file…" (file picker)
  // and "Import latest from Downloads" (AirDrop workflow).
  async function runOcrOnPath(picked: string) {
    if (settings.gemini_api_key_set !== "1") {
      notify("Add your Gemini API key in Settings first.", "err"); return;
    }

    // Guard: refuse to run OCR if the local DB schema can't hold the result.
    // Cheap to check, and it stops the classic "AI reads 21 rows, 0 imported,
    // 21 'unmatched'" foot-gun where the real cause is a missing DB column.
    const schemaError = await assertStaffHoursSchema();
    if (schemaError) {
      notify(`Schema check failed — import will fail. ${schemaError}`, "err");
      return;
    }

    setOcrBusy(true);
    setOcrResult(null);
    let apiKey: string | null = null;
    try {
      apiKey = await invoke<string | null>("keychain_get", { key: "gemini_api_key" });
      if (!apiKey) throw new Error("Gemini API key not found in keychain — re-save it in Settings.");

      // 1) Try to decode the sheet's QR to lock the month/year to the paper
      //    (defeats "UI picker says July, sheet says June" bugs). This is the
      //    fast path; if the QR is missing or unreadable, Gemini itself will
      //    read the month off the sheet's printed header in step (3).
      let qrMonthKey: string | undefined;
      let qrNote: string | undefined;
      let effectiveYear = year;
      let effectiveMonth = month;
      try {
        const norm = await invoke<{ qr: { year: number | null; month: number | null; sheet_id: string | null }; note: string }>(
          "normalize_sheet",
          { args: { image_path: picked } }
        );
        qrNote = norm.note;
        if (norm.qr.year && norm.qr.month) {
          effectiveYear = norm.qr.year;
          effectiveMonth = norm.qr.month;
          qrMonthKey = monthKey(effectiveYear, effectiveMonth);
        }
      } catch (e) {
        qrNote = "QR pre-check failed: " + String((e as any)?.message || e);
      }

      const bytes = await readFile(picked);
      const mime = fileToMime(picked);
      const result = await extractTimesheet({
        apiKey, imageBytes: bytes, mimeType: mime,
        monthYear: qrMonthKey || monthKey(year, month),  // HINT only — Gemini also reads the header
        knownStaffNames: activeStaff.map((s) => s.name),
      });

      // 2) Trust the sheet, not the UI. If Gemini read a month off the sheet's
      //    header/QR, prefer THAT over the UI picker and re-stamp every row's
      //    YYYY-MM to match. This is what fixes "June sheet uploaded with
      //    picker on July → all rows dated July".
      const uiMonthKey = monthKey(year, month);
      const sheetMonthKey = qrMonthKey || result.detected_month_year || undefined;
      if (sheetMonthKey && /^\d{4}-\d{2}$/.test(sheetMonthKey)) {
        for (const r of result.rows) {
          if (r.work_date && r.work_date.length >= 10) {
            const dd = r.work_date.slice(8, 10);
            r.work_date = `${sheetMonthKey}-${dd}`;
          }
        }
      }

      const unmatched = new Set<string>();
      for (const r of result.rows) {
        if (!matchStaffByName(r.staff_name, activeStaff)) unmatched.add(r.staff_name);
      }

      // 3) Hour validation: flag rows with paid-hours < 2 or > 10 so they
      //    can be surfaced in a banner (and skipped from auto-import).
      const flags: Array<{ index: number; reason: string }> = [];
      result.rows.forEach((r, i) => {
        if (!r.in_time || !r.out_time) return;   // partial rows aren't flagged
        const paid = paidHours(r.in_time, r.out_time, r.no_lunch === true);
        if (paid < 2) flags.push({ index: i, reason: `Shift too short (${paid.toFixed(2)}h)` });
        else if (paid > 10) flags.push({ index: i, reason: `Shift too long (${paid.toFixed(2)}h)` });
      });

      setOcrResult({
        rows: result.rows,
        unmatched: Array.from(unmatched).sort(),
        rawText: result.raw_text,
        qrNote,
        qrMonth: sheetMonthKey,
        monthMismatch: !!sheetMonthKey && sheetMonthKey !== uiMonthKey,
        flags,
      });
      if (result.rows.length === 0) {
        notify("AI returned 0 rows — see 'What the AI saw' below to debug.", "err");
      } else if (flags.length) {
        notify(`Read ${result.rows.length} entries; ${flags.length} need attention.`, "err");
      } else {
        notify(`Read ${result.rows.length} time entries. Ready to import.`);
      }
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
    // Re-check schema right before writing. Cheap; guarantees we never hit
    // the silent-catch trap even if the OCR guard was somehow bypassed.
    const schemaError = await assertStaffHoursSchema();
    if (schemaError) {
      notify(`Cannot import — ${schemaError}`, "err");
      return;
    }
    const flaggedIdx = new Set(ocrResult.flags.map((f) => f.index));
    let saved = 0, unmatched = 0, dbErrors = 0, flaggedSkipped = 0;
    let lastError: unknown = null;
    for (let i = 0; i < ocrResult.rows.length; i++) {
      const r = ocrResult.rows[i];
      if (flaggedIdx.has(i)) { flaggedSkipped++; continue; }
      const match = matchStaffByName(r.staff_name, activeStaff);
      if (!match) { unmatched++; continue; }
      try {
        await upsertHour(match.id, r.work_date, r.in_time, r.out_time, "ocr", null, null, r.no_lunch === true);
        saved++;
      } catch (e) {
        dbErrors++;
        lastError = e;
        console.error(`[importOcr] upsertHour failed for ${r.staff_name} @ ${r.work_date}:`, e);
      }
    }
    setOcrResult(null);
    await refresh();
    const bits: string[] = [`Imported ${saved} entries`];
    if (unmatched) bits.push(`${unmatched} unmatched`);
    if (dbErrors) bits.push(`${dbErrors} DB errors (see console)`);
    if (flaggedSkipped) bits.push(`${flaggedSkipped} flagged (fix and re-import)`);
    notify(bits.join(" · "), dbErrors ? "err" : "ok");
    if (dbErrors && lastError) {
      notify(`First DB error: ${String((lastError as Error)?.message ?? lastError).slice(0, 240)}`, "err");
    }
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
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}>
            <button
              onClick={importLatestFromDownloads}
              disabled={ocrBusy || activeStaff.length === 0 || settings.gemini_api_key_set !== "1"}
              title="Picks the newest image AirDropped or saved to ~/Downloads in the last 10 min"
              style={{
                position: "relative",
                padding: "16px 22px",
                fontSize: 16,
                fontWeight: 700,
                background: "linear-gradient(180deg, #16a34a 0%, #15803d 100%)",
                color: "white",
                border: "none",
                borderRadius: 12,
                cursor: ocrBusy ? "not-allowed" : "pointer",
                boxShadow: "0 4px 14px rgba(22, 163, 74, 0.35)",
                opacity: (ocrBusy || activeStaff.length === 0 || settings.gemini_api_key_set !== "1") ? 0.55 : 1,
                minWidth: 260,
              }}
            >
              <span style={{
                position: "absolute", top: -8, right: -8,
                background: "#f59e0b", color: "white", fontSize: 10,
                padding: "2px 7px", borderRadius: 10, fontWeight: 800, letterSpacing: 0.5,
              }}>NEW</span>
              <div style={{ fontSize: 22, marginBottom: 2 }}>📥 Import from Downloads</div>
              <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.9 }}>
                AirDrop from iPad → click here
              </div>
            </button>
            <button
              className="btn secondary"
              onClick={uploadSheet}
              disabled={ocrBusy || activeStaff.length === 0 || settings.gemini_api_key_set !== "1"}
              style={{ fontSize: 13 }}
            >
              {ocrBusy ? "Reading sheet…" : "…or choose file manually"}
            </button>
          </div>
        </div>

        {ocrResult && (
          <div style={{ background: "#fff", border: "1px solid var(--border)", padding: 14, borderRadius: 10, marginTop: 14 }}>
            {/* Month-source banner. qrMonth now holds whichever the app
                trusted: QR (fast path) or Gemini's header-read (fallback). */}
            {ocrResult.qrMonth && (
              <div style={{
                background: ocrResult.monthMismatch ? "#fef3c7" : "#dcfce7",
                border: `1px solid ${ocrResult.monthMismatch ? "#f59e0b" : "#22c55e"}`,
                padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 13,
              }}>
                <strong>📷 Sheet month:</strong> {ocrResult.qrMonth} (read from the sheet itself)
                {ocrResult.monthMismatch && <> — <strong>differs from the {MONTHS[month - 1]} {year} you had selected.</strong> Trusting the sheet.</>}
              </div>
            )}
            {ocrResult.qrMonth === undefined && (
              <div style={{ background: "#fef3c7", border: "1px solid #f59e0b", padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
                ⚠ Could not read the sheet's month from either the QR code or the header. Rows will be imported as <strong>{monthKey(year, month)}</strong> (the picker's month). If that's wrong, discard, fix the header month, and re-upload.
              </div>
            )}

            {/* Hour-validation flag banner */}
            {ocrResult.flags.length > 0 && (
              <div style={{
                background: "#fef2f2", border: "1px solid #ef4444",
                padding: 10, borderRadius: 6, marginBottom: 10, fontSize: 13,
              }}>
                <strong>⚠ {ocrResult.flags.length} row{ocrResult.flags.length === 1 ? "" : "s"} flagged</strong> (won't be imported until fixed):
                <ul style={{ margin: "6px 0 0 20px", padding: 0 }}>
                  {ocrResult.flags.slice(0, 8).map((f) => {
                    const r = ocrResult.rows[f.index];
                    return <li key={f.index}>{r.staff_name} on {r.work_date} · {f.reason} ({r.in_time || "?"}–{r.out_time || "?"}{r.no_lunch ? ", no lunch" : ""})</li>;
                  })}
                  {ocrResult.flags.length > 8 && <li>…and {ocrResult.flags.length - 8} more</li>}
                </ul>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
              <strong>AI read {ocrResult.rows.length} time entries</strong>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn secondary" onClick={() => setOcrResult(null)}>Discard</button>
                <button
                  className="btn"
                  onClick={importOcr}
                  style={{ fontWeight: 700 }}
                  title="Import all clean rows without reviewing (flagged rows are skipped)"
                >
                  ✓ Import all ({ocrResult.rows.length - ocrResult.flags.length} clean)
                </button>
              </div>
            </div>
            {ocrResult.unmatched.length > 0 && (
              <p style={{ margin: "0 0 8px", color: "#b45309", fontSize: 13 }}>
                ⚠ {ocrResult.unmatched.length} name{ocrResult.unmatched.length === 1 ? "" : "s"} couldn't be matched: <strong>{ocrResult.unmatched.join(", ")}</strong>.
                Add them under <em>Staff</em> below (or correct the spelling) and re-upload. Only matched rows will import.
              </p>
            )}
            <details>
              <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 13 }}>Preview {ocrResult.rows.length} extracted rows (optional review)</summary>
              <table className="table" style={{ marginTop: 10 }}>
                <thead><tr><th>From sheet</th><th>Matched to</th><th>Date</th><th>In</th><th>Out</th><th>No Ln</th><th>Paid hrs</th><th>Status</th></tr></thead>
                <tbody>
                  {ocrResult.rows.map((r, i) => {
                    const m = matchStaffByName(r.staff_name, activeStaff);
                    const flag = ocrResult.flags.find((f) => f.index === i);
                    const raw = hoursBetween(r.in_time, r.out_time);
                    const paid = paidHours(r.in_time, r.out_time, r.no_lunch === true);
                    return (
                      <tr key={i} style={
                        flag ? { background: "#fef2f2" } :
                        !m ? { opacity: 0.55 } : undefined
                      }>
                        <td>{r.staff_name}</td>
                        <td>{m ? m.name : <em>(no match)</em>}</td>
                        <td>{r.work_date}</td>
                        <td>{r.in_time || "—"}</td>
                        <td>{r.out_time || "—"}</td>
                        <td style={{ textAlign: "center" }}>{r.no_lunch ? "✓" : ""}</td>
                        <td title={`raw ${raw.toFixed(2)}h${r.no_lunch ? "" : " − 0.5h lunch"}`}>{paid.toFixed(2)}</td>
                        <td style={{ fontSize: 12 }}>
                          {flag ? <span style={{ color: "#dc2626", fontWeight: 600 }}>⚠ {flag.reason}</span> :
                           !m ? <span style={{ color: "#b45309" }}>skip: no match</span> :
                           <span style={{ color: "#16a34a" }}>✓ ready</span>}
                        </td>
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
                    Try retaking with better lighting / closer framing, or enter the hours manually below.
                  </p>
                )}
              </details>
            )}
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
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            {rows.length > 0 && (() => {
              const staffWithRows = activeStaff.concat(staff.filter((s) => !s.active && rowsByStaff.has(s.id)))
                .filter((s) => (rowsByStaff.get(s.id) || []).length > 0);
              const allCollapsed = staffWithRows.length > 0 && staffWithRows.every((s) => collapsedStaff.has(s.id));
              return (
                <button
                  className="btn link"
                  onClick={() => setCollapsedStaff(allCollapsed ? new Set() : new Set(staffWithRows.map((s) => s.id)))}
                  style={{ fontSize: 12 }}
                >
                  {allCollapsed ? "▸ Expand all" : "▾ Collapse all"}
                </button>
              );
            })()}
            {rows.length > 0 && (
              <div style={{ fontSize: 14 }}>
                <span style={{ color: "var(--muted)" }}>Month total: </span>
                <strong>{grandHours.toFixed(2)} hrs{grandPay ? ` · $${grandPay.toFixed(2)}` : ""}</strong>
              </div>
            )}
          </div>
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
            const isCollapsed = collapsedStaff.has(s.id);
            return (
              <div key={s.id} style={{ marginBottom: 12, padding: 14, background: "#fafbff", borderRadius: 10, border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <button
                    onClick={() => toggleCollapsed(s.id)}
                    title={isCollapsed ? "Expand" : "Collapse"}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      background: "transparent", border: "none", padding: 0, cursor: "pointer",
                      textAlign: "left", flex: "1 1 auto", minWidth: 0,
                    }}
                  >
                    <span style={{ fontSize: 20, lineHeight: 1, color: "var(--muted)", width: 20, display: "inline-block", textAlign: "center" }}>{isCollapsed ? "▸" : "▾"}</span>
                    <h4 style={{ margin: 0, fontSize: 15 }}>{s.name} <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>· {list.length} day{list.length === 1 ? "" : "s"}</span></h4>
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <strong>{total.toFixed(2)} hrs{s.hourly_rate ? ` · $${(s.hourly_rate * total).toFixed(2)}` : ""}</strong>
                    <button
                      className="btn link danger"
                      onClick={() => removeAllForStaff(s.id, s.name, list.length)}
                      title={`Delete all ${list.length} entries for ${s.name} in ${MONTHS[month - 1]} ${year}`}
                      style={{ fontSize: 12 }}
                    >
                      Delete all
                    </button>
                  </div>
                </div>
                {!isCollapsed && (
                  <table className="table" style={{ marginTop: 8 }}>
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
                )}
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
