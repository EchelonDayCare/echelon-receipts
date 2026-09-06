// DB restore: writes the chosen file to a "pending_restore.db" beside the live DB.
// On the next app startup, before the SQL plugin opens any connection,
// we back up the current DB and atomically swap the pending file in.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

fn app_db_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir app_data_dir: {e}"))?;
    let live = dir.join("echelon.db");
    let pending = dir.join("pending_restore.db");
    let backups = dir.join("Backups");
    Ok((live, pending, backups))
}

#[tauri::command]
pub fn stage_restore(
    src_path: String,
    app: tauri::AppHandle,
    auth: tauri::State<'_, crate::auth::AuthState>,
    passphrase: Option<String>,
) -> Result<String, String> {
    // Restore rewrites the live DB and can permanently lock out an
    // encrypted install if triggered from a compromised renderer. Require
    // the app to already be unlocked (owner has proven ownership this
    // session) before staging a restore.
    if !auth.has_mdk() {
        return Err("Unlock the app before restoring a backup.".into());
    }
    // H-8: don't trust an arbitrary caller-supplied path — constrain reads
    // to the app data dir / Documents / Downloads and reject symlinks.
    let src = crate::path_guard::validate_existing_file(&app, &src_path)?;
    let raw = fs::read(&src).map_err(|e| format!("read backup file: {e}"))?;

    // C-1: backups made after the encryption migration start with our
    // envelope magic. Decrypt them here; anything else is treated as a
    // legacy pre-migration plaintext `.db` dump (still supported so older
    // backups remain restorable).
    //
    // v3.24.4 (#3): if the source was plaintext AND this install is now
    // encrypted (has an MDK), we CANNOT just drop a plaintext SQLite file
    // into `pending_restore.db` — the SQL plugin will attempt to open it
    // with `PRAGMA key = ...` and fail with "file is not a database" (or
    // worse, corrupt it). Re-encrypt the plaintext into a fresh
    // SQLCipher-keyed file using the current MDK before staging.
    let (db_bytes, was_plaintext): (Vec<u8>, bool) = if crate::backup_crypto::is_encrypted(&raw) {
        let pass = passphrase
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "This backup is encrypted — a passphrase is required to restore it.".to_string())?;
        (crate::backup_crypto::decrypt(&pass, &raw)?, false)
    } else {
        (raw, true)
    };

    if db_bytes.len() < 16 || &db_bytes[..16] != SQLITE_HEADER {
        return Err("Not a valid SQLite database (header mismatch). Refusing to restore.".into());
    }

    let (_live, pending, _backups) = app_db_paths(&app)?;
    if let Some(parent) = pending.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }

    // If the incoming payload is plaintext AND we currently hold an MDK,
    // re-encrypt on the way in so pending → live doesn't leave a plaintext
    // file where SQLCipher expects an encrypted one.
    if was_plaintext {
        // Stage the plaintext to a temp file so we can (a) run integrity
        // checks on the plaintext (`run_integrity_checks` opens without
        // a key, which only works on a plaintext file), then (b) re-encrypt
        // into `pending` under the current MDK.
        let tmp_plain = pending.with_extension("plain.tmp");
        fs::write(&tmp_plain, &db_bytes).map_err(|e| format!("write tmp plain: {e}"))?;
        if let Err(e) = run_integrity_checks(&tmp_plain) {
            let _ = fs::remove_file(&tmp_plain);
            return Err(e);
        }
        let mdk = auth
            .clone_mdk()
            .ok_or_else(|| "Cannot re-encrypt restore: MDK not loaded. Unlock the app and retry.".to_string())?;
        let hex = mdk.as_pragma_hex();
        if pending.exists() {
            fs::remove_file(&pending).map_err(|e| format!("remove stale pending: {e}"))?;
        }
        let enc_result = {
            use crate::db_migration::Encryptor;
            crate::auth::SqlCipherExporter.encrypt_new(&tmp_plain, &pending, &hex)
        };
        // Always wipe the plaintext scratch file, success or fail.
        let _ = fs::remove_file(&tmp_plain);
        enc_result.map_err(|e| format!("re-encrypt restore with current MDK: {e}"))?;
        // Plaintext already passed integrity checks above — return early.
        return Ok(pending.to_string_lossy().to_string());
    }

    fs::write(&pending, &db_bytes).map_err(|e| format!("write pending: {e}"))?;

    // C-7: a header match alone doesn't rule out a truncated/corrupted or
    // referentially-broken dump. Run SQLite's own integrity checks on the
    // staged copy before we let it anywhere near `apply_pending_restore` —
    // abort staging (and clean up the pending file) on any failure.
    if let Err(e) = run_integrity_checks(&pending) {
        let _ = fs::remove_file(&pending);
        return Err(e);
    }

    Ok(pending.to_string_lossy().to_string())
}

