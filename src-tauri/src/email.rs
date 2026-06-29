use base64::Engine;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct SendEmailArgs {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    pub attachment_b64: String,
    pub attachment_filename: String,
    #[serde(default)]
    pub attachment_mime: Option<String>,
}

#[tauri::command]
pub async fn send_email(args: SendEmailArgs) -> Result<(), String> {
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

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(args.attachment_b64.as_bytes())
            .map_err(|e| format!("attachment decode: {e}"))?;
        let mime = args.attachment_mime.as_deref().unwrap_or("application/pdf");
        let content_type = ContentType::parse(mime)
            .unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
        let attachment = Attachment::new(args.attachment_filename)
            .body(bytes, content_type);

        let email = builder
            .multipart(
                MultiPart::mixed()
                    .singlepart(SinglePart::plain(args.body_text))
                    .singlepart(attachment),
            )
            .map_err(|e| format!("build: {e}"))?;

        let creds = Credentials::new(args.smtp_user, args.smtp_password);
        let mailer = SmtpTransport::starttls_relay(&args.smtp_host)
            .map_err(|e| format!("starttls: {e}"))?
            .port(args.smtp_port)
            .credentials(creds)
            .build();
        mailer.send(&email).map_err(|e| format!("send: {e}"))?;
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

#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
