// Waitlist Sync — Google Sheets service-account read-only ingestion.
//
// Safety invariants (spec §Safety, non-negotiable):
//   • Service-account JSON is ONLY stored in the OS keychain. Never touches SQLite.
//   • Never redacted-logged. Errors returned to the frontend are shortened and
//     never include the private_key bytes.
//   • Scope is HARDCODED to spreadsheets.readonly. We never call any write
//     endpoints and no Sheets write endpoint is ever used in this file.
//   • 30-second minimum interval is enforced on the TS side (module-level
//     lastSyncAt). This layer is happy to fetch on every call — the network
//     retries here handle transient 5xx / DNS blips.

use jsonwebtoken::{encode, EncodingKey, Header, Algorithm};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const SHEETS_SCOPE: &str = "https://www.googleapis.com/auth/spreadsheets.readonly";
const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const KEYRING_SERVICE: &str = "org.echelondaycare.receipts";
const KEY_NAME: &str = "waitlist_service_account_json";

// ─── Service-account key ────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
pub struct ServiceAccountKey {
    pub client_email: String,
    pub private_key: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub token_uri: Option<String>,
    #[serde(default, rename = "type")]
    #[allow(dead_code)]
    pub key_type: Option<String>,
}

impl ServiceAccountKey {
    fn token_uri(&self) -> &str {
        self.token_uri.as_deref().unwrap_or(DEFAULT_TOKEN_URI)
    }

    fn validate(&self) -> Result<(), String> {
        if self.client_email.trim().is_empty() {
            return Err("Service account JSON is missing 'client_email'.".into());
        }
        if self.private_key.trim().is_empty() {
            return Err("Service account JSON is missing 'private_key'.".into());
        }
        // project_id is a soft requirement (spec asks us to validate presence).
        if self.project_id.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
            return Err("Service account JSON is missing 'project_id'.".into());
        }
        Ok(())
    }
}

fn parse_key(json_text: &str) -> Result<ServiceAccountKey, String> {
    let sak: ServiceAccountKey = serde_json::from_str(json_text)
        .map_err(|e| format!("Invalid service account JSON: {e}"))?;
    sak.validate()?;
    Ok(sak)
}

// ─── JWT + token exchange ───────────────────────────────────────────────

#[derive(Serialize)]
struct JwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

fn build_jwt(sak: &ServiceAccountKey) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock: {e}"))?
        .as_secs();
    let claims = JwtClaims {
        iss: &sak.client_email,
        // SECURITY: scope is hardcoded read-only — never take from caller.
        scope: SHEETS_SCOPE,
        aud: sak.token_uri(),
        iat: now,
        exp: now + 3600,
    };
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("JWT".to_string());
    let key = EncodingKey::from_rsa_pem(sak.private_key.as_bytes())
        .map_err(|e| format!("Invalid RSA private_key PEM: {e}"))?;
    encode(&header, &claims, &key).map_err(|e| format!("JWT sign failed: {e}"))
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    #[allow(dead_code)]
    token_type: Option<String>,
}

async fn exchange_token(sak: &ServiceAccountKey) -> Result<(String, SystemTime), String> {
    let jwt = build_jwt(sak)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let form = [
        ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
        ("assertion", jwt.as_str()),
    ];
    let resp = client
        .post(sak.token_uri())
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token exchange: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // Never dump full body if it might contain the assertion; the OAuth
        // error body only has {error, error_description}, so it's safe.
        return Err(format!("token exchange HTTP {}: {}", status.as_u16(), truncate(&text, 400)));
    }
    let parsed: TokenResp = serde_json::from_str(&text)
        .map_err(|e| format!("token parse: {e}"))?;
    let ttl = parsed.expires_in.unwrap_or(3600);
    let expires_at = SystemTime::now() + Duration::from_secs(ttl);
    Ok((parsed.access_token, expires_at))
}

fn truncate(s: &str, n: usize) -> String {
    // L-2: `&s[..n]` panics if byte index `n` doesn't land on a UTF-8 char
    // boundary — a real risk here since this truncates arbitrary
    // API/error response text that can contain multi-byte characters.
    // Char-count based truncation is always safe.
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

// ─── Token cache ────────────────────────────────────────────────────────

struct TokenCache {
    // Cache is keyed by client_email — swapping credentials invalidates the
    // cached token automatically.
    client_email: String,
    token: String,
    expires_at: SystemTime,
}

static TOKEN_CACHE: OnceLock<Mutex<Option<TokenCache>>> = OnceLock::new();

fn token_cache() -> &'static Mutex<Option<TokenCache>> {
    TOKEN_CACHE.get_or_init(|| Mutex::new(None))
}

