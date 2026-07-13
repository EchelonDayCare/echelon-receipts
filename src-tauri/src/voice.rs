// Voice capture for the Organizer module (v1.8.0).
//
//   1. `transcribe_audio` — POSTs a browser-recorded audio blob to the
//      user-configured Azure Whisper deployment and returns the transcript
//      text. Endpoint URL comes over IPC (non-secret, per H-7); the API key
//      is fetched server-side from the OS keychain under
//      `azure_whisper_key`.
//
//   2. `parse_organizer_event` — feeds a transcript to the existing Azure
//      OpenAI chat deployment and returns a strictly-typed draft:
//        { kind: "meeting"|"followup"|"action_item",
//          title, date (yyyy-mm-dd|null), time (HH:MM|null),
//          duration_min, participants[], notes, priority }
//      Consumer confirms and saves via the existing repos — Rust never
//      writes to the DB directly.
//
// Both commands:
//   * validate the endpoint / MIME / size via `azure_url_guard`
//   * redact the API key from error strings before returning
//   * reuse `azure_ai_key` (piggy-back per reviewer guidance — one key,
//     one Settings tab, same threat model).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::azure_url_guard::{validate_audio_mime, validate_audio_size_b64, validate_azure_endpoint};

// Same as ask_echelon.rs — the chat deployment lives on our shared
// resource. Reused rather than duplicated so a future rename in one place
// forces the caller to see the other.
const AZURE_CHAT_ENDPOINT: &str = "https://ai-nse.openai.azure.com";
const CHAT_DEPLOY: &str = "gpt-4.1";
const CHAT_API_VER: &str = "2025-04-01-preview";

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

fn redact(s: String, secret: &str) -> String {
    if secret.is_empty() { return s; }
    s.replace(secret, "***")
}

// ─── transcribe_audio ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TranscribeArgs {
    /// Full Azure Whisper endpoint URL including deployment + api-version,
    /// e.g. https://X.cognitiveservices.azure.com/openai/deployments/whisper/audio/translations?api-version=2024-06-01
    pub endpoint_url: String,
    /// Base64-encoded audio payload from MediaRecorder.
    pub audio_b64: String,
    /// MIME type reported by MediaRecorder (audio/webm, audio/mp4, etc.).
    pub mime_type: String,
    /// Optional filename hint (Whisper uses the extension to sniff format).
    pub filename: Option<String>,
}

#[derive(Serialize)]
pub struct TranscribeResult {
    pub text: String,
    pub latency_ms: u64,
}

#[tauri::command]
pub async fn transcribe_audio(args: TranscribeArgs) -> Result<TranscribeResult, String> {
    let endpoint = validate_azure_endpoint(&args.endpoint_url)?;
    validate_audio_mime(&args.mime_type)?;
    validate_audio_size_b64(&args.audio_b64)?;

    let api_key = crate::secrets::get_secret("azure_whisper_key")?;

    // Decode base64 → raw bytes. Whisper expects binary multipart, not a
    // data-URL.
    use base64::Engine;
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(args.audio_b64.as_bytes())
        .map_err(|e| format!("audio base64: {e}"))?;

    let filename = args.filename.unwrap_or_else(|| {
        // Pick a filename extension Whisper recognises from the MIME.
        let ext = match args.mime_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "audio/webm" => "webm",
            "audio/wav" | "audio/x-wav" => "wav",
            "audio/mp4" => "m4a",
            "audio/mpeg" => "mp3",
            "audio/ogg" => "ogg",
            _ => "webm",
        };
        format!("audio.{ext}")
    });

    let start = std::time::Instant::now();
    let form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio_bytes)
                .file_name(filename)
                .mime_str(args.mime_type.split(';').next().unwrap_or("audio/webm").trim())
                .map_err(|e| format!("mime: {e}"))?,
        )
        .text("response_format", "json");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &api_key))?;

    let resp = client
        .post(&endpoint)
        .header("api-key", &api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), &api_key))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| redact(format!("read: {e}"), &api_key))?;
    if !status.is_success() {
        return Err(redact(
            format!("http {status} @ whisper :: {}", truncate(&text, 800)),
            &api_key,
        ));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| redact(format!("whisper json: {e} :: {}", truncate(&text, 400)), &api_key))?;
    let transcript = v["text"].as_str().unwrap_or("").trim().to_string();
    Ok(TranscribeResult {
        text: transcript,
        latency_ms: start.elapsed().as_millis() as u64,
    })
}

// ─── parse_organizer_event ───────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ParseEventArgs {
    pub transcript: String,
    /// Current local time in ISO 8601 (with offset), e.g.
    /// 2026-07-07T04:30:00-07:00. Used by the model to resolve
    /// relative phrases ("tomorrow", "next Friday").
    pub now_iso: String,
    /// IANA timezone id (e.g. "America/Vancouver"). Redundant with the
    /// offset in `now_iso` but helps the model reason correctly across
    /// DST boundaries in multi-day windows ("next Friday").
    pub tz: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ParsedEvent {
    /// "meeting" | "followup" | "action_item"
    pub kind: String,
    pub title: String,
    /// YYYY-MM-DD or null.
    pub date: Option<String>,
    /// HH:MM (24-hour) or null.
    pub time: Option<String>,
    pub duration_min: Option<u32>,
    pub participants: Vec<String>,
    pub notes: String,
    /// For followups/action items: "low" | "normal" | "high".
    pub priority: Option<String>,
    /// 0.0–1.0 model confidence self-report.
    pub confidence: Option<f32>,
}

