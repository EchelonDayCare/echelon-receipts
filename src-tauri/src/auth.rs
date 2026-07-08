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
use std::time::{Duration, Instant};

use subtle::ConstantTimeEq;
use tauri::Manager;
use zeroize::Zeroizing;

use crate::db_gate::DbGate;
use crate::db_migration::{self, Encryptor, MigrationError, Paths};
use crate::device_secret;
use crate::security::{
    self, ArgonParams, Mdk, MigrationState, SecurityEnvelope, SecurityError, SlotKind,
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

    #[error("too many failed attempts; retry after {retry_after_secs} s")]
    RateLimited { retry_after_secs: u64 },

    #[error("recovery code invalid or does not match this device's data")]
    RecoveryInvalid,

    #[error("recovery not configured")]
    RecoveryMissing,

    #[error("PIN must be at least 6 characters")]
    PinTooShort,
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

    /// Wrong-PIN attempt timestamps within the current window. Used
    /// to enforce a Rust-side rate limit that a compromised frontend
    /// cannot bypass by re-invoking Tauri commands directly.
    attempts: Vec<Instant>,

    /// If Some(t), reject unlock attempts until now >= t.
    lockout_until: Option<Instant>,

    /// Separate counter for step-up proof attempts (PIN reset / recovery
    /// generation). Kept apart from `attempts` so a failed sensitive-op
    /// proof cannot lock the user out of the normal unlock flow, and
    /// vice versa.
    step_up_attempts: Vec<Instant>,
    step_up_lockout_until: Option<Instant>,
}

/// Proof of ownership required to change sensitive authentication state
/// (reset PIN, regenerate recovery code). The proof must unwrap to the
/// same MDK currently backing the unlocked session — see
/// `verify_step_up` for the binding check that prevents envelope-tamper
/// attacks against an unlocked session.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepUpProof {
    Pin { pin: String },
    Recovery { code: String },
}

// Rate-limit policy: after this many failures in ATTEMPT_WINDOW,
// apply an increasing cool-off before the next attempt is honoured.
const MAX_ATTEMPTS: usize = 5;
const ATTEMPT_WINDOW: Duration = Duration::from_secs(5 * 60);

/// Cool-off ladder — grows with successive lockouts within the window.
fn cool_off_for(prior_attempts: usize) -> Duration {
    match prior_attempts {
        0..=4 => Duration::from_secs(0),
        5..=9 => Duration::from_secs(60),
        10..=14 => Duration::from_secs(5 * 60),
        _ => Duration::from_secs(30 * 60),
    }
}

impl AuthState {
    pub fn new() -> Self {
        Self::default()
    }

    fn set_mdk(&self, mdk: Mdk) {
        let mut g = self.inner.lock().unwrap();
        g.mdk = Some(mdk);
        g.attempts.clear();
        g.lockout_until = None;
    }

    fn take_mdk(&self) -> Option<Mdk> {
        let mut g = self.inner.lock().unwrap();
        g.mdk.take()
    }

    fn has_mdk(&self) -> bool {
        self.inner.lock().unwrap().mdk.is_some()
    }

    /// Return a copy of the currently-loaded MDK, if any. Used by the
    /// "change PIN while unlocked" flow (e.g. after unlocking via recovery
    /// code when the user has forgotten their PIN).
    fn clone_mdk(&self) -> Option<Mdk> {
        let g = self.inner.lock().unwrap();
        g.mdk.as_ref().map(|m| Mdk::from_bytes(*m.as_bytes()))
    }

    /// Check whether unlock is currently rate-limited. Returns
    /// `Err(RateLimited)` with remaining seconds if so.
    fn check_rate_limit(&self) -> Result<(), AuthError> {
        let mut g = self.inner.lock().unwrap();
        if let Some(until) = g.lockout_until {
            let now = Instant::now();
            if now < until {
                return Err(AuthError::RateLimited {
                    retry_after_secs: (until - now).as_secs().max(1),
                });
            } else {
                // Cool-off expired: clear the deadline but keep
                // the attempt counter so subsequent failures escalate.
                g.lockout_until = None;
            }
        }
        Ok(())
    }