// Opens the staged file read-only and runs PRAGMA integrity_check +
// PRAGMA foreign_key_check. Returns Err with a clear message unless both
// report clean.
fn run_integrity_checks(path: &Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ).map_err(|e| format!("open staged db: {e}"))?;

    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| format!("integrity_check: {e}"))?;
    if integrity.trim().to_lowercase() != "ok" {
        return Err(format!(
            "Restore aborted: the selected backup failed PRAGMA integrity_check ({integrity}). \
             The file may be corrupted or truncated."
        ));
    }

    let mut stmt = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| format!("prep foreign_key_check: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("foreign_key_check: {e}"))?;
    if rows.next().map_err(|e| format!("foreign_key_check next: {e}"))?.is_some() {
        return Err(
            "Restore aborted: the selected backup failed PRAGMA foreign_key_check \
             (referential integrity violations found)."
                .into(),
        );
    }

    Ok(())
}

#[tauri::command]
pub fn restart_app(
    app: tauri::AppHandle,
    auth: tauri::State<'_, crate::auth::AuthState>,
) -> Result<(), String> {
    if !auth.has_mdk() {
        return Err("Unlock the app before restarting.".into());
    }
    app.restart()
}

// v3.25.0 (Data Cleanup tool): mandatory safety copy of the live,
// still-encrypted DB before the frontend runs a bulk category delete
// (top-right Data Cleanup button). This is a plain file copy — no
// decrypt/re-encrypt round-trip — so it's safe to run even though we
// don't hold the passphrase here, and it's restorable later via the
// normal stage_restore path. Caller (frontend) must checkpoint the WAL
// first (`PRAGMA wal_checkpoint(TRUNCATE)`) so this single-file copy is
// a complete, consistent snapshot rather than missing uncheckpointed
// writes that are still sitting in -wal. We ALSO copy any leftover
// -wal/-shm sidecar files (belt-and-suspenders: a fully truncated
// checkpoint leaves nothing meaningful in them, but if the OS hasn't
// finished flushing them to zero length yet, a restore must still see
// a self-consistent trio, not a lone main file next to a stale -wal).
// Finally we verify the destination file size matches the source before
// declaring success — a short/partial copy must fail loudly here, not
// silently produce a truncated "backup."
#[tauri::command]
pub fn backup_before_data_cleanup(
    app: tauri::AppHandle,
    auth: tauri::State<'_, crate::auth::AuthState>,
) -> Result<String, String> {
    if !auth.has_mdk() {
        return Err("Unlock the app before running a data cleanup.".into());
    }
    let (live, _pending, backups) = app_db_paths(&app)?;
    if !live.exists() {
        return Err("Live database not found.".into());
    }
    fs::create_dir_all(&backups).map_err(|e| format!("mkdir backups: {e}"))?;
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let dest_dir = backups.join(format!("pre-cleanup-{stamp}"));
    fs::create_dir_all(&dest_dir).map_err(|e| format!("mkdir pre-cleanup backup dir: {e}"))?;

    let dest = dest_dir.join("echelon.db");
    fs::copy(&live, &dest).map_err(|e| format!("safety backup copy: {e}"))?;
    let src_len = fs::metadata(&live).map_err(|e| format!("stat live db: {e}"))?.len();
    let dest_len = fs::metadata(&dest).map_err(|e| format!("stat backup copy: {e}"))?.len();
    if src_len != dest_len {
        let _ = fs::remove_file(&dest);
        return Err(format!(
            "Safety backup copy looked incomplete ({dest_len} of {src_len} bytes) — aborting cleanup without deleting anything. Try again."
        ));
    }

    for ext in ["-wal", "-shm"] {
        let mut sidecar = live.clone().into_os_string();
        sidecar.push(ext);
        let sidecar = PathBuf::from(sidecar);
        if sidecar.exists() {
            let mut dest_sidecar = dest.clone().into_os_string();
            dest_sidecar.push(ext);
            fs::copy(&sidecar, PathBuf::from(dest_sidecar))
                .map_err(|e| format!("safety backup copy ({ext}): {e}"))?;
        }
    }

    Ok(dest_dir.to_string_lossy().into_owned())
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
    // On Windows, fs::rename fails if the target already exists. Remove the
    // live file first (we already copied it into Backups above) so the swap
    // is atomic-enough for both platforms.
    if live.exists() {
        fs::remove_file(&live).map_err(|e| format!("remove live before swap: {e}"))?;
    }
    fs::rename(&pending, &live).map_err(|e| format!("swap: {e}"))?;
    Ok(Some(stamp))
}
