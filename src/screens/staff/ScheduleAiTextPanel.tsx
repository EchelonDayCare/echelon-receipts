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
import { parseStaffShifts, type ParsedShift } from "../../lib/voice";
import { createShift } from "../../repo/scheduleRepo";

type Row = ParsedShift & { include: boolean; err?: string };

const EXAMPLES = [
  "Priya morning 7-2 Mon-Fri, no lunch",
  "Sarah closing 2-6 Wed and Thu",
  "Anita full day Saturday, Ravi covers Sunday morning",
];

export default function ScheduleAiTextPanel({
  weekStartIso,
  roster,
  onSaved,
}: {
  weekStartIso: string;
  roster: Array<{ id: string; name: string }>;
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
      const res = await parseStaffShifts({ text: t, weekStartIso, roster });
      if (res.shifts.length === 0) {
        setErr("AI couldn't find any shifts in that text. Try being more explicit — include a name, day, and time.");
        setBusy("idle");
        return;
      }
      // One-shift-per-person-per-day: if the AI produced multiple shifts for
      // the same (staff, date), auto-uncheck the extras and warn the owner.
      // The rule matches the underlying DB constraint in createShift, so the
      // save would fail anyway — telling the user up front is friendlier.
      const seen = new Set<string>();
      const dupeNames: string[] = [];
      const marked: Row[] = res.shifts.map((s) => {
        const key = `${s.staffId ?? "?"}|${s.shiftDate}`;
        const isDup = !!s.staffId && seen.has(key);
        if (s.staffId) seen.add(key);
        if (isDup) dupeNames.push(`${s.staffName} on ${s.shiftDate}`);
        return { ...s, include: !isDup };
      });
      setRows(marked);
      setBusy("idle");
      if (dupeNames.length > 0) {
        const uniq = Array.from(new Set(dupeNames));
        window.setTimeout(() => alert(
          `Heads up — one staff member can only have one shift per day.\n\n` +
          `AI produced duplicate shifts for:\n• ${uniq.join("\n• ")}\n\n` +
          `Only the first shift for each person+day is checked. Edit or uncheck as needed before saving.`,
        ), 50);
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
    let ok = 0;
    const failed: string[] = [];
    for (const r of toSave) {
      try {
        await createShift({
          staffId: r.staffId!,
          shiftDate: r.shiftDate,
          startTime: r.startTime,
          endTime: r.endTime,
          room: r.room,
          breakMinutes: r.breakMinutes,
          notes: r.notes,
          status: "planned",
        });
        ok++;
      } catch (e: any) {
        failed.push(`${r.staffName} ${r.shiftDate}: ${String(e?.message ?? e)}`);
      }
    }
    setBusy("idle");
    if (failed.length > 0) {
      setErr(`Saved ${ok}. Failed ${failed.length}: ${failed.slice(0, 3).join(" · ")}`);
    } else {
      const msg = skipped > 0 ? `Saved ${ok}. Skipped ${skipped}.` : `Saved ${ok}.`;
      setErr(null);
      onSaved();
      setText(""); setRows(null);
      window.setTimeout(() => alert(msg), 50);
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
