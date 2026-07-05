// Multi-model OCR consensus for staff sign-in sheets.
//
// Runs two providers in parallel:
//   1. Mistral Document AI (image → structured JSON via Azure AI Foundry)
//   2. Mistral OCR         (image → markdown → parsed per-cell digits)
//
// Gemini was removed entirely in v0.4.x — child attendance and Visa import
// were migrated to Azure Mistral Document AI (see azure_ai.rs).

use base64::Engine;
use image::ImageDecoder;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::Cursor;
use std::time::{Duration, Instant};

// Row shape shared with the frontend. Historically lived in gemini.rs.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ExtractedRow {
    pub staff_name: String,
    pub work_date: String,
    pub in_time: Option<String>,
    pub out_time: Option<String>,
    #[serde(default)]
    pub no_lunch: bool,
}

const PROVIDER_TIMEOUT_SECS: u64 = 60;
const PROVIDER_MAX_ATTEMPTS: u32 = 3;
const PROVIDER_RETRY_BACKOFF_MS: u64 = 400;
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
    // If false, skip the Mistral OCR (digits witness) call entirely.
    // Defaults to true when omitted so older clients keep working.
    #[serde(default)]
    pub enable_mistral_ocr: Option<bool>,
    // If false, skip the Azure Document Intelligence call. Defaults to true.
    #[serde(default)]
    pub enable_azure_di: Option<bool>,
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

// ─── Provider 3: Azure Document Intelligence (prebuilt-layout) ───────────
// Third independent semantic voter. Submits the image to Azure DI's
// prebuilt-layout model which returns a structured `analyzeResult` with
// tables including per-cell (rowIndex, columnIndex, columnSpan) metadata.
// We parse the sheet template — 1 Day column + (IN, OUT, No Ln) × 5 staff
// — using the header row's columnSpans to allocate cell ranges per staff.
// This is asynchronous: POST to submit, poll Operation-Location until
// status is "succeeded" or "failed", then parse.
async fn call_azure_di(
    api_key: &str, image_b64: &str, _mime_type: &str,
    month_year_hint: &str, _known_staff: &[String],
) -> Result<(Vec<ExtractedRow>, Option<String>, String), String> {
    const DI_ENDPOINT: &str = "https://ai-nse.cognitiveservices.azure.com";
    const DI_API_VERSION: &str = "2024-11-30";
    let submit_url = format!(
        "{DI_ENDPOINT}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version={DI_API_VERSION}"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PROVIDER_TIMEOUT_SECS))
        .build().map_err(|e| format!("http client: {e}"))?;
    // Step 1: submit
    let submit_body = json!({ "base64Source": image_b64 });
    let submit_resp = client.post(&submit_url)
        .header("Ocp-Apim-Subscription-Key", api_key)
        .header("Content-Type", "application/json")
        .json(&submit_body)
        .send().await
        .map_err(|e| format!("request: {e}"))?;
    let sub_status = submit_resp.status();
    let op_loc = submit_resp
        .headers()
        .get("operation-location")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    if !sub_status.is_success() {
        let text = submit_resp.text().await.unwrap_or_default();
        return Err(format!("http {sub_status} @ azure-di submit :: {}", truncate(&text, 400)));
    }
    let op_loc = op_loc.ok_or_else(|| "azure-di: no Operation-Location header".to_string())?;
    // Step 2: poll (max ~45s with 1.5s intervals = 30 polls)
    let mut analyze_json: Option<serde_json::Value> = None;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let poll_resp = client.get(&op_loc)
            .header("Ocp-Apim-Subscription-Key", api_key)
            .send().await
            .map_err(|e| format!("poll: {e}"))?;
        if !poll_resp.status().is_success() {
            let t = poll_resp.text().await.unwrap_or_default();
            return Err(format!("azure-di poll failed: {}", truncate(&t, 300)));
        }
        let v: serde_json::Value = poll_resp.json().await
            .map_err(|e| format!("poll json: {e}"))?;
        let status = v["status"].as_str().unwrap_or("");
        if status == "succeeded" { analyze_json = Some(v); break; }
        if status == "failed" {
            return Err(format!("azure-di analyze failed: {}",
                truncate(&v.to_string(), 400)));
        }
    }
    let result = analyze_json.ok_or_else(|| "azure-di: polling timed out".to_string())?;
    let raw = truncate(&result.to_string(), 8000);
    // Detect month from DI's `content` (top-of-sheet "JUNE 2026" banner).
    let detected = detect_month_from_di(&result);
    let month_for_parse: String = detected
        .clone()
        .unwrap_or_else(|| month_year_hint.to_string());
    let (mut rows, uncertain) = parse_azure_di_table(&result, &month_for_parse);
    // Refinement pass: for each slot DI left uncertain (fewer than 2 times
    // and not a weekend/OFF), crop the slot from the rotated source image
    // and ask a vision LLM to read the digits literally. Falls back gracefully
    // if the image can't be rotated or the API call fails.
    if !uncertain.is_empty() {
        if let Some(rotated) = prepare_rotated_image(image_b64, &result) {
            #[cfg(debug_assertions)]
            eprintln!("── [OCR:azure_di] refining {} uncertain slots", uncertain.len());
            let refined = refine_uncertain_slots(&rotated, &uncertain, api_key).await;
            for (row_idx, in_t, out_t) in refined {
                if let Some(r) = rows.get_mut(row_idx) {
                    // Only fill missing positions AND reject duplicates of the
                    // opposite time (guards against VLM re-reading the same
                    // single cell and returning it for the missing slot).
                    if r.in_time.is_none() {
                        if let Some(v) = in_t.as_ref() {
                            if r.out_time.as_deref() != Some(v.as_str()) {
                                r.in_time = Some(v.clone());
                            }
                        }
                    }
                    if r.out_time.is_none() {
                        if let Some(v) = out_t.as_ref() {
                            if r.in_time.as_deref() != Some(v.as_str()) {
                                r.out_time = Some(v.clone());
                            }
                        }
                    }
                }
            }
            // Drop rows that are still empty after refinement.
            rows.retain(|r| r.in_time.is_some() || r.out_time.is_some());
        }
    }
    Ok((rows, detected, raw))
}

