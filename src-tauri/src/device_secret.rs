// Day 3: device-bound secret for the v2.0.0 security envelope.
//
// A 32-byte cryptographically-random value stored in the OS keychain
// (macOS Keychain via keyring crate → Security.framework SecItem;
// Windows Credential Manager via keyring crate → wincred).
//
// Purpose: fold this secret into every KEK so a stolen `security.json`
// cannot be brute-forced offline on another machine. An attacker must
// also successfully copy or read this keychain entry — which requires
// the user's OS-level credentials.
//
// Threat considered mitigated:
//   * Casual snooping / file copy: even with `security.json` in hand,
//     the attacker cannot derive any KEK without this secret.
//   * Stolen laptop with locked screen: keychain entries are protected
//     by the OS lock; a raw disk pull without the OS credentials yields
//     nothing.
//
// Threat NOT mitigated here (handled elsewhere):
//   * Malware running as the logged-in user: can call keyring APIs and
//     read this secret. Biometric-gated key release (Day 6/7) is the
//     defense for that class.
//   * Domain-joined Windows setups with Credential Manager roaming:
//     the "device-bound" property degrades to "user-bound". For Echelon
//     (personal, non-domain devices) this is acceptable. A future v2.1
//     could switch Windows to DPAPI-with-machine-scope or NCrypt TPM
//     for hard device binding.

use base64::Engine;
use rand::{rngs::OsRng, RngCore};

/// Same service string the rest of the app uses.
const KEYRING_SERVICE: &str = "org.echelondaycare.receipts";
/// Distinct key so this doesn't collide with SMTP / Azure secrets.
const DEVICE_SECRET_KEY: &str = "v2.device_bound_secret";

const DEVICE_SECRET_LEN: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum DeviceSecretError {
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("stored device secret is corrupted (not valid base64 or wrong length)")]
    Corrupted,
}

/// Return the device-bound secret, creating and persisting one on first
/// call. Idempotent — subsequent calls always return the same value for
/// the lifetime of the OS user account on this machine.
///
/// The returned bytes are wrapped in `Zeroizing` so callers don't
/// accidentally leak them via `Debug` or long-lived buffers.
pub fn get_or_create() -> Result<zeroize::Zeroizing<Vec<u8>>, DeviceSecretError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, DEVICE_SECRET_KEY)
        .map_err(|e| DeviceSecretError::Keychain(e.to_string()))?;

    match entry.get_password() {
        Ok(existing) if !existing.is_empty() => decode(&existing),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let fresh = generate();
            let encoded = base64::engine::general_purpose::STANDARD.encode(&*fresh);
            entry
                .set_password(&encoded)
                .map_err(|e| DeviceSecretError::Keychain(e.to_string()))?;
            Ok(fresh)
        }
        Err(e) => Err(DeviceSecretError::Keychain(e.to_string())),
    }
}

/// Best-effort peek: return the existing secret without creating one.
/// Used by the migration state machine to detect whether the app has
/// already been through first-run.
pub fn peek() -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, DeviceSecretError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, DEVICE_SECRET_KEY)
        .map_err(|e| DeviceSecretError::Keychain(e.to_string()))?;
    match entry.get_password() {
        Ok(existing) if !existing.is_empty() => Ok(Some(decode(&existing)?)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(DeviceSecretError::Keychain(e.to_string())),
    }
}

/// Delete the device-bound secret. IRREVERSIBLE — any envelopes wrapped
/// with the deleted secret become permanently un-openable. Only called
/// by the explicit "Disable security" flow, after the user has re-wrapped
/// the MDK without the device secret component (i.e. gone back to
/// plaintext DB).
#[allow(dead_code)] // Wired up in Day 5 (DB gate module).
pub fn delete() -> Result<(), DeviceSecretError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, DEVICE_SECRET_KEY)
        .map_err(|e| DeviceSecretError::Keychain(e.to_string()))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(DeviceSecretError::Keychain(e.to_string())),
    }
}

fn generate() -> zeroize::Zeroizing<Vec<u8>> {
    let mut buf = zeroize::Zeroizing::new(vec![0u8; DEVICE_SECRET_LEN]);
    OsRng.fill_bytes(&mut buf);
    buf
}

fn decode(encoded: &str) -> Result<zeroize::Zeroizing<Vec<u8>>, DeviceSecretError> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| DeviceSecretError::Corrupted)?;
    if raw.len() != DEVICE_SECRET_LEN {
        return Err(DeviceSecretError::Corrupted);
    }
    Ok(zeroize::Zeroizing::new(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests hit the real OS keychain. On CI that lacks a keychain
    // (bare Linux runners), they are skipped by returning early on the
    // first keychain error. On Windows and macOS runners they should pass.
    //
    // We use a *test-scoped* keychain entry so we never trample the real
    // production one, and we always clean up.

    const TEST_SERVICE: &str = "org.echelondaycare.receipts.test";
    const TEST_KEY: &str = "v2.device_secret.unit_test";

    fn test_entry() -> Option<keyring::Entry> {
        keyring::Entry::new(TEST_SERVICE, TEST_KEY).ok()
    }

    fn cleanup(e: &keyring::Entry) {
        let _ = e.delete_credential();
    }

    #[test]
    fn round_trip_via_keyring() {
        let Some(entry) = test_entry() else {
            eprintln!("skipping: keyring unavailable");
            return;
        };
        cleanup(&entry);

        // Simulate get_or_create against the test entry.
        let fresh = generate();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&*fresh);
        if entry.set_password(&encoded).is_err() {
            eprintln!("skipping: keyring set failed (unsupported backend)");
            return;
        }
        let read_back = entry.get_password().expect("get after set");
        let decoded = decode(&read_back).expect("valid encoding");
        assert_eq!(&*fresh, &*decoded);

        cleanup(&entry);
    }

    #[test]
    fn decode_rejects_wrong_length() {
        // 16 bytes -> too short after base64 decode.
        let bad = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        assert!(matches!(decode(&bad), Err(DeviceSecretError::Corrupted)));
    }

    #[test]
    fn decode_rejects_non_base64() {
        assert!(matches!(decode("not-base64!!!"), Err(DeviceSecretError::Corrupted)));
    }

    #[test]
    fn generate_produces_correct_length_and_entropy() {
        let a = generate();
        let b = generate();
        assert_eq!(a.len(), DEVICE_SECRET_LEN);
        assert_ne!(&*a, &*b);
        assert!(a.iter().any(|&byte| byte != 0));
    }
}
