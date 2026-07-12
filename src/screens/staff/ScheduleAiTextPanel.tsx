// AI text-capture panel for the Staff Schedule page (v2.1.1).
//
// Free-text → structured shift rows for the currently-visible week.
// Uses the new parse_staff_shifts Tauri command which is constrained
// server-side to (a) the week we're viewing and (b) the active-staff
// roster. Unmatched staff names come back with staffId=null; the UI
// forces the user to pick a real staff member before that row will
// save. This keeps the AI from silently creating shifts for someone
// who doesn't exist on the roster.

import { useMemo, useState } from "react";
import { parseStaffShifts, type ParsedShift, type ParsedShiftKind } from "../../lib/voice";
import { createShift, cancelShift, restoreShift, getShift, listLiveShiftsOnDates, type ShiftStatus, absenceLabel } from "../../repo/scheduleRepo";
import { closedDayReasonsForRange } from "../../lib/centreCalendar";
import { showAlert } from "../../lib/dialogs";

type Row = ParsedShift & { include: boolean; err?: string };

const EXAMPLES = [
  "Priya morning 7-2 Mon-Fri, no lunch",
  "Sarah closing 2-6 Wed and Thu",
  "Judy on vacation this week",
  "Alex was sick yesterday, Priya covered",
];

// Map a ParsedShift.kind to the ShiftStatus we persist. "shift" → planned;
// absence kinds map straight through.
function kindToStatus(kind: ParsedShiftKind): ShiftStatus {
  return kind === "shift" ? "planned" : kind;
}

// Short human label for the review row chip. Matches the grid's badge
// wording so the user sees the same phrasing here as in the schedule.
function kindChipLabel(kind: ParsedShiftKind): string {
  if (kind === "shift") return "Shift";
  return absenceLabel(kindToStatus(kind)) ?? kind;
}

function kindChipStyle(kind: ParsedShiftKind): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 11, padding: "2px 8px", borderRadius: 999, fontWeight: 600,
    border: "1px solid transparent", whiteSpace: "nowrap",
  };
  switch (kind) {
    case "vacation": return { ...base, background: "#dcfce7", color: "#166534", borderColor: "#86efac" };
    case "sick":     return { ...base, background: "#fee2e2", color: "#991b1b", borderColor: "#fca5a5" };
    case "day_off":  return { ...base, background: "#e5e7eb", color: "#374151", borderColor: "#d1d5db" };
    default:         return { ...base, background: "#ede9fe", color: "#5b21b6", borderColor: "#c4b5fd" };
  }
}

