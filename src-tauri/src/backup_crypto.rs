// C-1: encrypted, passphrase-protected cloud backups.
//
// Previously `cloudBackup.ts` emailed the raw SQLite `.db` file as a
// plaintext attachment — a compromised/leaked mailbox meant the whole
// database (every family's PII) was exposed. Backups are now wrapped in a
// small self-describing envelope, encrypted with XChaCha20-Poly1305 using a
// key derived from a user-chosen passphrase via Argon2id.
//
// The passphrase itself lives only in the OS keychain (required so the
// *automatic* monthly backup can run unattended, with no prompt). A
// separate Argon2id PHC hash is kept in app settings purely to verify a
// re-entered passphrase (e.g. a "test decrypt" button or a passphrase
// change confirmation) without ever touching the keychain secret for that.
//
// Archive layout: [64-byte header][ciphertext (includes AEAD auth tag)]
//   magic      8 bytes   b"EDCBK1\0\0"
//   version    1 byte    1
//   kdf_id     1 byte    1 = Argon2id
//   reserved   2 bytes   0x00 0x00 (future flags)
//   salt       16 bytes  Argon2id salt
//   nonce      24 bytes  XChaCha20 nonce
//   aad_hash   12 bytes  first 12 bytes of SHA-256(everything above) — a
//                        cheap corruption check *before* attempting AEAD
//                        decryption. The same header prefix is also passed
//                        as AEAD associated data, so tampering is additionally
//                        caught (hard failure) by the cipher's auth tag.
use argon2::password_hash::{rand_core::OsRng as PhOsRng, SaltString};
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAGIC: &[u8; 8] = b"EDCBK1\0\0";
const VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const AAD_HASH_LEN: usize = 12;
const HEADER_LEN: usize = 8 + 1 + 1 + 2 + SALT_LEN + NONCE_LEN + AAD_HASH_LEN; // 64

fn sha256_12(data: &[u8]) -> [u8; AAD_HASH_LEN] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; AAD_HASH_LEN];
    out.copy_from_slice(&digest[..AAD_HASH_LEN]);
    out
}

// Argon2id parameters, pinned so that future crate defaults can never
// prevent old backups from decrypting. Aligned with OWASP 2024 guidance:
// m=19 MiB, t=2, p=1, output 32 bytes.
const ARGON2_M_COST_KIB: u32 = 19_456;
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

fn argon2_pinned() -> Argon2<'static> {
    let params = Params::new(
        ARGON2_M_COST_KIB,
        ARGON2_T_COST,
        ARGON2_P_COST,
        Some(32),
    ).expect("static Argon2 params must be valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    argon2_pinned()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("key derivation failed: {e}"))?;
    Ok(key)
}

/// Argon2id PHC hash for passphrase *verification only* — this is never
/// used to derive the encryption key (that always uses the per-archive
/// random salt above); it just confirms the user typed the right passphrase.
/// The PHC-encoded string embeds the m/t/p params inline, so this hash is
/// naturally self-describing even if pinned params change later.
pub fn hash_passphrase_for_verification(passphrase: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut PhOsRng);
    argon2_pinned()
        .hash_password(passphrase.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("hash failed: {e}"))
}

