// Document Vault — ZIP export (v1.1.0)
//
// Bundles a set of blob rows into a single ZIP on disk. Called from the
// Library screen's bulk "Export selected as ZIP" action. Done in Rust because
// (a) walking blobs via tauri-plugin-sql from JS and streaming a ZIP write in
// the browser sandbox is painful, and (b) the zip crate handles OS filename
// sanitization cleanly on both Windows and macOS.
//
// The JS caller passes an already-resolved list of {blob_key, path_in_zip}
// entries. This module does not query the DB — it just reads blobs by key
// via the same sqlite file the plugin manages.
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use serde::Deserialize;
use zip::write::SimpleFileOptions;

#[derive(Debug, Deserialize)]
pub struct ZipEntryInput {
    pub blob_key: String,
    pub path_in_zip: String,
}

#[tauri::command]
pub async fn documents_export_zip(
    app_handle: tauri::AppHandle,
    entries: Vec<ZipEntryInput>,
    dest_path: String,
) -> Result<u64, String> {
    // Locate the app data dir where tauri-plugin-sql keeps echelon.db.
    let db_path: PathBuf = tauri::Manager::path(&app_handle)
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("echelon.db");
    if !db_path.exists() {
        return Err(format!("database not found at {}", db_path.display()));
    }

    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| format!("open sqlite: {e}"))?;

    // H-8: don't trust an arbitrary caller-supplied destination — constrain
    // writes to the app data dir / Documents / Downloads and reject symlinks.
    let dest_path = crate::path_guard::validate_new_file_dest(&app_handle, &dest_path)?;
    let out_file = File::create(&dest_path).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(out_file);
    let opts = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let mut total: u64 = 0;
    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in entries {
        // Fetch blob content.
        let mut stmt = conn
            .prepare("SELECT content FROM blobs WHERE blob_key = ?")
            .map_err(|e| format!("prepare: {e}"))?;
        let content: Vec<u8> = stmt
            .query_row([&entry.blob_key], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|e| format!("blob {} missing: {e}", entry.blob_key))?;

        // Ensure unique filename in the ZIP (append " (2)", " (3)", etc.).
        let mut name = sanitize(&entry.path_in_zip);
        if used_names.contains(&name) {
            let (stem, ext) = split_ext(&name);
            let mut i = 2u32;
            loop {
                let candidate = if ext.is_empty() {
                    format!("{stem} ({i})")
                } else {
                    format!("{stem} ({i}).{ext}")
                };
                if !used_names.contains(&candidate) { name = candidate; break; }
                i += 1;
            }
        }
        used_names.insert(name.clone());

        zip.start_file(&name, opts).map_err(|e| format!("zip start: {e}"))?;
        zip.write_all(&content).map_err(|e| format!("zip write: {e}"))?;
        total += content.len() as u64;
    }

    zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(total)
}

fn sanitize(path: &str) -> String {
    // Split on '/' so category subfolders survive, then scrub each segment.
    path.split('/')
        .filter(|seg| !seg.is_empty() && *seg != "." && *seg != "..")
        .map(|seg| {
            seg.chars()
                .map(|c| match c {
                    '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*' => '_',
                    c if (c as u32) < 32 => '_',
                    c => c,
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn split_ext(name: &str) -> (String, String) {
    if let Some(idx) = name.rfind('.') {
        if idx > 0 && idx < name.len() - 1 {
            return (name[..idx].to_string(), name[idx + 1..].to_string());
        }
    }
    (name.to_string(), String::new())
}
