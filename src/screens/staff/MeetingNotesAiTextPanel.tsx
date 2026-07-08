// AI text-capture panel for Staff Meetings (v2.2.1).
//
// Free-text meeting notes → structured meeting + action items. Follows
// the same guardrail pattern as ExpenseAiTextPanel:
//   - staff names sent from frontend, model returns free-text names only.
//   - Frontend whitelists names → real staff IDs before saving.
//   - Preview + edit + include-checkbox before commit.

import { useState } from "react";
import { parseMeetingNotes, type ParsedMeeting } from "../../lib/voice";
import { createMeeting, addAction } from "../../lib/meetings";
import type { Staff } from "../../types";

type Row = ParsedMeeting & { include: boolean; resolvedAttendeeIds: number[] };

const EXAMPLES = [
  "Staff meeting yesterday with Priya, Sarah and Anita. Discussed summer program schedule, new drop-off policy, and Priya's request for time off in August. Action: Sarah to draft new drop-off flyer by Friday. Priya to submit vacation form.",
  "Weekly stand-up July 3 — everyone. Reviewed CCFRI renewal deadline (Aug 15), agreed to update parent handbook. Sarah will call licensing about the extra infant spot.",
];

function resolveIds(names: string[], staff: Staff[]): number[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const byName = new Map<string, number>();
  for (const s of staff) {
    byName.set(norm(s.name), s.id);
    const first = norm(s.name.split(/\s+/)[0] ?? "");
    if (first && !byName.has(first)) byName.set(first, s.id);
  }
  const out = new Set<number>();
  for (const n of names) {
    const id = byName.get(norm(n));
    if (id != null) out.add(id);
  }
  return [...out];
}