    /// Record a failed unlock attempt. Prunes old attempts, then
    /// sets a lockout if we're past MAX_ATTEMPTS in the window.
    fn record_failure(&self) {
        let mut g = self.inner.lock().unwrap();
        let now = Instant::now();
        g.attempts.retain(|t| now.duration_since(*t) < ATTEMPT_WINDOW);
        g.attempts.push(now);
        let n = g.attempts.len();
        let cool = cool_off_for(n);
        if !cool.is_zero() {
            g.lockout_until = Some(now + cool);
        }
    }

    /// Step-up-proof rate limit. Independent counter from unlock so a
    /// failed proof cannot lock users out of the normal unlock path.
    fn check_step_up_rate_limit(&self) -> Result<(), AuthError> {
        let mut g = self.inner.lock().unwrap();
        if let Some(until) = g.step_up_lockout_until {
            let now = Instant::now();
            if now < until {
                return Err(AuthError::RateLimited {
                    retry_after_secs: (until - now).as_secs().max(1),
                });
            } else {
                g.step_up_lockout_until = None;
            }
        }
        Ok(())
    }

    fn record_step_up_failure(&self) {
        let mut g = self.inner.lock().unwrap();
        let now = Instant::now();
        g.step_up_attempts.retain(|t| now.duration_since(*t) < ATTEMPT_WINDOW);
        g.step_up_attempts.push(now);
        let n = g.step_up_attempts.len();
        let cool = cool_off_for(n);
        if !cool.is_zero() {
            g.step_up_lockout_until = Some(now + cool);
        }
    }

