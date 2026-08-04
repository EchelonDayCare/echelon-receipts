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
//! libreoffice.org, ~350 MB one-time) and invoke `soffice --headless
//! --convert-to png` once per slide.
//!
//! ## Why we don't use `PageRange`
//!
//! LibreOffice's `impress_png_Export` filter accepts a `PageRange`
//! filter option in theory, but in practice the option is silently
//! ignored across every LO version we tested — every invocation ends
//! up exporting slide 1 no matter what page range is passed. Rather
//! than fight that, we **rewrite the deck's `sldIdLst`** to contain
//! exactly the target slide before each soffice call. LibreOffice
//! always exports slide 1 of what it's handed; if the only entry in
//! `sldIdLst` is slide N of the original deck, "slide 1" IS slide N.
//! Every soffice invocation gets a purpose-built single-slide temp
//! pptx and the resulting PNG is renamed into place.
//!
//! LibreOffice's PowerPoint renderer matches PowerPoint's output for
//! all the shape / text / picture features graduation templates use.
//! Fidelity to the actual `.pptx` (fonts, backgrounds, positioning)
//! is preserved because we're literally handing LibreOffice the same
//! file that PowerPoint / Keynote would open, just with one slide
//! isolated in the presentation part.
//!
//! # Trade-offs
//!
//! - One soffice startup per slide (~1-2s on a modern Mac; 30 kids
//!   ≈ 45 seconds end-to-end). Acceptable for a manual "export" click.
//! - JPEG output is achieved by decoding the PNG that LibreOffice
//!   emits and re-encoding via the `image` crate.
//! - If LibreOffice is missing we return a structured error the
//!   frontend surfaces as an "Install LibreOffice" callout instead of
//!   a mystery stack trace.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use image::{ImageEncoder, ImageReader};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

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

    // Slurp original pptx once — every per-slide temp file is a
    // rewrite of these bytes, so re-reading from disk N times would
    // be pointless I/O.
    let src_bytes = std::fs::read(pptx_path)
        .map_err(|e| format!("read {}: {e}", pptx_path.display()))?;
    let sld_ids = extract_sld_ids(&src_bytes)?;
    let slide_count = sld_ids.len();
    if slide_count == 0 {
        return Err("Deck has no slides to export".into());
    }

    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("mkdir {}: {e}", output_dir.display()))?;

    // v3.19.0 P2a — per-run tempdir instead of a fixed `.soffice-tmp`
    // inside the output folder. Two concurrent exports (e.g. two
    // grad batches on the same machine, or a re-click before the
    // first run finishes) used to `remove_dir_all` each other's
    // scratch. `tempfile::Builder::tempdir_in(output_dir)` gives us
    // a unique dir with automatic cleanup on drop (including error
    // paths and panics) — no manual sweep needed.
    //
    // v3.19.0 P2b — every `slide-NN.<ext>` is written into this
    // same tempdir first (as a staging area). We only touch
    // `output_dir` once, at the very end, after the whole deck has
    // rendered successfully. If soffice fails or the process is
    // killed mid-run, `output_dir` still holds the previous run's
    // images intact (staged files vanish with the tempdir). This
    // replaces the old pre-delete of `slide-*` which would empty
    // the folder before a run that then failed.
    let scratch_guard = tempfile::Builder::new()
        .prefix("soffice-")
        .tempdir_in(output_dir)
        .map_err(|e| format!("mkdir scratch in {}: {e}", output_dir.display()))?;
    let scratch = scratch_guard.path().to_path_buf();

    let mut warnings: Vec<String> = Vec::new();
    let mut written = 0usize;
    // Staged final outputs live in `scratch/staged/` so soffice's
    // temp `slice-N.png` outputs and our final `slide-NN.<ext>`
    // outputs don't collide inside the same directory.
    let staged_dir = scratch.join("staged");
    std::fs::create_dir_all(&staged_dir)
        .map_err(|e| format!("mkdir staged: {e}"))?;
    let mut staged_files: Vec<PathBuf> = Vec::new();

    let pad_width = digit_width(slide_count);

    for (i, sld_id_line) in sld_ids.iter().enumerate() {
        let slide_num = i + 1;
        // Build a temp pptx with only this slide listed in sldIdLst.
        // All other zip entries pass through verbatim so slideMasters,
        // theme, media, and the untouched slide XML files travel with
        // the temp file. LibreOffice renders whatever is in sldIdLst
        // as slide 1 → we get exactly this slide out.
        let temp_pptx = scratch.join(format!("slice-{slide_num}.pptx"));
        write_single_slide_pptx(&src_bytes, sld_id_line, &temp_pptx)
            .map_err(|e| format!("build single-slide pptx for slide {slide_num}: {e}"))?;

        let status = Command::new(&soffice)
            .arg("--headless")
            .arg("--norestore")
            .arg("--nologo")
            .arg("--nolockcheck")
            .arg("--convert-to")
            .arg("png")
            .arg("--outdir")
            .arg(&scratch)
            .arg(&temp_pptx)
            .status()
            .map_err(|e| format!("spawn soffice: {e}"))?;
        if !status.success() {
            return Err(format!(
                "soffice failed on slide {slide_num} (exit {:?}); source deck: {}",
                status.code(),
                pptx_path.display()
            ));
        }

        // soffice writes `<temp-stem>.png` — i.e. `slice-N.png` —
        // into the scratch dir. Move + rename to `slide-NN.<ext>`.
        let src_png = scratch.join(format!("slice-{slide_num}.png"));
        if !src_png.exists() {
            warnings.push(format!("soffice produced no output for slide {slide_num}"));
            // Sweep the temp pptx even on this soft-fail path.
            let _ = std::fs::remove_file(&temp_pptx);
            continue;
        }
        let dst = staged_dir.join(format!(
            "slide-{:0width$}.{ext}",
            slide_num,
            width = pad_width,
            ext = format.ext()
        ));
        match format {
            ImageFormat::Png => {
                std::fs::rename(&src_png, &dst)
                    .map_err(|e| format!("move {}: {e}", src_png.display()))?;
            }
            ImageFormat::Jpeg => {
                transcode_png_to_jpeg(&src_png, &dst)?;
                let _ = std::fs::remove_file(&src_png);
            }
        }
        staged_files.push(dst);
        // Clean the temp pptx immediately so scratch doesn't hold
        // 30× the deck size mid-run on a big grad batch.
        let _ = std::fs::remove_file(&temp_pptx);
        written += 1;
    }

    // v3.19.0 P2b — atomic-ish promote. All slides rendered
    // successfully; now sweep any stale `slide-*` from prior runs
    // in `output_dir` and rename the staged files into place. Any
    // failure above short-circuits with `?` and the tempdir cleans
    // itself up, leaving `output_dir` untouched.
    let removed = cleanup_slide_outputs(output_dir)
        .map_err(|e| format!("sweep stale slide-* in {}: {e}", output_dir.display()))?;
    if removed > 0 {
        warnings.push(format!(
            "Replaced {removed} slide image(s) from a previous export."
        ));
    }
    for staged in &staged_files {
        let final_path = output_dir.join(
            staged.file_name().expect("staged file always has a name"),
        );
        std::fs::rename(staged, &final_path)
            .map_err(|e| format!("promote {}: {e}", staged.display()))?;
    }

    // scratch_guard drops here → tempdir removed automatically.
    drop(scratch_guard);

    Ok(ExportSlideImagesReport {
        images_written: written,
        output_dir: output_dir.to_string_lossy().into_owned(),
        soffice_path: soffice.to_string_lossy().into_owned(),
        warnings,
    })
}

