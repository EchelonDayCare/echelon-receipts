//! GitHub PAT storage + verification for the Website CMS.
//!
//! # Storage
//! Under keychain entry
//! `echelon-website-cms-github-pat` in the same
//! `org.echelondaycare.receipts` service `secrets.rs` uses. Kept
//! separate from the Azure AI key so a scope reset doesn't cascade.
//!
//! # Verification
//! Before storing, the frontend "Connect" wizard calls
//! [`verify_pat`], which hits
//! `GET https://api.github.com/repos/EchelonDayCare/echelon-website`
//! with the PAT. Success = 200 with a `permissions.push == true`
//! (fine-grained PAT with contents:write). This makes an accidentally
//! read-only token fail fast, before the user thinks they're
//! configured and hits publish.

use serde::Deserialize;

const KEYRING_SERVICE: &str = "org.echelondaycare.receipts";
const KEYRING_KEY: &str = "echelon-website-cms-github-pat";
const REPO_URL: &str = "https://api.github.com/repos/EchelonDayCare/echelon-website";

/// Report from the verification step.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PatVerification {
    pub ok: bool,
    pub message: String,
    /// True iff the token has `push` permission on the repo. Without
    /// this, publish will fail on push.
    pub can_push: bool,
    /// GitHub login that owns/uses the token (best-effort, might be
    /// empty for classic PATs).
    pub user_login: Option<String>,
}

/// Fetch the token from the OS keychain. Returns None if no token
/// stored.
pub fn load_pat() -> Result<Option<String>, String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) if !p.is_empty() => Ok(Some(p)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Store the token in the OS keychain.
pub fn store_pat(pat: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY).map_err(|e| e.to_string())?;
    entry.set_password(pat).map_err(|e| e.to_string())
}

/// Delete the token from the OS keychain. Missing-entry is treated
/// as success (idempotent disconnect).
pub fn delete_pat() -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Report whether a token is currently stored (no value returned).
pub fn is_stored() -> Result<bool, String> {
    Ok(load_pat()?.is_some())
}

#[derive(Debug, Deserialize)]
struct RepoResponse {
    #[serde(default)]
    full_name: Option<String>,
    #[serde(default)]
    permissions: Option<RepoPermissions>,
}

#[derive(Debug, Deserialize, Default)]
struct RepoPermissions {
    #[serde(default)]
    push: bool,
    #[serde(default)]
    admin: bool,
    #[serde(default)]
    maintain: bool,
}

#[derive(Debug, Deserialize)]
struct UserResponse {
    #[serde(default)]
    login: Option<String>,
}

/// Call GitHub to verify the token. Non-network errors (bad URL,
/// missing HTTP client) surface as `Err`. Network failures where the
/// server responded but the token is wrong come back as
/// `Ok(PatVerification { ok: false, ... })`.
pub async fn verify_pat(pat: &str) -> Result<PatVerification, String> {
    let client = reqwest::Client::builder()
        .user_agent("echelon-receipts-cms/3.20")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    // GET repo — must return 200 with permissions.push == true.
    let resp = client
        .get(REPO_URL)
        .bearer_auth(pat)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("call github: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Ok(PatVerification {
            ok: false,
            message: format!("GitHub returned {status} — check the token or its scope"),
            can_push: false,
            user_login: None,
        });
    }
    let body: RepoResponse = resp
        .json()
        .await
        .map_err(|e| format!("parse github response: {e}"))?;
    let permissions = body.permissions.unwrap_or_default();
    let can_push = permissions.push || permissions.admin || permissions.maintain;

    // Best-effort user probe. If this fails we still report ok — the
    // repo check is the real gate.
    let login = client
        .get("https://api.github.com/user")
        .bearer_auth(pat)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()
        .and_then(|r| if r.status().is_success() { Some(r) } else { None });
    let login = if let Some(r) = login {
        r.json::<UserResponse>().await.ok().and_then(|u| u.login)
    } else {
        None
    };

    if !can_push {
        return Ok(PatVerification {
            ok: false,
            message: "Token is valid but does not have push access to this repo. Grant contents:write."
                .into(),
            can_push: false,
            user_login: login,
        });
    }
    Ok(PatVerification {
        ok: true,
        message: format!(
            "Connected to {}. Push access confirmed.",
            body.full_name.as_deref().unwrap_or("EchelonDayCare/echelon-website")
        ),
        can_push: true,
        user_login: login,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real keychain access is flaky in CI; we test the roundtrip
    // manually with a randomised key to avoid stomping on real
    // stored secrets on the developer's box.
    #[test]
    fn keychain_roundtrip_ok() {
        // Use a random suffix so parallel test runs don't collide.
        let key = format!(
            "echelon-website-cms-github-pat-testonly-{}",
            std::process::id()
        );
        let service = KEYRING_SERVICE;
        let entry = match keyring::Entry::new(service, &key) {
            Ok(e) => e,
            Err(_) => return, // Test env without a keychain — skip.
        };
        // Set and get back.
        if entry.set_password("token-abc-123").is_err() {
            return; // no keychain on this runner
        }
        let got = entry.get_password().unwrap();
        assert_eq!(got, "token-abc-123");
        let _ = entry.delete_credential();
    }
}
