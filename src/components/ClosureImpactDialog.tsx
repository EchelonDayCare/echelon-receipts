// v2.6.3 — Closure-impact modal.
//
// When the owner marks a previously-open day as closed (Centre Calendar
// single day, Settings master stat-holiday toggle, per-holiday opt-in, or
// default-open-days bitmap edit), any live staff shifts on affected dates
// become "orphaned" — they exist but the grid marks them as needing
// attention. This modal is the single choke point that surfaces the
// impact BEFORE the closure commits, and lets the owner decide what to
// do with the affected shifts.
//
// Three outcomes:
//   • "cancel"   — abort the calendar edit entirely
//   • "cancel-shifts" — proceed with the closure AND soft-cancel each
//                       affected shift (fires the same audit path as ✕)
//   • "keep-shifts"   — proceed with the closure and leave the shifts
//                       in place; the grid renders them with a warning
//                       tint so the owner can address them one-by-one
//
// Kept intentionally standalone — no context, no portal, no design-system
// coupling — because the surfaces that invoke it live in unrelated
// screens (Settings and MonthlyAttendance) and rendering it inline keeps
// the state machine local to the caller.

import { useEffect, useMemo, useState } from "react";
import { db } from "../lib/db";
import {
  cancelShift,
  listLiveShiftsOnDates,
  type StaffShift,
} from "../repo/scheduleRepo";
import { showAlert } from "../lib/dialogs";

export type ClosureImpactChoice = "cancel" | "cancel-shifts" | "keep-shifts";

/** Represents one date the caller is about to mark closed. */
export type ClosureImpactDate = {
  /** ISO YYYY-MM-DD */
  iso: string;
  /** Human-readable reason to display alongside the date. */
  reason: string;
};

export type ClosureImpact = {
  title: string;
  intro: string;
  dates: ClosureImpactDate[];
};

/**
 * Non-blocking helper. Loads affected shifts for `impact.dates`, then:
 *   - If there are no affected shifts: resolves immediately to
 *     "keep-shifts" and does NOT render the modal (caller can proceed
 *     without an interstitial for the common case).
 *   - Otherwise: renders the modal via a temporary React root and
 *     resolves with the owner's choice.
 *
 * The React root is torn down before the promise resolves so callers
 * can render further UI without a leaked node.
 */
export async function confirmClosureImpact(impact: ClosureImpact): Promise<ClosureImpactChoice> {
  const shifts = await listLiveShiftsOnDates(impact.dates.map((d) => d.iso));
  if (shifts.length === 0) return "keep-shifts";

  // Name lookup — plain map, staff rows are small.
  const staffRows = await (await db()).select<{ id: number; name: string }[]>(
    "SELECT id, name FROM staff",
  );
  const nameById = new Map<string, string>(
    staffRows.map((r) => [String(r.id), r.name]),
  );

  return new Promise<ClosureImpactChoice>((resolve) => {
    // Lazy-import react-dom/client so tests that don't hit this path
    // don't pull the whole client-root machinery.
    void import("react-dom/client").then(({ createRoot }) => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      const done = (choice: ClosureImpactChoice) => {
        root.unmount();
        host.remove();
        resolve(choice);
      };
      root.render(
        <ClosureImpactDialog
          impact={impact}
          shifts={shifts}
          nameById={nameById}
          onChoose={done}
        />,
      );
    });
  });
}

// ─── UI ─────────────────────────────────────────────────────────────────

