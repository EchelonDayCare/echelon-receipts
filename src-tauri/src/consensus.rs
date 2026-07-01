// Multi-model OCR consensus for staff sign-in sheets.
//
// Runs two providers in parallel:
//   1. Mistral Document AI (image → structured JSON via Azure AI Foundry)
//   2. Mistral OCR         (image → markdown → parsed per-cell digits)
//
// Gemini was removed in v0.2.4 — it consistently scrambled row-alignment
// (swapped OUT columns between adjacent days) on handwritten sheets, which
// gave it deciding-vote power on the wrong answer. Doc AI + Mistral OCR
// digits together are more accurate. Gemini is still used by the Attendance
// screen via gemini.rs — that path is unchanged.

use base64::Engine;
use image::ImageDecoder;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::Cursor;
use std::time::{Duration, Instant};

use crate::gemini::ExtractedRow;

const PROVIDER_TIMEOUT_SECS: u64 = 45;
const MAX_IMAGE_EDGE: u32 = 2400;
const JPEG_QUALITY: u8 = 92;

#[derive(Deserialize)]
pub struct ConsensusArgs {
    pub image_b64: String,
    pub mime_type: String,
    pub month_year: String,
    pub known_staff_names: Vec<String>,
    // Azure AI Foundry key (serves both Doc AI and Mistral OCR).
    pub azure_ai_key: Option<String>,
}

// Auto-normalize the uploaded image so Mac vs Windows uploads land on
// identical bytes for the OCR services:
//   • Honor EXIF orientation (iPhone/Mac photos often carry rotation flags)
//   • Downscale to MAX_IMAGE_EDGE longest edge (Retina scans are huge)
//   • Re-encode as JPEG at JPEG_QUALITY (drops HEIC/PNG variance)
// Returns (new_base64, "image/jpeg") on success; falls back to the original
// bytes/mime silently if decoding fails so we never block OCR entirely.
fn normalize_image(orig_b64: &str, orig_mime: &str) -> (String, String) {
    let bytes = match base64::engine::general_purpose::STANDARD.decode(orig_b64.as_bytes()) {
        Ok(b) => b,
        Err(_) => return (orig_b64.to_string(), orig_mime.to_string()),
    };
    let reader = match image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format() {
        Ok(r) => r,
        Err(_) => return (orig_b64.to_string(), orig_mime.to_string()),
    };
    // Pull EXIF orientation from the decoder before decoding pixels.
    let mut decoder = match reader.into_decoder() {
        Ok(d) => d,
        Err(_) => return (orig_b64.to_string(), orig_mime.to_string()),
    };
    let orientation = decoder.orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = match image::DynamicImage::from_decoder(decoder) {
        Ok(i) => i,
        Err(_) => return (orig_b64.to_string(), orig_mime.to_string()),
    };
    img.apply_orientation(orientation);
    let (w, h) = (img.width(), img.height());
    if w > MAX_IMAGE_EDGE || h > MAX_IMAGE_EDGE {
        let scale = MAX_IMAGE_EDGE as f32 / w.max(h) as f32;
        let nw = (w as f32 * scale) as u32;
        let nh = (h as f32 * scale) as u32;
        img = img.resize(nw, nh, image::imageops::FilterType::Lanczos3);
    }
    let rgb = img.to_rgb8();
    let mut out = Vec::with_capacity(bytes.len());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    if image::ImageEncoder::write_image(
        encoder, rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8
    ).is_err() {
        return (orig_b64.to_string(), orig_mime.to_string());
    }
    (
        base64::engine::general_purpose::STANDARD.encode(&out),
        "image/jpeg".to_string(),
    )
}

#[derive(Serialize, Clone)]
pub struct ProviderOutput {
    pub provider: String,           // "gpt5" | "mistral_ocr"
    pub ok: bool,
    pub rows: Vec<ExtractedRow>,
    pub detected_month_year: Option<String>,
    pub raw_text: String,           // for debug panel
    pub error: Option<String>,
    pub latency_ms: u64,
}

#[derive(Serialize)]
pub struct ConsensusResult {
    pub providers: Vec<ProviderOutput>,
}

fn redact(s: String, secrets: &[&str]) -> String {
    let mut out = s;
    for sec in secrets {
        if !sec.is_empty() {
            out = out.replace(sec, "***");
        }
    }
    out
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..n]) }
}

