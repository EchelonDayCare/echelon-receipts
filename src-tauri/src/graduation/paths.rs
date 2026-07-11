//! Path safety utilities for the Graduation Day pipeline.
//!
//! Two responsibilities:
//! 1. Sanitize student names and folder segments so they are valid on
//!    every platform we ship (Windows is the strict one).
//! 2. Wrap Windows long-path handling — writes to paths beyond ~260
//!    chars need the `\\?\` prefix, which requires an absolute path.
//! 3. Atomic file write: render to `<name>.tmp`, fsync, then rename.
//!    Falls back to a timestamped filename if the target is locked
//!    (e.g. Explorer preview holds a handle on Windows).

use std::path::{Path, PathBuf};

/// Characters banned in Windows filenames or that create ambiguity on
/// macOS Finder. Space, dot, and dash are allowed.
const BANNED: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\0'];

/// Windows reserved device names. Case-insensitive. If a sanitized
/// segment matches one of these, we prefix with `_` to make it a valid
/// filename.
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Sanitize an arbitrary user-supplied string (typically a student's
/// display name) into a filesystem-safe segment. Result is:
/// - never empty (fallback: "unnamed")
/// - never > 64 UTF-16 code units (Windows path budget)
/// - never a Windows reserved device name
/// - trimmed of leading/trailing whitespace and dots
pub fn sanitize_segment(input: &str) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| if BANNED.contains(&c) || c.is_control() { '-' } else { c })
        .collect();
    // Collapse runs of whitespace to a single space.
    let mut collapsed = String::with_capacity(cleaned.len());
    let mut prev_space = false;
    for c in cleaned.chars() {
        if c.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(c);
            prev_space = false;
        }
    }
    let trimmed = collapsed.trim().trim_matches('.').trim();
    let mut out = if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    };
    // Length cap using char count as a cheap UTF-16 proxy.
    if out.chars().count() > 64 {
        out = out.chars().take(64).collect();
    }
    let base_upper = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_RESERVED.iter().any(|r| *r == base_upper) {
        out = format!("_{out}");
    }
    out
}

/// Build a stable folder name for a student: `{id:04}-{sanitized_name}`.
/// The zero-padded id guarantees a consistent sort order even after
/// students are renamed.
pub fn student_folder_name(student_id: i64, display_name: &str) -> String {
    format!("{:04}-{}", student_id, sanitize_segment(display_name))
}

/// Atomically publish `tmp` at `final_dest`. Returns the actual path
/// written to — usually `final_dest`, but on Windows if the target is
/// locked (Explorer, an antivirus scan, or a video player) we fall back
/// to a timestamped sibling so the render is never lost.
///
/// Windows semantics: `std::fs::rename` refuses to overwrite. We use a
/// rename-through-backup pattern so if the second rename fails (target
/// locked) the previous final is still there — no data loss.
pub fn atomic_publish(tmp: &Path, final_dest: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        // Windows: rename doesn't atomically replace. Move any existing
        // final to a `.prev` sidecar first, promote tmp, then delete
        // the backup. If promotion fails we restore from backup.
        if final_dest.exists() {
            let backup = final_dest.with_extension(format!(
                "{}.prev",
                final_dest.extension().and_then(|s| s.to_str()).unwrap_or("bak")
            ));
            let _ = std::fs::remove_file(&backup);
            if let Err(e) = std::fs::rename(final_dest, &backup) {
                let hint = classify_publish_error(&e);
                return timestamped_fallback(
                    tmp,
                    final_dest,
                    &format!("existing file locked ({e}){hint}"),
                );
            }
            match std::fs::rename(tmp, final_dest) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&backup);
                    return Ok(final_dest.to_path_buf());
                }
                Err(e) => {
                    let hint = classify_publish_error(&e);
                    let _ = std::fs::rename(&backup, final_dest);
                    return timestamped_fallback(
                        tmp,
                        final_dest,
                        &format!("promote tmp failed ({e}){hint}"),
                    );
                }
            }
        }
        std::fs::rename(tmp, final_dest)
            .map(|_| final_dest.to_path_buf())
            .or_else(|e| {
                let hint = classify_publish_error(&e);
                timestamped_fallback(tmp, final_dest, &format!("rename failed ({e}){hint}"))
            })
    }
    #[cfg(not(windows))]
    {
        // Unix: rename replaces atomically. No dance needed.
        std::fs::rename(tmp, final_dest)
            .map(|_| final_dest.to_path_buf())
            .map_err(|e| format!("rename to {}: {e}", final_dest.display()))
    }
}