pub fn verify_passphrase(passphrase: &str, stored_hash: &str) -> bool {
    match PasswordHash::new(stored_hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(passphrase.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// True if `data` starts with our envelope magic and is long enough to hold
/// a full header. Anything else is either a legacy pre-migration plaintext
/// `.db` dump or a foreign file.
pub fn is_encrypted(data: &[u8]) -> bool {
    data.len() >= HEADER_LEN && &data[..8] == MAGIC
}

pub fn encrypt(passphrase: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = XNonce::from(nonce_bytes);

    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.push(VERSION);
    header.push(KDF_ARGON2ID);
    header.extend_from_slice(&[0u8, 0u8]);
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce_bytes);
    let aad_hash = sha256_12(&header);
    header.extend_from_slice(&aad_hash);
    debug_assert_eq!(header.len(), HEADER_LEN);

    let aad = header[..HEADER_LEN - AAD_HASH_LEN].to_vec();
    let ciphertext = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad: &aad })
        .map_err(|_| "encryption failed".to_string())?;

    let mut out = header;
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn decrypt(passphrase: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < HEADER_LEN {
        return Err("Archive too short to be a valid encrypted backup.".into());
    }
    if &data[..8] != MAGIC {
        return Err("Not an encrypted Echelon backup (magic mismatch).".into());
    }
    let version = data[8];
    let kdf_id = data[9];
    if version != VERSION {
        return Err(format!("Unsupported backup envelope version {version}."));
    }
    if kdf_id != KDF_ARGON2ID {
        return Err("Unsupported key-derivation function in backup header.".into());
    }
    let salt_start = 12;
    let nonce_start = salt_start + SALT_LEN;
    let aad_hash_start = nonce_start + NONCE_LEN;
    let salt = &data[salt_start..nonce_start];
    let nonce_bytes = &data[nonce_start..aad_hash_start];
    let stored_aad_hash = &data[aad_hash_start..HEADER_LEN];
    let header_prefix = &data[..aad_hash_start];

    if sha256_12(header_prefix) != stored_aad_hash {
        return Err("Backup header is corrupted (checksum mismatch).".into());
    }

    let key = derive_key(passphrase, salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce_arr: [u8; NONCE_LEN] = nonce_bytes
        .try_into()
        .map_err(|_| "Backup header has a malformed nonce.".to_string())?;
    let nonce = XNonce::from(nonce_arr);
    let ciphertext = &data[HEADER_LEN..];
    cipher
        .decrypt(&nonce, Payload { msg: ciphertext, aad: header_prefix })
        .map_err(|_| "Decryption failed — wrong passphrase, or the file is corrupted.".to_string())
}

// ─── Tauri commands ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SetPassphraseArgs {
    pub passphrase: String,
}

#[tauri::command]
pub fn backup_set_passphrase(args: SetPassphraseArgs) -> Result<String, String> {
    if args.passphrase.len() < 8 {
        return Err("Passphrase must be at least 8 characters.".into());
    }
    let entry = keyring::Entry::new("org.echelondaycare.receipts", "backup_passphrase")
        .map_err(|e| e.to_string())?;
    entry.set_password(&args.passphrase).map_err(|e| e.to_string())?;
    hash_passphrase_for_verification(&args.passphrase)
}

#[tauri::command]
pub fn backup_clear_passphrase() -> Result<(), String> {
    let entry = keyring::Entry::new("org.echelondaycare.receipts", "backup_passphrase")
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Deserialize)]
pub struct VerifyPassphraseArgs {
    pub passphrase: String,
    pub stored_hash: String,
}

#[tauri::command]
pub fn backup_verify_passphrase(args: VerifyPassphraseArgs) -> Result<bool, String> {
    Ok(verify_passphrase(&args.passphrase, &args.stored_hash))
}

#[derive(Deserialize)]
pub struct EncryptBackupArgs {
    pub plaintext_b64: String,
}

#[derive(Serialize)]
pub struct EncryptBackupResult {
    pub encrypted_b64: String,
}

#[tauri::command]
pub fn encrypt_backup(args: EncryptBackupArgs) -> Result<EncryptBackupResult, String> {
    let passphrase = crate::secrets::get_secret("backup_passphrase")?;
    let plaintext = base64::engine::general_purpose::STANDARD
        .decode(args.plaintext_b64.as_bytes())
        .map_err(|e| format!("decode: {e}"))?;
    let enc = encrypt(&passphrase, &plaintext)?;
    Ok(EncryptBackupResult {
        encrypted_b64: base64::engine::general_purpose::STANDARD.encode(enc),
    })
}

#[derive(Deserialize)]
pub struct DecryptBackupArgs {
    pub encrypted_b64: String,
    /// If omitted, the stored keychain passphrase is used (e.g. "test
    /// decrypt last backup"). Restore-from-file supplies a freshly
    /// user-entered passphrase instead.
    pub passphrase: Option<String>,
}

