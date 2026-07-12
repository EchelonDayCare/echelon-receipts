// Weekly staff schedule grid. Sunday-night desk work by the owner.
// Rows = active staff, columns = Mon-Sun. Click a cell to open the shift
// drawer. Publish button opens a per-staff wa.me tab chain.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  addDays, copyWeek, listShiftsForWeek, listShiftsForMonth, mondayOf, recordWeeklyPublish,
  shiftHours, softDeleteShift, absenceLabel, restoreShift, listRecentlyCancelled,
  type StaffShift,
} from "../../repo/scheduleRepo";
import { buildWaMeUrl, buildWhatsappDeepLink, renderTemplate } from "../../lib/whatsapp";
import { getSettings } from "../../lib/db";
import { isAiTextConfigured } from "../../lib/voice";
import { showAlert, showConfirm } from "../../lib/dialogs";
import { inactiveLabel } from "../../lib/inactiveLabel";
import ShiftDrawer, { loadStaffWithShiftsInWeek, notifyShiftCancel, type DrawerState } from "./ShiftDrawer";
import ScheduleAiTextPanel from "./ScheduleAiTextPanel";
import { bcHolidayLookup } from "../../lib/bcHolidays";
import {
  isBcHolidaysEnabled,
  getDisabledBcHolidayIds,
  getDefaultOpenDays,
  overridesForRange,
  isOpenDay,
  mergeBcHolidayOverrides,
  closedDayReasonsForRange,
} from "../../lib/centreCalendar";

type StaffLite = { id: number; name: string; whatsapp_phone_e164: string | null; active: boolean; terminated_at: string | null };

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Extract the calendar month (year, month 1-12) that contains a given ISO date. */
function monthOf(iso: string): { year: number; month: number } {
  const [y, m] = iso.split("-").map(Number);
  return { year: y, month: m };
}