#[derive(Serialize)]
pub struct ParseEventResult {
    pub event: ParsedEvent,
    pub latency_ms: u64,
    /// Raw JSON string returned by the model — audited to organizer_ai_events.
    pub raw_json: String,
}

#[tauri::command]
pub async fn parse_organizer_event(args: ParseEventArgs) -> Result<ParseEventResult, String> {
    let transcript = args.transcript.trim();
    if transcript.is_empty() {
        return Err("Transcript is empty. Nothing to parse.".to_string());
    }
    if transcript.len() > 4000 {
        return Err("Transcript too long (>4000 chars). Speak a shorter clip.".to_string());
    }

    let api_key = crate::secrets::get_secret("azure_ai_key")?;

    let system_prompt = format!(
        "You extract a single Organizer entry from a short dictation. Return STRICT JSON matching the schema — no prose, no code fences.\n\
         Current local time: {now_iso}\n\
         User timezone: {tz}\n\
         \n\
         kind rules:\n\
         - \"meeting\": explicit meeting/call/appointment with people, at a specific time.\n\
         - \"followup\": a reminder-style task without a strict clock time (\"remind me to…\").\n\
         - \"action_item\": a concrete to-do with an owner or a target (\"need to buy diapers by Friday\").\n\
         \n\
         Date rules:\n\
         - Resolve \"today\", \"tomorrow\", \"next Friday\", \"in 2 days\" etc. against the current local time.\n\
         - Output date as YYYY-MM-DD; time as HH:MM 24-hour; both null if unspecified.\n\
         - duration_min: infer if said (\"30 minutes\", \"half hour\", \"1 hour\"); null otherwise.\n\
         - Never invent a date, participant, or duration that wasn't dictated.\n\
         \n\
         priority: 'low' | 'normal' | 'high'; default 'normal' unless the speaker emphasises urgency.\n\
         confidence: your own 0.0–1.0 self-report. Below 0.7 suggests the user should review.",
        now_iso = args.now_iso,
        tz = args.tz,
    );

    let schema = json!({
        "type": "object",
        "properties": {
            "kind":         { "type": "string", "enum": ["meeting", "followup", "action_item"] },
            "title":        { "type": "string" },
            "date":         { "type": ["string", "null"], "description": "YYYY-MM-DD or null" },
            "time":         { "type": ["string", "null"], "description": "HH:MM 24h or null" },
            "duration_min": { "type": ["integer", "null"] },
            "participants": { "type": "array", "items": { "type": "string" } },
            "notes":        { "type": "string" },
            "priority":     { "type": ["string", "null"], "enum": ["low", "normal", "high", null] },
            "confidence":   { "type": ["number", "null"] }
        },
        "required": ["kind", "title", "date", "time", "duration_min", "participants", "notes", "priority", "confidence"],
        "additionalProperties": false
    });

    let body = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": transcript }
        ],
        "temperature": 0,
        "max_tokens": 400,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "OrganizerEvent", "schema": schema, "strict": true }
        }
    });

    let url = format!(
        "{AZURE_CHAT_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &api_key))?;
    let resp = client
        .post(&url)
        .header("api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), &api_key))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| redact(format!("read: {e}"), &api_key))?;
    if !status.is_success() {
        return Err(redact(
            format!("http {status} @ chat/completions :: {}", truncate(&text, 800)),
            &api_key,
        ));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| redact(format!("chat json: {e} :: {}", truncate(&text, 400)), &api_key))?;
    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err(redact(format!("chat: empty content :: {}", truncate(&text, 400)), &api_key));
    }
    let parsed: ParsedEvent = serde_json::from_str(&content)
        .map_err(|e| redact(format!("parsed JSON: {e} :: {}", truncate(&content, 400)), &api_key))?;

    Ok(ParseEventResult {
        event: parsed,
        latency_ms: start.elapsed().as_millis() as u64,
        raw_json: content,
    })
}

// ─── parse_staff_shifts ─────────────────────────────────────────────────
//
// Free-text → array of staff shifts, constrained to a specific week and a
// known active-staff roster. The model is *forbidden* from inventing names
// not in the roster — unmatched names come back with staff_id=null so the
// UI can surface them for manual fix rather than silently create bad rows.

