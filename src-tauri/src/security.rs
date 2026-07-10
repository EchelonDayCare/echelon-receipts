// v2.0.0 security envelope. Stores the wrapped Master Data Key (MDK) in
// `security.json` next to the SQLCipher database. The MDK itself never
// leaves memory unwrapped and is zeroed on drop.
//
// Design principles (see plan.md and the three-model architecture review):
//   * MDK is a 256-bit random key that keys SQLCipher via `PRAGMA key`.
//   * A user secret (PIN, recovery phrase, or biometric-released random key)
//     is combined with a *device-bound secret* to derive a KEK, which then
//     wraps the MDK with XChaCha20-Poly1305 + AEAD.
//   * Multiple slots (Pin / Biometric / Recovery) each hold an independent
//     wrapping of the same MDK, so any single method can unlock, and
//     changing one method never requires re-encrypting the database.
//   * AEAD associated data binds the envelope version and the argon params
//     to the ciphertext, so a downgrade attempt (swapping in an old
//     envelope with weaker params) fails authentication.
//   * The device-bound secret (Day 3) is folded into the KEK on every
//     wrap/unwrap so a stolen `security.json` alone cannot be
//     brute-forced offline. In this module it's supplied as a byte slice;
//     it may be `&[]` in tests to exercise the crypto path without a
//     platform keychain.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

// ────────────────────────────────────────────────────────────────────────
// Constants (pinned so old envelopes always decrypt even if defaults shift)
// ────────────────────────────────────────────────────────────────────────

pub const ENVELOPE_VERSION: u8 = 1;

const MDK_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24; // XChaCha20 nonce

// OWASP 2024 baseline (m=19 MiB, t=2, p=1) matches backup_crypto.rs, so
// derivation time stays perceptibly identical across the app. The device-
// bound secret carries the offline-resistance load.
const ARGON2_M_COST_KIB: u32 = 19_456;
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

#[allow(dead_code)] // Reserved for the future PIN-only fast-path.
fn argon2_pinned() -> Argon2<'static> {
    let params = Params::new(
        ARGON2_M_COST_KIB,
        ARGON2_T_COST,
        ARGON2_P_COST,
        Some(MDK_LEN),
    )
    .expect("static Argon2 params must be valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

/// One of the mutually-exclusive unlock methods that can wrap the MDK.
/// The string forms are stable — they appear in `security.json` and in
/// AEAD associated data. Renaming a variant is a breaking change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotKind {
    Pin,
    Biometric,
    Recovery,
}

impl SlotKind {
    fn as_str(&self) -> &'static str {
        match self {
            SlotKind::Pin => "pin",
            SlotKind::Biometric => "biometric",
            SlotKind::Recovery => "recovery",
        }
    }
}

/// Pinned Argon2id parameter set. Stored per slot so we can migrate to
/// stronger params for future slots without invalidating existing ones.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArgonParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for ArgonParams {
    fn default() -> Self {
        Self {
            m_cost_kib: ARGON2_M_COST_KIB,
            t_cost: ARGON2_T_COST,
            p_cost: ARGON2_P_COST,
        }
    }
}

/// One wrapped copy of the MDK. All bytes are base64-encoded when
/// serialized so the envelope is copy-pasteable JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Slot {
    pub kind: SlotKind,
    pub argon: ArgonParams,
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
    #[serde(with = "b64")]
    pub nonce: Vec<u8>,
    #[serde(with = "b64")]
    pub wrapped_mdk: Vec<u8>,
    /// Opaque platform-specific reference (e.g. a keychain item id) for
    /// slots that need one, otherwise `None`. Present but unused until Day 6/7.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_ref: Option<String>,
}

/// Envelope written to disk as `security.json`.
///
/// Everything in this file is public-in-principle — a folder-copy attacker
/// sees it in the clear. Its confidentiality relies entirely on:
///   1. Argon2id cost (guessing PIN)
///   2. The device-bound secret being unavailable off-device (Day 3)
///   3. AEAD authentication preventing tampered slots from decrypting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityEnvelope {
    pub version: u8,
    #[serde(default)]
    pub migration_state: MigrationState,
    pub slots: Vec<Slot>,
}

