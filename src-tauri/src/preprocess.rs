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

    let img = image::open(&path).map_err(|e| format!("open image: {e}"))?;
    let (w, h) = img.dimensions();

    // Try full image first (fast for well-aligned photos).
    if let Some(qr) = try_decode_qr(&img.to_luma8()) {
        return Ok(NormalizeResult {
            qr: parse_payload(&qr),
            note: "QR decoded from full image".into(),
        });
    }

    // Fall back to the bottom-right quadrant where our sheets place the QR.
    // Also try rotations in case the photo was taken sideways.
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
    // Match "ED-2026-06" anywhere in the string.
    let bytes = s.as_bytes();
    for i in 0..bytes.len().saturating_sub(10) {
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