    /// Verify a fresh proof of ownership. Succeeds only if the proof
    /// unwraps to the same MDK currently backing the unlocked session.
    ///
    /// Rationale for the MDK-binding step: if `security.json` were
    /// tampered while the app is unlocked (e.g. a malicious process
    /// injected a forged recovery slot whose secret the attacker knows),
    /// naive slot-unwrap would accept the forged proof. Requiring the
    /// unwrapped MDK to match the *live* session MDK closes that gap —
    /// the attacker must know a credential that unwraps to the real DB
    /// key, not just to some new envelope entry.
    ///
    /// Uses a separate rate-limit counter from unlock so a failed
    /// sensitive-op proof cannot lock users out of the normal unlock
    /// path.
    fn verify_step_up(
        &self,
        env: &crate::security::SecurityEnvelope,
        proof: &StepUpProof,
    ) -> Result<(), AuthError> {
        self.check_step_up_rate_limit()?;

        let device_secret = device_secret::get_or_create()?;
        let unwrapped: Mdk = match proof {
            StepUpProof::Pin { pin } => {
                let slot = env
                    .find_slot(SlotKind::Pin)
                    .ok_or(AuthError::NotSetUp)?
                    .clone();
                match security::unwrap_mdk(&slot, pin.as_bytes(), &device_secret) {
                    Ok(m) => m,
                    Err(SecurityError::Authentication) => {
                        self.record_step_up_failure();
                        return Err(AuthError::WrongPin);
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            StepUpProof::Recovery { code } => {
                let slot = env
                    .find_slot(SlotKind::Recovery)
                    .ok_or(AuthError::RecoveryMissing)?
                    .clone();
                let bytes = parse_recovery_code(code)?;
                match security::unwrap_mdk(&slot, &bytes, b"") {
                    Ok(m) => m,
                    Err(SecurityError::Authentication) => {
                        self.record_step_up_failure();
                        return Err(AuthError::RecoveryInvalid);
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        };

        // Bind: the unwrapped MDK must equal the live session MDK.
        let session = self.clone_mdk().ok_or(AuthError::NotSetUp)?;
        // Constant-time comparison — never leak timing on the key bytes.
        if unwrapped.as_bytes().ct_eq(session.as_bytes()).unwrap_u8() != 1 {
            self.record_step_up_failure();
            // Opaque error — don't reveal *which* half failed.
            return Err(match proof {
                StepUpProof::Pin { .. } => AuthError::WrongPin,
                StepUpProof::Recovery { .. } => AuthError::RecoveryInvalid,
            });
        }
        Ok(())
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
        // The ATTACH string contains the raw MDK — keep it in a
        // Zeroizing<String> so the heap allocation is wiped on drop
        // and never lingers in a swap file / memory dump.
        let dst = dst_encrypted.to_string_lossy().replace('\'', "''");
        let attach = Zeroizing::new(format!(
            "ATTACH DATABASE '{}' AS encrypted KEY \"x'{}'\"",
            dst, mdk_hex
        ));
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
        let key = Zeroizing::new(format!("PRAGMA key = \"x'{}'\"", mdk_hex));
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
            let key = Zeroizing::new(format!("PRAGMA key = \"x'{}'\"", hex));
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
    /// True once security.json exists AND migration is complete (Encrypted).
    pub is_set_up: bool,
    /// True when the MDK is in memory and db_gate has an encrypted
    /// connection open (or has a plaintext connection open pre-migration).
    pub is_unlocked: bool,
    pub migration_state: &'static str,
    /// True iff the envelope file exists but could not be loaded
    /// (corrupted JSON, unsupported version, I/O error). When set,
    /// the frontend must fail closed and refuse to render the app.
    pub envelope_error: Option<String>,
    /// True iff a recovery slot has been provisioned. UI uses this to
    /// show/hide the "Show recovery kit" button in the security tile.
    pub has_recovery: bool,
    /// Remaining rate-limit cool-off in seconds, if any.
    pub rate_limited_secs: u64,
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

    // Distinguish three cases:
    //   1. envelope does not exist                → legitimate v1.x compat, is_set_up=false
    //   2. envelope exists and loads OK           → normal path
    //   3. envelope exists but fails to load      → envelope_error set; frontend must fail closed
    let (is_set_up, migration_state, envelope_error, has_recovery) = if !env_path.exists() {
        (false, MigrationState::Plaintext, None, false)
    } else {
        match security::load_envelope(&env_path) {
            Ok(env) => {
                let done = env.migration_state == MigrationState::Encrypted;
                let has_rec = env.find_slot(SlotKind::Recovery).is_some();
                (done, env.migration_state, None, has_rec)
            }
            Err(e) => (
                false,
                MigrationState::Plaintext,
                Some(e.to_string()),
                false,
            ),
        }
    };

    let rate_limited_secs = match auth.check_rate_limit() {
        Ok(_) => 0,
        Err(AuthError::RateLimited { retry_after_secs }) => retry_after_secs,
        Err(_) => 0,
    };

    Ok(V2State {
        is_set_up,
        is_unlocked: auth.has_mdk(),
        migration_state: migration_state_str(migration_state),
        envelope_error,
        has_recovery,
        rate_limited_secs,
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
    if pin.chars().count() < 6 {
        return Err(AuthError::PinTooShort);
    }
    let env_path = envelope_path(&app)?;

    // Allow retry if a prior setup wizard crashed. recover_on_startup
    // (called from lib.rs) has already normalized envelope state, so at
    // this point:
    //   * envelope missing            → fresh install, proceed
    //   * envelope Plaintext          → prior wizard rolled back, delete stale envelope and proceed
    //   * envelope Encrypted          → already set up, refuse
    //   * envelope Encrypting/other   → recovery didn't run or failed, refuse
    if env_path.exists() {
        let env = security::load_envelope(&env_path)?;
        match env.migration_state {
            MigrationState::Plaintext => {
                std::fs::remove_file(&env_path)?;
            }
            MigrationState::Encrypted => return Err(AuthError::AlreadySetUp),
            MigrationState::Encrypting => return Err(AuthError::AlreadySetUp),
        }
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
    // Checkpoint any pending WAL frames back into the main file BEFORE
    // closing, so sqlcipher_export sees every committed transaction.
    // Ignore checkpoint errors — they are non-fatal (WAL may already be
    // empty, or the DB may be in journal mode); the migration will fail
    // downstream if data is genuinely missing.
    let _ = gate.checkpoint_wal().await;
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
///
/// Enforces a server-side rate limit: after 5 wrong-PIN attempts in a
/// 5-minute window we cool off for 60s, then 5min, then 30min. A
/// successful unlock clears the counter. Argon2 already imposes a
/// ~1s CPU cost per attempt, so this is defense-in-depth.
#[tauri::command]
pub async fn v2_unlock(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    gate: tauri::State<'_, DbGate>,
    pin: String,
) -> Result<(), AuthError> {
    auth.check_rate_limit()?;

    let env_path = envelope_path(&app)?;
    let env = security::load_envelope(&env_path)?;
    let slot = env
        .find_slot(SlotKind::Pin)
        .ok_or(AuthError::NotSetUp)?
        .clone();
    let device_secret = device_secret::get_or_create()?;
    let mdk = match security::unwrap_mdk(&slot, pin.as_bytes(), &device_secret) {
        Ok(m) => m,
        Err(SecurityError::Authentication) => {
            auth.record_failure();
            return Err(AuthError::WrongPin);
        }
        Err(e) => return Err(e.into()),
    };
    // Close any pre-migration plaintext connection and reopen encrypted.
    gate.close().await;
    let db = db_path(&app)?;
    gate.open_encrypted(&db, &mdk).await?;
    auth.set_mdk(mdk); // set_mdk clears rate-limit state
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
    if new_pin.chars().count() < 6 {
        return Err(AuthError::PinTooShort);
    }
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

/// Set a new PIN. Requires a fresh proof of ownership (current PIN or
/// recovery code) even when the app is already unlocked — the walk-up
/// attacker on an unlocked machine would otherwise be able to lock the
/// owner out permanently by resetting the PIN. `verify_step_up` also
/// binds the proof to the live session MDK so envelope tampering
/// against an unlocked session can't be used to satisfy the check.
///
/// Server-side length check on `new_pin` so a compromised or malicious
/// frontend can't ship a 1-char PIN via direct IPC.
#[tauri::command]
pub async fn v2_reset_pin(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    proof: StepUpProof,
    new_pin: String,
) -> Result<(), AuthError> {
    if new_pin.chars().count() < 6 {
        return Err(AuthError::PinTooShort);
    }
    let env_path = envelope_path(&app)?;
    let mut env = security::load_envelope(&env_path)?;
    if env.find_slot(SlotKind::Pin).is_none() {
        return Err(AuthError::NotSetUp);
    }
    auth.verify_step_up(&env, &proof)?;

    let mdk = auth.clone_mdk().ok_or(AuthError::NotSetUp)?;
    let device_secret = device_secret::get_or_create()?;
    let new_slot = security::wrap_mdk(
        SlotKind::Pin,
        &mdk,
        new_pin.as_bytes(),
        &device_secret,
        ArgonParams::default(),
    )?;
    env.upsert_slot(new_slot);
    security::save_envelope(&env_path, &env)?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// Recovery kit
// ────────────────────────────────────────────────────────────────────────
//
// The recovery kit is a random 24-byte secret shown to the user ONCE
// (typically printed) and wrapped over a copy of the MDK in a separate
// envelope slot. It bypasses the device-bound secret entirely so it
// works even after OS reinstall / laptop replacement — as long as the
// user still has the printed code.
//
// Format: 24 bytes → hex → grouped as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`
// (6 groups × 4 hex chars = 48 char human-friendly string).
//
// Threat: if the printed code is stolen, the encrypted DB can be
// decrypted anywhere. The UI must make this clear at generation time.

const RECOVERY_BYTES: usize = 24;

fn format_recovery_code(bytes: &[u8]) -> Zeroizing<String> {
    let mut out = String::with_capacity(RECOVERY_BYTES * 2 + RECOVERY_BYTES / 2);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && i % 2 == 0 {
            out.push('-');
        }
        out.push_str(&format!("{:02X}", b));
    }
    Zeroizing::new(out)
}

fn parse_recovery_code(code: &str) -> Result<Zeroizing<Vec<u8>>, AuthError> {
    let cleaned: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(|c| c.to_uppercase())
        .collect();
    if cleaned.len() != RECOVERY_BYTES * 2 {
        return Err(AuthError::RecoveryInvalid);
    }
    let mut out = Vec::with_capacity(RECOVERY_BYTES);
    for chunk in cleaned.as_bytes().chunks(2) {
        let s = std::str::from_utf8(chunk).map_err(|_| AuthError::RecoveryInvalid)?;
        let b = u8::from_str_radix(s, 16).map_err(|_| AuthError::RecoveryInvalid)?;
        out.push(b);
    }
    Ok(Zeroizing::new(out))
}

/// Generate a new recovery code, wrap a fresh copy of the MDK with it
/// (no device-bound secret), and persist the resulting slot in the
/// envelope. Requires a step-up proof (current PIN or existing recovery
/// code) so a walk-up attacker on an unlocked machine cannot mint a new
/// recovery code and use it to defeat the reset-PIN step-up check.
///
/// The setup wizard satisfies this by passing the just-created PIN as
/// the proof — the freshly-wrapped session MDK matches, so the binding
/// check inside `verify_step_up` succeeds.
///
/// Returns the human-readable code exactly ONCE. Callers must show it
/// to the user immediately and warn that it will not be recoverable.
#[tauri::command]
pub async fn v2_generate_recovery(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    proof: StepUpProof,
) -> Result<String, AuthError> {
    let env_path = envelope_path(&app)?;
    let mut env = security::load_envelope(&env_path)?;
    auth.verify_step_up(&env, &proof)?;

    // We need the current session MDK to wrap a copy of it under the
    // recovery code. Fail if the app is locked.
    let mdk_bytes: [u8; 32] = {
        let g = auth.inner.lock().unwrap();
        let m = g.mdk.as_ref().ok_or(AuthError::NotSetUp)?;
        *m.as_bytes()
    };
    let mdk = Mdk::from_bytes(mdk_bytes);

    // Fresh 24-byte random recovery secret.
    use rand::RngCore;
    let mut secret = Zeroizing::new(vec![0u8; RECOVERY_BYTES]);
    rand::thread_rng().fill_bytes(secret.as_mut());
    let code = format_recovery_code(&secret);

    // Wrap MDK with recovery secret ONLY (no device_bound_secret) so the
    // resulting slot is portable across machines.
    let slot = security::wrap_mdk(
        SlotKind::Recovery,
        &mdk,
        &secret,
        b"",
        ArgonParams::default(),
    )?;

    env.upsert_slot(slot);
    security::save_envelope(&env_path, &env)?;

    Ok((*code).clone())
}

/// Unlock the app using a previously-generated recovery code (bypasses PIN
/// AND device-bound secret). Same rate limit applies.
#[tauri::command]
pub async fn v2_unlock_with_recovery(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    gate: tauri::State<'_, DbGate>,
    code: String,
) -> Result<(), AuthError> {
    auth.check_rate_limit()?;

    let bytes = parse_recovery_code(&code)?;
    let env_path = envelope_path(&app)?;
    let env = security::load_envelope(&env_path)?;
    let slot = env
        .find_slot(SlotKind::Recovery)
        .ok_or(AuthError::RecoveryMissing)?
        .clone();
    let mdk = match security::unwrap_mdk(&slot, &bytes, b"") {
        Ok(m) => m,
        Err(SecurityError::Authentication) => {
            auth.record_failure();
            return Err(AuthError::RecoveryInvalid);
        }
        Err(e) => return Err(e.into()),
    };
    gate.close().await;
    let db = db_path(&app)?;
    gate.open_encrypted(&db, &mdk).await?;
    auth.set_mdk(mdk);
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::Mutex as StdMutex;

    /// Serialises tests that touch the global device_secret keychain
    /// entry. Without this, `device_secret::delete()` inside one test
    /// races with `get_or_create()` inside another, causing spurious
    /// unwrap failures.
    static DEVICE_SECRET_LOCK: StdMutex<()> = StdMutex::new(());

    /// Full end-to-end: plaintext DB -> setup with PIN -> encrypted DB
    /// -> lock -> unlock -> change PIN -> unlock with new PIN.
    /// Runs without the Tauri app (uses AuthState + SqlCipherExporter
    /// + DbGate directly against a tempdir).
    #[tokio::test]
    async fn full_setup_unlock_change_pin_cycle() {
        let _guard = DEVICE_SECRET_LOCK.lock().unwrap_or_else(|p| p.into_inner());
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

    #[test]
    fn verify_step_up_pin_success_and_failure() {
        let _guard = DEVICE_SECRET_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let device_secret = device_secret::get_or_create().unwrap();
        let mdk = Mdk::generate();
        let slot = security::wrap_mdk(
            SlotKind::Pin,
            &mdk,
            b"654321",
            &device_secret,
            ArgonParams { m_cost_kib: 1024, t_cost: 1, p_cost: 1 },
        )
        .unwrap();
        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(slot);

        let auth = AuthState::default();
        auth.set_mdk(mdk);

        // Correct PIN → ok.
        auth.verify_step_up(&env, &StepUpProof::Pin { pin: "654321".into() })
            .expect("correct PIN should verify");

        // Wrong PIN → WrongPin.
        let err = auth
            .verify_step_up(&env, &StepUpProof::Pin { pin: "000000".into() })
            .unwrap_err();
        assert!(matches!(err, AuthError::WrongPin), "got {err:?}");
    }

    /// Regression: a tampered envelope with a rogue slot that unwraps to
    /// a DIFFERENT MDK must NOT satisfy step-up. This is the whole point
    /// of binding the unwrapped MDK to the live session MDK.
    #[test]
    fn verify_step_up_rejects_forged_slot_with_wrong_mdk() {
        let _guard = DEVICE_SECRET_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let device_secret = device_secret::get_or_create().unwrap();

        // Real MDK for the session.
        let session_mdk = Mdk::generate();
        let real_slot = security::wrap_mdk(
            SlotKind::Pin,
            &session_mdk,
            b"aaaaaa",
            &device_secret,
            ArgonParams { m_cost_kib: 1024, t_cost: 1, p_cost: 1 },
        )
        .unwrap();

        // Attacker forges a Recovery slot wrapping a DIFFERENT MDK under
        // a secret they know. If verify_step_up only checked "does this
        // unwrap?" it would accept this. It must reject on MDK mismatch.
        let attacker_mdk = Mdk::generate();
        assert_ne!(session_mdk.as_bytes(), attacker_mdk.as_bytes());
        let forged_recovery_bytes = [7u8; RECOVERY_BYTES];
        let forged_slot = security::wrap_mdk(
            SlotKind::Recovery,
            &attacker_mdk,
            &forged_recovery_bytes,
            b"",
            ArgonParams { m_cost_kib: 1024, t_cost: 1, p_cost: 1 },
        )
        .unwrap();

        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(real_slot);
        env.upsert_slot(forged_slot);

        let auth = AuthState::default();
        auth.set_mdk(session_mdk);

        // The forged recovery unwraps successfully (crypto layer is happy),
        // but the MDK it produces is not the session MDK → reject.
        let forged_code_str = {
            let mut s = String::new();
            for b in forged_recovery_bytes.iter() {
                s.push_str(&format!("{:02X}", b));
            }
            s
        };
        let err = auth
            .verify_step_up(&env, &StepUpProof::Recovery { code: forged_code_str })
            .unwrap_err();
        assert!(matches!(err, AuthError::RecoveryInvalid), "got {err:?}");

        // Sanity: real PIN still works (proves we're not just rejecting
        // everything).
        auth.verify_step_up(&env, &StepUpProof::Pin { pin: "aaaaaa".into() })
            .expect("real PIN must still verify");
    }
}