function monthLabel(year: number, month: number): string {
  const dt = new Date(year, month - 1, 1);
  return dt.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function StaffSchedule() {
  // v2.6.3: view mode. "week" = existing Mon-Sun grid; "month" = day-of-month
  // grid rendered by <MonthGrid/>. Toggle lives in the toolbar. Both modes
  // share the closed-days map so gating rules are identical.
  const [viewMode, setViewMode] = useState<"week" | "month">("week");
  const [weekStart, setWeekStart] = useState<string>(() => mondayOf(new Date()));
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [shifts, setShifts] = useState<StaffShift[]>([]);
  // Every shift in the calendar month containing `weekStart`. Powers the
  // "Month total" column in week view AND the whole grid in month view.
  const [monthShifts, setMonthShifts] = useState<StaffShift[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>({ mode: "closed" });
  const [publishOpen, setPublishOpen] = useState(false);
  const [aiTextEnabled, setAiTextEnabled] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holidayMap, setHolidayMap] = useState<Map<string, string>>(new Map());
  // Set of ISO dates in the current week when the centre is closed —
  // any combination of weekend (per `centre_default_open_days` bitmap),
  // stat holiday (per Settings), or explicit `centre_calendar` closure.
  // Populated in the same effect that loads holiday names so we only
  // hit the DB once per week change. v2.6.3.
  const [closedDays, setClosedDays] = useState<Map<string, string>>(new Map());
  // Same as closedDays but covers the whole visible calendar month.
  // Populated alongside the week-scoped map so month view has the
  // reason strings without a second round-trip. v2.6.3.
  const [closedDaysMonth, setClosedDaysMonth] = useState<Map<string, string>>(new Map());
  // v2.6.3: rolling window of cancelled shifts so an accidental
  // "Close and cancel N shifts" can be undone one row at a time.
  // Populated after refresh(); shown collapsed by default.
  const [recentlyCancelled, setRecentlyCancelled] = useState<StaffShift[]>([]);
  const [rcOpen, setRcOpen] = useState(false);
  const [rcBusy, setRcBusy] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const end = addDays(weekStart, 6);
      const on = await isBcHolidaysEnabled();
      const excluded = on ? await getDisabledBcHolidayIds() : new Set<string>();
      const holidays = on ? bcHolidayLookup(weekStart, end, excluded) : new Map<string, string>();
      setHolidayMap(holidays);

      const [defaultOpenDays, rawOverrides] = await Promise.all([
        getDefaultOpenDays(),
        overridesForRange(weekStart, end),
      ]);
      const merged = on
        ? mergeBcHolidayOverrides(rawOverrides, weekStart, end, excluded)
        : rawOverrides;
      const closed = new Map<string, string>();
      for (let i = 0; i < 7; i++) {
        const iso = addDays(weekStart, i);
        if (!isOpenDay(iso, merged, defaultOpenDays)) {
          // Prefer specific reason: explicit override reason > holiday
          // name > weekend/default-closed. We don't have the override
          // reason string here (overridesForRange returns is_open only),
          // so fall back to holiday name or "Closed".
          closed.set(iso, holidays.get(iso) ?? "Closed");
        }
      }
      setClosedDays(closed);

      // Extend the reason lookup to the full calendar month containing
      // weekStart so month view can render closed days consistently.
      // Uses the batched `closedDayReasonsForRange` helper (single trip
      // to settings + centre_calendar).
      const { year, month } = monthOf(weekStart);
      const monthFrom = `${year}-${String(month).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const monthTo = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const monthClosed = await closedDayReasonsForRange(monthFrom, monthTo);
      setClosedDaysMonth(monthClosed);
    })();
  }, [weekStart]);

  const refresh = async () => {
    try {
      const { year, month } = monthOf(weekStart);
      const [staffRows, shiftRows, monthRows, rcRows] = await Promise.all([
        loadStaffWithShiftsInWeek(weekStart),
        listShiftsForWeek(weekStart),
        listShiftsForMonth(year, month),
        listRecentlyCancelled(7),
      ]);
      setStaff(staffRows);
      setShifts(shiftRows);
      setMonthShifts(monthRows);
      setRecentlyCancelled(rcRows);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  };

  useEffect(() => { void refresh();   }, [weekStart]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSettings();
      if (!cancelled) setAiTextEnabled(isAiTextConfigured(s as Record<string, string>));
    })();
    return () => { cancelled = true; };
  }, []);

  const shiftsByCell = useMemo(() => {
    const map = new Map<string, StaffShift[]>();
    for (const s of shifts) {
      const key = `${s.staffId}|${s.shiftDate}`;
      const arr = map.get(key) ?? []; arr.push(s); map.set(key, arr);
    }
    return map;
  }, [shifts]);

  const hoursByStaff = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of shifts) {
      if (s.status === "cancelled") continue;
      map.set(s.staffId, (map.get(s.staffId) ?? 0) + shiftHours(s));
    }
    return map;
  }, [shifts]);

  // Hours for the calendar month containing weekStart, keyed by staffId.
  // Rendered in the "Month total" column alongside "Weekly total". Uses
  // the same shiftHours rule (auto-30-min-if-≥5h) so the two totals are
  // directly comparable. v2.6.3.
  const monthHoursByStaff = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of monthShifts) {
      if (s.status === "cancelled") continue;
      map.set(s.staffId, (map.get(s.staffId) ?? 0) + shiftHours(s));
    }
    return map;
  }, [monthShifts]);

  const monthCtx = useMemo(() => monthOf(weekStart), [weekStart]);
  const monthTitle = useMemo(() => monthLabel(monthCtx.year, monthCtx.month), [monthCtx]);

  const weekLabel = useMemo(() => {
    const end = addDays(weekStart, 6);
    const [sy, sm, sd] = weekStart.split("-").map(Number);
    const [ey, em, ed] = end.split("-").map(Number);
    const s = new Date(sy, sm - 1, sd);
    const e = new Date(ey, em - 1, ed);
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(s)} – ${fmt(e)}${s.getFullYear() !== new Date().getFullYear() ? `, ${s.getFullYear()}` : ""}`;
  }, [weekStart]);

  async function doCopy(destWeeks: number) {
    setBusy(true); setErr(null);
    try {
      let src = weekStart;
      for (let i = 0; i < destWeeks; i++) {
        const dst = addDays(src, 7);
        await copyWeek(src, dst);
        src = dst;
      }
      await refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function doDeleteShift(sh: StaffShift, skipConfirm = false) {
    if (!skipConfirm && !(await showConfirm(
      `Delete this shift?\n\n${sh.shiftDate} · ${sh.startTime}–${sh.endTime}${sh.room ? " · " + sh.room : ""}\n\nThis cannot be undone.\n\nTip: Shift-click the ✕ to skip this confirmation.`,
      { kind: "warning" }
    ))) return;
    try {
      await softDeleteShift(sh.id, sh.version);
      // WhatsApp cancel offer — only for today-or-future shifts, only
      // when the primary confirm ran (Shift-click intentionally bypasses
      // both prompts), and only for staff with a number on file.
      // notifyShiftCancel itself gates the second confirm.
      if (!skipConfirm) {
        const today = new Date();
        const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        if (sh.shiftDate >= todayISO) {
          const s = staff.find((x) => String(x.id) === sh.staffId);
          if (s && s.whatsapp_phone_e164 && s.active) {
            const sendIt = await showConfirm(
              `Send ${s.name.split(/\s+/)[0]} a WhatsApp cancellation for this shift?`,
              { okLabel: "Send message", cancelLabel: "Skip" }
            );
            if (sendIt) {
              await notifyShiftCancel({
                staff: s,
                shiftDate: sh.shiftDate,
                startTime: sh.startTime,
                endTime: sh.endTime,
                room: sh.room ?? null,
              });
            }
          }
        }
      }
      await refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  return (
    <div style={{ padding: 24 }} className="schedule-page">
      <style>{PRINT_CSS}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {viewMode === "week" ? (
            <>
              <button className="btn" onClick={() => setWeekStart(addDays(weekStart, -7))} title="Previous week">‹</button>
              <h1 style={{ margin: 0, minWidth: 260 }}>{weekLabel}</h1>
              <button className="btn" onClick={() => setWeekStart(addDays(weekStart, 7))} title="Next week">›</button>
              <button className="btn" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => {
                // Jump to the Monday inside the previous month.
                const first = new Date(monthCtx.year, monthCtx.month - 1, 1);
                first.setMonth(first.getMonth() - 1);
                setWeekStart(mondayOf(first));
              }} title="Previous month">‹</button>
              <h1 style={{ margin: 0, minWidth: 260 }}>{monthTitle}</h1>
              <button className="btn" onClick={() => {
                const first = new Date(monthCtx.year, monthCtx.month - 1, 1);
                first.setMonth(first.getMonth() + 1);
                setWeekStart(mondayOf(first));
              }} title="Next month">›</button>
              <button className="btn" onClick={() => setWeekStart(mondayOf(new Date()))}>This month</button>
            </>
          )}
          <div role="group" aria-label="View mode" style={{ display: "inline-flex", marginLeft: 8, border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, overflow: "hidden" }}>
            <button
              className="btn"
              style={viewMode === "week" ? toggleActiveStyle : toggleInactiveStyle}
              onClick={() => setViewMode("week")}
              aria-pressed={viewMode === "week"}
            >Week</button>
            <button
              className="btn"
              style={viewMode === "month" ? toggleActiveStyle : toggleInactiveStyle}
              onClick={() => setViewMode("month")}
              aria-pressed={viewMode === "month"}
            >Month</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => window.print()} title="Print schedule">🖨 Print</button>
          {viewMode === "week" && (
            <>
              <button className="btn" onClick={() => doCopy(1)} disabled={busy}>Copy → next week</button>
              <button className="btn" onClick={() => doCopy(4)} disabled={busy}>Copy → next 4 weeks</button>
              <button className="btn primary" onClick={() => setPublishOpen(true)}>Publish week</button>
            </>
          )}
        </div>
      </div>

      {err && <div style={errBox}>{err}</div>}

      {staff.length === 0 ? (
        <div style={{ padding: 40, border: "1px dashed var(--border, #334155)", borderRadius: 8, textAlign: "center", color: "var(--muted)" }}>
          No active staff. Add staff first in <Link to="/staff/hours">Staff → Hours</Link>.
        </div>
      ) : viewMode === "month" ? (
        <MonthView
          year={monthCtx.year}
          month={monthCtx.month}
          staff={staff}
          shifts={monthShifts}
          monthHoursByStaff={monthHoursByStaff}
          onCellClick={(staffId, iso) => {
            const s = staff.find((x) => String(x.id) === staffId);
            if (!s) return;
            if (!s.active) { void showAlert(`${s.name} is inactive.`); return; }
            const closedReason = closedDaysMonth.get(iso);
            if (closedReason) {
              void showAlert(`Cannot add a shift on ${iso} — the centre is closed (${closedReason}).`);
              return;
            }
            const own = monthShifts.filter((sh) => sh.staffId === staffId && sh.shiftDate === iso);
            if (own.length === 1) setDrawer({ mode: "edit", shift: own[0] });
            else setDrawer({ mode: "new", staffId, shiftDate: iso });
          }}
          closedDays={closedDaysMonth}
        />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 6, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 8, width: 160 }}>Staff</th>
                {DAY_LABELS.map((d, i) => {
                  const iso = addDays(weekStart, i);
                  const [y, m, dd] = iso.split("-").map(Number);
                  const dt = new Date(y, m - 1, dd);
                  const holidayName = holidayMap.get(iso);
                  const closedReason = closedDays.get(iso);
                  const bg = closedReason
                    ? "#f1f5f9"
                    : holidayName
                    ? "#fff7ed"
                    : undefined;
                  const tip = closedReason
                    ? `Centre closed — ${closedReason}`
                    : (holidayName ?? undefined);
                  return (
                    <th key={d} style={{ textAlign: "left", padding: 8, color: "var(--muted)", background: bg }} title={tip}>
                      {d} <span style={{ fontWeight: 400 }}>{dt.getMonth() + 1}/{dt.getDate()}</span>
                      {holidayName && <div style={{ fontSize: 10, color: "#ea580c", fontWeight: 500 }}>🎉 {holidayName}</div>}
                      {closedReason && !holidayName && <div style={{ fontSize: 10, color: "#64748b", fontStyle: "italic" }}>Closed</div>}
                    </th>
                  );
                })}
                <th style={{ textAlign: "right", padding: 8, color: "var(--muted)", width: 80 }}>
                  Week total
                </th>
                <th style={{ textAlign: "right", padding: 8, color: "var(--muted)", width: 90 }} title={`Total scheduled hours in ${monthTitle}`}>
                  {monthTitle.split(" ")[0]} total
                </th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => {
                const total = hoursByStaff.get(String(s.id)) ?? 0;
                const overtime = total > 40;
                const inactive = !s.active;
                const inactiveMsg = `${s.name} is inactive. Reactivate them in Staff → Hours before editing shifts. Existing shifts remain visible for payroll reconciliation.`;
                return (
                  <tr key={s.id} style={inactive ? { opacity: 0.55 } : undefined}>
                    <td style={{ padding: 8, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 600 }} title={inactive ? "Inactive — historical shifts preserved" : undefined}>
                        {s.name}
                        {inactive && <span style={{ marginLeft: 6, color: "var(--muted)", fontStyle: "italic", fontSize: 11 }}>{inactiveLabel("staff", s.terminated_at)}</span>}
                      </div>
                      {!s.whatsapp_phone_e164 && !inactive && <div style={{ fontSize: 10, color: "#d97706" }}>No WhatsApp</div>}
                    </td>
                    {DAY_LABELS.map((_, i) => {
                      const iso = addDays(weekStart, i);
                      const cellShifts = shiftsByCell.get(`${s.id}|${iso}`) ?? [];
                      const closedReason = closedDays.get(iso);
                      const closedMsg = `Cannot add a shift on ${iso} — the centre is closed (${closedReason ?? "Closed"}). To schedule this day, mark it open in Centre Calendar or disable the holiday in Settings.`;
                      return (
                        <td key={i} style={{ padding: 0, verticalAlign: "top", minWidth: 110, background: closedReason ? "#f8fafc" : undefined }}>
                          {cellShifts.length === 0 ? (
                            closedReason ? (
                              <div
                                style={closedCellStyle}
                                title={`Centre closed — ${closedReason}`}
                              >
                                Closed
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  if (inactive) { void showAlert(inactiveMsg); return; }
                                  setDrawer({ mode: "new", staffId: String(s.id), shiftDate: iso });
                                }}
                                style={emptyCellStyle}
                                title={inactive ? "Inactive staff" : "Add shift"}
                                disabled={inactive}
                              >+ Add</button>
                            )
                          ) : (
                            cellShifts.map((sh) => (
                              <div key={sh.id} className="shift-cell" style={{ position: "relative" }}>
                                <button
                                  onClick={() => {
                                    if (inactive) { void showAlert(inactiveMsg); return; }
                                    if (closedReason) { void showAlert(closedMsg); return; }
                                    setDrawer({ mode: "edit", shift: sh });
                                  }}
                                  style={closedReason ? closedShiftWarningStyle(sh.status) : cellStyle(sh.status)}
                                  title={
                                    inactive
                                      ? "Inactive staff — read only"
                                      : closedReason
                                      ? `⚠ Shift on closed day (${closedReason}) — click ✕ to remove`
                                      : (absenceLabel(sh.status) ?? `${sh.startTime}–${sh.endTime}${sh.room ? ` · ${sh.room}` : ""}`)
                                  }
                                >
                                  {absenceLabel(sh.status)
                                    ? <div style={{ fontWeight: 700 }}>{absenceLabel(sh.status)}</div>
                                    : <>
                                        <div>{sh.startTime}–{sh.endTime}</div>
                                        {sh.room && <div style={{ fontSize: 10, opacity: 0.85 }}>{sh.room}</div>}
                                      </>}
                                </button>
                                <button
                                  className="shift-delete"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (inactive) { void showAlert(inactiveMsg); return; }
                                    void doDeleteShift(sh, e.shiftKey);
                                  }}
                                  title={inactive ? "Inactive staff — read only" : "Delete shift (Shift-click to skip confirm)"}
                                  aria-label="Delete shift"
                                >✕</button>
                              </div>
                            ))
                          )}
                        </td>
                      );
                    })}
                    <td style={{ padding: 8, textAlign: "right", color: overtime ? "#d97706" : undefined }}>
                      {total.toFixed(1)}h {overtime && "⚠"}
                    </td>
                    <td style={{ padding: 8, textAlign: "right", color: "var(--muted)" }} title={`${monthTitle} total`}>
                      {(monthHoursByStaff.get(String(s.id)) ?? 0).toFixed(1)}h
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {aiTextEnabled && staff.length > 0 && (
        <ScheduleAiTextPanel
          weekStartIso={weekStart}
          roster={staff.map((s) => ({ id: String(s.id), name: s.name }))}
          closedDays={closedDays}
          onSaved={() => { void refresh(); }}
        />
      )}

      {recentlyCancelled.length > 0 && (
        <section
          aria-label="Recently cancelled shifts"
          style={{
            marginTop: 16,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--surface, #fff)",
          }}
        >
          <button
            type="button"
            onClick={() => setRcOpen((v) => !v)}
            aria-expanded={rcOpen}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              fontWeight: 600,
              color: "var(--ink, #111)",
            }}
          >
            <span>Recently cancelled ({recentlyCancelled.length}) — last 7 days</span>
            <span aria-hidden="true" style={{ opacity: 0.6 }}>{rcOpen ? "▾" : "▸"}</span>
          </button>
          {rcOpen && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "8px 14px 12px" }}>
              <div style={{ fontSize: 12, color: "var(--muted, #666)", marginBottom: 8 }}>
                Restore puts the shift back on the schedule with the status it had before it was cancelled.
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                {recentlyCancelled.slice(0, 50).map((sh) => {
                  const person = staff.find((s) => String(s.id) === String(sh.staffId));
                  const name = person?.name ?? `Staff #${sh.staffId}`;
                  const abs = absenceLabel(sh.status);
                  const when = `${prettyDate(sh.shiftDate)}`;
                  const detail = abs ? abs : `${sh.startTime}–${sh.endTime}${sh.room ? ` · ${sh.room}` : ""}`;
                  const key = String(sh.id);
                  return (
                    <li
                      key={key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "6px 8px",
                        borderRadius: 6,
                        background: "rgba(0,0,0,0.02)",
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <strong style={{ marginRight: 8 }}>{name}</strong>
                        <span style={{ color: "var(--muted, #666)" }}>{when} · {detail}</span>
                      </span>
                      <button
                        type="button"
                        disabled={rcBusy === key}
                        onClick={async () => {
                          setRcBusy(key);
                          try {
                            await restoreShift(sh.id, sh.version);
                            await refresh();
                          } catch (e: any) {
                            await showAlert(`Could not restore shift: ${String(e?.message ?? e)}`);
                          } finally {
                            setRcBusy(null);
                          }
                        }}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          background: "var(--surface, #fff)",
                          cursor: rcBusy === key ? "wait" : "pointer",
                          fontWeight: 600,
                        }}
                      >
                        {rcBusy === key ? "Restoring…" : "Restore"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Print-only view — hidden on screen, shown on print, fits 1 landscape page. */}
      <div className="print-only print-schedule">
        <div className="print-header">
          <div className="print-title">Weekly Staff Schedule</div>
          <div className="print-week">{weekLabel}</div>
        </div>
        <table className="print-grid">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Staff</th>
              {DAY_LABELS.map((d, i) => {
                const iso = addDays(weekStart, i);
                const [y, m, dd] = iso.split("-").map(Number);
                const dt = new Date(y, m - 1, dd);
                return <th key={d}>{d} {dt.getMonth() + 1}/{dt.getDate()}</th>;
              })}
              <th style={{ textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => {
              const total = hoursByStaff.get(String(s.id)) ?? 0;
              return (
                <tr key={s.id}>
                  <td style={{ textAlign: "left", fontWeight: 600 }}>{s.name}</td>
                  {DAY_LABELS.map((_, i) => {
                    const iso = addDays(weekStart, i);
                    const cellShifts = (shiftsByCell.get(`${s.id}|${iso}`) ?? []).filter((sh) => sh.status !== "cancelled");
                    return (
                      <td key={i}>
                        {cellShifts.map((sh, ix) => {
                          const abs = absenceLabel(sh.status);
                          return (
                            <div key={sh.id} style={{ marginTop: ix ? 2 : 0 }}>
                              {abs ? abs : `${sh.startTime}–${sh.endTime}`}
                              {sh.room && <span className="print-room"> · {sh.room}</span>}
                            </div>
                          );
                        })}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{total.toFixed(1)}h</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="print-footer">Printed {new Date().toLocaleString()}</div>
      </div>

      <ShiftDrawer state={drawer} onClose={() => setDrawer({ mode: "closed" })} onSaved={() => { void refresh(); }} staffList={staff} />

      {publishOpen && (
        <PublishModal
          weekStart={weekStart}
          staff={staff}
          shifts={shifts}
          onClose={() => setPublishOpen(false)}
        />
      )}
    </div>
  );
}

function PublishModal({ weekStart, staff, shifts, onClose }: {
  weekStart: string; staff: StaffLite[]; shifts: StaffShift[]; onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(
    staff.filter((s) => shifts.some((sh) => sh.staffId === String(s.id))).map((s) => String(s.id))
  ));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // queue = one entry per selected staff, in publish order. Owner opens them
  // one at a time so they can hit Send in WhatsApp Desktop before moving on.
  const [queue, setQueue] = useState<Array<{ staffId: string; staffName: string; url: string; sent: boolean }>>([]);
  const [queueIdx, setQueueIdx] = useState(0);

  const perStaff = useMemo(() => {
    return staff.map((s) => {
      const own = shifts.filter((sh) => sh.staffId === String(s.id) && sh.status !== "cancelled");
      const total = own.reduce((a, sh) => a + shiftHours(sh), 0);
      return { staff: s, shifts: own, total };
    });
  }, [staff, shifts]);

  const weekEnd = addDays(weekStart, 6);
  const weekRange = `${prettyDate(weekStart)} – ${prettyDate(weekEnd)}`;

  // Build the queue. Records each publish in the audit trail up front, so if
  // the owner closes the modal mid-way the trail still shows what was queued.
  async function buildQueue() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const settings = await getSettings();
      const template = settings.shift_msg_weekly || "";
      const ownerFirst = (settings.sender_name || settings.daycare_name || "").split(/\s+/)[0] || "";
      const chosen = perStaff.filter((r) => selected.has(String(r.staff.id)) && r.shifts.length > 0);
      const list: Array<{ staffId: string; staffName: string; url: string; sent: boolean }> = [];
      for (const row of chosen) {
        if (!row.staff.whatsapp_phone_e164) {
          setErr((cur) => (cur ?? "") + `\n${row.staff.name}: no WhatsApp number (skipped)`);
          continue;
        }
        const firstName = row.staff.name.split(/\s+/)[0];
        // v2.6.3 CRITICAL: absence rows (vacation/sick/day_off) carry
        // placeholder 09:00-17:00 times but count as 0 hours. Publishing
        // them as literal times would send the employee a WhatsApp
        // saying "Fri Jul 18: 09:00-17:00" for a day they're on vacation
        // — self-contradictory with `total_hours` and dangerous (staff
        // might actually show up). Format absences as their label.
        const lines = row.shifts.map((sh) => {
          const abs = absenceLabel(sh.status);
          if (abs) {
            return `${prettyDate(sh.shiftDate)}: ${abs}${sh.room ? ` · ${sh.room}` : ""}`;
          }
          return `${prettyDate(sh.shiftDate)}: ${sh.startTime}–${sh.endTime}${sh.room ? ` · ${sh.room}` : ""}`;
        }).join("\n");
        const body = renderTemplate(template, {
          staff_first_name: firstName,
          owner_first_name: ownerFirst,
          week_range: weekRange,
          shift_lines: lines,
          total_hours: row.total.toFixed(1),
        });
        const url = buildWhatsappDeepLink(row.staff.whatsapp_phone_e164, body);
        // audit trail keeps the wa.me url as the human-readable fallback
        const auditUrl = buildWaMeUrl(row.staff.whatsapp_phone_e164, body);
        await recordWeeklyPublish(String(row.staff.id), weekStart, row.shifts.map((sh) => sh.id), body, auditUrl);
        list.push({ staffId: String(row.staff.id), staffName: row.staff.name, url, sent: false });
      }
      setQueue(list);
      setQueueIdx(0);
    } catch (e: any) { setErr((cur) => (cur ?? "") + "\n" + String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function openCurrent() {
    if (queueIdx >= queue.length) return;
    const item = queue[queueIdx];
    try { await openUrl(item.url); } catch (e: any) { setErr(String(e?.message ?? e)); return; }
    setQueue((cur) => cur.map((q, i) => (i === queueIdx ? { ...q, sent: true } : q)));
    setQueueIdx((i) => i + 1);
  }

  const toggle = (id: string) => setSelected((cur) => {
    const nx = new Set(cur); nx.has(id) ? nx.delete(id) : nx.add(id); return nx;
  });

  const inQueueMode = queue.length > 0;
  const done = inQueueMode && queueIdx >= queue.length;
  const current = inQueueMode && !done ? queue[queueIdx] : null;

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Publish schedule for {weekRange}</h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        {err && <div style={errBox}><pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{err}</pre></div>}

        {!inQueueMode && (
          <>
            <div style={{ maxHeight: 320, overflowY: "auto", marginBottom: 12 }}>
              {perStaff.map((row) => (
                <label key={row.staff.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border, #1e293b)", opacity: row.shifts.length === 0 ? 0.5 : 1 }}>
                  <input type="checkbox" checked={selected.has(String(row.staff.id))} onChange={() => toggle(String(row.staff.id))} disabled={row.shifts.length === 0} />
                  <div style={{ flex: 1 }}>
                    <div><b>{row.staff.name}</b></div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>
                      {row.shifts.length} shift{row.shifts.length === 1 ? "" : "s"} · {row.total.toFixed(1)}h
                      {row.total > 40 && <span style={{ color: "#d97706" }}> ⚠ OT</span>}
                      {!row.staff.whatsapp_phone_e164 && <span style={{ color: "#dc2626" }}> · no WhatsApp</span>}
                      {row.shifts.length === 0 && <span> · nothing to send</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={buildQueue} disabled={busy || selected.size === 0}>
                {busy ? "Preparing…" : "Prepare messages →"}
              </button>
            </div>
          </>
        )}

        {inQueueMode && (
          <>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
              Opens WhatsApp Desktop with a pre-filled message. Hit <b>Send</b> in WhatsApp, then click <b>Next</b> here.
            </p>
            <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
              {queue.map((q, i) => (
                <div key={q.staffId} style={{
                  padding: "8px 10px", borderRadius: 6,
                  background: i === queueIdx && !done ? "rgba(37,99,235,.18)" : "transparent",
                  border: `1px solid ${i === queueIdx && !done ? "#2563eb" : "var(--border, #1e293b)"}`,
                  display: "flex", alignItems: "center", gap: 8, fontSize: 13,
                }}>
                  <span style={{ width: 20 }}>{q.sent ? "✅" : i === queueIdx ? "▶" : "•"}</span>
                  <span style={{ flex: 1 }}>{q.staffName}</span>
                  <span style={{ color: "var(--muted)", fontSize: 11 }}>{q.sent ? "opened" : i === queueIdx ? "next" : "pending"}</span>
                </div>
              ))}
            </div>
            {done ? (
              <div style={{ padding: 12, borderRadius: 8, background: "rgba(34,197,94,.10)", color: "#4ade80", border: "1px solid rgba(34,197,94,.35)", marginBottom: 12, fontSize: 13 }}>
                All {queue.length} chat{queue.length === 1 ? "" : "s"} opened. Make sure you hit Send in each one.
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {done ? (
                <button className="btn primary" onClick={onClose}>Done</button>
              ) : (
                <>
                  <button className="btn" onClick={onClose}>Close</button>
                  <button className="btn primary" onClick={openCurrent}>
                    Open {current?.staffName} in WhatsApp →
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// v2.6.3: month view — staff × day-of-month grid. Each cell shows the
// summary of that day's shifts for that staff (hours, or "—", or the
// centre-closed hatch). Click a cell to add/edit — routing back to the
// same ShiftDrawer as week view. Kept simple on purpose: no chip-per-
// shift like week view because 31 columns × 5-15 staff rows can't fit
// full chips at reasonable font size.
function MonthView({
  year, month, staff, shifts, monthHoursByStaff, closedDays, onCellClick,
}: {
  year: number;
  month: number;
  staff: StaffLite[];
  shifts: StaffShift[];
  monthHoursByStaff: Map<string, number>;
  closedDays: Map<string, string>;
  onCellClick: (staffId: string, iso: string) => void;
}) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const shiftsByCell = useMemo(() => {
    const map = new Map<string, StaffShift[]>();
    for (const s of shifts) {
      const key = `${s.staffId}|${s.shiftDate}`;
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    return map;
  }, [shifts]);

  const dayLabel = (d: number) => {
    const dt = new Date(year, month - 1, d);
    return ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][dt.getDay()];
  };
  const isoFor = (d: number) =>
    `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 3, fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ position: "sticky", left: 0, background: "var(--bg, #fff)", zIndex: 1, textAlign: "left", padding: "6px 8px", minWidth: 140 }}>Staff</th>
            {days.map((d) => {
              const iso = isoFor(d);
              const closed = closedDays.get(iso);
              return (
                <th key={d} style={{
                  padding: "4px 2px", textAlign: "center", minWidth: 34,
                  color: closed ? "#7c2d12" : "var(--muted)",
                  background: closed ? "#f1f5f9" : undefined,
                  fontWeight: 400,
                }} title={closed ? `Closed — ${closed}` : undefined}>
                  <div style={{ fontSize: 10 }}>{dayLabel(d)}</div>
                  <div style={{ fontWeight: 600, color: closed ? "#7c2d12" : "inherit" }}>{d}</div>
                </th>
              );
            })}
            <th style={{ padding: "4px 8px", textAlign: "right", color: "var(--muted)", minWidth: 60 }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.id} style={!s.active ? { opacity: 0.55 } : undefined}>
              <td style={{ position: "sticky", left: 0, background: "var(--bg, #fff)", padding: "6px 8px", fontWeight: 600, whiteSpace: "nowrap" }}>{s.name}</td>
              {days.map((d) => {
                const iso = isoFor(d);
                const closed = closedDays.get(iso);
                const cellShifts = shiftsByCell.get(`${s.id}|${iso}`) ?? [];
                const live = cellShifts.filter((sh) => sh.status !== "cancelled");
                const hours = live.reduce((sum, sh) => sum + shiftHours(sh), 0);
                if (closed) {
                  // v2.6.3: closed day with live shift(s) — must be
                  // clickable so the owner can open the drawer and
                  // decide (cancel/keep) without switching to Week view.
                  if (live.length > 0) {
                    return (
                      <td key={d}>
                        <button
                          onClick={() => onCellClick(String(s.id), iso)}
                          style={{
                            width: "100%", minWidth: 30, padding: "4px 0",
                            background: "rgba(254,215,170,.5)",
                            border: "1px dashed #d97706",
                            borderRadius: 4, cursor: "pointer",
                            color: "#7c2d12", fontSize: 12, fontWeight: 700,
                          }}
                          title={`⚠ ${live.length} shift on closed day (${closed}) — click to edit or cancel`}
                          aria-label={`Review ${s.name}'s shift on closed day ${iso}`}
                        >⚠</button>
                      </td>
                    );
                  }
                  return (
                    <td key={d} style={{
                      background: "#f8fafc", textAlign: "center",
                      color: "#94a3b8", fontSize: 10, fontStyle: "italic",
                      padding: "4px 2px",
                    }} title={`Closed — ${closed}`}>·</td>
                  );
                }
                if (live.length === 0) {
                  return (
                    <td key={d}>
                      <button
                        onClick={() => onCellClick(String(s.id), iso)}
                        style={monthEmptyCell}
                        aria-label={`Add shift for ${s.name} on ${iso}`}
                      >+</button>
                    </td>
                  );
                }
                const primary = live[0];
                // v2.6.3: absence rows show a 1-char glyph (V/S/O) instead
                // of "0.0h" — hours are zero by construction and a letter
                // reads faster in a dense grid.
                const absLabel = absenceLabel(primary.status);
                const cellLabel = absLabel ? absLabel.charAt(0) : hours.toFixed(1);
                return (
                  <td key={d}>
                    <button
                      onClick={() => onCellClick(String(s.id), iso)}
                      style={monthFilledCell(primary.status)}
                      title={absLabel
                        ? `${absLabel} — ${s.name}`
                        : live.map((sh) => `${sh.startTime}–${sh.endTime}${sh.room ? " · " + sh.room : ""}`).join("\n")}
                    >{cellLabel}</button>
                  </td>
                );
              })}
              <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>
                {(monthHoursByStaff.get(String(s.id)) ?? 0).toFixed(1)}h
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const monthEmptyCell: React.CSSProperties = {
  width: "100%", minWidth: 30, padding: "4px 0",
  background: "transparent", border: "1px dashed var(--border, #cbd5e1)",
  borderRadius: 4, cursor: "pointer", color: "#94a3b8", fontSize: 12,
};
function monthFilledCell(status: StaffShift["status"]): React.CSSProperties {
  const bg =
    status === "confirmed" ? "rgba(34,197,94,.18)"
    : status === "swapped" ? "rgba(217,119,6,.18)"
    : status === "vacation" ? "rgba(22,163,74,.18)"
    : status === "sick" ? "rgba(220,38,38,.18)"
    : status === "day_off" ? "rgba(107,114,128,.20)"
    : "rgba(37,99,235,.18)";
  const bd =
    status === "confirmed" ? "#22c55e"
    : status === "swapped" ? "#d97706"
    : status === "vacation" ? "#16a34a"
    : status === "sick" ? "#dc2626"
    : status === "day_off" ? "#6b7280"
    : "#2563eb";
  return {
    width: "100%", minWidth: 30, padding: "4px 0",
    background: bg, border: `1px solid ${bd}55`,
    borderRadius: 4, cursor: "pointer", color: "inherit",
    fontWeight: 600, fontSize: 11,
  };
}

const toggleActiveStyle: React.CSSProperties = {
  background: "#2563eb", color: "#fff", border: "none",
  borderRadius: 0, padding: "6px 12px", cursor: "pointer", fontSize: 13,
};
const toggleInactiveStyle: React.CSSProperties = {
  background: "transparent", color: "var(--muted, #6b7280)", border: "none",
  borderRadius: 0, padding: "6px 12px", cursor: "pointer", fontSize: 13,
};

const emptyCellStyle: React.CSSProperties = {
  width: "100%", padding: "12px 6px", background: "transparent",
  border: "1px dashed var(--border, #334155)", borderRadius: 6, cursor: "pointer",
  color: "var(--muted)", fontSize: 11,
};
// Closed-day empty cell (v2.6.3): same footprint as `emptyCellStyle`
// but visually inert — no dashed border, no hover cursor, muted text —
// to communicate "you cannot schedule this day" without a disabled
// button that keyboard users would still tab through.
const closedCellStyle: React.CSSProperties = {
  width: "100%", padding: "12px 6px", background: "transparent",
  border: "1px solid transparent", borderRadius: 6,
  color: "var(--muted)", fontSize: 11, textAlign: "center",
  fontStyle: "italic", opacity: 0.6, cursor: "not-allowed",
  userSelect: "none",
};
function cellStyle(status: StaffShift["status"]): React.CSSProperties {
  const bg = status === "cancelled" ? "rgba(220,38,38,.10)"
    : status === "confirmed" ? "rgba(34,197,94,.14)"
    : status === "swapped" ? "rgba(217,119,6,.14)"
    : status === "vacation" ? "rgba(22,163,74,.14)"
    : status === "sick" ? "rgba(220,38,38,.14)"
    : status === "day_off" ? "rgba(107,114,128,.14)"
    : "rgba(37,99,235,.14)";
  const bd = status === "cancelled" ? "#dc2626"
    : status === "confirmed" ? "#22c55e"
    : status === "swapped" ? "#d97706"
    : status === "vacation" ? "#16a34a"
    : status === "sick" ? "#dc2626"
    : status === "day_off" ? "#6b7280"
    : "#2563eb";
  return {
    display: "block", width: "100%",
    padding: "6px 8px", background: bg, border: `1px solid ${bd}55`,
    color: "inherit", borderRadius: 6, cursor: "pointer", textAlign: "left",
    textDecoration: status === "cancelled" ? "line-through" : "none",
    fontSize: 12,
  };
}
// v2.6.3: a shift that lives on a day the centre is now marked closed
// (e.g. shift was created, then owner flipped the calendar). Amber outline
// signals "this needs your attention — either reopen the day, cancel the
// shift, or leave it as an exception". Reuses the status colour ramp for
// the background so cancelled shifts still read as cancelled.
function closedShiftWarningStyle(status: StaffShift["status"]): React.CSSProperties {
  const base = cellStyle(status);
  return {
    ...base,
    border: "1px dashed #d97706",
    boxShadow: "0 0 0 1px rgba(217,119,6,.35) inset",
    background: "rgba(254,215,170,.35)",
    color: "#7c2d12",
  };
}
const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.5)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
};
const modal: React.CSSProperties = {
  background: "var(--panel, #0b1220)", border: "1px solid var(--border, #1e293b)",
  borderRadius: 12, padding: 20, width: "min(560px, 92vw)", maxHeight: "90vh", overflowY: "auto",
};
const errBox: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5",
  border: "1px solid rgba(220,38,38,.35)", marginBottom: 12,
};

// Print stylesheet: hide the interactive UI, show only .print-schedule,
// force landscape, and auto-size the grid to a single page. Font size
// scales down as row count grows so 20+ staff still fit on one page.
const PRINT_CSS = `
  @media screen { .print-only { display: none !important; } }
  .shift-cell { margin-bottom: 4px; }
  .shift-cell .shift-delete {
    position: absolute; top: -6px; right: -6px;
    width: 18px; height: 18px; padding: 0; line-height: 1;
    border-radius: 999px; border: 1px solid #dc2626;
    background: #fff; color: #dc2626; font-size: 11px; font-weight: 700;
    cursor: pointer; display: block; opacity: 0.45;
    transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
    box-shadow: 0 1px 3px rgba(0,0,0,.15);
  }
  .shift-cell:hover .shift-delete { opacity: 1; }
  .shift-cell .shift-delete:hover { background: #dc2626; color: #fff; opacity: 1; }
  @media print { .shift-delete { display: none !important; } }
  @media print {
    @page { size: landscape; margin: 8mm; }
    html, body { background: #fff !important; color: #000 !important; }
    body * { visibility: hidden !important; }
    .print-only, .print-only * { visibility: visible !important; }
    .print-only { position: absolute; left: 0; top: 0; width: 100%; }
    .print-schedule {
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #000;
      padding: 4mm 6mm;
    }
    .print-header {
      display: flex; justify-content: space-between; align-items: baseline;
      border-bottom: 2px solid #000; padding-bottom: 4px; margin-bottom: 8px;
    }
    .print-title { font-size: 16pt; font-weight: 700; }
    .print-week { font-size: 12pt; }
    .print-grid {
      width: 100%; border-collapse: collapse;
      table-layout: fixed;
      font-size: 9pt;
    }
    .print-grid th, .print-grid td {
      border: 1px solid #666;
      padding: 3px 4px;
      vertical-align: top;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .print-grid th {
      background: #eee !important;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      font-size: 8.5pt;
      text-align: center;
    }
    .print-grid td { text-align: center; }
    .print-room { font-size: 7pt; color: #444; }
    .print-footer { margin-top: 6px; font-size: 8pt; color: #666; text-align: right; }
    /* Auto-shrink font/padding when many staff to keep to 1 page */
    .print-grid tr:nth-child(n+16) td,
    .print-grid tr:nth-child(n+16) th { font-size: 8pt; padding: 2px 3px; }
    .print-grid tr:nth-child(n+22) td,
    .print-grid tr:nth-child(n+22) th { font-size: 7pt; padding: 1px 2px; }
  }
`;
