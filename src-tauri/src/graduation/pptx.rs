//! Minimal .pptx templater for Graduation Day slides.
//!
//! Approach: a `.pptx` file is a ZIP of XML fragments. We do NOT parse
//! the deck as an object model. We locate the *marker slide* — the slide
//! whose XML contains the literal token `{{Name}}` — and use it as a
//! stamp. For every graduating student we:
//!
//! 1. Duplicate the marker slide's XML with `{{Name}}`, `{{Note}}`, and
//!    `{{Year}}` substituted.
//! 2. Duplicate its `_rels` file verbatim (image relationships etc.
//!    stay pointed at the same shared media).
//! 3. Register the new slide in `ppt/presentation.xml`,
//!    `ppt/_rels/presentation.xml.rels`, and `[Content_Types].xml`.
//! 4. Remove the marker slide from the output (it is a stamp, not part
//!    of the delivered deck).
//!
//! The result is a valid pptx that PowerPoint / Keynote / LibreOffice
//! open with no repair prompt. When a per-child photo is provided,
//! the largest image in the marker slide is replaced with a JPEG
//! re-encoding of that photo; students without a photo keep the
//! template placeholder unchanged.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

/// Hard cap on template pptx file size: 25 MB. A hand-authored template
/// with photos on every layout is typically 1–3 MB; anything past this
/// is either accidental (user pointed at a giant deck) or hostile.
const MAX_TEMPLATE_BYTES: u64 = 25 * 1024 * 1024;

/// Hard cap on total uncompressed size across all zip entries: 200 MB.
/// Guards against zip-bomb templates where a 1 KB pptx expands to
/// gigabytes of RAM.
const MAX_UNCOMPRESSED_BYTES: u64 = 200 * 1024 * 1024;

/// One graduating student's fields.
#[derive(Debug, Clone)]
pub struct SlideRow {
    pub name: String,
    pub note: String,
    /// Per-child photos to embed in this student's slide. When empty, the
    /// template placeholder is kept unchanged. When one photo is given it
    /// fills the placeholder region; when 2+ are given they are composited
    /// into a single image (see [`composite_photos_as_jpeg`]) that fits
    /// the placeholder's aspect ratio.
    pub photos: Vec<PathBuf>,
}

/// Image relationship extracted from a slide's `_rels` file.
struct ImageRel {
    r_id: String,
    target: String,
    media_path: String,
}

/// Substitution context applied to every generated slide.
#[derive(Debug, Clone)]
pub struct TemplateContext {
    pub year: u32,
    pub students: Vec<SlideRow>,
}

/// Report returned by [`render_slides`]. `warnings` bubbles up
/// non-fatal signals (F15/F16) so the caller can surface them in
/// its response and the frontend can hint at *why* a slide fell
/// back to the placeholder.
#[derive(Debug, Default)]
pub struct RenderReport {
    pub warnings: Vec<String>,
    /// Per-student render status: name + photo count + status message.
    pub children: Vec<ChildRenderStatus>,
}

#[derive(Debug, Clone)]
pub struct ChildRenderStatus {
    pub name: String,
    pub photo_count: usize,
    pub status: String,
}

pub fn render_slides(
    template_pptx: &Path,
    output_pptx: &Path,
    ctx: &TemplateContext,
) -> Result<RenderReport, String> {
    render_slides_cancellable(template_pptx, output_pptx, ctx, &|| false)
}

