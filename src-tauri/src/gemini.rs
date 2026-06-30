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

#[derive(Deserialize)]
pub struct ExtractAttendanceArgs {
    pub api_key: String,
    pub image_b64: String,
    pub mime_type: String,
    pub target_date: String,             // yyyy-mm-dd (default date the sheet covers)
    pub known_student_names: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ExtractedRow {
    pub staff_name: String,
    pub work_date: String,   // yyyy-mm-dd
    pub in_time: Option<String>,
    pub out_time: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ExtractedAttendanceRow {
    pub child_name: String,
    pub work_date: String,        // yyyy-mm-dd
    pub in_time: Option<String>,
    pub out_time: Option<String>,
    pub status: Option<String>,   // present | absent | sick | late | holiday
    pub signed_in_by: Option<String>,
    pub signed_out_by: Option<String>,
}

#[derive(Serialize)]
pub struct ExtractResult {
    pub rows: Vec<ExtractedRow>,
    pub raw_text: String,
}

#[derive(Serialize)]
pub struct ExtractAttendanceResult {
    pub rows: Vec<ExtractedAttendanceRow>,
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
        "You are reading a staff sign-in / timesheet for {month}. The sheet may be:\n\
        - a monthly grid (rows = staff, columns = days of the month), or\n\
        - a single-person timesheet, or\n\
        - a per-day list of a few people.\n\
        Do NOT assume any particular shape. Read what is actually visible.\n\
        \n\
        Known staff names (match to closest of these when reasonable): {staff_hint}.\n\
        \n\
        STRICT RULES — read carefully:\n\
        1. NEVER invent placeholder names like 'Staff 1', 'Staff 2', 'Person A', 'Employee 1', or 'Unknown'. If you cannot clearly read a name, SKIP that row entirely.\n\
        2. NEVER fabricate dates or times. Only output a row if you can read at least the staff name AND a real in_time OR out_time on the sheet.\n\
        3. If the image is blurry, low-contrast, partially cropped, or you are not confident, return an empty rows array: {{\"rows\": []}}. It is BETTER to return nothing than to guess.\n\
        4. The sheet may show only 1 staff member with 1 row of times — that is fine; return just that one row, not a synthetic month.\n\
        5. Skip blank cells, weekend cells (unless filled), header rows, and totals rows.\n\
        6. Convert all times to 24-hour HH:MM. If only one time is visible, set the other to null.\n\
        7. Use {month}-DD for the date prefix. If the day-of-month is unreadable, skip the row.\n\
        \n\
        Return ONLY JSON with this schema, no commentary:\n\
        {{\"rows\": [{{\"staff_name\": str, \"work_date\": \"YYYY-MM-DD\", \"in_time\": \"HH:MM\" or null, \"out_time\": \"HH:MM\" or null}}]}}",
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
        if name.is_empty() || date.len() < 10 { continue; }
        if is_placeholder_name(&name) { continue; }  // drop hallucinated "Staff 1" etc
        rows.push(ExtractedRow {
            staff_name: name,
            work_date: date,
            in_time: r["in_time"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            out_time: r["out_time"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        });
    }

    Ok(ExtractResult { rows, raw_text: inner })
}

#[tauri::command]
pub async fn extract_attendance(args: ExtractAttendanceArgs) -> Result<ExtractAttendanceResult, String> {
    let key_for_redact = args.api_key.clone();
    base64::engine::general_purpose::STANDARD
        .decode(args.image_b64.as_bytes())
        .map_err(|e| format!("image base64: {e}"))?;

    let student_hint = if args.known_student_names.is_empty() {
        "(none — use names exactly as written on the sheet)".to_string()
    } else {
        args.known_student_names.join(", ")
    };

    let prompt = format!(
        "You are reading a daycare child attendance / sign-in sheet. Target date for this sheet: {date}.\n\
        The sheet may be a single-day roster, a monthly grid (rows=children, cols=days), or a partial page with only a few children. Do NOT assume a shape — read what is actually visible.\n\
        \n\
        Known children (match to closest of these when names are written informally, nicknames, or partial spelling): {student_hint}.\n\
        \n\
        STRICT RULES:\n\
        1. NEVER invent placeholder names like 'Child 1', 'Student 2', 'Kid A'. If you cannot clearly read a name, SKIP that row.\n\
        2. NEVER fabricate dates, times, or signatures. Only output a row if you can read a real child name AND at least one of: in_time, out_time, or an explicit absent/sick/holiday marking.\n\
        3. If the image is blurry, low-contrast, partially cropped, or you are not confident, return an empty rows array: {{\"rows\": []}}. It is BETTER to return nothing than to guess.\n\
        4. The sheet may show only 1-2 children — return just those rows, not a synthetic full roster.\n\
        5. Skip blank cells, header rows, totals.\n\
        6. Convert all times to 24-hour HH:MM. If only one time is visible, set the other to null. If a row is explicitly marked Absent / Sick / Holiday with no times, return that status with null times.\n\
        7. Use {date} for work_date when the day cannot be otherwise inferred. If the day-of-month is unreadable on a multi-day sheet, skip the row.\n\
        8. Parent signatures go into signed_in_by / signed_out_by. If a single signature applies to both columns, copy it into both. If unreadable, leave null — do not invent names.\n\
        \n\
        Return ONLY JSON with this schema, no commentary:\n\
        {{\"rows\": [{{\"child_name\": str, \"work_date\": \"YYYY-MM-DD\", \"in_time\": \"HH:MM\" or null, \"out_time\": \"HH:MM\" or null, \"status\": \"present\"|\"absent\"|\"sick\"|\"late\"|\"holiday\" or null, \"signed_in_by\": str or null, \"signed_out_by\": str or null}}]}}",
        date = args.target_date,
        student_hint = student_hint
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
    let mut rows: Vec<ExtractedAttendanceRow> = Vec::with_capacity(rows_json.len());
    for r in rows_json {
        let name = r["child_name"].as_str().unwrap_or("").trim().to_string();
        let date = r["work_date"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || date.len() < 10 { continue; }
        if is_placeholder_name(&name) { continue; }  // drop hallucinated "Child 1" etc
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

    Ok(ExtractAttendanceResult { rows, raw_text: inner })
}

/// Detect obviously-synthetic placeholder names the model sometimes fabricates
/// when an image is unreadable ("Staff 1", "Person A", "Employee 2", "Child 3").
/// Used to scrub hallucinations server-side as a safety net on top of the prompt.
fn is_placeholder_name(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    if n.is_empty() { return true; }
    let placeholders = [
        "staff", "person", "employee", "worker", "teacher", "child",
        "student", "kid", "unknown", "name", "n/a", "tbd",
    ];
    for p in placeholders {
        // "staff 1", "staff #1", "staff-1", "staff a"
        if n == p { return true; }
        if n.starts_with(&format!("{p} ")) || n.starts_with(&format!("{p}#")) || n.starts_with(&format!("{p}-")) {
            let rest = &n[p.len()..].trim_start_matches(|c: char| c == ' ' || c == '#' || c == '-');
            if rest.chars().all(|c| c.is_ascii_alphanumeric()) && rest.len() <= 3 {
                return true;
            }
        }
    }
    false
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..n]) }
}
