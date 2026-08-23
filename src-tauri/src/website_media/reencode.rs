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

/// rav1e speed preset (1..=10). 4 is a good tradeoff; higher = faster
/// encode but worse compression.
pub const AVIF_SPEED: u8 = 4;

/// Decode any of our supported inputs into an in-memory image.
pub fn decode(bytes: &[u8]) -> Result<DynamicImage, MediaError> {
    image::load_from_memory(bytes).map_err(|e| MediaError::DecodeFailed(e.to_string()))
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
}