/// State machine for the plaintext-to-SQLCipher migration (Day 4). Present
/// in the envelope from v2.0.0 so a crash mid-migration is recoverable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MigrationState {
    /// No security enabled yet; DB is plaintext.
    #[default]
    Plaintext,
    /// User has committed to encryption; sqlcipher_export in progress.
    Encrypting,
    /// Encrypted DB is in place, plaintext removed. Steady state.
    Encrypted,
}

impl SecurityEnvelope {
    pub fn new_empty() -> Self {
        Self {
            version: ENVELOPE_VERSION,
            migration_state: MigrationState::Plaintext,
            slots: Vec::new(),
        }
    }

    pub fn find_slot(&self, kind: SlotKind) -> Option<&Slot> {
        self.slots.iter().find(|s| s.kind == kind)
    }

    /// Add or replace the slot of a given kind. Used when a user sets a
    /// PIN, enrolls biometric, or generates a new recovery phrase — each
    /// wraps the *same* MDK so any slot can unlock the DB.
    pub fn upsert_slot(&mut self, slot: Slot) {
        if let Some(existing) = self.slots.iter_mut().find(|s| s.kind == slot.kind) {
            *existing = slot;
        } else {
            self.slots.push(slot);
        }
    }

    #[allow(dead_code)] // Reserved for future PIN/passphrase revocation.
    pub fn remove_slot(&mut self, kind: SlotKind) {
        self.slots.retain(|s| s.kind != kind);
    }
}

// ────────────────────────────────────────────────────────────────────────
// MDK — zeroized on drop, best-effort locked in memory
// ────────────────────────────────────────────────────────────────────────

/// The 256-bit Master Data Key. Bytes are overwritten with zeros in
/// `Drop`, mitigating cold-boot / RAM-dump recovery.
///
/// A best-effort `mlock` / `VirtualLock` is applied at construction to
/// keep the pages out of the OS page/swap file. Failures are non-fatal
/// (the app may not have the privilege on locked-down systems).
pub struct Mdk {
    bytes: [u8; MDK_LEN],
    locked: bool,
}

impl std::fmt::Debug for Mdk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the key bytes. `Debug` is used by test asserts and
        // panic messages — leaking here would be catastrophic.
        f.debug_struct("Mdk")
            .field("len", &MDK_LEN)
            .field("locked", &self.locked)
            .finish_non_exhaustive()
    }
}

impl Mdk {
    pub fn generate() -> Self {
        let mut bytes = [0u8; MDK_LEN];
        OsRng.fill_bytes(&mut bytes);
        let mut m = Self { bytes, locked: false };
        m.try_lock();
        m
    }

    pub fn from_bytes(bytes: [u8; MDK_LEN]) -> Self {
        let mut m = Self { bytes, locked: false };
        m.try_lock();
        m
    }

    /// 64-hex-character rendering, ready for `PRAGMA key = "x'<hex>'"`.
    /// Returned as `zeroize::Zeroizing` so the temporary hex string is
    /// erased when the caller drops it.
    pub fn as_pragma_hex(&self) -> zeroize::Zeroizing<String> {
        let mut s = String::with_capacity(MDK_LEN * 2);
        for b in &self.bytes {
            use std::fmt::Write;
            let _ = write!(&mut s, "{:02x}", b);
        }
        zeroize::Zeroizing::new(s)
    }

    pub fn as_bytes(&self) -> &[u8; MDK_LEN] {
        &self.bytes
    }

    fn try_lock(&mut self) {
        // Best-effort — silence errors. Even without page-locking the
        // ZeroizeOnDrop guarantees the bytes are cleared when we're done.
        #[cfg(unix)]
        unsafe {
            let ptr = self.bytes.as_ptr() as *const libc::c_void;
            self.locked = libc::mlock(ptr, MDK_LEN) == 0;
        }
        #[cfg(windows)]
        unsafe {
            // We deliberately avoid pulling in the `winapi` crate for one
            // symbol; call VirtualLock via a lightweight extern block.
            #[link(name = "kernel32")]
            extern "system" {
                fn VirtualLock(lpAddress: *const core::ffi::c_void, dwSize: usize) -> i32;
            }
            let ptr = self.bytes.as_ptr() as *const core::ffi::c_void;
            self.locked = VirtualLock(ptr, MDK_LEN) != 0;
        }
    }
}

