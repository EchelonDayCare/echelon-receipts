// Voice Capture Modal — the whole tap → record → transcribe → parse →
// confirm → save loop for the Organizer (v1.8.0).
//
// State machine:
//   idle → recording → transcribing → parsing → review → saving → done
//                    ↘ error  (any stage)
// User can Cancel from any stage; Cancel from `review` discards the draft.
import { useEffect, useRef, useState } from "react";
import {
  startRecording,
  transcribeAudio,
  parseOrganizerEvent,
  logOrganizerAiEvent,
  isVoiceConfigured,
  type ParsedOrganizerEvent,
  type OrganizerEventKind,
  type OrganizerPriority,
  type Recorder,
} from "../lib/voice";
import { getSettings } from "../lib/db";
import { createMeeting, type MeetingKind } from "../repo/meetingsRepo";
import { createFollowup, type Priority } from "../repo/followupsRepo";

type Stage = "idle" | "recording" | "transcribing" | "parsing" | "review" | "saving" | "done" | "error";

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export default function VoiceCaptureModal({ open, onClose, onSaved }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [errMsg, setErrMsg] = useState<string>("");
  const [transcript, setTranscript] = useState<string>("");
  const [draft, setDraft] = useState<ParsedOrganizerEvent | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [recSecs, setRecSecs] = useState(0);

  const recRef = useRef<Recorder | null>(null);
  const timerRef = useRef<number | null>(null);

  // Reset + config check on open.
  useEffect(() => {
    if (!open) return;
    setStage("idle"); setErrMsg(""); setTranscript(""); setDraft(null); setRecSecs(0);
    (async () => {
      const s = await getSettings();
      setConfigured(isVoiceConfigured(s));
    })();
  }, [open]);

  // Clean up on unmount / close.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      recRef.current?.cancel();
    };
  }, []);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleClose() {
    recRef.current?.cancel();
    recRef.current = null;
    if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; }
    onClose();
  }

  async function startRec() {
    setErrMsg(""); setTranscript(""); setDraft(null); setRecSecs(0);
    try {
      recRef.current = await startRecording();
      setStage("recording");
      timerRef.current = window.setInterval(() => setRecSecs((s) => s + 1), 1000);
    } catch (e: any) {
      setStage("error");
      setErrMsg(e?.message ? String(e.message) : "Microphone permission denied.");
    }
  }

  async function stopAndProcess() {
    if (!recRef.current) return;
    if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; }
    setStage("transcribing");
    try {
      const { blob, mimeType } = await recRef.current.stop();
      recRef.current = null;
      const tr = await transcribeAudio(blob, mimeType);
      setTranscript(tr.text);
      await logOrganizerAiEvent({ kind: "transcribe", prompt: tr.text, latencyMs: tr.latencyMs });
      if (!tr.text.trim()) {
        setStage("error");
        setErrMsg("Nothing was heard. Please try again in a quieter spot.");
        return;
      }
      setStage("parsing");
      const parsed = await parseOrganizerEvent(tr.text);
      await logOrganizerAiEvent({
        kind: "parse", prompt: tr.text, response: parsed.rawJson, latencyMs: parsed.latencyMs,
      });
      setDraft(parsed.event);
      setStage("review");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setStage("error");
      setErrMsg(msg);
      await logOrganizerAiEvent({ kind: "error", prompt: transcript, error: msg });
    }
  }

  async function save() {
    if (!draft) return;
    setStage("saving");
    try {
      const dateStr = draft.date && draft.date.trim() ? draft.date : new Date().toISOString().slice(0, 10);
      const titleTrimmed = draft.title.trim() || "Untitled";
      const attendees = draft.participants.filter((p) => p.trim()).join(", ") || null;
      const notes = draft.notes.trim() || null;

      if (draft.kind === "meeting") {
        await createMeeting({
          meetingDate: dateStr,
          meetingTime: draft.time || null,
          kind: guessMeetingKind(titleTrimmed, attendees),
          subject: titleTrimmed,
          attendeesText: attendees,
          linkedKind: null,
          linkedId: null,
          notesMd: notes,
        });
      } else if (draft.kind === "followup") {
        await createFollowup({
          title: titleTrimmed,
          dueDate: draft.date || null,
          priority: (draft.priority ?? "normal") as Priority,
          notes,
        });
      } else {
        // action_item: model to a followup for now — the meetings.action
        // table requires a parent meeting. Action-without-meeting maps
        // cleanly onto the followups panel.
        await createFollowup({
          title: titleTrimmed,
          dueDate: draft.date || null,
          priority: (draft.priority ?? "normal") as Priority,
          notes: notes ? `[action] ${notes}` : "[action]",
        });
      }
      setStage("done");
      onSaved();
      // Auto-close on success.
      window.setTimeout(handleClose, 700);
    } catch (e: any) {
      setStage("error");
      setErrMsg(String(e?.message ?? e));
    }
  }

  if (!open) return null;

  return (
    <div style={backdropStyle} onClick={handleClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>🎤 Voice capture</h2>
          <button className="btn" onClick={handleClose} title="Close" style={{ fontSize: 13 }}>✕</button>
        </div>

        {configured === false && (
          <div style={warnBox}>
            Voice capture isn't set up yet. Open <b>Configuration → Staff</b> and paste your Azure Whisper endpoint URL and API key under Voice capture.
          </div>
        )}

        {stage === "idle" && configured !== false && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <p style={{ marginTop: 0, color: "var(--muted)" }}>
              Tap the mic and say something like:
            </p>
            <p style={{ fontStyle: "italic", color: "var(--muted)", marginTop: 4 }}>
              "Meeting with Daisy tomorrow at 11 for 30 minutes"
              <br />
              "Remind me to call the plumber next Wednesday"
            </p>
            <button style={micStyle(false)} onClick={startRec}>🎤</button>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>Tap to start recording</div>
          </div>
        )}

        {stage === "recording" && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <button style={micStyle(true)} onClick={stopAndProcess}>■</button>
            <div style={{ marginTop: 12, fontSize: 16, fontWeight: 500 }}>Recording… {fmtSecs(recSecs)}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted)" }}>Tap to stop</div>
          </div>
        )}

        {(stage === "transcribing" || stage === "parsing" || stage === "saving") && (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <div style={spinnerStyle} />
            <div style={{ marginTop: 12, fontSize: 14, color: "var(--muted)" }}>
              {stage === "transcribing" && "Transcribing…"}
              {stage === "parsing" && "Understanding…"}
              {stage === "saving" && "Saving…"}
            </div>
          </div>
        )}

        {stage === "review" && draft && (
          <DraftForm
            draft={draft}
            transcript={transcript}
            onChange={setDraft}
            onCancel={handleClose}
            onSave={save}
          />
        )}

        {stage === "done" && (
          <div style={{ textAlign: "center", padding: "30px 0", color: "var(--success, #16a34a)" }}>
            ✓ Saved
          </div>
        )}

        {stage === "error" && (
          <div>
            <div style={errBox}>{errMsg || "Something went wrong."}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={handleClose}>Close</button>
              <button className="btn primary" onClick={startRec}>Try again</button>
            </div>
          </div>
        )}
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

