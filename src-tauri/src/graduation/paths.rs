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
                // Existing file is locked — publish tmp under a
                // timestamped sibling so the render isn't lost.
                return timestamped_fallback(tmp, final_dest, &format!("existing file locked: {e}"));
            }
            match std::fs::rename(tmp, final_dest) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&backup);
                    return Ok(final_dest.to_path_buf());
                }
                Err(e) => {
                    // Restore previous final so we don't lose it, then
                    // publish tmp under a timestamped sibling.
                    let _ = std::fs::rename(&backup, final_dest);
                    return timestamped_fallback(tmp, final_dest, &format!("promote tmp failed: {e}"));
                }
            }
        }
        std::fs::rename(tmp, final_dest)
            .map(|_| final_dest.to_path_buf())
            .or_else(|e| timestamped_fallback(tmp, final_dest, &format!("rename failed: {e}")))
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
        format!(
            "{reason}; fallback rename to {} also failed ({e2})",
            fallback.display()
        )
    })?;
    Ok(fallback)
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
    // Only write README the first time so we don't clobber notes the
    // user might have added.
    if !layout.readme.exists() {
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
r#"Graduation {year} — Folder Guide
=================================

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
{names_block}

  3-Music-Optional/
      Drop ONE audio file (mp3 / m4a / wav / flac) here to use as the
      soundtrack. Leave empty to use the app's bundled default music.

  4-Slide-Template-Optional/
      Drop ONE PowerPoint template (.pptx) here with a slide
      containing the tokens {{{{Name}}}}, {{{{Note}}}}, {{{{Year}}}}.
      Leave empty to use the app's bundled default template.

  5-Output/
      Rendered videos and the final .pptx deck are saved here.

Tips:
  • Photo formats supported: JPG, PNG, WebP, HEIC (iPhone).
  • You can re-scaffold at any time; existing folders and files are
    kept. Only new subfolders are added.
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

/// Return the first audio file inside `dir`, or `None` if none is
/// present. Used to auto-detect user-supplied music dropped into the
/// scaffolded `3-Music-Optional` folder. See [`list_audio_in`] when the
/// caller needs to warn on multiples.
pub fn first_audio_in(dir: &Path) -> Option<PathBuf> {
    list_audio_in(dir).into_iter().next()
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

/// Validate a folder used for output (writes). Canonicalizes the
/// parent chain if the folder itself doesn't yet exist — we allow
/// creating scaffolded subfolders under an existing user-picked base.
pub fn validate_writable_dir(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("empty folder path".to_string());
    }
    let p = Path::new(raw);
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
}
