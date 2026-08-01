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
//!   6. **Playback order:** after top-N selection, curated photos are
//!      re-sorted by their source path using a **natural**,
//!      case-insensitive comparison so the video plays them in the
//!      order the user sees in Explorer/Finder (both Windows Explorer
//!      and macOS Finder default to natural sort — `IMG_2` before
//!      `IMG_10`). Sharpness governs which photos are chosen; filename
//!      governs playback sequence.
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
/// friendly "we could use more photos" warning). Selection is by
/// sharpness (top-N of the ranked input); the returned slice is then
/// re-sorted for **playback order** using a natural, case-insensitive
/// comparison on the full source path so the video plays photos in
/// the order the user sees in Explorer/Finder.
///
/// The sort has three properties:
/// 1. **Natural** — `IMG_2.jpg` < `IMG_10.jpg` (matches Windows Explorer
///    and macOS Finder default; a plain lexical sort would swap them).
/// 2. **Case-insensitive** — matches OS file-manager conventions.
/// 3. **Deterministic on non-UTF-8 paths** — the primary comparison is
///    a lossy Unicode conversion (correct for the 99.9% case); ties
///    (including all invalid-UTF-8 collisions) fall through to a raw
///    `OsStr` byte comparison so the total order is stable.
///
/// The full path (not just filename) is the sort key so photos in
/// subfolders of the kid folder can't collide with same-named siblings.
pub fn curate(photos: &[RankedPhoto], target_count: usize) -> Vec<RankedPhoto> {
    if photos.is_empty() {
        return Vec::new();
    }
    // Selection: keep the top-N by sharpness (input is sharpness-DESC).
    let mut selected: Vec<RankedPhoto> = if photos.len() <= target_count {
        photos.to_vec()
    } else {
        // Top-K gives noticeably better results in practice — a
        // graduation reel wants photos that look nice, not a
        // statistically-uniform sample of every candidate incl. blur.
        photos.iter().take(target_count).cloned().collect()
    };
    // Playback order: natural, case-insensitive, on `source` (unmodified
    // user path) so HEIC → JPEG cache filenames can't shuffle order.
    selected.sort_by(|a, b| {
        let a_lossy = a.source.to_string_lossy();
        let b_lossy = b.source.to_string_lossy();
        match natural_cmp_ignore_case(&a_lossy, &b_lossy) {
            std::cmp::Ordering::Equal => {
                // Tie-break on raw OsStr bytes so different non-UTF-8
                // paths (both lossy-converted to U+FFFD) still order
                // deterministically instead of collapsing together.
                a.source.as_os_str().cmp(b.source.as_os_str())
            }
            other => other,
        }
    });
    selected
}

/// Natural, case-insensitive comparison — treats runs of digits as
/// numeric values so `"IMG_2"` sorts before `"IMG_10"`. Both Windows
/// Explorer and macOS Finder use this convention by default; a plain
/// lexical sort would order `IMG_10` before `IMG_2` which is exactly
/// the "random-looking" behavior users complain about.
///
/// Case folding is done via full-string `to_lowercase()` up front
/// (not per-char) so multi-codepoint lowercase mappings like Turkish
/// `İ → i + combining dot` normalise correctly. Note this is Unicode's
/// default *lowercase mapping*, not the stricter *case folding*
/// operation — `ß` stays as `ß` (Rust std has no built-in `ß → ss`
/// folding). For daycare filename ordering this is a non-issue in
/// practice; documented for future reference.
///
/// Digit-run comparison works directly on the digit substring:
/// leading zeros are stripped, then the significant lengths are
/// compared (longer = larger), then digit-wise lexicographic compare
/// on the significant part is exactly numeric order. This is
/// **overflow-free** — arbitrarily long digit runs compare correctly
/// without ever parsing to an integer.
fn natural_cmp_ignore_case(a: &str, b: &str) -> std::cmp::Ordering {
    // Full-string lowercase handles multi-codepoint case mappings that
    // a per-char `.to_lowercase().next()` would truncate.
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    natural_cmp(&a_lower, &b_lower)
}