function ClosureImpactDialog({
  impact,
  shifts,
  nameById,
  onChoose,
}: {
  impact: ClosureImpact;
  shifts: StaffShift[];
  nameById: Map<string, string>;
  onChoose: (c: ClosureImpactChoice) => void;
}) {
  const [choice, setChoice] = useState<ClosureImpactChoice>("cancel-shifts");
  const [busy, setBusy] = useState(false);

  // Group affected shifts by date so the list scans as
  // "Sat 7/18 (Weekend) — Chloe 08:00–16:00, Judy 08:00–12:00".
  const byDate = useMemo(() => {
    const map = new Map<string, StaffShift[]>();
    for (const s of shifts) {
      const arr = map.get(s.shiftDate) ?? [];
      arr.push(s);
      map.set(s.shiftDate, arr);
    }
    return map;
  }, [shifts]);

  const reasonByDate = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of impact.dates) m.set(d.iso, d.reason);
    return m;
  }, [impact.dates]);

  const orderedDates = useMemo(
    () => Array.from(byDate.keys()).sort(),
    [byDate],
  );

  // Trap ESC → cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onChoose("cancel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onChoose]);

  return (
    <div style={backdrop} role="dialog" aria-modal="true" aria-labelledby="closure-impact-title">
      <div style={modal}>
        <h2 id="closure-impact-title" style={{ margin: "0 0 6px", fontSize: 18, color: "#7c2d12" }}>
          ⚠ {impact.title}
        </h2>
        <p style={{ margin: "0 0 12px", color: "#374151", fontSize: 14, lineHeight: 1.45 }}>
          {impact.intro}
        </p>

        <div style={listBox}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "#7c2d12" }}>
            {shifts.length} scheduled shift{shifts.length === 1 ? "" : "s"} affected:
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {orderedDates.map((iso) => {
              const dayShifts = byDate.get(iso) ?? [];
              const reason = reasonByDate.get(iso) ?? "Closed";
              return (
                <div key={iso}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "#111" }}>
                    {formatDateHeader(iso)}
                    <span style={{ color: "#7c2d12", fontWeight: 400, marginLeft: 6 }}>
                      ({reason})
                    </span>
                  </div>
                  <ul style={{ margin: "4px 0 0 18px", padding: 0, fontSize: 13, color: "#374151" }}>
                    {dayShifts.map((sh) => (
                      <li key={sh.id}>
                        {nameById.get(sh.staffId) ?? `Staff ${sh.staffId}`}
                        {" · "}
                        {sh.startTime}–{sh.endTime}
                        {sh.room ? ` · ${sh.room}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={choiceRow}>
            <input
              type="radio"
              name="closure-choice"
              checked={choice === "cancel-shifts"}
              onChange={() => setChoice("cancel-shifts")}
              disabled={busy}
            />
            <span>
              <strong>Cancel these shifts</strong> (recommended)
              <div style={choiceHint}>
                Close the day AND soft-cancel each affected shift.
                Cancelled shifts stay visible in payroll history.
              </div>
            </span>
          </label>
          <label style={choiceRow}>
            <input
              type="radio"
              name="closure-choice"
              checked={choice === "keep-shifts"}
              onChange={() => setChoice("keep-shifts")}
              disabled={busy}
            />
            <span>
              <strong>Keep shifts as-is</strong>
              <div style={choiceHint}>
                Close the day but leave the shifts in place. The Schedule
                grid will flag them with a warning tint so you can review
                each one manually later.
              </div>
            </span>
          </label>
        </div>

        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={() => onChoose("cancel")}
            disabled={busy}
          >
            Don't close the day
          </button>
          <button
            type="button"
            className="btn primary"
            style={{ background: "#b45309", borderColor: "#b45309" }}
            onClick={async () => {
              setBusy(true);
              onChoose(choice);
            }}
            disabled={busy}
          >
            {busy
              ? "Working…"
              : choice === "cancel-shifts"
              ? `Close and cancel ${shifts.length} shift${shifts.length === 1 ? "" : "s"}`
              : "Close and keep shifts"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDateHeader(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.55)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 2000,
};
const modal: React.CSSProperties = {
  background: "#fff", color: "#111", borderRadius: 10,
  padding: 20, width: "min(560px, 92vw)", maxHeight: "90vh", overflowY: "auto",
  border: "1px solid #fed7aa",
  boxShadow: "0 20px 60px rgba(0,0,0,.25)",
};
const listBox: React.CSSProperties = {
  padding: 12, borderRadius: 8, background: "#fff7ed",
  border: "1px solid #fed7aa", fontSize: 13, color: "#7c2d12",
};
const choiceRow: React.CSSProperties = {
  display: "flex", alignItems: "flex-start", gap: 10,
  padding: 10, borderRadius: 8, border: "1px solid #e5e7eb",
  cursor: "pointer", fontSize: 14,
};
const choiceHint: React.CSSProperties = {
  fontSize: 12, color: "#6b7280", marginTop: 2, lineHeight: 1.4,
};

/**
 * v2.6.3: Full closure-impact orchestration.
 *
 * 1. Prompts the closure-impact modal for `impact.dates`.
 * 2. If user chose "cancel-shifts": iterates the affected shifts, calls
 *    cancelShift on each, and COLLECTS failures (silent `catch {}` was
 *    called out by both Codex and functional review as unsafe — a stale
 *    version between read and cancel silently orphans the shift).
 * 3. Returns the choice so the caller can also gate the closure setting
 *    flip on the user's decision.
 * 4. If any cancels failed, shows a summary alert BEFORE returning so
 *    the owner knows to visit the schedule grid and act on the leftovers.
 *
 * Caller-side pattern:
 *   const choice = await runClosureImpact({ title, intro, dates });
 *   if (choice === "cancel") return;      // abort setting change
 *   await setBcHolidaysEnabled(true);     // both "cancel-shifts" and
 *                                          // "keep-shifts" fall through
 */
export async function runClosureImpact(impact: ClosureImpact): Promise<ClosureImpactChoice> {
  const choice = await confirmClosureImpact(impact);
  if (choice !== "cancel-shifts") return choice;

  // Re-fetch affected shifts at execution time so we don't rely on the
  // (already fetched inside the dialog) snapshot the user was shown —
  // any shift the owner cancelled manually between opening the dialog
  // and clicking Confirm will simply no longer be in the list.
  const affected = await listLiveShiftsOnDates(impact.dates.map((d) => d.iso));
  const failed: Array<{ label: string; msg: string }> = [];
  for (const sh of affected) {
    try {
      await cancelShift(sh.id, sh.version, "Centre closed on this day");
    } catch (e: any) {
      failed.push({
        label: `${sh.staffId} · ${sh.shiftDate} · ${sh.startTime}–${sh.endTime}`,
        msg: String(e?.message ?? e),
      });
    }
  }
  if (failed.length > 0) {
    // Fire-and-forget alert — do NOT abort the choice, the owner already
    // committed to closing the day and the setting flip should proceed.
    // Naming the failures gives them the info to clean up manually.
    const lines = failed.slice(0, 6).map((f) => `• ${f.label} — ${f.msg}`);
    const more = failed.length > 6 ? `\n…and ${failed.length - 6} more.` : "";
    void showAlert(
      `Closed the day, but ${failed.length} shift${failed.length === 1 ? "" : "s"} couldn't be cancelled:\n` +
      lines.join("\n") + more +
      `\n\nOpen Schedule → the shifts will show with an amber outline. Cancel them manually with the ✕ button.`,
      { kind: "warning" },
    );
  }
  return choice;
}
