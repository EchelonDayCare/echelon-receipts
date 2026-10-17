// DB restore: writes the chosen file to a "pending_restore.db" beside the live DB.
// On the next app startup, before the SQL plugin opens any connection,
// we back up the current DB and atomically swap the pending file in.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

fn app_db_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
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
    if !crate::backup_crypto::is_encrypted(&raw) {
        let wal = sqlite_sidecar(&src, "-wal");
        if wal.exists() {
            let wal = crate::path_guard::validate_existing_file(&app, &wal.to_string_lossy())?;
            if fs::metadata(&wal)
                .map_err(|e| format!("check backup WAL: {e}"))?
                .len()
                > 0
            {
                return Err("This database has an uncheckpointed WAL companion. Use a checkpointed safety copy or a portable app export; restoring the database file alone could omit committed records.".into());
            }
        }
    }

    // Portable envelopes decrypt to SQLite, then must be re-encrypted under
    // this installation's MDK. Raw safety copies require the existing key.
    let db_bytes: Vec<u8> = if crate::backup_crypto::is_encrypted(&raw) {
        let pass = passphrase.filter(|p| !p.is_empty()).ok_or_else(|| {
            "This backup is encrypted — a passphrase is required to restore it.".to_string()
        })?;
        crate::backup_crypto::decrypt(&pass, &raw)?
    } else {
        raw
    };

    let (_live, pending, _backups) = app_db_paths(&app)?;
    if let Some(parent) = pending.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }

    // If the incoming payload is plaintext AND we currently hold an MDK,
    // re-encrypt on the way in so pending → live doesn't leave a plaintext
    // file where SQLCipher expects an encrypted one.
    let mdk = auth
        .clone_mdk()
        .ok_or_else(|| "Unlock the app before restoring.".to_string())?;
    stage_database_bytes(&db_bytes, &pending, &mdk.as_pragma_hex())?;
    Ok(pending.to_string_lossy().to_string())
}

fn stage_database_bytes(db_bytes: &[u8], pending: &Path, hex: &str) -> Result<(), String> {
    static STAGING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = STAGING
        .lock()
        .map_err(|_| "Restore staging lock unavailable".to_string())?;
    if db_bytes.len() < 16 {
        return Err("Backup is truncated. Refusing to restore.".into());
    }
    if &db_bytes[..16] == SQLITE_HEADER {
        // Stage the plaintext to a temp file so we can (a) run integrity
        // checks on the plaintext (`run_integrity_checks` opens without
        // a key, which only works on a plaintext file), then (b) re-encrypt
        // into `pending` under the current MDK.
        let tmp_plain = pending.with_extension("plain.tmp");
        fs::write(&tmp_plain, &db_bytes).map_err(|e| format!("write tmp plain: {e}"))?;
        if let Err(e) = run_integrity_checks(&tmp_plain) {
            fs::remove_file(&tmp_plain).map_err(|cleanup| {
                format!("Invalid backup ({e}); cannot remove plaintext scratch: {cleanup}")
            })?;
            return Err(e);
        }
        let encrypted = pending.with_extension("encrypted.tmp");
        if encrypted.exists() {
            fs::remove_file(&encrypted)
                .map_err(|e| format!("remove incomplete encryption scratch: {e}"))?;
        }
        let enc_result = {
            use crate::db_migration::Encryptor;
            crate::auth::SqlCipherExporter.encrypt_new(&tmp_plain, &encrypted, hex)
        };
        fs::remove_file(&tmp_plain)
            .map_err(|e| format!("Cannot remove plaintext restore scratch: {e}"))?;
        if let Err(e) = enc_result {
            if encrypted.exists() {
                fs::remove_file(&encrypted).map_err(|cleanup| {
                    format!("Restore failed ({e}); cannot remove incomplete staged file: {cleanup}")
                })?;
            }
            return Err(format!("re-encrypt restore with current MDK: {e}"));
        }
        return replace_staged_file(&encrypted, pending);
    }

    // In-place safety copies are keyed with this install's MDK. Validate them
    // with that key; never treat an arbitrary header as a valid backup.
    let scratch = pending.with_extension("keyed.tmp");
    fs::write(&scratch, db_bytes).map_err(|e| format!("write keyed verification copy: {e}"))?;
    let validation = (|| {
        let c = rusqlite::Connection::open_with_flags(
            &scratch,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| e.to_string())?;
        let pragma = zeroize::Zeroizing::new(format!("PRAGMA key = \"x'{hex}'\""));
        c.execute_batch(&pragma).map_err(|e| e.to_string())?;
        check_connection(&c)
    })();
    if let Err(error) = validation {
        fs::remove_file(&scratch).map_err(|e| {
            format!("Invalid safety copy ({error}); cannot remove verification scratch: {e}")
        })?;
        return Err(format!(
            "Safety copy is invalid or belongs to another installation/key: {error}"
        ));
    }
    replace_staged_file(&scratch, pending)
}