impl Drop for Mdk {
    fn drop(&mut self) {
        if self.locked {
            #[cfg(unix)]
            unsafe {
                let ptr = self.bytes.as_ptr() as *const libc::c_void;
                let _ = libc::munlock(ptr, MDK_LEN);
            }
            #[cfg(windows)]
            unsafe {
                #[link(name = "kernel32")]
                extern "system" {
                    fn VirtualUnlock(
                        lpAddress: *const core::ffi::c_void,
                        dwSize: usize,
                    ) -> i32;
                }
                let ptr = self.bytes.as_ptr() as *const core::ffi::c_void;
                let _ = VirtualUnlock(ptr, MDK_LEN);
            }
        }
        // Manually zero the key material.
        self.bytes.zeroize();
    }
}

// ────────────────────────────────────────────────────────────────────────
// Wrap / unwrap
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)] // SlotNotFound reserved for future slot-lookup APIs.
pub enum SecurityError {
    #[error("wrong secret or corrupted slot")]
    Authentication,
    #[error("envelope version {0} not supported")]
    UnsupportedVersion(u8),
    #[error("slot not found: {0:?}")]
    SlotNotFound(SlotKind),
    #[error("crypto failure: {0}")]
    Crypto(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

// The `thiserror` crate isn't yet in Cargo.toml. Fall back to a hand-rolled
// impl so this module compiles standalone; we'll switch to `thiserror` if
// the rest of the crate adopts it. For now, provide manual conversions.
// (Added `thiserror = "2"` to Cargo.toml — this shim is now empty.)

/// Derive a wrapping key from a user secret + device-bound secret.
///
/// The device-bound secret (Day 3) is appended to the user secret before
/// Argon2id so that even a correct PIN cannot be verified offline against
/// a copied `security.json` without also possessing the device secret.
fn derive_kek(
    secret: &[u8],
    device_bound_secret: &[u8],
    salt: &[u8],
    argon: &ArgonParams,
) -> Result<zeroize::Zeroizing<[u8; 32]>, SecurityError> {
    let params = Params::new(argon.m_cost_kib, argon.t_cost, argon.p_cost, Some(32))
        .map_err(|e| SecurityError::Crypto(format!("argon params: {e}")))?;
    let hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    // secret ‖ 0x00 ‖ device_bound_secret — the 0x00 is a domain separator
    // that prevents "PIN=X + device=Y" from colliding with "PIN=X0 + device=Y".
    let mut input = Vec::with_capacity(secret.len() + 1 + device_bound_secret.len());
    input.extend_from_slice(secret);
    input.push(0);
    input.extend_from_slice(device_bound_secret);

    let mut kek = zeroize::Zeroizing::new([0u8; 32]);
    hasher
        .hash_password_into(&input, salt, kek.as_mut())
        .map_err(|e| SecurityError::Crypto(format!("kdf: {e}")))?;
    input.zeroize();
    Ok(kek)
}

fn build_aad(kind: SlotKind, salt: &[u8], nonce: &[u8], argon: &ArgonParams) -> Vec<u8> {
    // Canonical, deterministic AAD. Any change in version, slot kind, salt,
    // nonce, or argon params causes AEAD auth to fail — this is what
    // prevents downgrade / slot-swap attacks.
    let mut aad = Vec::with_capacity(64);
    aad.push(ENVELOPE_VERSION);
    aad.extend_from_slice(kind.as_str().as_bytes());
    aad.push(0);
    aad.extend_from_slice(salt);
    aad.extend_from_slice(nonce);
    aad.extend_from_slice(&argon.m_cost_kib.to_be_bytes());
    aad.extend_from_slice(&argon.t_cost.to_be_bytes());
    aad.extend_from_slice(&argon.p_cost.to_be_bytes());
    aad
}

/// Wrap the MDK with a user secret + device secret, producing a `Slot`.
pub fn wrap_mdk(
    kind: SlotKind,
    mdk: &Mdk,
    secret: &[u8],
    device_bound_secret: &[u8],
    argon: ArgonParams,
) -> Result<Slot, SecurityError> {
    let mut salt = vec![0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = vec![0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let kek = derive_kek(secret, device_bound_secret, &salt, &argon)?;
    let cipher = XChaCha20Poly1305::new_from_slice(kek.as_ref())
        .map_err(|e| SecurityError::Crypto(e.to_string()))?;
    let nonce = XNonce::try_from(&nonce_bytes[..])
        .map_err(|_| SecurityError::Crypto("nonce length invariant broken".into()))?;

    let aad = build_aad(kind, &salt, &nonce_bytes, &argon);
    let ciphertext = cipher
        .encrypt(&nonce, Payload { msg: mdk.as_bytes(), aad: &aad })
        .map_err(|_| SecurityError::Crypto("aead encrypt failed".into()))?;

    Ok(Slot {
        kind,
        argon,
        salt,
        nonce: nonce_bytes,
        wrapped_mdk: ciphertext,
        platform_ref: None,
    })
}

/// Unwrap the MDK from a slot given the correct secret + device secret.
pub fn unwrap_mdk(
    slot: &Slot,
    secret: &[u8],
    device_bound_secret: &[u8],
) -> Result<Mdk, SecurityError> {
    if slot.nonce.len() != NONCE_LEN {
        return Err(SecurityError::Crypto("nonce length invalid".into()));
    }
    if slot.salt.len() != SALT_LEN {
        return Err(SecurityError::Crypto("salt length invalid".into()));
    }

    let kek = derive_kek(secret, device_bound_secret, &slot.salt, &slot.argon)?;
    let cipher = XChaCha20Poly1305::new_from_slice(kek.as_ref())
        .map_err(|e| SecurityError::Crypto(e.to_string()))?;
    let nonce = XNonce::try_from(&slot.nonce[..])
        .map_err(|_| SecurityError::Crypto("nonce length invariant broken".into()))?;

    let aad = build_aad(slot.kind, &slot.salt, &slot.nonce, &slot.argon);
    let plaintext = cipher
        .decrypt(&nonce, Payload { msg: &slot.wrapped_mdk, aad: &aad })
        .map_err(|_| SecurityError::Authentication)?;

    if plaintext.len() != MDK_LEN {
        // Zero the bad plaintext before dropping it.
        let mut p = plaintext;
        p.zeroize();
        return Err(SecurityError::Crypto("unwrapped MDK wrong length".into()));
    }
    let mut arr = [0u8; MDK_LEN];
    arr.copy_from_slice(&plaintext);
    // Zero the intermediate Vec too.
    let mut p = plaintext;
    p.zeroize();
    Ok(Mdk::from_bytes(arr))
}

// ────────────────────────────────────────────────────────────────────────
// Envelope I/O
// ────────────────────────────────────────────────────────────────────────

pub fn load_envelope(path: &std::path::Path) -> Result<SecurityEnvelope, SecurityError> {
    let bytes = std::fs::read(path)?;
    let env: SecurityEnvelope = serde_json::from_slice(&bytes)?;
    if env.version != ENVELOPE_VERSION {
        return Err(SecurityError::UnsupportedVersion(env.version));
    }
    Ok(env)
}

/// Global write lock guarding load-modify-save of the security envelope.
///
/// The four Tauri commands that persist the envelope must hold this lock
/// across the entire load → mutate → save critical section:
///   • `v2_create_pin`   (auth.rs)
///   • `v2_change_pin`   (auth.rs)
///   • `v2_reset_pin`    (auth.rs)
///   • `v2_generate_recovery` (auth.rs)
///
/// Read-only commands (`v2_unlock_with_recovery`) do NOT need the guard.
/// The v1→v2 migration path (`db_migration::migrate_to_encrypted` and its
/// `save_envelope` callers) is only reachable from either (a) startup
/// `recover_on_startup` — single-threaded, runs before Tauri commands are
/// served — or (b) `v2_create_pin`, which already holds this lock.
/// New callers of `save_envelope` MUST take the lock themselves.
///
/// Without the lock two concurrent commands could each `load_envelope`,
/// both mutate their local copy, and the second `save_envelope` would
/// silently clobber the first (classic TOCTOU — e.g. adding a recovery
/// code while the user changes their PIN would drop one of the two writes
/// on the floor).
pub static ENVELOPE_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn save_envelope(
    path: &std::path::Path,
    env: &SecurityEnvelope,
) -> Result<(), SecurityError> {
    // Atomic write: write to `path.tmp` then rename. Prevents a crash
    // mid-write from leaving a truncated envelope that would lock the
    // user out permanently.
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(env)?;
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// base64 serde helper
// ────────────────────────────────────────────────────────────────────────

mod b64 {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(v);
        s.serialize_str(&encoded)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(&s)
            .map_err(serde::de::Error::custom)
    }
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn small_argon() -> ArgonParams {
        // Fast params for unit tests only. Production keeps the defaults.
        ArgonParams { m_cost_kib: 1024, t_cost: 1, p_cost: 1 }
    }

    #[test]
    fn round_trip_pin_slot() {
        let mdk = Mdk::generate();
        let device = b"device-bound-secret-32-bytes-XXX";
        let slot = wrap_mdk(SlotKind::Pin, &mdk, b"123456", device, small_argon())
            .expect("wrap");
        let unwrapped = unwrap_mdk(&slot, b"123456", device).expect("unwrap");
        assert_eq!(mdk.as_bytes(), unwrapped.as_bytes());
    }

    #[test]
    fn wrong_pin_fails_with_authentication_error() {
        let mdk = Mdk::generate();
        let device = b"device-secret";
        let slot = wrap_mdk(SlotKind::Pin, &mdk, b"correct", device, small_argon())
            .expect("wrap");
        let err = unwrap_mdk(&slot, b"wrong", device).unwrap_err();
        assert!(matches!(err, SecurityError::Authentication));
    }

    #[test]
    fn wrong_device_secret_fails() {
        let mdk = Mdk::generate();
        let slot = wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"device-a", small_argon())
            .expect("wrap");
        let err = unwrap_mdk(&slot, b"pin", b"device-b").unwrap_err();
        assert!(matches!(err, SecurityError::Authentication));
    }

    #[test]
    fn empty_device_secret_still_authenticates() {
        // Exercised in tests where no keychain is available.
        let mdk = Mdk::generate();
        let slot = wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"", small_argon()).expect("wrap");
        let unwrapped = unwrap_mdk(&slot, b"pin", b"").expect("unwrap");
        assert_eq!(mdk.as_bytes(), unwrapped.as_bytes());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let mdk = Mdk::generate();
        let mut slot = wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"dev", small_argon())
            .expect("wrap");
        slot.wrapped_mdk[0] ^= 0x01;
        let err = unwrap_mdk(&slot, b"pin", b"dev").unwrap_err();
        assert!(matches!(err, SecurityError::Authentication));
    }

    #[test]
    fn tampered_argon_params_fail_via_aad() {
        let mdk = Mdk::generate();
        let mut slot = wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"dev", small_argon())
            .expect("wrap");
        // Attacker bumps m_cost_kib in an attempt at a downgrade / replay.
        slot.argon.m_cost_kib += 1;
        let err = unwrap_mdk(&slot, b"pin", b"dev").unwrap_err();
        assert!(matches!(err, SecurityError::Authentication));
    }