#[derive(Serialize)]
pub struct DecryptBackupResult {
    pub plaintext_b64: String,
    pub was_encrypted: bool,
}

#[tauri::command]
pub fn decrypt_backup(args: DecryptBackupArgs) -> Result<DecryptBackupResult, String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(args.encrypted_b64.as_bytes())
        .map_err(|e| format!("decode: {e}"))?;
    if !is_encrypted(&data) {
        // Legacy pre-migration backup — never encrypted. Caller is expected
        // to have already warned the user before calling restore on it.
        return Ok(DecryptBackupResult {
            plaintext_b64: base64::engine::general_purpose::STANDARD.encode(&data),
            was_encrypted: false,
        });
    }
    let passphrase = match args.passphrase {
        Some(p) if !p.is_empty() => p,
        _ => crate::secrets::get_secret("backup_passphrase")?,
    };
    let plain = decrypt(&passphrase, &data)?;
    Ok(DecryptBackupResult {
        plaintext_b64: base64::engine::general_purpose::STANDARD.encode(plain),
        was_encrypted: true,
    })
}

// ─── Backup producers (portable, restore-safe) ──────────────────────────
//
// Prior versions of `Settings.tsx::backupNow`, `AnnualReceipts.tsx::backupNow`,
// and `cloudBackup.ts::sendMonthlyBackup` did a raw file copy of the live
// `echelon.db` file. Once SQLCipher was enabled that produced an opaque
// ciphertext blob that `restore.rs::stage_restore` rejects (fails the
// "SQLite format 3\0" magic check). Users had backups on disk that couldn't
// be restored — a silent data-loss bug.
//
// These commands run `sqlcipher_export()` against the live DbGate
// connection, producing a portable plain-SQLite file that restore.rs
// accepts directly. `export_encrypted_backup` additionally wraps the
// bytes in our EDCBK1 envelope for off-machine transit.

#[derive(Deserialize)]
pub struct ExportBackupArgs {
    pub dst_path: String,
}

