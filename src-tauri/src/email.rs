use base64::Engine;
use lettre::message::header::ContentType;
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

        let email = if attachments.is_empty() {
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