// Decode the incoming base64 image and, if DI reports it as landscape while
// the raw pixels are portrait, rotate 90° clockwise so DI polygon coordinates
// align. Returns None if decoding fails — caller then skips refinement.
fn prepare_rotated_image(image_b64: &str, di_result: &serde_json::Value) -> Option<image::DynamicImage> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(image_b64.as_bytes()).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    let page = di_result["analyzeResult"]["pages"].as_array()?.first()?;
    let pw = page["width"].as_f64().unwrap_or(0.0);
    let ph = page["height"].as_f64().unwrap_or(0.0);
    if pw > ph && img.height() > img.width() {
        Some(img.rotate90())
    } else if pw < ph && img.width() > img.height() {
        // Reverse orientation mismatch, unlikely but handle symmetrically.
        Some(img.rotate270())
    } else {
        Some(img)
    }
}

// One slot the DI parser couldn't fully resolve. `row_idx` is the index into
// the returned rows Vec so refinement results can be merged back in place.
struct UncertainSlot {
    row_idx: usize,
    // Union bounding box (DI pixel coords) of all cells in this slot.
    x0: u32, y0: u32, x1: u32, y1: u32,
    // Which values are missing — refinement may fill either or both.
    need_in: bool,
    need_out: bool,
}

// Fan out uncertain slots to the vision LLM ensemble. Returns
// (row_idx, refined_in, refined_out) tuples. Skips silently on any failure.
async fn refine_uncertain_slots(
    img: &image::DynamicImage, slots: &[UncertainSlot], api_key: &str,
) -> Vec<(usize, Option<String>, Option<String>)> {
    use tokio::task::JoinSet;
    let mut set = JoinSet::new();
    // Rc/Arc not needed because we clone tiny crop bytes into each task.
    let img_arc = std::sync::Arc::new(img.clone());
    for slot in slots {
        let img = img_arc.clone();
        let key = api_key.to_string();
        let s = (slot.row_idx, slot.x0, slot.y0, slot.x1, slot.y1, slot.need_in, slot.need_out);
        set.spawn(async move {
            let (row_idx, x0, y0, x1, y1, ni, no) = s;
            let pad = 15u32;
            let cx0 = x0.saturating_sub(pad);
            let cy0 = y0.saturating_sub(pad);
            let cx1 = (x1 + pad).min(img.width());
            let cy1 = (y1 + pad).min(img.height());
            if cx1 <= cx0 || cy1 <= cy0 { return (row_idx, None, None); }
            let crop = img.crop_imm(cx0, cy0, cx1 - cx0, cy1 - cy0);
            let mut buf: Vec<u8> = Vec::with_capacity(4096);
            if crop.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).is_err() {
                return (row_idx, None, None);
            }
            let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
            let (in_t, out_t) = ask_vlm_for_slot(&key, &b64, ni, no).await;
            (row_idx, in_t, out_t)
        });
    }
    let mut out = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(x) = res { out.push(x); }
    }
    out
}