#[derive(Deserialize)]
pub struct RosterMember {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
pub struct ClosedDay {
    pub iso: String,
    pub reason: String,
}

#[derive(Deserialize)]
pub struct ParseShiftsArgs {
    pub text: String,
    pub now_iso: String,
    pub tz: String,
    /// Monday of the target week, YYYY-MM-DD. Parser is not allowed to
    /// emit dates outside [week_start_iso .. week_start_iso + 6d].
    pub week_start_iso: String,
    pub roster: Vec<RosterMember>,
    /// v2.6.3. Days the centre is closed (weekend / stat holiday /
    /// manual override) within the parser's likely date window. The
    /// LLM is told never to schedule on these dates. Frontend also
    /// re-checks post-parse and pre-save as a backstop.
    #[serde(default)]
    pub closed_days: Vec<ClosedDay>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ParsedShift {
    /// Matched staff.id from the roster, or null when the name couldn't be
    /// resolved. UI must surface null-id shifts as "needs manual match".
    pub staff_id: Option<String>,
    /// Verbatim name the model matched on — for UI display.
    pub staff_name: String,
    /// YYYY-MM-DD within the week.
    pub shift_date: String,
    /// HH:MM 24h.
    pub start_time: String,
    /// HH:MM 24h.
    pub end_time: String,
    /// 0 by default; 30 or 60 if user said "with lunch break" / "1h break".
    pub break_minutes: u32,
    pub room: Option<String>,
    pub notes: Option<String>,
    pub confidence: Option<f32>,
    /// v2.6.3. What kind of row this is:
    ///   "shift"    → normal worked shift (default; matches legacy behaviour)
    ///   "vacation" → paid vacation marker; times default 09:00-17:00
    ///   "sick"     → sick-leave marker; times default 09:00-17:00
    ///   "day_off"  → unpaid personal day; times default 09:00-17:00
    /// Absence rows soft-cancel any planned shift for the same
    /// (staff, date) on save.
    #[serde(default = "default_shift_kind")]
    pub kind: String,
}

fn default_shift_kind() -> String { "shift".to_string() }

#[derive(Serialize)]
pub struct ParseShiftsResult {
    pub shifts: Vec<ParsedShift>,
    pub latency_ms: u64,
    pub raw_json: String,
}

#[tauri::command]
pub async fn parse_staff_shifts(args: ParseShiftsArgs) -> Result<ParseShiftsResult, String> {
    let text = args.text.trim();
    if text.is_empty() {
        return Err("Nothing to parse — the text box is empty.".to_string());
    }
    if text.len() > 4000 {
        return Err("Text too long (>4000 chars). Break it into smaller chunks.".to_string());
    }
    if args.roster.is_empty() {
        return Err("No active staff to schedule against. Add staff on the Staff page first.".to_string());
    }

    let api_key = crate::secrets::get_secret("azure_ai_key")?;

    // Build the roster block: "id: uuid, name: Priya" — the model is
    // instructed to echo back the id verbatim, so a name typo like "Preeya"
    // still maps to Priya's UUID as long as the fuzzy match is unambiguous.
    let roster_lines: Vec<String> = args.roster.iter()
        .map(|m| format!("- id: {} | name: {}", m.id, m.name))
        .collect();
    let roster_block = roster_lines.join("\n");

    // v2.6.3 closed-day block. When present the LLM is instructed to
    // never emit shifts on those dates. Kept short so it doesn't blow
    // token budget on year-long spans — callers should trim to a
    // reasonable window (typically 3-6 months around the visible week).
    let closed_block = if args.closed_days.is_empty() {
        "(none supplied — assume centre is open every day the user names)".to_string()
    } else {
        args.closed_days.iter()
            .map(|d| format!("- {} ({})", d.iso, d.reason))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let system_prompt = format!(
        "You convert free-text scheduling notes into a strict JSON array of staff shifts.\n\
         \n\
         Current local time: {now_iso}\n\
         User timezone: {tz}\n\
         User is currently viewing the week starting (Monday): {week_start}.\n\
         Use that week as the default anchor when the user says \"Monday\", \"Tuesday\", etc.\n\
         without more context. But shifts CAN and SHOULD be created for any future date if the\n\
         user says so — e.g. \"next Monday\", \"July 20\", \"in 3 weeks\", \"every Monday for the\n\
         next month\" all produce dates outside the current week. Never emit dates in the past.\n\
         \n\
         Active staff roster (name → id). You MUST match every shift to one of these ids.\n\
         If a name in the user's text is ambiguous or not in the roster, return staff_id=null\n\
         and put the raw name in staff_name — never invent an id.\n\
         {roster}\n\
         \n\
         Centre-closed days — NEVER emit a shift on any of these dates. If the user says\n\
         \"Priya Mon-Sun\" and Sat/Sun are listed as closed, only emit Mon-Fri. If every date\n\
         the user names is closed, emit an empty shifts array.\n\
         {closed}\n\
         \n\
         Rules:\n\
         - Expand multi-day phrases like \"Mon-Fri\" into one shift per day.\n\
         - Expand \"weekdays\" to Mon..Fri. \"weekend\" to Sat..Sun (but skip closed dates).\n\
         - Expand \"every Monday for next 4 weeks\", \"daily until end of month\", etc.\n\
         - Times: accept \"7-2\", \"7am to 2pm\", \"morning\", \"closing\", \"full day\".\n\
           Default anchors when only a shift word is given:\n\
             morning = 07:00-13:00, afternoon = 13:00-18:00, closing = 14:00-18:00, full day = 07:00-18:00.\n\
         - break_minutes: 0 unless the user says \"with lunch\", \"1h break\", \"no lunch\" (0), etc.\n\
         - room, notes: only fill if explicitly said. Otherwise null.\n\
         - Never emit end_time <= start_time.\n\
         - PAST DATES: if the user names a date that's already in the past (e.g. \"June 17\"\n\
           when today is July 13), still emit the shift with the past date. The frontend\n\
           will drop it and tell the user, which is more helpful than silently emitting\n\
           nothing (they usually meant a typo like \"July 17\" or next year's date).\n\
         - confidence: 0.0-1.0 self-report per shift.\n\
         \n\
         ABSENCES (kind field) — you MUST classify every row:\n\
         - kind=\"shift\"    : the default. A normal worked shift with real start/end times.\n\
         - kind=\"vacation\" : phrases like \"Judy on vacation this week\", \"Alex vacation Aug 1-5\",\n\
                              \"Priya off next Mon-Wed for vacation\", \"Sam PTO Tuesday\".\n\
         - kind=\"sick\"     : phrases like \"Judy sick today\", \"Priya was sick yesterday\",\n\
                              \"Alex out sick tomorrow\", \"Sam called in sick\".\n\
         - kind=\"day_off\"  : phrases like \"Judy day off Friday\", \"Alex has Wed off\",\n\
                              \"Priya dayoff tomorrow\", \"Sam is off Monday\" (with no reason given).\n\
         \n\
         For absence rows (kind != \"shift\"):\n\
         - Use 09:00 as start_time and 17:00 as end_time (placeholder — frontend zeroes hours).\n\
         - break_minutes = 0, room = null, notes = null.\n\
         - Expand week/range phrases the same way: \"Judy on vacation Mon-Fri next week\" → 5 rows.\n\
         - Do NOT emit an absence row on a centre-closed date (closed_days above).\n\
         \n\
         REPLACEMENTS — phrases like \"Judy was sick yesterday, Aldex covered\" or\n\
         \"Priya sick Monday, replaced by Sam\" or \"Alex off Tuesday, Judy takes it\" mean\n\
         EMIT TWO ROWS in this exact order:\n\
           1. The absence row for the original person (kind=sick/vacation/day_off, 09:00-17:00).\n\
           2. A normal kind=\"shift\" row for the covering person on the same date. If the user\n\
              didn't name times, use 09:00-17:00 as a best-guess placeholder — the user will\n\
              adjust in the review UI before saving.\n\
         \n\
         Return {{ \"shifts\": [...] }} — always wrap in an object, never a bare array.",
        now_iso = args.now_iso,
        tz = args.tz,
        week_start = args.week_start_iso,
        roster = roster_block,
        closed = closed_block,
    );

    let schema = json!({
        "type": "object",
        "properties": {
            "shifts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "staff_id":      { "type": ["string", "null"] },
                        "staff_name":    { "type": "string" },
                        "shift_date":    { "type": "string", "description": "YYYY-MM-DD" },
                        "start_time":    { "type": "string", "description": "HH:MM 24h" },
                        "end_time":      { "type": "string", "description": "HH:MM 24h" },
                        "break_minutes": { "type": "integer" },
                        "room":          { "type": ["string", "null"] },
                        "notes":         { "type": ["string", "null"] },
                        "confidence":    { "type": ["number", "null"] },
                        "kind":          { "type": "string", "enum": ["shift", "vacation", "sick", "day_off"] }
                    },
                    "required": ["staff_id", "staff_name", "shift_date", "start_time", "end_time", "break_minutes", "room", "notes", "confidence", "kind"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["shifts"],
        "additionalProperties": false
    });

    let body = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user",   "content": text }
        ],
        "temperature": 0,
        // v2.6.4: "vacation all July for whole team" can produce 5 staff × 31
        // days = 155 objects × ~150 tokens ≈ 23k. Cap at 16k which fits the
        // deployment's output budget and covers the vast majority of
        // real-world requests. Bigger requests will still truncate and the
        // caller sees a parse error with the original prompt to retry
        // per-staff. Empty rows are cheap; only pay for what's parsed.
        "max_tokens": 16000,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "StaffShifts", "schema": schema, "strict": true }
        }
    });

    let url = format!(
        "{AZURE_CHAT_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        // v2.6.4: 60s truncated the "everyone vacation all month" call which
        // now streams up to 16k tokens back. 120s covers it with headroom.
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &api_key))?;
    let resp = client
        .post(&url)
        .header("api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), &api_key))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| redact(format!("read: {e}"), &api_key))?;
    if !status.is_success() {
        return Err(redact(
            format!("http {status} @ chat/completions :: {}", truncate(&raw, 800)),
            &api_key,
        ));
    }
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| redact(format!("chat json: {e} :: {}", truncate(&raw, 400)), &api_key))?;
    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err(redact(format!("chat: empty content :: {}", truncate(&raw, 400)), &api_key));
    }
    #[derive(Deserialize)]
    struct Wrapper { shifts: Vec<ParsedShift> }
    let parsed: Wrapper = serde_json::from_str(&content)
        .map_err(|e| redact(format!("parsed JSON: {e} :: {}", truncate(&content, 400)), &api_key))?;

    // Post-process: enforce (a) date is today or later, (b) end > start,
    // (c) staff_id is either null or a real roster id. Model *should*
    // obey the prompt but strict server-side validation prevents a
    // hallucinated UUID or a stale date from reaching the DB layer.
    let today = args.now_iso.get(0..10).unwrap_or("").to_string();
    let valid_ids: std::collections::HashSet<&str> =
        args.roster.iter().map(|m| m.id.as_str()).collect();
    let mut cleaned: Vec<ParsedShift> = Vec::with_capacity(parsed.shifts.len());
    for mut s in parsed.shifts {
        // v2.6.3: only reject past dates for worked shifts. Absence rows
        // ("Judy was sick yesterday", "Priya on vacation last Mon-Fri")
        // legitimately reference past dates and must flow through to the
        // frontend so the user can persist them as historical markers.
        if s.kind == "shift" && !today.is_empty() && s.shift_date.as_str() < today.as_str() {
            continue;
        }
        if s.end_time.as_str() <= s.start_time.as_str() {
            continue;
        }
        if let Some(id) = &s.staff_id {
            if !valid_ids.contains(id.as_str()) {
                s.staff_id = None;
            }
        }
        cleaned.push(s);
    }

    Ok(ParseShiftsResult {
        shifts: cleaned,
        latency_ms: start.elapsed().as_millis() as u64,
        raw_json: content,
    })
}