#[cfg(windows)]
fn timestamped_fallback(tmp: &Path, final_dest: &Path, reason: &str) -> Result<PathBuf, String> {
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let fallback = final_dest.with_file_name(format!(
        "{}-{ts}.{}",
        final_dest.file_stem().and_then(|s| s.to_str()).unwrap_or("render"),
        final_dest.extension().and_then(|s| s.to_str()).unwrap_or("mp4"),
    ));
    std::fs::rename(tmp, &fallback).map_err(|e2| {
        let hint = classify_publish_error(&e2);
        format!(
            "{reason}; fallback rename to {} also failed ({e2}){hint}",
            fallback.display()
        )
    })?;
    Ok(fallback)
}

/// Turn `std::io::Error` kinds we've seen on real Windows machines
/// into user-actionable hints appended to the error message. AV
/// scanners hold new-file handles for a few seconds after write, so
/// AccessDenied on rename is far more common than the base rate.
#[cfg(windows)]
fn classify_publish_error(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::PermissionDenied => {
            " — likely locked by antivirus or another program; retry in a few seconds or add the output folder to AV exclusions"
        }
        ErrorKind::AlreadyExists => {
            " — target file exists and appears locked (e.g. open in PowerPoint / Preview); close it and retry"
        }
        _ => "",
    }
}

/// The graduation cache directory: `{app_data}/graduation-cache/`.
/// Contains decoded HEIC JPEGs, thumbnails, and any transient
/// intermediates that survive a single render but not an app reinstall.
pub fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base.join("graduation-cache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir cache_dir: {e}"))?;
    Ok(dir)
}

/// Resolve the bundled default graduation music track. Used as a
/// fallback when the user doesn't supply one so every reel has audio
/// out of the box. Returns `Ok(None)` (not an error) if the bundled
/// asset is missing — the render will still succeed, just silent.
///
/// Resolution:
/// - `tauri dev`  → `<repo>/src-tauri/resources/music/default-graduation.m4a`
/// - packaged app → resource_dir/resources/music/default-graduation.m4a
///                  (Tauri v2 places bundled resources under this root)
pub fn default_music_track(app: &tauri::AppHandle) -> Option<PathBuf> {
    resolve_bundled_resource(app, "resources/music/default-graduation.m4a")
}

/// Resolve the bundled default graduation slide template. Same
/// semantics as [`default_music_track`].
pub fn default_slide_template(app: &tauri::AppHandle) -> Option<PathBuf> {
    resolve_bundled_resource(app, "resources/templates/graduation-template.pptx")
}

/// Common resolver for a bundled `resources/**` asset: tries the
/// packaged resource_dir first, then the dev source tree.
fn resolve_bundled_resource(app: &tauri::AppHandle, rel: &str) -> Option<PathBuf> {
    use tauri::Manager;
    let rel_path = std::path::Path::new(rel);
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join(rel_path);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel_path);
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// The set of folders that make up a scaffolded graduation year. Created
/// by [`scaffold_year`] and returned to the frontend so it doesn't have
/// to reconstruct paths from the base folder.
#[derive(Debug, serde::Serialize)]
pub struct GraduationLayout {
    pub root: PathBuf,
    pub reel_photos: PathBuf,
    pub kids_photos: PathBuf,
    pub music: PathBuf,
    pub template: PathBuf,
    pub output: PathBuf,
    pub child_folders: Vec<ChildFolder>,
    pub readme: PathBuf,
}

#[derive(Debug, serde::Serialize)]
pub struct ChildFolder {
    pub student_id: i64,
    pub display_name: String,
    pub folder: PathBuf,
}

