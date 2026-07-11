//! Photo curation for the Graduation Day pipeline.
//!
//! Given a source folder and a target duration, produces a ranked
//! selection of photos ready to feed into the concat pipeline. The
//! flow is:
//!   1. Walk the folder (skipping symlinked directories to avoid cycles
//!      and to close a small footgun where a user drops a symlink to
//!      their entire Photos library into the reel folder).
//!   2. For JPEGs, read EXIF `Orientation` tag. If ≠ 1, apply the
//!      rotation/flip and write an upright JPEG into the cache so
//!      FFmpeg's concat demuxer (which does NOT auto-rotate) sees the
//!      photo the right way up. iPhone/Android photos in portrait mode
//!      routinely land with Orientation=6 (rotate 90° CW); without this
//!      step the reel showed them sideways.
//!   3. Normalise HEIC files to JPEGs via `heic::convert_heic_to_jpeg`
//!      (libheif applies `irot` transforms during decode, so HEICs
//!      don't need the EXIF path).
//!   4. Down-sample each candidate to 500px longest-edge in memory and
//!      score it with the Laplacian variance — a well-known
//!      blur/sharpness proxy that returns higher numbers for images
//!      with more edge energy. Resolution-normalised: works on any
//!      camera aspect.
//!   5. Rank by score, then curate down to the target count.
//!
//! No score is a hard reject: this is a *ranking*, not a filter. Better
//! to include a slightly-blurry photo of a real child than to blank the
//! reel.

use std::io::Read;
use std::path::{Path, PathBuf};

use image::{imageops::FilterType, GenericImageView};

use crate::graduation::heic;

const HEIC_EXTS: &[&str] = &["heic", "heif"];
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"];
const RESIZE_MAX_EDGE: u32 = 500; // Blur score is resolution-dependent.

#[derive(Debug, Clone)]
pub struct RankedPhoto {
    /// Final path that FFmpeg will read (HEIC → JPEG converted path
    /// when necessary; original path for JPEG/PNG/etc.).
    pub path: PathBuf,
    /// Original source path (unmodified user file). Used only for UI.
    pub source: PathBuf,
    /// Laplacian variance. Higher = sharper.
    pub sharpness: f64,
}

/// Discover, decode, and rank every image in `source_folder`.
///
/// HEIC files are converted to JPEG in `heic_cache_dir` (typically the
/// app's graduation cache). JPEGs with an EXIF `Orientation` other than
/// `Normal (1)` are pre-rotated to an upright JPEG in the same cache so
/// FFmpeg's concat demuxer renders them right-way-up. Any file that
/// fails to decode is silently skipped; the caller gets a stats struct
/// so it can surface a warning like "3 of 47 photos couldn't be read".
pub fn scan_and_rank(source_folder: &Path, heic_cache_dir: &Path) -> ScanResult {
    scan_and_rank_cancellable(source_folder, heic_cache_dir, &|| false)
}

