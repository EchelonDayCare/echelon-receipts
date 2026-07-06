// H-8: user-supplied filesystem paths (DB restore source, ZIP export
// destination) must be constrained to locations the user actually reached
// via a native file picker inside an expected directory — never trusted
// as-is. This guards against path traversal and reading/writing outside the
// app's sandbox. Symlinks are rejected outright since they can point
// anywhere regardless of the textual path.
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn allowed_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(d) = app.path().app_data_dir() {
        roots.push(d.canonicalize().unwrap_or(d));
    }
    if let Some(d) = dirs::document_dir() {
        roots.push(d.canonicalize().unwrap_or(d));
    }
    if let Some(d) = dirs::download_dir() {
        roots.push(d.canonicalize().unwrap_or(d));
    }
    roots
}

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Validate a path the user selected for an existing file we are about to
/// READ (e.g. a DB backup to restore). Requires the file to exist, not be a
/// symlink (nor be reached through one), and canonicalize to somewhere
/// under an allowed root.
pub fn validate_existing_file(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(raw);
    if !p.exists() {
        return Err(format!("File not found: {raw}"));
    }
    if is_symlink(&p) {
        return Err("Refusing to use a symlinked file.".into());
    }
    let canon = p.canonicalize().map_err(|e| format!("resolve path: {e}"))?;
    let roots = allowed_roots(app);
    if roots.is_empty() || !roots.iter().any(|r| canon.starts_with(r)) {
        return Err("File must be inside the app data folder, Documents, or Downloads.".into());
    }
    Ok(canon)
}

/// Validate a path the user selected as the destination for a new file we
/// are about to WRITE (e.g. a ZIP export). The file itself may not exist
/// yet, so we canonicalize the parent directory and re-check for a symlink
/// on both the parent and the (possibly pre-existing) target.
pub fn validate_new_file_dest(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(raw);
    let parent = p
        .parent()
        .filter(|s| !s.as_os_str().is_empty())
        .ok_or_else(|| "Destination has no parent directory.".to_string())?;
    if !parent.exists() {
        return Err(format!("Destination folder does not exist: {}", parent.display()));
    }
    if is_symlink(parent) {
        return Err("Refusing to write through a symlinked folder.".into());
    }
    let canon_parent = parent
        .canonicalize()
        .map_err(|e| format!("resolve destination folder: {e}"))?;
    let roots = allowed_roots(app);
    if roots.is_empty() || !roots.iter().any(|r| canon_parent.starts_with(r)) {
        return Err("Destination must be inside the app data folder, Documents, or Downloads.".into());
    }
    let file_name = p
        .file_name()
        .ok_or_else(|| "Destination has no filename.".to_string())?;
    let full = canon_parent.join(file_name);
    if is_symlink(&full) {
        return Err("Refusing to overwrite a symlink.".into());
    }
    Ok(full)
}