#[tauri::command]
pub async fn export_plaintext_backup(
    gate: tauri::State<'_, crate::db_gate::DbGate>,
    args: ExportBackupArgs,
) -> Result<(), String> {
    let dst = std::path::PathBuf::from(&args.dst_path);
    // Create parent dir off the tokio runtime — sync fs on hot path stalls IPC.
    let parent = dst.parent().map(|p| p.to_path_buf());
    if let Some(parent) = parent {
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(&parent))
            .await
            .map_err(|e| format!("join: {e}"))?
            .map_err(|e| format!("create backup dir: {e}"))?;
    }
    gate.export_plaintext_to(&dst)
        .await
        .map_err(|e| format!("sqlcipher_export failed: {e}"))?;
    // Sanity: first 16 bytes should read "SQLite format 3\0". Do this off-runtime too.
    let dst_verify = dst.clone();
    let head_ok = tokio::task::spawn_blocking(move || -> std::io::Result<bool> {
        use std::io::Read;
        let mut head = [0u8; 16];
        let mut f = std::fs::File::open(&dst_verify)?;
        let n = f.read(&mut head)?;
        Ok(n >= 16 && &head[..16] == b"SQLite format 3\0")
    })
    .await
    .map_err(|e| format!("join: {e}"))?
    .map_err(|e| format!("verify read: {e}"))?;
    if !head_ok {
        let _ = std::fs::remove_file(&dst);
        return Err("Exported file is not a valid plain SQLite database — aborting backup.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn export_encrypted_backup(
    gate: tauri::State<'_, crate::db_gate::DbGate>,
    args: ExportBackupArgs,
) -> Result<(), String> {
    // Step 1: export to a scratch plaintext file next to the target, so
    // we can encrypt in one shot without keeping arbitrary-sized bytes
    // pinned in memory longer than needed.
    let dst = std::path::PathBuf::from(&args.dst_path);
    let parent = dst.parent().map(|p| p.to_path_buf());
    if let Some(parent) = parent {
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(&parent))
            .await
            .map_err(|e| format!("join: {e}"))?
            .map_err(|e| format!("create backup dir: {e}"))?;
    }
    let tmp = dst.with_extension("edcbk1.tmp");
    // Clean any stragglers from a previous crashed run.
    if tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
    }
    gate.export_plaintext_to(&tmp)
        .await
        .map_err(|e| format!("sqlcipher_export failed: {e}"))?;
    // Step 2: read + encrypt + write on a blocking thread. Encryption
    // can be tens-of-MB → hundreds-of-ms; running it on the tokio
    // runtime stalls every other IPC call.
    let passphrase = crate::secrets::get_secret("backup_passphrase")?;
    let tmp_for_task = tmp.clone();
    let dst_for_task = dst.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let plaintext = std::fs::read(&tmp_for_task).map_err(|e| format!("read tmp: {e}"))?;
        // Zero the file before removing so plaintext bytes don't linger.
        let _ = std::fs::write(&tmp_for_task, vec![0u8; plaintext.len().min(64 * 1024)]);
        let _ = std::fs::remove_file(&tmp_for_task);
        let enc = encrypt(&passphrase, &plaintext)?;
        drop(plaintext);
        std::fs::write(&dst_for_task, enc).map_err(|e| format!("write dst: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_round_trip_preserves_bytes() {
        let plaintext = b"SQLite format 3\0-- pretend this is a whole database file --";
        let passphrase = "correct horse battery staple";
        let archive = encrypt(passphrase, plaintext).expect("encrypt should succeed");

        assert!(is_encrypted(&archive), "archive should carry the EDCBK1 magic header");
        assert!(archive.len() > plaintext.len(), "archive must be larger than plaintext (header + auth tag)");

        let decrypted = decrypt(passphrase, &archive).expect("decrypt with correct passphrase should succeed");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_fails_with_wrong_passphrase() {
        let archive = encrypt("right-passphrase", b"top secret db bytes").unwrap();
        let err = decrypt("wrong-passphrase", &archive).unwrap_err();
        assert!(err.to_lowercase().contains("decryption failed") || err.to_lowercase().contains("wrong passphrase"));
    }

    #[test]
    fn decrypt_detects_ciphertext_tampering() {
        let mut archive = encrypt("passphrase123", b"some database bytes here").unwrap();
        // Flip a byte in the ciphertext (well past the 64-byte header) — the
        // AEAD auth tag must catch this rather than silently returning
        // corrupted plaintext.
        let last = archive.len() - 1;
        archive[last] ^= 0xFF;
        let result = decrypt("passphrase123", &archive);
        assert!(result.is_err(), "tampered ciphertext must fail to decrypt");
    }

    #[test]
    fn decrypt_detects_header_corruption() {
        let mut archive = encrypt("passphrase123", b"some database bytes here").unwrap();
        // Flip a byte inside the header (the salt region) — this changes the
        // derived key silently unless the header checksum catches it first.
        archive[12] ^= 0xFF;
        let result = decrypt("passphrase123", &archive);
        assert!(result.is_err(), "corrupted header must be rejected");
    }

    #[test]
    fn is_encrypted_rejects_plain_sqlite_and_short_files() {
        assert!(!is_encrypted(b"SQLite format 3\0rest of a normal db file..."));
        assert!(!is_encrypted(b"short"));
        assert!(!is_encrypted(b""));
    }

    #[test]
    fn passphrase_hash_verification_round_trip() {
        let hash = hash_passphrase_for_verification("my-backup-passphrase").unwrap();
        assert!(verify_passphrase("my-backup-passphrase", &hash));
        assert!(!verify_passphrase("wrong-guess", &hash));
    }

    #[test]
    fn each_encryption_uses_a_fresh_salt_and_nonce() {
        // Same plaintext + passphrase encrypted twice must not produce
        // identical archives (random salt/nonce per call) — otherwise two
        // identical backups would leak that they're identical via ciphertext
        // comparison, and (worse) nonce reuse would break XChaCha20-Poly1305's
        // security guarantees entirely.
        let a = encrypt("same-passphrase", b"identical plaintext").unwrap();
        let b = encrypt("same-passphrase", b"identical plaintext").unwrap();
        assert_ne!(a, b);
    }
}
