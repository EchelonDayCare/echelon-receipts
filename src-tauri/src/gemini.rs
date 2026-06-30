// Gemini vision OCR for monthly staff sign-in sheets.
// Calls Generative Language API with an image + structured-output prompt.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize)]
pub struct ExtractArgs {
    pub api_key: String,
    pub image_b64: String,
    pub mime_type: String,        // e.g. "image/jpeg"
    pub month_year: String,       // e.g. "2026-06" — context for the model
    pub known_staff_names: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ExtractedRow {
    pub staff_name: String,
    pub work_date: String,   // yyyy-mm-dd
    pub in_time: Option<String>,
    pub out_time: Option<String>,
}

#[derive(Serialize)]
pub struct ExtractResult {
    pub rows: Vec<ExtractedRow>,
    pub raw_text: String,
}

const MODEL: &str = "gemini-2.5-flash";

/// Replace every occurrence of `secret` with `***` so the API key never leaks
/// through error messages, panic logs, or anything else displayed to the user.
fn redact(s: String, secret: &str) -> String {
    if secret.is_empty() { return s; }
    s.replace(secret, "***")
}

#[tauri::command]
pub async fn extract_timesheet(args: ExtractArgs) -> Result<ExtractResult, String> {
    let key_for_redact = args.api_key.clone();
    // Validate base64 quickly so we don't ship a giant garbage payload.
    base64::engine::general_purpose::STANDARD
        .decode(args.image_b64.as_bytes())
        .map_err(|e| format!("image base64: {e}"))?;

    let staff_hint = if args.known_staff_names.is_empty() {
        "(none — use names exactly as written on the sheet)".to_string()
    } else {
        args.known_staff_names.join(", ")
    };

    let prompt = format!(
        "You are reading a monthly staff sign-in sheet for {month}. \
Rows are staff members; columns are days of the month. \
Each filled cell typically contains an IN time and an OUT time (e.g. '8:30-4:30', '8:30/16:30', '0830 1630', or stacked on two lines). \
Known staff (match to closest of these if reasonable, otherwise return the name as written): {staff_hint}. \
Return ONLY JSON matching this schema with no commentary:\n\
{{\"rows\": [{{\"staff_name\": str, \"work_date\": \"YYYY-MM-DD\", \"in_time\": \"HH:MM\" or null, \"out_time\": \"HH:MM\" or null}}]}}\n\
Rules: convert all times to 24-hour HH:MM. Skip blank cells. Skip weekend cells unless they are filled. \
If only one time is visible, set the other to null. Use {month}-01 numbering for the date prefix.",
        month = args.month_year,
        staff_hint = staff_hint
    );

    let body = json!({
        "contents": [{
            "parts": [
                { "text": prompt },
                { "inline_data": { "mime_type": args.mime_type, "data": args.image_b64 } }
            ]
        }],
        "generationConfig": {
            "temperature": 0.0,
            "responseMimeType": "application/json"
        }
    });

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={key}",
        MODEL = MODEL,
        key = args.api_key
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), &key_for_redact))?;

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("gemini request: {e}"), &key_for_redact))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| redact(format!("gemini read: {e}"), &key_for_redact))?;
    if !status.is_success() {
        return Err(redact(format!("gemini http {status}: {}", truncate(&text, 800)), &key_for_redact));
    }

    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| redact(format!("gemini json: {e}"), &key_for_redact))?;
    let inner = v["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .ok_or_else(|| redact(format!("gemini: no text in response: {}", truncate(&text, 400)), &key_for_redact))?
        .to_string();

    let parsed: serde_json::Value = serde_json::from_str(&inner)
        .map_err(|e| redact(format!("model output not JSON: {e} :: {}", truncate(&inner, 400)), &key_for_redact))?;
    let rows_json = parsed["rows"].as_array().cloned().unwrap_or_default();
    let mut rows: Vec<ExtractedRow> = Vec::with_capacity(rows_json.len());
    for r in rows_json {
        let name = r["staff_name"].as_str().unwrap_or("").trim().to_string();
        let date = r["work_date"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || date.len() < 10 {
            continue;
        }
        rows.push(ExtractedRow {
            staff_name: name,
            work_date: date,
            in_time: r["in_time"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            out_time: r["out_time"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        });
    }

    Ok(ExtractResult { rows, raw_text: inner })
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..n]) }
}