// Naive ISO-date +N days (YYYY-MM-DD in, YYYY-MM-DD out). Kept for the
// upstream week-anchor prompt hint; also a general utility should future
// callers need it.
#[allow(dead_code)]
fn add_days_iso(iso: &str, days: i64) -> String {
    use std::str::FromStr;
    let parts: Vec<&str> = iso.split('-').collect();
    if parts.len() != 3 { return iso.to_string(); }
    let y = i32::from_str(parts[0]).unwrap_or(1970);
    let m = u32::from_str(parts[1]).unwrap_or(1);
    let d = u32::from_str(parts[2]).unwrap_or(1);
    // Rata Die-style day counter → convert, add, convert back.
    // Small helper: month lengths.
    fn days_in_month(y: i32, m: u32) -> u32 {
        match m {
            1|3|5|7|8|10|12 => 31,
            4|6|9|11 => 30,
            2 => if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 },
            _ => 30,
        }
    }
    let (mut yy, mut mm, mut dd) = (y, m, d as i64 + days);
    loop {
        if dd < 1 {
            mm -= 1;
            if mm < 1 { mm = 12; yy -= 1; }
            dd += days_in_month(yy, mm) as i64;
        } else if dd > days_in_month(yy, mm) as i64 {
            dd -= days_in_month(yy, mm) as i64;
            mm += 1;
            if mm > 12 { mm = 1; yy += 1; }
        } else { break; }
    }
    format!("{:04}-{:02}-{:02}", yy, mm, dd)
}