fn is_placeholder_name(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    if n.is_empty() { return true; }
    let placeholders = ["staff", "person", "employee", "worker", "teacher", "unknown", "name", "n/a", "tbd", "day"];
    for p in placeholders {
        if n == p { return true; }
        if n.starts_with(&format!("{p} ")) || n.starts_with(&format!("{p}#")) || n.starts_with(&format!("{p}-")) {
            let rest = &n[p.len()..].trim_start_matches(|c: char| c == ' ' || c == '#' || c == '-');
            if rest.chars().all(|c| c.is_ascii_alphanumeric()) && rest.len() <= 3 { return true; }
        }
    }
    false
}

// (build_prompt removed in v0.2.4 — was only used by the Gemini provider,
// which was retired. Mistral Document AI uses a JSON schema instead.)

fn parse_structured_json(inner: &str) -> (Vec<ExtractedRow>, Option<String>) {
    let parsed: serde_json::Value = match serde_json::from_str(inner) {
        Ok(v) => v,
        Err(_) => return (vec![], None),
    };
    let rows_json = parsed["rows"].as_array().cloned().unwrap_or_default();
    let detected = parsed["detected_month_year"]
        .as_str().map(|s| s.trim().to_string())
        .filter(|s| s.len() == 7 && s.chars().nth(4) == Some('-'));
    let mut rows = Vec::with_capacity(rows_json.len());
    for r in rows_json {
        let name = r["staff_name"].as_str().unwrap_or("").trim().to_string();
        let date = r["work_date"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || date.len() < 10 { continue; }
        if is_placeholder_name(&name) { continue; }
        rows.push(ExtractedRow {
            staff_name: name,
            work_date: date,
            in_time: r["in_time"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            out_time: r["out_time"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            no_lunch: r["no_lunch"].as_bool().unwrap_or(false),
        });
    }
    (rows, detected)
}

// ─── Provider 1: Mistral Document AI (structured extraction) ─────────────
// Replaces GPT-5.4 (which was hallucinating missing rows and inventing
// weekend rows on our test sheet). Mistral Document AI uses the same
// /ocr endpoint as mistral-ocr-4-0 but accepts a JSON schema and returns
// a structured `document_annotation` alongside the raw markdown.
//
// Provider slot remains "gpt5" in the wire format to avoid a TS rename
// cascade — the frontend PROVIDER_LABELS entry displays the true name.
async fn call_azure_openai(
    api_key: &str, image_b64: &str, mime_type: &str,
    month_year: &str, known: &[String],
) -> Result<(Vec<ExtractedRow>, Option<String>, String), String> {
    let data_url = format!("data:{mime_type};base64,{image_b64}");
    let schema = json!({
        "type": "object",
        "properties": {
            "detected_month_year": { "type": "string",
                "description": "YYYY-MM read from the sheet header itself. Fallback hint: ".to_string() + month_year },
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "staff_name": { "type": "string",
                            "description": "Exact staff name as written. Known staff on this sheet: ".to_string() + &known.join(", ") },
                        "work_date": { "type": "string", "description": "YYYY-MM-DD" },
                        "in_time":   { "type": ["string", "null"], "description": "HH:MM 24-hour. Daycare opens ~07:30." },
                        "out_time":  { "type": ["string", "null"], "description": "HH:MM 24-hour. Daycare closes ~17:30 — infer PM." },
                        "no_lunch":  { "type": "boolean" }
                    },
                    "required": ["staff_name", "work_date", "in_time", "out_time", "no_lunch"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["detected_month_year", "rows"],
        "additionalProperties": false
    });
    let body = json!({
        "model": "mistral-document-ai-2512",
        "document": {
            "type": "image_url",
            "image_url": data_url
        },
        "document_annotation_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "TimesheetExtraction",
                "schema": schema,
                "strict": true
            }
        },
        "include_image_base64": false
    });
    let url = "https://ai-nse.services.ai.azure.com/providers/mistral/azure/ocr";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PROVIDER_TIMEOUT_SECS))
        .build().map_err(|e| format!("http client: {e}"))?;
    let resp = client.post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send().await
        .map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("read: {e}"))?;
    if !status.is_success() {
        return Err(format!("http {status} @ mistral-document-ai :: {}", truncate(&text, 800)));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("json: {e}"))?;
    // Mistral Document AI returns the structured extraction as a JSON string
    // in `document_annotation`, and the raw OCR text in `pages[].markdown`.
    let annotation = v["document_annotation"].as_str()
        .ok_or_else(|| format!("no document_annotation in response: {}", truncate(&text, 400)))?
        .to_string();
    let (rows, detected) = parse_structured_json(&annotation);
    Ok((rows, detected, annotation))
}