/// Compute the folder layout for a graduation year without touching
/// the filesystem. `students` are the graduating students whose
/// per-child subfolders should be included.
pub fn layout(base: &Path, year: u32, students: &[(i64, String)]) -> GraduationLayout {
    let root = base.join(format!("Graduation-{year}"));
    let kids = root.join("2-Per-Child-Photos");
    let child_folders = students
        .iter()
        .map(|(id, name)| ChildFolder {
            student_id: *id,
            display_name: name.clone(),
            folder: kids.join(student_folder_name(*id, name)),
        })
        .collect();
    GraduationLayout {
        reel_photos: root.join("1-Year-Reel-Photos"),
        kids_photos: kids,
        music: root.join("3-Music-Optional"),
        template: root.join("4-Slide-Template-Optional"),
        output: root.join("5-Output"),
        readme: root.join("README.txt"),
        child_folders,
        root,
    }
}

/// Create the scaffold directory tree on disk. Idempotent — safe to run
/// again to add newly-added students. Writes a `README.txt` explaining
/// which folder gets what.
pub fn scaffold_year(base: &Path, year: u32, students: &[(i64, String)]) -> Result<GraduationLayout, String> {
    let layout = layout(base, year, students);
    for dir in [
        &layout.root,
        &layout.reel_photos,
        &layout.kids_photos,
        &layout.music,
        &layout.template,
        &layout.output,
    ] {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    for c in &layout.child_folders {
        std::fs::create_dir_all(&c.folder)
            .map_err(|e| format!("mkdir {}: {e}", c.folder.display()))?;
    }
    // README is auto-generated; overwrite on every scaffold so users
    // upgrading between app versions see current matcher rules and
    // format lists. Warn users in the file itself to keep personal
    // notes in NOTES.txt (which we never touch).
    {
        let names: Vec<String> = layout
            .child_folders
            .iter()
            .map(|c| format!("      {}", c.folder.file_name().and_then(|s| s.to_str()).unwrap_or("?")))
            .collect();
        let names_block = if names.is_empty() {
            "      (no graduating students marked yet — mark them in the app then re-scaffold)".to_string()
        } else {
            names.join("\n")
        };
        let content = format!(
r#"Graduation {year} — Folder Guide  (auto-generated; safe to overwrite)
=====================================================================
NOTE: this file is rewritten every time you re-scaffold. If you want
      to keep personal notes about this year's rendering, drop them
      into `NOTES.txt` in this folder — the app never touches that file.

Drop your files into the folders below, then come back to the app and
click "Render everything". Everything is optional except the reel
photos and per-child photos.

  1-Year-Reel-Photos/
      Drop ALL of this year's school photos here (one flat folder).
      The app curates the best ones and builds a 15-minute reel.

  2-Per-Child-Photos/
      One subfolder per graduating student. Drop 20-40 photos of that
      child into their folder. The app builds a 2-minute slideshow
      per child.

      *** Slide-deck photo(s) ***
      To show a child on their graduation slide, name their photo(s)
      to match one of these patterns (case-insensitive, spaces
      optional, extension .jpg / .jpeg / .png / .heic — or none if
      the extension was stripped by AirDrop / Finder):

          Beau.jpg                        (first name)
          Beau Seymour.jpg                (first + last)
          BeauSeymour.jpg                 (first + last, no space)
          Beau Andrew Seymour.jpg         (first + middle + last)
          BeauAndrewSeymour.jpg           (first + middle + last, no space)

      If MULTIPLE photos match, the app will place up to 4 of them
      on the slide (composited into a single image). Priority order
      when there are more than 4 matches: full-name > first+last >
      first-only, alphabetical within each tier.

      If NO name-matched photo exists, the slide uses the template's
      default silhouette placeholder.
{names_block}

  3-Music-Optional/
      Drop one or more audio files (mp3 / m4a / wav / flac) here.
      One track is picked at random per render — the app logs which
      one it used, so you can reproduce a specific render.

  4-Slide-Template-Optional/
      Drop ONE PowerPoint template (.pptx) here with a slide
      containing the tokens {{{{Name}}}}, {{{{Note}}}}, {{{{Year}}}}.
      Tag the picture placeholder shape with alt-text `{{{{Photo}}}}`
      so the app knows which image to swap out (otherwise it falls
      back to swapping whichever image is largest, which can pick
      the wrong shape on decks with big backgrounds).
      Leave the folder empty to use the app's bundled default template.

  5-Output/
      Rendered videos and the final .pptx deck are saved here.

Tips:
  • Photo formats supported: JPG, PNG, WebP, HEIC (iPhone). Extensionless
    files are recognised by their magic bytes.
  • You can re-scaffold at any time; existing folders and files are kept.
    Only new subfolders are added and this README is refreshed.
"#
        );
        std::fs::write(&layout.readme, content)
            .map_err(|e| format!("write README: {e}"))?;
    }
    Ok(layout)
}

/// Return all audio files inside `dir` (mp3/m4a/wav/flac/ogg/aac),
/// sorted alphabetically. Empty vec if the folder doesn't exist or is
/// empty. Callers can peek `.len()` to warn the user when they've
/// dropped multiple candidates.
pub fn list_audio_in(dir: &Path) -> Vec<PathBuf> {
    files_with_ext(dir, &["mp3", "m4a", "wav", "flac", "ogg", "aac"])
}

/// Pick one audio file at random from `dir`, or `None` if the folder
/// contains no audio. As of v2.4.1 the music folder is designed for
/// *multiple* tracks — each render picks a fresh song so back-to-back
/// reels don't feel identical. Uses `rand::thread_rng` so the choice
/// is process-lifetime random, not deterministic.
pub fn pick_random_audio_in(dir: &Path) -> Option<PathBuf> {
    use rand::seq::SliceRandom;
    let list = list_audio_in(dir);
    list.choose(&mut rand::thread_rng()).cloned()
}

/// Return the first `.pptx` inside `dir`, or `None`. Used to
/// auto-detect user-supplied templates.
pub fn first_pptx_in(dir: &Path) -> Option<PathBuf> {
    files_with_ext(dir, &["pptx"]).into_iter().next()
}

fn files_with_ext(dir: &Path, exts: &[&str]) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| exts.iter().any(|x| e.eq_ignore_ascii_case(x)))
                .unwrap_or(false)
        })
        .collect();
    candidates.sort();
    candidates
}

