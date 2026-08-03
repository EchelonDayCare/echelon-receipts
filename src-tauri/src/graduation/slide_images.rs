//! v3.17.0 — one-click "Export slides as images".
//!
//! Takes the rendered graduation deck (`Graduation-Slides-YEAR.pptx`)
//! and writes each slide out as `slide-01.png` / `.jpg` into a
//! dedicated `6-Slide-Images/` folder so owners can grab individual
//! images for the class WhatsApp group / parent handouts without
//! ever opening PowerPoint or Keynote.
//!
//! # Rasterisation strategy
//!
//! We do NOT bundle a PDF or PPTX renderer with the app. Instead we
//! require LibreOffice to be installed on the user's machine (free at
//! libreoffice.org, ~350 MB one-time) and invoke `soffice --headless`
//! once per slide with the standard `impress_png_Export` filter and a
//! `PageRange` filter option so each invocation writes exactly one
//! slide as PNG. Cross-platform, no compile-time deps.
//!
//! LibreOffice's PowerPoint renderer matches PowerPoint's output for
//! all the shape / text / picture features graduation templates use.
//! Fidelity to the actual `.pptx` (fonts, backgrounds, positioning)
//! is preserved because we're literally handing LibreOffice the same
//! file that PowerPoint / Keynote would open.
//!
//! # Trade-offs
//!
//! - One soffice startup per slide (~1-2s on a modern Mac; 30 kids
//!   ≈ 45 seconds end-to-end). We accept the overhead in exchange for
//!   zero pptx zip surgery.
//! - JPEG output is achieved by decoding the PNG that LibreOffice
//!   emits and re-encoding via the `image` crate; there is no
//!   built-in JPEG export filter equivalent in `soffice`.
//! - If LibreOffice is missing we return a structured error the
//!   frontend surfaces as an "Install LibreOffice" callout instead of
//!   a mystery stack trace.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::Command;

use image::{ImageEncoder, ImageReader};
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

/// Image format the user picks in the dropdown.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
}

impl ImageFormat {
    fn ext(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
        }
    }
}

/// Structured result for the frontend.
#[derive(Debug, Serialize)]
pub struct ExportSlideImagesReport {
    pub images_written: usize,
    pub output_dir: String,
    pub soffice_path: String,
    pub warnings: Vec<String>,
}

/// Public entry point. Renders every slide of `pptx_path` into
/// `output_dir` as `slide-01.<ext>`, `slide-02.<ext>`, ….
///
/// Errors bubble up as user-facing strings; every LibreOffice-missing
/// case returns a hint pointing at libreoffice.org.
pub fn export_all(
    pptx_path: &Path,
    output_dir: &Path,
    format: ImageFormat,
) -> Result<ExportSlideImagesReport, String> {
    let soffice = locate_soffice()
        .ok_or_else(|| {
            "LibreOffice is required to export slides as images. \
             Install the free download from https://www.libreoffice.org/download/ \
             (no license needed) then click Export again.".to_string()
        })?;

    let slide_count = count_slides(pptx_path)?;
    if slide_count == 0 {
        return Err("Deck has no slides to export".into());
    }

    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("mkdir {}: {e}", output_dir.display()))?;

    // soffice needs its own scratch dir so we can safely rename its
    // fixed-name output (`Graduation-Slides-2026.png`) into
    // `slide-NN.<ext>` without a race between invocations.
    let scratch = output_dir.join(".soffice-tmp");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("mkdir scratch: {e}"))?;

    let mut warnings: Vec<String> = Vec::new();
    let mut written = 0usize;

    // Padding width = ceil(log10(count+1)); keeps filenames
    // lexicographically sortable even for 100+ slide decks.
    let pad_width = digit_width(slide_count);

    for i in 1..=slide_count {
        // `impress_png_Export` supports a `PageRange` filter option; the
        // json is a UNO PropertyValue array. Value MUST be a string
        // ("1" not 1) — LibreOffice rejects integer types silently and
        // just exports slide 1 for every call.
        let filter = format!(
            "png:impress_png_Export:{{\"PageRange\":{{\"type\":\"string\",\"value\":\"{i}\"}}}}"
        );
        let status = Command::new(&soffice)
            .arg("--headless")
            .arg("--norestore")
            .arg("--nologo")
            .arg("--nolockcheck")
            .arg("--convert-to")
            .arg(&filter)
            .arg("--outdir")
            .arg(&scratch)
            .arg(pptx_path)
            .status()
            .map_err(|e| format!("spawn soffice: {e}"))?;
        if !status.success() {
            return Err(format!(
                "soffice failed on slide {i} (exit {:?}); pptx: {}",
                status.code(),
                pptx_path.display()
            ));
        }

        // soffice writes `<pptx-stem>.png` into the scratch dir every
        // time. Move + rename to `slide-NN.<ext>` (converting to
        // JPEG on the fly if that's what the user picked).
        let stem = pptx_path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "pptx path has no stem".to_string())?;
        let src = scratch.join(format!("{stem}.png"));
        if !src.exists() {
            warnings.push(format!("soffice produced no output for slide {i}"));
            continue;
        }
        let dst = output_dir.join(format!(
            "slide-{:0width$}.{ext}",
            i,
            width = pad_width,
            ext = format.ext()
        ));
        match format {
            ImageFormat::Png => {
                // Atomic rename inside the same folder — never fails
                // across filesystems here.
                std::fs::rename(&src, &dst)
                    .map_err(|e| format!("move {}: {e}", src.display()))?;
            }
            ImageFormat::Jpeg => {
                transcode_png_to_jpeg(&src, &dst)?;
                let _ = std::fs::remove_file(&src);
            }
        }
        written += 1;
    }

    let _ = std::fs::remove_dir_all(&scratch);

    Ok(ExportSlideImagesReport {
        images_written: written,
        output_dir: output_dir.to_string_lossy().into_owned(),
        soffice_path: soffice.to_string_lossy().into_owned(),
        warnings,
    })
}

