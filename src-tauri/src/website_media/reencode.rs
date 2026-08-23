//! Deterministic 3-widths × 3-formats re-encoder.
//!
//! For every source photo the pipeline produces:
//! - 3 widths: 400, 800, 1600 (aspect ratio preserved; target = max(w, h))
//! - 3 formats: AVIF (q=50, speed=4), WebP (lossless via `image` crate),
//!   JPG (q=82)
//!
//! Determinism guarantees:
//! - Same input bytes + same recipe version → byte-identical outputs on
//!   the same platform build.
//! - AVIF uses `.with_num_threads(Some(1))` to remove thread-scheduling
//!   variance in rav1e.
//! - JPG uses `image`'s deterministic JpegEncoder at fixed quality.
//! - WebP uses `image`'s lossless VP8L encoder (also deterministic).
//!
//! NOTE: `image` 0.25's built-in WebPEncoder is lossless-only. The
//! `q=80` quality knob will land in PR 3.5 when we add the `webp`
//! crate (libwebp bindings). Recipe version stays at 1 for now — bump
//! when we swap encoders.

use super::error::MediaError;
use super::hash::Format;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, GenericImageView, ImageEncoder};

/// Rendered widths, ordered small → large. The pipeline uses these as
/// the "max dimension" — portrait photos scale so `max(w, h) = width`.
pub const WIDTHS: [u32; 3] = [400, 800, 1600];

/// JPEG quality (0–100). 82 is the sweet spot between size and quality
/// for content photos — matches the current Tauri profile builder.
pub const JPG_QUALITY: u8 = 82;

/// AVIF quality (0–100). 50 is aggressive but still visually acceptable
/// at typical viewing distances; the format's contrast retention is much
/// better than JPEG at the same quantizer.
pub const AVIF_QUALITY: f32 = 50.0;

/// rav1e speed preset (1..=10). 8 is aggressive — encode ~2-3× faster
/// than speed 4 with ~15-25% larger files, but AVIF at speed 8 still
/// beats WebP on compression, so the on-disk cost is acceptable.
pub const AVIF_SPEED: u8 = 8;

/// Decode any of our supported inputs into an in-memory image, applying
/// EXIF orientation from the source bytes so downstream variants have
/// upright pixel data (the metadata itself is discarded on re-encode).
///
/// The strip step removes EXIF for privacy, but that also drops the
/// orientation tag — without applying it to the pixels first, a phone
/// photo taken in portrait would render sideways in the browser. We
/// read the orientation from the *original* bytes (which still carry
/// EXIF) and rotate the decoded pixels accordingly.
pub fn decode(bytes: &[u8]) -> Result<DynamicImage, MediaError> {
    decode_with_orientation(bytes, bytes)
}

/// Same as [`decode`] but reads orientation from a separate byte slice
/// (typically the pre-strip original). Use this when the decode input
/// has already had its EXIF stripped.
pub fn decode_with_orientation(
    decode_bytes: &[u8],
    orientation_source: &[u8],
) -> Result<DynamicImage, MediaError> {
    let mut img = image::load_from_memory(decode_bytes)
        .map_err(|e| MediaError::DecodeFailed(e.to_string()))?;
    if let Some(orientation) = read_exif_orientation(orientation_source) {
        img.apply_orientation(orientation);
    }
    Ok(img)
}

/// Parse the EXIF orientation tag (0x0112) from a JPEG's APP1 segment.
///
/// Returns `None` if the input is not a JPEG, has no EXIF, or has no
/// orientation tag. Returns a value of 1 (no transforms) as `None` so
/// callers can skip the apply cheaply.
fn read_exif_orientation(bytes: &[u8]) -> Option<image::metadata::Orientation> {
    use image::metadata::Orientation;
    let raw = parse_jpeg_orientation_value(bytes)?;
    match raw {
        1 => None,
        2 => Some(Orientation::FlipHorizontal),
        3 => Some(Orientation::Rotate180),
        4 => Some(Orientation::FlipVertical),
        5 => Some(Orientation::Rotate90FlipH),
        6 => Some(Orientation::Rotate90),
        7 => Some(Orientation::Rotate270FlipH),
        8 => Some(Orientation::Rotate270),
        _ => None,
    }
}

