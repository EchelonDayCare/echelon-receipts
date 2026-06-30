// Cross-platform error log writer backed by Rust (errlog.rs).
// Used by global window error handlers and explicit try/catch logging.
import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "ERROR" | "WARN" | "INFO";

let installed = false;

export async function logError(level: LogLevel, message: string, stack?: string) {
  try {
    const payload = stack ? `${message}\n${stack}` : message;
    await invoke("append_error_log", { level, message: payload });
  } catch {
    // Last resort — never throw from the logger itself.
  }
}

export async function readErrorLog(): Promise<string> {
  try { return await invoke<string>("read_error_log"); } catch { return ""; }
}

export async function errorLogPath(): Promise<string> {
  try { return await invoke<string>("error_log_path"); } catch { return ""; }
}

export async function clearErrorLog(): Promise<void> {
  try { await invoke("clear_error_log"); } catch { /* ignore */ }
}

export function installGlobalErrorHandlers() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (ev) => {
    const msg = `${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`;
    void logError("ERROR", msg, ev.error?.stack);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason: any = ev.reason;
    const msg = reason?.message ? String(reason.message) : String(reason);
    void logError("ERROR", `unhandledrejection: ${msg}`, reason?.stack);
  });
}