// Ask gpt-4.1 (chosen because in per-cell tests it hallucinated AM/PM less
// than gpt-5.4) to read a slot crop. Returns (in_time, out_time) both
// promoted through daycare PM inference.
async fn ask_vlm_for_slot(
    api_key: &str, crop_b64: &str, need_in: bool, need_out: bool,
) -> (Option<String>, Option<String>) {
    if !need_in && !need_out { return (None, None); }
    const ENDPOINT: &str = "https://ai-nse.openai.azure.com";
    const DEPLOY:   &str = "gpt-4.1";
    const API_VER:  &str = "2025-04-01-preview";
    let url = format!(
        "{ENDPOINT}/openai/deployments/{DEPLOY}/chat/completions?api-version={API_VER}"
    );
    let prompt = format!(
        "This is one horizontal strip from a daycare monthly staff sign-in \
         sheet. It shows ONE staff member's IN and OUT times for ONE day, \
         handwritten in pen in 12-hour format (no AM/PM shown).\n\
         Return the times EXACTLY as written — do NOT convert to 24-hour, \
         do NOT add AM/PM. If a value is empty write 'blank'. If the cell \
         says off/sick/pto/sat/sun write 'off'.\n\
         Reply in this exact format on ONE line:\n\
         IN=<value> OUT=<value>\n\
         Example replies:\n\
         IN=8:30 OUT=3:45\n\
         IN=9:00 OUT=blank\n\
         IN=off OUT=off\n\
         (needs: IN={}, OUT={})",
         if need_in {"yes"} else {"no"},
         if need_out {"yes"} else {"no"});
    let body = json!({
        "messages": [
            {"role":"system","content":"You are a strict OCR service. Reply with one line in the exact format requested. No prose."},
            {"role":"user","content":[
                {"type":"text","text": prompt},
                {"type":"image_url","image_url":{"url": format!("data:image/png;base64,{crop_b64}")}}
            ]}
        ],
        "max_completion_tokens": 40
    });
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20)).build() {
        Ok(c) => c, Err(_) => return (None, None),
    };
    let resp = match client.post(&url)
        .header("api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body).send().await {
        Ok(r) => r, Err(_) => return (None, None),
    };
    if !resp.status().is_success() { return (None, None); }
    let v: serde_json::Value = match resp.json().await { Ok(v) => v, Err(_) => return (None, None) };
    let msg = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
    parse_vlm_slot_reply(msg, need_in, need_out)
}

// Parse a VLM reply like "IN=8:30 OUT=3:45" or "IN=off OUT=off" and promote
// daycare PM times. Returns (in_time, out_time) as canonical HH:MM 24-hour or
// None where the model couldn't read the value.
fn parse_vlm_slot_reply(msg: &str, need_in: bool, need_out: bool) -> (Option<String>, Option<String>) {
    let low = msg.trim().to_lowercase();
    // KNOWN LIMITATION (Concern #2): If gpt-4.1 replies literal "off" for
    // both fields on a truly-empty crop, we return (None, None) here and
    // the row is silently dropped by the `rows.retain()` at the end of
    // call_azure_di. In practice the row would have been empty anyway, and
    // the calendar synthesis step re-materialises a placeholder for that
    // date. Revisit if we start seeing legitimate OFF rows disappear.
    if low.contains("off") && !low.contains("in=") && !low.contains("out=") {
        return (None, None);
    }
    fn extract(field: &str, s: &str) -> Option<String> {
        let key = format!("{}=", field);
        let pos = s.find(&key)?;
        let after = &s[pos + key.len()..];
        // token is until whitespace, comma, or end
        let token: String = after.chars()
            .take_while(|c| !c.is_whitespace() && *c != ',')
            .collect();
        let t = token.trim().trim_matches('.').to_string();
        if t.is_empty() { None } else { Some(t) }
    }
    let in_raw  = if need_in  { extract("in",  &low) } else { None };
    let out_raw = if need_out { extract("out", &low) } else { None };
    let norm = |raw: Option<String>| -> Option<String> {
        let v = raw?;
        if v == "blank" || v == "off" || v == "-" { return None; }
        // scan_times returns HH:MM with daycare PM inference already applied.
        scan_times(&v).into_iter().next()
    };
    (norm(in_raw), norm(out_raw))
}