export default function MeetingNotesAiTextPanel({
  staff, onSaved,
}: { staff: Staff[]; onSaved: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"idle" | "parsing" | "saving">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);

  async function parse() {
    const t = text.trim();
    if (!t) { setErr("Type or paste the meeting notes first."); return; }
    setErr(null); setBusy("parsing"); setRows(null);
    try {
      const res = await parseMeetingNotes({ text: t, staffNames: staff.map((s) => s.name) });
      if (res.meetings.length === 0) {
        setErr("AI couldn't find a meeting in that text. Try including a date, attendees, and what was discussed.");
        setBusy("idle");
        return;
      }
      setRows(res.meetings.map((m) => ({
        ...m, include: true, resolvedAttendeeIds: resolveIds(m.attendees, staff),
      })));
      setBusy("idle");
    } catch (e: any) {
      setErr(String(e?.message ?? e)); setBusy("idle");
    }
  }

  async function save() {
    if (!rows) return;
    const toSave = rows.filter((r) => r.include && r.title.trim());
    if (toSave.length === 0) { setErr("Nothing to save."); return; }
    setBusy("saving"); setErr(null);
    let ok = 0;
    const failed: string[] = [];
    for (const r of toSave) {
      try {
        const id = await createMeeting({
          meeting_date: r.meetingDate,
          title: r.title,
          agenda: r.agenda || undefined,
          notes: r.notes || undefined,
          attendee_ids: r.resolvedAttendeeIds,
        });
        for (const a of r.actionItems) {
          const ownerId = a.owner ? resolveIds([a.owner], staff)[0] ?? null : null;
          if (a.text.trim()) await addAction(id, {
            text: a.text,
            owner_staff_id: ownerId,
            due_date: a.dueDate,
          });
        }
        ok++;
      } catch (e: any) {
        failed.push(`${r.title}: ${String(e?.message ?? e)}`);
      }
    }
    setBusy("idle");
    if (failed.length > 0) {
      setErr(`Saved ${ok}. Failed ${failed.length}: ${failed.slice(0, 2).join(" · ")}`);
    } else {
      setErr(null);
      onSaved();
      setText(""); setRows(null); setExpanded(false);
      window.setTimeout(() => alert(`Saved ${ok} meeting${ok === 1 ? "" : "s"}.`), 50);
    }
  }

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev ? prev.map((r, ix) => ix === i ? { ...r, ...patch } : r) : prev);
  }

  function toggleAttendee(rowIx: number, id: number) {
    setRows((prev) => prev ? prev.map((r, ix) => {
      if (ix !== rowIx) return r;
      const set = new Set(r.resolvedAttendeeIds);
      if (set.has(id)) set.delete(id); else set.add(id);
      return { ...r, resolvedAttendeeIds: [...set] };
    }) : prev);
  }

  if (!expanded) {
    return (
      <div style={styles.strip}>
        <button style={styles.stripBtn} onClick={() => setExpanded(true)}>
          ✨ Type / paste notes in plain English → AI creates the meeting record
        </button>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>✨ AI Meeting Notes</div>
        <button style={styles.closeBtn} onClick={() => { setText(""); setRows(null); setErr(null); setExpanded(false); }} title="Close">✕</button>
      </div>
      <div style={styles.subLabel}>Paste raw notes — date, who attended, discussion, decisions, follow-ups. AI turns them into a meeting record with attendees and action items you review before saving.</div>

      {!rows && (
        <>
          <textarea
            style={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='e.g. "Staff meeting yesterday — Priya, Sarah, Anita. Discussed summer program..."'
            rows={5}
            disabled={busy === "parsing"}
          />
          <div style={styles.examples}>
            <span style={styles.examplesLabel}>Try:</span>
            {EXAMPLES.map((ex, i) => (
              <button key={i} style={styles.exampleChip} onClick={() => setText(ex)} disabled={busy === "parsing"} title={ex}>
                Example {i + 1}
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
            Review {rows.length} meeting{rows.length === 1 ? "" : "s"}. Uncheck to skip; edit any field before saving.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ ...styles.row, background: "#fdfaff", opacity: r.include ? 1 : 0.5 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={r.include}
                    onChange={(e) => updateRow(i, { include: e.target.checked })}
                  />
                  <strong style={{ fontSize: 13 }}>Include</strong>
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 8, marginBottom: 8 }}>
                  <input type="text" style={styles.input} value={r.title}
                    onChange={(e) => updateRow(i, { title: e.target.value })} placeholder="Meeting title" />
                  <input type="date" style={styles.input} value={r.meetingDate}
                    onChange={(e) => updateRow(i, { meetingDate: e.target.value })} />
                </div>
                <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Attendees ({r.resolvedAttendeeIds.length})</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                  {staff.map((s) => {
                    const on = r.resolvedAttendeeIds.includes(s.id);
                    return (
                      <button key={s.id} type="button"
                        onClick={() => toggleAttendee(i, s.id)}
                        style={{ ...styles.chip, background: on ? "#7c3aed" : "#fff", color: on ? "#fff" : "#333", borderColor: on ? "#7c3aed" : "#ddd" }}>
                        {s.name}{on ? " ✓" : ""}
                      </button>
                    );
                  })}
                </div>
                {r.attendees.length > 0 && r.resolvedAttendeeIds.length < r.attendees.length && (
                  <div style={{ fontSize: 11, color: "#b45309", marginBottom: 6 }}>
                    ⚠ Model mentioned: {r.attendees.join(", ")}. Only listed staff can be attendees — please tick the correct ones above.
                  </div>
                )}
                <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Agenda</div>
                <textarea style={{ ...styles.input, width: "100%", boxSizing: "border-box", marginBottom: 8 }} rows={2}
                  value={r.agenda} onChange={(e) => updateRow(i, { agenda: e.target.value })} />
                <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Notes</div>
                <textarea style={{ ...styles.input, width: "100%", boxSizing: "border-box", marginBottom: 8 }} rows={4}
                  value={r.notes} onChange={(e) => updateRow(i, { notes: e.target.value })} />
                <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>
                  Action items ({r.actionItems.length})
                </div>
                {r.actionItems.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#888", fontStyle: "italic" }}>No action items detected.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {r.actionItems.map((a, ai) => (
                      <div key={ai} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="text" style={{ ...styles.input, flex: 1 }} value={a.text}
                          onChange={(e) => updateRow(i, { actionItems: r.actionItems.map((x, xi) => xi === ai ? { ...x, text: e.target.value } : x) })} />
                        <input type="text" style={{ ...styles.input, width: 100 }} placeholder="Owner"
                          value={a.owner || ""} onChange={(e) => updateRow(i, { actionItems: r.actionItems.map((x, xi) => xi === ai ? { ...x, owner: e.target.value || null } : x) })} />
                        <input type="date" style={{ ...styles.input, width: 130 }}
                          value={a.dueDate || ""} onChange={(e) => updateRow(i, { actionItems: r.actionItems.map((x, xi) => xi === ai ? { ...x, dueDate: e.target.value || null } : x) })} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={styles.actions}>
            <button style={styles.primaryBtn} onClick={save} disabled={busy === "saving"}>
              {busy === "saving" ? "Saving…" : `✓ Save ${rows.filter((r) => r.include).length} meeting${rows.filter((r) => r.include).length === 1 ? "" : "s"}`}
            </button>
            <button style={styles.linkBtn} onClick={() => { setRows(null); }} disabled={busy === "saving"}>Back to text</button>
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
  closeBtn: { border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "#888" },
  card: { margin: "8px 0 16px", padding: 16, borderRadius: 12, background: "linear-gradient(180deg, #faf5ff, #fff)", border: "1px solid #ddd6fe" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  title: { fontWeight: 600, fontSize: 15, color: "#5b21b6" },
  subLabel: { fontSize: 12, color: "#666", marginBottom: 10 },
  textarea: { width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd", fontFamily: "inherit", fontSize: 14, resize: "vertical", boxSizing: "border-box" },
  examples: { display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0 4px", alignItems: "center" },
  examplesLabel: { fontSize: 12, color: "#666" },
  exampleChip: { padding: "4px 10px", borderRadius: 999, border: "1px solid #e5e7eb", background: "#fff", fontSize: 12, cursor: "pointer", color: "#555" },
  actions: { display: "flex", gap: 8, marginTop: 12, alignItems: "center" },
  primaryBtn: { padding: "8px 16px", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 500, cursor: "pointer", fontSize: 14 },
  linkBtn: { padding: "8px 12px", border: "none", background: "transparent", color: "#666", cursor: "pointer", fontSize: 13 },
  reviewHeader: { fontSize: 12, color: "#555", marginBottom: 8, marginTop: 4 },
  row: { padding: 12, borderRadius: 8, border: "1px solid #e5e7eb" },
  input: { padding: "4px 6px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, fontFamily: "inherit" },
  chip: { padding: "3px 10px", borderRadius: 999, border: "1px solid #ddd", fontSize: 12, cursor: "pointer" },
  err: { fontSize: 13, color: "#991b1b", padding: 8, background: "#fee2e2", borderRadius: 6, marginTop: 8 },
};