/// Sweep files matching `^slide-\d+\.(png|jpg|jpeg)$` (case-insensitive
/// extension) from `dir`. Returns the count of files removed. Used by
/// the atomic-promote path in `export_all`: we only sweep AFTER the
/// new deck has rendered successfully into a tempdir, so a failed
/// export can't leave the user with an empty output folder.
///
/// Non-slide files (owner's own PDFs, screenshots, `.DS_Store`) are
/// untouched — the anchored digits-then-known-extension match keeps
/// the sweep narrow.
fn cleanup_slide_outputs(dir: &Path) -> std::io::Result<usize> {
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut removed = 0usize;
    for entry in read {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_slide_output_name(name) {
            continue;
        }
        std::fs::remove_file(entry.path())?;
        removed += 1;
    }
    Ok(removed)
}

fn is_slide_output_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("slide-") else { return false };
    let dot = match rest.find('.') {
        Some(i) => i,
        None => return false,
    };
    let (digits, ext_with_dot) = rest.split_at(dot);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let ext = ext_with_dot.trim_start_matches('.').to_ascii_lowercase();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg")
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

/// Extract every `<p:sldId ... />` element from the deck's
/// `ppt/presentation.xml`, in document order. Each returned string is
/// the full self-closing tag verbatim (e.g.
/// `<p:sldId id="256" r:id="rId2"/>`) so it can be spliced back into a
/// rewritten `sldIdLst` untouched, preserving whatever `id` /
/// namespaced attributes the template author used.
fn extract_sld_ids(src_bytes: &[u8]) -> Result<Vec<String>, String> {
    let xml = read_zip_entry_as_string(src_bytes, "ppt/presentation.xml")?;
    let (lst_start, lst_end) = sld_id_lst_bounds(&xml).ok_or_else(|| {
        "ppt/presentation.xml is missing <p:sldIdLst>...</p:sldIdLst>".to_string()
    })?;
    let inner = &xml[lst_start..lst_end];
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = inner[cursor..].find("<p:sldId") {
        let start = cursor + rel;
        // Self-closing: find the "/>" that terminates this tag.
        let after = start + "<p:sldId".len();
        let Some(rel_close) = inner[after..].find("/>") else {
            break;
        };
        let end = after + rel_close + "/>".len();
        out.push(inner[start..end].to_string());
        cursor = end;
    }
    Ok(out)
}