async fn get_access_token(sak: &ServiceAccountKey) -> Result<String, String> {
    let now = SystemTime::now();
    {
        let guard = token_cache().lock().await;
        if let Some(c) = guard.as_ref() {
            if c.client_email == sak.client_email {
                // Refresh 5 min early so we don't race the wire-clock.
                if c.expires_at > now + Duration::from_secs(300) {
                    return Ok(c.token.clone());
                }
            }
        }
    }
    let (token, expires_at) = exchange_token(sak).await?;
    let mut guard = token_cache().lock().await;
    *guard = Some(TokenCache {
        client_email: sak.client_email.clone(),
        token: token.clone(),
        expires_at,
    });
    Ok(token)
}

// ─── Sheets fetch ───────────────────────────────────────────────────────

async fn fetch_rows(sak: &ServiceAccountKey, sheet_id: &str, range: &str) -> Result<Vec<Vec<String>>, String> {
    let token = get_access_token(sak).await?;
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{}/values/{}?majorDimension=ROWS",
        urlencoding::encode_path(sheet_id),
        urlencoding::encode_path(range),
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let mut delay_ms: u64 = 500;
    let mut last_err: String = String::new();
    for attempt in 0..3u32 {
        let resp = client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await;
        match resp {
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                if status.is_success() {
                    return parse_sheets_response(&text);
                }
                // 401/403 → give up immediately (bad creds / no access to sheet).
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    return Err(format!(
                        "Sheets API {}: {}",
                        status.as_u16(),
                        truncate(&text, 400)
                    ));
                }
                last_err = format!("Sheets API {}: {}", status.as_u16(), truncate(&text, 400));
                // Retry on 5xx / 429.
                if !(status.is_server_error() || status.as_u16() == 429) {
                    return Err(last_err);
                }
            }
            Err(e) => {
                last_err = format!("network: {e}");
            }
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            delay_ms *= 2;
        }
    }
    Err(last_err)
}

fn parse_sheets_response(text: &str) -> Result<Vec<Vec<String>>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("sheets parse: {e}"))?;
    let empty: Vec<Value> = Vec::new();
    let values = v.get("values").and_then(|x| x.as_array()).unwrap_or(&empty);
    let mut out: Vec<Vec<String>> = Vec::with_capacity(values.len());
    for row in values {
        let arr = row.as_array().cloned().unwrap_or_default();
        let cells: Vec<String> = arr
            .into_iter()
            .map(|c| match c {
                Value::String(s) => s,
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                Value::Null => String::new(),
                other => other.to_string(),
            })
            .collect();
        out.push(cells);
    }
    Ok(out)
}

// Minimal URL-path percent encoder — reqwest doesn't URL-encode path segments
// for us, and the Sheets range/id may contain '!', spaces, etc. We keep it
// local to avoid pulling `url`/`percent-encoding` as new dependencies.
mod urlencoding {
    /// RFC 3986 percent-encode for use inside a URL path segment.
    /// We deliberately restrict to *unreserved* characters (A-Z a-z 0-9 -_.~)
    /// and percent-encode EVERYTHING else. In particular `!` and `:` in an A1
    /// range like `Form_Responses!A:K` become `%21` and `%3A`.
    ///
    /// Google Sheets' router is picky about `!` at parse time — leaving it raw
    /// causes `Unable to parse range: Form_Responses!A:K` even when the tab
    /// name is correct. Percent-encoding fixes it.
    pub fn encode_path(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for b in s.as_bytes() {
            let c = *b;
            let unreserved = c.is_ascii_alphanumeric()
                || matches!(c, b'-' | b'_' | b'.' | b'~');
            if unreserved {
                out.push(c as char);
            } else {
                out.push_str(&format!("%{:02X}", c));
            }
        }
        out
    }
}