// ─── Provider 2: Mistral OCR ─────────────────────────────────────────────
// Mistral OCR returns per-page markdown. We convert its tabular markdown
// into ExtractedRow[] by heuristically parsing the Echelon grid layout:
// day-number rows down the left, staff columns with alternating IN/OUT
// (and optional No-Ln) sub-columns.
async fn call_mistral_ocr(
    api_key: &str, image_b64: &str, mime_type: &str, month_year_hint: &str,
    known_staff: &[String],
) -> Result<(Vec<ExtractedRow>, Option<String>, String), String> {
    let data_url = format!("data:{mime_type};base64,{image_b64}");
    let body = json!({
        "model": "mistral-ocr-4-0",
        "document": {
            "type": "image_url",
            "image_url": data_url,
        },
        "include_image_base64": false
    });
    let url = "https://ai-nse.services.ai.azure.com/providers/mistral/azure/ocr";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PROVIDER_TIMEOUT_SECS))
        .build().map_err(|e| format!("http client: {e}"))?;
    let resp = client.post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send().await
        .map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("read: {e}"))?;
    if !status.is_success() {
        return Err(format!("http {status} @ {url} :: {}", truncate(&text, 800)));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("json: {e}"))?;
    let markdown = v["pages"].as_array()
        .map(|arr| arr.iter()
            .filter_map(|p| p["markdown"].as_str())
            .collect::<Vec<_>>().join("\n\n"))
        .unwrap_or_default();
    if markdown.is_empty() {
        return Err(format!("no markdown in response: {}", truncate(&text, 300)));
    }
    let (rows, detected) = parse_mistral_markdown(&markdown, month_year_hint, known_staff);
    Ok((rows, detected, markdown))
}

// Best-effort parser for Mistral OCR markdown → ExtractedRow[].
//
// Strategy for Echelon monthly grid:
//   • Find markdown tables (lines with `|`).
//   • Header row: identify columns that look like time-header labels ("IN",
//     "OUT", "No Ln", or handwritten staff names). We treat each pair of
//     adjacent IN/OUT columns as belonging to a staff (name = column header
//     above that pair).
//   • Data rows: first cell = day-of-month; each subsequent staff-pair
//     yields one ExtractedRow if either IN or OUT parses to a time.
//
// Also tries to sniff a month header (e.g. "JUNE 2026") anywhere in the
// markdown so the frontend can prefer this over the UI-picker month.
fn parse_mistral_markdown(md: &str, month_year_hint: &str, _known_staff: &[String]) -> (Vec<ExtractedRow>, Option<String>) {
    let detected = sniff_month_year(md);
    let month_key = detected.clone().unwrap_or_else(|| month_year_hint.to_string());

    // Split into blocks of consecutive table lines.
    let mut rows_out: Vec<ExtractedRow> = Vec::new();
    let mut cur_block: Vec<Vec<String>> = Vec::new();
    let flush = |block: &mut Vec<Vec<String>>, rows_out: &mut Vec<ExtractedRow>, month: &str| {
        if block.len() >= 3 {
            extract_grid_from_block(block, rows_out, month);
        }
        block.clear();
    };
    for line in md.lines() {
        let l = line.trim();
        if l.starts_with('|') && l.ends_with('|') {
            let cells: Vec<String> = l.trim_matches('|').split('|')
                .map(|s| s.trim().to_string()).collect();
            cur_block.push(cells);
        } else if !cur_block.is_empty() {
            flush(&mut cur_block, &mut rows_out, &month_key);
        }
    }
    if !cur_block.is_empty() {
        flush(&mut cur_block, &mut rows_out, &month_key);
    }

    // Numeric-witness mode: Mistral cannot reliably read cursive staff names
    // (misreads "Judy" as "JUNE" etc.), and the Echelon sheet has no AM/PM
    // markers so OUT digits are literal (3:45, not 15:45). Instead of trying
    // to compete with Gemini/GPT as a semantic voter, Mistral only contributes
    // raw per-day digit reads. The frontend keys these by work_date to
    // corroborate Gemini/GPT's times (with a mod-12 tolerance for OUT).
    //
    // Sentinel staff_name ensures the frontend routes these rows to the
    // numeric-witness path, not the main staff-alignment bucket.
    for r in rows_out.iter_mut() {
        r.staff_name = MISTRAL_DIGITS_SENTINEL.to_string();
    }

    (rows_out, detected)
}

