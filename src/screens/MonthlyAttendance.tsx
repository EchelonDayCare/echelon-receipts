// Monthly child attendance grid — matches Luxmi's paper sign-in sheet
// (name × day-of-month, single-character marks). No in/out time on purpose;
// the paper doesn't capture it either. See /reports/attendance for the
// analytics view (centre-wide + per-child).
import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, listYears } from "../lib/db";
import { matchStudentByName } from "../lib/attendance";
import {
  monthGrid, setMark, calendarForMonth, seedWeekends, seedBcHolidays, setCalendarDay,
  daysOpenInMonth, MARK_LABEL, MARK_COLOR, clearMonthMarks, countMarksInMonth,
  type MonthMark, type MonthCell, type CalendarDay,
} from "../lib/monthAttendance";
import { extractMonthAttendance, fileToMime } from "../lib/ai";
import { h } from "../lib/html";
import { showConfirm, showPrompt } from "../lib/dialogs";
import { isBcHolidaysEnabled, setBcHolidaysEnabled } from "../lib/centreCalendar";
import { printHtmlDocument } from "../lib/print";
import { OcrProgressBanner, MONTH_OCR_STAGES } from "../components/OcrProgressBanner";

const MARK_CYCLE: (MonthMark | null)[] = ["P", "A", null];
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function todayYm() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextMark(current: MonthMark | undefined | null): MonthMark | null {
  const idx = MARK_CYCLE.indexOf((current ?? null) as any);
  const next = MARK_CYCLE[(idx + 1) % MARK_CYCLE.length];
  return next;
}