// Scan Azure DI's analyzeResult.content for a "<MonthName> <YYYY>" banner and
// return "YYYY-MM". Case-insensitive; tolerates punctuation between name/year.
fn detect_month_from_di(result: &serde_json::Value) -> Option<String> {
    let content = result["analyzeResult"]["content"].as_str().unwrap_or("");
    if content.is_empty() { return None; }
    let low = content.to_lowercase();
    let months: [(&str, u32); 12] = [
        ("january",1),("february",2),("march",3),("april",4),
        ("may",5),("june",6),("july",7),("august",8),
        ("september",9),("october",10),("november",11),("december",12),
    ];
    // Find the earliest month name occurrence and pair with a nearby 4-digit year.
    let mut best: Option<(usize, u32, i32)> = None; // (pos, month_num, year)
    for (name, num) in months.iter() {
        let mut search_from = 0usize;
        while let Some(rel) = low[search_from..].find(name) {
            let pos = search_from + rel;
            let tail_start = pos + name.len();
            let tail_end = (tail_start + 30).min(low.len());
            let tail = &low[tail_start..tail_end];
            let bytes = tail.as_bytes();
            let mut i = 0usize;
            while i < bytes.len() {
                if bytes[i].is_ascii_digit() {
                    let start = i;
                    while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
                    if i - start == 4 {
                        if let Ok(y) = tail[start..i].parse::<i32>() {
                            if (2000..=2100).contains(&y) {
                                if best.map_or(true, |(p,_,_)| pos < p) {
                                    best = Some((pos, *num, y));
                                }
                                break;
                            }
                        }
                    }
                } else {
                    i += 1;
                }
            }
            search_from = pos + name.len();
        }
    }
    best.map(|(_, m, y)| format!("{y:04}-{m:02}"))
}