fn first_file_with_ext(dir: &Path, exts: &[&str]) -> Option<PathBuf> {
    files_with_ext(dir, exts).into_iter().next()
}

/// Prune stale entries from the HEIC cache. Deletes:
/// - files older than `max_age_days` since last-modified, OR
/// - oldest files first until the directory is under `max_bytes`.
///
/// Best-effort — errors on individual entries are logged into the
/// returned Vec but do not stop the sweep.
pub fn gc_cache(dir: &Path, max_age_days: u64, max_bytes: u64) -> Vec<String> {
    let mut warnings: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return warnings };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(max_age_days * 86_400));
    let mut kept: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() { continue }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let size = meta.len();
        if let Some(c) = cutoff {
            if mtime < c {
                if let Err(e) = std::fs::remove_file(&p) {
                    warnings.push(format!("gc remove {}: {e}", p.display()));
                }
                continue;
            }
        }
        kept.push((mtime, size, p));
    }
    let total: u64 = kept.iter().map(|(_, s, _)| *s).sum();
    if total > max_bytes {
        // Delete oldest-first until under cap.
        kept.sort_by_key(|(t, _, _)| *t);
        let mut over = total.saturating_sub(max_bytes);
        for (_, size, p) in kept {
            if over == 0 { break }
            match std::fs::remove_file(&p) {
                Ok(()) => over = over.saturating_sub(size),
                Err(e) => warnings.push(format!("gc remove {}: {e}", p.display())),
            }
        }
    }
    warnings
}

/// Maximum number of photos we'll composite onto a single graduation slide.
/// Past 4 the tiles get too small to make out faces (see 2x2 grid in
/// `pptx::composite_photos_as_jpeg`).
pub const MAX_PHOTOS_PER_SLIDE: usize = 4;