/// Position-by-position natural compare on already-normalised (e.g.
/// lowercased) strings. Digit runs are treated as numeric values.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ac), Some(bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    match cmp_digit_runs(&mut ai, &mut bi) {
                        Ordering::Equal => continue,
                        other => return other,
                    }
                } else {
                    match ac.cmp(&bc) {
                        Ordering::Equal => { ai.next(); bi.next(); }
                        other => return other,
                    }
                }
            }
        }
    }
}

/// Compare two ASCII-digit runs at the head of each iterator as
/// numeric values, consuming the digits from both. Works for
/// arbitrarily long numbers (no integer parse, no overflow).
///
/// Algorithm:
/// 1. Buffer both digit runs.
/// 2. Strip leading zeros to get "significant" digits.
/// 3. Longer significant length ⇒ larger number.
/// 4. Same significant length ⇒ lex compare on significant digits is
///    exactly numeric order (they represent numbers with the same
///    magnitude).
/// 5. Equal numeric value with different leading-zero counts ⇒
///    shorter total run sorts first (so `1` < `01` < `001`), which is
///    a deterministic and reasonable tie-break for filenames.
fn cmp_digit_runs<I: Iterator<Item = char>>(
    a: &mut std::iter::Peekable<I>,
    b: &mut std::iter::Peekable<I>,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut a_digits = String::new();
    while let Some(&c) = a.peek() {
        if c.is_ascii_digit() { a_digits.push(c); a.next(); } else { break; }
    }
    let mut b_digits = String::new();
    while let Some(&c) = b.peek() {
        if c.is_ascii_digit() { b_digits.push(c); b.next(); } else { break; }
    }
    let a_sig = a_digits.trim_start_matches('0');
    let b_sig = b_digits.trim_start_matches('0');
    match a_sig.len().cmp(&b_sig.len()) {
        Ordering::Equal => match a_sig.cmp(b_sig) {
            // Same numeric value: order by total run length (fewer
            // leading zeros first).
            Ordering::Equal => a_digits.len().cmp(&b_digits.len()),
            other => other,
        },
        other => other,
    }
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
pub(crate) fn apply_exif_orientation(img: image::DynamicImage, orient: u16) -> image::DynamicImage {
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
pub(crate) fn read_jpeg_orientation(path: &Path) -> Option<u16> {
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
    fn curate_returns_selected_photos_in_filename_order() {
        // Input is sharpness-DESC (as scan_and_rank produces).
        // curate should select the top-3 by sharpness, then re-order
        // them by original source filename so the reel plays them in
        // the order the user sees them in Explorer/Finder.
        let photos = vec![
            RankedPhoto { path: "/c/IMG_003.jpg".into(), source: "/c/IMG_003.jpg".into(), sharpness: 9.0 },
            RankedPhoto { path: "/c/IMG_001.jpg".into(), source: "/c/IMG_001.jpg".into(), sharpness: 8.0 },
            RankedPhoto { path: "/c/IMG_005.jpg".into(), source: "/c/IMG_005.jpg".into(), sharpness: 7.0 },
            RankedPhoto { path: "/c/IMG_002.jpg".into(), source: "/c/IMG_002.jpg".into(), sharpness: 3.0 },
            RankedPhoto { path: "/c/IMG_004.jpg".into(), source: "/c/IMG_004.jpg".into(), sharpness: 2.0 },
        ];
        let out = curate(&photos, 3);
        assert_eq!(out.len(), 3);
        // Selection kept the top-3 by sharpness (9,8,7 → 003,001,005)
        // then reordered by filename: 001, 003, 005.
        let names: Vec<String> = out.iter()
            .map(|p| p.source.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["IMG_001.jpg", "IMG_003.jpg", "IMG_005.jpg"]);
    }

    #[test]
    fn curate_short_input_is_also_sorted_by_filename() {
        // When input is shorter than target we still want playback
        // order to be alphabetical, not sharpness order.
        let photos = vec![
            RankedPhoto { path: "/c/z.jpg".into(), source: "/c/z.jpg".into(), sharpness: 9.0 },
            RankedPhoto { path: "/c/a.jpg".into(), source: "/c/a.jpg".into(), sharpness: 5.0 },
            RankedPhoto { path: "/c/M.jpg".into(), source: "/c/M.jpg".into(), sharpness: 7.0 },
        ];
        let out = curate(&photos, 10);
        let names: Vec<String> = out.iter()
            .map(|p| p.source.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        // Case-insensitive: a < M < z.
        assert_eq!(names, vec!["a.jpg", "M.jpg", "z.jpg"]);
    }

    #[test]
    fn curate_uses_natural_sort_for_unpadded_numbers() {
        // Windows Explorer and macOS Finder both use natural sort by
        // default. A plain lexical sort would put IMG_10 before IMG_2
        // — exactly the "random-looking" behavior users complain about.
        let photos = vec![
            RankedPhoto { path: "/c/IMG_10.jpg".into(), source: "/c/IMG_10.jpg".into(), sharpness: 9.0 },
            RankedPhoto { path: "/c/IMG_2.jpg".into(),  source: "/c/IMG_2.jpg".into(),  sharpness: 8.0 },
            RankedPhoto { path: "/c/IMG_1.jpg".into(),  source: "/c/IMG_1.jpg".into(),  sharpness: 7.0 },
        ];
        let out = curate(&photos, 10);
        let names: Vec<String> = out.iter()
            .map(|p| p.source.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["IMG_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]);
    }

    #[test]
    fn curate_handles_extensionless_files() {
        let photos = vec![
            RankedPhoto { path: "/c/photo3".into(), source: "/c/photo3".into(), sharpness: 9.0 },
            RankedPhoto { path: "/c/photo1".into(), source: "/c/photo1".into(), sharpness: 8.0 },
            RankedPhoto { path: "/c/photo2".into(), source: "/c/photo2".into(), sharpness: 7.0 },
        ];
        let out = curate(&photos, 10);
        let names: Vec<String> = out.iter()
            .map(|p| p.source.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["photo1", "photo2", "photo3"]);
    }

    #[test]
    fn curate_disambiguates_same_filename_in_different_subfolders() {
        // walk() recurses into subfolders. Two `001.jpg` files in
        // different subdirs must not compare equal — comparing the
        // full source path (not just the basename) handles this.
        let photos = vec![
            RankedPhoto { path: "/c/Sports/001.jpg".into(),  source: "/c/Sports/001.jpg".into(),  sharpness: 9.0 },
            RankedPhoto { path: "/c/Casual/001.jpg".into(),  source: "/c/Casual/001.jpg".into(),  sharpness: 8.0 },
            RankedPhoto { path: "/c/Sports/002.jpg".into(),  source: "/c/Sports/002.jpg".into(),  sharpness: 7.0 },
        ];
        let out = curate(&photos, 10);
        let sources: Vec<String> = out.iter()
            .map(|p| p.source.to_string_lossy().into_owned())
            .collect();
        // Casual < Sports (case-insensitive alpha on the parent dir),
        // then within Sports 001 < 002 (natural numeric sort).
        assert_eq!(sources, vec!["/c/Casual/001.jpg", "/c/Sports/001.jpg", "/c/Sports/002.jpg"]);
    }

    #[test]
    fn curate_handles_unicode_filenames() {
        // Latin-1 accented chars have codepoints > ASCII, so with our
        // deterministic Unicode-code-point ordering, é (0xE9) sorts
        // after b (0x62). Two of the three names are ASCII so they
        // demonstrate case-insensitive alpha ordering; the third
        // ensures accented chars don't panic and land where expected.
        let photos = vec![
            RankedPhoto { path: "/c/apple.jpg".into(),  source: "/c/apple.jpg".into(),  sharpness: 9.0 },
            RankedPhoto { path: "/c/Banana.jpg".into(), source: "/c/Banana.jpg".into(), sharpness: 8.0 },
            RankedPhoto { path: "/c/été.jpg".into(),    source: "/c/été.jpg".into(),    sharpness: 7.0 },
        ];
        let out = curate(&photos, 10);
        let names: Vec<String> = out.iter()
            .map(|p| p.source.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["apple.jpg", "Banana.jpg", "été.jpg"]);
    }

    #[test]
    fn natural_cmp_handles_multi_char_case_folding() {
        use std::cmp::Ordering;
        // Turkish dotted-capital-I lowercases to i + combining dot
        // (two codepoints). A naive `to_lowercase().next()` per-char
        // would only see 'i' and drop the combining dot; full-string
        // lowercasing preserves both codepoints so an İ-name compares
        // against a pre-composed "i\u{0307}"-name as equal.
        assert_eq!(natural_cmp_ignore_case("İ", "i\u{0307}"), Ordering::Equal);
        // ASCII case-insensitivity still works after the multi-char
        // pathway.
        assert_eq!(natural_cmp_ignore_case("Apple", "apple"), Ordering::Equal);
        assert_eq!(natural_cmp_ignore_case("APPLE", "banana"), Ordering::Less);
    }

    #[test]
    fn natural_cmp_handles_arbitrarily_long_numbers() {
        use std::cmp::Ordering;
        // 40- and 41-digit numbers overflow u128. The old parsing
        // implementation would collapse both to u128::MAX and compare
        // equal; the new string-based compare handles it correctly.
        let a = format!("a{}", "9".repeat(40));  // 40 nines
        let b = format!("a{}", "1".repeat(41));  // 41 ones — larger
        assert_eq!(natural_cmp_ignore_case(&a, &b), Ordering::Less);
        // Leading zeros: equal numeric value, shorter total run first.
        assert_eq!(natural_cmp_ignore_case("a1", "a01"), Ordering::Less);
        assert_eq!(natural_cmp_ignore_case("a01", "a001"), Ordering::Less);
        // Different numeric values with different leading-zero counts.
        assert_eq!(natural_cmp_ignore_case("a09", "a10"), Ordering::Less);
        // Zero vs anything.
        assert_eq!(natural_cmp_ignore_case("a0", "a1"), Ordering::Less);
    }

    #[test]
    fn curate_handles_empty_source_paths() {
        // Degenerate edge case: paths with no filename (e.g. "" or "/")
        // should not panic. They tie on the natural-cmp key but the
        // OsStr tie-break still gives a stable total order.
        let photos = vec![
            RankedPhoto { path: "".into(),  source: "".into(),  sharpness: 9.0 },
            RankedPhoto { path: "/".into(), source: "/".into(), sharpness: 8.0 },
            RankedPhoto { path: "/a.jpg".into(), source: "/a.jpg".into(), sharpness: 7.0 },
        ];
        let out = curate(&photos, 10);
        assert_eq!(out.len(), 3, "no photos dropped");
    }

    #[test]
    fn natural_cmp_number_boundaries() {
        use std::cmp::Ordering;
        // Same prefix, different numbers.
        assert_eq!(natural_cmp_ignore_case("a2", "a10"), Ordering::Less);
        assert_eq!(natural_cmp_ignore_case("a10", "a2"), Ordering::Greater);
        // Equal numbers, different suffixes.
        assert_eq!(natural_cmp_ignore_case("a1b", "a1c"), Ordering::Less);
        // Case-insensitive.
        assert_eq!(natural_cmp_ignore_case("APPLE", "banana"), Ordering::Less);
        assert_eq!(natural_cmp_ignore_case("apple", "APPLE"), Ordering::Equal);
        // Number vs non-number at same position: char comparison.
        // '0' (0x30) < 'a' (0x61) so numeric side sorts first.
        assert_eq!(natural_cmp_ignore_case("a1", "aa"), Ordering::Less);
        // Shorter string is Less at prefix equality.
        assert_eq!(natural_cmp_ignore_case("a", "ab"), Ordering::Less);
        assert_eq!(natural_cmp_ignore_case("", ""), Ordering::Equal);
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
