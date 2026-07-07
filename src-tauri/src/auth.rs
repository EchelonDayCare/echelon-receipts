// v2.0.0 auth glue.
//
// Ties together the crypto primitives (security), device-bound secret
// (device_secret), migration state machine (db_migration), and
// runtime DB gate (db_gate) into a small set of Tauri commands the
// frontend uses to drive the setup wizard, AppLock overlay, and
// change-PIN screen.
//
// State machine (from the frontend's point of view):
//   NotSetUp   — no security.json yet. Show setup wizard.
//   Locked     — security.json exists and DB is encrypted; AppLock
//                overlay must be shown until unlock succeeds.
//   Unlocked   — MDK is in memory, db_gate has an encrypted connection
//                open, app is usable.
//
// Every failed PIN attempt costs Argon2 work by construction. No
// separate throttle needed for v2.0.0 (m=19 MiB, t=2 = ~1 s per
// attempt on typical hardware). Days 8-9 UI adds an incremental delay
// for cosmetic safety after 5 failed attempts.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::Manager;

use crate::db_gate::DbGate;
use crate::db_migration::{self, Encryptor, MigrationError, Paths};
use crate::device_secret;
use crate::security::{
    self, ArgonParams, Mdk, MigrationState, SecurityEnvelope, SecurityError, Slot, SlotKind,
};

// ────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("crypto: {0}")]
    Security(#[from] SecurityError),

    #[error("device secret: {0}")]
    DeviceSecret(#[from] device_secret::DeviceSecretError),

    #[error("db: {0}")]
    Db(#[from] crate::db_gate::DbError),

    #[error("migration: {0}")]
    Migration(#[from] MigrationError),

    #[error("no security envelope on disk")]
    NotSetUp,

    #[error("already set up")]
    AlreadySetUp,

    #[error("wrong PIN")]
    WrongPin,

    #[error("app handle unavailable")]
    NoAppHandle,
}

impl serde::Serialize for AuthError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ────────────────────────────────────────────────────────────────────────
// Shared in-memory state
// ────────────────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
pub struct AuthState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    /// Unlocked MDK bytes. `None` when locked or not yet set up.
    /// Never leaves this module. When set to `None`, the previous Mdk
    /// value is dropped which zeroises the bytes.
    mdk: Option<Mdk>,
}

impl AuthState {
    pub fn new() -> Self {
        Self::default()
    }

    fn set_mdk(&self, mdk: Mdk) {
        let mut g = self.inner.lock().unwrap();
        g.mdk = Some(mdk);
    }

    fn take_mdk(&self) -> Option<Mdk> {
        let mut g = self.inner.lock().unwrap();
        g.mdk.take()
    }

    fn has_mdk(&self) -> bool {
        self.inner.lock().unwrap().mdk.is_some()
    }
}

// ────────────────────────────────────────────────────────────────────────
// SQLCipher-backed Encryptor
// ────────────────────────────────────────────────────────────────────────

/// Real implementation of db_migration::Encryptor using rusqlite's
/// bundled SQLCipher. Runs `sqlcipher_export()` via ATTACH DATABASE to
/// convert a plaintext DB into an encrypted one.
pub struct SqlCipherExporter;

impl Encryptor for SqlCipherExporter {
    fn encrypt_new(
        &self,
        src_plaintext: &Path,
        dst_encrypted: &Path,
        mdk_hex: &str,
    ) -> Result<(), String> {
        use rusqlite::Connection;
        let conn = Connection::open(src_plaintext).map_err(|e| e.to_string())?;
        // sqlcipher_export copies schema+data from `main` into the
        // aliased attached DB. The attached DB is opened with a fresh
        // key so its file becomes SQLCipher-encrypted on disk.
        let dst = dst_encrypted.to_string_lossy().replace('\'', "''");
        let attach = format!(
            "ATTACH DATABASE '{}' AS encrypted KEY \"x'{}'\"",
            dst, mdk_hex
        );
        conn.execute_batch(&attach).map_err(|e| e.to_string())?;
        conn.execute_batch("SELECT sqlcipher_export('encrypted')")
            .map_err(|e| e.to_string())?;
        conn.execute_batch("DETACH DATABASE encrypted")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn integrity_check(&self, path: &Path, mdk_hex: &str) -> Result<String, String> {
        use rusqlite::Connection;
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let key = format!("PRAGMA key = \"x'{}'\"", mdk_hex);
        conn.execute_batch(&key).map_err(|e| e.to_string())?;
        let result: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        Ok(result)
    }

    fn total_row_count(&self, path: &Path, mdk_hex: Option<&str>) -> Result<u64, String> {
        use rusqlite::Connection;
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        if let Some(hex) = mdk_hex {
            let key = format!("PRAGMA key = \"x'{}'\"", hex);
            conn.execute_batch(&key).map_err(|e| e.to_string())?;
        }
        // Sum row counts across every user table. Excludes sqlite_
        // and _migrations bookkeeping so a re-run in a fresh envelope
        // doesn't create a spurious mismatch.
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' \
                 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut total: u64 = 0;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let name: String = row.get(0).map_err(|e| e.to_string())?;
            // Quote table name defensively even though we filtered on the pattern.
            let sql = format!("SELECT count(*) FROM \"{}\"", name.replace('"', "\"\""));
            let n: i64 = conn
                .query_row(&sql, [], |r| r.get(0))
                .map_err(|e| format!("count({}): {}", name, e))?;
            total = total.saturating_add(n.max(0) as u64);
        }
        Ok(total)
    }
}

// ────────────────────────────────────────────────────────────────────────
// Path helpers
// ────────────────────────────────────────────────────────────────────────

fn envelope_path(app: &tauri::AppHandle) -> Result<PathBuf, AuthError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AuthError::NoAppHandle)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("security.json"))
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, AuthError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AuthError::NoAppHandle)?;
    Ok(dir.join("echelon.db"))
}

