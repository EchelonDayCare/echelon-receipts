// Document Vault — ZIP export (v1.1.0)
//
// Bundles a set of blob rows into a single ZIP on disk. Called from the
// Library screen's bulk "Export selected as ZIP" action. Done in Rust because
// (a) walking blobs via tauri-plugin-sql from JS and streaming a ZIP write in
// the browser sandbox is painful, and (b) the zip crate handles OS filename
// sanitization cleanly on both Windows and macOS.
//
// v2.x note: reads MUST go through the app's DbGate — opening a second
// `Connection::open` on echelon.db bypasses the SQLCipher key we hold in
// memory and will produce "file is not a database" on the encrypted DB.
use std::fs::File;
use std::io::Write;
use serde::Deserialize;
use zip::write::SimpleFileOptions;

use crate::db_gate::{DbError, DbGate};

#[derive(Debug, Deserialize)]
pub struct ZipEntryInput {
    pub blob_key: String,
    pub path_in_zip: String,
}

#[tauri::command]
pub async fn documents_export_zip(
    app_handle: tauri::AppHandle,
    db_gate: tauri::State<'_, DbGate>,
    entries: Vec<ZipEntryInput>,
    dest_path: String,
) -> Result<u64, String> {
    // H-8: constrain writes to the app data dir / Documents / Downloads
    // and reject symlinks before we start reading blobs.
    let dest_path = crate::path_guard::validate_new_file_dest(&app_handle, &dest_path)?;

    // Pull all blobs up-front via the encrypted connection, then release
    // the DB lock before we spend time writing the ZIP. Failing here is
    // the common case (missing key, bad blob), so we haven't created the
    // destination file yet.
    let fetched: Vec<(String, Vec<u8>)> = db_gate
        .with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT content FROM blobs WHERE blob_key = ?")?;
            let mut out = Vec::with_capacity(entries.len());
            for entry in &entries {
                let content: Vec<u8> = stmt
                    .query_row([&entry.blob_key], |row| row.get::<_, Vec<u8>>(0))
                    .map_err(DbError::from)?;
                out.push((entry.path_in_zip.clone(), content));
            }
            Ok(out)
        })
        .await
        .map_err(|e| format!("read blobs: {e:?}"))?;

    // Zip creation is CPU + disk bound; wrap in spawn_blocking so we
    // don't stall the tokio runtime while a large export (100+ blobs)
    // is being deflated and written.
    let dest_path_clone = dest_path.clone();
    let total = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let out_file = File::create(&dest_path_clone).map_err(|e| format!("create zip: {e}"))?;
        let mut zip = zip::ZipWriter::new(out_file);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        let mut total: u64 = 0;
        let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();

        for (path_in_zip, content) in fetched {
            let mut name = sanitize(&path_in_zip);
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
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
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
