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
    let body = json!({
        "model": MISTRAL_DOC_AI_MODEL,
        "document": { "type": "image_url", "image_url": data_url },
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

    let resp = client.post(MISTRAL_DOC_AI_URL)
        .header("api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), api_key))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| redact(format!("read: {e}"), api_key))?;
    if !status.is_success() {
        return Err(redact(format!("http {status} @ mistral-document-ai :: {}", truncate(&text, 800)), api_key));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| redact(format!("json: {e}"), api_key))?;
    v["document_annotation"].as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| redact(format!("no document_annotation in response: {}", truncate(&text, 400)), api_key))
}

// ─── Child attendance sign-in sheet ─────────────────────────────────────

#[derive(Deserialize)]
pub struct ExtractAttendanceArgs {
    pub azure_ai_key: String,
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

    let key_for_redact = args.azure_ai_key.clone();
    let annotation = call_mistral_doc_ai(
        &args.azure_ai_key, &args.image_b64, &args.mime_type, schema, "AttendanceExtraction"
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

// ─── Visa / credit-card statement extraction ────────────────────────────

#[derive(Deserialize)]
pub struct ExtractVisaArgs {
    pub azure_ai_key: String,
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

    let key_for_redact = args.azure_ai_key.clone();
    let annotation = call_mistral_doc_ai(
        &args.azure_ai_key, &args.file_b64, &args.mime_type, schema, "VisaStatementExtraction"
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
