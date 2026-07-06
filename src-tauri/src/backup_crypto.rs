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
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
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

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("key derivation failed: {e}"))?;
    Ok(key)
}

/// Argon2id PHC hash for passphrase *verification only* — this is never
/// used to derive the encryption key (that always uses the per-archive
/// random salt above); it just confirms the user typed the right passphrase.
pub fn hash_passphrase_for_verification(passphrase: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut PhOsRng);
    Argon2::default()
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