// Parse Azure DI's analyzeResult.tables[0] into ExtractedRow list.
//
// Sheet template (16 columns as designed): Day + (IN, OUT, No Ln) × 5 staff.
// DI often reports 14-16 cols depending on merged-cell segmentation, so we
// use the header row's `columnSpan` to allocate a variable-width slot per
// staff. Any cell with columnSpan >= 2 in row 0 that isn't "Day" or "(name)"
// is treated as a staff slot spanning [columnIndex, columnIndex + columnSpan).
fn parse_azure_di_table(result: &serde_json::Value, month_year_hint: &str)
    -> (Vec<ExtractedRow>, Vec<UncertainSlot>)
{
    let tables = match result["analyzeResult"]["tables"].as_array() {
        Some(t) if !t.is_empty() => t,
        _ => return (vec![], vec![]),
    };
    let table = &tables[0];
    let cells = match table["cells"].as_array() {
        Some(c) => c, None => return (vec![], vec![]),
    };
    // Extract (yyyy, mm) from hint; if invalid, bail.
    let (yy, mm): (i32, u32) = {
        let parts: Vec<&str> = month_year_hint.split('-').collect();
        if parts.len() != 2 { return (vec![], vec![]); }
        match (parts[0].parse(), parts[1].parse()) {
            (Ok(y), Ok(m)) if (1..=12).contains(&m) => (y, m),
            _ => return (vec![], vec![]),
        }
    };
    // Row 0: build staff slot list
    let mut slots: Vec<(u64, u64, String)> = Vec::new(); // (col_start, col_end_exclusive, header)
    for c in cells {
        if c["rowIndex"].as_u64() != Some(0) { continue; }
        let col = match c["columnIndex"].as_u64() { Some(x) => x, None => continue };
        let span = c["columnSpan"].as_u64().unwrap_or(1);
        let content = c["content"].as_str().unwrap_or("").trim().to_string();
        if span < 2 { continue; } // skip Day (col 0) and "(name)" col
        let low = content.to_lowercase();
        if low.contains("day") || low == "(name)" || content.is_empty() { continue; }
        slots.push((col, col + span, content));
    }
    if slots.is_empty() { return (vec![], vec![]); }
    // Group cells by rowIndex for data rows
    let mut by_row: std::collections::BTreeMap<u64, Vec<&serde_json::Value>> = Default::default();
    for c in cells {
        let r = match c["rowIndex"].as_u64() { Some(x) => x, None => continue };
        if r < 2 { continue; } // skip header rows
        by_row.entry(r).or_default().push(c);
    }
    let mut out = Vec::new();
    let mut uncertain = Vec::new();
    for (r, row_cells) in by_row {
        // Find Day cell (columnIndex == 0)
        let day_content = row_cells.iter()
            .find(|c| c["columnIndex"].as_u64() == Some(0))
            .and_then(|c| c["content"].as_str())
            .unwrap_or("").trim().to_string();
        let day_num: Option<u32> = day_content.split_whitespace()
            .next()
            .and_then(|s| s.parse().ok())
            .filter(|d: &u32| *d >= 1 && *d <= 31);
        let day = match day_num { Some(d) => d, None => continue };
        // Verify the day is valid for the month
        let days_in_month = days_in(yy, mm);
        if day > days_in_month { continue; }
        let work_date = format!("{yy:04}-{mm:02}-{day:02}");
        // Also inspect the ENTIRE row for a weekend marker (any slot saying
        // SAT/SUN implies weekend for the whole day).
        let row_low: String = row_cells.iter()
            .map(|c| c["content"].as_str().unwrap_or("").to_lowercase())
            .collect::<Vec<_>>().join(" ");
        let row_is_weekend = row_low.contains(" sat") || row_low.contains("sat ")
            || row_low.contains(" sun") || row_low.contains("sun ")
            || row_low.trim() == "sat" || row_low.trim() == "sun";
        if row_is_weekend { continue; }
        // For each staff slot, gather cells in [col_start, col_end)
        for (col_start, col_end, header) in &slots {
            let slot_cells: Vec<&&serde_json::Value> = row_cells.iter()
                .filter(|c| {
                    let ci = c["columnIndex"].as_u64().unwrap_or(u64::MAX);
                    ci >= *col_start && ci < *col_end
                })
                .collect();
            // Combined content of the slot (for SAT/SUN/off detection)
            let combined: String = slot_cells.iter()
                .map(|c| c["content"].as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>()
                .join(" ");
            let low = combined.to_lowercase();
            if low.contains("sat") || low.contains("sun") ||
               low.contains(" off") || low.starts_with("off") ||
               low.contains("sick") || low.contains("pto") {
                continue;
            }
            // Extract time-shaped strings from each cell's content (in doc order)
            let mut times: Vec<String> = Vec::new();
            for c in &slot_cells {
                let txt = c["content"].as_str().unwrap_or("");
                for t in scan_times(txt) {
                    times.push(t);
                    if times.len() >= 2 { break; }
                }
                if times.len() >= 2 { break; }
            }
            let has_selected = combined
                .split(':')
                .any(|tok| tok.trim().eq_ignore_ascii_case("selected"));
            // If only 1 time was found and it's PM (hour >= 12), it's almost
            // certainly the OUT punch (no daycare opens at 12–6 PM). This
            // fixes cases like Kiranhe "9:\n1:30" where scan misses the
            // malformed IN and would otherwise mis-slot 13:30 as IN.
            let (in_time, out_time) = if times.len() == 1 {
                let only = &times[0];
                let hour = only.split(':').next().unwrap_or("0").parse::<u32>().unwrap_or(0);
                if hour >= 12 {
                    (None, Some(only.clone()))
                } else {
                    (Some(only.clone()), None)
                }
            } else {
                (times.get(0).cloned(), times.get(1).cloned())
            };
            let need_in = in_time.is_none();
            let need_out = out_time.is_none();
            // Slot content after stripping checkbox markers — used to decide
            // if there's anything worth OCR-refining.
            let stripped = combined
                .replace(":unselected:", "")
                .replace(":selected:", "")
                .trim().to_string();
            // Require substantive content (>= 3 non-space chars) to consider
            // this slot at all. Skips checkbox-only cells that DI sometimes
            // emits in unused staff columns.
            if stripped.trim().chars().filter(|c| !c.is_whitespace()).count() < 3 { continue; }
            // If both missing AND slot has no cells at all → truly nothing there.
            if slot_cells.is_empty() && need_in && need_out { continue; }
            // Refuse to emit a row from a slot where scan_times found NO times
            // at all — refinement on such crops has been observed to hallucinate.
            // The Mistral Doc AI voter still gets these; consensus handles them.
            if times.is_empty() { continue; }
            // Emit a row (even partial) so the refinement pass can fill it in.
            let row_idx = out.len();
            out.push(ExtractedRow {
                staff_name: header.clone(),
                work_date: work_date.clone(),
                in_time, out_time, no_lunch: has_selected,
            });
            // Queue for refinement when EITHER position is missing.
            // The dedup guard in the merge step (rejects VLM answer that
            // equals the opposite side's existing value) prevents the
            // duplicate-echo failure mode we saw in early testing.
            // Recovers ~30-50% of missing-IN cases where DI's OCR gave up
            // but a vision model can still resolve the digits.
            if need_in || need_out {
                // Compute union bbox of all slot cells' polygons.
                let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
                let mut have_bbox = false;
                for c in &slot_cells {
                    if let Some(regions) = c["boundingRegions"].as_array() {
                        for reg in regions {
                            if let Some(poly) = reg["polygon"].as_array() {
                                for (i, v) in poly.iter().enumerate() {
                                    let n = v.as_f64().unwrap_or(0.0).max(0.0) as u32;
                                    if i % 2 == 0 { x0 = x0.min(n); x1 = x1.max(n); }
                                    else          { y0 = y0.min(n); y1 = y1.max(n); }
                                }
                                have_bbox = true;
                            }
                        }
                    }
                }
                if have_bbox {
                    let _ = r; // keep DI row index for debug parity
                    uncertain.push(UncertainSlot {
                        row_idx, x0, y0, x1, y1, need_in, need_out,
                    });
                }
            }
        }
    }
    (out, uncertain)
}

// Scan a string for time-shaped substrings (HH:MM, HH.MM, HH MM, HHMM).
// Returns them in document order as "HH:MM" strings. Rejects impossible
// h/m combos (h>23, m>59). Handles typical DI cell contents like
// "3:45 :unselected:" and "$30 5:00 :unselected:".
//
// KNOWN LIMITATION (Concern #3): This regex does not verify context. If a
// slot cell contains adjacent numbers that happen to match HH MM (e.g.
// "$30 fee" → 03:30, or a scribbled memo "flu 3 15" → 03:15), they will
// be extracted as times. Mitigated in practice because we only scan
// inside DI-identified slot cells (not headers/footers/margins) and the
// sheet template has no numeric content in those cells. Revisit if
// staff start writing non-time numerics into shift cells.
fn scan_times(s: &str) -> Vec<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // Find start of a digit run
        if !bytes[i].is_ascii_digit() { i += 1; continue; }
        // Consume 1-2 digits for hour
        let h_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() && i - h_start < 2 { i += 1; }
        let h_str = &s[h_start..i];
        // Optional separator ':', '.', or single space
        let sep_start = i;
        if i < bytes.len() {
            let c = bytes[i];
            if c == b':' || c == b'.' { i += 1; }
            else if c == b' ' && i + 1 < bytes.len() && bytes[i+1].is_ascii_digit() { i += 1; }
        }
        // Consume exactly 2 digits for minute
        let m_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() && i - m_start < 2 { i += 1; }
        let m_str = &s[m_start..i];
        if m_str.len() == 2 {
            if let (Ok(h), Ok(m)) = (h_str.parse::<u32>(), m_str.parse::<u32>()) {
                if h <= 23 && m <= 59 {
                    // Daycare 12-hour → 24-hour inference: hours 1-6 are always PM
                    // (no daycare runs 1-6 AM). 7-12 stay as-is. 13-23 already 24h.
                    let h_final = if (1..=6).contains(&h) { h + 12 } else { h };
                    out.push(format!("{:02}:{:02}", h_final, m));
                }
            }
        } else {
            // Not a valid time — rewind past the separator to keep scanning
            i = sep_start.max(h_start + 1);
        }
    }
    out
}