fn replace_staged_file(source: &Path, pending: &Path) -> Result<(), String> {
    let previous = pending.with_extension("previous.db");
    if previous.exists() {
        if pending.exists() {
            fs::remove_file(&previous)
                .map_err(|e| format!("remove previous staging scratch: {e}"))?;
        } else {
            fs::rename(&previous, pending)
                .map_err(|e| format!("recover previous staged backup: {e}"))?;
        }
    }
    let had_pending = pending.exists();
    if had_pending {
        fs::rename(pending, &previous).map_err(|e| format!("preserve staged backup: {e}"))?;
    }
    if let Err(error) = fs::rename(source, pending) {
        if had_pending {
            fs::rename(&previous, pending).map_err(|e| {
                format!(
                    "Stage replacement failed ({error}); recover {} manually: {e}",
                    previous.display()
                )
            })?;
        }
        return Err(format!(
            "Stage replacement failed; previous backup preserved: {error}"
        ));
    }
    if had_pending {
        fs::remove_file(&previous).map_err(|e| format!("remove staging scratch: {e}"))?;
    }
    Ok(())
}

// Opens the staged file read-only and runs PRAGMA integrity_check +
// PRAGMA foreign_key_check. Returns Err with a clear message unless both
// report clean.
fn run_integrity_checks(path: &Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("open staged db: {e}"))?;
    check_connection(&conn)
}

fn check_connection(conn: &rusqlite::Connection) -> Result<(), String> {
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
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("foreign_key_check: {e}"))?;
    if rows
        .next()
        .map_err(|e| format!("foreign_key_check next: {e}"))?
        .is_some()
    {
        return Err(
            "Restore aborted: the selected backup failed PRAGMA foreign_key_check \
             (referential integrity violations found)."
                .into(),
        );
    }

    crate::finance::validate_restore(conn)
        .map_err(|e| format!("Accounting restore validation: {e}"))?;
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
    let src_len = fs::metadata(&live)
        .map_err(|e| format!("stat live db: {e}"))?
        .len();
    let dest_len = fs::metadata(&dest)
        .map_err(|e| format!("stat backup copy: {e}"))?
        .len();
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
    apply_restore_files(&live, &pending, &backups)
}

fn apply_restore_files(
    live: &Path,
    pending: &Path,
    backups: &Path,
) -> Result<Option<String>, String> {
    let parked = live.with_extension("pre-swap.db");
    recover_parked_restore(live, &parked)?;
    if !pending.exists() {
        return Ok(None);
    }

    fs::create_dir_all(&backups).map_err(|e| format!("mkdir backups: {e}"))?;
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    if live.exists() {
        let backup_path = backups.join(format!("echelon-pre-restore-{stamp}.db"));
        fs::copy(&live, &backup_path).map_err(|e| format!("safety backup: {e}"))?;
        for ext in ["echelon.db-wal", "echelon.db-shm"] {
            let s = live.with_file_name(ext);
            if s.exists() {
                let mut backup_sidecar = backup_path.clone().into_os_string();
                backup_sidecar.push(if ext.ends_with("-wal") {
                    "-wal"
                } else {
                    "-shm"
                });
                fs::copy(&s, PathBuf::from(backup_sidecar))
                    .map_err(|e| format!("backup sidecar before restore: {e}"))?;
            }
        }
    }
    let had_live = live.exists();
    if had_live {
        fs::rename(live, &parked).map_err(|e| format!("preserve live before swap: {e}"))?;
    }
    for ext in ["-wal", "-shm"] {
        let sibling = sqlite_sidecar(live, ext);
        if sibling.exists() {
            if let Err(error) = fs::rename(&sibling, sqlite_sidecar(&parked, ext)) {
                recover_parked_restore(live, &parked)?;
                return Err(format!("Preserve restore sidecar: {error}"));
            }
        }
    }
    if let Err(error) = fs::rename(pending, live) {
        recover_parked_restore(live, &parked)
            .map_err(|e| format!("Restore swap failed ({error}); {e}"))?;
        return Err(format!(
            "Restore swap failed; original database preserved: {error}"
        ));
    }
    recover_parked_restore(live, &parked)?;
    Ok(Some(stamp))
}

fn sqlite_sidecar(database: &Path, ext: &str) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(ext);
    PathBuf::from(path)
}