// ────────────────────────────────────────────────────────────────────────
// State reporting
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2State {
    /// True once security.json exists.
    pub is_set_up: bool,
    /// True when the MDK is in memory and db_gate has an encrypted
    /// connection open (or has a plaintext connection open pre-migration).
    pub is_unlocked: bool,
    pub migration_state: &'static str,
}

fn migration_state_str(s: MigrationState) -> &'static str {
    match s {
        MigrationState::Plaintext => "plaintext",
        MigrationState::Encrypting => "encrypting",
        MigrationState::Encrypted => "encrypted",
    }
}

// ────────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn v2_state(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
) -> Result<V2State, AuthError> {
    let env_path = envelope_path(&app)?;
    // is_set_up requires BOTH an envelope AND migration_state == Encrypted.
    // A stale envelope with Plaintext/Encrypting state means a prior setup
    // crashed before the DB was actually encrypted; treat as not set up so
    // the user can retry the wizard instead of being stuck at a PIN prompt
    // that can't unlock a plaintext DB.
    let (is_set_up, migration_state) = if env_path.exists() {
        let env = security::load_envelope(&env_path)?;
        let done = env.migration_state == MigrationState::Encrypted;
        (done, env.migration_state)
    } else {
        (false, MigrationState::Plaintext)
    };
    Ok(V2State {
        is_set_up,
        is_unlocked: auth.has_mdk(),
        migration_state: migration_state_str(migration_state),
    })
}

/// Create a fresh envelope with a single PIN slot. Then run the
/// plaintext -> SQLCipher migration and reopen db_gate on the
/// encrypted DB with the new MDK.
///
/// This is the terminal step of the setup wizard.
#[tauri::command]
pub async fn v2_create_pin(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    gate: tauri::State<'_, DbGate>,
    pin: String,
) -> Result<(), AuthError> {
    let env_path = envelope_path(&app)?;
    if env_path.exists() {
        return Err(AuthError::AlreadySetUp);
    }
    // Fresh device-bound secret + fresh MDK.
    let device_secret = device_secret::get_or_create()?;
    let mdk = Mdk::generate();

    // Wrap the MDK with the PIN + device_secret.
    let slot = security::wrap_mdk(
        SlotKind::Pin,
        &mdk,
        pin.as_bytes(),
        &device_secret,
        ArgonParams::default(),
    )?;
    let mut env = SecurityEnvelope::new_empty();
    env.upsert_slot(slot);
    security::save_envelope(&env_path, &env)?;

    // Encrypt the plaintext DB in place.
    let db = db_path(&app)?;
    let paths = Paths {
        plaintext: db.clone(),
        envelope: env_path.clone(),
    };
    // Close current plaintext connection so migration has exclusive
    // file access. Otherwise the running WAL blocks the rename.
    gate.close().await;

    let mdk_hex = mdk.as_pragma_hex();
    let mut sink = Vec::<u8>::new();
    db_migration::migrate_to_encrypted(
        &SqlCipherExporter,
        &paths,
        &mdk_hex,
        &mut env,
        &mut sink,
    )?;

    // Reopen the (now-encrypted) DB with the fresh MDK.
    gate.open_encrypted(&db, &mdk).await?;
    auth.set_mdk(mdk);
    Ok(())
}

