// DB restore: writes the chosen file to a "pending_restore.db" beside the live DB.
// On the next app startup, before the SQL plugin opens any connection,
// we back up the current DB and atomically swap the pending file in.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

fn read_header(path: &Path) -> Result<[u8; 16], String> {
    use std::io::Read;
    let mut f = fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let mut buf = [0u8; 16];
    f.read_exact(&mut buf).map_err(|e| format!("read header: {e}"))?;
    Ok(buf)
}

fn app_db_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir app_data_dir: {e}"))?;
    let live = dir.join("echelon.db");
    let pending = dir.join("pending_restore.db");
    let backups = dir.join("Backups");
    Ok((live, pending, backups))
}

#[tauri::command]
pub fn stage_restore(src_path: String, app: tauri::AppHandle) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err(format!("File not found: {src_path}"));
    }
    let header = read_header(&src)?;
    if &header != SQLITE_HEADER {
        return Err("Not a valid SQLite database (header mismatch). Refusing to restore.".into());
    }
    let (_live, pending, _backups) = app_db_paths(&app)?;
    if let Some(parent) = pending.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    fs::copy(&src, &pending).map_err(|e| format!("copy to pending: {e}"))?;
    Ok(pending.to_string_lossy().to_string())
}

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

// Called from .setup() BEFORE the frontend opens any DB connection.
// If a pending restore file is present, back up the live DB and swap.
pub fn apply_pending_restore(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let (live, pending, backups) = app_db_paths(app)?;
    if !pending.exists() {
        return Ok(None);
    }
    fs::create_dir_all(&backups).map_err(|e| format!("mkdir backups: {e}"))?;

    let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    if live.exists() {
        let backup_path = backups.join(format!("echelon-pre-restore-{stamp}.db"));
        fs::copy(&live, &backup_path).map_err(|e| format!("safety backup: {e}"))?;
        // SQLite WAL/SHM siblings — copy them too if present so the safety backup is consistent.
        for ext in ["echelon.db-wal", "echelon.db-shm"] {
            let s = live.with_file_name(ext);
            if s.exists() {
                let _ = fs::copy(&s, backups.join(format!("{ext}-pre-restore-{stamp}")));
                let _ = fs::remove_file(&s); // stale WAL/SHM must not survive the swap
            }
        }
    }
    fs::rename(&pending, &live).map_err(|e| format!("swap: {e}"))?;
    Ok(Some(stamp))
}