/// Find every photo in `child_folder` that matches the child named
/// `display_name`. Returns up to [`MAX_PHOTOS_PER_SLIDE`] matches
/// ordered by specificity (full-name > first+last > first-only) and
/// then alphabetically within each tier.
///
/// Match rules (case-insensitive, spaces optional):
/// - First name only — `Beau.jpg`
/// - First + last — `Beau Seymour.jpg`, `BeauSeymour.jpg`
/// - First + middle + last — `Beau Andrew Seymour.jpg`, `BeauAndrewSeymour.jpg`
///
/// The file must have a recognized photo extension (`jpg`, `jpeg`,
/// `png`, `heic`) OR — when the extension is missing or unrecognised —
/// its magic bytes must identify it as one of those formats. This
/// catches cases where AirDrop / Finder-hide-extension / a bad export
/// stripped the `.jpg` (real-world example: a file literally named
/// `Beau Seymour` with no visible extension).
///
/// Returns an empty `Vec` if the folder is missing, unreadable, or has
/// no matches.
pub fn child_photos(child_folder: &Path, display_name: &str) -> Vec<PathBuf> {
    let variants = name_variants(display_name);
    if variants.is_empty() {
        return Vec::new();
    }

    let Ok(entries) = std::fs::read_dir(child_folder) else {
        return Vec::new();
    };

    // Collect (tier, filename_lower, path). Lower tier = higher priority.
    let mut hits: Vec<(u8, String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_photo_file(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let norm = normalize(stem);
        if norm.is_empty() {
            continue;
        }
        let Some(tier) = variants
            .iter()
            .find(|(_, v)| v == &norm)
            .map(|(t, _)| *t)
        else {
            continue;
        };
        let fname_lower = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        hits.push((tier, fname_lower, path));
    }

    hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    hits.into_iter()
        .map(|(_, _, p)| p)
        .take(MAX_PHOTOS_PER_SLIDE)
        .collect()
}

/// Legacy single-match helper. Returns the highest-priority match,
/// preserved so callers that only want one photo don't have to
/// destructure a `Vec`.
pub fn child_photo(child_folder: &Path, display_name: &str) -> Option<PathBuf> {
    child_photos(child_folder, display_name).into_iter().next()
}

/// Normalise a name-like string for comparison: NFC-normalize, lowercase,
/// strip all whitespace. `"Beau Seymour"`, `"BeauSeymour"`, and
/// `"BEAU  SEYMOUR"` all collapse to `"beauseymour"`.
///
/// F7: NFC normalization is essential on macOS. HFS+/APFS store filenames
/// in NFD (decomposed), so `René.jpg` on disk is `R e ́ n e ́` (5 code points
/// with combining acute accents), while the display name coming from the
/// CSV / UI is typically NFC (`R é n é`, 4 precomposed code points). Byte
/// comparison of these fails silently. Normalizing BOTH sides to NFC
/// before comparison unifies the representation.
fn normalize(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfc()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Generate accepted (tier, normalized_variant) pairs for a display
/// name. Tier 0 wins over tier 1 wins over tier 2.
///
/// - Tier 0: full name (all tokens)
/// - Tier 1: first + last (only when 3+ tokens, else it collapses into tier 0)
/// - Tier 2: first-only
fn name_variants(display_name: &str) -> Vec<(u8, String)> {
    let tokens: Vec<String> = display_name
        .split_whitespace()
        .map(|s| normalize(s))
        .filter(|s| !s.is_empty())
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<(u8, String)> = Vec::new();
    // Tier 0: full name (all tokens concatenated).
    out.push((0, tokens.join("")));
    // Tier 1: first + last, only meaningful when there's a middle name.
    if tokens.len() >= 3 {
        out.push((1, format!("{}{}", tokens[0], tokens[tokens.len() - 1])));
    }
    // Tier 2: first name only. Suppress when it duplicates tier 0 (single-token names).
    if tokens.len() >= 2 {
        out.push((2, tokens[0].clone()));
    }
    // Deduplicate keeping the lowest tier (highest priority) per variant.
    out.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    out.dedup_by(|a, b| a.1 == b.1);
    out
}

/// Does this file look like a photo we can embed? Accepts:
/// - Any file with extension jpg/jpeg/png/heic (case-insensitive, fast path).
/// - Files with missing or unknown extensions whose first bytes match
///   a known image magic (JPEG, PNG, HEIC).
fn is_photo_file(path: &Path) -> bool {
    const KNOWN_EXTS: &[&str] = &["jpg", "jpeg", "png", "heic"];
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if KNOWN_EXTS.iter().any(|x| ext.eq_ignore_ascii_case(x)) {
            return true;
        }
    }
    // Fallback: sniff magic bytes. Only reads 12 bytes so it's cheap
    // even when a folder has hundreds of non-photo entries.
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut buf = [0u8; 12];
    use std::io::Read;
    let n = f.read(&mut buf).unwrap_or(0);
    if n < 4 {
        return false;
    }
    // JPEG: FF D8 FF
    if buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF {
        return true;
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if n >= 8 && &buf[0..8] == b"\x89PNG\r\n\x1a\n" {
        return true;
    }
    // HEIC/HEIF: ISO-BMFF `ftyp` box at offset 4. Brands we accept:
    // heic, heix, hevc, hevx, mif1, msf1, heim, heis.
    if n >= 12 && &buf[4..8] == b"ftyp" {
        let brand = &buf[8..12];
        const HEIF_BRANDS: &[&[u8; 4]] = &[
            b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heim", b"heis",
        ];
        if HEIF_BRANDS.iter().any(|b| brand == *b) {
            return true;
        }
    }
    false
}

/// Validate a user-supplied folder path used by graduation commands.
/// This is a lighter check than [`crate::path_guard::validate_existing_file`]
/// because the base folder is chosen by the user via a native picker and
/// may legitimately live on an external drive, Desktop, etc. — anywhere
/// the OS lets the app write. What we still enforce:
/// 1. Path exists and is a directory.
/// 2. Path is not a symlink (nor reached through one, via canonicalize).
/// 3. Path canonicalizes cleanly (rejects `..` traversal and non-UTF-8
///    edge cases).
///
/// Returns the canonicalized path so downstream `std::fs::*` calls
/// operate on a stable, resolved location.
pub fn validate_folder(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("empty folder path".to_string());
    }
    let p = Path::new(raw);
    // F16: reject any `..` traversal component and the leaf-being-a-symlink
    // case. Full-chain symlink rejection is unsafe on macOS where system
    // paths like `/tmp` and `/var` are themselves symlinks — walking every
    // ancestor with symlink_metadata would refuse to accept a user's own
    // /tmp/mypics pick. The residual attack surface (attacker-controlled
    // symlink INSIDE the user-picked folder) is defended at the scan-walker
    // layer: curate::scan_and_rank already skips symlinked entries during
    // directory traversal.
    reject_traversal_components(p)?;
    if std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("refusing to use a symlinked folder: {raw}"));
    }
    let canon = p
        .canonicalize()
        .map_err(|e| format!("resolve folder {raw}: {e}"))?;
    if !canon.is_dir() {
        return Err(format!("not a directory: {raw}"));
    }
    Ok(canon)
}

