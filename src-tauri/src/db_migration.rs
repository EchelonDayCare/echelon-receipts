// Day 4: SQLCipher migration state machine.
//
// Turns a plaintext `echelon.db` into a SQLCipher-encrypted one via
// SQLCipher's `sqlcipher_export()` function. Designed to be resumable
// across app crashes and to leave no plaintext residue on success.
//
// Flow (each step also updates security.json.migration_state):
//   Plaintext ─(user confirms)─▶ Encrypting ─(verify + atomic rename)─▶ Encrypted
//
// On crash mid-Encrypting:
//   * `echelon.db` (plaintext) is still intact — never touched until
//     the final atomic rename step.
//   * `echelon.db.encrypting` (partial encrypted) may exist and is
//     always safe to delete on the next launch. `resume_or_rollback()`
//     handles this.
//
// The actual SQLCipher call is injected via an `Encrypt` trait so this
// module compiles and unit-tests cleanly without SQLCipher linked. Day 5
// provides the real rusqlite+SQLCipher-backed implementation.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::security::{self, MigrationState, SecurityEnvelope};

// ────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("io: {0}")]
    Io(#[from] io::Error),

    #[error("insufficient free space: need ~{needed_bytes} bytes, have {available_bytes}")]
    NoSpace {
        needed_bytes: u64,
        available_bytes: u64,
    },

    #[error("plaintext DB not found at {0}")]
    PlaintextMissing(PathBuf),

    #[error("encryption backend failed: {0}")]
    EncryptionFailed(String),

    #[error("integrity check failed on encrypted DB: {0}")]
    IntegrityFailed(String),

    #[error("row count mismatch: plaintext={plaintext}, encrypted={encrypted}")]
    RowCountMismatch { plaintext: u64, encrypted: u64 },

    #[error("security envelope error: {0}")]
    Envelope(#[from] security::SecurityError),
}

// ────────────────────────────────────────────────────────────────────────
// Encrypt / verify trait — Day 5 wires in the SQLCipher implementation
// ────────────────────────────────────────────────────────────────────────

/// The single operation we need SQLCipher for: run `sqlcipher_export()`
/// from an unencrypted source database into a new encrypted destination.
///
/// Also exposes verification hooks so this migration module never has
/// to link SQLCipher itself. All tests use `StubEncryptor`.
pub trait Encryptor {
    /// Copy every table/index/trigger/view from `src_plaintext` into a
    /// brand-new encrypted DB at `dst_encrypted` using the supplied
    /// hex-encoded 256-bit MDK. The destination file must not exist.
    fn encrypt_new(
        &self,
        src_plaintext: &Path,
        dst_encrypted: &Path,
        mdk_hex: &str,
    ) -> Result<(), String>;

    /// Open `path` as an encrypted DB with `mdk_hex`, run
    /// `PRAGMA integrity_check`, and return "ok" or the error text.
    fn integrity_check(&self, path: &Path, mdk_hex: &str) -> Result<String, String>;

    /// Sum of `SELECT COUNT(*) FROM <table>` across every table in the
    /// DB. Used as a coarse row-count comparison before/after migration
    /// so a broken export can't silently ship with missing rows.
    fn total_row_count(&self, path: &Path, mdk_hex: Option<&str>) -> Result<u64, String>;
}

// ────────────────────────────────────────────────────────────────────────
// File-system helpers
// ────────────────────────────────────────────────────────────────────────

/// Return the amount of free space at `dir` in bytes.
///
/// Windows: `GetDiskFreeSpaceExW`. Unix: `statvfs`. Both wrapped
/// minimally with no external crates.
fn free_space(dir: &Path) -> io::Result<u64> {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut u64,
                lpTotalNumberOfBytes: *mut u64,
                lpTotalNumberOfFreeBytes: *mut u64,
            ) -> i32;
        }
        let mut avail: u64 = 0;
        let mut total: u64 = 0;
        let mut free: u64 = 0;
        if GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(avail)
    }
    #[cfg(unix)]
    unsafe {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c = CString::new(dir.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path with nul"))?;
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st) != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(st.f_bavail as u64 * st.f_frsize as u64)
    }
}