/// Cancellable variant of [`scan_and_rank`]. Checks `is_cancelled`
/// between each file *and* threads the same predicate into HEIC
/// decode so a cancel during a 100-photo HEIC batch takes effect
/// within one photo instead of running the whole scan to completion
/// (F14). On cancel, returns whatever was scanned so far — the
/// caller sees a partial `ScanResult` but is expected to bail out
/// immediately when it sees the render-state cancel flag set.
pub fn scan_and_rank_cancellable(
    source_folder: &Path,
    heic_cache_dir: &Path,
    is_cancelled: &dyn Fn() -> bool,
) -> ScanResult {
    let mut kept: Vec<RankedPhoto> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut heic_count = 0usize;

    let walker = walk(source_folder);
    for path in walker {
        if is_cancelled() {
            break;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        let (usable_path, is_heic) = if HEIC_EXTS.contains(&ext.as_str()) {
            heic_count += 1;
            match heic::convert_heic_to_jpeg_cancellable(&path, heic_cache_dir, is_cancelled) {
                Ok(p) => (p, true),
                Err(e) => {
                    errors.push(format!("HEIC decode {}: {e}", path.display()));
                    continue;
                }
            }
        } else if IMAGE_EXTS.contains(&ext.as_str()) {
            match ensure_upright(&path, heic_cache_dir) {
                Ok(p) => (p, false),
                Err(e) => {
                    errors.push(format!("orient {}: {e}", path.display()));
                    continue;
                }
            }
        } else {
            continue;
        };

        match score_image(&usable_path) {
            Ok(score) => kept.push(RankedPhoto {
                path: usable_path,
                source: path,
                sharpness: score,
            }),
            Err(e) => {
                let _ = is_heic;
                errors.push(format!("score {}: {e}", path.display()));
            }
        }
    }

    kept.sort_by(|a, b| b.sharpness.partial_cmp(&a.sharpness).unwrap_or(std::cmp::Ordering::Equal));

    ScanResult {
        photos: kept,
        heic_count,
        errors,
    }
}

/// Curate a ranked list down to `target_count` items. If the input has
/// fewer photos than target, returns everything (the caller shows a
/// friendly "we could use more photos" warning). Uses even spacing
/// through the sharpness-sorted list, which biases toward the sharper
/// half but still keeps variety.
pub fn curate(photos: &[RankedPhoto], target_count: usize) -> Vec<RankedPhoto> {
    if photos.is_empty() {
        return Vec::new();
    }
    if photos.len() <= target_count {
        return photos.to_vec();
    }
    // Take the top target_count in the sharpness ranking. Even-spacing
    // was tempting but "top-K" gives noticeably better results in
    // practice — a graduation reel wants photos that look nice, not a
    // statistically-uniform sample of every candidate including blur.
    photos.iter().take(target_count).cloned().collect()
}

pub struct ScanResult {
    pub photos: Vec<RankedPhoto>,
    pub heic_count: usize,
    pub errors: Vec<String>,
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some(d) = stack.pop() {
        // Skip symlinked dirs — they can point outside the source
        // folder (parent scan of the entire drive) or create cycles.
        // symlink_metadata does NOT follow the link, unlike path.is_dir().
        if let Ok(m) = std::fs::symlink_metadata(&d) {
            if m.file_type().is_symlink() { continue }
        }
        // Cycle guard on the canonical form: even without symlinks a
        // user could shove a junction on Windows; canonicalize dedupes.
        let canon = d.canonicalize().unwrap_or_else(|_| d.clone());
        if !visited.insert(canon) { continue }
        let Ok(read) = std::fs::read_dir(&d) else { continue };
        for entry in read.flatten() {
            let p = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                // Silently skip symlinked entries (both files and dirs)
                // — a symlinked *file* could resolve outside the folder,
                // which is exactly the traversal we want to prevent.
                continue;
            }
            if ft.is_dir() {
                // Skip our own cache dir if the user pointed at app_data.
                if p.file_name().and_then(|s| s.to_str()) == Some("graduation-cache") {
                    continue;
                }
                stack.push(p);
            } else if ft.is_file() {
                // Filter macOS sidecar cruft that would otherwise surface
                // as "unreadable image" warnings. `.DS_Store` is Finder's
                // folder-metadata cache; `._*` files are AppleDouble
                // resource forks written by Finder when copying to
                // non-HFS volumes (external drives, NAS, USB sticks).
                // Also skip Windows Thumbs.db while we're here.
                let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if name == ".DS_Store" || name == "Thumbs.db" || name.starts_with("._") {
                    continue;
                }
                out.push(p);
            }
        }
    }
    out
}