/// Reject `..` and `.` components anywhere in a user-supplied path.
/// `canonicalize()` resolves these silently, so an input like
/// `~/Documents/../../../etc/passwd` would slip past a leaf-only symlink
/// check. Empty and absolute-prefix components are fine.
fn reject_traversal_components(p: &Path) -> Result<(), String> {
    use std::path::Component;
    for c in p.components() {
        if matches!(c, Component::ParentDir) {
            return Err(format!(
                "refusing path containing '..' component: {}",
                p.display()
            ));
        }
    }
    Ok(())
}

/// Validate a folder used for output (writes). Canonicalizes the
/// parent chain if the folder itself doesn't yet exist — we allow
/// creating scaffolded subfolders under an existing user-picked base.
pub fn validate_writable_dir(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("empty folder path".to_string());
    }
    let p = Path::new(raw);
    reject_traversal_components(p)?;
    // If it exists, run the standard validation. Otherwise walk up to
    // the first existing ancestor and require that to be a real dir
    // (not a symlink) — the missing tail will be created by the caller.
    if p.exists() {
        return validate_folder(raw);
    }
    let mut cur = p.parent();
    while let Some(anc) = cur {
        if anc.as_os_str().is_empty() { break }
        if anc.exists() {
            if std::fs::symlink_metadata(anc)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err(format!("refusing to write through symlinked ancestor: {}", anc.display()));
            }
            let canon = anc.canonicalize()
                .map_err(|e| format!("resolve ancestor {}: {e}", anc.display()))?;
            let rel = p.strip_prefix(anc)
                .map_err(|e| format!("rel path: {e}"))?;
            return Ok(canon.join(rel));
        }
        cur = anc.parent();
    }
    Err(format!("no existing ancestor for {raw}"))
}