fn digit_width(n: usize) -> usize {
    let mut w = 1;
    let mut v = n;
    while v >= 10 {
        w += 1;
        v /= 10;
    }
    w.max(2)
}

/// Count `<p:sldId ` occurrences in the deck's `ppt/presentation.xml`.
/// That's the authoritative slide count — the file-count of
/// `ppt/slides/slideN.xml` can be higher when a template leaves
/// orphan slides in the zip that aren't referenced by the sldIdLst.
fn count_slides(pptx_path: &Path) -> Result<usize, String> {
    let bytes = std::fs::read(pptx_path)
        .map_err(|e| format!("read {}: {e}", pptx_path.display()))?;
    let mut zip = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("open {}: {e}", pptx_path.display()))?;
    let mut file = zip
        .by_name("ppt/presentation.xml")
        .map_err(|e| format!("presentation.xml: {e}"))?;
    let mut xml = String::new();
    file.read_to_string(&mut xml)
        .map_err(|e| format!("read presentation.xml: {e}"))?;
    Ok(xml.matches("<p:sldId ").count())
}

/// Locate LibreOffice's `soffice` binary. Checks the standard install
/// locations on macOS and Windows first (fastest path), then falls
/// back to whatever `soffice` / `soffice.exe` resolves to on PATH.
fn locate_soffice() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mac_default = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");
        if mac_default.exists() {
            return Some(mac_default);
        }
    }
    #[cfg(target_os = "windows")]
    {
        for candidate in [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ] {
            let p = PathBuf::from(candidate);
            if p.exists() {
                return Some(p);
            }
        }
    }
    // PATH fallback — resolve via `where`/`which` so the returned
    // path is absolute (soffice sometimes misbehaves when spawned as
    // a bare name via std::process::Command on macOS bundles).
    let which_bin = if cfg!(target_os = "windows") { "where" } else { "which" };
    let exe = if cfg!(target_os = "windows") { "soffice.exe" } else { "soffice" };
    let out = Command::new(which_bin).arg(exe).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let first = stdout.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    let p = PathBuf::from(first);
    if p.exists() { Some(p) } else { None }
}

/// Decode `src` (a PNG written by LibreOffice) and re-encode as JPEG
/// at quality 90 into `dst`. Quality 90 keeps parent-facing JPEGs
/// visually indistinguishable from the source PNG while cutting file
/// size roughly 10× on photo-heavy graduation slides.
fn transcode_png_to_jpeg(src: &Path, dst: &Path) -> Result<(), String> {
    let img = ImageReader::open(src)
        .map_err(|e| format!("open {}: {e}", src.display()))?
        .with_guessed_format()
        .map_err(|e| format!("guess format {}: {e}", src.display()))?
        .decode()
        .map_err(|e| format!("decode {}: {e}", src.display()))?
        .to_rgb8();
    let out_file = std::fs::File::create(dst)
        .map_err(|e| format!("create {}: {e}", dst.display()))?;
    let writer = std::io::BufWriter::new(out_file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 90);
    encoder
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("encode jpeg: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    #[test]
    fn image_format_extensions() {
        assert_eq!(ImageFormat::Png.ext(), "png");
        assert_eq!(ImageFormat::Jpeg.ext(), "jpg");
    }

    #[test]
    fn digit_width_floors_at_two() {
        assert_eq!(digit_width(1), 2);
        assert_eq!(digit_width(9), 2);
        assert_eq!(digit_width(10), 2);
        assert_eq!(digit_width(99), 2);
        assert_eq!(digit_width(100), 3);
        assert_eq!(digit_width(999), 3);
        assert_eq!(digit_width(1000), 4);
    }

    fn make_fake_pptx(dir: &Path, sld_id_count: usize) -> PathBuf {
        let path = dir.join("fake.pptx");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("ppt/presentation.xml", opts).unwrap();
        let mut xml = String::from("<p:presentation><p:sldIdLst>");
        for i in 0..sld_id_count {
            xml.push_str(&format!(
                "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
                256 + i,
                i + 2
            ));
        }
        xml.push_str("</p:sldIdLst></p:presentation>");
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn count_slides_reads_sld_id_list() {
        let dir = tempfile::tempdir().unwrap();
        let pptx = make_fake_pptx(dir.path(), 7);
        assert_eq!(count_slides(&pptx).unwrap(), 7);
    }

    #[test]
    fn count_slides_rejects_missing_presentation_xml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.pptx");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.finish().unwrap();
        assert!(count_slides(&path).is_err());
    }

    #[test]
    fn transcode_png_to_jpeg_produces_valid_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        // 8x8 red PNG
        let img = image::RgbImage::from_pixel(8, 8, image::Rgb([200, 30, 30]));
        let png_path = dir.path().join("in.png");
        img.save(&png_path).unwrap();
        let jpg_path = dir.path().join("out.jpg");
        transcode_png_to_jpeg(&png_path, &jpg_path).unwrap();
        let decoded = image::open(&jpg_path).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (8, 8));
    }
}