/// Walk JPEG APP1 markers looking for `Exif\0\0` + TIFF header + IFD0
/// orientation tag. Returns the raw 1..=8 value.
fn parse_jpeg_orientation_value(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        i += 2;
        // Standalone markers (no length): 0xD0..=0xD9, 0x01.
        if marker == 0xD8 || marker == 0xD9 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        if i + 2 > bytes.len() {
            return None;
        }
        let seg_len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > bytes.len() {
            return None;
        }
        let seg = &bytes[i + 2..i + seg_len];
        i += seg_len;
        // APP1 (0xE1) with "Exif\0\0" header.
        if marker == 0xE1 && seg.len() >= 6 && &seg[..6] == b"Exif\0\0" {
            let tiff = &seg[6..];
            return parse_tiff_orientation(tiff);
        }
        // Reached SOS (0xDA) — scan data follows, we're done.
        if marker == 0xDA {
            return None;
        }
    }
    None
}

fn parse_tiff_orientation(tiff: &[u8]) -> Option<u16> {
    if tiff.len() < 8 {
        return None;
    }
    let little = match &tiff[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let read_u16 = |o: usize| -> Option<u16> {
        let b = tiff.get(o..o + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let read_u32 = |o: usize| -> Option<u32> {
        let b = tiff.get(o..o + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    if read_u16(2)? != 0x002A {
        return None;
    }
    let ifd0_offset = read_u32(4)? as usize;
    if ifd0_offset + 2 > tiff.len() {
        return None;
    }
    let n_entries = read_u16(ifd0_offset)? as usize;
    for k in 0..n_entries {
        let entry_off = ifd0_offset + 2 + k * 12;
        if entry_off + 12 > tiff.len() {
            return None;
        }
        let tag = read_u16(entry_off)?;
        if tag == 0x0112 {
            // Value is a SHORT stored inline in the 4-byte value field.
            return read_u16(entry_off + 8);
        }
    }
    None
}

/// Scale so the longest dimension equals `target`. Aspect ratio preserved.
///
/// Unlike a typical "shrink only" resize this ALWAYS resizes — including
/// upscaling — so every variant has a predictable output size and the
/// downstream `<picture>` `sizes` attribute is stable. Upscaling a
/// small source is wasteful but harmless; callers that want to avoid
/// it should filter widths at the pipeline level.
pub fn resize_to_max_dim(img: &DynamicImage, target: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    if target == 0 || w == 0 || h == 0 {
        return img.clone();
    }
    if w == h && w == target {
        return img.clone();
    }
    let (nw, nh) = if w >= h {
        let nw = target;
        let nh = ((h as u64 * target as u64) / w as u64).max(1) as u32;
        (nw, nh)
    } else {
        let nh = target;
        let nw = ((w as u64 * target as u64) / h as u64).max(1) as u32;
        (nw, nh)
    };
    if (nw, nh) == (w, h) {
        return img.clone();
    }
    img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
}

/// Encode a JPEG at [`JPG_QUALITY`].
pub fn encode_jpg(img: &DynamicImage) -> Result<Vec<u8>, MediaError> {
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    let enc = JpegEncoder::new_with_quality(&mut out, JPG_QUALITY);
    enc.write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| MediaError::EncodeFailed(format!("jpg: {e}")))?;
    Ok(out)
}

/// Encode a WebP (lossless VP8L via `image` crate). See module note re:
/// the future lossy libwebp swap.
pub fn encode_webp(img: &DynamicImage) -> Result<Vec<u8>, MediaError> {
    let rgba = img.to_rgba8();
    let mut out = Vec::new();
    let enc = WebPEncoder::new_lossless(&mut out);
    enc.write_image(
        rgba.as_raw(),
        rgba.width(),
        rgba.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| MediaError::EncodeFailed(format!("webp: {e}")))?;
    Ok(out)
}

/// Encode an AVIF at [`AVIF_QUALITY`] / [`AVIF_SPEED`]. Single-threaded
/// for determinism.
pub fn encode_avif(img: &DynamicImage) -> Result<Vec<u8>, MediaError> {
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    // Rebuild as a Vec<RGBA8>; ravif re-exports rgb::RGBA8 and imgref::Img.
    let pixels: Vec<ravif::RGBA8> = rgba
        .chunks_exact(4)
        .map(|c| ravif::RGBA8 {
            r: c[0],
            g: c[1],
            b: c[2],
            a: c[3],
        })
        .collect();
    let img_ref = ravif::Img::new(pixels.as_slice(), w, h);

    let encoded = ravif::Encoder::new()
        .with_quality(AVIF_QUALITY)
        .with_speed(AVIF_SPEED)
        .with_num_threads(Some(1))
        .encode_rgba(img_ref)
        .map_err(|e| MediaError::EncodeFailed(format!("avif: {e}")))?;
    Ok(encoded.avif_file)
}

/// Encode into the requested format.
pub fn encode(img: &DynamicImage, format: Format) -> Result<Vec<u8>, MediaError> {
    match format {
        Format::Avif => encode_avif(img),
        Format::Webp => encode_webp(img),
        Format::Jpg => encode_jpg(img),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    fn make_solid_rgb_jpeg(w: u32, h: u32, colour: [u8; 3]) -> Vec<u8> {
        let mut img = RgbImage::new(w, h);
        for px in img.pixels_mut() {
            *px = image::Rgb(colour);
        }
        let mut buf = Vec::new();
        let enc = JpegEncoder::new_with_quality(&mut buf, 90);
        enc.write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .expect("jpeg");
        buf
    }

    #[test]
    fn reencode_produces_expected_dimensions_landscape() {
        // 200×150 landscape → target 100  = 100×75  (downscale).
        // 200×150 landscape → target 400  = 400×300 (upscale, aspect kept).
        // 200×150 landscape → target 200  = 200×150 (no-op — exact match).
        let jpeg = make_solid_rgb_jpeg(200, 150, [10, 20, 200]);
        let img = decode(&jpeg).unwrap();

        let small = resize_to_max_dim(&img, 100);
        assert_eq!(small.dimensions(), (100, 75));

        let big = resize_to_max_dim(&img, 400);
        assert_eq!(big.dimensions(), (400, 300));

        let same = resize_to_max_dim(&img, 200);
        assert_eq!(same.dimensions(), (200, 150));
    }

    #[test]
    fn reencode_portrait_preserves_orientation() {
        // 100×200 portrait scaled to max dim 800 → 400×800.
        // The test lives here (not just in pipeline) because the
        // resize helper is where the aspect-ratio math actually happens.
        let mut img = RgbImage::new(100, 200);
        for px in img.pixels_mut() {
            *px = image::Rgb([30, 220, 30]);
        }
        let mut buf = Vec::new();
        let enc = JpegEncoder::new_with_quality(&mut buf, 90);
        enc.write_image(img.as_raw(), 100, 200, image::ExtendedColorType::Rgb8)
            .unwrap();
        let decoded = decode(&buf).unwrap();

        let resized = resize_to_max_dim(&decoded, 800);
        assert_eq!(
            resized.dimensions(),
            (400, 800),
            "portrait must scale so max(w,h) = target and orientation is kept"
        );
    }

    #[test]
    fn reencode_produces_3_widths_3_formats() {
        // Feed a JPEG large enough that every target width actually
        // triggers a resize, so we can assert output dimensions.
        let jpeg = make_solid_rgb_jpeg(2000, 1500, [200, 40, 40]);
        let img = decode(&jpeg).unwrap();

        for &w in &WIDTHS {
            let resized = resize_to_max_dim(&img, w);
            let (rw, rh) = resized.dimensions();
            assert_eq!(rw.max(rh), w, "max dim should equal target {w}");

            let avif = encode_avif(&resized).unwrap();
            let webp = encode_webp(&resized).unwrap();
            let jpg = encode_jpg(&resized).unwrap();

            // Format magic byte checks — cheapest possible verification.
            assert!(
                avif.len() > 12 && &avif[4..8] == b"ftyp",
                "avif magic missing"
            );
            assert!(
                webp.len() > 12 && &webp[0..4] == b"RIFF" && &webp[8..12] == b"WEBP",
                "webp magic missing"
            );
            assert!(
                jpg.len() > 3 && jpg[0] == 0xFF && jpg[1] == 0xD8 && jpg[2] == 0xFF,
                "jpg SOI missing"
            );
        }
    }

    #[test]
    fn reencode_is_deterministic_jpg() {
        // JPG must be byte-identical across runs; determinism guarantee
        // matters most for the two lossy formats we ship at scale.
        let jpeg = make_solid_rgb_jpeg(800, 600, [123, 45, 67]);
        let img = decode(&jpeg).unwrap();
        let resized = resize_to_max_dim(&img, 400);
        let a = encode_jpg(&resized).unwrap();
        let b = encode_jpg(&resized).unwrap();
        assert_eq!(a, b, "jpg encoding is not deterministic");
    }

    #[test]
    fn reencode_is_deterministic_webp() {
        let jpeg = make_solid_rgb_jpeg(800, 600, [200, 200, 200]);
        let img = decode(&jpeg).unwrap();
        let resized = resize_to_max_dim(&img, 400);
        let a = encode_webp(&resized).unwrap();
        let b = encode_webp(&resized).unwrap();
        assert_eq!(a, b, "webp encoding is not deterministic");
    }

    /// Build a minimal JPEG with an APP1 EXIF segment declaring the
    /// given orientation (1..=8). Uses a tiny valid JPEG payload after
    /// the APP1 so the file parses.
    fn make_jpeg_with_orientation(orientation: u16) -> Vec<u8> {
        let base = make_solid_rgb_jpeg(20, 10, [0, 0, 0]);
        // APP1 EXIF segment: little-endian TIFF, IFD0 with 1 entry
        // (orientation SHORT).
        let mut app1 = Vec::new();
        app1.extend_from_slice(b"Exif\0\0");
        // TIFF header (II, 0x2A, IFD0 offset = 8).
        app1.extend_from_slice(b"II");
        app1.extend_from_slice(&0x002Au16.to_le_bytes());
        app1.extend_from_slice(&8u32.to_le_bytes());
        // IFD0: 1 entry.
        app1.extend_from_slice(&1u16.to_le_bytes());
        // Entry: tag=0x0112, type=3 (SHORT), count=1, value=orientation.
        app1.extend_from_slice(&0x0112u16.to_le_bytes());
        app1.extend_from_slice(&3u16.to_le_bytes());
        app1.extend_from_slice(&1u32.to_le_bytes());
        app1.extend_from_slice(&orientation.to_le_bytes());
        app1.extend_from_slice(&[0, 0]); // pad to 4 bytes
                                          // Next IFD offset = 0.
        app1.extend_from_slice(&0u32.to_le_bytes());
        let seg_len = (app1.len() + 2) as u16;
        // Splice APP1 right after SOI (first 2 bytes = FF D8).
        let mut out = Vec::new();
        out.extend_from_slice(&base[..2]);
        out.push(0xFF);
        out.push(0xE1);
        out.extend_from_slice(&seg_len.to_be_bytes());
        out.extend_from_slice(&app1);
        out.extend_from_slice(&base[2..]);
        out
    }

    #[test]
    fn exif_orientation_1_is_ignored_as_noop() {
        let jpeg = make_jpeg_with_orientation(1);
        assert!(read_exif_orientation(&jpeg).is_none());
    }

    #[test]
    fn exif_orientation_6_reads_as_rotate90() {
        // 6 = "Rotated 90 CW" (portrait taken with phone held normally).
        let jpeg = make_jpeg_with_orientation(6);
        let ori = read_exif_orientation(&jpeg).expect("orientation");
        assert!(matches!(ori, image::metadata::Orientation::Rotate90));
    }

    #[test]
    fn exif_orientation_baked_into_decoded_pixels() {
        // Rotation 90CW of a 20×10 landscape → 10×20 portrait after apply.
        let jpeg = make_jpeg_with_orientation(6);
        let img = decode(&jpeg).unwrap();
        let (w, h) = img.dimensions();
        assert_eq!(
            (w, h),
            (10, 20),
            "orientation 6 must rotate 20x10 into 10x20"
        );
    }

    #[test]
    fn no_exif_at_all_returns_no_orientation() {
        let jpeg = make_solid_rgb_jpeg(50, 40, [1, 2, 3]);
        assert!(read_exif_orientation(&jpeg).is_none());
    }
}