function fmtSecs(n: number) {
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Draft review form ───────────────────────────────────────────────────

function DraftForm({
  draft, transcript, onChange, onCancel, onSave,
}: {
  draft: ParsedOrganizerEvent;
  transcript: string;
  onChange: (d: ParsedOrganizerEvent) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof ParsedOrganizerEvent>(k: K, v: ParsedOrganizerEvent[K]) =>
    onChange({ ...draft, [k]: v });

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Heard</div>
      <div style={transcriptBox}>{transcript}</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div className="field">
          <label>Type</label>
          <select
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value as OrganizerEventKind)}
          >
            <option value="meeting">Meeting</option>
            <option value="followup">Follow-up</option>
            <option value="action_item">Action item</option>
          </select>
        </div>
        <div className="field">
          <label>Priority</label>
          <select
            value={draft.priority ?? "normal"}
            onChange={(e) => set("priority", e.target.value as OrganizerPriority)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      <div className="field" style={{ marginBottom: 10 }}>
        <label>Title</label>
        <input value={draft.title} onChange={(e) => set("title", e.target.value)} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div className="field">
          <label>Date</label>
          <input type="date" value={draft.date ?? ""} onChange={(e) => set("date", e.target.value || null)} />
        </div>
        <div className="field">
          <label>Time</label>
          <input type="time" value={draft.time ?? ""} onChange={(e) => set("time", e.target.value || null)} />
        </div>
        <div className="field">
          <label>Duration (min)</label>
          <input
            type="number" min={0} step={15}
            value={draft.durationMin ?? ""}
            onChange={(e) => set("durationMin", e.target.value ? Number(e.target.value) : null)}
          />
        </div>
      </div>

      <div className="field" style={{ marginBottom: 10 }}>
        <label>Participants</label>
        <input
          value={draft.participants.join(", ")}
          onChange={(e) => set("participants", e.target.value.split(",").map((p) => p.trim()).filter(Boolean))}
          placeholder="Comma-separated"
        />
      </div>

      <div className="field" style={{ marginBottom: 10 }}>
        <label>Notes</label>
        <textarea rows={3} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
      </div>

      {typeof draft.confidence === "number" && draft.confidence < 0.7 && (
        <div style={warnBox}>
          Model confidence is low ({(draft.confidence * 100).toFixed(0)}%). Please double-check the fields above.
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={onSave}>Save</button>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(15, 23, 42, .55)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};
const modalStyle: React.CSSProperties = {
  background: "var(--panel, #ffffff)",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 14,
  boxShadow: "0 20px 50px rgba(0,0,0,.25)",
  width: "min(560px, 92vw)",
  padding: 20,
  maxHeight: "90vh",
  overflowY: "auto",
};
const errBox: React.CSSProperties = {
  background: "rgba(220, 38, 38, .08)",
  border: "1px solid rgba(220, 38, 38, .3)",
  color: "#b91c1c",
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 13,
};
const warnBox: React.CSSProperties = {
  background: "rgba(245, 158, 11, .08)",
  border: "1px solid rgba(245, 158, 11, .3)",
  color: "#b45309",
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 13,
  marginBottom: 10,
};
const transcriptBox: React.CSSProperties = {
  background: "var(--muted-bg, #f1f5f9)",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 8, padding: "10px 12px", fontSize: 13,
  fontStyle: "italic", color: "var(--fg, #0f172a)", marginBottom: 14,
};
const spinnerStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: "50%",
  border: "3px solid var(--border, #e2e8f0)",
  borderTopColor: "var(--accent, #7c3aed)",
  animation: "spin 0.8s linear infinite",
  display: "inline-block",
};
function micStyle(active: boolean): React.CSSProperties {
  return {
    width: 96, height: 96, borderRadius: "50%", border: 0,
    fontSize: 36, color: "#fff", cursor: "pointer",
    background: active
      ? "linear-gradient(135deg, #dc2626, #b91c1c)"
      : "linear-gradient(135deg, #7c3aed, #2563eb)",
    boxShadow: active
      ? "0 0 0 8px rgba(220,38,38,.18)"
      : "0 8px 24px rgba(124,58,237,.35)",
    animation: active ? "pulse 1.2s ease-in-out infinite" : "none",
    transition: "transform .1s",
  };
}
