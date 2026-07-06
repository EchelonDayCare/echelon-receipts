// H-7: centralised secret retrieval. Secrets (Azure AI key, SMTP password)
// used to cross the IPC boundary as plaintext command arguments — the
// frontend fetched them from the OS keychain via `keychain_get` and handed
// them straight back to Rust as a function parameter. Any other code with
// IPC visibility (a compromised renderer, a devtools console, a future
// plugin) could intercept them in transit. Commands that need a secret now
// resolve it themselves, in-process, via this helper — the frontend only
// ever sends non-secret configuration.
const KEYRING_SERVICE: &str = "org.echelondaycare.receipts";

/// Fetch a secret from the OS keychain. Returns Err with a user-facing
/// message (safe to show — never includes the secret itself) if the entry
/// is missing or the keychain backend errors.
pub fn get_secret(key: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) if !p.is_empty() => Ok(p),
        Ok(_) => Err(format!("'{key}' is set but empty in the keychain.")),
        Err(keyring::Error::NoEntry) => Err(format!("'{key}' is not configured. Set it in Settings.")),
        Err(e) => Err(e.to_string()),
    }
}

/// Same as `get_secret` but returns `None` instead of `Err` when the secret
/// is simply absent — for callers where the secret is optional (e.g. a
/// consensus provider that's skipped when no key is configured).
pub fn get_secret_opt(key: &str) -> Option<String> {
    get_secret(key).ok()
}