export default function MonthlyAttendance() {
  const start = todayYm();
  const [year, setYear] = useState(start.year);
  const [month, setMonthState] = useState(start.month);
  const [cells, setCells] = useState<MonthCell[]>([]);
  const [calendar, setCalendar] = useState<CalendarDay[]>([]);
  const [daycareName, setDaycareName] = useState("");
  const [dataYears, setDataYears] = useState<number[]>([]);
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [holidaysOn, setHolidaysOn] = useState(true);
  useEffect(() => { void isBcHolidaysEnabled().then(setHolidaysOn); }, []);

  async function toggleHolidays(next: boolean) {
    await setBcHolidaysEnabled(next);
    setHolidaysOn(next);
    if (next) await seedBcHolidays(year, month);
    setCalendar(await calendarForMonth(year, month));
  }

  // OCR state
  const [ocrBusy, setOcrBusy] = useState(false);
  // Post-import breadcrumb — small badge near month picker showing which
  // sheet just landed. Auto-clears when the user changes month/year.
  const [justImported, setJustImported] = useState<null | { month: string; ts: number; marks: number }>(null);
  const [ocrReview, setOcrReview] = useState<null | {
    month: string;
    daysOpen: number | null;
    rows: {
      inputName: string;
      matchedId: number | null;
      matchedName: string | null;
      marks: Record<string, MonthMark>;
      /** Days flagged as low-confidence by the consensus merger (models disagreed). */
      uncertainDays: Set<string>;
      skip: boolean;
    }[];
    unmatched: string[];
    /** Cells where the primary model saw blank but the secondary saw a mark. */
    missedByPrimary: { childName: string; day: string; secondaryMark: string }[];
    providers: { provider: string; ok: boolean; latency_ms: number; row_count: number; mark_count: number; error: string | null }[];
  }>(null);

  async function refresh() {
    const [g, cal, s] = await Promise.all([
      monthGrid(year, month),
      calendarForMonth(year, month),
      getSettings(),
    ]);
    setCells(g);
    setCalendar(cal);
    setDaycareName(s.daycare_name || "");
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year, month]);
  useEffect(() => { listYears().then(setDataYears).catch(() => {}); }, []);

  // Seed weekend rows the first time a month is opened so the header
  // "days open" figure and the greyed-cell hinting Just Work.
  useEffect(() => {
    // Auto-clear the "just imported" breadcrumb when the user navigates
    // to a different month/year — it only makes sense on the sheet that
    // was just written to.
    setJustImported(null);
    (async () => {
      const added = await seedWeekends(year, month);
      const holidayAdded = (await isBcHolidaysEnabled()) ? await seedBcHolidays(year, month) : 0;
      if (added + holidayAdded > 0) setCalendar(await calendarForMonth(year, month));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  // Keyboard shortcuts for the OCR review modal:
  //   Enter → confirm import   Esc → cancel
  // Only bind while the modal is open so it doesn't collide with cell nav.
  useEffect(() => {
    if (!ocrReview) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Don't hijack typing in the roster-picker inputs inside the modal.
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Enter") { e.preventDefault(); void importOcr(); }
      else if (e.key === "Escape") { e.preventDefault(); setOcrReview(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocrReview]);

  function show(msg: string, tone: "ok" | "err" = "ok") {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2500);
  }

  const nDays = daysInMonth(year, month);
  const dayNums = useMemo(() => Array.from({ length: nDays }, (_, i) => i + 1), [nDays]);
  const closedByIso = useMemo(() => {
    const m = new Map<string, CalendarDay>();
    for (const c of calendar) if (!c.is_open) m.set(c.day, c);
    return m;
  }, [calendar]);
  const opensCount = useMemo(() => daysOpenInMonth(year, month, calendar), [year, month, calendar]);

  const yearOptions = useMemo(() => {
    const nowY = new Date().getFullYear();
    const s = new Set<number>([year, nowY, nowY - 1, nowY + 1]);
    for (const y of dataYears) s.add(y);
    return [...s].sort((a, b) => a - b);
  }, [dataYears, year]);

  async function onCellClick(studentId: number, day: number, current: MonthMark | undefined) {
    const iso = isoDay(year, month, day);
    const next = nextMark(current);
    await setMark(studentId, iso, next);
    // Optimistic update.
    setCells((prev) => prev.map((c) => {
      if (c.student_id !== studentId) return c;
      const marks = { ...c.marks };
      if (next === null) delete marks[String(day)];
      else marks[String(day)] = next;
      return { ...c, marks };
    }));
  }

  async function toggleCalendarDay(day: string, current: CalendarDay | undefined) {
    const nextOpen = current ? !current.is_open : false; // first click closes it
    const reason = nextOpen ? null : (current?.reason || "Closed");
    await setCalendarDay(day, nextOpen, reason);
    setCalendar(await calendarForMonth(year, month));
  }

  async function updateCalendarReason(day: string, reason: string) {
    const cur = calendar.find((c) => c.day === day);
    await setCalendarDay(day, cur ? cur.is_open : false, reason || null);
    setCalendar(await calendarForMonth(year, month));
  }

  // ─── OCR flow ─────────────────────────────────────────────────────────
  async function runExtractOnPath(path: string) {
    setOcrBusy(true);
    try {
      const bytes = await readFile(path);
      const mime = fileToMime(path);
      const targetMonth = `${year}-${String(month).padStart(2, "0")}`;
      const knownNames = cells.map((c) => c.student_name);
      const res = await extractMonthAttendance({
        imageBytes: bytes as Uint8Array,
        mimeType: mime,
        targetMonth,
        knownStudentNames: knownNames,
      });
      const roster = cells.map((c) => ({ id: c.student_id, name: c.student_name }));
      // Bucket uncertain cells by child name for quick lookup while building review rows.
      const uncertainByChild = new Map<string, Set<string>>();
      const missedByPrimary: { childName: string; day: string; secondaryMark: string }[] = [];
      for (const u of res.uncertain_cells ?? []) {
        // "primary blank + secondary marked" — surface separately so user can add manually.
        if (u.picked === "-" && u.votes[1] && u.votes[1] !== "-") {
          missedByPrimary.push({ childName: u.child_name, day: u.day, secondaryMark: u.votes[1] });
          continue;
        }
        // Anything else = disagreement or primary-only — flag the day on that child row.
        let s = uncertainByChild.get(u.child_name);
        if (!s) { s = new Set<string>(); uncertainByChild.set(u.child_name, s); }
        s.add(u.day);
      }
      const review = res.rows.map((r) => {
        const match = matchStudentByName(r.child_name, roster);
        return {
          inputName: r.child_name,
          matchedId: match?.id ?? null,
          matchedName: match?.name ?? null,
          marks: r.marks as Record<string, MonthMark>,
          uncertainDays: uncertainByChild.get(r.child_name) ?? new Set<string>(),
          skip: !match,
        };
      });
      const unmatched = review.filter((r) => !r.matchedId).map((r) => r.inputName);
      setOcrReview({
        month: res.month || targetMonth,
        daysOpen: res.days_centre_open,
        rows: review,
        unmatched,
        missedByPrimary,
        providers: res.providers ?? [],
      });
      const uncertainCount = (res.uncertain_cells ?? []).length;
      show(
        `OCR read ${review.length} rows${unmatched.length ? `; ${unmatched.length} unmatched` : ""}` +
        (uncertainCount ? `; ${uncertainCount} cells flagged for review` : ""),
      );
    } catch (e: any) {
      show(String(e?.message || e), "err");
    } finally {
      setOcrBusy(false);
    }
  }

  async function pickAndExtract() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Attendance sheet", extensions: ["jpg","jpeg","png","webp","heic"] }],
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    await runExtractOnPath(path);
  }

  // AirDrop / save-from-iPad workflow: pick up images dropped into ~/Downloads
  // within the last 10 minutes. Mirrors Staff Hours "Import from Downloads".
  async function importLatestFromDownloads() {
    if (ocrBusy) return;
    if (cells.length === 0) {
      show(`Add at least one student to the ${year} roster before uploading.`, "err");
      return;
    }
    try {
      const items = await invoke<Array<{ path: string; name: string; modified_secs_ago: number; size: number }>>(
        "inbox_list_recent",
        { withinMinutes: 10, limit: 5 },
      );
      if (!items.length) {
        show("No image files found in Downloads from the last 10 minutes. AirDrop from iPad and try again.", "err");
        return;
      }
      const fmtMin = (secs: number) => Math.max(1, Math.round(secs / 60));
      const fmtMb = (b: number) => (b / (1024 * 1024)).toFixed(1);
      let picked = items[0];
      if (items.length === 1) {
        const ok = await showConfirm(
          `Import "${picked.name}" (${fmtMin(picked.modified_secs_ago)} min ago, ${fmtMb(picked.size)} MB) for OCR?`,
        );
        if (!ok) return;
      } else {
        const list = items
          .map((it, i) => `${i + 1}. ${it.name}  (${fmtMin(it.modified_secs_ago)} min ago, ${fmtMb(it.size)} MB)`)
          .join("\n");
        const ans = await showPrompt(
          `Multiple recent images in Downloads:\n\n${list}\n\nWhich number to import?`,
          "1",
        );
        if (ans === null) return;
        const n = Number(ans.trim());
        if (!Number.isInteger(n) || n < 1 || n > items.length) {
          show(`Enter a number from 1 to ${items.length}.`, "err");
          return;
        }
        picked = items[n - 1];
      }
      show(`Reading ${picked.name}…`);
      await runExtractOnPath(picked.path);
    } catch (e: any) {
      show("Couldn't read Downloads: " + (e?.message || e), "err");
    }
  }

  async function importOcr() {
    if (!ocrReview) return;
    const [ry, rm] = ocrReview.month.split("-").map((x) => parseInt(x, 10));
    if (!Number.isFinite(ry) || !Number.isFinite(rm)) { show("Bad month from OCR", "err"); return; }
    const rowsToImport = ocrReview.rows.filter((r) => !r.skip && r.matchedId);
    // Closed-day guard: build the ISO set now so we never write marks on
    // Sat/Sun or stat-holiday days even if the model emits them. Seed the
    // target month first — the calendar may be a different month than the
    // grid currently on screen, and holidays only seed on month change so
    // they can silently be missing on first import. We deliberately seed
    // BC holidays here regardless of the master "Apply BC statutory
    // holidays" toggle: the OCR filter should always guard against writing
    // Canada Day etc. Per-holiday opt-outs in getDisabledBcHolidayIds()
    // are still honoured inside seedBcHolidays.
    await seedWeekends(ry, rm);
    await seedBcHolidays(ry, rm);
    const targetCalendar = await calendarForMonth(ry, rm);
    const closedIso = new Set(targetCalendar.filter((c) => !c.is_open).map((c) => c.day));
    // FIX-4: bound days by actual month length so an OCR hallucination
    // like "31" on a 30-day month can't skirt the closed-day set. `month`
    // here is 1-indexed (see setMonthState / MONTH_NAMES[month-1]), so
    // new Date(year, month, 0) is day 0 of the NEXT month = last day of THIS
    // month. E.g. rm=2 for Feb → new Date(y,2,0).getDate() = 28 or 29.
    const daysInMonth = new Date(ry, rm, 0).getDate();
    const filteredRows = rowsToImport.map((r) => ({
      ...r,
      marks: Object.fromEntries(
        Object.entries(r.marks).filter(([dStr]) => {
          const d = parseInt(dStr, 10);
          if (!Number.isFinite(d) || d < 1 || d > daysInMonth) return false;
          return !closedIso.has(isoDay(ry, rm, d));
        }),
      ) as Record<string, MonthMark>,
    }));
    const totalMarks = filteredRows.reduce((n, r) => n + Object.keys(r.marks).length, 0);
    // Smart confirm: skip the scary "REPLACE ALL" dialog when there's
    // nothing to replace (empty month) — the user just wants their marks
    // imported. Only interrupt when we'd actually destroy existing data.
    const existing = await countMarksInMonth(ry, rm);
    if (existing > 0) {
      const ok = await showConfirm(
        `Replace ${existing} existing mark${existing === 1 ? "" : "s"} in ${MONTH_NAMES[rm-1]} ${ry} with ${totalMarks} new mark${totalMarks === 1 ? "" : "s"} across ${filteredRows.length} children?\n\n` +
        `Closed days (weekends, stat holidays) stay empty.`,
      );
      if (!ok) return;
    }
    // Replace-not-merge: wipe the entire month first.
    await clearMonthMarks(ry, rm);
    let saved = 0;
    for (const r of filteredRows) {
      for (const [dStr, mark] of Object.entries(r.marks)) {
        const d = parseInt(dStr, 10);
        await setMark(r.matchedId!, isoDay(ry, rm, d), mark);
        saved++;
      }
    }
    if (ocrReview.daysOpen != null) {
      // Nothing to persist explicitly; calendar drives days_open. Skip.
    }
    setOcrReview(null);
    setJustImported({ month: `${MONTH_NAMES[rm-1]} ${ry}`, ts: Date.now(), marks: saved });
    if (ry !== year || rm !== month) { setYear(ry); setMonthState(rm); } else { await refresh(); }
    show(`Imported ${saved} marks (month cleared first)`);
  }

  function printBlank() {
    const monthLabel = `${MONTH_NAMES[month-1]}'${String(year).slice(-2)}`;
    // Fit strictly on one landscape page — shrink row height + font as the
    // child count grows. Landscape Letter usable area (with 6mm body padding)
    // is roughly 800px of vertical space for the table.
    const nRows = Math.max(1, cells.length);
    const TABLE_AVAIL_PX = 780; // after header + legend + margins
    const rowH = Math.max(11, Math.min(22, Math.floor(TABLE_AVAIL_PX / (nRows + 1))));
    const fontPx = rowH <= 13 ? 8 : rowH <= 16 ? 9 : 10;
    const nameFontPx = fontPx + 1;
    const padY = Math.max(1, Math.floor(rowH / 8));
    const rowsHtml = cells.map((c) => `
      <tr>
        <td class="name">${h(c.student_name)}</td>
        ${dayNums.map((d) => {
          const iso = isoDay(year, month, d);
          const closed = closedByIso.get(iso);
          const style = closed ? ' class="closed"' : "";
          return `<td${style}></td>`;
        }).join("")}
      </tr>`).join("");
    const headerCells = dayNums.map((d) => `<th>${d}</th>`).join("");
    const html = `<!doctype html><html><head><title>Attendance ${monthLabel}</title>
      <style>
        /* margin:0 tells Chromium/WebView2 not to draw its default header &
           footer (date, URL, page number, "Tauri + React + Typescript" title).
           We add visual whitespace via body padding instead. */
        @page { size: 11in 8.5in; margin: 0; }
        html, body { margin: 0; padding: 0; }
        body {
          font-family: -apple-system, "Segoe UI", sans-serif;
          font-size: ${fontPx}px;
          padding: 6mm 8mm;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        h1 { margin: 0 0 2px; font-size: 14px; }
        .meta { margin: 0 0 6px; font-size: 10px; }
        table { border-collapse: collapse; width: 100%; table-layout: fixed; }
        col.day { width: 2.7%; }
        col.name { width: 15%; }
        th, td {
          border: 1px solid #333; padding: ${padY}px 2px;
          text-align: center; height: ${rowH}px;
          overflow: hidden;
        }
        td.name {
          text-align: left; white-space: nowrap;
          padding-left: 4px; font-size: ${nameFontPx}px;
          text-overflow: ellipsis;
        }
        td.closed { background: #e5e5e5; }
        thead th { background: #f0f0f0; font-size: ${fontPx}px; }
        .legend { margin-top: 4px; font-size: 9px; color: #333; }
        /* Belt-and-braces: never spill onto a 2nd page. */
        table, tr, td, th { page-break-inside: avoid; break-inside: avoid; }
      </style></head><body>
      <h1>${h(daycareName || "Echelon Day Care")}</h1>
      <p class="meta">Attendance report for month of ${monthLabel}. Number of days Centre <b>____</b> open</p>
      <table>
        <colgroup>
          <col class="name" />
          ${dayNums.map(() => `<col class="day" />`).join("")}
        </colgroup>
        <thead><tr><th style="text-align:left;">Child</th>${headerCells}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p class="legend">Legend — P = Present · A = Absent. Weekends &amp; closed days pre-shaded.</p>
      </body></html>`;
    void printHtmlDocument(html).catch((e) => show("Print failed: " + (e as Error).message, "err"));
  }

  const monthLabel = `${MONTH_NAMES[month-1]} ${year}`;

  return (
    <div>
      <h1>Monthly Attendance</h1>
      <p className="subtitle">Name × day-of-month grid. Click a cell to cycle P → A → blank. Matches the paper sign-in sheet.</p>

      {/* Breadcrumb after a successful OCR import — makes it obvious which
          month you're now looking at and that fresh data just landed. */}
      {justImported && (
        <div style={{
          marginBottom: 12, padding: "8px 12px",
          background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 8,
          color: "#065f46", fontSize: 13,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <span>
            ✅ Viewing <b>{justImported.month}</b> — just imported {justImported.marks} mark{justImported.marks === 1 ? "" : "s"} from your sheet.
          </span>
          <button
            onClick={() => setJustImported(null)}
            style={{ background: "transparent", border: 0, color: "#065f46", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
            title="Dismiss"
          >×</button>
        </div>
      )}

      {/* Long-wait progress banner for the dual-model OCR call. */}
      <OcrProgressBanner
        active={ocrBusy}
        stages={MONTH_OCR_STAGES}
        hint="Two AI vision models run in parallel; the review panel opens as soon as they finish."
      />

      <div className="toolbar">
        <label style={{ fontSize: 13, color: "var(--muted)" }}>Year:</label>
        <select value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}>
          {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <label style={{ fontSize: 13, color: "var(--muted)", marginLeft: 12 }}>Month:</label>
        <select value={month} onChange={(e) => setMonthState(parseInt(e.target.value, 10))}>
          {MONTH_NAMES.map((n, i) => <option key={n} value={i+1}>{n}</option>)}
        </select>
        <button className="btn secondary" onClick={() => { const t = todayYm(); setYear(t.year); setMonthState(t.month); }}>This month</button>
        <div className="grow" />
        <button className="btn secondary" onClick={() => setShowCalendar((v) => !v)}>{showCalendar ? "Hide" : "Show"} Centre Calendar</button>
        <button
          className="btn secondary"
          onClick={async () => {
            const ok = await showConfirm(
              `Clear every attendance mark in ${MONTH_NAMES[month-1]} ${year}?\n\n` +
              `Days with in/out evidence keep their times; only the P/A marks are removed. Cannot be undone.`,
            );
            if (!ok) return;
            await clearMonthMarks(year, month);
            await refresh();
            show(`Cleared all marks for ${MONTH_NAMES[month-1]} ${year}`);
          }}
          disabled={cells.length === 0}
          title="Wipe every P/A mark for this month"
        >
          Clear This Month
        </button>
        <button className="btn secondary" onClick={printBlank} disabled={cells.length === 0}>Print Blank Template</button>
      </div>

      <div className="kpi" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <div className="card"><div className="lbl">Children ({year})</div><div className="val">{cells.length}</div></div>
        <div className="card"><div className="lbl">Days Centre open</div><div className="val">{opensCount}</div></div>
        <div className="card"><div className="lbl">Total P marks</div><div className="val">{cells.reduce((n,c) => n + Object.values(c.marks).filter(m => m==="P").length, 0)}</div></div>
        <div className="card"><div className="lbl">Total A marks</div><div className="val">{cells.reduce((n,c) => n + Object.values(c.marks).filter(m => m==="A").length, 0)}</div></div>
      </div>

      {/* OCR upload */}
      <section className="card" style={{ marginBottom: 16, background: "linear-gradient(180deg, #ecfdf5 0%, #ffffff 65%)", borderColor: "#a7f3d0" }}>
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ width: 56, height: 56, borderRadius: 12, background: "#d1fae5", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0 }}>📅</div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ margin: "0 0 4px" }}>Upload {monthLabel} sheet</h3>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
              Snap or scan the completed monthly attendance sheet. Azure AI reads each child's row of P / A marks; you review and import.
            </p>
            {cells.length === 0 && (
              <p style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: 13 }}>Add at least one student to the {year} roster before uploading.</p>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}>
            <button
              onClick={importLatestFromDownloads}
              disabled={ocrBusy || cells.length === 0}
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
                opacity: (ocrBusy || cells.length === 0) ? 0.55 : 1,
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
              onClick={pickAndExtract}
              disabled={ocrBusy || cells.length === 0}
              style={{ fontSize: 13 }}
            >
              {ocrBusy ? "Reading sheet…" : "…or choose file manually"}
            </button>
          </div>
        </div>
      </section>

      {/* Centre Calendar side panel */}
      {showCalendar && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Centre Calendar — {monthLabel}</h3>
          <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 13 }}>
            Toggle days when the Centre is closed (stat holidays, PD days, closures). Weekends are seeded automatically. The "Days Centre open" figure updates live.
          </p>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13 }}>
            <input type="checkbox" checked={holidaysOn} onChange={(e) => toggleHolidays(e.target.checked)} />
            Include BC statutory holidays as closed days (12 dates/year — New Year, Family Day, Good Friday, Victoria Day, Canada Day, BC Day, Labour Day, Truth &amp; Reconciliation, Thanksgiving, Remembrance Day, Christmas, Boxing Day)
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 8 }}>
            {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((label) => (
              <div key={label} style={{
                fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                textTransform: "uppercase", color: "var(--muted)",
                padding: "4px 6px", textAlign: "center",
              }}>{label}</div>
            ))}
            {(() => {
              // Leading blanks so day 1 lands under its correct weekday column
              // (Mon-first: Mon=0..Sun=6).
              const firstDow = new Date(year, month - 1, 1).getDay(); // 0=Sun
              const leading = (firstDow + 6) % 7;
              const blanks = Array.from({ length: leading }, (_, i) => (
                <div key={`blank-${i}`} />
              ));
              const cells = dayNums.map((d) => {
                const iso = isoDay(year, month, d);
                const entry = calendar.find((c) => c.day === iso);
                const closed = entry && !entry.is_open;
                const dt = new Date(year, month - 1, d);
                const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dt.getDay()];
                return (
                  <div key={iso} style={{
                    border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 8,
                    background: closed ? "#fef2f2" : "#f0fdf4",
                    minHeight: 68,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 600 }}>{d} <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 11 }}>{dow}</span></div>
                      <button className="btn secondary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => toggleCalendarDay(iso, entry)}>
                        {closed ? "Open" : "Close"}
                      </button>
                    </div>
                    {closed && (
                      <input
                        style={{ marginTop: 6, width: "100%", fontSize: 12, boxSizing: "border-box" }}
                        placeholder="Reason (Stat holiday, PD day…)"
                        defaultValue={entry?.reason || ""}
                        onBlur={(e) => updateCalendarReason(iso, e.target.value)}
                      />
                    )}
                  </div>
                );
              });
              return [...blanks, ...cells];
            })()}
          </div>
        </section>
      )}

      {/* Grid */}
      <div style={{ overflowX: "auto", border: "1px solid var(--border, #e5e7eb)", borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f9fafb" }}>
              <th style={{ position: "sticky", left: 0, background: "#f9fafb", zIndex: 2, padding: "6px 10px", textAlign: "left", borderBottom: "1px solid var(--border, #e5e7eb)", minWidth: 180 }}>Child</th>
              {dayNums.map((d) => {
                const iso = isoDay(year, month, d);
                const closed = closedByIso.has(iso);
                const dow = new Date(year, month - 1, d).getDay();
                return (
                  <th key={d} style={{
                    padding: "4px 2px", textAlign: "center", borderBottom: "1px solid var(--border, #e5e7eb)",
                    background: closed ? "#f3f4f6" : "#f9fafb",
                    color: (dow === 0 || dow === 6) ? "#6b7280" : "inherit",
                    minWidth: 26,
                  }}>{d}</th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {cells.length === 0 && (
              <tr><td colSpan={nDays + 1} style={{ padding: 20, textAlign: "center", color: "var(--muted)" }}>No active students in the {year} roster.</td></tr>
            )}
            {cells.map((c) => (
              <tr key={c.student_id}>
                <td style={{ position: "sticky", left: 0, background: "#fff", padding: "6px 10px", borderBottom: "1px solid var(--border, #f3f4f6)", whiteSpace: "nowrap" }}>{c.student_name}</td>
                {dayNums.map((d) => {
                  const iso = isoDay(year, month, d);
                  const closed = closedByIso.has(iso);
                  const mark = c.marks[String(d)];
                  const color = mark ? MARK_COLOR[mark] : undefined;
                  return (
                    <td key={d} style={{ padding: 0, borderBottom: "1px solid var(--border, #f3f4f6)", background: closed ? "#f3f4f6" : undefined }}>
                      <button
                        onClick={() => onCellClick(c.student_id, d, mark)}
                        title={mark ? MARK_LABEL[mark] : (closed ? "Centre closed" : "Empty — click to mark")}
                        style={{
                          width: "100%", minWidth: 26, height: 26, border: "none",
                          background: "transparent", cursor: "pointer",
                          color: color || (closed ? "#9ca3af" : "#111827"),
                          fontWeight: 600, fontSize: 13, padding: 0,
                        }}
                      >{mark ?? ""}</button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div style={{ marginTop: 10, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--muted)" }}>
        {(["P","A"] as MonthMark[]).map((m) => (
          <span key={m}><span style={{ display: "inline-block", width: 18, textAlign: "center", color: MARK_COLOR[m], fontWeight: 700 }}>{m}</span> {MARK_LABEL[m]}</span>
        ))}
        <span style={{ marginLeft: 8 }}>Shaded columns = Centre closed.</span>
      </div>

      {/* OCR review modal */}
      {ocrReview && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex",
          alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20,
        }}>
          <div style={{ background: "#fff", borderRadius: 12, maxWidth: 900, width: "100%", maxHeight: "90vh", overflow: "auto", padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Review OCR — {ocrReview.month}</h2>
              <button className="btn secondary" onClick={() => setOcrReview(null)}>Cancel</button>
            </div>
            {ocrReview.daysOpen != null && (
              <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 13 }}>
                Header says <b>{ocrReview.daysOpen}</b> days Centre open. Compare with your Centre Calendar figure of <b>{opensCount}</b>.
              </p>
            )}
            {(() => {
              // Row-count reconciliation: alert loudly if OCR row count doesn't
              // match roster size, or if any roster child is missing from the sheet.
              const rosterCount = cells.length;
              const ocrCount = ocrReview.rows.length;
              const matchedIds = new Set(ocrReview.rows.filter(r => r.matchedId).map(r => r.matchedId!));
              const missingFromSheet = cells
                .filter(c => !matchedIds.has(c.student_id))
                .map(c => c.student_name);
              const anyProblem = ocrCount !== rosterCount || missingFromSheet.length > 0 || ocrReview.unmatched.length > 0;
              if (!anyProblem) return null;
              return (
                <div style={{
                  margin: "0 0 10px", padding: 10,
                  background: "#fef2f2", border: "2px solid #f87171", borderRadius: 6,
                  fontSize: 13, color: "#7f1d1d",
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ Roster / sheet mismatch — review before import</div>
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {ocrCount !== rosterCount && (
                      <li>Sheet has <b>{ocrCount}</b> rows, roster has <b>{rosterCount}</b> children.</li>
                    )}
                    {missingFromSheet.length > 0 && (
                      <li>
                        Roster children <b>not found on sheet</b> ({missingFromSheet.length}):{" "}
                        <span style={{ fontStyle: "italic" }}>{missingFromSheet.join(", ")}</span>
                      </li>
                    )}
                    {ocrReview.unmatched.length > 0 && (
                      <li>
                        Names on sheet <b>not in roster</b> ({ocrReview.unmatched.length}, will be skipped):{" "}
                        <span style={{ fontStyle: "italic" }}>{ocrReview.unmatched.join(", ")}</span>
                      </li>
                    )}
                  </ul>
                </div>
              );
            })()}
            {/* Consensus diagnostic strip — how each vision model performed + how many cells disagreed. */}
            {ocrReview.providers.length > 0 && (
              <div style={{ marginBottom: 10, padding: 8, background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 6, fontSize: 12, color: "#0c4a6e" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Model consensus</div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {ocrReview.providers.map((p) => (
                    <div key={p.provider}>
                      <b>{p.provider}</b>: {p.ok ? `${p.mark_count} marks / ${p.row_count} rows` : `failed`}
                      {" "}<span style={{ opacity: 0.6 }}>({(p.latency_ms/1000).toFixed(1)}s)</span>
                      {p.error && <span style={{ color: "#b91c1c" }}> — {p.error.slice(0, 80)}</span>}
                    </div>
                  ))}
                </div>
                {ocrReview.rows.some((r) => r.uncertainDays.size > 0) && (
                  <div style={{ marginTop: 4 }}>
                    <span style={{ background: "#fef3c7", padding: "1px 4px", borderRadius: 3, fontWeight: 600 }}>⚠ Highlighted marks below</span>
                    {" "}= the two models disagreed. Double-check before importing.
                  </div>
                )}
                {ocrReview.missedByPrimary.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <b>{ocrReview.missedByPrimary.length}</b> potential mark(s) that the secondary model saw but the primary didn't — not imported. Review manually if needed:
                    {" "}<span style={{ fontStyle: "italic" }}>
                      {ocrReview.missedByPrimary.slice(0, 8).map((m) => `${m.childName} d${m.day}(${m.secondaryMark})`).join(", ")}
                      {ocrReview.missedByPrimary.length > 8 && ` … +${ocrReview.missedByPrimary.length - 8} more`}
                    </span>
                  </div>
                )}
              </div>
            )}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  <th style={{ padding: 6, textAlign: "left" }}>OCR name</th>
                  <th style={{ padding: 6, textAlign: "left" }}>Matched student</th>
                  <th style={{ padding: 6, textAlign: "left" }}>Marks</th>
                  <th style={{ padding: 6 }}>Import?</th>
                </tr>
              </thead>
              <tbody>
                {ocrReview.rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #f3f4f6", opacity: r.skip ? 0.5 : 1 }}>
                    <td style={{ padding: 6 }}>{r.inputName}</td>
                    <td style={{ padding: 6 }}>{r.matchedName ?? <em style={{ color: "var(--danger)" }}>no match</em>}</td>
                    <td style={{ padding: 6, fontFamily: "monospace" }}>
                      {Object.entries(r.marks).sort((a,b)=>parseInt(a[0])-parseInt(b[0]))
                        .map(([d,m]) => {
                          const flagged = r.uncertainDays.has(d);
                          return (
                            <span key={d} style={{
                              padding: flagged ? "1px 4px" : 0,
                              background: flagged ? "#fef3c7" : "transparent",
                              borderRadius: 3,
                              marginRight: 4,
                            }} title={flagged ? "Models disagreed on this day" : undefined}>
                              {d}:{m}{flagged ? "⚠" : ""}
                            </span>
                          );
                        })}
                    </td>
                    <td style={{ padding: 6, textAlign: "center" }}>
                      <input type="checkbox" checked={!r.skip} disabled={!r.matchedId}
                        onChange={(e) => setOcrReview((prev) => prev ? {
                          ...prev, rows: prev.rows.map((x, xi) => xi === i ? { ...x, skip: !e.target.checked } : x)
                        } : prev)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
              <span style={{ marginRight: "auto", fontSize: 12, color: "var(--muted)" }}>
                <kbd style={{ padding: "1px 6px", border: "1px solid #cbd5e1", borderRadius: 4, background: "#f8fafc" }}>Enter</kbd> to import ·{" "}
                <kbd style={{ padding: "1px 6px", border: "1px solid #cbd5e1", borderRadius: 4, background: "#f8fafc" }}>Esc</kbd> to cancel
              </span>
              <button className="btn secondary" onClick={() => setOcrReview(null)}>Cancel</button>
              <button className="btn primary" onClick={importOcr} autoFocus>Import marks</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 20, right: 20, padding: "10px 16px",
          background: toast.tone === "err" ? "#fee2e2" : "#d1fae5",
          color: toast.tone === "err" ? "#991b1b" : "#065f46",
          borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.15)", zIndex: 200,
        }}>{toast.msg}</div>
      )}
    </div>
  );
}
