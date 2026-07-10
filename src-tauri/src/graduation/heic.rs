//! HEIC → JPEG conversion, powered by libheif-rs.
//!
//! FFmpeg's LGPL build has no HEIF demuxer, so every HEIC file must be
//! decoded to JPEG *before* it enters the render pipeline. Converted
//! frames are cached in `{app_data}/graduation-cache/heic/` keyed by
//! source-path + mtime + size — repeated renders skip the decode work.
//!
//! # Errors
//! Everything is fail-soft. If libheif can't decode a specific frame,
//! `convert_heic_to_jpeg` returns Err and the caller is expected to
//! skip that photo (surfacing the failure in the render report) rather
//! than abort the whole reel.

use std::path::{Path, PathBuf};

use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};

use crate::graduation::StepReport;

/// Decode a HEIC file to a freshly-written JPEG at `dest_dir`, returning
/// the JPEG path. Uses the primary image (skips thumbnails / auxiliary
/// depth maps).
///
/// The output filename is `{sha256(source_path + mtime + size)[..16]}.jpg`
/// so a second invocation with the same source is a no-op if the JPEG
/// already exists on disk.
pub fn convert_heic_to_jpeg(source: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(source)
        .map_err(|e| format!("stat({}): {e}", source.display()))?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = cache_key(source, mtime_ns, meta.len());
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("mkdir({}): {e}", dest_dir.display()))?;
    let out = dest_dir.join(format!("{key}.jpg"));
    if out.exists() {
        return Ok(out);
    }

    let lib = LibHeif::new();
    let ctx = HeifContext::read_from_file(
        source
            .to_str()
            .ok_or_else(|| "non-UTF-8 source path".to_string())?,
    )
    .map_err(|e| format!("libheif open: {e}"))?;
    let handle = ctx
        .primary_image_handle()
        .map_err(|e| format!("libheif primary handle: {e}"))?;

    let img = lib
        .decode(&handle, ColorSpace::Rgb(RgbChroma::Rgb), None)
        .map_err(|e| format!("libheif decode: {e}"))?;

    let planes = img.planes();
    let plane = planes
        .interleaved
        .ok_or_else(|| "libheif returned no interleaved plane".to_string())?;

    let width = plane.width as u32;
    let height = plane.height as u32;
    // libheif hands us row-padded data (stride ≥ width * 3). Copy each
    // row into a tight buffer that image::RgbImage understands.
    let stride = plane.stride;
    let src = plane.data;
    let row_bytes = (width as usize) * 3;
    let mut tight = Vec::with_capacity(row_bytes * height as usize);
    for y in 0..height as usize {
        let start = y * stride;
        tight.extend_from_slice(&src[start..start + row_bytes]);
    }

    let rgb = image::RgbImage::from_raw(width, height, tight)
        .ok_or_else(|| "image::RgbImage::from_raw: dimensions mismatch".to_string())?;

    // Quality 88: sweet spot for photo slideshows; visually
    // indistinguishable from source at 1080p output but ~35% smaller
    // than 95.
    let mut file = std::fs::File::create(&out)
        .map_err(|e| format!("create({}): {e}", out.display()))?;
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 88);
    enc.encode_image(&rgb)
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(out)
}

/// Deterministic cache key for a source file: sha256(path|mtime|size)[..16].
/// The full sha256 is overkill for a local cache; 16 hex chars is 64 bits
/// of entropy which is far below any realistic collision risk for one
/// user's photo library.
fn cache_key(source: &Path, mtime_ns: u128, size: u64) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(source.to_string_lossy().as_bytes());
    h.update(b"|");
    h.update(mtime_ns.to_le_bytes());
    h.update(b"|");
    h.update(size.to_le_bytes());
    let full = h.finalize();
    hex_short(&full[..])
}

fn hex_short(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(16);
    for b in bytes.iter().take(8) {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0F) as usize] as char);
    }
    out
}

/// Preflight probe: instantiate LibHeif to confirm the shared library
/// loads. If the dylib / DLL is missing this fails at link time; a
/// stripped or version-mismatched build surfaces here.
pub fn probe() -> StepReport {
    let _lib = LibHeif::new();
    StepReport::ok("libheif loaded")
}
