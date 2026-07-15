// Azure AI Foundry — Mistral Document AI wrapper for
//   • child attendance sign-in sheet OCR
//   • Visa / credit-card statement itemisation
//
// Uses the same Azure endpoint and `azure_ai_key` as the staff-timesheet
// consensus flow (see consensus.rs, provider "gpt5" / mistral-document-ai-2512).
// Single-model — no consensus needed for these features.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

const MISTRAL_DOC_AI_URL: &str = "https://ai-nse.services.ai.azure.com/providers/mistral/azure/ocr";
const MISTRAL_DOC_AI_MODEL: &str = "mistral-document-ai-2512";

// GPT vision — used for the monthly attendance grid because Mistral
// Document AI truncated rows and confused X vs dash. gpt-5.4 does the
// heavy lifting (reasoning); gpt-4.1 is a second opinion for consensus.
const AZURE_OPENAI_ENDPOINT: &str = "https://ai-nse.openai.azure.com";
const VISION_DEPLOY_PRIMARY: &str = "gpt-5.4";   // reasoning model
const VISION_DEPLOY_SECONDARY: &str = "gpt-4.1"; // fast model, second opinion
const VISION_API_VER: &str = "2025-04-01-preview";

fn truncate(s: &str, n: usize) -> String {
    // char-boundary safe. Rust panics on non-boundary byte-slice indexing, and
    // Azure/Mistral responses routinely contain multi-byte characters
    // (accented merchant names, the "…" ellipsis, JSON escapes for unicode).
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

// Downscale a large photo before sending to a vision model. Handwritten
// attendance grids read fine at ~1600px on the longest side; larger
// images just burn tokens and latency. Non-image formats (application/pdf)
// pass through unchanged. Falls back to the original bytes on decode
// failure — we never want a resize error to break OCR entirely.
fn downscale_for_vision(image_b64: &str, mime_type: &str) -> (String, String) {
    const MAX_DIM: u32 = 1600;
    const JPEG_QUALITY: u8 = 85;
    if !mime_type.starts_with("image/") {
        return (image_b64.to_string(), mime_type.to_string());
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(image_b64.as_bytes()) {
        Ok(b) => b,
        Err(_) => return (image_b64.to_string(), mime_type.to_string()),
    };
    let orig_size = bytes.len();
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[month-ocr] downscale: image decode failed ({e}) — sending original bytes");
            return (image_b64.to_string(), mime_type.to_string());
        }
    };
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    let resized = if long > MAX_DIM {
        img.resize(MAX_DIM, MAX_DIM, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = std::io::Cursor::new(Vec::<u8>::new());
    if let Err(e) = resized.write_with_encoder(
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
    ) {
        eprintln!("[month-ocr] downscale: jpeg encode failed ({e}) — sending original bytes");
        return (image_b64.to_string(), mime_type.to_string());
    }
    let new_bytes = out.into_inner();
    let new_b64 = base64::engine::general_purpose::STANDARD.encode(&new_bytes);
    eprintln!(
        "[month-ocr] downscale: {}x{} → {}x{}, {} KB → {} KB",
        w, h, resized.width(), resized.height(),
        orig_size / 1024, new_bytes.len() / 1024,
    );
    (new_b64, "image/jpeg".to_string())
}

// Shared helper — POSTs a document (image/pdf) + JSON schema to Mistral Document AI
// and returns the parsed `document_annotation` string.
async fn call_mistral_doc_ai(
    api_key: &str, file_b64: &str, mime_type: &str,
    schema: serde_json::Value, name: &str,
) -> Result<String, String> {
    // Validate base64.
    base64::engine::general_purpose::STANDARD
        .decode(file_b64.as_bytes())
        .map_err(|e| format!("file base64: {e}"))?;

    let data_url = format!("data:{mime_type};base64,{file_b64}");
    // Mistral OCR uses different `type`+field for PDFs vs images.
    // - Images (image/png, image/jpeg, ...): { type: "image_url", image_url: ... }
    // - PDFs (application/pdf):              { type: "document_url", document_url: ... }
    let document = if mime_type.eq_ignore_ascii_case("application/pdf") {
        json!({ "type": "document_url", "document_url": data_url })
    } else {
        json!({ "type": "image_url", "image_url": data_url })
    };
    let body = json!({
        "model": MISTRAL_DOC_AI_MODEL,
        "document": document,
        "document_annotation_format": {
            "type": "json_schema",
            "json_schema": { "name": name, "schema": schema, "strict": true }
        },
        "include_image_base64": false
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), api_key))?;

    // M-15: retry with exponential backoff (100ms → 400ms → 1600ms, max 3
    // attempts) on transient HTTP 429/503/504 — Azure/Mistral rate-limits
    // and brief backend hiccups shouldn't fail an entire OCR import that a
    // human is waiting on.
    const MAX_ATTEMPTS: u32 = 3;
    const BASE_BACKOFF_MS: u64 = 100;
    let mut last_err: Result<String, String> = Err("no attempt".to_string());
    for attempt in 1..=MAX_ATTEMPTS {
        let resp = client.post(MISTRAL_DOC_AI_URL)
            .header("api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| redact(format!("request: {e}"), api_key))?;

        let status = resp.status();
        let text = resp.text().await.map_err(|e| redact(format!("read: {e}"), api_key))?;
        let retriable = matches!(status.as_u16(), 429 | 503 | 504);
        if !status.is_success() {
            last_err = Err(redact(format!("http {status} @ mistral-document-ai :: {}", truncate(&text, 800)), api_key));
            if retriable && attempt < MAX_ATTEMPTS {
                let backoff = BASE_BACKOFF_MS * 4u64.pow(attempt - 1);
                tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
                continue;
            }
            return last_err;
        }
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| redact(format!("json: {e}"), api_key))?;
        return v["document_annotation"].as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| redact(format!("no document_annotation in response: {}", truncate(&text, 400)), api_key));
    }
    last_err
}

