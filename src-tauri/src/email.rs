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

        let creds = Credentials::new(args.smtp_user, smtp_password.clone());
        let pw = smtp_password;
        let redact = |s: String| if pw.is_empty() { s } else { s.replace(&pw, "***") };
        let mailer = SmtpTransport::starttls_relay(&args.smtp_host)
            .map_err(|e| redact(format!("starttls: {e}")))?
            .port(args.smtp_port)
            .credentials(creds)
            .build();
        mailer.send(&email).map_err(|e| redact(format!("send: {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

const KEYRING_SERVICE: &str = "org.echelondaycare.receipts";

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