/// Read the EXIF `Orientation` tag from a JPEG APP1 segment and, if
/// non-normal (≠ 1), write an upright JPEG to `cache_dir`. Returns the
/// path FFmpeg should read — the original if no rotation is needed,
/// otherwise the cached upright copy.
///
/// This is deliberately a hand-rolled EXIF walker rather than a new
/// crate dep. We only need one 16-bit unsigned tag in IFD0. The parser
/// short-circuits fast when the file isn't JPEG, doesn't have APP1, or
/// has Orientation=1.
fn ensure_upright(source: &Path, cache_dir: &Path) -> Result<PathBuf, String> {
    let orient = read_jpeg_orientation(source).unwrap_or(1);
    if orient == 1 {
        return Ok(source.to_path_buf());
    }
    // Cache upright version keyed on source path + mtime + size +
    // orientation so we don't re-encode on every render.
    let meta = std::fs::metadata(source)
        .map_err(|e| format!("stat: {e}"))?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("mkdir: {e}"))?;
    let key = orient_cache_key(source, mtime_ns, meta.len(), orient);
    let out = cache_dir.join(format!("orient-{key}.jpg"));
    // Fast path: already produced on disk.
    if out.exists() {
        return Ok(out);
    }
    let img = image::open(source).map_err(|e| format!("decode: {e}"))?;
    let rotated = apply_exif_orientation(img, orient);
    // Same race-safe atomic-rename pattern as heic.rs — two threads
    // could otherwise both `save_with_format` to `out` and interleave
    // JPEG bytes, corrupting the cache.
    let tmp = cache_dir.join(format!(
        "orient-{key}.jpg.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    rotated
        .save_with_format(&tmp, image::ImageFormat::Jpeg)
        .map_err(|e| format!("write upright jpeg: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &out) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename {} -> {}: {e}", tmp.display(), out.display()));
    }
    Ok(out)
}

fn orient_cache_key(source: &Path, mtime_ns: u128, size: u64, orient: u16) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(source.to_string_lossy().as_bytes());
    h.update(b"|");
    h.update(mtime_ns.to_le_bytes());
    h.update(b"|");
    h.update(size.to_le_bytes());
    h.update(b"|");
    h.update([orient as u8]);
    let full = h.finalize();
    let mut hex = String::with_capacity(16);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in full.iter().take(8) {
        hex.push(HEX[(b >> 4) as usize] as char);
        hex.push(HEX[(b & 0x0F) as usize] as char);
    }
    hex
}

/// Apply the standard 8-value EXIF Orientation transformation. Values:
/// 1: Normal • 2: Flip-H • 3: Rotate 180 • 4: Flip-V
/// 5: Transpose (rotate 90 CW then flip-H) • 6: Rotate 90 CW
/// 7: Transverse (rotate 90 CCW then flip-H) • 8: Rotate 90 CCW
fn apply_exif_orientation(img: image::DynamicImage, orient: u16) -> image::DynamicImage {
    use image::imageops::{flip_horizontal, flip_vertical, rotate180, rotate270, rotate90};
    match orient {
        1 => img,
        2 => image::DynamicImage::ImageRgba8(flip_horizontal(&img.to_rgba8())),
        3 => image::DynamicImage::ImageRgba8(rotate180(&img.to_rgba8())),
        4 => image::DynamicImage::ImageRgba8(flip_vertical(&img.to_rgba8())),
        5 => {
            let r = rotate90(&img.to_rgba8());
            image::DynamicImage::ImageRgba8(flip_horizontal(&r))
        }
        6 => image::DynamicImage::ImageRgba8(rotate90(&img.to_rgba8())),
        7 => {
            let r = rotate270(&img.to_rgba8());
            image::DynamicImage::ImageRgba8(flip_horizontal(&r))
        }
        8 => image::DynamicImage::ImageRgba8(rotate270(&img.to_rgba8())),
        _ => img,
    }
}