// ─── parse_expense ──────────────────────────────────────────────────────
//
// Free-text → single (or several) expense rows. Categories and payment
// methods are passed in from the frontend as an enumeration, so the
// backend never hardcodes a policy — schema changes on the TS side flow
// through automatically. Model must pick from the allowed enum, or
// null if genuinely unable to classify.

#[derive(Deserialize)]
pub struct ParseExpenseArgs {
    pub text: String,
    pub now_iso: String,
    pub tz: String,
    /// Category enum values, e.g. ["rent_lease","payroll",...]. Must match
    /// EXPENSE_CATEGORIES in src/lib/expenses.ts exactly — no free-text.
    pub categories: Vec<String>,
    /// Payment method labels, e.g. ["Cash","Visa Credit Card",...].
    pub payment_methods: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ParsedExpense {
    pub date: String,
    pub category: String,
    pub subcategory: Option<String>,
    pub vendor: Option<String>,
    pub amount: f64,
    pub payment_method: String,
    pub reference: Option<String>,
    pub notes: Option<String>,
    pub confidence: Option<f32>,
}

#[derive(Serialize)]
pub struct ParseExpenseResult {
    pub expenses: Vec<ParsedExpense>,
    pub latency_ms: u64,
    pub raw_json: String,
}

#[tauri::command]
pub async fn parse_expense(args: ParseExpenseArgs) -> Result<ParseExpenseResult, String> {
    let text = args.text.trim();
    if text.is_empty() {
        return Err("Nothing to parse — the text box is empty.".to_string());
    }
    if text.len() > 4000 {
        return Err("Text too long (>4000 chars). Enter one expense at a time.".to_string());
    }
    if args.categories.is_empty() || args.payment_methods.is_empty() {
        return Err("No categories or payment methods provided.".to_string());
    }

    let api_key = crate::secrets::get_secret("azure_ai_key")?;

    let cats = args.categories.join(", ");
    let pays = args.payment_methods.join(", ");

    let system_prompt = format!(
        "You extract one or more daycare-expense entries from short free-text notes. Return STRICT JSON matching the schema — no prose.\n\
         \n\
         Current local time: {now_iso}\n\
         User timezone: {tz}\n\
         \n\
         Rules:\n\
         - Resolve relative dates: 'today', 'yesterday', 'last Friday', 'July 3', 'a week ago' -> YYYY-MM-DD.\n\
         - If no date is stated, default to today.\n\
         - amount: positive number, no currency symbol, dollars and cents.\n\
         - vendor: the merchant / person paid, if stated. Otherwise null.\n\
         - subcategory: optional free-text refinement, e.g. 'Costco snacks' under food_groceries.\n\
         - reference: cheque #, invoice #, order # if stated. Otherwise null.\n\
         - notes: anything the user said that doesn't fit above (e.g. 'reimbursed by grant').\n\
         - confidence: 0.0-1.0 self-report per row.\n\
         - If the user describes multiple purchases, return one entry per purchase.\n\
         \n\
         category MUST be one of exactly these keys (never invent): {cats}\n\
         Choose the closest fit. Use 'misc' as fallback.\n\
         \n\
         payment_method MUST be one of exactly these labels: {pays}\n\
         Default to 'Cash' unless another method is stated.\n\
         \n\
         Return {{ \"expenses\": [...] }} — always wrap in an object.",
        now_iso = args.now_iso,
        tz = args.tz,
        cats = cats,
        pays = pays,
    );

    let cat_enum: Vec<Value> = args.categories.iter().map(|s| json!(s)).collect();
    let pay_enum: Vec<Value> = args.payment_methods.iter().map(|s| json!(s)).collect();

    let schema = json!({
        "type": "object",
        "properties": {
            "expenses": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "date":           { "type": "string" },
                        "category":       { "type": "string", "enum": cat_enum },
                        "subcategory":    { "type": ["string", "null"] },
                        "vendor":         { "type": ["string", "null"] },
                        "amount":         { "type": "number" },
                        "payment_method": { "type": "string", "enum": pay_enum },
                        "reference":      { "type": ["string", "null"] },
                        "notes":          { "type": ["string", "null"] },
                        "confidence":     { "type": ["number", "null"] }
                    },
                    "required": ["date", "category", "subcategory", "vendor", "amount", "payment_method", "reference", "notes", "confidence"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["expenses"],
        "additionalProperties": false
    });

    let body = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user",   "content": text }
        ],
        "temperature": 0,
        "max_tokens": 1200,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "ExpenseEntries", "schema": schema, "strict": true }
        }
    });

    let url = format!(
        "{AZURE_CHAT_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &api_key))?;
    let resp = client
        .post(&url)
        .header("api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), &api_key))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| redact(format!("read: {e}"), &api_key))?;
    if !status.is_success() {
        return Err(redact(
            format!("http {status} @ chat/completions :: {}", truncate(&raw, 800)),
            &api_key,
        ));
    }
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| redact(format!("chat json: {e} :: {}", truncate(&raw, 400)), &api_key))?;
    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err(redact(format!("chat: empty content :: {}", truncate(&raw, 400)), &api_key));
    }
    #[derive(Deserialize)]
    struct Wrapper { expenses: Vec<ParsedExpense> }
    let parsed: Wrapper = serde_json::from_str(&content)
        .map_err(|e| redact(format!("parsed JSON: {e} :: {}", truncate(&content, 400)), &api_key))?;

    // Server-side sanity: drop rows with non-positive amount or category
    // not in the allowed list (double-check the enum enforcement).
    let cat_set: std::collections::HashSet<&str> =
        args.categories.iter().map(|s| s.as_str()).collect();
    let pay_set: std::collections::HashSet<&str> =
        args.payment_methods.iter().map(|s| s.as_str()).collect();
    let cleaned: Vec<ParsedExpense> = parsed.expenses.into_iter().filter(|e| {
        e.amount > 0.0 && cat_set.contains(e.category.as_str()) && pay_set.contains(e.payment_method.as_str())
    }).collect();

    Ok(ParseExpenseResult {
        expenses: cleaned,
        latency_ms: start.elapsed().as_millis() as u64,
        raw_json: content,
    })
}