// ─── Keychain helpers ───────────────────────────────────────────────────
//
// Windows Credential Manager caps single-blob passwords at 2560 UTF-16 chars
// (~5120 bytes). Google service-account JSON is ~2.5 KB → borderline; the
// PEM-embedded private_key varies and often pushes us over. We therefore
// CHUNK the JSON into 1000-char slices on Windows, storing:
//   waitlist_sa_chunks   → decimal N (chunk count)
//   waitlist_sa_1..N     → the chunks in order
//
// On macOS / Linux we use the single-entry path (KEY_NAME) — Keychain / Secret
// Service have no such limit.
//
// Legacy single-entry blobs on Windows (from v0.8.0) are still read for
// backward compatibility, then rewritten as chunks on next save.

const CHUNK_KEY_COUNT: &str = "waitlist_sa_chunks";
const CHUNK_KEY_PREFIX: &str = "waitlist_sa_";  // followed by 1-based index
const CHUNK_SIZE: usize = 1000;                 // well under 2560-wide-char cap

#[cfg(target_os = "windows")]
fn read_key_from_keychain() -> Result<Option<String>, String> {
    // Prefer chunked layout.
    let count_entry = keyring::Entry::new(KEYRING_SERVICE, CHUNK_KEY_COUNT)
        .map_err(|e| format!("keychain open: {e}"))?;
    match count_entry.get_password() {
        Ok(s) => {
            let n: usize = s.trim().parse().map_err(|_| "keychain chunk count parse".to_string())?;
            let mut out = String::with_capacity(n * CHUNK_SIZE);
            for i in 1..=n {
                let name = format!("{}{}", CHUNK_KEY_PREFIX, i);
                let entry = keyring::Entry::new(KEYRING_SERVICE, &name)
                    .map_err(|e| format!("keychain open chunk {i}: {e}"))?;
                let piece = entry.get_password()
                    .map_err(|e| format!("keychain read chunk {i}: {e}"))?;
                out.push_str(&piece);
            }
            return Ok(Some(out));
        }
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("keychain read chunks: {e}")),
    }
    // Legacy single-entry fallback (Mac migrations / old Windows installs).
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEY_NAME)
        .map_err(|e| format!("keychain open: {e}"))?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read: {e}")),
    }
}

#[cfg(target_os = "windows")]
fn write_key_to_keychain(json_text: &str) -> Result<(), String> {
    // Delete any legacy single-entry blob first so we don't leave stale data.
    let _ = keyring::Entry::new(KEYRING_SERVICE, KEY_NAME)
        .and_then(|e| e.delete_credential());
    // Wipe any prior chunk set (defensive).
    delete_chunks_windows()?;
    // Chunk on char boundaries — service-account JSON is ASCII-only, so
    // byte and char indexing coincide, but be safe with .chars().
    let chars: Vec<char> = json_text.chars().collect();
    let n = (chars.len() + CHUNK_SIZE - 1) / CHUNK_SIZE;
    for i in 0..n {
        let start = i * CHUNK_SIZE;
        let end = ((i + 1) * CHUNK_SIZE).min(chars.len());
        let piece: String = chars[start..end].iter().collect();
        let name = format!("{}{}", CHUNK_KEY_PREFIX, i + 1);
        let entry = keyring::Entry::new(KEYRING_SERVICE, &name)
            .map_err(|e| format!("keychain open chunk {}: {e}", i + 1))?;
        entry.set_password(&piece)
            .map_err(|e| format!("keychain write chunk {}: {e}", i + 1))?;
    }
    let count_entry = keyring::Entry::new(KEYRING_SERVICE, CHUNK_KEY_COUNT)
        .map_err(|e| format!("keychain open count: {e}"))?;
    count_entry.set_password(&n.to_string())
        .map_err(|e| format!("keychain write count: {e}"))
}

#[cfg(target_os = "windows")]
fn delete_key_from_keychain() -> Result<(), String> {
    // Delete legacy single-entry and any chunks + count.
    let _ = keyring::Entry::new(KEYRING_SERVICE, KEY_NAME)
        .and_then(|e| e.delete_credential());
    delete_chunks_windows()
}