/// Parse the EXIF Orientation tag from a JPEG. Returns `None` if the
/// file isn't a JPEG, has no EXIF, or lacks the tag. Never panics on
/// malformed input — every read is bounds-checked.
///
/// Format primer: JPEG = 0xFFD8 SOI, followed by APP segments. APP1
/// starts with 0xFFE1, has a 2-byte big-endian length, then either
/// `Exif\0\0` (EXIF) or `http://ns.adobe.com/xap/1.0/\0` (XMP). Skip to
/// EXIF. After the header is a TIFF header (`II*\0` little-endian or
/// `MM\0*` big-endian), the IFD0 offset, then IFD0 which is a count
/// followed by 12-byte entries. Orientation is tag 0x0112, type SHORT.
fn read_jpeg_orientation(path: &Path) -> Option<u16> {
    let mut f = std::fs::File::open(path).ok()?;
    // 128 KB is plenty — APP1/EXIF lives at the very start of the file
    // and typical JPEGs put it in the first ~64 KB.
    let mut buf = Vec::with_capacity(64 * 1024);
    let _ = f.by_ref().take(128 * 1024).read_to_end(&mut buf).ok()?;
    if buf.len() < 4 || buf[0] != 0xFF || buf[1] != 0xD8 {
        return None; // not a JPEG
    }
    let mut i = 2usize;
    while i + 4 <= buf.len() {
        if buf[i] != 0xFF { return None }
        let marker = buf[i + 1];
        // Some markers have no payload; APP1 (0xE1) always does.
        if marker == 0xD8 || marker == 0xD9 { return None }
        let seg_len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
        if seg_len < 2 || i + 2 + seg_len > buf.len() { return None }
        if marker == 0xE1 {
            // APP1 payload starts at i+4.
            let payload = &buf[i + 4..i + 2 + seg_len];
            if payload.len() >= 6 && &payload[..6] == b"Exif\0\0" {
                return parse_exif_orientation(&payload[6..]);
            }
        }
        i += 2 + seg_len;
    }
    None
}