pub const MISTRAL_DIGITS_SENTINEL: &str = "__mistral_digits__";

fn sniff_month_year(md: &str) -> Option<String> {
    // Look for patterns like "JUNE 2026", "Jun 2026", "06/2026", "2026-06".
    let months = [
        ("january", 1),("february", 2),("march", 3),("april", 4),("may", 5),("june", 6),
        ("july", 7),("august", 8),("september", 9),("october", 10),("november", 11),("december", 12),
        ("jan", 1),("feb", 2),("mar", 3),("apr", 4),("jun", 6),("jul", 7),("aug", 8),
        ("sep", 9),("sept", 9),("oct", 10),("nov", 11),("dec", 12),
    ];
    let lower = md.to_lowercase();
    for (name, num) in months.iter() {
        if let Some(idx) = lower.find(name) {
            // Grab up to 20 chars after the month name; look for a 4-digit year.
            let tail = &lower[idx..std::cmp::min(idx + name.len() + 12, lower.len())];
            for (yi, _) in tail.match_indices(char::is_numeric).step_by(1) {
                if yi + 4 <= tail.len() {
                    let yr = &tail[yi..yi + 4];
                    if let Ok(y) = yr.parse::<u32>() {
                        if (2000..=2100).contains(&y) {
                            return Some(format!("{:04}-{:02}", y, num));
                        }
                    }
                }
            }
        }
    }
    // "YYYY-MM" or "MM/YYYY" anywhere
    for line in md.lines().take(30) {
        let s = line.trim();
        if s.len() >= 7 {
            let head = &s[..7.min(s.len())];
            if let (Some(y), Some(m)) = (head.get(0..4).and_then(|x| x.parse::<u32>().ok()),
                                          head.get(5..7).and_then(|x| x.parse::<u32>().ok())) {
                if (2000..=2100).contains(&y) && (1..=12).contains(&m) && head.chars().nth(4) == Some('-') {
                    return Some(format!("{:04}-{:02}", y, m));
                }
            }
        }
    }
    None
}

