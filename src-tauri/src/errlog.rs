// Lightweight rolling error log shared by Rust panics and the JS global handlers.
// Writes to <app_log_dir>/error.log; rotates at ~512 KB to keep disk usage bounded.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

const MAX_BYTES: u64 = 512 * 1024;

pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("error.log");
        let _ = LOG_PATH.set(path.clone());

        // Install a panic hook that mirrors panics into the log file.
        std::panic::set_hook(Box::new(move |info| {
            let msg = format!(
                "PANIC at {}: {}",
                info.location()
                    .map(|l| format!("{}:{}", l.file(), l.line()))
                    .unwrap_or_else(|| "?".to_string()),
                info
            );
            write_line(&path, "PANIC", &msg);
            eprintln!("{msg}");
        }));
    }
}

fn write_line(path: &PathBuf, level: &str, msg: &str) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_BYTES {
            let rotated = path.with_extension("log.1");
            let _ = fs::rename(path, &rotated);
        }
    }
    let ts = chrono_like_now();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{ts}] [{level}] {msg}");
    }
}

// Tiny ISO-ish timestamp without pulling in chrono.
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // YYYY-MM-DDTHH:MM:SSZ from a basic epoch->civil conversion.
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn epoch_to_ymdhms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let h = (rem / 3600) as u32;
    let mi = ((rem % 3600) / 60) as u32;
    let s = (rem % 60) as u32;
    // Howard Hinnant's civil_from_days algorithm.
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if mo <= 2 { y + 1 } else { y };
    (y as i32, mo, d, h, mi, s)
}

#[tauri::command]
pub fn append_error_log(level: String, message: String) -> Result<(), String> {
    let path = LOG_PATH.get().ok_or_else(|| "log not initialised".to_string())?;
    // M-6: this command is reachable from any JS code path (including a
    // compromised/renderer-XSS'd frontend), so treat `level` as untrusted
    // input — allowlist the known tags rather than writing anything the
    // caller sends, and cap the message body so a single call can't blow
    // past the rotation threshold in one write.
    const ALLOWED_LEVELS: &[&str] = &["ERROR", "WARN", "INFO"];
    let level = if ALLOWED_LEVELS.contains(&level.as_str()) { level } else { "WARN".to_string() };
    const MAX_MESSAGE_BYTES: usize = 8 * 1024;
    let truncated_message = if message.len() > MAX_MESSAGE_BYTES {
        let mut cut = MAX_MESSAGE_BYTES;
        while cut > 0 && !message.is_char_boundary(cut) { cut -= 1; }
        format!("{}… [truncated, {} bytes total]", &message[..cut], message.len())
    } else {
        message
    };
    write_line(path, &level, &truncated_message);
    Ok(())
}

#[tauri::command]
pub fn read_error_log() -> Result<String, String> {
    let path = LOG_PATH.get().ok_or_else(|| "log not initialised".to_string())?;
    fs::read_to_string(path).or_else(|_| Ok(String::new()))
}

#[tauri::command]
pub fn error_log_path() -> Result<String, String> {
    let path = LOG_PATH.get().ok_or_else(|| "log not initialised".to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn clear_error_log() -> Result<(), String> {
    if let Some(path) = LOG_PATH.get() {
        let _ = fs::remove_file(path);
    }
    Ok(())
}