#[cfg(target_os = "windows")]
fn delete_chunks_windows() -> Result<(), String> {
    let count_entry = keyring::Entry::new(KEYRING_SERVICE, CHUNK_KEY_COUNT)
        .map_err(|e| format!("keychain open count: {e}"))?;
    let n: Option<usize> = match count_entry.get_password() {
        Ok(s) => s.trim().parse().ok(),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(format!("keychain read count: {e}")),
    };
    if let Some(n) = n {
        for i in 1..=n {
            let name = format!("{}{}", CHUNK_KEY_PREFIX, i);
            if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &name) {
                let _ = entry.delete_credential();
            }
        }
    }
    // Also try a few extra indices in case we ever chunked larger before.
    for i in 1..=16 {
        let name = format!("{}{}", CHUNK_KEY_PREFIX, i);
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &name) {
            let _ = entry.delete_credential();
        }
    }
    match count_entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete count: {e}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn read_key_from_keychain() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEY_NAME)
        .map_err(|e| format!("keychain open: {e}"))?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read: {e}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn write_key_to_keychain(json_text: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEY_NAME)
        .map_err(|e| format!("keychain open: {e}"))?;
    entry.set_password(json_text).map_err(|e| format!("keychain write: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn delete_key_from_keychain() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEY_NAME)
        .map_err(|e| format!("keychain open: {e}"))?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete: {e}")),
    }
}

fn mask_email(email: &str) -> String {
    let (local, domain) = match email.split_once('@') {
        Some((l, d)) => (l, d),
        None => return "***".to_string(),
    };
    if local.is_empty() { return format!("***@{domain}"); }
    let first = local.chars().next().unwrap();
    format!("{first}***@{domain}")
}

// ─── Return types ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub row_count: usize,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct SaveCredentialsResult {
    pub client_email: String,
    pub client_email_masked: String,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub credentials_loaded: bool,
    pub client_email_masked: Option<String>,
}

#[derive(Serialize)]
pub struct FetchRowsResult {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

// ─── Tauri commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn waitlist_test_connection(
    json_text: String,
    sheet_id: String,
    range: String,
) -> Result<TestConnectionResult, String> {
    let sak = match parse_key(&json_text) {
        Ok(s) => s,
        Err(e) => {
            return Ok(TestConnectionResult { ok: false, row_count: 0, error: Some(e) });
        }
    };
    match fetch_rows(&sak, &sheet_id, &range).await {
        Ok(rows) => Ok(TestConnectionResult {
            ok: true,
            row_count: rows.len(),
            error: None,
        }),
        Err(e) => Ok(TestConnectionResult { ok: false, row_count: 0, error: Some(e) }),
    }
}

#[tauri::command]
pub async fn waitlist_save_credentials(
    json_text: String,
) -> Result<SaveCredentialsResult, String> {
    let sak = parse_key(&json_text)?;
    // Write the ORIGINAL text (not the parsed struct) so we round-trip fields
    // like private_key_id, client_id, etc. that Google may add later.
    write_key_to_keychain(&json_text)?;
    Ok(SaveCredentialsResult {
        client_email_masked: mask_email(&sak.client_email),
        client_email: sak.client_email,
    })
}

#[tauri::command]
pub async fn waitlist_clear_credentials() -> Result<(), String> {
    // Also blow away the in-memory access token so the next fetch can't reuse
    // a cached token from the just-cleared identity.
    {
        let mut guard = token_cache().lock().await;
        *guard = None;
    }
    delete_key_from_keychain()
}

#[tauri::command]
pub async fn waitlist_get_status() -> Result<StatusResult, String> {
    let stored = read_key_from_keychain()?;
    let masked = match stored {
        Some(json_text) => match serde_json::from_str::<ServiceAccountKey>(&json_text) {
            Ok(sak) => Some(mask_email(&sak.client_email)),
            // Corrupt JSON in keychain — surface as "loaded but unusable".
            Err(_) => Some("***@invalid".to_string()),
        },
        None => None,
    };
    Ok(StatusResult {
        credentials_loaded: masked.is_some(),
        client_email_masked: masked,
    })
}

#[tauri::command]
pub async fn waitlist_fetch_rows(
    sheet_id: String,
    range: String,
) -> Result<FetchRowsResult, String> {
    let json_text = read_key_from_keychain()?
        .ok_or_else(|| "Waitlist credentials not configured.".to_string())?;
    let sak = parse_key(&json_text)?;
    let mut rows = fetch_rows(&sak, &sheet_id, &range).await?;
    let header = if rows.is_empty() {
        Vec::new()
    } else {
        rows.remove(0)
    };
    Ok(FetchRowsResult { header, rows })
}
