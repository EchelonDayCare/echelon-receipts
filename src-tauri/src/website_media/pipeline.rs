//! Top-level photo pipeline orchestrator.
//!
//! Turns a single uploaded photo into 9 deterministic derived variants
//! (3 widths × 3 formats). The 9 encode jobs are fanned out through
//! Rayon so a modern 8-core box finishes a 4K photo in a couple of
//! seconds even with AVIF in the mix.

use super::error::MediaError;
use super::exif::{strip_metadata, FormatHint};
use super::hash::{filename, source_hash_hex, Format, RECIPE_VERSION};
use super::reencode::{decode, encode, resize_to_max_dim, WIDTHS};
use rayon::prelude::*;

/// Hard cap on input photo size. 50 MiB is generous for any camera JPEG
/// or even a moderate PNG — anything larger is almost certainly a bug
/// or an attack vector.
pub const MAX_INPUT_SIZE: usize = 50 * 1024 * 1024;

/// A single photo upload.
#[derive(Debug, Clone)]
pub struct PhotoInput {
    /// Raw bytes as uploaded — used for identity hashing so re-uploading
    /// the same file (even with different EXIF) recomputes to the same
    /// base hash.
    pub original_bytes: Vec<u8>,
    /// The filename the user picked — kept for audit; the derived
    /// filenames are content-hashed and never expose it.
    pub source_filename: String,
}

/// One rendered variant.
#[derive(Debug)]
pub struct Variant {
    pub width: u32,
    pub format: Format,
    /// Deterministic derived filename — see [`super::hash::filename`].
    pub filename: String,
    pub bytes: Vec<u8>,
}

/// Result of processing one photo: the identity hash of the original
/// plus all rendered variants.
#[derive(Debug)]
pub struct PhotoOutput {
    /// Full 64-char sha256 hex of the ORIGINAL upload bytes. Stable
    /// identity for de-dup and audit.
    pub base_hash: String,
    /// Every rendered variant, sorted by (width asc, format asc).
    pub variants: Vec<Variant>,
}

/// Sniff the container from the leading bytes. Deliberately narrow —
/// we do NOT try to be `libmagic`; a small allow-list is safer.
pub(crate) fn detect_hint(bytes: &[u8]) -> Result<FormatHint, MediaError> {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Ok(FormatHint::Jpeg);
    }
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1A\n" {
        return Ok(FormatHint::Png);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(FormatHint::Webp);
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" {
        return Ok(FormatHint::Avif);
    }
    Err(MediaError::UnsupportedFormat)
}