/// Delete the SQLite triple `<path>`, `<path>-wal`, `<path>-shm` best-effort.
/// Called after a successful encrypted rename to ensure no plaintext
/// remnants survive.
///
/// NOTE: on SSDs with wear-leveling, file deletion doesn't guarantee
/// physical erasure of the underlying blocks. This is documented in
/// the setup wizard, which recommends enabling FileVault / BitLocker.
pub fn purge_sqlite_files(base: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut p = base.as_os_str().to_owned();
        p.push(suffix);
        let target = PathBuf::from(p);
        let _ = std::fs::remove_file(&target);
    }
}

/// Atomically replace `dst` with `src`. On Windows this uses
/// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, which is atomic on
/// NTFS. On Unix it's a plain `rename(2)`, atomic on the same
/// filesystem.
fn atomic_replace(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        let s: Vec<u16> = src.as_os_str().encode_wide().chain(Some(0)).collect();
        let d: Vec<u16> = dst.as_os_str().encode_wide().chain(Some(0)).collect();
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(
                lpExistingFileName: *const u16,
                lpNewFileName: *const u16,
                dwFlags: u32,
            ) -> i32;
        }
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
        if MoveFileExW(
            s.as_ptr(),
            d.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(unix)]
    {
        std::fs::rename(src, dst)
    }
}