fn recover_parked_restore(live: &Path, parked: &Path) -> Result<(), String> {
    if !parked.exists() {
        return Ok(());
    }
    let completed = live.exists();
    for ext in ["-wal", "-shm"] {
        let sidecar = sqlite_sidecar(parked, ext);
        if sidecar.exists() {
            if completed {
                fs::remove_file(&sidecar).map_err(|e| format!("finish restored sidecar: {e}"))?;
            } else {
                fs::rename(&sidecar, sqlite_sidecar(live, ext))
                    .map_err(|e| format!("recover original sidecar: {e}"))?;
            }
        }
    }
    if completed {
        fs::remove_file(parked).map_err(|e| format!("finish previous restore: {e}"))?;
    } else {
        fs::rename(parked, live).map_err(|e| format!("recover interrupted restore: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_migration::Encryptor;
    use rusqlite::Connection;
    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "echelon-finance-restore-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn activated_accounting_round_trips_envelope_and_current_key_safety_copy() {
        let dir = scratch();
        let plain = dir.join("portable.db");
        let keyed = dir.join("safety.db");
        let staged = dir.join("pending.db");
        let c = crate::finance::tests::enabled();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100)",
            [],
        )
        .unwrap();
        let request = |op: &str, data| crate::finance::FinanceRequest {
            op: op.into(),
            data,
        };
        let r = crate::finance::run(
            &c,
            request(
                "export_report",
                serde_json::json!({"from":"2026-09-01","to":"2026-09-30"}),
            ),
        )
        .unwrap();
        c.execute("VACUUM INTO ?", [plain.to_string_lossy().as_ref()])
            .unwrap();
        let bytes = fs::read(&plain).unwrap();
        let envelope =
            crate::backup_crypto::encrypt("Synthetic backup passphrase", &bytes).unwrap();
        let decrypted =
            crate::backup_crypto::decrypt("Synthetic backup passphrase", &envelope).unwrap();
        let hex = "ab".repeat(32);
        stage_database_bytes(&decrypted, &staged, &hex).unwrap();
        assert_ne!(&fs::read(&staged).unwrap()[..16], SQLITE_HEADER);
        let restored = Connection::open(&staged).unwrap();
        restored
            .execute_batch(&format!("PRAGMA key=\"x'{hex}'\";"))
            .unwrap();
        check_connection(&restored).unwrap();
        assert_eq!(
            crate::finance::run(
                &restored,
                request("saved_report", serde_json::json!({"id":1}))
            )
            .unwrap()["report"],
            r["report"]
        );
        assert!(restored.execute("DELETE FROM receipts", []).is_err());
        drop(restored);
        crate::auth::SqlCipherExporter
            .encrypt_new(&plain, &keyed, &hex)
            .unwrap();
        let raw = fs::read(&keyed).unwrap();
        stage_database_bytes(&raw, &staged, &hex).unwrap();
        let wrong = dir.join("wrong.db");
        assert!(stage_database_bytes(&raw, &wrong, &"cd".repeat(32)).is_err());
        assert!(!wrong.exists());
        drop(c);
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn corrupted_or_inconsistent_accounting_backup_is_not_staged() {
        let dir = scratch();
        let plain = dir.join("corrupt.db");
        let pending = dir.join("pending.db");
        let c = crate::finance::tests::enabled();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100)",
            [],
        )
        .unwrap();
        c.execute_batch("DROP TRIGGER finance_receipts_update; UPDATE receipts SET amount=99;")
            .unwrap();
        c.execute("VACUUM INTO ?", [plain.to_string_lossy().as_ref()])
            .unwrap();
        assert!(
            stage_database_bytes(&fs::read(&plain).unwrap(), &pending, &"ab".repeat(32)).is_err()
        );
        assert!(!pending.exists());
        assert!(stage_database_bytes(b"bad", &pending, &"ab".repeat(32)).is_err());
        fs::write(&pending, b"previous valid staged backup").unwrap();
        assert!(replace_staged_file(&dir.join("missing.db"), &pending).is_err());
        assert_eq!(fs::read(&pending).unwrap(), b"previous valid staged backup");
        drop(c);
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn applying_restore_preserves_original_and_recovers_interrupted_swap() {
        let dir = scratch();
        let live = dir.join("echelon.db");
        let pending = dir.join("pending.db");
        let backups = dir.join("Backups");
        fs::write(&live, b"original").unwrap();
        fs::write(&pending, b"replacement").unwrap();
        let stamp = apply_restore_files(&live, &pending, &backups)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(&live).unwrap(), b"replacement");
        assert_eq!(
            fs::read(backups.join(format!("echelon-pre-restore-{stamp}.db"))).unwrap(),
            b"original"
        );
        assert!(!pending.exists());
        fs::rename(&live, live.with_extension("pre-swap.db")).unwrap();
        fs::write(
            sqlite_sidecar(&live.with_extension("pre-swap.db"), "-wal"),
            b"original WAL",
        )
        .unwrap();
        assert!(apply_restore_files(&live, &pending, &backups)
            .unwrap()
            .is_none());
        assert_eq!(fs::read(&live).unwrap(), b"replacement");
        assert_eq!(
            fs::read(sqlite_sidecar(&live, "-wal")).unwrap(),
            b"original WAL"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
