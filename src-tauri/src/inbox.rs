// Lightweight "Inbox" helpers: list recent image files in ~/Downloads so the
// frontend can wire an "Import latest from Downloads" button without needing
// a permissive fs scope. AirDrop from iPad → Mac lands files in Downloads,
// so this is the smallest workflow step we can wrap.
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::Serialize;

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf"];

#[derive(Serialize, Clone)]
pub struct InboxItem {
    pub path: String,
    pub name: String,
    pub modified_secs_ago: u64,
    pub size: u64,
}

fn downloads_dir() -> Option<PathBuf> {
    // Honor $HOME on macOS / Linux and %USERPROFILE% on Windows.
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let p = PathBuf::from(home).join("Downloads");
    if p.is_dir() { Some(p) } else { None }
}

#[tauri::command]
pub fn inbox_list_recent(within_minutes: u32, limit: u32) -> Result<Vec<InboxItem>, String> {
    const MAX_SIZE_BYTES: u64 = 25 * 1024 * 1024; // 25 MiB cap — phone photos are < 10 MiB
    let dir = downloads_dir().ok_or_else(|| "Downloads folder not found".to_string())?;
    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(within_minutes as u64 * 60))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let read = fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    let mut items: Vec<InboxItem> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        // Use symlink_metadata so a malicious symlink named "sheet.jpg" pointing at
        // ~/.ssh/id_rsa or any other sensitive file does not get surfaced and read
        // through the existing $DOWNLOAD fs scope.
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let smeta = match entry.path().symlink_metadata() { Ok(m) => m, Err(_) => continue };
        if smeta.file_type().is_symlink() { continue; }
        if !meta.is_file() { continue; }
        if meta.len() == 0 { continue; }              // empty / placeholder
        if meta.len() > MAX_SIZE_BYTES { continue; }  // outsized; not a phone photo

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // Skip macOS metadata droppings and iCloud Drive placeholders that look
        // like images but aren't actually downloaded yet.
        if name.is_empty() || name.starts_with("._") || name == ".DS_Store" { continue; }
        if name.ends_with(".icloud") || name.starts_with(".") { continue; }

        // Filter by extension (case-insensitive).
        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| IMAGE_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
            .unwrap_or(false);
        if !ext_ok { continue; }

        let modified = match meta.modified() { Ok(m) => m, Err(_) => continue };
        if modified < cutoff { continue; }
        let modified_secs_ago = SystemTime::now()
            .duration_since(modified)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        items.push(InboxItem {
            path: path.to_string_lossy().to_string(),
            name,
            modified_secs_ago,
            size: meta.len(),
        });
    }

    items.sort_by_key(|i| i.modified_secs_ago);
    items.truncate(limit as usize);
    Ok(items)
}