// Shared helper — POSTs an image + JSON schema to GPT-4.1 vision (Azure
// OpenAI chat/completions with `response_format: json_schema`) and returns
// the strict JSON string from `choices[0].message.content`. Used by the
// monthly-attendance flow where handwriting differentiation matters.
async fn call_gpt_vision_json(
    api_key: &str, deployment: &str, file_b64: &str, mime_type: &str,
    schema: serde_json::Value, name: &str, system_prompt: &str, user_prompt: &str,
    reasoning_effort: Option<&str>,
) -> Result<String, String> {
    base64::engine::general_purpose::STANDARD
        .decode(file_b64.as_bytes())
        .map_err(|e| format!("file base64: {e}"))?;

    let url = format!(
        "{AZURE_OPENAI_ENDPOINT}/openai/deployments/{deployment}/chat/completions?api-version={VISION_API_VER}"
    );
    let data_url = format!("data:{mime_type};base64,{file_b64}");
    let mut body = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": [
                { "type": "text", "text": user_prompt },
                { "type": "image_url", "image_url": { "url": data_url, "detail": "high" } }
            ]}
        ],
        "max_completion_tokens": 16000,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": name, "schema": schema, "strict": true }
        }
    });
    if let Some(effort) = reasoning_effort {
        body["reasoning_effort"] = json!(effort);
    } else {
        body["temperature"] = json!(0.0);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), api_key))?;

    const MAX_ATTEMPTS: u32 = 3;
    const BASE_BACKOFF_MS: u64 = 100;
    let mut last_err: Result<String, String> = Err("no attempt".to_string());
    for attempt in 1..=MAX_ATTEMPTS {
        let resp = client.post(&url)
            .header("api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| redact(format!("request: {e}"), api_key))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| redact(format!("read: {e}"), api_key))?;
        let retriable = matches!(status.as_u16(), 429 | 503 | 504);
        if !status.is_success() {
            last_err = Err(redact(format!("http {status} @ {deployment} vision :: {}", truncate(&text, 800)), api_key));
            if retriable && attempt < MAX_ATTEMPTS {
                let backoff = BASE_BACKOFF_MS * 4u64.pow(attempt - 1);
                tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
                continue;
            }
            return last_err;
        }
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| redact(format!("json: {e}"), api_key))?;
        return v["choices"][0]["message"]["content"].as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| redact(format!("no message content in response: {}", truncate(&text, 400)), api_key));
    }
    last_err
}

// ─── Child attendance sign-in sheet ─────────────────────────────────────