// ─── parse_recurring_expense ────────────────────────────────────────────
// Recurring bills (monthly/quarterly/yearly templates). Same shape as
// parse_expense but returns RecurringExpense-flavoured rows: name,
// frequency, day_of_month, start_date, no reference.

#[derive(Deserialize)]
pub struct ParseRecurringArgs {
    pub text: String,
    pub now_iso: String,
    pub tz: String,
    pub categories: Vec<String>,
    pub payment_methods: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ParsedRecurring {
    pub name: String,
    pub category: String,
    pub subcategory: Option<String>,
    pub vendor: Option<String>,
    pub amount: f64,
    pub payment_method: String,
    pub frequency: String,
    pub day_of_month: i32,
    pub start_date: String,
    pub notes: Option<String>,
    pub confidence: Option<f32>,
}

#[derive(Serialize)]
pub struct ParseRecurringResult {
    pub recurring: Vec<ParsedRecurring>,
    pub latency_ms: u64,
    pub raw_json: String,
}

#[tauri::command]
pub async fn parse_recurring_expense(args: ParseRecurringArgs) -> Result<ParseRecurringResult, String> {
    let text = args.text.trim();
    if text.is_empty() {
        return Err("Nothing to parse — the text box is empty.".to_string());
    }
    if text.len() > 4000 {
        return Err("Text too long (>4000 chars).".to_string());
    }
    if args.categories.is_empty() || args.payment_methods.is_empty() {
        return Err("No categories or payment methods provided.".to_string());
    }

    let api_key = crate::secrets::get_secret("azure_ai_key")?;

    let cats = args.categories.join(", ");
    let pays = args.payment_methods.join(", ");

    let system_prompt = format!(
        "You extract one or more RECURRING daycare-bill templates from short free-text notes. Return STRICT JSON matching the schema — no prose.\n\
         \n\
         Current local time: {now_iso}\n\
         User timezone: {tz}\n\
         \n\
         Rules:\n\
         - name: short human label for the bill (e.g. 'Rogers Internet', 'BC Hydro'). Required.\n\
         - amount: positive number, dollars and cents.\n\
         - frequency: one of exactly 'monthly', 'quarterly', 'yearly'. Default 'monthly' if unclear.\n\
         - day_of_month: integer 1..28 for the day the bill posts. If user says 'on the 5th' -> 5. Default 1 if not stated.\n\
         - start_date: YYYY-MM-DD. Default to today. If user says 'starting Aug', use the 1st of that month.\n\
         - vendor: the payee, if distinct from name. Otherwise null.\n\
         - subcategory: optional free-text refinement.\n\
         - notes: anything the user said that doesn't fit above.\n\
         - confidence: 0.0-1.0 self-report per row.\n\
         - If user describes multiple recurring bills, return one entry per bill.\n\
         \n\
         category MUST be one of exactly these keys (never invent): {cats}\n\
         Choose the closest fit. Use 'misc' as fallback.\n\
         \n\
         payment_method MUST be one of exactly these labels: {pays}\n\
         Default to 'Direct Deposit (Bank)' unless another method is stated.\n\
         \n\
         Return {{ \"recurring\": [...] }} — always wrap in an object.",
        now_iso = args.now_iso,
        tz = args.tz,
        cats = cats,
        pays = pays,
    );

    let cat_enum: Vec<Value> = args.categories.iter().map(|s| json!(s)).collect();
    let pay_enum: Vec<Value> = args.payment_methods.iter().map(|s| json!(s)).collect();

    let schema = json!({
        "type": "object",
        "properties": {
            "recurring": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name":           { "type": "string" },
                        "category":       { "type": "string", "enum": cat_enum },
                        "subcategory":    { "type": ["string", "null"] },
                        "vendor":         { "type": ["string", "null"] },
                        "amount":         { "type": "number" },
                        "payment_method": { "type": "string", "enum": pay_enum },
                        "frequency":      { "type": "string", "enum": ["monthly", "quarterly", "yearly"] },
                        "day_of_month":   { "type": "integer" },
                        "start_date":     { "type": "string" },
                        "notes":          { "type": ["string", "null"] },
                        "confidence":     { "type": ["number", "null"] }
                    },
                    "required": ["name", "category", "subcategory", "vendor", "amount", "payment_method", "frequency", "day_of_month", "start_date", "notes", "confidence"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["recurring"],
        "additionalProperties": false
    });

    let body = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user",   "content": text }
        ],
        "temperature": 0,
        "max_tokens": 1200,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "RecurringEntries", "schema": schema, "strict": true }
        }
    });

    let url = format!(
        "{AZURE_CHAT_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &api_key))?;
    let resp = client
        .post(&url)
        .header("api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), &api_key))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| redact(format!("read: {e}"), &api_key))?;
    if !status.is_success() {
        return Err(redact(
            format!("http {status} @ chat/completions :: {}", truncate(&raw, 800)),
            &api_key,
        ));
    }
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| redact(format!("chat json: {e} :: {}", truncate(&raw, 400)), &api_key))?;
    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err(redact(format!("chat: empty content :: {}", truncate(&raw, 400)), &api_key));
    }
    #[derive(Deserialize)]
    struct Wrapper { recurring: Vec<ParsedRecurring> }
    let parsed: Wrapper = serde_json::from_str(&content)
        .map_err(|e| redact(format!("parsed JSON: {e} :: {}", truncate(&content, 400)), &api_key))?;

    let cat_set: std::collections::HashSet<&str> =
        args.categories.iter().map(|s| s.as_str()).collect();
    let pay_set: std::collections::HashSet<&str> =
        args.payment_methods.iter().map(|s| s.as_str()).collect();
    let allowed_freq = ["monthly", "quarterly", "yearly"];
    let cleaned: Vec<ParsedRecurring> = parsed.recurring.into_iter().map(|mut r| {
        if r.day_of_month < 1 { r.day_of_month = 1; }
        if r.day_of_month > 28 { r.day_of_month = 28; }
        r
    }).filter(|r| {
        !r.name.trim().is_empty()
        && r.amount > 0.0
        && cat_set.contains(r.category.as_str())
        && pay_set.contains(r.payment_method.as_str())
        && allowed_freq.contains(&r.frequency.as_str())
    }).collect();

    Ok(ParseRecurringResult {
        recurring: cleaned,
        latency_ms: start.elapsed().as_millis() as u64,
        raw_json: content,
    })
}


