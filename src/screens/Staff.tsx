import { showConfirm, showPrompt } from "../lib/dialogs";
import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getSettings, setSetting } from "../lib/db";
import {
  listStaff, createStaff, updateStaff, archiveStaff,
  listHoursForMonth, upsertHour, deleteHour, hoursBetween, paidHours,
  assertStaffHoursSchema, countHoursForStaffMonth, deleteHoursForStaffMonth,
} from "../lib/staff";
import { fileToMime } from "../lib/ai";
import {
  extractTimesheetConsensus, computeConsensus, editCell, PROVIDER_LABELS,
  type ConsensusAlignment, type ConsensusRow, type Confidence, type ProviderName,
} from "../lib/ocr";
import { loadXLSX } from "../lib/lazy";
import type { Staff, StaffHour, SettingsMap } from "../types";

type HourRow = StaffHour & { staff_name: string };

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function monthKey(y: number, m: number) { return `${y}-${String(m).padStart(2, "0")}`; }

function rankConf(c: Confidence): number { return c === "red" ? 2 : c === "yellow" ? 1 : 0; }
function isEditedRow(r: ConsensusRow): boolean {
  return r.in_time.edited || r.out_time.edited || r.no_lunch.edited;
}
function pillFor(c: Confidence): { bg: string; fg: string; border: string; label: string } {
  if (c === "green")  return { bg: "#dcfce7", fg: "#166534", border: "#22c55e", label: "✓" };
  if (c === "yellow") return { bg: "#fef3c7", fg: "#92400e", border: "#f59e0b", label: "≈" };
  return { bg: "#fee2e2", fg: "#991b1b", border: "#ef4444", label: "✗" };
}