    #[test]
    fn tampered_salt_fails_via_aad() {
        let mdk = Mdk::generate();
        let mut slot = wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"dev", small_argon())
            .expect("wrap");
        slot.salt[0] ^= 0xff;
        let err = unwrap_mdk(&slot, b"pin", b"dev").unwrap_err();
        assert!(matches!(err, SecurityError::Authentication));
    }

    #[test]
    fn slot_swap_between_kinds_fails() {
        // If an attacker takes a Pin slot and relabels it as Recovery
        // (hoping recovery-phrase entry accepts a short PIN), AEAD binding
        // to slot kind in AAD prevents it.
        let mdk = Mdk::generate();
        let mut slot = wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"dev", small_argon())
            .expect("wrap");
        slot.kind = SlotKind::Recovery;
        let err = unwrap_mdk(&slot, b"pin", b"dev").unwrap_err();
        assert!(matches!(err, SecurityError::Authentication));
    }

    #[test]
    fn multi_slot_envelope_all_unlock_same_mdk() {
        let mdk = Mdk::generate();
        let device = b"dev";
        let pin_slot =
            wrap_mdk(SlotKind::Pin, &mdk, b"123456", device, small_argon()).unwrap();
        let recovery_slot = wrap_mdk(
            SlotKind::Recovery,
            &mdk,
            b"correct horse battery staple correct horse battery staple",
            device,
            small_argon(),
        )
        .unwrap();

        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(pin_slot);
        env.upsert_slot(recovery_slot);
        assert_eq!(env.slots.len(), 2);

        let via_pin = unwrap_mdk(env.find_slot(SlotKind::Pin).unwrap(), b"123456", device)
            .unwrap();
        let via_rec = unwrap_mdk(
            env.find_slot(SlotKind::Recovery).unwrap(),
            b"correct horse battery staple correct horse battery staple",
            device,
        )
        .unwrap();
        assert_eq!(via_pin.as_bytes(), mdk.as_bytes());
        assert_eq!(via_rec.as_bytes(), mdk.as_bytes());
    }

    #[test]
    fn upsert_slot_replaces_same_kind() {
        let mdk = Mdk::generate();
        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(
            wrap_mdk(SlotKind::Pin, &mdk, b"old-pin", b"", small_argon()).unwrap(),
        );
        env.upsert_slot(
            wrap_mdk(SlotKind::Pin, &mdk, b"new-pin", b"", small_argon()).unwrap(),
        );
        assert_eq!(env.slots.len(), 1);
        // Old PIN no longer works.
        let slot = env.find_slot(SlotKind::Pin).unwrap();
        assert!(matches!(
            unwrap_mdk(slot, b"old-pin", b"").unwrap_err(),
            SecurityError::Authentication
        ));
        assert!(unwrap_mdk(slot, b"new-pin", b"").is_ok());
    }

    #[test]
    fn envelope_json_round_trip() {
        let mdk = Mdk::generate();
        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(
            wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"dev", small_argon()).unwrap(),
        );
        let json = serde_json::to_string_pretty(&env).unwrap();
        let restored: SecurityEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.version, ENVELOPE_VERSION);
        assert_eq!(restored.slots.len(), 1);
        let unwrapped =
            unwrap_mdk(restored.find_slot(SlotKind::Pin).unwrap(), b"pin", b"dev").unwrap();
        assert_eq!(mdk.as_bytes(), unwrapped.as_bytes());
    }

    #[test]
    fn atomic_file_write_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("security.json");
        let mdk = Mdk::generate();
        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(
            wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"dev", small_argon()).unwrap(),
        );
        env.migration_state = MigrationState::Encrypted;
        save_envelope(&path, &env).unwrap();

        // The tmp file should NOT still exist after a successful rename.
        assert!(!path.with_extension("json.tmp").exists());

        let loaded = load_envelope(&path).unwrap();
        assert_eq!(loaded.version, ENVELOPE_VERSION);
        assert_eq!(loaded.migration_state, MigrationState::Encrypted);
        let unwrapped =
            unwrap_mdk(loaded.find_slot(SlotKind::Pin).unwrap(), b"pin", b"dev").unwrap();
        assert_eq!(mdk.as_bytes(), unwrapped.as_bytes());
    }

    #[test]
    fn mdk_pragma_hex_is_64_chars_lowercase() {
        let mdk = Mdk::from_bytes([0xab; MDK_LEN]);
        let hex = mdk.as_pragma_hex();
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(&*hex, &"ab".repeat(32));
    }

    #[test]
    fn generated_mdks_are_unique_and_high_entropy() {
        let a = Mdk::generate();
        let b = Mdk::generate();
        assert_ne!(a.as_bytes(), b.as_bytes());
        // Sanity: bytes shouldn't all be zero (would indicate a broken RNG).
        assert!(a.as_bytes().iter().any(|&b| b != 0));
    }

    #[test]
    fn remove_slot_works() {
        let mdk = Mdk::generate();
        let mut env = SecurityEnvelope::new_empty();
        env.upsert_slot(
            wrap_mdk(SlotKind::Pin, &mdk, b"pin", b"", small_argon()).unwrap(),
        );
        env.upsert_slot(
            wrap_mdk(SlotKind::Recovery, &mdk, b"recovery-phrase-abc", b"", small_argon())
                .unwrap(),
        );
        assert_eq!(env.slots.len(), 2);
        env.remove_slot(SlotKind::Pin);
        assert_eq!(env.slots.len(), 1);
        assert_eq!(env.slots[0].kind, SlotKind::Recovery);
    }
}