// ─── parse_meeting_notes ────────────────────────────────────────────────
// Staff meeting notes captured in plain English → structured meeting rows
// with attendees returned as free-text names. The frontend resolves those
// to real staff IDs (whitelist) before saving.

#[derive(Deserialize)]
pub struct ParseMeetingArgs {
    pub text: String,
    pub now_iso: String,
    pub tz: String,
    pub staff_names: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ParsedMeeting {
    pub meeting_date: String,
    pub title: String,
    pub attendees: Vec<String>,
    pub agenda: String,
    pub notes: String,
    pub action_items: Vec<ParsedActionItem>,
    pub confidence: Option<f32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ParsedActionItem {
    pub text: String,
    pub owner: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Serialize)]
pub struct ParseMeetingResult {
    pub meetings: Vec<ParsedMeeting>,
    pub latency_ms: u64,
    pub raw_json: String,
}

#[tauri::command]
pub async fn parse_meeting_notes(args: ParseMeetingArgs) -> Result<ParseMeetingResult, String> {
    let text = args.text.trim();
    if text.is_empty() {
        return Err("Nothing to parse — the text box is empty.".to_string());
    }
    if text.len() > 8000 {
        return Err("Text too long (>8000 chars). Trim before parsing.".to_string());
    }

    let api_key = crate::secrets::get_secret("azure_ai_key")?;

    let staff_hint = if args.staff_names.is_empty() {
        "(no staff on file yet)".to_string()
    } else {
        args.staff_names.join(", ")
    };

    let system_prompt = format!(
        "You extract a staff meeting record from free-text notes. Return STRICT JSON matching the schema — no prose.\n\
         \n\
         Current local time: {now_iso}\n\
         User timezone: {tz}\n\
         Known staff names: {staff_hint}\n\
         \n\
         Rules:\n\
         - meeting_date: resolve 'today', 'yesterday', 'last Tuesday' -> YYYY-MM-DD. Default to today.\n\
         - title: short human label ('July staff meeting', 'Weekly stand-up'). If unclear, generate 'Staff meeting — <date>'.\n\
         - attendees: array of staff names taken verbatim from the text; match to Known staff names when possible.\n\
         - agenda: bullet-style summary of topics on the agenda (may be empty).\n\
         - notes: full narrative of what was discussed, decisions made, follow-ups. Preserve line breaks.\n\
         - action_items: distinct to-dos assigned to someone. Each has text; owner (name) and due_date (YYYY-MM-DD) are optional.\n\
         - confidence: 0.0-1.0 self-report.\n\
         - If the text contains multiple separate meetings, return one entry each. Otherwise return exactly one.\n\
         \n\
         Return {{ \"meetings\": [...] }} — always wrap in an object.",
        now_iso = args.now_iso,
        tz = args.tz,
        staff_hint = staff_hint,
    );

    let schema = json!({
        "type": "object",
        "properties": {
            "meetings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "meeting_date": { "type": "string" },
                        "title":        { "type": "string" },
                        "attendees":    { "type": "array", "items": { "type": "string" } },
                        "agenda":       { "type": "string" },
                        "notes":        { "type": "string" },
                        "action_items": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "text":     { "type": "string" },
                                    "owner":    { "type": ["string", "null"] },
                                    "due_date": { "type": ["string", "null"] }
                                },
                                "required": ["text", "owner", "due_date"],
                                "additionalProperties": false
                            }
                        },
                        "confidence": { "type": ["number", "null"] }
                    },
                    "required": ["meeting_date", "title", "attendees", "agenda", "notes", "action_items", "confidence"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["meetings"],
        "additionalProperties": false
    });

    let body = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user",   "content": text }
        ],
        "temperature": 0,
        "max_tokens": 2500,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "MeetingEntries", "schema": schema, "strict": true }
        }
    });

    let url = format!(
        "{AZURE_CHAT_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &api_key))?;
    let resp = client
        .post(&url)
        .header("api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), &api_key))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| redact(format!("read: {e}"), &api_key))?;
    if !status.is_success() {
        return Err(redact(
            format!("http {status} @ chat/completions :: {}", truncate(&raw, 800)),
            &api_key,
        ));
    }
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| redact(format!("chat json: {e} :: {}", truncate(&raw, 400)), &api_key))?;
    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err(redact(format!("chat: empty content :: {}", truncate(&raw, 400)), &api_key));
    }
    #[derive(Deserialize)]
    struct Wrapper { meetings: Vec<ParsedMeeting> }
    let parsed: Wrapper = serde_json::from_str(&content)
        .map_err(|e| redact(format!("parsed JSON: {e} :: {}", truncate(&content, 400)), &api_key))?;

    let cleaned: Vec<ParsedMeeting> = parsed.meetings.into_iter().filter(|m| !m.title.trim().is_empty()).collect();

    Ok(ParseMeetingResult {
        meetings: cleaned,
        latency_ms: start.elapsed().as_millis() as u64,
        raw_json: content,
    })
}