export default function StaffScreen() {
  const today = new Date();
  const [settings, setSettings] = useState<SettingsMap>({});
  const [staff, setStaff] = useState<Staff[]>([]);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [rows, setRows] = useState<HourRow[]>([]);
  const [editing, setEditing] = useState<Partial<Staff> | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  // Consensus mode: main OCR path. Contains per-provider votes + per-cell badges.
  const [consensus, setConsensus] = useState<{
    align: ConsensusAlignment;
    providerMeta: Array<{ provider: ProviderName; ok: boolean; error: string | null; latency_ms: number; rowCount: number; rawText: string }>;
    qrMonth?: string;
    monthMismatch?: boolean;
    qrNote?: string;
    flags: Map<string, string>;   // key = row.key, value = reason (hour validation)
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
    if (!await showConfirm("Archive this staff member? Their past hours are preserved.")) return;
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
    // Preserve the existing no_lunch flag (OCR often sets this from the sheet;
    // dropping it silently under-counts payroll by 0.5 h per shift).
    const noLunch = !!r.no_lunch;
    await upsertHour(r.staff_id, r.work_date, inT || null, outT || null, "manual", null, r.notes ?? null, noLunch);
    await refresh();
  }
  async function removeHour(id: number) {
    if (!await showConfirm("Delete this entry?")) return;
    await deleteHour(id);
    await refresh();
  }
  // Bulk-delete every entry we have for one staff member in the currently-
  // viewed month. Used by the "Delete all" button per employee — handy after
  // a bad OCR import ("21 entries stamped July but sheet was June").
  async function removeAllForStaff(staffId: number, staffName: string, count: number) {
    if (count === 0) return;
    const label = `${MONTHS[month - 1]} ${year}`;
    if (!await showConfirm(`Delete ALL ${count} entries for ${staffName} in ${label}?\n\nThis cannot be undone.`)) return;
    const ids = rows.filter((r) => r.staff_id === staffId).map((r) => r.id);
    let failed = 0;
    for (const id of ids) {
      try { await deleteHour(id); } catch { failed++; }
    }
    await refresh();
    if (failed === 0) notify(`Deleted ${ids.length} entries for ${staffName}.`);
    else notify(`Deleted ${ids.length - failed}/${ids.length}; ${failed} failed.`, "err");
  }

  // ---- OCR via multi-model consensus ----
  // Shared core: given an absolute image path, run Mistral Document AI +
  // Mistral OCR (digit witness) in parallel and compute per-cell agreement.
  // Called from both "Choose file…" and "Import latest from Downloads".
  async function runOcrOnPath(picked: string) {
    if (settings.azure_ai_key_set !== "1") {
      notify("Add your Azure AI Foundry key in Settings first.", "err"); return;
    }
    const schemaError = await assertStaffHoursSchema();
    if (schemaError) {
      notify(`Schema check failed — import will fail. ${schemaError}`, "err");
      return;
    }

    setOcrBusy(true);
    setConsensus(null);
    let azureKey: string | null = null;
    try {
      azureKey = await invoke<string | null>("keychain_get", { key: "azure_ai_key" });
      if (!azureKey) throw new Error("Azure AI Foundry key not found in keychain — re-save it in Settings.");

      // QR month lock — same fast path as before.
      let qrMonthKey: string | undefined;
      let qrNote: string | undefined;
      try {
        const norm = await invoke<{ qr: { year: number | null; month: number | null; sheet_id: string | null }; note: string }>(
          "normalize_sheet", { args: { image_path: picked } }
        );
        qrNote = norm.note;
        if (norm.qr.year && norm.qr.month) {
          qrMonthKey = monthKey(norm.qr.year, norm.qr.month);
        }
      } catch (e) {
        qrNote = "QR pre-check failed: " + String((e as any)?.message || e);
      }

      const bytes = await readFile(picked);
      const mime = fileToMime(picked);
      const result = await extractTimesheetConsensus({
        azureKey,
        imageBytes: bytes, mimeType: mime,
        monthYear: qrMonthKey || monthKey(year, month),
        knownStaffNames: activeStaff.map((s) => s.name),
        enableMistralOcr: settings.enable_mistral_ocr !== "0",
        enableAzureDi: settings.enable_azure_di !== "0",
      });

      const align = computeConsensus(result, activeStaff, qrMonthKey || null);
      const uiMonthKey = monthKey(year, month);
      const sheetMonthKey = qrMonthKey || align.detectedMonthYear || undefined;

      // Hour validation on the consensus-picked values.
      const flags = new Map<string, string>();
      for (const r of align.rows) {
        const inV = r.in_time.value;
        const outV = r.out_time.value;
        if (!inV || !outV) continue;
        const paid = paidHours(inV, outV, r.no_lunch.value === "true");
        if (paid < 2) flags.set(r.key, `Shift too short (${paid.toFixed(2)}h)`);
        else if (paid > 10) flags.set(r.key, `Shift too long (${paid.toFixed(2)}h)`);
      }

      const providerMeta = result.providers.map((p) => ({
        provider: p.provider as ProviderName,
        ok: p.ok,
        error: p.error,
        latency_ms: p.latency_ms,
        rowCount: p.rows.length,
        rawText: p.raw_text,
      }));

      setConsensus({
        align,
        providerMeta,
        qrMonth: sheetMonthKey,
        monthMismatch: !!sheetMonthKey && sheetMonthKey !== uiMonthKey,
        qrNote,
        flags,
      });

      if (align.rows.length === 0) {
        notify("All models returned 0 rows — see 'What each model saw' below to debug.", "err");
      } else {
        const nSuccess = align.succeededProviders.length;
        const red = align.rows.filter((r) => r.row_confidence === "red").length;
        const yellow = align.rows.filter((r) => r.row_confidence === "yellow").length;
        const green = align.rows.filter((r) => r.row_confidence === "green").length;
        const flagged = flags.size;
        const msg = `${nSuccess}/3 models: ${green} agree, ${yellow} majority, ${red} disagree${flagged ? `, ${flagged} flagged` : ""}.`;
        notify(msg, red || flagged ? "err" : "ok");
      }
    } catch (e: any) {
      const raw = String(e?.message || e);
      let safe = raw;
      if (azureKey)  safe = safe.split(azureKey).join("***");
      notify("OCR failed: " + safe, "err");
    } finally { setOcrBusy(false); }
  }

  async function uploadSheet() {
    if (settings.azure_ai_key_set !== "1") {
      notify("Add your Azure AI Foundry key in Settings first.", "err"); return;
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
    if (settings.azure_ai_key_set !== "1") {
      notify("Add your Azure AI Foundry key in Settings first.", "err"); return;
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
        const ok = await showConfirm(
          `Import "${picked.name}" (${fmtMin(picked.modified_secs_ago)} min ago, ${fmtMb(picked.size)} MB) for OCR?`
        );
        if (!ok) return;
      } else {
        const list = items
          .map((it, i) => `${i + 1}. ${it.name}  (${fmtMin(it.modified_secs_ago)} min ago, ${fmtMb(it.size)} MB)`)
          .join("\n");
        const ans = await showPrompt(
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

  async function importOcr(force: boolean = false) {
    if (!consensus) return;
    const schemaError = await assertStaffHoursSchema();
    if (schemaError) {
      notify(`Cannot import — ${schemaError}`, "err");
      return;
    }

    // ── Re-import protection ────────────────────────────────────────────
    // For every (staff_id, YYYY-MM) pair we're about to import, count what's
    // already in the DB. If any of those buckets have prior rows, confirm
    // with the user before wiping. This is what makes re-reading the same
    // sheet cleanly REPLACE prior data instead of leaving stale dates
    // behind (plain upsert would only overwrite matching dates).
    const rowsToImport = consensus.align.rows.filter((r) => {
      if (!force && r.row_confidence === "red") return false;
      if (!force && consensus.flags.has(r.key)) return false;
      if (!r.in_time.value && !r.out_time.value) return false;
      return true;
    });
    const bucketKeys = new Set<string>();
    for (const r of rowsToImport) {
      bucketKeys.add(`${r.staff_id}|${r.work_date.slice(0, 7)}`);
    }
    const buckets: Array<{ staffId: number; ym: string; existing: number; label: string }> = [];
    for (const key of bucketKeys) {
      const [sid, ym] = key.split("|");
      const staffId = Number(sid);
      const existing = await countHoursForStaffMonth(staffId, ym);
      if (existing > 0) {
        const label = staff.find((s) => s.id === staffId)?.name ?? `staff #${staffId}`;
        buckets.push({ staffId, ym, existing, label });
      }
    }
    if (buckets.length > 0) {
      const totalExisting = buckets.reduce((a, b) => a + b.existing, 0);
      const lines = buckets
        .slice(0, 12)
        .map((b) => `  • ${b.label} — ${b.ym} (${b.existing} entr${b.existing === 1 ? "y" : "ies"})`)
        .join("\n");
      const more = buckets.length > 12 ? `\n  … and ${buckets.length - 12} more` : "";
      const ok = await showConfirm(
        `This import will REPLACE ${totalExisting} existing ` +
        `entr${totalExisting === 1 ? "y" : "ies"} for the following staff/month${buckets.length === 1 ? "" : "s"}:\n\n` +
        lines + more +
        `\n\nAll prior data (including any manual edits) for these staff/month combinations will be wiped and replaced with the new OCR results.\n\nContinue?`
      );
      if (!ok) return;
      for (const b of buckets) {
        try {
          await deleteHoursForStaffMonth(b.staffId, b.ym);
        } catch (e) {
          console.error(`[importOcr] wipe failed for ${b.label} ${b.ym}:`, e);
          notify(`Failed to wipe old data for ${b.label} ${b.ym} — aborting import.`, "err");
          return;
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    let saved = 0, blocked = 0, flaggedSkipped = 0, dbErrors = 0;
    let lastError: unknown = null;
    for (const r of consensus.align.rows) {
      if (!force && r.row_confidence === "red") { blocked++; continue; }
      if (!force && consensus.flags.has(r.key)) { flaggedSkipped++; continue; }
      // Skip rows with no times captured (e.g. calendar-synth fillers where
      // nobody worked that day). Nothing to upsert — even in force mode.
      if (!r.in_time.value && !r.out_time.value) { continue; }
      try {
        await upsertHour(
          r.staff_id, r.work_date, r.in_time.value, r.out_time.value,
          "ocr", null, null, r.no_lunch.value === "true",
        );
        saved++;
      } catch (e) {
        dbErrors++;
        lastError = e;
        console.error(`[importOcr] upsertHour failed for ${r.staff_name_canonical} @ ${r.work_date}:`, e);
      }
    }
    setConsensus(null);
    await refresh();
    const bits: string[] = [force ? `Imported ${saved} entries (forced)` : `Imported ${saved} entries`];
    if (buckets.length > 0) {
      const wiped = buckets.reduce((a, b) => a + b.existing, 0);
      bits.push(`replaced ${wiped} prior entr${wiped === 1 ? "y" : "ies"}`);
    }
    if (blocked) bits.push(`${blocked} blocked (models disagree)`);
    if (flaggedSkipped) bits.push(`${flaggedSkipped} flagged (fix and re-import)`);
    if (dbErrors) bits.push(`${dbErrors} DB errors (see console)`);
    notify(bits.join(" · "), dbErrors || blocked ? "err" : "ok");
    if (dbErrors && lastError) {
      notify(`First DB error: ${String((lastError as Error)?.message ?? lastError).slice(0, 240)}`, "err");
    }
  }

  // Inline cell edit — user overrides consensus for one field on one row.
  function updateCell(rowKey: string, field: "in_time" | "out_time" | "no_lunch", newValue: string | null) {
    setConsensus((prev) => {
      if (!prev) return prev;
      const align = { ...prev.align, rows: prev.align.rows.map((r) => {
        if (r.key !== rowKey) return r;
        const nextCell = editCell(r[field], newValue);
        const next = { ...r, [field]: nextCell };
        // Recompute row_confidence from the (possibly edited) cells.
        const worst: Confidence = ([next.in_time.confidence, next.out_time.confidence, next.no_lunch.confidence] as Confidence[])
          .reduce<Confidence>((w, c) => (rankConf(c) > rankConf(w) ? c : w), "green");
        next.row_confidence = next.phantom && !isEditedRow(next) ? "red" : worst;
        // Re-run flag check with new values.
        const flags = new Map(prev.flags);
        const inV = next.in_time.value, outV = next.out_time.value;
        if (inV && outV) {
          const paid = paidHours(inV, outV, next.no_lunch.value === "true");
          if (paid < 2) flags.set(next.key, `Shift too short (${paid.toFixed(2)}h)`);
          else if (paid > 10) flags.set(next.key, `Shift too long (${paid.toFixed(2)}h)`);
          else flags.delete(next.key);
        }
        // Note: because prev.flags is captured, we build the new flags Map above.
        return next;
      }) };
      // Rebuild flags fresh so we don't miss deletions when other cells changed too.
      const newFlags = new Map<string, string>();
      for (const rr of align.rows) {
        const inV = rr.in_time.value, outV = rr.out_time.value;
        if (!inV || !outV) continue;
        const paid = paidHours(inV, outV, rr.no_lunch.value === "true");
        if (paid < 2) newFlags.set(rr.key, `Shift too short (${paid.toFixed(2)}h)`);
        else if (paid > 10) newFlags.set(rr.key, `Shift too long (${paid.toFixed(2)}h)`);
      }
      return { ...prev, align, flags: newFlags };
    });
  }
  function dropRow(rowKey: string) {
    setConsensus((prev) => {
      if (!prev) return prev;
      const align = { ...prev.align, rows: prev.align.rows.filter((r) => r.key !== rowKey) };
      const flags = new Map(prev.flags); flags.delete(rowKey);
      return { ...prev, align, flags };
    });
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
              Snap a clear photo or scan of the monthly sheet. Azure Document AI + GPT-5.4 + Mistral OCR run in parallel and agree on the in/out times; you review any low-confidence cells.
            </p>
            {activeStaff.length === 0 && (
              <p style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: 13 }}>Add at least one staff member below before uploading.</p>
            )}
            {settings.azure_ai_key_set !== "1" && activeStaff.length > 0 && (
              <p style={{ margin: "6px 0 0", color: "#b45309", fontSize: 13 }}>⚠ Add your Azure AI Foundry key in <strong>Settings → Optional features</strong> first.</p>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}>
            <button
              onClick={importLatestFromDownloads}
              disabled={ocrBusy || activeStaff.length === 0 || settings.azure_ai_key_set !== "1"}
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
                opacity: (ocrBusy || activeStaff.length === 0 || settings.azure_ai_key_set !== "1") ? 0.55 : 1,
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
              disabled={ocrBusy || activeStaff.length === 0 || settings.azure_ai_key_set !== "1"}
              style={{ fontSize: 13 }}
            >
              {ocrBusy ? "Reading sheet…" : "…or choose file manually"}
            </button>
            <label
              title="When ON, a second OCR pass reads raw digits and cross-checks Doc AI's times. Turn OFF to use only Mistral Document AI (faster, but no digit witness cross-check)."
              style={{
                display: "flex", alignItems: "center", gap: 8,
                fontSize: 12, color: "var(--muted)", cursor: "pointer",
                marginTop: 4, userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={settings.enable_mistral_ocr !== "0"}
                onChange={async (e) => {
                  const val = e.target.checked ? "1" : "0";
                  await setSetting("enable_mistral_ocr", val);
                  setSettings({ ...settings, enable_mistral_ocr: val });
                }}
                disabled={ocrBusy}
              />
              <span>
                Use Mistral OCR digit cross-check{" "}
                <span style={{ opacity: 0.7 }}>
                  ({settings.enable_mistral_ocr === "0" ? "OFF — Doc AI only" : "ON"})
                </span>
              </span>
            </label>
            <label
              title="Azure Document Intelligence — third semantic voter with strong table-structure understanding. Recommended ON for handwritten sheets."
              style={{
                display: "flex", alignItems: "center", gap: 8,
                fontSize: 12, color: "var(--muted)", cursor: "pointer",
                marginTop: 2, userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={settings.enable_azure_di !== "0"}
                onChange={async (e) => {
                  const val = e.target.checked ? "1" : "0";
                  await setSetting("enable_azure_di", val);
                  setSettings({ ...settings, enable_azure_di: val });
                }}
                disabled={ocrBusy}
              />
              <span>
                Use Azure Document Intelligence{" "}
                <span style={{ opacity: 0.7 }}>
                  ({settings.enable_azure_di === "0" ? "OFF" : "ON — 3rd voter"})
                </span>
              </span>
            </label>
          </div>
        </div>

        {consensus && (
          <div style={{ background: "#fff", border: "1px solid var(--border)", padding: 14, borderRadius: 10, marginTop: 14 }}>
            {/* Provider health strip — one badge per model with latency + row count. */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10, fontSize: 12 }}>
              {((): ProviderName[] => {
                const arr: ProviderName[] = ["gpt5"];
                if (settings.enable_azure_di !== "0") arr.push("azure_di");
                if (settings.enable_mistral_ocr !== "0") arr.push("mistral_ocr");
                return arr;
              })().map((p) => {
                const meta = consensus.providerMeta.find((m) => m.provider === p);
                const ok = meta?.ok;
                return (
                  <span key={p} title={meta?.error || `${meta?.rowCount ?? 0} rows in ${meta?.latency_ms ?? 0}ms`}
                    style={{
                      padding: "3px 10px", borderRadius: 999,
                      background: ok ? "#dcfce7" : "#fee2e2",
                      border: `1px solid ${ok ? "#22c55e" : "#ef4444"}`,
                      color: ok ? "#166534" : "#991b1b", fontWeight: 600,
                    }}>
                    {ok ? "●" : "○"} {PROVIDER_LABELS[p]} · {ok ? `${meta?.rowCount} rows` : (meta?.error?.slice(0, 40) || "failed")}
                  </span>
                );
              })}
              {settings.enable_mistral_ocr === "0" && (
                <span style={{ padding: "3px 10px", borderRadius: 999, background: "#e0e7ff", border: "1px solid #6366f1", color: "#3730a3", fontWeight: 600 }}>
                  Digit cross-check OFF — trusting Doc AI verbatim
                </span>
              )}
              {(() => {
                const expected = 1 + (settings.enable_azure_di !== "0" ? 1 : 0) + (settings.enable_mistral_ocr !== "0" ? 1 : 0);
                const got = consensus.align.succeededProviders.length;
                return got < expected ? (
                  <span style={{ padding: "3px 10px", borderRadius: 999, background: "#fef3c7", border: "1px solid #f59e0b", color: "#92400e", fontWeight: 600 }}>
                    ⚠ Only {got}/{expected} responded — reduced cross-check
                  </span>
                ) : null;
              })()}
            </div>

            {/* Month-source banner */}
            {consensus.qrMonth && (
              <div style={{
                background: consensus.monthMismatch ? "#fef3c7" : "#dcfce7",
                border: `1px solid ${consensus.monthMismatch ? "#f59e0b" : "#22c55e"}`,
                padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 13,
              }}>
                <strong>📷 Sheet month:</strong> {consensus.qrMonth} (read from the sheet itself)
                {consensus.monthMismatch && <> — <strong>differs from the {MONTHS[month - 1]} {year} you had selected.</strong> Trusting the sheet.</>}
              </div>
            )}
            {!consensus.qrMonth && (
              <div style={{ background: "#fef3c7", border: "1px solid #f59e0b", padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
                ⚠ Could not read the sheet's month from the QR code or any header. Rows will be imported as <strong>{monthKey(year, month)}</strong>.
              </div>
            )}

            {/* Unmatched staff-name banner */}
            {consensus.align.unmatchedNames.length > 0 && (
              <p style={{ margin: "0 0 8px", color: "#b45309", fontSize: 13 }}>
                ⚠ {consensus.align.unmatchedNames.length} name{consensus.align.unmatchedNames.length === 1 ? "" : "s"} couldn't be matched to a staff member: <strong>{consensus.align.unmatchedNames.join(", ")}</strong>. Add or correct them under <em>Staff</em> and re-upload.
              </p>
            )}

            {/* Summary + import controls */}
            {(() => {
              const rows = consensus.align.rows;
              const red = rows.filter((r) => r.row_confidence === "red").length;
              const yellow = rows.filter((r) => r.row_confidence === "yellow").length;
              const green = rows.filter((r) => r.row_confidence === "green").length;
              const flagged = consensus.flags.size;
              // A row is "importable" if it will produce a DB insert:
              //  - Has at least one of in/out time
              //  - Is not red-confidence
              //  - Is not user-flagged
              const importable = rows.filter((r) =>
                r.row_confidence !== "red" && !consensus.flags.has(r.key)
                && (r.in_time.value || r.out_time.value)
              ).length;
              // "Blocked" = rows the models actually disagreed on (red + flagged),
              // excluding weekends / empty-day placeholders that were never
              // importable anyway.
              const disagreementReds = rows.filter((r) =>
                r.row_confidence === "red"
                && (r.in_time.value || r.out_time.value)
              ).length;
              const blocked = disagreementReds + flagged;
              const blockedRows = rows.filter((r) =>
                (r.row_confidence === "red" && (r.in_time.value || r.out_time.value))
                || consensus.flags.has(r.key)
              );
              return (
                <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
                  <div>
                    <strong>{rows.length} rows read</strong>{" "}
                    <span style={{ color: "#166534" }}>✓ {green}</span> ·{" "}
                    <span style={{ color: "#92400e" }}>≈ {yellow}</span> ·{" "}
                    <span style={{ color: "#991b1b" }}>✗ {red}</span>
                    {flagged > 0 && <> · <span style={{ color: "#dc2626", fontWeight: 600 }}>⚠ {flagged} flagged</span></>}
                    {(() => {
                      const editedCells = rows.reduce((n, r) =>
                        n + (r.in_time.edited ? 1 : 0) + (r.out_time.edited ? 1 : 0) + (r.no_lunch.edited ? 1 : 0), 0);
                      const editedRows = rows.filter((r) => r.in_time.edited || r.out_time.edited || r.no_lunch.edited).length;
                      return editedCells > 0 ? (
                        <> · <span style={{ color: "#7c3aed", fontWeight: 600 }} title={`${editedCells} cell${editedCells === 1 ? "" : "s"} edited across ${editedRows} row${editedRows === 1 ? "" : "s"}`}>
                          ✎ {editedCells} edit{editedCells === 1 ? "" : "s"} ({editedRows} row{editedRows === 1 ? "" : "s"})
                        </span></>
                      ) : null;
                    })()}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn secondary" onClick={() => setConsensus(null)}>Discard</button>
                    <button
                      className="btn" onClick={() => importOcr(false)} style={{ fontWeight: 700 }}
                      disabled={importable === 0}
                      title={blocked ? `${blocked} rows blocked — click ✗ cells to fix, or use Drop row` : "Import all rows the models agree on"}
                    >
                      ✓ Import {importable}{blocked ? ` (${blocked} blocked)` : ""}
                    </button>
                    {blocked > 0 && (
                      <button
                        className="btn"
                        onClick={async () => {
                          const totalToImport = rows.filter((r) => r.in_time.value || r.out_time.value).length;
                          if (await showConfirm(`Force-import all ${totalToImport} rows including the ${blocked} blocked one${blocked === 1 ? "" : "s"}?\n\nUse this only after you've manually reviewed and corrected the flagged cells.`)) {
                            importOcr(true);
                          }
                        }}
                        style={{
                          fontWeight: 700,
                          background: "#dc2626",
                          borderColor: "#b91c1c",
                          color: "white",
                        }}
                        title="Bypass all confidence checks and import every row that has times (including reds and flagged)"
                      >
                        ⚡ Import All ({rows.filter((r) => r.in_time.value || r.out_time.value).length})
                      </button>
                    )}
                  </div>
                </div>
                {blocked > 0 && (
                  <details style={{ marginBottom: 10, fontSize: 12, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "6px 10px" }}>
                    <summary style={{ cursor: "pointer", fontWeight: 600, color: "#991b1b" }}>
                      Why {blocked} row{blocked === 1 ? "" : "s"} blocked?
                    </summary>
                    <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                      {blockedRows.map((r) => {
                        const reasons: string[] = [];
                        if (r.row_confidence === "red") reasons.push("red confidence");
                        if (consensus.flags.has(r.key)) reasons.push(`flagged: ${consensus.flags.get(r.key)}`);
                        if (r.warnings.length > 0) reasons.push(...r.warnings);
                        const inV = r.in_time.value ?? "—";
                        const outV = r.out_time.value ?? "—";
                        return (
                          <li key={r.key} style={{ marginBottom: 3 }}>
                            <strong>{r.staff_name_canonical} · {r.work_date}</strong> ({inV} → {outV}) — {reasons.join("; ") || "no times"}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
                </>
              );
            })()}

            <table className="table" style={{ marginTop: 6 }}>
              <thead><tr>
                <th style={{ width: 32 }}></th>
                <th>Staff</th><th>Date</th><th>In</th><th>Out</th><th>No Ln</th><th>Paid</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                {consensus.align.rows.map((r) => {
                  const inV = r.in_time.value, outV = r.out_time.value;
                  const paid = inV && outV ? paidHours(inV, outV, r.no_lunch.value === "true") : 0;
                  const flag = consensus.flags.get(r.key);
                  const rowP = pillFor(r.row_confidence);
                  return (
                    <tr key={r.key} style={{
                      background: r.row_confidence === "red" ? "#fef2f2"
                        : r.row_confidence === "yellow" ? "#fffbeb" : undefined,
                    }}>
                      <td>
                        <span style={{
                          display: "inline-block", padding: "2px 6px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                          background: rowP.bg, color: rowP.fg, border: `1px solid ${rowP.border}`,
                        }} title={r.phantom ? "Only 1 model saw this row (possible hallucination)" : ""}>
                          {rowP.label}
                        </span>
                      </td>
                      <td title={r.staff_names_seen.length > 1 ? `Models wrote: ${r.staff_names_seen.join(" / ")}` : ""}>
                        {r.staff_name_canonical}
                        {r.phantom && <span style={{ marginLeft: 6, fontSize: 10, color: "#991b1b" }}>PHANTOM</span>}
                      </td>
                      <td>{r.work_date}</td>
                      <td><CellCtl cell={r.in_time} onChange={(v) => updateCell(r.key, "in_time", v)} placeholder="HH:MM" /></td>
                      <td><CellCtl cell={r.out_time} onChange={(v) => updateCell(r.key, "out_time", v)} placeholder="HH:MM" /></td>
                      <td style={{ textAlign: "center" }}>
                        <CellToggle cell={r.no_lunch} onChange={(v) => updateCell(r.key, "no_lunch", v)} />
                      </td>
                      <td>{inV && outV ? paid.toFixed(2) : "—"}</td>
                      <td style={{ fontSize: 12 }}>
                        {r.warnings.length > 0 && (
                          <div style={{ color: "#b45309", fontWeight: 600, marginBottom: 2 }}>
                            ⚠ {r.warnings.join("; ")}
                          </div>
                        )}
                        {flag ? <span style={{ color: "#dc2626", fontWeight: 600 }}>⚠ {flag}</span> :
                          r.row_confidence === "red" ? <span style={{ color: "#991b1b" }}>models disagree</span> :
                          r.row_confidence === "yellow" ? <span style={{ color: "#92400e" }}>majority</span> :
                          <span style={{ color: "#16a34a" }}>✓ ready</span>}
                      </td>
                      <td>
                        <button className="btn link danger" style={{ fontSize: 11 }} onClick={() => dropRow(r.key)}>Drop</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 13 }}>What each model saw (debug)</summary>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10, marginTop: 8 }}>
                {consensus.providerMeta.map((m) => (
                  <div key={m.provider} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {PROVIDER_LABELS[m.provider]} {m.ok ? `· ${m.rowCount} rows · ${m.latency_ms}ms` : `· ✗ ${m.error}`}
                    </div>
                    <pre style={{ margin: 0, padding: 6, background: "#f5f5f5", borderRadius: 4, fontSize: 10, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
                      {m.rawText || m.error || "(no output)"}
                    </pre>
                  </div>
                ))}
              </div>
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

// ─── Per-cell UI helpers for consensus preview ──────────────────────────
function CellCtl({ cell, onChange, placeholder }: {
  cell: import("../lib/ocr").ConsensusCell;
  onChange: (v: string | null) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cell.value || "");
  useEffect(() => { setDraft(cell.value || ""); }, [cell.value]);
  const pill = pillFor(cell.confidence);
  const tip = cell.votes.map((v) => {
    const label = PROVIDER_LABELS[v.provider];
    if (!v.sawRow) return `${label}: (didn't see row)`;
    return `${label}: ${v.value ?? "null"}`;
  }).join("\n") + (cell.edited ? "\n(edited)" : "");
  if (editing) {
    return (
      <input
        autoFocus type="text" placeholder={placeholder} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); onChange(draft.trim() || null); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setDraft(cell.value || ""); setEditing(false); } }}
        style={{ width: 70, padding: "2px 4px", fontSize: 12 }}
      />
    );
  }
  return (
    <span onClick={() => setEditing(true)} title={tip} style={{
      cursor: "text", display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 6px", borderRadius: 4, border: `1px solid ${pill.border}`,
      background: pill.bg, color: pill.fg, fontVariantNumeric: "tabular-nums",
      fontWeight: cell.edited ? 700 : 500,
    }}>
      <span style={{ fontSize: 10 }}>{pill.label}</span>
      {cell.value || "—"}
    </span>
  );
}

function CellToggle({ cell, onChange }: {
  cell: import("../lib/ocr").ConsensusCell;
  onChange: (v: string | null) => void;
}) {
  const pill = pillFor(cell.confidence);
  const isTrue = cell.value === "true";
  const tip = cell.votes.map((v) => {
    const label = PROVIDER_LABELS[v.provider];
    if (!v.sawRow) return `${label}: (didn't see row)`;
    return `${label}: ${v.value === "true" ? "✓ no lunch" : "empty"}`;
  }).join("\n") + (cell.edited ? "\n(edited)" : "");
  return (
    <span
      onClick={() => onChange(isTrue ? "false" : "true")}
      title={tip}
      style={{
        cursor: "pointer", display: "inline-block", padding: "2px 8px", borderRadius: 4,
        border: `1px solid ${pill.border}`, background: pill.bg, color: pill.fg,
        fontWeight: cell.edited ? 700 : 500, minWidth: 24, textAlign: "center",
      }}
    >{isTrue ? "✓" : "—"}</span>
  );
}
