// AI text-capture panel for the Organizer page (v2.1.1).
//
// Sibling of VoiceCaptureModal: instead of mic → transcribe → parse, this
// takes typed English straight into parseOrganizerEvent. Whisper being
// broken on Mac (v2.1.0 discovery) motivated splitting the two paths — the
// parser has always been the reliable half.
//
// UI is a collapsible strip that lives above the Upcoming panel. When
// collapsed it's a single hint button. When expanded it exposes a
// textarea, examples, and a "✨ Parse" action. After parse, an in-place
// review card lets the user tweak the draft before saving. On save it
// writes via the existing createMeeting / createFollowup repos — no new
// write paths, so the audit trail continues to work.

import { useState } from "react";
import {
  parseOrganizerEvent,
  logOrganizerAiEvent,
  type ParsedOrganizerEvent,
  type OrganizerEventKind,
  type OrganizerPriority,
} from "../../lib/voice";
import { createMeeting, type MeetingKind } from "../../repo/meetingsRepo";
import { createFollowup, type Priority } from "../../repo/followupsRepo";

type Stage = "idle" | "parsing" | "review" | "saving" | "done" | "error";

const EXAMPLES = [
  "Meeting with Ravi's mom Thursday 3pm about biting incident, 30 min",
  "Remind me to renew Anita's first aid cert by end of next month",
  "Need to order new craft supplies before Friday — high priority",
  "Board meeting next Tuesday 7pm at daycare, agenda: budget review",
];

export default function OrganizerAiTextPanel({ onSaved }: { onSaved: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<ParsedOrganizerEvent | null>(null);

  async function parse() {
    const t = text.trim();
    if (!t) { setErr("Type something first."); return; }
    setErr(null); setStage("parsing");
    try {
      const res = await parseOrganizerEvent(t);
      await logOrganizerAiEvent({ kind: "parse", prompt: t, response: res.rawJson, latencyMs: res.latencyMs });
      setDraft(res.event);
      setStage("review");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(msg); setStage("error");
      await logOrganizerAiEvent({ kind: "error", prompt: t, error: msg });
    }
  }

  async function save() {
    if (!draft) return;
    setStage("saving");
    try {
      const dateStr = draft.date && draft.date.trim() ? draft.date : new Date().toISOString().slice(0, 10);
      const title = draft.title.trim() || "Untitled";
      const attendees = draft.participants.filter((p) => p.trim()).join(", ") || null;
      const notes = draft.notes.trim() || null;
      if (draft.kind === "meeting") {
        await createMeeting({
          meetingDate: dateStr,
          meetingTime: draft.time || null,
          kind: guessMeetingKind(title, attendees),
          subject: title,
          attendeesText: attendees,
          linkedKind: null,
          linkedId: null,
          notesMd: notes,
        });
      } else if (draft.kind === "followup") {
        await createFollowup({
          title, dueDate: draft.date || null,
          priority: (draft.priority ?? "normal") as Priority, notes,
        });
      } else {
        await createFollowup({
          title, dueDate: draft.date || null,
          priority: (draft.priority ?? "normal") as Priority,
          notes: notes ? `[action] ${notes}` : "[action]",
        });
      }
      setStage("done");
      onSaved();
      window.setTimeout(() => reset(), 900);
    } catch (e: any) {
      setStage("error"); setErr(String(e?.message ?? e));
    }
  }

  function reset() {
    setText(""); setDraft(null); setStage("idle"); setErr(null);
  }

  if (!expanded) {
    return (
      <div style={styles.strip}>
        <button style={styles.stripBtn} onClick={() => setExpanded(true)}>
          ✨ Type in plain English → AI schedules it
        </button>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>✨ AI Quick Capture</div>
        <button style={styles.closeBtn} onClick={() => { reset(); setExpanded(false); }} title="Close">✕</button>
      </div>

      {stage !== "review" && (
        <>
          <textarea
            style={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Meeting with Ravi's mom Thursday 3pm about biting incident, 30 min"
            rows={3}
            disabled={stage === "parsing" || stage === "saving"}
          />
          <div style={styles.examples}>
            <span style={styles.examplesLabel}>Try:</span>
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                style={styles.exampleChip}
                onClick={() => setText(ex)}
                disabled={stage === "parsing"}
              >
                {ex.length > 55 ? ex.slice(0, 55) + "…" : ex}
              </button>
            ))}
          </div>
          <div style={styles.actions}>
            <button
              style={styles.primaryBtn}
              onClick={parse}
              disabled={stage === "parsing" || !text.trim()}
            >
              {stage === "parsing" ? "Thinking…" : "✨ Parse with AI"}
            </button>
            <button style={styles.linkBtn} onClick={reset} disabled={stage === "parsing"}>Clear</button>
          </div>
        </>
      )}

      {stage === "review" && draft && (
        <DraftReview
          draft={draft}
          onChange={setDraft}
          onCancel={reset}
          onSave={save}
        />
      )}
      {stage === "saving" && <div style={styles.info}>Saving…</div>}
      {stage === "done" && <div style={styles.success}>✓ Saved.</div>}
      {err && stage === "error" && <div style={styles.err}>{err}</div>}
    </div>
  );
}