fn extract_grid_from_block(block: &[Vec<String>], out: &mut Vec<ExtractedRow>, month_key: &str) {
    if block.is_empty() { return; }
    let ncols = block[0].len();
    if ncols < 3 { return; }

    // Identify header row: the topmost row where at least ncols/2 cells are
    // non-numeric (i.e. text/labels). Then identify pairs of adjacent IN/OUT
    // columns using label sniffing, falling back to "every 2 columns after
    // column 0 is (IN, OUT), maybe with No-Ln column in between".
    let (header_idx, header) = block.iter().enumerate()
        .find(|(_, row)| row.iter().filter(|c| looks_like_label(c)).count() >= ncols / 2)
        .map(|(i, r)| (i, r.clone()))
        .unwrap_or((0, block[0].clone()));

    // Detect column roles. We resolve staff-name → (in_col, out_col, maybe noln_col).
    // `split_time` = Mistral rendered "8:30" as two adjacent cells ("| 8 | 30 |"),
    // so we need to combine (in_col, in_col+1) as IN and (in_col+2, in_col+3) as OUT.
    struct StaffCols { name: String, in_col: usize, out_col: usize, noln_col: Option<usize>, split_time: bool }
    let mut staff_cols: Vec<StaffCols> = Vec::new();

    // Approach A: scan headers looking for IN/OUT keywords and grab the
    // nearest preceding non-empty header cell as the staff name.
    let mut i = 1;
    while i < ncols {
        let cell = header.get(i).cloned().unwrap_or_default();
        if is_in_label(&cell) {
            let out_col = i + 1 + (0..2usize).find(|off| {
                let idx = i + 1 + off;
                idx < ncols && is_out_label(header.get(idx).unwrap_or(&String::new()))
            }).unwrap_or(0);
            if out_col < ncols {
                // staff name: walk back from i to find nearest non-empty non-label
                // in the header row itself; if nothing found, look at the row ABOVE
                // (Echelon sheets have a two-row header: staff name row + IN/OUT/NoLn row).
                let mut name = String::new();
                let mut j = i;
                while j > 0 {
                    j -= 1;
                    let c = header.get(j).cloned().unwrap_or_default();
                    if !c.is_empty() && !is_in_label(&c) && !is_out_label(&c) && !is_noln_label(&c) {
                        name = c; break;
                    }
                }
                if name.is_empty() && header_idx > 0 {
                    let above = &block[header_idx - 1];
                    // Try same column first, then walk back.
                    let mut k = i + 1;
                    while k > 0 {
                        k -= 1;
                        let c = above.get(k).cloned().unwrap_or_default();
                        if !c.is_empty() && !is_in_label(&c) && !is_out_label(&c) && !is_noln_label(&c) {
                            name = c; break;
                        }
                    }
                }
                // noln col: next col after out
                let noln = (out_col + 1..ncols).find(|&k| is_noln_label(header.get(k).unwrap_or(&String::new())));
                if !name.is_empty() && !is_placeholder_name(&name) {
                    staff_cols.push(StaffCols { name, in_col: i, out_col, noln_col: noln, split_time: false });
                }
                i = noln.map(|k| k + 1).unwrap_or(out_col + 1);
                continue;
            }
        }
        i += 1;
    }

    // Fallback approach B: no IN/OUT labels — treat header cells starting from
    // col 1 as staff names, expecting a (IN, OUT) column pair each.
    if staff_cols.is_empty() {
        let mut col = 1;
        while col + 1 < ncols {
            let name = header.get(col).cloned().unwrap_or_default();
            if !name.is_empty() && !is_placeholder_name(&name) && !name.chars().all(|c| c.is_ascii_digit()) {
                staff_cols.push(StaffCols {
                    name, in_col: col, out_col: col + 1, noln_col: None, split_time: false,
                });
                col += 2;
            } else {
                col += 1;
            }
        }
    }

    if staff_cols.is_empty() { return; }

    // Split-time detection: Mistral OCR sometimes renders "8:30" as "| 8 | 30 |"
    // (two cells with the colon eaten by the pipe separator). For each staff
    // block, sample the first few data rows: if row[in_col] and row[in_col+1]
    // both look like a valid (hour, minute) pair in multiple rows, mark split.
    let sample_rows: Vec<&Vec<String>> = block.iter().skip(header_idx + 1)
        .filter(|r| r.first().and_then(|s| parse_leading_day(s)).is_some())
        .take(6)
        .collect();
    for sc in staff_cols.iter_mut() {
        let mut split_hits = 0;
        let mut merged_hits = 0;
        for r in &sample_rows {
            let a = r.get(sc.in_col).map(|s| s.trim().to_string()).unwrap_or_default();
            let b = r.get(sc.in_col + 1).map(|s| s.trim().to_string()).unwrap_or_default();
            if a.is_empty() && b.is_empty() { continue; }
            // Fully-formed time in one cell → merged (single-cell) layout.
            if a.contains(':') || a.contains('.') { merged_hits += 1; continue; }
            let ai = a.parse::<u32>().ok();
            let bi = b.parse::<u32>().ok();
            if let (Some(h), Some(m)) = (ai, bi) {
                if h <= 23 && m <= 59 && b.len() <= 2 && !b.is_empty() { split_hits += 1; }
            }
        }
        if split_hits >= 2 && split_hits > merged_hits {
            sc.split_time = true;
        }
    }

    // Data rows: iterate rows after header, skip separators (lines of dashes).
    for row in block.iter().skip(header_idx + 1) {
        if row.iter().all(|c| c.chars().all(|ch| ch == '-' || ch == ':' || ch.is_whitespace())) { continue; }
        let day_cell = row.first().cloned().unwrap_or_default();
        let day = match parse_leading_day(&day_cell) { Some(d) => d, None => continue };
        let work_date = format!("{}-{:02}", month_key, day);
        for sc in &staff_cols {
            let (in_time, out_time) = if sc.split_time {
                let a = row.get(sc.in_col).cloned().unwrap_or_default();
                let b = row.get(sc.in_col + 1).cloned().unwrap_or_default();
                let c = row.get(sc.in_col + 2).cloned().unwrap_or_default();
                let d = row.get(sc.in_col + 3).cloned().unwrap_or_default();
                // Weekend rows have "SAT"/"SUN" written across the time cells.
                if is_weekend_marker(&a) || is_weekend_marker(&b)
                    || is_weekend_marker(&c) || is_weekend_marker(&d) { continue; }
                (combine_split_time(&a, &b), combine_split_time(&c, &d))
            } else {
                let in_val = row.get(sc.in_col).cloned().unwrap_or_default();
                let out_val = row.get(sc.out_col).cloned().unwrap_or_default();
                if is_weekend_marker(&in_val) || is_weekend_marker(&out_val) { continue; }
                (normalize_time(&in_val), normalize_time(&out_val))
            };
            if in_time.is_none() && out_time.is_none() { continue; }
            let no_lunch = sc.noln_col
                .and_then(|c| row.get(c))
                .map(|s| is_checkmark(s))
                .unwrap_or(false);
            out.push(ExtractedRow {
                staff_name: sc.name.clone(),
                work_date: work_date.clone(),
                in_time, out_time, no_lunch,
            });
        }
    }
}