/// Unlock: derive MDK from PIN + device_secret + envelope, verify by
/// opening the SQLCipher DB with it, stash MDK for the session.
#[tauri::command]
pub async fn v2_unlock(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    gate: tauri::State<'_, DbGate>,
    pin: String,
) -> Result<(), AuthError> {
    let env_path = envelope_path(&app)?;
    let env = security::load_envelope(&env_path)?;
    let slot = env
        .find_slot(SlotKind::Pin)
        .ok_or(AuthError::NotSetUp)?
        .clone();
    let device_secret = device_secret::get_or_create()?;
    let mdk = match security::unwrap_mdk(&slot, pin.as_bytes(), &device_secret) {
        Ok(m) => m,
        Err(SecurityError::Authentication) => return Err(AuthError::WrongPin),
        Err(e) => return Err(e.into()),
    };
    // Close any pre-migration plaintext connection and reopen encrypted.
    gate.close().await;
    let db = db_path(&app)?;
    gate.open_encrypted(&db, &mdk).await?;
    auth.set_mdk(mdk);
    Ok(())
}

/// Zeroise the MDK and drop the db_gate connection.
#[tauri::command]
pub async fn v2_lock(
    auth: tauri::State<'_, AuthState>,
    gate: tauri::State<'_, DbGate>,
) -> Result<(), AuthError> {
    let _ = auth.take_mdk(); // Drop zeroises the MDK bytes.
    gate.close().await;
    Ok(())
}

