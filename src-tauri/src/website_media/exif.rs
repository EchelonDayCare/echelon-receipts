//! Surgical metadata stripping — EXIF, XMP, IPTC, and ICC — without
//! re-encoding the pixel data.
//!
//! For JPEG we walk the marker segments and drop everything in the
//! APP1..APP15 range (which covers EXIF, XMP, IPTC/Photoshop, and Adobe
//! ancillary data) while keeping APP0 (JFIF) so viewers that require it
//! don't choke. For PNG/WebP we ask `img-parts` to null out the EXIF and
//! ICC chunks. AVIF metadata is dropped naturally when the pipeline
//! re-encodes the image, so we pass it through here as-is.

use super::error::MediaError;
use img_parts::{Bytes, ImageEXIF, ImageICC};

/// Which container the input bytes are in. The pipeline sniffs this
/// itself but callers can also pass it explicitly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormatHint {
    Jpeg,
    Png,
    Webp,
    Avif,
}

/// Strip every metadata marker/chunk the container supports.
pub fn strip_metadata(bytes: &[u8], hint: FormatHint) -> Result<Vec<u8>, MediaError> {
    match hint {
        FormatHint::Jpeg => strip_jpeg(bytes),
        FormatHint::Png => strip_png(bytes),
        FormatHint::Webp => strip_webp(bytes),
        FormatHint::Avif => {
            // AVIF is always re-encoded by the pipeline, so any embedded
            // Exif/XMP box is lost on the next hop anyway. Pass-through.
            Ok(bytes.to_vec())
        }
    }
}

fn strip_jpeg(bytes: &[u8]) -> Result<Vec<u8>, MediaError> {
    use img_parts::jpeg::Jpeg;

    let mut jpeg = Jpeg::from_bytes(Bytes::copy_from_slice(bytes))
        .map_err(|e| MediaError::DecodeFailed(format!("jpeg parse: {e}")))?;

    // Belt-and-braces: clear the typed accessors AND filter markers.
    jpeg.set_exif(None);
    jpeg.set_icc_profile(None);

    // Drop APP1..APP15 (EXIF, XMP, IPTC/APP13, Adobe/APP14, etc.).
    // Keep APP0 (0xE0 / JFIF) — some legacy JPEG readers require it.
    jpeg.segments_mut()
        .retain(|s| !(0xE1..=0xEF).contains(&s.marker()));

    let mut out = Vec::with_capacity(bytes.len());
    jpeg.encoder()
        .write_to(&mut out)
        .map_err(|e| MediaError::EncodeFailed(format!("jpeg re-serialize: {e}")))?;
    Ok(out)
}

fn strip_png(bytes: &[u8]) -> Result<Vec<u8>, MediaError> {
    use img_parts::png::Png;

    let mut png = Png::from_bytes(Bytes::copy_from_slice(bytes))
        .map_err(|e| MediaError::DecodeFailed(format!("png parse: {e}")))?;
    png.set_exif(None);
    png.set_icc_profile(None);

    let mut out = Vec::with_capacity(bytes.len());
    png.encoder()
        .write_to(&mut out)
        .map_err(|e| MediaError::EncodeFailed(format!("png re-serialize: {e}")))?;
    Ok(out)
}