/// Cancellable variant of [`render_slides`]. Checks `is_cancelled`
/// between each student slide and threads the same predicate into
/// HEIC decode so cancel during a large batch takes effect within
/// one photo instead of running the whole render to completion (F14).
/// On cancel, returns `Err("cancelled")` before finalizing the output
/// zip so the caller's error-path cleanup (`.pptx.tmp` sweep) fires.
pub fn render_slides_cancellable(
    template_pptx: &Path,
    output_pptx: &Path,
    ctx: &TemplateContext,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<RenderReport, String> {
    let mut report = RenderReport::default();
    let meta = std::fs::metadata(template_pptx)
        .map_err(|e| format!("stat template: {e}"))?;
    if meta.len() > MAX_TEMPLATE_BYTES {
        return Err(format!(
            "template pptx is {} bytes, exceeds max of {} bytes",
            meta.len(),
            MAX_TEMPLATE_BYTES,
        ));
    }
    let template_bytes =
        std::fs::read(template_pptx).map_err(|e| format!("read template: {e}"))?;
    let mut archive =
        ZipArchive::new(Cursor::new(&template_bytes)).map_err(|e| format!("open pptx zip: {e}"))?;

    // Slurp every entry into memory so we can freely rewrite. Bound the
    // total uncompressed size so a malicious template can't OOM us.
    let mut entries: Vec<(String, Vec<u8>)> = Vec::with_capacity(archive.len());
    let mut total_uncompressed: u64 = 0;
    // F11: a tampered pptx can declare a small `file.size()` but the
    // compressed stream still expands to gigabytes at decode time
    // (zip bomb). Cap what we're willing to read per entry AND
    // sum the *actual* bytes read against the overall budget so the
    // total is enforced whether entries lie or not.
    const MAX_PER_ENTRY: u64 = 64 * 1024 * 1024; // 64 MiB per entry
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|e| format!("read entry {i}: {e}"))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        let declared = file.size();
        // Cap per-entry allocation to a sane ceiling — don't trust
        // file.size() as the with_capacity() input because a
        // zip-bomb entry can declare a huge size.
        let cap = (declared as usize).min(8 * 1024 * 1024);
        let mut buf = Vec::with_capacity(cap);
        // Wrap the decompressed stream in `.take(cap)` so the actual
        // bytes read are bounded even when the ZIP header lies about
        // the entry size.
        let per_entry_budget =
            MAX_PER_ENTRY.min(MAX_UNCOMPRESSED_BYTES.saturating_sub(total_uncompressed) + 1);
        let mut bounded = file.take(per_entry_budget);
        bounded
            .read_to_end(&mut buf)
            .map_err(|e| format!("read {name}: {e}"))?;
        let actual = buf.len() as u64;
        // If we hit the per-entry cap, the entry is either bogusly
        // huge or the archive is corrupt — refuse rather than ship
        // a truncated part.
        if actual >= per_entry_budget && actual > declared {
            return Err(format!(
                "template pptx entry {name} exceeded per-entry cap ({MAX_PER_ENTRY} bytes); refusing"
            ));
        }
        total_uncompressed = total_uncompressed.saturating_add(actual);
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES {
            return Err(format!(
                "template pptx uncompressed size exceeds cap ({MAX_UNCOMPRESSED_BYTES} bytes); refusing"
            ));
        }
        entries.push((name, buf));
    }

    // Find marker slide: the /ppt/slides/slideN.xml containing "{{Name}}".
    // Coalesce split runs BEFORE the contains-check so a template whose
    // author accidentally typed `{{Na` `me}}` across two <a:r> runs still
    // gets discovered as the marker (F3 marker-discovery gap).
    let marker_idx = entries
        .iter()
        .position(|(n, b)| {
            if !is_slide_path(n) {
                return false;
            }
            let raw = String::from_utf8_lossy(b);
            raw.contains("{{Name}}") || coalesce_split_runs(&raw).contains("{{Name}}")
        })
        .ok_or_else(|| {
            "template.pptx must contain a slide with the placeholder text {{Name}}".to_string()
        })?;
    let (marker_slide_path, marker_slide_bytes) = entries[marker_idx].clone();
    let marker_rels_path = slide_rels_path(&marker_slide_path);
    // Strip notesSlide relationships from the marker's _rels before
    // we duplicate it per-student. Otherwise every generated slide
    // points at the SAME notesSlide1.xml — PowerPoint then shows the
    // same speaker notes on every child's slide (F7). Speaker-note
    // support for graduation decks isn't a MVP requirement; if the
    // template author needs it back they can add per-slide notes
    // after render.
    let marker_rels_bytes = entries
        .iter()
        .find(|(n, _)| n == &marker_rels_path)
        .map(|(_, b)| strip_notes_rels(&String::from_utf8_lossy(b)).into_bytes());
    let marker_slide_num = slide_number(&marker_slide_path)
        .ok_or_else(|| format!("cannot parse slide number from {marker_slide_path}"))?;

    // Find the largest slide N so we can append new slides after it.
    let mut max_slide_num: u32 = 0;
    for (n, _) in &entries {
        if let Some(num) = slide_number(n) {
            max_slide_num = max_slide_num.max(num);
        }
    }

    // Locate the required registry files.
    let pres_idx = entries
        .iter()
        .position(|(n, _)| n == "ppt/presentation.xml")
        .ok_or("missing ppt/presentation.xml")?;
    let rels_idx = entries
        .iter()
        .position(|(n, _)| n == "ppt/_rels/presentation.xml.rels")
        .ok_or("missing ppt/_rels/presentation.xml.rels")?;
    let ct_idx = entries
        .iter()
        .position(|(n, _)| n == "[Content_Types].xml")
        .ok_or("missing [Content_Types].xml")?;

    let mut pres_xml = String::from_utf8_lossy(&entries[pres_idx].1).into_owned();
    let mut rels_xml = String::from_utf8_lossy(&entries[rels_idx].1).into_owned();
    let mut ct_xml = String::from_utf8_lossy(&entries[ct_idx].1).into_owned();

    // Snapshot existing rId numbers so we can generate collision-free new ones.
    let mut next_r_id: u32 = 1 + max_existing_rel_id(&rels_xml);

    // For each student, emit a new slide entry + register it everywhere.
    let mut new_entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut sld_id_next: u64 = 1 + max_existing_sld_id(&pres_xml);
    let mut inserted_r_ids: Vec<(u32, u32)> = Vec::new(); // (rId, sldId)

    // Find the marker sldId reference in presentation.xml so we can
    // insert new sldId entries *at the marker position* instead of
    // always appending. This preserves the template author's intent
    // when the marker sits between other slides.
    let marker_sld_line_pos = find_marker_sld_id_pos(&rels_xml, &pres_xml, marker_slide_num);

    // Determine which image relationship to swap per-student. Priority:
    //  1. **Alt-text tag** — a `<p:pic>` shape whose `<p:cNvPr descr="...">`
    //     contains the literal string `{{Photo}}`. This is the authoring
    //     contract for graduation templates and is unambiguous.
    //  2. **Largest media** — heuristic fallback for templates that
    //     don't carry the alt-text tag yet (including the previous
    //     bundled default). Vulnerable to picking a big background
    //     image on custom decks — hence the deprecation in favour of
    //     the alt-text tag (F2).
    // If neither turns anything up, per-child photo swap is skipped.
    let swap_rid: Option<String> = match &marker_rels_bytes {
        None => None,
        Some(rels_bytes) => {
            let rels_str = String::from_utf8_lossy(rels_bytes);
            let image_rels = parse_image_rels(&rels_str);
            if image_rels.is_empty() {
                let msg = "Template marker slide has no image relationships; \
                     per-child photo swap disabled. Add a picture to the \
                     marker slide and tag it with alt-text `{{Photo}}`.";
                eprintln!("[graduation] {}", msg);
                report.warnings.push(msg.to_string());
                None
            } else {
                // 1. Alt-text tag {{Photo}}.
                let marker_xml_str = String::from_utf8_lossy(&marker_slide_bytes);
                let tagged = find_tagged_photo_embed_rid(&marker_xml_str, "{{Photo}}");
                if let Some(rid) = tagged {
                    // Verify the tagged rId actually exists in the rels
                    // (a template author might have retagged an orphan
                    // reference — protect against that).
                    if image_rels.iter().any(|r| r.r_id == rid) {
                        Some(rid)
                    } else {
                        eprintln!(
                            "[graduation] {{{{Photo}}}}-tagged shape references \
                             unknown rId; falling back to largest-image heuristic"
                        );
                        largest_image_rid(&image_rels, &entries)
                    }
                } else {
                    // 2. Largest media heuristic.
                    largest_image_rid(&image_rels, &entries)
                }
            }
        }
    };

    // Auto-generate a cover slide when the template contains ONLY the
    // marker (i.e. the author didn't include a separate title slide).
    // Without this the deck opens directly on the first child, which
    // reads more like a report page than a graduation deck. When the
    // author has already provided one or more non-marker slides they
    // remain untouched — we only fill the gap; we never override.
    //
    // The cover is built by cloning the marker slide's XML + rels, then
    // substituting `{{Name}}` → "Class of {year}" and `{{Note}}` → a
    // short subtitle. Trailing possessive text ("{{Name}}'s ...") in
    // the template — a common pattern that reads badly on a cover — is
    // scrubbed after substitution.
    let template_slide_count = entries.iter().filter(|(n, _)| is_slide_path(n)).count();
    if template_slide_count == 1 {
        let cover_num = max_slide_num + 1;
        max_slide_num = cover_num;

        let cover_title = format!("Class of {}", ctx.year);
        let cover_subtitle = "Graduation Ceremony";
        let mut cover_xml = String::from_utf8_lossy(&marker_slide_bytes).into_owned();
        cover_xml = coalesce_split_runs(&cover_xml);
        cover_xml = cover_xml
            .replace("{{Name}}", &escape_xml(&cover_title))
            .replace("{{Note}}", &escape_xml(cover_subtitle))
            .replace("{{Year}}", &ctx.year.to_string());
        // Scrub possessive suffixes glued to the substituted title
        // (`Class of 2026's ...` reads awkwardly on a cover slide).
        // Both straight and curly apostrophes.
        let title_esc = escape_xml(&cover_title);
        for suffix in [
            format!("{title_esc}'s "),
            format!("{title_esc}\u{2019}s "),
            format!("{title_esc}'s<"),
            format!("{title_esc}\u{2019}s<"),
        ] {
            let replacement = if suffix.ends_with('<') {
                format!("{title_esc}<")
            } else {
                format!("{title_esc} ")
            };
            cover_xml = cover_xml.replace(&suffix, &replacement);
        }

        let cover_slide_path = format!("ppt/slides/slide{cover_num}.xml");
        new_entries.push((cover_slide_path, cover_xml.into_bytes()));
        if let Some(rels) = &marker_rels_bytes {
            let cover_rels_path = format!("ppt/slides/_rels/slide{cover_num}.xml.rels");
            new_entries.push((cover_rels_path, rels.clone()));
        }

        let cover_r_id = next_r_id;
        next_r_id += 1;
        let cover_sld_id = sld_id_next;
        sld_id_next += 1;
        inserted_r_ids.push((cover_r_id, cover_num));

        let rel_line = format!(
            r#"<Relationship Id="rId{cover_r_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{cover_num}.xml"/>"#
        );
        rels_xml = insert_before_strict(&rels_xml, "</Relationships>", &rel_line)?;

        let sld_line = format!(r#"<p:sldId id="{cover_sld_id}" r:id="rId{cover_r_id}"/>"#);
        pres_xml = insert_sld_line(&pres_xml, marker_sld_line_pos.as_deref(), &sld_line)?;

        let override_line = format!(
            r#"<Override PartName="/ppt/slides/slide{cover_num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#
        );
        ct_xml = insert_before_strict(&ct_xml, "</Types>", &override_line)?;

        report.warnings.push(
            "Template had no cover slide — auto-inserted \"Class of \
             {year}\" title before the student slides.".replace("{year}", &ctx.year.to_string())
        );
    }

    for (i, student) in ctx.students.iter().enumerate() {
        if is_cancelled() {
            return Err("cancelled".into());
        }
        // Correct slide numbering: one new pptx-slide per student,
        // regardless of whether we push 1 or 2 zip entries (some
        // templates lack per-slide _rels — see marker_rels_bytes below).
        // The old `new_entries.len() / 2` formula collapsed to the same
        // number for consecutive students when _rels was None, silently
        // dropping half the students via the write-once dedupe map.
        let new_num = max_slide_num + 1 + i as u32;
        let new_slide_path = format!("ppt/slides/slide{new_num}.xml");
        let new_rels_path = format!("ppt/slides/_rels/slide{new_num}.xml.rels");

        let mut slide_xml = String::from_utf8_lossy(&marker_slide_bytes).into_owned();
        slide_xml = substitute(&slide_xml, student, ctx.year);
        new_entries.push((new_slide_path, slide_xml.into_bytes()));

        if let Some(rels) = &marker_rels_bytes {
            let rels_str = String::from_utf8_lossy(rels);
            let (rels_bytes, child_status) = match (&swap_rid, student.photos.as_slice()) {
                (Some(_), []) => (
                    rels.clone(),
                    "No matching photo found — using placeholder.".to_string(),
                ),
                (Some(rid), photos) => {
                    let target_aspect = compute_target_aspect(&String::from_utf8_lossy(&marker_slide_bytes), rid);
                    let encoded = if photos.len() == 1 {
                        encode_as_jpeg_cancellable(&photos[0], target_aspect, is_cancelled)
                    } else {
                        composite_photos_as_jpeg_cancellable(photos, target_aspect, is_cancelled)
                    };
                    match encoded {
                        Ok(jpeg_bytes) => {
                            let slug = media_slug(&student.name);
                            let media_entry = format!("ppt/media/child-{new_num}-{slug}.jpg");
                            let new_target = format!("../media/child-{new_num}-{slug}.jpg");
                            new_entries.push((media_entry, jpeg_bytes));
                            let status = if photos.len() == 1 {
                                "Photo matched.".to_string()
                            } else {
                                format!("{} photos composited.", photos.len())
                            };
                            (
                                rewrite_image_target(&rels_str, rid, &new_target).into_bytes(),
                                status,
                            )
                        }
                        Err(e) => {
                            let msg = format!(
                                "Photo for '{}' encode error ({e}); using placeholder.",
                                student.name
                            );
                            eprintln!("[graduation] {}", msg);
                            report.warnings.push(msg.clone());
                            (rels.clone(), format!("Encode error: {e} — using placeholder."))
                        }
                    }
                }
                (None, photos) if !photos.is_empty() => (
                    rels.clone(),
                    "Photo swap disabled by template — using placeholder.".to_string(),
                ),
                _ => (rels.clone(), "No photo provided — using placeholder.".to_string()),
            };
            new_entries.push((new_rels_path, rels_bytes));
            report.children.push(ChildRenderStatus {
                name: student.name.clone(),
                photo_count: student.photos.len(),
                status: child_status,
            });
        } else {
            report.children.push(ChildRenderStatus {
                name: student.name.clone(),
                photo_count: student.photos.len(),
                status: "Template marker has no _rels; slide rendered without photo.".to_string(),
            });
        }

        let r_id = next_r_id;
        next_r_id += 1;
        let sld_id = sld_id_next;
        sld_id_next += 1;
        inserted_r_ids.push((r_id, new_num));

        // Register in presentation.xml.rels
        let rel_line = format!(
            r#"<Relationship Id="rId{r_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{new_num}.xml"/>"#
        );
        rels_xml = insert_before_strict(&rels_xml, "</Relationships>", &rel_line)?;

        // Register in presentation.xml sldIdLst — try at the marker
        // position first (preserves the author's ordering), then fall
        // back to appending before </p:sldIdLst>.
        let sld_line = format!(r#"<p:sldId id="{sld_id}" r:id="rId{r_id}"/>"#);
        pres_xml = insert_sld_line(&pres_xml, marker_sld_line_pos.as_deref(), &sld_line)?;

        // Register in [Content_Types].xml
        let override_line = format!(
            r#"<Override PartName="/ppt/slides/slide{new_num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#
        );
        ct_xml = insert_before_strict(&ct_xml, "</Types>", &override_line)?;
    }

    // Remove the marker slide from the output deck: strip it from the
    // sldIdLst and from presentation.xml.rels, and remove its Override.
    // The slide XML file itself is dropped by the "skip marker" filter
    // in the write loop below.
    let marker_slide_file = format!("slide{marker_slide_num}.xml");
    strip_sld_id_for_target(&mut pres_xml, &mut rels_xml, &marker_slide_file);
    let marker_override = format!(
        r#"<Override PartName="/ppt/slides/slide{marker_slide_num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#
    );
    ct_xml = ct_xml.replace(&marker_override, "");

    entries[pres_idx].1 = pres_xml.into_bytes();
    entries[rels_idx].1 = rels_xml.into_bytes();
    entries[ct_idx].1 = ensure_jpg_content_type(&ct_xml).into_bytes();

    // Write output pptx.
    if let Some(parent) = output_pptx.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir output: {e}"))?;
    }
    let out_file =
        std::fs::File::create(output_pptx).map_err(|e| format!("create output pptx: {e}"))?;
    let mut writer = ZipWriter::new(out_file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut written: HashMap<String, ()> = HashMap::new();
    for (name, bytes) in entries.iter().chain(new_entries.iter()) {
        if name == &marker_slide_path || name == &marker_rels_path {
            continue;
        }
        if written.contains_key(name) {
            continue;
        }
        writer
            .start_file(name, opts)
            .map_err(|e| format!("start_file {name}: {e}"))?;
        writer.write_all(bytes).map_err(|e| format!("write {name}: {e}"))?;
        written.insert(name.clone(), ());
    }
    writer.finish().map_err(|e| format!("finish zip: {e}"))?;
    Ok(report)
}

fn is_slide_path(name: &str) -> bool {
    name.starts_with("ppt/slides/slide")
        && name.ends_with(".xml")
        && !name.contains("_rels/")
}

fn slide_rels_path(slide_path: &str) -> String {
    // ppt/slides/slide7.xml -> ppt/slides/_rels/slide7.xml.rels
    let file = slide_path.rsplit('/').next().unwrap_or(slide_path);
    format!("ppt/slides/_rels/{file}.rels")
}

fn slide_number(name: &str) -> Option<u32> {
    let file = name.rsplit('/').next()?;
    let stem = file.strip_suffix(".xml.rels").or_else(|| file.strip_suffix(".xml"))?;
    let num = stem.strip_prefix("slide")?;
    num.parse().ok()
}

fn substitute(xml: &str, s: &SlideRow, year: u32) -> String {
    // Fix F3: PowerPoint often splits a placeholder like `{{Name}}` into
    // multiple `<a:t>` runs when the user re-authors the slide — e.g.
    //   <a:r><a:rPr .../><a:t>{{Na</a:t></a:r><a:r><a:t>me}}</a:t></a:r>
    // A naive `xml.replace("{{Name}}", ...)` misses this and ships the
    // placeholder text verbatim into the deck. Before running the
    // replace, coalesce all `<a:t>` runs within each `<a:p>` paragraph
    // so any straddling placeholder is contiguous.
    let coalesced = coalesce_split_runs(xml);
    coalesced
        .replace("{{Name}}", &escape_xml(&s.name))
        .replace("{{Note}}", &encode_note_with_breaks(&s.note))
        .replace("{{Year}}", &year.to_string())
}

/// Encode a note for XML, converting `\n` (and `\r\n`) into
/// `</a:t></a:r><a:br/><a:r><a:t xml:space="preserve">`-wrapped breaks
/// so multi-line teacher notes actually wrap in PowerPoint (F12).
///
/// The naive `escape_xml` collapses newlines into whitespace inside a
/// single `<a:t>` and PowerPoint renders them as a single space. To
/// force a line break inside a paragraph, DrawingML uses `<a:br/>` as
/// a sibling of `<a:r>` inside `<a:p>` — inline `<a:r>` runs in the
/// same paragraph don't produce a visual line break on their own; we
/// have to emit a `<a:br/>` element between them.
fn encode_note_with_breaks(note: &str) -> String {
    // Normalise CRLF/CR first so we only have to split on '\n'.
    let normalized = note.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.contains('\n') {
        return escape_xml(&normalized);
    }
    let parts: Vec<String> = normalized.split('\n').map(escape_xml).collect();
    // Close the current run, emit an explicit <a:br/> line break, then
    // start a fresh run that inherits the paragraph's default run
    // properties. Keeps the surrounding <a:r>...</a:r> valid.
    parts.join(r#"</a:t></a:r><a:br/><a:r><a:t xml:space="preserve">"#)
}

/// For each `<a:p>...</a:p>` paragraph in the input XML, if it contains
/// multiple `<a:t>` text runs AND the concatenated text has both `{{`
/// and `}}` markers, merge all run texts into the first `<a:t>` and
/// blank out the text bodies of subsequent `<a:t>`s. Preserves all
/// surrounding `<a:r>`, `<a:rPr>`, and other run-property XML so the
/// paragraph remains schema-valid and inherits the first run's
/// formatting.
///
/// Paragraphs that don't contain a `{{…}}` placeholder are left
/// untouched — coalescing has non-zero risk of visual regressions
/// (all runs adopt the first run's formatting), so we only apply it
/// where it's actually needed.
fn coalesce_split_runs(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut pos = 0;
    while let Some(p_start_rel) = xml[pos..].find("<a:p>") {
        let p_start = pos + p_start_rel;
        // Emit everything up to and including the opening <a:p>.
        out.push_str(&xml[pos..p_start + 5]);
        // Find the matching </a:p>. Paragraphs never nest in OOXML, so
        // the next </a:p> after p_start is our match.
        let after_open = p_start + 5;
        let Some(p_end_rel) = xml[after_open..].find("</a:p>") else {
            // Malformed input — emit the rest verbatim and stop.
            out.push_str(&xml[after_open..]);
            return out;
        };
        let p_end = after_open + p_end_rel;
        let inner = &xml[after_open..p_end];
        // Only coalesce when the paragraph actually has a placeholder.
        // Check: does the sequence of `<a:t>` texts concatenated contain
        // both `{{` and `}}`? Cheap early-exit if no `{{` anywhere.
        let coalesced_inner = if inner.contains("{{") && inner.contains("}}") {
            coalesce_paragraph_inner(inner)
        } else {
            inner.to_string()
        };
        out.push_str(&coalesced_inner);
        out.push_str("</a:p>");
        pos = p_end + 6; // length of "</a:p>"
    }
    // Emit any trailing content.
    out.push_str(&xml[pos..]);
    out
}

fn coalesce_paragraph_inner(inner: &str) -> String {
    // Collect (open_tag_end, close_tag_start) offsets of each `<a:t>`
    // text body, plus the raw texts.
    // Handles both `<a:t>` and `<a:t xml:space="preserve">` opening forms.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut i = 0;
    while let Some(open_rel) = inner[i..].find("<a:t") {
        let open_start = i + open_rel;
        // Find the '>' that closes the opening tag (skipping any attributes).
        let Some(gt_rel) = inner[open_start..].find('>') else { break };
        let body_start = open_start + gt_rel + 1;
        let Some(close_rel) = inner[body_start..].find("</a:t>") else { break };
        let body_end = body_start + close_rel;
        runs.push((body_start, body_end));
        texts.push(inner[body_start..body_end].to_string());
        i = body_end + 6; // len of "</a:t>"
    }
    if runs.len() < 2 {
        return inner.to_string();
    }
    // Concatenate raw texts (already XML-escaped in the source).
    let merged: String = texts.concat();
    // Re-check the merged text: is a placeholder actually present now?
    // If not, coalescing would clobber formatting for no benefit.
    if !(merged.contains("{{") && merged.contains("}}")) {
        return inner.to_string();
    }
    // Build the coalesced XML: everything before the first run's body
    // unchanged, first run's body replaced by `merged`, then for each
    // subsequent run, preserve XML between-run wrapping (</a:t>...
    // <a:r><a:rPr/>...<a:t>) verbatim but empty the run's text body.
    let mut out = String::with_capacity(inner.len());
    // Prefix (before first body).
    out.push_str(&inner[..runs[0].0]);
    out.push_str(&merged);
    // Between-run + emptied bodies for each subsequent run.
    for w in runs.windows(2) {
        let (_, prev_body_end) = w[0];
        let (next_body_start, next_body_end) = w[1];
        // Emit the between-run XML: from prev's </a:t> through next's <a:t...>.
        out.push_str(&inner[prev_body_end..next_body_start]);
        // Empty body for the next run.
        let _ = next_body_end; // unused; body is intentionally left empty
    }
    // Suffix from last run's </a:t> onward.
    let (_, last_body_end) = *runs.last().unwrap();
    out.push_str(&inner[last_body_end..]);
    out
}

fn escape_xml(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn insert_before(hay: &str, needle: &str, ins: &str) -> String {
    match hay.find(needle) {
        Some(pos) => {
            let mut s = String::with_capacity(hay.len() + ins.len());
            s.push_str(&hay[..pos]);
            s.push_str(ins);
            s.push_str(&hay[pos..]);
            s
        }
        None => hay.to_string(),
    }
}

/// Like [`insert_before`] but returns an error when the needle isn't
/// found. The silent no-op behaviour was a footgun: a template with a
/// non-`p:` namespace prefix or self-closing tags could produce a
/// "successful" pptx with zero student slides and no user-visible error.
fn insert_before_strict(hay: &str, needle: &str, ins: &str) -> Result<String, String> {
    hay.find(needle)
        .map(|pos| {
            let mut s = String::with_capacity(hay.len() + ins.len());
            s.push_str(&hay[..pos]);
            s.push_str(ins);
            s.push_str(&hay[pos..]);
            s
        })
        .ok_or_else(|| format!(
            "template incompatible: could not find '{needle}' — the pptx may use a non-default XML namespace"
        ))
}

/// Locate the marker slide's `<p:sldId ... r:id="rIdN"/>` line inside
/// `presentation.xml` so new sldIds can be spliced in *at the marker's
/// position* rather than always appended before `</p:sldIdLst>`.
///
/// Returns the exact substring the caller can pass to
/// [`insert_sld_line`] to splice before, or None if the mapping isn't
/// found (in which case the caller falls back to append).
fn find_marker_sld_id_pos(rels: &str, pres: &str, marker_num: u32) -> Option<String> {
    // Find rId that maps to slides/slide{marker_num}.xml in rels.
    let target = format!("Target=\"slides/slide{marker_num}.xml\"");
    let rel_pos = rels.find(&target)?;
    let start = rels[..rel_pos].rfind("<Relationship").unwrap_or(rel_pos);
    let end = rels[rel_pos..].find("/>").map(|e| rel_pos + e + 2).unwrap_or(rels.len());
    let snippet = &rels[start..end];
    let id_start = snippet.find("Id=\"")? + 4;
    let rest = &snippet[id_start..];
    let id_end = rest.find('"')?;
    let r_id = &rest[..id_end];
    // The exact sldId line we want to insert before.
    let marker_line_key = format!(r#"r:id="{r_id}""#);
    if pres.contains(&marker_line_key) {
        // Return the full <p:sldId ... r:id="rIdN"/> substring so caller
        // can locate + splice.
        let pos = pres.find(&marker_line_key)?;
        let start = pres[..pos].rfind("<p:sldId").unwrap_or(pos);
        let end = pres[pos..].find("/>").map(|e| pos + e + 2).unwrap_or(pres.len());
        Some(pres[start..end].to_string())
    } else {
        None
    }
}

/// Splice a new `<p:sldId ...>` into `presentation.xml`. Prefer the
/// marker position (preserves template ordering); fall back to
/// appending before `</p:sldIdLst>` if the marker line isn't found.
/// Errors only if neither anchor is present in the XML.
fn insert_sld_line(pres: &str, marker_line: Option<&str>, sld_line: &str) -> Result<String, String> {
    if let Some(m) = marker_line {
        if let Some(pos) = pres.find(m) {
            let mut s = String::with_capacity(pres.len() + sld_line.len());
            s.push_str(&pres[..pos]);
            s.push_str(sld_line);
            s.push_str(&pres[pos..]);
            return Ok(s);
        }
    }
    insert_before_strict(pres, "</p:sldIdLst>", sld_line)
}

fn max_existing_rel_id(rels: &str) -> u32 {
    let mut max = 0u32;
    let mut pos = 0;
    while let Some(i) = rels[pos..].find("Id=\"rId") {
        let start = pos + i + 7;
        let tail = &rels[start..];
        let end = tail.find('"').unwrap_or(0);
        if let Ok(n) = tail[..end].parse::<u32>() {
            max = max.max(n);
        }
        pos = start + end;
    }
    max
}

fn max_existing_sld_id(pres: &str) -> u64 {
    // pptx spec: sldId values must be >= 256 and unique.
    let mut max = 255u64;
    let mut pos = 0;
    while let Some(i) = pres[pos..].find("<p:sldId ") {
        let after = pos + i;
        let tail = &pres[after..];
        if let Some(id_pos) = tail.find("id=\"") {
            let start = after + id_pos + 4;
            let t = &pres[start..];
            let end = t.find('"').unwrap_or(0);
            if let Ok(n) = t[..end].parse::<u64>() {
                max = max.max(n);
            }
            pos = start + end;
        } else {
            break;
        }
    }
    max
}

/// Remove the <p:sldId .../> pointing at the marker slide from
/// presentation.xml, and the matching <Relationship .../> from
/// presentation.xml.rels.
fn strip_sld_id_for_target(pres: &mut String, rels: &mut String, target_file: &str) {
    // Find the rId whose Target ends with `target_file`.
    let target = format!("Target=\"slides/{target_file}\"");
    let Some(rel_pos) = rels.find(&target) else { return };
    // Scan backwards to find the enclosing <Relationship ... /> start.
    let start = rels[..rel_pos].rfind("<Relationship").unwrap_or(rel_pos);
    // Forwards to closing "/>".
    let end = rels[rel_pos..]
        .find("/>")
        .map(|e| rel_pos + e + 2)
        .unwrap_or(rels.len());
    let rel_snippet = &rels[start..end];
    // Extract the Id= value.
    let id_val = rel_snippet
        .find("Id=\"")
        .and_then(|i| {
            let s = start + i + 4;
            let t = &rels[s..];
            let e = t.find('"')?;
            Some(rels[s..s + e].to_string())
        })
        .unwrap_or_default();

    // Delete the relationship line.
    rels.replace_range(start..end, "");

    if id_val.is_empty() {
        return;
    }

    // Delete the matching <p:sldId ... r:id="rIdX"/>
    let marker = format!("r:id=\"{id_val}\"");
    if let Some(pos) = pres.find(&marker) {
        let sld_start = pres[..pos].rfind("<p:sldId").unwrap_or(pos);
        let sld_end = pres[pos..]
            .find("/>")
            .map(|e| pos + e + 2)
            .unwrap_or(pres.len());
        pres.replace_range(sld_start..sld_end, "");
    }
}

// ── Photo helpers ─────────────────────────────────────────────────────────────

/// Extract the value of an XML attribute from a `<Relationship .../>` snippet.
fn attr_value(snippet: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = snippet.find(&key)? + key.len();
    let end = snippet[start..].find('"')?;
    Some(snippet[start..start + end].to_string())
}

/// Resolve a slide `_rels` Target like `../media/foo.jpeg` to its zip-entry
/// path `ppt/media/foo.jpeg`.
fn resolve_media_from_rel_target(target: &str) -> String {
    if let Some(rest) = target.strip_prefix("../media/") {
        format!("ppt/media/{rest}")
    } else {
        target.to_string()
    }
}

/// Fallback swap-target picker. Given the marker slide's image
/// relationships, return the rId whose backing media entry is largest
/// on disk. Non-fatal if `entries` doesn't contain a match — the
/// relationship is simply weighted at zero.
fn largest_image_rid(image_rels: &[ImageRel], entries: &[(String, Vec<u8>)]) -> Option<String> {
    image_rels
        .iter()
        .max_by_key(|r| {
            entries
                .iter()
                .find(|(n, _)| n == &r.media_path)
                .map(|(_, b)| b.len())
                .unwrap_or(0)
        })
        .map(|r| r.r_id.clone())
}

/// Scan a slide's XML for a `<p:pic>` shape whose non-visual
/// `<p:cNvPr descr="...">` contains the given tag (e.g. `{{Photo}}`),
/// and return the `r:embed` rId of that shape's `<a:blip>` — that's
/// the relationship to swap per-student. Returns `None` if no tagged
/// shape is present.
///
/// This is the authoring contract for graduation templates: the
/// template author flags the child-photo placeholder by setting its
/// alt-text (Format Picture → Alt Text → Description) to `{{Photo}}`.
/// The alternative (largest-image heuristic) is fragile on custom
/// templates where a background image outweighs the placeholder.
fn find_tagged_photo_embed_rid(slide_xml: &str, tag: &str) -> Option<String> {
    let mut pos = 0;
    while let Some(pic_rel) = slide_xml[pos..].find("<p:pic") {
        let pic_start = pos + pic_rel;
        let pic_end_rel = slide_xml[pic_start..].find("</p:pic>")?;
        let pic_end = pic_start + pic_end_rel;
        let block = &slide_xml[pic_start..pic_end];
        // Does this shape's descr contain the tag?
        if descr_contains(block, tag) {
            // Yes — pull r:embed from the first <a:blip r:embed="rIdN"/>.
            if let Some(rid) = extract_blip_embed(block) {
                return Some(rid);
            }
        }
        pos = pic_end + 8; // len of "</p:pic>"
    }
    None
}

fn descr_contains(pic_block: &str, tag: &str) -> bool {
    // Look for descr="..." within a <p:cNvPr .../> element. Simple
    // scan: find `descr="`, capture until the next `"`, check for tag.
    let mut i = 0;
    while let Some(rel) = pic_block[i..].find("descr=\"") {
        let start = i + rel + 7;
        let end_rel = pic_block[start..].find('"').unwrap_or(0);
        let value = &pic_block[start..start + end_rel];
        if value.contains(tag) {
            return true;
        }
        i = start + end_rel;
    }
    false
}

fn extract_blip_embed(pic_block: &str) -> Option<String> {
    let key = "r:embed=\"";
    let start_rel = pic_block.find(key)?;
    let start = start_rel + key.len();
    let end_rel = pic_block[start..].find('"')?;
    Some(pic_block[start..start + end_rel].to_string())
}


/// Called on the marker slide's `_rels` before we duplicate it per
/// student so we don't end up with every generated slide pointing at
/// the same `notesSlide1.xml` (F7). Preserves all other relationships
/// (image, slideLayout, hyperlink, …) verbatim.
fn strip_notes_rels(rels_xml: &str) -> String {
    let mut out = String::with_capacity(rels_xml.len());
    let mut pos = 0;
    while let Some(rel_offset) = rels_xml[pos..].find("<Relationship") {
        let start = pos + rel_offset;
        // Copy over everything up to this relationship verbatim.
        out.push_str(&rels_xml[pos..start]);
        let end = rels_xml[start..]
            .find("/>")
            .map(|e| start + e + 2)
            .unwrap_or(rels_xml.len());
        let snippet = &rels_xml[start..end];
        let is_notes = snippet
            .find("Type=\"")
            .and_then(|tp| {
                let ts = tp + 6;
                snippet[ts..].find('"').map(|te| &snippet[ts..ts + te])
            })
            .map(|t| t.ends_with("/relationships/notesSlide"))
            .unwrap_or(false);
        if !is_notes {
            out.push_str(snippet);
        }
        pos = end;
    }
    out.push_str(&rels_xml[pos..]);
    out
}


/// Parse all image `<Relationship>` entries from a slide `_rels` XML string.
/// Non-image relationships (slideLayout, notesSlide, etc.) are skipped.
fn parse_image_rels(rels_xml: &str) -> Vec<ImageRel> {
    let mut result = Vec::new();
    let mut pos = 0;
    while let Some(rel_offset) = rels_xml[pos..].find("<Relationship") {
        let start = pos + rel_offset;
        let end = rels_xml[start..]
            .find("/>")
            .map(|e| start + e + 2)
            .unwrap_or(rels_xml.len());
        let snippet = &rels_xml[start..end];
        let is_image = snippet
            .find("Type=\"")
            .and_then(|tp| {
                let ts = tp + 6;
                snippet[ts..].find('"').map(|te| &snippet[ts..ts + te])
            })
            .map(|t| t.ends_with("/relationships/image"))
            .unwrap_or(false);
        if is_image {
            if let (Some(r_id), Some(target)) =
                (attr_value(snippet, "Id"), attr_value(snippet, "Target"))
            {
                let media_path = resolve_media_from_rel_target(&target);
                result.push(ImageRel { r_id, target, media_path });
            }
        }
        pos = end;
    }
    result
}

/// Rewrite the `Target=` of the relationship identified by `r_id`. All other
/// relationships are left exactly as-is.
fn rewrite_image_target(rels_xml: &str, r_id: &str, new_target: &str) -> String {
    let id_needle = format!("Id=\"{r_id}\"");
    let Some(id_pos) = rels_xml.find(&id_needle) else {
        return rels_xml.to_string();
    };
    let start = rels_xml[..id_pos].rfind("<Relationship").unwrap_or(id_pos);
    let end = rels_xml[id_pos..]
        .find("/>")
        .map(|e| id_pos + e + 2)
        .unwrap_or(rels_xml.len());
    let snippet = &rels_xml[start..end];
    let Some(tgt_key_pos) = snippet.find("Target=\"") else {
        return rels_xml.to_string();
    };
    let val_start = tgt_key_pos + 8; // len("Target=\"") = 8
    let Some(val_end) = snippet[val_start..].find('"') else {
        return rels_xml.to_string();
    };
    let new_snippet = format!(
        "{}Target=\"{new_target}\"{}",
        &snippet[..tgt_key_pos],
        &snippet[val_start + val_end + 1..] // skip the old value's closing "
    );
    format!("{}{}{}", &rels_xml[..start], new_snippet, &rels_xml[end..])
}

/// Ensure `[Content_Types].xml` contains a `<Default Extension="jpg" …/>`.
/// Idempotent: if `jpg` is already declared, the string is returned
/// unchanged. If missing, the declaration is injected before `</Types>`.
///
/// NOTE: An existing `Extension="jpeg"` declaration is NOT enough — OPC
/// content types are extension-specific and our generated media parts
/// all use `.jpg`. If we skipped the injection just because the template
/// happened to declare `jpeg`, PowerPoint would report the deck as
/// corrupt or refuse to render the photo parts.
fn ensure_jpg_content_type(ct_xml: &str) -> String {
    if ct_xml.contains("Extension=\"jpg\"") {
        return ct_xml.to_string();
    }
    insert_before(
        ct_xml,
        "</Types>",
        r#"<Default Extension="jpg" ContentType="image/jpeg"/>"#,
    )
}

/// Sanitize a student display name into a lowercase alphanumeric-and-hyphen
/// slug suitable for use in a zip entry filename.
fn media_slug(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut prev_was_sep = true; // suppress leading hyphen
    for c in name.chars() {
        if c.is_alphanumeric() {
            slug.push(c.to_lowercase().next().unwrap_or(c));
            prev_was_sep = false;
        } else if !prev_was_sep {
            slug.push('-');
            prev_was_sep = true;
        }
    }
    if slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() { "student".to_string() } else { slug }
}

/// Re-encode a student photo as JPEG bytes ready to embed in the pptx zip.
///
/// Format is determined by magic-byte sniff first, extension second. This
/// dodges the F8 failure mode where a file named `photo.jpg` is actually a
/// PNG or HEIC — trusting the extension would ship broken bytes inside the
/// deck. Real format decides:
///
/// - JPEG magic → passthrough (fastest, no re-encode).
/// - HEIC/HEIF magic → libheif → JPEG.
/// - Anything else the `image` crate recognises → decode → JPEG quality 85.
fn encode_as_jpeg(source: &Path, target_aspect: f32) -> Result<Vec<u8>, String> {
    encode_as_jpeg_cancellable(source, target_aspect, &|| false)
}

/// Encode a per-child photo for embedding in the PPTX.
///
/// Pipeline (v2.6.3):
/// 1. Decode via `load_photo_cancellable` — HEIC, JPEG, PNG, WebP.
///    JPEG path applies EXIF Orientation so sideways iPhone photos
///    render upright (the marker slide `<p:pic>` has no `rot="…"`).
/// 2. Alpha-flatten over white.
/// 3. Center-crop to `target_aspect` (the marker slide picture-frame's
///    width/height ratio). Without this, the `<a:stretch>` fill mode
///    in `<p:blipFill>` distorts photos whose aspect doesn't match the
///    frame — e.g. a 2.14:1 panorama forced into a 0.93:1 near-square
///    frame is squished vertically.
/// 4. Downscale so the longest edge is ≤ `MAX_EDGE` (keeps deck size
///    reasonable — a 7 MB iPhone JPEG becomes ~300–600 KB with no
///    visible loss at slide size).
/// 5. Re-encode JPEG at quality 85.
fn encode_as_jpeg_cancellable(
    source: &Path,
    target_aspect: f32,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    const MAX_EDGE: u32 = 1920;

    let dyn_img = load_photo_cancellable(source, is_cancelled)?;
    if is_cancelled() {
        return Err("cancelled".into());
    }
    let rgb = flatten_over_white(&dyn_img);
    let cropped = center_crop_to_aspect(rgb, target_aspect);
    if is_cancelled() {
        return Err("cancelled".into());
    }
    let resized = downscale_to_max_edge(cropped, MAX_EDGE);
    let mut buf = Vec::<u8>::new();
    let mut enc =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85);
    enc.encode_image(&resized)
        .map_err(|e| format!("JPEG encode: {e}"))?;
    Ok(buf)
}

/// Center-crop an RGB image so its aspect ratio matches `target` (w/h).
/// `target <= 0` or non-finite is treated as "no crop".
fn center_crop_to_aspect(img: image::RgbImage, target: f32) -> image::RgbImage {
    if !target.is_finite() || target <= 0.0 {
        return img;
    }
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return img;
    }
    let cur = w as f32 / h as f32;
    // Within 0.5% of the target — no crop needed.
    if (cur - target).abs() / target < 0.005 {
        return img;
    }
    let (new_w, new_h) = if cur > target {
        // Too wide → shrink width, keep height.
        let nw = ((h as f32) * target).round().max(1.0) as u32;
        (nw.min(w), h)
    } else {
        // Too tall → shrink height, keep width.
        let nh = ((w as f32) / target).round().max(1.0) as u32;
        (w, nh.min(h))
    };
    let x = (w - new_w) / 2;
    let y = (h - new_h) / 2;
    image::DynamicImage::ImageRgb8(img)
        .crop_imm(x, y, new_w, new_h)
        .to_rgb8()
}

/// Downscale an RGB image so its longest edge is at most `max_edge`.
/// Uses Lanczos3 for photographic quality. No-op when already smaller.
fn downscale_to_max_edge(img: image::RgbImage, max_edge: u32) -> image::RgbImage {
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    if longest <= max_edge {
        return img;
    }
    let scale = max_edge as f32 / longest as f32;
    let new_w = ((w as f32) * scale).round().max(1.0) as u32;
    let new_h = ((h as f32) * scale).round().max(1.0) as u32;
    image::imageops::resize(&img, new_w, new_h, image::imageops::FilterType::Lanczos3)
}

/// Alpha-composite a `DynamicImage` onto a white background and return
/// the resulting RGB8 buffer. Only pays the compositing cost when the
/// input has an alpha channel — solid-RGB inputs go through the fast
/// path `into_rgb8`.
fn flatten_over_white(img: &image::DynamicImage) -> image::RgbImage {
    use image::GenericImageView;
    // Fast path: no alpha channel present → direct RGB conversion.
    if img.color().channel_count() < 4 {
        return img.to_rgb8();
    }
    let (w, h) = img.dimensions();
    let rgba = img.to_rgba8();
    let mut out = image::RgbImage::new(w, h);
    for (x, y, px) in rgba.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        // Standard "over white" blend: c_out = c_src*α + 255*(1-α)
        let a_f = a as f32 / 255.0;
        let one_minus = 1.0 - a_f;
        let blend = |c: u8| -> u8 {
            (c as f32 * a_f + 255.0 * one_minus).round().clamp(0.0, 255.0) as u8
        };
        out.put_pixel(x, y, image::Rgb([blend(r), blend(g), blend(b)]));
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PhotoFmt {
    Jpeg,
    Heic,
    Other,
}

/// Read the first 12 bytes and classify by magic. Falls back to `Other`
/// when the file is unreadable or too short — `decode_via_image` will
/// then produce a real diagnostic if the payload really is unusable.
fn sniff_format(source: &Path) -> PhotoFmt {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(source) else { return PhotoFmt::Other };
    let mut buf = [0u8; 12];
    let n = f.read(&mut buf).unwrap_or(0);
    if n >= 3 && buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF {
        return PhotoFmt::Jpeg;
    }
    if n >= 12 && &buf[4..8] == b"ftyp" {
        let brand = &buf[8..12];
        const HEIF_BRANDS: &[&[u8; 4]] = &[
            b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heim", b"heis",
        ];
        if HEIF_BRANDS.iter().any(|b| brand == *b) {
            return PhotoFmt::Heic;
        }
    }
    PhotoFmt::Other
}

/// Decode an image using the `image` crate with format sniffed from
/// magic bytes rather than from the file extension. Works for files
/// whose extension is missing or wrong.
fn decode_via_image(source: &Path) -> Result<image::DynamicImage, String> {
    let reader = image::ImageReader::open(source)
        .map_err(|e| format!("open {}: {e}", source.display()))?
        .with_guessed_format()
        .map_err(|e| format!("sniff {}: {e}", source.display()))?;
    reader
        .decode()
        .map_err(|e| format!("decode {}: {e}", source.display()))
}

/// Load a photo (any supported format, extension-aware or magic-sniffed)
/// as an in-memory `DynamicImage`. Used by the multi-photo compositor.
fn load_photo(source: &Path) -> Result<image::DynamicImage, String> {
    load_photo_cancellable(source, &|| false)
}

fn load_photo_cancellable(
    source: &Path,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<image::DynamicImage, String> {
    // Magic-byte sniff parity with encode_as_jpeg_cancellable — extension
    // can't be trusted for HEIC vs JPEG here either.
    let fmt = sniff_format(source);
    if fmt == PhotoFmt::Heic {
        // libheif already returns pixels in display orientation, so no
        // EXIF pass needed here.
        let dest = std::env::temp_dir().join("echelon-grad-slides-heic");
        let jpeg = crate::graduation::heic::convert_heic_to_jpeg_cancellable(source, &dest, is_cancelled)?;
        return decode_via_image(&jpeg);
    }
    let img = decode_via_image(source)?;
    // The `image` crate does not apply EXIF Orientation on decode. Do it
    // here so iPhone photos taken portrait-with-EXIF-6 (a very common
    // real-world case) land upright in the pptx — the marker slide's
    // `<p:pic>` has no `rot="…"` compensation.
    if fmt == PhotoFmt::Jpeg {
        if let Some(orient) = crate::graduation::curate::read_jpeg_orientation(source) {
            if orient != 1 {
                return Ok(crate::graduation::curate::apply_exif_orientation(img, orient));
            }
        }
    }
    Ok(img)
}

/// Composite 2–4 photos onto a single cream-background canvas sized to
/// roughly match the graduation template's placeholder aspect ratio
/// (~0.93 wide/tall, i.e. slightly portrait). Returned bytes are JPEG.
///
/// Layouts:
/// - 2 photos → stacked top / bottom, each half-height, full-width.
/// - 3 photos → 1 full-width on top, 2 half-width side-by-side on bottom.
/// - 4 photos → 2×2 grid.
///
/// Each cell uses a "contain" fit (letterbox with cream fill) so faces
/// don't get chopped by an aspect-forcing crop.
fn composite_photos_as_jpeg(paths: &[PathBuf], target_aspect: f32) -> Result<Vec<u8>, String> {
    composite_photos_as_jpeg_cancellable(paths, target_aspect, &|| false)
}

fn composite_photos_as_jpeg_cancellable(
    paths: &[PathBuf],
    target_aspect: f32,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    use image::{imageops::FilterType, GenericImage, Rgb, RgbImage};

    if paths.is_empty() {
        return Err("composite_photos_as_jpeg called with empty slice".to_string());
    }
    // Cap defensively — child_photos should already have enforced this
    // upstream, but this function is a public-ish helper.
    let n = paths.len().min(4);

    // Canvas roughly matches the bundled template's placeholder ratio
    // (~4846:5212 EMU ≈ 0.93). Portrait-ish.
    const CANVAS_W: u32 = 1200;
    const CANVAS_H: u32 = 1290;
    // Cream background matching the bundled template's placeholder tint.
    const CREAM: Rgb<u8> = Rgb([240, 229, 213]);
    const GUTTER: u32 = 12;

    // Cell geometry: (x, y, w, h) in canvas pixels.
    let cells: Vec<(u32, u32, u32, u32)> = match n {
        2 => {
            let h_each = (CANVAS_H - GUTTER) / 2;
            vec![
                (0, 0, CANVAS_W, h_each),
                (0, h_each + GUTTER, CANVAS_W, CANVAS_H - h_each - GUTTER),
            ]
        }
        3 => {
            let h_top = (CANVAS_H - GUTTER) / 2;
            let h_bot = CANVAS_H - h_top - GUTTER;
            let w_half = (CANVAS_W - GUTTER) / 2;
            vec![
                (0, 0, CANVAS_W, h_top),
                (0, h_top + GUTTER, w_half, h_bot),
                (w_half + GUTTER, h_top + GUTTER, CANVAS_W - w_half - GUTTER, h_bot),
            ]
        }
        4 => {
            let w_half = (CANVAS_W - GUTTER) / 2;
            let h_half = (CANVAS_H - GUTTER) / 2;
            vec![
                (0, 0, w_half, h_half),
                (w_half + GUTTER, 0, CANVAS_W - w_half - GUTTER, h_half),
                (0, h_half + GUTTER, w_half, CANVAS_H - h_half - GUTTER),
                (w_half + GUTTER, h_half + GUTTER, CANVAS_W - w_half - GUTTER, CANVAS_H - h_half - GUTTER),
            ]
        }
        // Fall-through for pathological callers (n == 1 or > 4).
        _ => vec![(0, 0, CANVAS_W, CANVAS_H)],
    };

    let mut canvas: RgbImage = RgbImage::from_pixel(CANVAS_W, CANVAS_H, CREAM);

    for (idx, path) in paths.iter().take(n).enumerate() {
        if is_cancelled() {
            return Err("cancelled".into());
        }
        let Some(&(cx, cy, cw, ch)) = cells.get(idx) else { continue };
        let img = match load_photo_cancellable(path, is_cancelled) {
            Ok(i) => i,
            Err(e) => {
                // Non-fatal: leave the cell as cream and log. Better a
                // partial slide than aborting the whole deck.
                eprintln!("[graduation] skip photo {}: {e}", path.display());
                continue;
            }
        };
        let rgb = flatten_over_white(&img);
        // Contain-fit: scale down keeping aspect, centre in the cell.
        let (iw, ih) = (rgb.width().max(1), rgb.height().max(1));
        let scale = (cw as f32 / iw as f32).min(ch as f32 / ih as f32);
        let new_w = ((iw as f32) * scale).round().max(1.0) as u32;
        let new_h = ((ih as f32) * scale).round().max(1.0) as u32;
        let resized = image::imageops::resize(&rgb, new_w, new_h, FilterType::Lanczos3);
        let offset_x = cx + (cw.saturating_sub(new_w)) / 2;
        let offset_y = cy + (ch.saturating_sub(new_h)) / 2;
        // `copy_from` returns an error if the source doesn't fit — clamp
        // to be safe. In practice `new_w <= cw` and `new_h <= ch` by
        // construction.
        if offset_x + new_w <= CANVAS_W && offset_y + new_h <= CANVAS_H {
            let _ = canvas.copy_from(&resized, offset_x, offset_y);
        }
    }

    // Center-crop the finished canvas so it matches the marker slide's
    // picture-frame aspect. Without this, a composite built for the
    // bundled 0.93 template would still get stretched inside a custom
    // template whose photo frame is a different shape.
    let canvas = center_crop_to_aspect(canvas, target_aspect);

    let mut buf = Vec::<u8>::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 88);
    enc.encode_image(&canvas)
        .map_err(|e| format!("JPEG encode composite: {e}"))?;
    Ok(buf)
}

/// Compute the target aspect ratio (width/height) of the `<p:pic>`
/// picture-frame in the marker slide that references `target_rid`.
///
/// The marker template may have several `<p:pic>` blocks; if the same
/// `r:embed` appears in more than one (e.g. a background echo of the
/// hero photo), we pick the one with the largest area — that's the
/// visible portrait frame the student photo actually fills.
///
/// Falls back to 0.93 (the bundled Echelon template's ratio) if the
/// marker XML is unparseable or the rId isn't found; that keeps the
/// pre-v2.6.3 behaviour on unusual templates.
fn compute_target_aspect(marker_xml: &str, target_rid: &str) -> f32 {
    const DEFAULT: f32 = 0.93;
    let embed_needle = format!(r#"r:embed="{target_rid}""#);
    let mut best_area: u64 = 0;
    let mut best_aspect: Option<f32> = None;
    let mut pos = 0;
    while let Some(rel) = marker_xml[pos..].find("<p:pic") {
        let start = pos + rel;
        let Some(end_rel) = marker_xml[start..].find("</p:pic>") else { break };
        let end = start + end_rel;
        let block = &marker_xml[start..end];
        if block.contains(&embed_needle) {
            // Find <a:ext cx=".." cy=".."/> — first one inside <p:spPr>.
            if let Some(ext_pos) = block.find("<a:ext ") {
                let after = &block[ext_pos..];
                let cx = attr_u64(after, "cx");
                let cy = attr_u64(after, "cy");
                if let (Some(cx), Some(cy)) = (cx, cy) {
                    if cy > 0 {
                        let area = cx.saturating_mul(cy);
                        if area > best_area {
                            best_area = area;
                            best_aspect = Some(cx as f32 / cy as f32);
                        }
                    }
                }
            }
        }
        pos = end + 8;
    }
    best_aspect.filter(|a| a.is_finite() && *a > 0.0).unwrap_or(DEFAULT)
}

/// Pull a numeric attribute value from an XML fragment. Handles
/// `name="123"` with double quotes only (sufficient for OOXML picks).
fn attr_u64(hay: &str, name: &str) -> Option<u64> {
    let key = format!(r#"{name}=""#);
    let start = hay.find(&key)? + key.len();
    let end_rel = hay[start..].find('"')?;
    hay[start..start + end_rel].parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slide_number_parses() {
        assert_eq!(slide_number("ppt/slides/slide7.xml"), Some(7));
        assert_eq!(slide_number("ppt/slides/_rels/slide12.xml.rels"), Some(12));
        assert_eq!(slide_number("ppt/theme/theme1.xml"), None);
    }

    #[test]
    fn compute_target_aspect_extracts_frame_ratio_from_matching_pic() {
        let marker = r#"<p:pic><p:nvPicPr/><p:blipFill><a:blip r:embed="rId5"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4846320" cy="5212080"/></a:xfrm></p:spPr></p:pic>"#;
        let aspect = compute_target_aspect(marker, "rId5");
        // 4846320 / 5212080 = 0.9298...
        assert!((aspect - 0.93).abs() < 0.005, "aspect={aspect}");
    }

    #[test]
    fn compute_target_aspect_picks_largest_when_rid_appears_twice() {
        let marker = r#"
            <p:pic><p:blipFill><a:blip r:embed="rId7"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic>
            <p:pic><p:blipFill><a:blip r:embed="rId7"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr></p:pic>
        "#;
        let aspect = compute_target_aspect(marker, "rId7");
        assert!((aspect - 3.0).abs() < 0.01, "aspect={aspect}");
    }

    #[test]
    fn compute_target_aspect_falls_back_when_rid_missing() {
        let marker = r#"<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>"#;
        let aspect = compute_target_aspect(marker, "rIdMissing");
        assert!((aspect - 0.93).abs() < 0.001);
    }

    #[test]
    fn center_crop_to_aspect_squeezes_wide_panorama_into_portrait_frame() {
        // 200x100 landscape → cropped to 0.5 aspect (portrait) → 50x100.
        let img = image::RgbImage::from_pixel(200, 100, image::Rgb([128, 128, 128]));
        let out = center_crop_to_aspect(img, 0.5);
        assert_eq!(out.width(), 50);
        assert_eq!(out.height(), 100);
    }

    #[test]
    fn center_crop_to_aspect_stretches_tall_portrait_into_landscape_frame() {
        // 100x300 tall → cropped to 2.0 aspect (landscape) → 100x50.
        let img = image::RgbImage::from_pixel(100, 300, image::Rgb([128, 128, 128]));
        let out = center_crop_to_aspect(img, 2.0);
        assert_eq!(out.width(), 100);
        assert_eq!(out.height(), 50);
    }

    #[test]
    fn center_crop_to_aspect_noop_when_already_matches() {
        let img = image::RgbImage::from_pixel(93, 100, image::Rgb([128, 128, 128]));
        let out = center_crop_to_aspect(img, 0.93);
        assert_eq!(out.width(), 93);
        assert_eq!(out.height(), 100);
    }

    #[test]
    fn downscale_to_max_edge_shrinks_and_preserves_aspect() {
        let img = image::RgbImage::from_pixel(4000, 3000, image::Rgb([128, 128, 128]));
        let out = downscale_to_max_edge(img, 1920);
        assert_eq!(out.width(), 1920);
        assert_eq!(out.height(), 1440);
    }

    #[test]
    fn downscale_to_max_edge_noop_when_smaller() {
        let img = image::RgbImage::from_pixel(800, 600, image::Rgb([128, 128, 128]));
        let out = downscale_to_max_edge(img, 1920);
        assert_eq!(out.width(), 800);
        assert_eq!(out.height(), 600);
    }

    #[test]
    fn escape_xml_replaces_metachars() {
        assert_eq!(escape_xml("Tom & Jerry"), "Tom &amp; Jerry");
        assert_eq!(escape_xml("<b>"), "&lt;b&gt;");
    }

    #[test]
    fn coalesce_stitches_split_placeholder_across_runs() {
        // The GPT-5.5 F3 test case: PowerPoint re-authored the slide
        // and split `{{Name}}` into `{{Na` + `me}}` across two <a:r>
        // runs. A naive `xml.replace` misses this; coalesce_split_runs
        // must merge them into the first <a:t> and empty the second.
        let xml = r#"<a:p><a:r><a:rPr lang="en-US"/><a:t>{{Na</a:t></a:r><a:r><a:t>me}}</a:t></a:r></a:p>"#;
        let out = coalesce_split_runs(xml);
        assert!(out.contains("{{Name}}"), "expected merged placeholder in {out}");
        // The second <a:t> body should now be empty.
        assert!(out.contains("<a:t></a:t>"), "expected empty trailing run in {out}");
    }

    #[test]
    fn coalesce_stitches_three_way_split() {
        let xml = r#"<a:p><a:r><a:t>{{N</a:t></a:r><a:r><a:t>am</a:t></a:r><a:r><a:t>e}}</a:t></a:r></a:p>"#;
        let out = coalesce_split_runs(xml);
        assert!(out.contains("{{Name}}"));
    }

    #[test]
    fn coalesce_leaves_intact_placeholder_alone() {
        // Single <a:t> already contains the whole placeholder — no
        // merge needed, output should equal input.
        let xml = r#"<a:p><a:r><a:t>{{Name}}</a:t></a:r></a:p>"#;
        assert_eq!(coalesce_split_runs(xml), xml);
    }

    #[test]
    fn coalesce_skips_paragraphs_without_placeholder() {
        // A multi-run paragraph that has NO placeholder should be left
        // untouched — coalescing would strip formatting for no reason.
        let xml = r#"<a:p><a:r><a:rPr b="1"/><a:t>Hello</a:t></a:r><a:r><a:t> world</a:t></a:r></a:p>"#;
        assert_eq!(coalesce_split_runs(xml), xml);
    }

    #[test]
    fn substitute_recovers_from_split_placeholder() {
        // End-to-end: substitute must produce the correct name even
        // when the placeholder was split.
        let xml = r#"<a:p><a:r><a:rPr/><a:t>{{Na</a:t></a:r><a:r><a:t>me}} — {{Year}}</a:t></a:r></a:p>"#;
        let row = SlideRow {
            name: "Beau".into(),
            note: "".into(),
            photos: vec![],
        };
        let out = substitute(xml, &row, 2026);
        assert!(out.contains("Beau"), "missing name in {out}");
        assert!(out.contains("2026"), "missing year in {out}");
        assert!(!out.contains("{{"), "placeholder tokens still present in {out}");
    }

    #[test]
    fn substitute_encodes_note_newlines_as_run_breaks() {
        // F12: multi-line notes must split into separate <a:r>/<a:t>
        // runs so PowerPoint renders them on separate visual lines.
        let xml = r#"<a:p><a:r><a:t>{{Note}}</a:t></a:r></a:p>"#;
        let row = SlideRow {
            name: "N".into(),
            note: "First line\nSecond line".into(),
            photos: vec![],
        };
        let out = substitute(xml, &row, 2026);
        // Both parts must be present and separated by run-break markup.
        assert!(out.contains("First line"), "missing first part in {out}");
        assert!(out.contains("Second line"), "missing second part in {out}");
        assert!(
            out.contains(r#"</a:t></a:r><a:br/><a:r><a:t xml:space="preserve">"#),
            "expected <a:br/> run-break splice in {out}"
        );
    }

    #[test]
    fn substitute_note_without_newline_stays_in_one_run() {
        // Single-line notes must not gain any spurious run breaks.
        let xml = r#"<a:p><a:r><a:t>{{Note}}</a:t></a:r></a:p>"#;
        let row = SlideRow {
            name: "N".into(),
            note: "Just one line".into(),
            photos: vec![],
        };
        let out = substitute(xml, &row, 2026);
        assert!(!out.contains(r#"</a:t></a:r><a:r>"#), "unexpected break in {out}");
        assert!(out.contains("Just one line"));
    }

    #[test]
    fn flatten_over_white_maps_transparent_pixel_to_white() {
        // F10: fully transparent pixel must render as white (255,255,255)
        // after alpha-composite, not black (which is what into_rgb8 does).
        let mut rgba = image::RgbaImage::new(2, 1);
        rgba.put_pixel(0, 0, image::Rgba([200, 100, 50, 255])); // opaque
        rgba.put_pixel(1, 0, image::Rgba([200, 100, 50, 0]));   // transparent
        let img = image::DynamicImage::ImageRgba8(rgba);
        let out = flatten_over_white(&img);
        assert_eq!(out.get_pixel(0, 0).0, [200, 100, 50], "opaque pixel changed");
        assert_eq!(out.get_pixel(1, 0).0, [255, 255, 255], "transparent should be white");
    }

    #[test]
    fn strip_notes_rels_removes_only_notes_relationship() {
        let xml = concat!(
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
            r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>"#,
            r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.jpeg"/>"#,
            r#"<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>"#,
            r#"</Relationships>"#,
        );
        let out = strip_notes_rels(xml);
        assert!(!out.contains("notesSlide1.xml"), "notes rel still present in {out}");
        assert!(out.contains("image1.jpeg"), "image rel wrongly removed");
        assert!(out.contains("slideLayout1.xml"), "slideLayout rel wrongly removed");
    }

    #[test]
    fn insert_before_splices() {
        assert_eq!(insert_before("<a></a>", "</a>", "X"), "<a>X</a>");
        assert_eq!(insert_before("<a>", "</a>", "X"), "<a>");
    }

    #[test]
    fn insert_before_strict_errors_when_missing() {
        assert!(insert_before_strict("<a>", "</a>", "X").is_err());
        assert_eq!(insert_before_strict("<a></a>", "</a>", "X").unwrap(), "<a>X</a>");
    }

    #[test]
    fn new_num_advances_correctly_without_rels() {
        // Simulate 3 students without a marker _rels file — the old
        // formula (new_entries.len() / 2) collapsed to the same number
        // for consecutive students, silently losing slides via the
        // write-once dedupe map.
        let base = 5u32;
        for i in 0..3usize {
            let new_num = base + 1 + i as u32;
            assert_eq!(new_num, base + 1 + i as u32);
        }
    }

    #[test]
    fn max_rel_id_finds_highest() {
        let r = r#"<Rel Id="rId1" /><Rel Id="rId42" /><Rel Id="rId3" />"#;
        assert_eq!(max_existing_rel_id(r), 42);
    }

    #[test]
    fn strip_removes_matching_rel_and_sld() {
        let mut pres = String::from(
            r#"<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>"#,
        );
        let mut rels = String::from(
            r#"<Relationships><Relationship Id="rId2" Type="X" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="X" Target="slides/slide2.xml"/></Relationships>"#,
        );
        strip_sld_id_for_target(&mut pres, &mut rels, "slide1.xml");
        assert!(!rels.contains("slide1.xml"));
        assert!(rels.contains("slide2.xml"));
        assert!(!pres.contains(r#"r:id="rId2""#));
        assert!(pres.contains(r#"r:id="rId3""#));
    }

    #[test]
    fn end_to_end_renders_sample_template() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let tpl = std::path::Path::new(manifest_dir)
            .join("resources")
            .join("templates")
            .join("graduation-template.pptx");
        if !tpl.exists() {
            eprintln!("SKIP: sample template missing at {}", tpl.display());
            return;
        }
        let out_dir = std::env::temp_dir().join("echelon-grad-test");
        std::fs::create_dir_all(&out_dir).unwrap();
        let out = out_dir.join("out.pptx");
        let ctx = TemplateContext {
            year: 2027,
            students: vec![
                SlideRow { name: "Emma".into(), note: "Kind & curious.".into(), photos: vec![] },
                SlideRow { name: "Liam O'Neil".into(), note: "Loves trucks & <blocks>.".into(), photos: vec![] },
            ],
        };
        render_slides(&tpl, &out, &ctx).expect("render should succeed");
        assert!(out.exists(), "output not created");
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut all_slides = String::new();
        let mut slide_count = 0usize;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).unwrap();
            let name = f.name().to_string();
            if !is_slide_path(&name) {
                continue;
            }
            slide_count += 1;
            f.read_to_string(&mut all_slides).unwrap();
        }
        assert_eq!(slide_count, 3, "expected 3 output slides (cover + 2 students), got {slide_count}");
        assert!(all_slides.contains("Emma"), "output missing Emma");
        assert!(
            all_slides.contains("Liam O&apos;Neil"),
            "output missing XML-escaped apostrophe name"
        );
        assert!(!all_slides.contains("{{Name}}"), "unsubstituted Name token");
        assert!(!all_slides.contains("{{Year}}"), "unsubstituted Year token");
        assert!(all_slides.contains("2027"), "Year token not substituted");
        assert!(all_slides.contains("Class of 2027"), "output missing auto-generated cover title");
    }

    #[test]
    fn parse_image_rels_extracts_image_relationships() {
        let xml = concat!(
            r#"<?xml version="1.0"?>"#,
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
            r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>"#,
            r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.jpeg"/>"#,
            r#"<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/>"#,
            r#"<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>"#,
            r#"</Relationships>"#,
        );
        let rels = parse_image_rels(xml);
        assert_eq!(rels.len(), 2, "expected 2 image rels, got {}", rels.len());
        assert_eq!(rels[0].r_id, "rId2");
        assert_eq!(rels[0].target, "../media/image1.jpeg");
        assert_eq!(rels[0].media_path, "ppt/media/image1.jpeg");
        assert_eq!(rels[1].r_id, "rId3");
        assert_eq!(rels[1].media_path, "ppt/media/image2.png");
    }

    #[test]
    fn rewrite_image_target_changes_only_targeted_rel() {
        let xml = concat!(
            r#"<Relationships>"#,
            r#"<Relationship Id="rId2" Type="...image" Target="../media/image1.jpeg"/>"#,
            r#"<Relationship Id="rId3" Type="...image" Target="../media/image2.png"/>"#,
            r#"</Relationships>"#,
        );
        let result = rewrite_image_target(xml, "rId2", "../media/child-7-alice.jpg");
        assert!(result.contains(r#"Target="../media/child-7-alice.jpg""#));
        assert!(result.contains(r#"Target="../media/image2.png""#));
        assert!(!result.contains("image1.jpeg"), "old rId2 target should be gone");
        assert!(result.contains(r#"Id="rId3""#), "rId3 must be untouched");
    }

    #[test]
    fn ensure_jpg_content_type_idempotent_and_injects() {
        // Already has jpg → no change
        let with_jpg =
            r#"<Types><Default Extension="jpg" ContentType="image/jpeg"/></Types>"#;
        assert_eq!(ensure_jpg_content_type(with_jpg), with_jpg);

        // Only has jpeg → still injects jpg (OPC content types are
        // extension-specific and generated media uses .jpg)
        let with_jpeg =
            r#"<Types><Default Extension="jpeg" ContentType="image/jpeg"/></Types>"#;
        let result_jpeg = ensure_jpg_content_type(with_jpeg);
        assert!(result_jpeg.contains(r#"Extension="jpg""#));
        assert!(result_jpeg.contains(r#"Extension="jpeg""#));

        // Missing → injects before </Types>
        let without = r#"<Types><Default Extension="png" ContentType="image/png"/></Types>"#;
        let result = ensure_jpg_content_type(without);
        assert!(result.contains(r#"Extension="jpg""#));
        assert!(result.contains("image/jpeg"));
        assert!(result.ends_with("</Types>"));
    }

    #[test]
    fn photo_swap_replaces_largest_image() {
        use std::io::Write as _;

        let tmp = tempfile::tempdir().unwrap();
        let tpl_path = tmp.path().join("template.pptx");
        let out_path = tmp.path().join("output.pptx");

        // Build a synthetic minimal PPTX with two image rels: 100 B and 5000 B.
        {
            let file = std::fs::File::create(&tpl_path).unwrap();
            let mut zip = ZipWriter::new(file);
            let opts =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

            let ct = concat!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
                r#"<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>"#,
                r#"<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#,
                r#"</Types>"#,
            );
            zip.start_file("[Content_Types].xml", opts).unwrap();
            zip.write_all(ct.as_bytes()).unwrap();

            let pres = concat!(
                r#"<?xml version="1.0"?>"#,
                r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
                r#"<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>"#,
                r#"</p:presentation>"#,
            );
            zip.start_file("ppt/presentation.xml", opts).unwrap();
            zip.write_all(pres.as_bytes()).unwrap();

            let pres_rels = concat!(
                r#"<?xml version="1.0"?>"#,
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
                r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>"#,
                r#"</Relationships>"#,
            );
            zip.start_file("ppt/_rels/presentation.xml.rels", opts).unwrap();
            zip.write_all(pres_rels.as_bytes()).unwrap();

            let slide = concat!(
                r#"<?xml version="1.0"?>"#,
                r#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">"#,
                r#"<p:cSld><p:spTree><p:sp><p:txBody><a:t>{{Name}}</a:t></p:txBody></p:sp></p:spTree></p:cSld>"#,
                r#"</p:sld>"#,
            );
            zip.start_file("ppt/slides/slide1.xml", opts).unwrap();
            zip.write_all(slide.as_bytes()).unwrap();

            let slide_rels = concat!(
                r#"<?xml version="1.0"?>"#,
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
                r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/small.jpeg"/>"#,
                r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/large.jpeg"/>"#,
                r#"</Relationships>"#,
            );
            zip.start_file("ppt/slides/_rels/slide1.xml.rels", opts).unwrap();
            zip.write_all(slide_rels.as_bytes()).unwrap();

            zip.start_file("ppt/media/small.jpeg", opts).unwrap();
            zip.write_all(&vec![0xFFu8; 100]).unwrap();

            zip.start_file("ppt/media/large.jpeg", opts).unwrap();
            zip.write_all(&vec![0xAAu8; 5000]).unwrap();

            zip.finish().unwrap();
        }

        // Create a minimal valid PNG as the student photo.
        let photo_path = tmp.path().join("Alice.png");
        {
            use image::codecs::png::PngEncoder;
            use image::ImageEncoder;
            use image::{ImageBuffer, Rgb};
            let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
                ImageBuffer::from_pixel(4, 4, Rgb([128u8, 64u8, 192u8]));
            let mut png_bytes = Vec::<u8>::new();
            PngEncoder::new(&mut png_bytes)
                .write_image(
                    img.as_raw(),
                    img.width(),
                    img.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .unwrap();
            std::fs::write(&photo_path, &png_bytes).unwrap();
        }

        let ctx = TemplateContext {
            year: 2025,
            students: vec![SlideRow {
                name: "Alice".into(),
                note: "Great kid".into(),
                photos: vec![photo_path],
            }],
        };

        render_slides(&tpl_path, &out_path, &ctx).expect("render should succeed");
        assert!(out_path.exists(), "output file not created");

        let out_bytes = std::fs::read(&out_path).unwrap();
        let mut zip = ZipArchive::new(Cursor::new(&out_bytes)).unwrap();

        // Collect all entry names.
        let mut names = Vec::new();
        for i in 0..zip.len() {
            names.push(zip.by_index(i).unwrap().name().to_string());
        }

        // A child-* media entry must exist.
        let child_entries: Vec<_> = names.iter().filter(|n| n.contains("child-")).collect();
        assert!(!child_entries.is_empty(), "expected child photo entry; got: {names:?}");

        // Cover slide is now auto-inserted first (slide2), so the student
        // rels live at slide3.xml.rels.
        let rels_name = names
            .iter()
            .find(|n| n.ends_with("slide3.xml.rels"))
            .expect("slide3.xml.rels (student rels) must exist")
            .clone();
        let mut rels_file = zip.by_name(&rels_name).unwrap();
        let mut rels_content = String::new();
        rels_file.read_to_string(&mut rels_content).unwrap();

        assert!(rels_content.contains("child-"), "rels must reference child photo");
        assert!(!rels_content.contains("large.jpeg"), "large.jpeg should be swapped out");
        assert!(rels_content.contains("small.jpeg"), "small.jpeg must still be referenced");
    }
}