fn is_weekend_marker(s: &str) -> bool {
    let t = s.trim().to_uppercase();
    t == "SAT" || t == "SUN" || t == "SATURDAY" || t == "SUNDAY" || t == "OFF" || t == "CLOSED"
}

// Extract the first run of digits from a cell like "01 Mon" or " 15" → 1, 15.
// Used because Mistral emits day+weekday joined ("01 Mon"), not just "01".
fn parse_leading_day(s: &str) -> Option<u32> {
    let t = s.trim();
    let mut acc = String::new();
    for ch in t.chars() {
        if ch.is_ascii_digit() { acc.push(ch); }
        else if !acc.is_empty() { break; }
        else if ch.is_whitespace() { continue; }
        else { break; }
    }
    if acc.is_empty() { return None; }
    let n: u32 = acc.parse().ok()?;
    if (1..=31).contains(&n) { Some(n) } else { None }
}

fn looks_like_label(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() { return false; }
    // A label has at least one alphabetic char and isn't a bare number.
    t.chars().any(|c| c.is_alphabetic()) && t.parse::<f64>().is_err()
}
fn is_in_label(s: &str) -> bool {
    let t = s.trim().to_lowercase();
    t == "in" || t == "time in" || t == "start" || t == "arr" || t == "arrival"
}
fn is_out_label(s: &str) -> bool {
    let t = s.trim().to_lowercase();
    t == "out" || t == "time out" || t == "end" || t == "dep" || t == "departure"
}
fn is_noln_label(s: &str) -> bool {
    let t = s.trim().to_lowercase().replace(' ', "").replace('.', "");
    t == "noln" || t == "nolunch" || t.starts_with("noln")
}
fn is_checkmark(s: &str) -> bool {
    let t = s.trim();
    matches!(t, "x" | "X" | "✓" | "✔" | "yes" | "Yes" | "YES" | "y" | "Y" | "☑" | "☒" | "[x]" | "[X]")
}
// For Mistral's split-time layout: two adjacent cells forming "HH:MM".
// e.g. combine_split_time("8", "30") → Some("08:30"). Requires both cells
// to be present integers, hour 0-23, minute 0-59.
fn combine_split_time(a: &str, b: &str) -> Option<String> {
    let ta = a.trim();
    let tb = b.trim();
    // If the first cell already has a full time, delegate.
    if ta.contains(':') || ta.contains('.') { return normalize_time(ta); }
    if ta.is_empty() && tb.is_empty() { return None; }
    let h: u32 = ta.parse().ok()?;
    let m: u32 = tb.parse().ok()?;
    if h > 23 || m > 59 || tb.len() > 2 { return None; }
    Some(format!("{:02}:{:02}", h, m))
}