fn strip_webp(bytes: &[u8]) -> Result<Vec<u8>, MediaError> {
    use img_parts::webp::WebP;

    let mut webp = WebP::from_bytes(Bytes::copy_from_slice(bytes))
        .map_err(|e| MediaError::DecodeFailed(format!("webp parse: {e}")))?;
    webp.set_exif(None);
    webp.set_icc_profile(None);

    let mut out = Vec::with_capacity(bytes.len());
    webp.encoder()
        .write_to(&mut out)
        .map_err(|e| MediaError::EncodeFailed(format!("webp re-serialize: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, RgbImage};

    /// Encode a small solid-red RGB JPEG we can hang tests off of. Doing
    /// this in code keeps the fixture set free of binary blobs.
    fn make_solid_jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut img = RgbImage::new(w, h);
        for px in img.pixels_mut() {
            *px = image::Rgb([220, 40, 40]);
        }
        let mut buf = Vec::new();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90);
        enc.write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .expect("jpeg encode");
        buf
    }

    /// Inject a known EXIF blob and an APP13 (IPTC) segment so the strip
    /// test has something to actually strip.
    fn inject_exif_and_iptc(clean_jpeg: &[u8]) -> Vec<u8> {
        use img_parts::jpeg::{markers, Jpeg, JpegSegment};

        let mut jpeg = Jpeg::from_bytes(Bytes::copy_from_slice(clean_jpeg))
            .expect("parse fixture");
        // Minimal valid EXIF blob: "Exif\0\0" prefix is added by set_exif.
        // We construct a tiny TIFF header (little-endian, magic 0x2A, IFD offset 8, 0 entries, 0 next).
        let exif_tiff: &[u8] = &[
            b'I', b'I', 0x2A, 0x00, // TIFF LE, magic
            0x08, 0x00, 0x00, 0x00, // IFD offset
            0x00, 0x00,             // 0 entries
            0x00, 0x00, 0x00, 0x00, // next IFD = none
        ];
        jpeg.set_exif(Some(Bytes::copy_from_slice(exif_tiff)));

        // Also stick a fake APP13 (IPTC) marker in so we can prove APP13 is stripped too.
        let iptc_bytes = Bytes::from_static(b"Photoshop 3.0\x008BIM\x04\x04\x00\x00\x00\x00");
        let seg = JpegSegment::new_with_contents(markers::APP1 + 12, iptc_bytes);
        jpeg.segments_mut().insert(1, seg);

        let mut out = Vec::new();
        jpeg.encoder().write_to(&mut out).unwrap();
        out
    }

    /// Count all APP1..APP15 markers still present in a JPEG.
    fn count_metadata_markers(jpeg_bytes: &[u8]) -> usize {
        let jpeg = img_parts::jpeg::Jpeg::from_bytes(Bytes::copy_from_slice(jpeg_bytes))
            .expect("parse");
        jpeg.segments()
            .iter()
            .filter(|s| (0xE1..=0xEF).contains(&s.marker()))
            .count()
    }

    #[test]
    fn exif_strip_removes_all_markers_jpeg() {
        let clean = make_solid_jpeg(200, 150);
        let dirty = inject_exif_and_iptc(&clean);
        // Sanity: we actually injected metadata.
        assert!(
            count_metadata_markers(&dirty) >= 2,
            "test fixture setup didn't add metadata"
        );

        let stripped = strip_metadata(&dirty, FormatHint::Jpeg).expect("strip ok");
        assert_eq!(
            count_metadata_markers(&stripped),
            0,
            "APP1..APP15 markers should all be gone"
        );
    }

    #[test]
    fn exif_strip_preserves_image_bytes_semantically() {
        // Strip is meant to be surgical — the DCT-encoded image data must
        // decode to the same pixel buffer before and after.
        let clean = make_solid_jpeg(200, 150);
        let dirty = inject_exif_and_iptc(&clean);

        let pixels_before = image::load_from_memory(&dirty)
            .expect("decode dirty")
            .to_rgb8();
        let stripped = strip_metadata(&dirty, FormatHint::Jpeg).expect("strip ok");
        let pixels_after = image::load_from_memory(&stripped)
            .expect("decode stripped")
            .to_rgb8();

        assert_eq!(pixels_before.dimensions(), pixels_after.dimensions());
        assert_eq!(
            pixels_before.as_raw(),
            pixels_after.as_raw(),
            "pixel bytes changed — strip is not surgical"
        );
    }

    #[test]
    fn exif_strip_avif_passthrough() {
        // AVIF strip is a no-op at this stage; the pipeline re-encodes.
        let fake = vec![0x00, 0x00, 0x00, 0x20, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f'];
        let out = strip_metadata(&fake, FormatHint::Avif).unwrap();
        assert_eq!(out, fake);
    }
}