fn days_in(y: i32, m: u32) -> u32 {
    match m {
        1|3|5|7|8|10|12 => 31,
        4|6|9|11 => 30,
        2 => if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 29 } else { 28 },
        _ => 30,
    }
}

// ─── Provider 2: Mistral OCR ─────────────────────────────────────────────
// Mistral OCR returns per-page markdown. We convert its tabular markdown
// into ExtractedRow[] by heuristically parsing the Echelon grid layout:
// day-number rows down the left, staff columns with alternating IN/OUT
// (and optional No-Ln) sub-columns.
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
    let raw = s.trim().to_lowercase();
    if raw.is_empty() || raw == "-" || raw == "—" { return None; }
    // Mistral OCR often renders "8:30" as "8 30" in a single markdown cell
    // (the colon is dropped, but the digits stay space-separated). Detect
    // that shape BEFORE we strip whitespace, so "8 30" doesn't collapse to "830".
    let space_split: Vec<&str> = raw.split_whitespace().collect();
    if space_split.len() == 2 {
        let a = space_split[0];
        let b = space_split[1];
        // Strip a possible am/pm suffix from the minutes token.
        let (b_core, pm) = if let Some(x) = b.strip_suffix("pm") { (x, Some(true)) }
            else if let Some(x) = b.strip_suffix("am") { (x, Some(false)) }
            else { (b, None) };
        if let (Ok(h), Ok(m)) = (a.parse::<u32>(), b_core.parse::<u32>()) {
            if h <= 23 && m <= 59 && !b_core.is_empty() && b_core.len() <= 2 {
                let hh = match pm {
                    Some(true) if h < 12 => h + 12,
                    Some(false) if h == 12 => 0,
                    _ => h,
                };
                if hh <= 23 { return Some(format!("{:02}:{:02}", hh, m)); }
            }
        }
    }
    let t = raw.replace(' ', "");
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
    let orig_size = args.image_b64.len();
    let (img, mime) = normalize_image(&args.image_b64, &args.mime_type);
    let month = args.month_year;
    let known = args.known_staff_names;

    #[cfg(debug_assertions)]
    eprintln!(
        "\n════════ [OCR] extract_timesheet_consensus ════════\n\
         image: orig_b64={} bytes, orig_mime={}, normalized_b64={} bytes, mime={}\n\
         month_hint={}  known_staff={:?}",
        orig_size, args.mime_type, img.len(), mime, month, known,
    );

    // Fire both providers in parallel. Each has its own timeout; we also
    // wrap with tokio::time::timeout as a hard ceiling.
    // Retry wrapper: run provider up to PROVIDER_MAX_ATTEMPTS times on error/timeout.
    // Retriable errors are network/timeout failures ("provider timeout", "request:", "sending request",
    // "connection", "reset", "eof"). HTTP 4xx from provider is NOT retriable.
    let is_retriable = |err: &str| -> bool {
        let e = err.to_ascii_lowercase();
        e.contains("timeout")
            || e.contains("sending request")
            || e.starts_with("request:")
            || e.contains("connection")
            || e.contains("connect")
            || e.contains("reset")
            || e.contains("eof")
            || e.contains("dns")
            || e.contains("stream")
            || e.contains("http/2")
            || e.contains("502")
            || e.contains("503")
            || e.contains("504")
            || e.contains("429")
    };

    macro_rules! call_with_retries {
        ($name:literal, $call:expr) => {{
            let started = Instant::now();
            let key = args.azure_ai_key.clone();
            let res = match key {
                Some(k) if !k.is_empty() => {
                    let mut last: Result<(Vec<ExtractedRow>, Option<String>, String), String> =
                        Err("no attempt".to_string());
                    for attempt in 1..=PROVIDER_MAX_ATTEMPTS {
                        let r = tokio::time::timeout(
                            Duration::from_secs(PROVIDER_TIMEOUT_SECS + 5),
                            $call(&k, &img, &mime, &month, &known),
                        )
                        .await
                        .unwrap_or_else(|_| Err("provider timeout".to_string()));
                        match r {
                            Ok(v) => {
                                last = Ok(v);
                                break;
                            }
                            Err(e) => {
                                #[cfg(debug_assertions)]
                                eprintln!(
                                    "── [OCR:{}] attempt {}/{} failed: {}",
                                    $name, attempt, PROVIDER_MAX_ATTEMPTS, e
                                );
                                last = Err(e.clone());
                                if attempt < PROVIDER_MAX_ATTEMPTS && is_retriable(&e) {
                                    tokio::time::sleep(Duration::from_millis(
                                        PROVIDER_RETRY_BACKOFF_MS * attempt as u64,
                                    ))
                                    .await;
                                    continue;
                                }
                                break;
                            }
                        }
                    }
                    last
                }
                _ => Err("no Azure AI Foundry key configured".to_string()),
            };
            (started.elapsed().as_millis() as u64, res)
        }};
    }

    let gpt_fut = async { call_with_retries!("gpt5", call_azure_openai) };
    let mistral_enabled = args.enable_mistral_ocr.unwrap_or(true);
    let mistral_fut = async {
        if mistral_enabled {
            call_with_retries!("mistral_ocr", call_mistral_ocr)
        } else {
            (0u64, Err("mistral_ocr disabled by user".to_string()))
        }
    };
    let di_enabled = args.enable_azure_di.unwrap_or(true);
    let di_fut = async {
        if di_enabled {
            call_with_retries!("azure_di", call_azure_di)
        } else {
            (0u64, Err("azure_di disabled by user".to_string()))
        }
    };

    let ((gpt_ms, gpt_res), (mis_ms, mis_res), (di_ms, di_res)) =
        tokio::join!(gpt_fut, mistral_fut, di_fut);

    let mut providers = Vec::with_capacity(3);
    let mut provider_slots: Vec<(&str, u64, Result<(Vec<ExtractedRow>, Option<String>, String), String>)> = vec![
        ("gpt5", gpt_ms, gpt_res),
    ];
    if mistral_enabled {
        provider_slots.push(("mistral_ocr", mis_ms, mis_res));
    }
    if di_enabled {
        provider_slots.push(("azure_di", di_ms, di_res));
    }
    for (name, ms, res) in provider_slots {
        match res {
            Ok((rows, detected, raw)) => {
                #[cfg(debug_assertions)]
                {
                    let redacted = redact_now(raw.clone());
                    eprintln!(
                        "── [OCR:{name}] ok={ok} latency={ms}ms rows={rc} detected_month={dm:?}\n{body}\n",
                        name = name, ok = true, ms = ms, rc = rows.len(),
                        dm = detected,
                        body = truncate(&redacted, 4000),
                    );
                    eprintln!(
                        "── [OCR:{name}] parsed_rows={:?}\n",
                        rows.iter().map(|r| format!(
                            "{}|{}|{}→{}|nl={}",
                            r.staff_name, r.work_date,
                            r.in_time.clone().unwrap_or_else(|| "-".into()),
                            r.out_time.clone().unwrap_or_else(|| "-".into()),
                            r.no_lunch
                        )).collect::<Vec<_>>()
                    );
                }
                providers.push(ProviderOutput {
                    provider: name.to_string(), ok: true,
                    rows, detected_month_year: detected,
                    raw_text: redact_now(raw),
                    error: None, latency_ms: ms,
                });
            }
            Err(e) => {
                #[cfg(debug_assertions)]
                eprintln!("── [OCR:{name}] FAILED latency={ms}ms error={}", redact_now(e.clone()));
                providers.push(ProviderOutput {
                    provider: name.to_string(), ok: false,
                    rows: vec![], detected_month_year: None,
                    raw_text: String::new(),
                    error: Some(redact_now(e)),
                    latency_ms: ms,
                });
            }
        }
    }

    #[cfg(debug_assertions)]
    eprintln!("════════ [OCR] done ════════\n");

    Ok(ConsensusResult { providers })
}