fn normalize_time(s: &str) -> Option<String> {
    let t = s.trim().replace(' ', "").to_lowercase();
    if t.is_empty() || t == "-" || t == "—" { return None; }
    // Strip AM/PM suffix (Mistral may or may not preserve).
    let (base, pm) = if let Some(stripped) = t.strip_suffix("pm") {
        (stripped.to_string(), Some(true))
    } else if let Some(stripped) = t.strip_suffix("am") {
        (stripped.to_string(), Some(false))
    } else {
        (t.clone(), None)
    };
    let (h, m) = if let Some((hh, mm)) = base.split_once(':') {
        (hh.parse::<u32>().ok()?, mm.parse::<u32>().ok()?)
    } else if let Some((hh, mm)) = base.split_once('.') {
        (hh.parse::<u32>().ok()?, mm.parse::<u32>().ok()?)
    } else if let Ok(n) = base.parse::<u32>() {
        if n <= 24 { (n, 0) } else { return None; }
    } else {
        return None;
    };
    let hh = match pm {
        Some(true)  if h < 12 => h + 12,
        Some(false) if h == 12 => 0,
        _ => h,
    };
    if hh > 23 || m > 59 { return None; }
    Some(format!("{:02}:{:02}", hh, m))
}

// ─── Tauri command ───────────────────────────────────────────────────────
#[tauri::command]
pub async fn extract_timesheet_consensus(args: ConsensusArgs) -> Result<ConsensusResult, String> {
    base64::engine::general_purpose::STANDARD
        .decode(args.image_b64.as_bytes())
        .map_err(|e| format!("image base64: {e}"))?;

    let secrets_owned: Vec<String> = [
        args.azure_ai_key.clone().unwrap_or_default(),
    ].into_iter().filter(|s| !s.is_empty()).collect();

    let redact_now = |s: String| {
        let refs: Vec<&str> = secrets_owned.iter().map(|s| s.as_str()).collect();
        redact(s, &refs)
    };

    // Normalize the uploaded image once (EXIF-rotate, downscale, JPEG q92)
    // so both providers receive identical bytes regardless of Mac/Win source.
    let (img, mime) = normalize_image(&args.image_b64, &args.mime_type);
    let month = args.month_year;
    let known = args.known_staff_names;

    // Fire both providers in parallel. Each has its own timeout; we also
    // wrap with tokio::time::timeout as a hard ceiling.
    let gpt_fut = async {
        let started = Instant::now();
        let key = args.azure_ai_key.clone();
        let res = match key {
            Some(k) if !k.is_empty() => {
                tokio::time::timeout(
                    Duration::from_secs(PROVIDER_TIMEOUT_SECS + 5),
                    call_azure_openai(&k, &img, &mime, &month, &known),
                ).await.unwrap_or_else(|_| Err("provider timeout".to_string()))
            }
            _ => Err("no Azure AI Foundry key configured".to_string()),
        };
        (started.elapsed().as_millis() as u64, res)
    };
    let mistral_fut = async {
        let started = Instant::now();
        let key = args.azure_ai_key.clone();
        let res = match key {
            Some(k) if !k.is_empty() => {
                tokio::time::timeout(
                    Duration::from_secs(PROVIDER_TIMEOUT_SECS + 5),
                    call_mistral_ocr(&k, &img, &mime, &month, &known),
                ).await.unwrap_or_else(|_| Err("provider timeout".to_string()))
            }
            _ => Err("no Azure AI Foundry key configured".to_string()),
        };
        (started.elapsed().as_millis() as u64, res)
    };

    let ((gpt_ms, gpt_res), (mis_ms, mis_res)) =
        tokio::join!(gpt_fut, mistral_fut);

    let mut providers = Vec::with_capacity(2);
    for (name, ms, res) in [
        ("gpt5", gpt_ms, gpt_res),
        ("mistral_ocr", mis_ms, mis_res),
    ] {
        match res {
            Ok((rows, detected, raw)) => providers.push(ProviderOutput {
                provider: name.to_string(), ok: true,
                rows, detected_month_year: detected,
                raw_text: redact_now(raw),
                error: None, latency_ms: ms,
            }),
            Err(e) => providers.push(ProviderOutput {
                provider: name.to_string(), ok: false,
                rows: vec![], detected_month_year: None,
                raw_text: String::new(),
                error: Some(redact_now(e)),
                latency_ms: ms,
            }),
        }
    }

    Ok(ConsensusResult { providers })
}
