// Weekly staff schedule grid. Sunday-night desk work by the owner.
// Rows = active staff, columns = Mon-Sun. Click a cell to open the shift
// drawer. Publish button opens a per-staff wa.me tab chain.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  addDays, copyWeek, listShiftsForWeek, mondayOf, recordWeeklyPublish,
  shiftHours, softDeleteShift, type StaffShift,
} from "../../repo/scheduleRepo";
import { buildWaMeUrl, buildWhatsappDeepLink, renderTemplate } from "../../lib/whatsapp";
import { getSettings } from "../../lib/db";
import { isAiTextConfigured } from "../../lib/voice";
import { showConfirm } from "../../lib/dialogs";
import ShiftDrawer, { loadActiveStaff, type DrawerState } from "./ShiftDrawer";
import ScheduleAiTextPanel from "./ScheduleAiTextPanel";
import { bcHolidayLookup } from "../../lib/bcHolidays";
import { isBcHolidaysEnabled, getDisabledBcHolidayIds } from "../../lib/centreCalendar";

type StaffLite = { id: number; name: string; whatsapp_phone_e164: string | null };

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function StaffSchedule() {
  const [weekStart, setWeekStart] = useState<string>(() => mondayOf(new Date()));
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [shifts, setShifts] = useState<StaffShift[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>({ mode: "closed" });
  const [publishOpen, setPublishOpen] = useState(false);
  const [aiTextEnabled, setAiTextEnabled] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holidayMap, setHolidayMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    (async () => {
      const on = await isBcHolidaysEnabled();
      const end = addDays(weekStart, 6);
      const excluded = on ? await getDisabledBcHolidayIds() : new Set<string>();
      setHolidayMap(on ? bcHolidayLookup(weekStart, end, excluded) : new Map());
    })();
  }, [weekStart]);

  const refresh = async () => {
    try {
      const [staffRows, shiftRows] = await Promise.all([
        loadActiveStaff(), listShiftsForWeek(weekStart),
      ]);
      setStaff(staffRows);
      setShifts(shiftRows);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [weekStart]);

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

  async function doDeleteShift(sh: StaffShift) {
    if (!(await showConfirm(
      `Delete this shift?\n\n${sh.shiftDate} · ${sh.startTime}–${sh.endTime}${sh.room ? " · " + sh.room : ""}\n\nThis cannot be undone.`,
      { kind: "warning" }
    ))) return;
    try {
      await softDeleteShift(sh.id, sh.version);
      await refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  return (
    <div style={{ padding: 24 }} className="schedule-page">
      <style>{PRINT_CSS}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</button>
          <h1 style={{ margin: 0, minWidth: 260 }}>{weekLabel}</h1>
          <button className="btn" onClick={() => setWeekStart(addDays(weekStart, 7))}>›</button>
          <button className="btn" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => window.print()} title="Print weekly schedule (1 page)">🖨 Print</button>
          <button className="btn" onClick={() => doCopy(1)} disabled={busy}>Copy → next week</button>
          <button className="btn" onClick={() => doCopy(4)} disabled={busy}>Copy → next 4 weeks</button>
          <button className="btn primary" onClick={() => setPublishOpen(true)}>Publish week</button>
        </div>
      </div>

      {err && <div style={errBox}>{err}</div>}

      {staff.length === 0 ? (
        <div style={{ padding: 40, border: "1px dashed var(--border, #334155)", borderRadius: 8, textAlign: "center", color: "var(--muted)" }}>
          No active staff. Add staff first in <Link to="/staff/hours">Staff → Hours</Link>.
        </div>
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
                  return (
                    <th key={d} style={{ textAlign: "left", padding: 8, color: "var(--muted)", background: holidayName ? "#fff7ed" : undefined }} title={holidayName ?? undefined}>
                      {d} <span style={{ fontWeight: 400 }}>{dt.getMonth() + 1}/{dt.getDate()}</span>
                      {holidayName && <div style={{ fontSize: 10, color: "#ea580c", fontWeight: 500 }}>🎉 {holidayName}</div>}
                    </th>
                  );
                })}
                <th style={{ textAlign: "right", padding: 8, color: "var(--muted)", width: 80 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => {
                const total = hoursByStaff.get(String(s.id)) ?? 0;
                const overtime = total > 40;
                return (
                  <tr key={s.id}>
                    <td style={{ padding: 8, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      {!s.whatsapp_phone_e164 && <div style={{ fontSize: 10, color: "#d97706" }}>No WhatsApp</div>}
                    </td>
                    {DAY_LABELS.map((_, i) => {
                      const iso = addDays(weekStart, i);
                      const cellShifts = shiftsByCell.get(`${s.id}|${iso}`) ?? [];
                      return (
                        <td key={i} style={{ padding: 0, verticalAlign: "top", minWidth: 110 }}>
                          {cellShifts.length === 0 ? (
                            <button
                              onClick={() => setDrawer({ mode: "new", staffId: String(s.id), shiftDate: iso })}
                              style={emptyCellStyle}
                              title="Add shift"
                            >+ Add</button>
                          ) : (
                            cellShifts.map((sh) => (
                              <div key={sh.id} className="shift-cell" style={{ position: "relative" }}>
                                <button
                                  onClick={() => setDrawer({ mode: "edit", shift: sh })}
                                  style={cellStyle(sh.status)}
                                  title={`${sh.startTime}–${sh.endTime}${sh.room ? ` · ${sh.room}` : ""}`}
                                >
                                  <div>{sh.startTime}–{sh.endTime}</div>
                                  {sh.room && <div style={{ fontSize: 10, opacity: 0.85 }}>{sh.room}</div>}
                                </button>
                                <button
                                  className="shift-delete"
                                  onClick={(e) => { e.stopPropagation(); void doDeleteShift(sh); }}
                                  title="Delete shift"
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
          onSaved={() => { void refresh(); }}
        />
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
                        {cellShifts.map((sh, ix) => (
                          <div key={sh.id} style={{ marginTop: ix ? 2 : 0 }}>
                            {sh.startTime}–{sh.endTime}
                            {sh.room && <span className="print-room"> · {sh.room}</span>}
                          </div>
                        ))}
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
        const lines = row.shifts.map((sh) => `${prettyDate(sh.shiftDate)}: ${sh.startTime}–${sh.endTime}${sh.room ? ` · ${sh.room}` : ""}`).join("\n");
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

const emptyCellStyle: React.CSSProperties = {
  width: "100%", padding: "12px 6px", background: "transparent",
  border: "1px dashed var(--border, #334155)", borderRadius: 6, cursor: "pointer",
  color: "var(--muted)", fontSize: 11,
};
function cellStyle(status: StaffShift["status"]): React.CSSProperties {
  const bg = status === "cancelled" ? "rgba(220,38,38,.10)"
    : status === "confirmed" ? "rgba(34,197,94,.14)"
    : status === "swapped" ? "rgba(217,119,6,.14)"
    : "rgba(37,99,235,.14)";
  const bd = status === "cancelled" ? "#dc2626"
    : status === "confirmed" ? "#22c55e"
    : status === "swapped" ? "#d97706" : "#2563eb";
  return {
    display: "block", width: "100%",
    padding: "6px 8px", background: bg, border: `1px solid ${bd}55`,
    color: "inherit", borderRadius: 6, cursor: "pointer", textAlign: "left",
    textDecoration: status === "cancelled" ? "line-through" : "none",
    fontSize: 12,
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
    cursor: pointer; display: none; box-shadow: 0 1px 3px rgba(0,0,0,.15);
  }
  .shift-cell:hover .shift-delete { display: block; }
  .shift-cell .shift-delete:hover { background: #dc2626; color: #fff; }
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
