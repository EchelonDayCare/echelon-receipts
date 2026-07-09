// Shift editor drawer — create/edit/cancel/reassign for a single shift.
// Rendered inline as a slide-over from Schedule.tsx.
import { useEffect, useMemo, useState } from "react";
import {
  createShift, updateShift, cancelShift, reassignShift,
  shiftHours, type StaffShift,
} from "../../repo/scheduleRepo";
import { buildWhatsappDeepLink, renderTemplate } from "../../lib/whatsapp";
import { db, getSettings } from "../../lib/db";
import { openUrl } from "@tauri-apps/plugin-opener";
import { showAlert, showConfirm, showPrompt } from "../../lib/dialogs";

type StaffLite = { id: number; name: string; whatsapp_phone_e164: string | null; active: boolean; terminated_at: string | null };

const ROOM_PRESETS = ["Infant", "Toddler", "3-5", "Support", "Prep"];

export type DrawerState =
  | { mode: "closed" }
  | { mode: "new"; staffId: string; shiftDate: string }
  | { mode: "edit"; shift: StaffShift };

export default function ShiftDrawer({
  state, onClose, onSaved, staffList,
}: {
  state: DrawerState;
  onClose: () => void;
  onSaved: () => void;
  staffList: StaffLite[];
}) {
  const [staffId, setStaffId] = useState("");
  const [shiftDate, setShiftDate] = useState("");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("16:00");
  const [room, setRoom] = useState("");
  const [breakMinutes, setBreakMinutes] = useState<number>(30);
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<StaffShift["status"]>("planned");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState<string>("");
  const [beforeSnap, setBeforeSnap] = useState<StaffShift | null>(null);

  useEffect(() => {
    if (state.mode === "closed") return;
    setErr(null);
    if (state.mode === "new") {
      setStaffId(state.staffId); setShiftDate(state.shiftDate);
      setStartTime("08:00"); setEndTime("16:00"); setRoom(""); setBreakMinutes(30);
      setNotes(""); setStatus("planned"); setBeforeSnap(null); setReassigning("");
    } else {
      const s = state.shift; setBeforeSnap(s);
      setStaffId(s.staffId); setShiftDate(s.shiftDate);
      setStartTime(s.startTime); setEndTime(s.endTime);
      setRoom(s.room ?? ""); setBreakMinutes(s.breakMinutes); setNotes(s.notes ?? "");
      setStatus(s.status); setReassigning("");
    }
  }, [state]);

  const current = useMemo<StaffShift | null>(() => {
    if (!staffId || !shiftDate) return null;
    return {
      id: "preview", staffId, shiftDate, startTime, endTime,
      room: room || null, breakMinutes, notes: notes || null, status,
      revisionOf: null, createdAt: "", updatedAt: "", updatedBy: "owner",
      version: 1, deletedAt: null,
    };
  }, [staffId, shiftDate, startTime, endTime, room, breakMinutes, notes, status]);

  async function promptNotify(kind: "change" | "cancel" | "weekly", targetStaffId: string, tokens: Record<string, string>) {
    const s = staffList.find((x) => String(x.id) === targetStaffId);
    if (!s?.whatsapp_phone_e164) {
      void showAlert(`No WhatsApp number on file for ${s?.name ?? "this staff"}. Add one in Roster to enable one-click messaging.`, { kind: "warning" });
      return;
    }
    const settings = await getSettings();
    const templateKey = kind === "change" ? "shift_msg_change" : kind === "cancel" ? "shift_msg_cancel" : "shift_msg_weekly";
    const template = settings[templateKey] || "";
    const ownerFirst = (settings.sender_name || settings.daycare_name || "").split(/\s+/)[0] || "";
    const firstName = s.name.split(/\s+/)[0];
    const msg = renderTemplate(template, {
      staff_first_name: firstName,
      owner_first_name: ownerFirst,
      ...tokens,
    });
    if (!(await showConfirm(`Open WhatsApp for ${s.name}?\n\n${msg}`))) return;
    const url = buildWhatsappDeepLink(s.whatsapp_phone_e164, msg);
    try { await openUrl(url); }
    catch (e: any) { setErr(`Could not open WhatsApp: ${String(e?.message ?? e)}`); }
  }

  async function save() {
    if (busy) return;
    if (state.mode === "closed") return;
    setBusy(true); setErr(null);
    try {
      if (state.mode === "new") {
        await createShift({
          staffId, shiftDate, startTime, endTime,
          room: room || null, breakMinutes, notes: notes || null,
        });
        onSaved();
        await promptNotify("change", staffId, {
          shift_date_pretty: prettyDate(shiftDate),
          old_shift: "—",
          new_shift: `${startTime}–${endTime}${room ? ` · ${room}` : ""}`,
        });
      } else {
        const s = state.shift;
        await updateShift(s.id, { shiftDate, startTime, endTime, room: room || null, breakMinutes, notes: notes || null, status }, s.version);
        onSaved();
        if (beforeSnap) {
          const changed = beforeSnap.startTime !== startTime || beforeSnap.endTime !== endTime || (beforeSnap.room ?? "") !== room || beforeSnap.shiftDate !== shiftDate;
          if (changed) {
            await promptNotify("change", staffId, {
              shift_date_pretty: prettyDate(shiftDate),
              old_shift: `${beforeSnap.startTime}–${beforeSnap.endTime}${beforeSnap.room ? ` · ${beforeSnap.room}` : ""}`,
              new_shift: `${startTime}–${endTime}${room ? ` · ${room}` : ""}`,
            });
          }
        }
      }
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function cancelThis() {
    if (state.mode !== "edit") return;
    const reason = (await showPrompt("Reason (optional):", "")) ?? "";
    setBusy(true);
    try {
      await cancelShift(state.shift.id, state.shift.version, reason);
      onSaved();
      await promptNotify("cancel", staffId, {
        shift_date_pretty: prettyDate(shiftDate),
        old_shift: `${startTime}–${endTime}${room ? ` · ${room}` : ""}`,
        reason_or_none: reason || "—",
      });
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function doReassign() {
    if (state.mode !== "edit" || !reassigning) return;
    setBusy(true);
    try {
      const { cancelled, created } = await reassignShift(state.shift.id, reassigning);
      onSaved();
      // Notify both old and new staff.
      await promptNotify("cancel", cancelled.staffId, {
        shift_date_pretty: prettyDate(shiftDate),
        old_shift: `${startTime}–${endTime}${room ? ` · ${room}` : ""}`,
        reason_or_none: "Reassigned",
      });
      await promptNotify("change", created.staffId, {
        shift_date_pretty: prettyDate(shiftDate),
        old_shift: "—",
        new_shift: `${startTime}–${endTime}${room ? ` · ${room}` : ""}`,
      });
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  if (state.mode === "closed") return null;

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{state.mode === "new" ? "New shift" : "Edit shift"}</h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>

        {err && <div style={errBox}>{err}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          <label style={label}>Staff
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              {staffList.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}{s.whatsapp_phone_e164 ? "" : " (no WhatsApp)"}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>Date
            <input type="date" value={shiftDate} onChange={(e) => setShiftDate(e.target.value)} />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={label}>Start
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label style={label}>End
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={label}>Room
              <input list="room-presets" value={room} onChange={(e) => setRoom(e.target.value)} />
              <datalist id="room-presets">{ROOM_PRESETS.map((r) => <option key={r} value={r} />)}</datalist>
            </label>
            <label style={label}>Break (min)
              <input type="number" min={0} value={breakMinutes} onChange={(e) => setBreakMinutes(Number(e.target.value))} />
            </label>
          </div>
          {state.mode === "edit" && (
            <label style={label}>Status
              <select value={status} onChange={(e) => setStatus(e.target.value as StaffShift["status"])}>
                <option value="planned">Planned</option>
                <option value="confirmed">Confirmed</option>
                <option value="cancelled">Cancelled</option>
                <option value="swapped">Swapped</option>
              </select>
            </label>
          )}
          <label style={label}>Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </label>
          {current && (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              {shiftHours(current).toFixed(1)}h scheduled after break
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            {state.mode === "edit" && (
              <>
                <button className="btn" onClick={cancelThis} disabled={busy} style={{ color: "#fca5a5" }}>Cancel shift</button>
              </>
            )}
            <button className="btn" onClick={onClose} disabled={busy}>Close</button>
            <button className="btn primary" onClick={save} disabled={busy || !staffId || !shiftDate}>
              {busy ? "Saving…" : state.mode === "new" ? "Add shift" : "Save"}
            </button>
          </div>

          {state.mode === "edit" && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer" }}>Reassign to another staff…</summary>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <select value={reassigning} onChange={(e) => setReassigning(e.target.value)} style={{ flex: 1 }}>
                  <option value="">— Pick staff —</option>
                  {staffList.filter((s) => String(s.id) !== staffId).map((s) => (
                    <option key={s.id} value={String(s.id)}>{s.name}</option>
                  ))}
                </select>
                <button className="btn" onClick={doReassign} disabled={!reassigning || busy}>Reassign</button>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

export function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Standalone WhatsApp cancel-notification helper for callers that live
// outside the drawer (e.g., the weekly grid's ✕ delete button). Renders
// the shift_msg_cancel template, prompts the user, and opens WhatsApp.
// Returns silently on missing number / declined prompt / template errors.
export async function notifyShiftCancel(args: {
  staff: StaffLite;
  shiftDate: string;
  startTime: string;
  endTime: string;
  room: string | null;
  reason?: string;
}): Promise<void> {
  const { staff, shiftDate, startTime, endTime, room, reason } = args;
  if (!staff.whatsapp_phone_e164) {
    void showAlert(
      `No WhatsApp number on file for ${staff.name}. Add one in Roster to enable one-click messaging.`,
      { kind: "warning" },
    );
    return;
  }
  const settings = await getSettings();
  const template = settings["shift_msg_cancel"] || "";
  const ownerFirst = (settings.sender_name || settings.daycare_name || "").split(/\s+/)[0] || "";
  const firstName = staff.name.split(/\s+/)[0];
  const msg = renderTemplate(template, {
    staff_first_name: firstName,
    owner_first_name: ownerFirst,
    shift_date_pretty: prettyDate(shiftDate),
    old_shift: `${startTime}–${endTime}${room ? ` · ${room}` : ""}`,
    reason_or_none: reason || "—",
  });
  if (!(await showConfirm(`Open WhatsApp for ${staff.name}?\n\n${msg}`))) return;
  const url = buildWhatsappDeepLink(staff.whatsapp_phone_e164, msg);
  try { await openUrl(url); } catch { /* opener errors handled via UI toast in caller if desired */ }
}

// Fetches every active staff row with their WhatsApp number. Exported for
// use by both the drawer and the grid.
export async function loadActiveStaff(): Promise<StaffLite[]> {
  const d = await db();
  const rows = await d.select<{ id: number; name: string; whatsapp_phone_e164: string | null; active: number; terminated_at: string | null }[]>(
    "SELECT id, name, whatsapp_phone_e164, active, terminated_at FROM staff WHERE active = 1 ORDER BY name",
  );
  return rows.map(r => ({ ...r, active: !!r.active }));
}

// Fetches active staff PLUS inactive staff who still have a non-deleted
// shift inside [weekStartISO, weekStartISO+6]. Preserves compliance: an
// employee who quits mid-week must remain visible on that week's grid so
// history and payroll reconcile. Callers must guard editing of inactive
// rows separately.
//
// Note: staff_shifts.staff_id is TEXT while staff.id is INTEGER (see
// db.ts:881), so the join uses an explicit CAST to keep the query
// portable across SQLite versions.
export async function loadStaffWithShiftsInWeek(weekStartISO: string): Promise<StaffLite[]> {
  const d = await db();
  const start = new Date(weekStartISO + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const endISO = end.toISOString().slice(0, 10);
  const rows = await d.select<{ id: number; name: string; whatsapp_phone_e164: string | null; active: number; terminated_at: string | null }[]>(
    `SELECT s.id, s.name, s.whatsapp_phone_e164, s.active, s.terminated_at
       FROM staff s
      WHERE s.active = 1
         OR EXISTS (
              SELECT 1 FROM staff_shifts ss
               WHERE ss.staff_id = CAST(s.id AS TEXT)
                 AND ss.deleted_at IS NULL
                 AND ss.shift_date BETWEEN ? AND ?
            )
      ORDER BY s.active DESC, s.name`,
    [weekStartISO, endISO],
  );
  return rows.map(r => ({ ...r, active: !!r.active }));
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.5)",
  display: "flex", alignItems: "center", justifyContent: "flex-end", zIndex: 100,
};
const panel: React.CSSProperties = {
  background: "var(--panel, #0b1220)", padding: 20, height: "100vh",
  overflowY: "auto", width: "min(480px, 96vw)", borderLeft: "1px solid var(--border, #1e293b)",
};
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)" };
const errBox: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5",
  border: "1px solid rgba(220,38,38,.35)", marginBottom: 12,
};
