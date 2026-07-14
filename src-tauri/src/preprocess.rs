// Image preprocessing for Echelon sign-in sheets.
// Currently: decode the QR code (bottom-right corner) to auto-lock
// month/year from the sheet itself, so the UI period picker can't cause
// wrong-month imports. Full 4-corner deskew is a future v0.3.0 upgrade.

use image::GenericImageView;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct NormalizeArgs {
    pub image_path: String,
}

#[derive(Serialize, Default)]
pub struct SheetQr {
    /// Full raw payload string (may be JSON) if any QR was decoded.
    pub raw: Option<String>,
    pub sheet_id: Option<String>, // e.g. "ED-2026-06"
    pub year: Option<i32>,
    pub month: Option<u32>,
    pub layout_version: Option<String>,
    /// Staff IDs in printed column order (0-based). Present when a staff
    /// sign-in sheet was printed by the app with QR v2 payload. Lets the
    /// OCR bypass column-header resolution entirely.
    pub staff_ids: Option<Vec<i64>>,
    /// Student IDs in printed row order (0-based). Present when a monthly
    /// student attendance sheet was printed by the app with QR v2 payload.
    /// Used by the frontend to lock the target month and (optionally)
    /// verify the current roster matches what was printed.
    pub student_ids: Option<Vec<i64>>,
}

#[derive(Serialize)]
pub struct NormalizeResult {
    pub qr: SheetQr,
    /// Best-effort diagnostic message (localised at surface layer if needed).
    pub note: String,
}

