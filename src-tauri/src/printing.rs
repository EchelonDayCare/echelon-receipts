// Native print via Tauri's WebviewWindow::print(). On macOS/WKWebView the
// JS `window.print()` call is unreliable in Tauri v2 (silently no-ops in
// some contexts), so we route every Print button through this native
// command which invokes the platform print dialog directly.
//
// v2.6.4: on some Windows/WebView2 configurations the native print()
// also silently no-ops (no dialog, no error). We ship a second command
// `print_html_via_browser` that writes the print-only HTML to a temp
// file and opens it with the default browser — the browser's own print
// preview is always reachable via Ctrl+P (or auto-triggered via a
// bundled onload script).
use std::io::Write;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn print_current_window(app: tauri::AppHandle, label: Option<String>) -> Result<(), String> {
    let label = label.unwrap_or_else(|| "main".to_string());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no webview window with label {label}"))?;
    window.print().map_err(|e| format!("print failed: {e}"))
}

/// Fallback: write HTML to the app cache directory and open it in the OS
/// default browser. The HTML should include a `window.onload = () =>
/// window.print()` so the print dialog auto-appears. Guaranteed to work
/// when the WebView2/WKWebView native print path silently no-ops.
///
/// v2.6.4: Uses the app-local-data directory (Tauri's per-platform
/// `$APPLOCALDATA` path, in `opener:allow-open-path` scope on both
/// Windows and macOS per `capabilities/default.json`) instead of the
/// raw OS temp dir. The raw temp dir on macOS (`/var/folders/.../T/`)
/// is outside the opener scope and would be denied on Mac. Best-effort
/// prune keeps only the 5 newest snapshots so daily use doesn't leak
/// megabytes over months.
#[tauri::command]
pub fn print_html_via_browser(app: tauri::AppHandle, html: String) -> Result<(), String> {
    use tauri::path::BaseDirectory;

    // Prefer the app-local-data dir (explicitly in `opener:allow-open-path`
    // scope on both Windows and macOS per capabilities/default.json).
    // Falls back to raw temp only if the resolve fails — that fallback
    // will be denied by the opener on macOS but at least the file still
    // exists for manual open.
    let dir_root = app
        .path()
        .resolve("print-snapshots", BaseDirectory::AppLocalData)
        .unwrap_or_else(|_| {
            let mut t = std::env::temp_dir();
            t.push("echelon-print-snapshots");
            t
        });
    std::fs::create_dir_all(&dir_root).map_err(|e| format!("create snapshot dir: {e}"))?;
    prune_stale_print_files(&dir_root);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut file_path = dir_root.clone();
    file_path.push(format!("echelon-print-{stamp}.html"));
    {
        let mut f = std::fs::File::create(&file_path).map_err(|e| format!("create snapshot html: {e}"))?;
        f.write_all(html.as_bytes())
            .map_err(|e| format!("write snapshot html: {e}"))?;
    }
    let path_str = file_path.to_string_lossy().to_string();
    let open_result = app.opener().open_path(path_str, None::<&str>);

    // v2.6.4 (Codex R3 MED): if the opener denies the path (macOS scope
    // rejection, no default browser, etc.), the snapshot HTML would
    // otherwise sit on disk with PII until the next prune. Delete
    // immediately on failure before returning the error.
    if let Err(e) = open_result {
        let _ = std::fs::remove_file(&file_path);
        return Err(format!("open browser: {e}"));
    }

    // v2.6.4 (Sonnet R2 MED): the snapshot contains PII (receipts,
    // reports, addresses). Prune-on-next-use is not enough — if the
    // fallback fires once and never again, the file sits on disk
    // indefinitely. Schedule a delete ~45s after open, long enough for
    // the browser to have parsed + rendered + fired print, but short
    // enough that a shared-workstation attacker can't casually grab it.
    // Best-effort: silently ignore if the browser still has it locked.
    let cleanup_path = file_path.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(45));
        let _ = std::fs::remove_file(&cleanup_path);
    });

    Ok(())
}

/// Delete every `echelon-print-*.html` in the temp dir except the 5 most
/// recent (which the OS default browser may still have open). Best-effort:
/// silently ignores per-file failures (e.g. still locked by the browser).
fn prune_stale_print_files(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut candidates: Vec<(std::path::PathBuf, std::time::SystemTime)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("echelon-print-")
        })
        .filter_map(|e| {
            let path = e.path();
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((path, mtime))
        })
        .collect();
    // Newest first.
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in candidates.into_iter().skip(5) {
        let _ = std::fs::remove_file(&path);
    }
}

