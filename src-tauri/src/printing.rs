// Native print via Tauri's WebviewWindow::print(). On macOS/WKWebView the
// JS `window.print()` call is unreliable in Tauri v2 (silently no-ops in
// some contexts), so we route every Print button through this native
// command which invokes the platform print dialog directly.
use tauri::Manager;

#[tauri::command]
pub fn print_current_window(app: tauri::AppHandle, label: Option<String>) -> Result<(), String> {
    let label = label.unwrap_or_else(|| "main".to_string());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no webview window with label {label}"))?;
    window.print().map_err(|e| format!("print failed: {e}"))
}