fn parse_exif_orientation(tiff: &[u8]) -> Option<u16> {
    if tiff.len() < 8 { return None }
    let little = match &tiff[..4] {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let u16 = |o: usize| -> Option<u16> {
        if o + 2 > tiff.len() { return None }
        let b = [tiff[o], tiff[o + 1]];
        Some(if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    };
    let u32 = |o: usize| -> Option<u32> {
        if o + 4 > tiff.len() { return None }
        let b = [tiff[o], tiff[o + 1], tiff[o + 2], tiff[o + 3]];
        Some(if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    };
    let ifd0_off = u32(4)? as usize;
    let count = u16(ifd0_off)? as usize;
    for e in 0..count {
        let entry = ifd0_off + 2 + e * 12;
        if entry + 12 > tiff.len() { return None }
        let tag = u16(entry)?;
        if tag == 0x0112 {
            // Orientation: SHORT (type=3), count=1. Value inlined in the
            // 4-byte value field. If little-endian, the SHORT is at
            // entry+8; big-endian the SHORT is still at entry+8 (first
            // two bytes of the 4-byte value field).
            return u16(entry + 8);
        }
    }
    None
}

/// Downsample to 500px longest-edge, convert to grayscale, then compute
/// the variance of the 3x3 Laplacian response — the classic "is this
/// image sharp?" metric (Pech-Pacheco et al. 2000).
fn score_image(path: &Path) -> Result<f64, String> {
    let img = image::open(path).map_err(|e| format!("open: {e}"))?;
    let (w, h) = img.dimensions();
    let scale = RESIZE_MAX_EDGE as f32 / (w.max(h) as f32);
    let (nw, nh) = if scale < 1.0 {
        ((w as f32 * scale) as u32, (h as f32 * scale) as u32)
    } else {
        (w, h)
    };
    let small = if (nw, nh) != (w, h) {
        img.resize_exact(nw.max(1), nh.max(1), FilterType::Triangle)
    } else {
        img
    };
    let gray = small.to_luma8();
    Ok(laplacian_variance(&gray))
}

/// Sum of squared responses to the 3x3 Laplacian kernel:
/// ```text
///  0  1  0
///  1 -4  1
///  0  1  0
/// ```
fn laplacian_variance(img: &image::GrayImage) -> f64 {
    let (w, h) = (img.width() as i32, img.height() as i32);
    if w < 3 || h < 3 {
        return 0.0;
    }
    let px = |x: i32, y: i32| -> f64 {
        img.get_pixel(x as u32, y as u32).0[0] as f64
    };
    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut n = 0.0f64;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let l = px(x, y - 1) + px(x, y + 1) + px(x - 1, y) + px(x + 1, y) - 4.0 * px(x, y);
            sum += l;
            sum_sq += l * l;
            n += 1.0;
        }
    }
    if n < 1.0 {
        return 0.0;
    }
    let mean = sum / n;
    sum_sq / n - mean * mean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn laplacian_zero_on_flat_image() {
        let img = image::GrayImage::from_pixel(100, 100, image::Luma([128]));
        assert!(laplacian_variance(&img) < 1e-6);
    }

    #[test]
    fn laplacian_positive_on_edge() {
        let mut img = image::GrayImage::from_pixel(100, 100, image::Luma([0]));
        for y in 0..100 {
            for x in 50..100 {
                img.put_pixel(x, y, image::Luma([255]));
            }
        }
        assert!(laplacian_variance(&img) > 100.0);
    }

    #[test]
    fn curate_returns_all_when_short() {
        let photos = vec![RankedPhoto {
            path: PathBuf::from("a.jpg"),
            source: PathBuf::from("a.jpg"),
            sharpness: 1.0,
        }];
        let out = curate(&photos, 10);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn scan_and_rank_cancellable_bails_out_early_when_flag_set() {
        // F14: with a pre-tripped cancel flag, scan_and_rank_cancellable
        // must return an empty ScanResult immediately instead of walking
        // every file. Simulates a user pressing Cancel between the
        // command entry and the spawn_blocking task starting.
        use std::fs;
        let src = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        // Drop 5 tiny JPEGs into the source folder.
        for i in 0..5 {
            let path = src.path().join(format!("photo-{i}.jpg"));
            let img = image::RgbImage::from_pixel(4, 4, image::Rgb([128, 128, 128]));
            image::DynamicImage::ImageRgb8(img).save(&path).unwrap();
            let _ = fs::metadata(&path).unwrap();
        }
        let result = scan_and_rank_cancellable(src.path(), cache.path(), &|| true);
        assert!(result.photos.is_empty(), "cancelled scan should return no photos");
        assert_eq!(result.heic_count, 0);
    }

    #[test]
    fn parse_exif_orientation_little_endian_six() {
        // Minimal TIFF: II*\0 header, IFD0 at offset 8, 1 entry,
        // tag=0x0112 (Orientation), type=SHORT, count=1, value=6.
        let mut t: Vec<u8> = Vec::new();
        t.extend_from_slice(b"II*\0");        // little-endian marker
        t.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
        t.extend_from_slice(&1u16.to_le_bytes()); // entry count
        t.extend_from_slice(&0x0112u16.to_le_bytes()); // tag
        t.extend_from_slice(&3u16.to_le_bytes());     // type SHORT
        t.extend_from_slice(&1u32.to_le_bytes());     // count
        t.extend_from_slice(&6u16.to_le_bytes());     // value low
        t.extend_from_slice(&0u16.to_le_bytes());     // pad
        assert_eq!(parse_exif_orientation(&t), Some(6));
    }

    #[test]
    fn parse_exif_missing_or_normal() {
        // Wrong byte-order marker → None.
        assert_eq!(parse_exif_orientation(b"ZZ**\0\0\0\0"), None);
        // Orientation=1 (Normal) is still returned as 1 — the caller
        // decides what to do with it (skip the reencode).
        let mut t: Vec<u8> = Vec::new();
        t.extend_from_slice(b"II*\0");
        t.extend_from_slice(&8u32.to_le_bytes());
        t.extend_from_slice(&1u16.to_le_bytes());
        t.extend_from_slice(&0x0112u16.to_le_bytes());
        t.extend_from_slice(&3u16.to_le_bytes());
        t.extend_from_slice(&1u32.to_le_bytes());
        t.extend_from_slice(&1u16.to_le_bytes());
        t.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(parse_exif_orientation(&t), Some(1));
    }
}