// ─── Amend meeting notes with AI ────────────────────────────────────────
//
// Given the current `notes` text of a meeting plus a plain-language
// `instruction`, return a rewritten notes body. No structured schema —
// notes are freeform. The prompt is deliberately conservative: preserve
// content unless explicitly told to change it, keep line breaks, do not
// invent facts.

#[derive(Deserialize)]
pub struct AmendMeetingNotesArgs {
    pub current_notes: String,
    pub instruction: String,
}

#[derive(Serialize)]
pub struct AmendMeetingNotesResult {
    pub notes: String,
    pub latency_ms: u64,
}

#[tauri::command]
pub async fn amend_meeting_notes(args: AmendMeetingNotesArgs) -> Result<AmendMeetingNotesResult, String> {
    let instr = args.instruction.trim();
    if instr.is_empty() {
        return Err("Tell me what you want changed (e.g. \"add a bullet about parent complaint follow-up\").".to_string());
    }
    if args.current_notes.len() > 20_000 || instr.len() > 2_000 {
        return Err("Notes or instruction too long (max 20k / 2k chars).".to_string());
    }

    let api_key = crate::secrets::get_secret("azure_ai_key")?;

    let system_prompt = "You revise a staff meeting's notes based on a plain-language instruction.\n\
        Rules:\n\
        - Return ONLY the revised notes text. No prose about what you changed. No code fences.\n\
        - Preserve everything from the original notes UNLESS the instruction tells you to remove, replace or restructure it.\n\
        - Keep line breaks and bullet formatting the user is already using.\n\
        - Do not invent facts, names, dates, or decisions that aren't in the original notes or the instruction.\n\
        - If the instruction is to reformat only, keep the content verbatim.\n\
        - If the current notes are empty, treat the instruction as the entire content to write.";

    let user = format!(
        "CURRENT NOTES:\n{}\n\nINSTRUCTION:\n{}\n\nReturn the revised notes now:",
        if args.current_notes.trim().is_empty() { "(none)" } else { args.current_notes.as_str() },
        instr,
    );

    let body = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user",   "content": user }
        ],
        "temperature": 0.2,
        "max_tokens": 2500
    });

    let url = format!(
        "{AZURE_CHAT_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &api_key))?;
    let resp = client
        .post(&url)
        .header("api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), &api_key))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| redact(format!("read: {e}"), &api_key))?;
    if !status.is_success() {
        return Err(redact(
            format!("http {status} @ chat/completions :: {}", truncate(&raw, 800)),
            &api_key,
        ));
    }
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| redact(format!("chat json: {e} :: {}", truncate(&raw, 400)), &api_key))?;
    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err(redact(format!("chat: empty content :: {}", truncate(&raw, 400)), &api_key));
    }
    // Strip any accidental code fence wrapping the model may have added.
    let cleaned = content
        .trim_start_matches("```markdown").trim_start_matches("```md").trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string();

    Ok(AmendMeetingNotesResult {
        notes: cleaned,
        latency_ms: start.elapsed().as_millis() as u64,
    })
}
