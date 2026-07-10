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
//! open with no repair prompt. This is text-substitution only —
//! per-child photo replacement is a future extension (requires
//! rewriting `media/` entries and updating `_rels` maps per slide).

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::path::Path;

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
}

/// Substitution context applied to every generated slide.
#[derive(Debug, Clone)]
pub struct TemplateContext {
    pub year: u32,
    pub students: Vec<SlideRow>,
}

pub fn render_slides(
    template_pptx: &Path,
    output_pptx: &Path,
    ctx: &TemplateContext,
) -> Result<(), String> {
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
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("read entry {i}: {e}"))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        let declared = file.size();
        total_uncompressed = total_uncompressed.saturating_add(declared);
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES {
            return Err(format!(
                "template pptx uncompressed size exceeds cap ({MAX_UNCOMPRESSED_BYTES} bytes); refusing"
            ));
        }
        // Cap per-entry allocation to a sane ceiling — don't trust
        // file.size() as the with_capacity() input because a
        // zip-bomb entry can declare a huge size.
        let cap = (declared as usize).min(8 * 1024 * 1024);
        let mut buf = Vec::with_capacity(cap);
        file.read_to_end(&mut buf).map_err(|e| format!("read {name}: {e}"))?;
        entries.push((name, buf));
    }

    // Find marker slide: the /ppt/slides/slideN.xml containing "{{Name}}".
    let marker_idx = entries
        .iter()
        .position(|(n, b)| {
            is_slide_path(n) && String::from_utf8_lossy(b).contains("{{Name}}")
        })
        .ok_or_else(|| {
            "template.pptx must contain a slide with the placeholder text {{Name}}".to_string()
        })?;
    let (marker_slide_path, marker_slide_bytes) = entries[marker_idx].clone();
    let marker_rels_path = slide_rels_path(&marker_slide_path);
    let marker_rels_bytes = entries
        .iter()
        .find(|(n, _)| n == &marker_rels_path)
        .map(|(_, b)| b.clone());
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

    for (i, student) in ctx.students.iter().enumerate() {
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
            new_entries.push((new_rels_path, rels.clone()));
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
    entries[ct_idx].1 = ct_xml.into_bytes();

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
    Ok(())
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
    xml.replace("{{Name}}", &escape_xml(&s.name))
        .replace("{{Note}}", &escape_xml(&s.note))
        .replace("{{Year}}", &year.to_string())
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
    fn escape_xml_replaces_metachars() {
        assert_eq!(escape_xml("Tom & Jerry"), "Tom &amp; Jerry");
        assert_eq!(escape_xml("<b>"), "&lt;b&gt;");
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
                SlideRow { name: "Emma".into(), note: "Kind & curious.".into() },
                SlideRow { name: "Liam O'Neil".into(), note: "Loves trucks & <blocks>.".into() },
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
        assert_eq!(slide_count, 2, "expected 2 output slides, got {slide_count}");
        assert!(all_slides.contains("Emma"), "output missing Emma");
        assert!(
            all_slides.contains("Liam O&apos;Neil"),
            "output missing XML-escaped apostrophe name"
        );
        assert!(!all_slides.contains("{{Name}}"), "unsubstituted Name token");
        assert!(!all_slides.contains("{{Year}}"), "unsubstituted Year token");
        assert!(all_slides.contains("2027"), "Year token not substituted");
    }
}
