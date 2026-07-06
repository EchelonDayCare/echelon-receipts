// Voice capture for the Organizer module (v1.8.0).
//
// Three concerns:
//   1. Browser MediaRecorder wrapper — start/stop, blob → base64.
//   2. Rust IPC wrappers for `transcribe_audio` + `parse_organizer_event`.
//   3. Audit-log helper that writes an entry to `organizer_ai_events` for
//      every round-trip (transcribe / parse / error), hashing the prompt
//      by default and only storing raw text when the owner opted in.
import { invoke } from "@tauri-apps/api/core";
import { db, execRetry, getSettings } from "./db";

// ─── Types ───────────────────────────────────────────────────────────────

export type OrganizerEventKind = "meeting" | "followup" | "action_item";
export type OrganizerPriority = "low" | "normal" | "high";

export type ParsedOrganizerEvent = {
  kind: OrganizerEventKind;
  title: string;
  /** YYYY-MM-DD or null */
  date: string | null;
  /** HH:MM 24-hour or null */
  time: string | null;
  durationMin: number | null;
  participants: string[];
  notes: string;
  priority: OrganizerPriority | null;
  confidence: number | null;
};

type RustParsedEvent = {
  kind: OrganizerEventKind;
  title: string;
  date: string | null;
  time: string | null;
  duration_min: number | null;
  participants: string[];
  notes: string;
  priority: OrganizerPriority | null;
  confidence: number | null;
};

// ─── MediaRecorder wrapper ───────────────────────────────────────────────

export type Recorder = {
  stop: () => Promise<{ blob: Blob; mimeType: string }>;
  cancel: () => void;
};

/**
 * Start a MediaRecorder-backed capture. Caller must call `.stop()` (returns
 * the audio blob) or `.cancel()` (discards and releases the mic).
 *
 * Throws if the browser has no MediaRecorder support or the user denied
 * microphone permission.
 */
export async function startRecording(): Promise<Recorder> {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Voice capture isn't supported on this system.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // Prefer opus/webm — Whisper handles it and it's what Chromium ships.
  const preferred = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  const mimeType = preferred.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  rec.start();

  let settled = false;
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        rec.onstop = () => {
          settled = true;
          stream.getTracks().forEach((t) => t.stop());
          const type = rec.mimeType || mimeType || "audio/webm";
          resolve({ blob: new Blob(chunks, { type }), mimeType: type });
        };
        rec.onerror = (e) => { settled = true; stream.getTracks().forEach((t) => t.stop()); reject(e); };
        try { rec.stop(); } catch (e) { reject(e); }
      }),
    cancel: () => {
      if (settled) return;
      try { rec.stop(); } catch { /* ignore */ }
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// ─── IPC wrappers ────────────────────────────────────────────────────────

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked to avoid stack overflow on large clips.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/**
 * Transcribe an audio blob via the configured Azure Whisper deployment.
 * Reads the endpoint URL from settings (`azure_whisper_endpoint`); the
 * API key stays in the OS keychain and is resolved server-side.
 */
export async function transcribeAudio(blob: Blob, mimeType: string): Promise<{ text: string; latencyMs: number }> {
  const endpoint = ((await getSettings())["azure_whisper_endpoint"] ?? "").toString();
  if (!endpoint.trim()) {
    throw new Error("Whisper endpoint isn't configured. Open Settings → AI to paste your Azure Whisper URL.");
  }
  const audio_b64 = await blobToBase64(blob);
  const res = await invoke<{ text: string; latency_ms: number }>("transcribe_audio", {
    args: { endpoint_url: endpoint, audio_b64, mime_type: mimeType },
  });
  return { text: res.text, latencyMs: res.latency_ms };
}

/**
 * Parse a dictation transcript into a structured Organizer draft. The
 * caller supplies the current local time so relative phrases resolve
 * correctly — never trust the model's own idea of "now".
 */
export async function parseOrganizerEvent(transcript: string): Promise<{
  event: ParsedOrganizerEvent;
  latencyMs: number;
  rawJson: string;
}> {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const nowIso = toLocalIso(now);
  const res = await invoke<{ event: RustParsedEvent; latency_ms: number; raw_json: string }>(
    "parse_organizer_event",
    { args: { transcript, now_iso: nowIso, tz } },
  );
  return {
    event: {
      kind: res.event.kind,
      title: res.event.title,
      date: res.event.date,
      time: res.event.time,
      durationMin: res.event.duration_min,
      participants: res.event.participants,
      notes: res.event.notes,
      priority: res.event.priority,
      confidence: res.event.confidence,
    },
    latencyMs: res.latency_ms,
    rawJson: res.raw_json,
  };
}

/**
 * ISO-8601 with local offset. Node/browser `toISOString` returns UTC
 * (drops the offset), which the model can still handle but is harder to
 * reason about — a local-offset string matches the `now_iso` contract in
 * `voice.rs`.
 */
export function toLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const offStr = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offStr}`
  );
}

// ─── Audit trail ─────────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const enc = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Append a row to `organizer_ai_events` recording one round-trip. The
 * transcript is only stored in full when `organizer_ai_store_transcripts`
 * is enabled; otherwise only a sha256 hash goes to disk.
 */
export async function logOrganizerAiEvent(entry: {
  kind: "transcribe" | "parse" | "error";
  prompt: string;
  response?: string;
  latencyMs?: number;
  error?: string;
}): Promise<void> {
  try {
    const storeRaw = ((await getSettings())["organizer_ai_store_transcripts"] ?? "") === "1";
    const hash = entry.prompt ? await sha256Hex(entry.prompt) : null;
    await execRetry(
      `INSERT INTO organizer_ai_events (kind, prompt_hash, prompt_text, response_text, latency_ms, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.kind,
        hash,
        storeRaw ? entry.prompt : null,
        entry.response ?? null,
        entry.latencyMs ?? null,
        entry.error ?? null,
      ],
    );
  } catch (e) {
    // Audit failures should never break the primary workflow.
    console.warn("[voice] audit log failed:", e);
  }
}

// ─── Test-hook helper ────────────────────────────────────────────────────

/** Non-DB helper: does the settings map indicate voice is enabled + configured? */
export function isVoiceConfigured(settings: Record<string, string>): boolean {
  return (
    (settings.voice_organizer_enabled ?? "1") === "1" &&
    !!(settings.azure_whisper_endpoint || "").trim() &&
    (settings.azure_whisper_key_set || "") === "1"
  );
}

/** Placeholder to keep the db import used — the audit table exists as of migration 025. */
export async function _ping(): Promise<void> { await db(); }