/// Full pipeline: EXIF strip → decode → 3×3 re-encode → 9 variants.
///
/// The 9 encode jobs are Rayon-parallel; the outer function is
/// synchronous and CPU-bound. Callers wanting async should spawn on
/// a blocking pool.
pub fn process_photo(input: PhotoInput) -> Result<PhotoOutput, MediaError> {
    if input.original_bytes.len() > MAX_INPUT_SIZE {
        return Err(MediaError::InputTooLarge {
            size: input.original_bytes.len(),
            max: MAX_INPUT_SIZE,
        });
    }

    let hint = detect_hint(&input.original_bytes)?;
    let stripped = strip_metadata(&input.original_bytes, hint)?;

    // Decode from the stripped bytes so the encode is fully deterministic
    // w.r.t. the stripped source — otherwise a pipeline run against a
    // freshly-stripped copy could diverge from a pipeline run against the
    // original.
    let decoded = decode(&stripped)?;

    let base_hash = source_hash_hex(&input.original_bytes);

    // NOTE: PR 3 groundwork ships WebP + JPG only (6 variants).
    // AVIF (Format::Avif) is intentionally omitted from the job list —
    // its encoder is stubbed in `reencode::encode_avif`. PR 3.5 will
    // re-add `Format::Avif` here in the same commit that re-introduces
    // the `ravif` dependency and bumps `RECIPE_VERSION` to 2.
    // TODO: reintroduce Format::Avif in PR3.5
    let jobs: Vec<(u32, Format)> = WIDTHS
        .iter()
        .copied()
        .flat_map(|w| {
            [Format::Webp, Format::Jpg]
                .into_iter()
                .map(move |f| (w, f))
        })
        .collect();

    let variants: Result<Vec<Variant>, MediaError> = jobs
        .into_par_iter()
        .map(|(w, f)| {
            let resized = resize_to_max_dim(&decoded, w);
            let bytes = encode(&resized, f)?;
            let fname = filename(&input.original_bytes, w, f, RECIPE_VERSION);
            Ok(Variant {
                width: w,
                format: f,
                filename: fname,
                bytes,
            })
        })
        .collect();

    let mut variants = variants?;
    variants.sort_by(|a, b| a.width.cmp(&b.width).then_with(|| a.format.cmp(&b.format)));

    Ok(PhotoOutput {
        base_hash,
        variants,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, RgbImage};

    fn make_solid_jpeg(w: u32, h: u32, colour: [u8; 3]) -> Vec<u8> {
        let mut img = RgbImage::new(w, h);
        for px in img.pixels_mut() {
            *px = image::Rgb(colour);
        }
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    #[test]
    fn pipeline_end_to_end_landscape() {
        let jpeg = make_solid_jpeg(2000, 1500, [200, 40, 40]);
        let out = process_photo(PhotoInput {
            original_bytes: jpeg.clone(),
            source_filename: "tiny_landscape.jpg".into(),
        })
        .expect("pipeline ok");

        // PR 3 groundwork: 3 widths × 2 formats (WebP + JPG). AVIF is
        // stubbed until PR 3.5 re-introduces ravif.
        assert_eq!(out.variants.len(), 6, "expected 3 widths × 2 formats");
        assert_eq!(out.base_hash.len(), 64);

        // Sorted by (width, format).
        let widths: Vec<u32> = out.variants.iter().map(|v| v.width).collect();
        assert_eq!(widths, vec![400, 400, 800, 800, 1600, 1600]);

        // Every filename ends in the right extension.
        for v in &out.variants {
            assert!(v.filename.ends_with(v.format.ext()), "wrong ext: {}", v.filename);
            assert!(v.filename.contains(&format!("-w{}", v.width)));
            assert!(!v.bytes.is_empty(), "empty output bytes");
            // AVIF must not appear in the shipped variant set.
            assert_ne!(v.format, Format::Avif, "AVIF should be stubbed in PR 3 groundwork");
        }
    }

    #[test]
    fn pipeline_end_to_end_portrait() {
        // Portrait 1000×1500 → max dim per width should equal the width.
        let jpeg = make_solid_jpeg(1000, 1500, [30, 220, 30]);
        let out = process_photo(PhotoInput {
            original_bytes: jpeg,
            source_filename: "tiny_portrait.jpg".into(),
        })
        .expect("pipeline ok");

        assert_eq!(out.variants.len(), 6);
        // Sniff dimensions of the JPG variant at width 800 → should be 533×800.
        let v = out
            .variants
            .iter()
            .find(|v| v.width == 800 && v.format == Format::Jpg)
            .unwrap();
        let decoded = image::load_from_memory(&v.bytes).unwrap();
        assert_eq!(
            decoded.height(),
            800,
            "portrait scaled so max dim = target width"
        );
        assert!(decoded.width() < decoded.height());
    }

    #[test]
    fn pipeline_is_deterministic() {
        // Full end-to-end determinism: same input twice → same 6 outputs
        // byte-for-byte. This is what unlocks safe CDN caching.
        let jpeg = make_solid_jpeg(400, 300, [90, 90, 90]);
        let a = process_photo(PhotoInput {
            original_bytes: jpeg.clone(),
            source_filename: "same.jpg".into(),
        })
        .unwrap();
        let b = process_photo(PhotoInput {
            original_bytes: jpeg,
            source_filename: "same.jpg".into(),
        })
        .unwrap();
        assert_eq!(a.base_hash, b.base_hash);
        assert_eq!(a.variants.len(), b.variants.len());
        for (va, vb) in a.variants.iter().zip(b.variants.iter()) {
            assert_eq!(va.filename, vb.filename);
            assert_eq!(va.bytes, vb.bytes, "variant {} bytes not deterministic", va.filename);
        }
    }

    #[test]
    fn pipeline_rejects_too_large() {
        let bytes = vec![0u8; MAX_INPUT_SIZE + 1];
        let err = process_photo(PhotoInput {
            original_bytes: bytes,
            source_filename: "huge.jpg".into(),
        })
        .expect_err("should reject");
        match err {
            MediaError::InputTooLarge { size, max } => {
                assert_eq!(size, MAX_INPUT_SIZE + 1);
                assert_eq!(max, MAX_INPUT_SIZE);
            }
            other => panic!("wrong error: {other:?}"),
        }
    }

    #[test]
    fn pipeline_rejects_bogus_bytes() {
        // Random bytes look like nothing we recognise → UnsupportedFormat.
        let bytes = vec![0x42u8; 512];
        let err = process_photo(PhotoInput {
            original_bytes: bytes,
            source_filename: "junk.bin".into(),
        })
        .expect_err("should reject");
        assert!(
            matches!(err, MediaError::UnsupportedFormat | MediaError::DecodeFailed(_)),
            "expected UnsupportedFormat or DecodeFailed, got {err:?}"
        );
    }

    #[test]
    fn pipeline_detect_hint_covers_all_formats() {
        // Direct unit test of the sniffer so a new format regression is
        // obvious even when the pipeline test is green.
        let jpeg = &[0xFFu8, 0xD8, 0xFF, 0xE0];
        assert_eq!(detect_hint(jpeg).unwrap(), FormatHint::Jpeg);

        let png = b"\x89PNG\r\n\x1A\n\x00\x00\x00\x00";
        assert_eq!(detect_hint(png).unwrap(), FormatHint::Png);

        let mut webp = Vec::from(&b"RIFF"[..]);
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(detect_hint(&webp).unwrap(), FormatHint::Webp);

        let mut avif = Vec::from(&[0u8, 0, 0, 0x20][..]);
        avif.extend_from_slice(b"ftypavif");
        assert_eq!(detect_hint(&avif).unwrap(), FormatHint::Avif);

        assert!(matches!(
            detect_hint(&[0x42u8; 32]),
            Err(MediaError::UnsupportedFormat)
        ));
    }
}
