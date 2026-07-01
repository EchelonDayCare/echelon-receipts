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
    #[serde(default)]
    pub no_lunch: bool,      // true = "No Ln" box checked → skip 30-min deduction
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
    // Month Gemini actually read off the sheet (from title / header / QR text
    // / date column) as "YYYY-MM". None if the sheet was ambiguous and the
    // model fell back to the caller's hint. Frontend should prefer this over
    // its UI-picker value so a June sheet uploaded with the picker on July
    // still gets stamped June-01, June-02, ...
    pub detected_month_year: Option<String>,
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
        "You are reading a staff sign-in / timesheet photo. The caller thinks this sheet is for {month}, but that is only a HINT — the sheet itself is authoritative.\n\
        \n\
        STEP 0 — DETERMINE THE SHEET'S MONTH AND YEAR (do this FIRST):\n\
        - Look at the sheet's printed title/header text (e.g. 'JUNE 2026', 'Jun-2026', '06/2026').\n\
        - If the sheet has a QR code with readable text nearby, use that too.\n\
        - If neither is legible, look at any pre-printed date cells or the day-of-week columns.\n\
        - Choose the month + year you can actually read from the page. Only fall back to the hint '{month}' if the sheet gives you NO usable month signal.\n\
        - Report this in the output field `detected_month_year` as 'YYYY-MM'. Use YOUR detected month for every work_date below — NOT the hint.\n\
        \n\
        COMMON LAYOUTS — detect which one this is:\n\
        (A) Echelon monthly grid: 4 black corner squares + QR code, days 1-31 as ROWS down the left, staff names HANDWRITTEN in COLUMN HEADERS at the top, each staff column split into sub-columns 'in' and 'out' (and sometimes 'TH' which is usually blank — ignore TH). Weekend/holiday rows may be peach-shaded.\n\
        (B) Single-person timesheet: one staff name at the top, many days as rows below.\n\
        (C) Daily list: one or more rows, each with a name and times.\n\
        \n\
        Known staff names (match handwriting to closest of these when reasonable): {staff_hint}.\n\
        \n\
        HOW TO UNWRAP LAYOUT (A) into rows — this is critical:\n\
        - Read the column-header names ONCE (handwritten names at the top of each staff column).\n\
        - Each staff column has THREE sub-columns: 'IN', 'OUT', and 'No Ln' (a small checkbox).\n\
        - For every day-row with at least one filled time cell, emit ONE output row PER staff column that has data, using that column's header name as staff_name and the day-row's date as work_date.\n\
        - For each emitted row, ALSO report no_lunch: true if the 'No Ln' checkbox is clearly ticked/checked/marked for that day+staff, else false. If the box is empty or unclear, return false.\n\
        - Skip days where ALL staff cells are blank. Skip the column-header row itself.\n\
        - If a staff column header is blank/illegible, skip that ENTIRE column (do not invent 'Staff 1'/'Person A').\n\
        - If a single time is visible (only 'in' or only 'out'), still emit the row with the other field null.\n\
        \n\
        STRICT RULES (all layouts):\n\
        1. Extract EVERY filled cell. A monthly grid for 5 staff over 22 working days can legitimately produce 100+ rows — that is correct, not a hallucination, as long as each row corresponds to an actually-filled cell.\n\
        2. NEVER invent placeholder names like 'Staff 1', 'Person A', 'Employee 1', 'Unknown'. Use only names you can actually read from the page or match to the known list.\n\
        3. NEVER fabricate rows for empty cells. Output must match what is physically written.\n\
        4. Convert all times to 24-hour HH:MM (e.g. '8' → '08:00', '8:30' → '08:30', '3' on an OUT column → '15:00' if context makes PM obvious, otherwise '03:00').\n\
        5. Format work_date as `{{detected_month_year}}-DD` (DD = the row's day-of-month, zero-padded). Every row's YYYY-MM must equal the detected_month_year you chose in STEP 0.\n\
        6. Skip totals rows, signature rows, and the column-header row.\n\
        \n\
        Return ONLY JSON, no commentary:\n\
        {{\"detected_month_year\": \"YYYY-MM\", \"rows\": [{{\"staff_name\": str, \"work_date\": \"YYYY-MM-DD\", \"in_time\": \"HH:MM\" or null, \"out_time\": \"HH:MM\" or null, \"no_lunch\": true|false}}]}}",
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
    // Detected month is optional — very old prompt versions or fallbacks may omit it.
    let detected_month_year = parsed["detected_month_year"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() == 7 && s.chars().nth(4) == Some('-'));
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
            no_lunch: r["no_lunch"].as_bool().unwrap_or(false),
        });
    }

    Ok(ExtractResult { rows, raw_text: inner, detected_month_year })
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
        "You are reading a daycare child attendance / sign-in sheet. Target date: {date}.\n\
        The sheet may be a single-day roster, a monthly grid (rows=children, cols=days), or a partial page with only a few children. Do NOT assume a shape — read what is physically on the page.\n\
        \n\
        Known children (match to closest when names are written informally / nicknames): {student_hint}.\n\
        \n\
        STRICT RULES:\n\
        1. Extract EVERY row where you can clearly read a real child name AND at least one of: in_time, out_time, or an explicit Absent/Sick/Holiday marking. Do not skip legible rows.\n\
        2. NEVER invent placeholder names like 'Child 1', 'Student 2', 'Kid A'. If a row's name is illegible, skip THAT row — keep all other legible rows.\n\
        3. NEVER fabricate rows that aren't on the page.\n\
        4. The sheet may show only 1-2 children — return just those rows.\n\
        5. Skip blank cells, header rows, totals.\n\
        6. Convert all times to 24-hour HH:MM. If only one time is visible, set the other to null. If a row is explicitly Absent/Sick/Holiday with no times, return that status with null times.\n\
        7. Use {date} for work_date when the day cannot otherwise be inferred. On a multi-day sheet, only skip a row if its day is truly unreadable.\n\
        8. Parent signatures go into signed_in_by / signed_out_by. If one signature covers both columns, copy it to both. If unreadable, leave null.\n\
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