export default function ScheduleAiTextPanel({
  weekStartIso,
  roster,
  closedDays,
  onSaved,
}: {
  weekStartIso: string;
  roster: Array<{ id: string; name: string }>;
  /** ISO → reason map for centre-closed days near the visible week.
   *  Passed to the LLM so it avoids proposing closed days up front.
   *  Frontend also re-checks post-parse and pre-save. v2.6.3. */
  closedDays?: Map<string, string>;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"idle" | "parsing" | "saving">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);

  const rosterById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of roster) m.set(r.id, r.name);
    return m;
  }, [roster]);

  async function parse() {
    const t = text.trim();
    if (!t) { setErr("Type something first."); return; }
    if (roster.length === 0) { setErr("No active staff yet — add staff on the Staff page first."); return; }
    setErr(null); setBusy("parsing"); setRows(null);
    try {
      const res = await parseStaffShifts({ text: t, weekStartIso, roster, closedDays });
      if (res.shifts.length === 0) {
        setErr(
          "AI couldn't find any shifts in that text. Try being more explicit — " +
          "include a name, day, and time (e.g. \"Judy 9am to 11am on Friday\").",
        );
        setBusy("idle");
        return;
      }
      // Compute today's local ISO for the past-date filter below.
      const today = new Date();
      const todayIso =
        `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-` +
        `${String(today.getDate()).padStart(2, "0")}`;

      // Past-date filter (v2.6.3): the LLM is now told to *emit* past
      // dates rather than swallow them silently, because users typically
      // typo'd the month ("June 17" vs "July 17") or meant next year.
      // We drop them here with a specific message so the user can retry
      // with the fix, rather than seeing "AI couldn't find any shifts".
      //
      // EXCEPTION: absence rows (sick / vacation / day_off) are allowed
      // in the past — "Judy was sick yesterday" is the whole point of
      // the flow, and dropping it would be user-hostile.
      const droppedForPast: string[] = [];
      const afterPast: ParsedShift[] = [];
      for (const s of res.shifts) {
        if (s.shiftDate < todayIso && s.kind === "shift") {
          droppedForPast.push(`${s.staffName} on ${s.shiftDate}`);
          continue;
        }
        afterPast.push(s);
      }

      // Closed-day gate (v2.6.3): fetch the reason map covering every
      // date the AI produced (may span past the currently-viewed week
      // for "every Monday for 4 weeks"-style prompts) and drop rows
      // that land on a closed day. The staff scheduler is the choke
      // point that the AI can bypass otherwise — the "+ Add" button
      // and drawer are already guarded.
      const droppedForClosure: string[] = [];
      const kept: ParsedShift[] = [];
      if (afterPast.length > 0) {
        const parsedDates = afterPast.map((s) => s.shiftDate).sort();
        const minDate = parsedDates[0];
        const maxDate = parsedDates[parsedDates.length - 1];
        const closedMap = await closedDayReasonsForRange(minDate, maxDate);
        for (const s of afterPast) {
          const reason = closedMap.get(s.shiftDate);
          if (reason) {
            droppedForClosure.push(`${s.staffName} on ${s.shiftDate} (${reason})`);
            continue;
          }
          kept.push(s);
        }
      }

      if (kept.length === 0) {
        // Nothing survived — build a single clear explanation covering
        // whichever filter(s) rejected the AI's rows. This is what the
        // user sees instead of the generic "couldn't find any shifts".
        const reasons: string[] = [];
        if (droppedForPast.length > 0) {
          reasons.push(
            `${droppedForPast.length} shift${droppedForPast.length === 1 ? " was" : "s were"} on past ` +
            `date${droppedForPast.length === 1 ? "" : "s"} — did you mean a different month or next year?\n` +
            `  • ${droppedForPast.join("\n  • ")}`,
          );
        }
        if (droppedForClosure.length > 0) {
          reasons.push(
            `${droppedForClosure.length} shift${droppedForClosure.length === 1 ? " landed" : "s landed"} on a closed day:\n` +
            `  • ${droppedForClosure.join("\n  • ")}`,
          );
        }
        setErr(
          `AI parsed ${res.shifts.length} shift${res.shifts.length === 1 ? "" : "s"} ` +
          `but nothing could be scheduled:\n\n${reasons.join("\n\n")}`,
        );
        setBusy("idle");
        return;
      }
      // One-shift-per-person-per-day: if the AI produced multiple shifts for
      // the same (staff, date), auto-uncheck the extras and warn the owner.
      // The rule matches the underlying DB constraint in createShift, so the
      // save would fail anyway — telling the user up front is friendlier.
      const seen = new Set<string>();
      const dupeNames: string[] = [];
      const marked: Row[] = kept.map((s) => {
        const key = `${s.staffId ?? "?"}|${s.shiftDate}`;
        const isDup = !!s.staffId && seen.has(key);
        if (s.staffId) seen.add(key);
        if (isDup) dupeNames.push(`${s.staffName} on ${s.shiftDate}`);
        return { ...s, include: !isDup };
      });
      setRows(marked);
      setBusy("idle");
      // Compose one alert covering past-dates, duplicates, and dropped
      // closed-day rows so we don't stack multiple dialogs.
      const notes: string[] = [];
      if (droppedForPast.length > 0) {
        const uniq = Array.from(new Set(droppedForPast));
        notes.push(
          `Dropped ${uniq.length} shift${uniq.length === 1 ? "" : "s"} on past dates ` +
          `— check the month or year:\n• ${uniq.join("\n• ")}`,
        );
      }
      if (droppedForClosure.length > 0) {
        const uniq = Array.from(new Set(droppedForClosure));
        notes.push(
          `Dropped ${uniq.length} shift${uniq.length === 1 ? "" : "s"} on closed days:\n• ${uniq.join("\n• ")}`,
        );
      }
      if (dupeNames.length > 0) {
        const uniq = Array.from(new Set(dupeNames));
        notes.push(
          `One staff member can only have one shift per day.\n` +
          `Auto-unchecked duplicate rows for:\n• ${uniq.join("\n• ")}\n` +
          `Edit or uncheck as needed before saving.`,
        );
      }
      if (notes.length > 0) {
        window.setTimeout(() => void showAlert(notes.join("\n\n"), { kind: "warning" }), 50);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e)); setBusy("idle");
    }
  }

  async function save() {
    if (!rows) return;
    const toSave = rows.filter((r) => r.include && r.staffId);
    const skipped = rows.length - toSave.length;
    if (toSave.length === 0) { setErr("Nothing to save — every row is either excluded or missing a staff match."); return; }
    setBusy("saving"); setErr(null);
    // Save-time backstop: user can manually change dates in the review
    // grid, so re-check every kept row against the closed-day set right
    // before we hit the DB.
    const dates = toSave.map((r) => r.shiftDate).sort();
    const closedMap = await closedDayReasonsForRange(dates[0], dates[dates.length - 1]);

    // v2.6.3: for absence rows (vacation/sick/day_off) we may need to
    // soft-cancel a planned shift the same person already has on that
    // date, so the new marker doesn't collide with the one-per-day rule.
    // Batch that lookup up front (single SQL) and index by (staffId|date).
    // Include past dates too — sick-yesterday flows are the common case.
    // We also capture the ORIGINAL STATUS so that if createShift fails
    // after cancelShift succeeded we can restore the shift to exactly
    // where it was (planned / confirmed / swapped), not blindly downgrade.
    const absenceRows = toSave.filter((r) => r.kind !== "shift");
    const existingByKey = new Map<string, { id: string; version: number; status: ShiftStatus }>();
    if (absenceRows.length > 0) {
      const absenceDates = Array.from(new Set(absenceRows.map((r) => r.shiftDate)));
      const existing = await listLiveShiftsOnDates(absenceDates, { includePast: true });
      for (const s of existing) {
        existingByKey.set(`${s.staffId}|${s.shiftDate}`, { id: s.id, version: s.version, status: s.status });
      }
    }

    let ok = 0;
    const failed: string[] = [];
    const replacedNotes: Array<{ label: string; prevStatus: ShiftStatus }> = [];
    for (const r of toSave) {
      const reason = closedMap.get(r.shiftDate);
      if (reason) {
        failed.push(`${r.staffName} ${r.shiftDate}: centre closed (${reason})`);
        continue;
      }
      let cancelledForRollback: { id: string; prevStatus: ShiftStatus } | null = null;
      try {
        // Absence rows first cancel any conflicting live shift for the
        // same (staff, date). If createShift fails afterwards we roll
        // back via restoreShift so we never leave the schedule with a
        // silent gap (Codex M3).
        if (r.kind !== "shift") {
          const existing = existingByKey.get(`${r.staffId!}|${r.shiftDate}`);
          if (existing) {
            await cancelShift(existing.id, existing.version, `Replaced by ${kindChipLabel(r.kind)} marker (AI)`);
            cancelledForRollback = { id: existing.id, prevStatus: existing.status };
            replacedNotes.push({
              label: `${r.staffName} ${r.shiftDate}`,
              prevStatus: existing.status,
            });
          }
        }
        await createShift({
          staffId: r.staffId!,
          shiftDate: r.shiftDate,
          startTime: r.startTime,
          endTime: r.endTime,
          room: r.room,
          breakMinutes: r.breakMinutes,
          notes: r.notes,
          status: kindToStatus(r.kind),
        });
        ok++;
      } catch (e: any) {
        // Best-effort rollback so we never orphan the pre-existing shift.
        // restoreShift internally recovers the exact previous status
        // from the audit trail — no hard-coded "planned" downgrade.
        let rollbackNote = "";
        if (cancelledForRollback) {
          try {
            // Need fresh version — cancelShift bumped it. Look it up.
            const rolledBack = await getShift(cancelledForRollback.id);
            if (rolledBack) {
              await restoreShift(rolledBack.id, rolledBack.version);
              rollbackNote = " (previous shift restored)";
              // Drop the "replaced" note since we un-replaced it.
              const idx = replacedNotes.findIndex((n) => n.label === `${r.staffName} ${r.shiftDate}`);
              if (idx >= 0) replacedNotes.splice(idx, 1);
            }
          } catch (rollbackErr) {
            rollbackNote = ` (⚠ ROLLBACK FAILED: ${String((rollbackErr as any)?.message ?? rollbackErr)} — original shift is still cancelled; recover it from the "Recently cancelled" panel)`;
          }
        }
        failed.push(`${r.staffName} ${r.shiftDate}: ${String(e?.message ?? e)}${rollbackNote}`);
      }
    }
    setBusy("idle");
    if (failed.length > 0) {
      setErr(`Saved ${ok}. Failed ${failed.length}:\n• ${failed.slice(0, 5).join("\n• ")}${failed.length > 5 ? `\n…and ${failed.length - 5} more.` : ""}`);
    } else {
      const parts: string[] = [skipped > 0 ? `Saved ${ok}. Skipped ${skipped}.` : `Saved ${ok}.`];
      if (replacedNotes.length > 0) {
        // v2.6.3 (Sonnet B4): echo the original status so the owner knows
        // whether we pulled a planned shift (safe) or a confirmed one
        // (may have already been WhatsApp'd to the employee).
        const bullets = replacedNotes.map((n) => `${n.label} (was ${n.prevStatus})`);
        parts.push(
          `Replaced existing shift${replacedNotes.length === 1 ? "" : "s"}:\n• ${bullets.join("\n• ")}`,
        );
      }
      setErr(null);
      onSaved();
      setText(""); setRows(null);
      window.setTimeout(() => void showAlert(parts.join("\n\n")), 50);
    }
  }

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev ? prev.map((r, ix) => ix === i ? { ...r, ...patch } : r) : prev);
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>✨ AI Schedule Builder</div>
      </div>
      <div style={styles.weekLabel}>Currently viewing week of {weekStartIso} — but you can schedule any future date (e.g. "next Monday", "July 20", "every Mon for 4 weeks").</div>

      {!rows && (
        <>
          <textarea
            style={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Priya morning 7-2 Mon-Fri, Sarah closing 2-6 Wed-Fri, Anita full day Sat"
            rows={3}
            disabled={busy === "parsing"}
          />
          <div style={styles.examples}>
            <span style={styles.examplesLabel}>Try:</span>
            {EXAMPLES.map((ex, i) => (
              <button key={i} style={styles.exampleChip} onClick={() => setText(ex)} disabled={busy === "parsing"}>
                {ex}
              </button>
            ))}
          </div>
          <div style={styles.actions}>
            <button style={styles.primaryBtn} onClick={parse} disabled={busy === "parsing" || !text.trim()}>
              {busy === "parsing" ? "Thinking…" : "✨ Parse with AI"}
            </button>
            <button style={styles.linkBtn} onClick={() => setText("")} disabled={busy === "parsing"}>Clear</button>
          </div>
        </>
      )}

      {rows && (
        <div>
          <div style={styles.reviewHeader}>
            Review {rows.length} parsed shift{rows.length === 1 ? "" : "s"}. Uncheck rows to skip; fix any that need a staff match. Shifts outside the currently-visible week are saved but you'll need to navigate to that week to see them.
          </div>
          <div style={styles.rowsWrap}>
            {rows.map((r, i) => {
              const needsMatch = !r.staffId;
              return (
                <div key={i} style={{ ...styles.row, background: needsMatch ? "#fef3c7" : "#f8fafc", opacity: r.include ? 1 : 0.5 }}>
                  <input
                    type="checkbox"
                    checked={r.include}
                    onChange={(e) => updateRow(i, { include: e.target.checked })}
                    style={{ marginRight: 8 }}
                  />
                  <select
                    style={{ ...styles.input, width: 100 }}
                    value={r.kind}
                    onChange={(e) => updateRow(i, { kind: e.target.value as ParsedShiftKind })}
                    title="Row type"
                  >
                    <option value="shift">Shift</option>
                    <option value="vacation">Vacation</option>
                    <option value="sick">Sick</option>
                    <option value="day_off">Day off</option>
                  </select>
                  <span style={{ ...kindChipStyle(r.kind), visibility: r.kind === "shift" ? "hidden" : "visible" }}>{kindChipLabel(r.kind)}</span>
                  <select
                    style={{ ...styles.input, minWidth: 120 }}
                    value={r.staffId ?? ""}
                    onChange={(e) => updateRow(i, { staffId: e.target.value || null, staffName: e.target.value ? (rosterById.get(e.target.value) || r.staffName) : r.staffName })}
                  >
                    <option value="">{needsMatch ? `⚠ ${r.staffName} — pick…` : "— pick —"}</option>
                    {roster.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                  <input
                    type="date"
                    style={{ ...styles.input, width: 130 }}
                    value={r.shiftDate}
                    onChange={(e) => updateRow(i, { shiftDate: e.target.value })}
                  />
                  <input
                    type="time"
                    style={{ ...styles.input, width: 95 }}
                    value={r.startTime}
                    onChange={(e) => updateRow(i, { startTime: e.target.value })}
                  />
                  <span style={{ color: "#888" }}>→</span>
                  <input
                    type="time"
                    style={{ ...styles.input, width: 95 }}
                    value={r.endTime}
                    onChange={(e) => updateRow(i, { endTime: e.target.value })}
                  />
                  <input
                    type="number"
                    style={{ ...styles.input, width: 55 }}
                    value={r.breakMinutes}
                    onChange={(e) => updateRow(i, { breakMinutes: parseInt(e.target.value || "0", 10) })}
                    min={0}
                    title="Break minutes"
                  />
                  {r.confidence != null && r.confidence < 0.7 && (
                    <span style={styles.lowConf} title="Model wasn't sure">⚠</span>
                  )}
                </div>
              );
            })}
          </div>
          <div style={styles.actions}>
            <button style={styles.primaryBtn} onClick={save} disabled={busy === "saving"}>
              {busy === "saving" ? "Saving…" : `✓ Create ${rows.filter((r) => r.include && r.staffId).length} shift${rows.filter((r) => r.include && r.staffId).length === 1 ? "" : "s"}`}
            </button>
            <button style={styles.linkBtn} onClick={() => { setRows(null); }} disabled={busy === "saving"}>
              Back to text
            </button>
          </div>
        </div>
      )}

      {err && <div style={styles.err}>{err}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  strip: { margin: "8px 0 12px" },
  stripBtn: {
    width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px dashed #7c3aed",
    background: "linear-gradient(90deg, #faf5ff, #f5f3ff)", color: "#5b21b6",
    fontSize: 14, fontWeight: 500, cursor: "pointer", textAlign: "left",
  },
  card: {
    margin: "8px 0 16px", padding: 16, borderRadius: 12,
    background: "linear-gradient(180deg, #faf5ff, #fff)", border: "1px solid #ddd6fe",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  title: { fontWeight: 600, fontSize: 15, color: "#5b21b6" },
  closeBtn: { border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "#888" },
  weekLabel: { fontSize: 12, color: "#666", marginBottom: 10 },
  textarea: {
    width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd", fontFamily: "inherit",
    fontSize: 14, resize: "vertical", boxSizing: "border-box",
  },
  examples: { display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0 4px", alignItems: "center" },
  examplesLabel: { fontSize: 12, color: "#666" },
  exampleChip: {
    padding: "4px 10px", borderRadius: 999, border: "1px solid #e5e7eb",
    background: "#fff", fontSize: 12, cursor: "pointer", color: "#555",
  },
  actions: { display: "flex", gap: 8, marginTop: 12, alignItems: "center" },
  primaryBtn: {
    padding: "8px 16px", borderRadius: 8, border: "none",
    background: "#7c3aed", color: "#fff", fontWeight: 500, cursor: "pointer", fontSize: 14,
  },
  linkBtn: { padding: "8px 12px", border: "none", background: "transparent", color: "#666", cursor: "pointer", fontSize: 13 },
  reviewHeader: { fontSize: 12, color: "#555", marginBottom: 8, marginTop: 4 },
  rowsWrap: { display: "flex", flexDirection: "column", gap: 6 },
  row: {
    display: "flex", gap: 6, alignItems: "center", padding: "6px 8px",
    borderRadius: 6, fontSize: 13,
  },
  input: { padding: "4px 6px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, fontFamily: "inherit" },
  lowConf: { color: "#c2410c", fontSize: 14, marginLeft: 4 },
  err: { fontSize: 13, color: "#991b1b", padding: 8, background: "#fee2e2", borderRadius: 6, marginTop: 8 },
};
