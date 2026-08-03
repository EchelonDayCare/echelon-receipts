use base64::Engine;
use lettre::message::header::{ContentType, HeaderName, HeaderValue};
use lettre::message::{Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct EmailAttachment {
    pub filename: String,
    pub b64: String,
    #[serde(default)]
    pub mime: Option<String>,
}

#[derive(Deserialize)]
pub struct SendEmailArgs {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    // Legacy single-attachment fields (still supported for existing callers).
    #[serde(default)]
    pub attachment_b64: Option<String>,
    #[serde(default)]
    pub attachment_filename: Option<String>,
    #[serde(default)]
    pub attachment_mime: Option<String>,
    // New multi-attachment field. If provided, takes precedence over the legacy
    // single-attachment fields. Pass an empty array for body-only emails.
    #[serde(default)]
    pub attachments: Option<Vec<EmailAttachment>>,
    // Deliverability additions (v2.6.7): all optional so existing callers work.
    // reply_to: where replies should go. If different from from_email, we set
    // the header. Gmail rewrites From to match SMTP auth, but Reply-To is kept
    // intact — parents replying still reach the intended inbox.
    #[serde(default)]
    pub reply_to: Option<String>,
    // list_unsubscribe: RFC 8058 mailto:/https: value. When set we also emit
    // List-Unsubscribe-Post so Gmail can honour one-click unsubscribe. Required
    // for bulk sends under Google's Feb-2024 sender rules; harmless on
    // one-off transactional receipts.
    #[serde(default)]
    pub list_unsubscribe: Option<String>,
}

#[tauri::command]
pub async fn send_email(args: SendEmailArgs) -> Result<(), String> {
    // H-7: resolve the SMTP password server-side instead of accepting it as
    // a plaintext IPC argument.
    let smtp_password = crate::secrets::get_secret("smtp_password")?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let from = format!("{} <{}>", args.from_name, args.from_email)
            .parse()
            .map_err(|e: lettre::address::AddressError| format!("from: {e}"))?;
        let mut builder = Message::builder().from(from).subject(args.subject);
        if let Some(rt) = args.reply_to.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let parsed = rt
                .parse()
                .map_err(|e: lettre::address::AddressError| format!("reply_to {rt}: {e}"))?;
            builder = builder.reply_to(parsed);
        }
        for t in &args.to {
            builder = builder.to(t.parse().map_err(|e: lettre::address::AddressError| format!("to {t}: {e}"))?);
        }
        for c in &args.cc {
            builder = builder.cc(c.parse().map_err(|e: lettre::address::AddressError| format!("cc {c}: {e}"))?);
        }
        for b in &args.bcc {
            builder = builder.bcc(b.parse().map_err(|e: lettre::address::AddressError| format!("bcc {b}: {e}"))?);
        }

        let bytes_result: Result<Vec<(String, Vec<u8>, ContentType)>, String> = (|| {
            let mut out: Vec<(String, Vec<u8>, ContentType)> = Vec::new();
            let list = match &args.attachments {
                Some(v) => {
                    // Explicit list wins — even if empty (body-only email).
                    let mut mapped: Vec<(String, String, Option<String>)> = Vec::new();
                    for a in v {
                        mapped.push((a.filename.clone(), a.b64.clone(), a.mime.clone()));
                    }
                    mapped
                }
                None => {
                    // Legacy path — single attachment via top-level fields.
                    match (&args.attachment_b64, &args.attachment_filename) {
                        (Some(b64), Some(fname)) if !b64.is_empty() && !fname.is_empty() => {
                            vec![(fname.clone(), b64.clone(), args.attachment_mime.clone())]
                        }
                        _ => Vec::new(),
                    }
                }
            };
            for (fname, b64, mime) in list {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64.as_bytes())
                    .map_err(|e| format!("attachment '{fname}' decode: {e}"))?;
                let mime = mime.as_deref().unwrap_or("application/pdf");
                let content_type = ContentType::parse(mime)
                    .unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
                out.push((fname, bytes, content_type));
            }
            Ok(out)
        })();
        let attachments = bytes_result?;

        let mut email = if attachments.is_empty() {
            builder
                .singlepart(SinglePart::plain(args.body_text))
                .map_err(|e| format!("build: {e}"))?
        } else {
            let mut mp = MultiPart::mixed().singlepart(SinglePart::plain(args.body_text));
            for (fname, bytes, ctype) in attachments {
                mp = mp.singlepart(Attachment::new(fname).body(bytes, ctype));
            }
            builder.multipart(mp).map_err(|e| format!("build: {e}"))?
        };

        // Deliverability headers, injected after build because lettre 0.11
        // requires a typed `Header` impl on the builder API but exposes raw
        // insertion on `Message::headers_mut()`.
        //
        // X-Mailer: identifies our transactional app to inbox providers.
        // Cheap signal of legitimate tooling.
        {
            let headers = email.headers_mut();
            headers.insert_raw(HeaderValue::new(
                HeaderName::new_from_ascii_str("X-Mailer"),
                format!("Echelon Receipts/{}", env!("CARGO_PKG_VERSION")),
            ));
            // List-Unsubscribe + List-Unsubscribe-Post: RFC 8058 one-click
            // unsubscribe. Required by Gmail's Feb-2024 bulk sender rules;
            // safe (and mildly positive) even on single-recipient receipts.
            if let Some(lu) = args
                .list_unsubscribe
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                headers.insert_raw(HeaderValue::new(
                    HeaderName::new_from_ascii_str("List-Unsubscribe"),
                    format!("<{}>", lu),
                ));
                // RFC 8058 §3.1: List-Unsubscribe-Post: One-Click is only
                // valid when the List-Unsubscribe value contains an HTTPS
                // URI (POST-able). With a mailto:-only target, strict
                // receivers treat the Post header as a misconfiguration.
                // Gate accordingly so we can safely add an HTTPS endpoint
                // later and get the One-Click benefit without changing Rust.
                if lu.to_ascii_lowercase().contains("https:") {
                    headers.insert_raw(HeaderValue::new(
                        HeaderName::new_from_ascii_str("List-Unsubscribe-Post"),
                        "List-Unsubscribe=One-Click".to_string(),
                    ));
                }
            }
        }

        let pw = smtp_password.clone();
        let redact = |s: String| if pw.is_empty() { s } else { s.replace(&pw, "***") };
        // v3.10.0: fetch a cached SmtpTransport (or build + cache one).
        // Lettre's built-in r2d2 pool means subsequent `.send()` calls
        // against the same transport reuse an idle TLS+auth session,
        // eliminating the per-send handshake tax for batched flows
        // (grad emails, monthly receipts).
        let (mailer, cache_key) = get_or_build_transport(
            &args.smtp_host,
            args.smtp_port,
            &args.smtp_user,
            &smtp_password,
        )
        .map_err(&redact)?;
        match mailer.send(&email) {
            Ok(_) => Ok(()),
            Err(e) => {
                // Sonnet review #1: a cached transport that starts failing
                // (server reboot, TLS rotation, network moved) would
                // otherwise poison the rest of a batch. Evict on error so
                // the next attempt rebuilds fresh.
                cache_evict(&cache_key);
                Err(redact(format!("send: {e}")))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

const KEYRING_SERVICE: &str = "org.echelondaycare.receipts";

// ----------------------------------------------------------------------
// v3.10.0 — SmtpTransport cache (connection pool reuse across sends)
// ----------------------------------------------------------------------
//
// The one-off `send_email` command previously built a fresh
// `SmtpTransport` on every invocation, which discarded lettre's internal
// r2d2 connection pool between calls. For the v3.8.0 grad-email flow —
// which serially fires `send_email` once per parent — that means 20
// full TLS handshakes + 20 SASL AUTH exchanges for a 20-kid class.
//
// Lettre already implements pooling: repeated `.send()` calls on the
// SAME `SmtpTransport` instance reuse an idle connection from the pool
// (default idle timeout 60s, more than enough for our per-row cadence).
// We therefore cache `SmtpTransport` values keyed by the identity of
// the SMTP connection so the pool sticks across the whole batch. This
// keeps the frontend's per-row streaming UX (log lines still appear
// after each parent) while collapsing the network overhead into a
// single handshake.
//
// Cache key: (host, port, user, password_fingerprint). Password is not
// stored in the key — only a SHA-256 fingerprint — so no plaintext
// secret is retained in memory beyond the transport object itself
// (which lettre already holds via `Credentials`). Rotating the SMTP
// password invalidates the cache entry safely: the new key won't hit
// the old entry, a fresh transport is built, and the stale one drops
// its pooled sockets on eviction (below).
//
// Cache lifetime: bounded (16 entries max). Older entries are evicted
// LRU-style when a new distinct connection is inserted. This prevents
// runaway memory in the unlikely event that host/user rotates in the
// same session.

fn transport_cache() -> &'static std::sync::Mutex<
    std::collections::VecDeque<(TransportKey, std::sync::Arc<SmtpTransport>)>,
> {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<std::collections::VecDeque<(TransportKey, std::sync::Arc<SmtpTransport>)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::VecDeque::new()))
}