/// Re-wrap the existing MDK under a new PIN. Existing sessions stay
/// unlocked (MDK unchanged); only future unlocks use the new PIN.
#[tauri::command]
pub async fn v2_change_pin(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    old_pin: String,
    new_pin: String,
) -> Result<(), AuthError> {
    let env_path = envelope_path(&app)?;
    let mut env = security::load_envelope(&env_path)?;
    let slot = env
        .find_slot(SlotKind::Pin)
        .ok_or(AuthError::NotSetUp)?
        .clone();
    let device_secret = device_secret::get_or_create()?;
    // Verify old PIN by unwrapping.
    let mdk = match security::unwrap_mdk(&slot, old_pin.as_bytes(), &device_secret) {
        Ok(m) => m,
        Err(SecurityError::Authentication) => return Err(AuthError::WrongPin),
        Err(e) => return Err(e.into()),
    };
    // Wrap same MDK under new PIN and persist.
    let new_slot = security::wrap_mdk(
        SlotKind::Pin,
        &mdk,
        new_pin.as_bytes(),
        &device_secret,
        ArgonParams::default(),
    )?;
    env.upsert_slot(new_slot);
    security::save_envelope(&env_path, &env)?;
    // Session MDK unchanged.
    if !auth.has_mdk() {
        auth.set_mdk(mdk);
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Full end-to-end: plaintext DB -> setup with PIN -> encrypted DB
    /// -> lock -> unlock -> change PIN -> unlock with new PIN.
    /// Runs without the Tauri app (uses AuthState + SqlCipherExporter
    /// + DbGate directly against a tempdir).
    #[tokio::test]
    async fn full_setup_unlock_change_pin_cycle() {
        let d = tempfile::tempdir().unwrap();
        let db = d.path().join("echelon.db");
        let env_path = d.path().join("security.json");

        // Seed a plaintext DB with some rows.
        {
            let c = Connection::open(&db).unwrap();
            c.execute_batch(
                "CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT);\
                 INSERT INTO students(name) VALUES('Alice'),('Bob'),('Carol');",
            )
            .unwrap();
        }

        let gate = DbGate::new();
        let auth = AuthState::new();
        gate.open_plaintext(&db).await.unwrap();

        // Manual setup (bypasses AppHandle path helpers).
        let device_secret = device_secret::get_or_create().unwrap();
        let mdk = Mdk::generate();
        let mdk_bytes_snapshot = *mdk.as_bytes();
        let slot = security::wrap_mdk(
            SlotKind::Pin,
            &mdk,
            b"123456",
            &device_secret,
            ArgonParams { m_cost_kib: 1024, t_cost: 1, p_cost: 1 },
        )
        .unwrap();
        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(slot);
        security::save_envelope(&env_path, &env).unwrap();

        gate.close().await;
        let paths = Paths { plaintext: db.clone(), envelope: env_path.clone() };
        let mut sink = Vec::<u8>::new();
        db_migration::migrate_to_encrypted(
            &SqlCipherExporter,
            &paths,
            &mdk.as_pragma_hex(),
            &mut env,
            &mut sink,
        )
        .expect("migration should succeed");

        // The DB is now encrypted — the file must not start with the
        // SQLite magic.
        let header = std::fs::read(&db).unwrap();
        assert!(!header.starts_with(b"SQLite format 3\0"));

        // Reopen encrypted with the same MDK and confirm data is intact.
        gate.open_encrypted(&db, &mdk).await.unwrap();
        auth.set_mdk(mdk);
        let rows = gate.select("SELECT count(*) AS n FROM students", &[]).await.unwrap();
        assert_eq!(rows[0].get("n").unwrap().as_i64().unwrap(), 3);

        // Lock.
        let _ = auth.take_mdk();
        gate.close().await;
        assert!(!auth.has_mdk());
        assert!(!gate.is_open().await);

        // Wrong PIN.
        let env2 = security::load_envelope(&env_path).unwrap();
        let slot = env2.find_slot(SlotKind::Pin).unwrap();
        let wrong = security::unwrap_mdk(slot, b"000000", &device_secret);
        assert!(matches!(wrong, Err(SecurityError::Authentication)));

        // Correct PIN.
        let mdk2 = security::unwrap_mdk(slot, b"123456", &device_secret).unwrap();
        assert_eq!(mdk2.as_bytes(), &mdk_bytes_snapshot);
        gate.open_encrypted(&db, &mdk2).await.unwrap();
        let rows = gate.select("SELECT count(*) AS n FROM students", &[]).await.unwrap();
        assert_eq!(rows[0].get("n").unwrap().as_i64().unwrap(), 3);

        // Change PIN: rewrap same MDK.
        let new_slot = security::wrap_mdk(
            SlotKind::Pin,
            &mdk2,
            b"999999",
            &device_secret,
            ArgonParams { m_cost_kib: 1024, t_cost: 1, p_cost: 1 },
        )
        .unwrap();
        let mut env3 = security::load_envelope(&env_path).unwrap();
        env3.upsert_slot(new_slot);
        security::save_envelope(&env_path, &env3).unwrap();

        // Old PIN no longer works.
        let env4 = security::load_envelope(&env_path).unwrap();
        let s4 = env4.find_slot(SlotKind::Pin).unwrap();
        let old_fail = security::unwrap_mdk(s4, b"123456", &device_secret);
        assert!(matches!(old_fail, Err(SecurityError::Authentication)));
        // New PIN works and unlocks the same MDK.
        let mdk3 = security::unwrap_mdk(s4, b"999999", &device_secret).unwrap();
        assert_eq!(mdk3.as_bytes(), &mdk_bytes_snapshot);

        // Clean up so the test doesn't leave a device-secret keychain
        // entry around across runs.
        let _ = device_secret::delete();
    }

    #[test]
    fn sqlcipher_exporter_encrypts_and_verifies() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("src.db");
        let dst = d.path().join("dst.db");
        {
            let c = Connection::open(&src).unwrap();
            c.execute_batch(
                "CREATE TABLE t(id INTEGER, v TEXT);\
                 INSERT INTO t VALUES(1,'a'),(2,'b'),(3,'c');",
            )
            .unwrap();
        }
        let mdk = Mdk::generate();
        let hex = mdk.as_pragma_hex();
        SqlCipherExporter.encrypt_new(&src, &dst, &hex).unwrap();

        let integrity = SqlCipherExporter.integrity_check(&dst, &hex).unwrap();
        assert_eq!(integrity, "ok");
        let n = SqlCipherExporter.total_row_count(&dst, Some(&hex)).unwrap();
        assert_eq!(n, 3);

        // File header must not be plaintext SQLite magic.
        let header = std::fs::read(&dst).unwrap();
        assert!(!header.starts_with(b"SQLite format 3\0"));
    }
}