/// Locate the byte range (inner content) of `<p:sldIdLst>` inside the
/// presentation part. Returns `(start_of_inner, end_of_inner)`.
fn sld_id_lst_bounds(xml: &str) -> Option<(usize, usize)> {
    let open = xml.find("<p:sldIdLst")?;
    // Skip over any attributes to the actual `>` that closes the
    // opening tag.
    let open_end = xml[open..].find('>')? + open + 1;
    let close = xml[open_end..].find("</p:sldIdLst>")? + open_end;
    Some((open_end, close))
}

/// Serialize a temp pptx containing every zip entry from `src_bytes`
/// verbatim, except `ppt/presentation.xml` which is rewritten so its
/// `<p:sldIdLst>` contains only `keep_sld_id_line`. LibreOffice always
/// renders "slide 1" of whatever it's handed — with only one entry in
/// the list, "slide 1" is the target slide.
fn write_single_slide_pptx(
    src_bytes: &[u8],
    keep_sld_id_line: &str,
    dest: &Path,
) -> Result<(), String> {
    let mut archive =
        ZipArchive::new(Cursor::new(src_bytes)).map_err(|e| format!("open src zip: {e}"))?;
    let out = std::fs::File::create(dest)
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut writer = ZipWriter::new(out);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("read src entry {i}: {e}"))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        let mut buf = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| format!("read {name}: {e}"))?;

        if name == "ppt/presentation.xml" {
            buf = rewrite_presentation_xml(&buf, keep_sld_id_line)
                .map_err(|e| format!("rewrite presentation.xml: {e}"))?;
        }

        let opts = if is_precompressed_media(&name) { stored } else { deflated };
        writer
            .start_file(&name, opts)
            .map_err(|e| format!("start_file {name}: {e}"))?;
        writer
            .write_all(&buf)
            .map_err(|e| format!("write {name}: {e}"))?;
    }
    writer.finish().map_err(|e| format!("finish zip: {e}"))?;
    Ok(())
}

