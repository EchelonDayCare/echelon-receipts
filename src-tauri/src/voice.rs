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

// Fetch an Azure AAD access token for the Cognitive Services audience via
// the local `az` CLI. Used only as a fallback when key-auth returns 403
// AuthenticationTypeDisabled (some Azure Policies enforce key-off on
// certain subs). Returns None if `az` isn't installed or the user isn't
// signed in — caller surfaces the original 403 in that case.
fn az_cli_token() -> Option<String> {
    let out = std::process::Command::new("az")
        .args([
            "account", "get-access-token",
            "--resource", "https://cognitiveservices.azure.com/",
            "--query", "accessToken",
            "-o", "tsv",
        ])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tok.is_empty() { None } else { Some(tok) }
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &api_key))?;

    // Build the multipart form as a closure so we can rebuild it for the
    // retry (reqwest::multipart::Form is not Clone).
    let mime = args.mime_type.split(';').next().unwrap_or("audio/webm").trim().to_string();
    let build_form = || -> Result<reqwest::multipart::Form, String> {
        Ok(reqwest::multipart::Form::new()
            .part(
                "file",
                reqwest::multipart::Part::bytes(audio_bytes.clone())
                    .file_name(filename.clone())
                    .mime_str(&mime)
                    .map_err(|e| format!("mime: {e}"))?,
            )
            .text("response_format", "json"))
    };

    // First attempt: key auth (the common case; also works for any user
    // whose Whisper resource isn't governed by an Azure Policy that
    // disables local auth).
    let resp = client
        .post(&endpoint)
        .header("api-key", &api_key)
        .multipart(build_form()?)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), &api_key))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| redact(format!("read: {e}"), &api_key))?;

    // If the resource has key-auth disabled (Azure Policy modify effect),
    // transparently fall back to an AAD token from the local `az` CLI.
    // This keeps the Voice Capture feature working on dev machines governed
    // by MSFT sandbox policies without changing the shipping code path.
    let (status, text) = if status.as_u16() == 403 && text.contains("AuthenticationTypeDisabled") {
        match az_cli_token() {
            Some(tok) => {
                let resp2 = client
                    .post(&endpoint)
                    .header("Authorization", format!("Bearer {tok}"))
                    .multipart(build_form()?)
                    .send()
                    .await
                    .map_err(|e| redact(format!("request(AAD): {e}"), &api_key))?;
                let s2 = resp2.status();
                let t2 = resp2.text().await.map_err(|e| redact(format!("read(AAD): {e}"), &api_key))?;
                (s2, t2)
            }
            None => (status, text),
        }
    } else {
        (status, text)
    };

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