/// Force everything staged for writing to be flushed to durable storage.
/// Cheap insurance before the atomic rename.
fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let f = std::fs::File::open(dir)?;
        f.sync_all()?;
    }
    #[cfg(windows)]
    {
        let _ = dir; // No portable equivalent; NTFS journal flush happens on rename.
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// Migration entry point
// ────────────────────────────────────────────────────────────────────────

/// Fixed sidecar name for the in-progress encrypted DB. Living beside
/// the plaintext file (same directory) keeps atomic rename on the
/// same filesystem, which is the OS-level atomicity guarantee.
pub const ENCRYPTING_SUFFIX: &str = ".encrypting";

pub struct Paths {
    pub plaintext: PathBuf,
    pub envelope: PathBuf,
}

impl Paths {
    pub fn encrypting(&self) -> PathBuf {
        let mut s = self.plaintext.as_os_str().to_owned();
        s.push(ENCRYPTING_SUFFIX);
        PathBuf::from(s)
    }
}

/// The migration entry point. Steps 1-8 of the flow described at the
/// top of this file. Idempotent when called from `Plaintext` (does the
/// full migration) or from `Encrypting` (resumes by rolling back the
/// partial `.encrypting` file and starting over).
pub fn migrate_to_encrypted<E: Encryptor>(
    encryptor: &E,
    paths: &Paths,
    mdk_hex: &str,
    envelope: &mut SecurityEnvelope,
    progress: &mut dyn Write,
) -> Result<(), MigrationError> {
    if envelope.migration_state == MigrationState::Encrypted {
        writeln!(progress, "[migrate] already encrypted, nothing to do")?;
        return Ok(());
    }
    if !paths.plaintext.exists() {
        return Err(MigrationError::PlaintextMissing(paths.plaintext.clone()));
    }

    let encrypting_path = paths.encrypting();

    // Any leftover .encrypting from a previous crash: nuke it.
    if encrypting_path.exists() {
        writeln!(
            progress,
            "[migrate] removing stale {}",
            encrypting_path.display()
        )?;
        let _ = std::fs::remove_file(&encrypting_path);
    }

    // Preflight: free space (need ~2× plaintext for safety margin).
    let plaintext_size = std::fs::metadata(&paths.plaintext)?.len();
    let needed = plaintext_size.saturating_mul(2).max(10 * 1024 * 1024);
    let parent = paths
        .plaintext
        .parent()
        .unwrap_or_else(|| Path::new("."));
    let avail = free_space(parent).unwrap_or(u64::MAX);
    if avail < needed {
        return Err(MigrationError::NoSpace {
            needed_bytes: needed,
            available_bytes: avail,
        });
    }
    writeln!(
        progress,
        "[migrate] plaintext={} bytes, need>={} bytes, avail={} bytes",
        plaintext_size, needed, avail
    )?;

    // Flip state to Encrypting BEFORE any destructive work, so a crash
    // between here and the atomic rename is recoverable.
    envelope.migration_state = MigrationState::Encrypting;
    security::save_envelope(&paths.envelope, envelope)?;
    writeln!(progress, "[migrate] state = Encrypting")?;

    // Run sqlcipher_export into `.encrypting`.
    encryptor
        .encrypt_new(&paths.plaintext, &encrypting_path, mdk_hex)
        .map_err(MigrationError::EncryptionFailed)?;
    writeln!(
        progress,
        "[migrate] wrote encrypted temp: {}",
        encrypting_path.display()
    )?;

    // Verify: integrity check + row count parity.
    let integrity = encryptor
        .integrity_check(&encrypting_path, mdk_hex)
        .map_err(MigrationError::IntegrityFailed)?;
    if integrity != "ok" {
        return Err(MigrationError::IntegrityFailed(integrity));
    }
    let src_rows = encryptor
        .total_row_count(&paths.plaintext, None)
        .map_err(MigrationError::EncryptionFailed)?;
    let dst_rows = encryptor
        .total_row_count(&encrypting_path, Some(mdk_hex))
        .map_err(MigrationError::EncryptionFailed)?;
    if src_rows != dst_rows {
        return Err(MigrationError::RowCountMismatch {
            plaintext: src_rows,
            encrypted: dst_rows,
        });
    }
    writeln!(
        progress,
        "[migrate] verified: integrity=ok, rows_src={}, rows_dst={}",
        src_rows, dst_rows
    )?;

    // Sync then atomically replace plaintext with encrypted.
    // Order matters: we delete plaintext sidecars BEFORE the rename so
    // there are never stale echelon.db-wal / echelon.db-shm files
    // pointing at what is now an encrypted DB. The plaintext DB itself
    // is superseded by the rename.
    let _ = sync_dir(parent);
    purge_sqlite_sidecars_only(&paths.plaintext);
    atomic_replace(&encrypting_path, &paths.plaintext)?;
    writeln!(progress, "[migrate] atomic rename complete")?;

    // Flip state to Encrypted only AFTER the rename succeeds.
    envelope.migration_state = MigrationState::Encrypted;
    security::save_envelope(&paths.envelope, envelope)?;
    writeln!(progress, "[migrate] state = Encrypted ✅")?;

    Ok(())
}

/// Called on every app launch. If we crashed during migration, clean up
/// the partial `.encrypting` file so the next attempt starts fresh.
pub fn resume_or_rollback(
    paths: &Paths,
    envelope: &mut SecurityEnvelope,
) -> Result<(), MigrationError> {
    if envelope.migration_state == MigrationState::Encrypting {
        let leftover = paths.encrypting();
        if leftover.exists() {
            let _ = std::fs::remove_file(&leftover);
        }
        // Plaintext DB was never touched — safe to reset state.
        envelope.migration_state = MigrationState::Plaintext;
        security::save_envelope(&paths.envelope, envelope)?;
    }
    Ok(())
}

/// Delete ONLY the -wal, -shm, -journal sidecars, never the main file.
/// Used during migration to strip plaintext-flavoured sidecars just
/// before we rename the encrypted DB over the plaintext file. The main
/// plaintext file itself is superseded (and overwritten) by the rename.
fn purge_sqlite_sidecars_only(base: &Path) {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut p = base.as_os_str().to_owned();
        p.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
}

// ────────────────────────────────────────────────────────────────────────
// Tests — use StubEncryptor
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Fake encryptor: "encrypts" by copying + prefixing bytes.
    /// Integrity always ok, row count derived from file size.
    /// Injectable failures let us exercise error branches.
    struct StubEncryptor {
        integrity_result: String,
        fail_encrypt: bool,
        row_count_override: Option<u64>,
    }

    impl Default for StubEncryptor {
        fn default() -> Self {
            Self {
                integrity_result: "ok".to_string(),
                fail_encrypt: false,
                row_count_override: None,
            }
        }
    }

    impl Encryptor for StubEncryptor {
        fn encrypt_new(
            &self,
            src: &Path,
            dst: &Path,
            _mdk_hex: &str,
        ) -> Result<(), String> {
            if self.fail_encrypt {
                return Err("stub-injected failure".into());
            }
            let mut src_bytes = std::fs::read(src).map_err(|e| e.to_string())?;
            let mut out = b"ENC:".to_vec();
            out.append(&mut src_bytes);
            std::fs::write(dst, out).map_err(|e| e.to_string())?;
            Ok(())
        }

        fn integrity_check(&self, _path: &Path, _mdk_hex: &str) -> Result<String, String> {
            Ok(self.integrity_result.clone())
        }

        fn total_row_count(
            &self,
            path: &Path,
            mdk_hex: Option<&str>,
        ) -> Result<u64, String> {
            // Override only applies to the encrypted read so tests can
            // simulate a broken export that produces wrong row counts.
            if let (Some(n), Some(_)) = (self.row_count_override, mdk_hex) {
                return Ok(n);
            }
            // Row count = plaintext file size, ENC prefix removed if present.
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let n = if bytes.starts_with(b"ENC:") {
                (bytes.len() - 4) as u64
            } else {
                bytes.len() as u64
            };
            Ok(n)
        }
    }

    fn setup(dir: &Path) -> Paths {
        let plaintext = dir.join("echelon.db");
        std::fs::write(&plaintext, b"pretend this is a real sqlite db").unwrap();
        // Add sidecars to make sure they're cleaned up.
        std::fs::write(dir.join("echelon.db-wal"), b"stale wal").unwrap();
        std::fs::write(dir.join("echelon.db-shm"), b"stale shm").unwrap();
        Paths {
            plaintext,
            envelope: dir.join("security.json"),
        }
    }

    fn seed_envelope(paths: &Paths) -> SecurityEnvelope {
        let mdk = security::Mdk::generate();
        let slot = security::wrap_mdk(
            security::SlotKind::Pin,
            &mdk,
            b"pin",
            b"dev-secret",
            security::ArgonParams { m_cost_kib: 1024, t_cost: 1, p_cost: 1 },
        )
        .unwrap();
        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(slot);
        security::save_envelope(&paths.envelope, &env).unwrap();
        env
    }

    #[test]
    fn happy_path_migrates_and_cleans_sidecars() {
        let d = tempfile::tempdir().unwrap();
        let paths = setup(d.path());
        let mut env = seed_envelope(&paths);
        let mut log = Vec::<u8>::new();
        migrate_to_encrypted(
            &StubEncryptor::default(),
            &paths,
            "deadbeef",
            &mut env,
            &mut log,
        )
        .expect("migration");

        assert_eq!(env.migration_state, MigrationState::Encrypted);
        // Main DB now contains the "encrypted" bytes.
        let after = std::fs::read(&paths.plaintext).unwrap();
        assert!(after.starts_with(b"ENC:"));
        // Sidecars purged.
        assert!(!d.path().join("echelon.db-wal").exists());
        assert!(!d.path().join("echelon.db-shm").exists());
        // Temp encrypting file cleaned up.
        assert!(!paths.encrypting().exists());
        // Envelope reflects state.
        let reloaded = security::load_envelope(&paths.envelope).unwrap();
        assert_eq!(reloaded.migration_state, MigrationState::Encrypted);
    }

    #[test]
    fn crash_between_state_flip_and_rename_is_recoverable() {
        let d = tempfile::tempdir().unwrap();
        let paths = setup(d.path());
        let mut env = seed_envelope(&paths);

        // Simulate crash: flip state to Encrypting, leave an .encrypting file.
        env.migration_state = MigrationState::Encrypting;
        security::save_envelope(&paths.envelope, &env).unwrap();
        std::fs::write(paths.encrypting(), b"partial junk from previous run").unwrap();

        // Recovery pass on next launch.
        resume_or_rollback(&paths, &mut env).unwrap();
        assert_eq!(env.migration_state, MigrationState::Plaintext);
        assert!(!paths.encrypting().exists());
        // Plaintext DB is untouched.
        let content = std::fs::read(&paths.plaintext).unwrap();
        assert_eq!(content, b"pretend this is a real sqlite db");

        // A fresh migration attempt now succeeds.
        let mut log = Vec::<u8>::new();
        migrate_to_encrypted(
            &StubEncryptor::default(),
            &paths,
            "deadbeef",
            &mut env,
            &mut log,
        )
        .unwrap();
        assert_eq!(env.migration_state, MigrationState::Encrypted);
    }

    #[test]
    fn already_encrypted_is_noop() {
        let d = tempfile::tempdir().unwrap();
        let paths = setup(d.path());
        let mut env = seed_envelope(&paths);
        env.migration_state = MigrationState::Encrypted;
        let original = std::fs::read(&paths.plaintext).unwrap();
        let mut log = Vec::<u8>::new();
        migrate_to_encrypted(
            &StubEncryptor::default(),
            &paths,
            "deadbeef",
            &mut env,
            &mut log,
        )
        .unwrap();
        // File is unchanged.
        assert_eq!(std::fs::read(&paths.plaintext).unwrap(), original);
    }

    #[test]
    fn encrypt_failure_leaves_plaintext_and_envelope_recoverable() {
        let d = tempfile::tempdir().unwrap();
        let paths = setup(d.path());
        let mut env = seed_envelope(&paths);
        let stub = StubEncryptor { fail_encrypt: true, ..Default::default() };
        let mut log = Vec::<u8>::new();
        let err = migrate_to_encrypted(&stub, &paths, "deadbeef", &mut env, &mut log)
            .unwrap_err();
        assert!(matches!(err, MigrationError::EncryptionFailed(_)));
        // Plaintext untouched.
        assert_eq!(
            std::fs::read(&paths.plaintext).unwrap(),
            b"pretend this is a real sqlite db"
        );
        // State was flipped to Encrypting but no encrypted file was produced.
        // resume_or_rollback should clean it up.
        assert_eq!(env.migration_state, MigrationState::Encrypting);
        resume_or_rollback(&paths, &mut env).unwrap();
        assert_eq!(env.migration_state, MigrationState::Plaintext);
    }

    #[test]
    fn integrity_failure_returns_error() {
        let d = tempfile::tempdir().unwrap();
        let paths = setup(d.path());
        let mut env = seed_envelope(&paths);
        let stub = StubEncryptor {
            integrity_result: "corrupt: page 5".into(),
            ..Default::default()
        };
        let mut log = Vec::<u8>::new();
        let err =
            migrate_to_encrypted(&stub, &paths, "deadbeef", &mut env, &mut log).unwrap_err();
        assert!(matches!(err, MigrationError::IntegrityFailed(_)));
    }

    #[test]
    fn row_count_mismatch_returns_error() {
        let d = tempfile::tempdir().unwrap();
        let paths = setup(d.path());
        let mut env = seed_envelope(&paths);
        let stub = StubEncryptor {
            row_count_override: Some(0), // pretends dst has 0 rows
            ..Default::default()
        };
        let mut log = Vec::<u8>::new();
        let err =
            migrate_to_encrypted(&stub, &paths, "deadbeef", &mut env, &mut log).unwrap_err();
        assert!(matches!(err, MigrationError::RowCountMismatch { .. }));
    }

    #[test]
    fn missing_plaintext_returns_error() {
        let d = tempfile::tempdir().unwrap();
        let paths = Paths {
            plaintext: d.path().join("does-not-exist.db"),
            envelope: d.path().join("security.json"),
        };
        let mut env = SecurityEnvelope::new_empty();
        let _ = security::save_envelope(&paths.envelope, &env);
        let mut log = Vec::<u8>::new();
        let err =
            migrate_to_encrypted(&StubEncryptor::default(), &paths, "x", &mut env, &mut log)
                .unwrap_err();
        assert!(matches!(err, MigrationError::PlaintextMissing(_)));
    }

    #[test]
    fn stale_encrypting_file_is_wiped_before_new_run() {
        let d = tempfile::tempdir().unwrap();
        let paths = setup(d.path());
        std::fs::write(paths.encrypting(), b"stale from crash").unwrap();
        let mut env = seed_envelope(&paths);
        let mut log = Vec::<u8>::new();
        migrate_to_encrypted(
            &StubEncryptor::default(),
            &paths,
            "deadbeef",
            &mut env,
            &mut log,
        )
        .unwrap();
        assert_eq!(env.migration_state, MigrationState::Encrypted);
    }

    #[test]
    fn purge_sidecars_only_leaves_main_file() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().join("db.db");
        std::fs::write(&base, b"main").unwrap();
        std::fs::write(d.path().join("db.db-wal"), b"wal").unwrap();
        std::fs::write(d.path().join("db.db-shm"), b"shm").unwrap();
        std::fs::write(d.path().join("db.db-journal"), b"j").unwrap();

        purge_sqlite_sidecars_only(&base);

        assert!(base.exists(), "main file must survive");
        assert!(!d.path().join("db.db-wal").exists());
        assert!(!d.path().join("db.db-shm").exists());
        assert!(!d.path().join("db.db-journal").exists());
    }

    #[test]
    fn purge_all_removes_main_and_sidecars() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().join("db.db");
        std::fs::write(&base, b"main").unwrap();
        std::fs::write(d.path().join("db.db-wal"), b"wal").unwrap();

        purge_sqlite_files(&base);
        assert!(!base.exists());
        assert!(!d.path().join("db.db-wal").exists());
    }

    #[test]
    fn free_space_returns_positive_on_temp() {
        let d = tempfile::tempdir().unwrap();
        let bytes = free_space(d.path()).unwrap();
        assert!(bytes > 0);
    }
}