/// Replace the entire body of `<p:sldIdLst>...</p:sldIdLst>` with the
/// single `<p:sldId .../>` element in `keep_line`. The rest of the
/// file is preserved byte-for-byte.
fn rewrite_presentation_xml(
    original: &[u8],
    keep_line: &str,
) -> Result<Vec<u8>, String> {
    let xml = std::str::from_utf8(original)
        .map_err(|e| format!("presentation.xml is not utf-8: {e}"))?;
    let (start, end) = sld_id_lst_bounds(xml)
        .ok_or_else(|| "presentation.xml is missing <p:sldIdLst>".to_string())?;
    let mut out = String::with_capacity(xml.len());
    out.push_str(&xml[..start]);
    out.push_str(keep_line);
    out.push_str(&xml[end..]);
    Ok(out.into_bytes())
}

fn read_zip_entry_as_string(src_bytes: &[u8], name: &str) -> Result<String, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(src_bytes)).map_err(|e| format!("open zip: {e}"))?;
    let mut file = archive
        .by_name(name)
        .map_err(|e| format!("read {name}: {e}"))?;
    let mut s = String::new();
    file.read_to_string(&mut s)
        .map_err(|e| format!("decode {name}: {e}"))?;
    Ok(s)
}

fn is_precompressed_media(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".mp4")
        || lower.ends_with(".webp")
        || lower.ends_with(".heic")
        || lower.ends_with(".heif")
        || lower.ends_with(".gif")
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
/// at quality 90 into `dst`.
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

    fn make_fake_pptx(dir: &Path, sld_ids: &[(u32, u32)]) -> PathBuf {
        let path = dir.join("fake.pptx");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("ppt/presentation.xml", opts).unwrap();
        let mut xml = String::from(
            r#"<?xml version="1.0"?><p:presentation xmlns:p="a" xmlns:r="b"><p:sldIdLst>"#,
        );
        for (id, rid) in sld_ids {
            xml.push_str(&format!(
                r#"<p:sldId id="{id}" r:id="rId{rid}"/>"#
            ));
        }
        xml.push_str("</p:sldIdLst></p:presentation>");
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn extract_sld_ids_preserves_verbatim_tags() {
        let dir = tempfile::tempdir().unwrap();
        let pptx = make_fake_pptx(dir.path(), &[(256, 2), (257, 3), (258, 4)]);
        let bytes = std::fs::read(&pptx).unwrap();
        let ids = extract_sld_ids(&bytes).unwrap();
        assert_eq!(ids.len(), 3);
        assert_eq!(ids[0], r#"<p:sldId id="256" r:id="rId2"/>"#);
        assert_eq!(ids[1], r#"<p:sldId id="257" r:id="rId3"/>"#);
        assert_eq!(ids[2], r#"<p:sldId id="258" r:id="rId4"/>"#);
    }

    #[test]
    fn extract_sld_ids_errors_when_lst_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.pptx");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("ppt/presentation.xml", opts).unwrap();
        zip.write_all(b"<p:presentation/>").unwrap();
        zip.finish().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(extract_sld_ids(&bytes).is_err());
    }

    #[test]
    fn rewrite_presentation_xml_replaces_only_sld_id_lst() {
        let original =
            br#"<p:presentation><p:sldSz cx="1"/><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:notesSz cx="2"/></p:presentation>"#;
        let out = rewrite_presentation_xml(
            original,
            r#"<p:sldId id="257" r:id="rId3"/>"#,
        )
        .unwrap();
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains(r#"<p:sldSz cx="1"/>"#));
        assert!(s.contains(r#"<p:notesSz cx="2"/>"#));
        assert!(s.contains(
            r#"<p:sldIdLst><p:sldId id="257" r:id="rId3"/></p:sldIdLst>"#
        ));
        assert!(!s.contains(r#"id="256""#));
    }

    #[test]
    fn write_single_slide_pptx_produces_readable_zip_with_one_sld_id() {
        let dir = tempfile::tempdir().unwrap();
        let src = make_fake_pptx(dir.path(), &[(256, 2), (257, 3), (258, 4)]);
        let src_bytes = std::fs::read(&src).unwrap();
        let dst = dir.path().join("slice.pptx");
        write_single_slide_pptx(
            &src_bytes,
            r#"<p:sldId id="257" r:id="rId3"/>"#,
            &dst,
        )
        .unwrap();
        let out_bytes = std::fs::read(&dst).unwrap();
        let mut zip = ZipArchive::new(Cursor::new(&out_bytes)).unwrap();
        let mut xml = String::new();
        zip.by_name("ppt/presentation.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains(r#"id="257""#));
        assert!(!xml.contains(r#"id="256""#));
        assert!(!xml.contains(r#"id="258""#));
    }

    #[test]
    fn transcode_png_to_jpeg_produces_valid_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let img = image::RgbImage::from_pixel(8, 8, image::Rgb([200, 30, 30]));
        let png_path = dir.path().join("in.png");
        img.save(&png_path).unwrap();
        let jpg_path = dir.path().join("out.jpg");
        transcode_png_to_jpeg(&png_path, &jpg_path).unwrap();
        let decoded = image::open(&jpg_path).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (8, 8));
    }

    // v3.19.0 P2b regression tests —————————————————————————————
    #[test]
    fn is_slide_output_name_accepts_known_shapes() {
        assert!(is_slide_output_name("slide-01.png"));
        assert!(is_slide_output_name("slide-99.jpg"));
        assert!(is_slide_output_name("slide-100.jpeg"));
        assert!(is_slide_output_name("slide-1.PNG"));
        assert!(is_slide_output_name("slide-007.JPG"));
    }

    #[test]
    fn is_slide_output_name_rejects_everything_else() {
        assert!(!is_slide_output_name("slide-.png"));
        assert!(!is_slide_output_name("slide-abc.png"));
        assert!(!is_slide_output_name("slide-01.gif"));
        assert!(!is_slide_output_name("slide-01"));
        assert!(!is_slide_output_name("slide-01.png.bak"));
        assert!(!is_slide_output_name("class-01.png"));
        assert!(!is_slide_output_name("MySlide-01.png"));
        assert!(!is_slide_output_name(".DS_Store"));
        assert!(!is_slide_output_name("random.txt"));
        // subfolders / paths shouldn't be considered — we only ever
        // pass DirEntry file names.
        assert!(!is_slide_output_name("sub/slide-01.png"));
    }

    #[test]
    fn cleanup_slide_outputs_removes_only_matching_files() {
        let dir = tempfile::tempdir().unwrap();
        // Seed with a mix of hits and non-hits.
        for name in [
            "slide-01.png",
            "slide-02.png",
            "slide-99.jpg",
            "slide-100.jpeg",
            "slide-1.PNG",
        ] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        for name in [
            "slide-.png",
            "slide-abc.png",
            "class-01.png",
            "random.txt",
            "notes.pdf",
            ".DS_Store",
        ] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        // Also seed a subdirectory that should be ignored entirely.
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("slide-01.png"), b"x").unwrap();

        let removed = cleanup_slide_outputs(dir.path()).unwrap();
        assert_eq!(removed, 5);

        // Survivors:
        for name in [
            "slide-.png",
            "slide-abc.png",
            "class-01.png",
            "random.txt",
            "notes.pdf",
            ".DS_Store",
        ] {
            assert!(
                dir.path().join(name).exists(),
                "expected non-slide file to survive: {name}"
            );
        }
        assert!(dir.path().join("sub").join("slide-01.png").exists());
    }

    #[test]
    fn cleanup_slide_outputs_handles_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert_eq!(cleanup_slide_outputs(&missing).unwrap(), 0);
    }
}