/// Validate a user-supplied file path (e.g. explicit music track or
/// template). Requires the file to exist and not be a symlink.
pub fn validate_file(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("empty file path".to_string());
    }
    let p = Path::new(raw);
    reject_traversal_components(p)?;
    if std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("refusing to use a symlinked file: {raw}"));
    }
    let canon = p
        .canonicalize()
        .map_err(|e| format!("resolve file {raw}: {e}"))?;
    if !canon.is_file() {
        return Err(format!("not a file: {raw}"));
    }
    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_banned_chars() {
        assert_eq!(sanitize_segment("Ann O'Malley"), "Ann O'Malley");
        assert_eq!(sanitize_segment("Bo:b|"), "Bo-b-");
        assert_eq!(sanitize_segment("  spaced  out  "), "spaced out");
        assert_eq!(sanitize_segment(""), "unnamed");
        assert_eq!(sanitize_segment("..."), "unnamed");
        assert_eq!(sanitize_segment("con"), "_con");
        assert_eq!(sanitize_segment("CON.txt"), "_CON.txt");
        // Leading dot would create a hidden folder on macOS/Linux — trim it.
        assert_eq!(sanitize_segment(".foo"), "foo");
        assert_eq!(sanitize_segment("..hidden"), "hidden");
        assert_eq!(sanitize_segment(".foo."), "foo");
    }

    #[test]
    fn student_folder_is_zero_padded() {
        assert_eq!(student_folder_name(7, "Ann"), "0007-Ann");
        assert_eq!(student_folder_name(1234, "Ben"), "1234-Ben");
    }

    #[test]
    fn child_photo_finds_exact_and_case_variants() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::write(base.join("Aarav Kumar.jpg"), b"fake").unwrap();
        assert!(child_photo(base, "Aarav Kumar").is_some());
        assert!(child_photo(base, "aarav kumar").is_some());
        assert!(child_photo(base, "AARAV KUMAR").is_some());
        assert!(child_photo(base, "Other Child").is_none());
    }

    #[test]
    fn child_photo_accepts_heic_and_png() {
        let heic_dir = tempfile::tempdir().unwrap();
        std::fs::write(heic_dir.path().join("Mia.heic"), b"x").unwrap();
        assert!(child_photo(heic_dir.path(), "Mia").is_some());

        let png_dir = tempfile::tempdir().unwrap();
        std::fs::write(png_dir.path().join("Ben.PNG"), b"x").unwrap();
        assert!(child_photo(png_dir.path(), "ben").is_some());
    }

    #[test]
    fn child_photo_missing_folder_returns_none() {
        let missing = Path::new("/hopefully/nonexistent/echelon-test-7f3a9b");
        assert!(child_photo(missing, "Anyone").is_none());
    }

    #[test]
    fn child_photo_matches_first_name() {
        // Most common parent behaviour: photo named just with the
        // child's first name.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Beau.jpg"), b"x").unwrap();
        let hit = child_photo(dir.path(), "Beau Seymour").unwrap();
        assert_eq!(hit.file_name().unwrap(), "Beau.jpg");
    }

    #[test]
    fn child_photo_prefers_full_name_over_first_name() {
        // When both are present, full-name match wins (most specific).
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Beau.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("Beau Seymour.jpg"), b"x").unwrap();
        let hit = child_photo(dir.path(), "Beau Seymour").unwrap();
        assert_eq!(hit.file_name().unwrap(), "Beau Seymour.jpg");
    }

    #[test]
    fn child_photo_ignores_random_names_that_dont_match_any_token() {
        // "20191021_082507.jpg" should NOT match "Beau Seymour", and neither
        // should a bare last name — the new spec dropped last-only matches.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("20191021_082507.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("random_photo.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("Seymour.jpg"), b"x").unwrap();
        assert!(child_photo(dir.path(), "Beau Seymour").is_none());
    }

    #[test]
    fn child_photo_single_word_name_still_works() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Beau.jpg"), b"x").unwrap();
        assert!(child_photo(dir.path(), "Beau").is_some());
    }

    #[test]
    fn child_photos_matches_first_last_when_display_name_has_middle() {
        // The bug that motivated v2.5.3: display name "Beau Andrew Seymour"
        // with a file named "Beau Seymour.jpg" MUST match.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Beau Seymour.jpg"), b"x").unwrap();
        let hits = child_photos(dir.path(), "Beau Andrew Seymour");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file_name().unwrap(), "Beau Seymour.jpg");
    }

    #[test]
    fn child_photos_matches_concatenated_no_space_variants() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("BeauSeymour.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("BeauAndrewSeymour.png"), b"x").unwrap();
        let hits = child_photos(dir.path(), "Beau Andrew Seymour");
        assert_eq!(hits.len(), 2);
        // Full-name (tier 0) beats first+last (tier 1).
        assert_eq!(hits[0].file_name().unwrap(), "BeauAndrewSeymour.png");
        assert_eq!(hits[1].file_name().unwrap(), "BeauSeymour.jpg");
    }

    #[test]
    fn child_photos_returns_all_matches_up_to_cap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Beau.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("BeauSeymour.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("Beau Andrew Seymour.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("BeauAndrewSeymour.jpg"), b"x").unwrap();
        let hits = child_photos(dir.path(), "Beau Andrew Seymour");
        // 4 matches, all under the cap.
        assert_eq!(hits.len(), 4);
        // Full-name (tier 0) files first, alpha within tier.
        let names: Vec<_> = hits
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap().to_string())
            .collect();
        assert_eq!(names[0], "Beau Andrew Seymour.jpg");
        assert_eq!(names[1], "BeauAndrewSeymour.jpg");
        assert_eq!(names[2], "BeauSeymour.jpg"); // tier 1: first+last
        assert_eq!(names[3], "Beau.jpg");        // tier 2: first only
    }

    #[test]
    fn child_photos_caps_at_max_per_slide() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..7 {
            // 7 files that all normalize to "beau".
            std::fs::write(dir.path().join(format!("Beau ({n}).jpg")), b"x").unwrap();
        }
        // Also add an unambiguous first-name-only match.
        std::fs::write(dir.path().join("Beau.jpg"), b"x").unwrap();
        let hits = child_photos(dir.path(), "Beau");
        assert!(hits.len() <= MAX_PHOTOS_PER_SLIDE);
    }

    #[test]
    fn child_photos_accepts_extensionless_jpeg_via_magic_bytes() {
        // Real-world case: AirDrop / macOS "hide extension" strips the
        // suffix, leaving a file literally named "Beau Seymour" with
        // JPEG magic bytes.
        let dir = tempfile::tempdir().unwrap();
        // Minimal JPEG magic: FF D8 FF E0 ... (JFIF header stub is enough).
        let jpeg_bytes: &[u8] = &[
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01,
        ];
        std::fs::write(dir.path().join("Beau Seymour"), jpeg_bytes).unwrap();
        let hits = child_photos(dir.path(), "Beau Andrew Seymour");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file_name().unwrap(), "Beau Seymour");
    }

    #[test]
    fn child_photos_ignores_extensionless_non_image_files() {
        let dir = tempfile::tempdir().unwrap();
        // Text file with no extension whose name would otherwise match.
        std::fs::write(dir.path().join("Beau"), b"just some notes about beau").unwrap();
        let hits = child_photos(dir.path(), "Beau");
        assert!(hits.is_empty());
    }

    #[test]
    fn child_photos_matches_nfc_and_nfd_variants() {
        // F7: filename on disk may be NFD (macOS APFS) while display
        // name from the CSV is NFC. Both should match.
        let dir = tempfile::tempdir().unwrap();
        // NFD: 'e' + combining acute (U+0301).
        let nfd_name = "Ren\u{0065}\u{0301}.jpg";
        std::fs::write(dir.path().join(nfd_name), b"x").unwrap();
        // Display name in NFC: precomposed 'é' (U+00E9).
        let nfc_display = "Ren\u{00E9}";
        let hits = child_photos(dir.path(), nfc_display);
        assert_eq!(hits.len(), 1, "NFC display should match NFD filename");
    }

    #[test]
    fn validate_folder_rejects_parent_dir_traversal() {
        // F16: `..` must be rejected before canonicalize resolves it.
        let dir = tempfile::tempdir().unwrap();
        let sneaky = dir.path().join("child").join("..").join("..");
        // Create the child so the leaf exists — traversal check must
        // fire before existence resolves it away.
        std::fs::create_dir_all(dir.path().join("child")).unwrap();
        let err = validate_folder(sneaky.to_str().unwrap()).unwrap_err();
        assert!(err.contains(".."), "expected .. rejection, got {err}");
    }
}