#[derive(Deserialize)]
pub struct ExtractAttendanceArgs {
    pub image_b64: String,
    pub mime_type: String,
    pub target_date: String,             // yyyy-mm-dd
    pub known_student_names: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ExtractedAttendanceRow {
    pub child_name: String,
    pub work_date: String,
    pub in_time: Option<String>,
    pub out_time: Option<String>,
    pub status: Option<String>,
    pub signed_in_by: Option<String>,
    pub signed_out_by: Option<String>,
}

#[derive(Serialize)]
pub struct ExtractAttendanceResult {
    pub rows: Vec<ExtractedAttendanceRow>,
    pub raw_text: String,
}

#[tauri::command]
pub async fn extract_attendance(args: ExtractAttendanceArgs) -> Result<ExtractAttendanceResult, String> {
    let known_hint = if args.known_student_names.is_empty() {
        "(none - use names exactly as written)".to_string()
    } else {
        args.known_student_names.join(", ")
    };

    let schema = json!({
        "type": "object",
        "properties": {
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "child_name":     { "type": "string",
                            "description": format!("Exact child name as written. Known children: {known_hint}") },
                        "work_date":      { "type": "string", "description": format!("YYYY-MM-DD. Default: {}", args.target_date) },
                        "in_time":        { "type": ["string", "null"], "description": "HH:MM 24-hour drop-off time. Daycare opens ~07:30." },
                        "out_time":       { "type": ["string", "null"], "description": "HH:MM 24-hour pick-up time. Daycare closes ~17:30 — infer PM." },
                        "status":         { "type": ["string", "null"], "description": "present | absent | sick | late | holiday" },
                        "signed_in_by":   { "type": ["string", "null"] },
                        "signed_out_by":  { "type": ["string", "null"] }
                    },
                    "required": ["child_name", "work_date", "in_time", "out_time", "status", "signed_in_by", "signed_out_by"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["rows"],
        "additionalProperties": false
    });

    let key_for_redact = crate::secrets::get_secret("azure_ai_key")?;
    let annotation = call_mistral_doc_ai(
        &key_for_redact, &args.image_b64, &args.mime_type, schema, "AttendanceExtraction"
    ).await?;

    let parsed: serde_json::Value = serde_json::from_str(&annotation)
        .map_err(|e| redact(format!("model output not JSON: {e} :: {}", truncate(&annotation, 400)), &key_for_redact))?;
    let rows_json = parsed["rows"].as_array().cloned().unwrap_or_default();
    let mut rows: Vec<ExtractedAttendanceRow> = Vec::with_capacity(rows_json.len());
    for r in rows_json {
        let name = r["child_name"].as_str().unwrap_or("").trim().to_string();
        let date = r["work_date"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || date.len() < 10 { continue; }
        if is_placeholder_name(&name) { continue; }
        let pick = |k: &str| r[k].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        rows.push(ExtractedAttendanceRow {
            child_name: name,
            work_date: date,
            in_time: pick("in_time"),
            out_time: pick("out_time"),
            status: pick("status"),
            signed_in_by: pick("signed_in_by"),
            signed_out_by: pick("signed_out_by"),
        });
    }
    Ok(ExtractAttendanceResult { rows, raw_text: annotation })
}

// ─── Monthly child attendance grid ──────────────────────────────────────
//
// The physical form (see Echelon Day Care template) is a matrix of
// child_name × day_of_month with single-character marks. Since v2.2.2 we
// only recognise two states: Present and Absent. On this specific paper
// template Luxmi's staff mark:
//   X  (or ✓, ✱, star, asterisk)   = Present  → emit "P"
//   -  (dash, en-dash, hyphen)     = Absent   → emit "A"
//   (blank cell inside a numbered day column)  → Absent → emit "A"
//   (blank cell inside the wide "Saturday & Sunday" column)  → OMIT — not attendance data
//   (any letter P/A written by hand)          → emit as-is
// The 4 wide vertical bands labelled "Saturday & Sunday" between weeks
// must NEVER be interpreted as day columns. They are gutters.
//
// Historical H/S/V marks may still exist in old data; on the read path we
// collapse them to A. See src/lib/monthAttendance.ts.

#[derive(Deserialize)]
pub struct ExtractMonthAttendanceArgs {
    pub image_b64: String,
    pub mime_type: String,
    pub target_month: String,             // "YYYY-MM"
    pub known_student_names: Vec<String>,
    // Calendar metadata for the target month. All optional — when supplied
    // the OCR prompt uses them as ground truth for column classification
    // (weekend/STAT/closed cells should contain NO handwriting; if the
    // model sees ink there it's a column-drift signal, not a real mark).
    // Days are 1..31 integers relative to the target month.
    #[serde(default)]
    pub weekend_days: Vec<u32>,
    #[serde(default)]
    pub stat_days: Vec<u32>,
    #[serde(default)]
    pub closed_days: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ExtractedMonthAttendanceRow {
    pub child_name: String,
    pub marks: std::collections::BTreeMap<String, String>, // "1".."31" -> "P|A"
}

#[derive(Serialize)]
pub struct ExtractMonthAttendanceResult {
    pub month: String,
    pub days_centre_open: Option<u32>,
    pub rows: Vec<ExtractedMonthAttendanceRow>,
    pub raw_text: String,
    /// Cells where the two vision models disagreed. UI should highlight
    /// these so the human reviewer can double-check before importing.
    #[serde(default)]
    pub uncertain_cells: Vec<MonthUncertainCell>,
    /// Per-provider metadata for the diagnostic panel + trust indicator.
    #[serde(default)]
    pub providers: Vec<MonthProviderMeta>,
    /// v3.0.7: What the consensus layer decided. One of:
    ///  - "primary"            — primary model's rows imported (normal path)
    ///  - "secondary_promoted" — primary silently under-read vs roster;
    ///                           secondary promoted to source of truth
    ///  - "primary_only"       — secondary failed/degraded; primary passed through
    ///  - "secondary_only"     — primary hard-failed; secondary was used
    /// Frontend shows a banner when this is not "primary" so the user
    /// knows why the numbers may look different from a naive read.
    #[serde(default)]
    pub consensus_action: String,
}

#[derive(Serialize)]
pub struct MonthUncertainCell {
    pub child_name: String,
    pub day: String,
    /// Ordered list of what each provider saw. Same order as `providers`.
    /// "P" | "A" | "-" (blank / not emitted).
    pub votes: Vec<String>,
    /// The value we picked (primary provider wins tie-break).
    pub picked: String,
}

#[derive(Serialize)]
pub struct MonthProviderMeta {
    pub provider: String,      // deployment name
    pub ok: bool,
    pub latency_ms: u64,
    pub row_count: usize,
    pub mark_count: usize,
    pub error: Option<String>,
}

// Days in the target month. Best-effort — returns 31 if the string can't
// be parsed as YYYY-MM. Used only for a hint string in the OCR prompt,
// so a wrong answer degrades output quality but never crashes.
fn expected_days_in_month(target_month: &str) -> u32 {
    expected_days_in_month_strict(target_month).unwrap_or(31)
}

// Strict variant: returns an error for malformed input instead of falling
// back to 31. Callers use this at the OCR entry point so bad inputs fail
// loud rather than corrupting the prompt.
fn expected_days_in_month_strict(target_month: &str) -> Result<u32, &'static str> {
    let parts: Vec<&str> = target_month.split('-').collect();
    if parts.len() != 2 { return Err("expected format YYYY-MM"); }
    if parts[0].len() != 4 { return Err("year must be 4 digits"); }
    if parts[1].len() != 2 { return Err("month must be 2 digits"); }
    let y: i32 = parts[0].parse().map_err(|_| "year is not a number")?;
    let m: u32 = parts[1].parse().map_err(|_| "month is not a number")?;
    if !(1..=12).contains(&m) { return Err("month must be 01..12"); }
    if !(1900..=2100).contains(&y) { return Err("year must be 1900..2100"); }
    Ok(match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
            if leap { 29 } else { 28 }
        }
        _ => unreachable!(),
    })
}

// Parse a single provider's raw JSON annotation into (month, days_open, rows).
fn parse_month_annotation(
    annotation: &str, target_month: &str,
) -> Result<(String, Option<u32>, Vec<ExtractedMonthAttendanceRow>), String> {
    let parsed: serde_json::Value = serde_json::from_str(annotation)
        .map_err(|e| format!("model output not JSON: {e} :: {}", truncate(annotation, 400)))?;
    let month = parsed["month"].as_str().unwrap_or(target_month).trim().to_string();
    let days_centre_open = parsed["days_centre_open"].as_u64().map(|n| n as u32);
    let rows_json = parsed["rows"].as_array().cloned().unwrap_or_default();
    let mut rows: Vec<ExtractedMonthAttendanceRow> = Vec::with_capacity(rows_json.len());
    for r in rows_json {
        let name = r["child_name"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || is_placeholder_name(&name) { continue; }
        let mut marks: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
        if let Some(arr) = r["marks"].as_array() {
            for entry in arr {
                let raw = entry["mark"].as_str().unwrap_or("").trim().to_uppercase();
                let val = match raw.as_str() {
                    "P" => "P".to_string(),
                    "A" | "H" | "S" | "V" => "A".to_string(),
                    _ => continue,
                };
                let k = entry["day"].as_str().unwrap_or("").trim().to_string();
                let n: u32 = match k.parse() { Ok(x) => x, Err(_) => continue };
                if !(1..=31).contains(&n) { continue; }
                marks.insert(n.to_string(), val);
            }
        }
        if marks.is_empty() { continue; }
        rows.push(ExtractedMonthAttendanceRow { child_name: name, marks });
    }
    Ok((month, days_centre_open, rows))
}

// Case-insensitive name normalisation for matching child rows across
// providers ("Adella Buitrago" vs "adella buitrago's" vs "  Adella  Buitrago ").
fn norm_child_name(s: &str) -> String {
    s.trim()
        .trim_end_matches('\'')
        .trim_end_matches('s')
        .trim_end_matches('\'')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

// Merge two providers' row sets into a single consensus row set. Primary
// wins on conflict; secondary's marks that the primary doesn't have are
// discarded (flagged as uncertain). Every disagreement is surfaced.
fn merge_month_consensus(
    primary: &[ExtractedMonthAttendanceRow],
    secondary: &[ExtractedMonthAttendanceRow],
) -> (Vec<ExtractedMonthAttendanceRow>, Vec<MonthUncertainCell>) {
    use std::collections::BTreeMap;
    let mut sec_index: BTreeMap<String, &ExtractedMonthAttendanceRow> = BTreeMap::new();
    for row in secondary { sec_index.insert(norm_child_name(&row.child_name), row); }
    let mut merged: Vec<ExtractedMonthAttendanceRow> = Vec::with_capacity(primary.len());
    let mut uncertain: Vec<MonthUncertainCell> = Vec::new();
    let mut primary_keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for prow in primary {
        let key = norm_child_name(&prow.child_name);
        primary_keys.insert(key.clone());
        let secr = sec_index.get(&key).copied();
        let mut merged_marks: BTreeMap<String, String> = BTreeMap::new();
        // Union of day keys across both.
        let mut all_days: std::collections::BTreeSet<String> = prow.marks.keys().cloned().collect();
        if let Some(sr) = secr {
            for k in sr.marks.keys() { all_days.insert(k.clone()); }
        }
        for day in all_days {
            let p_mark = prow.marks.get(&day).cloned();
            let s_mark = secr.and_then(|sr| sr.marks.get(&day).cloned());
            match (p_mark.as_deref(), s_mark.as_deref()) {
                (Some(a), Some(b)) if a == b => {
                    // Both agree: high confidence.
                    merged_marks.insert(day, a.to_string());
                }
                (Some(a), Some(b)) => {
                    // Both spoke but differ: primary wins, flag.
                    merged_marks.insert(day.clone(), a.to_string());
                    uncertain.push(MonthUncertainCell {
                        child_name: prow.child_name.clone(),
                        day: day.clone(),
                        votes: vec![a.to_string(), b.to_string()],
                        picked: a.to_string(),
                    });
                }
                (Some(a), None) => {
                    // Only primary saw a mark: take it but flag.
                    merged_marks.insert(day.clone(), a.to_string());
                    uncertain.push(MonthUncertainCell {
                        child_name: prow.child_name.clone(),
                        day: day.clone(),
                        votes: vec![a.to_string(), "-".to_string()],
                        picked: a.to_string(),
                    });
                }
                (None, Some(b)) => {
                    // Only secondary saw a mark: primary said blank. Do NOT
                    // write the mark (avoid over-marking) but surface for
                    // review so the user can choose to add it manually.
                    uncertain.push(MonthUncertainCell {
                        child_name: prow.child_name.clone(),
                        day: day.clone(),
                        votes: vec!["-".to_string(), b.to_string()],
                        picked: "-".to_string(),
                    });
                }
                (None, None) => { /* unreachable */ }
            }
        }
        if !merged_marks.is_empty() {
            merged.push(ExtractedMonthAttendanceRow {
                child_name: prow.child_name.clone(),
                marks: merged_marks,
            });
        }
    }
    // Secondary rows the primary missed entirely: surface every mark as
    // "primary=blank, secondary=X" for review, do NOT auto-import.
    for srow in secondary {
        let key = norm_child_name(&srow.child_name);
        if primary_keys.contains(&key) { continue; }
        for (day, mark) in &srow.marks {
            uncertain.push(MonthUncertainCell {
                child_name: srow.child_name.clone(),
                day: day.clone(),
                votes: vec!["-".to_string(), mark.to_string()],
                picked: "-".to_string(),
            });
        }
    }
    (merged, uncertain)
}

#[tauri::command]
pub async fn extract_month_attendance(args: ExtractMonthAttendanceArgs) -> Result<ExtractMonthAttendanceResult, String> {
    // Strict-validate target_month early (L3 fix). Malformed input now
    // returns an error instead of silently degrading OCR quality via the
    // best-effort 31-day fallback in expected_days_in_month.
    let expected_days = expected_days_in_month_strict(&args.target_month)
        .map_err(|e| format!("invalid target_month {:?}: {}", args.target_month, e))?;

    let known_hint = if args.known_student_names.is_empty() {
        "(none - use names exactly as written on the sheet)".to_string()
    } else {
        args.known_student_names.join(", ")
    };

    let schema = json!({
        "type": "object",
        "properties": {
            "month": { "type": "string", "description": format!("YYYY-MM detected from the header. Default: {}", args.target_month) },
            "days_centre_open": { "type": ["integer", "null"], "description": "The 'Number of days Centre __ open' figure in the header, if legible." },
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "child_name": { "type": "string",
                            "description": format!("Exact child name as written. Known children: {known_hint}") },
                        "marks": {
                            "type": "array",
                            "description": "One entry per day where the cell has an actual P/A mark. Omit blank cells and cells inside Saturday/Sunday bands or Stat Holiday columns.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "day":  { "type": "string", "description": format!("Day-of-month as string, '1'..'{}' (the target month has {} days).", expected_days, expected_days) },
                                    "mark": { "type": "string", "enum": ["P","A"], "description": format!("\
                                        VISUAL RULES (apply strictly, in order):\n\
                                        (1) 'P' = the cell contains TWO strokes that intersect — a clear X or +, a checkmark ✓, an asterisk/star ✱ ★, or the hand-written letter 'P'. The intersection is the deciding feature. A single stroke is NEVER 'P'.\n\
                                        (2) 'A' = a single stroke roughly parallel to the row (dash '-', en-dash, hyphen, minus sign, underscore) OR a hand-written 'A'. Never emit 'A' for two crossing strokes.\n\
                                        (3) BLANK / EMPTY cell: OMIT this array entry entirely. Do NOT emit 'A' for a truly empty cell — the sheet is filled progressively and future days are legitimately blank. Emitting 'A' for a blank cell corrupts payroll and subsidy math.\n\
                                        (4) Cells inside a shaded/tinted grey weekend column, a yellow/tan STAT column, or any column labelled vertically 'STAT'/'Stat Holiday'/'Closed' are NOT data cells — OMIT them. Staff never write in these columns; if you see ink there you have drifted, recount columns from the header.\n\
                                        (5) COLUMN ALIGNMENT: the top-of-sheet numeric labels are ground truth. This month has {n} day columns. On the Echelon printed sheet, weekend columns are visibly narrower but are still numbered — do NOT merge adjacent narrow columns (e.g. '4' and '5') into one. On the older Luxmi hand-drawn sheet, weekend days are inside wide 'Saturday & Sunday' bands with no per-day numbering; the numbered day columns pick up on the next weekday after each band. Count exactly {n} day columns before assigning marks; if you count fewer, you have merged something and must recount.\n\
                                        (6) When uncertain P vs A for a cell that clearly has ink, prefer 'A' (single-stroke is more common than accidental cross). When uncertain whether a cell has ink at all, prefer OMITTING (rule 3).", n = expected_days) }
                                },
                                "required": ["day", "mark"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["child_name", "marks"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["month", "days_centre_open", "rows"],
        "additionalProperties": false
    });

    let key = crate::secrets::get_secret("azure_ai_key")?;
    let system_prompt = "You are a precise OCR service. You read a paper daycare monthly attendance grid photographed by staff and emit ONLY strict JSON matching the provided schema. Never add prose. Never invent marks. Never emit 'A' for a blank cell. Never fill in blank cells to make rows look complete. When the image is ambiguous, prefer omission over guessing. A hallucinated mark corrupts payroll math and subsidy claims; an omitted mark is trivially fixed by the reviewer. Column drift (assigning a mark to the wrong day) is the single most damaging error and must be avoided even at the cost of leaving a row incomplete. No child attends more than 22 days in a 31-day month; if you drafted more, you over-marked and must recount.".to_string();

    // Calendar hints: pass the caller's known weekend / STAT / closed days
    // for the target month. These are corroboration ONLY — never override
    // what the model reads from the image, but they let the model detect
    // its own drift (ink in a weekend cell = mis-aligned columns).
    let fmt_days = |v: &Vec<u32>| -> String {
        if v.is_empty() { "(none)".to_string() }
        else { v.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(", ") }
    };
    let weekend_hint = fmt_days(&args.weekend_days);
    let stat_hint = fmt_days(&args.stat_days);
    let closed_hint = fmt_days(&args.closed_days);
    let roster_size = args.known_student_names.len();
    let numbered_roster = if args.known_student_names.is_empty() {
        "(unknown — read names as written)".to_string()
    } else {
        args.known_student_names.iter().enumerate()
            .map(|(i, n)| format!("{}. {}", i + 1, n))
            .collect::<Vec<_>>().join("\n")
    };

    let user_prompt = format!(
        "TASK\n\
         You are extracting handwritten attendance marks from a paper monthly grid for {month} at a small daycare in Vancouver, BC. The target month has exactly {expected_days} day columns. Your output feeds payroll and government subsidy math — every false mark you invent costs the centre real money, and every true mark you miss short-changes a family. Under-reporting is always safer than over-reporting; a human reviews your output before it lands in the ledger.\n\
         \n\
         SHEET LAYOUT — two variants are in circulation. Detect which one the photo matches, then apply the matching rules.\n\
         \n\
         Variant A: Echelon printed sheet (most common).\n\
         - Landscape Letter. Four corner black squares (fiducials); a QR code sits top-right.\n\
         - Title 'Echelon Daycare Society'. Subtitle 'Attendance report for month of {month}...'.\n\
         - Table header lists 'Child' then EVERY day number 1..{expected_days} across the top. Exactly {expected_days} numbered day columns.\n\
         - Weekend columns (Sat & Sun) are grey-tinted and visibly NARROWER but ARE still numbered — do not merge '4' and '5' into '45'.\n\
         - STAT columns are yellow/tan tinted with a vertical 'STAT' label; also narrower.\n\
         - Thicker vertical dividers appear on Sundays (visual week boundary).\n\
         - First column of the body table = child name (first + last).\n\
         \n\
         Variant B: Luxmi hand-drawn sheet (older, still accepted).\n\
         - Portrait or landscape hand-drawn grid on lined paper.\n\
         - Between weeks, wide vertical bands span both Saturday AND Sunday together — those bands have NO per-day numbering and are NOT day columns; skip them entirely and pick numbering back up on the next weekday.\n\
         - STAT columns carry a vertical multi-row text label like 'Stat Holiday' / 'Holiday' / 'Closed' — also NOT day columns; skip them.\n\
         - Day numbers appear only above the weekday columns and re-anchor after each band.\n\
         \n\
         Both variants: handwritten marks are 'X' = present (two crossing strokes), '-' or '–' = absent (single horizontal stroke), empty = future/unmarked.\n\
         \n\
         GROUND TRUTH (from the centre's records — trust these over anything the image seems to say)\n\
         - Target month: {month}\n\
         - Total day columns to find (Variant A) or day numbers to see across the whole grid (Variant B): {expected_days}\n\
         - Weekend days this month: {weekend_hint}\n\
         - STAT holidays this month: {stat_hint}\n\
         - Centre-closed days (custom closures): {closed_hint}\n\
         - Roster (exactly {roster_size} children — every row you emit MUST match one of these names verbatim, or be flagged as an unknown extra row):\n{numbered_roster}\n\
         \n\
         TYPICAL ROW DENSITY (calibration — this is the single biggest safeguard against hallucinated marks)\n\
         - A full-time enrolled child typically attends 15-22 open days in a month with ~22 open days.\n\
         - A part-time enrolled child typically attends 4-12 open days.\n\
         - The centre is closed weekends, statutory holidays, and any listed closures above; NEVER emit a mark for those days regardless of what you think you see.\n\
         - HARD CEILING: no single row should have more than 22 total marks (P + A combined) in a 30/31-day month. If your row draft exceeds this, you are hallucinating in blank cells — restart the row, and this time count blanks explicitly.\n\
         - Row density is a self-audit: after drafting each row, ask 'does this pattern look like a real daycare attendance record, or does it look like I filled in cells that were actually blank?'\n\
         - Sheets are filled progressively — TODAY is midway through the month. Days after the last-filled column across ALL rows are almost certainly all blank; do not project marks into the future.\n\
         \n\
         HARD RULES\n\
         1. NEVER emit a mark for a cell that corresponds to a weekend day, a STAT holiday, or a centre-closed day per the ground truth above. Staff do not write in those cells. If you see ink there, you have drifted — recount columns from the leftmost day label '1' before emitting anything.\n\
         2. Count exactly {expected_days} day columns (Variant A) or day numbers (Variant B) BEFORE you start reading marks. If your count is off, restart column detection using the numeric day labels as anchors.\n\
         3. Every row you emit must match a roster name via first-name AND last-name (case-insensitive; ignore middle names). If a handwritten name does not clearly match any roster entry, emit the row anyway with the name as read — the downstream reviewer will resolve it.\n\
         4. BLANK cells (no visible ink) → OMIT the day entry from that row's marks array. Never emit 'A' for a blank cell. Never 'fill in' a blank between two marked cells to make the row look complete. Better to under-report than to invent absences.\n\
         5. Single horizontal stroke = 'A' (absent). Two crossing strokes = 'P' (present). No third category exists. If ink is present but the shape is unclear, prefer 'A'.\n\
         6. Preserve column alignment across corroboration: if the ground truth says day D is a weekend/STAT/closed but your read shows any mark at that position, you have almost certainly counted columns wrong — re-anchor on the day-number header and try again.\n\
         7. The 'days_centre_open' field is the underline-blanked value in the subtitle ('Number of days Centre ___ open'). If it's not filled in on the sheet, return null. Do NOT compute it yourself.\n\
         8. FINAL SELF-CHECK before emitting: for each row, count total marks. If any row exceeds 22 marks or if the total across all rows exceeds roster_size × 20, you have almost certainly over-marked; re-examine those rows and remove marks in cells you are not certain contain ink.\n\
         \n\
         Emit JSON matching the schema. No prose, no comments, no wrapping ```json fences.",
        month = args.target_month,
        expected_days = expected_days,
        weekend_hint = weekend_hint,
        stat_hint = stat_hint,
        closed_hint = closed_hint,
        roster_size = roster_size,
        numbered_roster = numbered_roster,
    );

    // Downscale once up-front so both providers get the same compact input.
    // Photos from phones are typically 3000-4000px — we don't need that
    // resolution to read handwritten grid marks. Note: PDFs are rejected
    // earlier because Azure GPT-4 vision refuses application/pdf on the
    // chat completions image_url endpoint.
    if args.mime_type.eq_ignore_ascii_case("application/pdf") {
        return Err(
            "PDF uploads aren't supported for monthly attendance yet — please export the sheet as JPG or PNG and try again."
                .to_string(),
        );
    }
    let (image_b64, mime_type) = downscale_for_vision(&args.image_b64, &args.mime_type);

    // Run both providers in parallel. Primary carries reasoning_effort;
    // secondary is a fast model providing a second opinion. Cost/latency:
    // total wall clock = slower of the two (~5-15s for gpt-5.4, ~3-5s
    // for gpt-4.1).
    let key_ref = &key;
    let img_ref = image_b64.as_str();
    let mime_ref = mime_type.as_str();
    let schema_a = schema.clone();
    let schema_b = schema.clone();
    let sys_a = system_prompt.clone();
    let user_a = user_prompt.clone();
    let sys_b = system_prompt.clone();
    let user_b = user_prompt.clone();
    let primary_fut = async {
        let started = std::time::Instant::now();
        // FIX-1: bound primary at 300s so a hung gpt-5.4 can't drag the
        // whole join past 5 min. Secondary is bounded at 120s below.
        // Both bounds are wall-clock, not per-attempt.
        let res = match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            call_gpt_vision_json(
                key_ref, VISION_DEPLOY_PRIMARY, img_ref, mime_ref,
                schema_a, "MonthAttendanceExtraction", &sys_a, &user_a,
                Some("medium"),
            ),
        ).await {
            Ok(r) => r,
            Err(_) => Err(format!("primary ({VISION_DEPLOY_PRIMARY}) timed out after 300s")),
        };
        (started.elapsed().as_millis() as u64, res)
    };
    let secondary_fut = async {
        let started = std::time::Instant::now();
        // FIX-1: bound secondary at 120s. gpt-4.1 usually finishes in 20-40s;
        // 120s is a soft cap that prevents a stuck secondary from blocking join.
        let res = match tokio::time::timeout(
            std::time::Duration::from_secs(120),
            call_gpt_vision_json(
                key_ref, VISION_DEPLOY_SECONDARY, img_ref, mime_ref,
                schema_b, "MonthAttendanceExtraction", &sys_b, &user_b,
                None,
            ),
        ).await {
            Ok(r) => r,
            Err(_) => Err(format!("secondary ({VISION_DEPLOY_SECONDARY}) timed out after 120s")),
        };
        (started.elapsed().as_millis() as u64, res)
    };
    let ((p_ms, p_res), (s_ms, s_res)) = tokio::join!(primary_fut, secondary_fut);
    eprintln!(
        "[month-ocr] primary={} in {}ms ok={}, secondary={} in {}ms ok={}",
        VISION_DEPLOY_PRIMARY, p_ms, p_res.is_ok(),
        VISION_DEPLOY_SECONDARY, s_ms, s_res.is_ok(),
    );
    if let Err(ref e) = p_res { eprintln!("[month-ocr] primary error: {}", truncate(e, 600)); }
    if let Err(ref e) = s_res { eprintln!("[month-ocr] secondary error: {}", truncate(e, 600)); }

    // If primary hard-failed, try to fall back to the secondary — otherwise bail.
    let (primary_annotation, primary_ok, primary_err_str): (String, bool, Option<String>) = match p_res {
        Ok(a) => (a, true, None),
        Err(e) => {
            let err_str = redact(e, &key);
            eprintln!("[month-ocr] primary failed — falling back to secondary only");
            match &s_res {
                Ok(a) => (a.clone(), false, Some(err_str)),
                Err(_) => return Err(format!("both providers failed. primary ({VISION_DEPLOY_PRIMARY}): {err_str}")),
            }
        }
    };
    let (month, days_centre_open, primary_model_rows) =
        parse_month_annotation(&primary_annotation, &args.target_month)
            .map_err(|e| redact(e, &key))?;

    // Secondary is best-effort — degrade to primary-only if it failed OR if
    // we already promoted secondary into primary above.
    let (secondary_model_rows, secondary_err): (Vec<ExtractedMonthAttendanceRow>, Option<String>) = if primary_ok {
        match s_res {
            Ok(ann) => match parse_month_annotation(&ann, &args.target_month) {
                Ok((_, _, rows)) => (rows, None),
                Err(e) => (Vec::new(), Some(redact(e, &key))),
            },
            Err(e) => (Vec::new(), Some(redact(e, &key))),
        }
    } else {
        // Secondary was already promoted to primary — no cross-check available.
        (Vec::new(), Some("primary timed out; no second opinion available".to_string()))
    };

    // Raw per-model counts BEFORE any swap — used for `providers[]` metadata.
    let primary_model_row_count = primary_model_rows.len();
    let primary_model_mark_count: usize = primary_model_rows.iter().map(|r| r.marks.len()).sum();
    let secondary_model_row_count = secondary_model_rows.len();
    let secondary_model_mark_count: usize = secondary_model_rows.iter().map(|r| r.marks.len()).sum();

    // ── v3.0.7 consensus row-count sanity check ─────────────────────────
    // Silent primary failures are the single most damaging OCR bug: the
    // review UI shows only what primary imported, so 23 missing rows look
    // like the app said "not on sheet" when actually primary just gave up.
    // The July 2026 test scan hit this exactly: primary returned 2 of 25
    // rows in 145s (near-timeout), secondary returned all 25 in 67s — but
    // the review modal imported only primary's 2.
    //
    // Rule: if BOTH models succeeded AND primary saw < 50% of the roster
    // AND secondary saw >= 80% of it, swap. Asymmetric on purpose — never
    // promote a chatty secondary over a solid primary (that would let a
    // hallucinating secondary invent rows). Roster size 0 → skip (we have
    // no yardstick).
    let roster_size = args.known_student_names.len();
    let (source_rows, cross_rows, consensus_action, action_note): (
        Vec<ExtractedMonthAttendanceRow>,
        Vec<ExtractedMonthAttendanceRow>,
        String,
        Option<String>,
    ) = if !primary_ok {
        // primary_model_rows already came from the promoted secondary above.
        (primary_model_rows, secondary_model_rows, "secondary_only".to_string(), None)
    } else if secondary_err.is_some() {
        (primary_model_rows, secondary_model_rows, "primary_only".to_string(), None)
    } else if roster_size > 0
        && primary_model_row_count * 2 < roster_size            // primary < 50%
        && secondary_model_row_count * 5 >= roster_size * 4     // secondary >= 80%
    {
        let note = format!(
            "consensus: primary {} returned {}/{} rows; secondary {} returned {}/{} rows. Promoting secondary as source of truth.",
            VISION_DEPLOY_PRIMARY, primary_model_row_count, roster_size,
            VISION_DEPLOY_SECONDARY, secondary_model_row_count, roster_size,
        );
        eprintln!("[month-ocr] {}", note);
        // Swap: secondary becomes the source, primary becomes the cross-check.
        (secondary_model_rows, primary_model_rows, "secondary_promoted".to_string(), Some(note))
    } else {
        (primary_model_rows, secondary_model_rows, "primary".to_string(), None)
    };

    // v3.0.8: density signal — after choosing the source rows, compute
    // avg marks per row. If both models return absurdly dense rows (>15
    // avg, i.e. >~2x realistic daycare attendance) the source is almost
    // certainly hallucinating. Surface this in the note so the UI can
    // warn even more loudly and pre-uncheck rows for manual review.
    let source_rows_snapshot: Vec<ExtractedMonthAttendanceRow>;
    let cross_rows_snapshot: Vec<ExtractedMonthAttendanceRow>;
    let final_consensus_action: String;
    let final_action_note: Option<String>;
    {
        let (sr, cr, ca, an) = (source_rows, cross_rows, consensus_action, action_note);
        let source_marks: usize = sr.iter().map(|r| r.marks.len()).sum();
        let source_rows_with_marks = sr.iter().filter(|r| !r.marks.is_empty()).count().max(1);
        let avg_marks_per_row = source_marks as f32 / source_rows_with_marks as f32;
        // A realistic upper bound for a "normal" row is ~22 marks (fully
        // filled full-time child in a 22-open-day month). 15 is our warn
        // threshold — well above real life, well below full hallucination.
        let (dense, new_action, note) = if avg_marks_per_row > 15.0 {
            let n = format!(
                "density warning: source rows average {:.1} marks/row (roster {}, total marks {}); realistic max is ~22. Recommend row-by-row review before import.",
                avg_marks_per_row, roster_size, source_marks,
            );
            eprintln!("[month-ocr] {}", n);
            let combined_note = match &an {
                Some(existing) => format!("{} {}", existing, n),
                None => n.clone(),
            };
            // Tag the action as "_dense" so the UI can gate the review flow.
            let ca_dense = if ca.ends_with("_dense") { ca.clone() } else { format!("{}_dense", ca) };
            (true, ca_dense, Some(combined_note))
        } else {
            (false, ca.clone(), an.clone())
        };
        source_rows_snapshot = sr;
        cross_rows_snapshot = cr;
        final_consensus_action = new_action;
        final_action_note = note;
        let _ = dense;
    }
    let source_rows = source_rows_snapshot;
    let cross_rows = cross_rows_snapshot;
    let consensus_action = final_consensus_action;
    let action_note = final_action_note;

    let (rows, uncertain_cells) = if cross_rows.is_empty()
        && (consensus_action.starts_with("primary_only") || consensus_action.starts_with("secondary_only"))
    {
        // No consensus available — pass through source as-is.
        (source_rows.clone(), Vec::new())
    } else {
        merge_month_consensus(&source_rows, &cross_rows)
    };

    // Providers metadata reports RAW per-model output — never the swap.
    // Consumers use `consensus_action` to know what the source was.
    let providers = vec![
        MonthProviderMeta {
            provider: VISION_DEPLOY_PRIMARY.to_string(),
            ok: primary_ok,
            latency_ms: p_ms,
            row_count: if primary_ok { primary_model_row_count } else { 0 },
            mark_count: if primary_ok { primary_model_mark_count } else { 0 },
            error: primary_err_str,
        },
        MonthProviderMeta {
            provider: VISION_DEPLOY_SECONDARY.to_string(),
            ok: primary_ok && secondary_err.is_none(),
            latency_ms: s_ms,
            row_count: secondary_model_row_count,
            mark_count: secondary_model_mark_count,
            error: secondary_err,
        },
    ];

    // Prepend the promotion note (if any) to raw_text so it surfaces in
    // debug output too. Keeps the diagnostic self-contained.
    let raw_text = match action_note {
        Some(n) => format!("[consensus] {}\n\n{}", n, primary_annotation),
        None => primary_annotation,
    };

    Ok(ExtractMonthAttendanceResult {
        month,
        days_centre_open,
        rows,
        raw_text,
        uncertain_cells,
        providers,
        consensus_action,
    })
}

// ─── Visa / credit-card statement extraction ────────────────────────────

#[derive(Deserialize)]
pub struct ExtractVisaArgs {
    pub file_b64: String,
    pub mime_type: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ExtractedVisaTxn {
    pub date: String,
    pub merchant: String,
    pub amount: f64,
    pub foreign_amount: Option<String>,
    pub category_guess: Option<String>,
}

#[derive(Serialize)]
pub struct ExtractVisaResult {
    pub statement_period: Option<String>,
    pub card_last4: Option<String>,
    pub statement_total: Option<f64>,
    pub transactions: Vec<ExtractedVisaTxn>,
    pub raw_text: String,
}

#[tauri::command]
pub async fn extract_visa_statement(args: ExtractVisaArgs) -> Result<ExtractVisaResult, String> {
    let schema = json!({
        "type": "object",
        "properties": {
            "statement_period": { "type": ["string", "null"], "description": "YYYY-MM-DD to YYYY-MM-DD" },
            "card_last4":       { "type": ["string", "null"], "description": "Last 4 digits of the card number" },
            "statement_total":  { "type": ["number", "null"], "description": "The 'new balance' or 'total activity' figure" },
            "transactions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "date":           { "type": "string",  "description": "YYYY-MM-DD (posting date preferred)" },
                        "merchant":       { "type": "string",  "description": "Merchant name exactly as printed" },
                        "amount":         { "type": "number",  "description": "POSITIVE for charges/purchases/fees; NEGATIVE for payments, refunds, credits" },
                        "foreign_amount": { "type": ["string", "null"], "description": "e.g. 45.00 USD if the row shows a foreign currency, else null" },
                        "category_guess": { "type": ["string", "null"], "description": "One short label: Groceries, Utilities, Fuel, Subscription, Payment, Interest, etc." }
                    },
                    "required": ["date", "merchant", "amount", "foreign_amount", "category_guess"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["statement_period", "card_last4", "statement_total", "transactions"],
        "additionalProperties": false
    });

    let key_for_redact = crate::secrets::get_secret("azure_ai_key")?;
    let annotation = call_mistral_doc_ai(
        &key_for_redact, &args.file_b64, &args.mime_type, schema, "VisaStatementExtraction"
    ).await?;

    let parsed: serde_json::Value = serde_json::from_str(&annotation)
        .map_err(|e| redact(format!("model output not JSON: {e} :: {}", truncate(&annotation, 400)), &key_for_redact))?;

    let statement_period = parsed["statement_period"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let card_last4 = parsed["card_last4"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let statement_total = parsed["statement_total"].as_f64();

    let txns_json = parsed["transactions"].as_array().cloned().unwrap_or_default();
    let mut transactions: Vec<ExtractedVisaTxn> = Vec::with_capacity(txns_json.len());
    for t in txns_json {
        let date = t["date"].as_str().unwrap_or("").trim().to_string();
        let merchant = t["merchant"].as_str().unwrap_or("").trim().to_string();
        let amount = t["amount"].as_f64().unwrap_or(0.0);
        if date.len() < 10 || merchant.is_empty() { continue; }
        transactions.push(ExtractedVisaTxn {
            date, merchant, amount,
            foreign_amount: t["foreign_amount"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            category_guess: t["category_guess"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        });
    }

    Ok(ExtractVisaResult { statement_period, card_last4, statement_total, transactions, raw_text: annotation })
}

// Placeholder-name scrubber — same logic as the old Gemini path.
fn is_placeholder_name(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    if n.is_empty() { return true; }
    let placeholders = ["staff", "person", "employee", "worker", "teacher", "child", "student", "kid", "unknown", "name", "n/a", "tbd"];
    for p in placeholders {
        if n == p { return true; }
        if n.starts_with(&format!("{p} ")) || n.starts_with(&format!("{p}#")) || n.starts_with(&format!("{p}-")) {
            let rest = &n[p.len()..].trim_start_matches(|c: char| c == ' ' || c == '#' || c == '-');
            if rest.chars().all(|c| c.is_ascii_alphanumeric()) && rest.len() <= 3 { return true; }
        }
    }
    false
}

// ─── Staff credential document extraction ───────────────────────────────
// Reads photos/scans/PDFs of ECE certificates, First Aid cards, Criminal
// Record Checks, TB clearances, immunization records, orientation sign-offs.
// Extracts a structured record the user can review before saving.

#[derive(Deserialize)]
pub struct ExtractCredentialArgs {
    pub file_b64: String,
    pub mime_type: String,
    // Roster of staff names on file, used for fuzzy-matching the certificate
    // holder without asking the LLM to invent a name.
    pub known_staff_names: Vec<String>,
    // The credential-type catalog we already track, so the model chooses one
    // of the canonical labels instead of inventing "First Aid Cert v3".
    pub known_credential_types: Vec<String>,
}

#[derive(Serialize)]
pub struct ExtractCredentialResult {
    pub staff_name_guess: Option<String>,
    pub credential_type_guess: Option<String>,
    pub issuer: Option<String>,
    pub issued_date: Option<String>,
    pub expiry_date: Option<String>,
    pub certificate_number: Option<String>,
    pub notes: Option<String>,
    pub raw_text: String,
}

#[tauri::command]
pub async fn extract_credential(args: ExtractCredentialArgs) -> Result<ExtractCredentialResult, String> {
    // We keep the schema strict + list the known types so the model is nudged
    // toward one of our canonical labels; "Other" is allowed for anything
    // outside the catalog.
    let types_hint = if args.known_credential_types.is_empty() {
        "ECE Certificate, Criminal Record Check, Child Care First Aid, TB Clearance, Immunization Record, Policy / Orientation Sign-off, Other".to_string()
    } else {
        format!("{}, Other", args.known_credential_types.join(", "))
    };
    let names_hint = if args.known_staff_names.is_empty() {
        "".to_string()
    } else {
        format!(" Prefer matching the certificate holder to one of these staff names when possible: {}.", args.known_staff_names.join(", "))
    };

    let schema = json!({
        "type": "object",
        "properties": {
            "staff_name_guess":       { "type": ["string", "null"], "description": format!("Full name of the certificate holder, or the closest match from the roster.{}", names_hint) },
            "credential_type_guess":  { "type": ["string", "null"], "description": format!("One of: {}", types_hint) },
            "issuer":                 { "type": ["string", "null"], "description": "Issuing body / organization (e.g. Justice Institute of BC, Red Cross, ECEBC, Ministry of Public Safety)." },
            "issued_date":            { "type": ["string", "null"], "description": "Date issued in YYYY-MM-DD. Null if not printed on the document." },
            "expiry_date":            { "type": ["string", "null"], "description": "Expiry / renewal-due date in YYYY-MM-DD. Null if not printed." },
            "certificate_number":     { "type": ["string", "null"], "description": "Certificate / registration / file number exactly as printed, else null." },
            "notes":                  { "type": ["string", "null"], "description": "One short line combining anything useful the user should see (course name, sub-modules like CPR-C, etc.). Null if there is nothing extra." }
        },
        "required": ["staff_name_guess", "credential_type_guess", "issuer", "issued_date", "expiry_date", "certificate_number", "notes"],
        "additionalProperties": false
    });

    let key_for_redact = crate::secrets::get_secret("azure_ai_key")?;
    let annotation = call_mistral_doc_ai(
        &key_for_redact, &args.file_b64, &args.mime_type, schema, "CredentialExtraction"
    ).await?;

    let parsed: serde_json::Value = serde_json::from_str(&annotation)
        .map_err(|e| redact(format!("model output not JSON: {e} :: {}", truncate(&annotation, 400)), &key_for_redact))?;

    fn s(v: &serde_json::Value) -> Option<String> {
        v.as_str().map(|x| x.trim().to_string()).filter(|x| !x.is_empty() && x.to_lowercase() != "null")
    }
    // Placeholder-name scrub: the model sometimes writes generic role labels
    // ("Staff Member", "Employee") when the holder line is blurry.
    let staff_name_guess = s(&parsed["staff_name_guess"]).filter(|n| !is_placeholder_name(n));

    Ok(ExtractCredentialResult {
        staff_name_guess,
        credential_type_guess: s(&parsed["credential_type_guess"]),
        issuer: s(&parsed["issuer"]),
        issued_date: s(&parsed["issued_date"]).filter(|d| d.len() >= 10),
        expiry_date: s(&parsed["expiry_date"]).filter(|d| d.len() >= 10),
        certificate_number: s(&parsed["certificate_number"]),
        notes: s(&parsed["notes"]),
        raw_text: annotation,
    })
}