#[derive(PartialEq, Eq, Clone)]
struct TransportKey {
    host: String,
    port: u16,
    user: String,
    pw_fingerprint: [u8; 32],
}

fn password_fingerprint(pw: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(pw.as_bytes());
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

const TRANSPORT_CACHE_MAX: usize = 16;

/// Return a cached `SmtpTransport` for the given identity, or `None`
/// if none is cached. Extracted from `get_or_build_transport` so the
/// mutex is held only for the O(N) lookup, NOT across DNS resolution
/// inside `SmtpTransport::build()`. Concurrent senders against
/// different keys therefore don't block each other during a slow DNS
/// or TLS handshake (Sonnet #4).
fn cached_transport(key: &TransportKey) -> Option<std::sync::Arc<SmtpTransport>> {
    let mut cache = transport_cache().lock().ok()?;
    let pos = cache.iter().position(|(k, _)| k == key)?;
    let (k, t) = cache.remove(pos).unwrap();
    let clone = std::sync::Arc::clone(&t);
    // Move to the back so it's now MRU.
    cache.push_back((k, t));
    Some(clone)
}

/// Insert a freshly-built transport into the cache, evicting the
/// oldest entry on overflow. If another sender raced ahead and already
/// inserted a transport for the same key, prefer the existing entry
/// (its pool may already have a warm connection) — accept the "wasted"
/// build on our side rather than double-inserting.
fn cache_insert(
    key: TransportKey,
    transport: std::sync::Arc<SmtpTransport>,
) -> std::sync::Arc<SmtpTransport> {
    let Ok(mut cache) = transport_cache().lock() else {
        return transport; // lock poisoned — just return without caching
    };
    if let Some(pos) = cache.iter().position(|(k, _)| k == &key) {
        // A concurrent build won the race — use theirs, drop ours.
        return std::sync::Arc::clone(&cache[pos].1);
    }
    if cache.len() >= TRANSPORT_CACHE_MAX {
        cache.pop_front();
    }
    cache.push_back((key, std::sync::Arc::clone(&transport)));
    transport
}

/// Evict any cached entry matching `key`. Called when a `send()` fails
/// against a cached transport — the next attempt then rebuilds fresh
/// rather than re-hitting a poisoned pool (Sonnet #1 — the "one hiccup
/// kills the rest of the batch" trap).
fn cache_evict(key: &TransportKey) {
    if let Ok(mut cache) = transport_cache().lock() {
        cache.retain(|(k, _)| k != key);
    }
}

/// Return a `SmtpTransport` for the given connection identity, reusing
/// a cached instance whose internal pool may already hold a warm
/// connection. Building lettre's `SmtpTransport` is cheap; the win
/// comes from `.send()` reusing the pooled TCP+TLS+auth session on
/// subsequent invocations against the same key.
///
/// Returns the built `Arc<SmtpTransport>` alongside its cache key so
/// the caller can `cache_evict(&key)` on a send error. Wrapping in
/// `Arc` is defensive: today `SmtpTransport::clone()` shares
/// `Arc<Pool>` internally (lettre 0.11), so cloning already shares the
/// pool. The explicit outer `Arc` documents this intent and stays
/// correct even if lettre's internals change in a future release
/// (Sonnet #2).
fn get_or_build_transport(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
) -> Result<(std::sync::Arc<SmtpTransport>, TransportKey), String> {
    let key = TransportKey {
        host: host.to_string(),
        port,
        user: user.to_string(),
        pw_fingerprint: password_fingerprint(password),
    };
    if let Some(t) = cached_transport(&key) {
        return Ok((t, key));
    }
    // Build OUTSIDE the mutex — starttls_relay + build() perform DNS
    // resolution and are potentially blocking.
    let creds = Credentials::new(user.to_string(), password.to_string());
    let transport = SmtpTransport::starttls_relay(host)
        .map_err(|e| format!("starttls: {e}"))?
        .port(port)
        .credentials(creds)
        .build();
    let arc = std::sync::Arc::new(transport);
    let stored = cache_insert(key.clone(), arc);
    Ok((stored, key))
}

#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

// Internal-only keychain read. Deliberately NOT exposed as a `#[tauri::command]`
// so a malicious renderer (or a prompt-injection into a print HTML) can't
// fish arbitrary secrets out of the OS keyring. Callers on the Rust side
// use this helper; the JS side uses a scoped command (see `get_azure_ai_key`).
pub(crate) fn keychain_get_internal(key: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// Scoped, single-purpose keychain read. The renderer needs the Azure AI key
// to make Azure OpenAI calls directly (chat/completion with AbortSignal —
// see src/lib/aiDraft.ts). This command hard-codes the key name so a
// compromised renderer cannot pivot into other secrets (SMTP password,
// backup passphrase, etc.).
#[tauri::command]
pub fn get_azure_ai_key() -> Result<Option<String>, String> {
    keychain_get_internal("azure_ai_key")
}

#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