function DraftReview({
  draft, onChange, onCancel, onSave,
}: {
  draft: ParsedOrganizerEvent;
  onChange: (d: ParsedOrganizerEvent) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<ParsedOrganizerEvent>) => onChange({ ...draft, ...patch });
  return (
    <div style={styles.review}>
      <div style={styles.reviewBadge}>
        {draft.confidence != null && (
          <span style={{ ...styles.confidence, color: draft.confidence >= 0.7 ? "#166534" : "#92400e" }}>
            AI confidence: {Math.round((draft.confidence ?? 0) * 100)}%
          </span>
        )}
      </div>
      <div style={styles.row}>
        <label style={styles.label}>Type</label>
        <select
          style={styles.input}
          value={draft.kind}
          onChange={(e) => set({ kind: e.target.value as OrganizerEventKind })}
        >
          <option value="meeting">Meeting</option>
          <option value="followup">Follow-up</option>
          <option value="action_item">Action item</option>
        </select>
      </div>
      <div style={styles.row}>
        <label style={styles.label}>Title</label>
        <input style={styles.input} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ ...styles.row, flex: 1 }}>
          <label style={styles.label}>Date</label>
          <input style={styles.input} type="date" value={draft.date ?? ""} onChange={(e) => set({ date: e.target.value || null })} />
        </div>
        <div style={{ ...styles.row, flex: 1 }}>
          <label style={styles.label}>Time</label>
          <input style={styles.input} type="time" value={draft.time ?? ""} onChange={(e) => set({ time: e.target.value || null })} />
        </div>
        {draft.kind !== "meeting" && (
          <div style={{ ...styles.row, flex: 1 }}>
            <label style={styles.label}>Priority</label>
            <select
              style={styles.input}
              value={draft.priority ?? "normal"}
              onChange={(e) => set({ priority: e.target.value as OrganizerPriority })}
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>
        )}
      </div>
      {draft.kind === "meeting" && (
        <div style={styles.row}>
          <label style={styles.label}>Attendees</label>
          <input
            style={styles.input}
            value={draft.participants.join(", ")}
            onChange={(e) => set({ participants: e.target.value.split(",").map((p) => p.trim()).filter(Boolean) })}
          />
        </div>
      )}
      <div style={styles.row}>
        <label style={styles.label}>Notes</label>
        <textarea style={{ ...styles.input, minHeight: 56 }} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
      </div>
      <div style={styles.actions}>
        <button style={styles.primaryBtn} onClick={onSave}>✓ Save</button>
        <button style={styles.linkBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function guessMeetingKind(title: string, attendees: string | null): MeetingKind {
  const hay = `${title} ${attendees || ""}`.toLowerCase();
  if (/\b(board|agm|director|trustee)\b/.test(hay)) return "board";
  if (/\b(parent|mom|dad|mother|father|guardian|family)\b/.test(hay)) return "parent";
  if (/\b(staff|teacher|educator|team)\b/.test(hay)) return "staff";
  if (/\b(vendor|contractor|supplier|inspect(or|ion)|plumber|electrician)\b/.test(hay)) {
    return /\binspect/.test(hay) ? "inspection" : "vendor";
  }
  return "other";
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
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  title: { fontWeight: 600, fontSize: 15, color: "#5b21b6" },
  closeBtn: { border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "#888" },
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
  actions: { display: "flex", gap: 8, marginTop: 10, alignItems: "center" },
  primaryBtn: {
    padding: "8px 16px", borderRadius: 8, border: "none",
    background: "#7c3aed", color: "#fff", fontWeight: 500, cursor: "pointer", fontSize: 14,
  },
  linkBtn: { padding: "8px 12px", border: "none", background: "transparent", color: "#666", cursor: "pointer", fontSize: 13 },
  review: { display: "flex", flexDirection: "column", gap: 10 },
  reviewBadge: { display: "flex", justifyContent: "flex-end" },
  confidence: { fontSize: 12, fontWeight: 500 },
  row: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 12, color: "#666", fontWeight: 500 },
  input: { padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", fontSize: 14, fontFamily: "inherit" },
  info: { fontSize: 13, color: "#666", padding: 8 },
  success: { fontSize: 13, color: "#166534", padding: 8, background: "#dcfce7", borderRadius: 6, marginTop: 8 },
  err: { fontSize: 13, color: "#991b1b", padding: 8, background: "#fee2e2", borderRadius: 6, marginTop: 8 },
};
