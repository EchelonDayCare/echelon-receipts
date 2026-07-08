// Cross-platform print helper.
//
// On macOS (WKWebView) `window.print()` is unreliable in Tauri v2 — it can
// silently no-op depending on where the click originates. We route every
// Print button through this helper, which asks the native Tauri window to
// invoke the platform print dialog directly.
//
// Falls back to `window.print()` if the invoke fails (e.g. dev-server
// preview outside Tauri) so browser preview keeps working.
import { invoke } from "@tauri-apps/api/core";

let warned = false;

export async function printCurrentWindow(): Promise<void> {
  try {
    await invoke("print_current_window", { label: null });
  } catch (e) {
    if (!warned) {
      console.warn("[print] native print failed, falling back to window.print():", e);
      warned = true;
    }
    try { window.print(); } catch { /* nothing else to try */ }
  }
}