#[tauri::command]
pub async fn normalize_sheet(args: NormalizeArgs) -> Result<NormalizeResult, String> {
    // Read image (jpeg/png/webp/heic-if-decodable) from disk. HEIC isn't
    // decoded by the `image` crate today; we skip QR for those and rely on
    // Gemini's own recognition, which still works.
    let path = std::path::PathBuf::from(&args.image_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "heic" || ext == "heif" || ext == "pdf" {
        return Ok(NormalizeResult {
            qr: SheetQr::default(),
            note: format!("QR decode skipped for .{ext} (unsupported here)"),
        });
    }
    // Whole rest of the pipeline (open image, luma8 conversions, rotations,
    // QR scan) is CPU-bound and takes tens-to-hundreds of ms per photo.
    // Push to blocking pool so other IPC calls keep flowing.
    tokio::task::spawn_blocking(move || normalize_sheet_blocking(&path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn normalize_sheet_blocking(path: &std::path::Path) -> Result<NormalizeResult, String> {
    let img = image::open(path).map_err(|e| format!("open image: {e}"))?;
    let (w, h) = img.dimensions();

    // Try full image first (fast for well-aligned photos).
    if let Some(qr) = try_decode_qr(&img.to_luma8()) {
        return Ok(NormalizeResult {
            qr: parse_payload(&qr),
            note: "QR decoded from full image".into(),
        });
    }

    // Fall back to quadrant crops. New sheets (Jul 2026+) place the QR
    // top-right; older sheets used bottom-right. Try both before giving up.
    let tr = img.crop_imm(w.saturating_sub(w / 2), 0, w / 2, h / 2);
    if let Some(qr) = try_decode_qr(&tr.to_luma8()) {
        return Ok(NormalizeResult {
            qr: parse_payload(&qr),
            note: "QR decoded from top-right crop".into(),
        });
    }
    let br_x = w.saturating_sub(w / 2);
    let br_y = h.saturating_sub(h / 2);
    let br = img.crop_imm(br_x, br_y, w / 2, h / 2);
    if let Some(qr) = try_decode_qr(&br.to_luma8()) {
        return Ok(NormalizeResult {
            qr: parse_payload(&qr),
            note: "QR decoded from bottom-right crop".into(),
        });
    }

    // Rotations: 90 / 180 / 270 degrees (phone landscape vs portrait).
    for (label, rot) in [
        ("90", image::imageops::rotate90(&img)),
        ("180", image::imageops::rotate180(&img)),
        ("270", image::imageops::rotate270(&img)),
    ] {
        let dyn_rot = image::DynamicImage::ImageRgba8(rot);
        if let Some(qr) = try_decode_qr(&dyn_rot.to_luma8()) {
            return Ok(NormalizeResult {
                qr: parse_payload(&qr),
                note: format!("QR decoded after rotating {label}°"),
            });
        }
    }

    Ok(NormalizeResult {
        qr: SheetQr::default(),
        note: "No QR detected — falling back to UI-selected month".into(),
    })
}

fn try_decode_qr(img: &image::GrayImage) -> Option<String> {
    let mut prep = rqrr::PreparedImage::prepare(img.clone());
    for grid in prep.detect_grids() {
        if let Ok((_meta, content)) = grid.decode() {
            return Some(content);
        }
    }
    None
}

fn parse_payload(raw: &str) -> SheetQr {
    // Payload format from June-14 generator:
    // {"centre":"Echelon","year":2026,"month":6,"sheet_id":"ED-2026-06",
    //  "page":1,"of_pages":1,"cols":5,"v":1}
    let mut qr = SheetQr {
        raw: Some(raw.to_string()),
        ..Default::default()
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        qr.sheet_id = v["sheet_id"].as_str().map(String::from);
        qr.year = v["year"].as_i64().map(|n| n as i32);
        qr.month = v["month"].as_u64().map(|n| n as u32);
        qr.layout_version = v["layout_version"].as_str().map(String::from);
        // v2 payload (staff sheet): staff_ids in printed column order.
        if let Some(arr) = v["staff_ids"].as_array() {
            let ids: Vec<i64> = arr.iter().filter_map(|x| x.as_i64()).collect();
            if !ids.is_empty() {
                qr.staff_ids = Some(ids);
            }
        }
        // v2 payload (student sheet): student_ids in printed row order.
        if let Some(arr) = v["student_ids"].as_array() {
            let ids: Vec<i64> = arr.iter().filter_map(|x| x.as_i64()).collect();
            if !ids.is_empty() {
                qr.student_ids = Some(ids);
            }
        }
    } else {
        // Fallback: parse ED-YYYY-MM from any string (defensive if payload
        // format ever changes to a plain URL / ID).
        if let Some(caps) = extract_ed_yyyy_mm(raw) {
            qr.sheet_id = Some(format!("ED-{}-{:02}", caps.0, caps.1));
            qr.year = Some(caps.0);
            qr.month = Some(caps.1);
        }
    }
    qr
}

fn extract_ed_yyyy_mm(s: &str) -> Option<(i32, u32)> {
    // Match "ED-2026-06" anywhere in the string. Needs 10 bytes starting
    // at position i (indices i..i+10), so the last valid start is
    // len-10 inclusive — hence the `..=` in the loop bound. Using
    // `..len.saturating_sub(10)` (exclusive) skipped the i=0 case for
    // strings that were EXACTLY 10 chars long.
    let bytes = s.as_bytes();
    if bytes.len() < 10 { return None; }
    for i in 0..=bytes.len() - 10 {
        if &bytes[i..i + 3] == b"ED-" {
            let yr: i32 = std::str::from_utf8(&bytes[i + 3..i + 7]).ok()?.parse().ok()?;
            if bytes[i + 7] != b'-' {
                continue;
            }
            let mo: u32 = std::str::from_utf8(&bytes[i + 8..i + 10]).ok()?.parse().ok()?;
            if (1..=12).contains(&mo) && (2020..=2100).contains(&yr) {
                return Some((yr, mo));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_payload_v1_json() {
        // The original June-14 generator format.
        let raw = r#"{"centre":"Echelon","year":2026,"month":6,"sheet_id":"ED-2026-06","page":1,"of_pages":1,"cols":5,"v":1}"#;
        let qr = parse_payload(raw);
        assert_eq!(qr.year, Some(2026));
        assert_eq!(qr.month, Some(6));
        assert_eq!(qr.sheet_id.as_deref(), Some("ED-2026-06"));
        assert!(qr.staff_ids.is_none(), "v1 payload must not populate staff_ids");
        assert!(qr.student_ids.is_none(), "v1 payload must not populate student_ids");
    }

    #[test]
    fn parse_payload_v2_staff_sheet() {
        let raw = r#"{"centre":"Echelon","year":2026,"month":7,"sheet_id":"ED-2026-07","staff_ids":[11,7,23,4],"cols":4,"v":2}"#;
        let qr = parse_payload(raw);
        assert_eq!(qr.year, Some(2026));
        assert_eq!(qr.month, Some(7));
        assert_eq!(qr.staff_ids.as_deref(), Some(&[11i64, 7, 23, 4][..]));
        assert!(qr.student_ids.is_none(), "student_ids must remain None on a staff-sheet QR");
    }

    #[test]
    fn parse_payload_v2_student_sheet() {
        let raw = r#"{"centre":"Echelon","year":2026,"month":7,"sheet_id":"ED-STU-2026-07","kind":"attendance","student_ids":[101,102,103,104,105],"rows":5,"v":2}"#;
        let qr = parse_payload(raw);
        assert_eq!(qr.year, Some(2026));
        assert_eq!(qr.month, Some(7));
        assert_eq!(qr.sheet_id.as_deref(), Some("ED-STU-2026-07"));
        assert_eq!(qr.student_ids.as_deref(), Some(&[101i64, 102, 103, 104, 105][..]));
        assert!(qr.staff_ids.is_none(), "staff_ids must remain None on a student-sheet QR");
    }

    #[test]
    fn parse_payload_v2_empty_ids_arrays_are_ignored() {
        // Regression guard: an empty array must NOT set staff_ids/student_ids
        // to Some(vec![]) — downstream code branches on is_some().
        let raw = r#"{"year":2026,"month":7,"sheet_id":"ED-2026-07","staff_ids":[],"student_ids":[],"v":2}"#;
        let qr = parse_payload(raw);
        assert!(qr.staff_ids.is_none());
        assert!(qr.student_ids.is_none());
    }

    #[test]
    fn parse_payload_v2_skips_non_integer_ids() {
        // Defensive: if a corrupted payload has string ids mixed in, keep
        // the integer ones rather than dropping the whole array.
        let raw = r#"{"year":2026,"month":7,"staff_ids":[1,"bad",3,null,5]}"#;
        let qr = parse_payload(raw);
        assert_eq!(qr.staff_ids.as_deref(), Some(&[1i64, 3, 5][..]));
    }

    #[test]
    fn parse_payload_non_json_falls_back_to_ed_regex() {
        // If the QR ever holds a plain URL or ID string, we still recover
        // year/month from an "ED-YYYY-MM" substring.
        let raw = "https://echelon.example/sheet/ED-2025-11?p=1";
        let qr = parse_payload(raw);
        assert_eq!(qr.year, Some(2025));
        assert_eq!(qr.month, Some(11));
        assert_eq!(qr.sheet_id.as_deref(), Some("ED-2025-11"));
    }

    #[test]
    fn parse_payload_gibberish_returns_defaults() {
        let qr = parse_payload("not-a-payload");
        assert_eq!(qr.raw.as_deref(), Some("not-a-payload"));
        assert!(qr.year.is_none());
        assert!(qr.month.is_none());
        assert!(qr.sheet_id.is_none());
    }

    #[test]
    fn extract_ed_yyyy_mm_rejects_out_of_range() {
        // Year 1999 and month 13 must both fail — guards against garbage
        // substrings that happen to match the "ED-DDDD-DD" shape.
        assert!(extract_ed_yyyy_mm("ED-1999-06").is_none());
        assert!(extract_ed_yyyy_mm("ED-2026-13").is_none());
        assert!(extract_ed_yyyy_mm("ED-2026-00").is_none());
        assert_eq!(extract_ed_yyyy_mm("ED-2026-01"), Some((2026, 1)));
        assert_eq!(extract_ed_yyyy_mm("ED-2026-12"), Some((2026, 12)));
    }
}
